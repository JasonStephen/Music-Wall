import type { AlbumMeta, AlbumTrackSnapshot } from "../types";
import { EMPTY_NOW_PLAYING, type NowPlayingListener, type NowPlayingProvider, type NowPlayingState } from "./nowPlaying";
import { TrackUnavailableError, type SongSource } from "./audioSource";
import { t } from "../i18n";
import type { AudioQuality } from "./quality";
import type { AudioLease } from "./audioTransport";
import { AudioFader } from "./audioFade";

export type PlaybackOrder = "order" | "repeat" | "one" | "shuffle";
export interface AlbumQueueEntry { id: string; album: AlbumMeta; }

interface InternalPlayerDeps {
  resolve: (id: number, quality: AudioQuality) => Promise<SongSource>;
  load: (url: string, mime?: string) => Promise<Blob>;
  defaultQuality?: () => AudioQuality;
  notice: (message: string) => void;
  audio?: () => HTMLAudioElement;
  open?: (source: SongSource, id: number, durationMs: number, signal: AbortSignal) => Promise<AudioLease>;
  pauseFade?: () => number;
  crossFade?: () => number;
  webAudio?: boolean;
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(t("internal.networkError"))), 30000);
    })]);
  } finally { clearTimeout(timer!); }
}

/** Global queues with an active stream, a bounded next-track warmup and two fade voices. */
export class InternalPlayer implements NowPlayingProvider {
  readonly supported = true;
  album: AlbumMeta | null = null;
  revision = 0;
  index = -1;
  loading = false;
  trial = false;
  error = "";
  volume = 1;
  quality: AudioQuality | null = null;
  availableQualities: AudioQuality[] = [];
  preferredQuality: AudioQuality | null = null;
  contentKind: "album" | "playlist" = "album";
  order: PlaybackOrder = "order";
  albumQueue: AlbumQueueEntry[] = [];
  currentEntryId = "";
  queuedPlaylist: AlbumMeta | null = null;
  private savedPlaylist: { index: number; positionMs: number } | null = null;
  private entrySerial = 0;
  private savedAlbum: { id: string; index: number; positionMs: number } | null = null;
  private randomBag: number[] = [];
  /** Explicit next-song insertions take precedence over shuffle and repeat once. */
  private priorityNext: number[] = [];
  private skipped = new Set<number>();
  private history: number[] = [];
  private historyIndex = -1;
  private media: HTMLAudioElement | null = null;
  private objectUrl = "";
  private generation = 0;
  private wanted = false;
  private phase: NowPlayingState["status"] = "none";
  private listeners = new Set<NowPlayingListener>();
  private lease: AudioLease | null = null;
  private loadingAbort: AbortController | null = null;
  private previous: { media: HTMLAudioElement; url: string; lease: AudioLease | null } | null = null;
  private fader: AudioFader;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private prefetch: { key: string; controller: AbortController; adopted: boolean; resource: Promise<{ source: SongSource; lease: AudioLease }> } | null = null;

  constructor(private deps: InternalPlayerDeps) { this.fader = new AudioFader(deps.webAudio !== false); }
  get playingRequested(): boolean { return this.wanted; }

