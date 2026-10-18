// 专辑搜索面板：搜索列表 → 选择 → 共享详情面板确认 → 添加。
// 通过 WallHost 接口与当前墙解耦，视图实现该接口。
//
// 形态：不是模态框，而是一块可挂进任意容器的面板
// （音乐墙把它挂进右上角的悬浮框，见 FloatPanel / SideDrawer 的 float 形态）。

import { Notice, setIcon } from "obsidian";
import type { AlbumMeta, AlbumSummary } from "../types";
import { parseAlbumInput, sizedCover } from "../core/metadata";
import { playAlbum, type PlaybackDeps } from "../core/playback";
import { t } from "../i18n";
import { svgAction } from "./svgAction";

export interface WallHost {
  searchAlbums(keyword: string, offset: number): Promise<AlbumSummary[]>;
  fetchAlbumDetail(albumId: number): Promise<AlbumMeta>;
  getExistingIds(): Set<number>;
  addAlbum(meta: AlbumMeta, source: "search" | "manual"): void;
  confirmAdd(meta: AlbumMeta, onAdd: () => void): void;
  getPlaybackDeps?(): PlaybackDeps;
  getStyle?(): import("../types").DiscStyle;
  enqueueAlbum?(meta: AlbumMeta): Promise<void>;
}

const PAGE = 20;

export class AlbumSearchPanel {
  private host: WallHost;
  private keyword = "";
  private offset = 0;
  private results: AlbumSummary[] = [];
  private hasMore = true;
  private loading = false;

  private inputEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(host: WallHost) {
    this.host = host;
  }

