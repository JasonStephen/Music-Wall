// 音乐墙插件的核心类型契约。
// .mw 文件即为本模块 MusicWallData 的 JSON 序列化。
import type { AudioQuality } from "./core/quality";

/** 唱片视觉样式 */
export type DiscStyle = "vinyl" | "cd" | "cassette" | "cover";

/** 墙布局：网格（默认）、多列列表或展示架 */
export type WallLayout = "grid" | "list" | "shelf";

/** 展示架布局下，专辑名称文字显示档位（全局设置） */
export type ShelfCaption = "hidden" | "pull" | "always";

/** 排序类型；manual = 手动排序（顺序存于 MusicWallData.order） */
export type SortMode = "manual" | "addedAt" | "name" | "artist" | "year" | "rating";

/** 播放器页背景模式 */
export type PlayerBackground = "white" | "dark" | "art" | "wood";
export type DeviceCase = "white" | "black" | "wood" | "art";

/** 专辑来源 */
export type AlbumSource = "search" | "manual";

/** 单曲条目（快照，离线可读） */
export interface AlbumTrackSnapshot {
  id: number;
  name: string;
  /** 时长，毫秒 */
  duration: number;
  artists?: string;
  artistRefs?: { id: number; name: string }[];
  albumId?: number;
  albumName?: string;
  cover?: string;
}

/** 专辑元数据快照 */
export interface AlbumMeta {
  albumId: number;
  playlistId?: number;
  /** Runtime playback origin; never written back to the source wall. */
  playbackWallPath?: string;
  name: string;
  artist: string;
  artistRefs?: { id: number; name: string }[];
  /** 原始封面 URL（网易云） */
  cover: string;
  /** 发行时间戳（毫秒） */
  publishTime?: number;
  /** 发行年份，展示用 */
  year?: string;
  /** 曲目数 */
  trackCount: number;
  company?: string;
  description?: string;
  tags?: string[];
  /** 曲目快照，用于播放与详情展示 */
  tracks?: AlbumTrackSnapshot[];
}

/** 一面墙里的一个条目 */
export interface WallItem {
  albumId: number;
  source: AlbumSource;
  /** 锁定：禁止元数据编辑（搜索导入默认 true） */
  locked: boolean;
  /** @deprecated 单卡样式已废弃：渲染一律跟随墙级全局样式，此字段仅为旧文件保留 */
  style?: DiscStyle;
  /** 用户曾手动编辑过元数据（解锁编辑后 true） */
  metaEdited?: boolean;
  meta: AlbumMeta;
  /** ISO 时间，添加时间 */
  addedAt: string;
  /** 评分 1–5；缺省/缺失 = 未评分 */
  rating?: number;
  /** 所属分组 id；缺省 = 未分组（始终显示在最后一个分区） */
  groupId?: string;
}

/** 照片墙分组：可折叠、可重命名、可整体拖拽换序 */
export interface WallGroup {
  id: string;
  name: string;
  /** 收起状态（落盘，重开保持） */
  collapsed?: boolean;
}

/**
 * 视图状态（落盘，重开标签页保持）：
 * 排序类型与升降序彻底分离，筛选为多值（同维度 OR、维度间 AND）。
 */
export interface WallViewState {
  /** 排序类型，缺省 addedAt */
  sortMode?: SortMode;
  /** true = 升序；缺省 true（addedAt + 升序 == 最新在前） */
  sortAsc?: boolean;
  /** 多选艺术家（空/缺省 = 不限） */
  filterArtists?: string[];
  /** 多选年代，如 ["2010s"]（空/缺省 = 不限） */
  filterDecades?: string[];
  /** 多选标签（空/缺省 = 不限） */
  filterTags?: string[];
  /** 多选评分 1–5，0 = 未评分（空/缺省 = 不限） */
  filterRatings?: number[];
}

/** .mw 文件结构 */
export interface MusicWallData {
  version: number;
  name: string;
  /** 全局默认样式 */
  style: DiscStyle;
  /** 布局模式；缺省 = grid（旧文件兼容） */
  layout?: WallLayout;
  items: WallItem[];
  /** 分组定义；缺省 = 未分组 */
  groups?: WallGroup[];
  /** 「未分组」分区的收起状态（落盘，重开保持；它没有 WallGroup 记录，单独存一位） */
  ungroupedCollapsed?: boolean;
  /** 手动排序顺序（albumId 列表）；缺省时按视图排序，首次拖动时补齐 */
  order?: number[];
  /** 视图状态（排序/筛选） */
  view?: WallViewState;
}

/** 搜索结果里的专辑摘要 */
export interface AlbumSummary {
  albumId: number;
  name: string;
  artist: string;
  artistRefs?: { id: number; name: string; cover?: string }[];
  cover: string;
  trackCount: number;
  publishTime?: number;
  year?: string;
  size?: number;
  company?: string;
  briefDesc?: string;
}

