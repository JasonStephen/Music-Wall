import type { AlbumMeta, AlbumTrackSnapshot } from "../types";

export const SONG_MIME = "application/x-music-wall-song";
export const COLLECTION_MIME = "application/x-music-wall-collection";
export interface SongDrag { tracks: AlbumTrackSnapshot[]; collection?: string; ids: number[]; }
export function readSongs(event: DragEvent): SongDrag | null {
  try {
    const p = JSON.parse(event.dataTransfer?.getData(SONG_MIME) || "");
    if (!Array.isArray(p.tracks) || !p.tracks.length || !p.tracks.every((s: AlbumTrackSnapshot) => s && Number.isSafeInteger(s.id) && s.id > 0 && typeof s.name === "string")) return null;
    return { tracks: p.tracks, ids: p.tracks.map((s: AlbumTrackSnapshot) => s.id), collection: typeof p.collection === "string" ? p.collection : undefined };
  } catch { return null; }
}
export function songSource(el: HTMLElement, get: () => SongDrag): void {
  el.draggable = true;
  el.addEventListener("dragstart", event => {
    event.stopPropagation(); if (!event.dataTransfer) return;
    event.dataTransfer.setData(SONG_MIME, JSON.stringify(get())); event.dataTransfer.effectAllowed = "copyMove";
  });
}
export function collectionSource(el: HTMLElement, meta: AlbumMeta): void {
  el.draggable = true;
  el.addEventListener("dragstart", event => {
    event.stopPropagation(); if (!event.dataTransfer) return;
    event.dataTransfer.setData(COLLECTION_MIME, JSON.stringify(meta)); event.dataTransfer.effectAllowed = "copy";
  });
}
export function readCollection(event: DragEvent): AlbumMeta | null {
  try { const m = JSON.parse(event.dataTransfer?.getData(COLLECTION_MIME) || ""); return m && typeof m.name === "string" && (m.albumId > 0 || m.playlistId > 0) ? m : null; } catch { return null; }
}
export class MouseSelection<T extends string | number> {
  ids = new Set<T>();
  anchor: T | undefined;
  clear(): void { this.ids.clear(); this.anchor = undefined; }
  click(id: T, visible: T[], event: MouseEvent): void {
    if (event.shiftKey && this.anchor !== undefined && visible.includes(this.anchor)) {
      if (!event.ctrlKey && !event.metaKey) this.ids.clear();
      const a = visible.indexOf(this.anchor), b = visible.indexOf(id);
      for (const value of visible.slice(Math.min(a, b), Math.max(a, b) + 1)) this.ids.add(value);
    } else {
      if (event.ctrlKey || event.metaKey) { if (this.ids.has(id)) this.ids.delete(id); else this.ids.add(id); }
      else { this.ids.clear(); this.ids.add(id); }
      this.anchor = id;
    }
  }
  drag(id: T, visible: T[]): T[] {
    if (!this.ids.has(id)) { this.ids.clear(); this.ids.add(id); this.anchor = id; }
    return visible.filter(value => this.ids.has(value));
  }
}

export function reorderIds(visible: string[], moving: string[], target: string, after = false): string[] {
  const rest = visible.filter(id => !moving.includes(id));
  const at = rest.indexOf(target); if (at < 0) return visible;
  rest.splice(at + (after ? 1 : 0), 0, ...moving); return rest;
}
