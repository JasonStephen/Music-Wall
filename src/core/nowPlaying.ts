// Windows SMTC 正在播放服务。
// 通过常驻 PowerShell 进程读取 Windows.Media.Control 会话（1s 轮询），
// 控制命令按需另起一次性进程下发。非 Windows / 非 Electron 环境为空实现。
//
// 实测（网易云 2026）：SMTC 只发布 曲名 / 歌手 / 播放状态 与控制能力；
// 专辑名、封面、时间轴均不发布（durationMs=0、seekable=false），消费端需自行降级。

import { Platform } from "obsidian";
import { SMTC_SCRIPT } from "./smtcScript";

export type PlaybackStatus = "playing" | "paused" | "stopped" | "none";

export interface NowPlayingState {
  /** 平台/环境是否支持 SMTC */
  supported: boolean;
  /** 是否检测到媒体会话 */
  active: boolean;
  title: string;
  artist: string;
  album: string;
  status: PlaybackStatus;
  positionMs: number;
  durationMs: number;
  /** 会话是否支持改变播放位置（网易云实测 false） */
  seekable: boolean;
  canPlay: boolean;
  canPause: boolean;
  canToggle: boolean;
  canNext: boolean;
  canPrev: boolean;
}

export const EMPTY_NOW_PLAYING: NowPlayingState = {
  supported: false,
  active: false,
  title: "",
  artist: "",
  album: "",
  status: "none",
  positionMs: 0,
  durationMs: 0,
  seekable: false,
  canPlay: false,
  canPause: false,
  canToggle: false,
  canNext: false,
  canPrev: false,
};

export type NowPlayingListener = (state: NowPlayingState) => void;

export interface NowPlayingProvider {
  readonly supported: boolean;
  readonly state: NowPlayingState;
  start(): void;
  stop(): void;
  on(listener: NowPlayingListener): () => void;
  play(): Promise<boolean>;
  pause(): Promise<boolean>;
  toggle(): Promise<boolean>;
  next(): Promise<boolean>;
  prev(): Promise<boolean>;
  seek(positionMs: number): Promise<boolean>;
}

const POLL_INTERVAL_MS = 900;
const MAX_RESTARTS = 4;

function requireNode(): {
  cp: typeof import("child_process");
  fs: typeof import("fs");
  os: typeof import("os");
  path: typeof import("path");
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return {
      cp: require("child_process"),
      fs: require("fs"),
      os: require("os"),
      path: require("path"),
    };
  } catch {
    return null;
  }
}

/** Obsidian 桌面端（Electron）内才可用：普通 node（含自检脚本）直接判为不支持 */
function inElectron(): boolean {
  try {
    const p = (globalThis as unknown as { process?: { versions?: Record<string, string> } })
      .process;
    return !!(p?.versions?.electron);
  } catch {
    return false;
  }
}

