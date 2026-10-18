import type { AlbumMeta, AlbumTrackSnapshot } from "../types";
import { weapiPost, type Requester } from "./metadata";
import { LoginRequiredError } from "./playlist";
import { t } from "../i18n";

export interface CloudPlaylist { id: number; name: string; cover: string; creator: string; owner: number; count: number; special: number; }
const playlist = (item: any): CloudPlaylist => ({ id: Number(item.id), name: String(item.name || ""), cover: item.coverImgUrl || item.picUrl || "", creator: item.creator?.nickname || "", owner: Number(item.creator?.userId || item.userId), count: Number(item.trackCount || 0), special: Number(item.specialType || 0) });
const song = (item: any): AlbumTrackSnapshot => ({ id: Number(item.id), name: item.name || "", duration: Number(item.dt || 0), artists: (item.ar || []).map((artist: any) => artist.name).join(" / "), albumId: item.al?.id, albumName: item.al?.name, cover: item.al?.picUrl });

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
    const body = await this.call("/api/cloudsearch/pc", { s: keyword, type: 1000, limit: 30, offset, total: true }, cookie);
    const items = (body.result?.playlists || []).map(playlist);
    return { items, more: offset + items.length < Number(body.result?.playlistCount || 0) };
  }
  private async songs(ids: number[], cookie: string): Promise<AlbumTrackSnapshot[]> {
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
  async liked(uid: number, cookie: string): Promise<AlbumMeta> {
    const lists = await this.userPlaylists(uid, cookie);
    const liked = lists.find(item => item.special === 5 && item.owner === uid);
    if (liked) return this.detail(liked, cookie);
    const body = await this.call("/api/song/like/get", { uid }, cookie);
    const tracks = await this.songs((body.ids || []).map(Number).filter((id: number) => id > 0), cookie);
    return { albumId: 0, playlistId: -uid, name: t("library.likes"), artist: "", cover: tracks[0]?.cover || "", trackCount: tracks.length, tracks };
  }
}
