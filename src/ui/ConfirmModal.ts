// 通用确认模态框：删除、导入覆盖、Git 覆盖等处使用。
//
// requireText：可选的「输入文字才能确认」闸门。删除整组（连同组内唱片）这类
// 不可撤销且代价大的操作会要求用户把目标名字敲一遍；普通删除不传即保持原样。

import { App, Modal } from "obsidian";

import { applyModalTheme } from "./modalTheme";
import { t } from "../i18n";

export interface ConfirmOptions {
  title: string;
  message: string;
  /** 额外明细行（如将被覆盖的文件列表） */
  details?: string[];
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  /**
   * 要求手动输入该文字才能确认（不传 = 直接点确认）。
   * 用于删除分组这类会连带删掉一批数据的危险操作。
   */
  requireText?: string;
  /** requireText 的提示语，缺省用「请输入「<requireText>」以确认：」 */
  requireHint?: string;
  onConfirm: () => void;
}

export class ConfirmModal extends Modal {
  private opts: ConfirmOptions;

  constructor(app: App, opts: ConfirmOptions) {
    super(app);
    this.opts = opts;
  }

  onOpen(): void {
    // 弹窗跟随全局缩放（--mw-zoom 设在 body 上，这里只是挂上作用域类）
    this.modalEl.addClass("mw-modal-zoom");
    applyModalTheme(this.modalEl);
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("mw-confirm");

    contentEl.createEl("h2", { text: this.opts.title });

    const p = contentEl.createEl("p", { text: this.opts.message });
    p.addClass("mw-confirm__msg");
    if (this.opts.requireText) p.addClass("mw-confirm__warn");

    if (this.opts.details?.length) {
      const ul = contentEl.createEl("ul");
      ul.addClass("mw-confirm__details");
      if (this.opts.requireText) ul.addClass("mw-confirm__details--scroll");
      for (const line of this.opts.details) {
        ul.createEl("li", { text: line });
      }
    }

    const expect = this.opts.requireText ?? "";
    let input: HTMLInputElement | null = null;
    let hint: HTMLElement | null = null;
    if (this.opts.requireText) {
      const field = contentEl.createDiv({ cls: "mw-confirm__field" });
      field.createDiv({
        cls: "mw-confirm__label",
        text:
          this.opts.requireHint ??
          t("confirmModal.requireHint", { text: expect }),
      });
      input = field.createEl("input", { type: "text", cls: "mw-confirm__input" });
      input.setAttr("autocomplete", "off");
      input.setAttr("spellcheck", "false");
      input.setAttr("placeholder", expect);
      hint = field.createDiv({ cls: "mw-confirm__hint" });
    }

    const btns = contentEl.createDiv({ cls: "mw-confirm__buttons" });
    const cancel = btns.createEl("button", {
      text: this.opts.cancelText ?? t("common.cancel"),
    });
    cancel.addEventListener("click", () => this.close());

    const ok = btns.createEl("button", {
      text: this.opts.confirmText ?? t("common.confirm"),
      cls: this.opts.danger ? "mod-warning" : "mod-cta",
    });

    const commit = () => {
      this.close();
      this.opts.onConfirm();
    };
    const matched = () => !expect || (input?.value.trim() ?? "") === expect;
    const sync = () => {
      const okNow = matched();
      ok.toggleClass("is-disabled", !okNow);
      if (okNow) ok.removeAttribute("disabled");
      else ok.setAttr("disabled", "true");
      if (hint) {
        const typed = !!input?.value.trim();
        hint.setText(
          okNow
            ? ""
            : typed
              ? t("confirmModal.mismatch")
              : t("confirmModal.required")
        );
        hint.toggleClass("is-error", typed && !okNow);
      }
    };

    ok.addEventListener("click", () => {
      if (!matched()) return;
      commit();
    });

    if (input) {
      input.addEventListener("input", sync);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && matched()) {
          e.preventDefault();
          commit();
        }
      });
      sync();
      window.setTimeout(() => input?.focus(), 0);
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
