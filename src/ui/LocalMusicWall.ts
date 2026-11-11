import { Menu, Notice, setIcon } from "obsidian";
import type MusicWallPlugin from "../main";
import type { AlbumMeta, AlbumTrackSnapshot, SortMode } from "../types";
import { addFolder, addSongs, createPlaylist, descendants, folderKey, folderPath, moveEntries, moveFolder, removeEntries, removeFolder, WALL_KINDS, type LibraryEntry, type LibraryFolder, type SavedCollection, type WallKind, type WallLocation } from "../core/wallLibrary";
import { SONG_MIME, COLLECTION_MIME, MouseSelection, readSongs, readCollection, songSource, reorderIds } from "./libraryDrag";
import { t, styleLabel } from "../i18n";
import { svgAction } from "./svgAction";
import { buildDiscElement, makeCoverImg } from "./disc";
import { DEFAULT_COVER } from "./defaultCover";
import { WALL_STYLES } from "../core/wallLibrary";
import { sizedCover } from "../core/metadata";
import { bindLibraryMenu, type LibraryMenuAction } from "./libraryMenu";
import { ConfirmModal } from "./ConfirmModal";
import { WallDestinationModal, WallTextModal } from "./WallDestinationModal";
import { RatingModal } from "./RatingModal";
import { collectionSummary } from "./collectionSummary";
import { playAlbum } from "../core/playback";
import { SongPager } from "./SongPager";

