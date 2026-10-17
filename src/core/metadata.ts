// 网易云元数据层。全部接口为 POST，依赖 core/crypto 加密。
// 网络请求通过可注入的 Requester 发出：插件里接 Obsidian requestUrl，测试里接全局 fetch。

import { encryptLinux, encryptWeApi } from "./crypto";
import type { AlbumMeta, AlbumSummary, AlbumTrackSnapshot } from "../types";
import { t } from "../i18n";

export interface HttpRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

export interface HttpResponse {
  status: number;
  text: string;
  /** 登录接口通过 Set-Cookie 返回凭据；兼容现有不读取响应头的调用方。 */
  headers?: Record<string, string | string[]>;
}

/** 由宿主注入的网络实现 */
export type Requester = (req: HttpRequest) => Promise<HttpResponse>;

const REFERER = "https://music.163.com/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const LINUX_FORWARD_API = "https://music.163.com/api/linux/forward";
const CLOUD_SEARCH_TARGET = "https://music.163.com/api/cloudsearch/pc";
const ALBUM_API = "https://music.163.com/weapi/v1/album/%s";

/** 大陆 IP 前缀，模仿 music-lib WithRandomIPHeader */
const IP_PREFIXES = [
  "36.4.8",
  "36.4.16",
  "36.4.0",
  "36.4.2",
  "36.4.32",
  "36.4.64",
  "36.4.68",
  "36.4.66",
];

function randomIp(): string {
  const p = IP_PREFIXES[Math.floor(Math.random() * IP_PREFIXES.length)];
  const last = Math.floor(Math.random() * 255);
  return `${p}.${last}`;
}

function baseHeaders(cookie?: string): Record<string, string> {
  const ip = randomIp();
  const h: Record<string, string> = {
    Referer: REFERER,
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": UA,
    "X-Forwarded-For": ip,
    "X-Real-IP": ip,
  };
  if (cookie) h.Cookie = cookie;
  return h;
}

function encodeForm(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
}

function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(t("metaErr.notJson"));
  }
}

function yearFrom(publishTime?: number): string | undefined {
  if (!publishTime) return undefined;
  try {
    return String(new Date(publishTime).getFullYear());
  } catch {
    return undefined;
  }
}

function joinArtists(songsArtists: unknown, fallback: string): string {
  if (Array.isArray(songsArtists)) {
    const names = songsArtists
      .map((a: any) => (typeof a === "string" ? a : a?.name))
      .filter(Boolean);
    if (names.length) return names.join("、");
  }
  return fallback;
}

/**
 * 专辑搜索：linux/forward 代理 cloudsearch/pc，type=10。
 * music-lib 写死 offset=0/limit=10，这里补齐 offset 翻页。
 */
export async function searchAlbums(
  request: Requester,
  keyword: string,
  offset = 0,
  limit = 20,
  cookie?: string
): Promise<AlbumSummary[]> {
  const eparamsPayload = JSON.stringify({
    method: "POST",
    url: CLOUD_SEARCH_TARGET,
    params: { s: keyword, type: 10, offset, limit },
  });
  const req: HttpRequest = {
    url: LINUX_FORWARD_API,
    method: "POST",
    headers: baseHeaders(cookie),
    body: encodeForm({ eparams: encryptLinux(eparamsPayload) }),
  };
  const res = await request(req);
  const data = parseJson(res.text);
  if (data.code !== 200) {
    throw new Error(t("metaErr.searchFail", { code: data.code }));
  }
  const albums: any[] = data?.result?.albums ?? [];
  return albums.map((a) => ({
    albumId: a.id,
    name: a.name ?? "",
    artist: joinArtists(a.artists, a?.artist?.name ?? ""),
    cover: a.picUrl ?? a.blurPicUrl ?? "",
    trackCount: a.size ?? 0,
    publishTime: a.publishTime,
    year: yearFrom(a.publishTime),
    size: a.size,
    company: a.company,
    briefDesc: a.briefDesc,
  }));
}

/** 专辑详情：weapi/v1/album/{id}，返回元数据 + 曲目快照 */
export async function fetchAlbumDetail(
  request: Requester,
  albumId: number,
  cookie?: string
): Promise<AlbumMeta> {
  const data = await weapiPost(request, `/api/v1/album/${albumId}`, {}, cookie);
  if (data.code !== 200 || !data.album) {
    throw new Error(t("metaErr.detailFail", { code: data.code }));
  }
  const album = data.album;
  const songs: any[] = data.songs ?? album.songs ?? [];
  const tracks: AlbumTrackSnapshot[] = songs.map((s) => ({
    id: s.id,
    name: s.name ?? "",
    duration: s.dt ?? 0,
    artists: joinArtists(s.ar, ""),
  }));
  return {
    albumId: album.id,
    name: album.name ?? "",
    artist: joinArtists(album.artists, album?.artist?.name ?? ""),
    cover: album.picUrl ?? "",
    publishTime: album.publishTime,
    year: yearFrom(album.publishTime),
    trackCount: album.size ?? tracks.length,
    company: album.company,
    description: album.description || album.briefDesc || "",
    tags: Array.isArray(album.tags)
      ? album.tags.map((t: any) => (typeof t === "string" ? t : t?.name)).filter(Boolean)
      : undefined,
    tracks,
  };
}

/** 从分享链接或裸 ID 解析专辑 id */
export function parseAlbumInput(input: string): number | null {
  const trimmed = input.trim();
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  const m = trimmed.match(/album\??.*id=(\d+)/) || trimmed.match(/album\/(\d+)/);
  if (m) return parseInt(m[1], 10);
  return null;
}

/** 给网易云图片 URL 附加尺寸参数（封面懒加载用小图） */
export function sizedCover(url: string, size = 400): string {
  if (!url) return "";
  // data-URI（内置默认封面）不是远端图，不能也不需要追加 param 参数
  if (url.startsWith("data:")) return url;
  if (url.includes("param=")) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}param=${size}y${size}`;
}

/**
 * 通用 weapi POST：自动合并 csrf_token、加密并解析 JSON。
 * path 形如 "/api/user/playlist"（自动转 /weapi/...）。
 */
export async function weapiPost(
  request: Requester,
  path: string,
  data: Record<string, unknown>,
  cookie?: string
): Promise<any> {
  const url = `https://music.163.com/weapi${path.replace(/^\/api/, "")}`;
  const csrf = /(?:^|;\s*)__csrf=([^;]*)/.exec(cookie ?? "")?.[1] ?? "";
  const payload = { csrf_token: csrf, ...data };
  const { params, encSecKey } = encryptWeApi(JSON.stringify(payload));
  const res = await request({
    url,
    method: "POST",
    headers: baseHeaders(cookie),
    body: encodeForm({ params, encSecKey }),
  });
  return parseJson(res.text);
}
