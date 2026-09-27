// 单行输入模态框：新建墙命名、Git 仓库地址等。

import { App, Modal, Notice } from "obsidian";

import { applyModalTheme } from "./modalTheme";
import { t } from "../i18n";

export class InputModal extends Modal {
  private title: string;
  private placeholder: string;
  private initialValue: string;
  private onSubmit: (value: string) => void;

  constructor(
    app: App,
    title: string,
    placeholder: string,
    initialValue: string,
    onSubmit: (value: string) => void
  ) {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.initialValue = initialValue;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    // 弹窗跟随全局缩放（--mw-zoom 设在 body 上，这里只是挂上作用域类）
    this.modalEl.addClass("mw-modal-zoom");
    applyModalTheme(this.modalEl);
    const { contentEl } = this;
    contentEl.addClass("mw-input-modal");
    contentEl.createEl("h2", { text: this.title });
    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: this.placeholder,
      value: this.initialValue,
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submit(input.value);
    });
    const btns = contentEl.createDiv({ cls: "mw-input-modal__buttons" });
    btns
      .createEl("button", { text: t("common.cancel") })
      .addEventListener("click", () => this.close());
    btns
      .createEl("button", { text: t("common.confirm"), cls: "mod-cta" })
      .addEventListener("click", () => this.submit(input.value));
    input.focus();
    input.select();
  }

  private submit(value: string) {
    const v = value.trim();
    if (!v) {
      new Notice(t("inputModal.empty"));
      return;
    }
    this.close();
    this.onSubmit(v);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
