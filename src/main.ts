import { normalizePlayerPresets } from "./ui/playerPresets";
import type { WorkspaceLeaf } from "obsidian";
// Music Wall 插件主入口：注册扩展名/视图/命令/设置，并实现
// 网络请求适配、创建/导入/导出/Git 导入等服务。

import {
  Notice,
  Platform,
  Plugin,
  TFile,
  TFolder,
  requestUrl,
  setIcon,
} from "obsidian";
import {
  DEFAULT_SETTINGS,
  PLAYER_VIEW_TYPE,
  LIBRARY_VIEW_TYPE,
  WALL_DRAG_MIME,
  WALL_EXT,
  WALL_VIEW_TYPE,
  ZOOM_CSS_VAR,
  clampZoom,
  type AlbumMeta,
  type AlbumSummary,
  type MusicWallData,
  type MusicWallSettings,
  type WallItem,
} from "./types";
import type { Requester } from "./core/metadata";
import {
  fetchAlbumDetail as fetchAlbumDetailApi,
  searchAlbums as searchAlbumsApi,
} from "./core/metadata";
import { emptyWall, insertItem, mergeWalls, parseWall } from "./core/store";
import { checkGit } from "./core/git";
import { LoginDiagnosticError } from "./core/loginDiagnostics";
import { qrLoginRequester } from "./core/mobileLoginRequest";
import { GitHubAuth } from "./core/githubAuth";
import { GitHubLoginModal } from "./ui/GitHubLoginModal";
import { prepareVaultSync } from "./core/vaultWallSync";
import { GitHubWallReader, checkPullCancelled } from "./core/githubWallPull";
import { prepareMobileVaultPull } from "./core/mobileVaultWallSync";
import { syncPath, type SyncDirection } from "./core/wallSync";
import { GitSyncModal } from "./ui/GitSyncModal";
import { hasLoginCookie, listUserPlaylists, LoginRequiredError, verifyCookie } from "./core/playlist";
import type { PlaybackDeps } from "./core/playback";
import { SongSourceResolver } from "./core/audioSource";
import { isAudioQuality } from "./core/quality";
import { AudioTransport } from "./core/audioTransport";
import { CollectionStatsCache } from "./core/collectionStatsCache";
import { HistoryStore } from "./core/history";
import { clearCoverToneCache } from "./ui/accent";
import { LyricsService } from "./core/lyrics";
import { InternalPlayer, CombinedNowPlayingProvider } from "./core/internalPlayer";
import {
  createNowPlayingProvider,
  type NowPlayingProvider,
} from "./core/nowPlaying";
import { MusicWallView } from "./ui/MusicWallView";
import { MusicPlayerView } from "./ui/MusicPlayerView";
import { MusicLibraryView } from "./ui/MusicLibraryView";
import { MusicLibraryApi } from "./core/library";
import { InputModal } from "./ui/InputModal";
import { ConfirmModal } from "./ui/ConfirmModal";
import { NeteaseLoginModal } from "./ui/NeteaseLoginModal";
import { ChoiceModal, PickerModal, type ChoiceOption } from "./ui/smallModals";
import { WallTreePickerModal } from "./ui/WallTreePickerModal";
import { MusicWallSettingTab } from "./settings";
import { applyLanguagePref, styleLabel, t } from "./i18n";

/** 构建标识：启动时打印到控制台，用于确认当前运行版本 */
const BUILD_TAG = "1.3.2";