const MIME = "application/x-music-wall-library";
const iconFor = (kind: WallKind) => kind === "albums" ? "disc-3" : kind === "local" ? "list-music" : "bookmark";
interface WallHost {
  render(): void;
  renderNav(): void;
  remember(): void;
  back(): void;
  enter(): void;
  openSearch(kind: "albums" | "playlists"): void;
  renderTracks(parent: HTMLElement, tracks: AlbumTrackSnapshot[], collection: AlbumMeta): void;
  trackActions(track: AlbumTrackSnapshot, collection: AlbumMeta, index: number): LibraryMenuAction[];
}
export class LocalMusicWall {
  location: WallLocation;
  private keyword = "";
  private allSearch = false;
  private recursive = false;
  private cards = new MouseSelection<string>();
  private songs = new MouseSelection<number>();
  private expanded = new Set<string>();
  private selected = new Set<number>();
  private songQuery = "";
  private songSort = "manual";
  private songAsc = true;
  private detail: AlbumMeta | null = null;
  private failed = false;
  private partial = false;
  private loading = false;
  private request = 0;
  private disposed = false;
  private cleanup: (() => void)[] = [];
  private navCleanup: (() => void)[] = [];
  private main!: HTMLElement;
  constructor(private plugin: MusicWallPlugin, private host: WallHost) {
    this.location = { ...plugin.wallLibrary.data.last };
    const collection = this.collection;
    // Restore the folder for large collections; open details only on user action.
    if (Math.max(collection?.meta.trackCount || 0, collection?.meta.tracks?.length || 0) > SongPager.size) delete this.location.entry;
  }
  private get data() { return this.plugin.wallLibrary.data; }
  private get entry() { return this.data.entries.find(e => e.id === this.location.entry); }
  private get collection() { return this.data.collections.find(c => c.id === this.entry?.collection); }
  private async update(change: Parameters<typeof this.plugin.wallLibrary.update>[0]): Promise<void> { await this.plugin.wallLibrary.update(change); }
  private saveLocation(): void { const last = { ...this.location }; void this.update(d => { d.last = last; }).catch(() => new Notice(t("localWall.updateFailed"))); }
  open(kind: WallKind | null, folder: string | null = null, entry?: string): void {
    this.host.remember(); this.cards.clear(); this.songs.clear();
    this.host.enter();
    this.request++; this.location = { kind, folder, entry }; this.keyword = ""; this.detail = null; this.selected.clear(); this.songQuery = ""; this.songSort = "manual"; this.loading = false; this.failed = false; this.partial = false;
    this.saveLocation(); this.host.render();
    if (entry) void this.loadDetail();
  }
  async restore(): Promise<void> { if (this.location.entry) await this.loadDetail(); }
  back(): void {
    this.host.back();
  }
  capture(): () => void {
    const state = { location: { ...this.location }, keyword: this.keyword, detail: this.detail, songQuery: this.songQuery, failed: this.failed, partial: this.partial };
    return () => { ++this.request; Object.assign(this, state); this.loading = false; this.cards.clear(); this.songs.clear(); this.selected.clear(); this.saveLocation(); if (this.location.entry && !this.detail) void this.loadDetail(); };
  }
  private menu(host: HTMLElement, actions: () => LibraryMenuAction[], nav = false, cleanup = this.cleanup): void {
    const menu = bindLibraryMenu(host, actions); (nav ? this.navCleanup : cleanup).push(menu.dispose);
    if (!nav) {
      const more = svgAction(host, "ellipsis", t("libraryDetails.moreActions"), () => { const r = more.getBoundingClientRect(); menu.open(r.right, r.bottom); });
      more.addClass("mw-local__more"); more.addEventListener("click", event => event.stopPropagation());
    }
  }
  private popup(anchor: HTMLElement, actions: LibraryMenuAction[]): void {
    const menu = new Menu(); for (const a of actions) menu.addItem(item => item.setSection("music-wall").setTitle(a.label).setIcon(a.icon).onClick(() => { void Promise.resolve(a.run()).catch(() => new Notice(t("localWall.updateFailed"))); }));
    const r = anchor.getBoundingClientRect(); menu.showAtPosition({ x: r.right, y: r.bottom }); this.cleanup.push(() => menu.hide());
  }
  renderNav(parent: HTMLElement, activate: () => void): void {
    this.navCleanup.splice(0).forEach(fn => fn());
    const tree = parent.createDiv({ cls: "mw-local-tree" });
    for (const kind of WALL_KINDS) {
      const section = tree.createDiv({ cls: "mw-local-tree__section" });
      const root = section.createDiv({ cls: "mw-local-tree__row" });
      const state = this.rootCollapsed.has(kind);
      const toggle = svgAction(root, state ? "chevron-right" : "chevron-down", t(`localWall.${kind}`), () => { if (state) this.rootCollapsed.delete(kind); else this.rootCollapsed.add(kind); this.host.renderNav(); });
      toggle.setAttr("aria-expanded", String(!state));
      const button = svgAction(root, iconFor(kind), t(`localWall.${kind}`), () => { activate(); this.open(kind); }, true);
      button.dataset.wallKind = kind; if (this.location.kind === kind && !this.location.folder && !this.location.entry) button.setAttr("aria-current", "page");
      this.dropTarget(root, kind, null);
      this.menu(root, () => [{ label: t("localWall.newFolder"), icon: "folder-plus", run: () => this.newFolder(kind, null) }, ...(kind === "local" ? [{ label: t("localWall.newPlaylist"), icon: "list-plus", run: () => this.newPlaylist(null) }] : [])], true);
      if (!state) this.treeFolders(section, kind, null, 0, activate);
    }
  }
  private rootCollapsed = new Set<WallKind>(WALL_KINDS);
  private treeFolders(parent: HTMLElement, kind: WallKind, folder: string | null, depth: number, activate: () => void): void {
    for (const f of this.sortedFolders(kind, folder)) {
      const row = parent.createDiv({ cls: "mw-local-tree__row" }); row.style.setProperty("--mw-tree-depth", String(depth + 1));
      const hasChildren = this.data.folders.some(child => child.parent === f.id) || this.data.entries.some(e => e.folder === f.id);
      const toggle = svgAction(row, this.expanded.has(f.id) ? "chevron-down" : "chevron-right", f.name, () => { if (this.expanded.has(f.id)) this.expanded.delete(f.id); else this.expanded.add(f.id); this.host.renderNav(); });
      toggle.setAttr("aria-expanded", String(this.expanded.has(f.id))); if (!hasChildren) toggle.style.visibility = "hidden";
      const button = svgAction(row, "folder", f.name, () => { activate(); this.open(kind, f.id); }, true);
      button.dataset.wallFolder = f.id; if (this.location.folder === f.id) button.setAttr("aria-current", "page");
      this.dragSource(row, { type: "folder", id: f.id, kind }); this.dropTarget(row, kind, f.id); this.menu(row, () => this.folderActions(f), true);
      if (this.expanded.has(f.id)) this.treeFolders(parent, kind, f.id, depth + 1, activate);
    }
    for (const e of this.sortedEntries(kind, folder)) {
      const c = this.data.collections.find(c => c.id === e.collection)!;
      const row = parent.createDiv({ cls: "mw-local-tree__row", attr: { "data-nav-entry": e.id } }); row.style.setProperty("--mw-tree-depth", String(depth + 1));
      svgAction(row, iconFor(kind), c.meta.name, () => { activate(); this.open(kind, folder, e.id); }, true);
      this.dragSource(row, { type: "entry", id: e.id, kind }); this.entryDrop(row, e, c); this.menu(row, () => this.entryActions(e, c), true);
    }
  }
  render(parent: HTMLElement, head: HTMLElement): void {
    this.cleanup.splice(0).forEach(fn => fn()); this.main = parent;
    if (this.location.folder && !this.data.folders.some(f => f.id === this.location.folder && f.kind === this.location.kind)) this.location = { kind: this.location.kind, folder: null };
    if (this.location.entry && !this.entry) { this.location.entry = undefined; this.detail = null; }
    if (this.location.entry) { this.renderDetail(parent, head); return; }
    if (!this.location.kind) { this.renderLanding(parent); return; }
    const fixed = head.createDiv({ cls: "mw-local__fixed" });
    this.renderBreadcrumbs(fixed); this.renderToolbar(fixed);
    const controls = fixed.createDiv({ cls: "mw-local__search" });
    const search = controls.createEl("input", { attr: { type: "search", placeholder: t("localWall.search"), "aria-label": t("localWall.search") } }); search.value = this.keyword;
    search.addEventListener("input", () => { this.keyword = search.value; this.renderContents(contents); });
    const recursive = svgAction(controls, "folders", t("localWall.includeChildren"), () => { this.recursive = !this.recursive; recursive.setAttr("aria-pressed", String(this.recursive)); this.renderContents(contents); }); recursive.setAttr("aria-pressed", String(this.recursive));
    const all = svgAction(controls, "search", t("localWall.searchAll"), () => { this.allSearch = !this.allSearch; all.setAttr("aria-pressed", String(this.allSearch)); this.renderContents(contents); }); all.setAttr("aria-pressed", String(this.allSearch));
    const layouts = controls.createDiv({ cls: "mw-local__layouts" }); this.renderLayouts(layouts);
    const contents = parent.createDiv({ cls: "mw-local__contents" }); this.renderContents(contents);
  }
  private renderLanding(parent: HTMLElement): void {
    const landing = parent.createDiv({ cls: "mw-local__landing" });
    for (const kind of WALL_KINDS) {
      const button = landing.createEl("button", { cls: "mw-local__portal", attr: { type: "button", "data-wall-portal": kind } });
      setIcon(button.createSpan({ cls: "mw-local__portal-icon" }), iconFor(kind)); button.createEl("strong", { text: t(`localWall.${kind}`) });
      button.addEventListener("click", () => this.open(kind));
    }
  }
  private renderBreadcrumbs(parent: HTMLElement): void {
    const nav = parent.createEl("nav", { cls: "mw-local__breadcrumbs", attr: { "aria-label": t("localWall.folder") } });
    svgAction(nav, "library", t("localWall.title"), () => this.open(null), true);
    const kind = this.location.kind!; svgAction(nav, iconFor(kind), t(`localWall.${kind}`), () => this.open(kind), true); this.dropTarget(nav.lastElementChild as HTMLElement, kind, null);
    const ancestors: LibraryFolder[] = []; let id = this.location.folder;
    while (id) { const f = this.data.folders.find(f => f.id === id); if (!f) break; ancestors.unshift(f); id = f.parent; }
    for (const f of ancestors) { const b = svgAction(nav, "chevron-right", f.name, () => this.open(kind, f.id), true); this.dropTarget(b, kind, f.id); }
  }
  private renderToolbar(head: HTMLElement): void {
    const kind = this.location.kind!, folder = this.location.folder;
    const tools = head.createDiv({ cls: "mw-local__tools" });
    const sort = svgAction(tools, "arrow-up-down", t("localWall.sort"), () => this.popup(sort, [
      ...(["manual", "addedAt", "name", "artist", "year", ...(kind === "local" ? [] : ["rating"])] as SortMode[]).map(mode => ({ label: mode === "name" ? t("localWall.name") : t(`labels.sort.${mode}`), icon: this.view().sort === mode ? "check" : "arrow-up-down", run: () => this.setSort(mode) })),
      { label: t(this.view().asc ? "localWall.descending" : "localWall.ascending"), icon: "arrow-down-up", run: () => this.update(d => { const v = this.ensureView(d); v.asc = !v.asc; }) },
    ]));
    const add = svgAction(tools, "plus", t("localWall.add"), () => this.popup(add, [
      { label: t("localWall.newFolder"), icon: "folder-plus", run: () => this.newFolder(kind, folder) },
      ...(kind === "local" ? [{ label: t("localWall.newPlaylist"), icon: "list-plus", run: () => this.newPlaylist(folder) }] : [
        { label: t("localWall.searchAdd"), icon: "search", run: () => this.host.openSearch(kind) },
        { label: t("localWall.links"), icon: "link", run: () => this.addLinks(kind, folder) },
      ]),
    ]));
    if (kind === "albums") {
      const style = svgAction(tools, "disc-3", t("localWall.style"), () => this.popup(style, WALL_STYLES.map(value => ({ label: value === "colored-vinyl" ? t("localWall.coloredVinyl") : styleLabel(value), icon: this.data.appearance.style === value ? "check" : "disc", run: () => this.update(d => { d.appearance.style = value; }) }))));
    }
  }
  private renderLayouts(parent: HTMLElement): void {
    for (const [layout, icon] of [["grid", "layout-grid"], ["list", "list"]] as const) {
      const b = svgAction(parent, icon, t(`localWall.${layout}`), () => this.update(d => { d.appearance.layout = layout; })); b.setAttr("aria-pressed", String(layout === this.data.appearance.layout));
    }
  }
  private view() { return this.data.views[folderKey(this.location.kind!, this.location.folder)] || { sort: "addedAt" as SortMode, asc: true, order: [] }; }
  private ensureView(d: typeof this.data) { const key = folderKey(this.location.kind!, this.location.folder); return d.views[key] || (d.views[key] = { sort: "addedAt", asc: true, order: [] }); }
  private setSort(mode: SortMode): Promise<void> { return this.update(d => { this.ensureView(d).sort = mode; }); }
  private sortedFolders(kind: WallKind, folder: string | null): LibraryFolder[] {
    const view = this.data.views[folderKey(kind, folder)], rank = new Map((view?.order || []).map((id, i) => [id, i]));
    return this.data.folders.filter(f => f.kind === kind && f.parent === folder).sort((a, b) => {
      const cmp = view?.sort === "manual" ? (rank.get(a.id) ?? rank.size + this.data.folders.indexOf(a)) - (rank.get(b.id) ?? rank.size + this.data.folders.indexOf(b)) : a.name.localeCompare(b.name, undefined, { numeric: true });
      return cmp * (view?.asc === false ? -1 : 1);
    });
  }
  private renderContents(parent: HTMLElement): void {
    parent.empty(); const kind = this.location.kind!, folder = this.location.folder, q = this.keyword.trim().toLocaleLowerCase();
    const nested = folder ? descendants(this.data, folder) : null;
    const inside = (id: string | null) => this.allSearch && !!q ? true : q || this.recursive ? !folder || id !== null && nested!.has(id) : id === folder;
    const grid = parent.createDiv({ cls: `mw-local__grid${this.data.appearance.layout === "list" ? " is-list" : ""}` }); this.dropTarget(grid, kind, folder);
    let count = 0;
    for (const f of this.sortedFolders(kind, folder)) {
      if (q && !f.name.toLowerCase().includes(q)) continue;
      const card = grid.createDiv({ cls: "mw-local__card mw-local__folder", attr: { "data-folder-id": f.id } }); count++;
      const open = card.createEl("button", { cls: "mw-local__open", attr: { type: "button" } });
      setIcon(open.createSpan({ cls: "mw-local__folder-art" }), "folder"); open.createDiv({ cls: "mw-local__name", text: f.name });
      const total = this.data.folders.filter(c => c.parent === f.id).length + this.data.entries.filter(e => e.folder === f.id).length;
      open.createDiv({ cls: "mw-local__subtitle", text: t("localWall.folderCount", { count: total }) });
      this.selectCard(card, f.id, () => this.open(kind, f.id));
      this.menu(card, () => this.folderActions(f)); this.dragSource(card, { type: "folder", id: f.id, kind }); this.dropTarget(card, kind, f.id);
    }
    const entries = this.sortedEntries(kind, folder).filter(e => inside(e.folder) && (!q || this.matches(e, q)));
    if (q || this.recursive) {
      for (const e of this.data.entries) { const c = this.data.collections.find(c => c.id === e.collection); if (c?.kind === kind && inside(e.folder) && !entries.includes(e) && (!q || this.matches(e, q))) entries.push(e); }
    }
    for (const e of entries) { const c = this.data.collections.find(c => c.id === e.collection)!; this.renderCard(grid, e, e.snapshot ? { ...c, meta: e.snapshot } : c); count++; }
    this.paintSelection();
    if (!count) parent.createDiv({ cls: "mw-cloud__empty", text: t(q ? "localWall.noResults" : "localWall.emptyFolder") });
  }
  private matches(e: LibraryEntry, q: string): boolean { const c = this.data.collections.find(c => c.id === e.collection)!; return `${c.meta.name} ${c.meta.artist} ${c.meta.description || ""}`.toLowerCase().includes(q); }
  private sortedEntries(kind: WallKind, folder: string | null): LibraryEntry[] {
    const view = this.data.views[folderKey(kind, folder)] || { sort: "addedAt", asc: true, order: [] }, rank = new Map(view.order.map((id, i) => [id, i]));
    return this.data.entries.filter(e => e.folder === folder && this.data.collections.some(c => c.id === e.collection && c.kind === kind)).sort((a, b) => {
      const ca = this.data.collections.find(c => c.id === a.collection)!, cb = this.data.collections.find(c => c.id === b.collection)!;
      let cmp = 0;
      if (view.sort === "manual") cmp = (rank.get(a.id) ?? this.data.entries.indexOf(a) + rank.size) - (rank.get(b.id) ?? this.data.entries.indexOf(b) + rank.size);
      else if (view.sort === "addedAt") cmp = b.addedAt.localeCompare(a.addedAt);
      else if (view.sort === "rating") cmp = (a.rating || 0) - (b.rating || 0);
      else cmp = String(ca.meta[view.sort] || "").localeCompare(String(cb.meta[view.sort] || ""), undefined, { numeric: true });
      return cmp * (view.asc ? 1 : -1);
    });
  }
  private visibleCards(): string[] { return Array.from(this.main?.querySelectorAll<HTMLElement>("[data-entry-id], [data-folder-id]") || []).map(el => el.dataset.entryId || el.dataset.folderId!); }
  private paintSelection(): void { for (const el of Array.from(this.main?.querySelectorAll<HTMLElement>("[data-entry-id], [data-folder-id]") || [])) { const selected = this.cards.ids.has(el.dataset.entryId || el.dataset.folderId!); el.toggleClass("is-selected", selected); el.setAttr("aria-selected", String(selected)); } }
  private selectCard(card: HTMLElement, id: string, open: () => void): void {
    card.addEventListener("click", event => {
      if ((event.target as Element).closest(".mw-local__more")) return;
      this.cards.click(id, this.visibleCards(), event); this.paintSelection();
      if (!event.ctrlKey && !event.metaKey && !event.shiftKey) open();
    });
  }
  private renderCard(parent: HTMLElement, entry: LibraryEntry, c: SavedCollection): void {
    const card = parent.createDiv({ cls: "mw-local__card", attr: { "data-entry-id": entry.id, "data-collection-kind": c.kind } });
    const open = card.createEl("button", { cls: "mw-local__open", attr: { type: "button" } });
    const art = open.createDiv({ cls: "mw-local__art" });
    if (c.kind === "albums" && this.data.appearance.layout === "grid") art.appendChild(buildDiscElement({ albumId: c.meta.albumId, meta: c.meta, source: "search", locked: true, addedAt: entry.addedAt }, this.data.appearance.style === "colored-vinyl" ? "vinyl" : this.data.appearance.style, { coverSize: 300, coloredVinyl: this.data.appearance.style === "colored-vinyl" }));
    else this.renderCover(art, c.meta);
    const info = open.createDiv({ cls: "mw-local__info" }); info.createDiv({ cls: "mw-local__name", text: c.meta.name });
    info.createDiv({ cls: "mw-local__subtitle", text: c.kind === "local" ? t("localWall.folderCount", { count: c.meta.tracks?.length || 0 }) : c.meta.artist });
    if (entry.rating) info.createDiv({ cls: "mw-local__rating", text: "★".repeat(entry.rating), attr: { "aria-label": `${t("localWall.rating")} ${entry.rating}` } });
    if (this.keyword || this.recursive) info.createDiv({ cls: "mw-local__path", text: folderPath(this.data, entry.folder) });
    this.selectCard(card, entry.id, () => this.open(c.kind, entry.folder, entry.id));
    this.menu(card, () => this.entryActions(entry, c)); this.dragSource(card, { type: "entry", id: entry.id, kind: c.kind });
    this.entryDrop(card, entry, c);
  }
  private entryDrop(card: HTMLElement, entry: LibraryEntry, c: SavedCollection): void {
    if (c.kind === "local") this.songTarget(card, c.id);
    card.addEventListener("dragover", event => { if (event.dataTransfer?.types.includes(MIME)) { event.preventDefault(); card.addClass("is-drop-before"); } });
    card.addEventListener("dragleave", () => card.removeClass("is-drop-before"));
    card.addEventListener("drop", event => {
      card.removeClass("is-drop-before"); const payload = this.readDrop(event); if (!payload || payload.type !== "entry" || payload.kind !== c.kind || payload.id === entry.id) return;
      event.preventDefault(); event.stopPropagation();
      void this.update(d => {
        const chosen = payload.ids || [payload.id], moving = chosen.filter(id => d.entries.some(e => e.id === id)), visible = this.sortedEntries(c.kind, entry.folder).map(e => e.id);
        for (const id of chosen) if (d.folders.some(f => f.id === id)) moveFolder(d, id, entry.folder);
        moveEntries(d, moving, entry.folder);
        const key = folderKey(c.kind, entry.folder), v = d.views[key] || (d.views[key] = { sort: "manual", asc: true, order: [] });
        v.order = [...this.sortedFolders(c.kind, entry.folder).map(f => f.id), ...reorderIds([...new Set([...visible, ...moving])], moving, entry.id, this.dropAfter(event, card))]; v.sort = "manual"; v.asc = true;
      }).catch(() => new Notice(t("localWall.folderConflict")));
    });
  }
  renderCover(parent: HTMLElement, meta: AlbumMeta): void {
    const covers = [...new Set((meta.tracks || []).map(s => s.cover).filter((s): s is string => !!s))];
    if (meta.localPlaylistId && covers.length >= 4) { const mosaic = parent.createDiv({ cls: "mw-local__mosaic" }); for (const cover of covers.slice(0, 4)) mosaic.appendChild(makeCoverImg(sizedCover(cover, 200), "")); }
    else if (meta.localPlaylistId && !covers.length) { const empty = parent.createDiv({ cls: "mw-local__placeholder" }); setIcon(empty, "list-music"); }
    else parent.appendChild(makeCoverImg(sizedCover(meta.localPlaylistId ? covers[0] : meta.cover || DEFAULT_COVER, 300), meta.name));
  }
  private folderActions(f: LibraryFolder): LibraryMenuAction[] {
    return [
      { label: t("localWall.newFolder"), icon: "folder-plus", run: () => this.newFolder(f.kind, f.id) },
      { label: t("localWall.rename"), icon: "pencil", run: () => new WallTextModal(this.plugin.app, t("localWall.rename"), f.name, name => this.update(d => { const current = d.folders.find(x => x.id === f.id); if (!current || d.folders.some(x => x.id !== f.id && x.parent === current.parent && x.kind === f.kind && x.name === name)) throw new Error(); current.name = name; })).open() },
      { label: t("localWall.move"), icon: "folder-input", run: () => this.pickMove(f.kind, async id => this.update(d => moveFolder(d, f.id, id)), f.id) },
      { label: t("localWall.delete"), icon: "trash-2", run: () => this.confirm(t("localWall.deleteFolder"), () => this.update(d => removeFolder(d, f.id))) },
    ];
  }
  private entryActions(e: LibraryEntry, c: SavedCollection): LibraryMenuAction[] {
    return [
      { label: t("panel.play"), icon: "play", run: async () => { await playAlbum({ ...c.meta, wallEntryId: e.id }, this.plugin.getPlaybackDeps()); } },
      { label: t(c.kind === "albums" ? "queue.add" : "queue.addPlaylist"), icon: "list-plus", run: () => this.plugin.enqueueAlbum({ ...c.meta, wallEntryId: e.id }) },
      ...(c.kind !== "albums" ? [{ label: t("localWall.clone"), icon: "copy", run: () => this.plugin.cloneLocalPlaylist(c.meta) }] : []),
      { label: t("localWall.move"), icon: "folder-input", run: () => this.pickMove(c.kind, async id => this.update(d => { const ids = this.cards.ids.has(e.id) ? [...this.cards.ids] : [e.id]; for (const value of ids) if (d.folders.some(f => f.id === value)) moveFolder(d, value, id); moveEntries(d, ids.filter(value => d.entries.some(e => e.id === value)), id); })) },
      ...(c.kind !== "local" ? [{ label: t("localWall.rate"), icon: "star", run: () => new RatingModal(this.plugin.app, { albumName: c.meta.name, current: e.rating, onSave: rating => { void this.update(d => { const current = d.entries.find(x => x.id === e.id); if (current) current.rating = rating; }).catch(() => new Notice(t("localWall.updateFailed"))); } }).open() }] : []),
      { label: t(c.kind === "local" ? "localWall.delete" : "localWall.remove"), icon: "trash-2", run: () => this.confirm(t(c.kind === "local" ? "localWall.deletePlaylist" : "localWall.removeConfirm"), () => this.update(d => { const ids = this.cards.ids.has(e.id) ? [...this.cards.ids] : [e.id]; for (const id of ids) if (d.folders.some(f => f.id === id)) removeFolder(d, id); removeEntries(d, ids); this.cards.clear(); })) },
    ];
  }
  private confirm(message: string, action: () => Promise<void>): void { new ConfirmModal(this.plugin.app, { title: t("localWall.title"), message, danger: true, onConfirm: action }).open(); }
  private newFolder(kind: WallKind, folder: string | null): void { new WallTextModal(this.plugin.app, t("localWall.newFolder"), "", name => this.update(d => { addFolder(d, kind, folder, name); })).open(); }
  private newPlaylist(folder: string | null): void {
    new WallTextModal(this.plugin.app, t("localWall.newPlaylist"), "", async name => { let id = ""; await this.update(d => { id = createPlaylist(d, folder, name).id; }); this.open("local", folder, id); }).open();
  }
  private pickMove(kind: WallKind, action: (folder: string | null) => Promise<unknown>, exclude?: string): void {
    const blocked = exclude ? descendants(this.data, exclude) : new Set<string>();
    new WallDestinationModal(this.plugin.app, t("localWall.selectFolder"), [{ id: null, name: t(`localWall.${kind}`), icon: iconFor(kind) }, ...this.data.folders.filter(f => f.kind === kind && !blocked.has(f.id)).map(f => ({ id: f.id, name: folderPath(this.data, f.id), icon: "folder" }))], action).open();
  }
  private addLinks(kind: "albums" | "playlists", folder: string | null): void {
    new WallTextModal(this.plugin.app, t("localWall.linksHint"), "", async text => {
      let added = 0, skipped = 0, failed = 0;
      const cookie = this.plugin.settings.neteaseCookie;
      for (const input of text.split(/[\n\r]+/).map(s => s.trim()).filter(Boolean)) {
        try {
          const id = /^\d+$/.test(input) ? Number(input) : Number(input.match(new RegExp(`${kind === "albums" ? "album" : "playlist"}(?:\\?[^\\s]*?id=|/)(\\d+)`))?.[1]);
          if (!Number.isSafeInteger(id) || id <= 0) throw new Error();
          const meta = kind === "albums" ? await this.plugin.fetchAlbumDetail(id) : await this.plugin.libraryApi.detail({ id, name: "", cover: "", creator: "", count: 0, owner: 0, special: 0 }, cookie);
          if (cookie !== this.plugin.settings.neteaseCookie) throw new Error();
          if (await this.plugin.saveLocalCollection(meta, folder)) added++; else skipped++;
        } catch { failed++; }
      }
      new Notice(t("localWall.linksResult", { added, skipped, failed }));
    }, true).open();
  }
  private dragSource(el: HTMLElement, payload: { type: "folder" | "entry"; id: string; kind: WallKind }): void {
    el.draggable = true;
    el.addEventListener("dragstart", event => {
      if (!event.dataTransfer) return; event.stopPropagation();
      const visible = this.visibleCards(), ids = visible.includes(payload.id) ? this.cards.drag(payload.id, visible) : [payload.id];
      this.paintSelection(); event.dataTransfer.setData(MIME, JSON.stringify({ ...payload, ids })); event.dataTransfer.effectAllowed = "move";
    });
  }
  private readDrop(event: DragEvent): { type: "folder" | "entry"; id: string; ids?: string[]; kind: WallKind } | null {
    try { const p = JSON.parse(event.dataTransfer?.getData(MIME) || ""); return ["folder", "entry"].includes(p.type) && typeof p.id === "string" && WALL_KINDS.includes(p.kind) ? p : null; } catch { return null; }
  }
  private dropTarget(el: HTMLElement, kind: WallKind, folder: string | null): void {
    el.addEventListener("dragover", event => { if (event.dataTransfer?.types.some(type => [MIME, COLLECTION_MIME].includes(type))) { event.preventDefault(); event.stopPropagation(); el.addClass("is-drop-target"); } });
    el.addEventListener("dragleave", () => el.removeClass("is-drop-target"));
    el.addEventListener("drop", event => {
      el.removeClass("is-drop-target");
      const meta = readCollection(event);
      if (meta) {
        if ((meta.playlistId ? "playlists" : "albums") !== kind) return;
        event.preventDefault(); event.stopPropagation();
        void this.plugin.fetchCollectionDetail(meta).then(full => this.plugin.saveLocalCollection(full, folder)).catch(() => new Notice(t("localWall.updateFailed"))); return;
      }
      const p = this.readDrop(event); if (!p || p.kind !== kind) return;
      event.preventDefault(); event.stopPropagation();
      void this.update(d => {
        const source = d.folders.find(f => f.id === p.id), target = d.folders.find(f => f.id === folder);
        const moving = p.ids || [p.id];
        if (p.type === "folder" && source && target && source.id !== target.id && source.parent === target.parent && this.dropEdge(event, el)) {
          const key = folderKey(kind, target.parent), v = d.views[key] || (d.views[key] = { sort: "manual", asc: true, order: [] });
          const folders = this.sortedFolders(kind, target.parent).map(f => f.id);
          v.order = [...reorderIds(folders, moving.filter(id => folders.includes(id)), target.id, this.dropAfter(event, el)), ...this.sortedEntries(kind, target.parent).map(e => e.id)]; v.sort = "manual"; v.asc = true;
        } else {
          for (const id of moving) if (d.folders.some(f => f.id === id)) moveFolder(d, id, folder);
          moveEntries(d, moving.filter(id => d.entries.some(e => e.id === id)), folder);
        }
      }).catch(() => new Notice(t("localWall.folderConflict")));
    });
  }
  private dropAfter(event: DragEvent, el: HTMLElement): boolean { const r = el.getBoundingClientRect(); return el.classList.contains("mw-local__card") && this.data.appearance.layout === "grid" ? event.clientX > r.left + r.width / 2 : event.clientY > r.top + r.height / 2; }
  private dropEdge(event: DragEvent, el: HTMLElement): boolean { const r = el.getBoundingClientRect(); const x = el.classList.contains("mw-local__card") && this.data.appearance.layout === "grid" ? (event.clientX - r.left) / r.width : (event.clientY - r.top) / r.height; return x < .25 || x > .75; }
  private songTarget(el: HTMLElement, collection: string): void {
    el.addEventListener("dragover", event => { if (event.dataTransfer?.types.includes(SONG_MIME)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "copy"; el.addClass("is-drop-target"); } });
    el.addEventListener("dragleave", () => el.removeClass("is-drop-target"));
    el.addEventListener("drop", event => { const p = readSongs(event); if (!p) return; event.preventDefault(); event.stopPropagation(); el.removeClass("is-drop-target"); void this.update(d => { addSongs(d, collection, p.tracks); }).catch(() => new Notice(t("localWall.updateFailed"))); });
  }
  async loadDetail(): Promise<void> {
    const e = this.entry, c = this.collection; if (!e || !c) return;
    const request = ++this.request, cookie = this.plugin.settings.neteaseCookie;
    const current = () => !this.disposed && request === this.request && this.entry?.id === e.id && cookie === this.plugin.settings.neteaseCookie;
    this.loading = true; this.failed = false; this.partial = false; this.host.render();
    try {
      if (c.kind === "local") {
        const tracks = c.meta.tracks || []; let fresh: AlbumTrackSnapshot[] = [];
        try { if (tracks.length) fresh = await this.plugin.libraryApi.songs(tracks.map(s => s.id), cookie); } catch { if (current()) this.partial = true; }
        if (!current()) return;
        const found = new Map(fresh.map(s => [s.id, s])); if (fresh.length !== tracks.length) this.partial = true;
        const latest = this.collection!.meta, members = latest.tracks || [];
        this.detail = { ...latest, wallEntryId: e.id, tracks: members.map(s => ({ ...s, ...(found.get(s.id) || {}), unavailable: !found.has(s.id) })), trackCount: members.length };
        if (fresh.length) await this.update(d => {
          const item = d.collections.find(x => x.id === c.id); if (item) item.meta.tracks = (item.meta.tracks || []).map(s => ({ ...s, ...(found.get(s.id) || {}) }));
        });
      } else {
        const detail = await this.plugin.fetchCollectionDetail(c.meta); if (!current()) return;
        this.detail = { ...detail, wallEntryId: e.id };
      }
    } catch { if (current()) this.failed = true; }
    finally { if (current()) { this.loading = false; this.host.render(); } }
  }
  changed(): void {
    const c = this.collection;
    if (c?.kind === "local" && this.detail) {
      const info = new Map((this.detail.tracks || []).map(s => [s.id, s]));
      this.detail = { ...c.meta, wallEntryId: this.entry!.id, tracks: (c.meta.tracks || []).map(s => ({ ...info.get(s.id), ...s })) };
    }
  }
  private renderDetail(parent: HTMLElement, head: HTMLElement): void {
    const fixed = head.createDiv({ cls: "mw-local__fixed" }); this.renderBreadcrumbs(fixed);
    const e = this.entry!, c = this.collection!;
    if (this.loading) { parent.createDiv({ cls: "mw-cloud__empty", text: t("localWall.loading") }); return; }
    if (this.failed) { parent.createDiv({ cls: "mw-cloud__empty", text: t("localWall.failed") }); svgAction(parent, "refresh-cw", t("library.retry"), () => this.loadDetail(), true); return; }
    const meta = this.detail; if (!meta) return;
    const header = parent.createDiv({ cls: "mw-cloud__collection mw-local__detail" });
    const art = header.createDiv({ cls: "mw-local__detail-art" }); this.renderCover(art, meta);
    const info = header.createDiv({ cls: "mw-cloud__collection-info" }); info.createEl("h3", { text: meta.name }); info.createDiv({ cls: "mw-cloud__summary", text: collectionSummary(meta) });
    if (meta.description) info.createDiv({ cls: "mw-local__description", text: meta.description });
    svgAction(header, "play", t("panel.play"), () => playAlbum(meta, this.plugin.getPlaybackDeps())).disabled = !meta.tracks?.length;
    svgAction(header, "list-plus", t(c.kind === "albums" ? "queue.add" : "queue.addPlaylist"), () => this.plugin.enqueueAlbum(meta));
    if (c.kind !== "local") {
      if (c.kind === "playlists") svgAction(header, "copy", t("localWall.clone"), () => this.plugin.cloneLocalPlaylist(meta));
      svgAction(header, "star", e.rating ? `${t("localWall.rating")} ${e.rating}` : t("localWall.rate"), () => this.entryActions(e, c).find(a => a.icon === "star")!.run() as void);
      svgAction(header, "link", t("libraryDetails.copyLink"), () => navigator.clipboard.writeText(`https://music.163.com/${c.kind === "albums" ? "album" : "playlist"}?id=${meta.playlistId || meta.albumId}`));
      this.host.renderTracks(parent, meta.tracks || [], meta); return;
    }
    svgAction(header, "pencil", t("localWall.rename"), () => new WallTextModal(this.plugin.app, t("localWall.name"), c.meta.name, name => this.update(d => { const item = d.collections.find(x => x.id === c.id); if (item) item.meta.name = name; })).open());
    svgAction(header, "text", t("localWall.description"), () => new WallTextModal(this.plugin.app, t("localWall.description"), c.meta.description || "", description => this.update(d => { const item = d.collections.find(x => x.id === c.id); if (item) item.meta.description = description; }), true).open());
    if (this.partial) parent.createDiv({ cls: "mw-local__hint", text: t("localWall.offline") });
    this.renderLocalSongs(parent, meta, fixed);
  }
  private renderLocalSongs(parent: HTMLElement, meta: AlbumMeta, fixed: HTMLElement): void {
    const controls = fixed.createDiv({ cls: "mw-local__song-tools" });
    const input = controls.createEl("input", { attr: { type: "search", placeholder: t("library.search"), "aria-label": t("library.search") } }); input.value = this.songQuery;
    const sort = controls.createEl("select", { attr: { "aria-label": t("localWall.trackSort") } });
    for (const [value, key] of [["manual", "manual"], ["name", "songName"], ["artists", "artist"], ["albumName", "album"], ["added", "addedAt"]]) sort.createEl("option", { value, text: t(`localWall.${key}`) }); sort.value = this.songSort;
    sort.addEventListener("change", () => { this.songSort = sort.value; render(); });
    svgAction(controls, "arrow-up-down", t(this.songAsc ? "localWall.ascending" : "localWall.descending"), () => { this.songAsc = !this.songAsc; render(); });
    const selected = controls.createSpan({ cls: "mw-local__hint" });
    const add = svgAction(controls, "list-plus", t("localWall.addSongs"), () => this.plugin.addSongsToLocalPlaylist((meta.tracks || []).filter(s => this.selected.has(s.id))));
    const remove = svgAction(controls, "trash-2", t("localWall.removeSongs"), () => this.confirm(t("localWall.removeSongsConfirm"), () => this.update(d => {
      const c = d.collections.find(c => c.id === meta.localPlaylistId); if (!c) return;
      c.meta.tracks = (c.meta.tracks || []).filter(s => !this.selected.has(s.id)); c.meta.trackCount = c.meta.tracks.length; this.selected.clear();
    })));
    const list = parent.createDiv({ cls: "mw-cloud__tracks mw-local__songs" });
    this.songTarget(list, meta.localPlaylistId!);
    const filtered = () => {
      const q = this.songQuery.toLowerCase(); const tracks = (this.detail?.tracks || []).filter(s => `${s.name} ${s.artists || ""} ${s.albumName || ""}`.toLowerCase().includes(q));
      if (this.songSort !== "manual" && this.songSort !== "added") tracks.sort((a, b) => String(a[this.songSort as keyof AlbumTrackSnapshot] || "").localeCompare(String(b[this.songSort as keyof AlbumTrackSnapshot] || "")) * (this.songAsc ? 1 : -1));
      else if (!this.songAsc) tracks.reverse(); return tracks;
    };
    const pageMenus: (() => void)[] = [];
    const clearPage = () => pageMenus.splice(0).forEach(dispose => dispose()); this.cleanup.push(clearPage);
    const originalIndices = new Map((meta.tracks || []).map((song, index) => [song.id, index]));
    const pager = new SongPager(list, (page, s: AlbumTrackSnapshot) => {
        const row = page.createDiv({ cls: "mw-cloud__track mw-local__song", attr: { "data-local-song": String(s.id) } });
        row.toggleClass("is-selected", this.selected.has(s.id));
        row.toggleClass("is-current", this.plugin.nowPlaying.state.songId === s.id);
        row.setAttr("aria-current", String(this.plugin.nowPlaying.state.songId === s.id));
        row.addEventListener("click", event => {
          if ((event.target as Element).closest("button, a, input")) return;
          this.songs.click(s.id, filtered().map(s => s.id), event); this.selected = this.songs.ids;
          for (const item of Array.from(list.querySelectorAll<HTMLElement>("[data-local-song]"))) item.toggleClass("is-selected", this.selected.has(Number(item.dataset.localSong)));
          selected.setText(t("localWall.selected", { count: this.selected.size })); add.disabled = remove.disabled = !this.selected.size;
        });
        const title = row.createDiv({ cls: "mw-cloud__track-info" }); title.createDiv({ cls: "mw-cloud__name", text: s.name }); title.createDiv({ cls: "mw-cloud__track-meta", text: [s.artists, s.albumName].filter(Boolean).join(" · ") });
        if (s.unavailable) title.createDiv({ cls: "mw-local__hint", text: t("localWall.unavailable") });
        row.createSpan({ cls: "mw-cloud__duration", text: `${Math.floor(s.duration / 60000)}:${String(Math.floor(s.duration / 1000) % 60).padStart(2, "0")}` });
        const index = originalIndices.get(s.id) ?? 0;
        svgAction(row, "play", t("panel.play"), () => playAlbum({ ...this.detail! }, this.plugin.getPlaybackDeps(), index));
        this.menu(row, () => [...this.host.trackActions(s, this.detail!, index), { label: t("localWall.remove"), icon: "trash-2", run: () => this.update(d => { const c = d.collections.find(x => x.id === meta.localPlaylistId); if (c) { c.meta.tracks = (c.meta.tracks || []).filter(x => x.id !== s.id); c.meta.trackCount = c.meta.tracks.length; } }) }], false, pageMenus);
        songSource(row, () => { const visible = filtered(); const ids = this.songs.drag(s.id, visible.map(s => s.id)), chosen = new Set(ids); this.selected = this.songs.ids; return { collection: meta.localPlaylistId, ids, tracks: visible.filter(s => chosen.has(s.id)) }; });
        row.addEventListener("dragover", event => { if (event.dataTransfer?.types.includes("application/x-music-wall-song") && row.draggable) event.preventDefault(); });
        row.addEventListener("drop", event => {
          if (!row.draggable) return; event.preventDefault();
          const p = readSongs(event); if (!p) return; event.stopPropagation();
          void this.update(d => {
            const c = d.collections.find(c => c.id === meta.localPlaylistId); if (!c) return;
            if (p.collection !== meta.localPlaylistId) { addSongs(d, c.id, p.tracks); return; }
            const tracks = c.meta.tracks || [], ids = reorderIds(filtered().map(s => String(s.id)), p.ids.map(String), String(s.id), this.dropAfter(event, row));
            const byId = new Map(tracks.map(s => [String(s.id), s]));
            const visibleIds = new Set(ids); let position = 0;
            c.meta.tracks = tracks.map(track => visibleIds.has(String(track.id)) ? byId.get(ids[position++])! : track); this.songSort = "manual"; this.songAsc = true;
          }).catch(() => new Notice(t("localWall.updateFailed")));
        });
    }, clearPage, true);
    this.cleanup.push(() => pager.dispose());
    const render = () => {
      selected.setText(t("localWall.selected", { count: this.selected.size })); add.disabled = remove.disabled = !this.selected.size;
      pager.setItems(filtered());
    };
    if (!(meta.tracks || []).length) list.createDiv({ cls: "mw-cloud__empty", text: t("localWall.emptySongs") });
    input.addEventListener("input", () => { this.songQuery = input.value; render(); }); render();
  }
  dispose(): void { this.disposed = true; this.request++; this.cleanup.splice(0).forEach(fn => fn()); this.navCleanup.splice(0).forEach(fn => fn()); }
}
