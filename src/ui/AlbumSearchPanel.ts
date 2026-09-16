// 专辑搜索面板：搜索列表 → 选择 → 共享详情面板确认 → 添加。
// 通过 WallHost 接口与当前墙解耦，视图实现该接口。
//
// 形态：不是模态框，而是一块可挂进任意容器的面板
// （音乐墙把它挂进右上角的悬浮框，见 FloatPanel / SideDrawer 的 float 形态）。

import { Notice, setIcon } from "obsidian";
import type { AlbumMeta, AlbumSummary } from "../types";
import { parseAlbumInput, sizedCover } from "../core/metadata";

export interface WallHost {
  searchAlbums(keyword: string, offset: number): Promise<AlbumSummary[]>;
  fetchAlbumDetail(albumId: number): Promise<AlbumMeta>;
  getExistingIds(): Set<number>;
  addAlbum(meta: AlbumMeta, source: "search" | "manual"): void;
  confirmAdd(meta: AlbumMeta, onAdd: () => void): void;
}

const PAGE = 20;

export class AlbumSearchPanel {
  private host: WallHost;
  private keyword = "";
  private offset = 0;
  private results: AlbumSummary[] = [];
  private hasMore = true;
  private loading = false;

  private inputEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(host: WallHost) {
    this.host = host;
  }

  /** 在 container 内渲染面板；可重复调用（重建） */
  mount(container: HTMLElement): void {
    container.empty();
    container.addClass("mw-search-panel");
    container.createEl("p", {
      cls: "mw-search-panel__hint",
      text: "自动抓取完整元数据并锁定；也可直接粘贴专辑链接 / ID。",
    });

    const bar = container.createDiv({ cls: "mw-search-panel__bar" });
    const field = bar.createDiv({ cls: "mw-panel__searchbar" });
    const input = field.createEl("input", {
      type: "text",
      cls: "mw-panel__input",
      placeholder: "专辑名 / 歌手 / 链接 / ID",
    });
    this.inputEl = input;
    input.value = this.keyword;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.doSearch();
    });
    // 右端 × 清空（面板统一形态：不再用整宽「清空」按钮）
    const clear = field.createEl("button", { cls: "clickable-icon mw-panel__clearicon" });
    clear.setAttr("type", "button");
    clear.setAttr("aria-label", "清空");
    clear.setAttr("title", "清空");
    setIcon(clear, "x");
    const syncClear = () => clear.toggleClass("is-hidden", !input.value.length);
    input.addEventListener("input", syncClear);
    clear.addEventListener("click", () => {
      if (!input.value.length) return;
      input.value = "";
      syncClear();
      input.focus();
    });
    syncClear();
    bar
      .createEl("button", { cls: "mw-btn mw-btn--primary", text: "搜索" })
      .addEventListener("click", () => void this.doSearch());

    this.statusEl = container.createDiv({ cls: "mw-search-panel__status" });
    this.listEl = container.createDiv({ cls: "mw-search-panel__list" });
    // 重建后恢复上一次的结果（refresh 场景）
    if (this.results.length) this.renderList();
    window.setTimeout(() => input.focus(), 0);
  }

  /** 面板被销毁：清掉引用，避免陈旧 DOM 被后续回调写到 */
  dispose(): void {
    this.inputEl = null;
    this.listEl = null;
    this.statusEl = null;
  }

  private async doSearch(): Promise<void> {
    const raw = this.inputEl?.value.trim() ?? "";
    if (!raw) return;

    // 链接/裸 ID 快速路径
    const id = parseAlbumInput(raw);
    if (id !== null && /http|album/i.test(raw)) {
      await this.quickAddById(id);
      return;
    }

    this.keyword = raw;
    this.offset = 0;
    this.results = [];
    this.hasMore = true;
    this.listEl?.empty();
    await this.loadMore();
  }

  private async quickAddById(albumId: number): Promise<void> {
    if (this.host.getExistingIds().has(albumId)) {
      new Notice("该专辑已在当前音乐墙中");
      return;
    }
    this.setStatus("正在拉取专辑元数据…");
    try {
      const meta = await this.host.fetchAlbumDetail(albumId);
      this.setStatus("");
      this.host.confirmAdd(meta, () => {
        this.host.addAlbum(meta, "search");
        this.markAdded(albumId);
      });
    } catch (e: any) {
      this.setStatus("获取失败：" + (e?.message ?? e));
    }
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.textContent = text;
  }

  private async loadMore(): Promise<void> {
    if (this.loading || !this.keyword) return;
    this.loading = true;
    this.setStatus("搜索中…");
    try {
      const batch = await this.host.searchAlbums(this.keyword, this.offset);
      this.results.push(...batch);
      this.hasMore = batch.length >= PAGE;
      this.offset += batch.length;
      this.renderList();
      this.setStatus(this.results.length === 0 ? "没有结果，换个关键词试试" : "");
    } catch (e: any) {
      this.setStatus("搜索失败：" + (e?.message ?? e));
    } finally {
      this.loading = false;
    }
  }

  private renderList(): void {
    const list = this.listEl;
    if (!list) return;
    list.empty();
    const existing = this.host.getExistingIds();
    for (const a of this.results) {
      const row = list.createDiv({ cls: "mw-search-row" });
      row.dataset.id = String(a.albumId);
      const added = existing.has(a.albumId);
      if (added) row.addClass("is-added");

      const img = row.createEl("img", { cls: "mw-search-row__cover" });
      img.loading = "lazy";
      img.draggable = false;
      img.src = sizedCover(a.cover, 120);

      const info = row.createDiv({ cls: "mw-search-row__info" });
      info.createDiv({ cls: "mw-search-row__name", text: a.name });
      info.createDiv({
        cls: "mw-search-row__sub",
        text: `${a.artist || "未知"} · ${a.year ?? ""} · ${a.trackCount} 曲`,
      });

      const btn = row.createEl("button", {
        cls: "mw-search-row__add",
        text: added ? "已添加" : "添加",
      });
      btn.disabled = added;
      btn.addEventListener("click", () => void this.onAddClick(a, btn));
    }

    if (this.hasMore && this.results.length) {
      list
        .createEl("button", { cls: "mw-search-more", text: "加载更多" })
        .addEventListener("click", () => void this.loadMore());
    }
  }

  private async onAddClick(summary: AlbumSummary, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    btn.textContent = "拉取中…";
    try {
      const meta = await this.host.fetchAlbumDetail(summary.albumId);
      this.host.confirmAdd(meta, () => {
        this.host.addAlbum(meta, "search");
        this.markAdded(summary.albumId);
      });
    } catch (e: any) {
      new Notice("获取专辑详情失败：" + (e?.message ?? e));
    } finally {
      btn.textContent = "添加";
      btn.disabled = this.host.getExistingIds().has(summary.albumId);
    }
  }

  /** 重新渲染以更新「已添加」状态（简单可靠） */
  private markAdded(albumId: number): void {
    void albumId;
    this.renderList();
  }
}
