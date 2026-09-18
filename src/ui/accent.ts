// 从封面图提取「主色」+「整体亮度」，供播放器在「封面」背景下
// 给播放键取色、并决定文字/图标用深色还是浅色。
//
// 为什么不直接把封面 <img> 画进 canvas：Obsidian 的封面地址多为 app:// 或远端 URL，
// 跨源画布会被 taint，getImageData 直接抛 SecurityError。这里先用 requestUrl 把字节
// 取回来（走 Obsidian 的网络栈，不受 CORS 限制），再造 Blob URL——blob: 与文档同源，
// 画布可读。
//
// 失败（无封面 / 取字节失败 / 解码失败）一律返回 accent=null、luma=null，
// 由调用方回退到主题强调色与「浅字 + 文字阴影」，保证不会出现「白底白字 / 黑底黑字」。

import { requestUrl } from "obsidian";

/** 采样尺寸：24×24 足够看出主色与平均亮度，代价可忽略 */
const SAMPLE = 24;
/** 色相分桶数（每桶 30°） */
const HUE_BUCKETS = 12;
/** 饱和度 / 亮度门槛：太灰、太白、太黑都不能当强调色 */
const MIN_SAT = 0.22;
const MIN_L = 0.2;
const MAX_L = 0.82;
/** 输出颜色的亮度夹紧区间：保证与白字或黑字至少有一侧可读 */
const OUT_MIN_L = 0.36;
const OUT_MAX_L = 0.62;

/** url → 采样结果（失败也缓存，避免反复请求） */
const cache = new Map<string, CoverTone>();
/** 同一 URL 的并发请求合并 */
const inflight = new Map<string, Promise<CoverTone>>();

/** 取不到封面时的结果（不缓存这个对象本身，只作返回值用） */
const EMPTY_TONE: CoverTone = { accent: null, luma: null };

export interface AccentColors {
  /** 强调色（按钮底色） */
  accent: string;
  /** 压在强调色上的文字/图标色（按亮度自动选深或浅） */
  onAccent: string;
}

/** 一次封面采样的结果 */
export interface CoverTone {
  /** 强调色（按钮底色）；null = 取不到合适的颜色 */
  accent: string | null;
  /**
   * 封面整体亮度 0..1（**感知亮度**，见 perceived()）。
   * 播放器的封面背景 = 这张图放大模糊后的结果，模糊不改变平均值，
   * 所以它就是「背景是浅色还是深色」的良好近似，用来决定文字用深色还是浅色。
   * null = 取不到（调用方按深色背景处理）。
   */
  luma: number | null;
}


