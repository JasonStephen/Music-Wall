// .mw 文件的读写、解析与 schema 迁移。

import type { Vault, TFile } from "obsidian";
import {
  WALL_FILE_VERSION,
  type DiscStyle,
  type MusicWallData,
  type WallItem,
} from "../types";

const VALID_STYLES: DiscStyle[] = ["vinyl", "cd", "cassette", "cover"];

export function emptyWall(name: string, style: DiscStyle): MusicWallData {
  return { version: WALL_FILE_VERSION, name, style, items: [] };
}

/** 按 version 做 schema 迁移；未知版本尽力解析 */
function migrate(data: any): MusicWallData {
  const version: number =
    typeof data?.version === "number" ? data.version : WALL_FILE_VERSION;

  if (version > WALL_FILE_VERSION) {
    throw new Error(
      `该音乐墙文件版本为 v${version}，当前插件仅支持到 v${WALL_FILE_VERSION}，请升级插件`
    );
  }

  const style: DiscStyle = VALID_STYLES.includes(data?.style)
    ? data.style
    : "vinyl";

  const items: WallItem[] = Array.isArray(data?.items)
    ? data.items.filter(isWallItem)
    : [];

  return {
    version: WALL_FILE_VERSION,
    name: typeof data?.name === "string" && data.name ? data.name : "未命名音乐墙",
    style,
    layout: data?.layout === "list" ? "list" : undefined,
    items,
  };
}

function isWallItem(x: any): x is WallItem {
  return (
    x &&
    typeof x === "object" &&
    typeof x.albumId === "number" &&
    (x.source === "search" || x.source === "manual") &&
    typeof x.locked === "boolean" &&
    x.meta &&
    typeof x.meta.albumId === "number" &&
    typeof x.meta.name === "string" &&
    typeof x.addedAt === "string"
  );
}

export function parseWall(text: string): MusicWallData {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("文件不是合法的 JSON，无法作为音乐墙打开");
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) {
    throw new Error("文件结构不符合 .mw 音乐墙格式（缺少 items 数组）");
  }
  return migrate(raw);
}

export async function loadWall(vault: Vault, file: TFile): Promise<MusicWallData> {
  const text = await vault.read(file);
  return parseWall(text);
}

export async function saveWall(
  vault: Vault,
  file: TFile,
  data: MusicWallData
): Promise<void> {
  await vault.modify(file, JSON.stringify(data, null, 2));
}

/** 序列化为可导出文本（Git diff 友好：2 空格缩进） */
export function serializeWall(data: MusicWallData): string {
  return JSON.stringify(data, null, 2);
}

/** 按 albumId 去重插入单条目（样式跟随目标墙全局设置）。返回是否实际插入 */
export function insertItem(target: MusicWallData, item: WallItem): boolean {
  if (target.items.some((i) => i.albumId === item.albumId)) return false;
  target.items.push({ ...item, style: undefined });
  return true;
}

/** 合并另一个墙的数据，返回 {merged, addedCount, skippedCount}（按 albumId 去重） */
export function mergeWalls(
  target: MusicWallData,
  incoming: MusicWallData
): { addedCount: number; skippedCount: number } {
  const existing = new Set(target.items.map((i) => i.albumId));
  let addedCount = 0;
  let skippedCount = 0;
  for (const item of incoming.items) {
    if (existing.has(item.albumId)) {
      skippedCount++;
      continue;
    }
    target.items.push(item);
    existing.add(item.albumId);
    addedCount++;
  }
  return { addedCount, skippedCount };
}
