// 评分共享小组件：单星徽标（卡片右上角）与五星只读展示（详情用）。
// 徽标星形用内联 SVG 承载：字体 ★ 字形随平台/主题漂移（padding-top 居中补偿就是为此调的），
// 且星心太窄、数字顶到内凹角。自定义 path 把内半径从正五角星的 ≈0.382R 调大到 0.46R，
// 星心可用区直径由星宽 31% 提到 37%，数字四周透得出气。星色走 currentColor，CSS 按档位注入。
// 注：详情五星与评分弹窗大星没有叠字，仍用 ★ 字符承载，不受本改动影响。

import { t } from "../i18n";

/** 徽标胖五角星 path：viewBox 0 0 24 24，中心 (12,12)，外接径 10.5，内半径比 0.46。
 *  想调胖瘦只改这个 d：5 个外顶点在 -90°+k·72°、半径 10.5；5 个内凹点错开 36°、半径 10.5×比值。 */
const BADGE_STAR_PATH =
  "M12,1.5 L14.84,8.09 L21.99,8.76 L16.59,13.49 L18.17,20.49 L12,16.83 " +
  "L5.83,20.49 L7.41,13.49 L2.01,8.76 L9.16,8.09 Z";

/** 徽标用 SVG 星：不吃字号，CSS 给 color（样式表里 fill: currentColor 统一声明） */
function buildBadgeStarSvg(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "mw-rating-badge__star");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", BADGE_STAR_PATH);
  svg.appendChild(path);
  return svg;
}

/** 合法评分：1–5 整数 */
export function isRating(v: unknown): v is 1 | 2 | 3 | 4 | 5 {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;
}

/** 清洗：合法返回 1–5，否则返回 undefined（未评分） */
export function normalizeRating(v: unknown): number | undefined {
  return isRating(v) ? v : undefined;
}

/** 卡片右上角徽标：单颗星＋中间数字；调用方只在已评分时调用。
 *  data-rating 供 CSS 按档位着色（1–5 各有代表色）。 */
export function buildRatingBadge(rating: number): HTMLElement {
  const badge = document.createElement("div");
  badge.className = "mw-rating-badge";
  badge.dataset.rating = String(rating);
  badge.setAttribute("aria-label", t("rating.aria", { value: rating }));
  badge.setAttribute("title", t("rating.aria", { value: rating }));
  const num = document.createElement("span");
  num.className = "mw-rating-badge__num";
  num.textContent = String(rating);
  num.setAttribute("aria-hidden", "true");
  badge.append(buildBadgeStarSvg(), num);
  return badge;
}

/** 详情只读展示：五颗星，按评分点亮；未评分全暗。data-rating 让亮起的星取该档位代表色 */
export function buildStarsDisplay(rating: unknown): HTMLElement {
  const r = normalizeRating(rating) ?? 0;
  const wrap = document.createElement("div");
  wrap.className = "mw-stars";
  wrap.setAttribute(
    "aria-label",
    r ? t("rating.aria", { value: r }) : t("rating.unrated")
  );
  wrap.setAttribute(
    "title",
    r ? t("rating.aria", { value: r }) : t("rating.unrated")
  );
  if (!r) wrap.addClass("is-unrated");
  else wrap.dataset.rating = String(r);
  for (let i = 1; i <= 5; i++) {
    const s = document.createElement("span");
    s.className = "mw-stars__star";
    s.textContent = "★";
    s.setAttribute("aria-hidden", "true");
    if (i <= r) s.addClass("is-on");
    wrap.appendChild(s);
  }
  return wrap;
}

/** 原地刷新只读五星（详情评分保存后用，避免重建整个详情） */
export function paintStarsDisplay(wrap: HTMLElement, rating: unknown): void {
  const r = normalizeRating(rating) ?? 0;
  wrap.setAttribute(
    "aria-label",
    r ? t("rating.aria", { value: r }) : t("rating.unrated")
  );
  wrap.setAttribute(
    "title",
    r ? t("rating.aria", { value: r }) : t("rating.unrated")
  );
  wrap.toggleClass("is-unrated", !r);
  if (r) wrap.dataset.rating = String(r);
  else delete wrap.dataset.rating;
  const stars = Array.from(wrap.querySelectorAll<HTMLElement>(".mw-stars__star"));
  stars.forEach((s, i) => s.toggleClass("is-on", i < r));
}
