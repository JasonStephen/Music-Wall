// 时长格式化：单曲 "m:ss" 与整专总时长档位化展示。
// 网格/详情面板（AlbumPanelModal）与展示架开盒详情（MusicWallView）共用。

import { t } from "../i18n";

/** 毫秒 → "m:ss"（单曲时长） */
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** 曲目快照总时长（毫秒）；无有效时长返回 0 */
export function sumTrackDur(tracks?: { duration?: number }[]): number {
  if (!tracks?.length) return 0;
  return tracks.reduce((acc, t) => acc + (t.duration && t.duration > 0 ? t.duration : 0), 0);
}

/**
 * 整张专辑总时长（毫秒和）→ 档位化展示：
 *  - < 60 分钟：整数分钟（四舍五入）
 *  - 1 ~ 10 小时：小时保留 1 位小数（如 5.2 小时）
 *  - > 10 小时：只显示整数小时
 * 悬停用 fmtTotalDurTip：一律"总分钟:秒"（不显示小时，如 240:34）。
 */
export function fmtTotalDur(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const totalMin = Math.round(totalSec / 60);
  const totalHour = totalSec / 3600;
  if (totalHour > 10)
    return t("duration.hour", { value: Math.round(totalHour) });
  if (totalHour >= 1)
    return t("duration.hour", { value: totalHour.toFixed(1) });
  return t("duration.minute", { value: totalMin });
}

/** 总时长悬停提示："总分钟:秒"（秒两位补零，不显示小时） */
export function fmtTotalDurTip(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
}
