// 从封面图提取「主色」，供播放器在「封面」背景下给播放键取色。
//
// 为什么不直接把封面 <img> 画进 canvas：Obsidian 的封面地址多为 app:// 或远端 URL，
// 跨源画布会被 taint，getImageData 直接抛 SecurityError。这里先用 requestUrl 把字节
// 取回来（走 Obsidian 的网络栈，不受 CORS 限制），再造 Blob URL——blob: 与文档同源，
// 画布可读。
//
// 失败（无封面 / 取字节失败 / 解码失败 / 全是不适合当强调色的像素）一律返回 null，
// 由调用方回退到主题强调色，保证不会出现「白底白字 / 黑底黑字」。

import { requestUrl } from "obsidian";

/** 采样尺寸：24×24 足够看出主色，代价可忽略 */
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

/** url → 颜色（null = 取色失败，同样缓存，避免反复请求） */
const cache = new Map<string, string | null>();
/** 同一 URL 的并发请求合并 */
const inflight = new Map<string, Promise<string | null>>();

export interface AccentColors {
  /** 强调色（按钮底色） */
  accent: string;
  /** 压在强调色上的文字/图标色（按亮度自动选深或浅） */
  onAccent: string;
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

/** 由强调色推出压在其上的文字色 */
export function onAccentFor(accent: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(accent.trim());
  if (!m) return "#ffffff";
  const v = parseInt(m[1], 16);
  const lum = luminance((v >> 16) & 255, (v >> 8) & 255, v & 255);
  return lum > 0.45 ? "#1b1b1f" : "#ffffff";
}

/**
 * 封面主色。命中缓存直接返回；同一 URL 的并发只发一次请求。
 * @param url 封面地址（sizedCover 之后的地址即可）
 */
export async function coverAccent(url: string): Promise<string | null> {
  const key = url.trim();
  if (!key) return null;
  if (cache.has(key)) return cache.get(key) ?? null;
  const running = inflight.get(key);
  if (running) return running;
  const task = extract(key)
    .catch(() => null)
    .then((color) => {
      cache.set(key, color);
      inflight.delete(key);
      return color;
    });
  inflight.set(key, task);
  return task;
}

async function extract(url: string): Promise<string | null> {
  const resp = await requestUrl({ url, method: "GET" });
  const buf = resp.arrayBuffer;
  if (!buf || !buf.byteLength) return null;
  const blobUrl = URL.createObjectURL(new Blob([buf]));
  try {
    const img = await loadImage(blobUrl);
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    return pickDominant(ctx.getImageData(0, 0, SAMPLE, SAMPLE).data);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
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
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 200) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
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
  if (best.w <= 0) return null;
  const [h, s, l] = rgbToHsl(best.r / best.w, best.g / best.w, best.b / best.w);
  const outL = Math.min(OUT_MAX_L, Math.max(OUT_MIN_L, l));
  const outS = Math.min(0.9, Math.max(0.35, s));
  const [r, g, b] = hslToRgb(h, outS, outL);
  return toHex(r, g, b);
}
