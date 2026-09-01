// 两个通用小模态框：
// - ChoiceModal：若干动作按钮的选择框（导入时「合并 / 新建 / 取消」）。
// - PickerModal：可滚动的列表选择框（Git 导入时选择 .mw 文件）。

import { App, Modal } from "obsidian";

export interface ChoiceOption {
  label: string;
  description?: string;
  onSelect: () => void;
}

export class ChoiceModal extends Modal {
  private title: string;
  private message: string;
  private options: ChoiceOption[];

  constructor(app: App, title: string, message: string, options: ChoiceOption[]) {
    super(app);
    this.title = title;
    this.message = message;
    this.options = options;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mw-choice");
    contentEl.createEl("h2", { text: this.title });
    if (this.message)
      contentEl.createEl("p", { cls: "mw-choice__msg", text: this.message });
    const list = contentEl.createDiv({ cls: "mw-choice__options" });
    for (const opt of this.options) {
      const btn = list.createDiv({ cls: "mw-choice__option" });
      btn.createDiv({ cls: "mw-choice__label", text: opt.label });
      if (opt.description)
        btn.createDiv({ cls: "mw-choice__desc", text: opt.description });
      btn.addEventListener("click", () => {
        this.close();
        opt.onSelect();
      });
    }
    const cancel = contentEl.createDiv({ cls: "mw-choice__cancel" });
    cancel.createEl("button", { text: "取消" }).addEventListener("click", () =>
      this.close()
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export interface PickItem {
  label: string;
  detail?: string;
}

export class PickerModal extends Modal {
  private title: string;
  private items: PickItem[];
  private onPick: (index: number) => void;

  constructor(
    app: App,
    title: string,
    items: PickItem[],
    onPick: (index: number) => void
  ) {
    super(app);
    this.title = title;
    this.items = items;
    this.onPick = onPick;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("mw-picker");
    contentEl.createEl("h2", { text: this.title });
    const list = contentEl.createDiv({ cls: "mw-picker__list" });
    this.items.forEach((item, i) => {
      const row = list.createDiv({ cls: "mw-picker__row" });
      row.createDiv({ cls: "mw-picker__label", text: item.label });
      if (item.detail)
        row.createDiv({ cls: "mw-picker__detail", text: item.detail });
      row.addEventListener("click", () => {
        this.close();
        this.onPick(i);
      });
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
