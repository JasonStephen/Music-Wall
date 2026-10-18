import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type MusicWallPlugin from "../main";
import type { AlbumMeta } from "../types";
import { LIBRARY_VIEW_TYPE } from "../types";
import type { CloudPlaylist } from "../core/library";
import { t } from "../i18n";
import { sizedCover } from "../core/metadata";
import { DEFAULT_COVER } from "./defaultCover";
import { handleZoomWheel, syncZoomBox, disposeZoomBox } from "./zoom";
import { watchHostInset } from "./hostInset";

type Tab = "created" | "collected" | "likes" | "search";
export class MusicLibraryView extends ItemView {
  private tab: Tab = "created";
  private generation = 0;
  private keyword = "";
  private offset = 0;
  private lists: CloudPlaylist[] = [];
  private collection: AlbumMeta | null = null;
  private stopInset: (() => void) | null = null;
  private auth = "";
  constructor(leaf: WorkspaceLeaf, private plugin: MusicWallPlugin) { super(leaf); }
  getViewType(): string { return LIBRARY_VIEW_TYPE; }
  getDisplayText(): string { return t("library.title"); }
  getIcon(): string { return "list-music"; }
  async onOpen(): Promise<void> {
    this.registerDomEvent(this.contentEl, "wheel", (event: WheelEvent) => handleZoomWheel(event, this.plugin, this.contentEl), { capture: true, passive: false });
    this.render(); this.stopInset = watchHostInset(this.contentEl); await this.loadContent();
  }
  async onClose(): Promise<void> { ++this.generation; this.stopInset?.(); disposeZoomBox(this.contentEl); }
  syncZoomBox(): void { syncZoomBox(this.contentEl, this.plugin.settings.zoomScale); }
  refresh(): void {
    const auth = this.plugin.settings.neteaseCookie;
    if (auth !== this.auth) { this.auth = auth; this.collection = null; this.lists = []; ++this.generation; this.plugin.libraryApi.clear(); this.render(); if (auth) void this.loadContent(); }
    else this.render();
  }
  private iconButton(parent: HTMLElement, name: string, label: string, action: () => void): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "mw-cloud__icon", attr: { "aria-label": label, title: label } });
    setIcon(button, name); button.addEventListener("click", action); return button;
  }
  private render(): void {
    const root = this.contentEl; root.empty(); root.addClass("mw-view", "mw-cloud");
    const box = root.createDiv({ cls: "mw-zoombox" });
    const head = box.createDiv({ cls: "mw-cloud__head" }); head.createEl("h2", { text: t("library.title") });
    this.iconButton(head, "refresh-cw", t("library.refresh"), () => { this.plugin.libraryApi.clear(); this.collection = null; void this.loadContent(); });
    this.iconButton(head, "disc", t("cmd.openPlayer"), () => void this.plugin.openPlayerView());
    if (!this.plugin.settings.neteaseCookie) {
      const empty = box.createDiv({ cls: "mw-cloud__empty" }); empty.createEl("p", { text: t("auth.signedOutDesc") });
      empty.createEl("button", { text: t("auth.signIn"), cls: "mod-cta" }).addEventListener("click", () => void this.signIn());
      this.syncZoomBox(); return;
    }
    const tabs = box.createDiv({ cls: "mw-cloud__tabs", attr: { role: "tablist", "aria-label": t("library.title") } });
    for (const tab of ["created", "collected", "likes", "search"] as const) {
      const button = tabs.createEl("button", { text: t(`library.${tab}`), attr: { role: "tab", "aria-selected": String(this.tab === tab) } });
      button.addEventListener("click", () => { this.tab = tab; this.offset = 0; this.collection = null; this.lists = []; void this.loadContent(); });
    }
    if (this.tab === "search" && !this.collection) {
      const form = box.createEl("form", { cls: "mw-cloud__search" });
      const input = form.createEl("input", { attr: { type: "search", placeholder: t("library.searchPlaceholder"), "aria-label": t("library.search") } }); input.value = this.keyword;
      form.createEl("button", { text: t("library.search") , attr: { type: "submit" } });
      form.addEventListener("submit", event => { event.preventDefault(); this.keyword = input.value.trim(); this.offset = 0; this.lists = []; void this.loadContent(); });
    }
    const body = box.createDiv({ cls: "mw-cloud__body" });
    if (this.collection) this.renderTracks(body, this.collection); else this.renderLists(body);
    this.syncZoomBox();
  }
  private renderLists(body: HTMLElement): void {
    if (!this.lists.length) { body.createDiv({ cls: "mw-cloud__empty", text: this.tab === "search" && !this.keyword ? t("library.searchPlaceholder") : t("library.empty") }); return; }
    const grid = body.createDiv({ cls: "mw-cloud__grid" });
    for (const item of this.lists) {
      const card = grid.createEl("button", { cls: "mw-cloud__card" });
      card.createEl("img", { attr: { src: sizedCover(item.cover || DEFAULT_COVER, 300), alt: "", loading: "lazy" } });
      card.createSpan({ cls: "mw-cloud__name", text: item.name });
      card.createSpan({ cls: "mw-cloud__creator", text: item.creator });
      card.addEventListener("click", () => void this.openPlaylist(item));
    }
  }
  private renderTracks(body: HTMLElement, collection: AlbumMeta): void {
    const head = body.createDiv({ cls: "mw-cloud__collection" });
    this.iconButton(head, "arrow-left", t("common.back"), () => { this.collection = null; void this.loadContent(); });
    head.createEl("img", { attr: { src: sizedCover(collection.cover || DEFAULT_COVER, 160), alt: "" } });
    head.createEl("h3", { text: collection.name });
    this.iconButton(head, "play", t("panel.play"), () => void this.play(collection, 0));
    this.iconButton(head, "list-plus", t("queue.addPlaylist"), () => void (async () => {
      if (!(await this.plugin.ensureNeteaseLogin())) return;
      if (this.plugin.settings.playbackMode !== "internal") { new Notice(t("queue.internalOnly")); return; }
      this.plugin.internalPlayer.enqueuePlaylist(collection); new Notice(t("queue.playlistAdded"));
    })());
    const tracks = body.createDiv({ cls: "mw-cloud__tracks" });
    if (!collection.tracks?.length) tracks.createDiv({ cls: "mw-cloud__empty", text: t("library.empty") });
    collection.tracks?.forEach((track, index) => {
      const row = tracks.createEl("button", { cls: "mw-cloud__track", attr: { "aria-label": t("internal.playTrack", { name: track.name }) } });
      row.createSpan({ text: String(index + 1).padStart(2, "0") });
      const detail = row.createSpan(); detail.createSpan({ cls: "mw-cloud__name", text: track.name }); detail.createSpan({ cls: "mw-cloud__creator", text: track.artists || "" });
      row.createSpan({ cls: "mw-cloud__duration", text: `${Math.floor(track.duration / 60000)}:${String(Math.floor(track.duration / 1000) % 60).padStart(2, "0")}` });
      row.addEventListener("click", () => void this.play(collection, index));
    });
  }
  private async signIn(): Promise<void> { if (await this.plugin.ensureNeteaseLogin(true)) { this.auth = this.plugin.settings.neteaseCookie; await this.loadContent(); } }
  private current(token: number, cookie: string): boolean { return token === this.generation && cookie === this.plugin.settings.neteaseCookie; }
  private async loadContent(): Promise<void> {
    const token = ++this.generation, cookie = this.plugin.settings.neteaseCookie, tab = this.tab;
    this.auth = cookie; this.render(); if (!cookie) return;
    if (tab === "search" && !this.keyword) return;
    const body = this.contentEl.querySelector<HTMLElement>(".mw-cloud__body")!; body.empty(); body.createDiv({ cls: "mw-cloud__empty", text: t("mini.loading") });
    try {
      let uid = Number(this.plugin.settings.neteaseUserId);
      if (!(uid > 0)) { if (!(await this.plugin.ensureNeteaseLogin(true)) || !this.current(token, cookie)) return; uid = Number(this.plugin.settings.neteaseUserId); }
      if (tab === "likes") {
        const collection = await this.plugin.libraryApi.liked(uid, cookie); if (!this.current(token, cookie)) return; this.collection = collection;
      } else if (tab === "search") {
        const result = await this.plugin.libraryApi.search(this.keyword, cookie, this.offset); if (!this.current(token, cookie)) return;
        this.lists = this.offset ? [...this.lists, ...result.items] : result.items; this.render();
        if (result.more) this.contentEl.querySelector('.mw-cloud__body')!.createEl('button', { cls: 'mw-cloud__more', text: t('library.more') }).addEventListener('click', () => { this.offset += 30; void this.loadContent(); });
        return;
      } else {
        const lists = await this.plugin.libraryApi.userPlaylists(uid, cookie); if (!this.current(token, cookie)) return;
        this.lists = lists.filter(item => tab === "created" ? item.owner === uid : item.owner !== uid);
      }
      this.render();
    } catch { if (this.current(token, cookie)) this.showError(); }
  }
  private showError(): void {
    const body = this.contentEl.querySelector<HTMLElement>(".mw-cloud__body"); if (!body) return; body.empty();
    const empty = body.createDiv({ cls: "mw-cloud__empty" }); empty.createEl("p", { text: t("library.failed") });
    empty.createEl("button", { text: t("library.retry") }).addEventListener("click", () => void this.loadContent());
    empty.createEl("button", { text: t("auth.signIn") }).addEventListener("click", () => void this.signIn());
  }
  private async openPlaylist(item: CloudPlaylist): Promise<void> {
    const token = ++this.generation, cookie = this.plugin.settings.neteaseCookie;
    const body = this.contentEl.querySelector<HTMLElement>(".mw-cloud__body")!; body.empty(); body.createDiv({ cls: "mw-cloud__empty", text: t("mini.loading") });
    try { const collection = await this.plugin.libraryApi.detail(item, cookie); if (!this.current(token, cookie)) return; this.collection = collection; this.render(); }
    catch { if (this.current(token, cookie)) this.showError(); }
  }
  private async play(collection: AlbumMeta, index: number): Promise<void> {
    if (!(await this.plugin.ensureNeteaseLogin())) return;
    if (this.plugin.settings.playbackMode !== "internal") { new Notice(t("queue.internalOnly")); return; }
    await this.plugin.internalPlayer.playPlaylist(collection, index);
  }
}
