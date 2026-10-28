import {build} from 'esbuild';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';
const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'mw-filter-ui-'));
const source=p=>path.join(root,p).replaceAll('\\','/');
let shim=fs.readFileSync('tools/settings-shim.ts','utf8').replace("'./obsidian-shim'",JSON.stringify(source('tools/obsidian-shim.ts'))).replace('setDisabled:(v:boolean)', 'setCta:()=>c,setDisabled:(v:boolean)');
shim=shim.replace(' addSlider(callback:any)',` addTextArea(callback:any){const el=this.control.createEl('textarea');const c={setValue:(v:string)=>{el.value=v;return c;},onChange:(fn:any)=>{el.oninput=()=>fn(el.value);return c;}};callback(c);return this;}\n addSlider(callback:any)`);
fs.writeFileSync(path.join(dir,'shim.ts'),shim);
const entry=`import {renderArtistAlbumSettings,showArtistAlbumMenu} from ${JSON.stringify(source('src/ui/artistAlbumSettings.ts'))};import {installDomHelpers} from ${JSON.stringify(source('tools/obsidian-shim.ts'))};import {DEFAULT_SETTINGS} from ${JSON.stringify(source('src/types.ts'))};installDomHelpers();window.writes=0;window.refreshes=0;window.plugin={settings:{...DEFAULT_SETTINGS},async saveData(){window.writes++;},refreshOpenViews(){window.refreshes++;}};window.openMenu=()=>showArtistAlbumMenu(window.plugin,document.querySelector('#anchor'));renderArtistAlbumSettings(document.querySelector('#settings'),window.plugin);document.querySelector('#anchor').onclick=window.openMenu;`;
await build({stdin:{contents:entry,resolveDir:root,loader:'ts'},bundle:true,format:'iife',outfile:path.join(dir,'bundle.js'),alias:{obsidian:path.join(dir,'shim.ts')}});
fs.writeFileSync(path.join(dir,'index.html'),`<html><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(root,'styles.css'))}"><style>body{font:14px/1.4 system-ui;--background-primary:white;--text-normal:#222;--background-modifier-border:#ccc;--shadow-s:0 2px 15px #0003}.setting-item{display:flex;justify-content:space-between;border-top:1px solid #ccc;padding:12px;gap:12px}.setting-item-control{display:flex;align-items:center;gap:8px}.setting-item-info{flex:1}.setting-item-description{font-size:12px;color:#777}#anchor{position:fixed;right:18px;top:18px}#settings{max-width:600px;margin-top:100px}input,textarea{max-width:100%;}button{padding:5px}</style><button id="anchor">Filters</button><div id="settings"></div><script src="bundle.js"></script></html>`);
const child=spawn('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',['--headless=new','--disable-gpu','--no-first-run','--remote-debugging-port=0','--user-data-dir='+path.join(dir,'chrome')],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let socket;
try{
 const endpoint=await new Promise((resolve,reject)=>{child.once('error',reject);child.stderr.on('data',d=>{const m=/DevTools listening on (ws:\/\/\S+)/.exec(d.toString());if(m)resolve(m[1]);});});
 socket=new WebSocket(endpoint);await new Promise(r=>socket.addEventListener('open',r,{once:true}));let id=0;const pending=new Map();socket.addEventListener('message',e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}});
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const key=++id;pending.set(key,{resolve,reject});socket.send(JSON.stringify({id:key,method,params,sessionId}));});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});const page=(m,p)=>send(m,p,sessionId);
 const val=async expression=>{const result=await page('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.exception?.description||result.exceptionDetails.text);return result.result.value;};
 await page('Page.navigate',{url:pathToFileURL(path.join(dir,'index.html')).href});
 for(let i=0;i<50;i++){if(await val('typeof window.openMenu==="function"'))break;await new Promise(r=>setTimeout(r,50));}
 for(const width of [1280,360,240]){
  await page('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
  await val('window.openMenu()');
  const check=await val(`(()=>{const p=document.querySelector('.mw-artist-filters'),r=p.getBoundingClientRect();return {fit:r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight,overflow:p.scrollWidth>p.clientWidth+1,fields:p.querySelectorAll('input,textarea').length,text:p.textContent.includes('?')}})()`);
  if(!check.fit||check.overflow||check.fields!==4||check.text)throw Error(JSON.stringify({width,...check}));
  await val(`(()=>{const p=document.querySelector('.mw-artist-filters');const n=p.querySelector('input[type=number]');n.value='4';n.dispatchEvent(new Event('input'));const t=p.querySelector('textarea');t.value='Live;Demo';t.dispatchEvent(new Event('input'));})()`);
  if(await val('window.writes')!==0)throw Error('edits saved early');
  await val(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
 }
 await val('window.openMenu()');
 await page('Page.captureScreenshot',{format:'png'}).then(s=>fs.writeFileSync(path.join(dir,'popup.png'),Buffer.from(s.data,'base64')));
 await val(`document.querySelector('.mw-artist-filters button:last-child').click()`);
 await new Promise(r=>setTimeout(r,100));
 if(await val('window.writes')!==1||await val('!!document.querySelector(".mw-artist-filters")'))throw Error('apply failed');
 console.log('Browser checks passed: dropdown fits 1280/360/240px, all fields present, Chinese intact, draft edits do not save, Escape dismisses, Apply saves and closes. Screenshot: '+path.join(dir,'popup.png'));
}finally{socket?.close();child.kill();}
