// 界面缩放（全局，音乐墙 + 播放器 + 模态框）。
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
import { t } from "../i18n";

export interface ZoomHost {
  settings: MusicWallSettings;
  /** 持久化缩放（不触发视图重建） */
  saveZoom(scale: number): void;
}

/**
 * 缩放盒尺寸兜底（第六轮 B1）。
 *
 * CSS 里 `.mw-zoombox` 已经用 `width/height: calc(100% / var(--mw-zoom))` 做反除补偿，
 * 但**百分比一旦在任何环节解析不成**（父级高度不确定、变量晚于样式表到达、引擎差异……），
 * 该声明会静默退化成 `auto`：
 *   - `width: auto` → 铺满窗格宽度，再被 scale 压成 90% ⇒ **右侧一条空白**；
 *   - `height: auto` → 变成内容高度，再被 scale 压低 ⇒ **底部一大片空白**。
 * 用户实测的「右侧 + 底部大量留白」正是这个形状（右边窄、下边宽），
 * 而本地在任意缩放下都复现不出来（CSS calc 正常生效）。
 *
 * 所以这里按窗格**像素**把尺寸写进行内样式（行内优先级高于样式表），
 * 并用 ResizeObserver 跟随窗格尺寸变化。CSS 那条仍是基础实现，本函数只负责「保证」。
 */
const zoomObservers = new WeakMap<HTMLElement, ResizeObserver>();

function applyZoomBoxSize(root: HTMLElement, box: HTMLElement, scale: number): void {
  const z = clampZoom(scale);
  const w = root.clientWidth;
  const h = root.clientHeight;
  if (w <= 0 || h <= 0) return;
  // 向下取整而不是四舍五入：缩放盒会被 transform 再放大 z 倍，
  // 行内尺寸若被 round 到「略大」，放大后就会比窗格宽出零点几个千分位像素，
  // 配合根节点 overflow:auto（见 base.css 的滚动条抽动说明）会让最外层
  // 滚动条周期性出现/消失。floor 保证换算回来的视觉尺寸永远 ≤ 窗格。
  const px = (v: number) => `${Math.floor(v * 1000) / 1000}px`;
  box.style.width = px(w / z);
  box.style.height = px(h / z);
  // 记下当前缩放，ResizeObserver 回调里要复用（回调不接参数）
  root.dataset.mwZoom = String(z);
}

/**
 * 同步缩放盒尺寸并在首次调用时挂上 ResizeObserver。
 * 视图 `render()` 末尾、缩放变化（plugin.applyZoom）与窗格尺寸变化时都要走一遍。
 *
 * ⚠️ 观察者回调必须**每次重新查询**当前那只 `.mw-zoombox`（勿改回闭包捕获）：
 * `render()` 是 `root.empty()` 之后**新建**一只缩放盒，若把首次查询到的节点闭包捕获下来，
 * 第二次 render 起观察者写的就一直是「已脱离 DOM 的旧盒子」，页面上活着的盒子
 * 再也拿不到新尺寸。因为内联像素宽高优先级高于 CSS 的 calc 反除补偿，它不会自愈，
 * 表现为**改变窗口/窗格尺寸后内容钉在原地**（背景是根节点上的 ::before，不受影响，
 * 于是形状是「背景铺满、内容缩在原来的位置」）。只有下一次 render（拖入专辑、改设置、
 * 库内文件变动）或缩放变化才会顺手写对一次。
 */
export function syncZoomBox(root: HTMLElement, scale: number): void {
  const box = root.querySelector<HTMLElement>(":scope > .mw-zoombox");
  if (!box) return;
  // 观察者是「跟随窗格尺寸」的增强，拿不到就算了（render 绝不能因为环境缺 API 而抛错）。
  // Obsidian 桌面/移动端都有 ResizeObserver，这里的守卫是给离线冒烟等非浏览器环境留的。
  if (!zoomObservers.has(root) && typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => {
      // 重新查询：只有当前挂在 root 下的那只缩放盒才是活的（render 会重建它）
      const live = root.querySelector<HTMLElement>(":scope > .mw-zoombox");
      if (!live) return;
      const z = Number(root.dataset.mwZoom ?? "1") || 1;
      applyZoomBoxSize(root, live, z);
    });
    ro.observe(root);
    zoomObservers.set(root, ro);
  }
  applyZoomBoxSize(root, box, scale);
}

/** 视图关闭时断开观察者（视图会被反复创建，不清理会攒住已废弃的根节点） */
export function disposeZoomBox(root: HTMLElement): void {
  const ro = zoomObservers.get(root);
  if (ro) {
    ro.disconnect();
    zoomObservers.delete(root);
  }
}

/** 显示当前缩放的小提示（复用同一个元素，1.2s 后淡出） */
export function showZoomToast(host: HTMLElement, scale: number): void {
  let toast = host.querySelector<HTMLElement>(".mw-zoomtoast");
  if (!toast) {
    toast = host.createDiv({ cls: "mw-zoomtoast" });
  }
  toast.setText(t("zoom.toast", { value: Math.round(scale * 100) }));
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
