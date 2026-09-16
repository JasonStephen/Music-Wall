// 样式面板共用件：真实唱片缩略预览 + 预设类名。
//
// 预览刻意复用 buildDiscElement 渲染真实 DOM 后整体 scale 缩小，
// 不另写一套缩略图样式——四种样式的纹理永远与墙上一致，
// 改 styles/*.css 不需要同步第二份。

import type { DiscStyle, WallItem } from "../types";
import { buildDiscElement } from "./disc";
import { sizedCover } from "../core/metadata";

/** 预览舞台的标称宽度（与 buildDiscElement 的 coverSize 对齐，取图上限 340） */
const PRESET_STAGE_W = 340;

/** 预览用假条目：封面取「当前墙第一张」或内置渐变占位 */
export function presetItem(cover: string, name = "样式预览"): WallItem {
  return {
    albumId: 0,
    source: "manual",
    locked: true,
    addedAt: new Date(0).toISOString(),
    meta: {
      albumId: 0,
      name,
      artist: "",
      cover,
      trackCount: 0,
    },
  };
}

function placeholderCover(): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="340">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="#5b6ee1"/><stop offset="0.55" stop-color="#8a5be1"/>` +
    `<stop offset="1" stop-color="#e15b8a"/></linearGradient></defs>` +
    `<rect width="340" height="340" fill="url(#g)"/>` +
    `<circle cx="170" cy="170" r="86" fill="rgba(255,255,255,0.16)"/>` +
    `<circle cx="170" cy="170" r="26" fill="rgba(255,255,255,0.34)"/>` +
    `</svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

/**
 * 样式预设瓷砖：点一下即应用。
 * @param cover 预览封面（通常用当前墙第一张专辑封面，无则内置渐变占位）
 */
export function buildStyleTile(
  style: DiscStyle,
  label: string,
  cover: string,
  active: boolean,
  onPick: (style: DiscStyle) => void
): HTMLElement {
  const tile = document.createElement("button");
  tile.className = "mw-preset";
  tile.type = "button";
  tile.dataset.mwStyle = style;
  tile.toggleClass("is-active", active);
  tile.setAttr("aria-label", label);
  tile.setAttr("title", label);

  const stage = document.createElement("div");
  stage.className = "mw-preset__stage";
  const item = presetItem(
    cover || placeholderCover(),
    label
  );
  stage.appendChild(
    buildDiscElement(item, style as DiscStyle, { coverSize: PRESET_STAGE_W })
  );
  // 缩放系数由 CSS 按瓷砖实际宽度反解（--mw-preset-w 由布局给出）
  tile.appendChild(stage);
  tile.createSpan({ cls: "mw-preset__label", text: label });
  tile.addEventListener("click", () => onPick(style));
  return tile;
}

/** 用当前墙的第一张封面作为预览图（保持四种样式预览的是同一张，便于对比） */
export function firstCover(items: { meta: { cover: string } }[]): string {
  for (const it of items) if (it.meta.cover) return sizedCover(it.meta.cover, PRESET_STAGE_W);
  return "";
}

/** 布局预设：纯 CSS 示意图标（不依赖封面），三选一 */
export function buildLayoutTile(
  layout: "grid" | "list" | "shelf",
  label: string,
  active: boolean,
  onPick: (layout: "grid" | "list" | "shelf") => void
): HTMLElement {
  const tile = document.createElement("button");
  tile.className = "mw-preset mw-preset--layout";
  tile.type = "button";
  tile.dataset.mwLayout = layout;
  tile.toggleClass("is-active", active);
  tile.setAttr("aria-label", label);
  tile.setAttr("title", label);
  const art = tile.createDiv({ cls: `mw-preset__art mw-preset__art--${layout}` });
  for (let i = 0; i < 4; i++) art.createDiv({ cls: "mw-preset__cell" });
  tile.createSpan({ cls: "mw-preset__label", text: label });
  tile.addEventListener("click", () => onPick(layout));
  return tile;
}

/** 背景预设（播放器页）：色块 + 名称 */
export function buildBgTile(
  bg: string,
  label: string,
  title: string,
  active: boolean,
  onPick: (bg: string) => void
): HTMLElement {
  const tile = document.createElement("button");
  tile.className = "mw-preset mw-preset--bg";
  tile.type = "button";
  tile.dataset.mwBg = bg;
  tile.toggleClass("is-active", active);
  tile.setAttr("aria-label", label);
  tile.setAttr("title", title);
  tile.createDiv({ cls: `mw-preset__art mw-preset__art--bg-${bg}` });
  tile.createSpan({ cls: "mw-preset__label", text: label });
  tile.addEventListener("click", () => onPick(bg));
  return tile;
}
