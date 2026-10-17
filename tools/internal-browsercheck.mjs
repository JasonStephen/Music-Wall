// node tools/internal-browsercheck.mjs [--data <plugin data.json>]
// Tests real audio decoding. A supplied credential is read only and never printed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let liveBytes, liveMime="audio/mpeg", liveQuality="standard";
const credentialArg = process.argv.indexOf("--data");
if (credentialArg >= 0) {
  const settings = JSON.parse(fs.readFileSync(process.argv[credentialArg + 1], "utf8"));
  const built = await build({ entryPoints: [path.join(root,"src/core/audioSource.ts")], bundle:true,platform:"node",format:"esm",write:false });
  const { fetchSongSource } = await import("data:text/javascript;base64,"+Buffer.from(built.outputFiles[0].text).toString("base64"));
  const request = async (req) => {
    const res = await fetch(req.url,{method:req.method,headers:req.headers,body:req.body,signal:AbortSignal.timeout(15000)});
    return {status:res.status,text:await res.text()};
  };
  const qualityArg=process.argv.indexOf("--quality");
  const source = await fetchSongSource(request,347230,settings.neteaseCookie || "",qualityArg>=0?process.argv[qualityArg+1]:"standard");
  liveMime=source.mime; liveQuality=source.quality;
  const res = await fetch(source.url,{headers:{Referer:"https://music.163.com/"},signal:AbortSignal.timeout(30000)});
  if (!res.ok) throw Error("Live media response: " + res.status);
  liveBytes = Buffer.from(await res.arrayBuffer());
  if (!liveBytes.length) throw Error("Empty live media response");
  console.log(`Fetched live NetEase ${liveQuality} (${liveMime}) in memory; available: ${source.availableQualities.join(', ')}; no playlist operations.`);
}
const allowed = new Map([["/tools/internal-e2e.html","text/html"],["/tools/internal-e2e.bundle.js","text/javascript"],["/styles.css","text/css"]]);
const server = http.createServer((req,res) => {
  const pathname = new URL(req.url,"http://localhost").pathname;
  if (pathname === "/probe-audio.json" && liveBytes) {
    res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify({audio:liveBytes.toString("base64"),mime:liveMime,quality:liveQuality}));return;
  }
  if (!allowed.has(pathname)) { res.writeHead(404);res.end();return; }
  res.writeHead(200,{"Content-Type":allowed.get(pathname)});res.end(fs.readFileSync(path.join(root,pathname.slice(1))));
});
await new Promise((resolve) => server.listen(0,"127.0.0.1",resolve));
const profile = fs.mkdtempSync(path.join(os.tmpdir(),"mw-internal-browser-"));
const child = spawn(process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  ["--headless=new","--disable-gpu","--mute-audio","--no-first-run","--disable-extensions","--remote-debugging-port=0","--user-data-dir="+profile],
  {windowsHide:true,stdio:["ignore","ignore","pipe"]});
let socket;
try {
  const endpoint = await new Promise((resolve,reject) => {
    const timer = setTimeout(()=>reject(Error("Chrome startup timed out")),15000);
    child.once("error",reject);
    child.stderr.on("data",(data)=>{const match=/DevTools listening on (ws:\/\/[^\s]+)/.exec(data.toString());if(match){clearTimeout(timer);resolve(match[1]);}});
  });
  socket = new WebSocket(endpoint);
  await new Promise((resolve,reject)=>{socket.addEventListener("open",resolve,{once:true});socket.addEventListener("error",reject,{once:true});});
  let id=0;const pending=new Map();
  socket.addEventListener("message",({data})=>{
    const msg=JSON.parse(data);const item=pending.get(msg.id);if(!item)return;
    pending.delete(msg.id);clearTimeout(item.timer);
    if(msg.error)item.reject(Error(msg.error.message));else item.resolve(msg.result);
  });
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
    const messageId=++id;const timer=setTimeout(()=>{pending.delete(messageId);reject(Error("CDP timeout: "+method));},10000);
    pending.set(messageId,{resolve,reject,timer});socket.send(JSON.stringify({id:messageId,method,params,sessionId}));
  });
  const {targetId}=await send("Target.createTarget",{url:"about:blank"});
  const {sessionId}=await send("Target.attachToTarget",{targetId,flatten:true});
  const page=(method,params)=>send(method,params,sessionId);
  const value=async(expression)=>(await page("Runtime.evaluate",{expression,returnByValue:true})).result.value;
  await page("Emulation.setDeviceMetricsOverride",{width:1280,height:800,deviceScaleFactor:1,mobile:false});
  for(const live of liveBytes ? [false,true] : [false]) {
    await page("Page.navigate",{url:`http://127.0.0.1:${server.address().port}/tools/internal-e2e.html${live?'?live=1':''}`});
    for(let attempt=0;attempt<100;attempt++){await new Promise(r=>setTimeout(r,30));if(await value("typeof window.runInternalTest === 'function'"))break;}
    await page("Runtime.evaluate",{expression:"window.runInternalTest()",userGesture:true});
    let title;
    for(let attempt=0;attempt<300;attempt++){await new Promise(r=>setTimeout(r,50));title=await value("document.title");if(/^(PASS|FAIL):/.test(title))break;}
    const lines=await value("document.getElementById('result').innerText");console.log((live?"LIVE MP3":"LOCAL AUDIO")+"\n"+lines);
    if(!title?.startsWith("PASS:"))throw Error(title || "Browser test did not complete");
  }
  await send("Browser.close");
} finally {
  socket?.close();server.close();
  if(child.exitCode===null)await new Promise((resolve)=>{const timer=setTimeout(resolve,3000);child.once("exit",()=>{clearTimeout(timer);resolve();});});
  if(child.exitCode===null)child.kill();
  const resolved=path.resolve(profile),tempRoot=path.resolve(os.tmpdir())+path.sep;
  if(resolved.startsWith(tempRoot)&&path.basename(resolved).startsWith("mw-internal-browser-")) {
    try{await fs.promises.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{console.warn("Temporary browser profile retained: "+resolved);}
  }
}
