// 共享「唱片详情面板」：左侧当前样式大预览（只读，样式跟随墙全局）+ 右侧 metadata。
// 播放确认（mode=play）与搜索添加确认（mode=add）复用同一组件，
// 底部按钮与回调按模式切换（计划书 §变更B.2）。

import { App, Modal, Notice, setIcon } from "obsidian";
import type { AlbumMeta, DiscStyle, WallItem } from "../types";
import { buildDiscElement } from "./disc";
import { fmtDur, fmtTotalDur, fmtTotalDurTip, sumTrackDur } from "./duration";
import { playAlbum, type PlaybackDeps } from "../core/playback";
import { applyModalTheme } from "./modalTheme";
import { buildStarsDisplay, normalizeRating, paintStarsDisplay } from "./rating";
import { RatingModal } from "./RatingModal";
import { t } from "../i18n";
import { PickerModal } from "./smallModals";

export interface AlbumPanelNavigation {
  openAlbum(meta: AlbumMeta): Promise<void>;
  openArtist(artist: { id: number; name: string }): Promise<void>;
  fetchAlbum(albumId: number): Promise<AlbumMeta>;
  accountKey(): string;
}

export interface PanelOptions {
  meta: AlbumMeta;
  style: DiscStyle;
  locked?: boolean;
  source?: "search" | "manual";
  /** 当前评分（已入库条目传入；搜索待添加不传即不渲染评分行） */
  rating?: number;
  /** 评分保存（含撤回 undefined）；提供时才渲染“评分”按钮 */
  onRate?: (rating: number | undefined) => void;
  /** 打开评分框需要 App 实例（仅 onRate 存在时需要） */
  app?: App;
  navigation?: AlbumPanelNavigation;
  onNavigate?: () => void;
}

/** 渲染共享面板到容器 */
export function renderAlbumPanel(container: HTMLElement, opts: PanelOptions): () => void {
  container.empty();
  container.addClass("mw-panel");

  // 左：预览（样式跟随墙全局，无单卡切换）
  const left = container.createDiv({ cls: "mw-panel__left" });
  const preview = left.createDiv({ cls: "mw-panel__preview" });
  const item: WallItem = {
    albumId: opts.meta.albumId,
    source: opts.source ?? "manual",
    locked: !!opts.locked,
    meta: opts.meta,
    addedAt: "",
  };
  preview.appendChild(buildDiscElement(item, opts.style, { coverSize: 500 }));

  // 右：metadata
  const right = container.createDiv({ cls: "mw-panel__right" });
  const name = right.createEl(opts.navigation ? "button" : "div", { cls: "mw-panel__title", text: opts.meta.name });
  const artist = right.createEl(opts.navigation ? "button" : "div", {
    cls: "mw-panel__artist",
    text: opts.meta.artist || t("common.unknownArtist"),
  });
  let alive = true, request = 0, picker: PickerModal | null = null;
  let refs = opts.meta.artistRefs;
  if (opts.navigation && opts.app) {
    const nav = opts.navigation, app = opts.app;
    for (const link of [name, artist]) { link.addClass("mw-panel__link", "clickable-icon"); link.setAttr("type", "button"); link.title = link.textContent || ""; }
    name.addEventListener("click", event => {
      event.stopPropagation(); opts.onNavigate?.();
      void nav.openAlbum(opts.meta).catch(() => new Notice(t("library.failed")));
    });
    artist.addEventListener("click", event => {
      event.stopPropagation();
      const token = ++request, account = nav.accountKey();
      const valid = () => alive && token === request && artist.isConnected && account === nav.accountKey();
      picker?.close(); picker = null;
      void (async () => {
        if (!refs?.length) refs = (await nav.fetchAlbum(opts.meta.albumId)).artistRefs;
        if (!valid()) return;
        const artists = [...new Map((refs || []).filter(a => a.id > 0).map(a => [a.id, a])).values()];
        const open = async (index: number) => {
          if (!valid()) return;
          opts.onNavigate?.(); await nav.openArtist(artists[index]);
        };
        if (artists.length === 1) await open(0);
        else if (artists.length > 1) {
          picker = new PickerModal(app, t("libraryDetails.chooseArtist"), artists.map(a => ({ label: a.name, icon: "mic" })),
            index => { void open(index).catch(() => new Notice(t("library.failed"))); });
          picker.open();
        }
      })().catch(() => { if (valid()) new Notice(t("library.failed")); });
    });
  }

  const meta = right.createDiv({ cls: "mw-panel__meta" });
  const row = (k: string, v?: string | number) => {
    if (v === undefined || v === "" || v === null) return;
    const r = meta.createDiv({ cls: "mw-panel__row" });
    r.createSpan({ cls: "mw-panel__k", text: k });
    r.createSpan({ cls: "mw-panel__v", text: String(v) });
  };
  // 评分行：五星只读展示＋“评分”按钮（弹出评分框）；未入库（无 onRate/app）不渲染
  if (opts.onRate && opts.app) {
    const hostApp = opts.app;
    const rateRow = right.createDiv({ cls: "mw-rate-row" });
    const stars = buildStarsDisplay(opts.rating);
    rateRow.appendChild(stars);
    const rateBtn = rateRow.createEl("button", {
      cls: "mw-rate-row__btn",
      text: normalizeRating(opts.rating)
        ? t("panel.changeRate")
        : t("panel.rate"),
    });
    rateBtn.setAttr("type", "button");
    rateBtn.setAttr("title", t("panel.rateTip"));
    rateBtn.addEventListener("click", () => {
      new RatingModal(hostApp, {
        albumName: opts.meta.name,
        current: opts.rating,
        onSave: (r) => {
          opts.onRate?.(r);
          const next = normalizeRating(r);
          paintStarsDisplay(stars, next);
          rateBtn.setText(next ? t("panel.changeRate") : t("panel.rate"));
          opts.rating = next;
        },
      }).open();
    });
  }
  row(t("panel.release"), opts.meta.year);
  row(t("panel.trackCount"), opts.meta.trackCount);
  // 总时长：档位化展示（分钟/小时），悬停给"总分钟:秒"
  const totalDur = sumTrackDur(opts.meta.tracks);
  if (totalDur > 0) {
    const r = meta.createDiv({ cls: "mw-panel__row" });
    r.createSpan({ cls: "mw-panel__k", text: t("panel.totalDur") });
    r.createSpan({
      cls: "mw-panel__v mw-panel__v--dur",
      text: fmtTotalDur(totalDur),
      title: fmtTotalDurTip(totalDur),
    });
  }
  row(t("panel.company"), opts.meta.company);

  if (opts.meta.description) {
    const desc = right.createDiv({ cls: "mw-panel__desc" });
    desc.createDiv({ cls: "mw-panel__desc-title", text: t("panel.desc") });
    desc.createDiv({ cls: "mw-panel__desc-body", text: opts.meta.description });
  }

  if (opts.meta.tracks?.length) {
    const trackWrap = right.createDiv({ cls: "mw-panel__tracks" });
    trackWrap.createDiv({
      cls: "mw-panel__tracks-title",
      text: t("panel.tracks"),
    });
    const list = trackWrap.createEl("ol");
    list.addClass("mw-panel__track-list");
    for (const t of opts.meta.tracks) {
      const li = list.createEl("li");
      li.createSpan({ cls: "mw-track-name", text: t.name });
      const dur = t.duration ? fmtDur(t.duration) : "";
      if (dur) li.createSpan({ cls: "mw-track-dur", text: dur });
    }
  }
  return () => { alive = false; request++; picker?.close(); picker = null; };
}

