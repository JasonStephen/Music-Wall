// 播放服务：通过 orpheus:// 协议唤起网易云客户端。
// 协议格式（2026 验证）：orpheus://<Base64(JSON)>，JSON 如 {"type":"song","id":123,"cmd":"play"}。
// 整张专辑连播走「歌单通道」：先经 Cookie 把专辑曲目写入指定歌单，再下发 type=playlist。
// 桌面端信任 shell.openExternal（协议无处理器会抛错），不用焦点猜测，
// 因此装有客户端时绝不会连带唤醒浏览器；仅在 scheme 全部失败后才降级 H5。

import { Notice } from "obsidian";
import type { AlbumMeta } from "../types";
import type { Requester } from "./metadata";
import { replacePlaylistWithAlbumTracks, hasLoginCookie, ensureTempPlaylist } from "./playlist";
import { t } from "../i18n";

export interface PlaybackDeps {
  isDesktop: boolean;
  request: Requester;
  cookie?: string;
  /** 用作整专连播播放列表的歌单 ID */
  playlistId?: number;
  /** 自动创建中转歌单成功后回传 ID，宿主应持久化到设置 */
  onPlaylistResolved?: (id: number) => void;
  /** 登录后重新获取依赖，避免已打开面板继续使用旧账号的 Cookie。 */
  authorize?: () => Promise<PlaybackDeps | null>;
  isCurrent?: () => boolean;
  playInside?: (meta: AlbumMeta, startIndex: number) => Promise<boolean>;
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
export async function playAlbum(meta: AlbumMeta, deps: PlaybackDeps, startIndex = 0): Promise<void> {
  if (deps.authorize) {
    const authorized = await deps.authorize();
    if (!authorized) return;
    deps = authorized;
  }
  if (deps.isCurrent && !deps.isCurrent()) return;
  if (deps.playInside) {
    await deps.playInside(meta, startIndex);
    return;
  }
  if (!meta.tracks?.length) {
    new Notice(t("playback.noTracks"));
    await openWeb(h5FallbackUrl(meta), deps);
    return;
  }

  const cookieOk = hasLoginCookie(deps.cookie);
  let playlistId = deps.playlistId;

  // 有登录态但未配置歌单 → 自动创建/复用私密中转歌单，不打扰用户已有歌单
  if (!playlistId && cookieOk && deps.cookie) {
    new Notice(t("playback.creatingPlaylist"));
    try {
      playlistId = await ensureTempPlaylist(deps.request, deps.cookie);
      if (deps.isCurrent && !deps.isCurrent()) return;
      deps.onPlaylistResolved?.(playlistId);
    } catch (e: any) {
      new Notice(
        t("playback.createPlaylistFail", { error: e?.message ?? e })
      );
    }
  }

  const playlistMode = cookieOk && !!playlistId;
  if (deps.isCurrent && !deps.isCurrent()) return;

  if (playlistMode) {
    try {
      new Notice(t("playback.writingPlaylist"));
      const ids = meta.tracks.map((t) => t.id);
      await replacePlaylistWithAlbumTracks(
        deps.request,
        playlistId!,
        ids,
        deps.cookie!
      );
      if (deps.isCurrent && !deps.isCurrent()) return;
      if (await openScheme(orpheusPlaylistUrl(playlistId!), deps)) {
        new Notice(
          t("playback.playlistWritten", { name: meta.name, count: ids.length })
        );
        return;
      }
      new Notice(t("playback.schemeFallback"));
    } catch (e: any) {
      new Notice(
        t("playback.playlistModeFail", { error: e?.message ?? e })
      );
    }
  } else {
    const missing: string[] = [];
    if (!deps.cookie) missing.push(t("playback.missingCookie"));
    else if (!cookieOk) missing.push(t("playback.missingValidCookie"));
    if (!playlistId) missing.push(t("playback.missingPlaylist"));
    new Notice(
      t("playback.continuousOff", {
        missing: missing.join(t("playback.listSep")),
      })
    );
  }

  // 单曲通道：只播第一首（不追加、不打开网页）
  if (deps.isCurrent && !deps.isCurrent()) return;
  if (await openScheme(orpheusSongUrl(meta.tracks[0].id), deps)) return;

  // 最后手段：scheme 完全打不开（未安装客户端）才走 H5
  if (deps.isCurrent && !deps.isCurrent()) return;
  new Notice(t("playback.noClient"));
  await openWeb(h5FallbackUrl(meta), deps);
}
