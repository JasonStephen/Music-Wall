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
  WALL_EXT,
  WALL_VIEW_TYPE,
  type AlbumMeta,
  type AlbumSummary,
  type MusicWallData,
  type MusicWallSettings,
} from "./types";
import type { Requester } from "./core/metadata";
import {
  fetchAlbumDetail as fetchAlbumDetailApi,
  searchAlbums as searchAlbumsApi,
} from "./core/metadata";
import { emptyWall, mergeWalls, parseWall } from "./core/store";
import { checkGit, listWallFiles, syncRepo, type GitWallFile } from "./core/git";
import { listUserPlaylists, verifyCookie } from "./core/playlist";
import type { PlaybackDeps } from "./core/playback";
import { MusicWallView } from "./ui/MusicWallView";
import { InputModal } from "./ui/InputModal";
import { ConfirmModal } from "./ui/ConfirmModal";
import { ChoiceModal, PickerModal, type ChoiceOption } from "./ui/smallModals";
import { MusicWallSettingTab } from "./settings";

/** Git 缓存目录（相对库根，位于 .obsidian 下不会污染用户笔记） */
const GIT_CACHE_SUBDIR = ".obsidian/plugins/music-wall/git-cache";

function normalizePathJoin(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");
}

export default class MusicWallPlugin extends Plugin {
  settings: MusicWallSettings = DEFAULT_SETTINGS;
  private requester: Requester;

  async onload(): Promise<void> {
    await this.loadSettings();

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

    this.addRibbonIcon("library", "新建音乐墙", () => {
      void this.createNewWallCommand();
    });

    this.addCommand({
      id: "create-wall",
      name: "新建音乐墙文件 (.mw)",
      callback: () => void this.createNewWallCommand(),
    });
    this.addCommand({
      id: "search-add-album",
      name: "搜索导入专辑（当前墙·推荐）",
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
      })
    );
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.refreshOpenViews();
  }

  refreshOpenViews(): void {
    for (const view of this.allWallViews()) view.refresh();
  }

  private allWallViews(): MusicWallView[] {
    return this.app.workspace
      .getLeavesOfType(WALL_VIEW_TYPE)
      .map((l) => l.view as MusicWallView);
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

  private uniquePath(name: string, folder = ""): string {
    const prefix = folder ? `${folder}/` : "";
    let candidate = `${prefix}${name}.${WALL_EXT}`;
    let i = 1;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = `${prefix}${name} ${i}.${WALL_EXT}`;
      i++;
    }
    return candidate;
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
