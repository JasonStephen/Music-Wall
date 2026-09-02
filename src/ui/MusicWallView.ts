// 音乐墙 FileView：点开 .mw 文件即渲染唱片墙。
// FileView 基类负责 file 绑定/切换/重命名刷标题/导航历史，本类只管加载与渲染；
// 工具栏（样式切换/搜索/筛选/排序/添加）+ 响应式网格 + ⋯ 菜单 + 外部修改自动刷新；
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
  type AlbumMeta,
  type AlbumSummary,
  type DiscStyle,
  type MusicWallData,
  type WallItem,
  type WallLayout,
} from "../types";
import { loadWall, saveWall } from "../core/store";
import { playAlbum } from "../core/playback";
import { sizedCover } from "../core/metadata";
import { ALL_STYLES, STYLE_LABELS, buildDiscElement, makeCoverImg } from "./disc";
import { AlbumPanelModal } from "./AlbumPanelModal";
import { ConfirmModal } from "./ConfirmModal";
import { EditMetaModal } from "./EditMetaModal";
import { InputModal } from "./InputModal";
import { PickerModal } from "./smallModals";
import { SearchAlbumModal, type WallHost } from "./SearchAlbumModal";
import { openShelfMenu, type ShelfMenuItem } from "./ShelfMenu";

type SortKey = "addedAt" | "name" | "artist" | "year";
const SORT_LABELS: Record<SortKey, string> = {
  addedAt: "添加时间",
  name: "专辑名",
  artist: "艺术家",
  year: "发行年份",
};
const LAYOUT_LABELS: Record<WallLayout, string> = {
  grid: "网格",
  list: "列表",
  shelf: "展示架",
};

/** "2015" → "2010s"；无效返回 "" */
function decadeOf(y?: string): string {
  const n = parseInt(y ?? "", 10);
  return Number.isFinite(n) ? `${Math.floor(n / 10) * 10}s` : "";
}

/** 毫秒 → "m:ss" */
function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
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

export class MusicWallView extends FileView implements WallHost {
  private plugin: MusicWallPlugin;
  private data: MusicWallData | null = null;
  allowNoFile = true;