function powershellPath(pathMod: typeof import("path")): string {
  const root = process.env.SystemRoot || "C:\\Windows";
  return pathMod.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function asStatus(v: unknown): PlaybackStatus {
  return v === "playing" || v === "paused" || v === "stopped" ? v : "none";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function bool(v: unknown): boolean {
  return v === true;
}

/** 由脚本 JSON 行构造状态；非法/缺字段一律降级为安全值 */
function stateFromJson(raw: any): NowPlayingState | null {
  if (!raw || typeof raw !== "object") return null;
  if (raw.supported === false) return null;
  if (raw.active !== true) {
    return { ...EMPTY_NOW_PLAYING, supported: true, active: false, status: "none" };
  }
  return {
    supported: true,
    active: true,
    title: typeof raw.title === "string" ? raw.title : "",
    artist: typeof raw.artist === "string" ? raw.artist : "",
    album: typeof raw.album === "string" ? raw.album : "",
    status: asStatus(raw.status),
    positionMs: num(raw.positionMs),
    durationMs: num(raw.durationMs),
    seekable: bool(raw.seekable),
    canPlay: bool(raw.canPlay),
    canPause: bool(raw.canPause),
    canToggle: bool(raw.canToggle),
    canNext: bool(raw.canNext),
    canPrev: bool(raw.canPrev),
  };
}

/** 空实现：非 Windows/非桌面端，页面显示占位、墙不高亮 */
class NullNowPlayingProvider implements NowPlayingProvider {
  readonly supported = false;
  readonly state: NowPlayingState = { ...EMPTY_NOW_PLAYING };

  start(): void {
    /* no-op */
  }
  stop(): void {
    /* no-op */
  }
  on(): () => void {
    return () => undefined;
  }
  async play(): Promise<boolean> {
    return false;
  }
  async pause(): Promise<boolean> {
    return false;
  }
  async toggle(): Promise<boolean> {
    return false;
  }
  async next(): Promise<boolean> {
    return false;
  }
  async prev(): Promise<boolean> {
    return false;
  }
  async seek(): Promise<boolean> {
    return false;
  }
}

class WindowsSmtcProvider implements NowPlayingProvider {
  readonly supported = true;
  state: NowPlayingState = { ...EMPTY_NOW_PLAYING, supported: true };

  private node: NonNullable<ReturnType<typeof requireNode>>;
  private psExe: string;
  private scriptPath: string;
  private scriptOk = false;

  private pollChild: import("child_process").ChildProcess | null = null;
  private pollBuffer = "";
  private running = false;
  private restarts = 0;
  private restartTimer = 0;
  private lastSerialized = "";
  private listeners = new Set<NowPlayingListener>();
  private stderr = "";

  constructor(node: NonNullable<ReturnType<typeof requireNode>>) {
    this.node = node;
    this.psExe = powershellPath(node.path);
    this.scriptPath = node.path.join(node.os.tmpdir(), "music-wall-smtc.ps1");
    this.writeScript();
  }

  on(listener: NowPlayingListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.running || !this.scriptOk) return;
    this.running = true;
    this.spawnPoll();
  }

  stop(): void {
    this.running = false;
    if (this.restartTimer) {
      window.clearTimeout(this.restartTimer);
      this.restartTimer = 0;
    }
    this.killPoll();
  }

  private writeScript(): void {
    try {
      const { fs } = this.node;
      const existing = fs.existsSync(this.scriptPath)
        ? fs.readFileSync(this.scriptPath, "utf8")
        : "";
      if (existing !== SMTC_SCRIPT) fs.writeFileSync(this.scriptPath, SMTC_SCRIPT, "utf8");
      this.scriptOk = true;
    } catch {
      this.scriptOk = false;
    }
  }

  private spawnPoll(): void {
    try {
      this.pollBuffer = "";
      this.stderr = "";
      const child = this.node.cp.spawn(
        this.psExe,
        [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          this.scriptPath,
          "-Mode",
          "poll",
          "-IntervalMs",
          String(POLL_INTERVAL_MS),
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      );
      this.pollChild = child;
      child.stdout?.on("data", (chunk: Buffer | string) => this.onData(String(chunk)));
      child.stderr?.on("data", (chunk: Buffer | string) => {
        this.stderr = (this.stderr + String(chunk)).slice(-2000);
      });
      child.on("error", () => this.handleExit());
      child.on("close", () => this.handleExit());
    } catch {
      this.scriptOk = false;
      this.emit({ ...EMPTY_NOW_PLAYING, supported: false });
    }
  }

  private killPoll(): void {
    const child = this.pollChild;
    this.pollChild = null;
    if (!child) return;
    try {
      child.removeAllListeners("close");
      child.kill();
    } catch {
      /* 忽略 */
    }
  }

  private handleExit(): void {
    this.pollChild = null;
    if (!this.running) return;
    // helper 异常退出：限次重启，超限则降级为“无会话”，不影响主功能
    if (this.restarts >= MAX_RESTARTS) {
      this.running = false;
      this.emit({ ...EMPTY_NOW_PLAYING, supported: true, active: false, status: "none" });
      return;
    }
    this.restarts++;
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = 0;
      if (this.running) this.spawnPoll();
    }, 1500);
  }

  private onData(chunk: string): void {
    this.pollBuffer += chunk;
    let idx: number;
    while ((idx = this.pollBuffer.indexOf("\n")) >= 0) {
      const line = this.pollBuffer.slice(0, idx).trim();
      this.pollBuffer = this.pollBuffer.slice(idx + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      return;
    }
    if (raw?.supported === false) {
      this.scriptOk = false;
      this.stop();
      this.emit({ ...EMPTY_NOW_PLAYING, supported: false });
      return;
    }
    const next = stateFromJson(raw);
    if (next) this.emit(next);
  }

  private emit(next: NowPlayingState): void {
    const serialized = JSON.stringify(next);
    if (serialized === this.lastSerialized) return;
    this.lastSerialized = serialized;
    this.state = next;
    for (const l of [...this.listeners]) {
      try {
        l(next);
      } catch {
        /* 监听器异常不影响轮询 */
      }
    }
  }

  private runControl(action: string, positionMs = 0): Promise<boolean> {
    if (!this.scriptOk) return Promise.resolve(false);
    return new Promise((resolve) => {
      let out = "";
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        resolve(ok);
      };
      try {
        const child = this.node.cp.spawn(
          this.psExe,
          [
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            this.scriptPath,
            "-Mode",
            "control",
            "-Action",
            action,
            "-PositionMs",
            String(Math.max(0, Math.round(positionMs))),
          ],
          { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }
        );
        child.stdout?.on("data", (chunk: Buffer | string) => (out += String(chunk)));
        child.on("error", () => done(false));
        child.on("close", () => done(/"ok"\s*:\s*true/.test(out)));
        window.setTimeout(() => done(false), 8000);
      } catch {
        done(false);
      }
    });
  }

  play(): Promise<boolean> {
    return this.runControl("play");
  }
  pause(): Promise<boolean> {
    return this.runControl("pause");
  }
  toggle(): Promise<boolean> {
    return this.runControl("toggle");
  }
  next(): Promise<boolean> {
    return this.runControl("next");
  }
  prev(): Promise<boolean> {
    return this.runControl("prev");
  }
  seek(positionMs: number): Promise<boolean> {
    return this.runControl("seek", positionMs);
  }
}

/** 当前环境是否可能使用 SMTC（Windows + Electron + Node 可用） */
export function smtcSupported(): boolean {
  if (!Platform.isDesktopApp) return false;
  if (!inElectron()) return false;
  if (typeof process === "undefined" || process.platform !== "win32") return false;
  return requireNode() !== null;
}

export function createNowPlayingProvider(): NowPlayingProvider {
  if (!smtcSupported()) return new NullNowPlayingProvider();
  const node = requireNode();
  if (!node) return new NullNowPlayingProvider();
  try {
    return new WindowsSmtcProvider(node);
  } catch {
    return new NullNowPlayingProvider();
  }
}
