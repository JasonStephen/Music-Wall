/* 冒烟测试：加载真实产物 main.js（mock obsidian + 极简 DOM），
   驱动 onload() 与视图渲染，捕获接线级运行时错误。*/
"use strict";
const Module = require("module");
const path = require("path");

// ---- 极简 DOM 元素（Proxy：任意方法返回新元素） ----
function el() {
  const target = {
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => "" },
    dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    children: [],
    addEventListener() {},
    appendChild() {},
    append() {},
    remove() {},
    setAttribute() {},
    setAttr() {},
    setAttributeNS() {},
    toggleClass() {},
    addClass() {},
    removeClass() {},
    empty() {},
    createEl() { return el(); },
    createDiv() { return el(); },
    createSpan() { return el(); },
    querySelector() { return el(); },
    querySelectorAll() { return []; },
    set textContent(v) {},
    get textContent() { return ""; },
    focus() {},
    select() {},
    click() {},
  };
  return new Proxy(target, {
    get(t, p) {
      if (p in t) return t[p];
      return (..._args) => el();
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  });
}
global.document = {
  createElement: () => el(),
  createElementNS: () => el(),
  body: el(),
  documentElement: el(),
  addEventListener() {},
  removeEventListener() {},
  elementFromPoint: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};
global.window = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  addEventListener() {},
  removeEventListener() {},
  open: () => null,
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  innerWidth: 1280,
  innerHeight: 800,
};
Object.defineProperty(global, "navigator", {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
});

// ---- obsidian mock ----
class FakeComponent {
  registerEvent() {}
  register() {}
  registerDomEvent() {}
}
class FakeModal extends FakeComponent {
  constructor(app) { super(); this.app = app; this.contentEl = el(); }
  open() { this.onOpen(); }
  close() { this.onClose(); }
}
class FakeNotice {
  constructor(msg) { FakeNotice.notices.push(msg); }
}
FakeNotice.notices = [];
class FakePlugin extends FakeComponent {
  constructor(app, manifest) {
    super();
    this.app = app;
    this.manifest = manifest;
    FakePlugin.commands = [];
    FakePlugin.views = {};
    FakePlugin.extensions = [];
  }
  addCommand(c) { FakePlugin.commands.push(c); }
  addRibbonIcon() { return el(); }
  addSettingTab() {}
  registerView(type, factory) { FakePlugin.views[type] = factory; }
  registerExtensions(extensions, type) {
    FakePlugin.extensions.push({ extensions, type });
    FakePlugin.extType = type;
  }
  addStatusBarItem() { return el(); }
  async loadData() { return null; }
  async saveData() {}
}
class FakeItemView extends FakeComponent {
  constructor(leaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.contentEl = el();
  }
}
class FakeFileView extends FakeItemView {
  constructor(leaf) {
    super(leaf);
    this.file = null;
    this.allowNoFile = false;
    this.navigation = true;
  }
  getState() {
    return { file: this.file?.path };
  }
  async setState(state) {
    this.file = state?.file ? new FakeTFile(state.file) : null;
    if (this.file && this.onLoadFile) await this.onLoadFile(this.file);
  }
  getDisplayText() {
    return this.file ? this.file.name : "";
  }
  async onRename() {}
  async onLoadFile() {}
  async onUnloadFile() {}
}
class FakePluginSettingTab extends FakeComponent {
  constructor(app) { super(); this.app = app; this.containerEl = el(); }
}
class FakeSetting {
  setName() { return this; }
  setDesc() { return this; }
  addText(cb) { cb({ setPlaceholder: () => ({ setValue: () => ({ onChange: () => {} }) }) }); return this; }
  addTextArea(cb) { cb({ setPlaceholder: () => ({ setValue: () => ({ onChange: () => {}, inputEl: {} }) }) }); return this; }
  addDropdown(cb) { cb({ addOption: () => ({}), setValue: () => ({ onChange: () => {} }) }); return this; }
  addToggle(cb) { cb({ setValue: () => ({ onChange: () => {} }) }); return this; }
  addSlider(cb) { cb({ setLimits: () => ({ setValue: () => ({ setDynamicTooltip: () => ({ onChange: () => {} }) }) }) }); return this; }
  addButton(cb) { cb({ setButtonText: () => ({ setTooltip: () => ({ onClick: () => {} }) }) }); return this; }
}
class FakeTFile {
  constructor(p) { this.path = p; this.extension = p.split(".").pop(); this.basename = p; }
}

