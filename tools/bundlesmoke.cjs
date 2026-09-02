/* 冒烟测试：加载真实产物 main.js（mock obsidian + 极简 DOM），
   驱动 onload() 与视图渲染，捕获接线级运行时错误。*/
"use strict";
const Module = require("module");
const path = require("path");

// ---- 极简 DOM 元素（Proxy：任意方法返回新元素） ----
function el() {
  const target = {
    style: { setProperty() {} },
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
  body: el(),
};
global.window = { setTimeout, open: () => null };
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
  }
  addCommand(c) { FakePlugin.commands.push(c); }
  addRibbonIcon() { return el(); }
  addSettingTab() {}
  registerView(type, factory) { FakePlugin.views[type] = factory; }
  registerExtensions(extensions, type) { FakePlugin.extType = type; }
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
    addItem(cb) { cb({ setTitle: () => ({ setIcon: () => ({ onClick: () => {} }) }) }); return this; }
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
  if (FakePlugin.extType !== "music-wall-view")
    throw new Error("registerExtensions 必须映射到视图类型，实为: " + FakePlugin.extType);

  // 渲染冒烟：视图 onOpen（空状态）
  const leaf = { app: fakeApp, setEphemeralState: () => {} };
  const view = FakePlugin.views["music-wall-view"](leaf);
  await view.onOpen();
  // 渲染冒烟：带数据 + 四种墙级全局样式轮换（样式统一，不再按卡覆盖）
  view.data = {
    version: 1,
    name: "t",
    style: "vinyl",
    items: [0, 1, 2, 3].map((i) => ({
      albumId: i,
      source: "search",
      locked: true,
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

  const visible = view.getVisibleItems();
  console.log("getVisibleItems:", visible.length);
  if (visible.length !== 4) throw new Error("筛选逻辑异常");

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
