// 界面缩放（全局，MW + MWP + 模态框）。
//
// 实现：把缩放系数写进 body 上的 --mw-zoom；视图根的缩放盒用
// `transform: scale(var(--mw-zoom))` + `transform-origin: 0 0` 缩放，
// 并以 `width/height: calc(100% / var(--mw-zoom))` 反除补偿，
// 保证放大后视图仍然精确铺满窗格（否则右侧/底部会留白、缩小则溢出被裁）。
//
// 为什么不是 zoom：Chromium 128+ 起 zoom 对「自身尺寸来自百分比」的元素
// 完全失效（既不缩放布局也不缩放绘制/命中），而缩放盒正是这种元素——
// 上一版用 zoom 时补偿生效、放大失效，于是 >100% 留白、<100% 溢出。
// 详见 base.css 里 .mw-zoombox 的注释与 tools/gf-e2e.ts 的 zoom 场景。
//
// 注意（几何换算）：缩放后 getBoundingClientRect() 给的是**视觉像素**，
// 而 style.left/top 等长度是**局部像素**（会被 transform 再乘一次）。
// 所有「用 rect 差值去写样式」的地方都要除以缩放系数，见 zoom()`。

import { ZOOM_STEP, clampZoom, type MusicWallSettings } from "../types";

export interface ZoomHost {
  settings: MusicWallSettings;
  /** 持久化缩放（不触发视图重建） */
  saveZoom(scale: number): void;
}

/** 显示当前缩放的小提示（复用同一个元素，1.2s 后淡出） */
export function showZoomToast(host: HTMLElement, scale: number): void {
  let toast = host.querySelector<HTMLElement>(".mw-zoomtoast");
  if (!toast) {
    toast = host.createDiv({ cls: "mw-zoomtoast" });
  }
  toast.setText(`缩放 ${Math.round(scale * 100)}%`);
  toast.addClass("is-visible");
  const el = toast;
  const prev = Number(el.dataset.timer ?? 0);
  if (prev) window.clearTimeout(prev);
  const timer = window.setTimeout(() => {
    el.removeClass("is-visible");
    el.dataset.timer = "";
  }, 1200);
  el.dataset.timer = String(timer);
}

/**
 * 在视图内注册 Ctrl/Alt + 滚轮缩放。
 * 两个修饰键都支持（Ctrl 会接管 Obsidian 自带的字号缩放，已确认接受）。
 * @returns 是否消费了本次滚轮（consume=true 表示已缩放）
 */
export function handleZoomWheel(
  e: WheelEvent,
  host: ZoomHost,
  hostEl: HTMLElement
): boolean {
  if (!e.ctrlKey && !e.altKey) return false;
  e.preventDefault();
  e.stopPropagation();
  const dir = e.deltaY < 0 ? 1 : -1;
  const current = clampZoom(host.settings.zoomScale ?? 1);
  const next = clampZoom(current + dir * ZOOM_STEP);
  if (next === current) return true;
  host.settings.zoomScale = next;
  host.saveZoom(next);
  showZoomToast(hostEl, next);
  return true;
}
