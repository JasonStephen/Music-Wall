// 音乐墙插件的核心类型契约。
// .mw 文件即为本模块 MusicWallData 的 JSON 序列化。

/** 唱片视觉样式 */
export type DiscStyle = "vinyl" | "cd" | "cassette" | "cover";

/** 墙布局：网格（默认）或多列列表 */
export type WallLayout = "grid" | "list";

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
};

/** 当前 .mw 文件 schema 版本 */
export const WALL_FILE_VERSION = 1;
/** 文件扩展名 */
export const WALL_EXT = "mw";
/** ItemView 类型标识 */
export const WALL_VIEW_TYPE = "music-wall-view";
/** 唱片卡片跨墙拖拽的 DataTransfer MIME */
export const WALL_DRAG_MIME = "application/x-music-wall-item";
