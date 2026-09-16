// 解锁后的元数据编辑表单（仅手动/已解锁条目可用）。

import { App, Modal, Notice } from "obsidian";
import type { AlbumMeta } from "../types";

import { applyModalTheme } from "./modalTheme";

export class EditMetaModal extends Modal {
  private meta: AlbumMeta;
  private onSave: (meta: AlbumMeta) => void;

  constructor(app: App, meta: AlbumMeta, onSave: (meta: AlbumMeta) => void) {
    super(app);
    this.meta = { ...meta };
    this.onSave = onSave;
  }

  onOpen(): void {
    // 弹窗跟随全局缩放（--mw-zoom 设在 body 上，这里只是挂上作用域类）
    this.modalEl.addClass("mw-modal-zoom");
    applyModalTheme(this.modalEl);
    const { contentEl } = this;
    contentEl.addClass("mw-edit-modal");
    contentEl.createEl("h2", { text: `编辑元数据 · 专辑 ${this.meta.albumId}` });

    const field = (label: string, key: keyof AlbumMeta, type = "text") => {
      const wrap = contentEl.createDiv({ cls: "mw-edit-field" });
      wrap.createDiv({ cls: "mw-edit-label", text: label });
      const input = wrap.createEl("input", { type });
      input.value = String(this.meta[key] ?? "");
      input.addEventListener("input", () => {
        (this.meta as any)[key] = input.value;
      });
      return input;
    };

    field("专辑名", "name");
    field("艺术家", "artist");
    field("发行年份", "year");
    field("唱片公司", "company");
    field("封面 URL", "cover");

    const descWrap = contentEl.createDiv({ cls: "mw-edit-field" });
    descWrap.createDiv({ cls: "mw-edit-label", text: "简介" });
    const desc = descWrap.createEl("textarea", { cls: "mw-edit-textarea" });
    desc.value = this.meta.description ?? "";
    desc.addEventListener("input", () => {
      this.meta.description = desc.value;
    });

    const tagsWrap = contentEl.createDiv({ cls: "mw-edit-field" });
    tagsWrap.createDiv({ cls: "mw-edit-label", text: "标签（逗号分隔）" });
    const tags = tagsWrap.createEl("input", { type: "text" });
    tags.value = (this.meta.tags ?? []).join(",");
    tags.addEventListener("input", () => {
      this.meta.tags = tags.value
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
    });

    const btns = contentEl.createDiv({ cls: "mw-edit-buttons" });
    btns.createEl("button", { text: "取消" }).addEventListener("click", () =>
      this.close()
    );
    btns
      .createEl("button", { text: "保存", cls: "mod-cta" })
      .addEventListener("click", () => {
        if (!this.meta.name?.trim()) {
          new Notice("专辑名不能为空");
          return;
        }
        this.onSave(this.meta);
        this.close();
      });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
