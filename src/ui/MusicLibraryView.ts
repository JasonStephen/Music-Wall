import { ItemView, Notice, WorkspaceLeaf, setIcon } from "obsidian";
import type MusicWallPlugin from "../main";
import type { AlbumMeta, AlbumSummary, AlbumTrackSnapshot } from "../types";
import { LIBRARY_VIEW_TYPE } from "../types";
import type { ArtistContent, CloudArtist, CloudPlaylist, LibrarySearchKind, LibrarySearchResult } from "../core/library";
import { t } from "../i18n";
import { sizedCover } from "../core/metadata";
import { playAlbum } from "../core/playback";
import { DEFAULT_COVER } from "./defaultCover";
import { handleZoomWheel, syncZoomBox, disposeZoomBox } from "./zoom";
import { watchHostInset } from "./hostInset";
import { MiniPlayer } from "./MiniPlayer";
import { PickerModal } from "./smallModals";
import { bindLibraryMenu, type LibraryMenuAction } from "./libraryMenu";
import { collectionSummary, collectionStats, statsSummary, type CollectionStats } from "./collectionSummary";
import { svgAction } from "./svgAction";

type Tab = "home" | "created" | "collected" | "likes" | "search";
const emptySearch = (): LibrarySearchResult => ({ songs: [], artists: [], albums: [], playlists: [], more: false });

