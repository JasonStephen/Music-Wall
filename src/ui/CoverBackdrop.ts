import { coverTone, type CoverTone } from "./accent";
import { sizedCover } from "../core/metadata";
import { requestUrl } from "obsidian";

/** Two decoded image layers; stale requests can never replace a newer cover. */
export class CoverBackdrop {
  private layers: HTMLElement[];
  private active = 0;
  private key = "";
  private generation = 0;
  private fadeEnd = 0;
  private painted = false;
  tone: CoverTone | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private urls = ["", ""];
  constructor(private root: HTMLElement) {
    this.layers = [0, 1].map(() => root.createDiv({ cls: "mw-player__backdrop", attr: { "aria-hidden": "true" } }));
  }
  set(cover: string, ready: (tone: CoverTone) => void, retry = true): void {
    if (cover === this.key) return;
    clearTimeout(this.retry);
    this.key = cover; const generation = ++this.generation;
    if (!cover) return;
    const image = new Image(), url = sizedCover(cover, 800);
    void (async () => {
      let timer: ReturnType<typeof setTimeout>;
      let local = "", finished = false;
      try {
        const bounded = async <T>(work: Promise<T>, ms: number): Promise<T> => {
          let timeout: ReturnType<typeof setTimeout>;
          try { return await Promise.race([work, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("Cover timeout")), ms); })]); }
          finally { clearTimeout(timeout!); }
        };
        const decode = (source: string) => bounded(new Promise<void>((resolve, reject) => {
          image.onload = () => { if (typeof image.decode === "function") image.decode().then(resolve, reject); else resolve(); };
          image.onerror = () => reject(new Error("Cover unavailable"));
          image.src = source;
        }), 1500);
        let source = url;
        const decoded = (async () => {
          for (const candidate of [...new Set([url, sizedCover(cover, 300), cover])]) {
            if (finished || generation !== this.generation) throw new Error("Stale cover");
            if (!/^(data:|blob:)/.test(candidate)) {
              try {
                const response = await bounded(requestUrl({ url: candidate, method: "GET" }), 2000);
                if (finished || generation !== this.generation) throw new Error("Stale cover");
                if (!response.arrayBuffer?.byteLength) throw new Error("Empty cover");
                local = URL.createObjectURL(new Blob([response.arrayBuffer], { type: response.headers?.["content-type"] || "" }));
                await decode(local); source = local; return;
              } catch { if (local) URL.revokeObjectURL(local); local = ""; }
            } else { await decode(candidate); source = candidate; return; }
          }
          for (const candidate of [...new Set([sizedCover(cover, 300), cover])]) {
            if (finished || generation !== this.generation) throw new Error("Stale cover");
            try { await decode(candidate); source = candidate; return; } catch { /* Retain the last painted cover. */ }
          }
          throw new Error("Cover unavailable");
        })();
        const palette = coverTone(sizedCover(cover, 300));
        await Promise.race([
          decoded,
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Cover timeout")), 8000); }),
        ]);
        if (generation !== this.generation) return;
        const remaining = this.fadeEnd - performance.now();
        if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
        if (generation !== this.generation) return;
        const next = this.layers[1 - this.active], previous = this.layers[this.active];
        if (this.urls[1 - this.active]) URL.revokeObjectURL(this.urls[1 - this.active]);
        this.urls[1 - this.active] = local;
        next.style.backgroundImage = `url(${JSON.stringify(source)})`; local = "";
        const duration = !this.painted || matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 650;
        next.style.transitionDuration = "0ms"; next.style.opacity = "0"; next.style.zIndex = "1";
        previous.style.transitionDuration = "0ms"; previous.style.opacity = this.painted ? "1" : "0"; previous.style.zIndex = "0";
        // The opaque outgoing layer avoids a dark dip halfway through the dissolve.
        void next.offsetWidth; next.style.transitionDuration = `${duration}ms`; next.style.opacity = "1";
        this.root.style.setProperty("--mw-player-art", `url(${JSON.stringify(source)})`);
        this.root.addClass("has-backdrop"); this.tone = null; ready({ accent: null, luma: null });
        this.active = 1 - this.active; this.painted = true; this.fadeEnd = performance.now() + duration;
        if (duration) await new Promise(resolve => setTimeout(resolve, duration / 2));
        void palette.then(tone => { if (generation === this.generation) { this.tone = tone; ready(tone); } });
      } catch {
        if (generation === this.generation) {
          this.key = "";
          if (retry) this.retry = setTimeout(() => this.set(cover, ready, false), 1200);
        }
      }
      finally { finished = true; if (local) URL.revokeObjectURL(local); clearTimeout(timer!); image.onload = null; image.onerror = null; }
    })();
  }
  dispose(): void { ++this.generation; clearTimeout(this.retry); for (const url of this.urls) if (url) URL.revokeObjectURL(url); for (const layer of this.layers) layer.remove(); this.root.removeClass("has-backdrop"); }
}
