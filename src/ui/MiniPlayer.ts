import { setIcon } from "obsidian";
import type MusicWallPlugin from "../main";
import { t } from "../i18n";
import { sizedCover } from "../core/metadata";
import { qualityLabel, type AudioQuality } from "../core/quality";
import { DEFAULT_COVER } from "./defaultCover";
import { decorateRange, paintRange } from "./range";
import { QueueControls } from "./QueueControls";
import { cyclePlayOrder, updatePlayOrderButton } from "./playOrder";

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
type Panel = "playlist" | "quality" | "volume" | "more";
const PANELS: Panel[] = ["playlist", "quality", "volume", "more"];

/** Every wall controls the same global player. */
export class MiniPlayer {
  readonly root: HTMLElement;
  private off: () => void;
  private title: HTMLElement;
  private artist: HTMLElement;
  private time: HTMLElement;
  private cover: HTMLImageElement;
  private toggle: HTMLButtonElement;
  private previous: HTMLButtonElement;
  private next: HTMLButtonElement;
  private orderButton: HTMLButtonElement;
  private qualityText: HTMLElement;
  private volumeButton: HTMLButtonElement;
  private seek: HTMLInputElement;
  private seekPointer: number | null = null;
  private seekSong: number | undefined;
  private pendingSeek: { song: number | undefined; position: number } | null = null;
  private volume: HTMLInputElement;
  private panels = {} as Record<Panel, HTMLElement>;
  private buttons = {} as Record<Panel, HTMLButtonElement>;
  private openPanel: Panel | null = null;
  private trackRows: HTMLButtonElement[] = [];
  private queueControls: QueueControls;
  private playlistBody: HTMLElement;
  private albumKey = "";
  private qualityKey = "";
  private coverKey = "";
  private playing: boolean | null = null;
  private volumeIcon = "";
  private observer: ResizeObserver | null = null;
  private height = -1;
  private visible = false;

