// 音乐播放器 FileView（.mwp）。
// 页面本身不落盘任何播放数据：只保留「最近一次拖入的专辑」为运行时状态。
// 结构：当前播放区（SMTC 或最近一次拖入的专辑）+ 曲目列表（可点单曲播放）。
// 唱片可从任意音乐墙拖入本页（复用 WALL_DRAG_MIME），或经墙上菜单「加入播放器」。

import { FileView, Notice, TFile, WorkspaceLeaf, setIcon } from "obsidian";
import type MusicWallPlugin from "../main";
import {
  PLAYER_VIEW_TYPE,
  WALL_DRAG_MIME,
  clampZoom,
  type AlbumMeta,
  type DiscStyle,
  type PlayerBackground,
  type WallItem,
} from "../types";
import { playerBgLabel, styleLabel, t } from "../i18n";
import { sizedCover } from "../core/metadata";
import { playAlbum } from "../core/playback";
import { matchNowPlaying, type NowPlayingMatch } from "../core/match";
import { type NowPlayingState } from "../core/nowPlaying";
import { buildDevice } from "./device";
import { SideDrawer } from "./SideDrawer";
import { buildBgTile, buildStyleTile } from "./viewPrefs";
import { disposeZoomBox, handleZoomWheel, syncZoomBox } from "./zoom";
import { coverTone, peekTone, onAccentFor } from "./accent";
import { setModalTheme } from "./modalTheme";
import { DEFAULT_COVER, defaultCoverName } from "./defaultCover";

/** 面板最小宽度：低于则上下堆叠 */
const NARROW_WIDTH = 720;

/**
 * 「封面」背景下判「浅底」的阈值（感知亮度 0..1，见 accent.ts 的 perceived）。
 * ≥ 阈值 ⇒ 深色字/图标（浅色封面）；< 阈值 ⇒ 浅色字 + 文字阴影（深色封面）。
 */
const ART_LIGHT_LUMA = 0.5;

/** 播放器可选的设备外观：磁带机因无法达到交付要求已移除（音乐墙上的磁带样式不受影响） */
const PLAYER_STYLES: DiscStyle[] = ["vinyl", "cd", "cover"];

