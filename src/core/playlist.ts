// 歌单操作（需登录 Cookie）：用于「整张专辑作为播放列表连播」。
// 接口格式对齐 2026 年验证可用的 ncm-cli（weapi）实现。

import { weapiPost, type Requester } from "./metadata";

export interface UserPlaylistBrief {
  id: number;
  name: string;
  trackCount: number;
}

/** 粗检 Cookie 是否包含登录凭证 MUSIC_U（缺失则歌单操作必失败） */
export function hasLoginCookie(cookie?: string): boolean {
  return !!cookie && /MUSIC_U=/.test(cookie);
}

/** 验证 Cookie：返回账号 uid 与昵称 */
export async function verifyCookie(
  request: Requester,
  cookie: string
): Promise<{ uid: number; nickname: string }> {
  if (!hasLoginCookie(cookie)) {
    throw new Error(
      "Cookie 中未包含 MUSIC_U（登录凭证），请确认已在网页登录后复制完整 Cookie"
    );
  }
  const r = await weapiPost(request, "/api/w/nuser/account/get", {}, cookie);
  const uid = r?.account?.id ?? r?.profile?.userId;
  if (!uid) throw new Error("Cookie 无效或已过期，请在网易云网页端重新登录并更新");
  return { uid, nickname: r?.account?.nickname ?? r?.profile?.nickname ?? "" };
}

/** 当前账号的歌单列表 */
export async function listUserPlaylists(
  request: Requester,
  cookie: string
): Promise<UserPlaylistBrief[]> {
  const { uid } = await verifyCookie(request, cookie);
  const r = await weapiPost(
    request,
    "/api/user/playlist",
    { uid, limit: 1000, offset: 0, includeVideo: true },
    cookie
  );
  const list: any[] = r?.playlist ?? [];
  return list.map((p) => ({
    id: p.id,
    name: p.name ?? "",
    trackCount: p.trackCount ?? (p.trackIds?.length ?? 0),
  }));
}

/** 歌单内全部曲目 id */
export async function getPlaylistTrackIds(
  request: Requester,
  playlistId: number,
  cookie: string
): Promise<number[]> {
  const r = await weapiPost(
    request,
    "/api/v6/playlist/detail",
    { id: playlistId, n: 0, s: 8 },
    cookie
  );
  const ids = (r?.playlist?.trackIds ?? [])
    .map((t: any) => t?.id)
    .filter((x: unknown): x is number => typeof x === "number");
  return ids;
}

/** 增删歌单曲目（分块 50；add 兼容双重包裹风控格式，失败自动重试） */
export async function manipulateTracks(
  request: Requester,
  op: "add" | "del",
  playlistId: number,
  songIds: number[],
  cookie: string
): Promise<void> {
  for (let i = 0; i < songIds.length; i += 50) {
    const chunk = songIds.slice(i, i + 50);
    let r = await weapiPost(
      request,
      "/api/playlist/manipulate/tracks",
      {
        op,
        pid: playlistId,
        trackIds: JSON.stringify(chunk),
        imme: true,
      },
      cookie
    );
    if (op === "add" && r?.code !== 200) {
      // 老版本客户端风控：trackIds 需双重 JSON 包裹
      r = await weapiPost(
        request,
        "/api/playlist/manipulate/tracks",
        {
          op: "add",
          pid: playlistId,
          trackIds: JSON.stringify([JSON.stringify(chunk)]),
          imme: "true",
        },
        cookie
      );
    }
    if (r?.code !== 200) {
      throw new Error(`歌单${op === "add" ? "加歌" : "删歌"}失败（code=${r?.code}）`);
    }
  }
}

/** 用专辑曲目替换歌单内容（删除步骤尽力而为，添加失败才报错） */
export async function replacePlaylistWithAlbumTracks(
  request: Requester,
  playlistId: number,
  albumTrackIds: number[],
  cookie: string
): Promise<void> {
  let current: number[] = [];
  try {
    current = await getPlaylistTrackIds(request, playlistId, cookie);
  } catch {
    current = [];
  }
  const curSet = new Set(current);
  const wantSet = new Set(albumTrackIds);
  const toDel = current.filter((id) => !wantSet.has(id));
  if (toDel.length) {
    try {
      await manipulateTracks(request, "del", playlistId, toDel, cookie);
    } catch {
      // 删旧失败不阻塞：继续写入新专辑
    }
  }
  // 网易云将新加入的曲目插到歌单头部（实测正序提交结果整体倒序），倒序提交使最终顺序与专辑一致
  const toAdd = albumTrackIds.filter((id) => !curSet.has(id)).reverse();
  if (toAdd.length) await manipulateTracks(request, "add", playlistId, toAdd, cookie);
}

/** 中转歌单的固定名称：已存在则复用，避免每次播放都新建堆积 */
export const TEMP_PLAYLIST_NAME = "Music Wall 临时播放";

/** 确保存在仅自己可见的中转歌单；返回其 ID（创建接口可能受 checkToken 风控，失败抛错） */
export async function ensureTempPlaylist(
  request: Requester,
  cookie: string,
  name = TEMP_PLAYLIST_NAME
): Promise<number> {
  const existing = (await listUserPlaylists(request, cookie)).find(
    (p) => p.name === name
  );
  if (existing) return existing.id;
  const r = await weapiPost(request, "/api/playlist/create", { name, privacy: 10 }, cookie);
  const id = r?.id ?? r?.playlist?.id;
  if (!id) {
    throw new Error(`创建中转歌单失败（code=${r?.code}${r?.message ? "：" + r.message : ""}）`);
  }
  return Number(id);
}
