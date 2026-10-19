// 批量导入专辑：仅数字编号、分号（中英文）隔开 → 逐个拉取预览 → 一键全加。
// 入口在添加专辑浮层内的“批量添加”按钮（见 AlbumSearchPanel）。
// 去重：输入内重复/墙内已存在在预览中标出，确认时跳过并汇总。

import { App, Modal, Notice, setIcon } from "obsidian";
import type { AlbumMeta } from "../types";
import { playAlbum, type PlaybackDeps } from "../core/playback";
import { renderAlbumPanel, type AlbumPanelNavigation } from "./AlbumPanelModal";
import { applyModalTheme } from "./modalTheme";
import { sizedCover } from "../core/metadata";
import { createSelectBox } from "./selectBox";
import { t } from "../i18n";

export interface BatchHost {
  navigation?: AlbumPanelNavigation;
  fetchAlbumDetail(albumId: number): Promise<AlbumMeta>;
  getExistingIds(): Set<number>;
  addAlbum(meta: AlbumMeta, source: "search" | "manual"): void;
  getPlaybackDeps(): PlaybackDeps;
  getStyle(): import("../types").DiscStyle;
}

/** 解析批量输入：分号（含中英文）隔开，仅保留纯数字；返回有效 id 与非法片段 */
export function parseBatchInput(raw: string): { ids: number[]; invalid: string[] } {
  const parts = raw.split(/[;；]/).map((s) => s.trim()).filter((s) => s.length > 0);
  const ids: number[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    if (/^\d+$/.test(p)) {
      const n = parseInt(p, 10);
      if (Number.isSafeInteger(n) && n > 0) ids.push(n);
      else invalid.push(p);
    } else {
      invalid.push(p);
    }
  }
  return { ids, invalid };
}

type BatchStatus =
  | { kind: "pending" }
  | { kind: "loading" }
  | { kind: "ready"; meta: AlbumMeta }
  | { kind: "exists"; meta?: AlbumMeta }
  | { kind: "duplicate" }
  | { kind: "error"; message: string };

interface BatchRow {
  id: number;
  status: BatchStatus;
  /** 是否勾选添加（仅 ready 行可勾；解析/拉取成功默认 true） */
  picked: boolean;
}

/** 把网易接口错误码翻译成人话（code=405 等限流类已自动重试，仍失败才到这里） */
export function batchErrorText(raw: string): string {
  if (/code=\s*404\b/.test(raw)) return t("batch.err404");
  if (/code=\s*405\b/.test(raw)) return t("batch.err405");
  if (/code=\s*-46\d\b/.test(raw)) return t("batch.err46x");
  return raw;
}