/** 背景模式悬停提示 */
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
  /** 窗格尺寸观察者：窄屏类名与顶栏高度要跟随窗格，不能只听 window.resize */
  private paneObserver: ResizeObserver | null = null;

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
    return this.file
      ? t("player.displayNameWith", { name: this.file.basename })
      : t("player.displayName");
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
    // 窗格尺寸跟随：window.resize 覆盖不到「拖分隔条 / 分屏 / 收展侧边栏」
    this.watchPaneSize();
  }

  async onClose(): Promise<void> {
    if (this.offNow) {
      this.offNow();
      this.offNow = null;
    }
    this.paneObserver?.disconnect();
    this.paneObserver = null;
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
      new Notice(t("player.noSource"));
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

  /** 内置队列优先，其次 SMTC 命中和最近一次拖入的专辑。 */
  private displayAlbum(): AlbumMeta | null {
    return this.plugin.internalPlayer?.album ?? this.matchedAlbum() ?? this.current?.meta ?? null;
  }

  /** 当前曲目下标来自内置队列或 SMTC 匹配。 */
  private activeTrackIndex(): number {
    if (this.now.source === "internal") return this.plugin.internalPlayer?.index ?? -1;
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

    // 上拉曲目面板 + 遮罩：内置播放可选择曲目；客户端模式保留原只读列表。
    // 第七轮起遮罩**只做视觉**（pointer-events:none，见 player.css）：
    // 点其他地方不再收起面板——面板只能经 收起钮 / 曲目列表钮 / Esc 关闭。
    this.el.scrim = box.createDiv({ cls: "mw-player__scrim" });
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

  /** 背景模式落成类名；「封面」模式额外注入当前专辑封面做动态取色 + 黑白字自适应 */
  private applyBackground(): void {
    const root = this.contentEl;
    root.removeClass("mw-bg--white", "mw-bg--dark", "mw-bg--art", "mw-bg--wood");
    root.addClass(`mw-bg--${this.bg}`);
    const cover = this.displayAlbum()?.cover ?? "";
    // 「封面」模式永远有背景：没匹配到专辑 / 专辑无封面时铺内置默认封面，
    // 不再剩下「没有封面 → 什么都没有」的空白（第七轮问题 2）。
    const art = cover || DEFAULT_COVER;
    // 取色 + 自适应字色：只有「封面」模式跟着封面走，其余模式用 CSS 里各模式的固定色
    this.applyArtTone(this.bg === "art" ? art : "");
    if (this.bg !== "art") {
      root.style.removeProperty("--mw-player-art");
      return;
    }
    root.style.setProperty("--mw-player-art", `url("${sizedCover(art, 800)}")`);
    // 取色曾经失败的地址（缓存里是空结果）别铺底：模糊层照旧失控，白字必隐形；
    // 同步守卫 + 异步失败兜底（applyArtTone 里移除）各一道（第七轮）。
    const prev = peekTone(sizedCover(art, 300));
    if (prev && prev.luma === null && !prev.accent) {
      root.style.removeProperty("--mw-player-art");
    }
  }

  /** 已解析过取色的封面地址（防止异步结果覆盖后来的专辑） */
  private accentKey = "";

  /**
   * 「封面」背景下的两件事，一次采样同时拿到（见 accent.ts coverTone）：
   *   1. 播放键配色 = 封面主色；2. 文字/图标黑白色 = 按封面整体亮度自适应。
   * 取色是异步的：回来的晚于专辑切换就丢弃（比对 key）。
   * 取不到（无封面 / 网络失败）时清掉内联变量回退 CSS，并把字色按深色封面处理。
   */
  private applyArtTone(cover: string): void {
    const root = this.contentEl;
    const key = cover.trim();
    if (key === this.accentKey) return;
    this.accentKey = key;
    root.style.removeProperty("--mw-np-accent");
    root.style.removeProperty("--mw-np-accent-fg");
    if (!key) {
      this.setArtTone(null);
      return;
    }
    void coverTone(sizedCover(key, 300)).then((tone) => {
      if (this.accentKey !== key) return;
      if (tone.accent) {
        root.style.setProperty("--mw-np-accent", tone.accent);
        root.style.setProperty("--mw-np-accent-fg", onAccentFor(tone.accent));
      }
      this.setArtTone(tone.luma);
      // 亮度也取不到 = 这次连「背景是浅是深」都无从判断：
      // 不再敢于把失控的模糊封面铺在底下（浅封面 + 白字 = 全部隐形），
      // 移除 --mw-player-art 让 .mw-bg--art 落回深色基底，白字天然可读（第七轮）。
      if (tone.luma === null && !tone.accent) {
        root.style.removeProperty("--mw-player-art");
        console.warn(t("player.accentFail"), key);
      }
    });
  }

  /**
   * 按封面亮度在根节点上挂 `mw-art--light` / `mw-art--dark`（CSS 见 player.css）：
   * 浅色封面 → 深色字/图标（顶栏标题、调色盘图标、标题/艺术家/正在播放/来源），
   * 深色封面 → 保持浅色字 + 文字阴影。
   * 亮度取不到（luma=null，无封面或解码失败）时按**深色**处理：浅字 + 文字阴影是安全的
   * 一刀（深色封面占多数；即使背景其实是浅色，阴影也能把字托住，不会彻底看不见）。
   */
  private setArtTone(luma: number | null): void {
    const light = luma !== null && luma >= ART_LIGHT_LUMA;
    this.contentEl.toggleClass("mw-art--light", light);
    this.contentEl.toggleClass("mw-art--dark", !light);
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
      text: this.file?.basename ?? t("player.displayName"),
    });
    const btn = bar.createEl("button", { cls: "clickable-icon mw-toolbtn" });
    btn.setAttr("type", "button");
    btn.setAttr("aria-label", t("player.styleBg"));
    btn.setAttr("title", t("player.styleBg"));
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
    drawer.register("settings", t("player.styleBg"), (panel) => {
      // 样式：与音乐墙上四种样式同一套缩略预览（无专辑时给默认封面，别再空砖）
      const cover = (this.displayAlbum()?.cover ?? "") || DEFAULT_COVER;
      const secStyle = panel.createDiv({ cls: "mw-panel__section" });
      secStyle.createDiv({
        cls: "mw-panel__label",
        text: t("player.style"),
      });
      const grid = secStyle.createDiv({ cls: "mw-preset-grid mw-preset-grid--3" });
      for (const s of PLAYER_STYLES) {
        grid.appendChild(
          buildStyleTile(s, styleLabel(s), cover, this.discStyle === s, (picked) => {
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
        text: t("player.styleHint", {
          text: t("player.styleTitle." + this.discStyle),
        }),
      });

      const secBg = panel.createDiv({ cls: "mw-panel__section" });
      secBg.createDiv({
        cls: "mw-panel__label",
        text: t("player.bg"),
      });
      const bgs = secBg.createDiv({ cls: "mw-preset-grid" });
      for (const b of ALL_BGS) {
        bgs.appendChild(
          buildBgTile(
            b,
            playerBgLabel(b),
            t("player.bgTip." + b),
            this.bg === b,
            (picked) => {
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
    this.el.jump = line.createEl("button", {
      cls: "mw-np__jump",
      text: t("player.jump"),
    });
    this.el.jump.addEventListener("click", () => void this.jumpToWall());
    this.el.source = meta.createDiv({ cls: "mw-np__source" });

    const timeline = stack.createDiv({ cls: "mw-np__timeline is-hidden" });
    this.el.timeline = timeline;
    this.el.elapsed = timeline.createSpan({ text: "0:00" });
    const seek = timeline.createEl("input", { attr: { type: "range", min: "0", max: "1", step: "0.1", "aria-label": t("internal.seek") } });
    this.el.seek = seek;
    seek.addEventListener("change", () => void this.plugin.nowPlaying.seek(Number(seek.value) * 1000));
    this.el.duration = timeline.createSpan({ text: "0:00" });

    const volumeRow = stack.createDiv({ cls: "mw-np__volume is-hidden" });
    this.el.volumeRow = volumeRow;
    volumeRow.createSpan({ text: t("internal.volume") });
    const volume = volumeRow.createEl("input", { attr: { type: "range", min: "0", max: "1", step: "0.05", "aria-label": t("internal.volume") } });
    volume.value = String(this.plugin.internalPlayer?.volume ?? 1);
    this.el.volume = volume;
    volume.addEventListener("input", () => this.plugin.internalPlayer?.setVolume(Number(volume.value)));

    const controls = stack.createDiv({ cls: "mw-np__controls" });
    this.el.btnPrev = controls.createEl("button", { cls: "mw-np__ctrl", text: "" });
    setIcon(this.el.btnPrev, "skip-back");
    this.el.btnPrev.title = t("player.prevTip");
    this.el.btnPrev.addEventListener("click", () => void this.control("prev"));

    this.el.btnToggle = controls.createEl("button", {
      cls: "mw-np__ctrl mw-np__ctrl--main",
      text: "",
    });
    setIcon(this.el.btnToggle, "play");
    this.el.btnToggle.title = t("player.toggleTip");
    this.el.btnToggle.addEventListener("click", () => void this.control("toggle"));

    this.el.btnNext = controls.createEl("button", { cls: "mw-np__ctrl", text: "" });
    setIcon(this.el.btnNext, "skip-forward");
    this.el.btnNext.title = t("player.nextTip");
    this.el.btnNext.addEventListener("click", () => void this.control("next"));

    this.el.btnPlaylist = controls.createEl("button", {
      cls: "mw-np__ctrl mw-np__ctrl--list",
      text: "",
    });
    setIcon(this.el.btnPlaylist, "list");
    this.el.btnPlaylist.title = t("player.playlistTip");
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
    this.el.tracksTitle = head.createSpan({
      cls: "mw-player__playlist-title",
      text: t("player.tracks"),
    });
    this.el.tracksNote = head.createSpan({
      cls: "mw-player__playlist-note",
      text: t("player.tracksNote"),
    });
    const close = head.createEl("button", { cls: "mw-player__playlist-close" });
    setIcon(close, "chevron-down");
    close.title = t("player.closePlaylist");
    close.addEventListener("click", () => this.togglePlaylist(false));
    this.el.tracks = panel.createDiv({ cls: "mw-np__tracks" });
    this.updateTrackList();
  }

  /** 曲目列表重建；仅内置播放支持点击切歌，客户端歌单顺序不受影响。 */
  private updateTrackList(): void {
    const host = this.el.tracks;
    if (!host) return;
    host.empty();
    this.trackRows = [];
    const album = this.displayAlbum();
    const tracks = album?.tracks ?? [];
    const internal = this.plugin.settings.playbackMode === "internal";
    this.el.tracksNote?.setText(t(internal ? "internal.tracksNote" : "player.tracksNote"));
    if (this.el.tracksTitle) {
      this.el.tracksTitle.textContent = album
        ? t("player.tracksWithName", { name: album.name })
        : t("player.tracks");
    }
    if (!tracks.length) {
      host.createDiv({
        cls: "mw-np__noTrack",
        text: album ? t("player.noTracks") : t("player.noAlbum"),
      });
      return;
    }
    tracks.forEach((track, i) => {
      const row = host.createDiv({ cls: "mw-np__track" });
      if (internal && album) {
        row.addClass("is-playable");
        row.setAttr("role", "button"); row.setAttr("tabindex", "0");
        row.setAttr("aria-label", t("internal.playTrack", { name: track.name }));
        const play = () => void playAlbum(album, this.plugin.getPlaybackDeps(), i);
        row.addEventListener("click", play);
        row.addEventListener("keydown", (event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); play(); }
        });
      }
      row.createSpan({ cls: "mw-np__trackNo", text: String(i + 1).padStart(2, "0") });
      const name = row.createSpan({ cls: "mw-np__trackName", text: track.name });
      name.title = track.name;
      row.createSpan({ cls: "mw-np__trackDur", text: fmtClock(track.duration) });
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
        ? this.now.title || t("player.unknownTrack")
        : album
          ? album.name
          : t("player.notPlaying");
    }
    if (this.el.artist) {
      this.el.artist.textContent = this.now.active
        ? this.now.artist || t("common.unknownArtist")
        : album
          ? album.artist || t("common.unknownArtist")
          : t("player.dragHint");
    }
    if (this.el.status) this.el.status.textContent = this.statusText();
    if (this.el.source) {
      this.el.source.textContent = this.current
        ? t("player.sourceWall", { path: this.current.srcPath })
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

    const internal = this.now.source === "internal" && this.now.active;
    this.el.timeline?.toggleClass("is-hidden", !internal);
    this.el.volumeRow?.toggleClass("is-hidden", !internal);
    if (internal && this.el.seek) {
      const seek = this.el.seek as HTMLInputElement;
      seek.max = String(Math.max(1, this.now.durationMs / 1000));
      if (document.activeElement !== seek) seek.value = String(this.now.positionMs / 1000);
      seek.disabled = !this.now.seekable;
      this.el.elapsed?.setText(fmtClock(this.now.positionMs));
      this.el.duration?.setText(fmtClock(this.now.durationMs));
      if (this.el.volume && document.activeElement !== this.el.volume) {
        (this.el.volume as HTMLInputElement).value = String(this.plugin.internalPlayer?.volume ?? 1);
      }
    }

    this.updateHighlights();
  }

  private statusText(): string {
    if (this.now.source === "internal") {
      const player = this.plugin.internalPlayer;
      if (player?.error) return player.error;
      if (player?.loading) return t("internal.loading");
      const status = t(this.now.status === "playing" ? "player.stPlaying" : this.now.status === "paused" ? "player.stPaused" : "player.stStopped");
      return `${t("internal.label")} · ${status}${player?.trial ? ` · ${t("internal.trial")}` : ""}`;
    }
    if (!this.now.supported) return t("player.smtcOff");
    if (!this.now.active) {
      return this.current ? t("player.smtcSent") : t("player.smtcNone");
    }
    switch (this.now.status) {
      case "playing":
        return t("player.stPlaying");
      case "paused":
        return t("player.stPaused");
      case "stopped":
        return t("player.stStopped");
      default:
        return t("player.stIdle");
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
    // 没匹配到专辑 / 专辑无封面：用内置默认封面渲染设备，不再空着。
    // 匹配到的专辑仍以**专辑自己的封面**为主（第七轮的先后顺序）。
    const meta = album
      ? { ...album, cover: album.cover || DEFAULT_COVER }
      : {
          albumId: 0,
          name: defaultCoverName(),
          artist: "",
          cover: DEFAULT_COVER,
          trackCount: 0,
          tracks: [],
        };
    host.removeClass("is-empty");
    // 供封面模式做模糊环境底
    host.style.setProperty("--mw-np-art", `url("${sizedCover(meta.cover, 800)}")`);

    const pseudo: WallItem = {
      albumId: album ? album.albumId : 0,
      source: "manual",
      locked: true,
      meta,
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

  /**
   * 让布局跟随**窗格**尺寸，而不是只跟随窗口。
   *
   * 拖侧边栏分隔条、分屏/合并窗格、收展左右侧栏都会改变窗格宽度，但不触发
   * `window.resize`：只挂 window 的话，`mw-player--narrow`（阈值 NARROW_WIDTH）
   * 与 `--mw-topbar-h` 会一直停在旧值。缩放盒的像素尺寸由 zoom.ts 的观察者负责，
   * 这里只管布局状态；window.resize 仍然保留，作为没有 ResizeObserver 时的兜底。
   */
  private watchPaneSize(): void {
    if (this.paneObserver || typeof ResizeObserver === "undefined") return;
    this.paneObserver = new ResizeObserver(() => this.syncLayout());
    this.paneObserver.observe(this.contentEl);
  }

  // ---- 控制 ----

  private async control(action: "play" | "pause" | "toggle" | "next" | "prev"): Promise<void> {
    const pausing = action === "pause" || (action === "toggle" && this.now.status === "playing");
    if (!pausing && !(await this.plugin.ensureNeteaseLogin())) return;
    const np = this.plugin.nowPlaying;
    if (!np.supported) {
      new Notice(t("player.ctrlUnsupported"));
      return;
    }
    const ok = await np[action]();
    if (!ok) new Notice(t("player.ctrlRejected"));
  }

  // ---- 跳转到所在墙 ----

  private async jumpToWall(): Promise<void> {
    const albumId = this.match?.albumId;
    if (!albumId) return;
    const found = await this.plugin.findAlbumWall(albumId);
    if (!found) {
      new Notice(t("player.jumpNotFound"));
      return;
    }
    await this.plugin.openWall(found.file);
  }
}
