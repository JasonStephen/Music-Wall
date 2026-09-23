// 评分模态框：五颗星（悬停预览＋点击保存）＋当前分＋清除评分（撤回）。
// 调用方经 onSave 落盘，本框不直接写 vault；点击星即保存并关闭。

import { App, Modal } from "obsidian";
import { applyModalTheme } from "./modalTheme";
import { normalizeRating } from "./rating";

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
      text: `为《${this.albumName}》评分`,
      cls: "mw-rating-modal__heading",
    });

    const cur = contentEl.createDiv({ cls: "mw-rating-modal__current" });
    const syncCurrent = (preview?: number) => {
      const v = preview ?? this.current;
      cur.setText(v ? `当前：${v} / 5 分` : "当前：未评分");
    };
    syncCurrent();

    // 五颗星：mouseenter 预览 / mouseleave 还原 / click 保存；focus 兼顾键盘
    const row = contentEl.createDiv({ cls: "mw-rating-modal__stars" });
    row.setAttribute("role", "radiogroup");
    row.setAttribute("aria-label", "选择 1 到 5 分");
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
      b.setAttr("aria-label", `${i} 分`);
      b.setAttr("title", `${i} 分`);
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

    contentEl.createDiv({
      cls: "mw-rating-modal__hint",
      text: "悬停可预览不同星数下的效果，点击星即保存。",
    });

    const btns = contentEl.createDiv({ cls: "mw-rating-modal__buttons" });
    const clear = btns.createEl("button", { text: "清除评分" });
    clear.setAttr("type", "button");
    clear.disabled = this.current === undefined;
    clear.setAttr("title", "撤回打分，回到未评分");
    clear.addEventListener("click", () => {
      this.close();
      this.onSave(undefined);
    });
    const cancel = btns.createEl("button", { text: "取消" });
    cancel.setAttr("type", "button");
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
