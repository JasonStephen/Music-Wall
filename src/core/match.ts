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
 * 用 SMTC 的曲名/歌手在所有墙的条目的曲目快照里找命中项。
 * 曲名完全一致 100 分，互相包含 60 分；歌手一致再加 20/10 分。
 * 低于 60 分视为匹配失败（只显示、不定位）。
 */
export function matchNowPlaying(
  state: NowPlayingState,
  items: WallItem[]
): NowPlayingMatch | null {
  if (!state.active) return null;
  const title = normalizeText(state.title);
  if (!title) return null;
  const artist = normalizeText(state.artist);

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
