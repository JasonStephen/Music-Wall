// 唱片视觉元素构建器。网格（小尺寸）与详情面板（大尺寸）共用同一份 DOM 结构，
// 具体纹理与动效全部由 CSS（styles/*.css）实现，本文件只负责结构。

import type { DiscStyle, WallItem } from "../types";
import { sizedCover } from "../core/metadata";
import { DEFAULT_COVER } from "./defaultCover";

export interface DiscOptions {
  /** 封面取图尺寸（px），网格用小值省流量 */
  coverSize?: number;
}

/** 四种唱片样式列表（顺序=预设瓷砖展示顺序） */
export const ALL_STYLES: DiscStyle[] = ["vinyl", "cd", "cassette", "cover"];

function makeImg(src: string, alt: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "mw-cover-img";
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = alt;
  // 关键：<img> 默认是浏览器的原生拖拽源，按住封面一移动就会启动原生图片拖拽
  // 并取消指针事件 —— 排序手势会被整段抢走（用户报「拖不动」的根因之一）。
  // 关掉它，拖拽源就只剩整张卡片。
  img.draggable = false;
  // 第七轮起：没封面 / 封面拉不到都落到内置默认封面，不再露出破图或空白。
  // 兜底图自己也拉不到时（再换就没完没了）才隐藏并给父容器挂 mw-cover-broken；
  // 是否已是兜底图按 src 前缀判断，不再多存一份状态。
  img.addEventListener("error", () => {
    if (!img.src.startsWith("data:image/svg+xml")) {
      img.src = DEFAULT_COVER;
      return;
    }
    img.style.display = "none";
    const wrap = img.parentElement;
    if (wrap) wrap.classList.add("mw-cover-broken");
  });
  img.src = src || DEFAULT_COVER;
  return img;
}

/** 供展示架等外部构建器复用的封面 <img>（破图时父容器获得 mw-cover-broken） */
export function makeCoverImg(src: string, alt: string): HTMLImageElement {
  return makeImg(src, alt);
}

/** 构建一张唱片的视觉元素 */
export function buildDiscElement(
  item: WallItem,
  style: DiscStyle,
  opts: DiscOptions = {}
): HTMLElement {
  const { coverSize = 400 } = opts;
  const root = document.createElement("div");
  root.className = `mw-disc mw-disc--${style}`;

  const coverUrl = sizedCover(item.meta.cover, coverSize);

  if (style === "cassette") {
    // 壳子（外盒，展示封面）+ 里面会滑出的磁带本体
    const root0 = document.createElement("div");
    root0.className = "mw-case";

    // 磁带本体（在盒子里，悬停时滑出）
    const tape = document.createElement("div");
    tape.className = "mw-tape";
    const tapeWin = document.createElement("div");
    tapeWin.className = "mw-tape__win";
    const hubA = document.createElement("div");
    const hubB = document.createElement("div");
    hubA.className = hubB.className = "mw-tape__hub";
    const tapeStrip = document.createElement("div");
    tapeStrip.className = "mw-tape__strip";
    tapeWin.append(hubA, tapeStrip, hubB);
    tape.appendChild(tapeWin);

    // 盒子封面（带书脊）
    const caseFront = document.createElement("div");
    caseFront.className = "mw-case__front";
    const spine = document.createElement("div");
    spine.className = "mw-case__spine";
    const cover = document.createElement("div");
    cover.className = "mw-case__cover";
    cover.appendChild(makeImg(coverUrl, item.meta.name));
    caseFront.append(spine, cover);

    root0.append(tape, caseFront);
    root.appendChild(root0);
    return root;
  }

  if (style === "cover") {
    const cover = document.createElement("div");
    cover.className = "mw-cover mw-cover--standalone";
    cover.appendChild(makeImg(coverUrl, item.meta.name));
    root.appendChild(cover);
    return root;
  }

  // vinyl / cd：直接展示盘片本体
  const disc = document.createElement("div");
  disc.className = "mw-record";
  const plate = document.createElement("div");
  plate.className = "mw-record__plate";
  const label = document.createElement("div");
  label.className = "mw-record__label";
  label.appendChild(makeImg(coverUrl, item.meta.name));
  const center = document.createElement("div");
  center.className = "mw-record__center";
  plate.append(label, center);
  disc.appendChild(plate);
  root.appendChild(disc);
  return root;
}
