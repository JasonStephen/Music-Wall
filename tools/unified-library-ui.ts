import { MusicLibraryView } from '../src/ui/MusicLibraryView';
import { WallLibraryStore, addFolder, addSaved, createPlaylist, addSongs, moveFolder, type WallKind } from '../src/core/wallLibrary';
import { DEFAULT_SETTINGS } from '../src/types';
import { InternalPlayer } from '../src/core/internalPlayer';
import { HistoryStore } from '../src/core/history';
import { setLanguage, t } from '../src/i18n';
import { WorkspaceLeaf, installDomHelpers, probeCoverUri, MENU_LOG } from './obsidian-shim';
import { WallDestinationModal } from '../src/ui/WallDestinationModal';
installDomHelpers();
const tick = (ms=25) => new Promise(resolve => setTimeout(resolve,ms));
class Audio extends EventTarget {currentTime=0;duration=200;paused=true;ended=false;volume=1;async play(){this.paused=false;this.dispatchEvent(new Event('playing'));}pause(){this.paused=true;this.dispatchEvent(new Event('pause'));}removeAttribute(){}load(){}}
let dispose = async () => {};
(window as any).setupUnified = async (config: any = {}) => {
 await dispose(); setLanguage(config.lang || 'zh-CN'); document.body.className=`theme-${config.theme || 'light'}`; document.body.style.setProperty('--mw-zoom',String(config.zoom || 1));
 const mount=document.querySelector<HTMLElement>('#mount')!;mount.empty();const failures:string[]=[];let checks=0;const check=(value:unknown,label:string)=>{checks++;if(!value)failures.push(label);};
 const memory = new Map<string,string>();const adapter={exists:async(p:string)=>memory.has(p),read:async(p:string)=>memory.get(p)!,write:async(p:string,s:string)=>{memory.set(p,s)},mkdir:async(p:string)=>{memory.set(p,'')}};
 const store=new WallLibraryStore(adapter);await store.ready();
 const cover=probeCoverUri('6e8eaf');const tracks=Array.from({length:7},(_,i)=>({id:100+i,name:`Song ${i+1}`,artists:'Artist',albumName:`Album ${i+1}`,albumId:i+1,duration:200000,cover:probeCoverUri(['6e8eaf','b96d85','b9a276','798b6c'][i%4])}));
 let folder='',nested='',localId='',localEntry='',albumEntry='',playlistEntry='';
 await store.update(d=>{
  folder=addFolder(d,'albums',null,'Cinematic Music').id;nested=addFolder(d,'albums',folder,'Epic').id;
  for(let i=1;i<=14;i++){const e=addSaved(d,{albumId:i,name:`Night Drive ${i}`,artist:'The Midnight',cover,trackCount:7,tracks},folder)!;if(i===1)albumEntry=e.id;}
  addSaved(d,{albumId:30,name:'Nested collection',artist:'Artist',cover,trackCount:7,tracks},nested);
  playlistEntry=addSaved(d,{albumId:0,playlistId:2,name:'Saved collection',artist:'Owner',cover,trackCount:7,tracks},null)!.id;
  const entry=createPlaylist(d,null,'My playlist');localId=entry.collection;localEntry=entry.id;addSongs(d,localId,tracks);
  createPlaylist(d,null,'Empty playlist');
 });
 const engine=new InternalPlayer({resolve:async()=>({url:'https://example.test/audio',trial:false}),load:async()=>new Blob(['audio']),audio:()=>new Audio() as any,notice(){},webAudio:false});
 const history=new HistoryStore(adapter,'history');await history.ready();
 let view:MusicLibraryView, detailCalls=0,offline=false,tabCount=0;
 const workspace:any={activeLeaf:null,getLeavesOfType(){return []},getActiveViewOfType(){return view},getLeaf(){tabCount++;throw Error('Unexpected tab');}};
 const plugin:any={settings:{...DEFAULT_SETTINGS,neteaseCookie:'MUSIC_U=test',neteaseUserId:'42',zoomScale:config.zoom||1,libraryAppearance:config.theme||'light'},wallLibrary:store,internalPlayer:engine,nowPlaying:engine,historyStore:history,historyScope:()=> '42',
  ensureNowPlayingStarted(){},ensureNeteaseLogin:async()=>true,saveData:async()=>{},saveZoom:async()=>{},refreshLibraryLayouts(){},scanWallItems:async()=>[],lyrics:{get:async()=>({lines:[],translation:[]})},
  libraryApi:{clear(){},songs:async(ids:number[])=>{if(offline)throw Error();return tracks.filter(s=>ids.includes(s.id))},searchContent:async()=>({songs:tracks,albums:[],artists:[],playlists:[],more:false}),userPlaylists:async()=>[],detail:async()=>({albumId:0,playlistId:2,name:'Live playlist',artist:'Owner',cover,tracks,trackCount:7})},
  fetchCollectionDetail:async(meta:any)=>{detailCalls++;if(meta.localPlaylistId)return store.data.collections.find(c=>c.id===meta.localPlaylistId)!.meta;return {...meta,name:'Live detail '+detailCalls,tracks}},
  fetchAlbumDetail:async(id:number)=>({albumId:id,name:'Album',artist:'Artist',cover,tracks,trackCount:7}),
  getPlaybackDeps:()=>({isDesktop:false,request(){},loadCollection:plugin.fetchCollectionDetail,playInside:async(meta:any,index:number)=>meta.localPlaylistId||meta.playlistId?engine.playPlaylist(meta,index):engine.playAlbum(meta,index)}),
  openPlayerView:async()=>view.expandPlayer(),returnFromPlayer:async()=>view.collapsePlayer(),enqueueAlbum:async(meta:any)=>engine.enqueuePlaylist(meta),
  saveLocalCollection:async(meta:any,f:string|null)=>store.update(d=>!!addSaved(d,meta,f)),addLibraryAlbum(){},
  addSongsToLocalPlaylist(songs:any[]){new WallDestinationModal(leaf.app as any,t('localWall.selectPlaylist'),store.data.collections.filter(c=>c.kind==='local').map(c=>({id:c.id,name:c.meta.name,disabled:songs.every(s=>c.meta.tracks?.some(x=>x.id===s.id))})),async id=>store.update(d=>addSongs(d,id!,songs))).open()},
 };
 const leaf:any=new WorkspaceLeaf({workspace});view=new MusicLibraryView(leaf,plugin);leaf.view=view;workspace.activeLeaf=leaf;mount.appendChild(view.contentEl);await view.onOpen();
 check([...view.contentEl.querySelectorAll<HTMLElement>('[data-wall-portal]')].map(e=>e.dataset.wallPortal).join(',')==='local,playlists,albums','Three portals in order');
 check(view.getIcon()==='library'&&view.getDisplayText()===t('localWall.title'),'Wall title and icon');
 check([...view.contentEl.querySelectorAll<HTMLElement>('.mw-cloud__sidebar > [data-section]')].map(e=>e.dataset.section).join(',')==='search,likes,created,collected,history,wall','Wall section follows history');
 const v=view as any,wall=v.localWall;
 view.showWall('albums',folder);await tick();check(view.contentEl.querySelectorAll('[data-entry-id]').length===14,'Direct saved albums');check(view.contentEl.querySelectorAll('.mw-local__folder').length===1,'Folder and albums share grid');
 const before=detailCalls;view.showWall('albums',folder,albumEntry);await tick(60);check(detailCalls===before+1&&view.contentEl.textContent!.includes('Live detail'),'Fresh album details');
 view.showWall('albums',folder);view.showWall('albums',folder,albumEntry);await tick(60);check(detailCalls===before+2,'Reopening fetches again');
 await view.showCollection({albumId:77,name:'From player',artist:'Artist',cover});check(!!view.contentEl.querySelector('.mw-cloud__collection')&&!view.contentEl.querySelector('.mw-local__contents'),'Open online album from local wall');
 view.showWall('playlists',null);await tick();check(view.contentEl.querySelectorAll('.mw-disc').length===0,'Saved playlists use covers');
 view.showWall('local',null);await tick();check(view.contentEl.querySelectorAll('.mw-local__mosaic').length===1,'Local cover mosaic');check(!!view.contentEl.querySelector('.mw-local__placeholder svg'),'Empty playlist SVG');
 view.showWall('local',null,localEntry);await tick(80);check(view.contentEl.querySelectorAll('[data-local-song]').length===7,'Local song details');
 const first=view.contentEl.querySelector<HTMLInputElement>('.mw-local__song input')!;first.checked=true;first.dispatchEvent(new Event('change'));check(view.contentEl.textContent!.includes(t('localWall.selected',{count:1})),'Song selection');
 plugin.addSongsToLocalPlaylist([tracks[0]]);await tick();const disabled=document.querySelector<HTMLButtonElement>('.mw-wall-dialog__choice')!;check(disabled.disabled,'Duplicate target disabled');document.querySelector('.modal-container')?.remove();
 const rows=[...view.contentEl.querySelectorAll<HTMLElement>('[data-local-song]')];const transfer=new DataTransfer();rows[0].dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));rows[2].dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));await tick(80);check(store.data.collections.find(c=>c.id===localId)!.meta.tracks![1].id===tracks[0].id,'Song drag order persisted');
 offline=true;await wall.loadDetail();check(view.contentEl.querySelectorAll('[data-local-song]').length===7&&view.contentEl.textContent!.includes(t('localWall.offline')),'Offline songs preserved');offline=false;
 view.showWall('albums',folder);await tick();const body=view.contentEl.querySelector<HTMLElement>('.mw-cloud__body')!;body.scrollTop=120;const scroll=body.scrollTop;
 await view.expandPlayer();await tick(80);check(!!view.contentEl.querySelector('.mw-embedded-player .mw-player__collapse svg'),'Embedded collapse SVG');check(tabCount===0,'Player creates no workspace leaf');
 view.contentEl.querySelector<HTMLButtonElement>('.mw-player__collapse')!.click();await tick(80);check(!view.embeddedPlayer&&body.scrollTop===scroll,'Collapse restores browsing and scroll');
 const search=view.contentEl.querySelector<HTMLInputElement>('.mw-local__search input')!;search.value='Nested';search.dispatchEvent(new Event('input'));check(view.contentEl.querySelectorAll('[data-entry-id]').length===1,'Folder search includes descendants');
 view.showWall('albums',folder);await store.update(d=>{d.appearance.layout='list'});check(view.contentEl.querySelectorAll('.mw-disc').length===0,'List uses covers only');
 await store.update(d=>{d.appearance.layout='grid';d.appearance.style='cassette'});check(view.contentEl.querySelectorAll('.mw-case').length>0,'Album cassette grid');
 view.showWall('playlists',null);check(view.contentEl.querySelectorAll('.mw-case').length===0,'Global album style does not change playlist covers');
 if(config.page==='local')view.showWall('local',null,localEntry);else if(config.page==='albums')view.showWall('albums',folder);else if(config.page==='player'){await engine.playPlaylist({...store.data.collections.find(c=>c.id===localId)!.meta,wallEntryId:localEntry});await view.expandPlayer();}else view.showWall();
 await tick(100);
 const root=view.contentEl;const bodyRect=root.querySelector('.mw-cloud__body')!.getBoundingClientRect();const roots=root.getBoundingClientRect();
 check(root.scrollWidth<=root.clientWidth+1,'No root horizontal overflow');check(root.querySelector<HTMLElement>('.mw-cloud__body')!.scrollWidth<=root.querySelector<HTMLElement>('.mw-cloud__body')!.clientWidth+1,'No body horizontal overflow');
 check(!/localWall\.|labels\.sort\.|\?\?\?/.test(root.textContent||''),'All labels resolved');
 dispose=async()=>{engine.stop();await view.onClose();view.contentEl.remove();};
 return {checks,failures,tabCount,body:{width:bodyRect.width,height:bodyRect.height},root:{width:roots.width,height:roots.height},text:root.textContent!.slice(0,160),menus:MENU_LOG.length};
};