  /** 在 container 内渲染面板；可重复调用（重建） */
  mount(container: HTMLElement): void {
    container.empty();
    container.addClass("mw-search-panel");

    const bar = container.createDiv({ cls: "mw-search-panel__bar" });
    const field = bar.createDiv({ cls: "mw-panel__searchbar" });
    const input = field.createEl("input", {
      type: "text",
      cls: "mw-panel__input",
      placeholder: t("search.inputPh"),
    });
    this.inputEl = input;
    input.value = this.keyword;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.doSearch();
    });
    // 右端 × 清空（面板统一形态：不再用整宽「清空」按钮）
    const clear = field.createEl("button", { cls: "clickable-icon mw-panel__clearicon" });
    clear.setAttr("type", "button");
    clear.setAttr("aria-label", t("search.clear"));
    clear.setAttr("title", t("search.clear"));
    setIcon(clear, "x");
    const syncClear = () => clear.toggleClass("is-hidden", !input.value.length);
    input.addEventListener("input", syncClear);
    clear.addEventListener("click", () => {
      if (!input.value.length) return;
      input.value = "";
      syncClear();
      input.focus();
    });
    syncClear();
    bar
      .createEl("button", {
        cls: "mw-btn mw-btn--primary",
        text: t("search.btn"),
      })
      .addEventListener("click", () => void this.doSearch());
    // 批量入口：搜索右侧的紧凑次按钮（与搜索同行同高，不独占一行）
    const batchBtn = bar.createEl("button", {
      cls: "mw-btn mw-search-panel__batch",
      text: t("search.batch"),
    });
    batchBtn.setAttr("type", "button");
    batchBtn.setAttr("title", t("search.batchTip"));
    batchBtn.setAttr("aria-label", t("search.batchTip"));
    batchBtn.addEventListener("click", () => this.openBatch());

    this.statusEl = container.createDiv({ cls: "mw-search-panel__status" });
    this.listEl = container.createDiv({ cls: "mw-search-panel__list" });
    // 重建后恢复上一次的结果（refresh 场景）
    if (this.results.length) this.renderList();
    window.setTimeout(() => input.focus(), 0);
  }

  /** 面板被销毁：清掉引用，避免陈旧 DOM 被后续回调写到 */
  dispose(): void {
    this.inputEl = null;
    this.listEl = null;
    this.statusEl = null;
  }

  private async doSearch(): Promise<void> {
    const raw = this.inputEl?.value.trim() ?? "";
    if (!raw) return;

    // 分享链接快速路径（含 http / album?id= 的链接直接按 ID 拉取）
    // 裸 ID 不在这里拦：先当关键词搜，搜不到再兜底按 ID 取（见 loadMore）
    const id = parseAlbumInput(raw);
    if (id !== null && /http|album/i.test(raw)) {
      await this.quickAddById(id);
      return;
    }

    this.keyword = raw;
    this.offset = 0;
    this.results = [];
    this.hasMore = true;
    this.listEl?.empty();
    await this.loadMore();
  }

  /** 按 ID 直取专辑；返回是否走通（true=已提示/已弹确认框） */
  private async quickAddById(albumId: number): Promise<boolean> {
    if (this.host.getExistingIds().has(albumId)) {
      new Notice(t("search.alreadyAdded"));
      this.setStatus("");
      return true;
    }
    this.setStatus(t("search.fetching"));
    try {
      const meta = await this.host.fetchAlbumDetail(albumId);
      this.setStatus("");
      this.host.confirmAdd(meta, () => {
        this.host.addAlbum(meta, "search");
        this.markAdded(albumId);
      });
      return true;
    } catch (e: any) {
      this.setStatus(t("search.fetchFail", { error: e?.message ?? e }));
      return false;
    }
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private async loadMore(): Promise<void> {
    if (this.loading || !this.keyword) return;
    this.loading = true;
    this.setStatus(t("search.searching"));
    try {
      const batch = await this.host.searchAlbums(this.keyword, this.offset);
      this.results.push(...batch);
      this.hasMore = batch.length >= PAGE;
      this.offset += batch.length;
      this.renderList();
      if (this.results.length === 0) {
        // 云搜索按文本匹配、不认专辑 ID：纯数字关键词搜不到时，
        // 八成是用户粘贴的裸 ID → 兜底按 ID 直取（1989/21 这类有文本命中则不受影响）
        const id = parseAlbumInput(this.keyword);
        if (id !== null) {
          if (!(await this.quickAddById(id))) {
            this.setStatus(t("search.noResults"));
          }
          return;
        }
      }
      this.setStatus(
        this.results.length === 0 ? t("search.noResults") : ""
      );
    } catch (e: any) {
      this.setStatus(t("search.searchFail", { error: e?.message ?? e }));
    } finally {
      this.loading = false;
    }
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    const existing = this.host.getExistingIds();
    for (const a of this.results) {
      const row = list.createDiv({ cls: "mw-search-row" });
      row.dataset.id = String(a.albumId);
      const added = existing.has(a.albumId);
      if (added) row.addClass("is-added");

      const img = row.createEl("img", { cls: "mw-search-row__cover" });
      img.loading = "lazy";
      img.draggable = false;
      img.src = sizedCover(a.cover, 120);

      const info = row.createDiv({ cls: "mw-search-row__info" });
      info.createDiv({ cls: "mw-search-row__name", text: a.name });
      info.createDiv({
        cls: "mw-search-row__sub",
        text: t("search.rowSub", {
          artist: a.artist || t("search.unknown"),
          year: a.year ?? "",
          count: a.trackCount,
        }),
      });

      const actions = row.createDiv({ cls: "mw-search-row__actions" });
      const btn = svgAction(actions, added ? "check" : "plus", added ? t("search.added") : t("search.add"), () => this.onAddClick(a, btn));
      btn.addClass("mw-search-row__add");
      btn.disabled = added;

      // 试听：未添加也能播，原理与播放一致，点即播
      const preview = svgAction(actions, "play", t("search.preview"), () => this.onPreviewClick(a, preview));
      preview.addClass("mw-search-row__preview");
      preview.setAttr("title", t("search.previewTip"));
      if (this.host.enqueueAlbum) {
        const queue = svgAction(actions, "list-plus", t("queue.add"), async () => {
          const meta = await this.host.fetchAlbumDetail(a.albumId);
          if (this.listEl && queue.isConnected) await this.host.enqueueAlbum!(meta);
        });
        queue.addClass("mw-search-row__queue");
      }
    }

    if (this.hasMore && this.results.length) {
      list
        .createEl("button", {
          cls: "mw-search-more",
          text: t("search.loadMore"),
        })
        .addEventListener("click", () => void this.loadMore());
    }
  }

  private async onPreviewClick(summary: AlbumSummary, btn: HTMLButtonElement): Promise<void> {
    let deps = this.host.getPlaybackDeps?.();
    if (!deps) {
      new Notice(t("search.noPreview"));
      return;
    }
    btn.disabled = true;
    try {
      if (deps.authorize) {
        const authorized = await deps.authorize();
        if (!authorized) return;
        deps = authorized;
      }
      const meta = await this.host.fetchAlbumDetail(summary.albumId);
      await playAlbum(meta, deps);
    } catch (e: any) {
      new Notice(t("search.previewFail", { error: e?.message ?? e }));
    } finally {
      btn.disabled = false;
    }
  }

  /** 打开批量导入弹窗（App 从宿主视图的容器里取，避免面板与 App 解耦被打破） */
  private openBatch(): void {
    // AlbumSearchPanel 挂在视图浮层里，App 可从任意 DOM 的 ownerDocument 取不到；
    // 这里用全局 app 兜底：宿主视图会通过 setBatchOpener 注入真正的打开函数时优先用它。
    if (this.batchOpener) {
      this.batchOpener();
      return;
    }
    new Notice(t("search.noBatch"));
  }

  /** 由宿主视图注入（MusicWallView.buildFloater），避免面板直接依赖 App */
  batchOpener: (() => void) | null = null;

  private async onAddClick(summary: AlbumSummary, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    try {
      const meta = await this.host.fetchAlbumDetail(summary.albumId);
      this.host.confirmAdd(meta, () => {
        this.host.addAlbum(meta, "search");
        this.markAdded(summary.albumId);
      });
    } catch (e: any) {
      new Notice(t("search.detailFail", { error: e?.message ?? e }));
    } finally {
      btn.disabled = this.host.getExistingIds().has(summary.albumId);
    }
  }

  /** 重新渲染以更新「已添加」状态（简单可靠） */
  private markAdded(albumId: number): void {
    void albumId;
    this.renderList();
  }
}