export class MusicLibraryView extends ItemView {
  private albumItem: AlbumSummary | null = null;
  private artistSection: "songs" | "albums" = "songs";
  private history: (() => void)[] = [];
  private menuCleanups: (() => void)[] = [];
  private artistPicker: PickerModal | null = null;
  private statsObserver: IntersectionObserver | null = null;
  private statsTargets = new Map<Element, () => void>();
  private statsQueue: (() => Promise<void>)[] = [];
  private statsRunning = 0;
  private statsEpoch = 0;
  private statsCache = new Map<string, Promise<CollectionStats>>();
  private tab: Tab = "home";
  private generation = 0;
  private keyword = "";
  private searchKind: LibrarySearchKind = "songs";
  private offset = 0;
  private lists: CloudPlaylist[] = [];
  private results = emptySearch();
  private collection: AlbumMeta | null = null;
  private playlistItem: CloudPlaylist | null = null;
  private artist: ArtistContent | null = null;
  private artistItem: CloudArtist | null = null;
  private artistOffset = 0;
  private loading = false;
  private retry: (() => Promise<void>) | null = null;
  private stopInset: (() => void) | null = null;
  private auth = "";
  private closed = false;
  private miniPlayer: MiniPlayer | null = null;
  private head!: HTMLElement;
  private body!: HTMLElement;
  private sidebar!: HTMLElement;
  private layout!: HTMLElement;
  private overlay!: HTMLButtonElement;
  private resize: ResizeObserver | null = null;
  private wideExpanded = true;
  private drawer = false;
  private narrow = false;
  private playIntent = 0;
  private appearanceMedia: MediaQueryList | null = null;
  private appearanceButton: HTMLButtonElement | null = null;
  private onAppearanceChange = () => this.updateAppearance();
  constructor(leaf: WorkspaceLeaf, private plugin: MusicWallPlugin) { super(leaf); }
  getViewType(): string { return LIBRARY_VIEW_TYPE; }
  getDisplayText(): string { return this.tab === "likes" && !this.albumItem && !this.artistItem && !this.playlistItem ? t("library.likes") : this.collection?.name || this.playlistItem?.name || this.albumItem?.name || this.artistItem?.name || t(`library.${this.tab}`); }
  getIcon(): string { return "list-music"; }
  async onOpen(): Promise<void> {
    this.closed = false; this.auth = this.plugin.settings.neteaseCookie;
    const root = this.contentEl; root.empty(); root.addClass("mw-view", "mw-cloud");
    const win = root.ownerDocument.defaultView;
    this.appearanceMedia = typeof win?.matchMedia === "function" ? win.matchMedia("(prefers-color-scheme: dark)") : null;
    this.appearanceMedia?.addEventListener("change", this.onAppearanceChange);
    const box = root.createDiv({ cls: "mw-zoombox" });
    this.layout = box.createDiv({ cls: "mw-cloud__layout" });
    this.overlay = svgAction(this.layout, "x", t("library.closeNav"), () => this.closeDrawer()); this.overlay.addClass("mw-cloud__overlay");
    this.sidebar = this.layout.createEl("nav", { cls: "mw-cloud__sidebar", attr: { "aria-label": t("library.title") } });
    const main = this.layout.createDiv({ cls: "mw-cloud__main" });
    this.head = main.createDiv({ cls: "mw-cloud__head" });
    this.body = main.createDiv({ cls: "mw-cloud__body" });
    this.miniPlayer = new MiniPlayer(box, this.plugin);
    this.registerDomEvent(root, "wheel", (event: WheelEvent) => handleZoomWheel(event, this.plugin, root), { capture: true, passive: false });
    this.registerDomEvent(root, "keydown", (event: KeyboardEvent) => { if (event.key === "Escape" && this.drawer) { event.preventDefault(); this.closeDrawer(); } });
    if (typeof ResizeObserver !== "undefined") { this.resize = new ResizeObserver(() => this.updateLayout()); this.resize.observe(root); }
    this.render(); this.stopInset = watchHostInset(root);
  }
  async onClose(): Promise<void> {
    this.appearanceMedia?.removeEventListener("change", this.onAppearanceChange); this.appearanceMedia = null;
    this.appearanceButton = null;
    this.resetCardStats(); this.statsCache.clear();
    this.closed = true; ++this.generation; ++this.playIntent;
    this.clearMenus(); this.artistPicker?.close(); this.stopInset?.(); this.resize?.disconnect(); this.miniPlayer?.dispose(); this.miniPlayer = null; disposeZoomBox(this.contentEl);
  }
  syncZoomBox(): void { syncZoomBox(this.contentEl, this.plugin.settings.zoomScale); this.updateLayout(); }
  refresh(): void {
    if (this.closed || !this.body) return;
    const auth = this.plugin.settings.neteaseCookie;
    if (auth !== this.auth) {
      // A first sign-in may belong to a pending play action; logout/account replacement invalidates it.
      if (this.auth || !auth) ++this.playIntent;
      this.auth = auth; this.history = []; this.albumItem = null; this.artistPicker?.close(); ++this.generation; this.plugin.libraryApi.clear();
      this.statsCache.clear();
      this.collection = null; this.playlistItem = null; this.artist = null; this.artistItem = null; this.lists = []; this.results = emptySearch(); this.offset = 0;
      this.loading = false; this.retry = null; this.tab = "home";
    }
    this.render();
  }
  private updateLayout(): void {
    if (!this.layout) return;
    const narrow = this.contentEl.clientWidth / (this.plugin.settings.zoomScale || 1) < 700;
    if (narrow !== this.narrow) { this.narrow = narrow; this.drawer = false; }
    this.layout.toggleClass("is-narrow", this.narrow);
    this.layout.toggleClass("is-collapsed", !this.wideExpanded);
    this.layout.toggleClass("is-drawer-open", this.drawer);
    const hidden = this.narrow && !this.drawer;
    this.sidebar.setAttr("aria-hidden", String(hidden)); this.sidebar.toggleAttribute("inert", hidden);
    this.layout.querySelector<HTMLElement>(".mw-cloud__main")?.toggleAttribute("inert", this.narrow && this.drawer);
    this.overlay.hidden = !this.narrow || !this.drawer;
    for (const button of Array.from(this.layout.querySelectorAll('[data-nav-toggle]'))) button.setAttribute("aria-expanded", String(this.narrow ? this.drawer : this.wideExpanded));
  }
  private toggleNav(): void {
    if (this.narrow) this.drawer = !this.drawer; else this.wideExpanded = !this.wideExpanded;
    this.renderNav(); this.updateLayout();
    if (this.narrow && this.drawer) this.sidebar.querySelector<HTMLButtonElement>("button")?.focus();
  }
  private closeDrawer(): void { this.drawer = false; this.updateLayout(); this.head.querySelector<HTMLButtonElement>('[data-nav-toggle]')?.focus(); }
  private renderNav(): void {
    this.sidebar.empty();
    const toggle = svgAction(this.sidebar, this.wideExpanded ? "chevrons-left" : "chevrons-right", t(this.narrow ? "library.closeNav" : this.wideExpanded ? "library.collapseNav" : "library.expandNav"), () => this.toggleNav(), true);
    toggle.dataset.navToggle = "true";
    for (const [tab, icon] of [["search", "search"], ["likes", "heart"], ["created", "list-music"], ["collected", "bookmark"]] as const) {
      const button = svgAction(this.sidebar, icon, t(`library.${tab}`), () => this.navigate(tab), true);
      button.dataset.section = tab; if (this.tab === tab) button.setAttr("aria-current", "page");
    }
  }
  private render(): void {
    if (this.closed || !this.body) return;
    this.resetCardStats();
    this.clearMenus(); this.renderNav(); this.head.empty(); this.body.empty();
    const nav = svgAction(this.head, "menu", t("library.expandNav"), () => this.toggleNav()); nav.dataset.navToggle = "true"; nav.addClass("mw-cloud__menu");
    const heading = this.head.createDiv({ cls: "mw-cloud__heading" });
    if (this.collection || this.artist || this.playlistItem || this.albumItem || this.artistItem) {
      svgAction(heading, "arrow-left", t("common.back"), () => this.back()).addClass("mw-cloud__back");
    }
    heading.createEl("h2", { text: this.getDisplayText() });
    svgAction(this.head, "home", t("library.home"), () => this.navigate("home"));
    svgAction(this.head, "refresh-cw", t("library.refresh"), () => { this.statsCache.clear(); this.plugin.libraryApi.clear(); return this.reload(); });
    svgAction(this.head, "disc", t("cmd.openPlayer"), () => this.plugin.openPlayerView());
    this.appearanceButton = svgAction(this.head, "sun-moon", t("libraryAppearance.title"), () => this.cycleAppearance());
    this.appearanceButton.addClass("mw-cloud__appearance");
    this.updateAppearance();
    const leaf = this.leaf as WorkspaceLeaf & { updateHeader?: () => void; tabHeaderInnerTitleEl?: HTMLElement };
    leaf.updateHeader?.(); leaf.tabHeaderInnerTitleEl?.setText(this.getDisplayText());
    (this as unknown as { containerEl?: HTMLElement }).containerEl?.querySelector<HTMLElement>(".view-header-title")?.setText(this.getDisplayText());
    if (this.tab === "home") this.renderHome();
    else {
      if (this.tab === "search" && !this.collection && !this.playlistItem && !this.artistItem && !this.albumItem) { this.renderSearch(this.body); this.renderSearchTabs(); }
      if (this.loading) this.body.createDiv({ cls: "mw-cloud__empty", text: t("mini.loading") });
      else if (this.retry) this.renderError();
      else if (["created", "collected", "likes"].includes(this.tab) && !this.plugin.settings.neteaseCookie) this.renderSignIn(this.body);
      else if (this.collection) this.renderCollection(this.collection);
      else if (this.artist) this.renderArtist(this.artist);
      else if (this.tab === "search") this.renderResults();
      else this.renderLists(this.body, this.lists);
    }
    this.syncZoomBox();
  }
  private renderHome(): void {
    const home = this.body.createDiv({ cls: "mw-cloud__home" });
    home.createEl("h1", { text: t("library.welcome", { name: this.plugin.settings.neteaseCookie && this.plugin.settings.neteaseNickname || t("library.guest") }) });
    this.renderSearch(home);
    if (!this.plugin.settings.neteaseCookie) this.renderSignIn(home);
  }
  private renderSearch(parent: HTMLElement): void {
    const form = parent.createEl("form", { cls: "mw-cloud__search" });
    const input = form.createEl("input", { attr: { type: "search", placeholder: t("library.searchPlaceholder"), "aria-label": t("library.search"), maxlength: "200" } });
    input.value = this.keyword;
    svgAction(form, "search", t("library.search"), () => form.requestSubmit());
    form.addEventListener("submit", event => {
      event.preventDefault(); const keyword = input.value.trim(); if (!keyword) { input.focus(); return; }
      this.keyword = keyword; this.results = emptySearch(); this.offset = 0; this.tab = "search"; this.history = []; this.albumItem = null;
      this.collection = null; this.playlistItem = null; this.artist = null; this.artistItem = null; this.closeDrawer(); void this.loadContent();
    });
  }
  private renderSearchTabs(): void {
    const tabs = this.body.createDiv({ cls: "mw-cloud__tabs", attr: { role: "tablist", "aria-label": t("library.search") } });
    for (const [kind, icon] of [["songs", "music"], ["artists", "mic"], ["albums", "disc"], ["playlists", "list-music"]] as const) {
      const button = svgAction(tabs, icon, t(`library.${kind}`), () => { this.searchKind = kind; this.offset = 0; this.results = emptySearch(); return this.loadContent(); }, true);
      button.dataset.searchKind = kind; button.setAttr("role", "tab"); button.setAttr("aria-selected", String(this.searchKind === kind));
    }
  }
  private renderResults(): void {
    if (!this.keyword) { this.body.createDiv({ cls: "mw-cloud__empty", text: t("library.searchPlaceholder") }); return; }
    if (this.searchKind === "songs") this.renderTracks(this.body, this.results.songs);
    if (this.searchKind === "albums") this.renderAlbums(this.body, this.results.albums);
    if (this.searchKind === "playlists") this.renderLists(this.body, this.results.playlists);
    if (this.searchKind === "artists") {
      const grid = this.body.createDiv({ cls: "mw-cloud__grid" });
      for (const artist of this.results.artists) {
        const card = this.card(grid, artist.name, "", artist.cover); card.addClass("mw-cloud__artist-card");
        card.addEventListener("click", () => void this.openArtist(artist));
        this.context(card, () => this.artistActions(artist));
      }
      if (!this.results.artists.length) this.empty(this.body);
    }
    if (this.results.more) this.more(this.body, () => this.loadContent(true));
  }
  private empty(parent: HTMLElement): void { parent.createDiv({ cls: "mw-cloud__empty", text: t("library.empty") }); }
  private more(parent: HTMLElement, action: () => Promise<void>): void { svgAction(parent, "chevron-down", t("library.more"), action, true).addClass("mw-cloud__more"); }
  private card(parent: HTMLElement, name: string, subtitle: string, cover: string): HTMLButtonElement {
    const card = parent.createEl("button", { cls: "mw-cloud__card", attr: { type: "button", title: name } });
    card.createEl("img", { attr: { src: sizedCover(cover || DEFAULT_COVER, 300), alt: "", loading: "lazy" } });
    card.createSpan({ cls: "mw-cloud__name", text: name }); card.createSpan({ cls: "mw-cloud__creator", text: subtitle }); return card;
  }
  private renderLists(parent: HTMLElement, lists: CloudPlaylist[]): void {
    if (!lists.length) { this.empty(parent); return; }
    const grid = parent.createDiv({ cls: "mw-cloud__grid" });
    for (const item of lists) {
      const card = this.card(grid, item.name, item.creator, item.cover);
      this.cardStats(card, `playlist:${item.id}`, item.count, () => this.plugin.libraryApi.playlistStats(item.id, this.plugin.settings.neteaseCookie));
      card.addEventListener("click", () => void this.openPlaylist(item));
      this.context(card, () => this.playlistActions(item));
    }
  }
  private renderAlbums(parent: HTMLElement, albums: AlbumSummary[]): void {
    if (!albums.length) { this.empty(parent); return; }
    const grid = parent.createDiv({ cls: "mw-cloud__grid" });
    for (const album of albums) {
      const entry = grid.createDiv({ cls: "mw-cloud__album" });
      const card = entry.createEl("button", { cls: "mw-cloud__album-card", attr: { type: "button", title: album.name } });
      card.addEventListener("click", () => void this.openAlbum(album));
      this.context(entry, () => this.albumActions(album));
      card.createEl("img", { attr: { src: sizedCover(album.cover || DEFAULT_COVER, 300), alt: "", loading: "lazy" } });
      card.createSpan({ cls: "mw-cloud__name", text: album.name }); card.createSpan({ cls: "mw-cloud__creator", text: album.artist });
      this.cardStats(card, `album:${album.albumId}`, album.trackCount, async () => collectionStats(await this.plugin.fetchAlbumDetail(album.albumId)));
      const actions = entry.createDiv({ cls: "mw-cloud__actions" });
      svgAction(actions, "play", t("search.preview"), () => this.albumAction(album, "play"));
      svgAction(actions, "folder-plus", t("library.addToWall"), () => this.albumAction(album, "wall"));
      svgAction(actions, "list-plus", t("queue.add"), () => this.albumAction(album, "queue"));
    }
  }
  private updateAppearance(): void {
    if (this.closed) return;
    const mode = this.plugin.settings.libraryAppearance || "system";
    const dark = mode === "dark" || mode === "system" && (this.appearanceMedia?.matches ?? this.contentEl.ownerDocument.body.classList.contains("theme-dark"));
    this.contentEl.dataset.libraryTheme = dark ? "dark" : "light";
    const button = this.appearanceButton; if (!button) return;
    button.dataset.appearance = mode;
    const label = t("libraryAppearance.current", { mode: t(`libraryAppearance.${mode}`) });
    button.title = label; button.setAttr("aria-label", label);
    const glyph = button.querySelector<HTMLElement>(".mw-control-icon");
    if (glyph) setIcon(glyph, mode === "light" ? "sun" : mode === "dark" ? "moon" : "sun-moon");
  }
  private async cycleAppearance(): Promise<void> {
    if (this.closed) return;
    const modes = ["system", "light", "dark"] as const;
    const current = modes.indexOf(this.plugin.settings.libraryAppearance || "system");
    this.plugin.settings.libraryAppearance = modes[(current + 1) % modes.length];
    this.updateAppearance();
    try { await this.plugin.saveData(this.plugin.settings); } catch { new Notice(t("library.failed")); }
  }
  private resetCardStats(): void {
    ++this.statsEpoch; this.statsObserver?.disconnect(); this.statsObserver = null;
    this.statsTargets.clear(); this.statsQueue = [];
  }
  private drainCardStats(): void {
    while (this.statsRunning < 2 && this.statsQueue.length) {
      const task = this.statsQueue.shift()!; ++this.statsRunning;
      void task().finally(() => { --this.statsRunning; this.drainCardStats(); });
    }
  }
  private cardStats(card: HTMLElement, key: string, count: number, load: () => Promise<CollectionStats>): void {
    const label = card.createSpan({ cls: "mw-cloud__card-stats", text: statsSummary({ count }, true) });
    const epoch = this.statsEpoch, cookie = this.plugin.settings.neteaseCookie;
    const scope = this.plugin.settings.neteaseUserId || (cookie ? "" : "public");
    const valid = () => !this.closed && epoch === this.statsEpoch && cookie === this.plugin.settings.neteaseCookie && label.isConnected;
    const enqueue = () => {
      this.statsQueue.push(async () => {
        if (!valid()) return;
        const cached = await this.plugin.collectionStatsCache?.get(scope, key, count);
        if (!valid()) return;
        if (cached) { label.textContent = statsSummary(cached.stats); label.title = label.textContent; }
        if (cached?.fresh) return;
        let result = this.statsCache.get(key);
        if (!result) {
          result = load(); this.statsCache.set(key, result);
          if (this.statsCache.size > 200) this.statsCache.delete(this.statsCache.keys().next().value!);
        }
        try {
          const stats = await result;
          if (cookie === this.plugin.settings.neteaseCookie) await this.plugin.collectionStatsCache?.put(scope, key, count, stats);
          if (this.plugin.collectionStatsCache && this.statsCache.get(key) === result) this.statsCache.delete(key);
          if (valid()) { label.textContent = statsSummary(stats); label.title = label.textContent; }
        } catch {
          if (this.statsCache.get(key) === result) this.statsCache.delete(key);
          if (valid() && !cached) label.textContent = statsSummary({ count });
        }
      }); this.drainCardStats();
    };
    if (typeof IntersectionObserver === "undefined") { queueMicrotask(enqueue); return; }
    if (!this.statsObserver) this.statsObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        const start = this.statsTargets.get(entry.target); this.statsTargets.delete(entry.target);
        this.statsObserver?.unobserve(entry.target); start?.();
      }
    }, { rootMargin: "200px" });
    this.statsTargets.set(card, enqueue); this.statsObserver.observe(card);
  }
  private remember(): void {
    const snapshot = { tab: this.tab, collection: this.collection, playlistItem: this.playlistItem, albumItem: this.albumItem, artist: this.artist, artistItem: this.artistItem, artistSection: this.artistSection, artistOffset: this.artistOffset };
    const scroll = this.body.scrollTop;
    this.history.push(() => { Object.assign(this, snapshot); this.render(); this.body.scrollTop = scroll; });
  }
  private back(): void {
    ++this.generation; this.loading = false; this.retry = null;
    const restore = this.history.pop(); if (restore) { restore(); return; }
    this.collection = null; this.playlistItem = null; this.albumItem = null; this.artist = null; this.artistItem = null;
    if (this.tab === "likes") this.tab = "home"; this.render();
  }
  async showCollection(meta: AlbumMeta): Promise<void> {
    if ((!meta.playlistId && meta.albumId <= 0) || (meta.playlistId && meta.playlistId < 0) || meta.name === t("queue.playlistQueue")) { this.remember(); this.tab = "search"; this.albumItem = null; this.artist = null; this.artistItem = null; this.playlistItem = null; this.collection = meta; ++this.generation; this.loading = false; this.retry = null; this.render(); return; }
    if (meta.playlistId) return this.openPlaylist({ id: meta.playlistId, name: meta.name, creator: meta.artist, cover: meta.cover, count: meta.trackCount, owner: 0, special: 0 });
    return this.openAlbum(meta);
  }
  private async openAlbum(album: AlbumSummary, remember = true): Promise<void> {
    if (remember) this.remember();
    if (this.tab === "home") this.tab = "search";
    this.albumItem = album; this.playlistItem = null; this.collection = null; this.artist = null; this.artistItem = null;
    return this.request(() => this.plugin.fetchAlbumDetail(album.albumId), meta => { this.collection = meta; }, () => this.openAlbum(album, false));
  }
  private renderCollection(collection: AlbumMeta): void {
    const head = this.body.createDiv({ cls: "mw-cloud__collection" });
    head.createEl("img", { attr: { src: sizedCover(collection.cover || DEFAULT_COVER, 160), alt: "" } });
    const info = head.createDiv({ cls: "mw-cloud__collection-info" });
    info.createEl("h3", { text: collection.name });
    info.createDiv({ cls: "mw-cloud__summary", text: collectionSummary(collection) });
    svgAction(head, "play", t("panel.play"), () => this.play(collection, 0));
    svgAction(head, "list-plus", t(this.albumItem ? "queue.add" : "queue.addPlaylist"), async () => {
      if (!(await this.authorizeInternal())) return;
      if (this.albumItem) await this.plugin.enqueueAlbum(collection);
      else { this.plugin.internalPlayer.enqueuePlaylist(collection); new Notice(t("queue.playlistAdded")); }
    });
    this.renderTracks(this.body, collection.tracks || [], collection);
  }
  private renderTracks(parent: HTMLElement, tracks: AlbumTrackSnapshot[], collection?: AlbumMeta): void {
    if (!tracks.length) { this.empty(parent); return; }
    const list = parent.createDiv({ cls: "mw-cloud__tracks" });
    list.style.setProperty("--mw-track-digits", String(Math.max(2, String(tracks.length).length)));
    tracks.forEach((track, index) => {
      const row = list.createDiv({ cls: "mw-cloud__track" });
      row.createSpan({ cls: "mw-cloud__number", text: String(index + 1).padStart(2, "0") });
      const detail = row.createDiv({ cls: "mw-cloud__track-info" }); detail.createSpan({ cls: "mw-cloud__name", text: track.name }); const metadata = detail.createDiv({ cls: "mw-cloud__track-meta" });
      if (track.albumName || collection && !collection.playlistId) this.link(metadata, track.albumName || collection!.name, () => this.trackAlbum(track, collection), "album");
      if (track.artists) this.link(metadata, track.artists, () => this.trackArtist(track), "artist");
      row.createSpan({ cls: "mw-cloud__duration", text: `${Math.floor(track.duration / 60000)}:${String(Math.floor(track.duration / 1000) % 60).padStart(2, "0")}` });
      const actions = row.createDiv({ cls: "mw-cloud__actions" });
      const play = svgAction(actions, "play", t("internal.playTrack", { name: track.name }), () => collection ? this.play(collection, index) : this.single(track, true));
      play.dataset.trackAction = "play";
      row.addEventListener("dblclick", event => {
        const target = event.target as Element | null;
        if (event.defaultPrevented || event.button !== 0 || target?.closest("button, a, input, select, textarea, [role=button]")) return;
        event.preventDefault(); play.click();
      });
      svgAction(actions, "list-plus", t("library.playNext"), () => this.single(track, false)).dataset.trackAction = "next";
      const menu = this.context(row, () => this.trackActions(track, collection, index));
      const more = svgAction(actions, "ellipsis", t("libraryDetails.moreActions"), () => { const r = more.getBoundingClientRect(); menu.open(r.right, r.bottom); });
      more.dataset.trackAction = "more";
    });
  }
  private renderArtist(content: ArtistContent): void {
    const head = this.body.createDiv({ cls: "mw-cloud__collection" });
    head.createEl("img", { attr: { src: sizedCover(content.artist.cover || DEFAULT_COVER, 160), alt: "" } }); head.createEl("h3", { text: content.artist.name });
    const tabs = this.body.createDiv({ cls: "mw-cloud__tabs", attr: { role: "tablist", "aria-label": content.artist.name } });
    for (const section of ["songs", "albums"] as const) {
      const button = svgAction(tabs, section === "songs" ? "music" : "disc", t(`library.${section}`), () => { this.artistSection = section; this.render(); }, true);
      button.dataset.artistSection = section; button.setAttr("role", "tab"); button.setAttr("aria-selected", String(this.artistSection === section));
    }
    if (this.artistSection === "songs") this.renderTracks(this.body, content.tracks);
    else { this.renderAlbums(this.body, content.albums); if (content.more) this.more(this.body, () => this.loadArtistAlbums()); }
  }
  private renderSignIn(parent: HTMLElement): void {
    const empty = parent.createDiv({ cls: "mw-cloud__empty" }); empty.createEl("p", { text: t("auth.signedOutDesc") });
    svgAction(empty, "log-in", t("auth.signIn"), () => this.signIn(), true).addClass("mod-cta");
  }
  private async signIn(): Promise<void> {
    const desired = this.tab;
    if (await this.plugin.ensureNeteaseLogin(true)) { this.auth = this.plugin.settings.neteaseCookie; if (!this.closed) await this.navigate(desired); }
  }
  private async navigate(tab: Tab): Promise<void> {
    this.history = []; this.albumItem = null; this.tab = tab; this.collection = null; this.playlistItem = null; this.artist = null; this.artistItem = null; this.offset = 0;
    this.lists = []; this.results = emptySearch(); this.drawer = false; await this.loadContent();
  }
  private current(token: number, cookie: string): boolean { return !this.closed && token === this.generation && cookie === this.plugin.settings.neteaseCookie; }
  private async request<T>(load: () => Promise<T>, apply: (value: T) => void, retry: () => Promise<void>): Promise<void> {
    const token = ++this.generation, cookie = this.plugin.settings.neteaseCookie;
    this.loading = true; this.retry = null; this.render();
    try { const value = await load(); if (!this.current(token, cookie)) return; apply(value); this.loading = false; this.render(); }
    catch { if (this.current(token, cookie)) { this.loading = false; this.retry = retry; this.render(); } }
  }
  private async reload(): Promise<void> {
    if (this.albumItem) return this.openAlbum(this.albumItem, false);
    if (this.playlistItem) return this.openPlaylist(this.playlistItem, false);
    if (this.artist) return this.openArtist(this.artist.artist, false);
    return this.loadContent();
  }
  private async loadContent(more = false): Promise<void> {
    const cookie = this.plugin.settings.neteaseCookie, tab = this.tab;
    if (tab === "home" || (tab === "search" && !this.keyword) || (!cookie && tab !== "search")) { ++this.generation; this.loading = false; this.retry = null; this.render(); return; }
    if (tab === "search") {
      const offset = more ? this.offset + 30 : 0, kind = this.searchKind, keyword = this.keyword;
      return this.request(() => this.plugin.libraryApi.searchContent(keyword, kind, cookie, offset), result => {
        this.results = more ? { more: result.more, songs: [...this.results.songs, ...result.songs], artists: [...this.results.artists, ...result.artists], albums: [...this.results.albums, ...result.albums], playlists: [...this.results.playlists, ...result.playlists] } : result;
        this.offset = offset;
      }, () => this.loadContent(more));
    }
    const uid = Number(this.plugin.settings.neteaseUserId);
    if (!(uid > 0)) { this.loading = false; this.retry = () => this.signIn(); this.render(); return; }
    if (tab === "likes") return this.request(() => this.plugin.libraryApi.liked(uid, cookie), collection => { this.collection = collection; }, () => this.loadContent());
    return this.request(() => this.plugin.libraryApi.userPlaylists(uid, cookie), lists => {
      this.lists = lists.filter(item => tab === "created" ? item.owner === uid : item.owner !== uid);
    }, () => this.loadContent());
  }
  private renderError(): void {
    const empty = this.body.createDiv({ cls: "mw-cloud__empty" }); empty.createEl("p", { text: t("library.failed") });
    svgAction(empty, "refresh-cw", t("library.retry"), () => this.retry?.(), true);
    svgAction(empty, "log-in", t("auth.signIn"), () => this.signIn(), true);
  }
  private async openPlaylist(item: CloudPlaylist, remember = true): Promise<void> {
    if (remember) this.remember(); if (this.tab === "home") this.tab = "search";
    this.playlistItem = item; this.collection = null; this.albumItem = null; this.artist = null; this.artistItem = null;
    return this.request(() => this.plugin.libraryApi.detail(item, this.plugin.settings.neteaseCookie), collection => { this.collection = collection; }, () => this.openPlaylist(item, false));
  }
  async showArtist(artist: CloudArtist): Promise<void> { await this.openArtist(artist); }
  private async openArtist(artist: CloudArtist, remember = true): Promise<void> {
    if (remember) this.remember(); if (this.tab === "home") this.tab = "search";
    this.artistItem = artist; this.artist = null; this.artistSection = "songs"; this.collection = null; this.playlistItem = null; this.albumItem = null;
    return this.request(() => this.plugin.libraryApi.artistDetail(artist, this.plugin.settings.neteaseCookie), content => { this.artist = content; this.artistOffset = 0; }, () => this.openArtist(artist, false));
  }
  private async loadArtistAlbums(): Promise<void> {
    const artist = this.artist; if (!artist) return;
    const offset = this.artistOffset + 30;
    return this.request(() => this.plugin.libraryApi.artistAlbums(artist.artist.id, this.plugin.settings.neteaseCookie, offset), page => {
      this.artist = { ...artist, albums: [...artist.albums, ...page.albums], more: page.more }; this.artistOffset = offset;
    }, () => this.loadArtistAlbums());
  }
  private clearMenus(): void { this.menuCleanups.splice(0).forEach(cleanup => cleanup()); }
  private context(host: HTMLElement, actions: () => LibraryMenuAction[]) {
    const menu = bindLibraryMenu(host, actions); this.menuCleanups.push(menu.dispose); return menu;
  }
  private link(parent: HTMLElement, label: string, action: () => Promise<void>, kind: string): void {
    const button = parent.createEl("button", { cls: "clickable-icon mw-cloud__link", text: label, attr: { type: "button", title: label, "data-link": kind } });
    button.addEventListener("click", event => { event.stopPropagation(); void action().catch(() => new Notice(t("library.failed"))); });
  }
  private async trackAlbum(track: AlbumTrackSnapshot, collection?: AlbumMeta): Promise<void> {
    const token = this.generation, cookie = this.plugin.settings.neteaseCookie;
    const meta = track.albumId ? track : (await this.plugin.libraryApi.songs([track.id], cookie))[0];
    if (!this.current(token, cookie)) return;
    const id = meta?.albumId || (!collection?.playlistId ? collection?.albumId : 0);
    if (id) await this.openAlbum({ albumId: id, name: meta?.albumName || collection?.name || track.name, artist: track.artists || "", cover: meta?.cover || "", trackCount: 0 });
  }
  private async trackArtist(track: AlbumTrackSnapshot): Promise<void> {
    const token = this.generation, cookie = this.plugin.settings.neteaseCookie;
    const refs = track.artistRefs?.length ? track.artistRefs : (await this.plugin.libraryApi.songs([track.id], cookie))[0]?.artistRefs || [];
    if (!this.current(token, cookie)) return;
    const artists = [...new Map(refs.filter(a => a.id > 0).map(a => [a.id, a])).values()];
    if (artists.length === 1) await this.openArtist({ ...artists[0], cover: "" });
    else if (artists.length > 1) {
      this.artistPicker?.close(); this.artistPicker = new PickerModal(this.app, t("libraryDetails.chooseArtist"), artists.map(a => ({ label: a.name, icon: "mic" })), index => {
        if (this.current(token, cookie)) void this.openArtist({ ...artists[index], cover: "" });
      }); this.artistPicker.open();
    }
  }
  private copy(kind: "song" | "album" | "playlist" | "artist", id: number): Promise<void> {
    return navigator.clipboard.writeText(`https://music.163.com/#/${kind}?id=${id}`);
  }
  private trackActions(track: AlbumTrackSnapshot, collection?: AlbumMeta, index = 0): LibraryMenuAction[] {
    return [
      { label: t("panel.play"), icon: "play", run: () => collection ? this.play(collection, index) : this.single(track, true) },
      { label: t("library.playNext"), icon: "list-plus", run: () => this.single(track, false) },
      { label: t("libraryDetails.viewAlbum"), icon: "disc", run: () => this.trackAlbum(track, collection) },
      { label: t("libraryDetails.viewArtist"), icon: "mic", run: () => this.trackArtist(track) },
      { label: t("libraryDetails.copyLink"), icon: "link", run: () => this.copy("song", track.id) },
    ];
  }
  private albumActions(album: AlbumSummary): LibraryMenuAction[] {
    return [
      { label: t("libraryDetails.viewDetails"), icon: "disc", run: () => this.openAlbum(album) },
      { label: t("search.preview"), icon: "play", run: () => this.albumAction(album, "play") },
      { label: t("library.addToWall"), icon: "folder-plus", run: () => this.albumAction(album, "wall") },
      { label: t("queue.add"), icon: "list-plus", run: () => this.albumAction(album, "queue") },
      { label: t("libraryDetails.copyLink"), icon: "link", run: () => this.copy("album", album.albumId) },
    ];
  }
  private playlistActions(item: CloudPlaylist): LibraryMenuAction[] {
    const act = async (append: boolean) => {
      const token = this.generation, cookie = this.plugin.settings.neteaseCookie;
      const meta = await this.plugin.libraryApi.detail(item, cookie);
      if (!this.current(token, cookie)) return;
      if (append) { if (await this.authorizeInternal()) this.plugin.internalPlayer.enqueuePlaylist(meta); }
      else await this.play(meta, 0);
    };
    return [
      { label: t("libraryDetails.viewDetails"), icon: "list-music", run: () => this.openPlaylist(item) },
      { label: t("panel.play"), icon: "play", run: () => act(false) },
      { label: t("queue.addPlaylist"), icon: "list-plus", run: () => act(true) },
      { label: t("libraryDetails.copyLink"), icon: "link", run: () => this.copy("playlist", item.id) },
    ];
  }
  private artistActions(artist: CloudArtist): LibraryMenuAction[] {
    return [
      { label: t("libraryDetails.viewDetails"), icon: "mic", run: () => this.openArtist(artist) },
      { label: t("libraryDetails.copyLink"), icon: "link", run: () => this.copy("artist", artist.id) },
    ];
  }
  private async authorizeInternal(): Promise<boolean> {
    if (!(await this.plugin.ensureNeteaseLogin()) || this.closed) return false;
    if (this.plugin.settings.playbackMode !== "internal") { new Notice(t("queue.internalOnly")); return false; }
    return true;
  }
  private async single(track: AlbumTrackSnapshot, now: boolean): Promise<void> {
    const intent = ++this.playIntent;
    if (!(await this.authorizeInternal()) || intent !== this.playIntent) return;
    await this.plugin.internalPlayer.insertTrack(track, now);
    if (!now) new Notice(t("library.nextAdded", { name: track.name }));
  }
  private async play(collection: AlbumMeta, index: number): Promise<void> {
    const intent = ++this.playIntent;
    if (!(await this.authorizeInternal()) || intent !== this.playIntent) return;
    if (collection.albumId > 0 && !collection.playlistId) await this.plugin.internalPlayer.playAlbum(collection, index);
    else await this.plugin.internalPlayer.playPlaylist(collection, index);
  }
  private async albumAction(album: AlbumSummary, mode: "play" | "wall" | "queue"): Promise<void> {
    const intent = ++this.playIntent;
    let deps = this.plugin.getPlaybackDeps();
    if (mode === "play" && deps.authorize) { const authorized = await deps.authorize(); if (!authorized) return; deps = authorized; }
    if (mode === "queue") { if (!(await this.authorizeInternal())) return; deps = this.plugin.getPlaybackDeps(); }
    const cookie = this.plugin.settings.neteaseCookie;
    const meta = await this.plugin.fetchAlbumDetail(album.albumId);
    if (this.closed || intent !== this.playIntent || cookie !== this.plugin.settings.neteaseCookie || deps.isCurrent?.() === false) return;
    if (mode === "play") await playAlbum(meta, deps);
    if (mode === "queue") await this.plugin.enqueueAlbum(meta);
    if (mode === "wall") this.plugin.addLibraryAlbum(meta);
  }
}
