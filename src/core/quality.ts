import { t } from "../i18n";

export const AUDIO_QUALITIES = ["standard", "higher", "exhigh", "lossless", "hires"] as const;
export type AudioQuality = typeof AUDIO_QUALITIES[number];
export function isAudioQuality(value: unknown): value is AudioQuality {
  return AUDIO_QUALITIES.includes(value as AudioQuality);
}
export function qualityLabel(quality: AudioQuality): string { return t(`quality.${quality}`); }
export function atMost(quality: AudioQuality, ceiling: AudioQuality): boolean {
  return AUDIO_QUALITIES.indexOf(quality) <= AUDIO_QUALITIES.indexOf(ceiling);
}
