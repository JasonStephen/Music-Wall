import type { AlbumMeta } from "../types";

/** Wall keys retain the numeric ordering/drag contract: albums positive, playlists negative. */
export function wallCollectionId(meta: AlbumMeta): number {
  return meta.playlistId && meta.playlistId > 0 ? -meta.playlistId : meta.albumId;
}

export function collectionUrl(meta: AlbumMeta): string {
  return `https://music.163.com/${meta.playlistId ? "playlist" : "album"}?id=${meta.playlistId || meta.albumId}`;
}
