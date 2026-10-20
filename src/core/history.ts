import type { AlbumMeta, AlbumTrackSnapshot } from "../types";

export type HistoryKind = "songs" | "albums" | "playlists";
export type SearchScope = "library" | "wall";
export interface HistoryEntry { id: number; track?: AlbumTrackSnapshot; collection?: AlbumMeta; }
interface Bucket { songs: HistoryEntry[]; albums: HistoryEntry[]; playlists: HistoryEntry[]; library: string[]; wall: string[]; }
interface Storage { exists(path: string): Promise<boolean>; read(path: string): Promise<string>; write(path: string, value: string): Promise<unknown>; }
const empty = (): Bucket => ({ songs: [], albums: [], playlists: [], library: [], wall: [] });
const limits = { songs: 500, albums: 200, playlists: 200 };
const text = (v: unknown, max = 500) => typeof v === "string" ? v.slice(0, max) : "";
const id = (v: unknown) => Number.isSafeInteger(v) && Number(v) > 0;
function track(v: any): AlbumTrackSnapshot {
  return { id: v.id, name: text(v.name), duration: Math.max(0, Number(v.duration) || 0), artists: text(v.artists),
    albumId: id(v.albumId) ? v.albumId : undefined, albumName: text(v.albumName), cover: text(v.cover, 2000),
    artistRefs: Array.isArray(v.artistRefs) ? v.artistRefs.filter((a: any) => id(a?.id)).slice(0, 50).map((a: any) => ({ id: a.id, name: text(a.name) })) : undefined };
}
function collection(v: any): AlbumMeta {
  return { albumId: id(v.albumId) ? v.albumId : 0, playlistId: id(v.playlistId) ? v.playlistId : undefined,
    name: text(v.name), artist: text(v.artist), cover: text(v.cover, 2000), trackCount: Math.max(0, Math.floor(Number(v.trackCount) || 0)) };
}

/** Local-only, account-scoped history. Persist brief metadata, never cookies or track lists. */
export class HistoryStore {
  private buckets = new Map<string, Bucket>();
  private listeners = new Set<() => void>();
  private writes: Promise<void> = Promise.resolve();
  private loading: Promise<void> | null = null;
  constructor(private storage: Storage, private path: string) {}
  private scope(value: string): string { return /^\d+$/.test(value) ? value : "guest"; }
  async ready(): Promise<void> {
    if (!this.loading) this.loading = (async () => {
      try {
        if (!(await this.storage.exists(this.path))) return;
        const body = JSON.parse(await this.storage.read(this.path));
        if (body.version !== 1 || !Array.isArray(body.accounts)) return;
        for (const [scope, source] of body.accounts.slice(-50)) {
          if (typeof scope !== "string" || this.scope(scope) !== scope || !source) continue;
          const bucket = empty();
          for (const kind of ["songs", "albums", "playlists"] as const) {
            const seen = new Set<number>();
            for (const entry of (Array.isArray(source[kind]) ? source[kind] : []).slice(0, limits[kind])) {
              if (!id(entry?.id) || seen.has(entry.id)) continue;
              if (kind === "songs" ? !id(entry.track?.id) || entry.track.id !== entry.id : !entry.collection || (kind === "albums" ? entry.collection.albumId : entry.collection.playlistId) !== entry.id) continue;
              seen.add(entry.id); bucket[kind].push({ id: entry.id, ...(kind === "songs" ? { track: track(entry.track) } : { collection: collection(entry.collection) }) });
            }
          }
          for (const kind of ["library", "wall"] as const) bucket[kind] = [...new Set<string>((Array.isArray(source[kind]) ? source[kind] : []).filter((v: any) => typeof v === "string" && v.trim()).map((v: string) => text(v.trim(), 200)))].slice(0, 30);
          this.buckets.set(scope, bucket);
        }
      } catch { /* A malformed history must not block playback. */ }
    })();
    await this.loading;
  }
  private bucket(scope: string): Bucket {
    const key = this.scope(scope); let bucket = this.buckets.get(key);
    if (!bucket) { bucket = empty(); this.buckets.set(key, bucket); }
    return bucket;
  }
  on(callback: () => void): () => void { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  list(scope: string, kind: HistoryKind): HistoryEntry[] { return this.bucket(scope)[kind].map(e => ({ ...e })); }
  searches(scope: string, kind: SearchScope): string[] { return [...this.bucket(scope)[kind]]; }
  async record(scope: string, kind: HistoryKind, value: AlbumMeta | AlbumTrackSnapshot): Promise<void> {
    await this.ready();
    const key = kind === "songs" ? (value as AlbumTrackSnapshot).id : kind === "albums" ? (value as AlbumMeta).albumId : (value as AlbumMeta).playlistId;
    if (!id(key)) return;
    const bucket = this.bucket(scope);
    bucket[kind] = [{ id: key!, ...(kind === "songs" ? { track: track(value) } : { collection: collection(value) }) }, ...bucket[kind].filter(e => e.id !== key)].slice(0, limits[kind]);
    await this.save();
  }
  async search(scope: string, kind: SearchScope, keyword: string): Promise<void> {
    await this.ready(); keyword = keyword.trim().slice(0, 200); if (!keyword) return;
    const bucket = this.bucket(scope); bucket[kind] = [keyword, ...bucket[kind].filter(v => v !== keyword)].slice(0, 30); await this.save();
  }
  async remove(scope: string, kind: HistoryKind | SearchScope, key: number | string): Promise<void> {
    await this.ready(); const b = this.bucket(scope);
    if (kind === "library" || kind === "wall") b[kind] = b[kind].filter(v => v !== key);
    else b[kind] = b[kind].filter(v => v.id !== key);
    await this.save();
  }
  async clear(scope?: string, kind?: HistoryKind | "playback" | "search"): Promise<void> {
    await this.ready();
    for (const b of scope === undefined ? this.buckets.values() : [this.bucket(scope)]) {
      if (!kind || kind === "playback") { b.songs = []; b.albums = []; b.playlists = []; }
      else if (kind !== "search") b[kind] = [];
      if (!kind || kind === "search") { b.library = []; b.wall = []; }
    }
    await this.save();
  }
  usage(kind?: "playback" | "search"): number {
    const accounts = [...this.buckets].map(([scope, b]) => [scope, kind === "playback" ? {songs:b.songs, albums:b.albums, playlists:b.playlists} : kind === "search" ? {library:b.library, wall:b.wall} : b]);
    return new TextEncoder().encode(JSON.stringify({ version: 1, accounts })).byteLength;
  }
  private async save(): Promise<void> {
    const body = JSON.stringify({ version: 1, accounts: [...this.buckets] });
    const write = this.writes.catch(() => {}).then(() => this.storage.write(this.path, body)).then(() => {});
    this.writes = write; for (const callback of this.listeners) callback(); await write;
  }
  async flush(): Promise<void> { await this.writes; }
}
