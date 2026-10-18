import { setIcon } from "obsidian";
import type MusicWallPlugin from "../main";
import { t } from "../i18n";
import { sizedCover } from "../core/metadata";
import { qualityLabel, type AudioQuality } from "../core/quality";
import { DEFAULT_COVER } from "./defaultCover";
import { decorateRange, paintRange } from "./range";
import { QueueControls } from "./QueueControls";

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};
type Panel = "playlist" | "quality" | "volume";

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
  private qualityText: HTMLElement;
  private volumeButton: HTMLButtonElement;
  private seek: HTMLInputElement;
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
    this.seek.addEventListener("input", () => { paintRange(this.seek); void plugin.internalPlayer.seek(Number(this.seek.value) * 1000); });
    const left = this.root.createDiv({ cls: "mw-mini__left" });
    const open = left.createEl("button", { cls: "mw-mini__open", attr: { title: t("mini.open"), "aria-label": t("mini.open") } });
    this.cover = open.createEl("img", { cls: "mw-mini__cover", attr: { alt: "" } });
    const meta = open.createSpan({ cls: "mw-mini__meta" });
    this.title = meta.createSpan({ cls: "mw-mini__title" });
    this.artist = meta.createSpan({ cls: "mw-mini__artist" });
    this.time = meta.createSpan({ cls: "mw-mini__time" });
    open.addEventListener("click", () => void plugin.openPlayerView());
    const controls = left.createDiv({ cls: "mw-mini__controls" });
    this.previous = this.button(controls, "prev", "skip-back", t("player.prevTip"), () => void this.control("prev"));
    this.toggle = this.button(controls, "toggle", "play", t("player.toggleTip"), () => void this.control("toggle"));
    this.next = this.button(controls, "next", "skip-forward", t("player.nextTip"), () => void this.control("next"));
    const tools = this.root.createDiv({ cls: "mw-mini__tools" });
    this.buttons.playlist = this.button(tools, "playlist", "list-music", t("player.playlistTip"), () => this.showPanel("playlist"));
    this.buttons.quality = this.button(tools, "quality", "", t("quality.choose"), () => this.showPanel("quality"));
    this.qualityText = this.buttons.quality.createSpan();
    setIcon(this.buttons.quality.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } }), "chevron-down");
    this.volumeButton = this.buttons.volume = this.button(tools, "volume", "volume-2", t("internal.volume"), () => this.showPanel("volume"));
    this.button(tools, "expand", "maximize-2", t("mini.open"), () => void plugin.openPlayerView());
    for (const name of ["playlist", "quality", "volume"] as const) {
      this.buttons[name].setAttr("aria-expanded", "false");
      this.panels[name] = this.root.createDiv({ cls: `mw-mini__panel mw-mini__${name} is-hidden`, attr: { role: "group", "aria-label": this.buttons[name].getAttribute("aria-label")! } });
    }
    this.queueControls = new QueueControls(this.panels.playlist.createDiv(), plugin.internalPlayer, () => plugin.ensureNeteaseLogin());
    this.playlistBody = this.panels.playlist.createDiv();
    this.volume = this.panels.volume.createEl("input", { cls: "mw-range", attr: { type: "range", min: "0", max: "1", step: "0.01", "aria-label": t("internal.volume") } });
    decorateRange(this.volume, true);
    this.volume.addEventListener("input", () => plugin.internalPlayer.setVolume(Number(this.volume.value)));
    parent.ownerDocument.addEventListener("pointerdown", this.outside);
    parent.ownerDocument.addEventListener("keydown", this.escape);
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
    const target = event.target as Element;
    if (this.openPanel && !(this.root.contains(target) && target.closest(".mw-mini__panel, .mw-mini__tools"))) this.showPanel(null);
  };
  private escape = (event: KeyboardEvent) => {
    if (event.key === "Escape" && this.openPanel) {
      const button = this.buttons[this.openPanel]; this.showPanel(null); button.focus();
    }
  };
  private showPanel(name: Panel | null): void {
    this.openPanel = name === this.openPanel ? null : name;
    for (const key of ["playlist", "quality", "volume"] as const) {
      const open = key === this.openPanel;
      this.panels[key].toggleClass("is-hidden", !open);
      this.buttons[key].setAttr("aria-expanded", String(open));
      this.buttons[key].toggleClass("is-active", open);
    }
  }
  private reserveSpace(): void {
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
    const album = this.plugin.internalPlayer.album;
    if (!(await this.plugin.ensureNeteaseLogin()) || this.plugin.internalPlayer.album !== album) return;
    await this.plugin.internalPlayer.select(index);
  }
  private async selectQuality(quality: AudioQuality): Promise<void> {
    const player = this.plugin.internalPlayer, song = player.state.songId;
    this.showPanel(null);
    if (!(await this.plugin.ensureNeteaseLogin()) || player.state.songId !== song) return;
    await player.setQuality(quality);
  }
  private update(): void {
    const player = this.plugin.internalPlayer;
    this.visible = !!player?.album;
    this.root.toggleClass("is-hidden", !this.visible);
    this.reserveSpace();
    if (!this.visible) { this.showPanel(null); return; }
    const state = player.state;
    this.title.setText(state.title); this.title.title = state.title;
    this.artist.setText(player.error || (player.loading ? t("mini.loading") : `${state.artist}${state.status === "paused" ? ` · ${t("mini.paused")}` : ""}`));
    this.artist.title = this.artist.textContent ?? "";
    this.time.setText(`${clock(state.positionMs)} / ${clock(state.durationMs)}`);
    const cover = player.currentCover || DEFAULT_COVER;
    if (cover !== this.coverKey) { this.coverKey = cover; this.cover.src = sizedCover(cover, 160); }
    if (player.playingRequested !== this.playing) { this.playing = player.playingRequested; setIcon(this.toggle, this.playing ? "pause" : "play"); }
    this.previous.disabled = !state.canPrev; this.next.disabled = !state.canNext;
    this.seek.disabled = !state.seekable;
    this.seek.max = String(Math.max(1, state.durationMs / 1000));
    if (this.seek.ownerDocument.activeElement !== this.seek) this.seek.value = String(state.positionMs / 1000);
    paintRange(this.seek);
    if (this.volume.ownerDocument.activeElement !== this.volume) this.volume.value = String(player.volume);
    paintRange(this.volume); this.volume.setAttr("aria-valuetext", `${Math.round(player.volume * 100)}%`);
    const icon = player.volume === 0 ? "volume-x" : player.volume < .5 ? "volume-1" : "volume-2";
    if (icon !== this.volumeIcon) { this.volumeIcon = icon; setIcon(this.volumeButton, icon); }
    this.qualityText.setText(player.quality ? qualityLabel(player.quality) : "…");
    const albumKey = JSON.stringify([player.album?.albumId, player.album?.playlistId, player.album?.tracks]);
    if (this.albumKey !== albumKey) {
      this.albumKey = albumKey; this.playlistBody.empty(); this.trackRows = [];
      this.playlistBody.createDiv({ cls: "mw-mini__playlist-title", text: player.album?.name });
      const tracks = this.playlistBody.createDiv({ cls: "mw-mini__tracks" });
      player.album?.tracks?.forEach((track, index) => {
        const row = tracks.createEl("button", { cls: "mw-mini__track", attr: { "aria-label": t("internal.playTrack", { name: track.name }) } });
        row.createSpan({ text: String(index + 1).padStart(2, "0") });
        row.createSpan({ cls: "mw-mini__track-name", text: track.name });
        row.createSpan({ text: clock(track.duration) });
        row.addEventListener("click", () => void this.selectTrack(index)); this.trackRows.push(row);
      });
    }
    this.trackRows.forEach((row, index) => { row.toggleClass("is-current", index === player.index); row.setAttr("aria-current", String(index === player.index)); });
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
  dispose(): void {
    this.queueControls.dispose(); this.off(); this.observer?.disconnect(); this.parent.removeClass("has-mini");
    this.parent.ownerDocument.removeEventListener("pointerdown", this.outside);
    this.parent.ownerDocument.removeEventListener("keydown", this.escape);
    this.parent.style.removeProperty("--mw-mini-height"); this.root.remove();
  }
}
