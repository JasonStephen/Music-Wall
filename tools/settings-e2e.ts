import {MusicWallSettingTab} from '../src/settings';import {DEFAULT_SETTINGS} from '../src/types';import {setLanguage,t} from '../src/i18n';import {installDomHelpers} from './obsidian-shim';installDomHelpers();
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
(window as any).setupSettings=async(config:any)=>{
 setLanguage(config.lang);document.body.className=`theme-${config.theme}`;document.body.style.zoom=String(config.zoom||1);const mount=document.getElementById('mount')!;mount.empty();let used=8*1024*1024,saves=0,trimmed=0;
 const plugin:any={settings:{...DEFAULT_SETTINGS},async saveData(){saves++;},async saveSettings(){},refreshOpenViews(){},audioTransport:{supported:true,async usage(){return used;},async trim(){trimmed++;used=Math.min(used,plugin.settings.audioCacheMB*1024*1024);},async clear(){used=0;}}};
 const tab=new MusicWallSettingTab({} as never,plugin);mount.appendChild(tab.containerEl);tab.display();await wait(20);const rows=tab.containerEl.querySelectorAll<HTMLElement>('.mw-audio-setting'),fail:string[]=[];
 if(rows.length!==4)fail.push('Four audio settings must exist');
 for(const row of rows){row.scrollIntoView();const r=row.getBoundingClientRect();if(r.right>innerWidth+1||row.scrollWidth>row.clientWidth+1)fail.push('Audio setting overflows the pane');for(const input of row.querySelectorAll<HTMLElement>('input,button')){const r=input.getBoundingClientRect();if(r.left<0||r.right>innerWidth+1)fail.push('Audio setting control leaves the viewport');}}
 const fades=rows[0].querySelector<HTMLInputElement>('input')!;fades.value='6';fades.dispatchEvent(new Event('input'));await wait(0);if(plugin.settings.pauseFadeSeconds!==6)fail.push('Fade does not save');
 const capacity=rows[2].querySelector<HTMLInputElement>('input')!;capacity.value='1';capacity.dispatchEvent(new Event('input'));await wait(10);if(plugin.settings.audioCacheMB!==1||trimmed!==1||!rows[3].textContent?.includes('1.0 MB'))fail.push('Cache limit does not trim and refresh usage');
 rows[3].querySelector<HTMLButtonElement>('button')!.click();await wait(10);if(used!==0||!rows[3].textContent?.includes('0.0 MB'))fail.push('Clear cache does not refresh usage');
 if(saves!==2)fail.push('Audio preferences are not persisted');tab.hide();return {checks:rows.length*3+4,fail};
};
