import { weapiPost, type Requester } from "./metadata";

export interface LyricLine { time: number | null; text: string; translation?: string; }
export interface Lyrics { lines: LyricLine[]; instrumental: boolean; }
interface DiskStore { exists(path: string): Promise<boolean>; read(path: string): Promise<string>; write(path: string, value: string): Promise<unknown>; }

/** LRC timestamps are milliseconds; translation is aligned by time, never by row number. */
export function parseLrc(text: string): LyricLine[] {
  const offset = Number(/\[offset:\s*([+-]?\d+)\s*\]/i.exec(text)?.[1] || 0);
  const timed: LyricLine[] = [], plain: LyricLine[] = [];
  for (const raw of text.slice(0, 200000).replace(/^\uFEFF/, "").split(/\r?\n/).slice(0, 3000)) {
    const matches = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const content = raw.replace(/\[[^\]]*\]/g, "").trim().slice(0, 4000);
    if (matches.length) {
      for (const match of matches) if (Number(match[2]) < 60) timed.push({
        time: Math.max(0, Number(match[1]) * 60000 + Number(match[2]) * 1000 + Number((match[3] || "").padEnd(3, "0")) + offset), text: content,
      });
    } else if (content && !/^\s*\{/.test(content) && !/^\s*\[/.test(raw)) plain.push({ time: null, text: content });
  }
  return timed.length ? timed.sort((a, b) => a.time! - b.time!).slice(0, 3000) : plain;
}
export function parseLyrics(body: any): Lyrics {
  const lines = parseLrc(String(body.lrc?.lyric || ""));
  const translations = new Map<number, string[]>();
  for (const line of parseLrc(String(body.tlyric?.lyric || ""))) if (line.time !== null && line.text) {
    const group = translations.get(line.time) || []; if (!group.includes(line.text)) group.push(line.text); translations.set(line.time, group);
  }
  for (const line of lines) if (line.time !== null) line.translation = translations.get(line.time)?.filter(text => text !== line.text).join("\n") || undefined;
  return { lines, instrumental: body.nolyric === true || (!lines.some(line => line.text) && body.pureMusic === true) };
}
export function lyricIndexAt(lines: LyricLine[], positionMs: number): number {
  if (!Number.isFinite(positionMs) || !lines.length || lines[0].time === null) return -1;
  let low = 0, high = lines.length;
  while (low < high) { const mid = (low + high) >>> 1; if (lines[mid].time! <= positionMs) low = mid + 1; else high = mid; }
  return low - 1;
}

/** Public lyrics only: no cookies or account information in requests or persisted entries. */
export class LyricsService {
  private cache = new Map<number, { time: number; value: Lyrics }>();
  private pending = new Map<number, Promise<Lyrics>>();
  private ready: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  constructor(private request: Requester, private disk?: DiskStore, private path = "", private now = Date.now) {}
  private load(): Promise<void> {
    if (!this.ready) this.ready = (async () => {
      try {
        if (!this.disk || !(await this.disk.exists(this.path))) return;
        const body = JSON.parse(await this.disk.read(this.path));
        if (body.version !== 1 || !Array.isArray(body.entries)) return;
        for (const entry of body.entries.slice(-150)) if (Number.isSafeInteger(entry?.id) && entry.id > 0 && Number.isFinite(entry.time) && entry.time <= this.now() &&
          typeof entry.value?.instrumental === "boolean" && Array.isArray(entry.value.lines) && entry.value.lines.length <= 3000 && entry.value.lines.every((line: any) =>
            line && (line.time === null || Number.isFinite(line.time) && line.time >= 0) && typeof line.text === "string" && line.text.length < 10000 &&
            (line.translation === undefined || typeof line.translation === "string" && line.translation.length < 10000))) this.cache.set(entry.id, { time: entry.time, value: entry.value });
      } catch { /* Cache failure does not prevent online lyrics. */ }
    })(); return this.ready;
  }
  async get(id: number, refresh = false): Promise<Lyrics> {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("Invalid song ID");
    await this.load(); const hit = this.cache.get(id);
    const ttl = hit?.value.lines.length ? 7 * 86400000 : 3600000;
    if (!refresh && hit && this.now() - hit.time < ttl) return hit.value;
    const pending = this.pending.get(id); if (pending) return pending;
    const work = (async () => {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const body = await Promise.race([
          weapiPost(this.request, "/api/song/lyric", { id, lv: -1, kv: -1, tv: -1, rv: -1, _nmclfl: 1 }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Lyrics request timed out")), 15000); }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
        if (body.code !== 200 || !body.lrc && body.nolyric !== true && body.uncollected !== true && body.pureMusic !== true) throw new Error("Lyrics unavailable");
        const value = parseLyrics(body);
        this.cache.delete(id); this.cache.set(id, { time: this.now(), value });
        while (this.cache.size > 150) this.cache.delete(this.cache.keys().next().value!);
        if (this.disk) {
          const content = JSON.stringify({ version: 1, entries: [...this.cache].map(([id, entry]) => ({ id, ...entry })) });
          this.writing = this.writing.then(async () => { try { await this.disk!.write(this.path, content); } catch {} });
        }
        return value;
      } catch (error) { if (hit && !refresh) return hit.value; throw error; }
      finally { this.pending.delete(id); }
    })(); this.pending.set(id, work); return work;
  }
}
