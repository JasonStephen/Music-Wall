import { spawn } from 'node:child_process';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),profile=fs.mkdtempSync(path.join(os.tmpdir(),'mw-git-ui-'));
const child=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--disable-extensions','--remote-debugging-port=0','--user-data-dir='+profile],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let socket;
try{
 const endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Chrome startup timed out')),15000);child.once('error',reject);child.stderr.on('data',data=>{const match=/DevTools listening on (ws:\/\/[^\s]+)/.exec(String(data));if(match){clearTimeout(timer);resolve(match[1]);}});});
 socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
 let id=0;const pending=new Map();socket.addEventListener('message',({data})=>{const msg=JSON.parse(data),p=pending.get(msg.id);if(p){pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(Error(msg.error.message)):p.resolve(msg.result);}});
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>reject(Error('CDP timeout: '+method)),20000);pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params,sessionId}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const page=(method,params)=>send(method,params,sessionId);
 const value=async expression=>{const r=await page('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
 await page('Page.navigate',{url:pathToFileURL(path.join(root,'tools/git-sync-ui-e2e.html')).href});
 for(let n=0;n<100;n++){if(await value("typeof window.checkGitSyncUI==='function'"))break;await new Promise(r=>setTimeout(r,20));}
 let checks=0,failed=0,cases=0;
 for(const lang of ['zh-CN','zh-TW','en'])for(const theme of ['light','dark'])for(const [width,height,zoom] of [[1280,900,1],[360,740,1],[240,600,1],[360,740,2]]){
  await page('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  const config={lang,theme,zoom},r=await value('window.checkGitSyncUI('+JSON.stringify(config)+')');checks+=r.checks;cases++;
  if(r.failures.length){failed++;console.log('FAIL '+JSON.stringify({...config,width,height})+' '+JSON.stringify(r.failures));}
  if(lang==='zh-CN'&&theme==='dark'&&zoom===1){const shot=await page('Page.captureScreenshot',{format:'png'}),dir=path.join(root,'tools/shots/git-sync');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,`sync-${width}.png`),Buffer.from(shot.data,'base64'));}
  const auth=await value('window.checkGitHubAuthUI()');checks+=auth.checks;
  if(auth.failures.length){failed++;console.log('FAIL GitHub '+JSON.stringify({...config,width,height})+' '+JSON.stringify(auth.failures));}
  if(lang==='zh-CN'&&theme==='dark'&&zoom===1){const shot=await page('Page.captureScreenshot',{format:'png'}),dir=path.join(root,'tools/shots/git-sync');fs.writeFileSync(path.join(dir,`github-${width}.png`),Buffer.from(shot.data,'base64'));}
 }
 console.log(`${cases} sync UI configurations, ${checks} assertions, ${failed} failures`);if(failed)process.exitCode=1;
 await send('Browser.close');
}finally{
 socket?.close();if(child.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,3000);child.once('exit',()=>{clearTimeout(timer);resolve();});});if(child.exitCode===null)child.kill();
 const resolved=path.resolve(profile),tempRoot=path.resolve(os.tmpdir())+path.sep;if(resolved.startsWith(tempRoot)&&path.basename(resolved).startsWith('mw-git-ui-'))try{fs.rmSync(resolved,{recursive:true,force:true,maxRetries:4,retryDelay:100});}catch{}
}