  get currentCover(): string { return this.album?.tracks?.[this.index]?.cover || this.album?.cover || ""; }
  get allowedOrders(): PlaybackOrder[] { return this.contentKind === "playlist" ? ["order", "repeat", "one", "shuffle"] : ["order", "repeat", "one"]; }
  private get queueIndex(): number { return this.albumQueue.findIndex(entry => entry.id === this.currentEntryId); }
  setOrder(order: PlaybackOrder): void {
    if (!this.allowedOrders.includes(order)) return;
    this.order = order; this.resetRandom(); this.emit();
  }
  private resetRandom(): void { this.randomBag = []; this.skipped.clear(); this.history = this.index >= 0 ? [this.index] : []; this.historyIndex = this.history.length - 1; }
  enqueueAlbum(album: AlbumMeta): boolean {
    if (!album.tracks?.length || this.albumQueue.some(entry => entry.album.albumId === album.albumId)) return false;
    const entry = { id: String(++this.entrySerial), album: { ...album, tracks: album.tracks.map(track => ({ ...track })) } };
    this.albumQueue.push(entry); this.emit();
    if (!this.album && this.contentKind === "album") void this.playQueued(entry.id);
    return true;
  }
  moveQueued(id: string, target: number): boolean {
    if (id === this.currentEntryId || !Number.isInteger(target) || target < 0 || target >= this.albumQueue.length) return false;
    const active = this.albumQueue[this.queueIndex], activeIndex = this.queueIndex, targetId = this.albumQueue[target].id;
    if (targetId === this.currentEntryId) return false;
    const movable = this.albumQueue.filter(entry => entry.id !== this.currentEntryId);
    const from = movable.findIndex(entry => entry.id === id), to = movable.findIndex(entry => entry.id === targetId);
    if (from < 0 || to < 0 || from === to) return false;
    movable.splice(to, 0, movable.splice(from, 1)[0]);
    if (active) movable.splice(activeIndex, 0, active);
    this.albumQueue = movable; this.emit(); return true;
  }
  async removeQueued(id: string): Promise<void> {
    const index = this.albumQueue.findIndex(entry => entry.id === id);
    if (index < 0) return;
    this.albumQueue.splice(index, 1);
    if (this.savedAlbum?.id === id) this.savedAlbum = null;
    if (id !== this.currentEntryId) { this.emit(); return; }
    this.currentEntryId = "";
    if (this.contentKind === "playlist") { this.emit(); return; }
    const next = this.albumQueue[index] || this.albumQueue[0];
    if (next) await this.playQueued(next.id); else this.stop(false);
  }
  async playQueued(id: string): Promise<boolean> {
    const entry = this.albumQueue.find(entry => entry.id === id);
    if (!entry) return false;
    if (this.contentKind === "playlist" && this.album) { this.queuedPlaylist = this.album; this.savedPlaylist = { index: this.index, positionMs: this.state.positionMs }; }
    this.contentKind = "album"; if (this.order === "shuffle") this.order = "order";
    this.priorityNext = []; this.currentEntryId = id; ++this.revision; this.album = entry.album; this.resetRandom();
    const saved = this.savedAlbum?.id === id ? this.savedAlbum : null; this.savedAlbum = null;
    return this.select(saved?.index || 0, saved ? { positionMs: saved.positionMs, playing: true } : undefined);
  }
  async playPlaylist(collection: AlbumMeta, index = 0, restore?: { positionMs: number; playing: boolean }): Promise<boolean> {
    if (!collection.tracks?.length || index < 0 || index >= collection.tracks.length) return false;
    if (this.contentKind === "album" && this.album) this.savedAlbum = { id: this.currentEntryId, index: this.index, positionMs: this.state.positionMs };
    this.priorityNext = []; this.contentKind = "playlist"; ++this.revision; this.album = { ...collection, tracks: collection.tracks.map(track => ({ ...track })) };
    this.queuedPlaylist = this.album; this.savedPlaylist = null;
    this.resetRandom(); return this.select(index, restore);
  }
  enqueuePlaylist(collection: AlbumMeta): number {
    if (!collection.tracks?.length) return 0;
    const current = this.queuedPlaylist;
    const seen = new Set(current?.tracks?.map(track => track.id));
    const added = collection.tracks.filter(track => !seen.has(track.id)).map(track => ({ ...track }));
    if (!added.length) return 0;
    this.queuedPlaylist = current ? { ...current, name: t("queue.playlistQueue"), tracks: [...current.tracks || [], ...added], trackCount: (current.tracks?.length || 0) + added.length } : { ...collection, tracks: added, trackCount: added.length };
    if (this.contentKind === "playlist") { ++this.revision; this.album = this.queuedPlaylist; this.randomBag = []; }
    this.emit();
    if (!this.album) void this.playPlaylist(this.queuedPlaylist);
    return added.length;
  }
  async resumePlaylist(): Promise<boolean> {
    const playlist = this.queuedPlaylist, saved = this.savedPlaylist;
    if (!playlist) return false;
    return this.playPlaylist(playlist, saved?.index || 0, saved ? { positionMs: saved.positionMs, playing: true } : undefined);
  }
  /** Only player-owned snapshots change: source walls and account playlists stay untouched. */
  async insertTrack(track: AlbumTrackSnapshot, playNow = false): Promise<boolean> {
    if (!(track.id > 0)) return false;
    if (!this.album?.tracks?.length) return this.playPlaylist({ albumId: 0, name: t("queue.playlistQueue"), artist: "", cover: track.cover || "", trackCount: 1, tracks: [track] });
    const target = Math.max(0, this.index + 1);
    // Mutate the owned array so an in-flight loader sees inserted songs as well.
    this.album.tracks.splice(target, 0, { ...track }); this.album.trackCount = this.album.tracks.length;
    const shift = (index: number) => index >= target ? index + 1 : index;
    this.history = this.history.map(shift); this.randomBag = this.randomBag.map(shift);
    this.skipped = new Set([...this.skipped].map(shift));
    this.priorityNext = [target, ...this.priorityNext.map(shift)];
    ++this.revision; this.emit();
    return playNow ? this.playInserted(target) : true;
  }
  private playInserted(index: number): Promise<boolean> {
    if (this.order === "shuffle") {
      this.history = this.history.slice(0, this.historyIndex + 1); this.history.push(index); this.historyIndex = this.history.length - 1;
      this.randomBag = this.randomBag.filter(candidate => candidate !== index);
    }
    return this.loadTrack(index);
  }
  async select(index: number, restore?: { positionMs: number; playing: boolean }): Promise<boolean> {
    if (this.order === "shuffle" && !restore) { this.history = [index]; this.historyIndex = 0; this.randomBag = []; }
    return this.loadTrack(index, restore);
  }
  private async advance(automatic = false): Promise<boolean> {
    const tracks = this.album?.tracks || [];
    if (!tracks.length) return false;
    if (this.priorityNext.length) return this.playInserted(this.priorityNext[0]);
    if (automatic && this.order === "one") return this.loadTrack(this.index);
    if (this.order === "shuffle" && this.contentKind === "playlist") {
      if (this.historyIndex + 1 < this.history.length) return this.loadTrack(this.history[++this.historyIndex]);
      if (!this.randomBag.length) {
        this.randomBag = tracks.map((_, index) => index).filter(index => index !== this.index && !this.skipped.has(index));
        for (let i = this.randomBag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this.randomBag[i], this.randomBag[j]] = [this.randomBag[j], this.randomBag[i]]; }
      }
      const next = this.randomBag.shift() ?? this.index;
      this.history.push(next); this.historyIndex = this.history.length - 1;
      return this.loadTrack(next);
    }
    if (this.index + 1 < tracks.length) return this.loadTrack(this.index + 1);
    if (this.contentKind === "album" && this.albumQueue[this.queueIndex + 1]) return this.playQueued(this.albumQueue[this.queueIndex + 1].id);
    if (this.order === "repeat") return this.contentKind === "album" && this.albumQueue.length ? this.playQueued(this.albumQueue[0].id) : this.loadTrack(0);
    return false;
  }
  private async ended(): Promise<void> {
    if (!this.wanted) return;
    const generation = this.generation;
    if (await this.advance(true)) return;
    if (!this.wanted || generation !== this.generation) return;
    this.wanted = false; this.phase = "stopped"; this.emit();
  }
  get state(): NowPlayingState {
    const track = this.album?.tracks?.[this.index];
    const duration = this.media?.duration;
    return {
      ...EMPTY_NOW_PLAYING, supported: true, source: "internal", active: !!track,
      albumId: track?.albumId ?? this.album?.albumId, songId: track?.id,
      title: track?.name ?? "", artist: track?.artists || this.album?.artist || "",
      album: track?.albumName || this.album?.name || "", status: this.phase,
      positionMs: (this.media?.currentTime || 0) * 1000,
      durationMs: duration && Number.isFinite(duration) ? duration * 1000 : track?.duration ?? 0,
      seekable: !!this.media && Number.isFinite(duration) && duration! > 0 && !this.loading,
      canPlay: !!track, canPause: !!track, canToggle: !!track,
      canNext: !!track && (this.index < (this.album?.tracks?.length ?? 0) - 1 || this.order === "repeat" || this.order === "shuffle" || this.contentKind === "album" && this.queueIndex + 1 < this.albumQueue.length),
      canPrev: this.order === "shuffle" ? this.historyIndex > 0 : this.index > 0 || this.contentKind === "album" && this.queueIndex > 0,
    };
  }

  on(listener: NowPlayingListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void { for (const listener of this.listeners) listener(this.state); this.schedulePrefetch(); }
  start(): void {}

  stop(clearQueues = true): void {
    ++this.generation;
    this.wanted = false;
    this.loadingAbort?.abort(); this.cancelPrefetch();
    this.release();
    if (clearQueues) { this.queuedPlaylist = null; this.savedPlaylist = null; }
    this.priorityNext = []; this.albumQueue = []; this.currentEntryId = ""; this.savedAlbum = null; this.contentKind = "album";
    if (this.order === "shuffle") this.order = "order"; this.resetRandom();
    ++this.revision; this.album = null; this.index = -1; this.loading = false;
    this.trial = false; this.error = ""; this.phase = "none";
    this.quality = null; this.availableQualities = []; this.preferredQuality = null;
    this.emit();
  }

  private releaseCurrent(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer); this.stallTimer = null;
    const media = this.media;
    this.media = null;
    if (media) { this.fader.release(media); media.pause(); media.removeAttribute("src"); media.load(); }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = "";
    this.lease?.release(); this.lease = null;
  }
  private releasePrevious(): void {
    const previous = this.previous; this.previous = null;
    if (!previous) return;
    this.fader.release(previous.media); previous.media.pause(); previous.media.removeAttribute("src"); previous.media.load();
    if (previous.url) URL.revokeObjectURL(previous.url); previous.lease?.release();
  }
  private release(): void { this.releaseCurrent(); this.releasePrevious(); }
  dispose(): void { this.stop(); this.fader.close(); }
  private nextTrack(): { id: number; duration: number } | null {
    const tracks = this.album?.tracks; if (!tracks?.length) return null;
    if (this.priorityNext.length) return tracks[this.priorityNext[0]] || null;
    if (this.order === "one") return tracks[this.index];
    if (this.order === "shuffle" && this.contentKind === "playlist") {
      if (this.historyIndex + 1 < this.history.length) return tracks[this.history[this.historyIndex + 1]];
      if (!this.randomBag.length) {
        this.randomBag = tracks.map((_, index) => index).filter(index => index !== this.index && !this.skipped.has(index));
        for (let i = this.randomBag.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [this.randomBag[i], this.randomBag[j]] = [this.randomBag[j], this.randomBag[i]]; }
      }
      return tracks[this.randomBag[0] ?? this.index];
    }
    if (tracks[this.index + 1]) return tracks[this.index + 1];
    if (this.contentKind === "album" && this.albumQueue[this.queueIndex + 1]) return this.albumQueue[this.queueIndex + 1].album.tracks?.[0] || null;
    if (this.order === "repeat") return this.contentKind === "album" ? this.albumQueue[0]?.album.tracks?.[0] || null : tracks[0];
    return null;
  }
  private prefetchKey(id: number): string { return `${id}|${this.preferredQuality || this.deps.defaultQuality?.() || "standard"}`; }
  private cancelPrefetch(): void {
    const pending = this.prefetch; this.prefetch = null;
    if (pending) { pending.controller.abort(); void pending.resource.then(resource => { if (!pending.adopted) resource.lease.release(); }, () => {}); }
  }
  private schedulePrefetch(): void {
    if (!this.deps.open || !this.media || this.loading || !this.wanted) return;
    const next = this.nextTrack(), key = next && this.prefetchKey(next.id);
    if (this.prefetch?.key === key) return;
    this.cancelPrefetch(); if (!next || !key) return;
    const controller = new AbortController();
    const pending = { key, controller, adopted: false, resource: null! as Promise<{ source: SongSource; lease: AudioLease }> };
    this.prefetch = pending;
    pending.resource = (async () => {
      const source = await bounded(this.deps.resolve(next.id, this.preferredQuality || this.deps.defaultQuality?.() || "standard"));
      if (controller.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      const lease = await this.deps.open!(source, next.id, next.duration, controller.signal);
      return { source, lease };
    })();
    void pending.resource.then(async resource => {
      if (controller.signal.aborted && !pending.adopted) { resource.lease.release(); return; }
      if (!pending.adopted) try { await resource.lease.warm(Math.max(6, (this.deps.crossFade?.() || 0) + 3), controller.signal); } catch {}
    }, () => {});
  }

  async playAlbum(album: AlbumMeta, index = 0): Promise<boolean> {
    if (!album.tracks?.length) { this.deps.notice(t("internal.noTracks")); return false; }
    if (!Number.isInteger(index) || index < 0 || index >= album.tracks.length) return false;
    if (this.contentKind === "playlist" && this.album) { this.queuedPlaylist = this.album; this.savedPlaylist = { index: this.index, positionMs: this.state.positionMs }; }
    this.contentKind = "album"; if (this.order === "shuffle") this.order = "order";
    this.priorityNext = []; ++this.revision; this.album = { ...album, tracks: album.tracks.map((track) => ({ ...track })) };
    this.currentEntryId = String(++this.entrySerial); this.albumQueue = [{ id: this.currentEntryId, album: this.album }]; this.savedAlbum = null; this.resetRandom();
    return this.select(index);
  }

  private async loadTrack(index: number, restore?: { positionMs: number; playing: boolean }, forceBlob = false, replacing = false): Promise<boolean> {
    const tracks = this.album?.tracks;
    if (!tracks || !Number.isInteger(index) || index < 0 || index >= tracks.length) return false;
    const generation = ++this.generation;
    this.loadingAbort?.abort(); const controller = this.loadingAbort = new AbortController();
    this.wanted = restore?.playing ?? true;
    if (!this.preferredQuality) this.preferredQuality = this.deps.defaultQuality?.() ?? "standard";
    if (this.media) {
      if (this.stallTimer) clearTimeout(this.stallTimer); this.stallTimer = null;
      this.releasePrevious(); this.previous = { media: this.media, url: this.objectUrl, lease: this.lease };
      this.media = null; this.objectUrl = ""; this.lease = null;
    }
    for (let next = index; next < tracks.length; next++) {
      this.priorityNext = this.priorityNext.filter(pending => pending !== next);
      let usedStream = false;
      this.index = next; this.loading = true; this.error = ""; this.trial = false; this.phase = "paused";
      this.quality = null; this.availableQualities = [];
      this.emit();
      try {
        let source: SongSource, prepared: AudioLease | null = null;
        const pending = this.prefetch;
        if (!forceBlob && pending?.key === this.prefetchKey(tracks[next].id)) {
          this.prefetch = null; pending.adopted = true;
          try { const resource = await bounded(pending.resource); source = resource.source; prepared = resource.lease; }
          catch { pending.adopted = false; void pending.resource.then(resource => resource.lease.release(), () => {}); source = await bounded(this.deps.resolve(tracks[next].id, this.preferredQuality)); }
          finally { pending.controller.abort(); }
        } else { this.cancelPrefetch(); source = await bounded(this.deps.resolve(tracks[next].id, this.preferredQuality)); }
        if (generation !== this.generation) { prepared?.release(); return false; }
        this.skipped.delete(next);
        this.quality = source.quality ?? "standard";
        this.availableQualities = source.availableQualities ?? [this.quality];
        this.emit();
        let blob: Blob | null = null;
        if (!forceBlob && !prepared && this.deps.open) {
          const streamController = new AbortController(), cancel = () => streamController.abort();
          controller.signal.addEventListener("abort", cancel, { once: true }); if (controller.signal.aborted) cancel();
          try {
            prepared = await bounded(this.deps.open(source, tracks[next].id, tracks[next].duration, streamController.signal).then(lease => {
              if (generation !== this.generation || streamController.signal.aborted) { lease.release(); throw new DOMException("Cancelled", "AbortError"); }
              return lease;
            }));
          } catch { streamController.abort(); if (controller.signal.aborted) return false; }
          finally { controller.signal.removeEventListener("abort", cancel); }
        }
        if (!prepared) blob = await bounded(this.deps.load(source.url, source.mime));
        if (generation !== this.generation) { prepared?.release(); return false; }
        const media = this.deps.audio?.() ?? new Audio();
        this.media = media;
        this.lease = prepared;
        usedStream = !!prepared;
        this.objectUrl = blob ? URL.createObjectURL(blob) : "";
        this.trial = source.trial;
        const fade = Math.min(replacing ? .08 : 6, Math.max(0, this.deps.crossFade?.() || 0), tracks[next].duration / 2000);
        this.fader.setVolume(this.volume); this.fader.attach(media, this.previous && !this.previous.media.paused && this.wanted && fade > 0 ? 0 : 1);
        media.preload = "auto";
        const alive = () => generation === this.generation && this.media === media;
        let restorePosition = next === index ? restore?.positionMs ?? 0 : 0;
        let restorePending = next === index && !!restore;
        let starting = true;
        const seekRestored = () => {
          if (!alive() || !restorePending || !Number.isFinite(media.duration)) return;
          if (replacing && this.previous) restorePosition = this.previous.media.currentTime * 1000;
          media.currentTime = Math.min(restorePosition / 1000, Math.max(0, media.duration - 0.05));
          restorePending = false;
        };
        media.addEventListener("loadedmetadata", seekRestored);
        let advancing = false;
        for (const event of ["timeupdate", "durationchange", "loadedmetadata", "progress"]) {
          media.addEventListener(event, () => {
            if (!alive()) return; this.emit();
            const remaining = media.duration - media.currentTime, cross = Math.min(6, this.deps.crossFade?.() || 0, media.duration / 2);
            if (event === "timeupdate" && !advancing && !this.loading && this.wanted && cross > 0 && remaining > 0 && remaining <= cross && this.nextTrack()) { advancing = true; void this.advance(true); }
          });
        }
        media.addEventListener("playing", () => {
          if (!alive()) return;
          if (!this.wanted) { media.pause(); return; }
          if (this.stallTimer) clearTimeout(this.stallTimer); this.stallTimer = null;
          this.loading = false; this.phase = "playing"; this.emit();
        });
        media.addEventListener("waiting", () => {
          if (!alive() || !this.wanted || starting) return;
          this.loading = true; this.emit();
          if (this.stallTimer) clearTimeout(this.stallTimer);
          this.stallTimer = setTimeout(() => {
            this.stallTimer = null;
            if (alive() && this.wanted && media.readyState < 3) void this.loadTrack(this.index, { positionMs: this.state.positionMs, playing: true }, true, true);
          }, 20000);
        });
        media.addEventListener("pause", () => { if (alive() && !media.ended) { this.phase = "paused"; this.emit(); } });
        media.addEventListener("ended", () => {
          if (!alive()) return;
          void this.ended();
        });
        media.addEventListener("error", () => {
          if (!alive() || starting) return;
          if (prepared) { void this.loadTrack(this.index, { positionMs: this.state.positionMs, playing: this.wanted }, true, true); return; }
          this.wanted = false; this.loading = false; this.phase = "paused";
          this.error = t("internal.decodeError"); this.deps.notice(this.error); this.emit();
        });
        if (prepared) media.crossOrigin = "anonymous";
        media.src = prepared?.url || this.objectUrl;
        if (this.wanted) {
          try { await this.fader.resume(); await bounded(media.play()); }
          catch (error) {
            if (!alive()) return false;
            if (this.wanted || this.error) throw error;
            // 加载中按暂停会使浏览器拒绝未完成的 play()，这是正常取消。
          }
        }
        if (!alive()) return false;
        starting = false;
        const previous = this.previous;
        if (previous) {
          if (this.wanted && !previous.media.paused && fade > 0) {
            const remaining = previous.media.duration - previous.media.currentTime;
            const overlap = Number.isFinite(remaining) ? Math.min(fade, Math.max(.05, remaining)) : fade;
            void this.fader.fade(media, 1, overlap);
            void this.fader.fade(previous.media, 0, overlap).then(done => { if (done && this.previous === previous) this.releasePrevious(); });
          } else { if (this.wanted) void this.fader.fade(media, 1, Math.min(.3, fade)); this.releasePrevious(); }
        }
        seekRestored();
        this.loading = false;
        this.phase = this.wanted && !media.paused ? "playing" : "paused";
        if (this.trial) this.deps.notice(t("internal.trialNotice", { name: tracks[next].name }));
        this.emit();
        return true;
      } catch (error) {
        if (generation !== this.generation) return false;
        this.releaseCurrent(); this.loading = false;
        if (usedStream && !forceBlob && !controller.signal.aborted) return this.loadTrack(next, restore, true, replacing);
        if (error instanceof TrackUnavailableError && this.wanted && this.order === "shuffle" && this.contentKind === "playlist") {
          this.skipped.add(next);
          this.randomBag = this.randomBag.filter(index => !this.skipped.has(index));
          const candidate = this.randomBag.shift() ?? tracks.findIndex((_, index) => !this.skipped.has(index));
          if (candidate >= 0) { this.history[this.historyIndex] = candidate; return this.loadTrack(candidate); }
        }
        if (error instanceof TrackUnavailableError && this.wanted && next + 1 < tracks.length) {
          this.deps.notice(t("internal.skipped", { name: tracks[next].name }));
          continue;
        }
        if (error instanceof TrackUnavailableError && this.wanted && this.contentKind === "album" && this.albumQueue[this.queueIndex + 1]) return this.playQueued(this.albumQueue[this.queueIndex + 1].id);
        this.wanted = false; this.phase = "stopped";
        this.releasePrevious();
        this.error = error instanceof TrackUnavailableError ? t("internal.unavailable") : t("internal.playFailed");
        this.deps.notice(this.error); this.emit();
        return false;
      }
    }
    return false;
  }

  async play(): Promise<boolean> {
    if (!this.album) return false;
    this.wanted = true;
    if (this.loading && !this.media) { if (this.previous) void this.fader.fade(this.previous.media, 1, this.deps.pauseFade?.() || 0); return true; }
    if (!this.media || this.error) return this.select(Math.max(0, this.index));
    const media = this.media;
    const generation = this.generation;
    const alive = () => generation === this.generation && this.media === media;
    try {
      if (media.ended) media.currentTime = 0;
      await this.fader.resume();
      void this.fader.fade(media, 1, this.deps.pauseFade?.() || 0);
      await bounded(media.play());
      if (alive()) { if (this.wanted && !media.paused) { this.phase = "playing"; this.loading = false; } this.emit(); }
      return alive();
    } catch {
      if (!alive()) return false;
      if (!this.wanted) return true;
      this.wanted = false; this.phase = "paused"; this.error = t("internal.playFailed");
      this.deps.notice(this.error); this.emit(); return false;
    }
  }
  async pause(): Promise<boolean> {
    this.wanted = false; this.cancelPrefetch();
    const generation = this.generation, media = this.media;
    const previous = this.previous, seconds = this.deps.pauseFade?.() || 0;
    if (!this.album) return false;
    this.phase = "paused"; this.emit();
    if (previous) void this.fader.fade(previous.media, 0, seconds).then(done => { if (done && this.previous === previous) this.releasePrevious(); });
    if (media) { const done = await this.fader.fade(media, 0, seconds); if (done && !this.wanted && this.media === media && generation === this.generation) media.pause(); }
    return true;
  }
  async toggle(): Promise<boolean> { return this.wanted ? this.pause() : this.play(); }
  async setQuality(quality: AudioQuality): Promise<boolean> {
    if (this.loading || !this.album || !this.availableQualities.includes(quality)) return false;
    this.preferredQuality = quality;
    if (this.quality === quality) { this.emit(); return true; }
    return this.loadTrack(this.index, { positionMs: this.state.positionMs, playing: this.wanted }, false, true);
  }
  async next(): Promise<boolean> { return this.advance(); }
  async prev(): Promise<boolean> {
    if (this.order === "shuffle") return this.historyIndex > 0 ? this.loadTrack(this.history[--this.historyIndex]) : false;
    if (this.index > 0) return this.loadTrack(this.index - 1);
    if (this.contentKind === "album" && this.queueIndex > 0) return this.playQueued(this.albumQueue[this.queueIndex - 1].id);
    return false;
  }
  async seek(positionMs: number): Promise<boolean> {
    if (!this.state.seekable || !Number.isFinite(positionMs)) return false;
    this.media!.currentTime = Math.min(this.media!.duration, Math.max(0, positionMs / 1000));
    this.emit(); return true;
  }
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.min(1, Math.max(0, volume));
    this.fader.setVolume(this.volume);
    this.emit();
  }
}

