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
  if(process.argv.includes('--mini-compact')) {
    cases.splice(0,cases.length);
    for(const theme of ['light','dark']) for(const width of [760,600,557,420,400,360,280,240,200]) for(const statusBar of [true,false]) cases.push({kind:'wall',theme,layout:'grid',style:'cover',width,height:740,statusBar});
    for(const zoom of [.5,1.5,2]) for(const width of [557,360,240]) cases.push({kind:'wall',theme:'dark',layout:'shelf',style:'vinyl',width,height:740,zoom});
  }
  if(process.argv.includes('--wall-nav')) {
    cases.splice(0,cases.length);
    for(const theme of ['light','dark']) for(const layout of ['grid','list','shelf']) for(const width of [1280,360]) cases.push({kind:'wall',theme,layout,style:'cover',width,height:800,wallNavigation:true});
  }
  if(process.argv.includes('--seek')) cases.splice(0,cases.length,...cases.filter(item=>item.kind==='wall'&&item.layout==='grid'&&item.style==='cover'&&[1280,360].includes(item.width)));
  if(process.argv.includes('--lyrics')) {
    cases.splice(0,cases.length);
    for(const theme of ['light','dark']) for(const [width,height,zoom] of [[1280,800,1],[768,1024,1],[360,740,1],[240,600,1],[640,360,1],[360,740,2]]) cases.push({kind:'player',panel:'lyrics',theme,bg:theme==='dark'?'dark':'white',style:'cover',width,height,zoom});
  }
  if(process.argv.includes('--height')) {
    cases.splice(0,cases.length);
    for(const style of ['vinyl','cd','cover']) for(const machine of [true,false]) for(const height of [800,700,660,642,621,620,600,520]) cases.push({kind:'player',panel:'height',theme:'dark',bg:'art',style,machine,width:1315,height});
    for(const style of ['vinyl','cd','cover']) for(const paneHeight of [642,600])cases.push({kind:'player',panel:'height',theme:'dark',bg:'art',style,machine:false,width:1315,height:1000,paneHeight});
    for(const [width,height,zoom] of [[768,642,1],[360,740,1],[640,360,1],[360,740,2]])cases.push({kind:'player',panel:'height',theme:'dark',bg:'art',style:'vinyl',machine:false,width,height,zoom});
  }
  if(process.argv.includes('--bare')) {
    cases.splice(0,cases.length);
    for(const theme of ['light','dark']) for(const style of ['vinyl','cd']) for(const [width,height] of [[1280,800],[360,740],[640,360]]) cases.push({kind:'player',panel:'bare',theme,bg:theme==='dark'?'dark':'white',style,width,height});
  }
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
  if(process.argv.includes('--wall-appearance')) {
    cases.splice(0,cases.length);
    for(const theme of ['light','dark'])for(const layout of ['grid','list','shelf'])for(const [width,height] of [[1280,800],[360,740],[240,600]])cases.push({kind:'wall',theme,layout,style:'vinyl',width,height});
  }
  if(process.argv.includes('--presets')) {
    cases.splice(0,cases.length);
    for(const theme of ['light','dark'])for(const [width,height,zoom] of [[1280,800,1],[1315,642,1],[768,1024,1],[360,740,1],[640,360,1],[240,600,1],[360,740,2]])cases.push({kind:'player',theme,bg:'dark',style:'vinyl',panel:'presets',presets:true,width,height,zoom});
  }
  if(process.argv.includes('--mouse-back')) {
    cases.splice(0,cases.length);
    for(const kind of ['wall','player'])for(const [width,height] of [[1280,800],[360,740]])cases.push({kind,width,height,theme:'dark',style:'vinyl',layout:'grid',panel:'playlist'});
  }
  if(process.argv.includes('--hidden-zoom')) {
    cases.splice(0,cases.length);
    for(const [width,height] of [[1280,800],[360,740]])for(const kind of ['wall','player','library'])cases.push({kind,width,height,theme:'dark',style:'vinyl',layout:'grid',panel:'playlist',page:'created',lang:'zh-CN'});
  }
  if(process.argv.includes('--history')) {
    cases.splice(0,cases.length);
    for(const lang of ['zh-CN','zh-TW','en'])for(const theme of ['light','dark'])for(const [width,height,zoom] of [[1280,800,1],[360,740,1],[240,600,1],[360,740,2]])cases.push({kind:'library',page:'home',lang,theme,width,height,zoom});
  }
  if(process.argv.includes('--cache-settings')) {
    cases.splice(0,cases.length);
    for(const lang of ['zh-CN','zh-TW','en'])for(const theme of ['light','dark'])for(const width of [1280,360,240])cases.push({kind:'settings',lang,theme,width,height:800});
  }
  if(process.argv.includes('--mini-keyboard')) {
    cases.splice(0,cases.length);
    for(const kind of ['wall','library'])for(const width of [1280,360])for(const layout of kind==='wall'?['grid','list','shelf']:['grid'])cases.push({kind,width,height:800,theme:'dark',style:'cover',layout,page:'home',playing:true});
  }
  const shotRoot=path.join(root,'tools/shots/playback');fs.mkdirSync(shotRoot,{recursive:true});
  let checks=0,failed=0;let savedFailures=0,keyboardChecked=false,playOrderChecked=false;
  for(let i=0;i<cases.length;i++) {
    const item=cases[i];
    if(item.kind==='library')await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'},{name:'prefers-color-scheme',value:item.theme}]});
    await page('Emulation.setDeviceMetricsOverride',{width:item.width,height:item.height,deviceScaleFactor:1,mobile:false});
    await page('Page.navigate',{url:pathToFileURL(path.join(root,item.kind==='library'?'tools/library-ui-e2e.html':item.kind==='settings'?'tools/settings-e2e.html':'tools/playback-ui-e2e.html')).href});
    for(let attempt=0;attempt<100;attempt++){if(await value("typeof window.setupPlaybackUI === 'function'"))break;await new Promise(r=>setTimeout(r,10));}
    const result=await value('window.setupPlaybackUI('+JSON.stringify(item)+')');checks+=result.checks;
    if(process.argv.includes('--mini-keyboard')){const keys=await value('window.verifyMiniKeyboard()');checks+=keys.checks;if(keys.fail.length){failed++;console.log('FAIL mini keyboard '+JSON.stringify(item)+' '+JSON.stringify(keys.fail));}}
    if(process.argv.includes('--history')){const history=await value('window.verifyHistoryUI()');checks+=history.checks;if(history.fail.length){failed++;console.log('FAIL history '+JSON.stringify(item)+' '+JSON.stringify(history.fail));}}
    if(process.argv.includes('--hidden-zoom')) {
      const hidden=await value('window.verifyHiddenZoom()');checks+=hidden.checks;
      if(hidden.fail.length){failed++;console.log('FAIL hidden zoom '+item.kind+' '+item.width+' '+JSON.stringify(hidden.fail));}
    }
    if(process.argv.includes('--mouse-back')) {
      const back=await value('window.verifyMouseBack()');checks+=back.checks;if(back.fail.length){failed++;console.log('FAIL mouse back '+JSON.stringify(item)+' '+JSON.stringify(back.fail));}
    }
    if(item.presets){const presets=await value('window.verifyPlayerPresets()');checks+=presets.checks;if(presets.fail.length){failed++;console.log('FAIL presets '+JSON.stringify(item)+' '+JSON.stringify(presets.fail));}if(item.width===1280){const target=await value('window.prepareStyleHover()');await page('Input.dispatchMouseEvent',{type:'mouseMoved',x:target.x,y:target.y});await new Promise(r=>setTimeout(r,100));const hover=await value('window.styleHoverResult()');checks++;if(!hover.matches||!hover.hover){failed++;console.log('FAIL style hover '+JSON.stringify(hover));}await value('window.prepareStylePanelScreenshot()');}const shot=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shotRoot,`presets-${item.theme}-${item.width}-${item.zoom}.png`),Buffer.from(shot.data,'base64'));}
    if(process.argv.includes('--wall-appearance')){const appearance=await value('window.verifyWallAppearance()');checks+=appearance.checks;if(appearance.fail.length){failed++;console.log('FAIL wall appearance '+JSON.stringify(item)+' '+JSON.stringify(appearance.fail));}}
    if(result.fail.length){failed++;console.log('FAIL '+JSON.stringify(item)+' '+JSON.stringify(result.fail));if(savedFailures++<6){const shot=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shotRoot,'failure-'+i+'.png'),Buffer.from(shot.data,'base64'));}}
    if(item.wallNavigation){const nav=await value('window.verifyWallAlbumNavigation()');checks+=nav.checks;if(nav.fail.length){failed++;console.log('FAIL wall album navigation '+JSON.stringify(item)+' '+JSON.stringify(nav.fail));}}
    if(item.panel==='bare') {
      await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
      const bare=await value('window.verifyStandaloneDiscs()');checks+=bare.checks;if(bare.fail.length){failed++;console.log('FAIL bare disc '+JSON.stringify({item,errors:bare.fail}));}
      await new Promise(resolve=>setTimeout(resolve,350));
      const shot=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shotRoot,`bare-${item.style}-${item.theme}-${item.width}.png`),Buffer.from(shot.data,'base64'));
      await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    }
    if(item.panel==='lyrics') {
      const test=await value('window.verifyLyricsUI()');checks+=test.checks;if(test.fail.length){failed++;console.log('FAIL lyrics '+JSON.stringify({item,errors:test.fail}));}
      if(item.width===1280&&item.theme==='dark'){
        await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
        const motion=await value('window.verifyLyricMotion()');checks+=motion.checks;if(motion.fail.length){failed++;console.log('FAIL lyric motion '+JSON.stringify(motion.fail));}
        await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      }
      await value('window.prepareLyricsScreenshot()');
      const shot=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(shotRoot,`lyrics-${item.theme}-${item.width}-${item.zoom}.png`),Buffer.from(shot.data,'base64'));
    }
    if(process.argv.includes('--seek')) {
      for(const buffering of [false,true]) for(const touch of [false,true]) {
        const p=await value('window.prepareMiniSeek('+buffering+')');
        const preview=async()=>{
          const state=await value('window.miniSeekResult()');checks++;
          if(state.writes!==0||state.position!==0||!state.dragging||state.disabled){failed++;console.log('FAIL mini seek preview '+JSON.stringify({touch,buffering,state}));}
        };
        if(touch) {
          await page('Emulation.setTouchEmulationEnabled',{enabled:true});
          await page('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:p.x,y:p.y}]});
          for(let step=1;step<=5;step++)await page('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:p.x+(p.end-p.x)*step/5,y:p.y}]});
          await preview();
          await page('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
          await page('Emulation.setTouchEmulationEnabled',{enabled:false});
        } else {
          await page('Input.dispatchMouseEvent',{type:'mousePressed',x:p.x,y:p.y,button:'left',clickCount:1});
          for(let step=1;step<=5;step++)await page('Input.dispatchMouseEvent',{type:'mouseMoved',x:p.x+(p.end-p.x)*step/5,y:p.y,button:'left',buttons:1});
          await preview();
          await page('Input.dispatchMouseEvent',{type:'mouseReleased',x:p.end,y:p.y,button:'left',clickCount:1});
        }
        await new Promise(resolve=>setTimeout(resolve,50));
        const state=await value('window.miniSeekResult()');checks++;
        if(!p.hit||Math.abs(state.position/state.duration-.75)>.04||state.status!==(buffering?'playing':'paused')||state.writes!==1){failed++;console.log('FAIL native mini seek '+JSON.stringify({touch,buffering,width:item.width,hit:p.hit,state}));}
        checks++;if(!await value('window.verifyMiniSeekFollow()')){failed++;console.log('FAIL mini progress stops following while focused '+JSON.stringify({touch,width:item.width}));}
      }
      const lifecycle=await value('window.verifyMiniSeekLifecycle()');checks+=10;if(lifecycle.length){failed++;console.log('FAIL mini seek lifecycle '+JSON.stringify(lifecycle));}
    }
    if(item.kind==='player'&&item.panel!=='height'&&!item.presets&&!keyboardChecked){
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
      const features=await value('window.verifyLibraryDetails()');checks+=features.checks;if(features.fail.length){failed++;console.log('FAIL library detail features '+JSON.stringify(features.fail));}
      await value("window.setLibraryAppearance('system')");
      for(const theme of ['light','dark']){
        await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'},{name:'prefers-color-scheme',value:theme}]});
        const appearance=await value('new Promise(resolve=>setTimeout(()=>resolve(window.libraryAppearanceState()),60))');checks++;
        if(appearance.theme!==theme||appearance.color!==(theme==='dark'?'rgb(255, 255, 255)':'rgb(0, 0, 0)')){failed++;console.log('FAIL system appearance '+JSON.stringify(appearance));}
      }
      await value("window.setLibraryAppearance('light')");
      await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'},{name:'prefers-color-scheme',value:'dark'}]});
      checks++;if((await value('window.libraryAppearanceState()')).theme!=='light'){failed++;console.log('FAIL explicit appearance changed with OS');}
      await value("window.setLibraryAppearance('system')");
      await page('Emulation.setTouchEmulationEnabled',{enabled:true});
      const hold=await value('window.prepareLibraryNativeHold()');await page('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[hold]});await new Promise(r=>setTimeout(r,550));await page('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await new Promise(r=>setTimeout(r,50));
      const held=await value('window.libraryNativeHoldResult()');checks++;if(held.menus!==1||held.detail||!held.unchanged){failed++;console.log('FAIL native library hold '+JSON.stringify(held));}
      const overflow=await value('window.prepareLibraryNativeMore()');await page('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[overflow]});await page('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await new Promise(r=>setTimeout(r,50));
      const overflowResult=await value('window.libraryNativeMoreResult()');checks++;if(overflowResult.menus!==1||overflowResult.actions!==5){failed++;console.log('FAIL native library overflow '+JSON.stringify(overflowResult));}
      await page('Emulation.setTouchEmulationEnabled',{enabled:false});
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
      const switches=await value('window.verifyQueueSwitches()');checks+=switches.checks;if(switches.fail.length){failed++;console.log('FAIL queue browsing/source '+JSON.stringify(switches.fail));} await value('window.setupPlaybackUI('+JSON.stringify(item)+')');
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
    if(!playOrderChecked&&item.kind!=='library'&&item.kind!=='settings'&&item.panel!=='height'&&!item.presets){
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
