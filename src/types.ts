// 音乐墙插件的核心类型契约。
// .mw 文件即为本模块 MusicWallData 的 JSON 序列化。

/** 唱片视觉样式 */
export type DiscStyle = "vinyl" | "cd" | "cassette" | "cover";

/** 墙布局：网格（默认）、多列列表或展示架 */
export type WallLayout = "grid" | "list" | "shelf";

/** 展示架布局下，专辑名称文字显示档位（全局设置） */
export type ShelfCaption = "hidden" | "pull" | "always";

/** 布局模式的中文标签（工具栏样式面板与设置页共用） */
export const LAYOUT_LABELS: Record<WallLayout, string> = {
  grid: "网格",
  list: "列表",
  shelf: "展示架",
};

/** 排序类型；manual = 手动排序（顺序存于 MusicWallData.order） */
export type SortMode = "manual" | "addedAt" | "name" | "artist" | "year";

/** 排序类型的中文标签（排序面板与旧工具栏共用） */
export const SORT_LABELS: Record<SortMode, string> = {
  manual: "手动排序",
  addedAt: "添加时间",
  name: "专辑名",
  artist: "艺术家",
  year: "发行时间",
};

/** 播放器页背景模式 */
export type PlayerBackground = "white" | "dark" | "art" | "wood";

/** 播放器背景模式的中文标签（播放器芯片与设置页共用） */
export const PLAYER_BG_LABELS: Record<PlayerBackground, string> = {
  white: "白色",
  dark: "深色",
  art: "封面",
  wood: "木地板",
};

/** 专辑来源 */
export type AlbumSource = "search" | "manual";

/** 单曲条目（快照，离线可读） */
export interface AlbumTrackSnapshot {
  id: number;
  name: string;
  /** 时长，毫秒 */
  duration: number;
  artists?: string;
}

/** 专辑元数据快照 */
export interface AlbumMeta {
  albumId: number;
  name: string;
  artist: string;
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
  /** Git 远程仓库地址（用于 Git 导入） */
  gitRepoUrl: string;
  /** Git 分支，留空用仓库默认分支 */
  gitBranch: string;
  /** 仓库内存放 .mw 的相对子目录，留空表示根目录 */
  gitSubdir: string;
  /** 默认列宽 px（网格最小列宽），影响一屏显示几张 */
  minColumnWidth: number;
  /** 新建墙时的默认样式 */
  defaultStyle: DiscStyle;
  /** 网易云 Cookie（可选，提升结果完整度；配置后可写入歌单整专连播） */
  neteaseCookie: string;
  /** 播放用歌单 ID（配合 Cookie 实现整张专辑连播） */
  playbackPlaylistId: string;
  /** 是否已提示过移动端限制 */
  mobileNoticeShown: boolean;
  /** 展示架布局下文字显示档位 */
  shelfCaption: ShelfCaption;
  /** 是否启用 SMTC 正在播放（仅 Windows 桌面端生效） */
  smtcEnabled: boolean;
  /** 播放器页背景模式 */
  playerBackground: PlayerBackground;
}

export const DEFAULT_SETTINGS: MusicWallSettings = {
  gitRepoUrl: "",
  gitBranch: "",
  gitSubdir: "",
  minColumnWidth: 180,
  defaultStyle: "vinyl",
  neteaseCookie: "",
  playbackPlaylistId: "",
  mobileNoticeShown: false,
  shelfCaption: "pull",
  smtcEnabled: true,
  playerBackground: "dark",
};

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

/** 播放器文件扩展名（.mwp，仅作播放器页标记，不存播放数据） */
export const PLAYER_EXT = "mwp";
/** 播放器视图类型标识 */
export const PLAYER_VIEW_TYPE = "music-wall-player";
/** 播放器文件 schema 版本 */
export const PLAYER_FILE_VERSION = 1;

/** 播放器文件内容：仅标记，队列为运行时状态不落盘 */
export interface PlayerFile {
  version: number;
}
