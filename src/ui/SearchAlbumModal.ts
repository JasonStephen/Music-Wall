// 专辑搜索模态框：搜索列表 → 选择 → 共享详情面板确认 → 添加（计划书 §变更B）。
// 通过 WallHost 接口与当前墙解耦，视图实现该接口。

import { App, Modal, Notice } from "obsidian";
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

export class SearchAlbumModal extends Modal {
  private host: WallHost;
  private keyword = "";
  private offset = 0;
  private results: AlbumSummary[] = [];
  private hasMore = true;
  private loading = false;

  private inputEl!: HTMLInputElement;
  private listEl!: HTMLElement;
  private statusEl!: HTMLElement;

  constructor(app: App, host: WallHost) {
    super(app);
    this.host = host;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mw-search-modal");
    contentEl.createEl("h2", { text: "搜索网易云专辑" });
    contentEl.createEl("p", {
      cls: "mw-search-modal__hint",
      text: "搜索导入的专辑会自动抓取完整元数据并锁定；也可直接粘贴专辑链接/ID。",
    });

    const bar = contentEl.createDiv({ cls: "mw-search-modal__bar" });
    this.inputEl = bar.createEl("input", {
      type: "text",
      placeholder: "输入专辑名或歌手，回车搜索；或粘贴 music.163.com 专辑链接",
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.doSearch();
    });
    bar.createEl("button", { text: "搜索" }).addEventListener("click", () =>
      this.doSearch()
    );

    this.statusEl = contentEl.createDiv({ cls: "mw-search-modal__status" });
    this.listEl = contentEl.createDiv({ cls: "mw-search-modal__list" });
  }

  private async doSearch() {
    const raw = this.inputEl.value.trim();
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
    this.listEl.empty();
    await this.loadMore();
  }

  private async quickAddById(albumId: number) {
    if (this.host.getExistingIds().has(albumId)) {
      new Notice("该专辑已在当前音乐墙中");
      return;
    }
    this.setStatus("正在拉取专辑元数据…");
    try {
      const meta = await this.host.fetchAlbumDetail(albumId);
      this.setStatus("");
      this.close();
      this.host.confirmAdd(meta, () => this.host.addAlbum(meta, "search"));
    } catch (e: any) {
      this.setStatus("获取失败：" + (e?.message ?? e));
    }
  }

  private setStatus(text: string) {
    this.statusEl.textContent = text;
  }

  private async loadMore() {
    if (this.loading || !this.keyword) return;
    this.loading = true;
    this.setStatus("搜索中…");
    try {
      const batch = await this.host.searchAlbums(this.keyword, this.offset);
      this.results.push(...batch);
      this.hasMore = batch.length >= PAGE;
      this.offset += batch.length;
      this.renderList();
      this.setStatus(
        this.results.length === 0 ? "没有结果，换个关键词试试" : ""
      );
    } catch (e: any) {
      this.setStatus("搜索失败：" + (e?.message ?? e));
    } finally {
      this.loading = false;
    }
  }

  private renderList() {
    this.listEl.empty();
    const existing = this.host.getExistingIds();
    for (const a of this.results) {
      const row = this.listEl.createDiv({ cls: "mw-search-row" });
      row.dataset.id = String(a.albumId);
      const added = existing.has(a.albumId);
      if (added) row.addClass("is-added");

      const img = row.createEl("img", { cls: "mw-search-row__cover" });
      img.loading = "lazy";
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
      btn.addEventListener("click", () => this.onAddClick(a, btn));
    }

    if (this.hasMore && this.results.length) {
      this.listEl
        .createEl("button", { cls: "mw-search-more", text: "加载更多" })
        .addEventListener("click", () => this.loadMore());
    }
  }

  private async onAddClick(summary: AlbumSummary, btn: HTMLButtonElement) {
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

  private markAdded(albumId: number) {
    const row = Array.from(this.listEl.querySelectorAll(".mw-search-row")).find(
      (r) => (r as HTMLElement).dataset?.id === String(albumId)
    );
    // 重新渲染以更新「已添加」状态（简单可靠）
    this.renderList();
    void row;
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
