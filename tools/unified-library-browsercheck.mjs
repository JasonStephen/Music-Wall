import {spawn} from 'node:child_process';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
await build({entryPoints:['tools/unified-library-ui.ts'],bundle:true,platform:'browser',format:'iife',outfile:'tools/unified-library-ui.bundle.js',alias:{obsidian:path.resolve('tools/settings-shim.ts')}});
await build({entryPoints:['src/styles/index.css'],bundle:true,outfile:'styles.css',loader:{'.svg':'dataurl'}});
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'mw-unified-'));
const child=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--disable-extensions','--remote-debugging-port=0','--user-data-dir='+profile],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let socket;
try{
 const endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Chrome startup timeout')),15000);child.once('error',reject);child.stderr.on('data',data=>{const m=/DevTools listening on (ws:\/\/[^\s]+)/.exec(data.toString());if(m){clearTimeout(timer);resolve(m[1]);}})});
 socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})});
 let serial=0;const pending=new Map();socket.addEventListener('message',({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result)});
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++serial,timer=setTimeout(()=>reject(Error('Timeout '+method)),20000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}))});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});const page=(method,params)=>send(method,params,sessionId);
 const value=async expression=>{const r=await page('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value};
 let total=0;
 const cases=process.argv.includes('--queue')?[{width:1280,height:800,page:'player',queue:true},{width:1280,height:800,page:'player',queue:true,theme:'dark'}]:process.argv.includes('--quick')?[{width:1280,height:800,page:'albums'},{width:360,height:740,page:'local'}]:[{width:1280,height:800,page:'landing'},{width:1280,height:800,page:'albums'},{width:800,height:1024,page:'local'},{width:360,height:740,page:'landing'},{width:360,height:740,page:'local'},{width:1280,height:800,page:'player'},{width:360,height:740,page:'player'},{width:480,height:800,page:'albums',zoom:1.5,theme:'dark'},{width:240,height:600,page:'local',zoom:2},{width:800,height:700,page:'landing',lang:'en',theme:'dark'},{width:1280,height:800,page:'colored'},{width:1100,height:800,page:'colored',theme:'dark'},{width:800,height:1024,page:'player',theme:'dark'}];
 for(const c of process.argv.includes('--stress')?[{width:1280,height:800,page:'stress'},{width:1280,height:800,page:'stress',theme:'dark'},{width:1280,height:800,page:'stress',zoom:1.5}]:cases){await page('Emulation.setDeviceMetricsOverride',{width:c.width,height:c.height,deviceScaleFactor:1,mobile:false});await page('Page.navigate',{url:pathToFileURL(path.resolve('tools/unified-library-ui.html')).href});
  for(let i=0;i<50;i++){if(await value('typeof window.setupUnified === "function"'))break;await new Promise(r=>setTimeout(r,40))}
  const result=await value(`window.setupUnified(${JSON.stringify(c)})`);total+=result.checks;console.log(JSON.stringify({case:c,...result}));if(result.failures.length)throw Error(result.failures.join('; '));
  const shot=await page('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.mkdirSync('tools/shots',{recursive:true});fs.writeFileSync(`tools/shots/unified-${c.page}-${c.width}-${c.zoom||1}.png`,Buffer.from(shot.data,'base64'));
 }
 console.log(`${total} browser assertions passed`);
}finally{socket?.close();child.kill();}
