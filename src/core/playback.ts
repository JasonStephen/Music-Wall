// 播放服务：通过 orpheus:// 协议唤起网易云客户端。
// 协议格式（2026 验证）：orpheus://<Base64(JSON)>，JSON 如 {"type":"song","id":123,"cmd":"play"}。
// 整张专辑连播走「歌单通道」：先经 Cookie 把专辑曲目写入指定歌单，再下发 type=playlist。
// 桌面端信任 shell.openExternal（协议无处理器会抛错），不用焦点猜测，
// 因此装有客户端时绝不会连带唤醒浏览器；仅在 scheme 全部失败后才降级 H5。

import { Notice } from "obsidian";
import type { AlbumMeta } from "../types";
import type { Requester } from "./metadata";
import { replacePlaylistWithAlbumTracks, hasLoginCookie, ensureTempPlaylist } from "./playlist";

export interface PlaybackDeps {
  isDesktop: boolean;
  request: Requester;
  cookie?: string;
  /** 用作整专连播播放列表的歌单 ID */
  playlistId?: number;
  /** 自动创建中转歌单成功后回传 ID，宿主应持久化到设置 */
  onPlaylistResolved?: (id: number) => void;
}

function toBase64(json: string): string {
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** type=song / type=playlist 的协议 URL（id 为数字） */
export function orpheusSongUrl(songId: number): string {
  return `orpheus://${toBase64(JSON.stringify({ type: "song", id: songId, cmd: "play" }))}`;
}
export function orpheusPlaylistUrl(playlistId: number): string {
  return `orpheus://${toBase64(JSON.stringify({ type: "playlist", id: playlistId, cmd: "play" }))}`;
}

export function h5FallbackUrl(meta: AlbumMeta): string {
  return `https://music.163.com/album?id=${meta.albumId}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 打开外部链接/协议；返回是否成功接管（异常视为失败） */
async function openScheme(url: string, deps: PlaybackDeps): Promise<boolean> {
  if (deps.isDesktop) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { shell } = require("electron");
      if (shell?.openExternal) {
        await shell.openExternal(url);
        return true; // 无协议处理器时上面会抛错
      }
    } catch {
      return false;
    }
  }
  try {
    window.open(url);
  } catch {
    return false;
  }
  // 移动端（或拿不到 electron 的桌面环境）用焦点检测兜底
  await delay(900);
  return !document.hasFocus();
}

async function openWeb(url: string, deps: PlaybackDeps): Promise<void> {
  if (deps.isDesktop) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { shell } = require("electron");
      if (shell?.openExternal) {
        await shell.openExternal(url);
        return;
      }
    } catch {
      /* fallthrough */
    }
  }
  window.open(url);
}

/**
 * 播放整张专辑。
 * 有 cookie+playlistId → 专辑曲目写入歌单 → type=playlist 连播；
 * 配置不全 → type=song 播第一首（明确提示缺什么）；
 * 仅当 scheme 打开失败才降级 H5，装有客户端时不会连带打开网页。
 */
export async function playAlbum(meta: AlbumMeta, deps: PlaybackDeps): Promise<void> {
  if (!meta.tracks?.length) {
    new Notice("该专辑缺少曲目快照，将打开网页版");
    await openWeb(h5FallbackUrl(meta), deps);
    return;
  }

  const cookieOk = hasLoginCookie(deps.cookie);
  let playlistId = deps.playlistId;

  // 有登录态但未配置歌单 → 自动创建/复用私密中转歌单，不打扰用户已有歌单
  if (!playlistId && cookieOk && deps.cookie) {
    new Notice("未配置播放歌单，正在创建私密中转歌单…");
    try {
      playlistId = await ensureTempPlaylist(deps.request, deps.cookie);
      deps.onPlaylistResolved?.(playlistId);
    } catch (e: any) {
      new Notice(
        "自动创建中转歌单失败：" +
          (e?.message ?? e) +
          "（若为风控拦截，请在设置中手动指定一个歌单）"
      );
    }
  }

  const playlistMode = cookieOk && !!playlistId;

  if (playlistMode) {
    try {
      new Notice("正在把专辑写入播放歌单…");
      const ids = meta.tracks.map((t) => t.id);
      await replacePlaylistWithAlbumTracks(
        deps.request,
        playlistId!,
        ids,
        deps.cookie!
      );
      if (await openScheme(orpheusPlaylistUrl(playlistId!), deps)) {
        new Notice(`《${meta.name}》${ids.length} 首已替换进播放歌单并开始播放`);
        return;
      }
      new Notice("歌单播放指令未被客户端接收，改用单曲播放");
    } catch (e: any) {
      new Notice(
        "歌单模式失败：" +
          (e?.message ?? e) +
          "（请重新配置 Cookie 或重选播放歌单）；本次改用单曲播放"
      );
    }
  } else {
    const missing: string[] = [];
    if (!deps.cookie) missing.push("网易云 Cookie");
    else if (!cookieOk)
      missing.push("有效登录 Cookie（当前 Cookie 缺少 MUSIC_U，未登录）");
    if (!playlistId) missing.push("播放歌单 ID");
    new Notice(
      `整张专辑连播未启用：缺少「${missing.join("」「")}」。本次仅播放第一首`
    );
  }

  // 单曲通道：只播第一首（不追加、不打开网页）
  if (await openScheme(orpheusSongUrl(meta.tracks[0].id), deps)) return;

  // 最后手段：scheme 完全打不开（未安装客户端）才走 H5
  new Notice("未检测到网易云客户端，改用系统方式打开专辑链接");
  await openWeb(h5FallbackUrl(meta), deps);
}
