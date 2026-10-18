import { MusicLibraryView } from '../src/ui/MusicLibraryView';
import { InternalPlayer } from '../src/core/internalPlayer';
import { AlbumSearchPanel } from '../src/ui/AlbumSearchPanel';
import { setLanguage, t } from '../src/i18n';
import { DEFAULT_SETTINGS } from '../src/types';
import { WorkspaceLeaf, installDomHelpers, probeCoverUri } from './obsidian-shim';
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
 const tracks=Array.from({length:24},(_,i)=>({id:i+1,name:`Nightlight · 夜色中的微光 — A very long track title ${i+1}`,artists:'Xeuphoria / The Midnight',duration:260000,albumId:i+100,albumName:'Original album',cover}));
 const collection={albumId:0,playlistId:1,name:items[0].name,artist:items[0].creator,cover,tracks,trackCount:tracks.length};
 const albums=Array.from({length:4},(_,i)=>({albumId:i+100,name:items[i].name,artist:'The Midnight',cover,trackCount:3}));
 const artists=[{id:9,name:'The Midnight / 艺术家名字',cover}];
 let throwError=config.page==='error',blocked:((value:any)=>void)|null=null,apiCalls=0,wallAdded=0,tabTitle='';
 const searchCalls:any[]=[];
 const engine=new InternalPlayer({resolve:async()=>({url:'x',quality:'standard',trial:false}),load:async()=>new Blob(['x']),audio:()=>new TestAudio() as never,notice(){}});
 if(config.playing)await engine.playPlaylist(collection);
 const plugin:any={settings:{...DEFAULT_SETTINGS,neteaseCookie:config.page==='signedout'?'':'test-cookie',neteaseUserId:'42',neteaseNickname:'Music Wall 用户',zoomScale:config.zoom||1},
  internalPlayer:engine,nowPlaying:engine,async ensureNeteaseLogin(){return !!this.settings.neteaseCookie;},async openPlayerView(){},saveZoom(){},
  getPlaybackDeps(){return {isCurrent:()=>true,playInside:(meta:any)=>engine.playAlbum(meta)};},async fetchAlbumDetail(id:number){return {...albums.find(a=>a.albumId===id),tracks:tracks.slice(0,3)};},async enqueueAlbum(meta:any){engine.enqueueAlbum(meta);},addLibraryAlbum(){wallAdded++;},
  libraryApi:{clear(){},async userPlaylists(){apiCalls++;if(throwError)throw Error();return config.page==='empty'?[]:items;},
   async searchContent(keyword:string,kind:string,_cookie:string,offset:number){apiCalls++;searchCalls.push({keyword,kind,offset});return {songs:kind==='songs'?tracks.slice(0,3):[],artists:kind==='artists'?artists:[],albums:kind==='albums'?albums:[],playlists:kind==='playlists'?items:[],more:offset===0};},
   async artistDetail(artist:any){return {artist,tracks:tracks.slice(0,3),albums,more:true};},async artistAlbums(){return {albums,more:false};},
   async liked(){return collection;},async detail(){if(config.stale)return new Promise(resolve=>{blocked=resolve;});return collection;}}
 };
 const leaf:any=new WorkspaceLeaf({});const view=new MusicLibraryView(leaf,plugin);leaf.updateHeader=()=>{tabTitle=view.getDisplayText();};
 mount.appendChild(view.contentEl);await view.onOpen();const v=view as any;
 check(apiCalls===0&&view.getDisplayText()===t('library.home'),'Opening goes home without fetching private playlists');
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
 if(config.page==='artist')check(root.querySelectorAll('.mw-cloud__track').length===3&&root.querySelectorAll('.mw-cloud__album').length===4,'Artist shows songs and albums');
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
  root.querySelector<HTMLButtonElement>('[data-search-kind="artists"]')!.click();await wait();root.querySelector<HTMLButtonElement>('.mw-cloud__artist-card')!.click();await wait();check(view.getDisplayText()===artists[0].name&&!!root.querySelector('.mw-cloud__album'),'Artist result opens detail');
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
 dispose=async()=>{engine.stop();await view.onClose();};return {checks,fail};
};
