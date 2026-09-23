// 评分共享小组件：单星徽标（卡片右上角）与五星只读展示（详情用）。
// 星形用字符 ★ 承载形状，数字用绝对居中叠加——clip-path 会把数字一起裁掉，故不用它切星形。

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
  badge.setAttribute("aria-label", `评分 ${rating} / 5`);
  badge.setAttribute("title", `评分 ${rating} / 5`);
  const star = document.createElement("span");
  star.className = "mw-rating-badge__star";
  star.textContent = "★";
  star.setAttribute("aria-hidden", "true");
  const num = document.createElement("span");
  num.className = "mw-rating-badge__num";
  num.textContent = String(rating);
  num.setAttribute("aria-hidden", "true");
  badge.append(star, num);
  return badge;
}

/** 详情只读展示：五颗星，按评分点亮；未评分全暗。data-rating 让亮起的星取该档位代表色 */
export function buildStarsDisplay(rating: unknown): HTMLElement {
  const r = normalizeRating(rating) ?? 0;
  const wrap = document.createElement("div");
  wrap.className = "mw-stars";
  wrap.setAttribute("aria-label", r ? `评分 ${r} / 5` : "未评分");
  wrap.setAttribute("title", r ? `评分 ${r} / 5` : "未评分");
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
  wrap.setAttribute("aria-label", r ? `评分 ${r} / 5` : "未评分");
  wrap.setAttribute("title", r ? `评分 ${r} / 5` : "未评分");
  wrap.toggleClass("is-unrated", !r);
  if (r) wrap.dataset.rating = String(r);
  else delete wrap.dataset.rating;
  const stars = Array.from(wrap.querySelectorAll<HTMLElement>(".mw-stars__star"));
  stars.forEach((s, i) => s.toggleClass("is-on", i < r));
}
