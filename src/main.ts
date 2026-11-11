import { normalizePlayerPresets } from "./ui/playerPresets";
import { effectiveZoom } from "./ui/zoom";
import { suppressHoverHints } from "./ui/hoverHints";
import type { WorkspaceLeaf } from "obsidian";
// Music Wall 插件主入口：注册扩展名/视图/命令/设置，并实现
// 网络请求适配、创建/导入/导出/Git 导入等服务。

import {
  Notice,
  Platform,
  Plugin,
  requestUrl,
  setIcon,
} from "obsidian";
import {
  DEFAULT_SETTINGS,
  PLAYER_VIEW_TYPE,
  LIBRARY_VIEW_TYPE,
  ZOOM_CSS_VAR,
  clampZoom,
  type AlbumMeta,
  type MusicWallSettings,
  type WallItem,
} from "./types";
import type { Requester } from "./core/metadata";
import {
  fetchAlbumDetail as fetchAlbumDetailApi,
} from "./core/metadata";
import { wallCollectionId } from "./core/collection";
import { WallLibraryStore, WALL_LIBRARY_PATH, addSaved, addSongs, clonePlaylist, folderPath, type WallKind } from "./core/wallLibrary";
import { WallDestinationModal } from "./ui/WallDestinationModal";
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
import { PlaybackSessionStore } from "./core/playbackSession";
import { clearCoverToneCache } from "./ui/accent";
import { LyricsService } from "./core/lyrics";
import { InternalPlayer, CombinedNowPlayingProvider } from "./core/internalPlayer";
import {
  createNowPlayingProvider,
  type NowPlayingProvider,
} from "./core/nowPlaying";
import { MusicPlayerView } from "./ui/MusicPlayerView";
import { MusicLibraryView } from "./ui/MusicLibraryView";
import { MusicLibraryApi } from "./core/library";
import { NeteaseLoginModal } from "./ui/NeteaseLoginModal";
import { PickerModal } from "./ui/smallModals";
import { MusicWallSettingTab } from "./settings";
import { applyLanguagePref, t } from "./i18n";

