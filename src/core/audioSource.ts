// Enhanced song_url / song_url_v1 的曲目音源流程，复用现有 weapi 请求层。
// https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/module/song_url_v1.js
import { weapiPost, type Requester } from "./metadata";
import { LoginRequiredError } from "./playlist";
import { t } from "../i18n";

export class TrackUnavailableError extends Error {}
export interface SongSource { url: string; trial: boolean; }

export async function fetchSongSource(request: Requester, id: number, cookie: string): Promise<SongSource> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new TrackUnavailableError(t("internal.unavailable"));
  // 标准 MP3 可在桌面及移动端解码。旧接口作为同账号权限下的兼容回退。
  for (const path of ["/api/song/enhance/player/url/v1", "/api/song/enhance/player/url"]) {
    const body = await weapiPost(request, path, {
      ids: JSON.stringify([id]), level: "standard", encodeType: "mp3", br: 128000,
    }, cookie);
    if (body?.code === 301 || body?.code === 401) throw new LoginRequiredError(t("playlistErr.cookieInvalid"));
    if (body?.code !== 200) throw new Error(t("internal.networkError"));
    const track = body.data?.find((item: any) => Number(item.id) === id);
    if (!track?.url) continue;
    let url: URL;
    try { url = new URL(track.url); } catch { throw new Error(t("internal.networkError")); }
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") throw new Error(t("internal.networkError"));
    return { url: url.href, trial: !!track.freeTrialInfo && track.freeTrialInfo !== "null" };
  }
  throw new TrackUnavailableError(t("internal.unavailable"));
}
