import type { MusicWallSettings, PlayerBackground, DeviceCase } from "../types";
export type PresetGroup = MusicWallSettings["playerPresetGroup"];
export const PRESET_CHOICES = { vinyl: ["classic", "white", "color"], cd: ["classic", "color"], cover: ["record", "full"], machine: ["vinyl", "colorVinyl", "cd", "colorCd"] } as const;
export function normalizePlayerPresets(settings: MusicWallSettings): void {
  if (!["vinyl", "cd", "cover", "machine", "custom"].includes(settings.playerPresetGroup)) settings.playerPresetGroup = "vinyl";
  settings.playerExperimental = settings.playerExperimental === true;
  const saved = settings.playerPresetChoices;
  settings.playerPresetChoices = { vinyl: "classic", cd: "classic", cover: "record", machine: "vinyl" };
  for (const group of Object.keys(PRESET_CHOICES) as (keyof typeof PRESET_CHOICES)[]) {
    const choice = saved?.[group];
    if ((PRESET_CHOICES[group] as readonly string[]).includes(choice)) (settings.playerPresetChoices as Record<string, string>)[group] = choice;
  }
  if (!["system", "light", "dark"].includes(settings.playerPresetTone)) settings.playerPresetTone = "system";
  settings.playerColorGlass = settings.playerColorGlass === true;
  if (!["vinyl", "cd", "cover"].includes(settings.playerCustomStyle)) settings.playerCustomStyle = "vinyl";
}
export function resolvePlayerPreset(settings: MusicWallSettings, systemDark: boolean) {
  const group = settings.playerPresetGroup || "vinyl";
  if (group === "custom") return null;
  const choice = settings.playerPresetChoices?.[group] || PRESET_CHOICES[group][0];
  const appearance = settings.playerPresetTone === "system" || !settings.playerPresetTone ? settings.libraryAppearance : settings.playerPresetTone;
  const dark = appearance === "dark" || appearance !== "light" && systemDark;
  const color = choice === "color" || choice === "colorVinyl" || choice === "colorCd" || group === "cover";
  const white = group === "vinyl" && choice === "white";
  const style: "vinyl" | "cd" | "cover" = group === "cd" || choice === "cd" || choice === "colorCd" ? "cd" : group === "cover" ? "cover" : "vinyl";
  return { group, choice, style, machine: group === "machine", background: (color ? "art" : white || !dark ? "white" : "dark") as PlayerBackground,
    deviceCase: (color ? "art" : dark ? "black" : "white") as DeviceCase,
    finish: (color ? settings.playerColorGlass ? "colorGlass" : "color" : white ? "white" : "black") as MusicWallSettings["playerVinylFinish"],
    fullCover: group === "cover" && choice === "full", tone: !color && !white,
  };
}
/** Fixed SVG paths survive mobile host button styles without icon fonts. */
export function presetIcon(host: HTMLElement, group: PresetGroup): void {
  const paths: Record<PresetGroup, string[]> = {
    vinyl: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20", "M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10", "M12 11a1 1 0 1 0 0 2 1 1 0 0 0 0-2"],
    cd: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6", "M5 5l3 3m8 8 3 3M4 9l3 1m10 4 3 1"],
    cover: ["M3 3h18v18H3z", "m3 17 6-6 4 4 3-3 5 5", "M16 6h1v1h-1z"],
    machine: ["M2 3h20v18H2z", "M10 6a6 6 0 1 0 0 12 6 6 0 0 0 0-12", "M10 11v2m9-7-1 8-3 2M18 18h2"],
    custom: ["M14 6a5 5 0 0 0-6 6L2 18a2.8 2.8 0 0 0 4 4l6-6a5 5 0 0 0 6-6l-3 3-4-4 3-3Z"],
  };
  const ns = "http://www.w3.org/2000/svg", svg = host.ownerDocument.createElementNS(ns, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", width: "20", height: "20", fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
  for (const d of paths[group]) { const path = host.ownerDocument.createElementNS(ns, "path"); path.setAttribute("d", d); svg.appendChild(path); }
  host.appendChild(svg);
}

/** Choose the higher-contrast foreground for the solid sampled cover background. */
export function presetForeground(color: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return "#ffffff";
  const channels = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
  const luma = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  return (luma + .05) / .05 >= 1.05 / (luma + .05) ? "#111111" : "#ffffff";
}
