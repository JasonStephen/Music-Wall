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
  constructor() { this.settingEl = new Element(); settings.push(this); }
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
global.window = new EventTarget();
window.localStorage = { getItem: () => "zh-CN" };
global.document = new EventTarget();
document.hidden = false;
document.defaultView = window;
const built = buildSync({
  stdin: {
    contents: `export { default as MusicWallPlugin } from './src/main';
      export * from './src/core/auth'; export * from './src/core/playlist';
      export * from './src/core/playback'; export * from './src/types';
      export * from './src/i18n'; export * from './src/settings';
      export * from './src/ui/MusicPlayerView';
      export * from './src/core/loginDiagnostics';
      export * from './src/core/mobileLoginRequest';
      export * from './src/ui/NeteaseLoginModal';`,
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
  finally { for (const modal of modals.splice(0)) modal.close(); timers.clear(); document.hidden = false; delete window.Capacitor; await flush(); }
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
  await test("Native Set-Cookie newline, CRLF and mixed array formats preserve MUSIC_U", async () => {
    for (const separator of ["\n", "\r\n", ", "]) {
      const cookies = ["NMTID=device; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT", "MUSIC_U=token=tail; HttpOnly; Path=/", "__csrf=csrf; Path=/"].join(separator);
      assert.equal(api.mergeSetCookies("os=pc", { "set-cookie": [cookies, "other=value; Path=/"] }), "os=pc; NMTID=device; MUSIC_U=token=tail; __csrf=csrf; other=value");
    }
  });
  await test("Android QR transport preserves all cookies when host requestUrl drops duplicate headers", async () => {
    const base = fakeRequest(); let nativeCalls = 0; let fallbackPolls = 0;
    const joined = "__csrf=csrf; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT, MUSIC_U=android-credential; Path=/; HttpOnly, NMTID=device; Path=/";
    window.Capacitor = {
      getPlatform: () => "android",
      async nativePromise(plugin, method, options) {
        assert.equal(this, window.Capacitor); assert.equal(plugin, "CapacitorHttp"); assert.equal(method, "request");
        assert.equal(options.method, "POST"); assert.equal(options.responseType, "text");
        assert.equal(options.disableRedirects, true); assert.equal(options.readTimeout, 10000);
        assert.match(options.data, /^params=.+&encSecKey=/);
        assert.equal(options.headers["Content-Type"], "application/x-www-form-urlencoded");
        ++nativeCalls;
        // Model Capacitor's JSON auto-parsing and combined response headers.
        return options.url.endsWith("/unikey") ? {status:200,data:{code:200,unikey:"android-key"},headers:{"Set-Cookie":"NMTID=device; Path=/"}}
          : {status:200,data:{code:803},headers:{"Set-Cookie":joined}};
      },
    };
    const instance = plugin(req => {
      if (req.url.endsWith("/client/login")) { ++fallbackPolls; return Promise.resolve(response({code:803},{"set-cookie":"__csrf=csrf; Path=/"})); }
      if (req.url.endsWith("/w/nuser/account/get")) assert.match(req.headers.Cookie, /MUSIC_U=android-credential/);
      return base(req);
    });
    const login = instance.loginNetease(); await flush(); await tick();
    assert.equal(await login, true); assert.equal(nativeCalls, 2); assert.equal(fallbackPolls, 0);
    assert.match(instance.saved.neteaseCookie, /MUSIC_U=android-credential/);
    assert.doesNotMatch(instance.saved.neteaseCookie, /Path=|Expires=/);
  });
  await test("Desktop, iOS and hosts without a native bridge retain their existing requester", async () => {
    const base = fakeRequest(); assert.equal(api.qrLoginRequester(base), base);
    for (const platform of ["web", "ios", "electron"]) {
      window.Capacitor = {getPlatform:()=>platform,nativePromise:()=>{throw Error("must not use native bridge");}};
      assert.equal(api.qrLoginRequester(base), base);
    }
    window.Capacitor = {getPlatform:()=>"android"}; assert.equal(api.qrLoginRequester(base), base);
  });
  await test("Android native bridge is scoped to QR URLs and keeps the original encrypted body", async () => {
    let received; let fallbacks = 0;
    window.Capacitor = {getPlatform:()=>"android",nativePromise:async (_plugin,_method,options)=>{received=options;return {status:200,data:'{"code":801}',headers:{"Set-Cookie":["NMTID=x; Path=/","__csrf=y; Path=/"],ignored:42}};}};
    const request = api.qrLoginRequester(async req=>{++fallbacks;return response({code:200});});
    const qr = {url:"https://music.163.com/weapi/login/qrcode/client/login",method:"POST",headers:{Cookie:"os=pc","Content-Type":"application/x-www-form-urlencoded"},body:"params=unchanged%2B%3D&encSecKey=test"};
    const result = await request(qr); assert.equal(received.data,qr.body); assert.deepEqual(received.headers,qr.headers);
    assert.notEqual(received.headers,qr.headers); assert.equal(result.text,'{"code":801}'); assert.equal(result.headers.ignored,undefined);
    for (const url of ["https://music.163.com/weapi/w/nuser/account/get","https://example.test/weapi/login/qrcode/client/login","http://music.163.com/weapi/login/qrcode/client/login"]) await request({...qr,url});
    assert.equal(fallbacks,3);
  });
  await test("Missing CapacitorHttp falls back once; network failures never silently resend", async () => {
    const base = fakeRequest(); let nativeCalls = 0;
    window.Capacitor = {getPlatform:()=>"android",nativePromise:async()=>{++nativeCalls;throw {code:"UNIMPLEMENTED"};}};
    const request = api.qrLoginRequester(base); const session = await api.createQrLogin(request); await api.checkQrLogin(request,session);
    assert.equal(nativeCalls,1); assert.equal(base.calls.length,2);
    for (const failure of [Error("private MUSIC_U=SECRET"),{code:"NETWORK_ERROR",message:"SECRET"}]) {
      let fallbacks=0;
      window.Capacitor.nativePromise=async()=>{throw failure;};
      await assert.rejects(api.createQrLogin(api.qrLoginRequester(async()=>{++fallbacks;return response({code:200});})),error=>{
        assert.equal(error.reason,"network"); assert.doesNotMatch(error.message,/SECRET|MUSIC_U/); return true;
      });
      assert.equal(fallbacks,0);
    }
  });
  await test("Invalid or stalled native responses cannot save a login", async () => {
    for (const data of [null,{status:"200",data:{code:803}},{status:200}]) {
      window.Capacitor={getPlatform:()=>"android",nativePromise:async()=>data};
      await assert.rejects(api.createQrLogin(api.qrLoginRequester(fakeRequest())),error=>error.reason==="network");
    }
    let finish;
    window.Capacitor={getPlatform:()=>"android",nativePromise:()=>new Promise(resolve=>{finish=resolve;})};
    const request = api.createQrLogin(api.qrLoginRequester(fakeRequest()));
    const assertion=assert.rejects(request,error=>error.reason==="timeout"); await tick(15000); await assertion;
    finish({status:200,data:{code:200,unikey:"late-key"}}); await flush();
  });
  await test("Authorized credentials survive verification retries without polling a spent QR", async () => {
    const base = fakeRequest([803, 800]); let verifies = 0;
    const instance = plugin(req => {
      if (req.url.endsWith("/w/nuser/account/get") && ++verifies <= 2) throw Error("private network detail MUSIC_U=SECRET");
      return base(req);
    });
    const login = instance.loginNetease(); await flush(); await tick();
    assert.equal(instance.loginModal.phase, "verify");
    instance.loginModal.session.expiresAt = 0;
    assert.doesNotMatch(instance.loginModal.statusEl.textContent, /SECRET|private/);
    await tick(3000); await tick(3000);
    assert.equal(await login, true);
    assert.equal(verifies, 3);
    assert.equal(base.calls.filter(req => req.url.endsWith("/client/login")).length, 1);
  });
  await test("Manual verification retry reuses credentials after automatic retries stop", async () => {
    const base = fakeRequest([803]); let offline = true;
    const instance = plugin(req => req.url.endsWith("/w/nuser/account/get") && offline ? Promise.reject(Error("offline")) : base(req));
    const login = instance.loginNetease(); await flush(); await tick(); await tick(3000); await tick(3000);
    const modal = instance.loginModal;
    assert.equal(modal.stopped, true);
    assert.equal(modal.retryButton.hidden, false);
    assert.equal(modal.refreshButton.disabled, false);
    offline = false; modal.retryButton.click(); await flush();
    assert.equal(await login, true);
    assert.equal(base.calls.filter(req => req.url.endsWith("/client/login")).length, 1);
  });
  await test("Manual polling retry restores a still-valid QR image", async () => {
    const base = fakeRequest([801]); let offline = true;
    const instance = plugin(req => req.url.endsWith("/client/login") && offline ? Promise.reject(Error("offline")) : base(req));
    const login = instance.loginNetease(); await flush(); await tick(); await tick(3000); await tick(3000);
    const modal = instance.loginModal; assert.equal(modal.imageEl.hidden, true);
    offline = false; modal.retryButton.click(); await flush();
    assert.equal(modal.imageEl.hidden, false); assert.equal(modal.stopped, false);
    modal.close(); assert.equal(await login, false);
  });
  await test("Authorization received while hidden is verified on return without polling again", async () => {
    const base = fakeRequest([803]); let finish;
    const instance = plugin(req => req.url.endsWith("/client/login") ? new Promise(resolve => { finish = () => resolve(base(req)); }) : base(req));
    const login = instance.loginNetease(); await flush(); await tick();
    const modal = instance.loginModal;
    document.hidden = true; document.dispatchEvent(new Event("visibilitychange"));
    finish(); await flush(); assert.equal(modal.phase, "verify"); assert.equal(instance.saved, undefined);
    document.hidden = false; document.dispatchEvent(new Event("visibilitychange")); await flush();
    assert.equal(await login, true);
    assert.equal(base.calls.filter(req => req.url.endsWith("/client/login")).length, 1);
  });
  await test("Returning from background resumes one request; duplicate lifecycle events cannot overlap", async () => {
    const base = fakeRequest([801, 803]); let finish; let polls = 0; let active = 0; let maxActive = 0;
    const instance = plugin(async req => {
      if (!req.url.endsWith("/client/login")) return base(req);
      ++polls; ++active; maxActive = Math.max(maxActive, active);
      if (polls === 1) await new Promise(resolve => { finish = resolve; });
      try { return await base(req); } finally { --active; }
    });
    const login = instance.loginNetease(); await flush();
    document.hidden = true; document.dispatchEvent(new Event("visibilitychange"));
    await tick(); assert.equal(polls, 0);
    document.hidden = false; document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("pageshow"));
    assert.equal(polls, 1);
    finish(); await flush();
    assert.equal(await login, true); assert.equal(maxActive, 1); assert.equal(polls, 2);
    const before = polls; window.dispatchEvent(new Event("focus")); await tick(); assert.equal(polls, before);
  });
  await test("Background request failures do not consume foreground retry budget", async () => {
    const base = fakeRequest([803]); let fail;
    const instance = plugin(req => req.url.endsWith("/client/login") ? new Promise((_, reject) => { fail = reject; }) : base(req));
    const login = instance.loginNetease(); await flush(); await tick();
    const modal = instance.loginModal;
    document.hidden = true; document.dispatchEvent(new Event("visibilitychange"));
    fail(Error("suspended")); await flush();
    assert.equal(modal.failures, 0); assert.equal(modal.stopped, false);
    document.hidden = false; document.dispatchEvent(new Event("visibilitychange"));
    assert.equal(modal.inFlight.size, 1);
    modal.close(); fail(Error("cancelled")); await flush(); assert.equal(await login, false);
  });
  await test("Refresh invalidates a late QR response and its credential", async () => {
    const base = fakeRequest(); let finish;
    const instance = plugin(req => req.url.endsWith("/client/login") ? new Promise(resolve => { finish = resolve; }) : base(req));
    const login = instance.loginNetease(); await flush(); await tick();
    const modal = instance.loginModal; modal.refreshButton.click(); await flush();
    finish(response({code:803}, {"set-cookie":"MUSIC_U=stale; Path=/"})); await flush();
    assert.equal(modal.phase, "check"); assert.equal(instance.saved, undefined);
    assert.doesNotMatch(modal.session.cookie, /stale/);
    modal.close(); assert.equal(await login, false);
  });
  await test("HTTP, malformed, timeout, expired credential and risk diagnostics omit raw server data", async () => {
    for (const [request, reason] of [
      [async () => ({status:503,text:"SECRET body",headers:{}}), "http"],
      [async () => ({status:200,text:"SECRET body",headers:{}}), "response"],
      [async () => response({code:8821,message:"SECRET",cookie:"MUSIC_U=SECRET"}), "risk"],
      [async () => response({code:301}), "expired"],
    ]) {
      await assert.rejects(api.verifyCookie(request, "MUSIC_U=test"), error => {
        assert.equal(error.reason, reason); assert.doesNotMatch(error.message, /SECRET|MUSIC_U/);
        if (reason === "risk") { assert.equal(error.retryable, false); assert.match(error.message, /8821/); }
        return true;
      });
    }
    const checking = api.verifyCookie(() => new Promise(() => {}), "MUSIC_U=test");
    const assertion = assert.rejects(checking, error => error.reason === "timeout" && error.stage === "verify");
    await tick(15000); await assertion;
  });
  await test("Explicit risk and missing credentials stop retries and require a new QR", async () => {
    for (const code of [8821,803]) {
      const base = fakeRequest(); const instance = plugin(req => req.url.endsWith("/client/login") ? Promise.resolve(response({code})) : base(req));
      const login = instance.loginNetease(); await flush(); await tick();
      assert.equal(instance.loginModal.stopped, true); assert.equal(instance.loginModal.retryButton.hidden, true);
      await tick(3000); assert.equal(instance.saved, undefined);
      instance.loginModal.close(); assert.equal(await login, false);
    }
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
    assert.equal(instance.loginModal.stopped, true);
    assert.equal(instance.loginModal.retryButton.hidden, false);
    assert.match(instance.loginModal.statusEl.textContent, new RegExp(api.t("authDiagnostics.save")));
    instance.saveData = Plugin.prototype.saveData;
    instance.loginModal.retryButton.click(); await flush();
    assert.equal(await login, true);
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
