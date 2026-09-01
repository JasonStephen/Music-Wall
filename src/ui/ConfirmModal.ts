// 通用确认模态框：删除、导入覆盖、Git 覆盖等处使用。

import { App, Modal } from "obsidian";

export interface ConfirmOptions {
  title: string;
  message: string;
  /** 额外明细行（如将被覆盖的文件列表） */
  details?: string[];
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export class ConfirmModal extends Modal {
  private opts: ConfirmOptions;

  constructor(app: App, opts: ConfirmOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mw-confirm");

    contentEl.createEl("h2", { text: this.opts.title });

    const p = contentEl.createEl("p", { text: this.opts.message });
    p.addClass("mw-confirm__msg");

    if (this.opts.details?.length) {
      const ul = contentEl.createEl("ul");
      ul.addClass("mw-confirm__details");
      for (const line of this.opts.details) {
        ul.createEl("li", { text: line });
      }
    }

    const btns = contentEl.createDiv({ cls: "mw-confirm__buttons" });
    const cancel = btns.createEl("button", {
      text: this.opts.cancelText ?? "取消",
    });
    cancel.addEventListener("click", () => this.close());

    const ok = btns.createEl("button", {
      text: this.opts.confirmText ?? "确认",
      cls: this.opts.danger ? "mod-warning" : "mod-cta",
    });
    ok.addEventListener("click", () => {
      this.close();
      this.opts.onConfirm();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
