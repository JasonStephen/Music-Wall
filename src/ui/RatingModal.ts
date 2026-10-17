// 评分模态框：五颗星（悬停预览＋点击保存）＋当前分＋清除评分（撤回）。
// 调用方经 onSave 落盘，本框不直接写 vault；点击星即保存并关闭。

import { App, Modal } from "obsidian";
import { applyModalTheme } from "./modalTheme";
import { normalizeRating } from "./rating";
import { t } from "../i18n";

export interface RatingModalArgs {
  /** 专辑名，用于标题 */
  albumName: string;
  /** 当前评分（1–5），缺省 = 未评分 */
  current?: number;
  /** 保存（含撤回 undefined） */
  onSave: (rating: number | undefined) => void;
}

export class RatingModal extends Modal {
  private albumName: string;
  private current: number | undefined;
  private onSave: (rating: number | undefined) => void;

  constructor(app: App, args: RatingModalArgs) {
    super(app);
    this.albumName = args.albumName;
    this.current = normalizeRating(args.current);
    this.onSave = args.onSave;
  }

  onOpen(): void {
    this.modalEl.addClass("mw-modal-zoom");
    applyModalTheme(this.modalEl);
    const { contentEl } = this;
    contentEl.addClass("mw-rating-modal");
    contentEl.createEl("h2", {
      text: t("rating.title", { name: this.albumName }),
      cls: "mw-rating-modal__heading",
    });

    const cur = contentEl.createDiv({ cls: "mw-rating-modal__current" });
    const syncCurrent = (preview?: number) => {
      const v = preview ?? this.current;
      cur.setText(
        v ? t("rating.current", { value: v }) : t("rating.currentUnrated")
      );
    };
    syncCurrent();

    // 五颗星：mouseenter 预览 / mouseleave 还原 / click 保存；focus 兼顾键盘
    const row = contentEl.createDiv({ cls: "mw-rating-modal__stars" });
    row.setAttribute("role", "radiogroup");
    row.setAttribute("aria-label", t("rating.chooseAria"));
    const stars: HTMLButtonElement[] = [];
    const paint = (n: number) => {
      stars.forEach((b, i) => b.toggleClass("is-preview", i < n));
    };
    const paintSaved = () => {
      stars.forEach((b, i) => b.toggleClass("is-on", i < (this.current ?? 0)));
    };
    for (let i = 1; i <= 5; i++) {
      const b = row.createEl("button", { cls: "mw-rate-star" });
      b.setAttr("type", "button");
      // data-star：星位即档位，CSS 按位着该档代表色（弹窗因此是五色图例）
      b.dataset.star = String(i);
      b.setAttr("aria-label", t("rating.star", { value: i }));
      b.setAttr("title", t("rating.star", { value: i }));
      b.textContent = "★";
      b.setAttribute("aria-checked", this.current === i ? "true" : "false");
      b.addEventListener("mouseenter", () => {
        paint(i);
        syncCurrent(i);
      });
      b.addEventListener("focus", () => {
        paint(i);
        syncCurrent(i);
      });
      b.addEventListener("click", () => {
        const picked = i;
        this.close();
        this.onSave(picked);
      });
      stars.push(b);
    }
    row.addEventListener("mouseleave", () => {
      paint(0);
      syncCurrent();
    });
    row.addEventListener("blur", () => {
      paint(0);
      syncCurrent();
    });
    paintSaved();


    const btns = contentEl.createDiv({ cls: "mw-rating-modal__buttons" });
    const clear = btns.createEl("button", { text: t("rating.clear") });
    clear.setAttr("type", "button");
    clear.disabled = this.current === undefined;
    clear.setAttr("title", t("rating.clearTip"));
    clear.addEventListener("click", () => {
      this.close();
      this.onSave(undefined);
    });
    const cancel = btns.createEl("button", { text: t("common.cancel") });
    cancel.setAttr("type", "button");
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