type PanelModalMode = "play" | "add";

export class AlbumPanelModal extends Modal {
  private mode: PanelModalMode;
  private meta: AlbumMeta;
  private style: DiscStyle;
  private locked: boolean;
  private source: "search" | "manual";
  private deps: PlaybackDeps;
  private onAdd?: () => void;
  private rating?: number;
  private onRate?: (rating: number | undefined) => void;
  private navigation?: AlbumPanelNavigation;
  private disposePanel?: () => void;

  constructor(
    app: App,
    mode: PanelModalMode,
    args: {
      meta: AlbumMeta;
      style: DiscStyle;
      locked?: boolean;
      source?: "search" | "manual";
      deps: PlaybackDeps;
      onAdd?: () => void;
      rating?: number;
      onRate?: (rating: number | undefined) => void;
      navigation?: AlbumPanelNavigation;
    }
  ) {
    super(app);
    this.mode = mode;
    this.meta = args.meta;
    this.style = args.style;
    this.locked = !!args.locked;
    this.source = args.source ?? "manual";
    this.deps = args.deps;
    this.onAdd = args.onAdd;
    this.rating = normalizeRating(args.rating);
    this.onRate = args.onRate;
    this.navigation = args.navigation;
  }

  onOpen(): void {
    // 弹窗跟随全局缩放（--mw-zoom 设在 body 上，这里只是挂上作用域类）
    this.modalEl.addClass("mw-modal-zoom");
    applyModalTheme(this.modalEl);
    const { contentEl } = this;
    contentEl.addClass("mw-album-modal");
    contentEl.createEl("h2", {
      text: this.mode === "play" ? t("panel.playTitle") : t("panel.addTitle"),
      cls: "mw-album-modal__heading",
    });

    const panel = contentEl.createDiv();
    this.disposePanel?.();
    this.disposePanel = renderAlbumPanel(panel, {
      meta: this.meta,
      style: this.style,
      locked: this.locked,
      source: this.source,
      rating: this.rating,
      onRate: this.onRate
        ? (r) => {
            const next = normalizeRating(r);
            this.rating = next;
            this.onRate?.(next);
          }
        : undefined,
      app: this.app,
      navigation: this.navigation,
      onNavigate: () => this.close(),
    });

    const btns = contentEl.createDiv({ cls: "mw-album-modal__buttons" });
    const cancel = btns.createEl("button", { text: t("common.cancel") });
    cancel.addEventListener("click", () => this.close());

    // 试听：未添加也能播（add 模式下点即播，不关闭弹窗、不触发添加）
    if (this.mode === "add") {
      const preview = btns.createEl("button", { cls: "mw-button-icon" });
      setIcon(preview.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } }), "play");
      preview.createSpan({ text: t("panel.preview") });
      preview.setAttr("title", t("panel.previewTip"));
      preview.addEventListener("click", () => {
        void playAlbum(this.meta, this.deps);
      });
    }

    const primary = btns.createEl("button", {
      cls: "mod-cta",
    });
    if (this.mode === "play") {
      primary.addClass("mw-button-icon");
      setIcon(primary.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } }), "play");
    }
    primary.createSpan({ text: this.mode === "play" ? t("panel.play") : t("panel.confirmAdd") });
    primary.addEventListener("click", async () => {
      if (this.mode === "play") {
        this.close();
        await playAlbum(this.meta, this.deps);
      } else {
        this.onAdd?.();
        this.close();
      }
    });
  }

  onClose(): void {
    this.disposePanel?.(); this.disposePanel = undefined;
    this.contentEl.empty();
  }
}