  // 纯前端筛选/排序/搜索状态（不写入文件）
  private q = "";
  private filterArtist = "";
  private filterDecade = "";
  private filterTag = "";
  private sortKey: SortKey = "addedAt";
  private sortAsc = false;
  private suppressSelf = false;

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
    // 开盒详情内：Esc 返回展示架
    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape") this.closeShelfDetail();
    });
    // 放置靶点：其他墙拖来的唱片卡片可直接落在本墙上
    this.registerDomEvent(this.contentEl, "dragover", (e: DragEvent) => {
      if (e.dataTransfer?.types.includes(WALL_DRAG_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    });
    this.registerDomEvent(this.contentEl, "drop", (e: DragEvent) => {
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
    // 无文件（新建/瞬态）时也要有可读的界面，onLoadFile 接管后续渲染
    await this.render();
  }

  /** 供设置页/外部触发重绘 */
  refresh(): void {
    void this.render();
  }

  async onClose(): Promise<void> {
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
    });
    void this.persist().then(() => this.render());
  }

  // ---- 渲染 ----

  private async render(): Promise<void> {
    const root = this.contentEl;
    // 场景动画句柄随 root 重建失效：先令牌失效 + cancel + 复位状态机
    this.resetDetailState();
    // 重建会丢滚动位置（迁移/删除/样式切换等），先记后还
    const prevScroll = root.querySelector<HTMLElement>(".mw-grid")?.scrollTop ?? 0;
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
      cls: layout === "list" ? "mw-grid mw-grid--list" : layout === "shelf" ? "mw-grid mw-grid--shelf" : "mw-grid",
    });
    grid.style.setProperty("--mw-min-col", `${this.plugin.settings.minColumnWidth}px`);
    this.renderGrid(grid);
    grid.scrollTop = prevScroll;
    if (layout === "shelf") {
      // 开盒详情 overlay（懒填充）：点唱片推镜放大后绕书脊 3D 翻开
      stage.createDiv({ cls: "mw-shelf-detail" });
    }
  }

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

    // 全局样式切换（网格与展示架显示，列表隐藏）
    const showStyles = (this.data!.layout ?? "grid") !== "list";
    if (showStyles) {
      const styles = bar.createDiv({ cls: "mw-toolbar__styles" });
      for (const s of ALL_STYLES) {
        const chip = styles.createEl("button", {
          cls: "mw-chip",
          text: STYLE_LABELS[s],
        });
        chip.toggleClass("is-active", this.data!.style === s);
        chip.addEventListener("click", async () => {
          this.data!.style = s;
          await this.persist();
          this.render();
        });
      }
    }

    // 布局切换：网格 / 多列列表 / 展示架
    const layouts = bar.createDiv({ cls: "mw-toolbar__styles" });
    for (const l of ["grid", "list", "shelf"] as WallLayout[]) {
      const chip = layouts.createEl("button", { cls: "mw-chip", text: LAYOUT_LABELS[l] });
      chip.toggleClass("is-active", (this.data!.layout ?? "grid") === l);
      chip.addEventListener("click", async () => {
        this.data!.layout = l === "grid" ? undefined : l;
        await this.persist();
        this.render();
      });
    }

    const controls = bar.createDiv({ cls: "mw-toolbar__controls" });

    const search = controls.createEl("input", {
      type: "search",
      placeholder: "搜索本墙专辑…",
      cls: "mw-toolbar__search",
    });
    search.value = this.q;
    search.addEventListener("input", () => {
      this.q = search.value;
      this.rerenderGrid();
    });

    const uniq = (fn: (i: WallItem) => string | undefined) => {
      const set = new Set<string>();
      for (const i of this.data!.items) {
        const v = fn(i);
        if (v) set.add(v);
      }
      return [...set].sort();
    };
    const select = (
      placeholder: string,
      value: string,
      options: string[],
      onPick: (v: string) => void
    ) => {
      const sel = controls.createEl("select", { cls: "mw-toolbar__select" });
      sel.createEl("option", { text: placeholder, value: "" });
      for (const o of options) {
        sel.createEl("option", { text: o, value: o });
      }
      sel.value = value;
      sel.addEventListener("change", () => onPick(sel.value));
    };
    select(
      "艺术家",
      this.filterArtist,
      uniq((i) => i.meta.artist),
      (v) => {
        this.filterArtist = v;
        this.rerenderGrid();
      }
    );
    select(
      "年代",
      this.filterDecade,
      [...new Set(this.data!.items.map((i) => decadeOf(i.meta.year)).filter(Boolean))].sort(),
      (v) => {
        this.filterDecade = v;
        this.rerenderGrid();
      }
    );
    const allTags = new Set<string>();
    for (const i of this.data!.items) for (const t of i.meta.tags ?? []) allTags.add(t);
    if (allTags.size) {
      select(
        "标签",
        this.filterTag,
        [...allTags].sort(),
        (v) => {
          this.filterTag = v;
          this.rerenderGrid();
        }
      );
    }

    // 排序类型与升降序合并为一个下拉：选择当前项 = 翻转方向（选项文字带箭头指示）
    const sortSel = controls.createEl("select", { cls: "mw-toolbar__select" });
    for (const k of Object.keys(SORT_LABELS) as SortKey[]) {
      const label = `按${SORT_LABELS[k]}`;
      sortSel.createEl("option", {
        text: k === this.sortKey ? `${label} ${this.sortAsc ? "↑" : "↓"}` : label,
        value: k,
      });
    }
    sortSel.value = this.sortKey;
    sortSel.addEventListener("change", () => {
      const k = sortSel.value as SortKey;
      if (k === this.sortKey) this.sortAsc = !this.sortAsc;
      else this.sortKey = k;
      this.render();
    });

    const addGroup = controls.createDiv({ cls: "mw-toolbar__add" });
    const btnAdd = addGroup.createEl("button", {
      cls: "mw-btn mw-btn--primary",
      text: "＋ 添加",
    });
    btnAdd.setAttr("title", "搜索网易云专辑并抓取完整元数据");
    btnAdd.addEventListener("click", () => this.openSearchModal());
    const btnMore = addGroup.createEl("button", { cls: "mw-btn", text: "⋯" });
    btnMore.addEventListener("click", (e) => this.openMoreMenu(e as MouseEvent));
  }

  private rerenderGrid(): void {
    const grid = this.contentEl.querySelector(".mw-grid") as HTMLElement;
    if (grid) this.renderGrid(grid);
  }

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
    if (this.filterArtist)
      items = items.filter((i) => i.meta.artist === this.filterArtist);
    if (this.filterDecade)
      items = items.filter((i) => decadeOf(i.meta.year) === this.filterDecade);
    if (this.filterTag)
      items = items.filter((i) => (i.meta.tags ?? []).includes(this.filterTag));

    const dir = this.sortAsc ? 1 : -1;
    items.sort((a, b) => {
      let r = 0;
      switch (this.sortKey) {
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

  private renderGrid(grid: HTMLElement): void {
    // 搜索/筛选等局部重绘也保持滚动位置
    const prevScroll = grid.scrollTop;
    grid.empty();
    const items = this.getVisibleItems();
    if (!items.length) {
      const empty = grid.createDiv({ cls: "mw-empty" });
      empty.createDiv({
        text: this.data!.items.length
          ? "没有符合筛选条件的专辑"
          : "这面墙还是空的",
        cls: "mw-empty__title",
      });
      if (!this.data!.items.length) {
        empty.createDiv({
          text: "「添加」会搜索网易云专辑并抓取完整元数据，随时可用顶部栏切换四种唱片样式与网格/列表/展示架布局。",
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
            this.filterArtist = "";
            this.filterDecade = "";
            this.filterTag = "";
            this.render();
          });
      }
      return;
    }
    for (const item of items) {
      const layout = this.data!.layout ?? "grid";
      grid.appendChild(
        layout === "list"
          ? this.buildListRow(item)
          : layout === "shelf"
            ? this.buildShelfCard(item)
            : this.buildCard(item)
      );
    }
    // 展示架：滚动或点空白即收起所有抽出卡（grid 每次渲染重建，监听随元素回收）
    if ((this.data!.layout ?? "grid") === "shelf") {
      grid.addEventListener("scroll", () => this.retractAllShelf());
      grid.addEventListener("click", (e) => {
        if (!(e.target as HTMLElement | null)?.closest(".mw-shelf-card")) {
          this.retractAllShelf();
        }
      });
    }
    grid.scrollTop = prevScroll;
  }

  private buildCard(item: WallItem): HTMLElement {
    const style = this.data!.style;
    const card = document.createElement("div");
    card.className = "mw-card";
    card.appendChild(buildDiscElement(item, style, { coverSize: 300 }));
    card.appendChild(this.makeMenuButton(item));
    card.appendChild(this.makeDelButton(item));
    this.wireDraggable(card, item);

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

    card.addEventListener("click", () => this.openPlayModal(item));
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

    // 触屏长按 450ms 唤出菜单；滚动（pointercancel）自动取消
    let pressTimer = 0;
    card.addEventListener("pointerdown", (e) => {
      if (!this.touchMode) return;
      const pe = e as PointerEvent;
      const x = pe.clientX;
      const y = pe.clientY;
      pressTimer = window.setTimeout(() => {
        pressTimer = 0;
        this.longPressFired = true;
        this.openShelfCardMenu(x, y, item);
      }, 450);
    });
    const cancelPress = () => {
      if (pressTimer) window.clearTimeout(pressTimer);
      pressTimer = 0;
    };
    card.addEventListener("pointerup", cancelPress);
    card.addEventListener("pointercancel", cancelPress);
    card.addEventListener("pointerleave", cancelPress);

    card.addEventListener("click", () => {
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
    return card;
  }

  /** 列表模式行：封面 + 三行文字（专辑名/艺术家/年份）+ 操作钮 */
  private buildListRow(item: WallItem): HTMLElement {
    const row = document.createElement("div");
    row.className = "mw-row";

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
    row.addEventListener("click", () => this.openPlayModal(item));
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
   */
  private wireDraggable(root: HTMLElement, item: WallItem): void {
    root.addEventListener("pointerdown", (e) => {
      root.draggable = (e as PointerEvent).button === 0;
    });
    root.addEventListener("dragend", () => {
      root.draggable = false;
    });
    root.addEventListener("dragstart", (e) => {
      const de = e as DragEvent;
      if (!de.dataTransfer || !this.file) return;
      de.dataTransfer.setData(
        WALL_DRAG_MIME,
        JSON.stringify({ srcPath: this.file.path, albumId: item.albumId })
      );
      de.dataTransfer.effectAllowed = "copyMove";
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
    if (meta.year) {
      metaBox.createDiv({ cls: "mw-gf__year", text: `发行于 ${meta.year}` });
    }
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
        this.data!.items = this.data!.items.filter((i) => i !== item);
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
