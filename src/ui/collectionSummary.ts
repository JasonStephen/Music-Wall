import type { AlbumMeta } from "../types";
import { t } from "../i18n";

export interface CollectionStats { count: number; duration?: number; }
export function collectionStats(collection: AlbumMeta): CollectionStats {
  const tracks = collection.tracks || [];
  const count = Math.max(collection.trackCount || 0, tracks.length);
  return { count, duration: count === tracks.length && tracks.every(track => Number.isFinite(track.duration) && track.duration >= 0)
    ? tracks.reduce((sum, track) => sum + track.duration, 0) : undefined };
}
export function statsSummary(stats: CollectionStats, pending = false): string {
  const duration = stats.duration;
  if (duration === undefined) return t("libraryDetails.summary", { count: stats.count,
    duration: t(pending ? "libraryDetails.durationLoading" : "libraryDetails.durationUnavailable") });
  const hours = duration >= 3600000;
  const value = Number((duration / (hours ? 3600000 : 60000)).toFixed(1));
  return t("libraryDetails.summary", { count: stats.count, duration: t(hours ? "libraryDetails.hours" : "libraryDetails.minutes", { value }) });
}
export function collectionSummary(collection: AlbumMeta): string {
  const tracks = collection.tracks || [];
  const duration = tracks.reduce((sum, track) => sum + (Number.isFinite(track.duration) ? Math.max(0, track.duration) : 0), 0);
  const hours = duration >= 3600000;
  const value = Number((duration / (hours ? 3600000 : 60000)).toFixed(1));
  return t("libraryDetails.summary", { count: tracks.length, duration: t(hours ? "libraryDetails.hours" : "libraryDetails.minutes", { value }) });
}
