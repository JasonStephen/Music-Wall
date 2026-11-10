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
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    get ownerDocument() { return global.document; },
    children: [],
    addEventListener() {},
    appendChild(child) { child.parentElement = this; return child; },
    append() {},
    remove() {},
    setAttribute() {},
    setAttr() {},
    setAttributeNS() {},
    toggleClass() {},
    addClass() {},
    removeClass() {},
    empty() {},
    createEl() { const child = el(); child.parentElement = this; return child; },
    createDiv() { return this.createEl(); },
    createSpan() { return this.createEl(); },
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
  get defaultView() { return global.window; },
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
  requestAnimationFrame: callback => setTimeout(() => callback(Date.now()), 0),
  getComputedStyle: () => ({ transitionDuration: '0s', transitionDelay: '0s', getPropertyValue: () => '' }),
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
// 视图 render 里会用 ResizeObserver 跟随窗格尺寸（src/ui/zoom.ts syncZoomBox）。
// 产品代码有 `typeof ResizeObserver !== "undefined"` 守卫，这里也补一个空实现，
// 让冒烟把「挂了观察者」这条路径也走一遍。
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
Object.defineProperty(global, "navigator", {
  value: { clipboard: { writeText: async () => {} } },
  configurable: true,
});

// ---- obsidian mock ----
class FakeComponent {
  load() {}
  unload() {}
  registerEvent() {}
  register() {}
  registerDomEvent() {}
}
class FakeModal extends FakeComponent {
  constructor(app) { super(); this.app = app; this.contentEl = el(); this.modalEl = el(); }
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
  adapter: { basePath: "/tmp/fake-vault", exists: async () => false },
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
  Component: FakeComponent,
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
  // 首次打开不要求文件；并发入口只创建一个标签页，已打开时只聚焦。
  const originalGetLeaf = fakeWorkspace.getLeaf;
  const originalGetLeaves = fakeWorkspace.getLeavesOfType;
  const originalReveal = fakeWorkspace.revealLeaf;
  let playerLeaves = 0, playerReveals = 0, openedType = "";
  const openedLeaf = { async setViewState(state) { openedType = state.type; await Promise.resolve(); } };
  fakeWorkspace.getLeaf = () => { playerLeaves++; return openedLeaf; };
  fakeWorkspace.revealLeaf = () => { playerReveals++; };
  await Promise.all([plugin.openPlayerView(), plugin.openPlayerView()]);
  if (playerLeaves !== 1 || openedType !== "music-wall-library") throw new Error("播放器首次打开或并发去重失败");
  fakeWorkspace.getLeavesOfType = (type) => type === "music-wall-library" ? [{ view: { leaf: openedLeaf } }] : [];
  await plugin.openPlayerView();
  if (playerLeaves !== 1 || playerReveals !== 2) throw new Error("播放器重复打开未聚焦原标签页");
  fakeWorkspace.getLeaf = originalGetLeaf; fakeWorkspace.getLeavesOfType = originalGetLeaves; fakeWorkspace.revealLeaf = originalReveal;
  console.log("播放器无文件打开、并发去重与已有标签页聚焦：通过");
  const libraryLeaf = { app: fakeApp, view: null }, library = FakePlugin.views["music-wall-library"](libraryLeaf);
  libraryLeaf.view = library; await library.onOpen();
  fakeWorkspace.getLeavesOfType = type => type === "music-wall-library" ? [libraryLeaf] : [];
  await plugin.openPlayerView(libraryLeaf);
  if (!library.embeddedPlayer) throw Error("Player was not embedded");
  await plugin.returnFromPlayer();
  if (library.embeddedPlayer) throw Error("Player did not collapse");
  await library.onClose();
  fakeWorkspace.getLeavesOfType = originalGetLeaves; fakeWorkspace.revealLeaf = originalReveal;
  console.log("Embedded player open and collapse passed");
  const cmds = FakePlugin.commands.map(c => c.id);
  if (!cmds.includes('open-library') || !cmds.includes('open-player') || cmds.some(id => /create-wall|export-wall|import-wall|git/.test(id))) throw Error('Unexpected commands');
  if (FakePlugin.views['music-wall-view'] || FakePlugin.extensions.some(e => e.extensions.includes('mw'))) throw Error('Legacy renderer registered');
  const leaf = { app: fakeApp }, page = FakePlugin.views['music-wall-library'](leaf);
  await page.onOpen(); await page.expandPlayer();
  const player = page.embeddedPlayer;
  if (!player || player instanceof FakeItemView) throw Error('Embedded player owns a workspace view');
  if (player.contentEl !== page.playerHost) throw Error('Player host mismatch');
  await page.collapsePlayer();
  if (page.embeddedPlayer) throw Error('Player did not collapse');
  await page.onClose();
  const deps = plugin.getPlaybackDeps();
  if (!deps || typeof deps.isDesktop !== 'boolean' || !deps.request) throw Error('Invalid playback dependencies');
  console.log('Unified startup, embedded component, collapse, commands and legacy removal passed');
  console.log("\n== main.js 冒烟测试通过 ==");
  process.exit(0);
})().catch((e) => {
  console.error("冒烟失败:", e);
  process.exit(1);
});
