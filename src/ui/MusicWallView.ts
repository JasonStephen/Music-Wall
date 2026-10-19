import { bindMouseBack } from "./mouseBack";
// 音乐墙 FileView：点开 .mw 文件即渲染唱片墙。
// FileView 基类负责 file 绑定/切换/重命名刷标题/导航历史，本类只管加载与渲染。
//
// 顶部栏：固定不随网格滚动 —— 左「墙名 · N 张」，右一排图标钮
// （样式与布局 / 筛选 / 分组 / 排序 / 添加 / 搜索 / ⋯），点图标从右侧滑出面板。
// 网格：按分区分组渲染（分组头可展开收起、重命名、删除、整体拖拽换序）；
// 手动排序：从菜单进入编辑态后拖拽换位/跨组；普通浏览长按只打开菜单。
// 展示架布局点唱片 = 推镜 + 3D 开盒（gatefold）详情。

import {
  FileView,
  Menu,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  normalizePath,
  setIcon,
} from "obsidian";
import type MusicWallPlugin from "../main";
import {
  WALL_DRAG_MIME,
  WALL_VIEW_TYPE,
  clampZoom,
  type AlbumMeta,
  type AlbumSummary,
  type DiscStyle,
  type MusicWallData,
  type SortMode,
  type WallItem,
  type WallLayout,
} from "../types";
import { layoutLabel, sortLabel, styleLabel, t } from "../i18n";
import { loadWall, saveWall } from "../core/store";
import {
  UNGROUPED_ID,
  isHeadlessSection,
  moveGroup,
  moveInto,
  moveWithin,
  newGroupId,
  normalizeOrder,
  orderedIds,
  removeFromOrder,
  resolveSections,
  type Place,
  type WallSection,
} from "../core/layout";
import { playAlbum } from "../core/playback";
import { sizedCover } from "../core/metadata";
import { matchNowPlaying } from "../core/match";
import type { NowPlayingState } from "../core/nowPlaying";
import { ALL_STYLES, buildDiscElement, makeCoverImg } from "./disc";
import { fmtDur, fmtTotalDur, fmtTotalDurTip, sumTrackDur } from "./duration";
import { AlbumPanelModal } from "./AlbumPanelModal";
import { BatchAddModal } from "./BatchAddModal";
import { createSelectBox, syncSelectBox } from "./selectBox";
import { ConfirmModal } from "./ConfirmModal";
import { EditMetaModal } from "./EditMetaModal";
import { InputModal } from "./InputModal";
import { PickerModal } from "./smallModals";
import { AlbumSearchPanel, type WallHost } from "./AlbumSearchPanel";
import { SideDrawer, type DrawerKey } from "./SideDrawer";
import { buildLayoutTile, buildStyleTile, firstCover } from "./viewPrefs";
import { disposeZoomBox, handleZoomWheel, syncZoomBox } from "./zoom";
import { openShelfMenu, type ShelfMenuItem } from "./ShelfMenu";
import { setModalTheme } from "./modalTheme";
import { buildRatingBadge, buildStarsDisplay, normalizeRating, paintStarsDisplay } from "./rating";
import { RatingModal } from "./RatingModal";
import { MiniPlayer } from "./MiniPlayer";
import { watchHostInset } from "./hostInset";

/** "2015" → "2010s"；无效返回 "" */
function decadeOf(y?: string): string {
  const n = parseInt(y ?? "", 10);
  return Number.isFinite(n) ? `${Math.floor(n / 10) * 10}s` : "";
}

/** 数值防御：mock 环境 rect/滚动量可能不是数字 */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** DOMRect 中心点；非真实 rect（mock 代理等）返回 null */
function rectCenter(r: DOMRect | null | undefined): { x: number; y: number; w: number } | null {
  if (!r) return null;
  const a = (r as { left?: unknown }).left;
  const w = (r as { width?: unknown }).width;
  const h = (r as { height?: unknown }).height;
  if (typeof a !== "number" || typeof w !== "number" || typeof h !== "number") return null;
  return { x: r.left + w / 2, y: r.top + h / 2, w };
}

/** 开盒/收盒统一缓动（WAAPI 字符串 + JS 补间共用同一组参数） */
const GF_EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const GF_NEUTRAL = "translate(0px, 0px) scale(1) rotateY(0deg)";

/** 触屏浏览长按打开菜单；显式编辑态内长按开始指针拖拽。 */
const LONG_PRESS_MS_TOUCH = 350;
/**
 * 指针移动超过该距离视为「不是长按」。
 * 12px 是刻意的宽松值：真实鼠标按住时手抖 5~10px 很常见，
 * 原来 6px 会把长按手势几乎必然打断（用户报「拖不动」的根因之一）。
 */
const LONG_PRESS_SLOP = 12;
const LONG_PRESS_SLOP_TOUCH = 16;
/** 拖到网格上下边缘多少像素内开始自动滚动 */
const DRAG_AUTOSCROLL_EDGE = 56;
const DRAG_AUTOSCROLL_STEP = 14;

/** cubic-bezier 求值（标准 Newton 迭代），供 scrollTop 补间与 WAAPI 对拍 */
function gfBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sy = (t: number) => ((ay * t + by) * t + cy) * t;
  return (x: number) => {
    const clamped = Math.min(1, Math.max(0, x));
    let t = clamped;
    for (let i = 0; i < 6; i++) {
      const dx = (3 * ax * t + 2 * bx) * t + cx;
      if (Math.abs(dx) < 1e-6) break;
      t -= (sx(t) - clamped) / dx;
    }
    return sy(t);
  };
}
const gfEase = gfBezier(0.22, 1, 0.36, 1);

function gfPoseStr(p: { dx: number; dy: number; s: number }, tilt = -14): string {
  return `translate(${p.dx}px, ${p.dy}px) scale(${p.s}) rotateY(${tilt}deg)`;
}

/** 使卡片居中所需的目标 scrollTop（含边界钳制）。
 *  scrollTop 是局部像素，而 rect 差值是视觉像素（缩放会放大），故除以缩放系数 */
function gfCenterScrollTop(grid: HTMLElement, card: HTMLElement, zoom = 1): number {
  const ch = num((grid as unknown as { clientHeight?: unknown }).clientHeight);
  const sh = num((grid as unknown as { scrollHeight?: unknown }).scrollHeight);
  const gridTop = num(grid.getBoundingClientRect?.()?.top);
  const r = card.getBoundingClientRect?.();
  const cardCenter = num(r?.top) + num(r?.height) / 2 - gridTop;
  const delta = cardCenter - ch / 2;
  const max = Math.max(0, sh - ch);
  return Math.min(max, Math.max(0, num(grid.scrollTop) + delta / (zoom || 1)));
}

/** scrollTop 补间：与盒子飞回同缓动同时长（相机回撤对拍）。
 *  用 16ms 定时器而非 rAF 驱动：rAF 在无头/后台页不产帧时永不触发 */
function panScrollTo(
  el: HTMLElement,
  to: number,
  duration: number
): { done: Promise<void>; cancel: () => void } {
  const from = num(el.scrollTop);
  let timer = 0;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => (resolveDone = r));
  const cancel = () => {
    window.clearTimeout(timer);
    resolveDone();
  };
  if (
    Number.isFinite(from) &&
    Number.isFinite(to) &&
    Math.abs(to - from) >= 0.5 &&
    duration > 0
  ) {
    const t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / duration);
      el.scrollTop = Math.round(from + (to - from) * gfEase(t));
      if (t < 1) timer = window.setTimeout(step, 16);
      else resolveDone();
    };
    timer = window.setTimeout(step, 16);
  } else {
    el.scrollTop = to;
    resolveDone();
  }
  return { done, cancel };
}

/** 拖拽中的载荷（原生拖拽与触屏指针拖拽共用一套语义） */
type DragPayload =
  | { kind: "item"; item: WallItem }
  | { kind: "multi-item"; items: WallItem[] }
  | { kind: "group"; groupId: string };

/**
 * 跨视图 MIME 载荷。kind 缺省 = item（向后兼容：旧版本只写 srcPath + albumId）。
 * 分组拖拽也会带上载荷，但读取方必须用 kind !== "item" 排除，避免把分组当唱片迁移。
 * 多选拖拽用 kind="multi-item" + albumIds（同时保留 albumId 首项以兼容旧读取方）。
 */
interface WallDragData {
  kind?: "item" | "multi-item" | "group";
  srcPath: string;
  albumId?: number;
  albumIds?: number[];
  groupId?: string;
}

/**
 * 落点。`target: null` = 目标分区里一张卡片都没有（空分组），
 * 此时按「追加到该分组末尾」处理，绝不能拿被拖的唱片自己当锚点
 * （早期实现就是这样，于是拖进空分组会被 commitDrop 静默丢弃）。
 */
type DropTarget =
  | { kind: "item"; target: WallItem | null; place: Place; groupId: string }
  | { kind: "group"; anchorId: string; place: Place };

/**
 * 右键菜单项：只描述一次语义，渲染交给 showCtxMenu——
 * 普通布局走 Obsidian 原生 Menu，展示架走自绘木质菜单（见 ShelfMenu.ts）。
 */
interface CtxItem {
  /** 分隔线项：只有 sep，没有标题 */
  title?: string;
  /** lucide 图标名（原生菜单与木质菜单都支持） */
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  /** 分隔线 */
  sep?: boolean;
  /** 小标题行（不可点，用来给成组条目分节） */
  heading?: boolean;
  onPick?: () => void;
}

export class MusicWallView extends FileView implements WallHost {
  private plugin: MusicWallPlugin;
  private data: MusicWallData | null = null;
  allowNoFile = true;

  // 纯前端搜索词（落盘于 view 之外的会话态：输入即筛，不写文件）
  private q = "";
  private suppressSelf = false;
  /** SMTC 订阅取消函数 */
  private offNow: (() => void) | null = null;
  private appearanceMedia: MediaQueryList | null = null;
  private appearanceButton: HTMLButtonElement | null = null;
  private onAppearanceChange = () => this.refreshAppearance();
  private miniPlayer: MiniPlayer | null = null;
  private stopHostInset: (() => void) | null = null;

  /** 侧边抽屉（样式与布局 / 筛选 / 排序） */
  private drawer: SideDrawer | null = null;
  /** 右上角悬浮框（搜索本墙 / 添加专辑） */
  private floater: SideDrawer | null = null;
  private searchPanel: AlbumSearchPanel | null = null;
  /** 缩放盒：所有可见内容的父层，缩放作用在它身上（见 base.css .mw-zoombox） */
  private zoomBox: HTMLElement | null = null;
  /** 顶栏元素：它的高度写进 --mw-topbar-h，供抽屉/浮层定位（面板从顶栏下方开始） */
  private toolbarEl: HTMLElement | null = null;
  private toolbarObserver: ResizeObserver | null = null;

  /** 布局编辑态（手动排序 / 分组换序）：拖动实时落盘，退出即「完成」，没有回滚 */
  private editMode = false;

  /** 多选态：右上角图标进入，底部操作条退出；选中集为会话态，不落盘 */
  private selectMode = false;
  private selected = new Set<number>();

  /** 指针拖拽状态（仅触屏走这条路径） */
  private dragPayload: DragPayload | null = null;
  /** 原生拖拽进行中（本墙自己发起的原生拖拽；外来拖拽为 false） */
  private dragNative = false;
  /** 非编辑态在墙内拖拽被拒时，只提示一次 */
  private reorderHintShown = false;
  private dragGhost: HTMLElement | null = null;
  private dragLine: HTMLElement | null = null;
  private dragStart = { x: 0, y: 0 };
  private dragPointerId = -1;
  private dragActive = false;
  private dragTimer = 0;
  private dragCursor: { x: number; y: number } | null = null;
  private dragMoveTimer = 0;
  /** 拖拽边缘自动滚动：rAF 句柄 + 最近一次光标纵坐标（逐 dragover 步进太慢） */
  private autoScrollRaf = 0;
  private autoScrollGrid: HTMLElement | null = null;
  private autoScrollY = 0;
  private onDragMove = (e: PointerEvent) => this.handleDragMove(e);
  private onDragUp = (e: PointerEvent) => this.handleDragUp(e);

  constructor(leaf: WorkspaceLeaf, plugin: MusicWallPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return WALL_VIEW_TYPE;
  }
  getDisplayText(): string {
    return this.file
      ? t("wall.displayNameWith", { name: this.file.basename })
      : t("wall.displayName");
  }
  getIcon(): string {
    return "music";
  }

  /** 框架在绑定新文件后调用：读数据 + 渲染（setState/getState 由 FileView 基类接管） */
  async onLoadFile(file: TFile): Promise<void> {
    try {
      this.data = await loadWall(this.app.vault, file);
    } catch (e: any) {
      new Notice(t("wall.readFail", { error: e?.message ?? e }));
      this.data = null;
    }
    await this.render();
  }

  async onUnloadFile(file: TFile): Promise<void> {
    this.releasePress?.(); this.releasePress = null;
    this.disposeDrag(); this.closeContext?.(); this.closeContext = null;
    this.data = null;
  }

