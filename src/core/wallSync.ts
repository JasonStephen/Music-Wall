import { t } from "../i18n";
import { parseWall } from "./store";

export type SyncDirection = "push" | "pull";
export interface WallSyncFile { path: string; content: string; }
export type SyncStatus = "new" | "changed" | "same" | "kept" | "invalid";
export interface WallSyncRow { path: string; local?: WallSyncFile; remote?: WallSyncFile; status: SyncStatus; error?: string; }
export interface WallSyncPlan { direction: SyncDirection; rows: WallSyncRow[]; }

/** Only portable, visible paths inside the chosen directory are eligible. */
export function syncPath(value: string): string {
  const path = value.trim().replace(/\\/g, "/").replace(/\/$/, "");
  if (!path) return "";
  if (path.split("/").some(part => !part || part.startsWith(".") || /[<>:"|?*\x00-\x1f]/.test(part)
    || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(t("gitSync.badPath", { path: value }));
  return path;
}
export function inSyncDirectory(path: string, directory: string): boolean { return !directory || path.startsWith(`${directory}/`); }
export function joinSyncPath(directory: string, path: string): string { return syncPath(directory ? `${directory}/${path}` : path); }

export function buildSyncPlan(direction: SyncDirection, local: WallSyncFile[], remote: WallSyncFile[]): WallSyncPlan {
  const index = (files: WallSyncFile[]) => {
    const result = new Map<string, WallSyncFile>();
    for (const file of files) {
      if (!file.path.endsWith(".mw") || syncPath(file.path) !== file.path || result.has(file.path)) throw new Error(t("gitSync.badPath", { path: file.path }));
      result.set(file.path, file);
    }
    return result;
  };
  const locals = index(local), remotes = index(remote);
  const paths = [...new Set([...locals.keys(), ...remotes.keys()])].sort((a, b) => a.localeCompare(b));
  const folded = new Set<string>();
  for (const path of paths) {
    const key = path.toLowerCase();
    if (folded.has(key)) throw new Error(t("gitSync.caseCollision", { path }));
    folded.add(key);
  }
  const rows = paths.map(path => {
    const local = locals.get(path), remote = remotes.get(path);
    const source = direction === "push" ? local : remote, target = direction === "push" ? remote : local;
    const row: WallSyncRow = { path, local, remote, status: !source ? "kept" : !target ? "new" : source.content === target.content ? "same" : "changed" };
    if (source) { try { parseWall(source.content); } catch (error) { row.status = "invalid"; row.error = (error as Error).message; } }
    return row;
  });
  return { direction, rows };
}
export function canSelectSyncRow(row: WallSyncRow): boolean { return row.status !== "kept" && row.status !== "invalid"; }
export function defaultSyncSelection(plan: WallSyncPlan, selectedDirectory = false): Set<string> {
  return new Set(plan.rows.filter(row => canSelectSyncRow(row) && (plan.direction === "pull" || selectedDirectory || row.path.includes("/"))).map(row => row.path));
}
export function selectedSyncChanges(plan: WallSyncPlan, selected: Set<string>): WallSyncRow[] {
  return plan.rows.filter(row => selected.has(row.path) && (row.status === "new" || row.status === "changed"));
}
export interface WallSyncIO {
  read(path: string): Promise<string | null>;
  /** Compare and write atomically, including the nonexistence check for new files. */
  write(path: string, content: string, expected: string | null): Promise<void>;
  backup(files: WallSyncFile[]): Promise<void>;
}
export async function checkLocalSnapshot(rows: WallSyncRow[], io: WallSyncIO): Promise<void> {
  for (const row of rows) if (await io.read(row.path) !== (row.local?.content ?? null)) throw new Error(t("gitSync.localChanged", { path: row.path }));
}
export async function applyWallPull(plan: WallSyncPlan, selected: Set<string>, io: WallSyncIO): Promise<number> {
  if (plan.direction !== "pull") throw new Error("Expected a pull plan");
  const rows = selectedSyncChanges(plan, selected);
  await checkLocalSnapshot(rows, io);
  await io.backup(rows.flatMap(row => row.local ? [row.local] : []));
  let written = 0;
  try {
    for (const row of rows) { await io.write(row.path, row.remote!.content, row.local?.content ?? null); written++; }
  } catch (error) { throw new Error(t("gitSync.partial", { count: written, error: (error as Error).message })); }
  return written;
}
export interface WallChangeSummary { added: number; removed: number; updated: number; settings: boolean; }
export function summarizeWallChange(before?: WallSyncFile, after?: WallSyncFile): WallChangeSummary | null {
  try {
    const old = before ? parseWall(before.content) : null, next = after ? parseWall(after.content) : null;
    const a = new Map(old?.items.map(item => [item.albumId, item]) ?? []), b = new Map(next?.items.map(item => [item.albumId, item]) ?? []);
    const settings = (wall: typeof old) => wall ? JSON.stringify({ ...wall, items: undefined }) : "";
    return {
      added: [...b.keys()].filter(id => !a.has(id)).length,
      removed: [...a.keys()].filter(id => !b.has(id)).length,
      updated: [...b].filter(([id, item]) => a.has(id) && JSON.stringify(a.get(id)) !== JSON.stringify(item)).length,
      settings: settings(old) !== settings(next),
    };
  } catch { return null; }
}
/** Bounded LCS for highlighting; large changes use common prefix/suffix instead. */
export function changedLineSets(before: string, after: string): [Set<number>, Set<number>] {
  const a = before.split("\n"), b = after.split("\n"), left = new Set(a.map((_, i) => i)), right = new Set(b.map((_, i) => i));
  if (a.length * b.length <= 500_000) {
    const width = b.length + 1, grid = new Uint32Array((a.length + 1) * width);
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) grid[i * width + j] = a[i] === b[j] ? grid[(i + 1) * width + j + 1] + 1 : Math.max(grid[(i + 1) * width + j], grid[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { left.delete(i++); right.delete(j++); }
      else if (grid[(i + 1) * width + j] >= grid[i * width + j + 1]) i++; else j++;
    }
  } else {
    let start = 0, end = 0;
    while (start < Math.min(a.length, b.length) && a[start] === b[start]) { left.delete(start); right.delete(start++); }
    while (end < Math.min(a.length, b.length) - start && a[a.length - end - 1] === b[b.length - end - 1]) { left.delete(a.length - end - 1); right.delete(b.length - end++ - 1); }
  }
  return [left, right];
}