  constructor(private parent: HTMLElement, private plugin: MusicWallPlugin) {
    this.root = parent.createDiv({ cls: "mw-mini is-hidden", attr: { role: "region", "aria-label": t("player.displayName") } });
    this.seek = this.root.createEl("input", { cls: "mw-range", attr: { type: "range", min: "0", max: "1", step: "0.1", "aria-label": t("internal.seek") } });
    decorateRange(this.seek);
    this.seek.parentElement!.addClass("mw-mini__progress");
    this.seek.addEventListener("pointerdown", event => {
      if (this.seek.disabled || !event.isPrimary || event.button !== 0) return;
      this.pendingSeek = null;
      this.seekPointer = event.pointerId; this.seekSong = plugin.internalPlayer.state.songId;
      this.root.addClass("is-seeking");
    });
    this.seek.addEventListener("blur", () => this.finishSeek(false));
    this.seek.addEventListener("input", () => {
      paintRange(this.seek);
      const position = Number(this.seek.value) * 1000;
      if (this.seekPointer === null) void plugin.internalPlayer.seek(position);
      else this.time.setText(`${clock(position)} / ${clock(plugin.internalPlayer.state.durationMs)}`);
    });
    const left = this.root.createDiv({ cls: "mw-mini__left" });
    const open = left.createEl("button", { cls: "mw-mini__open", attr: { title: t("mini.open"), "aria-label": t("mini.open") } });
    this.cover = open.createEl("img", { cls: "mw-mini__cover", attr: { alt: "" } });
    const meta = open.createSpan({ cls: "mw-mini__meta" });
    this.title = meta.createSpan({ cls: "mw-mini__title" });
    this.artist = meta.createSpan({ cls: "mw-mini__artist" });
    this.time = meta.createSpan({ cls: "mw-mini__time" });
    open.addEventListener("click", () => void plugin.openPlayerView());
    const controls = this.root.createDiv({ cls: "mw-mini__controls" });
    this.previous = this.button(controls, "prev", "skip-back", t("player.prevTip"), () => void this.control("prev"));
    this.toggle = this.button(controls, "toggle", "play", t("player.toggleTip"), () => void this.control("toggle"));
    this.next = this.button(controls, "next", "skip-forward", t("player.nextTip"), () => void this.control("next"));
    const tools = this.root.createDiv({ cls: "mw-mini__tools" });
    this.orderButton = this.button(tools, "play-order", "", "", () => cyclePlayOrder(plugin.internalPlayer));
    this.buttons.playlist = this.button(tools, "playlist", "list-music", t("player.playlistTip"), () => this.showPanel("playlist"));
    this.buttons.quality = this.button(tools, "quality", "", t("quality.choose"), () => this.showPanel("quality"));
    this.qualityText = this.buttons.quality.createSpan();
    setIcon(this.buttons.quality.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } }), "chevron-down");
    this.volumeButton = this.buttons.volume = this.button(tools, "volume", "volume-2", t("internal.volume"), () => this.showPanel("volume"));
    this.button(tools, "expand", "maximize-2", t("mini.open"), () => void plugin.openPlayerView());
    this.buttons.more = this.button(tools, "more", "ellipsis", t("wall.toolbar.more"), () => this.showPanel("more"));
    for (const name of PANELS) {
      this.buttons[name].setAttr("aria-expanded", "false");
      this.panels[name] = this.root.createDiv({ cls: `mw-mini__panel mw-mini__${name} is-hidden`, attr: { role: "group", "aria-label": this.buttons[name].getAttribute("aria-label")! } });
    }
    for (const [action, icon, label] of [
      ["quality", "audio-lines", t("quality.choose")],
      ["volume", "volume-2", t("internal.volume")],
      ["expand", "maximize-2", t("mini.open")],
    ]) {
      const button = this.panels.more.createEl("button", { cls: "mw-mini__more-item", attr: { "data-more-action": action } });
      setIcon(button.createSpan(), icon); button.createSpan({ text: label });
      button.addEventListener("click", () => {
        if (action === "expand") { this.showPanel(null); void plugin.openPlayerView(); }
        else {
          this.showPanel(action as Panel);
          this.panels[action as Panel].querySelector<HTMLElement>("button, input")?.focus();
        }
      });
    }
    this.queueControls = new QueueControls(this.panels.playlist.createDiv(), plugin.internalPlayer, () => plugin.ensureNeteaseLogin(), () => { this.albumKey = ""; this.update(); });
    this.playlistBody = this.panels.playlist.createDiv();
    this.volume = this.panels.volume.createEl("input", { cls: "mw-range", attr: { type: "range", min: "0", max: "1", step: "0.01", "aria-label": t("internal.volume") } });
    decorateRange(this.volume, true);
    this.volume.addEventListener("input", () => plugin.internalPlayer.setVolume(Number(this.volume.value)));
    parent.ownerDocument.addEventListener("pointerdown", this.outside);
    parent.ownerDocument.addEventListener("keydown", this.escape);
    parent.ownerDocument.addEventListener("pointerup", this.releaseSeek);
    parent.ownerDocument.addEventListener("pointercancel", this.releaseSeek);
    this.off = plugin.nowPlaying.on(() => this.update());
    if (typeof ResizeObserver !== "undefined") {
      this.observer = new ResizeObserver(() => this.reserveSpace());
      this.observer.observe(this.root);
    }
    this.update();
  }

  private button(parent: HTMLElement, action: string, icon: string, label: string, click: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "mw-mini__button", attr: { "data-action": action, "aria-label": label, title: label } });
    if (icon) setIcon(button, icon);
    button.addEventListener("click", click);
    return button;
  }
  private outside = (event: Event) => {
    if ("button" in event && (event as MouseEvent).button !== 0) return;
    const target = event.target as Element;
    if (this.openPanel && !(this.root.contains(target) && target.closest(".mw-mini__panel, .mw-mini__tools"))) this.showPanel(null);
  };
  private escape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.openPanel) {
      const button = this.buttons[this.openPanel]; this.showPanel(null);
      (button.getClientRects().length ? button : this.buttons.more).focus();
    }
  };
  private releaseSeek = (event: PointerEvent) => {
    if (event.pointerId === this.seekPointer) this.finishSeek(event.type === "pointerup");
  };
  private finishSeek(commit: boolean): void {
    if (this.seekPointer === null) return;
    if (commit && this.plugin.internalPlayer.state.songId === this.seekSong) {
      this.pendingSeek = { song: this.seekSong, position: Number(this.seek.value) * 1000 };
    }
    this.seekPointer = null; this.root.removeClass("is-seeking"); this.update();
  }
  private showPanel(name: Panel | null): void {
    this.openPanel = name === this.openPanel ? null : name;
    for (const key of PANELS) {
      const open = key === this.openPanel;
      this.panels[key].toggleClass("is-hidden", !open);
      this.buttons[key].setAttr("aria-expanded", String(open));
      this.buttons[key].toggleClass("is-active", open);
    }
  }
  private reserveSpace(): void {
    if (this.openPanel === "more" && !this.buttons.more.getClientRects().length) this.showPanel(null);
    this.parent.toggleClass("has-mini", this.visible);
    const measured = this.visible ? this.root.offsetHeight : 0;
    if (!Number.isFinite(measured) || measured === this.height) return;
    this.height = measured;
    this.parent.style.setProperty("--mw-mini-height", `${measured}px`);
  }
  private async control(action: "toggle" | "next" | "prev"): Promise<void> {
    const player = this.plugin.internalPlayer;
    if (!player?.album) return;
    if (!(action === "toggle" && player.playingRequested) && !(await this.plugin.ensureNeteaseLogin())) return;
    await player[action]();
  }
  private async selectTrack(index: number): Promise<void> {
    await this.queueControls.selectTrack(index);
  }
  private async selectQuality(quality: AudioQuality): Promise<void> {
    const player = this.plugin.internalPlayer, song = player.state.songId;
    this.showPanel(null);
    if (!(await this.plugin.ensureNeteaseLogin()) || player.state.songId !== song) return;
    await player.setQuality(quality);
  }
  private update(): void {
    const player = this.plugin.internalPlayer;
    updatePlayOrderButton(this.orderButton, player);
    this.visible = !!player?.album;
    this.root.toggleClass("is-hidden", !this.visible);
    this.reserveSpace();
    if (!this.visible) {
      this.pendingSeek = null; this.seekPointer = null; this.root.removeClass("is-seeking");
      this.showPanel(null); return;
    }
    const state = player.state;
    if (this.seekPointer !== null && state.songId !== this.seekSong) {
      this.seekPointer = null; this.root.removeClass("is-seeking");
    }
    if (this.pendingSeek && this.pendingSeek.song !== state.songId) this.pendingSeek = null;
    if (this.pendingSeek && state.seekable) {
      const position = this.pendingSeek.position; this.pendingSeek = null;
      void player.seek(position); return;
    }
    this.title.setText(state.title); this.title.title = state.title;
    this.artist.setText(player.error || (player.loading ? t("mini.loading") : state.artist));
    this.artist.title = this.artist.textContent ?? "";
    this.time.setText(`${clock(this.seekPointer !== null ? Number(this.seek.value) * 1000 : this.pendingSeek?.position ?? state.positionMs)} / ${clock(state.durationMs)}`);
    const cover = player.currentCover || DEFAULT_COVER;
    if (cover !== this.coverKey) { this.coverKey = cover; this.cover.src = sizedCover(cover, 160); }
    if (player.playingRequested !== this.playing) { this.playing = player.playingRequested; setIcon(this.toggle, this.playing ? "pause" : "play"); }
    this.previous.disabled = !state.canPrev; this.next.disabled = !state.canNext;
    this.seek.disabled = !state.seekable && this.seekPointer === null;
    this.seek.max = String(Math.max(1, state.durationMs / 1000));
    if (this.seekPointer === null) this.seek.value = String((this.pendingSeek?.position ?? state.positionMs) / 1000);
    paintRange(this.seek);
    if (this.volume.ownerDocument.activeElement !== this.volume) this.volume.value = String(player.volume);
    paintRange(this.volume); this.volume.setAttr("aria-valuetext", `${Math.round(player.volume * 100)}%`);
    const icon = player.volume === 0 ? "volume-x" : player.volume < .5 ? "volume-1" : "volume-2";
    if (icon !== this.volumeIcon) { this.volumeIcon = icon; setIcon(this.volumeButton, icon); }
    this.qualityText.setText(player.quality ? qualityLabel(player.quality) : "…");
    const collection = this.queueControls.collection;
    const albumKey = JSON.stringify([this.queueControls.view, collection?.albumId, collection?.playlistId, collection?.tracks]);
    if (this.albumKey !== albumKey) {
      this.albumKey = albumKey; this.playlistBody.empty(); this.trackRows = [];
      this.playlistBody.createDiv({ cls: "mw-mini__playlist-title", text: collection?.name || t("library.empty") });
      const tracks = this.playlistBody.createDiv({ cls: "mw-mini__tracks" });
      collection?.tracks?.forEach((track, index) => {
        const row = tracks.createEl("button", { cls: "mw-mini__track", attr: { "aria-label": t("internal.playTrack", { name: track.name }) } });
        row.createSpan({ text: String(index + 1).padStart(2, "0") });
        row.createSpan({ cls: "mw-mini__track-name", text: track.name });
        row.createSpan({ text: clock(track.duration) });
        row.addEventListener("click", () => void this.selectTrack(index)); this.trackRows.push(row);
      });
    }
    this.trackRows.forEach((row, index) => { row.toggleClass("is-current", this.queueControls.isCurrent(index)); row.setAttr("aria-current", String(this.queueControls.isCurrent(index))); });
    const qualityKey = `${player.availableQualities.join()}|${player.quality}|${player.loading}`;
    if (qualityKey !== this.qualityKey) {
      this.qualityKey = qualityKey; this.panels.quality.empty();
      for (const quality of [...player.availableQualities].reverse()) {
        const option = this.panels.quality.createEl("button", { cls: "mw-mini__quality-option", attr: { "data-quality": quality, "aria-pressed": String(player.quality === quality) } });
        option.createSpan({ text: qualityLabel(quality) });
        if (player.quality === quality) setIcon(option.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } }), "check");
        option.disabled = player.loading; option.addEventListener("click", () => void this.selectQuality(quality));
      }
      if (!player.availableQualities.length) this.panels.quality.createSpan({ text: "…", attr: { "aria-label": t("quality.loading") } });
    }
  }
  closeForBack(): boolean {
    if (!this.openPanel) return false;
    this.showPanel(null); return true;
  }
  dispose(): void {
    this.queueControls.dispose(); this.off(); this.observer?.disconnect(); this.parent.removeClass("has-mini");
    this.parent.ownerDocument.removeEventListener("pointerdown", this.outside);
    this.parent.ownerDocument.removeEventListener("pointerup", this.releaseSeek);
    this.parent.ownerDocument.removeEventListener("pointercancel", this.releaseSeek);
    this.parent.ownerDocument.removeEventListener("keydown", this.escape);
    this.parent.style.removeProperty("--mw-mini-height"); this.root.remove();
  }
}
