// Enhanced song_url / song_url_v1 的曲目音源流程，复用现有 weapi 请求层。
// https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/blob/main/module/song_url_v1.js
import { weapiPost, type Requester } from "./metadata";
import { LoginRequiredError } from "./playlist";
import { t } from "../i18n";
import { AUDIO_QUALITIES, atMost, isAudioQuality, type AudioQuality } from "./quality";

export class TrackUnavailableError extends Error {}
export interface SongSource {
  url: string;
  trial: boolean;
  quality?: AudioQuality;
  availableQualities?: AudioQuality[];
  mime?: string;
}

async function requestSource(request: Requester, id: number, cookie: string, quality: AudioQuality): Promise<SongSource | null> {
  const body = await weapiPost(request, "/api/song/enhance/player/url/v1", {
    ids: JSON.stringify([id]), level: quality, encodeType: ["lossless", "hires"].includes(quality) ? "flac" : "mp3",
  }, cookie);
  return parseSource(body, id);
}

function parseSource(body: any, id: number): SongSource | null {
  if (body?.code === 301 || body?.code === 401) throw new LoginRequiredError(t("playlistErr.cookieInvalid"));
  if (body?.code !== 200) throw new Error(t("internal.networkError"));
  const track = body.data?.find((item: any) => Number(item.id) === id);
  if (!track?.url) return null;
  let url: URL;
  try { url = new URL(track.url); } catch { throw new Error(t("internal.networkError")); }
  if (url.protocol === "http:") url.protocol = "https:";
  if (url.protocol !== "https:") throw new Error(t("internal.networkError"));
  // level 是服务端实际返回档位；绝不能用请求档位标记降级后的音源。
  const quality = isAudioQuality(track.level) ? track.level : track.type === "mp3" || !track.type
    ? Number(track.br) >= 300000 ? "exhigh" : Number(track.br) >= 180000 ? "higher" : "standard"
    : undefined;
  return { url: url.href, trial: !!track.freeTrialInfo && track.freeTrialInfo !== "null", quality,
    mime: track.type === "flac" ? "audio/flac" : track.type === "aac" ? "audio/aac" : "audio/mpeg" };
}

/** 只探测音源链接，不下载五份音频。菜单按账号实际返回的音质去重。 */
async function discoverSources(request: Requester, id: number, cookie: string): Promise<SongSource[]> {
  if (!Number.isSafeInteger(id) || id <= 0) throw new TrackUnavailableError(t("internal.unavailable"));
  const results = await Promise.allSettled(AUDIO_QUALITIES.map((quality) => requestSource(request, id, cookie, quality)));
  const sources = new Map<AudioQuality, SongSource>();
  for (const result of results) {
    if (result.status === "rejected") {
      if (result.reason instanceof LoginRequiredError) throw result.reason;
      continue;
    }
    const source = result.value;
    if (source?.quality && (!sources.has(source.quality) || !source.trial)) sources.set(source.quality, source);
  }
  if (sources.size) return [...sources.values()];
  const legacy = parseSource(await weapiPost(request, "/api/song/enhance/player/url", {
    ids: JSON.stringify([id]), br: 128000,
  }, cookie), id);
  if (legacy?.quality) return [legacy];
  if (results.some((result) => result.status === "rejected")) throw new Error(t("internal.networkError"));
  throw new TrackUnavailableError(t("internal.unavailable"));
}

function chooseSource(sources: SongSource[], preferred: AudioQuality): SongSource {
  const available = sources.filter((source) => source.quality && atMost(source.quality, preferred));
  if (!available.length) throw new TrackUnavailableError(t("internal.unavailable"));
  available.sort((a, b) => Number(a.trial) - Number(b.trial) || AUDIO_QUALITIES.indexOf(b.quality!) - AUDIO_QUALITIES.indexOf(a.quality!));
  return { ...available[0], availableQualities: AUDIO_QUALITIES.filter((quality) => sources.some((source) => source.quality === quality && source.trial === available[0].trial)) };
}

export async function fetchSongSource(request: Requester, id: number, cookie: string, preferred: AudioQuality = "standard"): Promise<SongSource> {
  return chooseSource(await discoverSources(request, id, cookie), preferred);
}

/** 小型内存缓存随登出清空；按凭据隔离，链接过期前重新请求。 */
export class SongSourceResolver {
  private cache = new Map<number, { cookie: string; expires: number; sources: Promise<SongSource[]> }>();
  constructor(private request: Requester) {}
  clear(): void { this.cache.clear(); }
  async resolve(id: number, cookie: string, preferred: AudioQuality): Promise<SongSource> {
    let entry = this.cache.get(id);
    if (!entry || entry.cookie !== cookie || entry.expires <= Date.now()) {
      entry = { cookie, expires: Date.now() + 60000, sources: discoverSources(this.request, id, cookie) };
      this.cache.set(id, entry);
      if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value!);
    }
    try { return chooseSource(await entry.sources, preferred); }
    catch (error) { if (this.cache.get(id) === entry) this.cache.delete(id); throw error; }
  }
}
