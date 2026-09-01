// 音乐墙 FileView：点开 .mw 文件即渲染唱片墙。
// FileView 基类负责 file 绑定/切换/重命名刷标题/导航历史，本类只管加载与渲染；
// 工具栏（样式切换/搜索/筛选/排序/添加）+ 响应式网格 + ⋯ 菜单 + 外部修改自动刷新。

import {
  FileView,
  Menu,
  Notice,
  Platform,
  TFile,
  WorkspaceLeaf,
  normalizePath,
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
} from "../types";
import { loadWall, saveWall } from "../core/store";
import { playAlbum } from "../core/playback";
import { ALL_STYLES, STYLE_LABELS, buildDiscElement } from "./disc";
import { AlbumPanelModal } from "./AlbumPanelModal";
import { ConfirmModal } from "./ConfirmModal";
import { EditMetaModal } from "./EditMetaModal";
import { InputModal } from "./InputModal";
import { PickerModal } from "./smallModals";
import { SearchAlbumModal, type WallHost } from "./SearchAlbumModal";

type SortKey = "addedAt" | "name" | "artist" | "year";
const SORT_LABELS: Record<SortKey, string> = {
  addedAt: "添加时间",
  name: "专辑名",
  artist: "艺术家",
  year: "发行年份",
};

export class MusicWallView extends FileView implements WallHost {
  private plugin: MusicWallPlugin;
  private data: MusicWallData | null = null;
  allowNoFile = true;

  // 纯前端筛选/排序/搜索状态（不写入文件）
  private q = "";
  private filterArtist = "";
  private filterYear = "";
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
    root.empty();
    root.addClass("mw-view");
    if (!this.data) {
      root.createDiv({ cls: "mw-empty", text: "未选择音乐墙文件" });
      return;
    }

    this.renderToolbar(root);
    const grid = root.createDiv({ cls: "mw-grid" });
    grid.style.setProperty("--mw-min-col", `${this.plugin.settings.minColumnWidth}px`);
    this.renderGrid(grid);
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

    // 全局样式切换
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
      "年份",
      this.filterYear,
      uniq((i) => i.meta.year),
      (v) => {
        this.filterYear = v;
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

    const sortWrap = controls.createDiv({ cls: "mw-toolbar__sort" });
    const sortSel = sortWrap.createEl("select", { cls: "mw-toolbar__select" });
    for (const k of Object.keys(SORT_LABELS) as SortKey[]) {
      sortSel.createEl("option", { text: `按${SORT_LABELS[k]}`, value: k });
    }
    sortSel.value = this.sortKey;
    sortSel.addEventListener("change", () => {
      this.sortKey = sortSel.value as SortKey;
      this.rerenderGrid();
    });
    const dirBtn = sortWrap.createEl("button", {
      cls: "mw-toolbar__dir",
      text: this.sortAsc ? "↑" : "↓",
    });
    dirBtn.setAttr("title", "切换升/降序");
    dirBtn.addEventListener("click", () => {
      this.sortAsc = !this.sortAsc;
      this.rerenderGrid();
    });

    // 添加按钮：搜索（推荐）+ 手动
    const addGroup = controls.createDiv({ cls: "mw-toolbar__add" });
    const btnSearch = addGroup.createEl("button", {
      cls: "mw-btn mw-btn--primary",
      text: "🔍 搜索导入",
    });
    btnSearch.setAttr("title", "自动抓取完整元数据");
    btnSearch.addEventListener("click", () => this.openSearchModal());
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
    if (this.filterYear) items = items.filter((i) => i.meta.year === this.filterYear);
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
          text: "「搜索导入」会抓取完整专辑元数据，添加后可随时在右键菜单中锁定或解锁。",
          cls: "mw-empty__sub",
        });
        const actions = empty.createDiv({ cls: "mw-empty__actions" });
        actions
          .createEl("button", { cls: "mw-btn mw-btn--primary", text: "🔍 搜索导入" })
          .addEventListener("click", () => this.openSearchModal());
      } else {
        empty
          .createEl("button", { cls: "mw-btn", text: "清除筛选" })
          .addEventListener("click", () => {
            this.q = "";
            this.filterArtist = "";
            this.filterYear = "";
            this.filterTag = "";
            this.render();
          });
      }
      return;
    }
    for (const item of items) {
      grid.appendChild(this.buildCard(item));
    }
  }

  private buildCard(item: WallItem): HTMLElement {
    const style = this.data!.style;
    const card = document.createElement("div");
    card.className = "mw-card";
    card.appendChild(buildDiscElement(item, style, { coverSize: 300 }));

    const delBtn = document.createElement("button");
    delBtn.className = "mw-card__delete";
    delBtn.textContent = "✕";
    delBtn.title = "移出音乐墙";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.confirmDelete(item);
    });
    card.appendChild(delBtn);

    // 可见菜单入口：不依赖 contextmenu 事件路径（部分环境右键被拖拽系统吞掉），
    // 触屏同样可用
    const menuBtn = document.createElement("button");
    menuBtn.className = "mw-card__menu";
    menuBtn.textContent = "⋯";
    menuBtn.title = "更多操作";
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const rect = menuBtn.getBoundingClientRect();
      this.openCardMenu({ x: rect.left, y: rect.bottom + 4 } as MouseEvent, item);
    });
    card.appendChild(menuBtn);

    // 拖出：自定义 MIME 载荷 = 源墙路径 + 专辑 ID（完整条目由源视图内存提供）。
    // 常驻 draggable 会让 Windows Chromium 把右键当作右键拖拽吞掉 contextmenu，
    // 故仅左键按下时临时启用，dragend 复位；⋯ 按钮始终作为保底菜单入口。
    card.addEventListener("pointerdown", (e) => {
      card.draggable = (e as PointerEvent).button === 0;
    });
    card.addEventListener("dragend", () => {
      card.draggable = false;
    });
    card.addEventListener("dragstart", (e) => {
      const de = e as DragEvent;
      if (!de.dataTransfer || !this.file) return;
      de.dataTransfer.setData(
        WALL_DRAG_MIME,
        JSON.stringify({ srcPath: this.file.path, albumId: item.albumId })
      );
      de.dataTransfer.effectAllowed = "copyMove";
    });

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

  private openPlayModal(item: WallItem): void {
    new AlbumPanelModal(this.app, "play", {
      meta: item.meta,
      style: this.data!.style,
      locked: item.locked,
      source: item.source,
      deps: this.plugin.getPlaybackDeps(),
    }).open();
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
          await this.app.fileManager.renameFile(
            this.file!,
            normalizePath(`${name}.mw`)
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