function toHex(r: number, g: number, b: number): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** RGB → HSL（h 0..360，s/l 0..1） */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** 相对亮度（sRGB，用于挑压色） */
function luminance(r: number, g: number, b: number): number {
  const f = (v: number) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * 感知亮度 0..1（0.299R + 0.587G + 0.114B）。
 *
 * 为什么不直接用上面的 WCAG 相对亮度判「浅底/深底」：相对亮度是给对比度公式用的，
 * 对深蓝/深紫这类颜色压得很低（`#5b6ee1` 只有 0.18），会把肉眼看着是中间调的封面
 * 判成深色。判断「背景看起来浅不浅」用感知亮度更贴近人眼，阈值 0.5 正好落在中灰。
 */
function perceived(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/** 由强调色推出压在其上的文字色 */
export function onAccentFor(accent: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(accent.trim());
  if (!m) return "#ffffff";
  const v = parseInt(m[1], 16);
  const lum = luminance((v >> 16) & 255, (v >> 8) & 255, v & 255);
  return lum > 0.45 ? "#1b1b1f" : "#ffffff";
}

/**
 * 封面主色 + 整体亮度（一次采样拿两样东西）。命中缓存直接返回；同一 URL 的并发只跑一次。
 * @param url 封面地址（sizedCover 之后的地址即可）
 */
export async function coverTone(url: string): Promise<CoverTone> {
  const key = url.trim();
  if (!key) return EMPTY_TONE;
  const hit = cache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;
  const task = extract(key)
    .catch(() => EMPTY_TONE)
    .then((tone) => {
      cache.set(key, tone);
      inflight.delete(key);
      return tone;
    });
  inflight.set(key, task);
  return task;
}

/** 只要主色（内部仍是 coverTone 的同一次采样，不会重复请求） */
export async function coverAccent(url: string): Promise<string | null> {
  return (await coverTone(url)).accent;
}

/**
 * 同步查询缓存：命中返回结果，未请求/进行中返回 undefined。
 * 调用方在「要立刻重设背景」时用它守卫：上次取色失败的地址这次也别铺底，
 * 否则异步失败的兜底（移除 --mw-player-art）会被同步重设冲掉。
 */
export function peekTone(url: string): CoverTone | undefined {
  const key = url.trim();
  return key ? cache.get(key) : undefined;
}

async function extract(url: string): Promise<CoverTone> {
  // data-URI（内置默认封面 / 本站资源）与文档同源：不需要也不应该走 requestUrl
  //（requestUrl 抓不了 data:，而且这类地址画 canvas 不会 taint，直接解码采样）。
  if (url.startsWith("data:") || url.startsWith("blob:")) {
    return toneFromImage(url);
  }
  const resp = await requestUrl({ url, method: "GET" });
  const buf = resp.arrayBuffer;
  if (!buf || !buf.byteLength) return EMPTY_TONE;
  const blobUrl = URL.createObjectURL(new Blob([buf]));
  try {
    return await sampleImage(await loadImage(blobUrl));
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/** 本地地址（data: / blob:）直接解码采样：同源画布可读，不走网络栈 */
async function toneFromImage(src: string): Promise<CoverTone> {
  try {
    return await sampleImage(await loadImage(src));
  } catch {
    return EMPTY_TONE;
  }
}

/** 把图缩到 SAMPLE×SAMPLE 后一次采样出「主色 + 整体亮度」 */
function sampleImage(img: HTMLImageElement): CoverTone {
  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return EMPTY_TONE;
  ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
  const data = ctx.getImageData(0, 0, SAMPLE, SAMPLE).data;
  return { accent: pickDominant(data), luma: averageLuma(data) };
}

/** 整幅封面的平均亮度（只统计不透明像素）；全是透明像素时返回 null */
function averageLuma(data: Uint8ClampedArray): number | null {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 200) continue;
    sum += perceived(data[i], data[i + 1], data[i + 2]);
    n++;
  }
  return n ? sum / n : null;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("封面解码失败"));
    img.src = src;
  });
}

/** 按色相分桶取权重最大的桶（用饱和度加权），并夹紧亮度 */
function pickDominant(data: Uint8ClampedArray): string | null {
  const buckets = new Array(HUE_BUCKETS).fill(0).map(() => ({
    w: 0,
    r: 0,
    g: 0,
    b: 0,
  }));
  // 平均色累计（不管像素是否入选色桶都计入），供灰白调封面的兜底
  let avgR = 0, avgG = 0, avgB = 0, avgN = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 200) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    avgR += r;
    avgG += g;
    avgB += b;
    avgN++;
    const [h, s, l] = rgbToHsl(r, g, b);
    if (s < MIN_SAT || l < MIN_L || l > MAX_L) continue;
    const bucket = buckets[Math.floor((h / 360) * HUE_BUCKETS) % HUE_BUCKETS];
    const w = s * (1 - Math.abs(l - 0.5) * 1.2); // 越接近中亮越有代表性
    bucket.w += w;
    bucket.r += r * w;
    bucket.g += g * w;
    bucket.b += b * w;
  }
  let best = buckets[0];
  for (const b of buckets) if (b.w > best.w) best = b;
  if (best.w <= 0) {
    // 灰白调封面（没有合格的饱和像素）：不再返回 null 导致主题紫兜底「颜色不对」，
    // 改用封面自己的平均色，饱和度和亮度夹到可用范围（第七轮）。
    if (!avgN) return null;
    const [h, s, l] = rgbToHsl(avgR / avgN, avgG / avgN, avgB / avgN);
    // 平均色几乎完全无色相（纯灰/黑白封面）时，把 h 夹到 0 会得到脏红：
    // 这种封面交给调用方回退固定品牌色（见 player.css 的 --mw-np-accent）更干净。
    if (s < 0.08) return null;
    const outS = Math.min(0.9, Math.max(0.35, s));
    const outL = Math.min(OUT_MAX_L, Math.max(OUT_MIN_L, l));
    const [r, g, b] = hslToRgb(h, outS, outL);
    return toHex(r, g, b);
  }
  const [h, s, l] = rgbToHsl(best.r / best.w, best.g / best.w, best.b / best.w);
  const outL = Math.min(OUT_MAX_L, Math.max(OUT_MIN_L, l));
  const outS = Math.min(0.9, Math.max(0.35, s));
  const [r, g, b] = hslToRgb(h, outS, outL);
  return toHex(r, g, b);
}
