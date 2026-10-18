// Real view DOM/CSS across pane sizes, themes, cover brightness, layouts and zoom.
import {spawn} from 'node:child_process';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'mw-playback-ui-'));
const child=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ['--headless=new','--disable-gpu','--no-first-run','--disable-extensions','--remote-debugging-port=0','--user-data-dir='+profile],{windowsHide:true,stdio:['ignore','ignore','pipe']});
let socket;
try {
  const endpoint=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Chrome startup timed out')),15000);child.once('error',reject);child.stderr.on('data',data=>{const m=/DevTools listening on (ws:\/\/[^\s]+)/.exec(data.toString());if(m){clearTimeout(timer);resolve(m[1]);}});});
  socket=new WebSocket(endpoint);await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let id=0;const pending=new Map();
  socket.addEventListener('message',({data})=>{const msg=JSON.parse(data),item=pending.get(msg.id);if(!item)return;pending.delete(msg.id);clearTimeout(item.timer);if(msg.error)item.reject(Error(msg.error.message));else item.resolve(msg.result);});
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);reject(Error('CDP timeout: '+method));},20000);pending.set(key,{resolve,reject,timer});socket.send(JSON.stringify({id:key,method,params,sessionId}));});
  const {targetId}=await send('Target.createTarget',{url:'about:blank'}),{sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  const page=(method,params)=>send(method,params,sessionId);
  const value=async expression=>{const result=await page('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text+': '+result.exceptionDetails.exception?.description);return result.result.value;};
  await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const sizes=[[2560,1080],[1280,800],[768,1024],[360,740],[640,360],[240,600]];
  const cases=[];
  for(const theme of ['light','dark']) for(const bg of ['white','dark','wood','art-light','art-dark','art-color']) for(const panel of ['playlist','volume','quality']) for(const [width,height] of sizes) {
    cases.push({kind:'player',theme,bg:bg.startsWith('art')?'art':bg,cover:bg==='art-light'?'f5efe0':bg==='art-dark'?'151925':'46739a',panel,width,height,style:['vinyl','cd','cover'][cases.length%3]});
  }
  for(const style of ['vinyl','cd','cover']) for(const [width,height] of sizes) for(const panel of ['volume','quality','playlist']) cases.push({kind:'player',theme:'dark',bg:'art',cover:'f5efe0',style,width,height,panel});
  for(const theme of ['light','dark']) for(const layout of ['grid','list','shelf']) for(const style of ['vinyl','cd','cassette','cover']) for(const [width,height] of [[1280,800],[360,740],[640,360]]) cases.push({kind:'wall',theme,layout,style,width,height});
  for(const zoom of [.5,1.5,2]) for(const kind of ['player','wall']) for(const panel of ['volume','quality']) cases.push({kind,theme:'dark',bg:'art',cover:'f5efe0',layout:'shelf',style:'vinyl',width:360,height:740,zoom,panel});
  for(const caption of ['hidden','pull','always']) for(const style of ['vinyl','cd','cassette','cover']) cases.push({kind:'wall',theme:'dark',layout:'shelf',style,caption,width:805,height:600});
  for(const width of [240,560,600,805,2048]) for(const zoom of [1,2]) cases.push({kind:'wall',theme:'dark',layout:'grid',style:'cover',width,height:740,zoom});
  for(const theme of ['light','dark']) for(const bg of ['white','dark','art','wood']) for(const [width,height] of [[1280,800],[360,740],[640,360],[240,600]]) cases.push({kind:'player',theme,bg,style:'vinyl',panel:'queue',width,height});
  for(const theme of ['light','dark']) for(const layout of ['grid','list','shelf']) for(const zoom of [1,2]) cases.push({kind:'wall',theme,layout,style:'vinyl',queue:true,width:360,height:740,zoom});
  for(const theme of ['light','dark']) for(const [width,height] of [[1280,800],[360,740],[240,600]]) cases.push({kind:'player',theme,bg:'art',source:'playlist',style:'cd',panel:'playlist',width,height});
  for(const theme of ['light','dark']) for(const [width,height,zoom] of [[1280,800,1],[360,740,1],[640,360,1],[360,740,2]]) cases.push({kind:'player',theme,bg:'dark',style:'cd',panel:'queue',longQueue:true,width,height,zoom});
  if(process.argv.includes('--queue')) cases.splice(0,cases.length,...cases.filter(item=>item.panel==='queue'||item.queue||item.source==='playlist'));
  if(process.argv.includes('--mini')) cases.splice(0,cases.length,...cases.filter(item=>item.kind==='wall'));
  if(process.argv.includes('--quick')) {
    const selected=cases.filter(item=>item.width===1280&&item.kind==='player'&&item.panel==='playlist'||item.kind==='wall'&&item.width===360&&item.style==='cover');
    cases.splice(0,cases.length,...selected);
  }
  if(process.argv.includes('--library')) {
    cases.splice(0,cases.length);
    for(const theme of ['light','dark']) for(const lang of ['zh-CN','zh-TW','en']) for(const [width,height] of [[1280,800],[768,1024],[360,740],[240,600]]) for(const page of ['home','created','collected','likes','detail','search','songs','artists','artist','albums','error','empty','signedout']) cases.push({kind:'library',theme,lang,page,width,height});
    for(const zoom of [.5,1.5,2]) for(const page of ['created','detail','search','signedout']) cases.push({kind:'library',theme:'dark',lang:'en',page,width:360,height:740,zoom});
    for(const theme of ['light','dark']) for(const lang of ['zh-CN','zh-TW','en']) for(const [width,height] of [[2560,1080],[1280,800],[768,1024],[360,740],[640,360],[240,600]]) for(const page of ['created','detail','search'])cases.push({kind:'library',theme,lang,page,width,height,playing:true});
    for(const zoom of [.5,1.5,2]) for(const page of ['created','detail','search','signedout'])cases.push({kind:'library',theme:'dark',lang:'en',page,width:360,height:740,zoom,playing:true});
  }
  if(process.argv.includes('--finish')){
    cases.splice(0,cases.length);
    for(const theme of ['light','dark']) for(const bg of ['white','dark','art','wood']) for(const deviceCase of ['white','black','wood','art']) for(const style of ['vinyl','cd']) for(const [width,height] of [[1280,800],[360,740],[640,360]])cases.push({kind:'player',theme,bg,deviceCase,style,width,height,panel:'case',cover:'d8a430'});
    for(const deviceCase of ['white','black','wood','art'])for(const zoom of [.5,1.5,2])for(const style of ['vinyl','cd'])cases.push({kind:'player',theme:'dark',bg:'white',deviceCase,style,zoom,width:240,height:600,panel:'case',lang:'en'});
    for(const [width,height] of [[1280,800],[360,740],[240,600]])cases.push({kind:'player',theme:'light',bg:'white',deviceCase:'white',style:'cover',width,height,panel:'case'});
    for(const theme of ['light','dark'])for(const cover of ['326fa8','bb3b61','eeeeee','151925'])for(const [width,height] of [[1280,800],[360,740],[640,360]])cases.push({kind:'player',theme,bg:'art',deviceCase:'art',style:'vinyl',cover,width,height,panel:'case'});
  }
  if(process.argv.includes('--compact'))cases.splice(0,cases.length,...cases.filter(item=>item.zoom===2&&item.width===360&&item.playing));
  if(process.argv.includes('--library-quick'))cases.splice(0,cases.length,...cases.filter(item=>item.kind==='library'&&item.lang==='zh-CN'&&[1280,360,240].includes(item.width)&&['home','created','detail','albums','search','artist'].includes(item.page)||item.kind==='library'&&item.zoom===2));
  if(process.argv.includes('--tablet')) {
    cases.splice(0,cases.length);
    for(const theme of ['light','dark']) for(const [width,height] of [[1280,800],[800,1280]]) for(const zoom of [1,1.5]) {
      cases.push({kind:'player',tablet:true,theme,bg:'dark',style:'vinyl',panel:'quality',width,height,zoom});
      cases.push({kind:'wall',tablet:true,theme,layout:'shelf',style:'vinyl',width,height,zoom});
    }
  }
  const shotRoot=path.join(root,'tools/shots/playback');fs.mkdirSync(shotRoot,{recursive:true});
  let checks=0,failed=0;let savedFailures=0,keyboardChecked=false,playOrderChecked=false;
  for(let i=0;i<cases.length;i++) {
    const item=cases[i];
    await page('Emulation.setDeviceMetricsOverride',{width:item.width,height:item.height,deviceScaleFactor:1,mobile:false});
    await page('Page.navigate',{url:pathToFileURL(path.join(root,item.kind==='library'?'tools/library-ui-e2e.html':'tools/playback-ui-e2e.html')).href});
    for(let attempt=0;attempt<100;attempt++){if(await value("typeof window.setupPlaybackUI === 'function'"))break;await new Promise(r=>setTimeout(r,10));}
    const result=await value('window.setupPlaybackUI('+JSON.stringify(item)+')');checks+=result.checks;
    if(result.fail.length){failed++;console.log('FAIL '+JSON.stringify(item)+' '+JSON.stringify(result.fail));if(savedFailures++<6){const shot=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shotRoot,'failure-'+i+'.png'),Buffer.from(shot.data,'base64'));}}
    if(item.kind==='player'&&!keyboardChecked){
      const keyboard=await value('window.verifyKeyboardPlayback()');checks+=keyboard.checks;keyboardChecked=true;
      if(keyboard.fail.length){failed++;console.log('FAIL keyboard playback '+JSON.stringify(keyboard.fail));}
    }
    if(item.panel==='case'&&item.theme==='light'&&item.bg==='white'&&item.width===1280){const shot=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shotRoot,`finish-${item.deviceCase}-${item.style}.png`),Buffer.from(shot.data,'base64'));}
    if(item.panel==='case'&&item.theme==='light'&&item.bg==='art'&&item.width===1280){const shot=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shotRoot,`finish-cover-${item.cover}.png`),Buffer.from(shot.data,'base64'));}
    if(item.panel==='case'&&item.theme==='light'&&item.bg==='white'&&item.width===1280&&item.deviceCase==='black'&&item.style==='vinyl'){const details=await value('window.verifyCaseControls()');checks+=6;if(details.length){failed++;console.log('FAIL case controls '+JSON.stringify(details));}}
    if(item.kind==='library'&&item.playing&&item.theme==='light'&&item.lang==='zh-CN'&&item.width===1280&&item.page==='detail'){const mini=await value('window.verifyLibraryMini()');checks+=7;if(mini.length){failed++;console.log('FAIL library mini controls '+JSON.stringify(mini));}}
    if(item.kind==='library'&&item.theme==='dark'&&item.lang==='zh-CN'&&item.width===1280&&item.page==='created') {
      const navigation=await value('window.verifyLibraryNavigation()');checks+=3;
      if(!navigation.search||!navigation.more||!navigation.detail||!navigation.queued||!navigation.played){failed++;console.log('FAIL library navigation '+JSON.stringify(navigation));}
      if(navigation.fail?.length){failed++;console.log('FAIL new library actions '+JSON.stringify(navigation.fail));}
      checks++;if(!await value('window.verifyLibraryStale()')){failed++;console.log('FAIL logout stale cloud response');}
    }
    if(item.kind==='library'&&['home','created','detail','search','artist','albums'].includes(item.page)&&(item.lang==='zh-CN'&&[1280,360,240].includes(item.width)||item.zoom===2&&item.playing)){
      const shot=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shotRoot,'library-'+i+'-'+item.theme+'-'+item.width+'-'+item.page+'.png'),Buffer.from(shot.data,'base64'));
    }
    if(item.kind==='player'&&item.width===1280&&item.panel==='playlist') {
      const point=await value("(()=>{const r=document.querySelector('.mw-np__track:nth-child(2)').getBoundingClientRect();return {x:r.left+50,y:r.top+r.height/2}})()");
      await page('Input.dispatchMouseEvent',{type:'mouseMoved',x:point.x,y:point.y});
      checks++;
      if(await value("getComputedStyle(document.querySelector('.mw-np__track:nth-child(2)')).outlineStyle")!=='none'){failed++;console.log('FAIL playlist hover still has a host outline');}
      checks++;
      if(!await value('window.verifyHoverContrast()')){failed++;console.log('FAIL playlist hover text contrast');}
    }
    if(item.kind==='player'&&item.width===1280&&item.theme==='light'&&['dark','white','wood'].includes(item.bg)&&item.panel==='volume' || item.kind==='player'&&item.width===360&&item.theme==='dark'&&item.bg==='art'&&item.cover==='f5efe0'&&item.panel==='playlist'&& !item.zoom) {
      const shot=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shotRoot,`${i}-${item.bg}-${item.panel}.png`),Buffer.from(shot.data,'base64'));
    }
    if(item.kind==='wall'&&item.theme==='light'&&item.width===1280&&item.layout==='shelf' || item.kind==='wall'&&item.theme==='dark'&&item.width===360&&item.style==='cover' || item.kind==='player'&&item.width===640&&item.bg==='white'&&item.theme==='light'&&item.panel==='quality') {
      const shot=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shotRoot,`${i}-${item.kind}-${item.layout??item.bg}-${item.style}-${item.panel??'footer'}.png`),Buffer.from(shot.data,'base64'));
    }
    if(item.panel==='queue'&&!item.longQueue&&item.theme==='dark'&&item.bg==='dark'&&item.width===1280) {
      const queue=await value('window.verifyQueueUI()');checks+=7;if(queue.length){failed++;console.log('FAIL queue UI '+JSON.stringify(queue));}
    }
    if(item.panel==='queue'||item.queue){const shot=await page('Page.captureScreenshot',{format:'png'});if(item.width===1280||item.width===240||item.zoom===2)fs.writeFileSync(path.join(shotRoot,'queue-'+i+'-'+item.kind+'-'+item.theme+'-'+item.width+'.png'),Buffer.from(shot.data,'base64'));}
    if(item.kind==='wall'&&item.layout==='grid'&&item.style==='vinyl'&&item.theme==='light'&&item.width===1280){const shared=await value('window.verifySharedPlayback()');checks+=shared.checks;if(shared.fail.length){failed++;console.log('FAIL shared controls '+JSON.stringify(shared.fail));}}
    if(item.kind==='wall'&&item.layout==='list'&&item.style==='cover'&&item.width===1280&&item.theme==='dark') {
      const mini=await value('window.verifyMiniControls()');checks+=8;if(mini.length){failed++;console.log('FAIL mini controls '+JSON.stringify(mini));}
    }
    if(item.kind==='player'&&item.width===1280&&item.theme==='light'&&item.bg==='dark'&&item.panel==='volume') {
      const click=async(x,y)=>{await page('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await page('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});await page('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});await new Promise(r=>setTimeout(r,50));};
      const volume=await value("(()=>{const r=document.querySelector('.mw-np__volume-panel input').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+6+(r.height-12)*.25}})()");
      await click(volume.x,volume.y);checks++;
      if(Math.abs(await value('window.playbackEngine.volume')-.75)>.04){failed++;console.log('FAIL native vertical volume pointer mapping');}
      const seek=await value("(()=>{const r=document.querySelector('.mw-np__timeline .mw-slider').getBoundingClientRect();return {x:r.left+6+(r.width-12)*.25,y:r.top+r.height/2}})()");
      await click(seek.x,seek.y);checks++;
      if(Math.abs(await value('window.playbackEngine.state.positionMs')-65000)>2000){failed++;console.log('FAIL native seek pointer mapping');}
      const outside=await value('window.verifyOutside()');checks+=3;if(outside.length){failed++;console.log('FAIL outside click '+JSON.stringify(outside));}
      const clear=await value('window.verifyHostResize()');checks++;if(!clear){failed++;console.log('FAIL dynamic host status-bar resize/hide');}
    }
    if(!playOrderChecked&&item.kind!=='library'){
      const order=await value('window.verifyPlayOrderControls()');checks+=order.checks;playOrderChecked=true;
      if(order.fail.length){failed++;console.log('FAIL playback order controls '+JSON.stringify(order.fail));}
    }
    if((i+1)%50===0)console.log(`Checked ${i+1}/${cases.length} UI configurations`);
  }
  console.log(`${cases.length} UI configurations, ${checks} assertions, ${failed} failed configurations`);
  if(failed)process.exitCode=1;
  await send('Browser.close');
} finally {
  socket?.close();if(child.exitCode===null)await new Promise(resolve=>{const timer=setTimeout(resolve,3000);child.once('exit',()=>{clearTimeout(timer);resolve();});});if(child.exitCode===null)child.kill();
  const resolved=path.resolve(profile),tempRoot=path.resolve(os.tmpdir())+path.sep;
  if(resolved.startsWith(tempRoot)&&path.basename(resolved).startsWith('mw-playback-ui-'))try{await fs.promises.rm(resolved,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch{console.warn('Temporary browser profile retained: '+resolved);}
}