function normalizePathJoin(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

export default class MusicWallPlugin extends Plugin {
  settings: MusicWallSettings = DEFAULT_SETTINGS;
  /** 插件内音频优先；无内部队列时保留原 SMTC 正在播放服务。 */
  nowPlaying: NowPlayingProvider;
  internalPlayer: InternalPlayer;
  private combinedProvider: CombinedNowPlayingProvider;
  private requester: Requester;
  private audioSources: SongSourceResolver;
  audioTransport: AudioTransport | null = null;
  libraryApi: MusicLibraryApi;
  collectionStatsCache: CollectionStatsCache;
  historyStore: HistoryStore;
  historyScope(): string { return this.settings.neteaseUserId || "guest"; }
  async clearManagedCache(kind: "lyrics" | "stats" | "cover" | "playback" | "search" | "all"): Promise<void> {
    if (kind === "lyrics" || kind === "all") await this.lyrics.clear();
    if (kind === "stats" || kind === "all") {
      await this.collectionStatsCache.clear();
      for (const leaf of this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)) if (leaf.view instanceof MusicLibraryView) leaf.view.clearStatsMemory();
    }
    if (kind === "cover" || kind === "all") clearCoverToneCache();
    if (kind === "playback" || kind === "search") await this.historyStore.clear(undefined, kind);
    if (kind === "all") { await this.historyStore.clear(); await this.audioTransport?.clear(); this.audioSources?.clear(); this.libraryApi.clear(); }
  }
  lyrics: LyricsService;
  private openingLibrary: Promise<void> | null = null;
  private playerReturn: { leaf: WorkspaceLeaf; view: unknown; restore: () => Promise<void> } | null = null;
  private returningPlayer = false;
  private openingPlayer: Promise<void> | null = null;
  private statusEl: HTMLElement | null = null;
  /** 库内全部 .mw 条目缓存（播放器匹配用），vault 变动时失效 */
  private wallItemCache: WallItem[] | null = null;
  private wallItemScan: Promise<WallItem[]> | null = null;
  private wallCacheTimer = 0;
  private loginModal: NeteaseLoginModal | null = null;
  private loginPromise: Promise<boolean> | null = null;
  private ensureLoginPromise: Promise<boolean> | null = null;
  private authGeneration = 0;
  private playbackRequest = 0;
  private verifiedCookie = "";
  private verifiedAt = 0;
  private loginCheck: { cookie: string; promise: Promise<boolean> } | null = null;
  private unloading = false;
  private gitSyncModal: GitSyncModal | null = null;
  private githubWallReader: GitHubWallReader | null = null;
  private githubAuth = new GitHubAuth();
  private githubLoginModal: GitHubLoginModal | null = null;
  private githubLoginPromise: Promise<boolean> | null = null;

  async onload(): Promise<void> {
    console.log(`[music-wall] loaded, build ${BUILD_TAG}`);
    await this.loadSettings();

    this.requester = async (req) => {
      const res = await requestUrl({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        throw: false,
      });
      return { status: res.status, text: res.text, headers: res.headers };
    };
    this.audioSources = new SongSourceResolver(this.requester);
    if (Platform.isDesktopApp) {
      const adapter = this.app.vault.adapter as { getBasePath?: () => string };
      this.audioTransport = new AudioTransport(adapter.getBasePath?.() || this.app.vault.getName?.() || "default", () => this.settings.audioCacheMB, typeof location === "undefined" ? "app://obsidian.md" : location.origin);
    }
    this.internalPlayer = new InternalPlayer({
      defaultQuality: () => this.settings.defaultAudioQuality,
      pauseFade: () => this.settings.pauseFadeSeconds,
      crossFade: () => this.settings.crossFadeSeconds,
      webAudio: Platform.isDesktopApp,
      ...(this.audioTransport?.supported ? { open: (source: import("./core/audioSource").SongSource, id: number, durationMs: number, signal: AbortSignal) => this.audioTransport!.open(source, { account: this.settings.neteaseUserId || this.settings.neteaseCookie, song: id, durationMs }, signal) } : {}),
      resolve: async (id, quality) => {
        try { return await this.audioSources.resolve(id, this.settings.neteaseCookie, quality); }
        catch (error) {
          if (error instanceof LoginRequiredError) this.verifiedCookie = "";
          throw error;
        }
      },
      load: async (url, mime) => {
        // 宿主请求可携带 Referer，避免 WebView 的跨域/防盗链限制；只在内存中缓冲当前曲目。
        const response = await requestUrl({ url, headers: { Referer: "https://music.163.com/" }, throw: false });
        if (response.status < 200 || response.status >= 300 || !response.arrayBuffer.byteLength) {
          throw new Error(t("internal.networkError"));
        }
        return new Blob([response.arrayBuffer], { type: mime ?? "audio/mpeg" });
      },
      notice: (message) => { new Notice(message); },
    });
    this.internalPlayer.setVolume(this.settings.playerVolume ?? 1);
    this.internalPlayer.order = this.settings.playbackOrder;
    this.combinedProvider = new CombinedNowPlayingProvider(createNowPlayingProvider(), this.internalPlayer);
    this.nowPlaying = this.combinedProvider;
    this.nowPlaying.on(() => this.updateStatusBar());

    // 第二个参数必须是 registerView 注册的视图类型，Obsidian 据此关联 .mw → 音乐墙视图
    this.registerExtensions([WALL_EXT], WALL_VIEW_TYPE);
    this.registerView(WALL_VIEW_TYPE, (leaf) => new MusicWallView(leaf, this));

    this.registerView(PLAYER_VIEW_TYPE, (leaf) => new MusicPlayerView(leaf, this));
    this.registerView(LIBRARY_VIEW_TYPE, (leaf) => new MusicLibraryView(leaf, this));
    this.libraryApi = new MusicLibraryApi(this.requester);
    this.collectionStatsCache = new CollectionStatsCache(this.app.vault.adapter, `${this.app.vault.configDir}/plugins/${this.manifest.id}/collection-stats-cache.json`);
    this.lyrics = new LyricsService(this.requester, this.app.vault.adapter, `${this.app.vault.configDir}/plugins/${this.manifest.id}/lyrics-cache.json`);
    this.historyStore = new HistoryStore(this.app.vault.adapter, `${this.app.vault.configDir}/plugins/${this.manifest.id}/history.json`);
    await this.historyStore.ready();
    let lastSong = "", lastCollection = "";
    this.register(this.internalPlayer.on(() => {
      const state = this.internalPlayer.state, album = this.internalPlayer.album;
      if (!state.active || !album) { lastSong = ""; lastCollection = ""; return; }
      if (state.status !== "playing" || !state.songId) return;
      const scope = this.historyScope(), songKey = `${scope}/${state.songId}`;
      const track = album.tracks?.[this.internalPlayer.index];
      if (track && songKey !== lastSong) {
        lastSong = songKey;
        void this.historyStore.record(scope, "songs", { ...track, artists: track.artists || album.artist, cover: track.cover || album.cover, albumId: track.albumId || album.albumId, albumName: track.albumName || album.name }).catch(() => {});
      }
      const kind = this.internalPlayer.contentKind === "playlist" ? "playlists" : "albums";
      const collectionKey = `${scope}/${kind}/${kind === "playlists" ? album.playlistId : this.internalPlayer.currentEntryId}`;
      if (collectionKey !== lastCollection) { lastCollection = collectionKey; void this.historyStore.record(scope, kind, album).catch(() => {}); }
    }));

    this.addRibbonIcon("library", t("cmd.createWall"), () => {
      void this.createNewWallCommand();
    });
    this.addRibbonIcon("disc", t("cmd.openPlayer"), () => void this.openPlayerView());
    this.addRibbonIcon("list-music", t("library.title"), () => void this.openLibraryView());
    this.addCommand({ id: "open-library", name: t("library.title"), callback: () => void this.openLibraryView() });

    this.addCommand({
      id: "create-wall",
      name: t("cmd.createWallFile"),
      callback: () => void this.createNewWallCommand(),
    });
    this.addCommand({
      id: "open-player",
      name: t("cmd.openPlayer"),
      callback: () => void this.openPlayerView(),
    });
    this.addCommand({
      id: "search-add-album",
      name: t("cmd.addAlbum"),
      checkCallback: (checking) => {
        const view = this.activeWallView();
        if (!view) return false;
        if (!checking) view.openSearchModal();
        return true;
      },
    });
    this.addCommand({
      id: "export-wall",
      name: t("cmd.exportWall"),
      checkCallback: (checking) => {
        const view = this.activeWallView();
        if (!view) return false;
        if (!checking) void this.exportCurrentWall(view);
        return true;
      },
    });
    this.addCommand({
      id: "import-wall",
      name: t("cmd.importWall"),
      callback: () => void this.importMwFile(this.activeWallView()),
    });
    this.addCommand({
      id: "git-import-wall",
      name: t("gitSync.pullCommand"),
      callback: () => void this.gitSync("pull"),
    });
    this.addCommand({ id: "git-push-wall", name: t("gitSync.pushCommand"), callback: () => void this.gitSync("push") });

    this.addCommand({
      id: "pick-playback-playlist",
      name: t("cmd.pickPlaylist"),
      callback: () => void this.pickPlaybackPlaylist(),
    });
    this.addCommand({
      id: "toggle-internal-playback",
      name: t("internal.toggleCommand"),
      checkCallback: (checking) => {
        if (!this.internalPlayer.album) return false;
        if (!checking) void (async () => {
          if (this.internalPlayer.state.status === "playing" || await this.ensureNeteaseLogin()) {
            await this.internalPlayer.toggle();
          }
        })();
        return true;
      },
    });
    this.addCommand({
      id: "stop-internal-playback",
      name: t("internal.stopCommand"),
      checkCallback: (checking) => {
        if (!this.internalPlayer.album) return false;
        if (!checking) this.internalPlayer.stop();
        return true;
      },
    });

    this.addSettingTab(new MusicWallSettingTab(this.app, this));

    this.setupStatusBar();
    this.ensureNowPlayingStarted();
    this.applyZoom();

    // 文件列表右键文件夹/库根目录 → 直接新建「新的音乐墙.mw」并打开
    // （点开 .mw 文件由 registerExtensions + FileView 原生处理，无需 file-open 转换）
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, target) => {
        if (!(target instanceof TFolder)) return;
        menu.addItem((item) =>
          item
            .setTitle(t("cmd.createWall"))
            .setIcon("library")
            .onClick(() => void this.createNewWallIn(target))
        );
      })
    );

    // 库内 .mw 变动：失效播放器匹配缓存并稍后重绘播放器页
    const invalidate = () => this.invalidateWallItems();
    this.registerEvent(this.app.vault.on("modify", invalidate));
    this.registerEvent(this.app.vault.on("create", invalidate));
    this.registerEvent(this.app.vault.on("delete", invalidate));
    this.registerEvent(this.app.vault.on("rename", invalidate));

    // 拖拽迁移：唱片卡片可拖到文件列表中的 .mw 上（运行时事件，防御式注册）
    this.registerFileDrop();
  }

  onunload(): void {
    void this.historyStore?.flush().catch(() => {});
    this.playerReturn = null;
    void this.collectionStatsCache?.flush();
    this.unloading = true;
    ++this.authGeneration;
    ++this.playbackRequest;
    this.loginModal?.close();
    this.gitSyncModal?.close();
    this.githubLoginModal?.close();
    this.combinedProvider?.dispose();
    this.audioTransport?.close(); this.audioTransport = null;
    this.nowPlaying?.stop();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    normalizePlayerPresets(this.settings);
    this.settings.zoomScale = clampZoom(this.settings.zoomScale ?? 1);
    this.settings.minColumnWidth = 180;
    if (!["system", "light", "dark"].includes(this.settings.wallAppearance)) this.settings.wallAppearance = "system";
    this.settings.showGitSyncActions = this.settings.showGitSyncActions === true;
    if (this.settings.playbackMode !== "client") this.settings.playbackMode = "internal";
    if (!isAudioQuality(this.settings.defaultAudioQuality)) this.settings.defaultAudioQuality = "standard";
    this.settings.numericSeekEnabled = this.settings.numericSeekEnabled === true;
    this.settings.playerVolume = Number.isFinite(this.settings.playerVolume) ? Math.max(0, Math.min(1, this.settings.playerVolume)) : DEFAULT_SETTINGS.playerVolume;
    if (!["order", "repeat", "one", "shuffle"].includes(this.settings.playbackOrder)) this.settings.playbackOrder = DEFAULT_SETTINGS.playbackOrder;
    if (!["white", "black", "wood", "art"].includes(this.settings.playerCase)) this.settings.playerCase = "black";
    if (!["system", "light", "dark"].includes(this.settings.libraryAppearance)) this.settings.libraryAppearance = "system";
    const savedVinylFinish = this.settings.playerVinylFinish as string;
    if (savedVinylFinish === "glass") this.settings.playerVinylFinish = "whiteGlass";
    else if (!["black", "white", "color", "blackGlass", "whiteGlass", "colorGlass"].includes(savedVinylFinish)) this.settings.playerVinylFinish = "black";
    for (const field of ["pauseFadeSeconds", "crossFadeSeconds"] as const) this.settings[field] = Number.isFinite(this.settings[field]) ? Math.max(0, Math.min(6, this.settings[field])) : DEFAULT_SETTINGS[field];
    this.settings.audioCacheMB = Number.isFinite(this.settings.audioCacheMB) ? Math.max(0, Math.min(65536, Math.round(this.settings.audioCacheMB))) : DEFAULT_SETTINGS.audioCacheMB;
    applyLanguagePref(this.settings.language ?? "system");
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    applyLanguagePref(this.settings.language ?? "system");
    this.applySmtcSetting();
    this.refreshOpenViews();
  }

  /**
   * 只落盘缩放、不重建视图：滚轮缩放是连续操作，
   * 走 saveSettings 会连带 refreshOpenViews 把视图整页重绘（滚动位置与面板都会跳）。
   */
  async saveZoom(scale: number): Promise<void> {
    this.settings.zoomScale = clampZoom(scale);
    this.applyZoom();
    await this.saveData(this.settings);
  }

  /** 把缩放系数写到 body 的 CSS 变量上（视图与模态框都继承） */
  applyZoom(): void {
    const scale = clampZoom(this.settings.zoomScale ?? 1);
    document.body.style.setProperty(ZOOM_CSS_VAR, String(scale));
    // 只有真的放大时才给弹窗加尺寸上限（见 base.css 的 .mw-modal-zoom 说明）：
    // z = 1 时若也设 92vw/88vh，会把弹窗自己的宽度（如 .mw-album-modal 的 680px）
    // 与主题给弹窗的默认宽度一起顶掉。
    document.body.toggleClass("mw-zoomed", Math.abs(scale - 1) > 0.001);
    // 缩放变化要同步两个视图的缩放盒像素尺寸（CSS calc 之外的兜底，
    // 见 zoom.ts syncZoomBox：补偿退化的表现就是右侧/底部留白）
    for (const view of this.allWallViews()) view.syncZoomBox();
    for (const view of this.allPlayerViews()) view.syncZoomBox();
    for (const leaf of this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)) (leaf.view as MusicLibraryView).syncZoomBox();
  }

  refreshLibraryLayouts(source?: MusicLibraryView): void {
    for (const leaf of this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)) {
      if (leaf.view !== source) (leaf.view as MusicLibraryView).refresh();
    }
  }

  refreshOpenViews(): void {
    for (const view of this.allWallViews()) view.refresh();
    for (const view of this.allPlayerViews()) view.refresh();
    for (const leaf of this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)) (leaf.view as MusicLibraryView).refresh();
  }

  private allWallViews(): MusicWallView[] {
    return this.app.workspace
      .getLeavesOfType(WALL_VIEW_TYPE)
      .map((l) => l.view as MusicWallView);
  }

  refreshWallAppearance(): void {
    for (const view of this.allWallViews()) view.refreshAppearance();
  }
  allPlayerViews(): MusicPlayerView[] {
    return this.app.workspace
      .getLeavesOfType(PLAYER_VIEW_TYPE)
      .map((l) => l.view as MusicPlayerView);
  }

  // ================= SMTC / 播放器 =================

  /** 已打开墙的条目快照（同步，只覆盖已打开的墙） */
  openWallItems(): WallItem[] {
    const out: WallItem[] = [];
    for (const v of this.allWallViews()) {
      const d = v.getData();
      if (d) out.push(...d.items);
    }
    return out;
  }

  /** 库内全部 .mw 条目（异步扫描 + 缓存），供播放器匹配正在播放的曲目 */
  async scanWallItems(): Promise<WallItem[]> {
    if (this.wallItemCache) return this.wallItemCache;
    if (this.wallItemScan) return this.wallItemScan;
    this.wallItemScan = (async () => {
      const out: WallItem[] = [...this.openWallItems()];
      const seen = new Set(out.map((i) => `${i.albumId}`));
      for (const f of this.wallFiles()) {
        try {
          const data = parseWall(await this.app.vault.read(f));
          for (const item of data.items) {
            const key = `${item.albumId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(item);
          }
        } catch {
          /* 坏文件跳过 */
        }
      }
      this.wallItemCache = out;
      this.wallItemScan = null;
      return out;
    })();
    return this.wallItemScan;
  }

  private invalidateWallItems(): void {
    this.wallItemCache = null;
    if (this.wallCacheTimer) window.clearTimeout(this.wallCacheTimer);
    this.wallCacheTimer = window.setTimeout(() => {
      this.wallCacheTimer = 0;
      for (const v of this.allPlayerViews()) v.refresh();
    }, 600);
  }

  /** 首个已打开的播放器页（用于「加入播放器」） */
  firstPlayerView(): MusicPlayerView | null {
    const views = this.allPlayerViews();
    return views.length ? views[0] : null;
  }

  /** 墙上菜单「加入播放器」：无播放器打开时静默无操作（按约定不自动创建） */
  addToPlayer(item: WallItem, srcPath: string): void {
    void this.enqueueAlbum(item.meta);
  }

  /** 状态栏条目：显示正在播放并可点击打开播放器 */
  private setupStatusBar(): void {
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mw-statusbar");
    this.statusEl.setAttr("aria-label", t("main.statusOpenPlayer"));
    this.statusEl.addEventListener("click", () => void this.openPlayerView());
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    if (!this.statusEl) return;
    const s = this.nowPlaying?.state;
    if (s && s.active) {
      const icon = s.status === "playing" ? "play" : s.status === "paused" ? "pause" : "square";
      this.statusEl.empty();
      setIcon(this.statusEl.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } }), icon);
      this.statusEl.createSpan({ text: s.title || t("main.unknownTrack") });
      this.statusEl.setAttr("aria-label", `${s.title} · ${s.artist}`);
      this.statusEl.addClass("is-active");
    } else {
      this.statusEl.setText(t("main.statusPlayer"));
      this.statusEl.setAttr("aria-label", t("main.statusOpenPlayer"));
      this.statusEl.removeClass("is-active");
    }
  }

  private applySmtcSetting(): void {
    if (this.settings.smtcEnabled) this.ensureNowPlayingStarted();
    else {
      this.nowPlaying?.stop();
      this.updateStatusBar();
    }
  }

  /** 按需启动 SMTC 轮询（幂等） */
  ensureNowPlayingStarted(): void {
    if (!this.nowPlaying?.supported) return;
    if (!this.settings.smtcEnabled) return;
    this.nowPlaying.start();
  }

  async openPlayerView(source = this.app.workspace.activeLeaf): Promise<void> {
    if (source?.view instanceof MusicLibraryView) {
      const snapshot = source.view.captureReturnState();
      this.playerReturn = { leaf: source, view: source.view, restore: async () => {
        await this.openLibraryView();
        const target = this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)[0]?.view;
        if (target instanceof MusicLibraryView) await snapshot(target);
      } };
    } else if (source?.view instanceof MusicWallView && source.view.getFile()) {
      const path = source.view.getFile()!.path;
      this.playerReturn = { leaf: source, view: source.view, restore: async () => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) await this.openWall(file);
      } };
    } else if (!source || !(source.view instanceof MusicPlayerView)) this.playerReturn = null;
    if (this.openingPlayer) return this.openingPlayer;
    this.openingPlayer = this.openStandaloneView(PLAYER_VIEW_TYPE);
    try { await this.openingPlayer; } finally { this.openingPlayer = null; }
  }
  async returnFromPlayer(): Promise<void> {
    if (this.returningPlayer || !this.playerReturn || this.unloading) return;
    const source = this.playerReturn; this.returningPlayer = true;
    try {
      const leaves = this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE).concat(this.app.workspace.getLeavesOfType(WALL_VIEW_TYPE));
      if (leaves.includes(source.leaf) && source.leaf.view === source.view) await this.app.workspace.revealLeaf(source.leaf);
      else await source.restore();
      if (this.playerReturn === source) this.playerReturn = null;
    } finally { this.returningPlayer = false; }
  }
  async openLibraryView(): Promise<void> {
    if (this.openingLibrary) return this.openingLibrary;
    this.openingLibrary = this.openStandaloneView(LIBRARY_VIEW_TYPE);
    try { await this.openingLibrary; } finally { this.openingLibrary = null; }
  }
  async openLibraryCollection(meta: AlbumMeta): Promise<void> {
    await this.openLibraryView();
    const view = this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)[0]?.view;
    if (view instanceof MusicLibraryView) await view.showCollection(meta);
  }
  async openLibraryArtist(artist: { id: number; name: string; cover: string }): Promise<void> {
    await this.openLibraryView();
    const view = this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)[0]?.view;
    if (view instanceof MusicLibraryView) await view.showArtist(artist);
  }
  async revealWallAlbum(path: string, albumId: number): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) { new Notice(t("player.noSource")); return; }
    await this.openWall(file);
    this.allWallViews().find(view => view.getFile()?.path === path)?.revealAlbum(albumId);
  }
  private async openStandaloneView(type: string): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(type)[0];
    if (existing) { await this.app.workspace.revealLeaf(existing); return; }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.setViewState({ type, active: true }); await this.app.workspace.revealLeaf(leaf);
  }
  async enqueueAlbum(meta: AlbumMeta): Promise<void> {
    if (!(await this.ensureNeteaseLogin())) return;
    if (this.settings.playbackMode !== "internal") { new Notice(t("queue.internalOnly")); return; }
    new Notice(t(this.internalPlayer.enqueueAlbum(meta) ? "queue.added" : "queue.duplicate"));
  }
  /** Search results can be collected into any wall without binding the library to a file. */
  addLibraryAlbum(meta: AlbumMeta): void {
    const files = this.wallFiles();
    if (!files.length) { new Notice(t("library.noWalls")); return; }
    new WallTreePickerModal(this.app, t("library.addToWall"), files.map(file => ({ label: file.basename, path: file.path })), index => {
      const target = files[index]; if (!target || this.unloading) return;
      const open = this.allWallViews().find(view => view.getFile()?.path === target.path);
      if (open) { open.addAlbum(meta, "search"); return; }
      const item: WallItem = { albumId: meta.albumId, meta, source: "search", locked: true, addedAt: new Date().toISOString() };
      void (async () => {
        let added = false;
        await this.app.vault.process(target, content => {
          const data = parseWall(content); added = insertItem(data, item);
          return added ? JSON.stringify(data, null, 2) : content;
        });
        new Notice(t(added ? "wall.card.added" : "wall.card.alreadyIn", { name: meta.name }));
      })().catch(() => new Notice(t("library.failed")));
    }).open();
  }
  /** 解析来源墙中的条目（播放器接收拖拽用） */
  async resolveWallItem(srcPath: string, albumId: number): Promise<WallItem | null> {
    const open = this.allWallViews().find((v) => v.getFile()?.path === srcPath);
    const data = open?.getData();
    if (data) {
      const hit = data.items.find((i) => i.albumId === albumId);
      if (hit) return hit;
    }
    const file = this.app.vault.getAbstractFileByPath(srcPath);
    if (file instanceof TFile) {
      try {
        const parsed = parseWall(await this.app.vault.read(file));
        return parsed.items.find((i) => i.albumId === albumId) ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** 查找某专辑所在的音乐墙（播放器「定位到墙上唱片」用） */
  async findAlbumWall(
    albumId: number
  ): Promise<{ file: TFile; item: WallItem } | null> {
    for (const v of this.allWallViews()) {
      const file = v.getFile();
      const data = v.getData();
      if (!file || !data) continue;
      const item = data.items.find((i) => i.albumId === albumId);
      if (item) return { file, item };
    }
    const openPaths = new Set(
      this.allWallViews()
        .map((v) => v.getFile()?.path)
        .filter((p): p is string => !!p)
    );
    for (const file of this.wallFiles()) {
      if (openPaths.has(file.path)) continue;
      try {
        const data = parseWall(await this.app.vault.read(file));
        const item = data.items.find((i) => i.albumId === albumId);
        if (item) return { file, item };
      } catch {
        /* 坏文件跳过 */
      }
    }
    return null;
  }

  // ================= 迁移 =================

  /** 库内全部 .mw 文件（排除插件缓存目录与指定路径） */
  wallFiles(excludePath?: string): TFile[] {
    return this.app.vault
      .getFiles()
      .filter(
        (f) =>
          f.extension === WALL_EXT &&
          !f.path.startsWith(".obsidian/") &&
          f.path !== excludePath
      );
  }

  /** 将条目写入目标墙文件（查重）；重复或读写失败返回 false */
  async migrateItemInto(item: WallItem, target: TFile): Promise<boolean> {
    let data: MusicWallData;
    try {
      data = parseWall(await this.app.vault.read(target));
    } catch (e: any) {
      new Notice(t("main.readTargetFail", { error: e?.message ?? e }));
      return false;
    }
    if (!insertItem(data, item)) {
      new Notice(
        t("main.alreadyInTarget", {
          name: item.meta.name,
          wall: target.basename,
        })
      );
      return false;
    }
    try {
      await this.app.vault.modify(target, JSON.stringify(data, null, 2));
    } catch (e: any) {
      new Notice(
        t("main.writeTargetFail", { error: e?.message ?? e })
      );
      return false;
    }
    return true;
  }

  /** 拖拽迁移核心：从源视图移出条目并写入目标墙（file-drop 与墙内 drop 共用） */
  async receiveWallDrag(
    srcPath: string,
    albumId: number,
    target: TFile
  ): Promise<void> {
    await this.receiveWallBatch(srcPath, [albumId], target);
  }

  /** 批量拖拽迁移：多选拖拽与跨墙 drop 共用；重复跳过并汇总 */
  async receiveWallBatch(
    srcPath: string,
    albumIds: number[],
    target: TFile
  ): Promise<void> {
    const ids = [...new Set(albumIds.filter((x) => typeof x === "number"))];
    if (!ids.length) return;
    const src = this.allWallViews().find((v) => v.getFile()?.path === srcPath);
    if (!src) {
      new Notice(t("main.dragSourceLost"));
      return;
    }
    const data = src.getData();
    if (!data) return;
    const byId = new Map(data.items.map((i) => [i.albumId, i]));
    const items = ids.map((id) => byId.get(id)).filter((x): x is WallItem => !!x);
    if (!items.length) return;
    let okCount = 0;
    let skipCount = 0;
    const moved: number[] = [];
    for (const item of items) {
      if (await this.migrateItemInto(item, target)) {
        okCount++;
        moved.push(item.albumId);
      } else {
        skipCount++;
      }
    }
    if (moved.length) {
      // 批量移出源墙：一次落盘一次重绘
      await src.takeOutItems(moved);
    }
    if (items.length === 1) {
      const name = items[0].meta.name;
      if (okCount)
        new Notice(t("main.migratedOne", { name, target: target.basename }));
      return;
    }
    const parts = [
      t("main.migratedBatch", { ok: okCount, target: target.basename }),
    ];
    if (skipCount)
      parts.push(t("main.migrateSkipped", { count: skipCount }));
    new Notice(parts.join(t("main.listSep")));
  }

  /** 资源管理器文件落点（1.4+ 运行时事件，类型声明未收录，做防御式注册） */
  private registerFileDrop(): void {
    const ref = (this.app.workspace as any).on(
      "file-drop",
      (...args: unknown[]) => void this.onExplorerFileDrop(args)
    );
    if (ref) this.registerEvent(ref);
  }

  private async onExplorerFileDrop(args: unknown[]): Promise<void> {
    const file = args.find(
      (a: any) =>
        a && typeof a.extension === "string" && typeof a.path === "string"
    ) as TFile | undefined;
    if (!file || file.extension !== WALL_EXT) return;
    const dt = args.find(
      (a: any) => a && typeof a.getData === "function"
    ) as DataTransfer | undefined;
    const raw = dt?.getData(WALL_DRAG_MIME);
    if (!raw) return;
    const ev = args.find(
      (a: any) => a && typeof a.preventDefault === "function" && a !== dt
    ) as DragEvent | undefined;
    ev?.preventDefault();
    try {
      const p = JSON.parse(raw) as {
        srcPath: string;
        albumId?: number;
        albumIds?: number[];
      };
      const ids = Array.isArray(p.albumIds)
        ? p.albumIds.filter((x) => typeof x === "number")
        : typeof p.albumId === "number"
          ? [p.albumId]
          : [];
      if (!ids.length) return;
      if (p.srcPath !== file.path) {
        if (ids.length > 1) await this.receiveWallBatch(p.srcPath, ids, file);
        else await this.receiveWallDrag(p.srcPath, ids[0], file);
      }
    } catch {
      /* 载荷损坏：忽略 */
    }
  }

  /** 当前活动墙视图；找不到则返回 null（调用方给 Notice） */
  activeWallView(): MusicWallView | null {
    const active = this.app.workspace.getActiveViewOfType(MusicWallView);
    if (active) return active;
    const views = this.allWallViews();
    return views.length ? views[0] : null;
  }

  /** 在合适的新标签页打开 .mw 文件（视图类型由 registerExtensions 解析） */
  async openWall(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }

  // ================= 网络服务 =================

  async searchAlbums(keyword: string, offset: number): Promise<AlbumSummary[]> {
    return searchAlbumsApi(
      this.requester,
      keyword,
      offset,
      20,
      this.settings.neteaseCookie || undefined
    );
  }

  async fetchAlbumDetail(albumId: number): Promise<AlbumMeta> {
    return fetchAlbumDetailApi(
      this.requester,
      albumId,
      this.settings.neteaseCookie || undefined
    );
  }

  /** 供播放/详情面板使用的播放依赖 */
  getPlaybackDeps(wallPath?: string): PlaybackDeps {
    const pid = parseInt(this.settings.playbackPlaylistId, 10);
    const generation = this.authGeneration;
    const cookie = this.settings.neteaseCookie;
    const isCurrent = () => !this.unloading && generation === this.authGeneration && cookie === this.settings.neteaseCookie;
    return {
      isDesktop: Platform.isDesktopApp,
      request: this.requester,
      cookie: this.settings.neteaseCookie || undefined,
      playlistId: Number.isFinite(pid) && pid > 0 ? pid : undefined,
      authorize: async () => {
        const token = ++this.playbackRequest;
        if (!(await this.ensureNeteaseLogin()) || token !== this.playbackRequest) return null;
        const authorized = this.getPlaybackDeps(wallPath);
        return {
          ...authorized,
          authorize: undefined,
          isCurrent: () => token === this.playbackRequest && !!authorized.isCurrent?.(),
        };
      },
      isCurrent,
      playInside: this.settings.playbackMode !== "client" && this.internalPlayer
        ? async (meta, startIndex) => {
          if (!isCurrent()) return false;
          return this.internalPlayer.playAlbum(wallPath ? { ...meta, playbackWallPath: wallPath } : meta, startIndex);
        }
        : undefined,
      onPlaylistResolved: (id) => {
        if (!isCurrent()) return;
        this.settings.playbackPlaylistId = String(id);
        void this.saveSettings();
        new Notice(t("main.playlistResolved", { id }));
      },
    };
  }

  async setPlaybackMode(mode: "internal" | "client"): Promise<void> {
    ++this.playbackRequest;
    this.internalPlayer?.stop();
    this.settings.playbackMode = mode;
    await this.saveSettings();
  }

  /** 所有播放入口共用；保留有效旧 Cookie，明确失效时才重新扫码。 */
  ensureNeteaseLogin(forceCheck = false): Promise<boolean> {
    if (this.ensureLoginPromise) return this.ensureLoginPromise;
    const promise = this.ensureNeteaseLoginImpl(forceCheck).finally(() => {
      if (this.ensureLoginPromise === promise) this.ensureLoginPromise = null;
    });
    this.ensureLoginPromise = promise;
    return promise;
  }

  private async ensureNeteaseLoginImpl(forceCheck: boolean): Promise<boolean> {
    if (this.unloading) return false;
    const generation = this.authGeneration;
    const cookie = this.settings.neteaseCookie;
    if (hasLoginCookie(this.settings.neteaseCookie)) {
      try {
        return await this.verifySavedLogin(forceCheck);
      } catch (error) {
        if (this.unloading || generation !== this.authGeneration || cookie !== this.settings.neteaseCookie) return false;
        if (error instanceof LoginRequiredError) {
          try {
            await this.clearNeteaseLogin();
          } catch {
            new Notice(t("auth.saveFailed"));
            return false;
          }
          if (this.unloading || this.authGeneration !== generation + 1) return false;
        } else {
          new Notice(t("auth.verifyFailed"));
          return false;
        }
      }
    }
    return this.loginNetease();
  }

  private async verifySavedLogin(forceCheck: boolean): Promise<boolean> {
    const cookie = this.settings.neteaseCookie;
    const generation = this.authGeneration;
    if (!forceCheck && cookie === this.verifiedCookie && Date.now() - this.verifiedAt < 60_000) return true;
    if (this.loginCheck?.cookie === cookie) return this.loginCheck.promise;
    const promise = (async () => {
      const account = await verifyCookie(this.requester, cookie);
      if (this.unloading || generation !== this.authGeneration || cookie !== this.settings.neteaseCookie) return false;
      const uid = String(account.uid);
      const nickname = account.nickname || t("main.cookieLoggedIn");
      const previousUid = this.settings.neteaseUserId;
      if (previousUid !== uid || this.settings.neteaseNickname !== nickname) {
        this.settings.neteaseUserId = uid;
        this.settings.neteaseNickname = nickname;
        if (previousUid && previousUid !== uid) this.settings.playbackPlaylistId = "";
        await this.saveSettings();
      }
      if (this.unloading || generation !== this.authGeneration || cookie !== this.settings.neteaseCookie) return false;
      this.verifiedCookie = cookie;
      this.verifiedAt = Date.now();
      return true;
    })();
    this.loginCheck = { cookie, promise };
    try {
      return await promise;
    } finally {
      if (this.loginCheck?.promise === promise) this.loginCheck = null;
    }
  }

  /** 同时点击多个入口只打开一个弹窗，关闭后不会继续播放。 */
  loginNetease(): Promise<boolean> {
    if (this.unloading) return Promise.resolve(false);
    if (this.loginPromise) return this.loginPromise;
    const generation = this.authGeneration;
    const modal = new NeteaseLoginModal(this.app, qrLoginRequester(this.requester), async (cookie, valid) => {
      const account = await verifyCookie(this.requester, cookie);
      if (!valid() || this.unloading || generation !== this.authGeneration) return false;
      const previous = {
        neteaseCookie: this.settings.neteaseCookie,
        neteaseUserId: this.settings.neteaseUserId,
        neteaseNickname: this.settings.neteaseNickname,
        playbackPlaylistId: this.settings.playbackPlaylistId,
      };
      const uid = String(account.uid);
      if (previous.neteaseUserId && previous.neteaseUserId !== uid) this.settings.playbackPlaylistId = "";
      this.settings.neteaseCookie = cookie;
      this.settings.neteaseUserId = uid;
      this.settings.neteaseNickname = account.nickname || t("main.cookieLoggedIn");
      try {
        await this.saveSettings();
      } catch {
        if (generation === this.authGeneration) Object.assign(this.settings, previous);
        throw new LoginDiagnosticError("save", "storage", undefined, false);
      }
      if (!valid() || this.unloading || generation !== this.authGeneration) return false;
      this.verifiedCookie = cookie;
      this.verifiedAt = Date.now();
      new Notice(t("auth.signedIn", { name: this.settings.neteaseNickname }));
      return true;
    });
    this.loginModal = modal;
    const promise = modal.result.finally(() => {
      if (this.loginModal === modal) this.loginModal = null;
      if (this.loginPromise === promise) this.loginPromise = null;
    });
    this.loginPromise = promise;
    modal.open();
    return promise;
  }

  private async clearNeteaseLogin(): Promise<void> {
    this.audioSources?.clear();
    this.libraryApi?.clear();
    const generation = ++this.authGeneration;
    this.loginModal?.close();
    this.internalPlayer?.stop();
    this.loginCheck = null;
    this.verifiedCookie = "";
    this.verifiedAt = 0;
    const previous = {
      neteaseCookie: this.settings.neteaseCookie,
      neteaseUserId: this.settings.neteaseUserId,
      neteaseNickname: this.settings.neteaseNickname,
      playbackPlaylistId: this.settings.playbackPlaylistId,
    };
    this.settings.neteaseCookie = "";
    this.settings.neteaseUserId = "";
    this.settings.neteaseNickname = "";
    // 避免换账号后写入原账号的播放歌单；不会删除远端歌单。
    this.settings.playbackPlaylistId = "";
    try {
      await this.saveSettings();
    } catch (error) {
      if (generation === this.authGeneration) Object.assign(this.settings, previous);
      throw error;
    }
  }

  async logoutNetease(): Promise<void> {
    ++this.playbackRequest;
    this.ensureLoginPromise = null;
    await this.clearNeteaseLogin();
    new Notice(t("auth.signedOut"));
  }

  /** 验证当前 Cookie 登录态；成功返回昵称 */
  async verifyCookieNow(): Promise<string> {
    if (!(await this.ensureNeteaseLogin(true))) return "";
    const nickname = this.settings.neteaseNickname;
    new Notice(t("auth.signedIn", { name: nickname }));
    return nickname;
  }

  async pickPlaybackPlaylist(): Promise<void> {
    if (!(await this.ensureNeteaseLogin())) return;
    const generation = this.authGeneration;
    try {
      new Notice(t("main.readingPlaylists"));
      const list = await listUserPlaylists(
        this.requester,
        this.settings.neteaseCookie
      );
      if (generation !== this.authGeneration) return;
      if (!list.length) {
        new Notice(t("main.noPlaylists"));
        return;
      }
      new PickerModal(
        this.app,
        t("main.pickPlaylistTitle"),
        list.map((p) => ({
          label: p.name,
          detail: t("main.playlistTracks", {
            count: p.trackCount,
            id: p.id,
          }),
        })),
        (i) => {
          if (generation !== this.authGeneration) return;
          this.settings.playbackPlaylistId = String(list[i].id);
          void this.saveSettings();
          new Notice(t("main.playlistSet", { name: list[i].name }));
        }
      ).open();
    } catch (e: any) {
      new Notice(
        t("main.readPlaylistsFail", { error: e?.message ?? e })
      );
    }
  }

  // ================= 创建 / 导出 / 导入 =================

  private uniquePath(name: string, folder = "", ext = WALL_EXT): string {
    const prefix = folder ? `${folder}/` : "";
    let candidate = `${prefix}${name}.${ext}`;
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = `${prefix}${name} ${i}.${ext}`;
      i++;
    }
    return candidate;
  }

  async createNewWallCommand(): Promise<void> {
    new InputModal(
      this.app,
      t("main.createWallModal.title"),
      t("main.createWallModal.ph"),
      t("main.createWallModal.initial"),
      async (name) => {
        const path = this.uniquePath(name);
        const wall = emptyWall(name, this.settings.defaultStyle);
        await this.app.vault.create(path, JSON.stringify(wall, null, 2));
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) await this.openWall(f);
      }
    ).open();
  }

  /** 在指定文件夹（含库根）直接创建默认名音乐墙并打开 */
  async createNewWallIn(folder: TFolder): Promise<void> {
    const parent = folder.isRoot() ? "" : folder.path;
    const name = t("main.newWallName");
    const path = this.uniquePath(name, parent);
    const wall = emptyWall(name, this.settings.defaultStyle);
    await this.app.vault.create(path, JSON.stringify(wall, null, 2));
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.openWall(f);
  }

  async exportCurrentWall(view: MusicWallView): Promise<void> {
    const data = view.getData();
    const file = view.getFile();
    if (!data || !file) {
      new Notice(t("main.exportNone"));
      return;
    }
    // 导出到当前文件所在目录（分享副本）
    const parentDir = file.parent && file.parent.path !== "/"
      ? file.parent.path
      : "";
    new InputModal(
      this.app,
      t("main.exportWall.title"),
      t("main.exportWall.ph"),
      t("main.exportWall.defaultName", { name: file.basename }),
      async (name) => {
        const folderPrefix = parentDir ? `${parentDir}/` : "";
        const candidate = `${folderPrefix}${name}.${WALL_EXT}`;
        const target = this.app.vault.getAbstractFileByPath(candidate);
        const content = JSON.stringify(data, null, 2);
        if (target instanceof TFile) {
          new ConfirmModal(this.app, {
            title: t("main.exportOverwrite.title"),
            message: t("main.exportOverwrite.msg", { path: candidate }),
            details: [
              t("main.exportOverwrite.original", {
                size: target.stat.size,
                time: new Date(target.stat.mtime).toLocaleString(),
              }),
              t("main.exportOverwrite.incoming", {
                count: data.items.length,
              }),
            ],
            confirmText: t("main.exportOverwrite.confirm"),
            danger: true,
            onConfirm: async () => {
              await this.app.vault.modify(target, content);
              new Notice(t("main.exportedTo", { path: candidate }));
            },
          }).open();
        } else {
          await this.app.vault.create(candidate, content);
          new Notice(t("main.exportedTo", { path: candidate }));
        }
      }
    ).open();
  }

  async importMwFile(targetView: MusicWallView | null): Promise<void> {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `.${WALL_EXT},.json`;
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return;
      let data: MusicWallData;
      try {
        data = parseWall(await f.text());
      } catch (e: any) {
        new Notice(t("main.importFail", { error: e?.message ?? e }));
        return;
      }
      const options: ChoiceOption[] = [];
      if (targetView && targetView.getData()) {
        options.push({
          label: t("main.import.mergeLabel", {
            name:
              targetView.getFile()?.basename ?? t("main.importCurrent"),
          }),
          description: t("main.import.mergeDesc"),
          onSelect: async () => {
            const cur = targetView.getData()!;
            const { addedCount, skippedCount } = mergeWalls(cur, data);
            await targetView.saveData();
            new Notice(
              t("main.import.mergeDone", {
                added: addedCount,
                skipped: skippedCount,
              })
            );
          },
        });
      }
      options.push({
        label: t("main.import.createLabel"),
        description: t("main.import.createDesc"),
        onSelect: async () => {
          const path = this.uniquePath(
            data.name || t("main.import.defaultName")
          );
          await this.app.vault.create(path, JSON.stringify(data, null, 2));
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf(true);
            await leaf.openFile(file);
          }
          new Notice(t("main.import.created", { path }));
        },
      });
      new ChoiceModal(
        this.app,
        t("main.import.title"),
        t("main.import.info", {
          file: f.name,
          count: data.items.length,
          style: styleLabel(data.style),
        }),
        options
      ).open();
    });
    input.click();
  }

  // ================= 按目录预览并同步 .mw 文件 =================
  async loginGitHub(): Promise<boolean> {
    if (!Platform.isDesktopApp || this.unloading) { new Notice(t("main.git.desktopOnly")); return false; }
    if (this.githubLoginPromise) return this.githubLoginPromise;
    const previous = this.settings.githubAccount;
    this.githubLoginPromise = new Promise<boolean>(resolve => {
      this.githubLoginModal = new GitHubLoginModal(this.app, {
        selected: () => this.settings.githubAccount,
        inspect: signal => this.githubAuth.inspect(signal),
        login: signal => this.githubAuth.login(signal),
        select: async account => {
          if (this.unloading) throw new Error(t("githubAuth.cancelled"));
          const old = this.settings.githubAccount;
          this.settings.githubAccount = account;
          try { await this.saveData(this.settings); }
          catch (error) { this.settings.githubAccount = old; throw error; }
        },
      }, () => {
        this.githubLoginModal = null; this.githubLoginPromise = null;
        resolve(previous !== this.settings.githubAccount);
      });
      this.githubLoginModal.open();
    });
    return this.githubLoginPromise;
  }

  async gitSync(direction: SyncDirection = "pull"): Promise<void> {
    const desktop = Platform.isDesktopApp;
    if (!desktop && direction !== "pull") { new Notice(t("githubPull.pushUnavailable")); return; }
    if (this.unloading) return;
    if (this.gitSyncModal) { new Notice(t("gitSync.alreadyOpen")); return; }
    if (desktop && !(await checkGit())) {
      new Notice(t("main.git.gitNotFound"));
      return;
    }
    if (this.gitSyncModal || this.unloading) return;
    const basePath = (this.app.vault.adapter as any).basePath as string;
    if (desktop && !basePath) {
      new Notice(t("main.git.noBasePath"));
      return;
    }
    const relativeCache = `${this.app.vault.configDir}/plugins/${this.manifest.id}/wall-sync`;
    const cacheDir = desktop ? `${basePath}/${relativeCache}` : relativeCache;
    if (!desktop && !this.githubWallReader) this.githubWallReader = new GitHubWallReader(async url => {
      const response = await requestUrl({ url, method: "GET", headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, throw: false });
      return { status: response.status, text: response.text, headers: response.headers };
    });
    this.gitSyncModal = new GitSyncModal(this.app, {
      repoUrl: this.settings.gitRepoUrl, branch: this.settings.gitBranch,
      localDirectory: this.settings.gitLocalDir ?? "", remoteDirectory: this.settings.gitSubdir,
    }, async (config, mode, signal) => {
      checkPullCancelled(signal);
      config.localDirectory = syncPath(config.localDirectory); config.remoteDirectory = syncPath(config.remoteDirectory);
      if (!config.repoUrl.trim()) throw new Error(t("main.git.needUrl"));
      this.settings.gitRepoUrl = config.repoUrl.trim(); this.settings.gitBranch = config.branch.trim();
      this.settings.gitLocalDir = config.localDirectory; this.settings.gitSubdir = config.remoteDirectory;
      await this.saveData(this.settings);
      checkPullCancelled(signal);
      if (!desktop) {
        if (mode !== "pull") throw new Error(t("githubPull.pushUnavailable"));
        return prepareMobileVaultPull(this.app.vault, this.githubWallReader!, config, cacheDir, signal);
      }
      const account = this.settings.githubAccount;
      return prepareVaultSync(this.app.vault, cacheDir, config, mode, async repoUrl => {
        if (account !== this.settings.githubAccount || this.unloading) throw new Error(t("githubAuth.changed"));
        const args = await this.githubAuth.gitArguments(repoUrl, account);
        if (account !== this.settings.githubAccount || this.unloading) throw new Error(t("githubAuth.changed"));
        return args;
      });
    }, direction, () => { this.gitSyncModal = null; }, desktop ? { name: () => this.settings.githubAccount, open: () => this.loginGitHub() } : undefined, !desktop);
    this.gitSyncModal.open();
  }
}