/** 构建标识：启动时打印到控制台，用于确认当前运行版本 */
const BUILD_TAG = "1.4.0-exp-5";


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
  wallLibrary: WallLibraryStore;
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
  private statusEl: HTMLElement | null = null;
  /** 库内全部 .mw 条目缓存（播放器匹配用），vault 变动时失效 */
  private loginModal: NeteaseLoginModal | null = null;
  private loginPromise: Promise<boolean> | null = null;
  private ensureLoginPromise: Promise<boolean> | null = null;
  private authGeneration = 0;
  private playbackRequest = 0;
  private verifiedCookie = "";
  private verifiedAt = 0;
  private loginCheck: { cookie: string; promise: Promise<boolean> } | null = null;
  private unloading = false;
  private playbackSessionStore: PlaybackSessionStore | null = null;
  private gitSyncModal: GitSyncModal | null = null;
  private githubWallReader: GitHubWallReader | null = null;
  private githubAuth = new GitHubAuth();
  private githubLoginModal: GitHubLoginModal | null = null;
  private githubLoginPromise: Promise<boolean> | null = null;

  async onload(): Promise<void> {
    this.registerDomEvent(document, "mouseover", suppressHoverHints, true);
    console.log(`[music-wall] loaded, build ${BUILD_TAG}`);
    await this.loadSettings();
    this.wallLibrary = new WallLibraryStore(this.app.vault.adapter, WALL_LIBRARY_PATH, this.settings.defaultStyle);
    try { await this.wallLibrary.ready(); }
    catch (error) { new Notice(t("localWall.dataFailed")); throw error; }

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

    this.libraryApi = new MusicLibraryApi(this.requester);
    this.collectionStatsCache = new CollectionStatsCache(this.app.vault.adapter, `${this.app.vault.configDir}/plugins/${this.manifest.id}/collection-stats-cache.json`);
    this.lyrics = new LyricsService(this.requester, this.app.vault.adapter, `${this.app.vault.configDir}/plugins/${this.manifest.id}/lyrics-cache.json`);
    this.historyStore = new HistoryStore(this.app.vault.adapter, `${this.app.vault.configDir}/plugins/${this.manifest.id}/history.json`);
    await this.historyStore.ready();
    this.playbackSessionStore = new PlaybackSessionStore(this.app.vault.adapter, `${this.app.vault.configDir}/plugins/${this.manifest.id}/playback-session.json`);
    const savedSession = this.settings.playbackMode === "internal" ? await this.playbackSessionStore.load() : null;
    if (savedSession) this.internalPlayer.restoreSession(savedSession);
    this.playbackSessionStore.watch(this.internalPlayer, savedSession?.playing);
    let resumeSession = savedSession?.playing ?? false;
    this.register(this.internalPlayer.on(() => { resumeSession = false; }));
    this.app.workspace.onLayoutReady(() => {
      if (!resumeSession || this.unloading || this.settings.playbackMode !== "internal" || !hasLoginCookie(this.settings.neteaseCookie)) return;
      resumeSession = false;
      void this.internalPlayer.play();
    });
    // Register only after services are ready: Obsidian may immediately restore
    // the last active player/library as soon as its view factory is registered.
    this.registerView(PLAYER_VIEW_TYPE, (leaf) => new MusicLibraryView(leaf, this));
    this.registerView(LIBRARY_VIEW_TYPE, (leaf) => new MusicLibraryView(leaf, this));
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

    this.addRibbonIcon("library", t("localWall.title"), () => void this.openLibraryView());
    this.addCommand({ id: "open-library", name: t("localWall.title"), callback: () => void this.openLibraryView() });
    this.addCommand({ id: "open-player", name: t("cmd.openPlayer"), callback: () => void this.openPlayerView() });

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

    this.registerEvent(this.app.vault.on("modify", file => {
      if (file.path === WALL_LIBRARY_PATH) void this.wallLibrary.reload().catch(() => new Notice(t("localWall.dataFailed")));
    }));
  }

  onunload(): void {
    void this.playbackSessionStore?.dispose();
    void this.historyStore?.flush().catch(() => {});
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
    delete (this.settings as MusicWallSettings & { lyricsContrastThreshold?: number }).lyricsContrastThreshold;
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
    const scale = effectiveZoom(this.settings.zoomScale ?? 1);
    document.body.style.setProperty(ZOOM_CSS_VAR, String(scale));
    // 只有真的放大时才给弹窗加尺寸上限（见 base.css 的 .mw-modal-zoom 说明）：
    // z = 1 时若也设 92vw/88vh，会把弹窗自己的宽度（如 .mw-album-modal 的 680px）
    // 与主题给弹窗的默认宽度一起顶掉。
    document.body.toggleClass("mw-zoomed", Math.abs(scale - 1) > 0.001);
    // 缩放变化要同步两个视图的缩放盒像素尺寸（CSS calc 之外的兜底，
    // 见 zoom.ts syncZoomBox：补偿退化的表现就是右侧/底部留白）
    for (const view of this.allPlayerViews()) view.syncZoomBox();
    for (const leaf of this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)) (leaf.view as MusicLibraryView).syncZoomBox();
  }

  refreshLibraryLayouts(source?: MusicLibraryView): void {
    for (const leaf of this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)) {
      if (leaf.view !== source) (leaf.view as MusicLibraryView).refresh();
    }
  }

  refreshOpenViews(): void {
    for (const view of this.allPlayerViews()) view.refresh();
    for (const leaf of this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)) (leaf.view as MusicLibraryView).refresh();
  }
  allPlayerViews(): MusicPlayerView[] {
    return this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE).flatMap(l => {
      const player = (l.view as MusicLibraryView).embeddedPlayer;
      return player ? [player] : [];
    });
  }

  /** 收藏条目快照，供播放器匹配正在播放的曲目。 */
  async scanWallItems(): Promise<WallItem[]> {
    return this.wallLibrary.data.entries.flatMap(e => {
      const c = this.wallLibrary.data.collections.find(c => c.id === e.collection); if (!c || c.kind === "local") return [];
      return [{ albumId: wallCollectionId(c.meta), meta: c.meta, source: "search" as const, locked: true, addedAt: e.addedAt, rating: e.rating }];
    });
  }


  /** 首个已打开的播放器页（用于「加入播放器」） */
  firstPlayerView(): MusicPlayerView | null {
    const views = this.allPlayerViews();
    return views.length ? views[0] : null;
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
    await this.openLibraryView();
    const view = this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)[0]?.view;
    if (view instanceof MusicLibraryView) await view.expandPlayer();
  }
  async returnFromPlayer(): Promise<void> {
    for (const leaf of this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)) {
      if (leaf.view instanceof MusicLibraryView) await leaf.view.collapsePlayer();
    }
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
  async revealWallAlbum(_path: string, albumId: number): Promise<void> {
    const entry = this.wallLibrary.data.entries.find(e => this.wallLibrary.data.collections.some(c => c.id === e.collection && wallCollectionId(c.meta) === albumId));
    if (entry) await this.revealLocalEntry(entry.id);
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
    const generation = this.authGeneration;
    meta = await this.fetchCollectionDetail(meta);
    if (generation !== this.authGeneration || this.unloading) return;
    if (meta.playlistId || meta.localPlaylistId) { this.internalPlayer.enqueuePlaylist(meta); new Notice(t("queue.playlistAdded")); return; }
    new Notice(t(this.internalPlayer.enqueueAlbum(meta) ? "queue.added" : "queue.duplicate"));
  }
  /** Search results can be collected into any wall without binding the library to a file. */
  addLibraryAlbum(meta: AlbumMeta): void {
    const kind: WallKind = meta.playlistId ? "playlists" : "albums";
    if (kind === "albums" ? !(meta.albumId > 0) : !(meta.playlistId! > 0)) return;
    const data = this.wallLibrary.data;
    const key = `${kind}:${meta.playlistId || meta.albumId}`;
    const saved = new Set(data.entries.filter(e => e.collection === key).map(e => e.folder));
    new WallDestinationModal(this.app, t("localWall.selectFolder"), [
      { id: null, name: t(`localWall.${kind}`), icon: kind === "albums" ? "disc" : "bookmark", disabled: saved.has(null) },
      ...data.folders.filter(f => f.kind === kind).map(f => ({ id: f.id, name: folderPath(data, f.id), disabled: saved.has(f.id) })),
    ], async folder => {
      const added = await this.saveLocalCollection(meta, folder);
      new Notice(t(added ? "localWall.saved" : "localWall.duplicate"));
    }).open();
  }
  async saveLocalCollection(meta: AlbumMeta, folder: string | null): Promise<boolean> {
    return this.wallLibrary.update(d => !!addSaved(d, meta, folder));
  }
  cloneLocalPlaylist(meta: AlbumMeta): void {
    const data = this.wallLibrary.data;
    new WallDestinationModal(this.app, t("localWall.selectFolder"), [
      { id: null, name: t("localWall.local"), icon: "list-music" },
      ...data.folders.filter(f => f.kind === "local").map(f => ({ id: f.id, name: folderPath(data, f.id) })),
    ], async folder => {
      const full = await this.fetchCollectionDetail(meta);
      await this.wallLibrary.update(d => { clonePlaylist(d, full, folder); });
      new Notice(t("localWall.saved"));
    }).open();
  }
  addSongsToLocalPlaylist(songs: import("./types").AlbumTrackSnapshot[]): void {
    if (!songs.length) return;
    const data = this.wallLibrary.data;
    const playlists = data.collections.filter(c => c.kind === "local");
    if (!playlists.length) { new Notice(t("localWall.emptyPlaylists")); return; }
    new WallDestinationModal(this.app, t("localWall.selectPlaylist"), playlists.map(c => {
      const ids = new Set(c.meta.tracks?.map(s => s.id));
      const disabled = songs.every(s => ids.has(s.id));
      const entry = data.entries.find(e => e.collection === c.id);
      return { id: c.id, name: c.meta.name, detail: disabled ? t("localWall.songExists") : folderPath(data, entry?.folder || null), disabled, icon: "list-music" };
    }), async id => {
      const count = await this.wallLibrary.update(d => addSongs(d, id!, songs));
      new Notice(t("localWall.addedSongs", { count }));
    }).open();
  }
  async revealLocalEntry(id: string): Promise<void> {
    const entry = this.wallLibrary.data.entries.find(e => e.id === id);
    const collection = this.wallLibrary.data.collections.find(c => c.id === entry?.collection);
    if (!entry || !collection) return;
    await this.openLibraryView();
    const view = this.app.workspace.getLeavesOfType(LIBRARY_VIEW_TYPE)[0]?.view;
    if (view instanceof MusicLibraryView) { await view.collapsePlayer(); view.showWall(collection.kind, entry.folder, entry.id); }
  }

  async fetchAlbumDetail(albumId: number): Promise<AlbumMeta> {
    return fetchAlbumDetailApi(
      this.requester,
      albumId,
      this.settings.neteaseCookie || undefined
    );
  }

  /** Fetch details on every open/play; wall metadata is only a display snapshot. */
  async fetchCollectionDetail(meta: AlbumMeta): Promise<AlbumMeta> {
    if (meta.localPlaylistId) {
      const c = this.wallLibrary.data.collections.find(c => c.id === meta.localPlaylistId && c.kind === "local");
      if (!c) throw new Error(t("localWall.failed"));
      return { ...c.meta, wallEntryId: meta.wallEntryId };
    }
    let detail: AlbumMeta;
    if (meta.playlistId && meta.playlistId > 0) {
      detail = await this.libraryApi.detail({ id: meta.playlistId, name: meta.name, creator: meta.artist, cover: meta.cover, count: meta.trackCount, owner: 0, special: 0 }, this.settings.neteaseCookie);
    } else if (!meta.playlistId && meta.albumId > 0) detail = await this.fetchAlbumDetail(meta.albumId);
    else return meta;
    return { ...detail, playbackWallPath: meta.playbackWallPath, wallEntryId: meta.wallEntryId };
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
      loadCollection: meta => this.fetchCollectionDetail(meta),
      playInside: this.settings.playbackMode !== "client" && this.internalPlayer
        ? async (meta, startIndex) => {
          if (!isCurrent()) return false;
          const collection = wallPath ? { ...meta, playbackWallPath: wallPath } : meta;
          return meta.playlistId || meta.localPlaylistId ? this.internalPlayer.playPlaylist(collection, startIndex) : this.internalPlayer.playAlbum(collection, startIndex);
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

