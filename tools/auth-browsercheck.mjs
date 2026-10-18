// Exact viewport checks: desktop Chrome otherwise enforces a minimum window width.
// node tools/auth-browsercheck.mjs [--screenshots <output directory>]
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
const chrome = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mw-auth-browser-"));
const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--no-first-run", "--disable-extensions", "--remote-debugging-port=0", "--user-data-dir=" + profile], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let browser;
try {
  const endpoint = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(Error("Chrome startup timed out")), 15000);
    child.once("error", reject);
    child.stderr.on("data", (data) => {
      const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(data.toString());
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
  });
  browser = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { browser.addEventListener("open", resolve, { once: true }); browser.addEventListener("error", reject, { once: true }); });
  let messageId = 0;
  const pending = new Map();
  browser.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!pending.has(message.id)) return;
    const { resolve, reject, timeout } = pending.get(message.id);
    pending.delete(message.id); clearTimeout(timeout);
    if (message.error) reject(Error(message.error.message)); else resolve(message.result);
  });
  function send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++messageId;
      const timeout = setTimeout(() => { pending.delete(id); reject(Error("CDP timeout: " + method)); }, 10000);
      pending.set(id, { resolve, reject, timeout });
      browser.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  const page = (method, params) => send(method, params, sessionId);
  const evaluate = async (expression, awaitPromise=false) => {
    const result=await page("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||'Browser evaluation failed');
    return result.result.value;
  };
  const player = process.argv.includes('--player');
  const settings = process.argv.includes('--settings');
  const html = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), settings ? "settings-e2e.html" : player ? "player-ui-e2e.html" : "auth-e2e.html"));
  const cases = [
    { name: "auth-zh-CN", lang: "zh-CN", width: 1000, height: 800 },
    { name: "auth-zh-TW", lang: "zh-TW", width: 1000, height: 800 },
    { name: "auth-en-narrow-dark", lang: "en", width: 360, height: 800, theme: "dark" },
  ];
  if (player) cases.splice(0,cases.length,{name:'player',lang:'zh-CN',width:1280,height:760});
  if (settings) {cases.splice(0,cases.length);for(const theme of ['light','dark'])for(const lang of ['zh-CN','zh-TW','en'])for(const [width,height] of [[1280,800],[360,740],[240,600],[640,360]])for(const zoom of [1,2])cases.push({name:`settings-${lang}-${theme}-${width}-${zoom}`,lang,theme,width,height,zoom});}
  const outputIndex = process.argv.indexOf("--screenshots");
  const screenshotRoot = outputIndex >= 0 ? path.resolve(process.argv[outputIndex + 1]) : null;
  for (const item of cases) {
    await page("Emulation.setDeviceMetricsOverride", { width: item.width, height: item.height, deviceScaleFactor: 1, mobile: false });
    for (const preview of screenshotRoot && !settings ? [false, true] : [false]) {
      const url = new URL(html); url.searchParams.set("lang", item.lang);
      if (item.theme) url.searchParams.set("theme", item.theme);
      if (preview) url.searchParams.set("preview", "1");
      await page("Page.navigate", { url: url.href });
      if(settings){
        for(let i=0;i<100;i++){if(await evaluate("typeof window.setupSettings==='function'"))break;await new Promise(resolve=>setTimeout(resolve,20));}
        const result=await evaluate('window.setupSettings('+JSON.stringify(item)+')',true);
        if(result.fail.length)throw Error(item.name+': '+result.fail.join('; '));
        if(screenshotRoot&&item.width===360&&item.zoom===1&&item.lang==='en'){
          fs.mkdirSync(screenshotRoot,{recursive:true});await evaluate("document.querySelector('.mw-audio-setting').scrollIntoView()");
          const capture=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(screenshotRoot,item.name+'.png'),Buffer.from(capture.data,'base64'));
        }
        console.log('PASS '+item.name);continue;
      }
      let title;
      for (let attempt = 0; attempt < (player ? 1800 : 500); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        title = await evaluate("document.title");
        if (/^(PASS|FAIL):/.test(title)) break;
      }
      const width = await evaluate("innerWidth");
      if (width !== item.width || !title.startsWith("PASS:")) {
        console.log(await evaluate("Array.from(document.querySelectorAll('.bad')).map(x=>x.textContent)"));
        throw Error(`${item.name}: viewport=${width}, ${title}`);
      }
      if (!preview) console.log(`PASS ${item.name}: actual viewport ${width}px`);
      else {
        const capture = await page("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        fs.writeFileSync(path.join(screenshotRoot, item.name + ".png"), Buffer.from(capture.data, "base64"));
      }
    }
  }
  await send("Browser.close");
} finally {
  browser?.close();
  if (child.exitCode === null) {
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 3000);
      child.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
  }
  if (child.exitCode === null) child.kill();
  // Only remove this script's freshly created temporary profile, after path validation.
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  const resolvedProfile = path.resolve(profile);
  if (resolvedProfile.startsWith(tempRoot) && path.basename(resolvedProfile).startsWith("mw-auth-browser-")) {
    try {
      await fs.promises.rm(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A still-closing Chrome helper may hold a cache file on Windows.
      console.warn("Temporary browser profile retained: " + resolvedProfile);
    }
  }
}
