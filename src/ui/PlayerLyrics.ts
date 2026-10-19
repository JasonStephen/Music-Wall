import type MusicWallPlugin from "../main";
import type { NowPlayingState } from "../core/nowPlaying";
import { lyricIndexAt, type Lyrics } from "../core/lyrics";
import { t } from "../i18n";
import { svgAction } from "./svgAction";

/** Only mounted in the full player. Timeline comes from the current audio, not a free-running clock. */
export class PlayerLyrics {
  private viewport: HTMLElement;
  private track: HTMLElement;
  private translate: HTMLButtonElement;
  private follow: HTMLButtonElement;
  private retry: HTMLButtonElement;
  private rows: HTMLElement[] = [];
  private lyrics: Lyrics | null = null;
  private state: NowPlayingState | null = null;
  private key = "";
  private generation = 0;
  private active = -2;
  private manual = false;
  private disposed = false;
  private resize: ResizeObserver | null = null;
  private frame = 0;
  private motions: Animation[] = [];
  constructor(private root: HTMLElement, private plugin: MusicWallPlugin) {
    root.addClass("mw-lyrics"); root.setAttr("aria-label", t("lyrics.title"));
    const bar = root.createDiv({ cls: "mw-lyrics__bar" });
    bar.createSpan({ cls: "mw-lyrics__heading", text: t("lyrics.title") });
    this.follow = svgAction(bar, "locate", t("lyrics.follow"), () => { this.manual = false; this.updateActive(true); }, true);
    this.follow.addClass("is-hidden");
    this.translate = svgAction(bar, "languages", t("lyrics.translation"), async () => {
      this.plugin.settings.lyricsTranslation = !this.plugin.settings.lyricsTranslation;
      this.updateTranslation(); this.updateActive(true); await this.plugin.saveData(this.plugin.settings);
    }, true);
    this.viewport = root.createDiv({ cls: "mw-lyrics__viewport", attr: { tabindex: "0" } });
    this.track = this.viewport.createDiv({ cls: "mw-lyrics__track" });
    this.retry = svgAction(root, "refresh-cw", t("library.retry"), () => this.load(true), true); this.retry.addClass("is-hidden");
    const browse = () => { if (this.lyrics?.lines.some(line => line.time !== null)) { this.manual = true; this.cancelMotion(); this.follow.removeClass("is-hidden"); } };
    this.viewport.addEventListener("wheel", event => { if (!event.ctrlKey && !event.altKey) browse(); }, { passive: true });
    this.viewport.addEventListener("touchstart", browse, { passive: true });
    this.viewport.addEventListener("keydown", event => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(event.key)) browse(); });
    if (typeof ResizeObserver !== "undefined") { this.resize = new ResizeObserver(() => this.updateActive(true)); this.resize.observe(this.viewport); }
    this.updateTranslation();
  }
  update(state: NowPlayingState): void {
    if (this.disposed) return;
    this.state = state;
    const key = state.active && state.source === "internal" && state.songId ? String(state.songId) : state.active ? "external" : "idle";
    if (this.key !== key) { this.key = key; void this.load(); }
    else this.updateActive();
  }
  private message(text: string): void { this.rows = []; this.viewport.addClass("is-message"); this.track.empty(); this.track.createDiv({ cls: "mw-lyrics__message", text }); }
  private async load(refresh = false): Promise<void> {
    const token = ++this.generation, key = this.key;
    this.cancelMotion();
    if (this.frame) cancelAnimationFrame(this.frame);
    this.lyrics = null; this.active = -2; this.manual = false;
    this.retry.addClass("is-hidden"); this.follow.addClass("is-hidden"); this.updateTranslation();
    this.viewport.scrollTop = 0;
    if (key === "idle" || !key) { this.message(t("lyrics.idle")); return; }
    if (key === "external") { this.message(t("lyrics.external")); return; }
    this.message(t("lyrics.loading"));
    try {
      if (!this.plugin.lyrics) throw new Error("Unavailable");
      const source = await this.plugin.lyrics.get(Number(key), refresh);
      // Normalize at the display boundary so existing cached lyrics are fixed too.
      const lyrics = { ...source, lines: source.lines.filter(line => line.text.trim().length > 0) };
      if (this.disposed || token !== this.generation || key !== this.key) return;
      this.lyrics = lyrics;
      if (!lyrics.lines.some(line => line.text)) { this.message(t(lyrics.instrumental ? "lyrics.instrumental" : "lyrics.empty")); return; }
      this.viewport.removeClass("is-message"); this.track.empty(); this.rows = [];
      for (const line of lyrics.lines) {
        const timed = line.time !== null;
        const row = this.track.createEl(timed ? "button" : "div", { cls: "mw-lyrics__line", ...(timed ? { attr: { type: "button" } } : {}) });
        const text = row.createSpan({ cls: "mw-lyrics__text" });
        text.createSpan({ cls: "mw-lyrics__original", text: line.text });
        if (line.translation) text.createSpan({ cls: "mw-lyrics__translation", text: line.translation });
        if (timed) row.addEventListener("click", () => {
          if (this.state?.source !== "internal" || String(this.state.songId) !== key || !this.state.seekable) return;
          this.manual = false; this.follow.addClass("is-hidden"); void this.plugin.internalPlayer.seek(line.time!);
        });
        this.rows.push(row);
      }
      this.updateTranslation(); this.updateActive(true);
    } catch {
      if (this.disposed || token !== this.generation) return;
      this.message(t("lyrics.failed")); this.retry.removeClass("is-hidden");
    }
  }
  private updateTranslation(): void {
    this.root.toggleClass("show-translation", !!this.plugin.settings.lyricsTranslation);
    this.translate.setAttr("aria-pressed", String(!!this.plugin.settings.lyricsTranslation));
    this.translate.disabled = !this.lyrics?.lines.some(line => line.translation);
    this.translate.title = t(this.translate.disabled ? "lyrics.noTranslation" : "lyrics.translation");
  }
  private updateActive(force = false): void {
    const lines = this.lyrics?.lines;
    if (!lines?.length || !this.rows.length || !this.state) return;
    const index = lyricIndexAt(lines, this.state.positionMs);
    if (index === this.active && !force) return;
    const previous = this.active; this.active = index;
    let first = index;
    while (first > 0 && lines[first - 1].time === lines[index]?.time) --first;
    this.rows.forEach((row, i) => {
      const active = index >= 0 && lines[i].time === lines[index].time;
      row.toggleClass("is-active", active); row.toggleClass("is-near", Math.abs(i - index) <= 1);
      row.toggleClass("is-past", index >= 0 && i < first);
      if (active) row.setAttr("aria-current", "true"); else row.removeAttribute("aria-current");
    });
    if (this.manual || lines[0].time === null) return;
    this.follow.addClass("is-hidden");
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      if (this.disposed || this.manual) return;
      const row = this.rows[Math.max(0, first)]; if (!row) return;
      const reduced = this.root.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches;
      // Capture the current visual positions before cancelling interrupted motion.
      // Native scrolling sets the final layout; individual rows animate the visual
      // difference, so each visible lower row can start exactly 50ms later.
      const before = this.rows.map(line => line.getBoundingClientRect());
      this.cancelMotion();
      this.viewport.scrollTo({ top: Math.max(0, row.offsetTop - this.viewport.clientHeight * .26), behavior: "instant" });
      if (force || reduced || previous < 0 || index < previous) return;
      const bounds = this.viewport.getBoundingClientRect(); let order = 0;
      this.rows.forEach((line, i) => {
        const after = line.getBoundingClientRect(), old = before[i];
        const visible = old.bottom > bounds.top && old.top < bounds.bottom || after.bottom > bounds.top && after.top < bounds.bottom;
        const delta = old.top - after.top;
        if (!visible || Math.abs(delta) < .5 || typeof line.animate !== "function") return;
        const animation = line.animate([{ transform: `translateY(${delta}px)` }, { transform: "translateY(0)" }], {
          duration: 650, delay: order++ * 50, easing: "cubic-bezier(.2,.8,.2,1)", fill: "both",
        });
        this.motions.push(animation);
        void animation.finished.then(() => animation.cancel(), () => {});
      });
    });
  }
  private cancelMotion(): void { this.motions.splice(0).forEach(animation => animation.cancel()); }
  dispose(): void { this.disposed = true; ++this.generation; this.resize?.disconnect(); this.cancelMotion(); if (this.frame) cancelAnimationFrame(this.frame); }
}
