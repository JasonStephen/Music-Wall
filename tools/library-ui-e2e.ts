import { MusicLibraryView } from '../src/ui/MusicLibraryView';
import { InternalPlayer } from '../src/core/internalPlayer';
import { setLanguage } from '../src/i18n';
import { DEFAULT_SETTINGS } from '../src/types';
import { WorkspaceLeaf, installDomHelpers, probeCoverUri } from './obsidian-shim';
installDomHelpers();
const wait=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
class TestAudio extends EventTarget {
 currentTime=0;duration=260;paused=true;ended=false;volume=1;
 async play(){this.paused=false;this.dispatchEvent(new Event('playing'));}
 pause(){this.paused=true;this.dispatchEvent(new Event('pause'));}
 removeAttribute(){}load(){}
}
let dispose=async()=>{};
(window as any).setupPlaybackUI=async(config:any)=>{
 await dispose();setLanguage(config.lang || 'zh-CN');document.body.className=`theme-${config.theme}`;document.body.style.setProperty('--mw-zoom',String(config.zoom||1));
 const mount=document.getElementById('mount')!;mount.empty();let checks=0;const fail:string[]=[];const check=(value:unknown,label:string)=>{checks++;if(!value)fail.push(label);};
 const cover=probeCoverUri(config.theme==='dark'?'31506d':'a9b5c0');
 const items=Array.from({length:9},(_,i)=>({id:i+1,name:`夜间公路与城市灯光 · Summer Night Drive Collection ${i+1}`,creator:'The Midnight / 测试歌单创建者',owner:i<5?42:7,cover,count:12,special:0}));
 const tracks=Array.from({length:24},(_,i)=>({id:i+1,name:`Nightlight · 夜色中的微光 — A very long track title ${i+1}`,artists:'Xeuphoria / The Midnight',duration:260000,albumId:i+100,albumName:'Original album',cover}));
 const collection={albumId:0,playlistId:1,name:items[0].name,artist:items[0].creator,cover,tracks,trackCount:tracks.length};
 let throwError=config.page==='error',blocked:((value:any)=>void)|null=null;
 const engine=new InternalPlayer({resolve:async()=>({url:'x',quality:'standard',trial:false}),load:async()=>new Blob(['x']),audio:()=>new TestAudio() as never,notice(){}});
 const plugin:any={settings:{...DEFAULT_SETTINGS,neteaseCookie:config.page==='signedout'?'':'test-cookie',neteaseUserId:'42',zoomScale:config.zoom||1},
  internalPlayer:engine,async ensureNeteaseLogin(){return !!this.settings.neteaseCookie;},async openPlayerView(){},saveZoom(){},
  libraryApi:{clear(){},async userPlaylists(){if(throwError)throw Error();return config.page==='empty'?[]:items;},async search(){return {items,more:true};},async liked(){return collection;},async detail(){if(config.stale)return new Promise(resolve=>{blocked=resolve;});return collection;}}
 };
 const app:any={};const view=new MusicLibraryView(new WorkspaceLeaf(app),plugin);mount.appendChild(view.contentEl);await view.onOpen();
 if(config.page==='likes'){(view as any).tab='likes';await (view as any).loadContent();}
 if(config.page==='collected'){(view as any).tab='collected';await (view as any).loadContent();}
 if(config.page==='search'){(view as any).tab='search';(view as any).keyword='Synthwave';await (view as any).loadContent();}
 if(config.page==='detail'){await (view as any).openPlaylist(items[0]);}
 await wait(35);const root=view.contentEl,box=root.querySelector<HTMLElement>('.mw-zoombox')!;
 check(!('file' in view),'Cloud library does not bind to any file');
 check(box.getBoundingClientRect().right<=innerWidth+1&&box.getBoundingClientRect().bottom<=innerHeight+1,'Library zoom fits the pane');
 const body=root.querySelector<HTMLElement>('.mw-cloud__body');
 if(body){check(body.scrollWidth<=body.clientWidth+1,'Library body has no horizontal overflow');const bar=document.querySelector('.status-bar')!.getBoundingClientRect();check(parseFloat(getComputedStyle(body).paddingBottom)*(config.zoom||1)>=bar.height,'Library content clears floating status bar');}
 for(const button of root.querySelectorAll<HTMLElement>('.mw-cloud__tabs button,.mw-cloud__search button,.mw-cloud__icon')){const r=button.getBoundingClientRect();check(r.left>=-1&&r.right<=innerWidth+1,'All navigation controls fit within the pane');}
 for(const icon of root.querySelectorAll('.mw-cloud__icon'))check(!!icon.querySelector('svg'),'Every cloud action icon is SVG');
 if(config.page==='detail'){
  check(root.querySelectorAll('.mw-cloud__track').length===24,'Playlist renders every returned track');
  for(const row of root.querySelectorAll<HTMLElement>('.mw-cloud__track'))check(row.scrollWidth<=row.clientWidth+1,'Long track names are truncated without overflow');
 }
 if(config.page==='created')check(root.querySelectorAll('.mw-cloud__card').length===5,'Created playlists use the current account ownership');
 if(config.page==='collected')check(root.querySelectorAll('.mw-cloud__card').length===4,'Collected playlists exclude owned playlists');
 if(config.page==='error'){check(root.textContent?.includes(config.lang==='en'?'Unable':config.lang==='zh-TW'?'載入失敗':'加载失败'),'Failed requests show a retry state');throwError=false;(root.querySelector('.mw-cloud__empty button') as HTMLButtonElement).click();await wait(15);check(root.querySelectorAll('.mw-cloud__card').length===5,'Retry recovers the list');}
 (window as any).verifyLibraryStale=async()=>{
  plugin.libraryApi.detail=()=>new Promise(resolve=>{blocked=resolve;});
  const open=(view as any).openPlaylist(items[0]);await wait(0);plugin.settings.neteaseCookie='';view.refresh();blocked!(collection);await open;
  const clear=!root.querySelector('.mw-cloud__track')&&!!root.querySelector('.mod-cta');
  return clear;
 };
 (window as any).verifyLibraryNavigation=async()=>{
  (view as any).tab='search';(view as any).collection=null;(view as any).keyword='';(view as any).render();
  const input=root.querySelector<HTMLInputElement>('.mw-cloud__search input')!;input.value='Synthwave';root.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));await wait(20);
  const search=root.querySelectorAll('.mw-cloud__card').length===9;
  root.querySelector<HTMLButtonElement>('.mw-cloud__more')!.click();await wait(20);const more=root.querySelectorAll('.mw-cloud__card').length===18;
  root.querySelector<HTMLButtonElement>('.mw-cloud__card')!.click();await wait(20);const detail=root.querySelectorAll('.mw-cloud__track').length===24;
  root.querySelector<SVGElement>('.mw-cloud__collection svg[data-icon="list-plus"]')!.closest<HTMLButtonElement>('button')!.click();await wait(20);
  const queued=engine.contentKind==='playlist'&&engine.album?.tracks?.length===24;
  root.querySelector<HTMLButtonElement>('.mw-cloud__track:nth-child(3)')!.click();await wait(20);
  return {search,more,detail,queued,played:engine.index===2};
 };
 dispose=async()=>{engine.stop();await view.onClose();};return {checks,fail};
};
