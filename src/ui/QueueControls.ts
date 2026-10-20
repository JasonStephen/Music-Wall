import { setIcon } from "obsidian";
import { t } from "../i18n";
import type { InternalPlayer } from "../core/internalPlayer";

/** Shared queue controls for the player page and every wall footer. */
export class QueueControls {
  private off: () => void;
  private key = "";
  view: "album" | "playlist";
  private dragging = "";
  private disposed = false;
  constructor(private root: HTMLElement, private player: InternalPlayer, private authorize: () => Promise<boolean>, private onView: () => void = () => {}, private onPreferenceChange: () => void = () => {}) {
    this.view = player.contentKind;
    root.addClass("mw-queue"); this.off = player.on(() => { if (this.update()) this.onView(); }); this.update();
  }
  private button(parent: HTMLElement, icon: string, label: string, action: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "clickable-icon mw-queue__button", attr: { title: label, "aria-label": label } });
    setIcon(button, icon); button.addEventListener("click", action); return button;
  }
  private update(): boolean {
    const key = `${this.player.contentKind}|${this.player.order}|${this.player.currentEntryId}|${this.player.albumQueue.map(entry => entry.id).join()}|${this.player.songQueue.map(track => track.id).join()}|${this.view}|${this.player.revision}|${this.player.queuedPlaylist?.tracks?.length || 0}`;
    if (key === this.key) return false; this.key = key;
    this.root.empty();
    const toolbar = this.root.createDiv({ cls: "mw-queue__toolbar" });
    const tabs = toolbar.createDiv({ cls: "mw-queue__tabs", attr: { role: "tablist", "aria-label": t("player.playlistTip") } });
    for (const kind of ["playlist", "album"] as const) {
      const label = t(kind === "playlist" ? "queue.playlistQueue" : "queue.title");
      const count = kind === "playlist" ? this.player.songQueue.length : this.player.albumQueue.length;
      const tab = this.button(tabs, kind === "playlist" ? "list-music" : "disc", label, () => {
        this.view = kind; this.update(); this.onView(); this.root.querySelector<HTMLButtonElement>(`[data-queue-view="${kind}"]`)?.focus();
      });
      tab.createSpan({ text: `${label} · ${count}` }); tab.dataset.queueView = kind;
      if (kind === "album") tab.dataset.action = "album-queue";
      tab.setAttr("role", "tab"); tab.setAttr("aria-selected", String(this.view === kind));
    }
    const head = toolbar.createDiv({ cls: "mw-queue__head" });
    head.createSpan({ cls: "mw-queue__kind", text: t(`queue.${this.player.contentKind}Mode`) });
    const currentView = this.player.contentKind === "playlist" ? "playlist" : "album";
    if (this.view !== currentView) this.button(head, "arrow-right-left", t("queue.switchCurrent"), () => { this.view = currentView; this.update(); this.onView(); });
    const icons = { order: "list-ordered", repeat: "repeat", one: "repeat-1", shuffle: "shuffle" };
    const modeLabel = () => t(`queue.${this.player.order === "repeat" && this.player.contentKind === "playlist" ? "repeatList" : this.player.order}`);
    const mode = this.button(head, icons[this.player.order], modeLabel(), () => {
      const orders = this.player.allowedOrders;
      this.player.setOrder(orders[(orders.indexOf(this.player.order) + 1) % orders.length]);
      this.onPreferenceChange();
    });
    mode.dataset.action = "play-order"; mode.createSpan({ text: modeLabel() });
    if (this.view !== "album") return this.renderSongs(toolbar);
    const list = this.root.createDiv({ cls: "mw-queue__list" });
    if (!this.player.albumQueue.length) { list.createDiv({ cls: "mw-queue__empty", text: t("queue.empty") }); return true; }
    this.player.albumQueue.forEach((entry, index) => {
      const current = entry.id === this.player.currentEntryId;
      const row = list.createDiv({ cls: `mw-queue__row${current ? " is-current" : ""}`, attr: { "data-entry": entry.id } });
      row.draggable = !current;
      const grip = row.createSpan({ cls: "mw-queue__grip", attr: { "aria-hidden": "true" } }); setIcon(grip, current ? "disc" : "grip-vertical");
      const play = row.createEl("button", { cls: "mw-queue__name", text: entry.album.name, attr: { title: entry.album.name } });
      play.addEventListener("click", () => void (async () => { if (await this.authorize() && !this.disposed) await this.player.playQueued(entry.id); })());
      const actions = row.createDiv({ cls: "mw-queue__actions" });
      for (const direction of [-1, 1]) {
        let target = index + direction;
        if (this.player.albumQueue[target]?.id === this.player.currentEntryId) target += direction;
        const move = this.button(actions, direction < 0 ? "chevron-up" : "chevron-down", t(direction < 0 ? "queue.up" : "queue.down"), () => this.player.moveQueued(entry.id, target));
        move.disabled = current || target < 0 || target >= this.player.albumQueue.length;
      }
      this.button(actions, "x", t("queue.remove"), () => void this.player.removeQueued(entry.id));
      row.addEventListener("dragstart", event => {
        if (current) { event.preventDefault(); return; }
        this.dragging = entry.id; event.dataTransfer?.setData("application/x-mw-album-queue", entry.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragover", event => { if (!current && (this.dragging || event.dataTransfer?.types.includes("application/x-mw-album-queue"))) event.preventDefault(); });
      row.addEventListener("drop", event => {
        const id = event.dataTransfer?.getData("application/x-mw-album-queue") || this.dragging;
        if (id && !current) { event.preventDefault(); event.stopPropagation(); this.player.moveQueued(id, index); }
        this.dragging = "";
      });
      row.addEventListener("dragend", () => { this.dragging = ""; });
    });
    return true;
  }
  private renderSongs(toolbar: HTMLElement): boolean {
    const head = toolbar.querySelector<HTMLElement>(".mw-queue__head");
    if (!head) return true;
    const clear = this.button(head, "trash-2", t("queue.clearSongs"), () => this.player.clearSongQueue());
    clear.disabled = this.player.songQueue.length === 0;
    const list = this.root.createDiv({ cls: "mw-queue__list" });
    if (!this.player.songQueue.length) { list.createDiv({ cls: "mw-queue__empty", text: t("queue.empty") }); return true; }
    this.player.songQueue.forEach((track, index) => {
      const row = list.createDiv({ cls: `mw-queue__row${this.player.album?.tracks?.[this.player.index]?.id === track.id && this.player.contentKind === "playlist" ? " is-current" : ""}`, attr: { "data-song": String(track.id) } });
      row.createSpan({ cls: "mw-queue__number", text: String(index + 1).padStart(2, "0") });
      const play = row.createEl("button", { cls: "mw-queue__name", text: track.name, attr: { title: track.name } });
      play.addEventListener("click", () => void this.player.playPlaylist({albumId:0,name:track.name,artist:track.artists||"",cover:track.cover||"",trackCount:this.player.songQueue.length,tracks:this.player.songQueue.map(item=>({...item}))}, index));
      const actions = row.createDiv({ cls: "mw-queue__actions" });
      row.createSpan({ cls: "mw-queue__duration", text: `${Math.floor(track.duration / 60000)}:${String(Math.floor(track.duration / 1000) % 60).padStart(2, "0")}` });
      this.button(actions, "trash-2", t("queue.removeSong"), () => void this.player.removeSong(track.id));
    });
    return true;
  }
  get collection() {
    return this.view === "playlist" ? (this.player.songQueue.length ? {albumId:0,name:t("queue.playlistQueue"),artist:"",cover:"",trackCount:this.player.songQueue.length,tracks:this.player.songQueue} : null) : this.player.contentKind === "album" ? this.player.album : null;
  }
  async selectTrack(index: number): Promise<void> {
    const collection = this.collection;
    const track = collection?.tracks?.[index];
    if (!collection || !track || !(await this.authorize()) || this.disposed || collection !== this.collection) return;
    const selected = collection.tracks!.indexOf(track); if (selected < 0) return;
    if (this.player.album === collection) await this.player.select(selected);
    else await this.player.playPlaylist(collection, selected);
  }
  isCurrent(index: number): boolean { return this.collection === this.player.album && index === this.player.index; }
  dispose(): void { this.disposed = true; this.off(); }
}