/** 插件设置 */
export interface MusicWallSettings {
  /** 界面语言：system = 跟随 Obsidian 界面语言（zh → 简中，zh-TW → 繁中，其他 → 英文） */
  language?: "system" | "zh-CN" | "zh-TW" | "en";
  /** Git 远程仓库地址（用于音乐墙推送和拉取） */
  gitRepoUrl: string;
  /** Git 分支，留空用仓库默认分支 */
  gitBranch: string;
  /** 仓库内存放 .mw 的相对子目录，留空表示根目录 */
  gitSubdir: string;
  /** Vault-relative root mapped to gitSubdir. Empty means the vault root. */
  gitLocalDir: string;
  /** Account name only; OAuth credentials stay in the system Git credential manager. */
  githubAccount: string;
  /** 默认列宽 px（网格最小列宽），影响一屏显示几张 */
  minColumnWidth: number;
  /** 新建墙时的默认样式 */
  defaultStyle: DiscStyle;
  /** 扫码取得的网易云登录凭据；兼容旧版手动填写的 Cookie。 */
  neteaseCookie: string;
  neteaseUserId: string;
  neteaseNickname: string;
  /** 播放用歌单 ID（配合 Cookie 实现整张专辑连播） */
  playbackPlaylistId: string;
  /** 插件内播放不使用账号歌单；client 保留原官方客户端播放路径。 */
  playbackMode: "internal" | "client";
  defaultAudioQuality: AudioQuality;
  /** 是否启用数字键按百分比跳转（实验功能） */
  numericSeekEnabled: boolean;
  /** 是否已提示过移动端限制 */
  mobileNoticeShown: boolean;
  /** 展示架布局下文字显示档位 */
  shelfCaption: ShelfCaption;
  /** 是否启用 SMTC 正在播放（仅 Windows 桌面端生效） */
  smtcEnabled: boolean;
  /** 播放器页背景模式 */
  playerExperimental: boolean;
  playerPresetGroup: "vinyl" | "cd" | "cover" | "machine" | "custom";
  playerPresetChoices: { vinyl: "classic" | "white" | "color"; cd: "classic" | "color"; cover: "record" | "full"; machine: "vinyl" | "colorVinyl" | "cd" | "colorCd" };
  playerPresetTone: "system" | "light" | "dark";
  playerColorGlass: boolean;
  playerCustomStyle: "vinyl" | "cd" | "cover";
  playerBackground: PlayerBackground;
  playerCase: DeviceCase;
  playerVolume: number;
  playbackOrder: "order" | "repeat" | "one" | "shuffle";
  playerVinylMachine: boolean;
  playerCdMachine: boolean;
  playerVinylFinish: "black" | "white" | "color" | "blackGlass" | "whiteGlass" | "colorGlass";
  pauseFadeSeconds: number;
  crossFadeSeconds: number;
  audioCacheMB: number;
  lyricsTranslation: boolean;
  libraryAppearance: "system" | "light" | "dark";
  libraryLayout?: "grid" | "list";
  artistAlbumHideSingles: boolean;
  artistAlbumHideRemixes: boolean;
  artistAlbumTrackLimit: number;
  artistAlbumKeywords: string;
  wallAppearance: "system" | "light" | "dark";
  showGitSyncActions: boolean;
  /**
   * 界面缩放（1 = 100%）。对音乐墙与播放器页全局生效，
   * 含侧边抽屉与模态框；可在设置里调，也可在视图内 Ctrl/Alt + 滚轮调。
   */
  zoomScale: number;
}

export const DEFAULT_SETTINGS: MusicWallSettings = {
  language: "system",
  gitRepoUrl: "",
  gitBranch: "",
  gitSubdir: "",
  gitLocalDir: "",
  githubAccount: "",
  minColumnWidth: 180,
  defaultStyle: "vinyl",
  neteaseCookie: "",
  neteaseUserId: "",
  neteaseNickname: "",
  playbackPlaylistId: "",
  playbackMode: "internal",
  defaultAudioQuality: "standard",
  numericSeekEnabled: false,
  mobileNoticeShown: false,
  shelfCaption: "pull",
  smtcEnabled: true,
  playerExperimental: false,
  playerPresetGroup: "vinyl",
  playerPresetChoices: { vinyl: "classic", cd: "classic", cover: "record", machine: "vinyl" },
  playerPresetTone: "system",
  playerColorGlass: false,
  playerCustomStyle: "vinyl",
  playerBackground: "dark",
  playerCase: "black",
  playerVolume: 1,
  playbackOrder: "order",
  playerVinylMachine: true,
  playerCdMachine: true,
  playerVinylFinish: "black",
  pauseFadeSeconds: 0.3,
  crossFadeSeconds: 2,
  audioCacheMB: 1024,
  lyricsTranslation: false,
  libraryAppearance: "system",
  artistAlbumHideSingles: false,
  artistAlbumHideRemixes: false,
  artistAlbumTrackLimit: 1,
  artistAlbumKeywords: "remix",
  wallAppearance: "system",
  showGitSyncActions: false,
  zoomScale: 1,
};

/** 缩放范围与步进（设置页滑块与 Ctrl/Alt + 滚轮共用） */
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 2;
export const ZOOM_STEP = 0.05;

/** 夹取到合法缩放区间（保留两位小数，避免浮点噪声写进设置） */
export function clampZoom(v: number): number {
  if (!Number.isFinite(v)) return 1;
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
  return Math.round(clamped * 100) / 100;
}

/** 画布缩放用的 CSS 变量名（设在 body 上，模态框也能继承） */
export const ZOOM_CSS_VAR = "--mw-zoom";

/** 当前 .mw 文件 schema 版本（v2：新增 groups / order / view） */
export const WALL_FILE_VERSION = 2;
/** 分组 id 前缀 */
export const GROUP_ID_PREFIX = "g";
/** 文件扩展名 */
export const WALL_EXT = "mw";
/** ItemView 类型标识 */
export const WALL_VIEW_TYPE = "music-wall-view";
/** 唱片卡片跨墙拖拽的 DataTransfer MIME */
export const WALL_DRAG_MIME = "application/x-music-wall-item";

/** 播放器视图类型标识 */
export const PLAYER_VIEW_TYPE = "music-wall-player";
export const LIBRARY_VIEW_TYPE = "music-wall-library";
