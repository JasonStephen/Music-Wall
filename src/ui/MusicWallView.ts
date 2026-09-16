// 音乐墙 FileView：点开 .mw 文件即渲染唱片墙。
// FileView 基类负责 file 绑定/切换/重命名刷标题/导航历史，本类只管加载与渲染。
//
// 顶部栏：固定不随网格滚动 —— 左「墙名 · N 张」，右一排图标钮
// （样式与布局 / 筛选 / 分组 / 排序 / 添加 / 搜索 / ⋯），点图标从右侧滑出面板。
// 网格：按分区分组渲染（分组头可展开收起、重命名、删除、整体拖拽换序）；
// 手动排序：长按唱片或右键「编辑布局」进入编辑态后可直接拖拽唱片换位/跨组。
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
  LAYOUT_LABELS,
  SORT_LABELS,
  WALL_DRAG_MIME,
  WALL_VIEW_TYPE,
  type AlbumMeta,
  type AlbumSummary,
  type DiscStyle,
  type MusicWallData,
  type SortMode,
  type WallItem,
  type WallLayout,
} from "../types";
import { loadWall, saveWall } from "../core/store";
import {
  UNGROUPED_ID,
  UNGROUPED_LABEL,
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
import { ALL_STYLES, STYLE_LABELS, buildDiscElement, makeCoverImg } from "./disc";
import { fmtDur, fmtTotalDur, fmtTotalDurTip, sumTrackDur } from "./duration";
import { AlbumPanelModal } from "./AlbumPanelModal";
import { ConfirmModal } from "./ConfirmModal";
import { EditMetaModal } from "./EditMetaModal";
import { InputModal } from "./InputModal";
import { PickerModal } from "./smallModals";
import { SearchAlbumModal, type WallHost } from "./SearchAlbumModal";
import { SideDrawer, type DrawerKey } from "./SideDrawer";
import { buildLayoutTile, buildStyleTile, firstCover } from "./viewPrefs";
import { openShelfMenu, type ShelfMenuItem } from "./ShelfMenu";

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

/** 长按进入编辑态 / 开始拖拽的阈值 */
const LONG_PRESS_MS = 400;
const LONG_PRESS_MS_TOUCH = 450;
/** 指针移动超过该距离视为滚动/误触，取消长按 */
const LONG_PRESS_SLOP = 6;

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

/** 使卡片居中所需的目标 scrollTop（含边界钳制） */
function gfCenterScrollTop(grid: HTMLElement, card: HTMLElement): number {
  const ch = num((grid as unknown as { clientHeight?: unknown }).clientHeight);
  const sh = num((grid as unknown as { scrollHeight?: unknown }).scrollHeight);
  const gridTop = num(grid.getBoundingClientRect?.()?.top);
  const r = card.getBoundingClientRect?.();
  const cardCenter = num(r?.top) + num(r?.height) / 2 - gridTop;
  const delta = cardCenter - ch / 2;
  const max = Math.max(0, sh - ch);
  return Math.min(max, Math.max(0, num(grid.scrollTop) + delta));
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

/** 拖拽中的载荷（唱片卡片 / 分组头共用一套指针拖拽） */
type DragPayload =
  | { kind: "item"; item: WallItem }
  | { kind: "group"; groupId: string };

type DropTarget =
  | { kind: "item"; target: WallItem; place: Place; groupId: string }
  | { kind: "group"; anchorId: string; place: Place };

export class MusicWallView extends FileView implements WallHost {
  private plugin: MusicWallPlugin;
  private data: MusicWallData | null = null;
  allowNoFile = true;

  // 纯前端搜索词（落盘于 view 之外的会话态：输入即筛，不写文件）
  private q = "";
  private suppressSelf = false;
  /** SMTC 订阅取消函数 */
  private offNow: (() => void) | null = null;

  private drawer: SideDrawer | null = null;
  private searchRow: HTMLElement | null = null;
  private searchInput: HTMLInputElement | null = null;

  /** 布局编辑态（手动排序 / 分组换序） */
  private editMode = false;
  private editSnapshot = "";

  /** 指针拖拽状态 */
  private dragPayload: DragPayload | null = null;
  private dragGhost: HTMLElement | null = null;
  private dragLine: HTMLElement | null = null;
  private dragStart = { x: 0, y: 0 };
  private dragPointerId = -1;
  private dragActive = false;
  private dragTimer = 0;
  private dragCursor: { x: number; y: number } | null = null;
  private dragMoveTimer = 0;
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
    return this.file ? `音乐墙 · ${this.file.basename}` : "音乐墙";
  }
  getIcon(): string {
    return "music";
  }

  /** 框架在绑定新文件后调用：读数据 + 渲染（setState/getState 由 FileView 基类接管） */
  async onLoadFile(file: TFile): Promise<void> {
    try {
      this.data = await loadWall(this.app.vault, file);
    } catch (e: any) {
      new Notice("读取音乐墙失败：" + (e?.message ?? e));
      this.data = null;
    }
    await this.render();
  }

  async onUnloadFile(file: TFile): Promise<void> {
    this.data = null;
  }

  /** 文件被重命名/移动：super 刷新标签页标题，render 刷新视图内工具栏标题 */
  async onRename(file: TFile): Promise<void> {
    await super.onRename(file);
    await this.render();
  }

  async onOpen(): Promise<void> {
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
        new Notice("已退出布局编辑");
        return;
      }
      this.closeShelfDetail();
    });
    // 放置靶点：其他墙拖来的唱片卡片可直接落在本墙上
    this.registerDomEvent(this.contentEl, "dragover", (e: DragEvent) => {
      if (this.editMode) return;
      if (e.dataTransfer?.types.includes(WALL_DRAG_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    });
    this.registerDomEvent(this.contentEl, "drop", (e: DragEvent) => {
      if (this.editMode) return;
      const raw = e.dataTransfer?.getData(WALL_DRAG_MIME);
      if (!raw || !this.file) return;
      e.preventDefault();
      try {
        const p = JSON.parse(raw) as { srcPath: string; albumId: number };
        if (p.srcPath !== this.file.path) {
          void this.plugin.receiveWallDrag(p.srcPath, p.albumId, this.file);
        }
      } catch {
        /* 载荷损坏：忽略 */
      }
    });
    // SMTC：订阅正在播放，命中的唱片高亮（仅 Windows 桌面端会有数据）
    this.offNow = this.plugin.nowPlaying.on((s) => this.applyNowPlaying(s));
    this.register(() => this.offNow?.());
    this.register(() => this.disposeDrag());
    // 无文件（新建/瞬态）时也要有可读的界面，onLoadFile 接管后续渲染
    await this.render();
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

  /** 供设置页/外部触发重绘 */
  refresh(): void {
    void this.render();
  }

  async onClose(): Promise<void> {
    this.drawer?.dispose();
    this.drawer = null;
    this.disposeDrag();
    // registerEvent 随组件自动卸载
  }

  private async reload(): Promise<void> {
    if (!this.file) return;
    try {
      this.data = await loadWall(this.app.vault, this.file);
    } catch (e: any) {
      new Notice("读取音乐墙失败：" + (e?.message ?? e));
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
    if (!this.data) return;
    this.data.items = this.data.items.filter((i) => i.albumId !== albumId);
    if (this.data.order) {
      this.data.order = removeFromOrder(this.data.order, [albumId]);
    }
    await this.persist();
    this.render();
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
  confirmAdd(meta: AlbumMeta, onAdd: () => void): void {
    new AlbumPanelModal(this.app, "add", {
      meta,
      style: this.getStyle(),
      source: "search",
      deps: this.plugin.getPlaybackDeps(),
      onAdd: () => {
        onAdd();
        new Notice(`已添加《${meta.name}》`);
      },
    }).open();
  }
  addAlbum(meta: AlbumMeta, source: "search" | "manual"): void {
    if (!this.data) return;
    if (this.getExistingIds().has(meta.albumId)) {
      new Notice("该专辑已在当前音乐墙中");
      return;
    }
    this.data.items.push({
      albumId: meta.albumId,
      source,
      locked: source === "search",
      meta,
      addedAt: new Date().toISOString(),
      groupId: this.targetGroupId ?? undefined,
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

  private get filtering(): boolean {
    return (
      !!this.q ||
      this.filterArtists.length > 0 ||
      this.filterDecades.length > 0 ||
      this.filterTags.length > 0
    );
  }

  /** 新条目落进哪个分组：分组面板里「选中」的分组；null = 未分组 */
  private targetGroupId: string | null = null;

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
    const root = this.contentEl;
    // 场景动画句柄随 root 重建失效：先令牌失效 + cancel + 复位状态机
    this.resetDetailState();
    // 重建会丢滚动位置（迁移/删除/样式切换等），先记后还
    const prevScroll = root.querySelector<HTMLElement>(".mw-grid")?.scrollTop ?? 0;
    // 抽屉内容随 root 重建，但开合状态要保留（重建后按同一 key 还原）
    const prevDrawer = this.drawer?.currentKey() ?? null;
    this.drawer?.dispose();
    this.drawer = null;
    this.searchRow = null;
    this.searchInput = null;
    this.disposeDrag();

    root.empty();
    root.addClass("mw-view");
    const cap = this.plugin.settings.shelfCaption ?? "pull";
    root.removeClass("mw-shelfcap-hidden", "mw-shelfcap-pull", "mw-shelfcap-always");
    root.addClass(`mw-shelfcap-${cap}`);
    if (!this.data) {
      root.createDiv({ cls: "mw-empty", text: "未选择音乐墙文件" });
      return;
    }

    this.renderToolbar(root);
    const layout = this.data.layout ?? "grid";
    const stage = root.createDiv({ cls: "mw-stage" });
    const grid = stage.createDiv({
      cls:
        layout === "list"
          ? "mw-grid mw-grid--list"
          : layout === "shelf"
            ? "mw-grid mw-grid--shelf"
            : "mw-grid",
    });
    grid.style.setProperty("--mw-min-col", `${this.plugin.settings.minColumnWidth}px`);
    this.renderGrid(grid);
    grid.scrollTop = prevScroll;
    if (layout === "shelf") {
      // 开盒详情 overlay（懒填充）：点唱片推镜放大后绕书脊 3D 翻开
      stage.createDiv({ cls: "mw-shelf-detail" });
    }
    // 抽屉挂在 .mw-stage 上（absolute 覆盖层）：不参与网格滚动，
    // 因此「工具栏与面板固定、只有网格滚动」是结构性保证
    const drawer = this.buildDrawer(stage);
    this.drawer = drawer;
    if (prevDrawer) drawer.open(prevDrawer);
    // 重建后重新施加「正在播放」高亮 + 编辑态提示条
    this.applyNowPlaying(this.plugin.nowPlaying.state);
    if (this.editMode) this.renderEditBar();
  }

  // ---- 顶部工具栏（固定，不随网格滚动） ----

  private renderToolbar(root: HTMLElement): void {
    const bar = root.createDiv({ cls: "mw-toolbar" });

    const left = bar.createDiv({ cls: "mw-toolbar__left" });
    const title = left.createDiv({
      cls: "mw-toolbar__title",
      text: this.file?.basename ?? this.data!.name,
    });
    title.setAttr("title", "点击重命名墙文件名");
    title.addEventListener("click", () => this.renameWall());
    left.createDiv({
      cls: "mw-toolbar__count",
      text: `${this.data!.items.length} 张`,
    });

    const actions = bar.createDiv({ cls: "mw-toolbar__actions" });
    const mkIcon = (
      icon: string,
      label: string,
      onClick: (btn: HTMLButtonElement) => void,
      extraCls = ""
    ) => {
      const btn = actions.createEl("button", {
        cls: extraCls ? `mw-toolbtn ${extraCls}` : "mw-toolbtn",
      });
      btn.setAttr("type", "button");
      btn.setAttr("aria-label", label);
      btn.setAttr("title", label);
      setIcon(btn, icon);
      btn.addEventListener("click", () => onClick(btn));
      return btn;
    };

    const styleBtn = mkIcon("palette", "样式与布局", () => {
      this.drawer?.toggle("style");
    });
    const filterBtn = mkIcon("filter", "筛选", () => {
      this.drawer?.toggle("filter");
    });
    const groupBtn = mkIcon("folder-tree", "分组", () => {
      this.drawer?.toggle("group");
    });
    const sortBtn = mkIcon("arrow-up-down", "排序", () => {
      this.drawer?.toggle("sort");
    });
    mkIcon(
      "plus",
      "添加专辑",
      () => this.openSearchModal(),
      "mw-toolbtn--primary"
    );
    const searchBtn = mkIcon("search", "搜索本墙专辑", () => this.toggleSearch());
    const moreBtn = mkIcon("more-horizontal", "更多操作", (btn) => {
      const rect = btn.getBoundingClientRect();
      this.openMoreMenu({ x: rect.left, y: rect.bottom + 4 } as MouseEvent);
    });

    // 搜索行：绝对定位在工具栏之下，不推挤网格、不随滚动
    const row = root.createDiv({ cls: "mw-searchrow" });
    const input = row.createEl("input", {
      type: "search",
      placeholder: "搜索本墙专辑（专辑名 / 艺术家 / 标签）…",
      cls: "mw-searchrow__input",
    });
    input.value = this.q;
    input.addEventListener("input", () => {
      this.q = input.value;
      searchBtn.toggleClass("is-active", !!this.q);
      this.rerenderGrid();
    });
    input.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Escape") {
        e.stopPropagation();
        this.toggleSearch(false);
      }
    });
    const closeRow = row.createEl("button", { cls: "mw-searchrow__close" });
    closeRow.setAttr("type", "button");
    closeRow.setAttr("aria-label", "收起搜索");
    closeRow.setAttr("title", "收起 (Esc)");
    setIcon(closeRow, "x");
    closeRow.addEventListener("click", () => this.toggleSearch(false));
    this.searchRow = row;
    this.searchInput = input;

    // 抽屉开合 → 图标激活态同步
    this.drawerState = { styleBtn, filterBtn, groupBtn, sortBtn, searchBtn, moreBtn };
    this.syncToolbarState();
  }

  private drawerState: {
    styleBtn?: HTMLButtonElement;
    filterBtn?: HTMLButtonElement;
    groupBtn?: HTMLButtonElement;
    sortBtn?: HTMLButtonElement;
    searchBtn?: HTMLButtonElement;
    moreBtn?: HTMLButtonElement;
  } = {};

  private syncToolbarState(): void {
    const key = this.drawer?.currentKey() ?? null;
    const s = this.drawerState;
    s.styleBtn?.toggleClass("is-active", key === "style");
    s.filterBtn?.toggleClass("is-active", key === "filter" || this.filtering);
    s.groupBtn?.toggleClass("is-active", key === "group");
    s.sortBtn?.toggleClass("is-active", key === "sort");
    s.searchBtn?.toggleClass("is-active", !!this.q || key === "search");
    s.moreBtn?.removeClass("is-active");
  }

  /** 搜索行展开/收起（展开时聚焦并把光标放到末尾） */
  private toggleSearch(force?: boolean): void {
    const open = force ?? !this.searchRow?.hasClass("is-open");
    this.searchRow?.toggleClass("is-open", open);
    this.syncToolbarState();
    if (open) {
      const el = this.searchInput;
      if (el) {
        window.setTimeout(() => {
          el.focus();
          try {
            el.setSelectionRange(el.value.length, el.value.length);
          } catch {
            /* 某些环境不支持 selection 操作 */
          }
        }, 0);
      }
    }
  }

  // ---- 抽屉（右侧滑出面板） ----

  private buildDrawer(stage: HTMLElement): SideDrawer {
    const drawer = new SideDrawer(stage, () => {
      this.syncToolbarState();
      if (this.editMode) this.renderEditBar();
    });
    drawer.register("style", "样式与布局", (body) => this.panelStyle(body));
    drawer.register("filter", "筛选", (body, api) => this.panelFilter(body, api));
    drawer.register("group", "分组", (body) => this.panelGroup(body));
    drawer.register("sort", "排序", (body, api) => this.panelSort(body, api));
    drawer.register("search", "搜索", (body, api) => this.panelSearch(body, api));
    drawer.register("settings", "设置", (body) => this.panelSettings(body));
    return drawer;
  }

  /** 样式与布局面板：四种唱片样式（真实缩略预览）+ 三种布局 */
  private panelStyle(body: HTMLElement): void {
    const cover = firstCover(this.data!.items);
    const secStyle = body.createDiv({ cls: "mw-panel__section" });
    secStyle.createDiv({ cls: "mw-panel__label", text: "唱片样式" });
    const grid = secStyle.createDiv({ cls: "mw-preset-grid" });
    for (const s of ALL_STYLES) {
      grid.appendChild(
        buildStyleTile(s, STYLE_LABELS[s], cover, this.data!.style === s, (picked) => {
          this.data!.style = picked;
          void this.commit();
        })
      );
    }

    const secLayout = body.createDiv({ cls: "mw-panel__section" });
    secLayout.createDiv({ cls: "mw-panel__label", text: "布局" });
    const layouts = secLayout.createDiv({ cls: "mw-preset-grid mw-preset-grid--3" });
    const current = this.data!.layout ?? "grid";
    for (const l of ["grid", "list", "shelf"] as WallLayout[]) {
      layouts.appendChild(
        buildLayoutTile(l, LAYOUT_LABELS[l], current === l, (picked) => {
          this.data!.layout = picked === "grid" ? undefined : picked;
          void this.commit();
        })
      );
    }
    body.createDiv({
      cls: "mw-panel__hint",
      text: "列表布局统一用封面缩略图；唱片样式在网格与展示架下生效。",
    });
  }

  /** 筛选面板：搜索 + 多选艺术家/年代/标签（同维度 OR，维度间 AND） */
  private panelFilter(body: HTMLElement, api: { refresh(): void }): void {
    const items = this.data!.items;

    const searchSec = body.createDiv({ cls: "mw-panel__section" });
    searchSec.createDiv({ cls: "mw-panel__label", text: "关键词" });
    const input = searchSec.createEl("input", {
      type: "search",
      cls: "mw-panel__input",
      placeholder: "专辑名 / 艺术家 / 标签…",
    });
    input.value = this.q;
    input.addEventListener("input", () => {
      this.q = input.value;
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
        text: "清除",
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
      "艺术家",
      uniq((i) => i.meta.artist),
      this.filterArtists,
      (next) => {
        if (next.length) view.filterArtists = next;
        else delete view.filterArtists;
        void this.persist();
      }
    );
    facet(
      "年代",
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
      "标签",
      [...tagOptions.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh")),
      this.filterTags,
      (next) => {
        if (next.length) view.filterTags = next;
        else delete view.filterTags;
        void this.persist();
      }
    );

    if (this.filtering) {
      const reset = body.createEl("button", {
        cls: "mw-btn mw-panel__reset",
        text: "清除全部筛选",
      });
      reset.setAttr("type", "button");
      reset.addEventListener("click", () => {
        this.q = "";
        delete view.filterArtists;
        delete view.filterDecades;
        delete view.filterTags;
        void this.persist();
        this.render();
      });
    }
  }

  /** 分组面板：新建 / 重命名 / 删除 / 收起 / 拖拽换序 */
  private panelGroup(body: HTMLElement): void {
    const groups = this.data!.groups ?? [];
    const addRow = body.createDiv({ cls: "mw-panel__section" });
    const addBtn = addRow.createEl("button", {
      cls: "mw-btn mw-btn--primary mw-panel__add",
      text: "＋ 新建分组",
    });
    addBtn.setAttr("type", "button");
    addBtn.addEventListener("click", () => this.createGroup());

    if (!groups.length) {
      body.createDiv({
        cls: "mw-panel__hint",
        text: "还没有分组。新建后唱片墙会按分组分区显示：分组可展开收起、重命名、拖动换序，删除分组会连同组内唱片一起删除。",
      });
      this.panelGroupTarget(body);
      return;
    }

    const list = body.createDiv({ cls: "mw-panel__list mw-grouplist" });
    for (const g of groups) {
      const count = this.data!.items.filter((i) => i.groupId === g.id).length;
      const row = list.createDiv({ cls: "mw-grouplist__row" });
      row.dataset.mwGroupRow = g.id;

      const handle = row.createEl("button", { cls: "mw-grouplist__handle" });
      handle.setAttr("type", "button");
      handle.setAttr("aria-label", `拖动排序：${g.name}`);
      handle.setAttr("title", "按住拖到其他分组位置");
      setIcon(handle, "grip-vertical");
      this.wireGroupHandle(handle, g.id);

      const name = row.createSpan({ cls: "mw-grouplist__name", text: g.name });
      name.setAttr("title", "双击重命名");
      name.addEventListener("dblclick", () => this.renameGroup(g.id));
      row.createSpan({ cls: "mw-grouplist__count", text: `${count} 张` });

      const eye = row.createEl("button", { cls: "mw-grouplist__btn" });
      eye.setAttr("type", "button");
      const collapsed = !!g.collapsed;
      eye.setAttr("aria-label", collapsed ? "展开分组" : "收起分组");
      eye.setAttr("title", collapsed ? "展开" : "收起");
      setIcon(eye, collapsed ? "chevron-right" : "chevron-down");
      eye.addEventListener("click", () => this.toggleGroup(g.id));

      const ren = row.createEl("button", { cls: "mw-grouplist__btn" });
      ren.setAttr("type", "button");
      ren.setAttr("aria-label", "重命名分组");
      ren.setAttr("title", "重命名");
      setIcon(ren, "pencil");
      ren.addEventListener("click", () => this.renameGroup(g.id));

      const del = row.createEl("button", {
        cls: "mw-grouplist__btn mw-grouplist__btn--danger",
      });
      del.setAttr("type", "button");
      del.setAttr("aria-label", "删除分组");
      del.setAttr("title", "删除分组");
      setIcon(del, "trash");
      del.addEventListener("click", () => this.confirmDeleteGroup(g.id));
    }
    this.panelGroupTarget(body);
  }

  /** 「新唱片加入哪个分组」选择：避免建了新分组还要手动拖进去 */
  private panelGroupTarget(body: HTMLElement): void {
    const groups = this.data!.groups ?? [];
    if (!groups.length) return;
    const sec = body.createDiv({ cls: "mw-panel__section" });
    sec.createDiv({ cls: "mw-panel__label", text: "新添加的专辑放入" });
    const list = sec.createDiv({ cls: "mw-panel__list" });
    const options: { id: string | null; label: string }[] = [
      { id: null, label: UNGROUPED_LABEL },
      ...groups.map((g) => ({ id: g.id, label: g.name })),
    ];
    for (const opt of options) {
      const row = list.createEl("label", { cls: "mw-check" });
      const radio = row.createEl("input", { type: "radio", cls: "mw-check__box" });
      radio.name = "mw-group-target";
      radio.checked = this.targetGroupId === opt.id;
      radio.addEventListener("change", () => {
        this.targetGroupId = opt.id;
      });
      row.createSpan({ cls: "mw-check__text", text: opt.label });
    }
  }

  /** 排序面板：类型单选 + 独立的升/降序按钮 */
  private panelSort(body: HTMLElement, api: { refresh(): void }): void {
    const sec = body.createDiv({ cls: "mw-panel__section" });
    sec.createDiv({ cls: "mw-panel__label", text: "排序类型" });
    const list = sec.createDiv({ cls: "mw-panel__list" });
    for (const k of Object.keys(SORT_LABELS) as SortMode[]) {
      const row = list.createEl("label", { cls: "mw-check" });
      const radio = row.createEl("input", { type: "radio", cls: "mw-check__box" });
      radio.name = "mw-sort-mode";
      radio.checked = this.sortMode === k;
      radio.addEventListener("change", () => this.setSort(k));
      row.createSpan({ cls: "mw-check__text", text: SORT_LABELS[k] });
      if (k === "manual") {
        row.createSpan({ cls: "mw-check__count", text: "可拖动" });
      }
    }

    // 升降序与排序类型彻底解耦：独立一排按钮
    const dirSec = body.createDiv({ cls: "mw-panel__section" });
    dirSec.createDiv({ cls: "mw-panel__label", text: "顺序" });
    const dirs = dirSec.createDiv({ cls: "mw-dirbtns" });
    const mkDir = (asc: boolean, icon: string, text: string) => {
      const btn = dirs.createEl("button", { cls: "mw-btn mw-dirbtn", text });
      btn.setAttr("type", "button");
      btn.toggleClass("is-active", this.sortAsc === asc);
      setIcon(btn, icon);
      btn.addEventListener("click", () => this.setSortAsc(asc));
      return btn;
    };
    mkDir(true, "arrow-up", "升序");
    mkDir(false, "arrow-down", "降序");

    const secEdit = body.createDiv({ cls: "mw-panel__section" });
    const editBtn = secEdit.createEl("button", {
      cls: "mw-btn mw-panel__add",
      text: this.editMode ? "退出布局编辑" : "调整顺序（编辑布局）",
    });
    editBtn.setAttr("type", "button");
    editBtn.addEventListener("click", () => {
      if (this.editMode) this.exitEditMode();
      else this.enterEditMode();
      api.refresh();
    });
    body.createDiv({
      cls: "mw-panel__hint",
      text:
        this.sortMode === "manual"
          ? "当前为手动排序：长按唱片或分组头即可拖动，按「完成」保存、「取消」还原。"
          : "选择「手动排序」后可用拖动的方式排列唱片；也可以随时点上面的按钮进入编辑布局。",
    });
  }

  /** 搜索面板：与搜索行等价的内联输入（供面板入口使用） */
  private panelSearch(body: HTMLElement, api: { refresh(): void }): void {
    const sec = body.createDiv({ cls: "mw-panel__section" });
    sec.createDiv({ cls: "mw-panel__label", text: "搜索本墙" });
    const input = sec.createEl("input", {
      type: "search",
      cls: "mw-panel__input",
      placeholder: "专辑名 / 艺术家 / 标签…",
    });
    input.value = this.q;
    input.addEventListener("input", () => {
      this.q = input.value;
      this.syncToolbarState();
      this.rerenderGrid();
    });
    const reset = sec.createEl("button", { cls: "mw-btn mw-panel__reset", text: "清空" });
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
      text: "打开插件设置",
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
    body.createDiv({
      cls: "mw-panel__hint",
      text: "列宽、展示架文字档位、Cookie、播放歌单、SMTC 等全局项在插件设置里。",
    });
  }

  // ---- 分组操作 ----

  private createGroup(): void {
    new InputModal(this.app, "新建分组", "分组名称", "", (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const data = this.data!;
      if (!data.groups) data.groups = [];
      const id = newGroupId(data.groups);
      data.groups.push({ id, name: trimmed });
      this.targetGroupId = id;
      void this.commit(`已新建分组「${trimmed}」`);
    }).open();
  }

  private renameGroup(id: string): void {
    const group = this.data?.groups?.find((g) => g.id === id);
    if (!group) return;
    new InputModal(this.app, "重命名分组", "新的分组名称", group.name, (name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      group.name = trimmed;
      void this.commit(`分组已重命名为「${trimmed}」`);
    }).open();
  }

  /** 展开/收起：局部重建该分区，不整页重绘（避免闪白与滚动跳动） */
  private toggleGroup(id: string): void {
    const data = this.data!;
    const group = data.groups?.find((g) => g.id === id);
    if (!group) return;
    group.collapsed = !group.collapsed;
    void this.persist();
    this.rerenderGrid();
    if (this.drawer?.currentKey() === "group") this.drawer.refresh();
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
      if (this.targetGroupId === id) this.targetGroupId = null;
      void this.commit(
        members.length
          ? `已删除分组「${group.name}」及其 ${members.length} 张专辑`
          : `已删除分组「${group.name}」`
      );
    };

    if (!members.length) {
      // 空分组：普通二次确认即可
      new ConfirmModal(this.app, {
        title: "删除空分组",
        message: `确定删除分组「${group.name}」吗？`,
        details: ["该分组里没有唱片，删除后不可恢复。"],
        danger: true,
        confirmText: "删除分组",
        onConfirm: doDelete,
      }).open();
      return;
    }
    // 非空分组：必须输入分组名确认（连同组内唱片一起删除）
    const list = members.slice(0, 8).map((m) => m.meta.name);
    if (members.length > 8) list.push(`等共 ${members.length} 张…`);
    new ConfirmModal(this.app, {
      title: "删除分组",
      message: `分组「${group.name}」中还有 ${members.length} 张专辑，删除分组会连同它们一起从这面音乐墙移出。`,
      details: list,
      danger: true,
      confirmText: "删除分组及其唱片",
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
        text: data.items.length ? "没有符合筛选条件的专辑" : "这面墙还是空的",
        cls: "mw-empty__title",
      });
      if (!data.items.length) {
        empty.createDiv({
          text: "「＋」会搜索网易云专辑并抓取完整元数据；顶部图标可切换四种唱片样式与网格/列表/展示架布局，也可以先建几个分组。",
          cls: "mw-empty__sub",
        });
        const actions = empty.createDiv({ cls: "mw-empty__actions" });
        actions
          .createEl("button", { cls: "mw-btn mw-btn--primary", text: "＋ 添加" })
          .addEventListener("click", () => this.openSearchModal());
      } else {
        empty
          .createEl("button", { cls: "mw-btn", text: "清除筛选" })
          .addEventListener("click", () => {
            this.q = "";
            const view = this.ensureView();
            delete view.filterArtists;
            delete view.filterDecades;
            delete view.filterTags;
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
      this.filtering
    );
    for (const section of sections) this.buildSection(grid, section, data.groups ?? []);

    // 展示架：滚动或点空白即收起所有抽出卡（grid 每次渲染重建，监听随元素回收）
    if ((data.layout ?? "grid") === "shelf") {
      grid.addEventListener("scroll", () => this.retractAllShelf());
      grid.addEventListener("click", (e) => {
        if (!(e.target as HTMLElement | null)?.closest(".mw-shelf-card")) {
          this.retractAllShelf();
        }
      });
    }
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
      const chev = head.createEl("button", { cls: "mw-section__chevron" });
      chev.setAttr("type", "button");
      chev.setAttr(
        "aria-label",
        section.collapsed ? `展开分组 ${section.name}` : `收起分组 ${section.name}`
      );
      chev.setAttr("title", section.collapsed ? "展开" : "收起");
      setIcon(chev, section.collapsed ? "chevron-right" : "chevron-down");
      chev.addEventListener("click", (e) => {
        e.stopPropagation();
        this.toggleGroup(section.id);
      });

      const title = head.createSpan({ cls: "mw-section__title", text: section.name });
      title.setAttr("title", "双击重命名分组");
      title.addEventListener("dblclick", () => this.renameGroup(section.id));
      head.createSpan({
        cls: "mw-section__count",
        text: `${section.items.length} 张`,
      });

      const actions = head.createDiv({ cls: "mw-section__actions" });
      const mkAct = (icon: string, label: string, fn: () => void, danger = false) => {
        const b = actions.createEl("button", {
          cls: danger ? "mw-section__btn mw-section__btn--danger" : "mw-section__btn",
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
        mkAct("pencil", "重命名分组", () => this.renameGroup(section.id));
        mkAct("trash", "删除分组", () => this.confirmDeleteGroup(section.id), true);
      }
      // 分组头整体可拖（编辑态 / 长按）
      this.wireGroupDrag(head, section.id);
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
    card.appendChild(buildDiscElement(item, style, { coverSize: 300 }));
    card.appendChild(this.makeMenuButton(item));
    card.appendChild(this.makeDelButton(item));
    this.wireDraggable(card, item);
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
    artistEl.textContent = item.meta.artist || "未知艺术家";
    cap.appendChild(artistEl);
    if (item.meta.year) {
      const yearEl = document.createElement("div");
      yearEl.className = "mw-card__sub mw-card__year";
      yearEl.textContent = `发行于 ${item.meta.year}`;
      cap.appendChild(yearEl);
    }
    card.appendChild(cap);

    card.addEventListener("click", () => {
      if (this.editMode) return; // 编辑布局时不弹详情
      this.openPlayModal(item);
    });
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openCardMenu(e as MouseEvent, item);
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

  /** 长按标志：触屏长按唤出菜单后抑制同次 click */
  private longPressFired = false;

  /** 展示架卡片：木板上平放封套，hover/首触抽出（聚光灯照亮），点击进场景详情，右键/长按菜单 */
  private buildShelfCard(item: WallItem): HTMLElement {
    const card = document.createElement("div");
    card.className = "mw-card mw-shelf-card";
    card.dataset.mwAlbum = String(item.albumId);
    if (item.groupId) card.dataset.mwGroup = item.groupId;

    const slot = document.createElement("div");
    slot.className = "mw-shelf-slot";
    const jacket = document.createElement("div");
    jacket.className = "mw-shelf-jacket";
    jacket.appendChild(makeCoverImg(sizedCover(item.meta.cover, 300), item.meta.name));
    slot.appendChild(jacket);
    card.appendChild(slot);

    const cap = document.createElement("div");
    cap.className = "mw-shelf-cap";
    const name = document.createElement("div");
    name.className = "mw-shelf-cap__name";
    name.textContent = item.meta.name;
    name.title = item.meta.name;
    const artist = document.createElement("div");
    artist.className = "mw-shelf-cap__artist";
    artist.textContent = item.meta.artist || "未知艺术家";
    cap.append(name, artist);
    card.appendChild(cap);

    // 触屏长按 450ms 唤出菜单；滚动（pointercancel）自动取消。
    // 长按同时也是「进入布局编辑并拖拽」的手势，因此已进入长按/拖拽流程时不再弹菜单。
    let pressTimer = 0;
    card.addEventListener("pointerdown", (e) => {
      if (!this.touchMode || this.editMode) return;
      const pe = e as PointerEvent;
      const x = pe.clientX;
      const y = pe.clientY;
      pressTimer = window.setTimeout(() => {
        pressTimer = 0;
        if (this.dragActive) return;
        this.longPressFired = true;
        this.openShelfCardMenu(x, y, item);
      }, LONG_PRESS_MS_TOUCH);
    });
    const cancelPress = () => {
      if (pressTimer) window.clearTimeout(pressTimer);
      pressTimer = 0;
    };
    card.addEventListener("pointerup", cancelPress);
    card.addEventListener("pointercancel", cancelPress);
    card.addEventListener("pointerleave", cancelPress);

    card.addEventListener("click", () => {
      if (this.editMode) return; // 编辑布局时不进详情
      if (this.longPressFired) {
        this.longPressFired = false;
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
      e.preventDefault();
      cancelPress();
      this.openShelfCardMenu((e as MouseEvent).x, (e as MouseEvent).y, item);
    });
    this.wireDraggable(card, item);
    this.wireCardReorder(card, item);
    return card;
  }

  /** 列表模式行：封面 + 三行文字（专辑名/艺术家/年份）+ 操作钮 */
  private buildListRow(item: WallItem): HTMLElement {
    const row = document.createElement("div");
    row.className = "mw-row";
    row.dataset.mwAlbum = String(item.albumId);
    if (item.groupId) row.dataset.mwGroup = item.groupId;

    const thumb = document.createElement("img");
    thumb.className = "mw-row__thumb";
    thumb.loading = "lazy";
    thumb.alt = item.meta.name;
    thumb.addEventListener("error", () => (thumb.style.visibility = "hidden"));
    thumb.src = sizedCover(item.meta.cover, 200);

    const info = document.createElement("div");
    info.className = "mw-row__info";
    const name = document.createElement("div");
    name.className = "mw-card__name";
    name.textContent = item.meta.name;
    name.title = item.meta.name;
    const artist = document.createElement("div");
    artist.className = "mw-card__sub";
    artist.textContent = item.meta.artist || "未知艺术家";
    const year = document.createElement("div");
    year.className = "mw-card__sub mw-card__year";
    year.textContent = item.meta.year ? `发行于 ${item.meta.year}` : "";
    info.append(name, artist, year);

    const actions = document.createElement("div");
    actions.className = "mw-row__actions";
    actions.append(this.makeMenuButton(item), this.makeDelButton(item));

    row.append(thumb, info, actions);
    this.wireDraggable(row, item);
    this.wireCardReorder(row, item);
    row.addEventListener("click", () => {
      if (this.editMode) return;
      this.openPlayModal(item);
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openCardMenu(e as MouseEvent, item);
    });
    return row;
  }

  /** ✕ 快捷删除钮（网格悬停浮层 / 列表行内共用） */
  private makeDelButton(item: WallItem): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "mw-iconbtn mw-iconbtn--del";
    btn.textContent = "✕";
    btn.title = "移出音乐墙";
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
    btn.title = "更多操作";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = btn.getBoundingClientRect();
      this.openCardMenu({ x: rect.left, y: rect.bottom + 4 } as MouseEvent, item);
    });
    return btn;
  }

  /**
   * 拖出迁移：自定义 MIME 载荷 = 源墙路径 + 专辑 ID。
   * 常驻 draggable 会让 Windows Chromium 把右键当右键拖拽吞掉 contextmenu，
   * 故仅左键按下时临时启用，dragend 复位。
   * 编辑布局时禁用：此时拖拽语义是「本墙内换位」，两套拖拽不能同时开。
   */
  private wireDraggable(root: HTMLElement, item: WallItem): void {
    root.addEventListener("pointerdown", (e) => {
      if (this.editMode) {
        root.draggable = false;
        return;
      }
      root.draggable = (e as PointerEvent).button === 0;
    });
    root.addEventListener("dragend", () => {
      root.draggable = false;
    });
    root.addEventListener("dragstart", (e) => {
      if (this.editMode) return;
      const de = e as DragEvent;
      if (!de.dataTransfer || !this.file) return;
      de.dataTransfer.setData(
        WALL_DRAG_MIME,
        JSON.stringify({ srcPath: this.file.path, albumId: item.albumId })
      );
      de.dataTransfer.effectAllowed = "copyMove";
    });
  }

  // ---- 布局编辑（手动排序 / 分组换序） ----

  /** 长按进入编辑态：鼠标 400ms / 触屏 450ms；移动超过阈值视为滚动，取消 */
  private wireCardReorder(el: HTMLElement, item: WallItem): void {
    el.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      if (pe.button !== 0 && pe.pointerType === "mouse") return;
      if (this.editMode) {
        this.beginDrag(pe, { kind: "item", item }, el);
        return;
      }
      this.armLongPress(pe, { kind: "item", item }, el);
    });
  }

  private wireGroupDrag(head: HTMLElement, groupId: string): void {
    head.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      if (pe.button !== 0 && pe.pointerType === "mouse") return;
      if (this.editMode) {
        this.beginDrag(pe, { kind: "group", groupId }, head, true);
        return;
      }
      this.armLongPress(pe, { kind: "group", groupId }, head, true);
    });
  }

  /** 面板里的分组拖拽手柄（不需要长按，手柄本身就是拖拽语义） */
  private wireGroupHandle(handle: HTMLElement, groupId: string): void {
    handle.addEventListener("pointerdown", (e) => {
      const pe = e as PointerEvent;
      if (pe.button !== 0 && pe.pointerType === "mouse") return;
      // 手柄拖拽：把目标投到网格上的分组头，因此允许不在编辑态
      this.beginDrag(pe, { kind: "group", groupId }, handle);
    });
  }

  private armLongPress(
    pe: PointerEvent,
    payload: DragPayload,
    el: HTMLElement,
    isHead = false
  ): void {
    this.clearLongPress();
    this.dragStart = { x: pe.clientX, y: pe.clientY };
    this.dragPointerId = pe.pointerId;
    const target = { payload, el, isHead };
    const move = (ev: PointerEvent) => {
      const dx = Math.abs(ev.clientX - this.dragStart.x);
      const dy = Math.abs(ev.clientY - this.dragStart.y);
      if (dx > LONG_PRESS_SLOP || dy > LONG_PRESS_SLOP) {
        cancel(); // 视为滚动/误触
      }
    };
    const up = () => cancel();
    // 注意：这里只做「拆监听 + 清计时器」，不能回调 clearLongPress（会自引用递归）
    const cancel = () => {
      if (this.dragTimer) window.clearTimeout(this.dragTimer);
      this.dragTimer = 0;
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      if (this.armCancel === cancel) this.armCancel = null;
    };
    // 记住取消函数：视图重建/卸载时也要拆掉这两个 window 监听，否则会残留
    this.armCancel = cancel;
    window.addEventListener("pointermove", move, true);
    const delay = pe.pointerType === "touch" ? LONG_PRESS_MS_TOUCH : LONG_PRESS_MS;
    this.dragTimer = window.setTimeout(() => {
      this.dragTimer = 0;
      cancel();
      if (!this.editMode) {
        this.enterEditMode();
        new Notice("已进入布局编辑：拖动唱片调整顺序，按「完成」保存");
      }
      // 长按已成立：直接开始拖动（沿用同一个指针）
      this.beginDrag(
        {
          pointerId: this.dragPointerId,
          clientX: this.dragStart.x,
          clientY: this.dragStart.y,
        } as PointerEvent,
        target.payload,
        target.el,
        target.isHead
      );
    }, delay);
    window.addEventListener("pointerup", up, true);
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
      this.dragLine = this.contentEl.createDiv({ cls: "mw-drop-line" });
    }
    return this.dragLine;
  }

  private beginDrag(
    pe: PointerEvent,
    payload: DragPayload,
    el: HTMLElement,
    isHead = false
  ): void {
    if (this.dragActive) return;
    this.dragActive = true;
    this.dragPayload = payload;
    this.dragCursor = { x: pe.clientX, y: pe.clientY };
    this.longPressFired = true; // 抑制随后的 click
    el.addClass("is-dragging");
    el.setAttribute("draggable", "false");
    // 刻意不做 setPointerCapture：指针被捕获后 Chromium 会把 pointerup/pointermove
    // 重定向到捕获元素，document 上的监听可能整段收不到（实测 window 能收到、
    // document 收不到）。拖拽的自有监听统一挂 window，命中判定走 elementFromPoint，
    // 不依赖捕获也不会丢事件。
    const ghost = this.contentEl.createDiv({ cls: "mw-drag-ghost" });
    const label =
      payload.kind === "group"
        ? (this.data?.groups?.find((g) => g.id === payload.groupId)?.name ?? "分组")
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
  }

  private positionGhost(x: number, y: number): void {
    if (!this.dragGhost) return;
    this.dragGhost.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
  }

  private handleDragMove(e: PointerEvent): void {
    if (!this.dragActive) return;
    e.preventDefault();
    this.dragCursor = { x: e.clientX, y: e.clientY };
    this.positionGhost(e.clientX, e.clientY);
    if (this.dragMoveTimer) return;
    this.dragMoveTimer = window.setTimeout(() => {
      this.dragMoveTimer = 0;
      this.updateDropHint();
    }, 32);
  }

  private handleDragUp(e: PointerEvent): void {
    if (!this.dragActive) return;
    const payload = this.dragPayload;
    const cursor = this.dragCursor ?? { x: e.clientX, y: e.clientY };
    const target = this.resolveDrop(cursor.x, cursor.y);
    // 无论是否命中落点都必须先收拾拖拽现场：原地松手（落点为空）时若提早 return，
    // dragActive 会一直挂着，之后所有拖动都会被 beginDrag 的守卫挡掉。
    this.disposeDrag();
    if (payload && target) this.commitDrop(payload, target);
  }

  private disposeDrag(): void {
    this.clearLongPress();
    if (this.dragMoveTimer) window.clearTimeout(this.dragMoveTimer);
    this.dragMoveTimer = 0;
    window.removeEventListener("pointermove", this.onDragMove, true);
    window.removeEventListener("pointerup", this.onDragUp, true);
    window.removeEventListener("pointercancel", this.onDragUp, true);
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

    if (payload.kind === "item") {
      const section = hit.closest<HTMLElement>(".mw-section");
      if (!section) return null;
      const groupId = section.dataset.mwGroup ?? UNGROUPED_ID;
      const card = hit.closest<HTMLElement>("[data-mw-album]");
      if (card) {
        const albumId = Number(card.dataset.mwAlbum);
        const item = this.data?.items.find((i) => i.albumId === albumId);
        if (!item || item.albumId === payload.item.albumId) return null;
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
      // 落在分区空白处：追加到该分区末尾
      const cards = section.querySelectorAll<HTMLElement>("[data-mw-album]");
      const last = cards.length ? cards[cards.length - 1] : null;
      if (!last) return { kind: "item", target: payload.item, place: "after", groupId };
      const albumId = Number(last.dataset.mwAlbum);
      const item = this.data?.items.find((i) => i.albumId === albumId);
      if (!item) return null;
      return { kind: "item", target: item, place: "after", groupId };
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

  /** 拖动中的落点提示（横线 + 目标高亮） */
  private updateDropHint(): void {
    if (!this.dragPayload || !this.dragCursor) return;
    const target = this.resolveDrop(this.dragCursor.x, this.dragCursor.y);
    this.contentEl
      .querySelectorAll(".is-drop-target")
      .forEach((el) => el.removeClass("is-drop-target"));
    if (!target) {
      this.dragLine?.removeClass("is-visible");
      return;
    }
    const line = this.dropLine;
    line.addClass("is-visible");
    if (target.kind === "item") {
      const card = this.contentEl.querySelector<HTMLElement>(
        `[data-mw-album="${target.target.albumId}"]`
      );
      if (!card) {
        line.removeClass("is-visible");
        return;
      }
      card.addClass("is-drop-target");
      const r = card.getBoundingClientRect();
      const host = this.contentEl.getBoundingClientRect();
      if (this.isListLayout()) {
        // 列表：横向分隔线
        const top = (target.place === "before" ? r.top : r.bottom) - host.top;
        line.addClass("is-horizontal");
        line.style.left = `${r.left - host.left}px`;
        line.style.top = `${top}px`;
        line.style.width = `${r.width}px`;
        line.style.height = "";
        line.style.transform = "";
      } else {
        const left = (target.place === "before" ? r.left : r.right) - host.left;
        line.removeClass("is-horizontal");
        line.style.left = `${left}px`;
        line.style.top = `${r.top - host.top}px`;
        line.style.height = `${r.height}px`;
        line.style.width = "";
        line.style.transform = "translateX(-50%)";
      }
    } else {
      const head = this.contentEl.querySelector<HTMLElement>(
        `.mw-section[data-mw-group="${target.anchorId}"] .mw-section__head`
      );
      if (!head) {
        line.removeClass("is-visible");
        return;
      }
      const r = head.getBoundingClientRect();
      const host = this.contentEl.getBoundingClientRect();
      const top = (target.place === "before" ? r.top : r.bottom) - host.top;
      line.addClass("is-horizontal");
      line.style.left = `${r.left - host.left}px`;
      line.style.width = `${r.width}px`;
      line.style.top = `${top}px`;
      line.style.height = "";
      line.style.transform = "";
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
      void this.commit("分组顺序已更新");
      return;
    }

    // 唱片：卡片落点（同组换位 / 跨组改组）或面板手柄拖到分组头（追加进目标分组末尾）
    if (target.kind !== "item") return;
    const item = payload.item;
    if (item.albumId === target.target.albumId) return;
    const order = this.ensureOrder();
    const fromGroup = item.groupId ?? UNGROUPED_ID;
    if (fromGroup === target.groupId) {
      data.order = moveWithin(order, item.albumId, target.target.albumId, target.place);
      void this.commit("顺序已更新");
      return;
    }
    if (target.groupId === UNGROUPED_ID) delete item.groupId;
    else item.groupId = target.groupId;
    data.order = moveInto(order, [item.albumId], target.target.albumId, target.place);
    void this.commit("已移动到分组");
  }

  // ---- 编辑态 ----

  /**
   * 进入编辑态。刻意「不整页重绘」：长按手势此刻正在拖同一张卡片，
   * render() 会把卡片与拖拽浮标一起换掉（旧节点成孤儿），拖动随之失效。
   * 这里只切状态 + 挂类名 + 插操作条，DOM 结构保持不变。
   */
  private enterEditMode(): void {
    if (this.editMode || !this.data) return;
    this.editSnapshot = JSON.stringify(this.data);
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

  private exitEditMode(revert = false): void {
    if (!this.editMode && !revert) return;
    this.disposeDrag();
    if (revert && this.editSnapshot && this.data) {
      try {
        this.data = JSON.parse(this.editSnapshot) as MusicWallData;
      } catch {
        /* 快照损坏：保持现状 */
      }
      void this.persist();
    }
    this.editMode = false;
    this.editSnapshot = "";
    this.contentEl.removeClass("mw-edit-layout");
    this.contentEl.querySelector(".mw-editbar")?.remove();
    this.render();
  }

  /** 编辑态的操作条（工具栏下沿 + 右下角完成/取消） */
  private renderEditBar(): void {
    this.contentEl.querySelector(".mw-editbar")?.remove();
    const bar = this.contentEl.createDiv({ cls: "mw-editbar" });
    bar.createDiv({
      cls: "mw-editbar__text",
      text: "布局编辑中：拖动唱片调整顺序，拖动分组头调整分组顺序",
    });
    const done = bar.createEl("button", {
      cls: "mw-btn mw-btn--primary mw-editbar__btn",
      text: "完成",
    });
    done.setAttr("type", "button");
    done.addEventListener("click", () => {
      this.exitEditMode();
      new Notice("布局已保存");
    });
    const cancel = bar.createEl("button", {
      cls: "mw-btn mw-editbar__btn",
      text: "取消",
    });
    cancel.setAttr("type", "button");
    cancel.addEventListener("click", () => {
      this.exitEditMode(true);
      new Notice("已取消布局编辑，顺序已还原");
    });
  }

  private openPlayModal(item: WallItem): void {
    new AlbumPanelModal(this.app, "play", {
      meta: item.meta,
      style: this.data!.style,
      locked: item.locked,
      source: item.source,
      deps: this.plugin.getPlaybackDeps(),
    }).open();
  }

  // ---- 展示架：自绘风格菜单（右键 / 触屏长按共用） ----

  private openShelfCardMenu(x: number, y: number, item: WallItem): void {
    const items: ShelfMenuItem[] = [
      {
        title: "播放",
        onClick: () => void playAlbum(item.meta, this.plugin.getPlaybackDeps()),
      },
      {
        title: "加入播放器",
        disabled: !this.plugin.firstPlayerView(),
        onClick: () => {
          if (this.file) this.plugin.addToPlayer(item, this.file.path);
        },
      },
      { title: "编辑布局", onClick: () => this.enterEditMode() },
    ];
    if (!item.locked) {
      items.push({ title: "编辑元数据", onClick: () => this.editItemMeta(item, false) });
    }
    items.push(
      { title: "迁移到其他墙…", onClick: () => this.migrateCard(item) },
      {
        title: "复制专辑链接",
        onClick: async () => {
          await navigator.clipboard.writeText(
            `https://music.163.com/album?id=${item.albumId}`
          );
          new Notice("已复制");
        },
      },
      { title: "删除", danger: true, onClick: () => this.confirmDelete(item) }
    );
    openShelfMenu(x, y, items);
  }

  /** 解锁后元数据编辑；reopenDetail = 编辑保存后回到场景内详情 */
  private editItemMeta(item: WallItem, reopenDetail: boolean): void {
    new EditMetaModal(this.app, item.meta, async (meta) => {
      item.meta = meta;
      item.metaEdited = true;
      await this.persist();
      this.render();
      new Notice("元数据已保存");
      if (reopenDetail) this.openShelfDetail(item);
    }).open();
  }

  // ---- 展示架：开盒详情（推镜 + 3D gatefold，仅 shelf 布局，替代播放模态） ----

  /** 场景动画句柄（含 scrim/book/翻页/淡入/飞回），统一 cancel 用 */
  private detailAnims: Animation[] = [];
  private detailBusy = false;
  /** 异步时序令牌：render 重建/中止时自增，使陈旧回调失效 */
  private detailSeq = 0;
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
      const target = gfCenterScrollTop(grid, card);
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
      return {
        dx: jr.x - bc.x - s * (cr.x - bc.x),
        dy: jr.y - bc.y - s * (cr.y - bc.y),
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
    const scrim = detail.createDiv({ cls: "mw-gf__scrim" });
    scrim.addEventListener("click", () => this.closeShelfDetail());
    const book = detail.createDiv({ cls: "mw-gf__book" });

    // 右页必须先建：闭合态左右两页共面，共面时后建者绘制在上，封面页（左页）要压住盘托
    const panelR = book.createDiv({ cls: "mw-gf__panel mw-gf__panel--right" });
    const panelL = book.createDiv({ cls: "mw-gf__panel mw-gf__panel--left" });

    const info = panelL.createDiv({ cls: "mw-gf__face mw-gf__face--info" });
    const bar = info.createDiv({ cls: "mw-gf__bar" });
    const closeBtn = bar.createEl("button", { cls: "mw-gf__close" });
    setIcon(closeBtn, "x");
    closeBtn.setAttr("title", "关闭 (Esc)");
    closeBtn.addEventListener("click", () => this.closeShelfDetail());

    // 发行年 + 总时长：顶栏内、操作钮左侧（右页盘片占满，无处安放），随左页信息带一起右移
    const barMeta = bar.createDiv({ cls: "mw-gf__bar-meta" });
    if (meta.year) {
      barMeta.createDiv({ cls: "mw-gf__year", text: `发行于 ${meta.year}` });
    }
    const totalDur = sumTrackDur(meta.tracks);
    if (totalDur > 0) {
      const durEl = barMeta.createDiv({
        cls: "mw-gf__total",
        text: `总时长 ${fmtTotalDur(totalDur)}`,
      });
      durEl.title = fmtTotalDurTip(totalDur);
    }

    const tools = bar.createDiv({ cls: "mw-gf__tools" });
    const mkTool = (icon: string, title: string, danger: boolean, fn: () => void) => {
      const b = tools.createEl("button", {
        cls: danger ? "mw-gf__tool mw-gf__tool--danger" : "mw-gf__tool",
      });
      setIcon(b, icon);
      b.setAttr("title", title);
      b.addEventListener("click", fn);
    };
    mkTool("link", "复制专辑链接", false, async () => {
      await navigator.clipboard.writeText(`https://music.163.com/album?id=${item.albumId}`);
      new Notice("已复制");
    });
    mkTool("arrow-right", "迁移到其他墙", false, () => this.migrateCard(item));
    mkTool("trash", "移出音乐墙", true, () => this.confirmDelete(item));

    const metaBox = info.createDiv({ cls: "mw-gf__meta" });
    const nameEl = metaBox.createDiv({ cls: "mw-gf__name", text: meta.name });
    nameEl.title = meta.name;
    metaBox.createDiv({ cls: "mw-gf__artist", text: meta.artist || "未知艺术家" });
    const tracks = info.createDiv({ cls: "mw-gf__tracks" });
    const list = meta.tracks ?? [];
    if (!list.length) {
      tracks.createDiv({ cls: "mw-gf__noTrack", text: "无曲目快照" });
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
      void playAlbum(item.meta, this.plugin.getPlaybackDeps());
    });
    const vinylFace = discWrap.createDiv({ cls: "mw-gf__discface" });
    vinylFace.appendChild(buildDiscElement(item, "vinyl", { coverSize: 500 }));
    const cdFace = discWrap.createDiv({ cls: "mw-gf__discface is-hidden" });
    cdFace.appendChild(buildDiscElement(item, "cd", { coverSize: 500 }));
    const swap = tray.createDiv({ cls: "mw-gf__swap" });
    const btnVinyl = swap.createEl("button", { text: "黑胶" });
    const btnCd = swap.createEl("button", { text: "CD" });
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

  private openCardMenu(evt: MouseEvent, item: WallItem): void {
    const menu = new Menu();
    menu.addItem((it) =>
      it
        .setTitle("播放")
        .setIcon("play")
        .onClick(() => void playAlbum(item.meta, this.plugin.getPlaybackDeps()))
    );
    menu.addItem((it) =>
      it
        .setTitle("加入播放器")
        .setIcon("disc")
        .setDisabled(!this.plugin.firstPlayerView())
        .onClick(() => {
          if (this.file) this.plugin.addToPlayer(item, this.file.path);
        })
    );
    menu.addItem((it) =>
      it.setTitle("编辑布局").setIcon("move").onClick(() => this.enterEditMode())
    );
    if (!item.locked) {
      menu.addItem((it) =>
        it.setTitle("编辑元数据").setIcon("edit").onClick(() => {
          new EditMetaModal(this.app, item.meta, async (meta) => {
            item.meta = meta;
            item.metaEdited = true;
            await this.persist();
            this.render();
            new Notice("元数据已保存");
          }).open();
        })
      );
    }
    menu.addItem((it) =>
      it
        .setTitle("迁移到其他墙…")
        .setIcon("arrow-right")
        .onClick(() => this.migrateCard(item))
    );
    menu.addItem((it) =>
      it.setTitle("复制专辑链接").setIcon("link").onClick(async () => {
        await navigator.clipboard.writeText(
          `https://music.163.com/album?id=${item.albumId}`
        );
        new Notice("已复制");
      })
    );
    menu.addItem((it) =>
      it
        .setTitle("删除")
        .setIcon("trash")
        .onClick(() => this.confirmDelete(item))
    );
    menu.showAtPosition({ x: evt.x, y: evt.y });
  }

  private confirmDelete(item: WallItem): void {
    new ConfirmModal(this.app, {
      title: "删除专辑",
      message: `确定将《${item.meta.name}》移出这面音乐墙吗？`,
      details: ["仅从本墙移除，不影响其他墙与网易云账号数据。"],
      danger: true,
      confirmText: "删除",
      onConfirm: async () => {
        const data = this.data!;
        data.items = data.items.filter((i) => i !== item);
        if (data.order) data.order = removeFromOrder(data.order, [item.albumId]);
        await this.persist();
        this.render();
        new Notice(`已移除《${item.meta.name}》`);
      },
    }).open();
  }

  /** 迁移（移动语义）：选取库内另一面墙作为目标 */
  private migrateCard(item: WallItem): void {
    const files = this.plugin.wallFiles(this.file?.path);
    if (!files.length) {
      new Notice("库中没有其他 .mw 音乐墙，可先新建一面再迁移");
      return;
    }
    new PickerModal(
      this.app,
      `将《${item.meta.name}》迁移到…`,
      files.map((f) => ({
        label: f.basename,
        detail:
          f.parent && f.parent.path !== "/" ? f.parent.path : "库根目录",
      })),
      (i) => void this.doMigrate(item, files[i])
    ).open();
  }

  private async doMigrate(item: WallItem, target: TFile): Promise<void> {
    if (!this.data) return;
    const ok = await this.plugin.migrateItemInto(item, target);
    if (!ok) return;
    await this.takeOutItem(item.albumId);
    new Notice(`已迁移《${item.meta.name}》→ ${target.basename}.mw`);
  }

  openSearchModal(): void {
    new SearchAlbumModal(this.app, this).open();
  }

  private async renameWall(): Promise<void> {
    if (!this.file) return;
    new InputModal(
      this.app,
      "重命名音乐墙",
      "新名称",
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
          new Notice("重命名失败：" + (e?.message ?? e));
        }
      }
    ).open();
  }

  private openMoreMenu(evt: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((it) =>
      it.setTitle("导出当前墙（分享副本）").setIcon("download").onClick(() => {
        void this.plugin.exportCurrentWall(this);
      })
    );
    menu.addItem((it) =>
      it.setTitle("导入 .mw 文件").setIcon("upload").onClick(() => {
        void this.plugin.importMwFile(this);
      })
    );
    menu.addItem((it) =>
      it.setTitle("从 Git 仓库导入").setIcon("git").onClick(() => {
        if (!Platform.isDesktopApp) {
          new Notice("Git 导入仅在桌面端可用");
          return;
        }
        void this.plugin.gitImport(this);
      })
    );
    menu.showAtPosition({ x: evt.x, y: evt.y });
  }
}
