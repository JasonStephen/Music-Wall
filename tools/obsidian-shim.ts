// e2e 专用 obsidian API 垫片：用真实 DOM 实现插件实际用到的最小面，
// 供 tools/gf-e2e.ts 把真实的 MusicWallView 跑在浏览器里做交互/命中/时序断言。
// 与产品代码零耦合：仅在本 harness 的 esbuild 打包中通过 --alias:obsidian 替换。

export type App = unknown;

export class TFile {
  path: string;
  parent: TFolder;
  constructor(path: string) {
    this.path = path;
    this.parent = new TFolder("/");
  }
  get name(): string {
    return this.path.split("/").pop() ?? this.path;
  }
  get basename(): string {
    return this.name.replace(/\.[^.]+$/, "");
  }
  get extension(): string {
    const seg = this.name.split(".");
    return seg.length > 1 ? seg[seg.length - 1] : "";
  }
}

export class TFolder {
  path: string;
  constructor(path: string) {
    this.path = path;
  }
}

export class WorkspaceLeaf {
  app: unknown;
  view: unknown = null;
  constructor(app?: unknown) {
    this.app = app;
  }
}

export class Notice {
  static log: string[] = [];
  constructor(message: unknown) {
    Notice.log.push(String(message));
  }
}

export const Platform = {
  isDesktopApp: false,
  isMobile: false,
  isMobileOnly: false,
};

/**
 * requestUrl 垫片：产品代码用它在「封面动态取色」时取图片字节（绕过 CORS）。
 *
 * 约定：URL 里带 `accent-probe-<hex>` 就返回一张该颜色的 8×8 PNG（现场用 canvas
 * 生成，保证字节合法），让取色链路可以被确定性地断言；其余 URL 一律抛错，
 * 用来验证「取不到就回退主题强调色」这条路径。
 */
export async function requestUrl(req: { url: string }): Promise<{
  status: number;
  arrayBuffer: ArrayBuffer;
  text: string;
  headers: Record<string, string>;
}> {
  const url = String(req?.url ?? "");
  const m = /accent-probe-([0-9a-f]{6})/i.exec(url);
  if (m) {
    const buf = probePng(`#${m[1]}`);
    return { status: 200, arrayBuffer: buf, text: "", headers: {} };
  }
  throw new Error(`requestUrl unavailable in harness: ${url}`);
}

/** 用 canvas 现场生成一张纯色 PNG（避免在垫片里硬编码图片字节） */
function probePng(color: string): ArrayBuffer {
  const canvas = document.createElement("canvas");
  canvas.width = 8;
  canvas.height = 8;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 8, 8);
  const b64 = canvas.toDataURL("image/png").split(",")[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer as ArrayBuffer;
}

export function normalizePath(p: string): string {
  return p;
}

/** 用真实 <svg> 注入图标占位（宽高由插件 CSS 控制，断言可测） */
export function setIcon(el: HTMLElement, name: string): void {
  el.textContent = "";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.dataset.icon = name;
  const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  rect.setAttribute("x", "4");
  rect.setAttribute("y", "4");
  rect.setAttribute("width", "16");
  rect.setAttribute("height", "16");
  svg.appendChild(rect);
  el.appendChild(svg);
}

/** 菜单条目快照：让 e2e 能断言「点了右键到底弹了什么」 */
export interface ShimMenuItem {
  title: string;
  icon?: string;
  disabled?: boolean;
  submenu?: ShimMenuItem[];
  run?: () => void;
}

/** 每次 showAtPosition 都会把当次菜单推进这里（供 e2e 读取） */
export const MENU_LOG: { items: ShimMenuItem[] }[] = [];

export class Menu {
  items: ShimMenuItem[] = [];

  addItem(cb: (item: never) => unknown): this {
    const entry: ShimMenuItem = { title: "" };
    const chain = {
      setTitle: (t: string) => {
        entry.title = t;
        return chain;
      },
      setIcon: (i: string) => {
        entry.icon = i;
        return chain;
      },
      setDisabled: (d: boolean) => {
        entry.disabled = d;
        return chain;
      },
      setChecked: () => chain,
      onClick: (fn: () => void) => {
        entry.run = fn;
        return chain;
      },
      setSubmenu: () => {
        const sub = new Menu();
        entry.submenu = sub.items;
        return sub;
      },
    };
    cb(chain as never);
    this.items.push(entry);
    return this;
  }
  addSeparator(): this {
    return this;
  }
  showAtPosition(_pos: { x: number; y: number }): this {
    MENU_LOG.push({ items: this.items });
    return this;
  }
  hide(): this {
    return this;
  }
}

export class Component {
  registerEvent(_ref: unknown): void {}
  register(_c: unknown): void {}
  registerDomEvent(
    el: EventTarget,
    type: string,
    cb: EventListener,
    opts?: AddEventListenerOptions
  ): void {
    el.addEventListener(type, cb, opts);
  }
  registerInterval(id: number): number {
    return id;
  }
  load(): void {}
  onload(): void {}
  unload(): void {}
  onunload(): void {}
}

