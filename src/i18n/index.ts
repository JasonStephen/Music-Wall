// 轻量 i18n：嵌套字典 + 点路径 t() + 参数插值（{name}）。
// 简体中文为基准/回退语言；三种语言的字典结构由 TypeScript 的 typeof 约束强制对齐，
// 缺 key 会在编译期报错。
//
// 「跟随系统」= 跟随 Obsidian 界面语言（getLanguage，1.8.7+；低版本回退 localStorage.language）。

import { zhCN } from "./zh-CN";
import { zhTW } from "./zh-TW";
import { en } from "./en";
import type {
  DiscStyle,
  PlayerBackground,
  ShelfCaption,
  SortMode,
  WallLayout,
} from "../types";

/** 实际支持的语言 */
export type LangCode = "zh-CN" | "zh-TW" | "en";
/** 设置项里的语言偏好：system = 跟随 Obsidian 界面语言 */
export type LanguagePref = "system" | LangCode;

/** 消息表类型（以简中为基准结构） */
export type Messages = typeof zhCN;

const DICTS: Record<LangCode, Messages> = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
};

/** 当前生效语言（模块级单例；initial 即回退语言，无需初始化即可工作） */
let current: LangCode = "zh-CN";

export function getActiveLang(): LangCode {
  return current;
}

/** 直接指定生效语言（main.ts 在载入设置后调用） */
export function setLanguage(lang: LangCode): void {
  current = lang;
}

/** 读取 Obsidian 界面语言（getLanguage / localStorage 双路兜底） */
function detectObsidianLang(): string {
  try {
    // getLanguage 存在于 1.8.7+，低版本（minAppVersion 1.5.0）走回退
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getLanguage } = require("obsidian") as {
      getLanguage?: () => string;
    };
    if (typeof getLanguage === "function") {
      const v = getLanguage();
      if (typeof v === "string" && v) return v;
    }
  } catch {
    /* 忽略，走回退 */
  }
  try {
    return window.localStorage.getItem("language") ?? "en";
  } catch {
    return "en";
  }
}

/**
 * 语言偏好 → 实际语言：
 * - zh-TW / zh-HK / zh-Hant* → 繁中；其余 zh* → 简中；非中文 → 英文。
 */
export function resolveLang(pref: LanguagePref): LangCode {
  const raw = pref === "system" ? detectObsidianLang() : pref;
  if (/^zh([-_]?(tw|hk|mo|hant))/i.test(raw)) return "zh-TW";
  if (/^zh/i.test(raw)) return "zh-CN";
  return "en";
}

/** 按偏好生效语言（设置加载/变更时调用） */
export function applyLanguagePref(pref: LanguagePref): LangCode {
  const lang = resolveLang(pref);
  setLanguage(lang);
  return lang;
}

function lookup(dict: unknown, key: string): string | undefined {
  let node: unknown = dict;
  for (const seg of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return typeof node === "string" ? node : undefined;
}

/**
 * 取翻译。参数插值用 {name} 占位；当前语言缺 key 回退简中，再缺回显 key 本身。
 */
export function t(
  key: string,
  params?: Record<string, string | number>
): string {
  let s = lookup(DICTS[current], key) ?? lookup(DICTS["zh-CN"], key) ?? key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

// ---- 枚举值 → 文案 的便捷映射（替代原 types.ts / disc.ts 里的 *_LABELS 常量） ----

export function styleLabel(s: DiscStyle): string {
  return t(`labels.style.${s}`);
}
export function layoutLabel(l: WallLayout): string {
  return t(`labels.layout.${l}`);
}
export function sortLabel(k: SortMode): string {
  return t(`labels.sort.${k}`);
}
export function playerBgLabel(b: PlayerBackground): string {
  return t(`labels.bg.${b}`);
}
export function shelfCaptionLabel(c: ShelfCaption): string {
  return t(`labels.caption.${c}`);
}
