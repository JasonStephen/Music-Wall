// 音乐播放器 FileView（.mwp）。
// 页面本身不落盘任何播放数据：只保留「最近一次拖入的专辑」为运行时状态。
// 结构：当前播放区（SMTC 或最近一次拖入的专辑）+ 曲目列表（可点单曲播放）。
// 唱片可从任意音乐墙拖入本页（复用 WALL_DRAG_MIME），或经墙上菜单「加入播放器」。

import { FileView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type MusicWallPlugin from "../main";
import {
  PLAYER_BG_LABELS,
  PLAYER_VIEW_TYPE,
  WALL_DRAG_MIME,
  clampZoom,
  type AlbumMeta,
  type DiscStyle,
  type PlayerBackground,
  type WallItem,
} from "../types";
import { sizedCover } from "../core/metadata";
import { playAlbum } from "../core/playback";
import { matchNowPlaying, type NowPlayingMatch } from "../core/match";
import { type NowPlayingState } from "../core/nowPlaying";
import { STYLE_LABELS } from "./disc";
import { buildDevice } from "./device";
import { SideDrawer } from "./SideDrawer";
import { buildBgTile, buildStyleTile } from "./viewPrefs";
import { disposeZoomBox, handleZoomWheel, syncZoomBox } from "./zoom";
import { coverAccent, onAccentFor } from "./accent";
import { setModalTheme } from "./modalTheme";

/** 面板最小宽度：低于则上下堆叠 */
const NARROW_WIDTH = 720;

/** 播放器可选的设备外观：磁带机因无法达到交付要求已移除（音乐墙上的磁带样式不受影响） */
const PLAYER_STYLES: DiscStyle[] = ["vinyl", "cd", "cover"];

/** 各样式在播放器里对应的设备外观（芯片悬停提示） */
const PLAYER_STYLE_TITLES: Record<DiscStyle, string> = {
  vinyl: "唱片机外观",
  cd: "CD 播放器外观",
  cassette: "磁带机外观",
  cover: "大封面外观",
};

/** 背景模式悬停提示 */
const BG_TITLES: Record<PlayerBackground, string> = {
  white: "纯白背景",
  dark: "深色背景",
  art: "跟随专辑封面动态取色",
  wood: "木地板背景",
};
const ALL_BGS: PlayerBackground[] = ["white", "dark", "art", "wood"];

function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export class MusicPlayerView extends FileView {
  private plugin: MusicWallPlugin;
  /** 最近一次拖入 / 加入的专辑（运行时，不落盘） */
  private current: { meta: AlbumMeta; srcPath: string } | null = null;
  private now: NowPlayingState;
  private match: NowPlayingMatch | null = null;
  private wallItems: WallItem[] = [];
  private offNow: (() => void) | null = null;

  /** 唱片样式：与墙上四种一致（默认黑胶） */
  private discStyle: DiscStyle = "vinyl";
  /** 页面背景模式（持久化到插件设置） */
  private bg: PlayerBackground = "dark";
  /** 上拉曲目面板是否展开 */
  private playlistOpen = false;

  private shell: HTMLElement | null = null;
  private el: Record<string, HTMLElement> = {};
  private trackRows: HTMLElement[] = [];
  private albumKey = "";
  private iconPaused: boolean | null = null;
  /** 设备上的数字显示屏（TRxx 曲目号），不显示时间 */
  private readoutEl: HTMLElement | null = null;
  /** 右上角样式图标打开的抽屉（样式 / 背景） */
  private drawer: SideDrawer | null = null;
  private styleBtn: HTMLButtonElement | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MusicWallPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.now = this.currentNow();
    this.bg = plugin.settings.playerBackground ?? "dark";
  }

  /**
   * 取 SMTC 的当前状态（含 supported）。
   * nowPlaying.emit() 按「状态是否变化」去重，监听者只会收到后续变化；
   * 新开的标签页若不主动读一次，正在播放时只会一直显示「未在播放」
   * （暂停、停止同理——只要状态不再变化就永远收不到事件）。
   */
  private currentNow(): NowPlayingState {
    return { ...this.plugin.nowPlaying.state };
  }

  getViewType(): string {
    return PLAYER_VIEW_TYPE;
  }
  getDisplayText(): string {
    return this.file ? `播放器 · ${this.file.basename}` : "音乐播放器";
  }
  getIcon(): string {
    return "disc";
  }

  async onLoadFile(_file: TFile): Promise<void> {
    await this.render();
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    /* 播放器页不依赖文件内容 */
  }

  async onOpen(): Promise<void> {
    this.plugin.ensureNowPlayingStarted();
    // 订阅之前先同步一次当前状态，避免「打开时正在播放却显示未在播放」
    this.now = this.currentNow();
    this.offNow = this.plugin.nowPlaying.on((s) => {
      this.now = s;
      void this.refreshMatch().then(() => this.updateNow());
    });
    this.register(() => this.offNow?.());
    this.registerDomEvent(window, "resize", () => this.syncLayout());
    // Ctrl/Alt + 滚轮：与音乐墙同一套全局缩放
    this.registerDomEvent(
      this.contentEl,
      "wheel",
      (e: WheelEvent) => {
        handleZoomWheel(e, this.plugin, this.contentEl);
      },
      { passive: false, capture: true }
    );
    this.registerDomEvent(document, "keydown", (e: KeyboardEvent) => {
      if (e.key === "Escape" && this.playlistOpen) this.togglePlaylist(false);
    });
    this.registerDomEvent(this.contentEl, "dragover", (e) => this.onDragOver(e));
    this.registerDomEvent(this.contentEl, "dragleave", (e) => {
      if (e.target === this.contentEl) this.contentEl.removeClass("is-dragover");
    });
    this.registerDomEvent(this.contentEl, "drop", (e) => void this.onDrop(e));
    await this.render();
  }

  async onClose(): Promise<void> {
    if (this.offNow) {
      this.offNow();
      this.offNow = null;
    }
    this.drawer?.dispose();
    this.drawer = null;
    this.styleBtn = null;
    this.shell = null;
    this.el = {};
    this.trackRows = [];
    this.albumKey = "";
    this.iconPaused = null;
    this.playlistOpen = false;
    disposeZoomBox(this.contentEl);
  }

  // ---- 对外：拖入 / 加入播放器即播 ----

  /** 缩放变化时重算缩放盒像素尺寸（plugin.applyZoom 会调，见 zoom.ts syncZoomBox） */
  syncZoomBox(): void {
    syncZoomBox(this.contentEl, clampZoom(this.plugin.settings.zoomScale ?? 1));
  }

  /** 拖入或菜单「加入播放器」：替换当前专辑并立即整专播放 */
  playInPlayer(meta: AlbumMeta, srcPath: string): void {
    this.current = { meta, srcPath };
    void this.render();
    void playAlbum(meta, this.plugin.getPlaybackDeps());
  }

  /** 外部（设置变更 / 库变动）触发重绘 */
  refresh(): void {
    this.bg = this.plugin.settings.playerBackground ?? this.bg;
    this.now = this.currentNow();
    void this.render();
  }

  // ---- 拖拽接收 ----

  private onDragOver(e: DragEvent): void {
    if (!e.dataTransfer?.types.includes(WALL_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    this.contentEl.addClass("is-dragover");
  }

  private async onDrop(e: DragEvent): Promise<void> {
    const raw = e.dataTransfer?.getData(WALL_DRAG_MIME);
    this.contentEl.removeClass("is-dragover");
    if (!raw) return;
    e.preventDefault();
    let payload: { srcPath?: string; albumId?: number };
    try {
      payload = JSON.parse(raw) as { srcPath?: string; albumId?: number };
    } catch {
      return;
    }
    const srcPath = payload.srcPath ?? "";
    const albumId = payload.albumId;
    if (!srcPath || typeof albumId !== "number") return;
    const item = await this.plugin.resolveWallItem(srcPath, albumId);
    if (!item) {
      new Notice("未能在来源音乐墙中找到这张唱片");
      return;
    }
    this.playInPlayer(item.meta, srcPath);
  }

  // ---- 匹配与进度 ----

  private async refreshMatch(): Promise<void> {
    this.wallItems = await this.plugin.scanWallItems();
    this.match = matchNowPlaying(this.now, this.wallItems);
  }

  private matchedAlbum(): AlbumMeta | null {
    const albumId = this.match?.albumId;
    if (albumId === undefined) return null;
    const inWalls = this.wallItems.find((i) => i.albumId === albumId)?.meta;
    if (inWalls) return inWalls;
    return this.current?.meta.albumId === albumId ? this.current.meta : null;
  }

  /** 当前展示的专辑：SMTC 命中优先，其次最近一次拖入的 */
  private displayAlbum(): AlbumMeta | null {
    return this.matchedAlbum() ?? this.current?.meta ?? null;
  }

  /** 当前播放曲目在曲目列表中的下标（来自 SMTC 匹配） */
  private activeTrackIndex(): number {
    return this.match ? this.match.trackIndex : -1;
  }

  // ---- 渲染 ----

  private async render(): Promise<void> {
    const root = this.contentEl;
    const prevDrawer = this.drawer?.currentKey() ?? null;
    this.drawer?.dispose();
    this.drawer = null;
    root.empty();
    root.addClass("mw-view", "mw-player");
    // 播放器的弹窗一律用默认皮肤（展示架的木色只属于音乐墙）
    setModalTheme("default");
    this.el = {};
    this.trackRows = [];
    this.albumKey = "";
    this.iconPaused = null;
    await this.refreshMatch();

    // 所有内容放进缩放盒（zoom 必须作用在没有 overflow 裁剪的中间层，见 base.css）
    const box = root.createDiv({ cls: "mw-zoombox" });

    this.applyBackground();
    const bar = this.buildBar(box);
    this.syncTopbarHeight(bar);

    const body = box.createDiv({ cls: "mw-player__body" });
    this.shell = body;
    this.buildNow(body.createDiv({ cls: "mw-player__now" }));

    // 上拉曲目面板 + 遮罩：覆盖在 page 之上，纯查看不可切歌
    this.el.scrim = box.createDiv({ cls: "mw-player__scrim" });
    this.el.scrim.addEventListener("click", () => this.togglePlaylist(false));
    this.el.panel = box.createDiv({ cls: "mw-player__playlist" });
    this.buildPlaylist(this.el.panel);

    // 样式 / 背景抽屉：与遮罩同层挂在缩放盒上（挂 body 上时遮罩只压暗 body，
    // 顶栏与缩放盒四周会露白；面板仍从顶栏下方开始，靠 --mw-topbar-h）
    this.drawer = this.buildDrawer(box);
    if (prevDrawer) this.drawer.open(prevDrawer);

    this.syncLayout();
    this.updateNow();
    this.togglePlaylist(this.playlistOpen);
    // 缩放盒尺寸兜底（与音乐墙同一套，见 zoom.ts syncZoomBox）：
    // CSS 的 calc 反除补偿若退化成 auto，内容会缩在左上角、右/下留白
    this.syncZoomBox();
  }

  /** 背景模式落成类名；「封面」模式额外注入当前专辑封面做动态取色 */
  private applyBackground(): void {
    const root = this.contentEl;
    root.removeClass("mw-bg--white", "mw-bg--dark", "mw-bg--art", "mw-bg--wood");
    root.addClass(`mw-bg--${this.bg}`);
    const cover = this.displayAlbum()?.cover ?? "";
    // 播放键取色：只有「封面」模式跟着封面主色走，其余模式用 CSS 里各模式的固定色
    this.applyArtAccent(this.bg === "art" ? cover : "");
    if (this.bg !== "art") {
      root.style.removeProperty("--mw-player-art");
      return;
    }
    if (cover) root.style.setProperty("--mw-player-art", `url("${sizedCover(cover, 800)}")`);
    else root.style.removeProperty("--mw-player-art");
  }

  /** 已解析过主色的封面地址（防止异步结果覆盖后来的专辑） */
  private accentKey = "";

  /**
   * 「封面」背景下的播放键配色 = 封面主色。
   * 取色是异步的：回来的晚于专辑切换就丢弃（比对 key）。
   * 取不到（无封面 / 网络失败 / 全是不适合的像素）时清掉内联变量，
   * 回退到 CSS 的 --mw-np-accent（= 主题强调色）。
   */
  private applyArtAccent(cover: string): void {
    const root = this.contentEl;
    const key = cover.trim();
    if (key === this.accentKey) return;
    this.accentKey = key;
    root.style.removeProperty("--mw-np-accent");
    root.style.removeProperty("--mw-np-accent-fg");
    if (!key) return;
    void coverAccent(sizedCover(key, 300)).then((color) => {
      if (!color || this.accentKey !== key) return;
      root.style.setProperty("--mw-np-accent", color);
      root.style.setProperty("--mw-np-accent-fg", onAccentFor(color));
    });
  }

  /**
   * 顶栏高度写进 --mw-topbar-h（局部像素）：抽屉面板与右上角浮层都从顶栏下方开始，
   * 否则面板会盖住唯一的样式图标。缩放由缩放盒的 transform 负责，这里只给几何。
   */
  private syncTopbarHeight(bar: HTMLElement): void {
    const h = bar.offsetHeight;
    if (h > 0) this.contentEl.style.setProperty("--mw-topbar-h", `${h}px`);
  }

  /** 顶栏：只有标题 + 右上角一个样式图标（点开滑出「样式 / 背景」抽屉） */
  private buildBar(root: HTMLElement): HTMLElement {
    const bar = root.createDiv({ cls: "mw-player__bar" });
    bar.createDiv({
      cls: "mw-player__title",
      text: this.file?.basename ?? "音乐播放器",
    });
    const btn = bar.createEl("button", { cls: "clickable-icon mw-toolbtn" });
    btn.setAttr("type", "button");
    btn.setAttr("aria-label", "样式与背景");
    btn.setAttr("title", "样式与背景");
    setIcon(btn, "palette");
    btn.addEventListener("click", () => this.drawer?.toggle("settings"));
    this.styleBtn = btn;
    return bar;
  }

  private buildDrawer(body: HTMLElement): SideDrawer {
    const drawer = new SideDrawer(body, () => {
      const open = !!this.drawer?.isOpen();
      this.styleBtn?.toggleClass("is-active", open);
      // 抽屉与上拉曲目面板互斥：都占右侧/底部，同时开会互相遮挡
      if (open) this.togglePlaylist(false);
    });
    drawer.register("settings", "样式与背景", (panel) => {
      // 样式：与音乐墙上四种样式同一套缩略预览
      const cover = this.displayAlbum()?.cover ?? "";
      const secStyle = panel.createDiv({ cls: "mw-panel__section" });
      secStyle.createDiv({ cls: "mw-panel__label", text: "样式" });
      const grid = secStyle.createDiv({ cls: "mw-preset-grid mw-preset-grid--3" });
      for (const s of PLAYER_STYLES) {
        grid.appendChild(
          buildStyleTile(s, STYLE_LABELS[s], cover, this.discStyle === s, (picked) => {
            this.discStyle = picked;
            // 清空 albumKey 让 updateNow 立即重建设备与曲目列表
            this.albumKey = "";
            this.updateNow();
            grid
              .querySelectorAll<HTMLElement>(".mw-preset")
              .forEach((el) =>
                el.toggleClass("is-active", el.dataset.mwStyle === picked)
              );
          })
        );
      }
      panel.createDiv({
        cls: "mw-panel__hint",
        text: PLAYER_STYLE_TITLES[this.discStyle] + "（磁带机外观已移除）",
      });

      const secBg = panel.createDiv({ cls: "mw-panel__section" });
      secBg.createDiv({ cls: "mw-panel__label", text: "背景" });
      const bgs = secBg.createDiv({ cls: "mw-preset-grid" });
      for (const b of ALL_BGS) {
        bgs.appendChild(
          buildBgTile(b, PLAYER_BG_LABELS[b], BG_TITLES[b], this.bg === b, (picked) => {
            const bg = picked as PlayerBackground;
            this.bg = bg;
            this.applyBackground();
            this.plugin.settings.playerBackground = bg;
            void this.plugin.saveData(this.plugin.settings);
            bgs
              .querySelectorAll<HTMLElement>(".mw-preset")
              .forEach((el) => el.toggleClass("is-active", el.dataset.mwBg === picked));
          })
        );
      }
    });
    return drawer;
  }

  private buildNow(col: HTMLElement): void {
    // 统一宽度的竖列：设备 / 信息 / 进度 / 控制 上下对齐
    const stack = col.createDiv({ cls: "mw-np__stack" });
    const stage = stack.createDiv({ cls: "mw-np__stage" });
    this.el.discWrap = stage.createDiv({ cls: "mw-np__disc is-paused" });

    const meta = stack.createDiv({ cls: "mw-np__meta" });
    this.el.title = meta.createDiv({ cls: "mw-np__title" });
    this.el.artist = meta.createDiv({ cls: "mw-np__artist" });
    const line = meta.createDiv({ cls: "mw-np__line" });
    this.el.status = line.createSpan({ cls: "mw-np__status" });
    this.el.jump = line.createEl("button", { cls: "mw-np__jump", text: "定位到墙上唱片" });
    this.el.jump.addEventListener("click", () => void this.jumpToWall());
    this.el.source = meta.createDiv({ cls: "mw-np__source" });

    const controls = stack.createDiv({ cls: "mw-np__controls" });
    this.el.btnPrev = controls.createEl("button", { cls: "mw-np__ctrl", text: "" });
    setIcon(this.el.btnPrev, "skip-back");
    this.el.btnPrev.title = "上一首";
    this.el.btnPrev.addEventListener("click", () => void this.control("prev"));

    this.el.btnToggle = controls.createEl("button", {
      cls: "mw-np__ctrl mw-np__ctrl--main",
      text: "",
    });
    setIcon(this.el.btnToggle, "play");
    this.el.btnToggle.title = "播放/暂停";
    this.el.btnToggle.addEventListener("click", () => void this.control("toggle"));

    this.el.btnNext = controls.createEl("button", { cls: "mw-np__ctrl", text: "" });
    setIcon(this.el.btnNext, "skip-forward");
    this.el.btnNext.title = "下一首";
    this.el.btnNext.addEventListener("click", () => void this.control("next"));

    this.el.btnPlaylist = controls.createEl("button", {
      cls: "mw-np__ctrl mw-np__ctrl--list",
      text: "",
    });
    setIcon(this.el.btnPlaylist, "list");
    this.el.btnPlaylist.title = "曲目列表";
    this.el.btnPlaylist.addEventListener("click", () =>
      this.togglePlaylist(!this.playlistOpen)
    );
  }

  /** 上拉面板的开关（面板覆盖在 page 之上，点遮罩/Esc 收起） */
  private togglePlaylist(open: boolean): void {
    this.playlistOpen = open;
    if (open) this.drawer?.close();
    this.el.panel?.toggleClass("is-open", open);
    this.el.scrim?.toggleClass("is-open", open);
    this.el.btnPlaylist?.toggleClass("is-active", open);
  }

  private buildPlaylist(panel: HTMLElement): void {
    const head = panel.createDiv({ cls: "mw-player__playlist-head" });
    this.el.tracksTitle = head.createSpan({ cls: "mw-player__playlist-title", text: "曲目" });
    this.el.tracksNote = head.createSpan({
      cls: "mw-player__playlist-note",
      text: "仅展示，播放顺序由客户端歌单决定",
    });
    const close = head.createEl("button", { cls: "mw-player__playlist-close" });
    setIcon(close, "chevron-down");
    close.title = "收起";
    close.addEventListener("click", () => this.togglePlaylist(false));
    this.el.tracks = panel.createDiv({ cls: "mw-np__tracks" });
    this.updateTrackList();
  }

  /** 曲目列表重建（当前专辑变化时）；纯展示，点击不切歌以免打乱歌单顺序 */
  private updateTrackList(): void {
    const host = this.el.tracks;
    if (!host) return;
    host.empty();
    this.trackRows = [];
    const album = this.displayAlbum();
    const tracks = album?.tracks ?? [];
    if (this.el.tracksTitle) {
      this.el.tracksTitle.textContent = album ? `曲目 · ${album.name}` : "曲目";
    }
    if (!tracks.length) {
      host.createDiv({
        cls: "mw-np__noTrack",
        text: album ? "该专辑无曲目快照" : "尚未选择专辑",
      });
      return;
    }
    tracks.forEach((t, i) => {
      const row = host.createDiv({ cls: "mw-np__track" });
      row.createSpan({ cls: "mw-np__trackNo", text: String(i + 1).padStart(2, "0") });
      const name = row.createSpan({ cls: "mw-np__trackName", text: t.name });
      name.title = t.name;
      row.createSpan({ cls: "mw-np__trackDur", text: fmtClock(t.duration) });
      this.trackRows.push(row);
    });
  }

  // ---- 增量更新 ----

  private updateNow(): void {
    const album = this.displayAlbum();
    const albumKey = album ? `${album.albumId}|${this.discStyle ?? "def"}` : "";
    if (albumKey !== this.albumKey) {
      this.albumKey = albumKey;
      this.renderDisc(album);
      this.updateTrackList();
      // 「封面」背景下专辑变化时需要重新取色
      this.applyBackground();
    }

    if (this.el.title) {
      this.el.title.textContent = this.now.active
        ? this.now.title || "（未知曲目）"
        : album
          ? album.name
          : "未在播放";
    }
    if (this.el.artist) {
      this.el.artist.textContent = this.now.active
        ? this.now.artist || "未知艺术家"
        : album
          ? album.artist || "未知艺术家"
          : "拖一张唱片进来开始";
    }
    if (this.el.status) this.el.status.textContent = this.statusText();
    if (this.el.source) {
      this.el.source.textContent = this.current
        ? `来源墙：${this.current.srcPath}`
        : "";
    }
    if (this.el.jump) this.el.jump.toggleClass("is-hidden", !this.match);

    const paused = this.now.status !== "playing";
    this.el.discWrap?.toggleClass("is-paused", paused);

    // 设备显示屏：当前曲目号（不显示时间）
    if (this.readoutEl) {
      const idx = this.activeTrackIndex();
      this.readoutEl.textContent =
        idx >= 0 ? `TR${String(idx + 1).padStart(2, "0")}` : "TR--";
    }

    if (this.el.btnToggle && paused !== this.iconPaused) {
      this.iconPaused = paused;
      setIcon(this.el.btnToggle, paused ? "play" : "pause");
    }
    if (this.el.btnNext) this.el.btnNext.toggleClass("is-disabled", !this.now.canNext);
    if (this.el.btnPrev) this.el.btnPrev.toggleClass("is-disabled", !this.now.canPrev);

    this.updateHighlights();
  }

  private statusText(): string {
    if (!this.now.supported) return "SMTC 不可用（仅 Windows 桌面端支持）";
    if (!this.now.active) {
      return this.current ? "已向客户端发送播放指令" : "未检测到系统播放会话";
    }
    switch (this.now.status) {
      case "playing":
        return "正在播放";
      case "paused":
        return "已暂停";
      case "stopped":
        return "已停止";
      default:
        return "空闲";
    }
  }

  private updateHighlights(): void {
    const idx = this.activeTrackIndex();
    this.trackRows.forEach((row, i) => row.toggleClass("is-current", i === idx));
  }

  private renderDisc(album: AlbumMeta | null): void {
    const host = this.el.discWrap;
    if (!host) return;
    host.empty();
    this.readoutEl = null;
    host.style.removeProperty("--mw-np-art");
    if (!album || !album.cover) {
      host.addClass("is-empty");
      host.createDiv({ cls: "mw-np__disc-empty" });
      return;
    }
    host.removeClass("is-empty");
    // 供封面模式做模糊环境底
    host.style.setProperty("--mw-np-art", `url("${sizedCover(album.cover, 800)}")`);

    const pseudo: WallItem = {
      albumId: album.albumId,
      source: "manual",
      locked: true,
      meta: album,
      addedAt: new Date().toISOString(),
    };
    const device = buildDevice(pseudo, this.discStyle, 500);
    this.readoutEl = device.readout;
    host.appendChild(device.root);
  }

  private syncLayout(): void {
    if (!this.shell) return;
    const w = this.contentEl.clientWidth || 0;
    this.contentEl.toggleClass("mw-player--narrow", w > 0 && w < NARROW_WIDTH);
    const bar = this.contentEl.querySelector<HTMLElement>(".mw-player__bar");
    if (bar) this.syncTopbarHeight(bar);
  }

  // ---- 控制 ----

  private async control(action: "play" | "pause" | "toggle" | "next" | "prev"): Promise<void> {
    const np = this.plugin.nowPlaying;
    if (!np.supported) {
      new Notice("当前平台不支持 SMTC 控制（仅 Windows 桌面端）");
      return;
    }
    const ok = await np[action]();
    if (!ok) new Notice("控制指令未被播放器接受");
  }

  // ---- 跳转到所在墙 ----

  private async jumpToWall(): Promise<void> {
    const albumId = this.match?.albumId;
    if (!albumId) return;
    const found = await this.plugin.findAlbumWall(albumId);
    if (!found) {
      new Notice("未在库中找到该专辑所在的音乐墙");
      return;
    }
    await this.plugin.openWall(found.file);
  }
}
