import type { AlbumMeta, AlbumTrackSnapshot } from "../types";
import type { AlbumQueueEntry, InternalPlayer, PlaybackOrder } from "./internalPlayer";

export interface PlaybackSession {
  version: 1;
  album: AlbumMeta | null;
  index: number;
  playing: boolean;
  contentKind: "album" | "playlist";
  order: PlaybackOrder;
  albumQueue: AlbumQueueEntry[];
  currentEntryId: string;
  songQueue: AlbumTrackSnapshot[];
  queuedPlaylist: AlbumMeta | null;
  playlistSource?: AlbumMeta | null;
  trackSources?: Record<string, AlbumMeta>;
  savedAlbum: { id: string; index: number } | null;
  savedPlaylist: { index: number } | null;
  priorityNext: number[];
  prioritySongs: number[];
}

export function parsePlaybackSession(text: string): PlaybackSession | null {
  try {
    const value = JSON.parse(text);
    const track = (item: any): boolean => !!item && Number.isSafeInteger(item.id) && item.id > 0
      && (item.playbackSourceId == null || typeof item.playbackSourceId === "string")
      && typeof item.name === "string" && Number.isFinite(item.duration) && item.duration >= 0;
    const album = (item: any): boolean => !!item && Number.isFinite(item.albumId)
      && typeof item.name === "string" && typeof item.artist === "string" && typeof item.cover === "string"
      && Array.isArray(item.tracks) && item.tracks.every(track);
    const index = (i: any, item: AlbumMeta | null): boolean => Number.isInteger(i) && i >= 0 && i < (item?.tracks?.length || 0);
    if (!value || value.version !== 1 || typeof value.playing !== "boolean"
      || !["album", "playlist"].includes(value.contentKind) || !["order", "repeat", "one", "shuffle"].includes(value.order)
      || !(value.album === null && value.index === -1 || album(value.album) && index(value.index, value.album))
      || !Array.isArray(value.albumQueue) || !value.albumQueue.every((entry: any) => typeof entry?.id === "string" && album(entry.album))
      || new Set(value.albumQueue.map((entry: AlbumQueueEntry) => entry.id)).size !== value.albumQueue.length
      || typeof value.currentEntryId !== "string" || !Array.isArray(value.songQueue) || !value.songQueue.every(track)
      || !(value.queuedPlaylist === null || album(value.queuedPlaylist))
      || !(value.playlistSource == null || album(value.playlistSource))
      || !(value.trackSources == null || typeof value.trackSources === "object" && !Array.isArray(value.trackSources)
        && Object.entries(value.trackSources).every(([key, item]) => /^[1-9]\d*$/.test(key) && album(item)))
      || !(value.savedPlaylist === null || index(value.savedPlaylist?.index, value.queuedPlaylist))
      || !(value.savedAlbum === null || typeof value.savedAlbum?.id === "string"
        && index(value.savedAlbum.index, value.albumQueue.find((entry: AlbumQueueEntry) => entry.id === value.savedAlbum.id)?.album))
      || !Array.isArray(value.priorityNext) || !value.priorityNext.every((i: number) => index(i, value.album))
      || !Array.isArray(value.prioritySongs) || !value.prioritySongs.every((id: number) => value.songQueue.some((item: AlbumTrackSnapshot) => item.id === id))) return null;
    return value;
  } catch { return null; }
}

interface SessionAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

/** Playback changes are saved immediately; progress ticks never serialize the queues. */
export class PlaybackSessionStore {
  private writing: Promise<void> = Promise.resolve();
  private off: (() => void) | null = null;
  constructor(private adapter: SessionAdapter, private path: string) {}
  async load(): Promise<PlaybackSession | null> {
    try { return await this.adapter.exists(this.path) ? parsePlaybackSession(await this.adapter.read(this.path)) : null; }
    catch (error) { console.warn("[music-wall] Playback session could not be read", error); return null; }
  }
  watch(player: InternalPlayer, initialPlaying = player.playingRequested): void {
    this.off?.();
    let previous = this.key(player, initialPlaying);
    this.off = player.on(() => {
      const key = this.key(player);
      if (key === previous) return;
      previous = key;
      const text = JSON.stringify(player.exportSession());
      this.writing = this.writing.then(() => this.adapter.write(this.path, text + "\n")).catch(error => {
        previous = ""; console.warn("[music-wall] Playback session could not be saved", error);
      });
    });
  }
  private key(player: InternalPlayer, playing = player.playingRequested): string {
    return [player.revision, player.index, playing, player.order, player.contentKind,
      player.currentEntryId, player.albumQueue.map(entry => entry.id).join(), player.songQueue.map(track => track.id).join()].join("|");
  }
  flush(): Promise<void> { return this.writing; }
  dispose(): Promise<void> { this.off?.(); this.off = null; return this.flush(); }
}