const fakeWorkspace = {
  on() { return {}; },
  onLayoutReady(fn) { fn(); },
  getActiveFile: () => null,
  getLeavesOfType: () => [],
  getMostRecentLeaf: () => null,
  getLeaf: () => ({ setViewState: async () => {}, openFile: async () => {} }),
  revealLeaf() {},
};
const fakeVault = {
  adapter: { basePath: "/tmp/fake-vault" },
  on() { return {}; },
  getFiles: () => [],
  getAbstractFileByPath: () => null,
  async create() {},
  async read() { return "{}"; },
  async modify() {},
};
const fakeApp = {
  vault: fakeVault,
  workspace: fakeWorkspace,
  fileManager: { renameFile: async () => {} },
  keychain: {},
};

const obsidianMock = {
  App: class {},
  Modal: FakeModal,
  Notice: FakeNotice,
  Plugin: FakePlugin,
  ItemView: FakeItemView,
  FileView: FakeFileView,
  Menu: class {
    addItem(cb) {
      const mk = () => chain;
      const chain = {
        setTitle: mk,
        setIcon: mk,
        setDisabled: mk,
        setChecked: mk,
        onClick: mk,
        setSubmenu: () => chain,
      };
      cb(chain);
      return this;
    }
    addSeparator() {
      return this;
    }
    showAtPosition() {}
  },
  Platform: { isDesktopApp: true, isMobileOnly: false },
  PluginSettingTab: FakePluginSettingTab,
  Setting: FakeSetting,
  TFile: FakeTFile,
  TFolder: class {},
  WorkspaceLeaf: class {},
  FolderSuggestModal: FakeModal,
  MarkdownView: class {},
  normalizePath: (p) => p,
  setIcon: () => {},
  requestUrl: async () => ({ status: 200, text: "{}" }),
};

const origLoad = Module._load;

