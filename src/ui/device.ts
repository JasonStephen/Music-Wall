// 播放器「设备」外观构建器：唱片机 / CD 播放器 / 纯封面。
// 盘片本体复用 disc.ts 的 buildDiscElement，这里只负责设备外壳与零件。
// 注意：MW（音乐墙）的唱片样式全部由 disc.ts + styles/{vinyl,cd,cassette,cover}.css 负责，
// 本文件与 player.css 里的 .mw-dev* 均为播放器专用，互不影响。
// 磁带机外观因无法达到交付要求已移除（音乐墙上的磁带唱片样式不受影响）。

import type { DiscStyle, WallItem } from "../types";
import { buildDiscElement } from "./disc";

export interface DeviceParts {
  root: HTMLElement;
  /** 数字显示屏（写 TRxx / 时间），封面模式无 */
  readout: HTMLElement | null;
}

function box(cls: string): HTMLElement {
  const node = document.createElement("div");
  node.className = cls;
  return node;
}

function btnRow(count: number): HTMLElement {
  const row = box("mw-dev__btnrow");
  for (let i = 0; i < count; i++) row.appendChild(box("mw-dev__btn"));
  return row;
}

/** 黑胶 = 唱片机：转盘 + 中心轴 + 唱臂（配重/臂管/唱头）+ 臂枕 + 调速旋钮 */
function buildTurntable(item: WallItem, coverSize: number): DeviceParts {
  const deck = box("mw-dev__deck");

  deck.appendChild(box("mw-dev__hinge"));

  const platter = box("mw-dev__platter");
  platter.appendChild(buildDiscElement(item, "vinyl", { coverSize }));
  deck.appendChild(platter);
  deck.appendChild(box("mw-dev__spindle"));

  const arm = box("mw-dev__arm");
  arm.appendChild(box("mw-dev__arm-cw"));
  const tube = box("mw-dev__arm-tube");
  tube.appendChild(box("mw-dev__arm-head"));
  arm.appendChild(tube);
  deck.appendChild(arm);

  deck.appendChild(box("mw-dev__arm-rest"));
  deck.appendChild(box("mw-dev__speedknob"));

  const btns = box("mw-dev__deckbtns");
  btns.appendChild(box("mw-dev__deckbtn"));
  btns.appendChild(box("mw-dev__deckbtn"));
  deck.appendChild(btns);

  const panel = box("mw-dev__panel mw-dev__panel--deck");
  panel.appendChild(box("mw-dev__led"));
  const readout = box("mw-dev__readout");
  panel.appendChild(readout);
  deck.appendChild(panel);

  return { root: deck, readout };
}

/** CD = CD 播放器：金属面板 + 碟仓 + 显示屏 + 按键 */
function buildCdPlayer(item: WallItem, coverSize: number): DeviceParts {
  const deck = box("mw-dev__deck mw-dev__deck--cd");

  const well = box("mw-dev__cdwell");
  well.appendChild(buildDiscElement(item, "cd", { coverSize }));
  deck.appendChild(well);

  const panel = box("mw-dev__panel mw-dev__panel--cd");
  panel.appendChild(box("mw-dev__led"));
  const readout = box("mw-dev__readout");
  panel.appendChild(readout);
  panel.appendChild(btnRow(4));
  deck.appendChild(panel);

  return { root: deck, readout };
}

/** 封面 = 大封面 + 模糊环境底（参考网易云播放器） */
function buildCoverStage(item: WallItem, coverSize: number): DeviceParts {
  const stage = box("mw-dev__coverstage");
  stage.appendChild(buildDiscElement(item, "cover", { coverSize }));
  return { root: stage, readout: null };
}

/** 按样式构建设备外观；返回根节点（含 .mw-dev--<style>）与显示屏引用 */
export function buildDevice(
  item: WallItem,
  style: DiscStyle,
  coverSize = 500,
  showMachine = true
): DeviceParts {
  if (!showMachine && (style === "vinyl" || style === "cd")) {
    const root = box(`mw-player-disc-only mw-player-disc-only--${style}`);
    root.appendChild(buildDiscElement(item, style, { coverSize }));
    return { root, readout: null };
  }
  const parts =
    style === "vinyl"
      ? buildTurntable(item, coverSize)
      : style === "cd"
        ? buildCdPlayer(item, coverSize)
        : buildCoverStage(item, coverSize);

  const root = box(`mw-dev mw-dev--${style}`);
  const chassis = box("mw-dev__chassis");
  chassis.appendChild(parts.root);
  root.appendChild(chassis);

  return { root, readout: parts.readout };
}
