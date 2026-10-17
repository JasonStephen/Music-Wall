// SMTC 正在播放 → 墙上专辑的匹配。
// 网易云 SMTC 不发布专辑名，只有 曲名/歌手，因此按「专辑曲目快照」反查所属专辑。

import type { WallItem } from "../types";
import type { NowPlayingState } from "./nowPlaying";

export interface NowPlayingMatch {
  albumId: number;
  /** 命中的曲目在 meta.tracks 中的下标 */
  trackIndex: number;
  score: number;
}

const PUNCT = /[\s\u3000·・.,，。、!！?？'"“”‘’()（）[\]【】<>《》\-_/\\|~～:：;；&＆+＋]/g;

/** 归一化：NFKC + 小写 + 去空白与常见标点，用于容错比对 */
export function normalizeText(input: string | undefined | null): string {
  let s = typeof input === "string" ? input : "";
  if (!s) return "";
  try {
    s = s.normalize("NFKC");
  } catch {
    /* 老引擎缺 normalize：保持原样 */
  }
  return s.toLowerCase().replace(PUNCT, "");
}

/**
 * 用 SMTC 的曲名/歌手在所有墙的条目里找命中项。
 * **专辑为主（第七轮）**：部分播放器（非网易云）的 SMTC 会发布专辑名，
 * `state.album` 非空时先做专辑级匹配——专辑名归一化后完全一致 100 分、
 * 互相包含 60 分，命中后在**该专辑内**再尽力配一次曲目快照（拿 trackIndex，
 * 配不上则 -1 只亮专辑不亮单曲）；没有专辑级候选时才回退全库曲目快照匹配。
 * 曲名完全一致 100 分，互相包含 60 分；歌手一致再加 20/10 分。
 * 低于 60 分视为匹配失败（只显示、不定位）。
 */
export function matchNowPlaying(
  state: NowPlayingState,
  items: WallItem[]
): NowPlayingMatch | null {
  if (!state.active) return null;
  if (state.source === "internal" && state.albumId !== undefined) {
    const item = items.find((item) => item.albumId === state.albumId);
    if (!item) return null;
    return { albumId: item.albumId, trackIndex: item.meta.tracks?.findIndex((track) => track.id === state.songId) ?? -1, score: 200 };
  }
  const title = normalizeText(state.title);
  const artist = normalizeText(state.artist);

  // ---- 专辑级：SMTC 发布了专辑名时优先按专辑匹配 ----
  const albumName = normalizeText(state.album);
  if (albumName) {
    let bestAlbumScore = 0;
    let bestAlbumItem: WallItem | null = null;
    for (const item of items) {
      const name = normalizeText(item.meta.name);
      if (!name) continue;
      let score = 0;
      if (name === albumName) score = 100;
      else if (name.includes(albumName) || albumName.includes(name)) score = 60;
      else continue;
      // 专辑级：与专辑主艺人对一下（SMTC 的歌手可能带 feat，做包含判定）
      if (artist) {
        const albumArtist = normalizeText(item.meta.artist);
        if (albumArtist === artist) score += 20;
        else if (albumArtist.includes(artist) || artist.includes(albumArtist)) score += 10;
      }
      if (score > bestAlbumScore) {
        bestAlbumScore = score;
        bestAlbumItem = item;
      }
    }
    if (bestAlbumItem && bestAlbumScore >= 60) {
      return {
        albumId: bestAlbumItem.albumId,
        trackIndex: bestTrackIndex(bestAlbumItem, title, artist),
        score: bestAlbumScore,
      };
    }
  }

  // ---- 曲目级：快照反查（网易云 SMTC 不发布专辑名的主路径） ----
  if (!title) return null;

  let best: NowPlayingMatch | null = null;
  for (const item of items) {
    const tracks = item.meta.tracks ?? [];
    for (let i = 0; i < tracks.length; i++) {
      const name = normalizeText(tracks[i].name);
      if (!name) continue;
      let score = 0;
      if (name === title) score = 100;
      else if (name.includes(title) || title.includes(name)) score = 60;
      else continue;
      if (artist) {
        const trackArtist = normalizeText(tracks[i].artists || item.meta.artist);
        if (trackArtist === artist) score += 20;
        else if (trackArtist.includes(artist) || artist.includes(trackArtist)) score += 10;
      }
      if (!best || score > best.score) {
        best = { albumId: item.albumId, trackIndex: i, score };
      }
    }
  }
  return best && best.score >= 60 ? best : null;
}

/** 已定专辑时，在其中尽力找曲名命中的下标；找不到返回 -1（只亮专辑） */
function bestTrackIndex(
  item: WallItem,
  title: string,
  artist: string
): number {
  const tracks = item.meta.tracks ?? [];
  let bestIdx = -1;
  let bestScore = 0;
  for (let i = 0; i < tracks.length; i++) {
    const name = normalizeText(tracks[i].name);
    if (!name) continue;
    let score = 0;
    if (name === title) score = 100;
    else if (name.includes(title) || title.includes(name)) score = 60;
    else continue;
    if (artist) {
      const trackArtist = normalizeText(tracks[i].artists || item.meta.artist);
      if (trackArtist === artist) score += 20;
      else if (trackArtist.includes(artist) || artist.includes(trackArtist)) score += 10;
    }
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }
  return bestScore >= 60 ? bestIdx : -1;
}
