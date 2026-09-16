// 手动排序顺序与分组分区的纯逻辑层。
// 刻意不依赖 obsidian / DOM：node 自检（tools/storecheck.ts）直接跑这一份函数。
//
// 约定：
// - MusicWallData.order 是「手动排序」下的权威展示顺序（albumId 列表，可残缺）；
// - 缺项由 normalizeOrder 追加到末尾，已删条目的 id 会被剔除；
// - 分组只影响展示分区（groupId），不影响 order 的全局顺序；
// - order 的「全局性」保证：手动顺序在加入分组、跨组拖动、取消分组后都不丢。

import { GROUP_ID_PREFIX, type WallGroup, type WallItem } from "../types";

/** 分区条目顺序的重排位置：锚点之前 / 之后 */
export type Place = "before" | "after";

/** 一个展示分区（分组或末尾的「未分组」） */
export interface WallSection {
  /** 分组 id；"" = 未分组 */
  id: string;
  name: string;
  collapsed: boolean;
  /** 该分区内已按顺序排好的条目 */
  items: WallItem[];
}

/** 未分组分区的固定 id（空串不会被 groupId 命中） */
export const UNGROUPED_ID = "";

/** 未分组分区的显示名 */
export const UNGROUPED_LABEL = "未分组";

/** 排序结果（升序时 dir=1，降序时 dir=-1） */
export function sortDir(asc: boolean): 1 | -1 {
  return asc ? 1 : -1;
}

/**
 * 归一化手动顺序：返回值恰好覆盖当前全部条目、且只覆盖它们。
 * - 保留 order 中仍然存在的 id（含其相对顺序）
 * - 剔除已删除/已迁出的 id
 * - 新条目（order 里没有、items 里有）追加到末尾，按传入 items 的顺序
 */
export function normalizeOrder(items: WallItem[], order?: number[]): number[] {
  const alive: number[] = [];
  const aliveSet = new Set<number>();
  for (const it of items) {
    if (aliveSet.has(it.albumId)) continue;
    aliveSet.add(it.albumId);
    alive.push(it.albumId);
  }
  const out: number[] = [];
  const used = new Set<number>();
  for (const raw of order ?? []) {
    const id = Number(raw);
    if (!Number.isFinite(id) || used.has(id) || !aliveSet.has(id)) continue;
    used.add(id);
    out.push(id);
  }
  for (const id of alive) if (!used.has(id)) out.push(id);
  return out;
}

/** 按手动顺序排好的 albumId 列表（order 残缺时自动补齐尾部） */
export function orderedIds(items: WallItem[], order?: number[]): number[] {
  return normalizeOrder(items, order);
}

/** 把 id 移到锚点前/后（锚点不存在或等于自身时原样返回） */
export function moveWithin(
  order: number[],
  id: number,
  anchorId: number,
  place: Place
): number[] {
  if (!order.includes(id) || id === anchorId) return [...order];
  const rest = order.filter((x) => x !== id);
  const at = rest.indexOf(anchorId);
  if (at < 0) return [...order];
  rest.splice(place === "before" ? at : at + 1, 0, id);
  return rest;
}

/**
 * 把若干 id 插入到锚点前/后（跨分组拖动与「追加到某分区」共用）。
 * @param anchorId 目标锚点；省略时追加到末尾
 * @param place 锚点不存在时按「追加到末尾」处理
 */
export function moveInto(
  order: number[],
  ids: number[],
  anchorId?: number | null,
  place: Place = "after"
): number[] {
  const moving = ids.filter((id) => Number.isFinite(id));
  if (!moving.length) return [...order];
  const movingSet = new Set(moving);
  const rest = order.filter((x) => !movingSet.has(x));
  if (anchorId == null || movingSet.has(anchorId)) {
    return [...rest, ...moving];
  }
  const at = rest.indexOf(anchorId);
  if (at < 0) return [...rest, ...moving];
  rest.splice(place === "before" ? at : at + 1, 0, ...moving);
  return rest;
}

/** 从顺序数组里移除若干 id（删除条目 / 迁出本墙时调用） */
export function removeFromOrder(order: number[], ids: number[]): number[] {
  const drop = new Set(ids);
  return order.filter((x) => !drop.has(x));
}

/** 生成不撞车的分组 id：g1 / g2 / … */
export function newGroupId(groups: WallGroup[]): string {
  let max = 0;
  for (const g of groups) {
    const m = /^g(\d+)$/.exec(g.id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${GROUP_ID_PREFIX}${max + 1}`;
}

/** 组内整体位置：返回把 groups[i] 移到锚点前/后的新数组（拖拽分组头用） */
export function moveGroup(
  groups: WallGroup[],
  id: string,
  anchorId: string,
  place: Place
): WallGroup[] {
  const from = groups.findIndex((g) => g.id === id);
  if (from < 0 || id === anchorId) return [...groups];
  const moving = groups[from];
  const rest = groups.filter((g) => g.id !== id);
  const at = rest.findIndex((g) => g.id === anchorId);
  if (at < 0) return [...groups];
  rest.splice(place === "before" ? at : at + 1, 0, moving);
  return rest;
}

/** 删除分组：返回剩余分组（组内条目由调用方一并处理） */
export function removeGroup(groups: WallGroup[], id: string): WallGroup[] {
  return groups.filter((g) => g.id !== id);
}

/**
 * 切分展示分区。
 * @param order 已排好的条目 id 顺序（getVisibleItems 的输出必须是这个顺序）
 * @param filtering 是否处于筛选/搜索态：筛选态下不显示空分区（避免一堆空标题）
 * @param ungroupedCollapsed 未分组分区是否收起（它不在 groups 里，状态单独存一位）
 * @returns 分组顺序 = groups 声明顺序 + 末尾「未分组」（仅当确实有未分组条目）
 */
export function resolveSections(
  items: WallItem[],
  groups: WallGroup[],
  order: number[],
  filtering = false,
  ungroupedCollapsed = false
): WallSection[] {
  const byId = new Map<number, WallItem>();
  for (const it of items) byId.set(it.albumId, it);
  const knownGroups = new Set(groups.map((g) => g.id));
  const buckets = new Map<string, WallItem[]>();
  for (const g of groups) buckets.set(g.id, []);
  const ungrouped: WallItem[] = [];

  for (const id of order) {
    const item = byId.get(id);
    if (!item) continue;
    const gid = item.groupId && knownGroups.has(item.groupId) ? item.groupId : "";
    if (!gid) ungrouped.push(item);
    else buckets.get(gid)!.push(item);
  }

  const sections: WallSection[] = [];
  for (const g of groups) {
    const list = buckets.get(g.id) ?? [];
    if (!list.length && filtering) continue;
    sections.push({
      id: g.id,
      name: g.name,
      collapsed: !!g.collapsed,
      items: list,
    });
  }
  // 未分组分区：有未分组条目时必出；本墙没有任何分组时也要出（作为列容器，
  // 且空墙需要它承载空态）。筛选态下没有未分组命中就不出。
  // 注意：无分组（headless）时不落收起标记——那时没有分组头，收起了就再也展不开。
  if (ungrouped.length || (!groups.length && !filtering)) {
    sections.push({
      id: UNGROUPED_ID,
      name: UNGROUPED_LABEL,
      collapsed: groups.length ? ungroupedCollapsed : false,
      items: ungrouped,
    });
  }
  return sections;
}

/** 该分区在「未分组且本墙无分组」时不需要渲染分组头 */
export function isHeadlessSection(section: WallSection, groups: WallGroup[]): boolean {
  return section.id === UNGROUPED_ID && groups.length === 0;
}
