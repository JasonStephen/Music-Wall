import { t } from "../i18n";
import { setIcon } from "obsidian";

/** Keep DOM size bounded while retaining the complete ordered collection. */
export class SongPager<T> {
  static readonly size = 100;
  private items: readonly T[] = [];
  private page = 0;
  private rows: HTMLElement;
  private nav: HTMLElement;
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private label: HTMLElement;
  private range: HTMLElement;
  private controls: HTMLElement;
  constructor(parent: HTMLElement, private row: (parent: HTMLElement, item: T, index: number) => void, private beforeRender = () => {}) {
    this.nav = parent.createDiv({ cls: "mw-song-pager" });
    this.range = this.nav.createSpan({ cls: "mw-song-pager__range" });
    this.controls = this.nav.createDiv({ cls: "mw-song-pager__controls" });
    this.previous = this.button("chevron-left", t("localWall.previousPage"), -1);
    this.label = this.controls.createSpan({ cls: "mw-song-pager__page", attr: { "aria-live": "polite" } });
    this.next = this.button("chevron-right", t("localWall.nextPage"), 1);
    this.rows = parent.createDiv({ cls: "mw-song-pager__rows" });
  }
  private button(icon: string, label: string, direction: number): HTMLButtonElement {
    const button = this.controls.createEl("button", { cls: "clickable-icon mw-svg-action", attr: { type: "button", title: label, "aria-label": label } });
    setIcon(button.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } }), icon);
    button.addEventListener("click", () => this.turn(direction));
    return button;
  }
  get currentPage(): number { return this.page; }
  setItems(items: readonly T[], reset = true, initialPage?: number): void {
    this.items = items;
    this.page = Math.max(0, Math.min(initialPage ?? (reset ? 0 : this.page), Math.max(0, Math.ceil(items.length / SongPager.size) - 1)));
    this.render();
  }
  reveal(index: number): void {
    if (index < 0 || index >= this.items.length) return;
    const page = Math.floor(index / SongPager.size);
    if (page !== this.page) { this.page = page; this.render(); }
    (this.rows.children[index % SongPager.size] as HTMLElement)?.scrollIntoView({ block: "nearest" });
  }
  private turn(direction: number): void {
    this.page = Math.max(0, Math.min(this.page + direction, Math.ceil(this.items.length / SongPager.size) - 1));
    this.render();
    this.rows.firstElementChild?.scrollIntoView({ block: "nearest" });
  }
  private render(): void {
    this.beforeRender(); this.rows.empty();
    const pages = Math.max(1, Math.ceil(this.items.length / SongPager.size));
    this.nav.hidden = pages === 1;
    this.previous.disabled = this.page === 0; this.next.disabled = this.page + 1 >= pages;
    const start = this.page * SongPager.size;
    const description = t("localWall.pageCount", { page: this.page + 1, pages, count: this.items.length });
    this.label.empty();
    this.label.createEl("strong", { text: String(this.page + 1) });
    this.label.createSpan({ text: `/ ${pages}` });
    this.label.setAttr("aria-label", description);
    this.range.setText(`${Math.min(start + 1, this.items.length)}–${Math.min(start + SongPager.size, this.items.length)} / ${this.items.length.toLocaleString()}`);
    this.range.setAttr("title", description);
    this.items.slice(start, start + SongPager.size).forEach((item, offset) => this.row(this.rows, item, start + offset));
  }
}