export class ItemView extends Component {
  leaf: WorkspaceLeaf;
  app: unknown;
  contentEl: HTMLElement;
  navigation = true;
  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.contentEl = document.createElement("div");
  }
  getViewType(): string {
    return "";
  }
  getDisplayText(): string {
    return "";
  }
  getIcon(): string {
    return "";
  }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class FileView extends ItemView {
  file: TFile | null = null;
  allowNoFile = false;
  getState(): { file?: string } {
    return this.file ? { file: this.file.path } : {};
  }
  async setState(state: { file?: string }): Promise<void> {
    this.file = state?.file ? new TFile(state.file) : null;
    const self = this as unknown as { onLoadFile?: (f: TFile) => Promise<void> };
    if (this.file && self.onLoadFile) await self.onLoadFile(this.file);
  }
  getDisplayText(): string {
    return this.file ? this.file.name : "";
  }
  async onRename(_f: TFile): Promise<void> {}
  async onLoadFile(_f: TFile): Promise<void> {}
  async onUnloadFile(_f: TFile): Promise<void> {}
}

export class Modal extends Component {
  app: unknown;
  modalEl: HTMLElement;
  contentEl: HTMLElement;
  shouldRestoreSelection = true;
  constructor(app?: unknown) {
    super();
    this.app = app;
    this.modalEl = document.createElement("div");
    this.modalEl.className = "modal-container";
    this.contentEl = document.createElement("div");
    this.contentEl.className = "modal";
    this.modalEl.appendChild(this.contentEl);
  }
  open(): void {
    document.body.appendChild(this.modalEl);
    this.onOpen();
  }
  close(): void {
    this.modalEl.remove();
    this.onClose();
  }
  onOpen(): void {}
  onClose(): void {}
}

/** Obsidian 在真实环境会给 HTMLElement 注入一组助手方法，插件代码大量依赖；
 *  浏览器里跑真实视图前必须补齐同名实现。 */
export function installDomHelpers(): void {
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  if (proto.__mwE2eShim) return;
  proto.__mwE2eShim = true;
  const mk = (tag: string) => {
    const el = document.createElement(tag);
    return el;
  };
  const applyOpts = (
    el: HTMLElement,
    o?: { cls?: string; text?: string; type?: string; attr?: Record<string, string>; title?: string }
  ) => {
    if (o?.cls) el.className = o.cls;
    if (o?.text != null) el.textContent = o.text;
    if (o?.type) el.setAttribute("type", o.type);
    if (o?.title != null) el.title = o.title;
    if (o?.attr) for (const k of Object.keys(o.attr)) el.setAttribute(k, o.attr[k]);
  };
  proto.createDiv = function (o?: Parameters<typeof applyOpts>[1]) {
    const el = mk("div");
    applyOpts(el, o);
    (this as HTMLElement).appendChild(el);
    return el;
  };
  proto.createSpan = function (o?: Parameters<typeof applyOpts>[1]) {
    const el = mk("span");
    applyOpts(el, o);
    (this as HTMLElement).appendChild(el);
    return el;
  };
  proto.createEl = function (tag: string, o?: Parameters<typeof applyOpts>[1]) {
    const el = mk(tag);
    applyOpts(el, o);
    (this as HTMLElement).appendChild(el);
    return el;
  };
  proto.empty = function () {
    const self = this as HTMLElement;
    while (self.firstChild) self.removeChild(self.firstChild);
  };
  // Obsidian 注入的文本/属性助手（真实环境存在，shim 必须对齐，
  // 否则产品代码里一用 setText 就会在 e2e 里抛 "not a function"）
  proto.setText = function (text: string | DocumentFragment) {
    const self = this as HTMLElement;
    self.textContent = typeof text === "string" ? text : "";
    if (typeof text !== "string") self.appendChild(text);
  };
  proto.getText = function () {
    return (this as HTMLElement).textContent ?? "";
  };
  // 与真实 Obsidian 对齐：每个参数就是一个 token，空格分隔的字符串会抛
  // InvalidCharacterError（classList 原生行为），不做拆分兜底，保证 e2e 能抓住此类误用
  proto.addClass = function (...cs: string[]) {
    for (const c of cs) (this as HTMLElement).classList.add(c);
  };
  proto.removeClass = function (...cs: string[]) {
    for (const c of cs) if (c) (this as HTMLElement).classList.remove(...c.split(" "));
  };
  proto.hasClass = function (c: string): boolean {
    return (this as HTMLElement).classList.contains(c);
  };
  proto.toggleClass = function (c: string, on: boolean) {
    (this as HTMLElement).classList.toggle(c, on);
  };
  proto.setAttr = function (name: string, value: unknown) {
    const self = this as HTMLElement;
    if (value == null) self.removeAttribute(name);
    else self.setAttribute(name, String(value));
  };
  proto.setAttrs = function (o: Record<string, unknown>) {
    for (const k of Object.keys(o)) {
      (this as unknown as { setAttr: (n: string, v: unknown) => void }).setAttr(k, o[k]);
    }
  };
}