  /** 文件被重命名/移动：super 刷新标签页标题，render 刷新视图内工具栏标题 */
  async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    await this.render();
  }

  async onOpen(): Promise<void> {
    this.appearanceMedia = this.contentEl.ownerDocument.defaultView?.matchMedia("(prefers-color-scheme: dark)") || null;
    this.appearanceMedia?.addEventListener("change", this.onAppearanceChange);
    this.register(bindMouseBack(this.contentEl, () => {
      if (this.miniPlayer?.closeForBack()) return;
      if (this.drawer?.isOpen()) { this.drawer.close(); return; }
      if (this.detailOpen) { this.closeShelfDetail(); return; }
      if (this.editMode) this.exitEditMode();
    }));
    this.registerEvent(
      this.app.vault.on("modify", (f) => {
        if (this.suppressSelf) return;
        if (this.file && f.path === this.file.path) {
          void this.reload().then(() => this.render());
        }
      })
    );
    // 开盒详情内：Esc 返回展示架；编辑布局：Esc 视为「完成」
    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (this.drawer?.isOpen()) return; // 抽屉自己处理
      if (this.editMode) {
        this.exitEditMode();
        new Notice(t("wall.editbar.exited"));
        return;
      }
      this.closeShelfDetail();
    });
    // 接收外来拖拽（其他墙拖来的唱片）：本墙永远可以接收，编辑态也照收。
    // 本墙自己发起的拖拽在 dragover 阶段读不到载荷（浏览器安全限制），
    // 因此用 dragNative 标志区分「自己的拖拽」与「外来拖拽」。
    this.registerDomEvent(this.contentEl, "dragover", (e: DragEvent) => {
      if (this.dragNative) return; // 本墙拖拽：由 .mw-grid 决定接收与否
      if (e.dataTransfer?.types.includes(WALL_DRAG_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    });
    this.registerDomEvent(this.contentEl, "drop", (e: DragEvent) => {
      if (this.dragNative) return;
      const raw = e.dataTransfer?.getData(WALL_DRAG_MIME);
      if (!raw || !this.file) return;
      e.preventDefault();
      try {
        const p = JSON.parse(raw) as WallDragData;
        // 分组拖拽不是迁移
        if (p.kind === "group") return;
        const ids = Array.isArray(p.albumIds)
          ? p.albumIds.filter((x) => typeof x === "number")
          : typeof p.albumId === "number"
            ? [p.albumId]
            : [];
        if (!ids.length) return;
        if (p.srcPath !== this.file.path) {
          if (ids.length > 1) {
            void this.plugin.receiveWallBatch(p.srcPath, ids, this.file);
          } else {
            void this.plugin.receiveWallDrag(p.srcPath, ids[0], this.file);
          }
        }
      } catch {
        /* 载荷损坏：忽略 */
      }
    });
    // SMTC：订阅正在播放，命中的唱片高亮（仅 Windows 桌面端会有数据）
    this.offNow = this.plugin.nowPlaying.on((s) => this.applyNowPlaying(s));
    this.register(() => this.offNow?.());
    this.register(() => this.disposeDrag());
    // Ctrl/Alt + 滚轮：全局缩放（捕获阶段拦下，避免连带触发 Obsidian 自己的缩放）
    this.registerDomEvent(
      this.contentEl,
      "wheel",
      (e: WheelEvent) => {
        handleZoomWheel(e, this.plugin, this.contentEl);
      },
      { passive: false, capture: true }
    );
    // 无文件（新建/瞬态）时也要有可读的界面，onLoadFile 接管后续渲染
    await this.render();
    this.stopHostInset?.();
    this.stopHostInset = watchHostInset(this.contentEl);
  }

  /** SMTC 正在播放 → 墙上命中唱片加高亮环 + 角标；匹配不上则不高亮 */
  private applyNowPlaying(state: NowPlayingState): void {
    const root = this.contentEl;
    root.toggleClass("mw-np-paused", state.active && state.status !== "playing");
    for (const el of Array.from(
      root.querySelectorAll<HTMLElement>("[data-mw-album].is-now-playing")
    )) {
      el.removeClass("is-now-playing");
    }
    if (!this.data) return;
    const hit = matchNowPlaying(state, this.data.items);
    if (!hit) return;
    const card = root.querySelector<HTMLElement>(
      `[data-mw-album="${hit.albumId}"]`
    );
    card?.addClass("is-now-playing");
  }

  refreshAppearance(): void {
    const mode = this.plugin.settings.wallAppearance || "system";
    const dark = mode === "dark" || mode === "system" && (this.appearanceMedia?.matches ?? this.contentEl.ownerDocument.body.classList.contains("theme-dark"));
    this.contentEl.dataset.wallTheme = dark ? "dark" : "light";
    if (this.appearanceButton) {
      setIcon(this.appearanceButton, mode === "light" ? "sun" : mode === "dark" ? "moon" : "sun-moon");
      const label = t("libraryAppearance.current", { mode: t(`libraryAppearance.${mode}`) });
      this.appearanceButton.title = label; this.appearanceButton.setAttr("aria-label", label);
    }
  }
  private openPluginSettings(): void {
    const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
    setting?.open(); setting?.openTabById(this.plugin.manifest.id);
  }
  /** 供设置页/外部触发重绘 */
  refresh(): void {
    void this.render();
  }

  async onClose(): Promise<void> {
    this.appearanceMedia?.removeEventListener("change", this.onAppearanceChange); this.appearanceMedia = null; this.appearanceButton = null;
    this.detailArtistPicker?.close(); this.detailArtistPicker = null;
    this.detailArtistRequest++;
    this.releasePress?.(); this.releasePress = null;
    this.closeContext?.(); this.closeContext = null;
    this.stopHostInset?.(); this.stopHostInset = null;
    this.offNow?.(); this.offNow = null;
    this.miniPlayer?.dispose(); this.miniPlayer = null;
    this.drawer?.dispose();
    this.drawer = null;
    this.toolbarObserver?.disconnect();
    this.toolbarObserver = null;
    this.toolbarEl = null;
    this.disposeDrag();
    disposeZoomBox(this.contentEl);
    // registerEvent 随组件自动卸载
  }

  private async reload(): Promise<void> {
    if (!this.file) return;
    try {
      this.data = await loadWall(this.app.vault, this.file);
    } catch (e: any) {
      new Notice(t("wall.readFail", { error: e?.message ?? e }));
    }
  }

  private async persist(): Promise<void> {
    if (!this.file || !this.data) return;
    this.suppressSelf = true;
    try {
      await saveWall(this.app.vault, this.file, this.data);
    } finally {
      // 自己的写入会触发 modify 事件，稍后解除抑制
      window.setTimeout(() => (this.suppressSelf = false), 400);
    }
  }

  /** 写盘 + 整页重绘（结构变更用） */
  private async commit(notice?: string): Promise<void> {
    await this.persist();
    if (notice) new Notice(notice);
    this.render();
  }

  // ---- 供 main.ts 使用的公开访问器 ----
  getFile(): TFile | null {
    return this.file;
  }
  getData(): MusicWallData | null {
    return this.data;
  }
  async saveData(): Promise<void> {
    await this.persist();
    this.render();
  }

  /** 从本墙移出条目并保存（迁移流程调用） */
  async takeOutItem(albumId: number): Promise<void> {
    await this.takeOutItems([albumId]);
  }

  /** 批量移出条目并保存（多选/拖拽批量迁移共用，一次落盘一次重绘） */
  async takeOutItems(albumIds: number[]): Promise<void> {
    if (!this.data || !albumIds.length) return;
    const drop = new Set(albumIds);
    this.data.items = this.data.items.filter((i) => !drop.has(i.albumId));
    if (this.data.order) {
      this.data.order = removeFromOrder(this.data.order, albumIds);
    }
    for (const id of albumIds) this.selected.delete(id);
    await this.persist();
    this.render();
    if (this.selectMode) this.renderSelectionBar();
  }

  // ---- WallHost 接口（供 SearchAlbumModal 调用） ----

  getExistingIds(): Set<number> {
    return new Set((this.data?.items ?? []).map((i) => i.albumId));
  }
  getStyle(): DiscStyle {
    return this.data?.style ?? this.plugin.settings.defaultStyle;
  }
  async searchAlbums(keyword: string, offset: number): Promise<AlbumSummary[]> {
    return this.plugin.searchAlbums(keyword, offset);
  }
  async fetchAlbumDetail(albumId: number): Promise<AlbumMeta> {
    return this.plugin.fetchAlbumDetail(albumId);
  }
  async enqueueAlbum(meta: AlbumMeta): Promise<void> { await this.plugin.enqueueAlbum(this.data?.items.some(item => item.albumId === meta.albumId) ? { ...meta, playbackWallPath: this.getFile()?.path } : meta); }
  revealAlbum(albumId: number): void {
    this.contentEl.querySelector<HTMLElement>(`[data-mw-album="${albumId}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  getPlaybackDeps(): import("../core/playback").PlaybackDeps {
    const wrap = (deps: import("../core/playback").PlaybackDeps): import("../core/playback").PlaybackDeps => ({
      ...deps,
      authorize: deps.authorize ? async () => { const next = await deps.authorize!(); return next ? wrap(next) : null; } : undefined,
      playInside: deps.playInside ? (meta, index) => deps.playInside!(this.data?.items.some(item => item.albumId === meta.albumId) ? { ...meta, playbackWallPath: this.getFile()?.path } : meta, index) : undefined,
    });
    return wrap(this.plugin.getPlaybackDeps());
  }
  private albumPanelNavigation(): import("./AlbumPanelModal").AlbumPanelNavigation {
    return {
      openAlbum: meta => this.plugin.openLibraryCollection(meta),
      openArtist: artist => this.plugin.openLibraryArtist({ ...artist, cover: "" }),
      fetchAlbum: id => this.fetchAlbumDetail(id),
      accountKey: () => this.plugin.settings.neteaseCookie,
    };
  }
  confirmAdd(meta: AlbumMeta, onAdd: () => void): void {
    new AlbumPanelModal(this.app, "add", {
      meta,
      style: this.getStyle(),
      source: "search",
      navigation: this.albumPanelNavigation(),
      deps: this.getPlaybackDeps(),
      onAdd: () => {
        onAdd();
        new Notice(t("wall.card.added", { name: meta.name }));
      },
    }).open();
  }
  addAlbum(meta: AlbumMeta, source: "search" | "manual"): void {
    if (!this.data) return;
    if (this.getExistingIds().has(meta.albumId)) {
      new Notice(t("wall.card.alreadyIn"));
      return;
    }
    this.data.items.push({
      albumId: meta.albumId,
      source,
      locked: source === "search",
      meta,
      addedAt: new Date().toISOString(),
      // 新专辑一律进「未分组」，之后用拖拽或右键「移动到分组 ▸」归组
    });
    // 已有手动顺序时把新条目追加到末尾，避免它插到墙中间
    if (this.data.order) {
      this.data.order = normalizeOrder(this.data.items, this.data.order);
    }
    void this.persist().then(() => this.render());
  }

  // ---- 视图状态存取（落盘于 .mw 的 view 字段） ----

  private ensureView(): NonNullable<MusicWallData["view"]> {
    const data = this.data!;
    if (!data.view) data.view = {};
    return data.view;
  }

  private get sortMode(): SortMode {
    return this.data?.view?.sortMode ?? "addedAt";
  }

  private get sortAsc(): boolean {
    return this.data?.view?.sortAsc ?? true;
  }

  private get filterArtists(): string[] {
    return this.data?.view?.filterArtists ?? [];
  }

  private get filterDecades(): string[] {
    return this.data?.view?.filterDecades ?? [];
  }

  private get filterTags(): string[] {
    return this.data?.view?.filterTags ?? [];
  }

  private get filterRatings(): number[] {
    return this.data?.view?.filterRatings ?? [];
  }

  private get filtering(): boolean {
    return (
      !!this.q ||
      this.filterArtists.length > 0 ||
      this.filterDecades.length > 0 ||
      this.filterTags.length > 0 ||
      this.filterRatings.length > 0
    );
  }

  private setSort(mode: SortMode): void {
    const view = this.ensureView();
    view.sortMode = mode;
    if (mode === "manual") this.ensureOrder();
    void this.commit();
  }

  private setSortAsc(asc: boolean): void {
    this.ensureView().sortAsc = asc;
    void this.commit();
  }

  /** 确保存在完整的手动顺序（首次真正需要时才写入文件） */
  private ensureOrder(): number[] {
    const data = this.data!;
    data.order = normalizeOrder(data.items, data.order);
    return data.order;
  }

  /** 当前展示顺序（手动模式用 order，其余按排序键排） */
  private getVisibleItems(): WallItem[] {
    let items = [...(this.data?.items ?? [])];
    if (this.q) {
      const q = this.q.toLowerCase();
      items = items.filter(
        (i) =>
          i.meta.name.toLowerCase().includes(q) ||
          i.meta.artist.toLowerCase().includes(q) ||
          (i.meta.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    }
    const artists = this.filterArtists;
    if (artists.length) items = items.filter((i) => artists.includes(i.meta.artist));
    const decades = this.filterDecades;
    if (decades.length) items = items.filter((i) => decades.includes(decadeOf(i.meta.year)));
    const tags = this.filterTags;
    if (tags.length) {
      items = items.filter((i) => (i.meta.tags ?? []).some((t) => tags.includes(t)));
    }
    const ratings = this.filterRatings;
    if (ratings.length) {
      items = items.filter((i) => ratings.includes(i.rating ?? 0));
    }

    if (this.sortMode === "manual") {
      const order = normalizeOrder(this.data?.items ?? [], this.data?.order);
      const rank = new Map<number, number>();
      order.forEach((id, i) => rank.set(id, i));
      const dir = this.sortAsc ? 1 : -1;
      items.sort(
        (a, b) => ((rank.get(a.albumId) ?? 0) - (rank.get(b.albumId) ?? 0)) * dir
      );
      return items;
    }

    const dir = this.sortAsc ? 1 : -1;
    const key = this.sortMode;
    items.sort((a, b) => {
      let r = 0;
      switch (key) {
        case "name":
          r = a.meta.name.localeCompare(b.meta.name, "zh");
          break;
        case "artist":
          r = a.meta.artist.localeCompare(b.meta.artist, "zh");
          break;
        case "year":
          r = (a.meta.year ?? "").localeCompare(b.meta.year ?? "");
          break;
        case "rating": {
          // 未评分恒沉底（升/降序都最后），已评分部分按方向排
          const ar = a.rating ?? 0;
          const br = b.rating ?? 0;
          if (!ar && !br) r = 0;
          else if (!ar) return 1;
          else if (!br) return -1;
          else r = ar - br;
          break;
        }
        case "addedAt":
          r = a.addedAt.localeCompare(b.addedAt);
          break;
      }
      return r * dir;
    });
    return items;
  }

  // ---- 渲染 ----

  private async render(): Promise<void> {
    this.closeContext?.(); this.closeContext = null;
    const root = this.contentEl;
    this.miniPlayer?.dispose(); this.miniPlayer = null;
    // 场景动画句柄随 root 重建失效：先令牌失效 + cancel + 复位状态机
    this.resetDetailState();
    // 重建会丢滚动位置（迁移/删除/样式切换等），先记后还
    const prevScroll = root.querySelector<HTMLElement>(".mw-grid")?.scrollTop ?? 0;
    // 抽屉/浮层内容随 root 重建，但开合状态要保留（重建后按同一 key 还原）
    const prevDrawer = this.drawer?.currentKey() ?? null;
    const prevFloater = this.floater?.currentKey() ?? null;
    this.drawer?.dispose();
    this.drawer = null;
    this.floater?.dispose();
    this.floater = null;
    this.searchPanel?.dispose();
    this.searchPanel = null;
    this.disposeDrag();

    root.empty();
    root.addClass("mw-view");
    const cap = this.plugin.settings.shelfCaption ?? "pull";
    root.removeClass("mw-shelfcap-hidden", "mw-shelfcap-pull", "mw-shelfcap-always");
    root.addClass(`mw-shelfcap-${cap}`);
    // 所有内容放进缩放盒：缩放放在没有 overflow 裁剪的中间层，
    // 才能既精确铺满窗格又不被裁掉（见 base.css 的 .mw-zoombox 说明）
    const box = root.createDiv({ cls: "mw-zoombox" });
    this.zoomBox = box;
    if (!this.data) {
      box.createDiv({ cls: "mw-empty", text: t("wall.empty.noFile") });
      return;
    }

    this.toolbarEl = this.renderToolbar(box);
    this.watchTopbarHeight();
    const layout = this.data.layout ?? "grid";
    // 墙面类名：驱动顶栏与墙面同一张画布（展示架的木纹底挂在根上，见 base.css）
    root.removeClass("mw-wall--grid", "mw-wall--list", "mw-wall--shelf");
    root.addClass(`mw-wall--${layout}`);
    this.refreshAppearance();
    // 模态框挂在 body 上，不在本子树里：渲染时登记皮肤，弹窗自己来取（见 modalTheme.ts）
    setModalTheme(layout === "shelf" ? "shelf" : "default");
    const stage = box.createDiv({ cls: "mw-stage" });
    const grid = stage.createDiv({
      cls:
        layout === "list"
          ? "mw-grid mw-grid--list"
          : layout === "shelf"
            ? "mw-grid mw-grid--shelf"
            : "mw-grid",
    });
    grid.style.setProperty("--mw-min-col", "180px");
    // 网格级监听只在「新建网格元素」时接一次：renderGrid 会被 rerenderGrid 反复调用，
    // 在里面 addEventListener 会重复注册
    this.wireGridDragTarget(grid);
    if (layout === "shelf") {
      // 展示架：滚动或点空白即收起所有抽出卡
      grid.addEventListener("scroll", () => this.retractAllShelf());
      grid.addEventListener("click", (e) => {
        if (!(e.target as HTMLElement | null)?.closest(".mw-shelf-card")) {
          this.retractAllShelf();
        }
      });
    }
    this.renderGrid(grid);
    this.miniPlayer = new MiniPlayer(box, this.plugin);
    grid.scrollTop = prevScroll;
    if (layout === "shelf") {
      // 开盒详情 overlay（懒填充）：点唱片推镜放大后绕书脊 3D 翻开。
      // 必须挂在**缩放盒**上而不是 .mw-stage 里：.mw-stage 带 contain: layout 会形成
      // 堆叠上下文，overlay 的 inset:0 只能盖住「顶栏以下」，顶栏那一条（墙名 + 6 个图标）
      // 会露在黑底之上（用户报的「背景黑色没能覆盖全屏」）。与抽屉/浮层同理。
      // 尺寸参照随之改为缩放盒的尺寸容器（见 base.css 的 `container: mw-pane / size`）。
      box.createDiv({ cls: "mw-shelf-detail" });
    }
    // 抽屉（侧边）与浮层（右上角）挂在缩放盒上（absolute 覆盖层）：
    // 两者必须与遮罩同层，才能既压暗顶栏与四周、又让面板盖在遮罩之上
    // （.mw-stage 带 contain: layout 会形成堆叠上下文，把面板困在卡片那一层）。
    // 面板从顶栏下方开始：靠 --mw-topbar-h（见 watchTopbarHeight）。
    const drawer = this.buildDrawer(box);
    const floater = this.buildFloater(box);
    this.drawer = drawer;
    this.floater = floater;
    if (prevDrawer) drawer.open(prevDrawer);
    if (prevFloater) floater.open(prevFloater);
    // 重建后重新施加「正在播放」高亮 + 编辑态提示条
    this.applyNowPlaying(this.plugin.nowPlaying.state);
    if (this.editMode) this.renderEditBar();
    if (this.selectMode) {
      this.pruneSelection();
      this.contentEl.toggleClass("mw-selecting", true);
      this.renderSelectionBar();
      this.syncToolbarState();
    }
    // 缩放盒尺寸兜底（见 zoom.ts syncZoomBox）：CSS 的 calc 反除补偿一旦退化，
    // 表现就是「右侧 + 底部留白」，这里用像素把尺寸钉死
    syncZoomBox(root, this.zoom);
  }

  // ---- 顶部工具栏（固定，不随网格滚动） ----

  /**
   * 把「顶栏底部相对缩放盒的距离」写进 --mw-topbar-h（局部像素，缩放盒内直接可用）：
   * 侧边抽屉与右上角浮层都要从顶栏下方开始，否则会盖住顶栏图标。
   * 用 offsetTop + offsetHeight 而不是 offsetHeight：编辑态下编辑条是顶栏上面的一行，
   * 顶栏被推下去，只取高度会让面板盖住编辑条。
   * 窄容器下工具栏会换行（高度变化），所以用 ResizeObserver 跟随。
   */
  private watchTopbarHeight(): void {
    this.toolbarObserver?.disconnect();
    this.toolbarObserver = null;
    const bar = this.toolbarEl;
    if (!bar) return;
    const apply = () => {
      const h = bar.offsetTop + bar.offsetHeight;
      // 注意：写的是「局部像素」（缩放盒内），缩放由 transform 另外负责
      if (h > 0) this.contentEl.style.setProperty("--mw-topbar-h", `${h}px`);
    };
    apply();
    if (typeof ResizeObserver === "function") {
      this.toolbarObserver = new ResizeObserver(apply);
      this.toolbarObserver.observe(bar);
    }
  }

  private renderToolbar(root: HTMLElement): HTMLElement {
    const bar = root.createDiv({ cls: "mw-toolbar" });

    const left = bar.createDiv({ cls: "mw-toolbar__left" });
    const title = left.createDiv({
      cls: "mw-toolbar__title",
      text: this.file?.basename ?? this.data!.name,
    });
    title.setAttr("title", t("wall.toolbar.renameTip"));
    title.addEventListener("click", () => this.renameWall());
    left.createDiv({
      cls: "mw-toolbar__count",
      text: t("common.albumCount", { count: this.data!.items.length }),
    });

    const actions = bar.createDiv({ cls: "mw-toolbar__actions" });
    // 顶部图标一律「只有图标」：加 Obsidian 自带的 clickable-icon 类，
    // 主题的 button:not(.clickable-icon)（特异性 0,1,1）就不会再给它刷白底圆角
    const mkIcon = (
      icon: string,
      label: string,
      onClick: (btn: HTMLButtonElement) => void,
      extraCls = ""
    ) => {
      const btn = actions.createEl("button", {
        cls: extraCls
          ? `clickable-icon mw-toolbtn ${extraCls}`
          : "clickable-icon mw-toolbtn",
      });
      btn.setAttr("type", "button");
      btn.setAttr("aria-label", label);
      btn.setAttr("title", label);
      setIcon(btn, icon);
      btn.addEventListener("click", () => onClick(btn));
      return btn;
    };

    const styleBtn = mkIcon("palette", t("wall.toolbar.style"), () => {
      this.drawer?.toggle("style");
    });
    const filterBtn = mkIcon("filter", t("wall.toolbar.filter"), () => {
      this.drawer?.toggle("filter");
    });
    const sortBtn = mkIcon("arrow-up-down", t("wall.toolbar.sort"), () => {
      this.drawer?.toggle("sort");
    });
    const addBtn = mkIcon("plus", t("wall.toolbar.add"), () => {
      this.floater?.toggle("add");
    });
    const searchBtn = mkIcon("search", t("wall.toolbar.search"), () => {
      this.floater?.toggle("search");
    });
    const selectBtn = mkIcon("check-square", t("wall.toolbar.select"), () => {
      if (this.selectMode) this.exitSelectMode();
      else this.enterSelectMode();
    });
    this.appearanceButton = mkIcon("sun-moon", t("wallAppearance.title"), () => {
      const modes = ["system", "light", "dark"] as const;
      this.plugin.settings.wallAppearance = modes[(modes.indexOf(this.plugin.settings.wallAppearance || "system") + 1) % 3];
      this.refreshAppearance(); this.plugin.refreshWallAppearance?.();
      void this.plugin.saveData(this.plugin.settings).catch(() => new Notice(t("library.failed")));
    }, "mw-wall-appearance");
    this.appearanceButton.addEventListener("contextmenu", event => {
      event.preventDefault(); event.stopPropagation();
      this.showCtxMenu(event, [{ title: t("wall.settingsPanel.open"), icon: "settings", onPick: () => this.openPluginSettings() }]);
    });
    const moreBtn = mkIcon("more-horizontal", t("wall.toolbar.more"), (btn) => {
      const rect = btn.getBoundingClientRect();
      this.openMoreMenu({ x: rect.left, y: rect.bottom + 4 } as MouseEvent);
    });

    // 抽屉/浮层开合 → 图标激活态同步
    this.drawerState = { styleBtn, filterBtn, sortBtn, searchBtn, addBtn, moreBtn, selectBtn };
    this.syncToolbarState();
    return bar;
  }

  private drawerState: {
    styleBtn?: HTMLButtonElement;
    filterBtn?: HTMLButtonElement;
    sortBtn?: HTMLButtonElement;
    searchBtn?: HTMLButtonElement;
    addBtn?: HTMLButtonElement;
    moreBtn?: HTMLButtonElement;
    selectBtn?: HTMLButtonElement;
  } = {};

  private syncToolbarState(): void {
    const key = this.drawer?.currentKey() ?? null;
    const floatKey = this.floater?.currentKey() ?? null;
    const s = this.drawerState;
    s.styleBtn?.toggleClass("is-active", key === "style");
    s.filterBtn?.toggleClass("is-active", key === "filter" || this.filtering);
    s.sortBtn?.toggleClass("is-active", key === "sort");
    s.searchBtn?.toggleClass("is-active", floatKey === "search" || !!this.q);
    s.addBtn?.toggleClass("is-active", floatKey === "add");
    s.selectBtn?.toggleClass("is-active", this.selectMode);
    s.moreBtn?.removeClass("is-active");
  }

  /** 搜索/添加面板已改为右上角悬浮框，这里只保留聚焦（供外部调用） */
  private focusWallSearch(): void {
    this.floater?.open("search");
    window.setTimeout(() => {
      this.floater
        ?.currentBodyEl()
        ?.querySelector<HTMLInputElement>(".mw-panel__input")
        ?.focus();
    }, 0);
  }

  // ---- 浮层（侧边抽屉 + 右上角悬浮框） ----

  private buildDrawer(host: HTMLElement): SideDrawer {
    const drawer = new SideDrawer(host, () => {
      // 侧边与悬浮互斥：开一个就收起另一个
      if (drawer.isOpen()) this.floater?.close();
      this.syncToolbarState();
      if (this.editMode) this.renderEditBar();
    });
    drawer.register("style", t("wall.drawer.style"), (body) =>
      this.panelStyle(body)
    );
    drawer.register("filter", t("wall.drawer.filter"), (body, api) =>
      this.panelFilter(body, api)
    );
    drawer.register("sort", t("wall.drawer.sort"), (body, api) =>
      this.panelSort(body, api)
    );
    drawer.register("settings", t("wall.drawer.settings"), (body) =>
      this.panelSettings(body)
    );
    return drawer;
  }

  /**
   * 右上角悬浮框：搜索本墙 + 添加专辑。
   * 不用底部搜索条（反馈：会多占一条横条），也不因点击墙面而关闭——
   * 搜索时通常要边筛边看墙。
   */
  private buildFloater(host: HTMLElement): SideDrawer {
    const floater = new SideDrawer(
      host,
      () => {
        if (floater.isOpen()) this.drawer?.close();
        this.syncToolbarState();
      },
      "float"
    );
    floater.register("search", t("wall.drawer.search"), (body) =>
      this.panelWallSearch(body)
    );
    floater.register("add", t("wall.drawer.add"), (body) => {
      this.searchPanel?.dispose();
      const panel = new AlbumSearchPanel(this);
      this.searchPanel = panel;
      panel.batchOpener = () => this.openBatchAdd();
      panel.mount(body);
    });
    return floater;
  }

  /** 打开批量导入弹窗（添加浮层内的批量按钮入口） */
  private openBatchAdd(): void {
    new BatchAddModal(this.app, {
      fetchAlbumDetail: (id: number) => this.fetchAlbumDetail(id),
      getExistingIds: () => this.getExistingIds(),
      addAlbum: (meta: AlbumMeta, source: "search" | "manual") => this.addAlbum(meta, source),
      getPlaybackDeps: () => this.getPlaybackDeps(),
      getStyle: () => this.getStyle(),
      navigation: this.albumPanelNavigation(),
    }).open();
  }

  /**
   * 输入框 + 右端 × 清空钮（面板统一形态）。
   * 不再用整宽「清空」按钮（反馈：太长太占地方），× 在输入为空时自动隐藏。
   */
  private buildSearchField(
    host: HTMLElement,
    value: string,
    placeholder: string,
    onChange: (v: string) => void
  ): HTMLInputElement {
    const bar = host.createDiv({ cls: "mw-panel__searchbar" });
    const input = bar.createEl("input", {
      type: "search",
      cls: "mw-panel__input",
      placeholder,
    });
    input.value = value;
    const clear = bar.createEl("button", { cls: "clickable-icon mw-panel__clearicon" });
    clear.setAttr("type", "button");
    clear.setAttr("aria-label", t("wall.filterPanel.clear"));
    clear.setAttr("title", t("wall.filterPanel.clear"));
    setIcon(clear, "x");
    const syncClear = () => clear.toggleClass("is-hidden", !input.value.length);
    input.addEventListener("input", () => {
      onChange(input.value);
      syncClear();
    });
    clear.addEventListener("click", () => {
      if (!input.value.length) return;
      input.value = "";
      onChange("");
      syncClear();
      input.focus();
    });
    syncClear();
    return input;
  }

  /** 搜索本墙：输入即筛（命中数 + 右端 × 清空） */
  private panelWallSearch(body: HTMLElement): void {
    const sec = body.createDiv({ cls: "mw-panel__section" });
    sec.createDiv({ cls: "mw-panel__label", text: t("wall.wallSearch.keyword") });
    const input = this.buildSearchField(sec, this.q, t("wall.wallSearch.ph"), (v) => {
      this.q = v;
      this.syncToolbarState();
      this.rerenderGrid();
      syncCount();
    });
    const count = sec.createDiv({ cls: "mw-panel__hint" });
    const syncCount = () => {
      if (!this.q) {
        count.setText(
          t("wall.wallSearch.showing", {
            count: this.getVisibleItems().length,
          })
        );
        return;
      }
      count.setText(
        t("wall.wallSearch.hits", { count: this.getVisibleItems().length })
      );
    };
    syncCount();
    window.setTimeout(() => input.focus(), 0);
  }

  /**
   * 样式与布局面板：**布局在上、唱片样式在下**（第四轮反馈：原来反了）。
   * 唱片样式只在网格布局下生效（列表统一用封面缩略图、展示架按封套陈列），
   * 因此非网格布局不渲染那一组，只留一行说明，避免摆一组点了没反应的瓷砖。
   */
  private panelStyle(body: HTMLElement): void {
    const current = this.data!.layout ?? "grid";

    const secLayout = body.createDiv({ cls: "mw-panel__section" });
    secLayout.createDiv({
      cls: "mw-panel__label",
      text: t("wall.stylePanel.layout"),
    });
    const layouts = secLayout.createDiv({ cls: "mw-preset-grid mw-preset-grid--3" });
    for (const l of ["grid", "list", "shelf"] as WallLayout[]) {
      layouts.appendChild(
        buildLayoutTile(l, layoutLabel(l), current === l, (picked) => {
          this.data!.layout = picked === "grid" ? undefined : picked;
          void this.commit();
        })
      );
    }

    if (current === "grid") {
      const cover = firstCover(this.data!.items);
      const secStyle = body.createDiv({ cls: "mw-panel__section" });
      secStyle.createDiv({
        cls: "mw-panel__label",
        text: t("wall.stylePanel.disc"),
      });
      const grid = secStyle.createDiv({ cls: "mw-preset-grid" });
      for (const s of ALL_STYLES) {
        grid.appendChild(
          buildStyleTile(s, styleLabel(s), cover, this.data!.style === s, (picked) => {
            this.data!.style = picked;
            void this.commit();
          })
        );
      }
      return;
    }

  }

  /** 筛选面板：搜索 + 多选艺术家/年代/标签（同维度 OR，维度间 AND） */
  private panelFilter(body: HTMLElement, api: { refresh(): void }): void {
    const items = this.data!.items;

    const searchSec = body.createDiv({ cls: "mw-panel__section" });
    searchSec.createDiv({
      cls: "mw-panel__label",
      text: t("wall.filterPanel.keyword"),
    });
    this.buildSearchField(searchSec, this.q, t("wall.filterPanel.ph"), (v) => {
      this.q = v;
      this.syncToolbarState();
      this.rerenderGrid();
    });

    const uniq = (fn: (i: WallItem) => string | undefined) => {
      const counts = new Map<string, number>();
      for (const i of items) {
        const v = fn(i);
        if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh"));
    };

    const facet = (
      title: string,
      options: [string, number][],
      selected: string[],
      apply: (next: string[]) => void
    ) => {
      if (!options.length) return;
      const sec = body.createDiv({ cls: "mw-panel__section" });
      const head = sec.createDiv({ cls: "mw-panel__section-head" });
      head.createDiv({ cls: "mw-panel__label", text: title });
      const clearBtn = head.createEl("button", {
        cls: "mw-panel__clear",
        text: t("wall.filterPanel.clearFacet"),
      });
      clearBtn.setAttr("type", "button");
      clearBtn.toggleClass("is-disabled", selected.length === 0);
      clearBtn.addEventListener("click", () => {
        if (!selected.length) return;
        apply([]);
        api.refresh();
      });
      const list = sec.createDiv({ cls: "mw-panel__list" });
      for (const [value, count] of options) {
        const row = list.createEl("label", { cls: "mw-check" });
        const box = row.createEl("input", { type: "checkbox", cls: "mw-check__box" });
        box.checked = selected.includes(value);
        box.addEventListener("change", () => {
          const cur = new Set(selected);
          if (box.checked) cur.add(value);
          else cur.delete(value);
          apply([...cur]);
          this.rerenderGrid();
          this.syncToolbarState();
        });
        row.createSpan({ cls: "mw-check__text", text: value });
        row.createSpan({ cls: "mw-check__count", text: String(count) });
      }
    };

    const view = this.ensureView();
    facet(
      t("wall.filterPanel.artist"),
      uniq((i) => i.meta.artist),
      this.filterArtists,
      (next) => {
        if (next.length) view.filterArtists = next;
        else delete view.filterArtists;
        void this.persist();
      }
    );
    facet(
      t("wall.filterPanel.decade"),
      uniq((i) => decadeOf(i.meta.year)),
      this.filterDecades,
      (next) => {
        if (next.length) view.filterDecades = next;
        else delete view.filterDecades;
        void this.persist();
      }
    );
    const tagOptions = new Map<string, number>();
    for (const i of items) {
      for (const t of i.meta.tags ?? []) tagOptions.set(t, (tagOptions.get(t) ?? 0) + 1);
    }
    facet(
      t("wall.filterPanel.tag"),
      [...tagOptions.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh")),
      this.filterTags,
      (next) => {
        if (next.length) view.filterTags = next;
        else delete view.filterTags;
        void this.persist();
      }
    );
    // 评分 facet：5→1＋未评分（数值维度，单独渲染；选中值存 view.filterRatings，0 = 未评分）
    {
      const counts = new Map<number, number>();
      for (const i of items) {
        const k = i.rating ?? 0;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const order = [5, 4, 3, 2, 1, 0];
      if (order.some((k) => counts.has(k))) {
        const selected = new Set(this.filterRatings);
        const sec = body.createDiv({ cls: "mw-panel__section" });
        const head = sec.createDiv({ cls: "mw-panel__section-head" });
        head.createDiv({
          cls: "mw-panel__label",
          text: t("wall.filterPanel.ratingKey"),
        });
        const clearBtn = head.createEl("button", {
          cls: "mw-panel__clear",
          text: t("wall.filterPanel.clearFacet"),
        });
        clearBtn.setAttr("type", "button");
        clearBtn.toggleClass("is-disabled", selected.size === 0);
        clearBtn.addEventListener("click", () => {
          if (!selected.size) return;
          delete view.filterRatings;
          void this.persist();
          api.refresh();
        });
        const list = sec.createDiv({ cls: "mw-panel__list" });
        for (const k of order) {
          if (!counts.has(k)) continue;
          const row = list.createEl("label", { cls: "mw-check" });
          const box = row.createEl("input", { type: "checkbox", cls: "mw-check__box" });
          box.checked = selected.has(k);
          box.addEventListener("change", () => {
            const cur = new Set(view.filterRatings ?? []);
            if (box.checked) cur.add(k);
            else cur.delete(k);
            if (cur.size) view.filterRatings = [...cur].sort((a, b) => b - a);
            else delete view.filterRatings;
            void this.persist();
            this.rerenderGrid();
            this.syncToolbarState();
          });
          row.createSpan({
            cls: "mw-check__text",
            text:
              k === 0
                ? t("wall.filterPanel.unrated")
                : t("wall.filterPanel.score", { value: k }),
          });
          row.createSpan({ cls: "mw-check__count", text: String(counts.get(k) ?? 0) });
        }
      }
    }

    if (this.filtering) {
      const reset = body.createEl("button", {
        cls: "mw-btn mw-panel__reset",
        text: t("wall.filterPanel.clearAll"),
      });
      reset.setAttr("type", "button");
      reset.addEventListener("click", () => {
        this.q = "";
        delete view.filterArtists;
        delete view.filterDecades;
        delete view.filterTags;
        delete view.filterRatings;
        void this.persist();
        this.render();
      });
    }
  }

  /**
   * 当前墙是否为展示架布局（决定右键菜单与弹窗用木质皮肤还是主题原生外观）
   */
  private isShelf(): boolean {
    return (this.data?.layout ?? "grid") === "shelf";
  }

  /**
   * 统一右键菜单入口：菜单项只描述一次，皮肤按布局选。
   *
   * 展示架用自绘木质菜单——原生 Menu 是「白色圆角底 + 主题紫高亮」，
   * 与木墙是两套语言（第五轮反馈 A3）；其它布局保持原生菜单。
   */
  private showCtxMenu(evt: MouseEvent, items: CtxItem[]): void {
    this.disposeDrag(); this.closeContext?.(); this.closeContext = null;
    // 两种调用方式都要兼容：真实事件用 clientX/Y，触屏长按传的是 {x, y} 合成对象
    const x = num(evt.clientX ?? evt.x);
    const y = num(evt.clientY ?? evt.y);
    if (this.isShelf()) {
      const shelfItems: ShelfMenuItem[] = items.map((it) => ({
        title: it.title ?? "",
        icon: it.icon,
        danger: it.danger,
        disabled: it.disabled,
        heading: it.heading,
        separator: it.sep,
        onClick: it.onPick,
      }));
      this.closeContext = openShelfMenu(x, y, shelfItems);
      return;
    }
    const menu = new Menu();
    for (const it of items) {
      if (it.sep) {
        menu.addSeparator();
        continue;
      }
      menu.addItem((mi) => {
        mi.setTitle(it.title ?? "");
        if (it.icon) mi.setIcon(it.icon);
        if (it.disabled) mi.setDisabled(true);
        mi.onClick(() => it.onPick?.());
      });
    }
    menu.showAtPosition({ x, y });
  }

  /**
   * 墙空白处右键菜单：分组的创建与整体展开/收起都在这里
   * （顶部不再有分组图标；分组头本身也可直接拖拽换序）。
   */
  private openWallMenu(evt: MouseEvent): void {
    const groups = this.data?.groups ?? [];
    const items: CtxItem[] = [
      {
        title: t("wall.group.newItem"),
        icon: "folder-plus",
        onPick: () => this.createGroup(),
      },
    ];
    if (groups.length) {
      items.push(
        { sep: true },
        {
          title: t("wall.group.expandAll"),
          icon: "chevrons-down-up",
          onPick: () => this.setAllGroupsCollapsed(false),
        },
        {
          title: t("wall.group.collapseAll"),
          icon: "chevrons-up-down",
          onPick: () => this.setAllGroupsCollapsed(true),
        }
      );
    }
    items.push(
      { sep: true },
      {
        title: this.editMode
          ? t("wall.ctx.editLayoutExit")
          : t("wall.ctx.editLayoutDrag"),
        icon: "move",
        onPick: () => (this.editMode ? this.exitEditMode() : this.enterEditMode()),
      }
    );
    items.push({ sep: true }, { title: t("wall.settingsPanel.open"), icon: "settings", onPick: () => this.openPluginSettings() });
    this.showCtxMenu(evt, items);
  }

  /** 分组头右键菜单：重命名 / 删除 / 展开收起（含全部） */
  private openGroupMenu(evt: MouseEvent, groupId: string): void {
    const group = this.data?.groups?.find((g) => g.id === groupId);
    if (!group) return;
    this.showCtxMenu(evt, [
      {
        title: t("wall.group.renameItem"),
        icon: "pencil",
        onPick: () => this.renameGroup(groupId),
      },
      {
        title: group.collapsed
          ? t("wall.group.expand")
          : t("wall.group.collapse"),
        icon: group.collapsed ? "chevron-right" : "chevron-down",
        onPick: () => this.toggleGroup(groupId),
      },
      { sep: true },
      {
        title: t("wall.group.expandAll"),
        icon: "chevrons-down-up",
        onPick: () => this.setAllGroupsCollapsed(false),
      },
      {
        title: t("wall.group.collapseAll"),
        icon: "chevrons-up-down",
        onPick: () => this.setAllGroupsCollapsed(true),
      },
      { sep: true },
      {
        title: t("wall.group.deleteItem"),
        icon: "trash",
        danger: true,
        onPick: () => this.confirmDeleteGroup(groupId),
      },
    ]);
  }

  /**
   * 未分组分区标题的右键菜单：只有展开/收起。
   * 「未分组」不是一条 WallGroup 记录，重命名/删除都无从谈起（第五轮反馈 A1）。
   */
  private openUngroupedMenu(evt: MouseEvent): void {
    const collapsed = !!this.data?.ungroupedCollapsed;
    this.showCtxMenu(evt, [
      {
        title: collapsed ? t("wall.group.expand") : t("wall.group.collapse"),
        icon: collapsed ? "chevron-right" : "chevron-down",
        onPick: () => this.toggleGroup(UNGROUPED_ID),
      },
      { sep: true },
      {
        title: t("wall.group.expandAll"),
        icon: "chevrons-down-up",
        onPick: () => this.setAllGroupsCollapsed(false),
      },
      {
        title: t("wall.group.collapseAll"),
        icon: "chevrons-up-down",
        onPick: () => this.setAllGroupsCollapsed(true),
      },
    ]);
  }

  /** 一键展开 / 收起全部分组（未分组分区一起，它同样有分组头） */
  private setAllGroupsCollapsed(collapsed: boolean): void {
    const data = this.data;
    const groups = data?.groups ?? [];
    // 无分组时未分组分区是无头的，没有可收起的东西
    if (!data || !groups.length) return;
    let changed = false;
    for (const g of groups) {
      const next = collapsed ? true : undefined;
      if (g.collapsed !== next) {
        g.collapsed = next;
        changed = true;
      }
    }
    const nextUngrouped = collapsed ? true : undefined;
    if (data.ungroupedCollapsed !== nextUngrouped) {
      if (collapsed) data.ungroupedCollapsed = true;
      else delete data.ungroupedCollapsed;
      changed = true;
    }
    if (!changed) return;
    void this.persist();
    this.rerenderGrid();
    new Notice(
      collapsed ? t("wall.group.collapsedAll") : t("wall.group.expandedAll")
    );
  }

  /** 把唱片移动到指定分组（null = 未分组）；顺序按 moveInto 保持稳定 */
  private moveItemToGroup(item: WallItem, groupId: string | null): void {
    const data = this.data!;
    const from = item.groupId ?? UNGROUPED_ID;
    const to = groupId ?? UNGROUPED_ID;
    if (from === to) return;
    const order = this.ensureOrder();
    const siblings = this.getVisibleItems().filter(
      (i) => (i.groupId ?? UNGROUPED_ID) === to && i.albumId !== item.albumId
    );
    const last = siblings.length ? siblings[siblings.length - 1] : null;
    if (to === UNGROUPED_ID) delete item.groupId;
    else item.groupId = to;
    data.order = last
      ? moveInto(order, [item.albumId], last.albumId, "after")
      : moveInto(order, [item.albumId], null);
    const name =
      to === UNGROUPED_ID
        ? t("wall.group.ungrouped")
        : (data.groups?.find((g) => g.id === to)?.name ??
          t("wall.group.fallbackName"));
    void this.commit(t("wall.group.movedTo", { name }));
  }

  /** 排序面板：类型单选 + 独立的升/降序按钮 */
  private panelSort(body: HTMLElement, api: { refresh(): void }): void {
    const sec = body.createDiv({ cls: "mw-panel__section" });
    sec.createDiv({ cls: "mw-panel__label", text: t("wall.sortPanel.type") });
    const list = sec.createDiv({ cls: "mw-panel__list" });
    const SORT_KEYS: SortMode[] = [
      "manual",
      "addedAt",
      "name",
      "artist",
      "year",
      "rating",
    ];
    for (const k of SORT_KEYS) {
      const row = list.createEl("label", { cls: "mw-check" });
      const radio = row.createEl("input", { type: "radio", cls: "mw-check__box" });
      radio.name = "mw-sort-mode";
      radio.checked = this.sortMode === k;
      radio.addEventListener("change", () => this.setSort(k));
      row.createSpan({ cls: "mw-check__text", text: sortLabel(k) });
      if (k === "manual") {
        row.createSpan({
          cls: "mw-check__count",
          text: t("wall.sortPanel.draggable"),
        });
      }
    }

    // 升降序与排序类型彻底解耦：独立一排按钮
    const dirSec = body.createDiv({ cls: "mw-panel__section" });
    dirSec.createDiv({ cls: "mw-panel__label", text: t("wall.sortPanel.order") });
    const dirs = dirSec.createDiv({ cls: "mw-dirbtns" });
    const mkDir = (asc: boolean, icon: string, text: string) => {
      const btn = dirs.createEl("button", { cls: "mw-btn mw-dirbtn", text });
      btn.setAttr("type", "button");
      btn.toggleClass("is-active", this.sortAsc === asc);
      setIcon(btn, icon);
      btn.addEventListener("click", () => this.setSortAsc(asc));
      return btn;
    };
    mkDir(true, "arrow-up", t("wall.sortPanel.asc"));
    mkDir(false, "arrow-down", t("wall.sortPanel.desc"));

    const secEdit = body.createDiv({ cls: "mw-panel__section" });
    const editBtn = secEdit.createEl("button", {
      cls: "mw-btn mw-panel__add",
      text: this.editMode
        ? t("wall.sortPanel.editExit")
        : t("wall.sortPanel.edit"),
    });
    editBtn.setAttr("type", "button");
    editBtn.addEventListener("click", () => {
      if (this.editMode) this.exitEditMode();
      else this.enterEditMode();
      api.refresh();
    });
  }

  /** 搜索面板：与搜索行等价的内联输入（供面板入口使用） */
  private panelSearch(body: HTMLElement, api: { refresh(): void }): void {
    const sec = body.createDiv({ cls: "mw-panel__section" });
    sec.createDiv({
      cls: "mw-panel__label",
      text: t("wall.drawer.search"),
    });
    const input = sec.createEl("input", {
      type: "search",
      cls: "mw-panel__input",
      placeholder: t("wall.filterPanel.ph"),
    });
    input.value = this.q;
    input.addEventListener("input", () => {
      this.q = input.value;
      this.syncToolbarState();
      this.rerenderGrid();
    });
    const reset = sec.createEl("button", {
      cls: "mw-btn mw-panel__reset",
      text: t("wall.filterPanel.clear"),
    });
    reset.setAttr("type", "button");
    reset.addEventListener("click", () => {
      this.q = "";
      input.value = "";
      this.syncToolbarState();
      this.rerenderGrid();
      api.refresh();
    });
  }

  /** 设置面板：低频入口（全局项统一跳插件设置，避免工具栏继续膨胀） */
  private panelSettings(body: HTMLElement): void {
    const sec = body.createDiv({ cls: "mw-panel__section" });
    const open = sec.createEl("button", {
      cls: "mw-btn",
      text: t("wall.settingsPanel.open"),
    });
    open.setAttr("type", "button");
    open.addEventListener("click", () => {
      // app.setting 未收录进公开类型（社区插件的常规做法），做防御式访问
      const setting = (this.app as unknown as {
        setting?: { open(): void; openTabById(id: string): void };
      }).setting;
      setting?.open();
      setting?.openTabById(this.plugin.manifest.id);
    });
  }

  // ---- 分组操作 ----

  private createGroup(): void {
    new InputModal(
      this.app,
      t("wall.group.newTitle"),
      t("wall.group.newPh"),
      "",
      (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const data = this.data!;
        if (!data.groups) data.groups = [];
        const id = newGroupId(data.groups);
        data.groups.push({ id, name: trimmed });
        void this.commit(t("wall.group.created", { name: trimmed }));
      }
    ).open();
  }

  private renameGroup(id: string): void {
    const group = this.data?.groups?.find((g) => g.id === id);
    if (!group) return;
    new InputModal(
      this.app,
      t("wall.group.renameTitle"),
      t("wall.group.renamePh"),
      group.name,
      (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        group.name = trimmed;
        void this.commit(t("wall.group.renamed", { name: trimmed }));
      }
    ).open();
  }

  /**
   * 展开/收起：局部重建该分区，不整页重绘（避免闪白与滚动跳动）。
   * 未分组分区没有 WallGroup 记录，收起状态存在 data.ungroupedCollapsed 上。
   */
  private toggleGroup(id: string): void {
    const data = this.data!;
    if (id === UNGROUPED_ID) {
      // 本墙没有任何分组时未分组分区是无头的（连标题都不渲染），无从收起
      if (!(data.groups ?? []).length) return;
      if (data.ungroupedCollapsed) delete data.ungroupedCollapsed;
      else data.ungroupedCollapsed = true;
      void this.persist();
      this.rerenderGrid();
      return;
    }
    const group = data.groups?.find((g) => g.id === id);
    if (!group) return;
    group.collapsed = !group.collapsed;
    void this.persist();
    this.rerenderGrid();
  }

  private confirmDeleteGroup(id: string): void {
    const data = this.data!;
    const group = data.groups?.find((g) => g.id === id);
    if (!group) return;
    const members = data.items.filter((i) => i.groupId === id);
    const doDelete = () => {
      data.groups = (data.groups ?? []).filter((g) => g.id !== id);
      if (!data.groups.length) delete data.groups;
      const ids = members.map((m) => m.albumId);
      data.items = data.items.filter((i) => i.groupId !== id);
      if (data.order) data.order = removeFromOrder(data.order, ids);
      void this.commit(
        members.length
          ? t("wall.group.deletedWithItems", {
              name: group.name,
              count: members.length,
            })
          : t("wall.group.deleted", { name: group.name })
      );
    };

    if (!members.length) {
      // 空分组：普通二次确认即可
      new ConfirmModal(this.app, {
        title: t("wall.group.deleteEmptyTitle"),
        message: t("wall.group.deleteEmptyMsg", { name: group.name }),
        details: [t("wall.group.deleteEmptyDetail")],
        danger: true,
        confirmText: t("wall.group.deleteEmptyConfirm"),
        onConfirm: doDelete,
      }).open();
      return;
    }
    // 非空分组：必须输入分组名确认（连同组内唱片一起删除）
    const list = members.slice(0, 8).map((m) => m.meta.name);
    if (members.length > 8)
      list.push(t("wall.group.andMore", { count: members.length }));
    new ConfirmModal(this.app, {
      title: t("wall.group.deleteTitle"),
      message: t("wall.group.deleteMsg", {
        name: group.name,
        count: members.length,
      }),
      details: list,
      danger: true,
      confirmText: t("wall.group.deleteConfirm"),
      requireText: group.name,
      onConfirm: doDelete,
    }).open();
  }

  // ---- 网格与分区 ----

  private rerenderGrid(): void {
    const grid = this.contentEl.querySelector(".mw-grid") as HTMLElement;
    if (grid) this.renderGrid(grid);
  }

  private renderGrid(grid: HTMLElement): void {
    this.clearLongPress(); this.closeContext?.(); this.closeContext = null;
    // 搜索/筛选等局部重绘也保持滚动位置
    const prevScroll = grid.scrollTop;
    grid.empty();
    const items = this.getVisibleItems();
    const data = this.data!;

    if (!items.length) {
      const wrap = grid.createDiv({ cls: "mw-section mw-section--plain" });
      const host = wrap.createDiv({ cls: "mw-section__cards" });
      const empty = host.createDiv({ cls: "mw-empty" });
      empty.createDiv({
        text: data.items.length
          ? t("wall.empty.filtered")
          : t("wall.empty.blank"),
        cls: "mw-empty__title",
      });
      if (!data.items.length) {
        const actions = empty.createDiv({ cls: "mw-empty__actions" });
        const add = actions.createEl("button", {
            cls: "mw-btn mw-btn--primary",
          });
        add.addClass("mw-button-icon");
        setIcon(add.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } }), "plus");
        add.createSpan({ text: t("wall.empty.add") });
        add.addEventListener("click", () => this.openSearchModal());
      } else {
        empty
          .createEl("button", {
            cls: "mw-btn",
            text: t("wall.empty.clearFilters"),
          })
          .addEventListener("click", () => {
            this.q = "";
            const view = this.ensureView();
            delete view.filterArtists;
            delete view.filterDecades;
            delete view.filterTags;
            delete view.filterRatings;
            void this.persist();
            this.render();
          });
      }
      return;
    }

    const order = items.map((i) => i.albumId);
    const sections = resolveSections(
      items,
      data.groups ?? [],
      order,
      this.filtering,
      !!data.ungroupedCollapsed
    );
    for (const section of sections) this.buildSection(grid, section, data.groups ?? []);
    grid.scrollTop = prevScroll;
  }

  /** 一个分区：分组头（无分组时省略）+ 卡片列容器 */
  private buildSection(
    grid: HTMLElement,
    section: WallSection,
    groups: NonNullable<MusicWallData["groups"]>
  ): void {
    const headless = isHeadlessSection(section, groups);
    const el = grid.createDiv({ cls: "mw-section" });
    el.dataset.mwGroup = section.id;
    el.toggleClass("is-collapsed", section.collapsed);

    if (!headless) {
      const head = el.createDiv({ cls: "mw-section__head" });
      const chev = head.createEl("button", { cls: "clickable-icon mw-section__chevron" });
      chev.setAttr("type", "button");
      chev.setAttr(
        "aria-label",
        section.collapsed
          ? t("wall.group.expandAria", { name: section.name })
          : t("wall.group.collapseAria", { name: section.name })
      );
      chev.setAttr(
        "title",
        section.collapsed
          ? t("wall.group.expandTip")
          : t("wall.group.collapseTip")
      );
      setIcon(chev, section.collapsed ? "chevron-right" : "chevron-down");
      chev.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleGroup(section.id);
      });

      const title = head.createSpan({ cls: "mw-section__title", text: section.name });
      if (section.id !== UNGROUPED_ID) {
        title.setAttr("title", t("wall.group.dblRenameTip"));
        title.addEventListener("dblclick", () => this.renameGroup(section.id));
      }
      head.createSpan({
        cls: "mw-section__count",
        text: t("common.albumCount", { count: section.items.length }),
      });

      const actions = head.createDiv({ cls: "mw-section__actions" });
      const mkAct = (icon: string, label: string, fn: () => void, danger = false) => {
        const b = actions.createEl("button", {
          cls: danger
            ? "clickable-icon mw-section__btn mw-section__btn--danger"
            : "clickable-icon mw-section__btn",
        });
        b.setAttr("type", "button");
        b.setAttr("aria-label", label);
        b.setAttr("title", label);
        setIcon(b, icon);
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          fn();
        });
        return b;
      };
      if (section.id !== UNGROUPED_ID) {
        mkAct("pencil", t("wall.group.renameBtn"), () =>
          this.renameGroup(section.id)
        );
        mkAct("trash", t("wall.group.deleteBtn"), () =>
          this.confirmDeleteGroup(section.id)
        , true);
        // 分组头：任何时候都能直接拖拽换序（不需要编辑模式）；
        // 未分组分区固定排在末尾，不参与换序
        this.wireGroupDrag(head, section.id);
        head.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (this.editMode && this.contextPointer !== "mouse") return;
          this.openGroupMenu(e as MouseEvent, section.id);
        });
      } else {
        // 未分组分区同样能收起/展开（第五轮反馈 A1 的修复点）：
        // 它不是一条 WallGroup 记录，状态存在 data.ungroupedCollapsed 上，
        // 菜单因此只有展开/收起——重命名、删除对它没有意义。
        head.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (this.editMode && this.contextPointer !== "mouse") return;
          this.openUngroupedMenu(e as MouseEvent);
        });
      }
    }

    // 收起的分区不渲染卡片：大墙里几十上百张唱片的 DOM 与封面请求都能省掉
    if (section.collapsed) return;

    const cards = el.createDiv({ cls: "mw-section__cards" });
    for (const item of section.items) {
      cards.appendChild(
        (this.data!.layout ?? "grid") === "list"
          ? this.buildListRow(item)
          : (this.data!.layout ?? "grid") === "shelf"
            ? this.buildShelfCard(item)
            : this.buildCard(item)
      );
    }
  }

  private buildCard(item: WallItem): HTMLElement {
    const style = this.data!.style;
    const card = document.createElement("div");
    card.className = "mw-card";
    card.dataset.mwAlbum = String(item.albumId);
    if (item.groupId) card.dataset.mwGroup = item.groupId;
    if (this.selectMode && this.isSelected(item.albumId)) card.addClass("is-selected");
    // 唱片区包裹层：多选复选框锚在唱片左下角（.mw-card__art 底部），
    // 而不是卡片底部——卡片还含下面的文字区，直接按卡片 bottom 定位会掉进文字里。
    const art = document.createElement("div");
    art.className = "mw-card__art";
    art.appendChild(buildDiscElement(item, style, { coverSize: 300 }));
    art.appendChild(this.makeSelectBox(item));
    card.appendChild(art);
    const badgeRating = normalizeRating(item.rating);
    if (badgeRating) {
      card.addClass("has-rating");
      card.appendChild(buildRatingBadge(badgeRating));
    }
    card.appendChild(this.makeMenuButton(item));
    card.appendChild(this.makeDelButton(item));
    this.wireCardReorder(card, item);

    const cap = document.createElement("div");
    cap.className = "mw-card__caption";
    const nameEl = document.createElement("div");
    nameEl.className = "mw-card__name";
    nameEl.textContent = item.meta.name;
    nameEl.title = item.meta.name;
    cap.appendChild(nameEl);
    const artistEl = document.createElement("div");
    artistEl.className = "mw-card__sub";
    artistEl.textContent = item.meta.artist || t("common.unknownArtist");
    cap.appendChild(artistEl);
    if (item.meta.year) {
      const yearEl = document.createElement("div");
      yearEl.className = "mw-card__sub mw-card__year";
      yearEl.textContent = t("wall.card.released", { year: item.meta.year });
      cap.appendChild(yearEl);
    }
    card.appendChild(cap);

    card.addEventListener("click", (e) => {
      if (this.consumeLongPressClick(e, card)) return;
      if (this.editMode) return; // 编辑布局时不弹详情
      if (this.selectMode) {
        this.toggleSelect(item.albumId);
        return;
      }
      this.openPlayModal(item);
    });
    card.addEventListener("contextmenu", (e) => {
      this.cardContext(e, card, item);
    });
    return card;
  }

  /** 触屏（无 hover）环境：抽出需两段式点击 */
  private get touchMode(): boolean {
    return (
      typeof window.matchMedia === "function" &&
      window.matchMedia("(hover: none)").matches
    );
  }

  /** 收起展示架中所有已抽出的卡片 */
  private retractAllShelf(): void {
    this.contentEl
      .querySelectorAll(".mw-shelf-card.is-pulled")
      .forEach((el) => el.removeClass("is-pulled"));
  }

  private longPressClick: HTMLElement | null = null;
  private longPressUntil = 0;
  private releasePress: (() => void) | null = null;
  private closeContext: (() => void) | null = null;
  private contextPointer = "mouse";
  private suppressCardClick(el: HTMLElement, pointerId?: number): void {
    this.releasePress?.(); this.releasePress = null;
    this.longPressClick = el; this.longPressUntil = pointerId === undefined ? Date.now() + 700 : Infinity;
    if (pointerId === undefined) return;
    const end = (event: PointerEvent) => { if (event.pointerId === pointerId) finish(); };
    const finish = () => {
      this.longPressUntil = Date.now() + 700;
      window.removeEventListener("pointerup", end, true); window.removeEventListener("pointercancel", end, true); window.removeEventListener("blur", finish);
      if (this.releasePress === finish) this.releasePress = null;
    };
    this.releasePress = finish;
    window.addEventListener("pointerup", end, true); window.addEventListener("pointercancel", end, true); window.addEventListener("blur", finish);
  }
  private consumeLongPressClick(event: MouseEvent, el: HTMLElement): boolean {
    if (event.detail === 0 || this.longPressClick !== el || Date.now() > this.longPressUntil) return false;
    this.longPressClick = null; event.preventDefault(); event.stopPropagation(); return true;
  }
  private cardContext(event: MouseEvent, el: HTMLElement, item: WallItem): void {
    event.preventDefault(); event.stopPropagation();
    if (this.selectMode || (this.editMode && this.contextPointer !== "mouse") || (this.longPressClick === el && Date.now() <= this.longPressUntil)) return;
    this.suppressCardClick(el); this.openCardMenu(event, item);
  }

  /** 展示架卡片：木板上平放封套，hover/首触抽出（聚光灯照亮），点击进场景详情，右键/长按菜单 */
  private buildShelfCard(item: WallItem): HTMLElement {
    const card = document.createElement("div");
    card.className = "mw-card mw-shelf-card";
    card.dataset.mwAlbum = String(item.albumId);
    if (item.groupId) card.dataset.mwGroup = item.groupId;
    if (this.selectMode && this.isSelected(item.albumId)) card.addClass("is-selected");

    const slot = document.createElement("div");
    slot.className = "mw-shelf-slot";
    const jacket = document.createElement("div");
    jacket.className = "mw-shelf-jacket";
    jacket.appendChild(makeCoverImg(sizedCover(item.meta.cover, 300), item.meta.name));
    // 徽标必须挂在**封套内部**：封套 z-index 高于卡槽，挂在槽位右上会被封套压住
    // （用户反馈「星星被挡在唱片后面」）；挂在封套里还能跟随 hover 抽出与缩放一起动。
    const shelfRating = normalizeRating(item.rating);
    if (shelfRating) {
      card.addClass("has-rating");
      jacket.appendChild(buildRatingBadge(shelfRating));
    }
    slot.appendChild(jacket);
    card.appendChild(slot);
    card.appendChild(this.makeSelectBox(item));

    const cap = document.createElement("div");
    cap.className = "mw-shelf-cap";
    const name = document.createElement("div");
    name.className = "mw-shelf-cap__name";
    name.textContent = item.meta.name;
    name.title = item.meta.name;
    const artist = document.createElement("div");
    artist.className = "mw-shelf-cap__artist";
    artist.textContent = item.meta.artist || t("common.unknownArtist");
    cap.append(name, artist);
    card.appendChild(cap);

    card.addEventListener("click", (e) => {
      if (this.consumeLongPressClick(e, card)) return;
      if (this.editMode) return; // 编辑布局时不进详情
      if (this.selectMode) {
        this.toggleSelect(item.albumId);
        return;
      }
      if (this.touchMode && !card.hasClass("is-pulled")) {
        this.retractAllShelf();
        card.addClass("is-pulled");
        return;
      }
      this.openShelfDetail(item);
    });
    card.addEventListener("contextmenu", (e) => {
      this.cardContext(e, card, item);
    });
    this.wireCardReorder(card, item);
    return card;
  }

  /** 列表模式行：封面 + 三行文字（专辑名/艺术家/年份）+ 操作钮 */
  private buildListRow(item: WallItem): HTMLElement {
    const row = document.createElement("div");
    row.className = "mw-row";
    row.dataset.mwAlbum = String(item.albumId);
    if (item.groupId) row.dataset.mwGroup = item.groupId;
    if (this.selectMode && this.isSelected(item.albumId)) row.addClass("is-selected");
    row.appendChild(this.makeSelectBox(item));

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "mw-row__thumbwrap";
    // 与网格/封套同一条错误链：封面拉不到 → 内置默认封面 → 父容器 mw-cover-broken 渐变
    // （以前是 visibility:hidden 留一块主题边框色的平面——审计 B8）
    const thumb = makeCoverImg(sizedCover(item.meta.cover, 200), item.meta.name);
    thumb.addClass("mw-row__thumb");
    thumbWrap.appendChild(thumb);
    const rowRating = normalizeRating(item.rating);
    if (rowRating) thumbWrap.appendChild(buildRatingBadge(rowRating));

    const info = document.createElement("div");
    info.className = "mw-row__info";
    const name = document.createElement("div");
    name.className = "mw-card__name";
    name.textContent = item.meta.name;
    name.title = item.meta.name;
    const artist = document.createElement("div");
    artist.className = "mw-card__sub";
    artist.textContent = item.meta.artist || t("common.unknownArtist");
    const year = document.createElement("div");
    year.className = "mw-card__sub mw-card__year";
    year.textContent = item.meta.year
      ? t("wall.card.released", { year: item.meta.year })
      : "";
    info.append(name, artist, year);

    const actions = document.createElement("div");
    actions.className = "mw-row__actions";
    actions.append(this.makeMenuButton(item), this.makeDelButton(item));

    row.append(thumbWrap, info, actions);
    this.wireCardReorder(row, item);
    row.addEventListener("click", (e) => {
      if (this.consumeLongPressClick(e, row)) return;
      if (this.editMode) return;
      if (this.selectMode) {
        this.toggleSelect(item.albumId);
        return;
      }
      this.openPlayModal(item);
    });
    row.addEventListener("contextmenu", (e) => {
      this.cardContext(e, row, item);
    });
    return row;
  }

  /** 多选复选框（自绘组件，内部无原生 input，见 selectBox.ts） */
  private makeSelectBox(item: WallItem): HTMLElement {
    const box = createSelectBox({
      checked: this.isSelected(item.albumId),
      title: t("wall.card.selectTip"),
      onToggle: () => {
        if (this.selected.has(item.albumId)) this.selected.delete(item.albumId);
        else this.selected.add(item.albumId);
        this.paintSelection();
        return this.selected.has(item.albumId);
      },
    });
    // label 时代的 stopPropagation 由组件内部处理；这里保留卡片点击不穿透即可
    return box;
  }

  /** ✕ 快捷删除钮（网格悬停浮层 / 列表行内共用） */
  private makeDelButton(item: WallItem): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "mw-iconbtn mw-iconbtn--del";
    btn.textContent = "✕";
    btn.title = t("wall.card.delBtn");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.confirmDelete(item);
    });
    return btn;
  }

  /** ⋯ 保底菜单钮：不依赖 contextmenu 事件路径，触屏同样可用 */
  private makeMenuButton(item: WallItem): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "mw-iconbtn mw-iconbtn--menu";
    btn.textContent = "⋯";
    btn.title = t("wall.card.menuBtn");
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = btn.getBoundingClientRect();
      this.openCardMenu({ x: rect.left, y: rect.bottom + 4 } as MouseEvent, item);
    });
    return btn;
  }

  /**
   * 原生拖拽接线（桌面）。
   *
   * 关键约定：**左键按下就武装 draggable，两种模式都武装**——浏览器要求拖拽源在
   * dragstart 之前就是可拖的。是否「在本墙内换位」由 .mw-grid 的 dragover/drop
   * 按编辑态决定（非编辑态拒绝，只允许跨墙迁移）；这样可以只用一套手势同时支持
   * 「任何时候跨墙迁移」与「编辑态内墙内排序」。
   *
   * 右键必须先把 draggable 关掉：Windows Chromium 会把右键当右键拖拽，
   * 吞掉 contextmenu。
   */
  private wireNativeDrag(el: HTMLElement, make: () => DragPayload | null): void {
    el.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      this.contextPointer = pe.pointerType;
      if (pe.pointerType !== "mouse" || pe.button !== 0 || (pe.target as Element)?.closest("button, input, a, [role=checkbox]")) {
        el.draggable = false;
        return;
      }
      el.draggable = true;
    });
    el.addEventListener("dragstart", (e) => {
      const de = e as DragEvent;
      const payload = make();
      if (!de.dataTransfer || !this.file || !payload) {
        e.preventDefault();
        return;
      }
      // 已经走原生拖拽，取消尚未触发的长按菜单
      this.clearLongPress();
      this.dragNative = true;
      this.dragPayload = payload;
      de.dataTransfer.effectAllowed = "copyMove";
      const data: WallDragData =
        payload.kind === "item"
          ? { kind: "item", srcPath: this.file.path, albumId: payload.item.albumId }
          : payload.kind === "multi-item"
            ? {
                kind: "multi-item",
                srcPath: this.file.path,
                albumId: payload.items[0]?.albumId,
                albumIds: payload.items.map((x) => x.albumId),
              }
            : { kind: "group", srcPath: this.file.path, groupId: payload.groupId };
      de.dataTransfer.setData(WALL_DRAG_MIME, JSON.stringify(data));
      el.addClass("is-dragging");
    });
    el.addEventListener("dragend", () => {
      el.draggable = false;
      el.removeClass("is-dragging");
      this.dragNative = false;
      this.dragPayload = null;
      this.stopAutoScroll();
      this.hideDropHint();
    });
  }

  /**
   * 网格落点接线：本墙自己的拖拽是否被接收，完全由编辑态决定。
   * - 非编辑态：不 preventDefault（浏览器显示禁止光标）+ dropEffect=none，并提示一次
   *   「调整顺序请先从菜单进入布局编辑」；跨墙迁移不受影响（由 contentEl 处理外来拖拽）。
   * - 编辑态：接收 → 复用 resolveDrop/updateDropHint 画落点线，松手时 commitDrop。
   */
  private wireGridDragTarget(grid: HTMLElement): void {
    // 空白处右键 = 墙级菜单（新建分组 / 展开收起全部 / 编辑布局）
    grid.addEventListener("contextmenu", (e) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".mw-card, .mw-row, .mw-section__head")) return;
      e.preventDefault();
      this.openWallMenu(e as MouseEvent);
    });
    /** 本墙是否接收这次拖拽的落点：编辑态接收唱片；分组头任何时候都能换序 */
    const acceptsHere = (): boolean =>
      this.editMode ||
      this.dragPayload?.kind === "group" ||
      (this.selectMode && this.dragPayload?.kind === "multi-item");
    grid.addEventListener("dragover", (e) => {
      const de = e as DragEvent;
      const dt = de.dataTransfer;
      if (!dt || !this.dragNative || !this.dragPayload) return; // 外来拖拽交给 contentEl
      if (!acceptsHere()) {
        dt.dropEffect = "none";
        this.hintReorderOnce();
        return;
      }
      const target = this.resolveDrop(de.clientX, de.clientY);
      if (!target) {
        dt.dropEffect = "none";
        this.hideDropHint();
        return;
      }
      de.preventDefault();
      dt.dropEffect = "move";
      this.dragCursor = { x: de.clientX, y: de.clientY };
      this.updateDropHint();
      this.autoScrollDuringDrag(de.clientY, grid);
    });
    grid.addEventListener("dragleave", (e) => {
      const to = (e as DragEvent).relatedTarget as Node | null;
      if (!to || !grid.contains(to)) this.hideDropHint();
    });
    grid.addEventListener("drop", (e) => {
      const de = e as DragEvent;
      if (!this.dragNative) return; // 外来拖拽由 contentEl 落库
      const payload = this.dragPayload;
      const inside = !!payload && acceptsHere();
      const target = inside ? this.resolveDrop(de.clientX, de.clientY) : null;
      this.dragPayload = null;
      this.dragNative = false;
      this.stopAutoScroll();
      this.hideDropHint();
      if (!payload || !target) return;
      de.preventDefault();
      de.stopPropagation(); // 不要落到 contentEl 的迁移分支
      this.commitDrop(payload, target);
    });
  }

  /**
   * 网格边缘自动滚动：拖到上下边缘时把内容滚起来，否则长墙拖不到远处的分组。
   *
   * 用 rAF 连续滚动而不是「每个 dragover 事件走一步」：真实环境里 dragover 约
   * 350ms 才来一次，逐步 14px 相当于每秒只滚 40px，跨到较远的分组几乎拖不过去。
   * 这里把最新光标位置记下来，由 rAF 按「离边缘多远」给速度，松手/结束即停。
   */
  private autoScrollDuringDrag(clientY: number, grid: HTMLElement): void {
    this.autoScrollGrid = grid;
    this.autoScrollY = clientY;
    if (this.autoScrollRaf) return;
    const step = () => {
      this.autoScrollRaf = 0;
      const g = this.autoScrollGrid;
      // 拖拽已结束（原生拖拽用 dragNative 判定，指针拖拽用 dragActive）
      if ((!this.dragActive && !this.dragNative) || !g || !g.isConnected) return;
      const r = g.getBoundingClientRect();
      let dy = 0;
      if (r.height > 0) {
        const edge = DRAG_AUTOSCROLL_EDGE;
        if (this.autoScrollY < r.top + edge) {
          const ratio = Math.min(1, (r.top + edge - this.autoScrollY) / edge);
          dy = -Math.ceil(ratio * DRAG_AUTOSCROLL_STEP);
        } else if (this.autoScrollY > r.bottom - edge) {
          const ratio = Math.min(1, (this.autoScrollY - (r.bottom - edge)) / edge);
          dy = Math.ceil(ratio * DRAG_AUTOSCROLL_STEP);
        }
      }
      if (dy) g.scrollTop += dy;
      this.autoScrollRaf = window.requestAnimationFrame(step);
    };
    this.autoScrollRaf = window.requestAnimationFrame(step);
  }

  private stopAutoScroll(): void {
    if (this.autoScrollRaf) window.cancelAnimationFrame(this.autoScrollRaf);
    this.autoScrollRaf = 0;
    this.autoScrollGrid = null;
  }

  /** 非编辑态墙内拖拽被拒：每个视图只提示一次，别刷屏 */
  private hintReorderOnce(): void {
    if (this.reorderHintShown) return;
    this.reorderHintShown = true;
    new Notice(t("wall.reorderHint"));
  }

  // ---- 布局编辑（手动排序 / 分组换序） ----

  /**
   * 唱片拖拽接线。
   * - 桌面鼠标：原生拖拽，墙内换位由显式编辑态决定。
   * - 触屏：没有 HTML5 原生拖拽，长按 350ms 后走指针拖拽（编辑态内排序）。
   */
  private wireCardReorder(el: HTMLElement, item: WallItem): void {
    const make = (): DragPayload => {
      // 多选态下拖其中一张即带上整组（若本卡未选中则只拖本卡）
      if (this.selectMode && this.selected.size > 1 && this.selected.has(item.albumId)) {
        const items = this.selectedItems();
        if (items.length > 1) return { kind: "multi-item", items };
      }
      return { kind: "item", item };
    };
    this.wireNativeDrag(el, make);
    el.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      this.releasePress?.(); this.releasePress = null; this.longPressClick = null;
      if (this.selectMode || pe.button !== 0 || !["touch", "pen"].includes(pe.pointerType)
        || (pe.target as Element)?.closest("button, input, a, [role=checkbox]")) return;
      this.armLongPress(pe, make(), el, false, this.editMode, this.editMode ? undefined : () => {
        if (this.selectMode || this.editMode) return;
        this.suppressCardClick(el, pe.pointerId); this.openCardMenu({ x: pe.clientX, y: pe.clientY } as MouseEvent, item);
      });
    });
  }

  /**
   * 分组头拖拽接线：桌面可原生拖拽，触屏仅在编辑态拖拽。
   * 桌面原生拖拽；触屏长按后指针拖拽。
   */
  private wireGroupDrag(head: HTMLElement, groupId: string): void {
    const make = (): DragPayload => ({ kind: "group", groupId });
    this.wireNativeDrag(head, make);
    head.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      if (this.editMode && ["touch", "pen"].includes(pe.pointerType) && pe.button === 0
        && !(pe.target as Element)?.closest("button, input, a")) this.armLongPress(pe, make(), head, true, true);
    });
  }

  /**
   * 触屏或笔长按 350ms；移动、取消、失焦或抬起均取消。
   * @param pointerDrag 长按成立后是否直接开始指针拖拽（触屏用；
   *                    桌面靠随后的移动触发原生拖拽，不在这里接管）
   */
  private armLongPress(
    pe: PointerEvent,
    payload: DragPayload,
    el: HTMLElement,
    isHead = false,
    pointerDrag = false,
    onHold?: () => void
  ): void {
    this.clearLongPress();
    this.dragStart = { x: pe.clientX, y: pe.clientY };
    this.dragPointerId = pe.pointerId;
    const slop = pe.pointerType === "touch" ? LONG_PRESS_SLOP_TOUCH : LONG_PRESS_SLOP;
    const target = { payload, el, isHead };
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== pe.pointerId) return;
      const dx = Math.abs(ev.clientX - this.dragStart.x);
      const dy = Math.abs(ev.clientY - this.dragStart.y);
      if (dx > slop || dy > slop) {
        cancel(); // 视为滚动 / 已经在拖别的（原生拖拽）
      }
    };
    const up = (ev: PointerEvent) => { if (ev.pointerId === pe.pointerId) cancel(); };
    // 注意：这里只做「拆监听 + 清计时器」，不能回调 clearLongPress（会自引用递归）
    const cancel = () => {
      if (this.dragTimer) window.clearTimeout(this.dragTimer);
      this.dragTimer = 0;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("blur", cancel);
      if (this.armCancel === cancel) this.armCancel = null;
    };
    // 记住取消函数：视图重建/卸载时也要拆掉这两个 window 监听，否则会残留
    this.armCancel = cancel;
    window.addEventListener("pointermove", move, true);
    const delay = LONG_PRESS_MS_TOUCH;
    this.dragTimer = window.setTimeout(() => {
      this.dragTimer = 0;
      cancel();
      if (!el.isConnected) return;
      if (onHold) { onHold(); return; }
      if (pointerDrag && this.editMode && !this.selectMode) {
        // 触屏：沿用同一个指针，直接开始拖拽
        this.beginPointerDrag(
          {
            pointerId: this.dragPointerId,
            clientX: this.dragStart.x,
            clientY: this.dragStart.y,
          } as PointerEvent,
          target.payload,
          target.el,
          target.isHead
        );
      }
    }, delay);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    window.addEventListener("blur", cancel);
  }

  /** 长按计时中，移除 window 监听用；disposeDrag 也会调用（记得在这里置空） */
  private armCancel: (() => void) | null = null;

  private clearLongPress(): void {
    if (this.dragTimer) window.clearTimeout(this.dragTimer);
    this.dragTimer = 0;
    const cancel = this.armCancel;
    this.armCancel = null;
    cancel?.();
  }

  private get dropLine(): HTMLElement {
    if (!this.dragLine) {
      // 落点线挂在 .mw-stage 上（它是 position: relative 的定位上下文），
      // 这样 updateDropHint 里「以 stage 的 rect 为原点」的换算才成立。
      const host =
        this.contentEl.querySelector<HTMLElement>(".mw-stage") ?? this.contentEl;
      this.dragLine = host.createDiv({ cls: "mw-drop-line" });
    }
    return this.dragLine;
  }

  private beginPointerDrag(
    pe: PointerEvent,
    payload: DragPayload,
    el: HTMLElement,
    isHead = false
  ): void {
    if (this.dragActive) return;
    this.dragActive = true;
    this.dragPayload = payload;
    this.dragCursor = { x: pe.clientX, y: pe.clientY };
    this.suppressCardClick(el, pe.pointerId);
    el.addClass("is-dragging");
    el.setAttribute("draggable", "false");
    // 刻意不做 setPointerCapture：指针被捕获后 Chromium 会把 pointerup/pointermove
    // 重定向到捕获元素，document 上的监听可能整段收不到（实测 window 能收到、
    // document 收不到）。拖拽的自有监听统一挂 window，命中判定走 elementFromPoint，
    // 不依赖捕获也不会丢事件。
    const ghost = (this.zoomBox ?? this.contentEl).createDiv({ cls: "mw-drag-ghost" });
    const label =
      payload.kind === "group"
        ? (this.data?.groups?.find((g) => g.id === payload.groupId)?.name ??
          t("wall.group.fallbackName"))
        : payload.kind === "multi-item"
          ? t("wall.select.dragLabel", { count: payload.items.length })
          : payload.item.meta.name;
    if (payload.kind === "group") ghost.addClass("mw-drag-ghost--group");
    ghost.dataset.dragKind = payload.kind;
    ghost.textContent = label;
    if (payload.kind === "item") {
      const img = document.createElement("img");
      img.src = sizedCover(payload.item.meta.cover, 120);
      img.alt = "";
      ghost.prepend(img);
    }
    this.dragGhost = ghost;
    this.positionGhost(pe.clientX, pe.clientY);
    el.addClass(isHead ? "is-drag-head" : "is-drag-card");
    window.addEventListener("pointermove", this.onDragMove, true);
    window.addEventListener("pointerup", this.onDragUp, true);
    window.addEventListener("pointercancel", this.onDragUp, true);
    window.addEventListener("blur", this.onDragCancel);
  }

  /** 当前缩放系数：rect 差值（视觉像素）与样式长度（局部像素）之间需要它换算 */
  private get zoom(): number {
    return clampZoom(this.plugin.settings.zoomScale ?? 1);
  }

  /** 缩放变化时重算缩放盒像素尺寸（plugin.applyZoom 会调，见 zoom.ts syncZoomBox） */
  syncZoomBox(): void {
    syncZoomBox(this.contentEl, this.zoom);
  }

  private positionGhost(x: number, y: number): void {
    if (!this.dragGhost) return;
    // 浮标是缩放盒里的 absolute 元素：原点 = 缩放盒的左上角（rect 是视觉像素），
    // 因此先减原点、再除以缩放系数换成局部像素。
    const z = this.zoom;
    const host = (this.zoomBox ?? this.contentEl).getBoundingClientRect();
    this.dragGhost.style.transform = `translate(${(x - host.left + 12) / z}px, ${
      (y - host.top + 12) / z
    }px)`;
  }

  private handleDragMove(e: PointerEvent): void {
    if (!this.dragActive || e.pointerId !== this.dragPointerId) return;
    e.preventDefault();
    this.dragCursor = { x: e.clientX, y: e.clientY };
    this.positionGhost(e.clientX, e.clientY);
    const grid = this.contentEl.querySelector<HTMLElement>(".mw-grid");
    if (grid) this.autoScrollDuringDrag(e.clientY, grid);
    if (this.dragMoveTimer) return;
    this.dragMoveTimer = window.setTimeout(() => {
      this.dragMoveTimer = 0;
      this.updateDropHint();
    }, 32);
  }

  private handleDragUp(e: PointerEvent): void {
    if (!this.dragActive || e.pointerId !== this.dragPointerId) return;
    if (e.type === "pointercancel") { this.disposeDrag(); return; }
    const payload = this.dragPayload;
    const cursor = this.dragCursor ?? { x: e.clientX, y: e.clientY };
    const target = this.resolveDrop(cursor.x, cursor.y);
    // 无论是否命中落点都必须先收拾拖拽现场：原地松手（落点为空）时若提早 return，
    // dragActive 会一直挂着，之后所有拖动都会被 beginDrag 的守卫挡掉。
    this.disposeDrag();
    if (payload && target) this.commitDrop(payload, target);
  }

  private onDragCancel = (): void => this.disposeDrag();
  private disposeDrag(): void {
    this.clearLongPress();
    this.stopAutoScroll();
    if (this.dragMoveTimer) window.clearTimeout(this.dragMoveTimer);
    this.dragMoveTimer = 0;
    window.removeEventListener("pointermove", this.onDragMove, true);
    window.removeEventListener("pointerup", this.onDragUp, true);
    window.removeEventListener("pointercancel", this.onDragUp, true);
    window.removeEventListener("blur", this.onDragCancel);
    this.dragGhost?.remove();
    this.dragGhost = null;
    this.dragLine?.remove();
    this.dragLine = null;
    this.dragPayload = null;
    this.dragActive = false;
    this.dragCursor = null;
    // 空格分隔的多类名不能只调一次 removeClass（Obsidian 真实实现会拆词，但
    // 语义上仍应逐个类移除），这里显式分三次
    for (const el of Array.from(
      this.contentEl.querySelectorAll<HTMLElement>(".is-dragging, .is-drag-card, .is-drag-head")
    )) {
      el.removeClass("is-dragging");
      el.removeClass("is-drag-card");
      el.removeClass("is-drag-head");
    }
  }

  /**
   * 命中测试：指针下的分组头或唱片卡片，折算成「插到谁前面/后面」。
   * elementFromPoint 在落点超出视口（例如贴着窗口底边松手）时返回 null，
   * 此时退化为按坐标就近匹配可见卡片——否则贴在边缘松手会静默丢掉这次拖动。
   */
  private resolveDrop(x: number, y: number): DropTarget | null {
    const payload = this.dragPayload;
    if (!payload) return null;
    const hit =
      (document.elementFromPoint(x, y) as HTMLElement | null) ??
      this.nearestElementAt(x, y);
    if (!hit || !this.contentEl.contains(hit)) return null;

    if (payload.kind === "item" || payload.kind === "multi-item") {
      const movingIds =
        payload.kind === "item" ? new Set([payload.item.albumId]) : new Set(payload.items.map((x) => x.albumId));
      const section = hit.closest<HTMLElement>(".mw-section");
      if (!section) return null;
      const groupId = section.dataset.mwGroup ?? UNGROUPED_ID;
      const card = hit.closest<HTMLElement>("[data-mw-album]");
      if (card) {
        const albumId = Number(card.dataset.mwAlbum);
        const item = this.data?.items.find((i) => i.albumId === albumId);
        if (!item || movingIds.has(item.albumId)) return null;
        const r = card.getBoundingClientRect();
        const place: Place = this.isListLayout()
          ? y < r.top + r.height / 2
            ? "before"
            : "after"
          : x < r.left + r.width / 2
            ? "before"
            : "after";
        return { kind: "item", target: item, place, groupId };
      }
      // 落在分区空白处 / 分组头 / 收起的分区：追加到该分区末尾。
      // 锚点必须**按数据**取该分区顺序里的最后一张：收起的分组与空分组都没有卡片 DOM，
      // 用「最后一张可见卡片」会退化成「锚点 = 自己」，跨组拖拽静默失败。
      const last = this.lastNonMovingItemOfGroup(groupId, movingIds);
      if (!last) {
        // 目标分区为空或只剩被拖项：按追加到该分组末尾处理
        // 若拖的全部都在本组且组内无其他项，则是原地不动
        const want = groupId === UNGROUPED_ID ? "" : groupId;
        const others = (this.data?.items ?? []).some(
          (i) => (i.groupId ?? "") === want && !movingIds.has(i.albumId)
        );
        if (!others) {
          const allInGroup = payload.kind === "item"
            ? (payload.item.groupId ?? UNGROUPED_ID) === groupId
            : payload.items.every((x) => (x.groupId ?? UNGROUPED_ID) === groupId);
          if (allInGroup) return null;
        }
        return { kind: "item", target: null, place: "after", groupId };
      }
      return { kind: "item", target: last, place: "after", groupId };
    }

    // 分组：目标必须是某个分组头（未分组分区不可作为拖拽锚点）
    const head = hit.closest<HTMLElement>(".mw-section__head");
    if (!head) return null;
    const section = head.closest<HTMLElement>(".mw-section");
    const anchorId = section?.dataset.mwGroup ?? "";
    if (!anchorId || anchorId === payload.groupId) return null;
    const r = head.getBoundingClientRect();
    const place: Place = y < r.top + r.height / 2 ? "before" : "after";
    return { kind: "group", anchorId, place };
  }

  private isListLayout(): boolean {
    return (this.data?.layout ?? "grid") === "list";
  }

  /**
   * 某个分区在**当前手动顺序**里的最后一张（跨组落点用）。
   * 刻意走数据而不走 DOM：收起的分组不渲染卡片、空分组根本没有卡片，
   * 只有数据能给出正确的「追加位置」。
   */
  private lastItemOfGroup(groupId: string): WallItem | null {
    return this.lastNonMovingItemOfGroup(groupId, new Set());
  }

  /** 同上，但排除正在拖拽的若干 id（多选拖拽用，避免锚点落到自己身上） */
  private lastNonMovingItemOfGroup(groupId: string, exclude: Set<number>): WallItem | null {
    const data = this.data;
    if (!data) return null;
    const want = groupId === UNGROUPED_ID ? "" : groupId;
    const byId = new Map(data.items.map((i) => [i.albumId, i]));
    const ids = orderedIds(data.items, data.order);
    for (let i = ids.length - 1; i >= 0; i--) {
      if (exclude.has(ids[i])) continue;
      const it = byId.get(ids[i]);
      if (it && (it.groupId ?? "") === want) return it;
    }
    return null;
  }

  /** 落点超出视口时的兜底：取矩形包含该点、或在纵向上最近的一张卡片/分组头 */
  private nearestElementAt(x: number, y: number): HTMLElement | null {
    let best: HTMLElement | null = null;
    let bestDist = Infinity;
    for (const el of Array.from(
      this.contentEl.querySelectorAll<HTMLElement>(
        "[data-mw-album], .mw-section__head"
      )
    )) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
      const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = el;
      }
    }
    return best;
  }

  /** 拖动中的落点提示（落点线 + 卡片/整分区高亮）；无落点时全部隐藏 */
  private hideDropHint(): void {
    this.dragLine?.removeClass("is-visible");
    for (const cls of ["is-drop-target", "is-drop-section"]) {
      for (const el of Array.from(
        this.contentEl.querySelectorAll<HTMLElement>(`.${cls}`)
      )) {
        el.removeClass(cls);
      }
    }
  }

  /** 目标分区的元素（跨组落点用整块高亮，让「这一组会被接收」可见） */
  private sectionEl(groupId: string): HTMLElement | null {
    return this.contentEl.querySelector<HTMLElement>(
      `.mw-section[data-mw-group="${groupId === UNGROUPED_ID ? "" : groupId}"]`
    );
  }

  private updateDropHint(): void {
    if (!this.dragPayload || !this.dragCursor) return;
    const target = this.resolveDrop(this.dragCursor.x, this.dragCursor.y);
    this.hideDropHint();
    if (!target) return;
    const line = this.dropLine;
    // 落点线的包含块是 .mw-stage（position: relative），不是 .mw-view：
    // 用 contentEl 的 rect 当原点会让线整体下移一个工具栏的高度。
    // 另外 rect 给的是视觉像素，而 style.left/top 是局部像素（会被 transform 再乘一次），
    // 所以要除以缩放系数。
    const z = this.zoom;
    const hostEl =
      this.contentEl.querySelector<HTMLElement>(".mw-stage") ?? this.contentEl;
    const host = hostEl.getBoundingClientRect();
    if (target.kind === "item") {
      const p = this.dragPayload;
      const movingGroups =
        p.kind === "item"
          ? [(p.item.groupId ?? UNGROUPED_ID)]
          : p.kind === "multi-item"
            ? p.items.map((x) => x.groupId ?? UNGROUPED_ID)
            : [];
      const crossGroup = movingGroups.some((g) => g !== target.groupId);
      // 跨组：整块分区高亮（卡片高亮在收起/空分组里根本画不出来）
      if (crossGroup) this.sectionEl(target.groupId)?.addClass("is-drop-section");
      if (!target.target) {
        // 空分组：没有锚点卡片，落点信息全靠分区高亮
        line.removeClass("is-visible");
        return;
      }
      const card = this.contentEl.querySelector<HTMLElement>(
        `[data-mw-album="${target.target.albumId}"]`
      );
      if (!card) {
        // 收起的分组：卡片被 display:none，用分组头画一条落点线
        const head = this.sectionEl(target.groupId)?.querySelector<HTMLElement>(
          ".mw-section__head"
        );
        if (!head) return;
        const r = head.getBoundingClientRect();
        line.addClass("is-horizontal");
        line.style.left = `${(r.left - host.left) / z}px`;
        line.style.width = `${r.width / z}px`;
        line.style.top = `${(r.bottom - host.top) / z}px`;
        line.style.height = "";
        line.style.transform = "";
        line.addClass("is-visible");
        return;
      }
      line.addClass("is-visible");
      card.addClass("is-drop-target");
      const r = card.getBoundingClientRect();
      if (this.isListLayout()) {
        // 列表：横向分隔线
        const top = (target.place === "before" ? r.top : r.bottom) - host.top;
        line.addClass("is-horizontal");
        line.style.left = `${(r.left - host.left) / z}px`;
        line.style.top = `${top / z}px`;
        line.style.width = `${r.width / z}px`;
        line.style.height = "";
        line.style.transform = "";
      } else {
        const left = (target.place === "before" ? r.left : r.right) - host.left;
        line.removeClass("is-horizontal");
        line.style.left = `${left / z}px`;
        line.style.top = `${(r.top - host.top) / z}px`;
        line.style.height = `${r.height / z}px`;
        line.style.width = "";
        line.style.transform = "translateX(-50%)";
      }
    } else {
      const head = this.contentEl.querySelector<HTMLElement>(
        `.mw-section[data-mw-group="${target.anchorId}"] .mw-section__head`
      );
      if (!head) return;
      const r = head.getBoundingClientRect();
      const top = (target.place === "before" ? r.top : r.bottom) - host.top;
      line.addClass("is-horizontal");
      line.style.left = `${(r.left - host.left) / z}px`;
      line.style.width = `${r.width / z}px`;
      line.style.top = `${top / z}px`;
      line.style.height = "";
      line.style.transform = "";
      line.addClass("is-visible");
    }
  }

  /** 落盘一次拖动结果（payload 由调用方带入：handleDragUp 里 disposeDrag 已清空字段） */
  private commitDrop(payload: DragPayload, target: DropTarget): void {
    const data = this.data;
    if (!data) return;

    if (payload.kind === "group") {
      if (target.kind !== "group") return;
      if (payload.groupId === target.anchorId) return;
      data.groups = moveGroup(
        data.groups ?? [],
        payload.groupId,
        target.anchorId,
        target.place
      );
      void this.commit(t("wall.group.orderUpdated"));
      return;
    }

    // 唱片：卡片落点（同组换位 / 跨组改组）、分区空白或分组头（追加进目标分区末尾）
    if (target.kind !== "item") return;
    if (payload.kind === "multi-item") {
      const ids = payload.items.map((x) => x.albumId);
      const moving = new Set(ids);
      if (target.target && moving.has(target.target.albumId)) return;
      const order = this.ensureOrder();
      const byId = new Map(data.items.map((i) => [i.albumId, i]));
      const toGroup = target.groupId;
      for (const id of ids) {
        const it = byId.get(id);
        if (!it) continue;
        if (toGroup === UNGROUPED_ID) delete it.groupId;
        else it.groupId = toGroup;
      }
      data.order = target.target
        ? moveInto(order, ids, target.target.albumId, target.place)
        : moveInto(order, ids, null);
      void this.commit(t("wall.order.movedMulti", { count: ids.length }));
      return;
    }
    const item = payload.item;
    const anchor = target.target;
    // 锚点就是自己：同组 = 原地重排（无意义），跨组不可能出现
    if (anchor && anchor.albumId === item.albumId) return;
    const order = this.ensureOrder();
    const fromGroup = item.groupId ?? UNGROUPED_ID;
    const toGroup = target.groupId;
    if (fromGroup === toGroup) {
      if (!anchor) return;
      data.order = moveWithin(order, item.albumId, anchor.albumId, target.place);
      void this.commit(t("wall.order.updated"));
      return;
    }
    // 跨组：先无条件改归属，再按锚点插入；没有锚点（目标分组为空）= 追加到墙末尾
    if (toGroup === UNGROUPED_ID) delete item.groupId;
    else item.groupId = toGroup;
    data.order = anchor
      ? moveInto(order, [item.albumId], anchor.albumId, target.place)
      : moveInto(order, [item.albumId], null);
    void this.commit(t("wall.order.movedToGroup"));
  }

  // ---- 编辑态 ----

  /**
   * 进入编辑态。刻意「不整页重绘」：长按手势此刻正在拖同一张卡片，
   * render() 会把卡片与拖拽浮标一起换掉（旧节点成孤儿），拖动随之失效。
   * 这里只切状态 + 挂类名 + 插操作条，DOM 结构保持不变。
   *
   * 拖动**实时生效**：每次落点都直接写数据并落盘（见 commitDrop / moveItemToGroup），
   * 所以这里不再存快照，退出编辑态也没有「取消并还原」这条路（第五轮反馈 A2）。
   */
  private enterEditMode(): void {
    if (this.editMode || !this.data) return;
    this.editMode = true;
    this.contentEl.addClass("mw-edit-layout");
    // 手动排序之外的排序模式下拖动没有意义：自动切到手动排序（用当前可视顺序初始化）。
    // 排序模式只在下次渲染时才会体现，而进入编辑态本就要拖顺序，故不必立刻重绘。
    const view = this.ensureView();
    if (view.sortMode !== "manual") view.sortMode = "manual";
    this.ensureOrder();
    this.renderEditBar();
    void this.persist();
  }

  private exitEditMode(): void {
    if (!this.editMode) return;
    this.disposeDrag();
    this.editMode = false;
    this.contentEl.removeClass("mw-edit-layout");
    this.contentEl.querySelector(".mw-editbar")?.remove();
    this.render();
  }

  /** 编辑态的操作条：缩放盒里**正常流的第一行**（编辑条 → 工具栏 → 网格） */
  private renderEditBar(): void {
    this.contentEl.querySelector(".mw-editbar")?.remove();
    const host = this.zoomBox ?? this.contentEl;
    const bar = host.createDiv({ cls: "mw-editbar" });
    // 插到最前面：不能再用 position:absolute 贴顶——缩放盒是定位上下文，
    // absolute 会正好压在工具栏上（提示文字与墙名重叠、横线穿过图标）。
    host.insertBefore(bar, host.firstChild);
    bar.createDiv({
      cls: "mw-editbar__text",
      text: t("wall.editbar.text"),
    });
    // 只有一个「完成」图标：拖动已经实时落盘，没有需要再确认的提交，
    // 也没有可回滚的取消（第五轮反馈 A2：两个按钮收成一个 ✓）
    const done = bar.createEl("button", { cls: "clickable-icon mw-editbar__done" });
    done.setAttr("type", "button");
    done.setAttr("aria-label", t("wall.editbar.done"));
    done.setAttr("title", t("wall.editbar.done"));
    setIcon(done, "check");
    done.addEventListener("click", () => this.exitEditMode());
    // 编辑条占了顶部一行，顶栏被推下去：面板/浮层的定位要跟着重算
    this.watchTopbarHeight();
  }

  // ---- 多选态 ----

  /** 进入多选：与编辑态互斥，单击卡片改为切换选中 */
  private enterSelectMode(): void {
    if (this.selectMode || !this.data) return;
    if (this.editMode) this.exitEditMode();
    this.selectMode = true;
    this.contentEl.addClass("mw-selecting");
    this.syncToolbarState();
    this.rerenderGrid();
    this.renderSelectionBar();
  }

  /** 退出多选：清空已选（按需求约定） */
  private exitSelectMode(): void {
    if (!this.selectMode) return;
    this.selectMode = false;
    this.selected.clear();
    this.contentEl.removeClass("mw-selecting");
    this.contentEl.querySelector(".mw-selectbar")?.remove();
    this.syncToolbarState();
    this.rerenderGrid();
  }

  private isSelected(albumId: number): boolean {
    return this.selected.has(albumId);
  }

  private toggleSelect(albumId: number): void {
    if (this.selected.has(albumId)) this.selected.delete(albumId);
    else this.selected.add(albumId);
    this.paintSelection();
  }

  /** 选中项对应的 WallItem（按当前数据过滤掉已删除） */
  private selectedItems(): WallItem[] {
    if (!this.data || !this.selected.size) return [];
    const byId = new Map(this.data.items.map((i) => [i.albumId, i]));
    const out: WallItem[] = [];
    for (const id of this.selected) {
      const hit = byId.get(id);
      if (hit) out.push(hit);
    }
    return out;
  }

  /** 剪枝已不存在的选中 id（删除/迁移/重载后调用） */
  private pruneSelection(): void {
    if (!this.selected.size) return;
    if (!this.data) {
      this.selected.clear();
      return;
    }
    const alive = new Set(this.data.items.map((i) => i.albumId));
    for (const id of [...this.selected]) {
      if (!alive.has(id)) this.selected.delete(id);
    }
  }

  /** 不重建网格，只刷新选中态（高亮 + 复选框 + 底部计数） */
  private paintSelection(): void {
    for (const el of Array.from(
      this.contentEl.querySelectorAll<HTMLElement>("[data-mw-album]")
    )) {
      const id = Number(el.dataset.mwAlbum);
      const on = this.selected.has(id);
      el.toggleClass("is-selected", on);
      const box = el.querySelector<HTMLButtonElement>(".mw-selectbox");
      if (box) syncSelectBox(box, on);
    }
    const count = this.contentEl.querySelector<HTMLElement>(".mw-selectbar__count");
    if (count)
      count.setText(t("wall.select.count", { count: this.selected.size }));
    const btns = this.contentEl.querySelectorAll<HTMLElement>(
      ".mw-selectbar [data-sel-act]"
    );
    const has = this.selected.size > 0;
    for (const b of Array.from(btns)) {
      const act = b.dataset.selAct;
      if (act === "all" || act === "exit") continue;
      (b as HTMLButtonElement).toggleClass("is-disabled", !has);
    }
  }

  private selectAllVisible(): void {
    for (const i of this.getVisibleItems()) this.selected.add(i.albumId);
    this.paintSelection();
  }

  private invertSelectionVisible(): void {
    const visible = new Set(this.getVisibleItems().map((i) => i.albumId));
    const next = new Set<number>();
    for (const id of visible) {
      if (!this.selected.has(id)) next.add(id);
    }
    // 可见之外的选中保留，避免隐藏项被意外丢掉
    if (this.data) {
      for (const id of this.selected) {
        if (!visible.has(id)) next.add(id);
      }
    }
    this.selected = next;
    this.paintSelection();
  }

  private clearSelection(): void {
    this.selected.clear();
    this.paintSelection();
  }

  /** 底部多选操作条：与编辑条同为缩放盒正常流首行之下（工具栏之上不压图标） */
  private renderSelectionBar(): void {
    this.contentEl.querySelector(".mw-selectbar")?.remove();
    if (!this.selectMode) return;
    const host = this.zoomBox ?? this.contentEl;
    const bar = host.createDiv({ cls: "mw-selectbar" });
    const toolbar = host.querySelector(".mw-toolbar");
    if (toolbar?.nextSibling) host.insertBefore(bar, toolbar.nextSibling);
    else host.appendChild(bar);
    bar.createDiv({
      cls: "mw-selectbar__count",
      text: t("wall.select.count", { count: this.selected.size }),
    });
    const mkBtn = (
      icon: string,
      label: string,
      act: string,
      fn: () => void,
      cls = ""
    ) => {
      const b = bar.createEl("button", {
        cls: `mw-selbtn${cls ? " " + cls : ""}`,
      });
      b.setAttr("type", "button");
      b.setAttr("title", label);
      b.setAttr("aria-label", label);
      setIcon(b, icon);
      b.dataset.selAct = act;
      b.addEventListener("click", fn);
      return b;
    };
    mkBtn("list-checks", t("wall.select.all"), "all", () =>
      this.selectAllVisible()
    );
    mkBtn("arrow-left-right", t("wall.select.invert"), "invert", () =>
      this.invertSelectionVisible()
    );
    mkBtn("eraser", t("wall.select.clear"), "clear", () =>
      this.clearSelection()
    );
    mkBtn("arrow-right", t("wall.select.migrate"), "migrate", () =>
      this.migrateSelectedToWall(), "mw-selbtn--primary");
    mkBtn("folder-input", t("wall.select.group"), "group", () =>
      this.moveSelectedToGroup()
    );
    mkBtn("trash", t("wall.select.delete"), "delete", () =>
      this.confirmDeleteSelected(), "mw-selbtn--danger");
    mkBtn("x", t("wall.select.exit"), "exit", () => this.exitSelectMode());
    this.paintSelection();
  }

  /** 把选中唱片批量移动到指定分组（null = 未分组）；保持选中相对顺序 */
  private moveItemsToGroup(ids: number[], groupId: string | null): void {
    const data = this.data;
    if (!data || !ids.length) return;
    const moving = new Set(ids);
    const order = this.ensureOrder();
    const want = groupId ?? UNGROUPED_ID;
    const byId = new Map(data.items.map((i) => [i.albumId, i]));
    // 目标分区现有成员（排除本次移动项），取其在手动顺序中的最后一张做锚点
    const seq = order.filter((id) => {
      const it = byId.get(id);
      if (!it || moving.has(id)) return false;
      return (it.groupId ?? UNGROUPED_ID) === want;
    });
    const anchor = seq.length ? seq[seq.length - 1] : null;
    for (const id of ids) {
      const it = byId.get(id);
      if (!it) continue;
      if (groupId === null) delete it.groupId;
      else it.groupId = groupId;
    }
    data.order =
      anchor != null
        ? moveInto(order, ids, anchor, "after")
        : moveInto(order, ids, null);
    const name =
      want === UNGROUPED_ID
        ? t("wall.group.ungrouped")
        : (data.groups?.find((g) => g.id === want)?.name ??
          t("wall.group.fallbackName"));
    void this.commit(
      t("wall.group.movedToMulti", { count: ids.length, name })
    );
  }

  /** 多选：移动到分组（本墙内，与单张 pickGroupFor 同语言，不选墙） */
  private moveSelectedToGroup(): void {
    const items = this.selectedItems();
    if (!items.length) {
      new Notice(t("wall.select.needSelect"));
      return;
    }
    const groups = this.data?.groups ?? [];
    if (!groups.length) {
      new Notice(t("wall.select.noGroups"));
      return;
    }
    const targets: { id: string; label: string }[] = [
      { id: UNGROUPED_ID, label: t("wall.group.ungrouped") },
      ...groups.map((g) => ({ id: g.id, label: g.name })),
    ];
    new PickerModal(
      this.app,
      t("wall.pick.multiMove", { count: items.length }),
      targets.map((gt) => ({
        label: gt.label,
        detail: t("wall.pick.groupCount", {
          count: this.data!.items.filter(
            (i) => (i.groupId ?? UNGROUPED_ID) === gt.id
          ).length,
        }),
      })),
      (i) => {
        const target = targets[i];
        if (!target) return;
        this.moveItemsToGroup(
          items.map((x) => x.albumId),
          target.id === UNGROUPED_ID ? null : target.id
        );
      }
    ).open();
  }

  /** 多选：迁移到其他墙（剪切语义；重复跳过并汇总） */
  private migrateSelectedToWall(): void {
    const items = this.selectedItems();
    if (!items.length) {
      new Notice(t("wall.select.needSelect"));
      return;
    }
    const files = this.plugin.wallFiles(this.file?.path);
    if (!files.length) {
      new Notice(t("wall.select.noWalls"));
      return;
    }
    new PickerModal(
      this.app,
      t("wall.pick.multiMigrate", { count: items.length }),
      files.map((f) => ({
        label: f.basename,
        detail:
          f.parent && f.parent.path !== "/"
            ? f.parent.path
            : t("wall.pick.vaultRoot"),
      })),
      (i) => void this.doMigrateSelected(items, files[i])
    ).open();
  }

  private async doMigrateSelected(items: WallItem[], target: TFile): Promise<void> {
    if (!this.data) return;
    let okCount = 0;
    let skipCount = 0;
    let failCount = 0;
    const moved: number[] = [];
    for (const item of items) {
      try {
        const ok = await this.plugin.migrateItemInto(item, target);
        if (ok) {
          okCount++;
          moved.push(item.albumId);
        } else {
          skipCount++;
        }
      } catch {
        failCount++;
      }
    }
    if (moved.length) {
      const drop = new Set(moved);
      this.data.items = this.data.items.filter((i) => !drop.has(i.albumId));
      if (this.data.order) {
        this.data.order = removeFromOrder(this.data.order, moved);
      }
      for (const id of moved) this.selected.delete(id);
      await this.persist();
      this.render();
      this.renderSelectionBar();
    }
    const parts = [
      t("wall.select.migratedBatch", { ok: okCount, target: target.basename }),
    ];
    if (skipCount)
      parts.push(t("wall.select.migrateSkipped", { count: skipCount }));
    if (failCount)
      parts.push(t("wall.select.migrateFailed", { count: failCount }));
    new Notice(parts.join(t("main.listSep")));
  }

  /** 多选删除：一次确认，列出数量 + 前几张 */
  private confirmDeleteSelected(): void {
    const items = this.selectedItems();
    if (!items.length) {
      new Notice(t("wall.select.needSelect"));
      return;
    }
    const list = items.slice(0, 8).map((m) => `《${m.meta.name}》`);
    if (items.length > 8)
      list.push(t("wall.group.andMore", { count: items.length }));
    new ConfirmModal(this.app, {
      title: t("wall.select.deleteTitle", { count: items.length }),
      message: t("wall.select.deleteMsg", { count: items.length }),
      details: [...list, t("wall.select.deleteNote")],
      danger: true,
      confirmText: t("common.delete"),
      onConfirm: async () => {
        const data = this.data!;
        const drop = new Set(items.map((i) => i.albumId));
        data.items = data.items.filter((i) => !drop.has(i.albumId));
        if (data.order) {
          data.order = removeFromOrder(data.order, [...drop]);
        }
        this.selected.clear();
        await this.persist();
        this.render();
        this.renderSelectionBar();
        new Notice(t("wall.select.deleted", { count: items.length }));
      },
    }).open();
  }

  private openPlayModal(item: WallItem): void {
    new AlbumPanelModal(this.app, "play", {
      meta: item.meta,
      navigation: this.albumPanelNavigation(),
      style: this.data!.style,
      locked: item.locked,
      source: item.source,
      rating: item.rating,
      onRate: (r) => this.applyRating(item, r),
      deps: this.getPlaybackDeps(),
    }).open();
  }

  /** 统一落盘评分（含撤回 undefined）：持久化＋墙面徽标刷新＋开盒详情星显同步 */
  private applyRating(item: WallItem, rating: number | undefined): void {
    const next = normalizeRating(rating);
    if (next === undefined) delete item.rating;
    else item.rating = next;
    void this.persist();
    this.rerenderGrid();
    // 开盒详情正开着同一张：原地刷新星显与按钮文案，不重走开盒动画
    const detail = this.contentEl.querySelector<HTMLElement>(".mw-shelf-detail");
    const stars = detail?.querySelector<HTMLElement>(
      `.mw-gf__rate-stars[data-mw-album="${item.albumId}"]`
    );
    if (stars) {
      paintStarsDisplay(stars, next);
      const btn = detail?.querySelector<HTMLElement>(
        `.mw-gf__rate-btn[data-mw-album="${item.albumId}"]`
      );
      if (btn)
        btn.setText(next ? t("rating.change") : t("rating.rate"));
    }
  }

  /** 右键「评分…」：弹出评分框（五星悬停预览＋清除评分） */
  private rateItem(item: WallItem): void {
    new RatingModal(this.app, {
      albumName: item.meta.name,
      current: item.rating,
      onSave: (r) => this.applyRating(item, r),
    }).open();
  }

  /** 解锁后元数据编辑；reopenDetail = 编辑保存后回到场景内详情 */
  private editItemMeta(item: WallItem, reopenDetail: boolean): void {
    new EditMetaModal(this.app, item.meta, async (meta) => {
      item.meta = meta;
      item.metaEdited = true;
      await this.persist();
      this.render();
      new Notice(t("wall.metaSaved"));
      if (reopenDetail) this.openShelfDetail(item);
    }).open();
  }

  // ---- 展示架：开盒详情（推镜 + 3D gatefold，仅 shelf 布局，替代播放模态） ----

  /** 场景动画句柄（含 scrim/book/翻页/淡入/飞回），统一 cancel 用 */
  private detailAnims: Animation[] = [];
  private detailBusy = false;
  /** 异步时序令牌：render 重建/中止时自增，使陈旧回调失效 */
  private detailSeq = 0;
  private detailArtistPicker: PickerModal | null = null;
  private detailArtistRequest = 0;
  /** 进入详情前的架子滚动位（关闭时相机回撤目标） */
  private detailPrevScroll = 0;
  private detailOpen = false;
  /** 会话级盘片面选择：null = 跟随墙级样式（cd 墙用 CD 面，其余黑胶面） */
  private gfDisc: "vinyl" | "cd" | null = null;
  /** 推镜位姿：封面页与架上封套的对齐参数（关闭时飞回的基准） */
  private detailPose: { dx: number; dy: number; s: number } | null = null;
  /** 开盒状态机：idle → preparing(滚动/建盒/测距) → animating(时间线) → open */
  private gfPhase: "idle" | "preparing" | "animating" | "open" = "idle";
  private gfTarget: "open" | "closed" = "closed";
  /** 动画中点击其他唱片：排队，收完再开 */
  private gfQueue: WallItem | null = null;
  private gfClosing = false;
  private gfBookAnim: Animation | null = null;
  /** 翻页动画（无 delay，reverse 可从任意中间姿态平滑倒放） */
  private gfPageAnims: Animation[] = [];
  private gfPan: { done: Promise<void>; cancel: () => void } | null = null;

  private openShelfDetail(item: WallItem): void {
    this.requestOpen(item);
  }

  private closeShelfDetail(): void {
    this.requestClose();
  }

  /** gfTarget 的读法走 getter：TS 无法跨方法追踪字段变更，直读会被收窄成常量 */
  private get targetClosed(): boolean {
    return this.gfTarget === "closed";
  }

  /** 点唱片：空闲即开；动画中/已开则排队，收完自动开新唱片 */
  private requestOpen(item: WallItem): void {
    if (this.gfPhase === "idle" && !this.gfClosing) {
      void this.openSequence(item);
      return;
    }
    this.gfQueue = item;
    if (this.gfPhase === "open" && !this.gfClosing) void this.driveClose();
  }

  /** ✕/Esc/点空白：任意时刻可打断——从当前姿态平滑反向收盒，不硬切 */
  private requestClose(): void {
    if (this.gfPhase === "idle" || this.gfClosing) return;
    this.gfTarget = "closed";
    if (this.gfPhase === "preparing") return; // open 序列检查点自行中止
    void this.driveClose();
  }

  /**
   * 开盒：卡片居中落位（自有补间）→ 建盒测距（基态闭合位姿）→
   * scrim/推镜动画 + is-booting 钉住闭合 → 翻页动画（无 delay，支持 reverse 打断）
   * → 内容错峰淡入。终态姿态由 CSS is-open 持有，动画保留到收盒时 reverse。
   */
  private async openSequence(item: WallItem): Promise<void> {
    const stage = this.contentEl.querySelector(".mw-stage") as HTMLElement | null;
    const detail = this.contentEl.querySelector<HTMLElement>(".mw-shelf-detail");
    if (!stage || !detail) return;
    const seq = ++this.detailSeq;
    this.gfPhase = "preparing";
    this.gfTarget = "open";
    this.gfQueue = null;
    this.detailBusy = true;
    this.detailOpen = false;
    const live = () => seq === this.detailSeq;
    this.retractAllShelf();
    const grid = stage.querySelector<HTMLElement>(".mw-grid");
    const card = this.contentEl.querySelector<HTMLElement>(
      '.mw-shelf-card[data-mw-album="' + String(item.albumId) + '"]'
    );
    const jacket = card?.querySelector<HTMLElement>(".mw-shelf-jacket") ?? null;
    this.detailPrevScroll = num(grid?.scrollTop);
    // 相机平移：自有补间（与收盒回撤同一缓动系统），不依赖原生 smooth scrollIntoView
    let pan: { done: Promise<void>; cancel: () => void } | null = null;
    if (grid && card) {
      const target = gfCenterScrollTop(grid, card, this.zoom);
      pan = panScrollTo(grid, target, 380);
      this.gfPan = pan;
    }
    if (pan) await pan.done.catch(() => undefined);
    if (!live()) return;
    if (this.targetClosed) {
      this.abortOpen(detail, grid);
      return;
    }
    const built = this.buildGatefold(detail, item);
    if (!live() || !built) {
      if (live()) this.abortOpen(detail, grid);
      return;
    }
    const narrow = num(stage.clientWidth) > 0 && num(stage.clientWidth) <= 640;
    const instant = this.gatefoldInstant();
    // 推镜测距：此刻未挂 is-open，面板处于 CSS 闭合位姿，封面页 rect 即屏幕上的封面。
    // 封套 rect 须量"静置位姿"——点击时卡片处于 hover 抽出态（上浮+放大 6%），
    // 直接量会把收盒落点带偏，故临时挂 mw-measure 钉回原位。
    // 位移反解必须考虑 scale 以 book 中心为原点：封面中心偏在 book 右半（+W/4），
    // 缩放会把封面中心拽回 (1−s)·W/4——不补偿则推镜起点与收盒落点都系统性左偏。
    const pose: { dx: number; dy: number; s: number } | null = (() => {
      const cover = built.book.querySelector<HTMLElement>(".mw-gf__face--cover");
      const bc = rectCenter(built.book.getBoundingClientRect?.());
      const cr = rectCenter(cover?.getBoundingClientRect?.());
      card?.addClass("mw-measure");
      const jr = rectCenter(jacket?.getBoundingClientRect?.());
      card?.removeClass("mw-measure");
      if (!bc || !cr || !jr || cr.w <= 0) return null;
      const s = jr.w / cr.w;
      // rect 差值是视觉像素，而 transform 的长度是局部像素（会被 zoom 再乘一次）
      const z = this.zoom || 1;
      return {
        dx: (jr.x - bc.x - s * (cr.x - bc.x)) / z,
        dy: (jr.y - bc.y - s * (cr.y - bc.y)) / z,
        s,
      };
    })();
    this.detailPose = pose;
    const full = !instant && !narrow;
    const anims: Animation[] = [];
    let bootAnim: Animation | null = null;
    // scrim 渐暗贯穿推镜+开盒全程，推镜期间架子保持可见
    anims.push(
      built.scrim.animate(
        full ? [{ opacity: 0 }, { opacity: 0.55, offset: 0.42 }, { opacity: 1 }] : [{ opacity: 0 }, { opacity: 1 }],
        { duration: full ? 1100 : 240, fill: "both" }
      )
    );
    if (full && pose) {
      // 首帧先压到架上封套位姿，避免全尺寸盒子闪现；fill:both 结束后保持终点
      built.book.style.transform = gfPoseStr(pose);
      bootAnim = built.book.animate(
        [{ transform: gfPoseStr(pose) }, { transform: GF_NEUTRAL }],
        { duration: 460, easing: GF_EASE, fill: "both" }
      );
      anims.push(bootAnim);
      this.gfBookAnim = bootAnim;
    }
    this.detailAnims = anims;
    // Obsidian 的 addClass 不接受空格分隔多类字符串（整串当作一个 token 会抛
    // InvalidCharacterError），必须逐个调用
    detail.addClass("is-open");
    if (full) detail.addClass("is-booting");
    this.gfPhase = "animating";
    if (bootAnim) await this.animWrap(bootAnim);
    if (!live()) return;
    if (this.targetClosed || this.gfQueue) {
      await this.driveClose();
      return;
    }
    // 推镜落位：摘 is-booting 同帧建翻页动画（首帧=闭合位姿，无缝衔接）
    detail.removeClass("is-booting");
    built.book.style.transform = "";
    const pageAnims: Animation[] = [];
    if (full) {
      // 翻开：左页绕书脊 180°→0°（落定平面，保证旋转面内子元素可命中）；右页保持 0°
      if (built.panelL) {
        pageAnims.push(
          built.panelL.animate([{ transform: "rotateY(180deg)" }, { transform: "rotateY(0deg)" }], {
            duration: 640,
            easing: GF_EASE,
            fill: "both",
          })
        );
      }
      const delays = [120, 240, 200, 320];
      built.targets.forEach((el, k) => {
        pageAnims.push(
          el.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 300,
            delay: delays[k],
            fill: "both",
          })
        );
      });
    }
    this.gfPageAnims = pageAnims;
    anims.push(...pageAnims);
    await Promise.all(pageAnims.map((a) => this.animWrap(a))).catch(() => undefined);
    if (!live()) return;
    if (this.targetClosed || this.gfQueue) {
      await this.driveClose();
      return;
    }
    this.gfPhase = "open";
    this.detailBusy = false;
    this.detailOpen = true;
  }

  /**
   * 收盒（串行可打断）：①合页——翻页动画 reverse() 从任意中间姿态平滑倒放，
   * 内容/scrim 同步淡出；②缩小 + 相机回撤并行——盒子从当前位姿飞回架上封套
   * （目标按滚回 prevScroll 后卡片应在的视口位修正），scrollTop 同缓动补间，
   * 盒子精确落回原唱片。完成后按队列自动开下一张。
   */
  private async driveClose(): Promise<void> {
    this.detailArtistPicker?.close(); this.detailArtistPicker = null; this.detailArtistRequest++;
    if (this.gfClosing) return;
    this.gfClosing = true;
    const seq = this.detailSeq;
    const stage = this.contentEl.querySelector(".mw-stage") as HTMLElement | null;
    const detail = this.contentEl.querySelector<HTMLElement>(".mw-shelf-detail");
    const grid = stage?.querySelector<HTMLElement>(".mw-grid") ?? null;
    const finish = () => {
      this.gfClosing = false;
    };
    if (!stage || !detail || !grid) {
      this.resetDetailState();
      finish();
      return;
    }
    const narrow = num(stage.clientWidth) > 0 && num(stage.clientWidth) <= 640;
    if (this.gatefoldInstant()) {
      this.snapShut(detail, grid);
      finish();
      return;
    }
    this.detailOpen = false;
    this.detailBusy = true;
    // ① 合页（推镜阶段翻页动画尚未创建，面板仍被 is-booting 钉在闭合姿态，直接跳到缩小）。
    // 不用 reverse()：从当前姿态快照新建闭合动画——跨引擎行为一致，中途打断同样平滑。
    if (this.gfPageAnims.length) {
      const closers: Promise<unknown>[] = [];
      const panelL = detail.querySelector<HTMLElement>(".mw-gf__panel--left");
      if (panelL?.animate) {
        const from =
          typeof getComputedStyle === "function" ? getComputedStyle(panelL).transform : "none";
        closers.push(
          this.animWrap(
            panelL.animate(
              [{ transform: from === "none" ? "rotateY(180deg)" : from }, { transform: "rotateY(180deg)" }],
              { duration: 420, easing: GF_EASE, fill: "forwards" }
            )
          )
        );
      }
      const scrim = detail.querySelector<HTMLElement>(".mw-gf__scrim");
      if (scrim?.animate) {
        const from =
          typeof getComputedStyle === "function" ? getComputedStyle(scrim).opacity : "1";
        closers.push(
          this.animWrap(
            scrim.animate([{ opacity: from }, { opacity: 0 }], { duration: 280, fill: "forwards" })
          )
        );
      }
      for (const el of Array.from(
        detail.querySelectorAll<HTMLElement>(
          ".mw-gf__meta, .mw-gf__tracks, .mw-gf__discwrap, .mw-gf__swap"
        )
      )) {
        closers.push(
          this.animWrap(el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 180, fill: "forwards" }))
        );
      }
      await Promise.all(closers).catch(() => undefined);
      if (seq !== this.detailSeq) return finish();
    }
    // ② 缩小飞回 + 相机回撤（并行）
    const book = detail.querySelector<HTMLElement>(".mw-gf__book");
    if (narrow || !book?.animate) {
      this.cancelAllDetailAnims();
      detail.removeClass("is-open", "is-booting", "is-shutting");
      detail.empty();
      this.scrollGridBack(grid, "instant");
      this.detailPose = null;
      this.gfPhase = "idle";
      this.detailBusy = false;
      finish();
    } else {
      // 快照要在 cancel 之前：cancel 会让 computed 立刻回落到内联起始位姿
      const from =
        typeof getComputedStyle === "function" ? getComputedStyle(book).transform : "none";
      try {
        this.gfBookAnim?.cancel();
      } catch {
        /* 忽略 */
      }
      this.gfBookAnim = null;
      const shrink = this.shrinkBack(grid, book, from);
      this.detailAnims.push(shrink.anim);
      this.gfPan = shrink.pan;
      await Promise.all([this.animWrap(shrink.anim), shrink.pan.done]).catch(() => undefined);
      if (seq !== this.detailSeq) return finish();
      this.cancelAllDetailAnims();
      detail.removeClass("is-open", "is-booting", "is-shutting");
      this.clearGatefoldPose(detail);
      detail.empty();
      this.detailPose = null;
      this.gfPhase = "idle";
      this.detailBusy = false;
      finish();
    }
    const next = this.gfQueue;
    this.gfQueue = null;
    if (next) void this.openSequence(next);
  }

  /** 盒子飞回架上封套位姿（420ms）+ scrollTop 同缓动补间（并行） */
  private shrinkBack(
    grid: HTMLElement,
    book: HTMLElement,
    from: string
  ): { anim: Animation; pan: { done: Promise<void>; cancel: () => void } } {
    const pose = this.detailPose ?? { dx: 0, dy: 0, s: 1 };
    const s2 = num(grid.scrollTop);
    // 目标 = 滚回 prevScroll 后封套应在的视口位（横移不变，纵移叠加滚动差）
    const target = { dx: pose.dx, dy: pose.dy + (s2 - this.detailPrevScroll), s: pose.s };
    const anim = book.animate(
      // 落定姿态取 0° 倾角：-14° 入戏倾斜经透视投影会带来几像素落点偏差，落地须正
      [{ transform: from === "none" ? GF_NEUTRAL : from }, { transform: gfPoseStr(target, 0) }],
      { duration: 420, easing: GF_EASE, fill: "forwards" }
    );
    const pan = panScrollTo(grid, this.detailPrevScroll, 420);
    return { anim, pan };
  }

  /** 开盒中止（滚动阶段被关闭）：静默复位到架子 */
  private abortOpen(detail: HTMLElement, grid: HTMLElement | null): void {
    this.cancelAllDetailAnims();
    detail.removeClass("is-open", "is-booting", "is-shutting");
    detail.empty();
    this.clearGatefoldPose(detail);
    this.scrollGridBack(grid, "instant");
    this.detailPose = null;
    this.gfPhase = "idle";
    this.detailBusy = false;
    this.detailOpen = false;
  }

  /** render 重建前的全套复位（动画句柄随旧 DOM 失效） */
  private resetDetailState(): void {
    this.detailSeq++;
    this.cancelAllDetailAnims();
    this.detailPose = null;
    this.gfPhase = "idle";
    this.gfTarget = "closed";
    this.gfQueue = null;
    this.gfClosing = false;
    this.detailBusy = false;
    this.detailOpen = false;
  }

  /** reduce-motion 或缺乏 WAAPI/几何可测环境：直接切状态 */
  private gatefoldInstant(): boolean {
    const reduce =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const probe = this.contentEl;
    return reduce || typeof probe.animate !== "function" || typeof probe.getBoundingClientRect !== "function";
  }

  /** 硬切关闭：无动画直接回到闭合骨架 */
  private snapShut(detail: HTMLElement, grid: HTMLElement | null): void {
    this.detailArtistPicker?.close(); this.detailArtistPicker = null; this.detailArtistRequest++;
    this.detailSeq++;
    this.cancelAllDetailAnims();
    detail.removeClass("is-open", "is-booting", "is-shutting");
    detail.empty();
    this.clearGatefoldPose(detail);
    this.scrollGridBack(grid, "instant");
    this.detailPose = null;
    this.gfPhase = "idle";
    this.gfTarget = "closed";
    this.detailBusy = false;
    this.detailOpen = false;
  }

  /** cancel 全部场景动画句柄（fill 终态随之释放，回落到 CSS 规则） */
  private cancelAllDetailAnims(): void {
    for (const a of this.detailAnims) {
      try {
        a.cancel();
      } catch {
        /* mock 环境句柄形状不定：忽略 */
      }
    }
    this.detailAnims = [];
    this.gfBookAnim = null;
    this.gfPageAnims = [];
    if (this.gfPan) {
      this.gfPan.cancel();
      this.gfPan = null;
    }
  }

  /** 清掉盒子上的内联推镜 transform */
  private clearGatefoldPose(detail: HTMLElement): void {
    const book = detail.querySelector<HTMLElement>(".mw-gf__book");
    if (book) book.style.transform = "";
  }

  /** 相机回撤：恢复进详情前的架子滚动位（snap/instant 路径用） */
  private scrollGridBack(grid: HTMLElement | null, behavior: ScrollBehavior): void {
    if (!grid) return;
    try {
      if (typeof grid.scrollTo === "function") {
        grid.scrollTo({ top: this.detailPrevScroll, behavior });
      } else {
        grid.scrollTop = this.detailPrevScroll;
      }
    } catch {
      grid.scrollTop = this.detailPrevScroll;
    }
  }

  /** 动画完成等待：finished 优先；mock 代理缺 Promise 时回退 finish 事件；两路都无则立即完成 */
  private animWrap(anim: Animation): Promise<unknown> {
    return new Promise((resolve) => {
      let done = false;
      const fin = () => {
        if (!done) {
          done = true;
          resolve(undefined);
        }
      };
      const f = anim.finished as Promise<unknown> | undefined;
      if (f && typeof f.then === "function") f.then(fin, fin);
      try {
        if (typeof anim.addEventListener === "function") {
          anim.addEventListener("finish", fin, { once: true } as EventListenerOptions);
        }
      } catch {
        /* mock 形状不兼容：靠 finished 或直落 */
      }
      if (!f || typeof f.then !== "function") fin();
    });
  }

  /** 构建 gatefold 骨架（scrim + book + 左右双面板各双面），供推镜测距与动画取元素 */
  private buildGatefold(
    detail: HTMLElement,
    item: WallItem
  ): {
    book: HTMLElement;
    panelL: HTMLElement;
    panelR: HTMLElement;
    scrim: HTMLElement;
    faces: HTMLElement[];
    targets: HTMLElement[];
  } | null {
    detail.empty();
    const meta = item.meta;
    // 遮罩既是视觉压暗、也是「点空白处收起」的命中层（第七轮修正）：
    // 曾经 pointer-events:none 让点击穿透到墙上，点背面唱片会被当成「换开另一张」，
    // 用户报「点黑色空白处没收回详情，反而误触切换」。现在 scrim 在 is-open 时接管点击：
    // 点册页落在 book 上（不关闭），点册页外任何位置都收起。
    const scrim = detail.createDiv({ cls: "mw-gf__scrim" });
    scrim.addEventListener("click", (e) => {
      e.stopPropagation();
      this.requestClose();
    });
    const book = detail.createDiv({ cls: "mw-gf__book" });

    // 右页必须先建：闭合态左右两页共面，共面时后建者绘制在上，封面页（左页）要压住盘托
    const panelR = book.createDiv({ cls: "mw-gf__panel mw-gf__panel--right" });
    const panelL = book.createDiv({ cls: "mw-gf__panel mw-gf__panel--left" });

    const info = panelL.createDiv({ cls: "mw-gf__face mw-gf__face--info" });
    const bar = info.createDiv({ cls: "mw-gf__bar" });
    const closeBtn = bar.createEl("button", { cls: "clickable-icon mw-gf__close", attr: { type: "button", "aria-label": t("wall.shelf.closeTip") } });
    setIcon(closeBtn, "x");
    closeBtn.setAttr("title", t("wall.shelf.closeTip"));
    closeBtn.addEventListener("click", () => this.closeShelfDetail());

    // 发行年 + 总时长：顶栏内、操作钮左侧（右页盘片占满，无处安放），随左页信息带一起右移
    const barMeta = bar.createDiv({ cls: "mw-gf__bar-meta" });
    if (meta.year) {
      barMeta.createDiv({
        cls: "mw-gf__year",
        text: t("wall.shelf.released", { year: meta.year }),
      });
    }
    const totalDur = sumTrackDur(meta.tracks);
    if (totalDur > 0) {
      const durEl = barMeta.createDiv({
        cls: "mw-gf__total",
        text: t("wall.shelf.totalDur", { value: fmtTotalDur(totalDur) }),
      });
      durEl.title = fmtTotalDurTip(totalDur);
    }

    const tools = bar.createDiv({ cls: "mw-gf__tools" });
    const mkTool = (icon: string, title: string, danger: boolean, fn: () => void) => {
      const b = tools.createEl("button", {
        cls: danger ? "clickable-icon mw-gf__tool mw-gf__tool--danger" : "clickable-icon mw-gf__tool",
        attr: { type: "button", "aria-label": title },
      });
      setIcon(b, icon);
      b.setAttr("title", title);
      b.addEventListener("click", fn);
    };
    mkTool("link", t("wall.shelf.copyLink"), false, async () => {
      await navigator.clipboard.writeText(`https://music.163.com/album?id=${item.albumId}`);
      new Notice(t("common.copied"));
    });
    mkTool("arrow-right", t("wall.shelf.migrate"), false, () =>
      this.migrateCard(item)
    );
    mkTool("trash", t("wall.shelf.remove"), true, () =>
      this.confirmDelete(item)
    );

    const metaBox = info.createDiv({ cls: "mw-gf__meta" });
    const nameEl = metaBox.createEl("button", { cls: "mw-gf__name mw-gf__link", text: meta.name, attr: { type: "button" } });
    nameEl.title = meta.name;
    nameEl.addEventListener("click", event => {
      event.stopPropagation();
      void this.plugin.openLibraryCollection(meta).catch(() => new Notice(t("library.failed")));
    });
    const artistEl = metaBox.createEl("button", {
      cls: "mw-gf__artist mw-gf__link", attr: { type: "button" },
      text: meta.artist || t("common.unknownArtist"),
    });
    artistEl.title = meta.artist || t("common.unknownArtist");
    let artistRefs = meta.artistRefs;
    artistEl.addEventListener("click", event => {
      event.stopPropagation();
      const seq = this.detailSeq, request = ++this.detailArtistRequest, cookie = this.plugin.settings.neteaseCookie;
      const valid = () => request === this.detailArtistRequest && seq === this.detailSeq && artistEl.isConnected && cookie === this.plugin.settings.neteaseCookie;
      this.detailArtistPicker?.close(); this.detailArtistPicker = null;
      void (async () => {
        if (!artistRefs?.length) artistRefs = (await this.fetchAlbumDetail(item.albumId)).artistRefs;
        if (!valid()) return;
        const artists = [...new Map((artistRefs || []).filter(artist => artist.id > 0).map(artist => [artist.id, artist])).values()];
        const open = async (index: number) => { if (valid()) await this.plugin.openLibraryArtist({ ...artists[index], cover: "" }); };
        if (artists.length === 1) await open(0);
        else if (artists.length > 1) {
          this.detailArtistPicker = new PickerModal(this.app, t("libraryDetails.chooseArtist"), artists.map(artist => ({ label: artist.name, icon: "mic" })),
            index => { void open(index).catch(() => new Notice(t("library.failed"))); });
          this.detailArtistPicker.open();
        }
      })().catch(() => { if (valid()) new Notice(t("library.failed")); });
    });
    // 评分行：五星只读展示＋“评分”按钮（弹出评分框，悬停预览）
    const gfRateRow = info.createDiv({ cls: "mw-rate-row mw-gf__rate" });
    const gfStars = buildStarsDisplay(item.rating);
    gfStars.addClass("mw-gf__rate-stars");
    gfStars.dataset.mwAlbum = String(item.albumId);
    gfRateRow.appendChild(gfStars);
    const gfRateBtn = gfRateRow.createEl("button", {
      cls: "mw-gf__rate-btn",
      text: normalizeRating(item.rating)
        ? t("rating.change")
        : t("rating.rate"),
    });
    gfRateBtn.dataset.mwAlbum = String(item.albumId);
    gfRateBtn.setAttr("type", "button");
    gfRateBtn.setAttr("title", t("panel.rateTip"));
    gfRateBtn.addEventListener("click", () => this.rateItem(item));
    const tracks = info.createDiv({ cls: "mw-gf__tracks" });
    const list = meta.tracks ?? [];
    if (!list.length) {
      tracks.createDiv({
        cls: "mw-gf__noTrack",
        text: t("wall.shelf.noTracks"),
      });
    } else {
      list.forEach((t, i) => {
        const row = tracks.createDiv({ cls: "mw-gf__track" });
        row.createSpan({ cls: "mw-gf__trackNo", text: `Track-${String(i + 1).padStart(2, "0")}` });
        const nm = row.createSpan({ cls: "mw-gf__trackName", text: t.name });
        nm.title = t.name;
        row.createSpan({ cls: "mw-gf__trackDur", text: fmtDur(t.duration) });
      });
    }
    const coverFace = panelL.createDiv({ cls: "mw-gf__face mw-gf__face--cover" });
    coverFace.appendChild(makeCoverImg(sizedCover(meta.cover, 500), meta.name));

    const tray = panelR.createDiv({ cls: "mw-gf__face mw-gf__face--tray" });
    const discWrap = tray.createDiv({ cls: "mw-gf__discwrap" });
    discWrap.addEventListener("click", () => {
      void playAlbum(item.meta, this.getPlaybackDeps());
    });
    const vinylFace = discWrap.createDiv({ cls: "mw-gf__discface" });
    vinylFace.appendChild(buildDiscElement(item, "vinyl", { coverSize: 500 }));
    const cdFace = discWrap.createDiv({ cls: "mw-gf__discface is-hidden" });
    cdFace.appendChild(buildDiscElement(item, "cd", { coverSize: 500 }));
    const swap = tray.createDiv({ cls: "mw-gf__swap" });
    const btnVinyl = swap.createEl("button", {
      text: styleLabel("vinyl"),
    });
    const btnCd = swap.createEl("button", { text: styleLabel("cd") });
    const applySwap = (which: "vinyl" | "cd") => {
      vinylFace.toggleClass("is-hidden", which !== "vinyl");
      cdFace.toggleClass("is-hidden", which !== "cd");
      btnVinyl.toggleClass("is-active", which === "vinyl");
      btnCd.toggleClass("is-active", which === "cd");
    };
    btnVinyl.addEventListener("click", () => {
      this.gfDisc = "vinyl";
      applySwap("vinyl");
    });
    btnCd.addEventListener("click", () => {
      this.gfDisc = "cd";
      applySwap("cd");
    });
    applySwap(this.gfDisc ?? (this.data!.style === "cd" ? "cd" : "vinyl"));
    const back = panelR.createDiv({ cls: "mw-gf__face mw-gf__face--back" });

    return {
      book,
      panelL,
      panelR,
      scrim,
      faces: [info, coverFace, tray, back],
      targets: [metaBox, tracks, discWrap, swap],
    };
  }

  // ---- 卡片右键菜单（网格 / 列表 / 展示架共用一份描述，皮肤按布局选） ----

  /**
   * 卡片右键菜单：三种布局共用同一份菜单项。
   * 以前展示架另有一份自绘菜单，两边各写一遍导致能力漂移
   * （展示架那份把「移动到分组」内联成一长列分组，第五轮反馈 B3）。
   */
  private openCardMenu(evt: MouseEvent, item: WallItem): void {
    this.showCtxMenu(evt, this.cardMenuItems(item));
  }

  private cardMenuItems(item: WallItem): CtxItem[] {
    const items: CtxItem[] = [
      {
        title: t("wall.ctx.play"),
        icon: "play",
        onPick: () => void playAlbum(item.meta, this.getPlaybackDeps()),
      },
      {
        title: t("wall.ctx.addToPlayer"),
        icon: "disc",
        disabled: !this.plugin.firstPlayerView(),
        onPick: () => {
          if (this.file) this.plugin.addToPlayer(item, this.file.path);
        },
      },
      {
        title: t("wall.ctx.editLayout"),
        icon: "move",
        onPick: () => this.enterEditMode(),
      },
      {
        title: item.rating
          ? t("wall.ctx.rateCurrent", { value: item.rating })
          : t("wall.ctx.rate"),
        icon: "star",
        onPick: () => this.rateItem(item),
      },
    ];
    // 「移动到分组…」走模态选择框（分组一多内联列表就比屏幕还长）
    if ((this.data?.groups ?? []).length) {
      items.push({
        title: t("wall.ctx.moveToGroup"),
        icon: "folder-input",
        onPick: () => this.pickGroupFor(item),
      });
    }
    if (!item.locked) {
      items.push({
        title: t("wall.ctx.editMeta"),
        icon: "edit",
        onPick: () => this.editItemMeta(item, false),
      });
    }
    items.push(
      {
        title: t("wall.ctx.migrate"),
        icon: "arrow-right",
        onPick: () => this.migrateCard(item),
      },
      {
        title: t("wall.ctx.copyLink"),
        icon: "link",
        onPick: () => {
          void navigator.clipboard
            .writeText(`https://music.163.com/album?id=${item.albumId}`)
            .then(() => new Notice(t("common.copied")));
        },
      },
      {
        title: t("wall.ctx.delete"),
        icon: "trash",
        danger: true,
        onPick: () => this.confirmDelete(item),
      }
    );
    return items;
  }

  /** 分组选择框：未分组 + 全部分组，当前所在项标 ✓ 且不可选 */
  private pickGroupFor(item: WallItem): void {
    const groups = this.data?.groups ?? [];
    if (!groups.length) return;
    const current = item.groupId ?? UNGROUPED_ID;
    const targets: { id: string; label: string }[] = [
      { id: UNGROUPED_ID, label: t("wall.group.ungrouped") },
      ...groups.map((g) => ({ id: g.id, label: g.name })),
    ];
    new PickerModal(
      this.app,
      t("wall.pick.moveOne", { name: item.meta.name }),
      targets.map((gt) => ({
        label: gt.label,
        icon: gt.id === current ? "check" : undefined,
        detail:
          gt.id === current
            ? t("wall.pick.currentGroup")
            : t("wall.pick.groupCount", {
                count: this.data!.items.filter(
                  (i) => (i.groupId ?? UNGROUPED_ID) === gt.id
                ).length,
              }),
      })),
      (i) => {
        const target = targets[i];
        if (!target || target.id === current) return;
        this.moveItemToGroup(item, target.id === UNGROUPED_ID ? null : target.id);
      }
    ).open();
  }

  private confirmDelete(item: WallItem): void {
    new ConfirmModal(this.app, {
      title: t("wall.del.title"),
      message: t("wall.del.msg", { name: item.meta.name }),
      details: [t("wall.del.note")],
      danger: true,
      confirmText: t("common.delete"),
      onConfirm: async () => {
        const data = this.data!;
        data.items = data.items.filter((i) => i !== item);
        if (data.order) data.order = removeFromOrder(data.order, [item.albumId]);
        await this.persist();
        this.render();
        new Notice(t("wall.del.deleted", { name: item.meta.name }));
      },
    }).open();
  }

  /** 迁移（移动语义）：选取库内另一面墙作为目标 */
  private migrateCard(item: WallItem): void {
    const files = this.plugin.wallFiles(this.file?.path);
    if (!files.length) {
      new Notice(t("wall.select.noWalls"));
      return;
    }
    new PickerModal(
      this.app,
      t("wall.pick.migrateOne", { name: item.meta.name }),
      files.map((f) => ({
        label: f.basename,
        detail:
          f.parent && f.parent.path !== "/"
            ? f.parent.path
            : t("wall.pick.vaultRoot"),
      })),
      (i) => void this.doMigrate(item, files[i])
    ).open();
  }

  private async doMigrate(item: WallItem, target: TFile): Promise<void> {
    if (!this.data) return;
    const ok = await this.plugin.migrateItemInto(item, target);
    if (!ok) return;
    await this.takeOutItem(item.albumId);
    new Notice(
      t("main.migratedOne", { name: item.meta.name, target: target.basename })
    );
  }

  /** 「添加专辑」入口（工具栏 ＋ / 命令 / 空态按钮）：打开右上角悬浮搜索框 */
  openSearchModal(): void {
    this.floater?.open("add");
  }

  private async renameWall(): Promise<void> {
    if (!this.file) return;
    new InputModal(
      this.app,
      t("wall.rename.title"),
      t("wall.rename.ph"),
      this.file.basename,
      async (name) => {
        try {
          // 保持在原父目录：renameFile 需要完整目标路径，只给文件名会被挪到库根目录
          const parent = this.file!.parent;
          const parentPath = parent && parent.path !== "/" ? `${parent.path}/` : "";
          await this.app.fileManager.renameFile(
            this.file!,
            normalizePath(`${parentPath}${name}.mw`)
          );
          // this.file 与标签标题由 FileView 基类的 rename 处理自动更新；
          // 这里只需同步 .mw 内部的 name 字段并重绘工具栏标题
          if (this.data) {
            this.data.name = name;
            await this.persist();
          }
          this.render();
        } catch (e: any) {
          new Notice(t("wall.rename.fail", { error: e?.message ?? e }));
        }
      }
    ).open();
  }

  private openMoreMenu(evt: MouseEvent): void {
    // 与右键菜单同源：展示架布局要走自绘木菜单，不能绕过 showCtxMenu 直接 new Menu
    // （否则木墙上弹出一个白底主题菜单——审计 A1）
    this.showCtxMenu(evt, [
      {
        title: t("wall.more.export"),
        icon: "download",
        onPick: () => void this.plugin.exportCurrentWall(this),
      },
      {
        title: t("wall.more.import"),
        icon: "upload",
        onPick: () => void this.plugin.importMwFile(this),
      },
      ...(this.plugin.settings.showGitSyncActions ? [
      {
        title: t("gitSync.pullCommand"),
        icon: "download-cloud",
        onPick: () => {
          void this.plugin.gitSync("pull");
        },
      },
      { title: t("gitSync.pushCommand"), icon: "upload-cloud", onPick: () => void this.plugin.gitSync("push") },
      ] : []),
    ]);
  }
}
