import { setIcon } from "obsidian";
import { t } from "../i18n";
import type { InternalPlayer } from "../core/internalPlayer";

/** Shared queue controls for the player page and every wall footer. */
export class QueueControls {
  private off: () => void;
  private key = "";
  private expanded = false;
  private dragging = "";
  constructor(private root: HTMLElement, private player: InternalPlayer, private authorize: () => Promise<boolean>) {
    root.addClass("mw-queue"); this.off = player.on(() => this.update()); this.update();
  }
  private button(parent: HTMLElement, icon: string, label: string, action: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "mw-queue__button", attr: { title: label, "aria-label": label } });
    setIcon(button, icon); button.addEventListener("click", action); return button;
  }
  private update(): void {
    const key = `${this.player.contentKind}|${this.player.order}|${this.player.currentEntryId}|${this.player.albumQueue.map(entry => entry.id).join()}|${this.expanded}|${this.player.queuedPlaylist?.tracks?.length || 0}`;
    if (key === this.key) return; this.key = key;
    this.root.empty();
    const head = this.root.createDiv({ cls: "mw-queue__head" });
    head.createSpan({ cls: "mw-queue__kind", text: t(`queue.${this.player.contentKind}Mode`) });
    const icons = { order: "list-ordered", repeat: "repeat", one: "repeat-1", shuffle: "shuffle" };
    const modeLabel = () => t(`queue.${this.player.order === "repeat" && this.player.contentKind === "playlist" ? "repeatList" : this.player.order}`);
    const mode = this.button(head, icons[this.player.order], modeLabel(), () => {
      const orders = this.player.allowedOrders;
      this.player.setOrder(orders[(orders.indexOf(this.player.order) + 1) % orders.length]);
    });
    if (this.player.contentKind === "album" && this.player.queuedPlaylist?.tracks?.length) {
      const playlist = this.button(head, "list-music", t("queue.playlistQueue"), () => void (async () => { if (await this.authorize()) await this.player.resumePlaylist(); })());
      playlist.createSpan({ text: t("queue.playlistQueue") });
    }
    mode.dataset.action = "play-order"; mode.setAttr("aria-label", modeLabel());
    mode.createSpan({ text: t(`queue.${this.player.order}`) });
    const expand = this.button(head, this.expanded ? "chevron-up" : "list-music", t("queue.title"), () => { this.expanded = !this.expanded; this.update(); });
    expand.dataset.action = "album-queue"; expand.setAttr("aria-expanded", String(this.expanded)); expand.createSpan({ text: `${t("queue.title")} · ${this.player.albumQueue.length}` });
    if (!this.expanded) return;
    const list = this.root.createDiv({ cls: "mw-queue__list" });
    if (!this.player.albumQueue.length) { list.createDiv({ cls: "mw-queue__empty", text: t("queue.empty") }); return; }
    this.player.albumQueue.forEach((entry, index) => {
      const current = entry.id === this.player.currentEntryId;
      const row = list.createDiv({ cls: `mw-queue__row${current ? " is-current" : ""}`, attr: { "data-entry": entry.id } });
      row.draggable = !current;
      const grip = row.createSpan({ cls: "mw-queue__grip", attr: { "aria-hidden": "true" } }); setIcon(grip, current ? "disc" : "grip-vertical");
      const play = row.createEl("button", { cls: "mw-queue__name", text: entry.album.name, attr: { title: entry.album.name } });
      play.addEventListener("click", () => void (async () => { if (await this.authorize()) await this.player.playQueued(entry.id); })());
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
  }
  dispose(): void { this.off(); }
}
