import type { AlbumMeta, AlbumSummary, AlbumTrackSnapshot } from "../types";
import { weapiPost, type Requester } from "./metadata";
import { LoginRequiredError } from "./playlist";
import { t } from "../i18n";
import { artistAlbumFilterKey, artistAlbumKeywords, normalizeArtistAlbumFilters, type ArtistAlbumFilters } from "./artistAlbumFilters";
export { artistAlbumFilterKey, type ArtistAlbumFilters } from "./artistAlbumFilters";

export interface CloudPlaylist { id: number; name: string; cover: string; creator: string; owner: number; count: number; special: number; }
const playlist = (item: any): CloudPlaylist => ({ id: Number(item.id), name: String(item.name || ""), cover: item.coverImgUrl || item.picUrl || "", creator: item.creator?.nickname || "", owner: Number(item.creator?.userId || item.userId), count: Number(item.trackCount || 0), special: Number(item.specialType || 0) });
const song = (item: any): AlbumTrackSnapshot => ({ id: Number(item.id), name: item.name || "", duration: Number(item.dt || item.duration || 0), artistRefs: (item.ar || item.artists || []).filter((a: any) => Number(a.id) > 0).map((a: any) => ({ id: Number(a.id), name: String(a.name || "") })), artists: (item.ar || item.artists || []).map((artist: any) => artist.name).join(" / "), albumId: (item.al || item.album)?.id, albumName: (item.al || item.album)?.name, cover: (item.al || item.album)?.picUrl });
export type LibrarySearchKind = "songs" | "artists" | "albums" | "playlists";
export interface CloudArtist { id: number; name: string; cover: string; }
export interface LibrarySearchResult { songs: AlbumTrackSnapshot[]; artists: CloudArtist[]; albums: AlbumSummary[]; playlists: CloudPlaylist[]; more: boolean; }
export interface ArtistAlbumPage { albums: AlbumSummary[]; more: boolean; nextOffset: number; filterKey: string; }
export interface ArtistContent extends ArtistAlbumPage { artist: CloudArtist; tracks: AlbumTrackSnapshot[]; }
const album = (item: any): AlbumSummary => ({ albumId: Number(item.id), name: item.name || "", artist: (item.artists || [item.artist]).filter(Boolean).map((a: any) => a.name).join(" / "), cover: item.picUrl || item.blurPicUrl || "", trackCount: Number(item.size || 0), publishTime: item.publishTime, year: item.publishTime ? String(new Date(item.publishTime).getFullYear()) : undefined });

