import { MusicWallView } from '../src/ui/MusicWallView';
import { openShelfMenu } from '../src/ui/ShelfMenu';
import { DEFAULT_SETTINGS } from '../src/types';
import { installDomHelpers, WorkspaceLeaf, MENU_LOG, probeCoverUri } from './obsidian-shim';
installDomHelpers();
const wait = (ms=20) => new Promise(resolve=>setTimeout(resolve,ms));
let dispose = () => {};
let v:any, card:HTMLElement, actions:Record<string,number>, writes=0;
function fixture(layout='shelf', hover=false) {
  dispose(); document.querySelectorAll('.mw-shelf-menu,.modal-container').forEach(el=>el.remove());
  document.getElementById('mount')!.empty(); MENU_LOG.length=0; actions={};writes=0;
  const count=(key:string)=>{actions[key]=(actions[key]||0)+1;};
  const app:any={}; const plugin:any={settings:{...DEFAULT_SETTINGS},firstPlayerView:()=>null,getPlaybackDeps:()=>({playInside:async()=>{count('play');return true;}})};
  v=new MusicWallView(new WorkspaceLeaf(app),plugin);
  const item={albumId:1,meta:{albumId:1,name:'Touch album',artist:'Artist',cover:probeCoverUri('365775'),tracks:[{id:1,name:'Track',duration:1000}],trackCount:1},source:'manual',locked:false,addedAt:''};
  v.data={version:2,name:'Test',style:'vinyl',layout,items:[item,{...item,albumId:2,meta:{...item.meta,albumId:2}}]};
  v.persist=async()=>{writes++;};v.renderEditBar=()=>{};v.syncToolbarState=()=>{};
  Object.defineProperty(v,'touchMode',{get:()=>!hover});
  v.openShelfDetail=()=>count('detail');v.openPlayModal=()=>count('detail');v.closeShelfDetail=()=>count('close');
  v.rateItem=()=>count('rate');v.editItemMeta=()=>count('metadata');v.migrateCard=()=>count('migrate');v.confirmDelete=()=>count('delete');
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>count('copy')}});
  const root=v.contentEl as HTMLElement;root.className='mw-view';root.style.cssText='width:100%;height:100%;';document.getElementById('mount')!.appendChild(root);
  const box=root.createDiv({cls:'mw-zoombox'});const stage=box.createDiv({cls:'mw-stage'});const grid=stage.createDiv({cls:'mw-grid'});
  const section=grid.createDiv({cls:'mw-section'});section.dataset.mwGroup='';
  card=layout==='shelf'?v.buildShelfCard(item):layout==='list'?v.buildListRow(item):v.buildCard(item);
  card.style.cssText='position:absolute;left:40px;top:60px;width:160px;height:160px';section.appendChild(card);
  const other=layout==='shelf'?v.buildShelfCard(v.data.items[1]):layout==='list'?v.buildListRow(v.data.items[1]):v.buildCard(v.data.items[1]);
  other.style.cssText='position:absolute;left:220px;top:60px;width:160px;height:160px';section.appendChild(other);
  dispose=()=>{v?.disposeDrag();v?.closeContext?.();root.remove();};
}
function pointer(type:string,target:EventTarget=card,extra:PointerEventInit={}) { const e=new PointerEvent(type,{bubbles:true,cancelable:true,isPrimary:true,pointerType:'touch',pointerId:7,button:0,clientX:100,clientY:110,...extra});target.dispatchEvent(e);return e; }
function click(target:HTMLElement=card) { target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1})); }
const menu=()=>document.querySelector('.mw-shelf-menu') || MENU_LOG.at(-1);
(window as any).runTouchChecks=async()=>{
 const fail:string[]=[];let checks=0;const check=(ok:unknown,label:string)=>{checks++;if(!ok)fail.push(label);};
 for(const layout of ['grid','list','shelf'])for(const type of ['touch','pen'])for(const hover of [false,true]) {
  fixture(layout,hover);pointer('pointerdown',card,{pointerType:type});await wait(390);
  const first=menu();check(!!first,`${layout}/${type}/${hover}: hold opens menu`);check(!v.editMode&&!v.selectMode&&!v.dragActive&&writes===0,'Browsing hold cannot edit, select, drag or save');
  card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:110}));
  check(menu()===first&&MENU_LOG.length<2,'Native contextmenu cannot reopen a held menu');
  const moved=pointer('pointermove',window,{clientX:102,clientY:111});check(!moved.defaultPrevented,'Menu hold leaves later touches unblocked');
  pointer('pointerup',window);click();check(!actions.detail,'Release click does not open details behind menu');
  pointer('pointerdown');pointer('pointerup',window);click();check(layout==='shelf'&&!hover?card.classList.contains('is-pulled'):actions.detail===1,'Next independent tap is not swallowed');
 }
 for(const cancel of ['move','pointercancel','pointerup','blur','detach']) {
  fixture();pointer('pointerdown');
  if(cancel==='move')pointer('pointermove',window,{clientX:180});
  else if(cancel==='blur')window.dispatchEvent(new Event('blur'));
  else if(cancel==='detach')card.remove();else pointer(cancel,window);
  await wait(390);check(!menu()&&!v.editMode&&!v.dragActive&&writes===0,`${cancel}: no delayed hold action`);
 }
 fixture();pointer('pointerdown');pointer('pointerup',window,{pointerId:8});await wait(390);check(!!menu(),'Unrelated pointer cannot release the active gesture');pointer('pointerup',window);
 fixture('grid');const control=card.querySelector<HTMLButtonElement>('button')!;pointer('pointerdown',control);await wait(390);check(!menu()&&!v.dragActive,'Holding a card action does not arm card drag/menu');pointer('pointerup',window);
 fixture('grid');pointer('pointerdown',card,{pointerType:'mouse'});await wait(420);check(!v.editMode&&!v.dragActive&&!menu(),'Mouse hold no longer enters editing');pointer('pointerup',window,{pointerType:'mouse'});
 pointer('pointerdown',card,{pointerType:'mouse',button:2});card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:110}));check(MENU_LOG.length===1&&!card.draggable,'Mouse right click remains available');
 fixture('grid');v.enterSelectMode(); // Multi-select is still an explicit command, not a hold gesture.
 const selected=v.selectMode;check(selected===true,'Explicit multi-select remains available');v.disposeDrag();
 fixture();v.enterEditMode();writes=0;pointer('pointerdown');await wait(390);check(v.dragActive&&!menu(),'Explicit editing permits touch drag without a menu');
 card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:110}));check(v.dragActive&&!menu(),'Native touch contextmenu cannot interrupt an explicit drag');
 pointer('pointermove',window,{clientX:260});pointer('pointercancel',window,{clientX:260});check(!v.dragActive&&!document.querySelector('.mw-drag-ghost')&&writes===0,'Cancelled drag cleans up without committing a drop');
 pointer('pointerdown');pointer('pointercancel',window);await wait(390);check(!v.dragActive,'Cancelled edit hold never starts dragging later');
 pointer('pointerdown',card,{pointerType:'mouse',button:2});card.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:110}));check(!!menu(),'Explicit editing still permits mouse right-click menus');
 fixture();pointer('pointerdown');v.disposeDrag();await wait(390);check(!menu()&&!v.dragActive,'Unloading cancels pending gestures');
 // All enabled menu actions execute once; no actual files or account APIs are used.
 for(const index of [0,2,3,4,5,6,7]) {
  fixture();v.openCardMenu({x:20,y:20},v.data.items[0]);await wait();const row=document.querySelectorAll<HTMLElement>('.mw-shelf-menu__item')[index];
  if(!row){check(false,'Expected action row '+index);continue;}row.click();row.click();await wait();
  check(!document.querySelector('.mw-shelf-menu'),'Selecting a menu action closes the menu');
  check(index===2?v.editMode&&writes===1:Object.values(actions).reduce((a,b)=>a+b,0)===1,'Enabled menu action executes exactly once: '+index);
 }
 fixture();v.openCardMenu({x:20,y:20},v.data.items[0]);document.querySelectorAll<HTMLElement>('.mw-shelf-menu__item')[1].click();check(!!document.querySelector('.mw-shelf-menu')&&Object.keys(actions).length===0,'Disabled menu item cannot fire');
 let invoked=0;const closeA=openShelfMenu(20,20,[{title:'Old',onClick:()=>invoked++}]);closeA();openShelfMenu(20,20,[{title:'New',onClick:()=>invoked++}]);await wait();
 const active=document.querySelector<HTMLElement>('.mw-shelf-menu')!;active.dispatchEvent(new Event('scroll',{bubbles:false}));check(active.isConnected,'Scrolling inside a menu keeps it open');active.querySelector<HTMLElement>('[role=menuitem]')!.dispatchEvent(new KeyboardEvent('keydown',{bubbles:true,key:'Enter'}));check(invoked===1,'Keyboard activation works after immediate menu replacement');
 fixture();const detail=document.createElement('div');v.buildGatefold(detail,v.data.items[0]);const bar=detail.querySelector<HTMLElement>('.mw-gf__bar')!;v.contentEl.appendChild(bar);bar.classList.add('probe-icons');
 for(const b of bar.querySelectorAll<HTMLElement>('button')) { const svg=b.querySelector('svg')!;check(b.classList.contains('clickable-icon')&&parseFloat(getComputedStyle(b).paddingLeft)===0,'Detail actions exclude tablet text-button padding');check(svg.getBoundingClientRect().width>=19&&svg.getBoundingClientRect().height>=19,'Detail SVG stays visible'); }
 bar.remove();dispose();return {checks,fail};
};
(window as any).prepareNativeMenu=()=>{fixture();v.openCardMenu({x:20,y:20},v.data.items[0]);const row=document.querySelector<HTMLElement>('.mw-shelf-menu__item')!,r=row.getBoundingClientRect();return {x:r.left+20,y:r.top+15};};
(window as any).nativeMenuResult=()=>({actions,dragActive:v.dragActive,editMode:v.editMode,open:!!document.querySelector('.mw-shelf-menu')});
(window as any).prepareNativeIcons=()=>{fixture();const detail=document.createElement('div');v.buildGatefold(detail,v.data.items[0]);const bar=detail.querySelector<HTMLElement>('.mw-gf__bar')!;bar.style.cssText='position:fixed;top:10px;left:10px;width:320px';v.contentEl.appendChild(bar);return [...bar.querySelectorAll<HTMLElement>('button')].map(b=>{const r=b.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};});};
(window as any).nativeIconResult=()=>actions;
(window as any).prepareNativeHold=()=>{fixture();const r=card.getBoundingClientRect();return {x:r.left+50,y:r.top+50};};
(window as any).nativeHoldResult=()=>({editMode:v.editMode,dragActive:v.dragActive,menu:!!document.querySelector('.mw-shelf-menu'),details:actions.detail||0,writes});
(window as any).prepareNativeDrag=()=>{fixture();v.enterEditMode();writes=0;const r=card.getBoundingClientRect();return {x:r.left+50,y:r.top+50};};