/** 保留现有 SMTC 订阅接口，插件内有队列时优先发布自身播放状态。 */
export class CombinedNowPlayingProvider implements NowPlayingProvider {
  private listeners = new Set<NowPlayingListener>();
  private off: (() => void)[];
  constructor(private external: NowPlayingProvider, private internal: InternalPlayer) {
    const changed = () => { for (const listener of this.listeners) listener(this.state); };
    this.off = [external.on(changed), internal.on(changed)];
  }
  private get current(): NowPlayingProvider { return this.internal.album ? this.internal : this.external; }
  get supported(): boolean { return this.current.supported; }
  get state(): NowPlayingState { return this.current === this.internal ? this.internal.state : { ...this.external.state, source: "client" }; }
  on(listener: NowPlayingListener): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  start(): void { this.external.start(); }
  stop(): void { this.external.stop(); }
  play(): Promise<boolean> { return this.current.play(); }
  pause(): Promise<boolean> { return this.current.pause(); }
  toggle(): Promise<boolean> { return this.current.toggle(); }
  next(): Promise<boolean> { return this.current.next(); }
  prev(): Promise<boolean> { return this.current.prev(); }
  seek(ms: number): Promise<boolean> { return this.current.seek(ms); }
  dispose(): void { this.off.forEach((off) => off()); this.listeners.clear(); this.external.stop(); this.internal.dispose(); }
}
