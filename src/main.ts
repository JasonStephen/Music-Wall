// Music Wall 插件主入口：注册扩展名/视图/命令/设置，并实现
// 网络请求适配、创建/导入/导出/Git 导入等服务。

import {
  Notice,
  Platform,
  Plugin,
  TFile,
  TFolder,
  requestUrl,
} from "obsidian";
import {
  DEFAULT_SETTINGS,
  PLAYER_FILE_VERSION,
  PLAYER_EXT,
  PLAYER_VIEW_TYPE,
  WALL_DRAG_MIME,
  WALL_EXT,
  WALL_VIEW_TYPE,
  ZOOM_CSS_VAR,
  clampZoom,
  type AlbumMeta,
  type AlbumSummary,
  type MusicWallData,
  type MusicWallSettings,
  type PlayerFile,
  type WallItem,
} from "./types";
import type { Requester } from "./core/metadata";
import {
  fetchAlbumDetail as fetchAlbumDetailApi,
  searchAlbums as searchAlbumsApi,
} from "./core/metadata";
import { emptyWall, insertItem, mergeWalls, parseWall } from "./core/store";
import { checkGit, listWallFiles, syncRepo, type GitWallFile } from "./core/git";
import { listUserPlaylists, verifyCookie } from "./core/playlist";
import type { PlaybackDeps } from "./core/playback";
import {
  createNowPlayingProvider,
  type NowPlayingProvider,
} from "./core/nowPlaying";
import { MusicWallView } from "./ui/MusicWallView";
import { MusicPlayerView } from "./ui/MusicPlayerView";
import { InputModal } from "./ui/InputModal";
import { ConfirmModal } from "./ui/ConfirmModal";
import { ChoiceModal, PickerModal, type ChoiceOption } from "./ui/smallModals";
import { MusicWallSettingTab } from "./settings";

/** Git 缓存目录（相对库根，位于 .obsidian 下不会污染用户笔记） */
const GIT_CACHE_SUBDIR = ".obsidian/plugins/music-wall/git-cache";
/** 构建标识：启动时打印到控制台，用于确认当前运行版本 */
const BUILD_TAG = "20260916-07";

