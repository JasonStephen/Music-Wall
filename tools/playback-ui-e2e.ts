import { verifyHiddenZoom } from "./hidden-zoom-ui";
import { InternalPlayer, CombinedNowPlayingProvider } from "../src/core/internalPlayer";
import { EMPTY_NOW_PLAYING } from "../src/core/nowPlaying";
import { PlayerLyrics } from "../src/ui/PlayerLyrics";
import { MusicPlayerView } from "../src/ui/MusicPlayerView";
import { MusicWallView } from "../src/ui/MusicWallView";
import { DEFAULT_SETTINGS } from "../src/types";
import { setLanguage, t } from "../src/i18n";
import { installDomHelpers, WorkspaceLeaf, TFile, probeCoverUri } from "./obsidian-shim";
installDomHelpers(); setLanguage("zh-CN");
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const rgba=(color:string):number[]=>{
  if(color.startsWith("#"))return [0,2,4].map(i=>parseInt(color.slice(1+i,3+i),16)).concat(1);
  const values=color.match(/[\d.]+/g)?.map(Number)??[0,0,0];return [...values.slice(0,3),values[3]??1];
};
const over=(front:number[],back:number[])=>front.slice(0,3).map((v,i)=>v*front[3]+back[i]*(1-front[3])).concat(1);
const luminance=(color:number[])=>color.slice(0,3).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
const contrast=(text:string,background:number[])=>{const a=luminance(over(rgba(text),background)),b=luminance(background);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
class FakeAudio extends EventTarget {
  private time=0;
  get currentTime(){return this.time;}
  set currentTime(value:number){
    this.time=value;
    (window as any).miniSeekWrites=((window as any).miniSeekWrites||0)+1;
    if((window as any).miniSeekBuffering&&!this.paused)queueMicrotask(()=>{
      this.dispatchEvent(new Event('waiting'));
      setTimeout(()=>this.dispatchEvent(new Event('playing')),30);
    });
  }
  duration=260; paused=true; ended=false; volume=1; preload="";
  set src(_url:string) { queueMicrotask(()=>this.dispatchEvent(new Event("loadedmetadata"))); }
  async play() {this.paused=false;this.dispatchEvent(new Event("playing"));}
  pause(){this.paused=true;this.dispatchEvent(new Event("pause"));}
  removeAttribute(){} load(){}
}
let close = async()=>{};
(window as any).setupPlaybackUI = async (config: any) => {
  await close();
  (window as any).miniSeekBuffering=false;
  setLanguage(config.lang || 'zh-CN');
  document.body.className = `theme-${config.theme}${config.tablet ? " is-mobile is-tablet" : ""}`;
  document.body.style.setProperty("--mw-zoom",String(config.zoom??1));
  const mount=document.getElementById("mount")!;mount.empty();mount.style.height=config.paneHeight ? `${config.paneHeight}px` : "100vh";
  const hostBar=document.querySelector<HTMLElement>(".status-bar")!;
  hostBar.style.display=config.statusBar===false?"none":"flex";
  const fail:string[]=[];let checks=0;
  const check=(ok:unknown,label:string)=>{checks++;if(!ok)fail.push(label);};
  const checkScrollbar=(element:HTMLElement)=>{
    if(element.closest('.mw-player')) {
      check(getComputedStyle(element).scrollbarWidth==='none'&&getComputedStyle(element,'::-webkit-scrollbar').display==='none','Player hides scrollbars without changing overflow');return;
    }
    const thumb=getComputedStyle(element,'::-webkit-scrollbar-thumb');
    check(getComputedStyle(element,'::-webkit-scrollbar').width==='8px'&&thumb.borderRadius==='999px',"Scrollbar uses compact rounded styling");
    check(thumb.backgroundColor!=='rgba(0, 0, 0, 0)',"Scrollbar thumb has a surface-specific color");
  };
  const engine=new InternalPlayer({
    defaultQuality:()=>"hires",
    resolve:async(_id,quality)=>({url:"https://example.test/audio",trial:false,quality:quality==="hires"?"exhigh":quality,availableQualities:["standard","higher","exhigh"]}),
    load:async()=>new Blob(["ui"]),audio:()=>new FakeAudio() as never,notice:()=>{},
  });
  const external={supported:false,state:{...EMPTY_NOW_PLAYING},on:()=>()=>{},start(){},stop(){},async play(){return false;},async pause(){return false;},async toggle(){return false;},async next(){return false;},async prev(){return false;},async seek(){return false;}};
  const provider=new CombinedNowPlayingProvider(external,engine);
  const cover=probeCoverUri(config.cover??"f0e8dc");
  const meta={albumId:1,name:"Dreamcatcher · 测试专辑",artist:"Xeuphoria",cover,trackCount:4,
    tracks:[{id:11,name:"Nightlight · 夜色中的微光",duration:260000},{id:12,name:"A Waltz for Forgetting",duration:105000},{id:13,name:"Feeling Alone in a Room Full of People (2020 Ver.)",duration:192000},{id:14,name:"Dreamcatcher",duration:274000}]};
  let opens=0; const sourceCalls:any[]=[];
  let artistLookup = async () => [{ id: 11, artistRefs: [{ id: 91, name: "Resolved artist" }] }];
  const plugin={
    manifest:{id:"music-wall"},
    settings:{...DEFAULT_SETTINGS,playerPresetGroup:config.presets?"vinyl":"custom",playerExperimental:!config.presets,playerPresetChoices:{...DEFAULT_SETTINGS.playerPresetChoices},playerBackground:config.bg??"dark",playerCase:config.deviceCase??"black",playerTexture:false,playerVinylMachine:config.machine!==false,playerCdMachine:config.machine!==false,zoomScale:config.zoom??1,shelfCaption:config.caption??"pull"},internalPlayer:engine,nowPlaying:provider,
    async returnFromPlayer(){sourceCalls.push({kind:"back"});},
    async openLibraryCollection(meta:any){sourceCalls.push({kind:"library",meta});},async revealWallAlbum(path:string,id:number){sourceCalls.push({kind:"wall",path,id});},
    async openLibraryArtist(artist:any){sourceCalls.push({kind:"artist",artist});},libraryApi:{songs:()=>artistLookup()},
    lyrics:{async get(id:number){return {instrumental:false,lines:Array.from({length:60},(_,index)=>({time:index*5000,text:`Song ${id} · Line ${index+1} 夜色中的微光`,translation:`歌曲 ${id} · 翻译 ${index+1}`}))};}},
    ensureNowPlayingStarted(){},async ensureNeteaseLogin(){return true;},async openPlayerView(){opens++;},
    getPlaybackDeps:()=>({isDesktop:false,request:async()=>{throw Error("No external calls");},playInside:(m:any,i:number)=>engine.playAlbum(m,i)}),
    async scanWallItems(){return [{albumId:1,meta}];},async findAlbumWall(){return null;},async saveData(){},wallFiles:()=>[],firstPlayerView:()=>null,
  };
  let activePlayer:MusicPlayerView|null=null;
  let settingsOpened=0;
  const app={setting:{open(){settingsOpened++;},openTabById(id:string){if(id!=="music-wall")throw Error("Wrong settings tab");}},vault:{on:()=>({}),getAbstractFileByPath:()=>null,async read(){return "{}";}},workspace:{on:()=>({}),getLeavesOfType:()=>[],getActiveViewOfType:()=>activePlayer}};
  const views:(MusicWallView|MusicPlayerView)[]=[];
  const createWall=async()=>{
    const view=new MusicWallView(new WorkspaceLeaf(app),plugin as never);
    (view as any).file=new TFile("Test.mw");
    (view as any).data={version:2,name:"Music Wall",style:config.style??"vinyl",layout:config.layout??"grid",groups:[{id:"g1",name:"FM Attack"},{id:"g2",name:"The Midnight"}],items:Array.from({length:12},(_,i)=>({albumId:i+1,source:"manual",locked:true,groupId:i<4?"g1":"g2",addedAt:"2026-10-17",meta:{...meta,albumId:i+1,name:`Record ${i+1}`}}))};
    mount.appendChild(view.contentEl);views.push(view);await view.onOpen();return view;
  };
  if(config.kind==="wall") {
    const wall=await createWall();
    check(wall.contentEl.querySelector(".mw-mini")?.classList.contains("is-hidden"),"No queue hides footer");
    await engine.playAlbum(meta);
    if(config.queue) { engine.enqueueAlbum({...meta,albumId:2,name:"A very long queued album · 第二张专辑"});engine.enqueueAlbum({...meta,albumId:3,name:"Third album"}); }
    await wait(40);
    const mini=wall.contentEl.querySelector<HTMLElement>(".mw-mini")!;
    (window as any).prepareMiniSeek=async(buffering=false)=>{
      (window as any).miniSeekBuffering=false;
      await engine.pause();await engine.seek(0);
      if(buffering)await engine.play();
      (window as any).miniSeekBuffering=buffering;(window as any).miniSeekWrites=0;
      const input=mini.querySelector<HTMLInputElement>('.mw-mini__progress input')!,r=input.getBoundingClientRect();
      return {x:r.left+r.width*.25,end:r.left+r.width*.75,y:r.top+r.height/2,hit:document.elementFromPoint(r.left+r.width*.25,r.top+r.height/2)===input};
    };
    (window as any).miniSeekResult=()=>({position:engine.state.positionMs,duration:engine.state.durationMs,status:engine.state.status,writes:(window as any).miniSeekWrites,
      dragging:mini.classList.contains('is-seeking'),disabled:mini.querySelector<HTMLInputElement>('.mw-mini__progress input')!.disabled});
    (window as any).verifyMiniSeekFollow=async()=>{
      (window as any).miniSeekBuffering=false;
      await engine.seek(10000);await wait();
      return Number(mini.querySelector<HTMLInputElement>('.mw-mini__progress input')!.value)===10;
    };
    (window as any).verifyMiniSeekLifecycle=async()=>{
      const input=mini.querySelector<HTMLInputElement>('.mw-mini__progress input')!;const failures:string[]=[];
      input.dispatchEvent(new PointerEvent('pointerdown',{pointerId:701,isPrimary:true,button:0,bubbles:true}));input.value='20';
      await engine.seek(10000);if(Number(input.value)!==20)failures.push('playback updates overwrite active drag');
      document.dispatchEvent(new PointerEvent('pointerup',{pointerId:702,bubbles:true}));await engine.seek(12000);
      if(Number(input.value)!==20)failures.push('unrelated pointer releases drag');
      document.dispatchEvent(new PointerEvent('pointercancel',{pointerId:701,bubbles:true}));
      if(Number(input.value)!==12||mini.classList.contains('is-seeking'))failures.push('cancel does not restore progress');
      input.focus();input.value='30';input.dispatchEvent(new Event('input'));await wait();
      if(engine.state.positionMs!==30000)failures.push('keyboard input does not seek');
      await engine.seek(40000);if(Number(input.value)!==40)failures.push('keyboard focus prevents progress updates');
      await engine.play();await engine.seek(0);
      input.dispatchEvent(new PointerEvent('pointerdown',{pointerId:703,isPrimary:true,button:0,bubbles:true}));input.value='45';input.dispatchEvent(new Event('input'));
      (engine as any).media.dispatchEvent(new Event('waiting'));
      if(input.disabled||!mini.classList.contains('is-seeking'))failures.push('buffering cancels active preview');
      document.dispatchEvent(new PointerEvent('pointerup',{pointerId:703,bubbles:true}));
      if(engine.state.positionMs!==0)failures.push('buffered release seeks too early');
      (engine as any).media.dispatchEvent(new Event('playing'));
      if(engine.state.positionMs!==45000)failures.push('buffered release never commits after recovery');
      input.dispatchEvent(new PointerEvent('pointerdown',{pointerId:704,isPrimary:true,button:0,bubbles:true}));input.value='65';input.dispatchEvent(new Event('input'));
      document.dispatchEvent(new PointerEvent('pointercancel',{pointerId:704,bubbles:true}));
      if(engine.state.positionMs!==45000)failures.push('cancel commits preview');
      input.dispatchEvent(new PointerEvent('pointerdown',{pointerId:705,isPrimary:true,button:0,bubbles:true}));input.value='85';input.dispatchEvent(new Event('input'));
      (engine as any).media.dispatchEvent(new Event('waiting'));document.dispatchEvent(new PointerEvent('pointerup',{pointerId:705,bubbles:true}));
      await engine.select(1);await wait();
      if(engine.state.positionMs!==0||Number(input.value)!==0)failures.push('pending seek leaks into next song');
      return failures;
    };
    checkScrollbar(wall.contentEl.querySelector<HTMLElement>('.mw-grid')!);
    check(!mini.classList.contains("is-hidden"),"Playing shows footer");
    const stage=wall.contentEl.querySelector<HTMLElement>(".mw-stage")!.getBoundingClientRect(), rect=mini.getBoundingClientRect();
    check(stage.bottom<=rect.top+2,"Footer reserves space below records");
    check(mini.scrollWidth<=mini.clientWidth+1,"Footer has no horizontal overflow");
    check(rect.left>=-1&&rect.right<=innerWidth+1&&rect.bottom<=innerHeight+1,"Footer stays in pane");
    const miniBg=over(rgba(getComputedStyle(mini).backgroundColor),[255,255,255,1]);
    check(contrast(getComputedStyle(mini.querySelector(".mw-mini__title")!).color,miniBg)>=4.5,"Footer title contrast is readable");
    check(contrast(getComputedStyle(mini.querySelector(".mw-mini__artist")!).color,miniBg)>=4.5,"Footer artist contrast is readable");
    const controls=mini.querySelector<HTMLElement>(".mw-mini__tools")!.getBoundingClientRect();
    check(config.statusBar===false || controls.bottom<=hostBar.getBoundingClientRect().top+1,"Host status bar does not cover footer controls");
    const openRect=mini.querySelector<HTMLElement>(".mw-mini__open")!.getBoundingClientRect();
    const coverRect=mini.querySelector<HTMLElement>(".mw-mini__cover")!.getBoundingClientRect();
    check(getComputedStyle(mini.querySelector(".mw-mini__cover")!).display==="none"||Math.abs(openRect.left-coverRect.left)<2,"Footer metadata stays left aligned");
    check(coverRect.height>=openRect.height-2,"Footer cover spans the information area's height");
    const transport=mini.querySelector<HTMLElement>('.mw-mini__controls')!.getBoundingClientRect();
    check(openRect.bottom<=transport.top+1||openRect.right<=transport.left+1,"Centered transport stays beside song information or wraps below in very narrow panes");
    check(coverRect.right<=transport.left+1||coverRect.bottom<=transport.top+1,"Cover does not overlap playback controls");
    for(const button of mini.querySelectorAll<HTMLElement>('.mw-mini__button')) {
      const r=button.getBoundingClientRect();check(r.left>=-1&&r.right<=innerWidth+1,"Every footer control remains inside its pane");
    }
    check([...mini.querySelectorAll('.mw-mini__controls button')].map(x=>(x as HTMLElement).dataset.action).join(',')==='prev,toggle,next',"Transport order is previous, play/pause, next");
    check([...mini.querySelectorAll('.mw-mini__tools button')].map(x=>(x as HTMLElement).dataset.action).join(',')==='play-order,playlist,quality,volume,expand',"Playback order immediately precedes playlist in footer tools");
    check(!!mini.querySelector('.mw-mini__tools [data-action="play-order"] svg'),"Footer playback order uses an SVG icon");
    check(mini.querySelector('.mw-mini__progress')!.getBoundingClientRect().top<=rect.top+1,"Progress runs along the top of the bar");
    for(const name of ['playlist','quality','volume']) {
      mini.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!.click();await wait(15);
      const panel=mini.querySelector<HTMLElement>(`.mw-mini__${name}`)!,r=panel.getBoundingClientRect();
      check(!panel.classList.contains('is-hidden'),`Footer ${name} opens locally`);
      check(r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=rect.top+1,`Footer ${name} panel fits above bar`);
      mini.querySelector<HTMLButtonElement>(`[data-action="${name}"]`)!.click();
    }
    (window as any).verifyMiniControls=async()=>{
      const failures:string[]=[];
      mini.querySelector<HTMLButtonElement>('[data-action="next"]')!.click();await wait(30);
      if(engine.index!==1)failures.push('Next did not select the next song');
      mini.querySelector<HTMLButtonElement>('[data-action="prev"]')!.click();await wait(30);
      if(engine.index!==0)failures.push('Previous did not select the previous song');
      mini.querySelector<HTMLButtonElement>('[data-action="playlist"]')!.click();
      mini.querySelector<HTMLButtonElement>('.mw-mini__track:nth-child(3)')!.click();await wait(30);
      if(engine.index!==2)failures.push('Mini playlist did not select the clicked song');
      mini.querySelector<HTMLButtonElement>('[data-action="quality"]')!.click();
      mini.querySelector<HTMLButtonElement>('[data-quality="higher"]')!.click();await wait(30);
      if(engine.quality!=='higher')failures.push('Mini quality selection was not applied');
      mini.querySelector<HTMLButtonElement>('[data-action="volume"]')!.click();
      const volume=mini.querySelector<HTMLInputElement>('.mw-mini__volume input')!;volume.value='.37';volume.dispatchEvent(new Event('input'));
      if(engine.volume!==.37)failures.push('Mini volume was not applied');
      wall.contentEl.querySelector('.mw-toolbar')!.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
      if(mini.querySelector('.mw-mini__volume')?.classList.contains('is-hidden')===false)failures.push('Outside click did not close mini volume');
      mini.querySelector<HTMLButtonElement>('[data-action="quality"]')!.click();
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      if(mini.querySelector('.mw-mini__quality')?.classList.contains('is-hidden')===false)failures.push('Escape did not close mini quality');
      const seek=mini.querySelector<HTMLInputElement>('.mw-mini__progress input')!;seek.value='20';seek.dispatchEvent(new Event('input'));await wait(20);
      if(Math.abs(engine.state.positionMs-20000)>100)failures.push('Mini progress did not seek');
      return failures;
    };
    if(config.queue) {
      mini.querySelector<HTMLButtonElement>('[data-action="playlist"]')!.click();
      mini.querySelector<HTMLButtonElement>('[data-action="album-queue"]')!.click();await wait(15);
      const queue=mini.querySelector<HTMLElement>('.mw-mini__playlist')!;
      check(queue.scrollWidth<=queue.clientWidth+1,"Expanded mini album queue has no horizontal overflow");
      for(const button of queue.querySelectorAll<HTMLElement>('.mw-queue__button'))check(!!button.querySelector('svg'),"Queue actions use SVG icons");
    }
    if(config.layout==="shelf") {
      const sections=wall.contentEl.querySelectorAll<HTMLElement>(".mw-section");
      const first=sections[0],nextHead=sections[1].querySelector<HTMLElement>(".mw-section__head")!;
      const last=first.querySelector<HTMLElement>(".mw-shelf-card:last-child")!;last.classList.add("is-pulled");
      const caption=last.querySelector<HTMLElement>(".mw-shelf-cap")!;
      check(caption.getBoundingClientRect().bottom+8<=nextHead.getBoundingClientRect().top,"Album and artist captions do not overlap the next group");
      wall.contentEl.querySelector<HTMLElement>(".mw-shelf-card")!.click();await wait(600);
      const overlay=wall.contentEl.querySelector<HTMLElement>(".mw-shelf-detail")!;
      check(overlay.classList.contains("is-open"),"Shelf detail opens with active playback");
      check(overlay.getBoundingClientRect().bottom<=mini.getBoundingClientRect().top+2,"Shelf detail reserves footer space");
      const button=mini.querySelector<HTMLButtonElement>(".mw-mini__controls button")!,r=button.getBoundingClientRect();
      check(!!document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)?.closest(".mw-mini"),"Shelf detail does not cover playback controls");
      (wall as any).closeShelfDetail();await wait(30);
    }
  } else {
    await engine.playAlbum(meta);await engine.seek(38000);await engine.pause();
    if(config.panel==='queue') { engine.enqueueAlbum({...meta,albumId:2,name:'A very long queued album · 第二张专辑'});engine.enqueueAlbum({...meta,albumId:3,name:'Third album'});if(config.longQueue)for(let id=4;id<=60;id++)engine.enqueueAlbum({...meta,albumId:id,name:`Queued album ${id}`}); }
    if(config.source==='playlist') await engine.playPlaylist({...meta,albumId:0,playlistId:42,tracks:meta.tracks.map(track=>({...track,albumId:1,albumName:meta.name,cover:meta.cover}))});
    const view=new MusicPlayerView(new WorkspaceLeaf(app),plugin as never);(view as any).discStyle=config.style??"vinyl";views.push(view);mount.appendChild(view.contentEl);await view.onOpen();await wait(80);
    check(!("file" in view) && !("onLoadFile" in view),"Player is an independent ItemView without file binding");
    check(!view.contentEl.querySelector(".mw-mini"),"Full player has no duplicate footer");
    const root=view.contentEl;
    activePlayer=view;
    (window as any).verifyPlayerPresets=async()=>{
      const errors:string[]=[];let assertions=0;const expect=(ok:unknown,label:string)=>{assertions++;if(!ok)errors.push(label);};
      const customBefore=JSON.stringify([plugin.settings.playerBackground,plugin.settings.playerCase,plugin.settings.playerVinylFinish,plugin.settings.playerVinylMachine,plugin.settings.playerCdMachine]);
      const audioBefore=[engine.state.songId,engine.state.positionMs,engine.state.status].join('|');
      let currentGroup='vinyl';
      const ensure=async()=>{if(!(view as any).drawer.isOpen()){root.querySelector<HTMLButtonElement>('.mw-toolbtn')!.click();await wait();}};
      const pick=async(key:string)=>{await ensure();root.querySelector<HTMLButtonElement>(`[data-choice-group="${currentGroup}"][data-preset-choice="${key}"]`)!.click();await wait();};
      const group=async(key:string)=>{
        await ensure();
        if(key==='custom'){root.querySelector<HTMLButtonElement>('[data-style-tab="custom"]')!.click();await wait();return;}
        root.querySelector<HTMLButtonElement>('[data-style-tab="presets"]')!.click();await wait();currentGroup=key;await pick((plugin.settings.playerPresetChoices as any)[key]);
      };
      expect(root.querySelectorAll('.mw-player__bar .mw-toolbtn').length===1&&!root.querySelector('[data-preset-group]'),'original single style icon remains in player header');
      await ensure();
      expect(root.querySelectorAll('.mw-style-tabs [role="tab"]').length===2&&!!root.querySelector('[data-style-tab="custom"] svg path'),'preset and persistent wrench tabs live inside drawer');
      expect(root.querySelectorAll('[data-style-section]').length===4&&root.querySelectorAll('.mw-preset-option').length===11,'all four categories share one preset page');
      expect([...root.querySelectorAll('.mw-preset-options')].every(e=>getComputedStyle(e).gridTemplateColumns.split(' ').length===2),'preset effects use two-column grids');
      expect([...root.querySelectorAll('.mw-style-preview')].every(e=>e.querySelector('.mw-dev,.mw-player-disc-only,.mw-style-preview__cover')),'previews render actual devices or full covers against backgrounds');
      const badge=root.querySelector<HTMLElement>('.mw-style-custom-label')!,oldAccent=root.style.getPropertyValue('--mw-case-accent');root.style.setProperty('--mw-case-accent','#336699');expect(getComputedStyle(badge).backgroundColor==='rgb(51, 102, 153)','custom badge follows sampled cover accent');root.style.setProperty('--mw-case-accent',oldAccent);
      expect(!!root.querySelector('.mw-np__disc .mw-player-disc-only--vinyl')&&root.dataset.mwVinyl==='black','default preset is a standalone classic black record');
      await group('vinyl');plugin.settings.libraryAppearance='light';view.refreshPresetAppearance();expect(root.classList.contains('mw-bg--white'),'classic follows library day override');
      plugin.settings.libraryAppearance='dark';view.refreshPresetAppearance();expect(root.classList.contains('mw-bg--dark'),'classic follows library night override');
      root.querySelector<HTMLButtonElement>('[data-preset-tone="light"]')!.click();await wait();expect(root.classList.contains('mw-bg--white'),'explicit light overrides library night');
      root.querySelector<HTMLButtonElement>('[data-preset-tone="system"]')!.click();await wait();
      await pick('white');expect(root.dataset.mwVinyl==='white'&&root.classList.contains('mw-bg--white'),'white vinyl stays on white background');
      await pick('color');expect(root.dataset.mwVinyl==='color'&&root.classList.contains('mw-bg--art'),'color vinyl uses cover colors');
      root.querySelector<HTMLButtonElement>('.mw-preset-glass')!.click();await wait();expect(root.dataset.mwVinyl==='colorGlass'&&!!root.querySelector('.mw-preset-glass svg'),'glass switch uses an icon and changes colored vinyl material');
      expect([...root.querySelectorAll('.mw-preset-tones button')].every(e=>e.querySelector('svg')&&!e.textContent?.trim()),'appearance controls are icon buttons');
      await group('cd');expect(!!root.querySelector('.mw-player-disc-only--cd')&&root.classList.contains('mw-bg--dark'),'classic CD is standalone and follows library dark');
      await pick('color');expect(root.classList.contains('mw-bg--art')&&!!root.querySelector('.mw-player-disc-only--cd'),'color CD retains standard disc with cover background');
      await group('machine');for(const key of ['vinyl','colorVinyl','cd','colorCd']){await pick(key);expect(!!root.querySelector(key.toLowerCase().includes('cd')?'.mw-dev--cd':'.mw-dev--vinyl'),'machine preset renders chassis '+key);expect(root.classList.contains(key.startsWith('color')?'mw-bg--art':'mw-bg--dark'),'machine background '+key);}
      await group('vinyl');expect(root.dataset.mwVinyl==='colorGlass','vinyl selection is remembered independently');
      await group('cd');expect(root.classList.contains('mw-bg--art'),'CD selection is remembered independently');
      await group('cover');await pick('record');expect(!!root.querySelector('.mw-dev--cover')&&!root.classList.contains('mw-player--full-cover'),'record cover retains ordinary player layout');
      await pick('full');(view as any).drawer.close();await wait();
      const art=root.querySelector<HTMLElement>('.mw-full-cover')!,box=root.querySelector<HTMLElement>('.mw-zoombox')!,a=art.getBoundingClientRect(),b=box.getBoundingClientRect();
      expect(getComputedStyle(art).backgroundSize==='cover','full cover crops to fill');
      expect(getComputedStyle(art).maskImage.includes('linear-gradient')&&getComputedStyle(art).maskImage.includes('rgba(0, 0, 0, 0)'),'cover blends into solid background using alpha gradient');
      if(root.classList.contains('mw-player--portrait')){
        expect(Math.abs(a.height/b.height-.75)<.01&&Math.abs((a.top-b.top)/b.height-.125)<.01,'portrait cover occupies centered 75 percent');
        const toggle=root.querySelector<HTMLButtonElement>('.mw-cover-toggle')!;expect(!toggle.classList.contains('is-hidden')&&getComputedStyle(root.querySelector('.mw-lyrics')!).display==='none','portrait defaults to cover with lyric toggle');
        toggle.click();await wait();expect(getComputedStyle(root.querySelector('.mw-lyrics')!).display==='flex'&&getComputedStyle(root.querySelector('.mw-player__now')!).display==='none','portrait can show lyrics');toggle.click();
      }else expect(Math.abs(a.width/b.width-.5)<.01,'landscape cover uses left half');
      expect(JSON.stringify([plugin.settings.playerBackground,plugin.settings.playerCase,plugin.settings.playerVinylFinish,plugin.settings.playerVinylMachine,plugin.settings.playerCdMachine])===customBefore,'presets preserve all custom choices');
      expect([engine.state.songId,engine.state.positionMs,engine.state.status].join('|')===audioBefore,'preset switching never changes playback');
      const nav=root.querySelector('.mw-player-presets')!.getBoundingClientRect();expect(nav.left>=-1&&nav.right<=innerWidth+1,'preset toolbar stays inside pane');
      await group('custom');expect(!!root.querySelector('[data-mw-style]')&&!!root.querySelector('.mw-case-options'),'persistent custom tab exposes legacy controls');
      plugin.settings.playerExperimental=false;view.refresh();await wait(80);await ensure();expect(!!root.querySelector('[data-style-tab="custom"]')&&!!root.querySelector('[data-mw-style]'),'custom remains available with experimental flag disabled');
      await group('cover');await pick('full');(view as any).drawer.close();
      (window as any).prepareStylePanelScreenshot=async()=>{await group('vinyl');await pick('classic');(view as any).drawer.open('settings');await wait(50);};
      await (window as any).prepareStylePanelScreenshot();
      const panel=root.querySelector<HTMLElement>('.mw-drawer__body')!;
      expect(panel.scrollWidth<=panel.clientWidth+1,'style panel has no horizontal overflow at narrow widths');
      expect(root.querySelector('.mw-drawer__title')?.textContent===t('playerPresets.title'),'drawer title is player styles');
      return {checks:assertions,fail:errors};
    };
    if(config.presets) { close=async()=>{for(const view of views)await view.onClose();provider.dispose();};return {checks,fail}; }
    if(config.panel==='height') {
      const left=root.querySelector<HTMLElement>('.mw-player__now')!,stack=root.querySelector<HTMLElement>('.mw-np__stack')!,disc=root.querySelector<HTMLElement>('.mw-np__disc')!,controls=root.querySelector<HTMLElement>('.mw-np__controls')!,quality=root.querySelector<HTMLElement>('.mw-np__quality')!;
      const area=left.getBoundingClientRect(),record=disc.getBoundingClientRect(),buttons=[...controls.querySelectorAll('button')].map(e=>e.getBoundingClientRect());
      check(Math.abs(record.width-record.height)<2,'Artwork stays square');
      check(record.left>=area.left-1&&record.right<=area.right+1,'Artwork remains within left column');
      check(getComputedStyle(stack).flexShrink==='0','Stack never collapses children');
      if(config.width>=1000&&(config.zoom||1)===1) {
        check(buttons.every(r=>Math.abs(r.top+r.height/2-buttons[0].top-buttons[0].height/2)<2),'Wide player keeps all six controls on one row');
        check(quality.getBoundingClientRect().bottom<=area.bottom+1,'Quality selector fits actual available height');
        check(left.scrollHeight<=left.clientHeight+1,'Wide player fits without scrolling');
      }
      left.scrollTop=left.scrollHeight;
      check(quality.getBoundingClientRect().bottom<=left.getBoundingClientRect().bottom+Math.max(1,config.zoom||1),'Last control is reachable when scrolling is needed');
      left.scrollTop=0;
      return {checks,fail};
    }

    (window as any).verifyLyricsUI=async()=>{
      const errors:string[]=[];let count=0;const expect=(ok:unknown,label:string)=>{count++;if(!ok)errors.push(label);};
      await engine.seek(12000);await wait(40);
      const lyrics=root.querySelector<HTMLElement>('.mw-lyrics')!,viewport=lyrics.querySelector<HTMLElement>('.mw-lyrics__viewport')!;
      expect(lyrics.querySelectorAll('.mw-lyrics__line').length===60,'loads line lyrics');
      expect(lyrics.querySelector('.is-active')?.textContent?.includes('Line 3'),'timeline highlights current line');
      const left=root.querySelector('.mw-player__now')!.getBoundingClientRect(),right=lyrics.getBoundingClientRect();
      expect(root.classList.contains('mw-player--lyrics-stacked')?left.bottom<=right.top+1:left.right<=right.left+1,'player and lyrics occupy separate responsive columns/rows');
      expect(right.width>0&&right.height>0&&right.right<=innerWidth+1&&right.bottom<=innerHeight+1,'lyrics fit pane');
      expect(['auto','hidden'].includes(getComputedStyle(root.querySelector('.mw-player__now')!).overflowY),'player content cannot overflow into lyrics');
      expect(lyrics.querySelectorAll('.mw-svg-action svg').length===3,'all lyric controls use SVG');
      expect(getComputedStyle(viewport).overflowY==='auto'&&getComputedStyle(viewport).scrollbarWidth==='none'&&getComputedStyle(viewport,'::-webkit-scrollbar').display==='none','lyrics scrollbar hidden while scroll remains enabled');
      const scrollBefore=viewport.scrollTop;viewport.scrollTop+=35;expect(viewport.scrollTop>scrollBefore,'hidden scrollbar retains scrolling');
      const chassis=root.querySelector('.mw-dev--cover .mw-dev__chassis');
      expect(!chassis||getComputedStyle(chassis,'::before').content==='none','cover has no local blurred trail');
      const translate=lyrics.querySelector<HTMLButtonElement>('[aria-pressed]')!;
      translate.click();await wait();expect(lyrics.classList.contains('show-translation')&&translate.getAttribute('aria-pressed')==='true','translation toggle enables translations');
      expect(getComputedStyle(lyrics.querySelector('.mw-lyrics__translation')!).display!=='none','translation is visible');
      const translationStyle=getComputedStyle(lyrics.querySelector('.mw-lyrics__translation')!),originalStyle=getComputedStyle(lyrics.querySelector('.mw-lyrics__original')!);
      expect(Math.abs(parseFloat(translationStyle.fontSize)/parseFloat(originalStyle.fontSize)-.72)<.01&&translationStyle.fontWeight==='525','translation uses 72 percent size and medium weight');
      translate.click();await wait();expect(getComputedStyle(lyrics.querySelector('.mw-lyrics__translation')!).display==='none','translation can be hidden');
      lyrics.querySelectorAll<HTMLButtonElement>('.mw-lyrics__line')[8].click();await wait();expect(engine.state.positionMs===40000,'click lyric seeks to row');
      viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:20,bubbles:true}));
      expect(!lyrics.querySelector('.mw-lyrics__bar button')!.classList.contains('is-hidden'),'manual browsing exposes follow button');
      lyrics.querySelector<HTMLButtonElement>('.mw-lyrics__bar button')!.click();await wait();
      expect(lyrics.querySelector('.mw-lyrics__bar button')!.classList.contains('is-hidden'),'follow resumes');
      const realSetTimeout=window.setTimeout,realClearTimeout=window.clearTimeout;
      let clock=0,nextTimer=-1;const followTimers=new Map<number,{at:number;run:()=>void}>();
      window.setTimeout=((handler:TimerHandler,delay?:number,...args:any[])=>{
        if(delay!==10000||typeof handler!=='function')return realSetTimeout(handler,delay,...args);
        const id=nextTimer--;followTimers.set(id,{at:clock+delay,run:()=>handler(...args)});return id;
      }) as typeof window.setTimeout;
      window.clearTimeout=((id?:number)=>{if(id!==undefined&&followTimers.delete(id))return;realClearTimeout(id);}) as typeof window.clearTimeout;
      const tick=(ms:number)=>{clock+=ms;for(const [id,timer] of [...followTimers])if(timer.at<=clock){followTimers.delete(id);timer.run();}};
      const following=()=>lyrics.querySelector('.mw-lyrics__bar button')!.classList.contains('is-hidden');
      try {
        viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:30}));tick(9999);expect(!following(),'manual lyrics remain until ten seconds elapse');
        tick(1);await wait(25);expect(following()&&followTimers.size===0,'ten idle seconds automatically restore following');
        const active=lyrics.querySelector<HTMLElement>('.is-active')!;
        expect(Math.abs(viewport.scrollTop-Math.max(0,active.offsetTop-viewport.clientHeight*.26))<2,'idle return targets the current timed lyric');
        viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:30}));tick(9000);viewport.dispatchEvent(new Event('scroll'));tick(9000);expect(!following(),'continued or inertial scrolling restarts the countdown');
        tick(1000);await wait(25);expect(following(),'following returns ten seconds after scrolling stops');
        viewport.dispatchEvent(new TouchEvent('touchstart'));tick(20000);expect(!following()&&followTimers.size===0,'held touch never triggers automatic return');
        viewport.dispatchEvent(new TouchEvent('touchend'));tick(9999);expect(!following(),'touch release starts a fresh ten-second countdown');tick(1);await wait(25);expect(following(),'touch browsing resumes after ten idle seconds');
        viewport.dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown'}));tick(9000);viewport.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown'}));tick(1000);expect(!following(),'repeated keyboard browsing restarts countdown');
        lyrics.querySelector<HTMLButtonElement>('.mw-lyrics__bar button')!.click();await wait();expect(following()&&followTimers.size===0,'explicit follow cancels pending return');
        viewport.dispatchEvent(new WheelEvent('wheel',{deltaY:30}));lyrics.querySelectorAll<HTMLButtonElement>('.mw-lyrics__line')[8].click();await wait();expect(followTimers.size===0&&following(),'lyric seek cancels pending return');
        const probe=root.createDiv(),component=new PlayerLyrics(probe,plugin as never);component.update(engine.state);await wait();
        probe.querySelector('.mw-lyrics__viewport')!.dispatchEvent(new WheelEvent('wheel',{deltaY:30}));expect(followTimers.size===1,'independent lyric view schedules return');
        component.update({...engine.state,songId:987654});expect(followTimers.size===0,'song changes cancel old return');await wait();
        probe.querySelector('.mw-lyrics__viewport')!.dispatchEvent(new WheelEvent('wheel',{deltaY:30}));component.dispose();expect(followTimers.size===0,'closing lyrics cancels pending return');tick(10000);probe.remove();
      } finally { for(const id of followTimers.keys())window.clearTimeout(id);window.setTimeout=realSetTimeout;window.clearTimeout=realClearTimeout; }
      await engine.seek(0);await wait();expect(lyrics.querySelector('.is-active')?.textContent?.includes('Line 1'),'seek backwards resets highlight');
      let resolveOld:any;const original=plugin.lyrics.get;(plugin.lyrics as any).get=()=>new Promise(resolve=>{resolveOld=resolve;});
      await engine.select(1);await wait();(plugin.lyrics as any).get=original;await engine.select(2);await wait();
      resolveOld({instrumental:false,lines:[{time:0,text:'STALE LYRICS'}]});await wait();
      expect(!lyrics.textContent?.includes('STALE')&&lyrics.textContent?.includes('Song 13'),'old request never replaces new song');
      (plugin.lyrics as any).get=async()=>{throw Error('Offline');};await engine.select(3);await wait();
      expect(!!lyrics.querySelector('.mw-lyrics__message')&&!lyrics.querySelector(':scope > button')!.classList.contains('is-hidden'),'failed request exposes retry');
      (plugin.lyrics as any).get=async()=>({instrumental:false,lines:[{time:null,text:'Static lyrics'}]});
      lyrics.querySelector<HTMLButtonElement>(':scope > button')!.click();await wait();
      expect(lyrics.textContent?.includes('Static lyrics')&&!lyrics.querySelector('.is-active'),'plain lyrics remain readable without false timing');
      expect(lyrics.querySelector<HTMLButtonElement>('[aria-pressed]')!.disabled,'translation disabled when unavailable');
      const cachedLines=[{time:0,text:'First line'},{time:5000,text:''},{time:7000,text:'  \t '},{time:10000,text:'Second line',translation:'第二句'}];
      (plugin.lyrics as any).get=async()=>({instrumental:false,lines:cachedLines});await engine.select(0);await engine.seek(6000);await wait();
      expect(lyrics.querySelectorAll('.mw-lyrics__line').length===2&&!lyrics.textContent?.includes('♪'),'cached blank and whitespace rows never render symbols or placeholders');
      expect(cachedLines.length===4,'filtering never mutates cached lyrics');
      lyrics.querySelectorAll<HTMLButtonElement>('.mw-lyrics__line')[1].click();await wait();
      expect(engine.state.positionMs===10000&&lyrics.querySelector('.is-active')?.textContent?.includes('Second line'),'remaining lyrics retain original timestamps and highlight correctly');
      (plugin.lyrics as any).get=async()=>({instrumental:false,lines:[{time:0,text:''},{time:5000,text:'   '}]});await engine.select(1);await wait();
      expect(!lyrics.querySelector('.mw-lyrics__line')&&lyrics.querySelector('.mw-lyrics__message')?.textContent==='暂无歌词','blank-only lyrics show empty state');
      (plugin.lyrics as any).get=async()=>({instrumental:true,lines:[]});await engine.select(0);await wait();
      expect(lyrics.querySelector('.mw-lyrics__message')?.textContent==='纯音乐，请欣赏','instrumental state');
      const messageRect=lyrics.querySelector('.mw-lyrics__message')!.getBoundingClientRect(),viewportRect=viewport.getBoundingClientRect();
      expect(Math.abs(messageRect.top+messageRect.height/2-viewportRect.top-viewportRect.height/2)<2&&Math.abs(messageRect.left+messageRect.width/2-viewportRect.left-viewportRect.width/2)<2,'status message centered horizontally and vertically inside lyric content');
      (plugin.lyrics as any).get=original;return {checks:count,fail:errors};
    };
    (window as any).verifyLyricMotion=async()=>{
      const errors:string[]=[];let checks=0;const expect=(ok:unknown,label:string)=>{checks++;if(!ok)errors.push(label);};
      (view as any).togglePlaylist(false);await engine.select(1);await engine.seek(15000);await wait(70);
      await engine.seek(20000);await wait(35);
      const lines=[...root.querySelectorAll<HTMLElement>('.mw-lyrics__line')];
      const moving=lines.flatMap(line=>line.getAnimations().filter(animation=>animation.effect?.getKeyframes().some(frame=>String(frame.transform).includes('translateY'))));
      expect(moving.length>=3,'multiple lyric rows move independently');
      const delays=moving.map(animation=>Number(animation.effect!.getTiming().delay));
      expect(delays.every((delay,index)=>delay===index*50),'each lower visible row starts exactly 50ms later');
      expect(moving.every(animation=>animation.effect!.getTiming().duration===650),'row motion uses consistent smooth duration');
      await wait(Math.max(0,...delays)+750);
      expect(lines.every(line=>!line.getAnimations().some(animation=>animation.effect?.getKeyframes().some(frame=>String(frame.transform).includes('translateY')))),'finished motion releases animation layers');
      return {checks,fail:errors};
    };
    (window as any).prepareLyricsScreenshot=async()=>{(view as any).togglePlaylist(false);(view as any).togglePopover(null);await engine.select(1);await engine.seek(25000);await wait(60);};
    (window as any).verifyStandaloneDiscs=async()=>{
      const errors:string[]=[];let checks=0;const expect=(ok:unknown,label:string)=>{checks++;if(!ok)errors.push(label);};
      (view as any).togglePlaylist(false);(view as any).drawer.open('settings');await wait();
      const pick=(style:string)=>root.querySelector<HTMLButtonElement>(`[data-mw-style="${style}"]`)!.click();
      const toggle=()=>root.querySelector<HTMLButtonElement>('.mw-machine-toggle')!;
      const unchanged=()=>engine.state.songId===song&&engine.index===index&&engine.state.positionMs===position;
      await engine.pause();const song=engine.state.songId,index=engine.index,position=engine.state.positionMs;
      pick('vinyl');expect(toggle().getAttribute('aria-checked')==='true'&&!!root.querySelector('.mw-dev--vinyl'),'vinyl defaults to turntable');
      toggle().click();await wait();
      expect(!!root.querySelector('.mw-player-disc-only--vinyl .mw-record__plate')&&!root.querySelector('.mw-dev__chassis'),'vinyl toggle renders only disc');
      expect(root.querySelector('.mw-case-options')!.classList.contains('is-hidden'),'bare disc hides machine finish settings');
      expect(!!toggle().querySelector('svg')&&toggle().getAttribute('role')==='switch','machine switch has SVG and accessible state');
      const switchSvg=toggle().querySelector('svg')!,thumb=toggle().querySelector<SVGCircleElement>('.mw-machine-switch__thumb')!;
      expect(switchSvg.getBoundingClientRect().width>=43&&switchSvg.getBoundingClientRect().height>=25,'switch has a large 44 by 26 SVG');
      expect(getComputedStyle(thumb).transitionDuration.includes('0.22'),'switch thumb has sliding animation');
      const thumbElement=thumb;
      const finish=(value:string)=>root.querySelector<HTMLButtonElement>(`[data-vinyl-finish="${value}"]`)!.click();
      expect(root.querySelectorAll('[data-vinyl-finish]').length===6&&!root.querySelector('.mw-vinyl-options')!.classList.contains('is-hidden'),'bare vinyl offers six disc materials');
      const disc=root.querySelector('.mw-player-disc-only .mw-record__plate')!;const materials:string[]=[];
      for(const value of ['black','white','color','blackGlass','whiteGlass','colorGlass']){
        finish(value);await wait();materials.push(getComputedStyle(disc).backgroundImage);
        expect(root.dataset.mwVinyl===value&&root.querySelector(`[data-vinyl-finish="${value}"]`)!.getAttribute('aria-pressed')==='true','persists selected vinyl finish '+value);
      }
      expect(new Set(materials).size===6,'all six materials have distinct rendered backgrounds');
      expect(root.querySelector('.mw-player-disc-only .mw-record__plate')===disc,'material changes retain rotating element');
      finish('black');
      expect(unchanged()&&engine.state.status==='paused','switch preserves track, position and pause');
      const plate=root.querySelector<HTMLElement>('.mw-player-disc-only .mw-record__plate')!;
      expect(getComputedStyle(plate).animationPlayState==='paused','bare vinyl is paused with audio');
      await engine.play();await wait(50);expect(root.querySelector('.mw-player-disc-only .mw-record__plate')===plate&&getComputedStyle(plate).animationPlayState==='running','resume starts rotation without replacing disc');
      await engine.pause();await wait();expect(root.querySelector('.mw-player-disc-only .mw-record__plate')===plate&&getComputedStyle(plate).animationPlayState==='paused','pause freezes same rotating disc');
      pick('cd');expect(toggle().getAttribute('aria-checked')==='true'&&!!root.querySelector('.mw-dev--cd'),'CD has independent enabled default');
      expect(root.querySelector('.mw-vinyl-options')!.classList.contains('is-hidden'),'CD hides vinyl material options');
      toggle().click();await wait();expect(!!root.querySelector('.mw-player-disc-only--cd .mw-disc--cd'),'CD toggle renders bare CD');
      pick('vinyl');expect(toggle().getAttribute('aria-checked')==='false'&&!!root.querySelector('.mw-player-disc-only--vinyl'),'vinyl remembers separate setting');
      toggle().click();await wait();expect(!!root.querySelector('.mw-dev--vinyl')&&!root.querySelector('.mw-case-options')!.classList.contains('is-hidden'),'machine and finish options can be restored');
      expect(toggle().querySelector('.mw-machine-switch__thumb')===thumbElement,'toggle retains the same SVG thumb for animation');
      expect(root.querySelector('.mw-vinyl-options')!.classList.contains('is-hidden'),'turntable hides independent disc materials');
      for(const choice of ['white','black','wood','art']) {
        root.querySelector<HTMLButtonElement>(`[data-case-choice="${choice}"]`)!.click();
        expect(root.dataset.mwVinyl===(choice==='art'?'color':'black'),'turntable record follows chassis rule '+choice);
      }
      toggle().click();finish('whiteGlass');toggle().click();
      expect(root.dataset.mwVinyl==='color'&&plugin.settings.playerVinylFinish==='whiteGlass','turntable leaves independent finish preference intact');
      toggle().click();expect(root.dataset.mwVinyl==='whiteGlass','turning off turntable restores saved independent finish');
      toggle().click();
      pick('cd');expect(toggle().getAttribute('aria-checked')==='false','restoring vinyl never changes CD setting');
      pick('cover');expect(root.querySelector('.mw-machine-options')!.classList.contains('is-hidden'),'cover has no machine switch');
      expect(unchanged(),'style switches do not seek or change songs');
      if(config.style==='vinyl'){pick('vinyl');if(toggle().getAttribute('aria-checked')==='true')toggle().click();}else pick('cd');
      (view as any).drawer.close();await engine.play();await wait(50);return {checks,fail:errors};
    };
    (window as any).verifyKeyboardPlayback=async()=>{
      const failures:string[]=[];let assertions=0;
      const expect=(ok:boolean,label:string)=>{assertions++;if(!ok)failures.push(label);};
      const space=async(target:EventTarget=document,options:KeyboardEventInit={})=>{
        const event=new KeyboardEvent('keydown',{key:' ',code:'Space',bubbles:true,cancelable:true,...options});
        target.dispatchEvent(event);await wait(20);return event;
      };
      await engine.pause();(document.activeElement as HTMLElement)?.blur();
      expect((await space()).defaultPrevented&&engine.state.status==='playing','Space resumes without scrolling');
      expect((await space(root)).defaultPrevented&&engine.state.status==='paused','Space in the player pauses');
      expect((await space(document,{repeat:true})).defaultPrevented&&engine.state.status==='paused','Held Space neither toggles repeatedly nor scrolls');
      for(const options of [{ctrlKey:true},{altKey:true},{metaKey:true},{shiftKey:true},{isComposing:true}]){
        expect(!(await space(document,options)).defaultPrevented&&engine.state.status==='paused','Modified or composing Space is ignored');
      }
      for(const tag of ['input','textarea','select','button','a','div']){
        const control=document.createElement(tag);
        if(tag==='a')control.setAttribute('href','#');
        if(tag==='div')control.contentEditable='true';
        root.appendChild(control);
        expect(!(await space(control)).defaultPrevented&&engine.state.status==='paused',`Space in ${tag} keeps its native action`);
        control.remove();
      }
      const modal=document.createElement('div');modal.className='modal-container';document.body.appendChild(modal);
      expect(!(await space(modal)).defaultPrevented&&engine.state.status==='paused','A modal does not trigger playback');modal.remove();
      activePlayer=null;
      expect(!(await space()).defaultPrevented&&engine.state.status==='paused','Space outside the active player is ignored');
      const second=new MusicPlayerView(new WorkspaceLeaf(app),plugin as never);
      mount.appendChild(second.contentEl);await second.onOpen();activePlayer=second;
      expect((await space()).defaultPrevented&&engine.state.status==='playing','Multiple player tabs toggle shared playback only once');
      await second.onClose();second.contentEl.remove();activePlayer=view;
      await engine.pause();
      return {checks:assertions,fail:failures};
    };
    check(!!root.querySelector('.mw-np__quality-button .mw-control-icon svg'),"Quality dropdown uses an SVG chevron");
    checkScrollbar(root.querySelector<HTMLElement>('.mw-np__tracks')!);
    const volume=root.querySelector<HTMLButtonElement>(".mw-np__popover-anchor > .mw-np__ctrl")!;
    const list=root.querySelector<HTMLButtonElement>(".mw-np__ctrl--list")!;
    check(list.previousElementSibling?.getAttribute('data-action')==='play-order',"Playback order immediately precedes playlist in the full player");
    check(!!list.previousElementSibling?.querySelector('svg'),"Full player playback order uses an SVG icon");
    check(volume.getBoundingClientRect().left>=list.getBoundingClientRect().right-1 || (config.zoom??1)>1,"Volume follows playlist");
    const seek=root.querySelector<HTMLInputElement>(".mw-range")!;
    check(seek.style.getPropertyValue("--mw-range-percent").length>0,"Seek track has progress fill");
    const track=root.querySelector<HTMLElement>(".mw-np__timeline .mw-slider__track")!.getBoundingClientRect();
    const thumb=root.querySelector<HTMLElement>(".mw-np__timeline .mw-slider__thumb")!.getBoundingClientRect();
    check(Math.abs(track.top+track.height/2-thumb.top-thumb.height/2)<1,"Seek thumb stays centered on its track under host styles");
    const chassis=root.querySelector<HTMLElement>('.mw-dev__chassis')!;
    check(root.dataset.mwCase===(config.deviceCase??'black'),'Device case selection is applied');
    if(config.style!=='cover') {
      check(getComputedStyle(chassis).getPropertyValue('--mw-case-fill').length>0,'Chassis uses its own finish palette');
      check(getComputedStyle(chassis).backgroundImage.includes('url(')&&getComputedStyle(chassis,'::after').content!=='none','Material details remain enabled even with an old disabled preference');
    }
    if(config.panel==='case') {
      root.querySelector<HTMLButtonElement>('.mw-toolbtn')!.click();await wait(40);
      const section=root.querySelector<HTMLElement>('.mw-case-options')!;
      const vinylOptions=root.querySelector<HTMLElement>('.mw-vinyl-options')!;
      check(vinylOptions.classList.contains('is-hidden'),'Machine mode hides independent vinyl finish choices');
      check(section.classList.contains('is-hidden')===(config.style==='cover'),'Case options are hidden for the pure cover style');
      if(config.style!=='cover'){
        check(section.querySelectorAll('[data-case-choice]').length===4,'Four case finishes are available');
        check(!section.querySelector('[role="switch"]'),'Case options no longer contain a material switch');
        for(const button of section.querySelectorAll<HTMLElement>('[data-case-choice]'))check(button.scrollWidth<=button.clientWidth+1,'Case preset contents fit their tile');
      }
      const drawerBody=root.querySelector<HTMLElement>('.mw-drawer__body')!;drawerBody.scrollTop=drawerBody.scrollHeight;
      const last=root.querySelector<HTMLElement>('[data-mw-bg]:last-child')!;
      check(last.getBoundingClientRect().bottom<=hostBar.getBoundingClientRect().top+1,'Last style option remains above the host status bar');
      drawerBody.scrollTop=0;
    } else if(config.panel==="volume") {
      volume.click();
      const slider=root.querySelector<HTMLInputElement>(".mw-np__volume-panel input")!;
      slider.value="0.35";slider.dispatchEvent(new Event("input"));
      check(engine.volume===.35,"Volume panel changes player volume");
      await wait(20);
      check(!!root.querySelector('.mw-np__quality-button .mw-control-icon svg'),"Quality SVG survives playback state updates");
      const wrapper=slider.parentElement!.getBoundingClientRect();
      check(wrapper.height>wrapper.width*2,"Volume slider is vertical");
      check(!root.querySelector(".mw-np__volume-panel")!.textContent?.trim(),"Volume panel contains no visible text");
      const t=root.querySelector<HTMLElement>(".mw-np__volume-panel .mw-slider__track")!.getBoundingClientRect();
      const h=root.querySelector<HTMLElement>(".mw-np__volume-panel .mw-slider__thumb")!.getBoundingClientRect();
      check(Math.abs(t.left+t.width/2-h.left-h.width/2)<1,"Volume thumb stays centered on its track");
    } else if(config.panel==="quality") {
      root.querySelector<HTMLButtonElement>(".mw-np__quality-button")!.click();
      check(root.querySelectorAll("[data-quality]").length===3,"Quality menu contains verified levels only");
      check(!root.querySelector('[data-quality="hires"]'),"Unsupported Hi-Res is hidden");
      check(!root.querySelector(".mw-np__quality-panel .mw-np__popover-head,.mw-np__quality-panel .mw-np__popover-hint"),"Quality menu contains options only");
      check([...root.querySelectorAll("[data-quality]")].map(x=>x.textContent).join(',')==='320kbps,192kbps,128kbps',"Quality labels use the requested bitrates");
      check(!!root.querySelector('.mw-np__quality-option[aria-pressed="true"] .mw-control-icon svg'),"Selected quality uses an SVG check");
    } else {
      list.click();
      if(config.panel==='queue') {
        root.querySelector<HTMLButtonElement>('[data-action="album-queue"]')!.click();await wait(20);
        if(config.longQueue){const queue=root.querySelector<HTMLElement>('.mw-queue')!;check(queue.scrollHeight>queue.clientHeight,'Long album queues scroll inside the player panel');queue.scrollTop=queue.scrollHeight;const toolbar=queue.querySelector<HTMLElement>('.mw-queue__toolbar')!.getBoundingClientRect();check(toolbar.top>=queue.getBoundingClientRect().top-1&&toolbar.bottom<=queue.getBoundingClientRect().bottom+1,'Queue view tabs remain reachable when scrolled');const last=queue.querySelector<HTMLElement>('.mw-queue__row:last-child')!;check(last.getBoundingClientRect().bottom<=queue.getBoundingClientRect().bottom+1,'Last queued album remains accessible');}
      }
      const panel=root.querySelector<HTMLElement>(".mw-player__playlist")!;
      const name=panel.querySelector<HTMLElement>(".mw-np__trackName")!;
      check(getComputedStyle(name).color===getComputedStyle(panel).getPropertyValue("--mw-panel-fg").trim() || getComputedStyle(name).color==="rgb(242, 244, 248)" || getComputedStyle(name).color==="rgb(233, 236, 241)" || getComputedStyle(name).color==="rgb(34, 37, 43)" || getComputedStyle(name).color==="rgb(246, 239, 228)","Playlist uses its own text palette");
    }
    await wait(40);
    const visible=root.querySelector<HTMLElement>(config.panel==='case'?'.mw-drawer.is-open':config.panel==="volume"?".mw-np__volume-panel":config.panel==="quality"?".mw-np__quality-panel":".mw-player__playlist")!;
    const rect=visible.getBoundingClientRect();
    check(rect.left>=-1&&rect.right<=innerWidth+1,"Panel fits pane width");
    check(rect.top>=-1&&rect.bottom<=innerHeight+1,"Panel fits pane height");
    // The blurred cover intentionally extends past the root; it is clipped and never scrolls.
    check(getComputedStyle(root).overflowX==="hidden"&&root.querySelector<HTMLElement>(".mw-zoombox")!.getBoundingClientRect().right<=innerWidth+1,"Player clips decorative overflow within pane");
    check(visible.scrollWidth<=visible.clientWidth+1,"Panel content has no horizontal overflow");
    check(config.panel==='case'||config.statusBar===false||rect.bottom<=hostBar.getBoundingClientRect().top+1,"Host status bar does not cover the panel");
    check(!root.querySelector(".mw-player__playlist-note"),"Playlist has no developer explanation");
    const panelBg=over(rgba(getComputedStyle(visible).backgroundColor),[255,255,255,1]);
    (window as any).verifyHoverContrast=()=>{
      const row=root.querySelector('.mw-np__track:nth-child(2)')!;
      const bg=over(rgba(getComputedStyle(row).backgroundColor),panelBg);
      return [...row.querySelectorAll('.mw-np__trackName,.mw-np__trackNo,.mw-np__trackDur')].every(text=>contrast(getComputedStyle(text).color,bg)>=4.5);
    };
    if(config.panel!=="playlist") {
      for(const option of visible.querySelectorAll(".mw-np__quality-option"))check(contrast(getComputedStyle(option).color,panelBg)>=4.5,"Quality option contrast is readable");
      for(const hint of visible.querySelectorAll(".mw-np__popover-hint"))check(contrast(getComputedStyle(hint).color,panelBg)>=4.5,"Popup hint contrast is readable");
    } else {
      for(const text of visible.querySelectorAll(".mw-np__trackName,.mw-np__trackNo,.mw-np__trackDur,.mw-player__playlist-note")) {
        const row=text.closest(".mw-np__track"),bg=row?over(rgba(getComputedStyle(row).backgroundColor),panelBg):panelBg;
        const ratio=contrast(getComputedStyle(text).color,bg);
        check(ratio>=4.5,`Playlist ${text.className} contrast is readable (${ratio.toFixed(2)})`);
      }
    }
    if(config.bg!=="art") {
      const bg=rgba(config.bg==="white"?"#eef0f3":config.bg==="wood"?"#7a5433":"#252932");
      for(const text of root.querySelectorAll(".mw-np__title,.mw-np__artist,.mw-np__status,.mw-np__elapsed"))check(contrast(getComputedStyle(text).color,bg)>=4.5,"Player text contrast is readable");
    }
    (window as any).verifyCaseControls = async()=>{
      const failures:string[]=[];
      if(!root.querySelector('.mw-drawer.is-open'))root.querySelector<HTMLButtonElement>('.mw-toolbtn')!.click();
      const originalId=engine.state.songId, originalIndex=engine.index;
      root.querySelector<HTMLButtonElement>('[data-case-choice="white"]')!.click();
      if(plugin.settings.playerCase!=='white'||root.dataset.mwCase!=='white')failures.push('White case was not applied');
      root.querySelector<HTMLButtonElement>('[data-case-choice="art"]')!.click();await wait(70);
      const color=root.style.getPropertyValue('--mw-case-accent');
      const vinylSurface=()=>getComputedStyle(root.querySelector<HTMLElement>('.mw-dev__platter .mw-record__plate')!).backgroundImage;
      const vinylWell=()=>getComputedStyle(root.querySelector<HTMLElement>('.mw-dev__chassis')!,'::before').backgroundImage;
      const plateColor=vinylSurface(), wellColor=vinylWell();
      if(!color||color==='#596773')failures.push('Cover color extraction is unavailable with a non-cover page background');
      if(engine.state.songId!==originalId||engine.index!==originalIndex)failures.push('Changing the case interrupted playback');
      await engine.playPlaylist({...meta,albumId:0,playlistId:99,tracks:meta.tracks.map(track=>({...track,cover:probeCoverUri('c25b34')}))});await wait(90);
      if(root.style.getPropertyValue('--mw-case-accent')===color)failures.push('Case color did not follow the current song cover');
      if(vinylSurface()===plateColor||vinylWell()===wellColor)failures.push('Vinyl or recessed well did not follow the current song cover');
      root.querySelector<HTMLButtonElement>('[data-case-choice="black"]')!.click();
      if(vinylSurface().includes('color(srgb')||vinylWell().includes('color(srgb'))failures.push('Cover tint leaked into the black finish');
      root.querySelector<HTMLButtonElement>('[data-mw-style="cover"]')!.click();
      if(!root.querySelector('.mw-case-options.is-hidden'))failures.push('Pure-cover style still shows case options');
      return failures;
    };
    (window as any).verifyQueueSwitches = async()=>{
      let checks=0;const errors:string[]=[];const expect=(ok:unknown,label:string)=>{checks++;if(!ok)errors.push(label);};
      const artistButton=()=>root.querySelector<HTMLButtonElement>('.mw-np__artist')!;
      await engine.playAlbum({...meta,tracks:[{...meta.tracks[0],artistRefs:[{id:7,name:'Solo artist'}]}]});await wait();await engine.pause();
      artistButton().click();await wait();expect(sourceCalls.at(-1)?.artist?.id===7,'player single artist opens directly');
      expect(engine.state.status==='paused'&&engine.state.songId===11,'artist navigation preserves playback');
      await engine.playAlbum({...meta,tracks:[{...meta.tracks[0],artistRefs:[{id:7,name:'Solo artist'},{id:8,name:'Second artist'}]}]});await wait();
      artistButton().click();await wait();
      const choices=[...document.querySelectorAll<HTMLElement>('.mw-picker__row')];
      expect(choices.length===2,'player multiple artists opens chooser');choices[1]?.click();await wait();
      expect(sourceCalls.at(-1)?.artist?.id===8,'player chooser opens selected artist');
      await engine.playAlbum(meta);await wait();artistButton().click();await wait();
      expect(sourceCalls.at(-1)?.artist?.id===91,'old snapshots resolve actual artist IDs');
      let resolveLookup:any;artistLookup=()=>new Promise(resolve=>{resolveLookup=resolve;});
      const before=sourceCalls.length;artistButton().click();await wait();await engine.select(1);await wait();
      resolveLookup([{id:11,artistRefs:[{id:93,name:'Stale artist'}]}]);await wait();
      expect(sourceCalls.length===before&&!document.querySelector('.mw-picker__row'),'stale artist lookup ignored after song changes');
      artistLookup=async()=>[{id:11,artistRefs:[{id:91,name:'Resolved artist'}]}];
      await engine.playPlaylist({...meta,albumId:0,playlistId:99,name:'Saved playlist'});await engine.seek(43000);await engine.pause();
      await engine.playAlbum({...meta,playbackWallPath:'MusicWall/Test.mw'});engine.enqueueAlbum({...meta,albumId:2});await engine.seek(27000);await engine.pause();await wait(20);
      const tabs=()=>[...root.querySelectorAll<HTMLButtonElement>('.mw-queue [data-queue-view]')];
      expect(tabs().length===2,'both queue tabs always present');
      const unchanged=()=>engine.contentKind==='album'&&engine.index===0&&engine.state.positionMs===27000&&engine.state.status==='paused'&&engine.albumQueue.length===2;
      tabs().find(t=>t.dataset.queueView==='playlist')!.click();await wait();
      expect(unchanged(),'viewing songs preserves album, progress, pause and album queue');
      expect(root.querySelectorAll('.mw-np__track').length===4,'saved song list visible');
      expect(!root.querySelector('.mw-np__track.is-current'),'inactive saved list has no playing highlight');
      tabs().find(t=>t.dataset.queueView==='album')!.click();await wait();
      expect(unchanged()&&root.querySelectorAll('.mw-queue__row').length===2,'switching back keeps playback unchanged');
      const source=root.querySelector<HTMLButtonElement>('.mw-player__source')!;
      expect(source.textContent==='音乐墙专辑·'+meta.name,'wall source uses type and album name');
      source.click();await wait();expect(sourceCalls.at(-1)?.kind==='wall'&&sourceCalls.at(-1)?.id===1,'wall source locates original wall');
      expect(!root.querySelector('.mw-np__jump'),'old source pill removed');
      const bar=root.querySelector('.mw-player__bar')!.getBoundingClientRect(),src=source.getBoundingClientRect();
      expect(Math.abs(src.left+src.width/2-bar.left-bar.width/2)<1,'source centered across full header');
      tabs().find(t=>t.dataset.queueView==='playlist')!.click();await wait();
      root.querySelector<HTMLElement>('.mw-np__track:nth-child(3)')!.click();await wait(20);
      expect(engine.contentKind==='playlist'&&engine.index===2&&engine.albumQueue.length===2,'song click explicitly switches playback retaining albums');
      expect(source.textContent==='歌单·Saved playlist','playlist source is displayed');source.click();await wait();expect(sourceCalls.at(-1)?.kind==='library'&&sourceCalls.at(-1)?.meta.playlistId===99,'playlist source opens details');
      tabs().find(t=>t.dataset.queueView==='album')!.click();await wait();
      const song=engine.state.songId;expect(engine.contentKind==='playlist'&&engine.state.songId===song,'album tab only browses');
      root.querySelector<HTMLButtonElement>('.mw-queue__row:nth-child(2) .mw-queue__name')!.click();await wait(20);
      expect(engine.contentKind==='album'&&engine.album?.albumId===2&&engine.queuedPlaylist?.tracks?.length===4,'album click explicitly switches retaining song list');
      expect(source.textContent==='专辑·'+meta.name,'ordinary album source displayed');source.click();await wait();expect(sourceCalls.at(-1)?.meta.albumId===2,'album source opens album details');
      const wall=await createWall();await wait(20);const mini=wall.contentEl.querySelector<HTMLElement>('.mw-mini')!;
      const detail=document.createElement('div');wall.contentEl.appendChild(detail);
      const wallMeta={...meta,artistRefs:[{id:71,name:'Album artist'},{id:72,name:'Second album artist'}]};
      (wall as any).buildGatefold(detail,{albumId:1,meta:wallMeta});
      detail.querySelector<HTMLButtonElement>('.mw-gf__name')!.click();await wait();
      expect(sourceCalls.at(-1)?.kind==='library'&&sourceCalls.at(-1)?.meta===wallMeta,'wall album name opens album details');
      detail.querySelector<HTMLButtonElement>('.mw-gf__artist')!.click();await wait();
      const wallArtists=[...document.querySelectorAll<HTMLElement>('.mw-picker__row')];
      expect(wallArtists.length===2,'wall album artists open chooser');wallArtists[1]?.click();await wait();
      expect(sourceCalls.at(-1)?.artist?.id===72,'wall chooser uses album artists');
      (wall as any).buildGatefold(detail,{albumId:1,meta:{...meta,artistRefs:[{id:73,name:'Single album artist'}]}});
      detail.querySelector<HTMLButtonElement>('.mw-gf__artist')!.click();await wait();
      expect(sourceCalls.at(-1)?.artist?.id===73,'wall single artist opens directly');
      let resolveAlbum:any;(plugin as any).fetchAlbumDetail=()=>new Promise(resolve=>{resolveAlbum=resolve;});
      (wall as any).buildGatefold(detail,{albumId:1,meta});const callsBefore=sourceCalls.length;
      detail.querySelector<HTMLButtonElement>('.mw-gf__artist')!.click();await wait();
      (wall as any).snapShut(detail,null);resolveAlbum({...meta,artistRefs:[{id:74,name:'Stale album artist'}]});await wait();
      expect(sourceCalls.length===callsBefore,'wall closed detail ignores pending artist lookup');detail.remove();
      await engine.pause();expect(!mini.querySelector('.mw-mini__artist')!.textContent?.includes('已暂停'),'mini omits paused label');
      const r=mini.getBoundingClientRect(),ctrl=mini.querySelector('.mw-mini__controls')!.getBoundingClientRect();expect(Math.abs(ctrl.left+ctrl.width/2-r.left-r.width/2)<1,'mini controls centered across bar');
      mini.querySelector<HTMLButtonElement>('[data-action=playlist]')!.click();
      mini.querySelector<HTMLButtonElement>('[data-queue-view=playlist]')!.click();await wait();
      expect(mini.querySelectorAll('.mw-mini__track').length===4&&engine.contentKind==='album','mini can browse saved songs without playing');
      mini.querySelector<HTMLButtonElement>('.mw-mini__track:nth-child(2)')!.click();await wait();
      expect(engine.contentKind==='playlist'&&engine.index===1,'mini saved song click plays selected index');
      mini.querySelector<HTMLButtonElement>('[data-queue-view=album]')!.click();await wait();expect(engine.contentKind==='playlist','mini album tab never starts audio');
      root.querySelector<HTMLButtonElement>('[data-queue-view=playlist]')!.click();await wait();await engine.playQueued(engine.albumQueue[0].id);await wait();engine.enqueuePlaylist({...meta,albumId:0,playlistId:17,tracks:[{...meta.tracks[0],id:999}]});await wait();expect(root.querySelectorAll('.mw-np__track').length===5,'inactive saved song list updates when appended');
      await wall.onClose();wall.contentEl.remove();return {checks,fail:errors};
    };
    (window as any).verifyQueueUI = async()=>{
      const failures:string[]=[];
      const original=engine.currentEntryId;
      root.querySelector<HTMLButtonElement>('.mw-np__track:nth-child(2)')!.click();await wait(30);
      if(engine.albumQueue.length!==3||engine.currentEntryId!==original||engine.index!==1)failures.push('Selecting a song destroyed the album queue');
      const controls=root.querySelector('.mw-queue')!;
      if(!controls.querySelector('.mw-queue__row'))controls.querySelector<HTMLButtonElement>('[data-action="album-queue"]')!.click();
      const current=controls.querySelector('.mw-queue__row.is-current')!;
      if([...current.querySelectorAll<HTMLButtonElement>('.mw-queue__actions button')].slice(0,2).some(button=>!button.disabled))failures.push('Current album can be moved');
      const moving=controls.querySelectorAll<HTMLElement>('.mw-queue__row')[2], target=controls.querySelectorAll<HTMLElement>('.mw-queue__row')[1];
      const transfer=new DataTransfer();moving.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:transfer}));
      if(engine.albumQueue[1].album.albumId!==3||engine.currentEntryId!==original)failures.push('Queue drag failed or moved current album');
      controls.querySelector<HTMLButtonElement>('.mw-queue__row.is-current .mw-queue__actions button:last-child')!.click();await wait(30);
      if(engine.albumQueue.length!==2||engine.album?.albumId!==3)failures.push('Removing current album did not advance');
      const seen:string[]=[];for(let i=0;i<3;i++){seen.push(engine.order);root.querySelector<HTMLButtonElement>('[data-action="play-order"]')!.click();}
      if(seen.includes('shuffle')||new Set(seen).size!==3)failures.push('Album order modes are incorrect');
      await engine.playPlaylist({...meta,albumId:0,playlistId:42});await wait(30);
      root.querySelector<HTMLButtonElement>('[data-queue-view=playlist]')!.click();await wait(0);
      for(let i=0;i<4&&engine.order!=='shuffle';i++)root.querySelector<HTMLButtonElement>('[data-action="play-order"]')!.click();
      if(engine.order!=='shuffle')failures.push('Playlist shuffle is unavailable');
      root.querySelector<HTMLButtonElement>('.mw-np__track:nth-child(3)')!.click();await wait(30);
      if(engine.contentKind!=='playlist'||engine.order!=='shuffle'||engine.index!==2)failures.push('Playlist song selection reset its playback mode');
      engine.enqueuePlaylist({...meta,albumId:0,playlistId:7,tracks:meta.tracks.map(track=>({...track,id:track.id+100}))});await wait(30);
      if(root.querySelectorAll('.mw-np__track').length!==8)failures.push('Appended songs are missing from full player');
      return failures;
    };
    (window as any).verifyOutside = async()=>{
      const failures:string[]=[];
      list.click();if(!root.querySelector('.mw-player__playlist.is-open'))list.click();
      root.querySelector('.mw-player__playlist')!.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
      if(!root.querySelector('.mw-player__playlist.is-open'))failures.push('Clicking inside the playlist must keep it open');
      root.querySelector('.mw-player__title')!.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
      if(root.querySelector('.mw-player__playlist.is-open'))failures.push('Clicking blank space must close the playlist');
      root.querySelector<HTMLButtonElement>('.mw-toolbtn')!.click();
      root.querySelector('.mw-player__body')!.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));
      if(root.querySelector('.mw-drawer.is-open'))failures.push('Clicking blank space must close the style drawer');
      return failures;
    };
  }
  (window as any).playbackEngine=engine;
  (window as any).verifyPlayOrderControls=async()=>{
    const failures:string[]=[];let assertions=0;
    const expect=(ok:unknown,label:string)=>{assertions++;if(!ok)failures.push(label);};
    const wall=await createWall();
    const full=new MusicPlayerView(new WorkspaceLeaf(app),plugin as never);
    mount.appendChild(full.contentEl);await full.onOpen();
    const mini=wall.contentEl.querySelector<HTMLButtonElement>('.mw-mini__tools [data-action="play-order"]')!;
    const main=full.contentEl.querySelector<HTMLButtonElement>('.mw-np__controls [data-action="play-order"]')!;
    const queue=()=>full.contentEl.querySelector<HTMLButtonElement>('.mw-queue [data-action="play-order"]')!;
    const synchronized=async(mode:string,icon:string)=>{
      await wait(0); // The full view refreshes its metadata before updating controls.
      expect(engine.order===mode&&[mini,main,queue()].every(button=>button.querySelector('svg')?.getAttribute('data-icon')===icon),'All order icons follow '+mode);
      expect([mini,main,queue()].every(button=>button.title===main.title&&button.getAttribute('aria-label')===main.title)&&!!main.title,'Order tooltips and accessible labels stay synchronized');
    };
    await engine.playAlbum(meta);await engine.seek(38000);await engine.pause();engine.setOrder('order');
    const song=engine.state.songId;
    mini.click();await synchronized('repeat','repeat');
    const albumRepeat=main.title;
    queue().click();await synchronized('one','repeat-1');
    main.click();await synchronized('order','list-ordered');
    expect(engine.state.songId===song&&engine.state.status==='paused'&&engine.state.positionMs===38000,'Changing order preserves the song, progress and paused state');
    await engine.playPlaylist({...meta,albumId:0,playlistId:42});
    mini.click();await synchronized('repeat','repeat');
    expect(main.title!==albumRepeat,'Repeat tooltip distinguishes a song list from an album queue');
    main.click();await synchronized('one','repeat-1');
    queue().click();await synchronized('shuffle','shuffle');
    mini.click();await synchronized('order','list-ordered');
    engine.setOrder('shuffle');await engine.playAlbum(meta);await synchronized('order','list-ordered');
    await full.onClose();full.contentEl.remove();await wall.onClose();wall.contentEl.remove();
    return {checks:assertions,fail:failures};
  };
  (window as any).verifyHostResize=async()=>{
    const root=views[0].contentEl;
    hostBar.style.height='44px';await wait(100);
    const bigger=parseFloat(getComputedStyle(root).getPropertyValue('--mw-host-bottom'));
    hostBar.style.display='none';await wait(100);
    const hidden=parseFloat(getComputedStyle(root).getPropertyValue('--mw-host-bottom'));
    hostBar.style.height='28px';hostBar.style.display='flex';await wait(100);
    return bigger>0&&hidden===0;
  };
  (window as any).verifySharedPlayback = async()=>{
    const second=await createWall();await wait(30);
    const titles=()=>[...mount.querySelectorAll(".mw-mini__title")].map(x=>x.textContent);
    check(titles().length===2&&titles()[0]===titles()[1],"Two walls share the current song");
    second.contentEl.querySelector<HTMLButtonElement>('.mw-mini [data-action="toggle"]')!.click();await wait(30);
    check(engine.state.status==="paused","Second wall pauses global playback");
    second.contentEl.querySelector<HTMLButtonElement>('.mw-mini [data-action="next"]')!.click();await wait(30);
    check(engine.index===1&&titles()[0]===titles()[1],"Next track syncs across walls");
    second.contentEl.querySelector<HTMLButtonElement>('.mw-mini [data-action="quality"]')!.click();
    second.contentEl.querySelector<HTMLButtonElement>('.mw-mini [data-quality="higher"]')!.click();await wait(30);
    check([...mount.querySelectorAll('.mw-mini [data-action="quality"]')].every(button=>button.textContent==='192kbps'),"Quality changes sync across walls");
    const volume=second.contentEl.querySelector<HTMLInputElement>('.mw-mini__volume input')!;volume.value='.42';volume.dispatchEvent(new Event('input'));
    check([...mount.querySelectorAll<HTMLInputElement>('.mw-mini__volume input')].every(input=>input.value==='0.42'),"Volume changes sync across walls");
    second.contentEl.querySelector<HTMLButtonElement>(".mw-mini__open")!.click();await wait(10);check(opens===1,"Footer opens full player explicitly");
    await second.onClose();second.contentEl.remove();check(engine.state.status==="playing","Closing a wall preserves playback");
    engine.stop();check(views[0].contentEl.querySelector(".mw-mini")!.classList.contains("is-hidden"),"Stop hides remaining footer");
    return {checks,fail};
  };
  (window as any).verifyWallAppearance=async()=>{
    const errors:string[]=[];let count=0;const expect=(ok:unknown,label:string)=>{count++;if(!ok)errors.push(label);};
    const view:any=views[0],root=view.contentEl as HTMLElement,button=root.querySelector<HTMLButtonElement>('.mw-wall-appearance')!;
    const before={background:getComputedStyle(root).backgroundImage,color:getComputedStyle(root).color};
    expect(!!button?.querySelector('svg')&&button.nextElementSibling?.querySelector('svg')?.dataset.icon==='more-horizontal','appearance SVG sits immediately before more menu');
    const pane=root.getBoundingClientRect();expect([...root.querySelectorAll('.mw-toolbar .mw-toolbtn')].every(e=>{const r=e.getBoundingClientRect();return r.left>=pane.left-1&&r.right<=pane.right+1;}),'all toolbar actions stay reachable in narrow panes');
    expect(root.querySelector<HTMLElement>('.mw-grid,.mw-list,.mw-shelf')?.style.getPropertyValue('--mw-min-col')==='180px','wall column width is locked to 180px');
    for(const mode of ['light','dark','system']) {
      button.click();await wait();expect(plugin.settings.wallAppearance===mode,'theme button cycles to '+mode);
      expect(button.querySelector<SVGElement>('svg')?.dataset.icon===(mode==='light'?'sun':mode==='dark'?'moon':'sun-moon'),'correct mode icon '+mode);
      if(config.layout==='shelf')expect(getComputedStyle(root).backgroundImage===before.background&&getComputedStyle(root).color===before.color,'shelf retains wooden appearance '+mode);
      else if(mode!=='system')expect(getComputedStyle(root).backgroundColor===(mode==='light'?'rgb(250, 250, 250)':'rgb(27, 29, 34)'),'local wall palette '+mode);
    }
    const original=view.showCtxMenu;let menu:any[]=[];view.showCtxMenu=(_event:any,items:any[])=>{menu=items;};
    try {
      view.openMoreMenu({x:20,y:20});expect(!menu.some(i=>i.icon==='download-cloud'||i.icon==='upload-cloud'),'Git actions hidden by default');
      plugin.settings.showGitSyncActions=true;view.openMoreMenu({x:20,y:20});expect(menu.filter(i=>i.icon==='download-cloud'||i.icon==='upload-cloud').length===2,'Git switch reveals both actions');plugin.settings.showGitSyncActions=false;
      view.openWallMenu({x:20,y:20});const settingsItem=menu.find(i=>i.icon==='settings');expect(!!settingsItem,'wall context menu links to plugin settings');settingsItem?.onPick();expect(settingsOpened===1,'settings item opens plugin settings');
      button.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));expect(menu.length===1&&menu[0].icon==='settings','appearance context menu offers settings');
    } finally {view.showCtxMenu=original;}
    return {checks:count,fail:errors};
  };
  (window as any).verifyMouseBack=async()=>{
    const errors:string[]=[];let count=0;const expect=(ok:unknown,label:string)=>{count++;if(!ok)errors.push(label);};
    const view:any=views[0],root=view.contentEl as HTMLElement;
    const gesture=async(button=3)=>{root.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,button,pointerType:'mouse'}));for(const type of ['mousedown','mouseup','auxclick'])root.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,button}));await wait(30);};
    const song=engine.state.songId,position=engine.state.positionMs;
    if(config.kind==='player') {
      view.togglePlaylist(false);view.togglePopover(null);view.drawer.open('settings');await gesture();expect(!view.drawer.isOpen()&&!sourceCalls.some(c=>c.kind==='back'),'back first closes player drawer');
      view.togglePlaylist(true);await gesture();expect(!view.playlistOpen&&!sourceCalls.some(c=>c.kind==='back'),'one back closes song list without crossing tabs');
      view.togglePopover('volume');await gesture();expect(view.popover===null&&!sourceCalls.some(c=>c.kind==='back'),'one back closes popover without crossing tabs');
      await gesture();expect(sourceCalls.filter(c=>c.kind==='back').length===1,'release and auxclick produce one cross-tab return');
      await gesture(4);await gesture(0);expect(sourceCalls.filter(c=>c.kind==='back').length===1,'forward and primary mouse buttons do not go back');
    } else {
      view.drawer.open('style');await gesture();expect(!view.drawer.isOpen(),'wall side key closes active drawer');
    }
    expect(engine.state.songId===song&&engine.state.positionMs===position,'mouse back never changes playback');
    return {checks:count,fail:errors};
  };
  (window as any).verifyHiddenZoom=()=>verifyHiddenZoom(views[0].contentEl,scale=>{plugin.settings.zoomScale=scale;for(const view of views)view.syncZoomBox();});
  close=async()=>{for(const view of views)await view.onClose();provider.dispose();};
  for (const button of mount.querySelectorAll<HTMLElement>(".mw-np__ctrl, .mw-mini__button:not([data-action='quality'])")) {
    if (!button.getClientRects().length) continue;
    const svg = button.querySelector("svg"), style = getComputedStyle(button);
    check(!!svg && svg.getBoundingClientRect().width >= 12 * (config.zoom ?? 1), "Playback icon keeps a visible width");
    check(parseFloat(style.paddingLeft) === 0 && parseFloat(style.paddingRight) === 0, "Icon control excludes tablet text-button padding");
  }
  return {checks,fail, colors:config.kind==="wall"?null:{title:getComputedStyle(mount.querySelector(".mw-np__title")!).color,track:getComputedStyle(mount.querySelector(".mw-np__trackName")!).color}};
};
