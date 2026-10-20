export interface CachedCollectionStats { count: number; duration?: number; }
interface Entry { key: string; stats: CachedCollectionStats; observedCount: number; updated: number; }
interface Storage { exists(path: string): Promise<boolean>; read(path: string): Promise<string>; write(path: string, value: string): Promise<unknown>; }
const LIMIT = 2000;
const validStats = (value: any): value is CachedCollectionStats => !!value && Number.isSafeInteger(value.count) && value.count >= 0 &&
  (value.duration === undefined || (Number.isFinite(value.duration) && value.duration >= 0));

/** Small local metadata file. Never stores credentials, artwork or track lists. */
export class CollectionStatsCache {
  revision = 0;
  private entries = new Map<string, Entry>();
  private loading: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();
  constructor(private storage: Storage, private path: string, private now = Date.now) {}
  private key(scope: string, collection: string): string | null {
    return /^(public|\d+)$/.test(scope) && /^(album|playlist):\d+$/.test(collection) ? `${scope}/${collection}` : null;
  }
  private ready(): Promise<void> {
    if (!this.loading) this.loading = (async () => {
      try {
        if (!(await this.storage.exists(this.path))) return;
        const body = JSON.parse(await this.storage.read(this.path));
        if (body.version !== 1 || !Array.isArray(body.entries)) return;
        for (const entry of body.entries.slice(-LIMIT)) {
          if (!entry || typeof entry.key !== "string" || !/^(public|\d+)\/(album|playlist):\d+$/.test(entry.key) || !validStats(entry.stats) ||
            !Number.isSafeInteger(entry.observedCount) || entry.observedCount < 0 || !Number.isFinite(entry.updated) || entry.updated < 0 || entry.updated > this.now()) continue;
          this.entries.set(entry.key, { key: entry.key, stats: { count: entry.stats.count, duration: entry.stats.duration }, observedCount: entry.observedCount, updated: entry.updated });
        }
      } catch { /* A missing, corrupt or unavailable cache must never block the library. */ }
    })();
    return this.loading;
  }
  async get(scope: string, collection: string, observedCount: number): Promise<{ stats: CachedCollectionStats; fresh: boolean } | null> {
    const key = this.key(scope, collection); if (!key) return null;
    await this.ready(); const entry = this.entries.get(key); if (!entry) return null;
    const ttl = entry.stats.duration === undefined ? 5 * 60000 : collection.startsWith("album:") ? 30 * 86400000 : 6 * 3600000;
    return { stats: { ...entry.stats }, fresh: entry.observedCount === observedCount && this.now() - entry.updated < ttl };
  }
  async put(scope: string, collection: string, observedCount: number, stats: CachedCollectionStats, revision = this.revision): Promise<void> {
    const key = this.key(scope, collection); if (!key || !validStats(stats) || !Number.isSafeInteger(observedCount) || observedCount < 0) return;
    await this.ready(); if (revision !== this.revision) return; this.entries.delete(key);
    this.entries.set(key, { key, stats: { count: stats.count, duration: stats.duration }, observedCount, updated: this.now() });
    while (this.entries.size > LIMIT) this.entries.delete(this.entries.keys().next().value!);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 400);
  }
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    await this.ready();
    const content = JSON.stringify({ version: 1, entries: [...this.entries.values()] });
    this.writes = this.writes.catch(() => {}).then(async () => { try { await this.storage.write(this.path, content); } catch { /* Best effort; retry on the next update. */ } });
    await this.writes;
  }
  usage(): number { return new TextEncoder().encode(JSON.stringify([...this.entries])).byteLength; }
  async clear(): Promise<void> {
    ++this.revision; await this.ready(); if (this.timer) clearTimeout(this.timer); this.timer = null; this.entries.clear();
    this.writes = this.writes.catch(() => {}).then(async () => { await this.storage.write(this.path, JSON.stringify({version:1,entries:[]})); });
    await this.writes;
  }

}