export class MusicLibraryApi {
  private generation = 0;
  private lists: { cookie: string; uid: number; time: number; value: CloudPlaylist[] } | null = null;
  constructor(private request: Requester) {}
  clear(): void { ++this.generation; this.lists = null; }
  private async call(path: string, data: Record<string, unknown>, cookie: string): Promise<any> {
    const result = await weapiPost(this.request, path, data, cookie);
    if (result?.code === 301 || result?.code === 401) throw new LoginRequiredError(t("auth.signedOutDesc"));
    if (result?.code !== 200) throw new Error(t("library.failed"));
    return result;
  }
  async userPlaylists(uid: number, cookie: string, refresh = false): Promise<CloudPlaylist[]> {
    if (!refresh && this.lists?.cookie === cookie && this.lists.uid === uid && Date.now() - this.lists.time < 30000) return this.lists.value;
    const generation = this.generation;
    const result: CloudPlaylist[] = [], seen = new Set<number>();
    for (let offset = 0; ; offset += 200) {
      const body = await this.call("/api/user/playlist", { uid, offset, limit: 200, includeVideo: false }, cookie);
      const page: any[] = body.playlist || [];
      let added = 0;
      for (const item of page) if (Number(item.id) > 0 && !seen.has(Number(item.id))) { seen.add(Number(item.id)); result.push(playlist(item)); added++; }
      if (!added || body.more === false || (body.more == null && page.length < 200)) break;
    }
    if (generation === this.generation) this.lists = { cookie, uid, time: Date.now(), value: result }; return result;
  }
  async search(keyword: string, cookie: string, offset = 0): Promise<{ items: CloudPlaylist[]; more: boolean }> {
    const result = await this.searchContent(keyword, "playlists", cookie, offset);
    return { items: result.playlists, more: result.more };
  }
  async searchContent(keyword: string, kind: LibrarySearchKind, cookie: string, offset = 0): Promise<LibrarySearchResult> {
    const type = { songs: 1, artists: 100, albums: 10, playlists: 1000 }[kind];
    const body = await this.call("/api/cloudsearch/pc", { s: keyword, type, limit: 30, offset, total: true }, cookie);
    const raw = body.result || {}, result: LibrarySearchResult = { songs: [], artists: [], albums: [], playlists: [], more: false };
    const rows = Array.isArray(raw[kind]) ? raw[kind] : [];
    if (kind === "songs") result.songs = rows.map(song).filter((item: AlbumTrackSnapshot) => item.id > 0);
    if (kind === "artists") result.artists = rows.filter((item: any) => Number(item.id) > 0).map((item: any) => ({ id: Number(item.id), name: String(item.name || ""), cover: item.picUrl || item.img1v1Url || "" }));
    if (kind === "albums") result.albums = rows.map(album).filter((item: AlbumSummary) => item.albumId > 0);
    if (kind === "playlists") result.playlists = rows.map(playlist).filter((item: CloudPlaylist) => item.id > 0);
    const count = raw[{ songs: "songCount", artists: "artistCount", albums: "albumCount", playlists: "playlistCount" }[kind]];
    result.more = rows.length > 0 && offset + rows.length < Number(count || 0);
    return result;
  }
  async artistAlbums(id: number, cookie: string, offset = 0, filters: ArtistAlbumFilters = {}, isCurrent: () => boolean = () => true): Promise<ArtistAlbumPage> {
    // Snapshot the switches: settings may change while a request is in flight.
    const options = normalizeArtistAlbumFilters(filters);
    const keywords = artistAlbumKeywords(options.artistAlbumKeywords);
    const filterKey = artistAlbumFilterKey(filters);
    const albums: AlbumSummary[] = [];
    let more = true;
    while (more && albums.length < 30) {
      if (!isCurrent()) throw new Error("Artist album request cancelled");
      // Request only the remaining slots so that no matching albums are skipped.
      const body = await this.call(`/api/artist/albums/${id}`, { limit: 30 - albums.length, offset, total: true }, cookie);
      const rows: any[] = body.hotAlbums || [];
      offset += rows.length;
      more = body.more === true && rows.length > 0;
      for (const row of rows) {
        const item = album(row);
        if (options.artistAlbumHideSingles && row.size != null && Number.isFinite(Number(row.size)) && Number(row.size) >= 0 && item.trackCount <= options.artistAlbumTrackLimit
          || options.artistAlbumHideRemixes && keywords.some(word => item.name.toLowerCase().includes(word))) continue;
        albums.push(item);
      }
    }
    return { albums, more, nextOffset: offset, filterKey };
  }
  async artistDetail(artist: CloudArtist, cookie: string, filters: ArtistAlbumFilters = {}, isCurrent?: () => boolean): Promise<ArtistContent> {
    const [top, albums] = await Promise.all([
      this.call("/api/artist/top/song", { id: artist.id }, cookie), this.artistAlbums(artist.id, cookie, 0, filters, isCurrent),
    ]);
    return { artist, tracks: (top.songs || []).map(song).filter((item: AlbumTrackSnapshot) => item.id > 0), ...albums };
  }
  async songs(ids: number[], cookie: string): Promise<AlbumTrackSnapshot[]> {
    const result: AlbumTrackSnapshot[] = [];
    for (let start = 0; start < ids.length; start += 200) {
      const batch = ids.slice(start, start + 200);
      const body = await this.call("/api/v3/song/detail", { c: JSON.stringify(batch.map(id => ({ id }))) }, cookie);
      const found = new Map<number, AlbumTrackSnapshot>((body.songs || []).map((item: any) => [Number(item.id), song(item)]));
      for (const id of batch) if (found.has(id)) result.push(found.get(id)!);
    }
    return result;
  }
  async detail(item: CloudPlaylist, cookie: string): Promise<AlbumMeta> {
    const body = await this.call("/api/v6/playlist/detail", { id: item.id, n: 100000, s: 0 }, cookie);
    const ids: number[] = (body.playlist?.trackIds || []).map((entry: any) => Number(entry.id)).filter((id: number) => id > 0);
    const tracks = await this.songs(ids, cookie);
    return { albumId: 0, playlistId: item.id, name: body.playlist?.name || item.name, artist: item.creator, cover: body.playlist?.coverImgUrl || item.cover, trackCount: tracks.length, tracks };
  }
  async playlistStats(id: number, cookie: string): Promise<{ count: number; duration?: number }> {
    const body = await this.call("/api/v6/playlist/detail", { id, n: 100000, s: 0 }, cookie);
    const ids: number[] = (body.playlist?.trackIds || []).map((entry: any) => Number(entry.id)).filter((id: number) => id > 0);
    const count = Math.max(Number(body.playlist?.trackCount || 0), ids.length);
    const tracks = await this.songs(ids, cookie);
    return { count, duration: count === ids.length && tracks.length === ids.length && tracks.every(track => Number.isFinite(track.duration) && track.duration >= 0)
      ? tracks.reduce((sum, track) => sum + track.duration, 0) : undefined };
  }
  async liked(uid: number, cookie: string): Promise<AlbumMeta> {
    const lists = await this.userPlaylists(uid, cookie);
    const liked = lists.find(item => item.special === 5 && item.owner === uid);
    if (liked) return this.detail(liked, cookie);
    const body = await this.call("/api/song/like/get", { uid }, cookie);
    const tracks = await this.songs((body.ids || []).map(Number).filter((id: number) => id > 0), cookie);
    return { albumId: 0, playlistId: -uid, name: t("library.likes"), artist: "", cover: tracks[0]?.cover || "", trackCount: tracks.length, tracks };
  }
}