function normalizePathJoin(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

export default class MusicWallPlugin extends Plugin {
  settings: MusicWallSettings = DEFAULT_SETTINGS;
  /** SMTC 正在播放服务（非 Windows/非桌面端为空实现） */
  nowPlaying: NowPlayingProvider;
  private requester: Requester;
  private statusEl: HTMLElement | null = null;
  /** 库内全部 .mw 条目缓存（播放器匹配用），vault 变动时失效 */
  private wallItemCache: WallItem[] | null = null;
  private wallItemScan: Promise<WallItem[]> | null = null;
  private wallCacheTimer = 0;

  async onload(): Promise<void> {
    console.log(`[music-wall] loaded, build ${BUILD_TAG}`);
    await this.loadSettings();

    this.nowPlaying = createNowPlayingProvider();
    this.nowPlaying.on(() => this.updateStatusBar());

    this.requester = async (req) => {
      const res = await requestUrl({
        url: req.url,
        method: req.method,
        headers: req.headers,
        body: req.body,
        throw: false,
      });
      return { status: res.status, text: res.text };
    };

    // 第二个参数必须是 registerView 注册的视图类型，Obsidian 据此关联 .mw → 音乐墙视图
    this.registerExtensions([WALL_EXT], WALL_VIEW_TYPE);
    this.registerView(WALL_VIEW_TYPE, (leaf) => new MusicWallView(leaf, this));

    // .mwp 播放器页：同样是 FileView，但文件内容只是标记，队列为运行时状态
    this.registerExtensions([PLAYER_EXT], PLAYER_VIEW_TYPE);
    this.registerView(PLAYER_VIEW_TYPE, (leaf) => new MusicPlayerView(leaf, this));

    this.addRibbonIcon("library", "新建音乐墙", () => {
      void this.createNewWallCommand();
    });

    this.addCommand({
      id: "create-wall",
      name: "新建音乐墙文件 (.mw)",
      callback: () => void this.createNewWallCommand(),
    });
    this.addCommand({
      id: "create-player",
      name: "新建音乐播放器文件 (.mwp)",
      callback: () => void this.createNewPlayerCommand(),
    });
    this.addCommand({
      id: "open-player",
      name: "打开音乐播放器",
      callback: () => void this.openPlayerView(),
    });
    this.addCommand({
      id: "search-add-album",
      name: "添加专辑（当前墙）",
      checkCallback: (checking) => {
        const view = this.activeWallView();
        if (!view) return false;
        if (!checking) view.openSearchModal();
        return true;
      },
    });
    this.addCommand({
      id: "export-wall",
      name: "导出当前音乐墙（分享副本）",
      checkCallback: (checking) => {
        const view = this.activeWallView();
        if (!view) return false;
        if (!checking) void this.exportCurrentWall(view);
        return true;
      },
    });
    this.addCommand({
      id: "import-wall",
      name: "导入 .mw 音乐墙文件",
      callback: () => void this.importMwFile(this.activeWallView()),
    });
    this.addCommand({
      id: "git-import-wall",
      name: "从 Git 仓库导入音乐墙",
      callback: () => {
        if (!Platform.isDesktopApp) {
          new Notice("Git 导入仅在桌面端可用");
          return;
        }
        void this.gitImport(this.activeWallView());
      },
    });

    this.addCommand({
      id: "pick-playback-playlist",
      name: "选择播放歌单（整专连播，需 Cookie）",
      callback: () => void this.pickPlaybackPlaylist(),
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
            .setTitle("新建音乐墙")
            .setIcon("library")
            .onClick(() => void this.createNewWallIn(target))
        );
        menu.addItem((item) =>
          item
            .setTitle("新建音乐播放器")
            .setIcon("disc")
            .onClick(() => void this.createNewPlayerIn(target))
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
    this.nowPlaying?.stop();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.zoomScale = clampZoom(this.settings.zoomScale ?? 1);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
  }

  refreshOpenViews(): void {
    for (const view of this.allWallViews()) view.refresh();
    for (const view of this.allPlayerViews()) view.refresh();
  }

  private allWallViews(): MusicWallView[] {
    return this.app.workspace
      .getLeavesOfType(WALL_VIEW_TYPE)
      .map((l) => l.view as MusicWallView);
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
    const view = this.firstPlayerView();
    if (!view) return;
    view.playInPlayer(item.meta, srcPath);
  }

  /** 状态栏条目：显示正在播放并可点击打开播放器 */
  private setupStatusBar(): void {
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass("mw-statusbar");
    this.statusEl.setAttr("aria-label", "打开音乐播放器");
    this.statusEl.addEventListener("click", () => void this.openPlayerView());
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    if (!this.statusEl) return;
    const s = this.nowPlaying?.state;
    if (s && s.active) {
      const icon = s.status === "playing" ? "▶" : s.status === "paused" ? "⏸" : "⏹";
      this.statusEl.setText(`${icon} ${s.title || "未知曲目"}`);
      this.statusEl.setAttr("aria-label", `${s.title} · ${s.artist}`);
      this.statusEl.addClass("is-active");
    } else {
      this.statusEl.setText("音乐播放器");
      this.statusEl.setAttr("aria-label", "打开音乐播放器");
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

  /** 库内全部 .mwp 文件 */
  playerFiles(): TFile[] {
    return this.app.vault
      .getFiles()
      .filter(
        (f) => f.extension === PLAYER_EXT && !f.path.startsWith(".obsidian/")
      );
  }

  /** 打开（或聚焦）播放器页：优先已打开的，其次库内第一个 .mwp */
  async openPlayerView(): Promise<void> {
    const views = this.allPlayerViews();
    if (views.length) {
      this.app.workspace.revealLeaf(views[0].leaf);
      return;
    }
    const files = this.playerFiles();
    if (!files.length) {
      new Notice("还没有播放器文件：先执行「新建音乐播放器文件 (.mwp)」");
      return;
    }
    await this.openWall(files[0]);
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
      new Notice("读取目标墙失败：" + (e?.message ?? e));
      return false;
    }
    if (!insertItem(data, item)) {
      new Notice(`《${item.meta.name}》已在《${target.basename}》中，迁移取消`);
      return false;
    }
    try {
      await this.app.vault.modify(target, JSON.stringify(data, null, 2));
    } catch (e: any) {
      new Notice("写入目标墙失败：" + (e?.message ?? e));
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
    const src = this.allWallViews().find((v) => v.getFile()?.path === srcPath);
    if (!src) {
      new Notice("拖拽源墙已不在前台标签中，请改用卡片右键「迁移到其他墙…」");
      return;
    }
    const data = src.getData();
    const item = data?.items.find((i) => i.albumId === albumId);
    if (!data || !item) return;
    if (!(await this.migrateItemInto(item, target))) return;
    await src.takeOutItem(albumId);
    new Notice(`已迁移《${item.meta.name}》→ ${target.basename}.mw`);
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
      const p = JSON.parse(raw) as { srcPath: string; albumId: number };
      if (p.srcPath !== file.path) await this.receiveWallDrag(p.srcPath, p.albumId, file);
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
  getPlaybackDeps(): PlaybackDeps {
    const pid = parseInt(this.settings.playbackPlaylistId, 10);
    return {
      isDesktop: Platform.isDesktopApp,
      request: this.requester,
      cookie: this.settings.neteaseCookie || undefined,
      playlistId: Number.isFinite(pid) && pid > 0 ? pid : undefined,
      onPlaylistResolved: (id) => {
        this.settings.playbackPlaylistId = String(id);
        void this.saveSettings();
        new Notice(`已自动设置播放歌单（ID ${id}）`);
      },
    };
  }

  /** 验证当前 Cookie 登录态；成功返回昵称 */
  async verifyCookieNow(): Promise<string> {
    if (!this.settings.neteaseCookie) {
      new Notice("尚未填写 Cookie");
      return "";
    }
    const { nickname } = await verifyCookie(
      this.requester,
      this.settings.neteaseCookie
    );
    new Notice(`Cookie 有效：${nickname || "已登录"}`);
    return nickname;
  }

  async pickPlaybackPlaylist(): Promise<void> {
    if (!this.settings.neteaseCookie) {
      new Notice("请先在设置中配置网易云 Cookie（登录态）");
      return;
    }
    try {
      new Notice("正在读取账号歌单…");
      const list = await listUserPlaylists(
        this.requester,
        this.settings.neteaseCookie
      );
      if (!list.length) {
        new Notice("账号下没有歌单，请先在网易云客户端创建一个");
        return;
      }
      new PickerModal(
        this.app,
        "选择作为播放列表的歌单（整张专辑将写入此歌单连播）",
        list.map((p) => ({
          label: p.name,
          detail: `${p.trackCount} 首 · ID ${p.id}`,
        })),
        (i) => {
          this.settings.playbackPlaylistId = String(list[i].id);
          void this.saveSettings();
          new Notice(`播放歌单已设为《${list[i].name}》`);
        }
      ).open();
    } catch (e: any) {
      new Notice("读取歌单失败：" + (e?.message ?? e));
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

  /** .mwp 内容：仅版本标记，播放队列不落盘 */
  private playerFileContent(): string {
    const marker: PlayerFile = { version: PLAYER_FILE_VERSION };
    return JSON.stringify(marker, null, 2);
  }

  async createNewPlayerCommand(): Promise<void> {
    new InputModal(
      this.app,
      "新建音乐播放器",
      "文件名（将成为 .mwp 文件）",
      "Music Player",
      async (name) => {
        const path = this.uniquePath(name, "", PLAYER_EXT);
        await this.app.vault.create(path, this.playerFileContent());
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f instanceof TFile) await this.openWall(f);
      }
    ).open();
  }

  /** 在指定文件夹（含库根）直接创建默认名播放器并打开 */
  async createNewPlayerIn(folder: TFolder): Promise<void> {
    const parent = folder.isRoot() ? "" : folder.path;
    const path = this.uniquePath("音乐播放器", parent, PLAYER_EXT);
    await this.app.vault.create(path, this.playerFileContent());
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.openWall(f);
  }

  async createNewWallCommand(): Promise<void> {
    new InputModal(
      this.app,
      "新建音乐墙",
      "墙名称（将成为 .mw 文件名）",
      "我的音乐墙",
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
    const name = "新的音乐墙";
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
      new Notice("当前没有可导出的音乐墙");
      return;
    }
    // 导出到当前文件所在目录（分享副本）
    const parentDir = file.parent && file.parent.path !== "/"
      ? file.parent.path
      : "";
    new InputModal(
      this.app,
      "导出音乐墙（分享副本）",
      "导出文件名（.mw）",
      `${file.basename} - 分享`,
      async (name) => {
        const folderPrefix = parentDir ? `${parentDir}/` : "";
        const candidate = `${folderPrefix}${name}.${WALL_EXT}`;
        const target = this.app.vault.getAbstractFileByPath(candidate);
        const content = JSON.stringify(data, null, 2);
        if (target instanceof TFile) {
          new ConfirmModal(this.app, {
            title: "导出覆盖确认",
            message: `目标文件已存在：${candidate}`,
            details: [
              `原文件：${target.stat.size} B · 修改于 ${new Date(
                target.stat.mtime
              ).toLocaleString()}`,
              `新内容：${data.items.length} 张专辑`,
            ],
            confirmText: "覆盖",
            danger: true,
            onConfirm: async () => {
              await this.app.vault.modify(target, content);
              new Notice(`已导出到 ${candidate}`);
            },
          }).open();
        } else {
          await this.app.vault.create(candidate, content);
          new Notice(`已导出到 ${candidate}`);
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
        new Notice("导入失败：" + (e?.message ?? e));
        return;
      }
      const options: ChoiceOption[] = [];
      if (targetView && targetView.getData()) {
        options.push({
          label: `合并进当前墙《${targetView.getFile()?.basename ?? "当前"}》`,
          description: "按专辑 ID 去重，现有条目不受影响",
          onSelect: async () => {
            const cur = targetView.getData()!;
            const { addedCount, skippedCount } = mergeWalls(cur, data);
            await targetView.saveData();
            new Notice(`导入完成：新增 ${addedCount}，跳过重复 ${skippedCount}`);
          },
        });
      }
      options.push({
        label: "创建为新的 .mw 音乐墙文件",
        description: "放在库根目录，重名将自动加后缀",
        onSelect: async () => {
          const path = this.uniquePath(data.name || "导入的音乐墙");
          await this.app.vault.create(path, JSON.stringify(data, null, 2));
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            const leaf = this.app.workspace.getLeaf(true);
            await leaf.openFile(file);
          }
          new Notice(`已创建 ${path}`);
        },
      });
      new ChoiceModal(
        this.app,
        "导入音乐墙文件",
        `${f.name} · ${data.items.length} 张专辑 · 样式「${data.style}」`,
        options
      ).open();
    });
    input.click();
  }

  // ================= Git 导入 =================

  async gitImport(targetView: MusicWallView | null): Promise<void> {
    if (!this.settings.gitRepoUrl) {
      new Notice("请先在设置中填写 Git 远程仓库地址");
      return;
    }
    if (!(await checkGit())) {
      new Notice("未检测到 git 命令。请安装 Git 并确保其在 PATH 中");
      return;
    }
    const basePath = (this.app.vault.adapter as any).basePath as string;
    if (!basePath) {
      new Notice("无法定位库路径");
      return;
    }
    const cacheDir = `${basePath}/${GIT_CACHE_SUBDIR}`;
    new Notice("正在从 Git 仓库拉取…");
    let files: GitWallFile[];
    try {
      await syncRepo(
        this.settings.gitRepoUrl,
        cacheDir,
        this.settings.gitBranch || undefined
      );
      files = await listWallFiles(cacheDir, this.settings.gitSubdir || undefined);
    } catch (e: any) {
      new Notice("Git 导入失败：" + (e?.message ?? e));
      return;
    }
    if (!files.length) {
      new Notice("仓库中未找到 .mw 音乐墙文件");
      return;
    }
    new PickerModal(
      this.app,
      "选择要导入的音乐墙",
      files.map((f) => ({
        label: f.name,
        detail: `${f.relPath} · ${(f.sizeBytes / 1024).toFixed(1)} KB`,
      })),
      (idx) => void this.applyGitFile(files[idx], targetView)
    ).open();
  }

  private async applyGitFile(
    file: GitWallFile,
    targetView: MusicWallView | null
  ): Promise<void> {
    let data: MusicWallData;
    try {
      data = parseWall(file.content);
    } catch (e: any) {
      new Notice("仓库中的文件不是合法音乐墙：" + (e?.message ?? e));
      return;
    }
    const baseName = file.name;
    const options: ChoiceOption[] = [];
    if (targetView && targetView.getData()) {
      options.push({
        label: `合并进当前墙《${targetView.getFile()?.basename}》`,
        description: "按专辑 ID 去重",
        onSelect: async () => {
          const { addedCount, skippedCount } = mergeWalls(
            targetView.getData()!,
            data
          );
          await targetView.saveData();
          new Notice(`Git 导入完成：新增 ${addedCount}，跳过重复 ${skippedCount}`);
        },
      });
    }
    options.push({
      label: `写入为库文件 ${baseName}`,
      description: "若同名文件已存在将覆盖（会再次确认）",
      onSelect: async () => {
        const existing = this.app.vault.getAbstractFileByPath(baseName);
        if (existing instanceof TFile) {
          new ConfirmModal(this.app, {
            title: "Git 导入覆盖确认",
            message: `库内已存在 ${baseName}，Git 导入将覆盖它`,
            details: [
              `本地：${existing.stat.size} B · ${new Date(
                existing.stat.mtime
              ).toLocaleString()}`,
              `仓库：${file.sizeBytes} B · ${data.items.length} 张专辑`,
            ],
            confirmText: "覆盖",
            danger: true,
            onConfirm: async () => {
              await this.app.vault.modify(existing, file.content);
              this.openWallFile(existing);
            },
          }).open();
        } else {
          await this.app.vault.create(baseName, file.content);
          new Notice(`已写入 ${baseName}`);
          const f = this.app.vault.getAbstractFileByPath(baseName);
          if (f instanceof TFile) this.openWallFile(f);
        }
      },
    });
    new ChoiceModal(
      this.app,
      `Git 导入 · ${baseName}`,
      `${data.items.length} 张专辑 · 样式「${data.style}」`,
      options
    ).open();
  }

  private openWallFile(file: TFile): void {
    void this.openWall(file);
  }
}
