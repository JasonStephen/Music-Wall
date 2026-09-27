// 样式面板共用件：真实唱片缩略预览 + 预设瓷砖。
//
// 预览刻意复用 buildDiscElement 渲染真实 DOM：四种样式的纹理永远与墙上一致，
// 改 styles/*.css 不需要同步第二份缩略图。尺寸由容器决定（见 presets.css），
// 不用固定宽 + transform: scale()。

import type { DiscStyle, WallItem } from "../types";
import { buildDiscElement } from "./disc";
import { sizedCover } from "../core/metadata";
import { t } from "../i18n";

/** 预览取图尺寸：瓷砖实际只有 ~120-180px，取 220 足够清晰又不浪费流量 */
const PRESET_COVER_SIZE = 220;

/** 预览用假条目：封面取「当前墙第一张」或内置渐变占位 */
export function presetItem(cover: string, name?: string): WallItem {
  return {
    albumId: 0,
    source: "manual",
    locked: true,
    addedAt: new Date(0).toISOString(),
    meta: {
      albumId: 0,
      name: name ?? t("viewPrefs.presetName"),
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
  stage.appendChild(
    buildDiscElement(presetItem(cover || placeholderCover(), label), style, {
      coverSize: PRESET_COVER_SIZE,
    })
  );
  tile.appendChild(stage);
  tile.createSpan({ cls: "mw-preset__label", text: label });
  tile.addEventListener("click", () => onPick(style));
  return tile;
}

/** 用当前墙的第一张封面作为预览图（四种样式预览同一张，便于对比） */
export function firstCover(items: { meta: { cover: string } }[]): string {
  for (const it of items) if (it.meta.cover) return sizedCover(it.meta.cover, PRESET_COVER_SIZE);
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
