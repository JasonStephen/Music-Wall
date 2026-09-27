// 内置默认封面：专辑没匹配到 / 专辑没有封面时的兜底视觉。
//
// 为什么是内联 SVG data-URI 而不是资源文件：
// - 插件按 esbuild 单文件打包（main.js + styles.css 两个产物，见 tools/deploy.cjs），
//   没有独立的 assets 投放通道；SVG 内联进 bundle 零额外请求。
// - data-URI 与文档同源，画进 canvas 不会 taint（accent.ts 的本地采样可以直接用），
//   也天然离线可用（车联网/断网时不至于空白）。
//
// 视觉：黑胶纹理底（同心纹 + 中央标签）+ 白色音符（lucide "music" 轮廓），
// 与唱片的既成语言一致，不用额外配色 influenced 主题。

import { t } from "../i18n";

/** 默认封面唱片名（运行时取当前语言） */
export function defaultCoverName(): string {
  return t("defaultCover.name");
}

const SVG = [
  "<svg xmlns='http://www.w3.org/2000/svg' width='512' height='512' viewBox='0 0 512 512'>",
  "<defs>",
  "<radialGradient id='bg' cx='50%' cy='38%' r='75%'>",
  "<stop offset='0' stop-color='#282c36'/><stop offset='1' stop-color='#14161c'/>",
  "</radialGradient>",
  "</defs>",
  "<rect width='512' height='512' rx='24' fill='url(#bg)'/>",
  // 黑胶同心纹
  "<g fill='none' stroke='rgba(255,255,255,0.07)' stroke-width='2'>",
  [56, 88, 120, 152, 184, 216].map((r) => `<circle cx='256' cy='256' r='${r}'/>`).join(""),
  "</g>",
  // 中央标签
  "<circle cx='256' cy='256' r='96' fill='#2b2f3a' stroke='rgba(255,255,255,0.16)' stroke-width='2'/>",
  "<circle cx='256' cy='256' r='10' fill='#0d0f13'/>",
  // 音符（lucide "music"，24 网格 → 8× 放大居中）
  "<g transform='translate(160 176) scale(8)' fill='none' stroke='rgba(233,236,241,0.92)'",
  " stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'>",
  "<path d='M9 18V5l12-2v13'/>",
  "<circle cx='6' cy='18' r='3'/>",
  "<circle cx='18' cy='16' r='3'/>",
  "</g>",
  "</svg>",
].join("");

export const DEFAULT_COVER = `data:image/svg+xml,${encodeURIComponent(SVG)}`;
