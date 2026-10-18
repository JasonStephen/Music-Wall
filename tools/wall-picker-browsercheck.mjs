// Production picker and CSS in real Chrome; no accounts, vaults or network APIs.
import {build} from 'esbuild';
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os'; import {spawn} from 'node:child_process';
const root=process.cwd(), profile=fs.mkdtempSync(path.join(os.tmpdir(),'mw-picker-check-'));
const bundle=await build({entryPoints:['tools/wall-picker-e2e.ts'],bundle:true,write:false,format:'iife',platform:'browser',alias:{obsidian:path.join(root,'tools/obsidian-shim.ts')}});
const chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--disable-extensions','--remote-debugging-port=0','--user-data-dir='+profile],{windowsHide:true,stdio:['ignore','ignore','pipe']}); let socket;
try {
 const endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Chrome startup timeout')),15000);chrome.once('error',reject);chrome.stderr.on('data',d=>{const m=/DevTools listening on (ws:\/\/[^\s]+)/.exec(d.toString());if(m){clearTimeout(timer);resolve(m[1]);}});});
 socket=new WebSocket(endpoint); await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true})); let id=0; const pending=new Map();
 socket.addEventListener('message',({data})=>{const m=JSON.parse(data),p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('CDP timeout '+method));},30000);pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params,sessionId}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true}); const page=(m,p)=>send(m,p,sessionId);
 const value=async expression=>{const r=await page('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 await page('Page.enable'); const {frameTree}=await page('Page.getFrameTree');
 const fixture=fs.readFileSync('tools/git-sync-ui-e2e.html','utf8').replace('<link rel="stylesheet" href="../styles.css">','<style>'+fs.readFileSync('styles.css','utf8')+'</style>').replace('<script src="git-sync-ui-e2e.bundle.js"></script>','');
 await page('Page.setDocumentContent',{frameId:frameTree.frame.id,html:fixture}); await value(bundle.outputFiles[0].text);
 const behavior=await value('window.runPickerChecks()'); if(behavior.fail.length)throw Error(behavior.fail.join('\n')); console.log(`PASS ${behavior.checks} picker behavior checks`);
 let configurations=0,checks=0;
 for(const width of [360,768,1280]) for(const zoom of [1,2]) for(const theme of ['light','dark','shelf']) for(const lang of ['zh-CN','zh-TW','en']) {
   await page('Emulation.setDeviceMetricsOverride',{width,height:854,deviceScaleFactor:1,mobile:false});
   const result=await value(`window.pickerLayout(${JSON.stringify(lang)},${JSON.stringify(theme)},${zoom})`); configurations++;checks+=result.checks;
   if(result.fail.length)throw Error(`${width}px z${zoom} ${theme} ${lang}: ${result.fail.slice(0,8).join('; ')}`);
 }
 console.log(`PASS ${configurations} picker layouts, ${checks} geometry/icon checks`);
 await page('Emulation.setDeviceMetricsOverride',{width:768,height:854,deviceScaleFactor:1,mobile:false}); await value('window.pickerLayout("zh-CN","dark",1)');
 await page('Emulation.setTouchEmulationEnabled',{enabled:true}); const point=await value('window.preparePickerTouch()');
 await page('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]}); await page('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
 const result=await value('window.pickerTouchResult()'); if(result.open||result.picked.length!==1||result.picked[0]!==3)throw Error('Native touch selection failed: '+JSON.stringify(result));
 console.log('PASS native touch selects the correct wall once'); await send('Browser.close');
} finally {
 socket?.close();if(chrome.exitCode===null)await new Promise(resolve=>{const t=setTimeout(resolve,2000);chrome.once('exit',()=>{clearTimeout(t);resolve();});});if(chrome.exitCode===null)chrome.kill();
 const resolved=path.resolve(profile);if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('mw-picker-check-'))try{await fs.promises.rm(resolved,{recursive:true,force:true,maxRetries:3,retryDelay:100});}catch{}
}
