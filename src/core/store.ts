// .mw 文件的读写、解析与 schema 迁移。

import type { Vault, TFile } from "obsidian";
import {
  WALL_FILE_VERSION,
  type DiscStyle,
  type MusicWallData,
  type SortMode,
  type WallGroup,
  type WallItem,
  type WallViewState,
} from "../types";
import { normalizeOrder } from "./layout";
import { t } from "../i18n";

const VALID_STYLES: DiscStyle[] = ["vinyl", "cd", "cassette", "cover"];
const VALID_SORT_MODES: SortMode[] = ["manual", "addedAt", "name", "artist", "year", "rating"];

export function emptyWall(name: string, style: DiscStyle): MusicWallData {
  return { version: WALL_FILE_VERSION, name, style, items: [] };
}

/** 字符串数组清洗：去非字符串、去空串、去重 */
function cleanStringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (!s || out.includes(s)) continue;
    out.push(s);
  }
  return out.length ? out : undefined;
}

/** 分组数组校验（丢弃非法项） */
function cleanGroups(v: unknown): WallGroup[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: WallGroup[] = [];
  const seen = new Set<string>();
  for (const raw of v as any[]) {
    if (!raw || typeof raw !== "object") continue;
    const id = typeof raw.id === "string" ? raw.id.trim() : "";
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, collapsed: raw.collapsed === true ? true : undefined });
  }
  return out.length ? out : undefined;
}

/** 评分清洗：仅接受 1–5 整数，否则视为未评分 */
function cleanRating(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5 ? v : undefined;
}

/** 评分筛选清洗：仅接受 0–5 整数（0 = 未评分），去重 */
function cleanRatings(v: unknown): number[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: number[] = [];
  for (const raw of v) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw > 5) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out.length ? out : undefined;
}

/** 视图状态校验（未知键丢弃） */
function cleanView(v: unknown): WallViewState | undefined {
  if (!v || typeof v !== "object") return undefined;
  const raw = v as any;
  const out: WallViewState = {};
  if (VALID_SORT_MODES.includes(raw.sortMode)) out.sortMode = raw.sortMode;
  if (typeof raw.sortAsc === "boolean") out.sortAsc = raw.sortAsc;
  const artists = cleanStringList(raw.filterArtists);
  if (artists) out.filterArtists = artists;
  const decades = cleanStringList(raw.filterDecades);
  if (decades) out.filterDecades = decades;
  const tags = cleanStringList(raw.filterTags);
  if (tags) out.filterTags = tags;
  const ratings = cleanRatings(raw.filterRatings);
  if (ratings) out.filterRatings = ratings;
  return Object.keys(out).length ? out : undefined;
}

/** 按 version 做 schema 迁移；未知版本尽力解析 */
function migrate(data: any): MusicWallData {
  const version: number =
    typeof data?.version === "number" ? data.version : WALL_FILE_VERSION;

  if (version > WALL_FILE_VERSION) {
    throw new Error(
      t("storeErr.versionTooNew", {
        version,
        max: WALL_FILE_VERSION,
      })
    );
  }

  const style: DiscStyle = VALID_STYLES.includes(data?.style)
    ? data.style
    : "vinyl";

  const items: WallItem[] = Array.isArray(data?.items)
    ? data.items.filter(isWallItem)
    : [];

  // 评分只认 1–5 整数：脏值（字符串/小数/越界）一律按未评分处理并丢弃字段
  for (const it of items) {
    const r = cleanRating((it as { rating?: unknown }).rating);
    if (r === undefined) delete it.rating;
    else it.rating = r;
  }

  const groups = cleanGroups(data?.groups);

  // 孤儿 groupId（指向不存在的分组）统一退回未分组，避免条目从所有分区里消失
  if (groups) {
    const known = new Set(groups.map((g) => g.id));
    for (const it of items) {
      if (it.groupId && !known.has(it.groupId)) delete it.groupId;
    }
  } else {
    for (const it of items) delete it.groupId;
  }

  // order 只在文件里确实存在时才保留：v1 文件读入后不会凭空多出 order 字段，
  // 手动排序首次真正生效时再由视图层补齐（避免无意义的 git diff）。
  // 只接受真正的数字：Number(null) === 0、Number("") === 0，用转换会把脏值洗成合法 id
  const order = Array.isArray(data?.order)
    ? data.order.filter((x: unknown) => typeof x === "number" && Number.isFinite(x))
    : undefined;

  return {
    version: WALL_FILE_VERSION,
    name: typeof data?.name === "string" && data.name ? data.name : "未命名音乐墙",
    style,
    layout: data?.layout === "list" || data?.layout === "shelf" ? data.layout : undefined,
    items,
    groups,
    // 「未分组」分区没有 WallGroup 记录，它的收起状态单独存一位。
    // 没有分组时未分组分区是无头的（连标题都不渲染），这时不保留该状态。
    ungroupedCollapsed: groups && data?.ungroupedCollapsed === true ? true : undefined,
    order,
    view: cleanView(data?.view),
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
    throw new Error(t("storeErr.notJson"));
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.items)) {
    throw new Error(t("storeErr.badStructure"));
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

/** 迁入条目的分组归属：目标墙存在同名分组才保留，否则退回未分组（不会消失） */
function adaptGroupId(target: MusicWallData, item: WallItem): string | undefined {
  if (!item.groupId) return undefined;
  return (target.groups ?? []).some((g) => g.id === item.groupId)
    ? item.groupId
    : undefined;
}

/** 按 albumId 去重插入单条目（样式跟随目标墙全局设置）。返回是否实际插入 */
export function insertItem(target: MusicWallData, item: WallItem): boolean {
  if (target.items.some((i) => i.albumId === item.albumId)) return false;
  target.items.push({ ...item, style: undefined, groupId: adaptGroupId(target, item) });
  if (target.order) target.order = normalizeOrder(target.items, target.order);
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
    target.items.push({
      ...item,
      style: undefined,
      groupId: adaptGroupId(target, item),
    });
    existing.add(item.albumId);
    addedCount++;
  }
  if (addedCount && target.order) {
    target.order = normalizeOrder(target.items, target.order);
  }
  return { addedCount, skippedCount };
}
