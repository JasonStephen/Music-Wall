import type { AlbumMeta } from "../types";
import { EMPTY_NOW_PLAYING, type NowPlayingListener, type NowPlayingProvider, type NowPlayingState } from "./nowPlaying";
import { TrackUnavailableError, type SongSource } from "./audioSource";
import { t } from "../i18n";

interface InternalPlayerDeps {
  resolve: (id: number) => Promise<SongSource>;
  load: (url: string) => Promise<Blob>;
  notice: (message: string) => void;
  audio?: () => HTMLAudioElement;
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(t("internal.networkError"))), 30000);
    })]);
  } finally { clearTimeout(timer!); }
}

/** 一份全局临时队列；只缓冲当前曲目，换曲、登出、卸载均释放音频。 */
export class InternalPlayer implements NowPlayingProvider {
  readonly supported = true;
  album: AlbumMeta | null = null;
  index = -1;
  loading = false;
  trial = false;
  error = "";
  volume = 1;
  private media: HTMLAudioElement | null = null;
  private objectUrl = "";
  private generation = 0;
  private wanted = false;
  private phase: NowPlayingState["status"] = "none";
  private listeners = new Set<NowPlayingListener>();

  constructor(private deps: InternalPlayerDeps) {}

  get state(): NowPlayingState {
    const track = this.album?.tracks?.[this.index];
    const duration = this.media?.duration;
    return {
      ...EMPTY_NOW_PLAYING, supported: true, source: "internal", active: !!track,
      albumId: this.album?.albumId, songId: track?.id,
      title: track?.name ?? "", artist: track?.artists || this.album?.artist || "",
      album: this.album?.name ?? "", status: this.phase,
      positionMs: (this.media?.currentTime || 0) * 1000,
      durationMs: duration && Number.isFinite(duration) ? duration * 1000 : track?.duration ?? 0,
      seekable: !!this.media && Number.isFinite(duration) && duration! > 0 && !this.loading,
      canPlay: !!track, canPause: !!track, canToggle: !!track,
      canNext: this.index >= 0 && this.index < (this.album?.tracks?.length ?? 0) - 1,
      canPrev: this.index > 0,
    };
  }

  on(listener: NowPlayingListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void { for (const listener of this.listeners) listener(this.state); }
  start(): void {}

  stop(): void {
    ++this.generation;
    this.wanted = false;
    this.release();
    this.album = null; this.index = -1; this.loading = false;
    this.trial = false; this.error = ""; this.phase = "none";
    this.emit();
  }

  private release(): void {
    const media = this.media;
    this.media = null;
    if (media) { media.pause(); media.removeAttribute("src"); media.load(); }
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = "";
  }

  async playAlbum(album: AlbumMeta, index = 0): Promise<boolean> {
    if (!album.tracks?.length) { this.deps.notice(t("internal.noTracks")); return false; }
    if (!Number.isInteger(index) || index < 0 || index >= album.tracks.length) return false;
    this.album = { ...album, tracks: album.tracks.map((track) => ({ ...track })) };
    return this.select(index);
  }

  async select(index: number): Promise<boolean> {
    const tracks = this.album?.tracks;
    if (!tracks || !Number.isInteger(index) || index < 0 || index >= tracks.length) return false;
    const generation = ++this.generation;
    this.wanted = true;
    this.release();
    for (let next = index; next < tracks.length; next++) {
      this.index = next; this.loading = true; this.error = ""; this.trial = false; this.phase = "paused";
      this.emit();
      try {
        const source = await bounded(this.deps.resolve(tracks[next].id));
        if (generation !== this.generation) return false;
        const blob = await bounded(this.deps.load(source.url));
        if (generation !== this.generation) return false;
        const media = this.deps.audio?.() ?? new Audio();
        this.media = media;
        this.objectUrl = URL.createObjectURL(blob);
        this.trial = source.trial;
        media.volume = this.volume;
        media.preload = "auto";
        const alive = () => generation === this.generation && this.media === media;
        for (const event of ["timeupdate", "durationchange", "loadedmetadata"]) {
          media.addEventListener(event, () => { if (alive()) this.emit(); });
        }
        media.addEventListener("playing", () => {
          if (!alive()) return;
          if (!this.wanted) { media.pause(); return; }
          this.loading = false; this.phase = "playing"; this.emit();
        });
        media.addEventListener("pause", () => { if (alive() && !media.ended) { this.phase = "paused"; this.emit(); } });
        media.addEventListener("ended", () => {
          if (!alive()) return;
          if (this.index + 1 < tracks.length) void this.select(this.index + 1);
          else { this.wanted = false; this.phase = "stopped"; this.emit(); }
        });
        media.addEventListener("error", () => {
          if (!alive() || this.loading) return;
          this.wanted = false; this.loading = false; this.phase = "paused";
          this.error = t("internal.decodeError"); this.deps.notice(this.error); this.emit();
        });
        media.src = this.objectUrl;
        if (this.wanted) {
          try { await bounded(media.play()); }
          catch (error) {
            if (!alive()) return false;
            if (this.wanted || this.error) throw error;
            // 加载中按暂停会使浏览器拒绝未完成的 play()，这是正常取消。
          }
        }
        if (!alive()) return false;
        this.loading = false;
        this.phase = this.wanted && !media.paused ? "playing" : "paused";
        if (this.trial) this.deps.notice(t("internal.trialNotice", { name: tracks[next].name }));
        this.emit();
        return true;
      } catch (error) {
        if (generation !== this.generation) return false;
        this.release(); this.loading = false;
        if (error instanceof TrackUnavailableError && this.wanted && next + 1 < tracks.length) {
          this.deps.notice(t("internal.skipped", { name: tracks[next].name }));
          continue;
        }
        this.wanted = false; this.phase = "stopped";
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
    if (this.loading) return true;
    if (!this.media || this.error) return this.select(Math.max(0, this.index));
    const media = this.media;
    const generation = this.generation;
    const alive = () => generation === this.generation && this.media === media;
    try {
      if (media.ended) media.currentTime = 0;
      await bounded(media.play());
      return alive();
    } catch {
      if (!alive()) return false;
      if (!this.wanted) return true;
      this.wanted = false; this.phase = "paused"; this.error = t("internal.playFailed");
      this.deps.notice(this.error); this.emit(); return false;
    }
  }
  async pause(): Promise<boolean> {
    this.wanted = false; this.media?.pause();
    if (!this.album) return false;
    this.phase = "paused"; this.emit(); return true;
  }
  async toggle(): Promise<boolean> { return this.wanted ? this.pause() : this.play(); }
  async next(): Promise<boolean> { return this.select(this.index + 1); }
  async prev(): Promise<boolean> { return this.select(this.index - 1); }
  async seek(positionMs: number): Promise<boolean> {
    if (!this.state.seekable || !Number.isFinite(positionMs)) return false;
    this.media!.currentTime = Math.min(this.media!.duration, Math.max(0, positionMs / 1000));
    this.emit(); return true;
  }
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.media) this.media.volume = this.volume;
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
  dispose(): void { this.off.forEach((off) => off()); this.listeners.clear(); this.external.stop(); this.internal.stop(); }
}
