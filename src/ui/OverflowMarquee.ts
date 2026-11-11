/** Scroll overflowing text without changing its single-line layout. */
export class OverflowMarquee {
  private text: HTMLElement;
  private resize: ResizeObserver | null = null;
  private motion: Animation | null = null;
  private frame = 0;
  private distance = -1;
  private value = "";
  private media: MediaQueryList | undefined;
  private refresh = () => {
    const win = this.root.ownerDocument.defaultView;
    if (!win || this.frame) return;
    this.frame = win.requestAnimationFrame(() => { this.frame = 0; this.measure(); });
  };
  constructor(private root: HTMLElement) {
    root.addClass("mw-marquee");
    this.text = root.createSpan({ cls: "mw-marquee__text" });
    this.media = root.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)");
    this.media?.addEventListener("change", this.refresh);
    if (typeof ResizeObserver !== "undefined") {
      this.resize = new ResizeObserver(this.refresh);
      this.resize.observe(root); this.resize.observe(this.text);
    }
  }
  set(value: string): void {
    if (value === this.value) return;
    this.value = value; this.text.textContent = value;
    this.distance = -1; this.motion?.cancel(); this.motion = null;
    this.refresh();
  }
  private measure(): void {
    const distance = this.root.clientWidth ? Math.max(0, this.text.scrollWidth - this.root.clientWidth) : 0;
    this.root.toggleClass("is-overflowing", distance > 1);
    if (distance === this.distance && !!this.motion === (distance > 1 && !this.media?.matches)) return;
    this.distance = distance; this.motion?.cancel(); this.motion = null;
    if (distance <= 1 || this.media?.matches || typeof this.text.animate !== "function") return;
    const duration = 4000 + distance / 26 * 2000, pause = 2000 / duration;
    this.motion = this.text.animate([
      { transform: "translateX(0)", offset: 0 },
      { transform: "translateX(0)", offset: pause },
      { transform: `translateX(-${distance}px)`, offset: .5 },
      { transform: `translateX(-${distance}px)`, offset: .5 + pause },
      { transform: "translateX(0)", offset: 1 },
    ], { duration, iterations: Infinity, easing: "linear" });
  }
  dispose(): void {
    this.resize?.disconnect(); this.motion?.cancel();
    this.media?.removeEventListener("change", this.refresh);
    if (this.frame) this.root.ownerDocument.defaultView?.cancelAnimationFrame(this.frame);
  }
}
