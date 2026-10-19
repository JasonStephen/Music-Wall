import { PRESET_CHOICES, presetForeground, presetIcon, resolvePlayerPreset, type PresetGroup } from "./playerPresets";
import { bindMouseBack } from "./mouseBack";
// 独立音乐播放器页面。
// 页面本身不落盘任何播放数据：只保留「最近一次拖入的专辑」为运行时状态。
// 结构：当前播放区（SMTC 或最近一次拖入的专辑）+ 曲目列表（可点单曲播放）。
// 唱片可从任意音乐墙拖入本页（复用 WALL_DRAG_MIME），或经墙上菜单「加入播放器」。

import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type MusicWallPlugin from "../main";
import {
  PLAYER_VIEW_TYPE,
  WALL_DRAG_MIME,
  clampZoom,
  type AlbumMeta,
  type DiscStyle,
  type PlayerBackground,
  type DeviceCase,
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
import { coverTone, onAccentFor } from "./accent";
import { setModalTheme } from "./modalTheme";
import { DEFAULT_COVER, defaultCoverName } from "./defaultCover";
import { qualityLabel, type AudioQuality } from "../core/quality";
import { decorateRange, paintRange } from "./range";
import { watchHostInset } from "./hostInset";
import { QueueControls } from "./QueueControls";
import { CoverBackdrop } from "./CoverBackdrop";
import { cyclePlayOrder, updatePlayOrderButton } from "./playOrder";
import { PickerModal } from "./smallModals";
import { PlayerLyrics } from "./PlayerLyrics";

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

export class MusicPlayerView extends ItemView {
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
  private popover: "volume" | "quality" | null = null;
  private queueControls: QueueControls | null = null;
  private qualityKey = "";
  private playerLyrics: PlayerLyrics | null = null;
  private artistPicker: PickerModal | null = null;
  private artistRequest = 0;
  private artistContext = "";
  private volumeIcon = "";
  private stopHostInset: (() => void) | null = null;
  private caseToneKey = "";
  private backdrop: CoverBackdrop | null = null;

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
  private presetMedia: MediaQueryList | null = null;
  private fullLyrics = false;
  private lastPresetGroup: Exclude<PresetGroup, "custom"> = "vinyl";
  private onPresetTheme = () => this.refreshPresetAppearance();
  /** 窗格尺寸观察者：窄屏类名与顶栏高度要跟随窗格，不能只听 window.resize */
  private paneObserver: ResizeObserver | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: MusicWallPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.now = this.currentNow();
    this.bg = plugin.settings.playerBackground ?? "dark";
    this.discStyle = plugin.settings.playerCustomStyle || "vinyl";
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
    return t("player.displayName");
  }
  getIcon(): string { return "disc"; }

  async onOpen(): Promise<void> {
    this.register(bindMouseBack(this.contentEl, () => this.mouseBack()));
    this.presetMedia = this.contentEl.ownerDocument.defaultView?.matchMedia("(prefers-color-scheme: dark)") || null;
    this.presetMedia?.addEventListener("change", this.onPresetTheme);
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
      if ((e.code === "Space" || e.key === " ") && !e.defaultPrevented && !e.isComposing
        && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey
        && this.app.workspace.getActiveViewOfType(MusicPlayerView) === this && this.now.canToggle) {
        const target = e.target instanceof Element ? e.target : document.activeElement;
        const controls = "input, textarea, select, button, a[href], [contenteditable]:not([contenteditable='false']), [role='textbox'], [role='button'], [role='slider'], .modal-container, .prompt";
        if (target && !target.closest(controls)
          && (this.contentEl.contains(target) || target === document.body || target === document.documentElement)) {
          e.preventDefault();
          if (!e.repeat) void this.control("toggle");
        }
      }
      if (e.key === "Escape" && this.popover) {
        const button = this.el[this.popover === "volume" ? "btnVolume" : "btnQuality"];
        this.togglePopover(null); button?.focus();
      }
      if (e.key === "Escape" && this.playlistOpen) this.togglePlaylist(false);
    });
    this.registerDomEvent(this.contentEl, "pointerdown", (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target as Element;
      if (!target.closest(".mw-np__popover-anchor")) this.togglePopover(null);
      if (!target.closest(".mw-player__playlist, .mw-np__ctrl--list")) this.togglePlaylist(false);
      if (!target.closest(".mw-drawer, .mw-toolbtn")) this.drawer?.close();
    });
    this.registerDomEvent(this.contentEl, "dragover", (e) => this.onDragOver(e));
    this.registerDomEvent(this.contentEl, "dragleave", (e) => {
      if (e.target === this.contentEl) this.contentEl.removeClass("is-dragover");
    });
    this.registerDomEvent(this.contentEl, "drop", (e) => void this.onDrop(e));
    await this.render();
    // 窗格尺寸跟随：window.resize 覆盖不到「拖分隔条 / 分屏 / 收展侧边栏」
    this.watchPaneSize();
    this.stopHostInset = watchHostInset(this.contentEl);
  }

  private async mouseBack(): Promise<void> {
    if (this.popover) { this.togglePopover(null); return; }
    if (this.playlistOpen) { this.togglePlaylist(false); return; }
    if (this.drawer?.isOpen()) { this.drawer.close(); return; }
    await this.plugin.returnFromPlayer();
  }
  async onClose(): Promise<void> {
    this.presetMedia?.removeEventListener("change", this.onPresetTheme); this.presetMedia = null;
    this.playerLyrics?.dispose(); this.playerLyrics = null;
    this.artistRequest++; this.artistPicker?.close(); this.artistPicker = null;
    this.backdrop?.dispose(); this.backdrop = null;
    this.caseToneKey = "";
    this.stopHostInset?.(); this.stopHostInset = null;
    if (this.offNow) {
      this.offNow();
      this.offNow = null;
    }
    this.paneObserver?.disconnect();
    this.paneObserver = null;
    this.queueControls?.dispose(); this.queueControls = null;
    this.drawer?.dispose();
    this.drawer = null;
    this.styleBtn = null;
    this.shell = null;
    this.el = {};
    this.trackRows = [];
    this.albumKey = "";
    this.iconPaused = null;
    this.playlistOpen = false;
    this.popover = null;
    disposeZoomBox(this.contentEl);
  }

  // ---- 对外：拖入 / 加入播放器即播 ----

  /** 缩放变化时重算缩放盒像素尺寸（plugin.applyZoom 会调，见 zoom.ts syncZoomBox） */
  syncZoomBox(): void {
    syncZoomBox(this.contentEl, clampZoom(this.plugin.settings.zoomScale ?? 1));
  }

  /** 拖入或菜单「加入播放器」：替换当前专辑并立即整专播放 */
  playInPlayer(meta: AlbumMeta, srcPath: string): void {
    this.current = { meta: { ...meta, playbackWallPath: srcPath || undefined }, srcPath };
    void this.render();
    void playAlbum(meta, this.plugin.getPlaybackDeps(srcPath));
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
    const player = this.plugin.internalPlayer;
    return player?.album ? { ...player.album, cover: player.currentCover } : this.matchedAlbum() ?? this.current?.meta ?? null;
  }

  /** 当前曲目下标来自内置队列或 SMTC 匹配。 */
  private activeTrackIndex(): number {
    if (this.now.source === "internal") return this.plugin.internalPlayer?.index ?? -1;
    return this.match ? this.match.trackIndex : -1;
  }

  // ---- 渲染 ----

  private async render(): Promise<void> {
    this.playerLyrics?.dispose(); this.playerLyrics = null;
    const root = this.contentEl;
    const prevDrawer = this.drawer?.currentKey() ?? null;
    this.drawer?.dispose();
    this.queueControls?.dispose(); this.queueControls = null;
    this.drawer = null;
    this.backdrop?.dispose(); root.empty();
    root.addClass("mw-view", "mw-player");
    this.backdrop = new CoverBackdrop(root);
    // 播放器的弹窗一律用默认皮肤（展示架的木色只属于音乐墙）
    setModalTheme("default");
    this.el = {};
    this.trackRows = [];
    this.popover = null; this.qualityKey = ""; this.volumeIcon = "";
    this.albumKey = "";
    this.iconPaused = null;
    await this.refreshMatch();

    // 所有内容放进缩放盒（zoom 必须作用在没有 overflow 裁剪的中间层，见 base.css）
    const box = root.createDiv({ cls: "mw-zoombox" });

    this.syncPreset();
    this.el.fullCover = box.createDiv({ cls: "mw-full-cover", attr: { "aria-hidden": "true" } });
    this.applyBackground();
    const bar = this.buildBar(box);
    this.syncTopbarHeight(bar);

    const body = box.createDiv({ cls: "mw-player__body" });
    this.shell = body;
    this.buildNow(body.createDiv({ cls: "mw-player__now" }));
    this.playerLyrics = new PlayerLyrics(body.createDiv(), this.plugin);

    // 上拉曲目面板 + 遮罩：内置播放可选择曲目；客户端模式保留原只读列表。
    // 遮罩只做视觉，不拦截点击；点击列表外区域、收起钮、列表钮或 Esc 均可关闭。
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
    if (this.bg !== "art") {
      this.backdrop?.set("", () => {});
      root.style.removeProperty("--mw-np-accent"); root.style.removeProperty("--mw-np-accent-fg"); this.setArtTone(null);
      root.style.removeProperty("--mw-player-art");
      return;
    }
    this.backdrop?.set(art, tone => {
      if (this.bg !== "art") return;
      root.style.setProperty("--mw-full-tone", tone.accent || "#303742");
      root.style.setProperty("--mw-full-foreground", presetForeground(tone.accent || "#303742"));
      if (tone.accent) { root.style.setProperty("--mw-np-accent", tone.accent); root.style.setProperty("--mw-np-accent-fg", onAccentFor(tone.accent)); }
      else { root.style.removeProperty("--mw-np-accent"); root.style.removeProperty("--mw-np-accent-fg"); }
      this.setArtTone(tone.luma);
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
      text: t("player.displayName"),
    });
    this.el.source = bar.createEl("button", { cls: "clickable-icon mw-player__source", attr: { type: "button" } });
    this.el.source.addEventListener("click", () => void this.openSource());
    const tools = bar.createDiv({ cls: "mw-player-presets", attr: { role: "group", "aria-label": t("playerPresets.title") } });
    this.el.coverToggle = tools.createEl("button", { cls: "clickable-icon mw-cover-toggle", attr: { type: "button" } });
    setIcon(this.el.coverToggle, "list-music");
    this.el.coverToggle.addEventListener("click", () => { this.fullLyrics = !this.fullLyrics; this.syncLayout(); });
    const button = tools.createEl("button", { cls: "clickable-icon mw-toolbtn", attr: { type: "button", title: t("playerPresets.title"), "aria-label": t("playerPresets.title") } });
    setIcon(button, "palette"); button.addEventListener("click", () => this.drawer?.toggle("settings"));
    this.styleBtn = button;
    return bar;
  }

  private presetGroup(): PresetGroup { return this.preset()?.group || "custom"; }
  private preset() { return resolvePlayerPreset(this.plugin.settings, this.presetMedia?.matches ?? this.contentEl.ownerDocument.body.classList.contains("theme-dark")); }
  private syncPreset(): void {
    const preset = this.preset();
    if (preset) { this.discStyle = preset.style; this.bg = preset.background; this.lastPresetGroup = preset.group; }
    else this.bg = this.plugin.settings.playerBackground || "dark";
    this.contentEl.toggleClass("mw-player--full-cover", !!preset?.fullCover);
    this.contentEl.dataset.playerPreset = preset ? `${preset.group}-${preset.choice}` : "custom";
  }
  refreshPresetAppearance(refreshDrawer = true): void {
    if (!this.shell) return;
    this.syncPreset(); this.applyBackground(); this.updateNow(); this.syncLayout();
    if (refreshDrawer && this.drawer?.isOpen()) {
      const body = this.contentEl.querySelector<HTMLElement>(".mw-drawer__body"), scroll = body?.scrollTop || 0;
      this.drawer.refresh(); if (body) body.scrollTop = scroll;
    }
  }
  private buildStyleTabs(panel: HTMLElement): void {
    const tabs = panel.createDiv({ cls: "mw-style-tabs", attr: { role: "tablist", "aria-label": t("playerPresets.title") } });
    for (const tab of ["presets", "custom"] as const) {
      const custom = tab === "custom", label = t(`playerPresets.${tab}`);
      const selected = custom === (this.presetGroup() === "custom");
      const button = tabs.createEl("button", { cls: "clickable-icon mw-style-tab", attr: { type: "button", role: "tab", title: label, "aria-label": label, "data-style-tab": tab, "aria-selected": String(selected), tabindex: selected ? "0" : "-1" } });
      if (custom) presetIcon(button, "custom"); else setIcon(button, "layout-grid");
      button.createSpan({ text: label });
      const select = () => {
        if (selected) return;
        this.plugin.settings.playerPresetGroup = custom ? "custom" : this.lastPresetGroup;
        if (custom) this.discStyle = this.plugin.settings.playerCustomStyle || "vinyl";
        this.refreshPresetAppearance();
        void this.plugin.saveData(this.plugin.settings).catch(() => new Notice(t("library.failed")));
      };
      button.addEventListener("click", select);
      button.addEventListener("keydown", event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "presets" : event.key === "End" ? "custom" : custom ? "presets" : "custom";
        this.contentEl.querySelector<HTMLButtonElement>(`[data-style-tab="${next}"]`)?.click();
        this.contentEl.querySelector<HTMLButtonElement>(`[data-style-tab="${next}"]`)?.focus();
      });
    }
  }
  private buildPresetOptions(panel: HTMLElement): void {
    const cover = this.displayAlbum()?.cover || DEFAULT_COVER;
    const item: WallItem = { albumId: 0, source: "manual", locked: true, addedAt: "", meta: { albumId: 0, name: "", artist: "", cover, trackCount: 0, tracks: [] } };
    for (const group of Object.keys(PRESET_CHOICES) as Exclude<PresetGroup, "custom">[]) {
      const section = panel.createEl("section", { cls: "mw-style-section", attr: { "data-style-section": group } });
      section.createEl("h3", { text: t(`playerPresets.${group}`) });
      const grid = section.createDiv({ cls: "mw-preset-options" });
      for (const choice of PRESET_CHOICES[group]) {
        const config = resolvePlayerPreset({ ...this.plugin.settings, playerPresetGroup: group, playerPresetChoices: { ...this.plugin.settings.playerPresetChoices, [group]: choice } }, this.presetMedia?.matches || false)!;
        const selected = this.presetGroup() === group && this.preset()?.choice === choice;
        const key = `${group}${choice[0].toUpperCase()}${choice.slice(1)}` as "vinylClassic";
        const card = grid.createDiv({ cls: "mw-style-card", attr: { "data-style-kind": `${group}-${choice}` } });
        const button = card.createEl("button", { cls: "mw-preset-option", attr: { type: "button", "data-preset-choice": choice, "data-choice-group": group, "aria-pressed": String(selected) } });
        const preview = button.createDiv({ cls: "mw-style-preview mw-vinyl-swatch mw-case-sample", attr: { "aria-hidden": "true" } });
        preview.dataset.mwCase = config.deviceCase;
        preview.dataset.mwVinyl = config.machine ? config.deviceCase === "art" ? "color" : "black" : config.finish;
        preview.dataset.previewBackground = config.background;
        if (config.background === "art" && !config.fullCover) preview.createDiv({ cls: "mw-style-preview__background" }).style.backgroundImage = `url("${sizedCover(cover, 300)}")`;
        if (config.fullCover) {
          preview.addClass("mw-style-preview--full");
          preview.createDiv({ cls: "mw-style-preview__cover" }).style.backgroundImage = `url("${sizedCover(cover, 300)}")`;
        } else preview.appendChild(buildDevice(item, config.style, 200, config.machine).root);
        button.createSpan({ cls: "mw-style-card__name", text: t(`playerPresets.${key}`) });
        const glass = group === "vinyl" && choice === "color";
        if (config.tone || glass) button.createSpan({ cls: "mw-style-custom-label", text: t("playerPresets.custom") });
        const choose = () => {
          this.plugin.settings.playerPresetGroup = group;
          this.plugin.settings.playerPresetChoices = { ...this.plugin.settings.playerPresetChoices, [group]: choice };
        };
        button.addEventListener("click", () => {
          choose(); this.refreshPresetAppearance();
          void this.plugin.saveData(this.plugin.settings).catch(() => new Notice(t("library.failed")));
        });
        if (selected && config.tone) {
          const tones = card.createDiv({ cls: "mw-preset-tones", attr: { role: "group", "aria-label": t("playerPresets.tone") } });
          for (const mode of ["system", "light", "dark"] as const) {
            const label = t(`playerPresets.${mode}`);
            const tone = tones.createEl("button", { cls: "clickable-icon", attr: { type: "button", title: label, "aria-label": label, "data-preset-tone": mode, "aria-pressed": String((this.plugin.settings.playerPresetTone || "system") === mode) } });
            setIcon(tone, mode === "system" ? "sun-moon" : mode === "light" ? "sun" : "moon");
            tone.addEventListener("click", () => { this.plugin.settings.playerPresetTone = mode; this.refreshPresetAppearance(); void this.plugin.saveData(this.plugin.settings).catch(() => new Notice(t("library.failed"))); });
          }
        }
        if (selected && glass) {
          const label = t("playerPresets.glass"), toggle = card.createEl("button", { cls: "mw-preset-glass", attr: { type: "button", role: "switch", title: label, "aria-label": label, "aria-checked": String(!!this.plugin.settings.playerColorGlass) } });
          setIcon(toggle.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } }), "blend");
          toggle.createSpan({ cls: "mw-preset-switch", attr: { "aria-hidden": "true" } });
          toggle.addEventListener("click", () => {
            this.plugin.settings.playerColorGlass = !this.plugin.settings.playerColorGlass;
            toggle.setAttr("aria-checked", String(this.plugin.settings.playerColorGlass));
            this.refreshPresetAppearance(false); preview.dataset.mwVinyl = this.plugin.settings.playerColorGlass ? "colorGlass" : "color";
            void this.plugin.saveData(this.plugin.settings).catch(() => new Notice(t("library.failed")));
          });
        }
      }
    }
  }

  private buildDrawer(body: HTMLElement): SideDrawer {
    const drawer = new SideDrawer(body, () => {
      const open = !!this.drawer?.isOpen();
      this.styleBtn?.toggleClass("is-active", open);
      // 抽屉与上拉曲目面板互斥：都占右侧/底部，同时开会互相遮挡
      if (open) { this.togglePlaylist(false); this.togglePopover(null); }
      if (open) this.applyCaseAppearance();
    });
    drawer.register("settings", t("playerPresets.title"), (panel) => {
      this.buildStyleTabs(panel);
      if (this.presetGroup() !== "custom") { this.buildPresetOptions(panel); return; }
      // 样式：与音乐墙上四种样式同一套缩略预览（无专辑时给默认封面，别再空砖）
      const cover = (this.displayAlbum()?.cover ?? "") || DEFAULT_COVER;
      const secStyle = panel.createDiv({ cls: "mw-panel__section" });
      secStyle.createDiv({
        cls: "mw-panel__label",
        text: t("player.style"),
      });
      const grid = secStyle.createDiv({ cls: "mw-preset-grid mw-preset-grid--3" });
      let caseSection: HTMLElement | null = null;
      let vinylSection: HTMLElement | null = null;
      let refreshMachine = () => {};
      for (const s of PLAYER_STYLES) {
        grid.appendChild(
          buildStyleTile(s, styleLabel(s), cover, this.discStyle === s, (picked) => {
            this.discStyle = picked; this.plugin.settings.playerCustomStyle = picked as "vinyl" | "cd" | "cover";
            void this.plugin.saveData(this.plugin.settings);
            // 清空 albumKey 让 updateNow 立即重建设备与曲目列表
            this.albumKey = "\0";
            this.updateNow();
            refreshMachine();
            grid
              .querySelectorAll<HTMLElement>(".mw-preset")
              .forEach((el) =>
                el.toggleClass("is-active", el.dataset.mwStyle === picked)
              );
          })
        );
      }

      const machineSection = panel.createDiv({ cls: "mw-panel__section mw-machine-options" });
      const machineButton = machineSection.createEl("button", { cls: "clickable-icon mw-machine-toggle", attr: { type: "button", role: "switch" } });
      const machineLabel = machineButton.createSpan();
      const machineIcon = machineButton.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } });
      const switchSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      switchSvg.setAttribute("viewBox", "0 0 44 26"); switchSvg.setAttribute("aria-hidden", "true");
      const switchTrack = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      switchTrack.setAttribute("x", "1"); switchTrack.setAttribute("y", "1"); switchTrack.setAttribute("width", "42"); switchTrack.setAttribute("height", "24"); switchTrack.setAttribute("rx", "12"); switchTrack.setAttribute("class", "mw-machine-switch__track");
      const switchThumb = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      switchThumb.setAttribute("cx", "13"); switchThumb.setAttribute("cy", "13"); switchThumb.setAttribute("r", "9"); switchThumb.setAttribute("class", "mw-machine-switch__thumb");
      switchSvg.append(switchTrack, switchThumb); machineIcon.appendChild(switchSvg);
      refreshMachine = () => {
        machineSection.toggleClass("is-hidden", this.discStyle === "cover");
        const enabled = this.showMachine();
        const label = t(this.discStyle === "cd" ? "playerMachine.cd" : "playerMachine.vinyl");
        machineLabel.setText(label); machineButton.setAttr("aria-label", label);
        machineButton.setAttr("aria-checked", String(enabled)); machineButton.toggleClass("is-active", enabled);
        caseSection?.toggleClass("is-hidden", this.discStyle === "cover" || !enabled);
        vinylSection?.toggleClass("is-hidden", this.discStyle !== "vinyl" || enabled);
      };
      machineButton.addEventListener("click", () => {
        if (this.discStyle === "cover") return;
        const key = this.discStyle === "cd" ? "playerCdMachine" : "playerVinylMachine";
        this.plugin.settings[key] = !this.showMachine();
        this.albumKey = "\0"; this.updateNow(); refreshMachine();
        void this.plugin.saveData(this.plugin.settings);
      });

      vinylSection = panel.createDiv({ cls: "mw-panel__section mw-vinyl-options" });
      vinylSection.createDiv({ cls: "mw-panel__label", text: t("vinylFinish.title") });
      const finishes = vinylSection.createDiv({ cls: "mw-preset-grid mw-vinyl-grid" });
      for (const finish of ["black", "white", "color", "blackGlass", "whiteGlass", "colorGlass"] as const) {
        const button = finishes.createEl("button", { cls: "mw-preset", attr: { type: "button", "aria-label": t(`vinylFinish.${finish}`), "aria-pressed": String((this.plugin.settings.playerVinylFinish || "black") === finish) } });
        button.dataset.vinylFinish = finish; button.toggleClass("is-active", (this.plugin.settings.playerVinylFinish || "black") === finish);
        const swatch = button.createDiv({ cls: "mw-vinyl-swatch", attr: { "aria-hidden": "true" } }); swatch.dataset.mwVinyl = finish;
        swatch.createSpan({ cls: "mw-vinyl-swatch__disc" });
        button.createSpan({ cls: "mw-preset__label", text: t(`vinylFinish.${finish}`) });
        button.addEventListener("click", () => {
          if (this.discStyle !== "vinyl" || this.showMachine()) return;
          this.plugin.settings.playerVinylFinish = finish; this.applyCaseAppearance();
          for (const tile of Array.from(finishes.querySelectorAll<HTMLElement>("[data-vinyl-finish]"))) {
            const selected = tile.dataset.vinylFinish === finish; tile.toggleClass("is-active", selected); tile.setAttr("aria-pressed", String(selected));
          }
          void this.plugin.saveData(this.plugin.settings);
        });
      }

      caseSection = panel.createDiv({ cls: "mw-panel__section mw-case-options" });
      caseSection.toggleClass("is-hidden", this.discStyle === "cover");
      caseSection.createDiv({ cls: "mw-panel__label", text: t("case.title") });
      const cases = caseSection.createDiv({ cls: "mw-preset-grid mw-case-grid" });
      for (const choice of ["white", "black", "wood", "art"] as DeviceCase[]) {
        const tile = cases.createEl("button", { cls: "mw-preset", attr: { type: "button", "aria-label": t(`case.${choice}`), "aria-pressed": String((this.plugin.settings.playerCase || "black") === choice) } });
        tile.dataset.caseChoice = choice;
        tile.toggleClass("is-active", (this.plugin.settings.playerCase || "black") === choice);
        const sample = tile.createDiv({ cls: "mw-case-sample", attr: { "aria-hidden": "true" } }); sample.dataset.mwCase = choice;
        tile.createSpan({ cls: "mw-preset__label", text: t(`case.${choice}`) });
        tile.addEventListener("click", () => {
          this.plugin.settings.playerCase = choice; this.applyCaseAppearance();
          for (const button of Array.from(cases.querySelectorAll<HTMLElement>("[data-case-choice]"))) {
            const active = button.dataset.caseChoice === choice; button.toggleClass("is-active", active); button.setAttr("aria-pressed", String(active));
          }
          void this.plugin.saveData(this.plugin.settings);
        });
      }
      refreshMachine();
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
    this.el.artist = meta.createEl("button", { cls: "mw-np__artist", attr: { type: "button" } });
    this.el.artist.addEventListener("click", () => { void this.openCurrentArtist().catch(() => new Notice(t("library.failed"))); });
    const line = meta.createDiv({ cls: "mw-np__line" });
    this.el.status = line.createSpan({ cls: "mw-np__status" });

    const timeline = stack.createDiv({ cls: "mw-np__timeline is-hidden" });
    this.el.timeline = timeline;
    this.el.elapsed = timeline.createSpan({ text: "0:00" });
    const seek = timeline.createEl("input", { cls: "mw-range", attr: { type: "range", min: "0", max: "1", step: "0.1", "aria-label": t("internal.seek") } });
    this.el.seek = seek;
    decorateRange(seek);
    seek.addEventListener("pointerdown", () => { seek.dataset.dragging = "true"; });
    seek.addEventListener("input", () => { paintRange(seek); this.el.elapsed?.setText(fmtClock(Number(seek.value) * 1000)); });
    seek.addEventListener("change", () => {
      seek.dataset.dragging = "false";
      void this.plugin.nowPlaying.seek(Number(seek.value) * 1000);
    });
    for (const event of ["pointerup", "pointercancel", "blur"]) seek.addEventListener(event, () => { seek.dataset.dragging = "false"; });
    this.el.duration = timeline.createSpan({ text: "0:00" });

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

    const listControls = controls.createDiv({ cls: "mw-np__list-controls" });
    this.el.btnOrder = listControls.createEl("button", {
      cls: "mw-np__ctrl is-hidden", attr: { type: "button", "data-action": "play-order" },
    });
    this.el.btnOrder.addEventListener("click", () => {
      if (this.plugin.internalPlayer) cyclePlayOrder(this.plugin.internalPlayer);
    });

    this.el.btnPlaylist = listControls.createEl("button", {
      cls: "mw-np__ctrl mw-np__ctrl--list",
      text: "",
    });
    setIcon(this.el.btnPlaylist, "list");
    this.el.btnPlaylist.title = t("player.playlistTip");
    this.el.btnPlaylist.addEventListener("click", () =>
      this.togglePlaylist(!this.playlistOpen)
    );
    this.el.btnPlaylist.setAttr("aria-label", t("player.playlistTip"));
    this.el.btnPlaylist.setAttr("aria-expanded", "false");

    const volumeAnchor = listControls.createDiv({ cls: "mw-np__popover-anchor is-hidden" });
    this.el.volumeAnchor = volumeAnchor;
    const volumeButton = volumeAnchor.createEl("button", { cls: "mw-np__ctrl", attr: {
      "aria-label": t("internal.volume"), "aria-expanded": "false", title: t("internal.volume"),
    } });
    this.el.btnVolume = volumeButton;
    setIcon(volumeButton, "volume-2");
    volumeButton.addEventListener("click", () => this.togglePopover(this.popover === "volume" ? null : "volume"));
    const volumePanel = volumeAnchor.createDiv({ cls: "mw-np__popover mw-np__volume-panel is-hidden", attr: { role: "group", "aria-label": t("internal.volume") } });
    this.el.volumePanel = volumePanel;
    const volume = volumePanel.createEl("input", { cls: "mw-range", attr: { type: "range", min: "0", max: "1", step: "0.01", "aria-label": t("internal.volume") } });
    this.el.volume = volume;
    decorateRange(volume, true);
    volume.addEventListener("input", () => this.plugin.internalPlayer?.setVolume(Number(volume.value)));

    const qualityAnchor = stack.createDiv({ cls: "mw-np__popover-anchor mw-np__quality is-hidden" });
    this.el.qualityAnchor = qualityAnchor;
    const qualityButton = qualityAnchor.createEl("button", { cls: "mw-np__quality-button", attr: {
      "aria-label": t("quality.choose"), "aria-expanded": "false", "aria-haspopup": "true",
    } });
    this.el.btnQuality = qualityButton;
    this.el.qualityLabel = qualityButton.createSpan();
    setIcon(qualityButton.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } }), "chevron-down");
    qualityButton.addEventListener("click", () => this.togglePopover(this.popover === "quality" ? null : "quality"));
    this.el.qualityPanel = qualityAnchor.createDiv({ cls: "mw-np__popover mw-np__quality-panel is-hidden", attr: { role: "group", "aria-label": t("quality.choose") } });
  }

  private togglePopover(next: "volume" | "quality" | null): void {
    this.popover = next;
    if (next) { this.togglePlaylist(false); this.drawer?.close(); }
    for (const name of ["volume", "quality"] as const) {
      const open = next === name;
      this.el[`${name}Panel`]?.toggleClass("is-hidden", !open);
      const button = this.el[name === "volume" ? "btnVolume" : "btnQuality"];
      button?.setAttr("aria-expanded", String(open)); button?.toggleClass("is-active", open);
    }
  }

  private updateQuality(): void {
    const player = this.plugin.internalPlayer;
    if (!player || !this.el.qualityPanel) return;
    this.el.qualityLabel?.setText(player.quality ? qualityLabel(player.quality) : "…");
    this.el.btnQuality?.setAttr("title", player.quality ? t("quality.actual", { quality: qualityLabel(player.quality) }) : t("quality.loading"));
    const key = `${player.availableQualities.join()}|${player.quality}|${player.preferredQuality}|${player.loading}`;
    if (key === this.qualityKey) return;
    this.qualityKey = key;
    const panel = this.el.qualityPanel; panel.empty();
    for (const quality of [...player.availableQualities].reverse()) {
      const button = panel.createEl("button", { cls: "mw-np__quality-option", attr: { "aria-pressed": String(player.quality === quality) } });
      button.createSpan({ text: qualityLabel(quality) });
      if (player.quality === quality) setIcon(button.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } }), "check");
      button.dataset.quality = quality;
      button.disabled = player.loading;
      button.addEventListener("click", () => void this.changeQuality(quality));
    }
    if (!player.availableQualities.length) panel.createSpan({ text: "…", attr: { "aria-label": t("quality.loading") } });
  }

  private async changeQuality(quality: AudioQuality): Promise<void> {
    const player = this.plugin.internalPlayer;
    const songId = player.state.songId;
    this.togglePopover(null);
    if (!(await this.plugin.ensureNeteaseLogin())) return;
    if (player.state.songId !== songId) return;
    await player.setQuality(quality);
  }

  /** 上拉面板的开关（面板覆盖在 page 之上，点遮罩/Esc 收起） */
  private togglePlaylist(open: boolean): void {
    this.playlistOpen = open;
    if (open) { this.drawer?.close(); this.togglePopover(null); }
    this.el.panel?.toggleClass("is-open", open);
    this.el.scrim?.toggleClass("is-open", open);
    this.el.btnPlaylist?.toggleClass("is-active", open);
    this.el.btnPlaylist?.setAttr("aria-expanded", String(open));
  }

  private buildPlaylist(panel: HTMLElement): void {
    const head = panel.createDiv({ cls: "mw-player__playlist-head" });
    this.el.tracksTitle = head.createSpan({
      cls: "mw-player__playlist-title",
      text: t("player.tracks"),
    });
    const close = head.createEl("button", { cls: "mw-player__playlist-close" });
    setIcon(close, "chevron-down");
    close.title = t("player.closePlaylist");
    close.addEventListener("click", () => this.togglePlaylist(false));
    if (this.plugin.internalPlayer) this.queueControls = new QueueControls(panel.createDiv(), this.plugin.internalPlayer, () => this.plugin.ensureNeteaseLogin(), () => { this.updateTrackList(); this.updateHighlights(); });
    this.el.tracks = panel.createDiv({ cls: "mw-np__tracks" });
    this.updateTrackList();
  }

  /** 曲目列表重建；仅内置播放支持点击切歌，客户端歌单顺序不受影响。 */
  private updateTrackList(): void {
    const host = this.el.tracks;
    if (!host) return;
    host.empty();
    this.trackRows = [];
    const album = this.plugin.settings.playbackMode === "internal" && this.queueControls ? this.queueControls.collection : this.displayAlbum();
    const tracks = album?.tracks ?? [];
    const internal = this.plugin.settings.playbackMode === "internal";
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
        const collection = this.plugin.internalPlayer.album;
        const play = () => void (async () => {
          if (this.queueControls) await this.queueControls.selectTrack(i);
          else if (await this.plugin.ensureNeteaseLogin() && this.plugin.internalPlayer.album === collection) await this.plugin.internalPlayer.select(i);
        })();
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
    this.playerLyrics?.update(this.now);
    const artistContext = this.currentArtistContext();
    if (artistContext !== this.artistContext) {
      this.artistContext = artistContext; this.artistRequest++;
      this.artistPicker?.close(); this.artistPicker = null;
    }
    this.applyCaseAppearance();
    const album = this.displayAlbum();
    if (this.el.fullCover) this.el.fullCover.style.backgroundImage = `url("${sizedCover(album?.cover || DEFAULT_COVER, 1200)}")`;
    const albumKey = album ? `${album.albumId}|${album.playlistId ?? ""}|${album.cover}|${this.plugin.internalPlayer?.revision || 0}|${this.discStyle ?? "def"}|${this.showMachine()}` : "";
    if (albumKey !== this.albumKey) {
      this.albumKey = albumKey;
      this.renderDisc(album);
      const previewCover = sizedCover(album?.cover || DEFAULT_COVER, 300);
      for (const image of Array.from(this.contentEl.querySelectorAll<HTMLImageElement>(".mw-style-preview img"))) image.src = previewCover;
      for (const background of Array.from(this.contentEl.querySelectorAll<HTMLElement>(".mw-style-preview__background, .mw-style-preview__cover"))) background.style.backgroundImage = `url("${previewCover}")`;
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
      (this.el.artist as HTMLButtonElement).disabled = !this.now.active || !this.now.songId;
      this.el.artist.textContent = this.now.active
        ? this.now.artist || t("common.unknownArtist")
        : album
          ? album.artist || t("common.unknownArtist")
          : t("player.dragHint");
    }
    if (this.el.status) this.el.status.textContent = this.statusText();
    this.updateSource();

    const paused = this.now.status !== "playing" && !(this.now.source === "internal" && this.plugin.internalPlayer?.loading && this.plugin.internalPlayer.playingRequested);
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
    this.el.btnOrder?.toggleClass("is-hidden", !internal);
    if (this.el.btnOrder && this.plugin.internalPlayer) updatePlayOrderButton(this.el.btnOrder, this.plugin.internalPlayer);
    this.el.timeline?.toggleClass("is-hidden", !internal);
    this.el.volumeAnchor?.toggleClass("is-hidden", !internal);
    this.el.qualityAnchor?.toggleClass("is-hidden", !internal);
    if (!internal) this.togglePopover(null);
    if (internal && this.el.seek) {
      const seek = this.el.seek as HTMLInputElement;
      seek.max = String(Math.max(1, this.now.durationMs / 1000));
      if (seek.dataset.dragging !== "true") seek.value = String(this.now.positionMs / 1000);
      paintRange(seek);
      seek.disabled = !this.now.seekable;
      seek.setAttr("aria-valuetext", `${fmtClock(this.now.positionMs)} / ${fmtClock(this.now.durationMs)}`);
      this.el.elapsed?.setText(fmtClock(this.now.positionMs));
      this.el.duration?.setText(fmtClock(this.now.durationMs));
      if (this.el.volume && document.activeElement !== this.el.volume) {
        (this.el.volume as HTMLInputElement).value = String(this.plugin.internalPlayer?.volume ?? 1);
      }
      paintRange(this.el.volume as HTMLInputElement);
      this.el.volume?.setAttr("aria-valuetext", `${Math.round((this.plugin.internalPlayer?.volume ?? 1) * 100)}%`);
      const volume = this.plugin.internalPlayer?.volume ?? 1;
      const icon = volume === 0 ? "volume-x" : volume < .5 ? "volume-1" : "volume-2";
      if (this.el.btnVolume && icon !== this.volumeIcon) { this.volumeIcon = icon; setIcon(this.el.btnVolume, icon); }
      this.updateQuality();
    }

    this.updateHighlights();
  }
  private currentArtistContext(): string {
    return `${this.now.active}|${this.now.source}|${this.now.songId || 0}|${this.plugin.settings.neteaseCookie}`;
  }
  private async openCurrentArtist(): Promise<void> {
    const id = this.now.active && this.now.songId;
    if (!id) return;
    const context = this.currentArtistContext(), request = ++this.artistRequest;
    const valid = () => !!this.shell && request === this.artistRequest && context === this.currentArtistContext();
    this.artistPicker?.close(); this.artistPicker = null;
    const track = this.plugin.internalPlayer?.album?.tracks?.find(track => track.id === id);
    const refs = track?.artistRefs?.length ? track.artistRefs :
      (await this.plugin.libraryApi.songs([id], this.plugin.settings.neteaseCookie))[0]?.artistRefs || [];
    if (!valid()) return;
    const artists = [...new Map(refs.filter(artist => artist.id > 0).map(artist => [artist.id, artist])).values()];
    const open = async (index: number) => {
      if (valid()) await this.plugin.openLibraryArtist({ ...artists[index], cover: "" });
    };
    if (artists.length === 1) await open(0);
    else if (artists.length > 1) {
      this.artistPicker = new PickerModal(this.app, t("libraryDetails.chooseArtist"),
        artists.map(artist => ({ label: artist.name, icon: "mic" })),
        index => { void open(index).catch(() => new Notice(t("library.failed"))); });
      this.artistPicker.open();
    }
  }

  private statusText(): string {
    if (this.now.source === "internal") {
      const player = this.plugin.internalPlayer;
      if (player?.error) return player.error;
      if (player?.loading) return t("internal.loading");
      const status = t(this.now.status === "playing" ? "player.stPlaying" : this.now.status === "paused" ? "player.stPaused" : "player.stStopped");
      return `${status}${player?.trial ? ` · ${t("internal.trial")}` : ""}`;
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
    this.trackRows.forEach((row, i) => row.toggleClass("is-current", this.queueControls ? this.queueControls.isCurrent(i) : i === idx));
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
    const device = buildDevice(pseudo, this.discStyle, 500, this.showMachine());
    this.readoutEl = device.readout;
    host.appendChild(device.root);
  }

  private applyCaseAppearance(): void {
    const preset = this.preset();
    const root = this.contentEl, choice = preset?.deviceCase || this.plugin.settings.playerCase || "black";
    root.dataset.mwVinyl = this.discStyle === "vinyl" && this.showMachine()
      ? choice === "art" ? "color" : "black"
      : preset?.finish || this.plugin.settings.playerVinylFinish || "black";
    if (root.dataset.mwCase !== choice) root.dataset.mwCase = choice;
    if (choice !== "art" && !["color", "colorGlass"].includes(root.dataset.mwVinyl) && !this.drawer?.isOpen()) return;
    const cover = this.displayAlbum()?.cover || DEFAULT_COVER;
    const key = sizedCover(cover, 300);
    if (this.caseToneKey === key) return;
    this.caseToneKey = key;
    root.style.setProperty("--mw-case-accent", "#596773");
    root.style.setProperty("--mw-style-tag-fg", presetForeground("#596773"));
    void coverTone(key).then(tone => {
      if (this.caseToneKey !== key) return;
      const accent = tone.accent || (tone.luma !== null && tone.luma >= .5 ? "#b4b6b8" : "#51555b");
      root.style.setProperty("--mw-case-accent", accent); root.style.setProperty("--mw-style-tag-fg", presetForeground(accent));
    });
  }
  private showMachine(): boolean {
    if (this.preset()) return this.preset()!.machine;
    return (this.discStyle === "cd" ? this.plugin.settings.playerCdMachine : this.plugin.settings.playerVinylMachine) !== false;
  }

  private syncLayout(): void {
    if (!this.shell) return;
    const w = this.contentEl.clientWidth || 0;
    const portrait = w > 0 && w < this.contentEl.clientHeight;
    this.contentEl.toggleClass("mw-player--portrait", portrait);
    this.contentEl.toggleClass("mw-player--cover-lyrics", this.fullLyrics);
    if (this.el.coverToggle) {
      this.el.coverToggle.toggleClass("is-hidden", !this.preset()?.fullCover || !portrait);
      this.el.coverToggle.setAttr("aria-pressed", String(this.fullLyrics));
      this.el.coverToggle.setAttr("aria-label", t(this.fullLyrics ? "playerPresets.showCover" : "playerPresets.showLyrics"));
      this.el.coverToggle.title = t(this.fullLyrics ? "playerPresets.showCover" : "playerPresets.showLyrics");
    }
    this.contentEl.toggleClass("mw-player--lyrics-stacked", w > 0 && w / (this.plugin.settings.zoomScale || 1) < 620);
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
    const pausing = action === "pause" || (action === "toggle" && (this.now.status === "playing" || this.now.source === "internal" && this.plugin.internalPlayer?.playingRequested));
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

  private updateSource(): void {
    const meta = this.plugin.internalPlayer?.album || this.matchedAlbum() || this.current?.meta;
    const source = this.el.source; if (!source) return;
    const wall = meta?.playbackWallPath;
    const kind = wall ? "wallAlbum" : meta?.playlistId || this.plugin.internalPlayer?.contentKind === "playlist" ? "playlist" : "album";
    source.setText(meta ? `${t(`libraryDetails.${kind}`)}·${meta.name}` : "");
    source.title = source.textContent || ""; source.toggleClass("is-hidden", !meta);
  }
  private async openSource(): Promise<void> {
    const meta = this.plugin.internalPlayer?.album || this.matchedAlbum() || this.current?.meta;
    if (!meta) return;
    if (meta.playbackWallPath) {
      await this.plugin.revealWallAlbum(meta.playbackWallPath, meta.albumId);
    } else await this.plugin.openLibraryCollection(meta);
  }
}
