import { verifyHiddenZoom } from "./hidden-zoom-ui";
import { MusicLibraryView } from '../src/ui/MusicLibraryView';
import { InternalPlayer } from '../src/core/internalPlayer';
import { AlbumSearchPanel } from '../src/ui/AlbumSearchPanel';
import { setLanguage, t } from '../src/i18n';
import { collectionSummary, statsSummary } from '../src/ui/collectionSummary';
import { CollectionStatsCache } from '../src/core/collectionStatsCache';
import { DEFAULT_SETTINGS } from '../src/types';
import { WorkspaceLeaf, installDomHelpers, probeCoverUri, MENU_LOG } from './obsidian-shim';
installDomHelpers();
const wait = (ms=15) => new Promise(resolve=>setTimeout(resolve,ms));
class TestAudio extends EventTarget {
 currentTime=0;duration=260;paused=true;ended=false;volume=1;
 async play(){this.paused=false;this.dispatchEvent(new Event('playing'));}
 pause(){this.paused=true;this.dispatchEvent(new Event('pause'));}removeAttribute(){}load(){}
}
let dispose=async()=>{};
(window as any).setupPlaybackUI=async(config:any)=>{
 await dispose();setLanguage(config.lang||'zh-CN');document.body.className=`theme-${config.theme} is-tablet`;document.body.style.setProperty('--mw-zoom',String(config.zoom||1));
 const mount=document.getElementById('mount')!;mount.empty();let checks=0;const fail:string[]=[];const check=(value:unknown,label:string)=>{checks++;if(!value)fail.push(label);};
 const cover=probeCoverUri(config.theme==='dark'?'31506d':'a9b5c0');
 const items=Array.from({length:9},(_,i)=>({id:i+1,name:`夜间公路与城市灯光 · Summer Night Drive Collection ${i+1}`,creator:'The Midnight / 测试歌单创建者',owner:i<5?42:7,cover,count:12,special:0}));
 const tracks=Array.from({length:24},(_,i)=>({id:i+1,name:`Nightlight · 夜色中的微光 — A very long track title ${i+1}`,artists:'Xeuphoria / The Midnight',duration:260000,albumId:i+100,albumName:'Original album',artistRefs:i===0?[{id:9,name:'Artist A'},{id:10,name:'Artist B'}]:[{id:9,name:'Artist A'}],cover}));
 const collection={albumId:0,playlistId:1,name:items[0].name,artist:items[0].creator,cover,tracks,trackCount:tracks.length};
 const albums=Array.from({length:4},(_,i)=>({albumId:i+100,name:items[i].name,artist:'The Midnight',cover,trackCount:3}));
 const artists=[{id:9,name:'The Midnight / 艺术家名字',cover}];
 let throwError=config.page==='error',blocked:((value:any)=>void)|null=null,apiCalls=0,wallAdded=0,tabTitle='';
 const searchCalls:any[]=[];
 const engine=new InternalPlayer({resolve:async()=>({url:'x',quality:'standard',trial:false}),load:async()=>new Blob(['x']),audio:()=>new TestAudio() as never,notice(){}});
 if(config.playing)await engine.playPlaylist(collection);
 const plugin:any={settings:{...DEFAULT_SETTINGS,neteaseCookie:config.page==='signedout'?'':'test-cookie',neteaseUserId:'42',neteaseNickname:'Music Wall 用户',zoomScale:config.zoom||1},
  internalPlayer:engine,nowPlaying:engine,async ensureNeteaseLogin(){return !!this.settings.neteaseCookie;},async openPlayerView(){},saveZoom(){},
  getPlaybackDeps(){return {isCurrent:()=>true,playInside:(meta:any)=>engine.playAlbum(meta)};},async fetchAlbumDetail(id:number){return {...(albums.find(a=>a.albumId===id)||albums[0]),albumId:id,trackCount:3,tracks:tracks.slice(0,3)};},async enqueueAlbum(meta:any){engine.enqueueAlbum(meta);},addLibraryAlbum(){wallAdded++;},
  libraryApi:{clear(){},async userPlaylists(){apiCalls++;if(throwError)throw Error();return config.page==='empty'?[]:items;},
   async searchContent(keyword:string,kind:string,_cookie:string,offset:number){apiCalls++;searchCalls.push({keyword,kind,offset});return {songs:kind==='songs'?tracks.slice(0,3):[],artists:kind==='artists'?artists:[],albums:kind==='albums'?albums:[],playlists:kind==='playlists'?items:[],more:offset===0};},
   async artistDetail(artist:any){return {artist,tracks:tracks.slice(0,3),albums,more:true};},async artistAlbums(){return {albums,more:false};},
   async playlistStats(){return {count:24,duration:6240000};},async songs(ids:number[]){return tracks.filter(track=>ids.includes(track.id));},async liked(){return collection;},async detail(){if(config.stale)return new Promise(resolve=>{blocked=resolve;});return collection;}}
 };
 const leaf:any=new WorkspaceLeaf({});const view=new MusicLibraryView(leaf,plugin);leaf.updateHeader=()=>{tabTitle=view.getDisplayText();};
 mount.appendChild(view.contentEl);await view.onOpen();const v=view as any;
 check(apiCalls===0&&view.getDisplayText()===t('library.home'),'Opening goes home without fetching private playlists');
 check(plugin.settings.libraryAppearance==='system'&&view.contentEl.dataset.libraryTheme===(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'),'library defaults to actual system appearance');
 check(!!view.contentEl.querySelector('.mw-cloud__home h1')&&!!view.contentEl.querySelector('form input'),'Home includes welcome and search');
 if(['created','collected','likes'].includes(config.page))await v.navigate(config.page);
 if(['error','empty'].includes(config.page))await v.navigate('created');
 if(config.page==='detail'){await v.navigate('created');await v.openPlaylist(items[0]);}
 if(['search','songs','albums','artists','artist'].includes(config.page)){
  v.keyword='Synthwave';v.searchKind=config.page==='search'?'playlists':config.page==='artist'?'artists':config.page;await v.navigate('search');
  if(config.page==='artist')await v.openArtist(artists[0]);
 }
 await wait(35);const root=view.contentEl,box=root.querySelector<HTMLElement>('.mw-zoombox')!,body=root.querySelector<HTMLElement>('.mw-cloud__body')!;
 check(tabTitle===view.getDisplayText()&&root.querySelector('h2')?.textContent===tabTitle,'Native tab and page title follow the active section');
 check(box.getBoundingClientRect().right<=innerWidth+1&&box.getBoundingClientRect().bottom<=innerHeight+1,'Zoom box fits the pane');
 check(body.scrollWidth<=body.clientWidth+1,'Library body has no horizontal overflow');
 const info=root.querySelector<HTMLElement>('.mw-cloud__collection-info');if(info)check(info.clientWidth>=Math.min(120,body.clientWidth-20),'Collection title has readable width at narrow zoom');
 check(root.querySelectorAll('.mw-mini').length===1,'One persistent mini player');
 const sidebar=root.querySelector<HTMLElement>('.mw-cloud__sidebar')!;
 const overlay=root.querySelector<HTMLButtonElement>('.mw-cloud__overlay')!,menu=root.querySelector<HTMLButtonElement>('.mw-cloud__menu')!;
 check(getComputedStyle(overlay).display==='none'&&overlay.getClientRects().length===0,'Closed drawer overlay is invisible and takes no space');
 check(v.narrow?getComputedStyle(menu).display!=='none':getComputedStyle(menu).display==='none','Header drawer button appears only in narrow layout');
 check([...sidebar.querySelectorAll<HTMLButtonElement>('[data-section]')].map(b=>b.dataset.section).join(',')==='search,likes,created,collected','Sidebar order matches requested sections');
 for(const icon of root.querySelectorAll<HTMLElement>('.mw-svg-action')){
  check(!!icon.querySelector('svg'),'Each new action has an SVG');const svg=icon.querySelector('svg')!;
  if(icon.getClientRects().length){const r=svg.getBoundingClientRect();check(r.width>=17*(config.zoom||1)&&r.height>=17*(config.zoom||1),'Tablet styles cannot shrink SVG actions');}
 }
 for(const row of root.querySelectorAll<HTMLElement>('.mw-cloud__track'))check(row.scrollWidth<=row.clientWidth+1,'Long track names and actions do not overflow');
 if(config.page==='created')check(root.querySelectorAll('.mw-cloud__card').length===5,'Created uses account ownership');
 if(config.page==='collected')check(root.querySelectorAll('.mw-cloud__card').length===4,'Saved playlists read existing account collections');
 if(config.page==='detail')check(root.querySelectorAll('.mw-cloud__track').length===24,'Playlist displays all songs');
 if(config.page==='likes')check(view.getDisplayText()===t('library.likes'),'Liked section keeps its own title');
 if(config.page==='artist'){check(root.querySelectorAll('.mw-cloud__track').length===3&&!root.querySelector('.mw-cloud__album'),'Artist defaults to songs only');root.querySelector<HTMLButtonElement>('[data-artist-section=albums]')!.click();await wait();check(root.querySelectorAll('.mw-cloud__album').length===4&&!root.querySelector('.mw-cloud__track'),'Artist album tab shows albums only');}
 if(config.page==='error'){check(!!v.retry,'Error shows retry');throwError=false;await v.retry();check(root.querySelectorAll('.mw-cloud__card').length===5,'Retry recovers');}
 if(config.playing){
  const mini=root.querySelector<HTMLElement>('.mw-mini')!,r=mini.getBoundingClientRect(),bar=document.querySelector('.status-bar')!.getBoundingClientRect();
  check(!mini.classList.contains('is-hidden'),'Playing shows footer');check(r.bottom<=innerHeight+1&&r.left>=-1&&r.right<=innerWidth+1,'Footer fits pane');
  check(body.getBoundingClientRect().bottom<=r.top+1,'Content reserves footer space');check(mini.scrollWidth<=mini.clientWidth+1,'Footer has no horizontal overflow');
  check(mini.querySelector('.mw-mini__tools')!.getBoundingClientRect().bottom<=bar.top+1,'Footer clears host status bar');
 }
 // Drawer and wide collapse work without rebuilding the player or dropping search state.
 const beforeNav={tab:v.tab,collection:v.collection,playlistItem:v.playlistItem,artist:v.artist,artistItem:v.artistItem,lists:v.lists,results:v.results,offset:v.offset,retry:v.retry,keyword:v.keyword};
 const footer=root.querySelector('.mw-mini');await v.toggleNav();
 if(v.narrow){check(v.drawer&&getComputedStyle(sidebar).display==='flex','Narrow opens a drawer');check(root.querySelector('.mw-cloud__main')!.hasAttribute('inert'),'Drawer blocks background keyboard focus');check(getComputedStyle(overlay).display==='block'&&!overlay.hidden,'Open drawer displays its backdrop');overlay.click();await wait();check(!v.drawer&&getComputedStyle(overlay).display==='none','Backdrop closes the drawer and disappears');await v.toggleNav();await v.navigate('search');check(!v.drawer&&sidebar.hasAttribute('inert'),'Section selection closes narrow drawer');}
 else{check(!v.wideExpanded&&sidebar.getBoundingClientRect().width<=65*(config.zoom||1),'Wide collapse keeps a slim icon rail');await v.toggleNav();}
 check(root.querySelector('.mw-mini')===footer,'Navigation preserves mini player instance');
 Object.assign(v,beforeNav);v.render();
 // Exercise the wall search at this pane's logical width, including tablet padding and 200% zoom.
 const probe=document.createElement('div');probe.className='mw-view';probe.style.cssText=`position:fixed;left:0;top:0;width:${Math.max(80,innerWidth/(config.zoom||1)-20)}px;height:auto;z-index:10000`;
 document.body.appendChild(probe);const narrowPanel=new AlbumSearchPanel({searchAlbums:async()=>albums,fetchAlbumDetail:plugin.fetchAlbumDetail,getExistingIds:()=>new Set(),addAlbum(){},confirmAdd(){},enqueueAlbum:async()=>{}});
 narrowPanel.mount(probe.createDiv());(narrowPanel as any).results=albums;(narrowPanel as any).renderList();
 for(const row of probe.querySelectorAll<HTMLElement>('.mw-search-row'))check(row.scrollWidth<=row.clientWidth+1,'Wall search actions fit narrow panel');
 for(const svg of probe.querySelectorAll<SVGElement>('.mw-search-row__actions svg'))check(svg.getBoundingClientRect().width>=17,'Wall search keeps every SVG visible');
 narrowPanel.dispose();probe.remove();
 (window as any).verifyLibraryDetails=async()=>{
  const errors:string[]=[];let count=0;const expect=(ok:unknown,label:string)=>{count++;if(!ok)errors.push(label);};
  const themeButton=root.querySelector<HTMLButtonElement>('.mw-cloud__appearance')!,footerBefore=root.querySelector('.mw-mini'),bodyBefore=body.firstElementChild;
  const callsBefore=apiCalls,songBefore=engine.state.songId;
  const menuCount=MENU_LOG.length;
  themeButton.click();await wait();
  expect(MENU_LOG.length===menuCount&&!themeButton.hasAttribute('aria-haspopup'),'appearance cycles without a menu');
  expect(root.dataset.libraryTheme==='light'&&themeButton.querySelector<SVGElement>('svg')!.dataset.icon==='sun'&&getComputedStyle(themeButton).color==='rgb(0, 0, 0)','day mode uses black sun');
  themeButton.click();await wait();
  expect(root.dataset.libraryTheme==='dark'&&themeButton.querySelector<SVGElement>('svg')!.dataset.icon==='moon'&&getComputedStyle(themeButton).color==='rgb(255, 255, 255)','night mode uses white moon');
  expect(plugin.settings.libraryAppearance==='dark'&&apiCalls===callsBefore&&engine.state.songId===songBefore&&root.querySelector('.mw-mini')===footerBefore&&body.firstElementChild===bodyBefore,'appearance changes persist preference without refetching, rerendering or affecting audio');
  themeButton.click();await wait();expect(themeButton.querySelector<SVGElement>('svg')!.dataset.icon==='sun-moon','cycle returns to system mode');
  for(const tab of ['created','collected']) {
   await v.navigate(tab);await wait(100);
   expect(root.querySelector('.mw-cloud__card-stats')?.textContent===statsSummary({count:24,duration:6240000}),tab+' card shows actual count and hours');
  }
  v.keyword='Search';v.searchKind='playlists';await v.navigate('search');await wait(100);
  expect(root.querySelector('.mw-cloud__card-stats')?.textContent===statsSummary({count:24,duration:6240000}),'playlist search card shows count and total duration');
  v.searchKind='albums';await v.navigate('search');await wait(100);
  expect(root.querySelector('.mw-cloud__card-stats')?.textContent===statsSummary({count:3,duration:780000}),'album search card shows count and minutes');
  await v.openArtist(artists[0]);
  expect(root.querySelectorAll('.mw-cloud__track').length===3&&!root.querySelector('.mw-cloud__album'),'artist defaults to songs');
  expect(!!root.querySelector('.mw-cloud__head .mw-cloud__back')&&!root.querySelector('.mw-cloud__collection [data-icon=arrow-left]'),'artist back is in top heading');
  root.querySelector<HTMLButtonElement>('[data-artist-section=albums]')!.click();await wait();
  expect(!root.querySelector('.mw-cloud__track')&&root.querySelectorAll('.mw-cloud__album').length===4,'artist tabs are exclusive');
  await wait(100);expect(root.querySelector('.mw-cloud__card-stats')?.textContent===statsSummary({count:3,duration:780000}),'artist album card shows count and duration');
  const oldSong=engine.state.songId;root.querySelector<HTMLButtonElement>('.mw-cloud__album-card')!.click();await wait();
  expect(v.albumItem?.albumId===100&&root.querySelectorAll('.mw-cloud__track').length===3,'artist album opens track detail');
  expect(engine.state.songId===oldSong,'browsing album never plays');
  expect(root.querySelector('.mw-cloud__summary')?.textContent===collectionSummary(v.collection),'album shows song count and duration');
  const albumRow=root.querySelector<HTMLElement>('.mw-cloud__track:nth-child(2)')!;
  albumRow.click();await wait();expect(engine.state.songId===oldSong,'single click on a song row never starts playback');
  albumRow.querySelector('.mw-cloud__name')!.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,button:0}));await wait();
  expect(engine.contentKind==='album'&&engine.state.songId===tracks[1].id&&engine.index===1,'double click album row plays selected song in album');
  const songBeforeControls=engine.state.songId;
  for(const element of albumRow.querySelectorAll('button')) element.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,button:0}));
  await wait();expect(engine.state.songId===songBeforeControls,'double click links or action buttons never invokes row playback');
  root.querySelector<HTMLButtonElement>('.mw-cloud__track [data-track-action=play]')!.click();await wait();
  expect(engine.contentKind==='album'&&engine.album?.albumId===100,'album detail uses album playback');
  root.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,button:3}));root.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,button:3}));root.dispatchEvent(new MouseEvent('auxclick',{bubbles:true,cancelable:true,button:3}));await wait();expect(v.artistSection==='albums'&&!!root.querySelector('.mw-cloud__album'),'back restores artist album tab');
  root.querySelector<HTMLButtonElement>('[data-artist-section=songs]')!.click();await wait();
  root.querySelector('.mw-cloud__track:nth-child(3) .mw-cloud__name')!.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,button:0}));await wait();
  expect(engine.state.songId===tracks[2].id,'artist song list supports double click playback');
  root.querySelector<HTMLButtonElement>('.mw-cloud__track [data-link=album]')!.click();await wait();
  expect(v.collection?.albumId===100,'song album metadata opens correct album');
  v.back();root.querySelector<HTMLButtonElement>('.mw-cloud__track:nth-child(2) [data-link=artist]')!.click();await wait();
  expect(v.artistItem?.id===9&&!document.querySelector('.mw-picker'),'single artist opens directly');
  v.back();root.querySelector<HTMLButtonElement>('.mw-cloud__track [data-link=artist]')!.click();await wait();
  const choices=document.querySelectorAll<HTMLElement>('.mw-picker__row');expect(choices.length===2,'multiple artists show chooser');
  choices[1]?.click();await wait();expect(v.artistItem?.id===10,'chooser opens selected artist id');
  v.back();
  v.keyword='Search';v.searchKind='songs';await v.navigate('search');await wait();
  const queueBefore=engine.album!.tracks!.length;
  root.querySelector('.mw-cloud__track:nth-child(2) .mw-cloud__name')!.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,button:0}));await wait();
  expect(engine.state.songId===tracks[1].id&&engine.album!.tracks!.length>=queueBefore,'search double click plays selected song while retaining queue');
  await v.openPlaylist(items[0]);
  root.querySelector('.mw-cloud__track:nth-child(4) .mw-cloud__name')!.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,button:0}));await wait();
  expect(engine.contentKind==='playlist'&&engine.album?.playlistId===items[0].id&&engine.index===3,'playlist double click plays selected song in playlist');
  body.scrollTop=120;const savedScroll=body.scrollTop;
  const restore=v.captureReturnState(),copy=new MusicLibraryView(new WorkspaceLeaf(view.app),plugin as never);mount.append(copy.contentEl);await copy.onOpen();await restore(copy);
  expect((copy as any).collection?.playlistId===items[0].id&&copy.contentEl.querySelectorAll('.mw-cloud__track').length===tracks.length,'closed library can restore playlist detail in a recreated view');
  expect(Math.abs(copy.contentEl.querySelector('.mw-cloud__body')!.scrollTop-savedScroll)<2,'recreated source restores list scroll position');
  await copy.onClose();copy.contentEl.remove();
  const many={...collection,tracks:Array.from({length:225},(_,i)=>({...tracks[i%tracks.length],id:i+1})),trackCount:225};
  v.artist=null;v.artistItem=null;v.albumItem=null;v.playlistItem=items[0];v.collection=many;v.render();
  const row=root.querySelector<HTMLElement>('.mw-cloud__track:nth-child(225)')!;
  expect(row.querySelector('.mw-cloud__number')?.textContent==='225','three digit index remains complete');
  expect(getComputedStyle(row.querySelector('.mw-cloud__number')!).textAlign==='right','indices align right');
  expect(row.querySelector('.mw-cloud__track-info')!.getBoundingClientRect().left-row.querySelector('.mw-cloud__number')!.getBoundingClientRect().right>=10,'three digit index keeps name gap');
  expect(root.querySelector('.mw-cloud__summary')?.textContent===collectionSummary(many),'playlist displays complete duration');
  const summary=(duration:number)=>collectionSummary({...collection,tracks:[{...tracks[0],duration}]});
  expect(summary(2700000).includes('45分钟')&&!summary(2700000).includes('45.0'),'integer minutes omit decimal');
  expect(summary(3600000).includes('1小时')&&!summary(3600000).includes('1.0'),'one hour switches units');
  expect(summary(5400000).includes('1.5小时'),'fractional hours retain one decimal');
  expect(summary(90500).includes('1.5分钟'),'fractional minutes retain one decimal');
  const first=root.querySelector<HTMLElement>('.mw-cloud__track')!;
  first.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:500,clientY:300}));
  const context=MENU_LOG.at(-1)!.items.map(item=>item.title).join('|');
  expect(MENU_LOG.at(-1)!.items.length===5&&MENU_LOG.at(-1)!.items.every(item=>!!item.icon),'song context has five SVG actions');
  first.querySelector<HTMLButtonElement>('[data-track-action=more]')!.click();await wait();
  expect(MENU_LOG.at(-1)!.items.map(item=>item.title).join('|')===context,'overflow and right click share menu');
  const before=engine.album!.tracks!.length,position=engine.state.positionMs;
  MENU_LOG.at(-1)!.items[1].run?.();await wait();
  expect(engine.album!.tracks!.length===before+1&&engine.state.positionMs===position,'menu next preserves playback position');
  let copied='';const clipboard=Object.getOwnPropertyDescriptor(navigator,'clipboard');Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{copied=value;}}});
  MENU_LOG.at(-1)!.items[4].run?.();await wait();expect(copied==='https://music.163.com/#/song?id=1','copy action uses song id');
  if(clipboard)Object.defineProperty(navigator,'clipboard',clipboard);else delete (navigator as any).clipboard;
  const initialMenus=MENU_LOG.length;
  first.dispatchEvent(new PointerEvent('pointerdown',{pointerId:51,pointerType:'touch',isPrimary:true,clientX:400,clientY:300,bubbles:true}));
  await wait(470);expect(MENU_LOG.length===initialMenus+1,'touch hold opens one menu');
  document.dispatchEvent(new PointerEvent('pointerup',{pointerId:99,pointerType:'touch',bubbles:true}));
  const cancelledClick=new MouseEvent('click',{detail:1,bubbles:true,cancelable:true});first.dispatchEvent(cancelledClick);
  expect(cancelledClick.defaultPrevented,'hold suppresses compatibility click even before matching release');
  document.dispatchEvent(new PointerEvent('pointerup',{pointerId:51,pointerType:'touch',bubbles:true}));
  first.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));expect(MENU_LOG.length===initialMenus+1,'native context duplicate suppressed');
  await wait(710);
  first.dispatchEvent(new PointerEvent('pointerdown',{pointerId:52,pointerType:'touch',isPrimary:true,clientX:400,clientY:300,bubbles:true}));
  document.dispatchEvent(new PointerEvent('pointermove',{pointerId:52,pointerType:'touch',clientX:400,clientY:340,bubbles:true}));await wait(470);
  expect(MENU_LOG.length===initialMenus+1,'scroll movement cancels long press');
  first.dispatchEvent(new PointerEvent('pointerdown',{pointerId:53,pointerType:'pen',isPrimary:true,clientX:400,clientY:300,bubbles:true}));
  await v.navigate('home');await wait(470);expect(MENU_LOG.length===initialMenus+1,'navigation disposes pending hold');
  await v.openArtist(artists[0]);root.querySelector('.mw-cloud__track')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  MENU_LOG.at(-1)!.items[2].run?.();await wait();expect(v.collection?.albumId===100,'menu view album follows metadata');
  v.back();root.querySelector<HTMLButtonElement>('[data-artist-section=albums]')!.click();await wait();root.querySelector('.mw-cloud__album')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));
  expect(MENU_LOG.at(-1)!.items.length===5,'album context has details preview wall queue and copy');
  await v.navigate('created');root.querySelector('.mw-cloud__card')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));expect(MENU_LOG.at(-1)!.items.length===4,'playlist context has details play append and copy');
  v.keyword='Artist';v.searchKind='artists';await v.navigate('search');root.querySelector('.mw-cloud__artist-card')!.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));expect(MENU_LOG.at(-1)!.items.length===2,'artist context has details and copy');
  await v.navigate('home');v.resetCardStats();v.statsCache.clear();
  const statsHost=body.createDiv(),resolvers:((value:any)=>void)[]=[];let started=0;
  for(let i=0;i<6;i++)v.cardStats(statsHost.createDiv(),'probe:'+i,5,()=>{started++;return new Promise(resolve=>resolvers.push(resolve));});
  for(const start of v.statsTargets.values())start();v.statsObserver?.disconnect();v.statsTargets.clear();await wait();
  expect(started===2,'card metadata loads at most two collections concurrently');
  for(let i=0;i<6;i++){resolvers.shift()!({count:5,duration:120000});await wait();}
  expect(started===6&&[...statsHost.querySelectorAll('.mw-cloud__card-stats')].every(node=>node.textContent===statsSummary({count:5,duration:120000})),'queued card metadata completes without blocking render');
  const cached=statsHost.createDiv();v.cardStats(cached,'probe:0',5,async()=>{started++;return {count:0,duration:0};});
  v.statsTargets.get(cached)?.();await wait();expect(started===6,'repeated card reuses cached statistics');
  v.resetCardStats();const stale=statsHost.createDiv();let finishStats:any;
  v.cardStats(stale,'stale',5,()=>new Promise(resolve=>{finishStats=resolve;}));v.statsTargets.get(stale)?.();await wait();
  const pending=stale.textContent;v.resetCardStats();finishStats({count:99,duration:0});await wait();expect(stale.textContent===pending,'navigation ignores late card metadata');
  const unavailable=statsHost.createDiv();v.cardStats(unavailable,'unavailable',5,async()=>{throw Error('Offline');});v.statsTargets.get(unavailable)?.();await wait();
  expect(unavailable.textContent===statsSummary({count:5})&&!v.statsCache.has('unavailable'),'failed metadata preserves song count and is retryable');
  v.resetCardStats();statsHost.empty();v.statsCache.clear();
  let statsDisk='',statsTime=1000000,persistentCalls=0;
  const storage={exists:async()=>!!statsDisk,read:async()=>statsDisk,write:async(_path:string,content:string)=>{statsDisk=content;}};
  const newCache=()=>new CollectionStatsCache(storage,'cache',()=>statsTime);
  plugin.collectionStatsCache=newCache();
  const persistentCard=async(loader:()=>Promise<any>)=>{
   const card=statsHost.createDiv();v.cardStats(card,'playlist:909',5,loader);v.statsTargets.get(card)?.();await wait(30);return card;
  };
  await persistentCard(async()=>{persistentCalls++;return {count:5,duration:120000};});await plugin.collectionStatsCache.flush();
  plugin.collectionStatsCache=newCache();v.statsCache.clear();
  const restored=await persistentCard(async()=>{persistentCalls++;throw Error('Unexpected network');});
  expect(persistentCalls===1&&restored.textContent===statsSummary({count:5,duration:120000}),'statistics survive cache recreation and refresh without network');
  statsTime+=6*3600000;let finishRefresh:any;
  const staleCard=await persistentCard(()=>{persistentCalls++;return new Promise(resolve=>{finishRefresh=resolve;});});
  expect(staleCard.textContent===statsSummary({count:5,duration:120000}),'expired statistics remain visible during background update');
  finishRefresh({count:5,duration:180000});await wait();
  expect(staleCard.textContent===statsSummary({count:5,duration:180000}),'background update replaces expired statistics');
  await plugin.collectionStatsCache.flush();delete plugin.collectionStatsCache;
  v.resetCardStats();statsHost.remove();
  return {checks:count,fail:errors};
 };
 (window as any).setLibraryAppearance=async(mode:string)=>{
  for(let i=0;i<3&&plugin.settings.libraryAppearance!==mode;i++) { root.querySelector<HTMLButtonElement>('.mw-cloud__appearance')!.click();await wait(); }

 };
 (window as any).libraryAppearanceState=()=>({theme:root.dataset.libraryTheme,mode:plugin.settings.libraryAppearance,color:getComputedStyle(root.querySelector('.mw-cloud__appearance')!).color});
 let nativeMenuCount=0,nativeSong:number|undefined;
 (window as any).prepareLibraryNativeHold=async()=>{
  await v.navigate('created');nativeMenuCount=MENU_LOG.length;nativeSong=engine.state.songId;
  const card=root.querySelector<HTMLElement>('.mw-cloud__card')!.getBoundingClientRect();
  return {x:card.left+card.width/2,y:card.top+card.height/2};
 };
 (window as any).libraryNativeHoldResult=()=>({menus:MENU_LOG.length-nativeMenuCount,detail:!!v.collection,unchanged:engine.state.songId===nativeSong});
 (window as any).prepareLibraryNativeMore=async()=>{
  await v.openPlaylist(items[0]);nativeMenuCount=MENU_LOG.length;
  const button=root.querySelector<HTMLElement>('[data-track-action=more]')!.getBoundingClientRect();return {x:button.left+button.width/2,y:button.top+button.height/2};
 };
 (window as any).libraryNativeMoreResult=()=>({menus:MENU_LOG.length-nativeMenuCount,actions:MENU_LOG.at(-1)?.items.length});
 (window as any).verifyLibraryMini=async()=>{
  const errors:string[]=[];const mini=root.querySelector<HTMLElement>('.mw-mini')!;
  mini.querySelector<HTMLButtonElement>('[data-action="toggle"]')!.click();await wait();if(engine.state.status!=='paused')errors.push('pause');
  mini.querySelector<HTMLButtonElement>('[data-action="next"]')!.click();await wait();if(engine.index!==1)errors.push('next');
  mini.querySelector<HTMLButtonElement>('[data-action="prev"]')!.click();await wait();if(engine.index!==0)errors.push('prev');
  const listeners=(engine as any).listeners.size;view.refresh();if((engine as any).listeners.size!==listeners||root.querySelector('.mw-mini')!==mini)errors.push('refresh subscriptions');return errors;
 };
 (window as any).verifyLibraryNavigation=async()=>{
  await v.navigate('home');let input=root.querySelector<HTMLInputElement>('form input')!;input.value='Synthwave';root.querySelector<HTMLButtonElement>('form button')!.click();await wait();
  check(root.querySelectorAll('.mw-cloud__track').length===3,'Home SVG search button submits');
  await engine.playPlaylist(collection);const oldIds=engine.album!.tracks!.map(t=>t.id);await engine.seek(42000);
  root.querySelector<HTMLButtonElement>('[data-track-action="next"]')!.click();await wait();check(engine.state.positionMs===42000&&engine.index===0,'Next action preserves audio position');check(engine.album!.tracks!.length===oldIds.length+1,'Next action retains old queue');
  root.querySelector<HTMLButtonElement>('.mw-cloud__track:nth-child(2) [data-track-action="play"]')!.click();await wait();check(engine.state.songId===2&&engine.album!.tracks!.length===oldIds.length+2,'Play now inserts and switches without discarding queue');
  root.querySelector<HTMLButtonElement>('[data-search-kind="albums"]')!.click();await wait();
  const queueButton=root.querySelector<HTMLButtonElement>('.mw-cloud__album .mw-cloud__actions button:last-child')!;queueButton.click();await wait();check(engine.albumQueue.length===1&&engine.contentKind==='playlist','Album enqueue leaves song playlist playing');
  root.querySelector<HTMLButtonElement>('.mw-cloud__album .mw-cloud__actions button:nth-child(2)')!.click();await wait();check(wallAdded===1,'Album can select a target wall');
  root.querySelector<HTMLButtonElement>('[data-search-kind="artists"]')!.click();await wait();root.querySelector<HTMLButtonElement>('.mw-cloud__artist-card')!.click();await wait();check(view.getDisplayText()===artists[0].name&&!!root.querySelector('[data-artist-section=albums]'),'Artist result opens detail');
  await v.back();root.querySelector<HTMLButtonElement>('[data-search-kind="playlists"]')!.click();await wait();const search=root.querySelectorAll('.mw-cloud__card').length===9;
  root.querySelector<HTMLButtonElement>('.mw-cloud__more')!.click();await wait();const more=root.querySelectorAll('.mw-cloud__card').length===18;check(searchCalls.at(-1).offset===30,'More uses the next offset');
  root.querySelector<HTMLButtonElement>('.mw-cloud__card')!.click();await wait();const detail=root.querySelectorAll('.mw-cloud__track').length===24;
  root.querySelector<HTMLButtonElement>('.mw-cloud__track:nth-child(3) [data-track-action="play"]')!.click();await wait();const played=engine.index===2&&engine.album?.tracks?.length===24;
  const collectionQueue=root.querySelector<HTMLButtonElement>('.mw-cloud__collection button:last-child')!;collectionQueue.click();await wait();const queued=engine.contentKind==='playlist'&&engine.album?.tracks?.length===24;
  // The wall search uses the same SVG queue action and works before adding an album.
  const host=document.createElement('div');host.className='mw-view';mount.appendChild(host);let enqueued=0;
  const panel=new AlbumSearchPanel({searchAlbums:async()=>albums,fetchAlbumDetail:plugin.fetchAlbumDetail,getExistingIds:()=>new Set(),addAlbum(){},confirmAdd(){},enqueueAlbum:async()=>{enqueued++;}});
  panel.mount(host);(panel as any).results=albums;(panel as any).renderList();host.querySelector<HTMLButtonElement>('.mw-search-row__queue')!.click();await wait();check(enqueued===1,'Wall search has working SVG enqueue');panel.dispose();host.remove();
  plugin.settings.neteaseCookie='';view.refresh();const oldEnsure=plugin.ensureNeteaseLogin;
  plugin.ensureNeteaseLogin=async()=>{plugin.settings.neteaseCookie='new-cookie';view.refresh();return true;};
  await v.single({...tracks[0],id:404},true);check(engine.state.songId===404,'First login resumes the requested search song');plugin.ensureNeteaseLogin=oldEnsure;
  return {search,more,detail,played,queued,fail:fail.slice(),checks};
 };
 (window as any).verifyLibraryStale=async()=>{
  plugin.libraryApi.detail=()=>new Promise(resolve=>{blocked=resolve;});const opening=v.openPlaylist(items[0]);await wait(0);plugin.settings.neteaseCookie='';engine.stop();view.refresh();blocked!(collection);await opening;
  const accountSafe=!root.querySelector('.mw-cloud__track')&&!!root.querySelector('.mw-cloud__home');
  let release:any;plugin.libraryApi.searchContent=()=>new Promise(resolve=>release=resolve);v.keyword='pending';await v.navigate('home');const searching=v.navigate('search');await wait(0);await v.navigate('home');release({songs:tracks,artists:[],albums:[],playlists:[],more:false});await searching;
  return accountSafe&&!!root.querySelector('.mw-cloud__home')&&!root.querySelector('.mw-cloud__track');
 };
 (window as any).verifyHiddenZoom=()=>verifyHiddenZoom(root,scale=>{plugin.settings.zoomScale=scale;view.syncZoomBox();});
 dispose=async()=>{engine.stop();await view.onClose();};return {checks,fail};
};