/** 是否值得自动重试：限流/验证/网络抖动类；404 等硬失败不重试 */
function isRetryableBatchError(e: any): boolean {
  const msg = e?.message ?? String(e);
  return (
    /code=\s*(405|-46\d)\b/.test(msg) ||
    /Failed to fetch|Network|timeout|ETIMEDOUT|ECONNRESET|ECONNABORTED/i.test(msg)
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export class BatchAddModal extends Modal {
  private host: BatchHost;

  constructor(app: App, host: BatchHost) {
    super(app);
    this.host = host;
  }

  onOpen(): void {
    this.modalEl.addClass("mw-modal-zoom");
    applyModalTheme(this.modalEl);
    // 批量弹窗拉取耗时、勾选态宝贵：拦截点到背景遮罩的点击，避免误触空白关闭
    // （捕获阶段先于遮罩自身的关闭监听，用 stopPropagation 吃掉；框内点击与 Esc 不受影响）
    this.containerEl.addEventListener(
      "click",
      (e) => {
        const t = e.target as Node | null;
        if (t && t !== this.modalEl && !this.modalEl.contains(t)) {
          e.stopPropagation();
        }
      },
      true
    );
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mw-batch");
    contentEl.createEl("h2", {
      text: t("batch.title"),
      cls: "mw-batch__heading",
    });
    contentEl.createEl("p", {
      cls: "mw-batch__hint",
      text: t("batch.hint"),
    });

    const input = contentEl.createEl("textarea", {
      cls: "mw-batch__input",
      placeholder: t("batch.inputPh"),
    });
    input.rows = 3;

    const errLine = contentEl.createDiv({ cls: "mw-batch__error" });
    const btnRow = contentEl.createDiv({ cls: "mw-batch__btnrow" });
    const parseBtn = btnRow.createEl("button", {
      text: t("batch.parse"),
      cls: "mod-cta",
    });
    const cancelBtn = btnRow.createEl("button", { text: t("common.cancel") });
    cancelBtn.addEventListener("click", () => this.close());

    const listWrap = contentEl.createDiv({ cls: "mw-batch__list" });
    const foot = contentEl.createDiv({ cls: "mw-batch__foot" });

    let rows: BatchRow[] = [];
    let loadingToken = 0;

    const renderList = () => {
      const keepScroll = listWrap.scrollTop;
      listWrap.empty();
      if (!rows.length) {
        listWrap.createDiv({
          cls: "mw-batch__empty",
          text: t("batch.emptyList"),
        });
        return;
      }
      // 顶部选择行：全选 / 取消全选（仅待添加行参与），确认只添加勾中的
      const readyRows = rows.filter((r) => r.status.kind === "ready");
      if (readyRows.length) {
        const selRow = listWrap.createDiv({ cls: "mw-batch__selectrow" });
        const allOn = readyRows.every((r) => r.picked);
        const toggle = selRow.createEl("button", {
          text: allOn ? t("batch.deselectAll") : t("batch.selectAll"),
          cls: "mw-batch__selectall",
        });
        toggle.addEventListener("click", (e) => {
          e.stopPropagation();
          const next = !readyRows.every((r) => r.picked);
          for (const r of readyRows) r.picked = next;
          renderList();
        });
        const pickedCount = readyRows.filter((r) => r.picked).length;
        selRow.createDiv({
          cls: "mw-batch__selectcount",
          text: t("batch.selectCount", {
            picked: pickedCount,
            ready: readyRows.length,
          }),
        });
      }
      const rerenderKeepScroll = () => {
        renderList();
        listWrap.scrollTop = keepScroll;
      };
      for (const row of rows) {
        const el = listWrap.createDiv({ cls: "mw-batch-row" });
        el.dataset.id = String(row.id);
        const st = row.status;
        // 待添加行首复选框（复用自绘组件）；未勾选整行置淡
        if (st.kind === "ready") {
          el.appendChild(
            createSelectBox({
              checked: row.picked,
              title: t("batch.rowCheckboxTip"),
              onToggle: () => {
                row.picked = !row.picked;
                rerenderKeepScroll();
                return row.picked;
              },
            })
          );
          el.toggleClass("is-unpicked", !row.picked);
        }
        const coverUrl =
          (st.kind === "ready" || st.kind === "exists") && st.meta?.cover ? st.meta.cover : "";
        if (coverUrl) {
          const img = el.createEl("img", { cls: "mw-batch-row__cover" });
          img.loading = "lazy";
          img.src = sizedCover(coverUrl, 120);
        } else {
          el.createDiv({ cls: "mw-batch-row__cover mw-batch-row__cover--ph", text: String(row.id).slice(0, 4) });
        }
        const info = el.createDiv({ cls: "mw-batch-row__info" });
        if (st.kind === "ready") {
          info.createDiv({ cls: "mw-batch-row__name", text: st.meta.name });
          info.createDiv({
            cls: "mw-batch-row__sub",
            text: t("batch.rowSub", {
              artist: st.meta.artist || t("search.unknown"),
              year: st.meta.year ?? "",
              count: st.meta.trackCount,
            }),
          });
        } else if (st.kind === "exists") {
          info.createDiv({
            cls: "mw-batch-row__name",
            text: st.meta ? st.meta.name : `ID ${row.id}`,
          });
          info.createDiv({
            cls: "mw-batch-row__sub",
            text: t("batch.exists"),
          });
        } else if (st.kind === "loading" || st.kind === "pending") {
          info.createDiv({
            cls: "mw-batch-row__name",
            text: `ID ${row.id}`,
          });
          info.createDiv({
            cls: "mw-batch-row__sub",
            text: t("batch.loading"),
          });
        } else if (st.kind === "duplicate") {
          info.createDiv({
            cls: "mw-batch-row__name",
            text: `ID ${row.id}`,
          });
          info.createDiv({
            cls: "mw-batch-row__sub",
            text: t("batch.duplicated"),
          });
        } else {
          info.createDiv({
            cls: "mw-batch-row__name",
            text: `ID ${row.id}`,
          });
          info.createDiv({
            cls: "mw-batch-row__sub",
            text: t("batch.fetchFailed", {
              error: batchErrorText(st.message),
            }),
          });
        }
        const badge = el.createDiv({ cls: "mw-batch-row__badge" });
        const badgeText =
          st.kind === "ready"
            ? t("batch.badgeReady")
            : st.kind === "exists"
              ? t("batch.badgeExists")
              : st.kind === "duplicate"
                ? t("batch.badgeDuplicate")
                : st.kind === "error"
                  ? t("batch.badgeError")
                  : t("batch.badgeLoading");
        badge.setText(badgeText);
        badge.addClass(`is-${st.kind}`);
        const ops = el.createDiv({ cls: "mw-batch-row__ops" });
        if (st.kind === "ready" || st.kind === "exists") {
          const detail = ops.createEl("button", { text: t("batch.detail") });
          detail.addEventListener("click", (e) => {
            e.stopPropagation();
            const meta = st.meta;
            if (meta) this.openDetail(meta);
            else new Notice(t("batch.noDetail"));
          });
          const previewMeta: AlbumMeta | undefined = st.meta;
          if (previewMeta) {
            const metaForPlay: AlbumMeta = previewMeta;
            const preview = ops.createEl("button", {
              text: t("batch.preview"),
              cls: "mw-batch-row__preview",
            });
            preview.setAttr("title", t("batch.previewTip"));
            preview.addEventListener("click", (e) => {
              e.stopPropagation();
              void playAlbum(metaForPlay, this.host.getPlaybackDeps());
            });
          }
        }
        if (st.kind === "error") {
          const retry = ops.createEl("button", { text: t("batch.retry") });
          retry.addEventListener("click", (e) => {
            e.stopPropagation();
            void this.fetchOne(row, () => renderList());
          });
        }
        el.addEventListener("click", () => {
          if ((st.kind === "ready" || st.kind === "exists") && st.meta) this.openDetail(st.meta);
        });
      }
      this.renderFoot(
        foot,
        rows,
        () => {
          this.close();
        },
        () => renderList()
      );
    };

    parseBtn.addEventListener("click", () => {
      const { ids, invalid } = parseBatchInput(input.value);
      errLine.setText(
        invalid.length
          ? t("batch.invalidLine", {
              items: invalid.slice(0, 10).join("、"),
            }) +
              (invalid.length > 10
                ? t("batch.invalidMore", { count: invalid.length })
                : "")
          : ""
      );
      if (!ids.length) {
        new Notice(t("batch.invalidNotice"));
        return;
      }
      const seen = new Set<number>();
      const existing = this.host.getExistingIds();
      rows = ids.map((id) => {
        if (seen.has(id)) return { id, picked: false, status: { kind: "duplicate" } as BatchStatus };
        seen.add(id);
        if (existing.has(id)) {
          // 仍尝试拉取详情以便预览/看详情，但标记为 exists，确认时跳过
          return { id, picked: false, status: { kind: "exists" } as BatchStatus };
        }
        return { id, picked: false, status: { kind: "pending" } as BatchStatus };
      });
      renderList();
      const token = ++loadingToken;
      void this.fetchAll(rows, () => {
        if (token === loadingToken) renderList();
      });
    });
  }

  private renderFoot(
    foot: HTMLElement,
    rows: BatchRow[],
    onDone: () => void,
    refresh: () => void
  ): void {
    foot.empty();
    if (!rows.length) return;
    const readyRows = rows.filter((r) => r.status.kind === "ready");
    const pickedRows = readyRows.filter((r) => r.picked);
    const ready = readyRows.length;
    const picked = pickedRows.length;
    const exists = rows.filter((r) => r.status.kind === "exists").length;
    const dup = rows.filter((r) => r.status.kind === "duplicate").length;
    const fail = rows.filter((r) => r.status.kind === "error").length;
    foot.createDiv({
      cls: "mw-batch__summary",
      text: t("batch.summary", {
        total: rows.length,
        ready,
        picked,
        exists,
        dup,
        fail,
      }),
    });
    const row = foot.createDiv({ cls: "mw-batch__btnrow" });
    const retryAll = row.createEl("button", {
      text: t("batch.retryFailed"),
    });
    retryAll.toggleClass("is-disabled", fail === 0);
    if (fail === 0) retryAll.setAttr("disabled", "true");
    else {
      retryAll.addEventListener("click", () => {
        const targets = rows.filter((r) => r.status.kind === "error");
        for (const t of targets) t.status = { kind: "pending" };
        refresh();
        void this.fetchAll(targets, refresh);
      });
    }
    const confirm = row.createEl("button", {
      text: picked
        ? t("batch.confirmAddN", { count: picked })
        : t("batch.confirmAdd"),
      cls: "mod-cta",
    });
    confirm.toggleClass("is-disabled", picked === 0);
    if (picked === 0) confirm.setAttr("disabled", "true");
    confirm.addEventListener("click", () => {
      let added = 0;
      let skipped = 0;
      const existingNow = this.host.getExistingIds();
      for (const r of rows) {
        // 只添加勾中的待添加行，其余一律跳过
        if (r.status.kind !== "ready" || !r.picked) {
          skipped++;
          continue;
        }
        if (existingNow.has(r.id)) {
          skipped++;
          continue;
        }
        try {
          this.host.addAlbum(r.status.meta, "search");
          existingNow.add(r.id);
          added++;
        } catch {
          skipped++;
        }
      }
      new Notice(
        added
          ? t("batch.doneNotice", { added, skipped })
          : t("batch.noneNotice")
      );
      if (added) onDone();
    });
  }

  private async fetchOne(row: BatchRow, onUpdate: () => void): Promise<void> {
    if (row.status.kind !== "error" && row.status.kind !== "pending") return;
    row.status = { kind: "loading" };
    onUpdate();
    try {
      const meta = await this.fetchWithRetry(row.id);
      // 拉取成功后若墙内已存在，标为 exists（确认时跳过，但可看详情）
      if (this.host.getExistingIds().has(meta.albumId)) {
        row.status = { kind: "exists", meta };
        row.picked = false;
      } else {
        row.status = { kind: "ready", meta };
        row.picked = true;
      }
    } catch (e: any) {
      row.status = { kind: "error", message: e?.message ?? String(e) };
    }
    onUpdate();
  }

  /** 带自动重试的单次拉取：限流/验证/网络抖动类错误指数退避重试 2 次 */
  private async fetchWithRetry(albumId: number): Promise<AlbumMeta> {
    let last: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(1500 * attempt);
      try {
        return await this.host.fetchAlbumDetail(albumId);
      } catch (e: any) {
        last = e;
        if (!isRetryableBatchError(e)) throw e;
      }
    }
    throw last;
  }

  /** 并发拉取（exists 占位无 meta 时也拉取详情用于预览，但仍标 exists） */
  private async fetchAll(targets: BatchRow[], onUpdate: () => void): Promise<void> {
    const queue = targets.filter(
      (r) => r.status.kind === "pending" || r.status.kind === "loading" || r.status.kind === "error" || (r.status.kind === "exists" && !r.status.meta)
    );
    for (const r of queue) {
      if (r.status.kind === "pending" || r.status.kind === "error") r.status = { kind: "loading" };
    }
    onUpdate();
    // 并发 3：此前用 4 时曾恰好末尾两项被接口限流（code=405），下调一级
    const CONC = 3;
    let idx = 0;
    const workers = Array.from({ length: Math.min(CONC, queue.length) }, async () => {
      while (idx < queue.length) {
        const row = queue[idx++];
        const wasExistsPlaceholder =
          row.status.kind === "exists" || this.host.getExistingIds().has(row.id);
        if (row.status.kind !== "loading") row.status = { kind: "loading" };
        onUpdate();
        try {
          const meta = await this.fetchWithRetry(row.id);
          if (this.host.getExistingIds().has(meta.albumId) || wasExistsPlaceholder) {
            row.status = { kind: "exists", meta };
            row.picked = false;
          } else {
            row.status = { kind: "ready", meta };
            row.picked = true;
          }
        } catch (e: any) {
          row.status = { kind: "error", message: e?.message ?? String(e) };
        }
        onUpdate();
      }
    });
    await Promise.all(workers);
    onUpdate();
  }

  /** 批量内详情：只读 + 试听（不触发单张添加，避免与一键全加混淆） */
  private openDetail(meta: AlbumMeta): void {
    new DetailPreviewModal(this.app, {
      meta,
      style: this.host.getStyle(),
      deps: this.host.getPlaybackDeps(),
      navigation: this.host.navigation,
      onNavigate: () => this.close(),
    }).open();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DetailPreviewModal extends Modal {
  private onNavigate?: () => void;
  private navigation?: AlbumPanelNavigation;
  private disposePanel?: () => void;
  private meta: AlbumMeta;
  private style: import("../types").DiscStyle;
  private deps: PlaybackDeps;

  constructor(
    app: App,
    args: { meta: AlbumMeta; style: import("../types").DiscStyle; deps: PlaybackDeps; navigation?: AlbumPanelNavigation; onNavigate?: () => void }
  ) {
    super(app);
    this.meta = args.meta;
    this.style = args.style;
    this.deps = args.deps;
    this.navigation = args.navigation;
    this.onNavigate = args.onNavigate;
  }

  onOpen(): void {
    this.modalEl.addClass("mw-modal-zoom");
    applyModalTheme(this.modalEl);
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mw-album-modal");
    contentEl.createEl("h2", {
      text: t("batch.detailTitle"),
      cls: "mw-album-modal__heading",
    });
    const panel = contentEl.createDiv();
    this.disposePanel?.();
    this.disposePanel = renderAlbumPanel(panel, { meta: this.meta, style: this.style, source: "search", app: this.app, navigation: this.navigation, onNavigate: () => { this.close(); this.onNavigate?.(); } });
    const btns = contentEl.createDiv({ cls: "mw-album-modal__buttons" });
    const back = btns.createEl("button", { text: t("common.back") });
    back.addEventListener("click", () => this.close());
    const preview = btns.createEl("button", {
      cls: "mod-cta mw-button-icon",
    });
    setIcon(preview.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } }), "play");
    preview.createSpan({ text: t("panel.preview") });
    preview.setAttr("title", t("panel.previewTip"));
    preview.addEventListener("click", () => {
      void playAlbum(this.meta, this.deps);
    });
  }

  onClose(): void {
    this.disposePanel?.(); this.disposePanel = undefined;
    this.contentEl.empty();
  }
}
