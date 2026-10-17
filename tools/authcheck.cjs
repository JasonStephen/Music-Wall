/* node tools/authcheck.cjs
 * Compile real modules in memory; fake only Obsidian, network and timers.
 * No real account credentials or external requests are used.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { buildSync } = require("esbuild");

const timers = new Map();
let timerId = 0;
const later = (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; };
const flush = () => new Promise((resolve) => setImmediate(resolve));
async function tick(delay = 1500) {
  const pending = [...timers].filter(([, timer]) => timer.delay === delay);
  for (const [id, timer] of pending) { if (timers.delete(id)) timer.fn(); }
  await flush();
}
const opened = [];
const notices = [];
const modals = [];
class Element {
  constructor(tag = "div", options = {}) {
    this.tag = tag; this.children = []; this.textContent = options.text || "";
    this.attrs = options.attr || {}; this.style = { setProperty() {}, removeProperty() {} };
  }
  addClass() {} toggleClass() {} setText(value) { this.textContent = value; }
  removeAttribute(name) { delete this[name]; delete this.attrs[name]; }
  setAttr(name, value) { this.attrs[name] = value; }
  addEventListener(name, fn) { this[name] = fn; }
  empty() { this.children = []; }
  createEl(tag, options) { const el = new Element(tag, options); this.children.push(el); return el; }
  createDiv(options) { return this.createEl("div", options); }
  appendText(text) { this.textContent += text; }
}
class Component {
  constructor(app) { this.app = app; this.contentEl = new Element(); this.containerEl = new Element(); }
}
class Modal extends Component {
  constructor(app) { super(app); this.modalEl = new Element(); }
  open() { modals.push(this); this.onOpen(); }
  close() { this.onClose(); }
}
class Plugin extends Component {
  async saveData(settings) { this.saved = JSON.parse(JSON.stringify(settings)); }
}
const settings = [];
class Setting {
  constructor() { settings.push(this); }
  setName(name) { this.name = name; return this; }
  setDesc(desc) { this.desc = desc; return this; }
  addButton(cb) {
    const control = {
      setButtonText(text) { this.text = text; return this; },
      setTooltip() { return this; }, setDisabled() { return this; },
      onClick(fn) { this.click = fn; return this; },
    };
    (this.buttons ||= []).push(control); cb(control); return this;
  }
  addText() { return this; } addDropdown() { return this; }
  addSlider() { return this; } addToggle() { return this; }
}
const obsidian = {
  Plugin, Modal, Setting, FileView: Component, ItemView: Component, PluginSettingTab: Component,
  Notice: class { constructor(text) { notices.push(text); } },
  TFile: class {}, TFolder: class {}, WorkspaceLeaf: class {},
  Platform: { isDesktopApp: true }, setIcon() {}, requestUrl() {},
};
global.window = { localStorage: { getItem: () => "zh-CN" } };
const built = buildSync({
  stdin: {
    contents: `export { default as MusicWallPlugin } from './src/main';
      export * from './src/core/auth'; export * from './src/core/playlist';
      export * from './src/core/playback'; export * from './src/types';
      export * from './src/i18n'; export * from './src/settings';
      export * from './src/ui/MusicPlayerView';`,
    resolveDir: path.resolve(__dirname, ".."), loader: "ts",
  },
  bundle: true, platform: "node", format: "cjs", write: false, external: ["obsidian", "electron"],
});
const loaded = { exports: {} };
const fakeRequire = (name) => name === "obsidian" ? obsidian
  : name === "electron" ? { shell: { openExternal: async (url) => { opened.push(url); } } } : require(name);
new Function("module", "exports", "require", "setTimeout", "clearTimeout", built.outputFiles[0].text)(
  loaded, loaded.exports, fakeRequire, later, (id) => timers.delete(id)
);
const api = loaded.exports;
api.setLanguage("zh-CN");
const response = (body, headers) => ({ status: 200, text: JSON.stringify(body), headers });
function fakeRequest(codes = [801, 802, 803]) {
  const calls = [];
  const request = async (req) => {
    calls.push(req);
    assert.equal(new URL(req.url).hostname, "music.163.com");
    if (req.url.endsWith("/unikey")) return response({ code: 200, unikey: "test-key" }, { "Set-Cookie": "NMTID=test-device; Path=/; HttpOnly" });
    if (req.url.endsWith("/client/login")) {
      assert.match(req.headers.Cookie, /NMTID=test-device/);
      const code = codes.shift() ?? 801;
      return response({ code }, code === 803 ? { "set-cookie": ["MUSIC_U=test-credential; Path=/; HttpOnly", "__csrf=test-csrf; Path=/"] } : {});
    }
    if (req.url.endsWith("/w/nuser/account/get")) return response({ code: 200, account: { id: 42 }, profile: { nickname: "Test user" } });
    throw Error("Unexpected request: " + req.url);
  };
  request.calls = calls;
  return request;
}
function plugin(request = fakeRequest()) {
  const instance = new api.MusicWallPlugin({ workspace: { getLeavesOfType: () => [] } });
  instance.settings = { ...api.DEFAULT_SETTINGS, language: "zh-CN" };
  instance.requester = request;
  return instance;
}
let passed = 0;
async function test(name, run) {
  try { await run(); passed++; console.log("PASS " + name); }
  finally { for (const modal of modals.splice(0)) modal.close(); timers.clear(); await flush(); }
}
async function main() {
  await test("Set-Cookie merge preserves values and ignores attributes/Expires commas", async () => {
    const result = api.mergeSetCookies("os=pc; MUSIC_U=old; NMTID=old", {
      "SET-COOKIE": "MUSIC_U=new=token; Path=/; HttpOnly; Expires=Wed, 21 Oct 2037 07:28:00 GMT, __csrf=csrf; Path=/, NMTID=; Max-Age=0; Path=/",
    });
    assert.equal(result, "os=pc; MUSIC_U=new=token; __csrf=csrf");
    assert.equal(api.hasLoginCookie("MUSIC_U=; os=pc"), false);
    assert.equal(api.hasLoginCookie("NOT_MUSIC_U=token"), false);
  });
  await test("QR session retains device cookie through waiting, confirmation and success", async () => {
    const request = fakeRequest();
    const session = await api.createQrLogin(request);
    assert.match(session.image, /^data:image\/gif;base64,/);
    assert.equal(await api.checkQrLogin(request, session), 801);
    assert.equal(await api.checkQrLogin(request, session), 802);
    assert.equal(await api.checkQrLogin(request, session), 803);
    assert.match(session.cookie, /MUSIC_U=test-credential/);
    assert.match(session.cookie, /__csrf=test-csrf/);
    assert.doesNotMatch(session.cookie, /Path=|HttpOnly/);
  });
  await test("Expired or malformed QR responses cannot become a saved login", async () => {
    const request = fakeRequest([803]);
    const session = await api.createQrLogin(request);
    session.expiresAt = 0;
    const before = request.calls.length;
    assert.equal(await api.checkQrLogin(request, session), 800);
    assert.equal(request.calls.length, before);
    session.expiresAt = Date.now() + 10000;
    await assert.rejects(api.checkQrLogin(async () => response({ code: 803 }), session));
    await assert.rejects(api.createQrLogin(async () => response({ code: 200, unikey: "" })));
  });
  await test("Preview opens one QR modal; success resumes only the latest requested album", async () => {
    const instance = plugin(fakeRequest([803]));
    const before = opened.length;
    const first = api.playAlbum({ albumId: 1, tracks: [] }, instance.getPlaybackDeps());
    const second = api.playAlbum({ albumId: 2, tracks: [] }, instance.getPlaybackDeps());
    await flush();
    assert.equal(modals.length, 1);
    assert.equal(opened.length, before);
    await tick();
    await Promise.all([first, second]);
    assert.deepEqual(opened.slice(before), ["https://music.163.com/album?id=2"]);
    assert.equal(instance.saved.neteaseUserId, "42");
    assert.equal(instance.saved.neteaseNickname, "Test user");
    assert.match(instance.saved.neteaseCookie, /MUSIC_U=/);
  });
  await test("Cancel stops polling, saving and playback", async () => {
    const request = fakeRequest([803]);
    const instance = plugin(request);
    const before = opened.length;
    const playing = api.playAlbum({ albumId: 3, tracks: [] }, instance.getPlaybackDeps());
    await flush();
    instance.loginModal.close();
    await playing;
    await tick();
    assert.equal(request.calls.length, 1);
    assert.equal(instance.settings.neteaseCookie, "");
    assert.equal(opened.length, before);
  });
  await test("Successful QR sign-in preserves the whole-album playlist playback path", async () => {
    const base = fakeRequest([803]); const writes = [];
    const instance = plugin(async (req) => {
      if (req.url.endsWith("/user/playlist")) return response({ code: 200, playlist: [{ id: 321, name: "Music Wall 临时播放" }] });
      if (req.url.endsWith("/v6/playlist/detail")) return response({ code: 200, playlist: { trackIds: [] } });
      if (req.url.endsWith("/playlist/manipulate/tracks")) { writes.push(req); return response({ code: 200 }); }
      return base(req);
    });
    const before = opened.length;
    const playing = api.playAlbum({ albumId: 1, name: "Album", tracks: [{ id: 11 }, { id: 12 }] }, instance.getPlaybackDeps());
    await flush(); await tick(); await playing;
    assert.equal(writes.length, 1);
    assert.match(writes[0].headers.Cookie, /MUSIC_U=test-credential/);
    assert.equal(instance.saved.playbackPlaylistId, "321");
    const payload = JSON.parse(Buffer.from(opened[before].slice("orpheus://".length), "base64"));
    assert.deepEqual(payload, { type: "playlist", id: 321, cmd: "play" });
  });
  await test("Cancel while account verification is in flight cannot save credentials", async () => {
    let finish;
    const base = fakeRequest([803]);
    const instance = plugin((req) => req.url.endsWith("/w/nuser/account/get")
      ? new Promise((resolve) => { finish = resolve; }) : base(req));
    const login = instance.loginNetease();
    await flush(); await tick();
    assert.equal(typeof finish, "function");
    instance.loginModal.close();
    finish(response({ code: 200, account: { id: 42 } }));
    assert.equal(await login, false); await flush();
    assert.equal(instance.settings.neteaseCookie, "");
    assert.equal(instance.saved, undefined);
  });
  await test("Valid legacy cookies and selected playlists survive migration", async () => {
    const request = fakeRequest();
    const instance = plugin(request);
    instance.settings.neteaseCookie = "MUSIC_U=legacy";
    instance.settings.playbackPlaylistId = "1234";
    assert.equal(await instance.ensureNeteaseLogin(), true);
    assert.equal(await instance.ensureNeteaseLogin(), true);
    assert.equal(instance.settings.playbackPlaylistId, "1234");
    assert.equal(modals.length, 0);
    assert.equal(request.calls.length, 1);
  });
  await test("Invalid credentials open one new QR session even with concurrent playback requests", async () => {
    const base = fakeRequest();
    const instance = plugin((req) => req.url.endsWith("/w/nuser/account/get") ? Promise.resolve(response({ code: 301 })) : base(req));
    instance.settings.neteaseCookie = "MUSIC_U=expired";
    instance.settings.playbackPlaylistId = "1234";
    const one = instance.ensureNeteaseLogin();
    const two = instance.ensureNeteaseLogin();
    await flush();
    assert.equal(modals.length, 1);
    assert.equal(instance.settings.neteaseCookie, "");
    assert.equal(instance.settings.playbackPlaylistId, "");
    instance.loginModal.close();
    assert.deepEqual(await Promise.all([one, two]), [false, false]);
  });
  await test("Network failures keep existing credentials and block playback", async () => {
    const instance = plugin(async () => { throw Error("offline"); });
    instance.settings.neteaseCookie = "MUSIC_U=existing";
    assert.equal(await instance.ensureNeteaseLogin(), false);
    assert.equal(instance.settings.neteaseCookie, "MUSIC_U=existing");
    assert.equal(modals.length, 0);
  });
  await test("Logout clears only account fields and playlist selection; old panels must sign in again", async () => {
    const instance = plugin();
    instance.settings.neteaseCookie = "MUSIC_U=existing";
    instance.settings.neteaseUserId = "42";
    instance.settings.playbackPlaylistId = "1234";
    instance.settings.gitRepoUrl = "https://example.test/walls.git";
    const old = instance.getPlaybackDeps();
    await instance.logoutNetease();
    assert.equal(instance.saved.neteaseCookie, "");
    assert.equal(instance.saved.neteaseUserId, "");
    assert.equal(instance.saved.playbackPlaylistId, "");
    assert.equal(instance.saved.gitRepoUrl, "https://example.test/walls.git");
    assert.equal(old.isCurrent(), false);
    const next = old.authorize(); await flush();
    assert.equal(modals.length, 1);
    instance.loginModal.close(); assert.equal(await next, null);
  });
  await test("Logout invalidates pending verification without opening another login", async () => {
    let finish;
    const instance = plugin(() => new Promise((resolve) => { finish = resolve; }));
    instance.settings.neteaseCookie = "MUSIC_U=old";
    const checking = instance.ensureNeteaseLogin();
    await instance.logoutNetease();
    finish(response({ code: 301 }));
    assert.equal(await checking, false);
    assert.equal(modals.length, 0);
    assert.equal(instance.saved.neteaseCookie, "");
  });
  await test("Save failure does not report a successful sign-in", async () => {
    const instance = plugin(fakeRequest([803]));
    instance.saveData = async () => { throw Error("read-only"); };
    const login = instance.loginNetease(); await flush(); await tick();
    assert.equal(instance.settings.neteaseCookie, "");
    instance.loginModal.close(); assert.equal(await login, false);
  });
  await test("Failed sign-out persistence leaves the credential available for retry", async () => {
    const instance = plugin();
    instance.settings.neteaseCookie = "MUSIC_U=existing";
    instance.settings.playbackPlaylistId = "1234";
    instance.saveData = async () => { throw Error("read-only"); };
    await assert.rejects(instance.logoutNetease());
    assert.equal(instance.settings.neteaseCookie, "MUSIC_U=existing");
    assert.equal(instance.settings.playbackPlaylistId, "1234");
  });
  await test("Player play/skip require login; pause remains available", async () => {
    const instance = plugin(); let attempts = 0; const controls = [];
    instance.ensureNeteaseLogin = async () => { attempts++; return false; };
    instance.nowPlaying = {
      supported: true, state: { status: "paused" },
      async play() { controls.push("play"); }, async next() { controls.push("next"); },
      async pause() { controls.push("pause"); }, async toggle() { controls.push("toggle"); },
    };
    const player = new api.MusicPlayerView({ app: instance.app }, instance);
    await player.control("play"); await player.control("next"); await player.control("pause");
    assert.equal(attempts, 2); assert.deepEqual(controls, ["pause"]);
    player.now.status = "playing"; await player.control("toggle");
    assert.deepEqual(controls, ["pause", "toggle"]);
  });
  await test("Settings show QR sign-in / logout and API privacy details in all three languages", async () => {
    for (const language of ["zh-CN", "zh-TW", "en"]) {
      api.setLanguage(language); settings.length = 0;
      const instance = plugin();
      const tab = new api.MusicWallSettingTab(instance.app, instance); tab.display();
      const account = settings.find((setting) => setting.name === api.t("auth.account"));
      assert.equal(account.buttons[0].text, api.t("auth.signIn"));
      assert.ok(tab.containerEl.children.find((child) => child.tag === "details"));
      instance.settings.neteaseCookie = "MUSIC_U=test"; settings.length = 0; tab.display();
      const loggedIn = settings.find((setting) => setting.name === api.t("auth.account"));
      assert.equal(loggedIn.buttons[1].text, api.t("auth.signOut"));
      assert.notEqual(api.t("auth.aboutStorage"), "auth.aboutStorage");
    }
    api.setLanguage("zh-CN");
  });
  console.log(`\n${passed} authentication checks passed`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
