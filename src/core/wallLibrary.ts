import type { AlbumMeta, AlbumTrackSnapshot, DiscStyle, MusicWallData, SortMode } from "../types";

export const WALL_LIBRARY_PATH = "MusicWall/music-wall.json";
export type WallKind = "local" | "playlists" | "albums";
export const WALL_KINDS: WallKind[] = ["local", "playlists", "albums"];
export const WALL_STYLES = ["cover", "vinyl", "colored-vinyl", "cd", "cassette"] as const;
export type WallDiscStyle = typeof WALL_STYLES[number];
export interface LibraryFolder { id: string; kind: WallKind; parent: string | null; name: string; collapsed?: boolean; }
export interface SavedCollection { id: string; kind: WallKind; meta: AlbumMeta; }
export interface LibraryEntry { id: string; collection: string; folder: string | null; addedAt: string; rating?: number; metaEdited?: boolean; snapshot?: AlbumMeta; }
export interface FolderView { sort: SortMode; asc: boolean; order: string[]; }
export interface WallLocation { kind: WallKind | null; folder: string | null; entry?: string; }
export interface WallLibraryData {
  version: 1;
  folders: LibraryFolder[];
  collections: SavedCollection[];
  entries: LibraryEntry[];
  views: Record<string, FolderView>;
  appearance: { style: WallDiscStyle; layout: "grid" | "list" };
  last: WallLocation;
  migrated: string[];
}
export const newId = () => globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export const folderKey = (kind: WallKind, folder: string | null) => `${kind}/${folder || ""}`;
export function emptyLibrary(style: WallDiscStyle = "vinyl"): WallLibraryData {
  return { version: 1, folders: [], collections: [], entries: [], views: {}, appearance: { style, layout: "grid" }, last: { kind: null, folder: null }, migrated: [] };
}
export function parseLibrary(text: string): WallLibraryData {
  const d = JSON.parse(text) as WallLibraryData;
  if (!d || d.version !== 1 || !Array.isArray(d.folders) || !Array.isArray(d.collections) || !Array.isArray(d.entries) || !d.views || typeof d.views !== "object" || Array.isArray(d.views)) throw new Error("Invalid collection");
  const folders = new Map<string, LibraryFolder>();
  for (const f of d.folders) {
    if (!f || typeof f.id !== "string" || !f.id || folders.has(f.id) || !WALL_KINDS.includes(f.kind) || typeof f.name !== "string" || !f.name.trim() || f.parent !== null && typeof f.parent !== "string") throw new Error("Invalid folder");
    folders.set(f.id, f);
  }
  for (const f of d.folders) {
    const seen = new Set([f.id]); let parent = f.parent;
    while (parent !== null) {
      const p = folders.get(parent);
      if (!p || p.kind !== f.kind || seen.has(p.id)) throw new Error("Invalid folder tree");
      seen.add(p.id); parent = p.parent;
    }
  }
  const collections = new Map<string, SavedCollection>();
  for (const c of d.collections) {
    if (!c || typeof c.id !== "string" || collections.has(c.id) || !WALL_KINDS.includes(c.kind) || !c.meta || typeof c.meta.name !== "string" || !Number.isFinite(c.meta.albumId)) throw new Error("Invalid collection");
    if (c.kind === "albums" && !(Number.isSafeInteger(c.meta.albumId) && c.meta.albumId > 0 && !c.meta.playlistId) || c.kind === "playlists" && !(Number.isSafeInteger(c.meta.playlistId) && c.meta.playlistId! > 0 && c.meta.albumId === 0) || c.kind === "local" && (c.meta.localPlaylistId !== c.id || c.meta.albumId !== 0 || c.meta.playlistId)) throw new Error("Invalid collection identity");
    if (c.meta.tracks !== undefined && (!Array.isArray(c.meta.tracks) || c.meta.tracks.some(s => !s || !Number.isSafeInteger(s.id) || s.id <= 0 || typeof s.name !== "string"))) throw new Error("Invalid songs");
    collections.set(c.id, c);
  }
  const ids = new Set<string>(), locations = new Set<string>(), locals = new Set<string>();
  for (const e of d.entries) {
    if (!e) throw new Error("Invalid saved item");
    const c = collections.get(e.collection);
    if (!e || typeof e.id !== "string" || ids.has(e.id) || !c || typeof e.addedAt !== "string" || e.folder !== null && (!folders.has(e.folder) || folders.get(e.folder)!.kind !== c.kind)) throw new Error("Invalid saved item");
    if (locations.has(`${e.collection}/${e.folder}`) || c.kind === "local" && locals.has(c.id)) throw new Error("Duplicate saved item");
    if (e.rating !== undefined && (!Number.isInteger(e.rating) || e.rating < 1 || e.rating > 5 || c.kind === "local")) throw new Error("Invalid rating");
    locations.add(`${e.collection}/${e.folder}`); ids.add(e.id); if (c.kind === "local") locals.add(c.id);
  }
  if (!d.appearance || !WALL_STYLES.includes(d.appearance.style) || !["grid", "list"].includes(d.appearance.layout)) throw new Error("Invalid appearance");
  for (const v of Object.values(d.views)) if (!v || !["manual", "addedAt", "name", "artist", "year", "rating"].includes(v.sort) || typeof v.asc !== "boolean" || !Array.isArray(v.order) || v.order.some(id => typeof id !== "string")) throw new Error("Invalid order");
  if (!Array.isArray(d.migrated) || d.migrated.some(p => typeof p !== "string")) throw new Error("Invalid migration");
  if (!d.last || d.last.kind !== null && !WALL_KINDS.includes(d.last.kind)) d.last = { kind: null, folder: null };
  if (d.last.folder && folders.get(d.last.folder)?.kind !== d.last.kind) d.last = { kind: d.last.kind, folder: null };
  return d;
}
export function folderPath(d: WallLibraryData, folder: string | null): string {
  const names: string[] = []; const seen = new Set<string>();
  while (folder && !seen.has(folder)) { seen.add(folder); const f = d.folders.find(f => f.id === folder); if (!f) break; names.unshift(f.name); folder = f.parent; }
  return names.join(" / ");
}
export function descendants(d: WallLibraryData, folder: string): Set<string> {
  const ids = new Set([folder]); let changed = true;
  while (changed) { changed = false; for (const f of d.folders) if (f.parent && ids.has(f.parent) && !ids.has(f.id)) { ids.add(f.id); changed = true; } }
  return ids;
}
function checkParent(d: WallLibraryData, kind: WallKind, parent: string | null): void {
  if (parent !== null && !d.folders.some(f => f.id === parent && f.kind === kind)) throw new Error("Folder unavailable");
}
export function addFolder(d: WallLibraryData, kind: WallKind, parent: string | null, name: string): LibraryFolder {
  checkParent(d, kind, parent); name = name.trim(); if (!name) throw new Error("Name required");
  if (d.folders.some(f => f.kind === kind && f.parent === parent && f.name === name)) throw new Error("Name already exists");
  const f = { id: newId(), kind, parent, name }; d.folders.push(f); return f;
}
export function addSaved(d: WallLibraryData, meta: AlbumMeta, folder: string | null, extra: Partial<LibraryEntry> = {}): LibraryEntry | null {
  const kind: WallKind = meta.localPlaylistId ? "local" : meta.playlistId ? "playlists" : "albums";
  checkParent(d, kind, folder);
  const id = kind === "local" ? meta.localPlaylistId! : `${kind}:${meta.playlistId || meta.albumId}`;
  if (d.entries.some(e => e.collection === id && (kind === "local" || e.folder === folder))) return null;
  if (!d.collections.some(c => c.id === id)) {
    const snapshot = JSON.parse(JSON.stringify(meta)) as AlbumMeta;
    delete snapshot.playbackWallPath; delete snapshot.wallEntryId;
    d.collections.push({ id, kind, meta: snapshot });
  }
  const e: LibraryEntry = { ...extra, id: newId(), collection: id, folder, addedAt: extra.addedAt || new Date().toISOString() };
  d.entries.push(e); return e;
}
export function createPlaylist(d: WallLibraryData, folder: string | null, name: string): LibraryEntry {
  if (!name.trim()) throw new Error("Name required");
  const id = `local:${newId()}`;
  return addSaved(d, { albumId: 0, localPlaylistId: id, name: name.trim(), artist: "", cover: "", description: "", trackCount: 0, tracks: [] }, folder)!;
}
export function moveFolder(d: WallLibraryData, id: string, parent: string | null): void {
  const f = d.folders.find(f => f.id === id); if (!f) throw new Error("Folder unavailable");
  checkParent(d, f.kind, parent);
  if (parent && descendants(d, id).has(parent) || d.folders.some(other => other.id !== id && other.kind === f.kind && other.parent === parent && other.name === f.name)) throw new Error("Cannot move folder");
  f.parent = parent;
}
export function clonePlaylist(d: WallLibraryData, source: AlbumMeta, folder: string | null): LibraryEntry {
  const entry = createPlaylist(d, folder, source.name);
  const c = d.collections.find(c => c.id === entry.collection)!;
  c.meta.description = source.description || "";
  addSongs(d, c.id, (source.tracks || []).map(s => ({ ...s })));
  return entry;
}
export function moveEntries(d: WallLibraryData, ids: string[], folder: string | null): void {
  for (const id of ids) {
    const e = d.entries.find(e => e.id === id); if (!e) continue;
    const c = d.collections.find(c => c.id === e.collection)!; checkParent(d, c.kind, folder);
    if (d.entries.some(other => other.id !== id && other.collection === e.collection && other.folder === folder)) throw new Error("Already in folder");
    e.folder = folder;
  }
}
export function removeEntries(d: WallLibraryData, ids: string[]): void {
  d.entries = d.entries.filter(e => !ids.includes(e.id));
  const used = new Set(d.entries.map(e => e.collection)); d.collections = d.collections.filter(c => used.has(c.id));
}
export function removeFolder(d: WallLibraryData, id: string): void {
  const ids = descendants(d, id); removeEntries(d, d.entries.filter(e => e.folder && ids.has(e.folder)).map(e => e.id));
  d.folders = d.folders.filter(f => !ids.has(f.id));
  if (d.last.folder && ids.has(d.last.folder)) d.last = { kind: d.last.kind, folder: null };
}
export function addSongs(d: WallLibraryData, collection: string, songs: AlbumTrackSnapshot[]): number {
  const c = d.collections.find(c => c.id === collection && c.kind === "local"); if (!c) throw new Error("Playlist unavailable");
  const tracks = c.meta.tracks || (c.meta.tracks = []), seen = new Set(tracks.map(s => s.id)); let count = 0;
  for (const s of songs) if (Number.isSafeInteger(s.id) && s.id > 0 && !seen.has(s.id)) { tracks.push({ ...s }); seen.add(s.id); count++; }
  c.meta.trackCount = tracks.length; return count;
}
export function migrateWall(d: WallLibraryData, path: string, wall: MusicWallData): number {
  path = path.replace(/\\/g, "/"); if (d.migrated.includes(path)) return 0;
  const kinds = new Set<WallKind>(wall.items.map(i => i.meta.playlistId ? "playlists" : "albums")); let count = 0;
  if (!kinds.size) kinds.add("albums");
  for (const kind of kinds) {
    let parent: string | null = null;
    for (const name of path.replace(/\.mw$/i, "").split("/").filter(Boolean)) parent = (d.folders.find(f => f.kind === kind && f.parent === parent && f.name === name) || addFolder(d, kind, parent, name)).id;
    const groupFolders = new Map<string, string>();
    for (const g of wall.groups || []) {
      const folder = d.folders.find(f => f.kind === kind && f.parent === parent && f.name === g.name) || addFolder(d, kind, parent, g.name);
      folder.collapsed = g.collapsed; groupFolders.set(g.id, folder.id);
    }
    const byId = new Map(wall.items.map(i => [i.albumId, i]));
    const ordered = [...new Set([...(wall.order || []), ...wall.items.map(i => i.albumId)])].map(id => byId.get(id)).filter(Boolean);
    for (const item of ordered) {
      if (!item || (item.meta.playlistId ? "playlists" : "albums") !== kind) continue;
      const folder = item.groupId && groupFolders.get(item.groupId) || parent;
      const e = addSaved(d, item.meta, folder, { addedAt: item.addedAt, rating: item.rating, metaEdited: item.metaEdited, snapshot: JSON.parse(JSON.stringify(item.meta)) });
      if (e) { count++; const key = folderKey(kind, folder); const v = d.views[key] || (d.views[key] = { sort: wall.view?.sortMode || (wall.order ? "manual" : "addedAt"), asc: wall.view?.sortAsc ?? true, order: [] }); v.order.push(e.id); }
    }
  }
  d.migrated.push(path); return count;
}
interface StorageAdapter { exists(path: string): Promise<boolean>; read(path: string): Promise<string>; write(path: string, text: string): Promise<void>; mkdir(path: string): Promise<void>; }
export class WallLibraryStore {
  data: WallLibraryData;
  private queue: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  constructor(private adapter: StorageAdapter, readonly path = WALL_LIBRARY_PATH, style: DiscStyle = "vinyl") { this.data = emptyLibrary(style); }
  private async read(): Promise<WallLibraryData> { return await this.adapter.exists(this.path) ? parseLibrary(await this.adapter.read(this.path)) : emptyLibrary(this.data.appearance.style); }
  async ready(): Promise<void> { this.data = await this.read(); }
  on(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  reload(): Promise<void> { return this.enqueue(async () => { const data = await this.read(); if (JSON.stringify(data) !== JSON.stringify(this.data)) { this.data = data; this.emit(); } }); }
  private emit(): void { for (const fn of this.listeners) fn(); }
  private enqueue<T>(action: () => Promise<T>): Promise<T> { const run = this.queue.then(action); this.queue = run.catch(() => {}); return run; }
  update<T>(change: (d: WallLibraryData) => T): Promise<T> {
    return this.enqueue(async () => {
      const d = await this.read(); const result = change(d); const text = JSON.stringify(d, null, 2); parseLibrary(text);
      const parts = this.path.split("/"); parts.pop(); let dir = "";
      for (const part of parts) { dir = dir ? `${dir}/${part}` : part; if (!(await this.adapter.exists(dir))) await this.adapter.mkdir(dir); }
      await this.adapter.write(this.path, text + "\n"); this.data = d; this.emit(); return result;
    });
  }
}