// ---- 驱动 ----
(async () => {
  // 产物是 CJS，但 package.json 有 type:module。用 new Function 手动注入 CJS 环境，
  // 与真实 Obsidian 的加载方式一致（Obsidian 用自己的 require 评估 main.js）。
  const fs = require("fs");
  const code = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf-8");
  const fakeRequire = (request) => {
    if (request === "obsidian") return obsidianMock;
    if (request === "electron") return { shell: { openExternal() {} } };
    return origLoad(request, module, false);
  };
  const moduleShim = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function("module", "exports", "require", code)(
    moduleShim,
    moduleShim.exports,
    fakeRequire
  );
  const mod = moduleShim.exports;
  const Plugin = mod.default || mod;
  const plugin = new Plugin(fakeApp, { id: "music-wall" });
  await plugin.onload();
  const cmds = FakePlugin.commands.map((c) => c.id);
  console.log("注册命令:", cmds.join(", "));
  if (cmds.length < 6) throw new Error("命令注册数量不足");
  if (!FakePlugin.views["music-wall-view"]) throw new Error("视图未注册");
  if (!FakePlugin.views["music-wall-player"]) throw new Error("播放器视图未注册");
  const extList = FakePlugin.extensions
    .map((e) => `${e.extensions.join(",")}→${e.type}`)
    .join(" | ");
  const wallExtOk = FakePlugin.extensions.some(
    (e) => e.extensions.includes("mw") && e.type === "music-wall-view"
  );
  const playerExtOk = FakePlugin.extensions.some(
    (e) => e.extensions.includes("mwp") && e.type === "music-wall-player"
  );
  if (!wallExtOk || !playerExtOk)
    throw new Error("registerExtensions 映射异常: " + extList);

  // 渲染冒烟：视图 onOpen（空状态）
  const leaf = { app: fakeApp, setEphemeralState: () => {} };
  const view = FakePlugin.views["music-wall-view"](leaf);
  await view.onOpen();
  // 渲染冒烟：带数据 + 四种墙级全局样式轮换（样式统一，不再按卡覆盖）
  view.data = {
    version: 2,
    name: "t",
    style: "vinyl",
    groups: [{ id: "g1", name: "分组一" }, { id: "g2", name: "分组二", collapsed: true }],
    order: [3, 2, 1, 0],
    view: { sortMode: "manual", sortAsc: true, filterArtists: ["B"] },
    items: [0, 1, 2, 3].map((i) => ({
      albumId: i,
      source: "search",
      locked: true,
      groupId: i % 2 ? "g1" : "g2",
      meta: { albumId: i, name: "A", artist: "B", cover: "", trackCount: 2, year: "2020", tags: ["x"], tracks: [{ id: 1, name: "t", duration: 1000 }] },
      addedAt: new Date().toISOString(),
    })),
  };
  for (const s of ["vinyl", "cd", "cassette", "cover"]) {
    view.data.style = s;
    await view.render();
  }
  view.data.layout = "list";
  await view.render();
  view.data.layout = "shelf";
  for (const s of ["vinyl", "cd", "cassette", "cover"]) {
    view.data.style = s;
    await view.render();
  }
  // 展示架场景内详情：开→关
  view.openShelfDetail(view.data.items[0]);
  view.closeShelfDetail();
  view.data.layout = undefined;
  console.log("视图渲染（空态 + 四样式全局轮换 + 多列列表 + 展示架四样式 + 场景详情）未抛错");

  // 分组 + 手动排序 + 抽屉/浮层：分区渲染、编辑态进出、面板构建都不应抛错
  view.enterEditMode();
  view.renderEditBar();
  for (const key of ["style", "filter", "sort", "settings"]) {
    view.drawer?.open(key);
    view.drawer?.refresh();
  }
  view.drawer?.close();
  for (const key of ["search", "add"]) {
    view.floater?.open(key);
    view.floater?.refresh();
  }
  view.floater?.close();
  view.exitEditMode(true);
  console.log("分组分区 + 布局编辑态 + 侧边抽屉/右上浮层 未抛错");

  // 全局缩放：设置项 → body 变量 → 视图尺寸补偿
  plugin.settings.zoomScale = 1.25;
  plugin.applyZoom();
  if (plugin.settings.zoomScale !== 1.25) throw new Error("缩放设置未生效");
  plugin.settings.zoomScale = 1;
  plugin.applyZoom();
  console.log("全局缩放（设置 → body 变量）未抛错");

  const visible = view.getVisibleItems();
  console.log("getVisibleItems:", visible.length);
  if (visible.length !== 4) throw new Error("筛选逻辑异常");
  // 手动排序：order = [3,2,1,0] + 升序 ⇒ 展示顺序 3,2,1,0
  if (visible.map((i) => i.albumId).join(",") !== "3,2,1,0")
    throw new Error("手动排序顺序异常: " + visible.map((i) => i.albumId).join(","));
  console.log("手动排序顺序跟随 order：通过");

  // 降序时应当整体反转
  view.data.view.sortAsc = false;
  const desc = view.getVisibleItems().map((i) => i.albumId).join(",");
  if (desc !== "0,1,2,3") throw new Error("手动排序降序异常: " + desc);
  view.data.view.sortAsc = true;
  console.log("升降序与排序类型解耦：通过");

  // 播放器视图：空态渲染 + 拖入一张（与墙上拖拽同路径）+ 点单曲
  const player = FakePlugin.views["music-wall-player"](leaf);
  await player.onOpen();
  player.playInPlayer(
    {
      albumId: 7,
      name: "P",
      artist: "Q",
      cover: "",
      trackCount: 1,
      tracks: [{ id: 9, name: "s", duration: 1000 }],
    },
    "walls/a.mw"
  );
  await new Promise((r) => setTimeout(r, 0));
  // 播放器设备外观：三种样式轮换渲染（磁带机因无法达到交付要求已移除）
  for (const s of ["vinyl", "cd", "cover"]) {
    player.discStyle = s;
    await player.render();
  }
  const playerState = player.plugin?.nowPlaying?.state;
  await player.onClose();
  console.log(
    "播放器视图（空态 + 拖入播放 + 三样式设备外观 + SMTC 状态）未抛错",
    playerState?.supported === false ? "[空实现]" : ""
  );

  // 回归：打开标签页时必须主动读一次既有状态。
  // nowPlaying 的事件按「状态变化」去重，on() 只会收到后续变化——
  // 正在播放时状态不再变化，只靠订阅会一直显示「未在播放」。
  const realProvider = plugin.nowPlaying;
  plugin.nowPlaying = {
    supported: true,
    state: {
      supported: true, active: true, title: "T", artist: "A", album: "",
      status: "playing", positionMs: 0, durationMs: 0, seekable: false,
      canPlay: true, canPause: true, canToggle: true, canNext: true, canPrev: true,
    },
    start() {}, stop() {}, on() { return () => {}; },
    async play() { return true; },
    async pause() { return true; },
    async toggle() { return true; },
    async next() { return true; },
    async prev() { return true; },
    async seek() { return true; },
  };
  const fresh = FakePlugin.views["music-wall-player"](leaf);
  await fresh.onOpen();
  const snapped = { active: fresh.now?.active, status: fresh.now?.status, title: fresh.now?.title };
  await fresh.onClose();
  plugin.nowPlaying = realProvider;
  if (snapped.active !== true || snapped.status !== "playing" || snapped.title !== "T")
    throw new Error("打开播放器未同步既有播放状态: " + JSON.stringify(snapped));
  console.log("播放器打开时同步 SMTC 既有状态：通过");

  // getPlaybackDeps 形状
  const deps = plugin.getPlaybackDeps();
  if (!deps || typeof deps.isDesktop !== "boolean" || !deps.request)
    throw new Error("getPlaybackDeps 返回异常");
  console.log("getPlaybackDeps 正常");

  console.log("\n== main.js 冒烟测试通过 ==");
  process.exit(0);
})().catch((e) => {
  console.error("冒烟失败:", e);
  process.exit(1);
});
