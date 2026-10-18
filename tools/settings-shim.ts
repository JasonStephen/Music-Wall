export * from './obsidian-shim';
export class App {}
export class PluginSettingTab { containerEl=document.createElement('div'); constructor(..._args: any[]){} }
export class Setting {
 settingEl:HTMLElement;info:HTMLElement;control:HTMLElement;name:HTMLElement;desc:HTMLElement;
 constructor(parent:HTMLElement){this.settingEl=parent.createDiv({cls:'setting-item'});this.info=this.settingEl.createDiv({cls:'setting-item-info'});this.name=this.info.createDiv({cls:'setting-item-name'});this.desc=this.info.createDiv({cls:'setting-item-description'});this.control=this.settingEl.createDiv({cls:'setting-item-control'});}
 setName(value:string){this.name.textContent=value;return this;}setDesc(value:string){this.desc.textContent=value;return this;}
 addDropdown(callback:any){const el=this.control.createEl('select');const c={addOption:(value:string,label:string)=>{el.createEl('option',{text:label,attr:{value}});return c;},setValue:(v:string)=>{el.value=v;return c;},onChange:(fn:any)=>{el.onchange=()=>fn(el.value);return c;}};callback(c);return this;}
 addText(callback:any){const el=this.control.createEl('input');const c={inputEl:el,setValue:(v:string)=>{el.value=v;return c;},setPlaceholder:(v:string)=>{el.placeholder=v;return c;},onChange:(fn:any)=>{el.oninput=()=>fn(el.value);return c;}};callback(c);return this;}
 addSlider(callback:any){const el=this.control.createEl('input',{attr:{type:'range'}});const c={setLimits:(min:number,max:number,step:number)=>{el.min=String(min);el.max=String(max);el.step=String(step);return c;},setValue:(v:number)=>{el.value=String(v);return c;},setDynamicTooltip:()=>c,onChange:(fn:any)=>{el.oninput=()=>fn(Number(el.value));return c;}};callback(c);return this;}
 addButton(callback:any){const el=this.control.createEl('button');const c={setButtonText:(v:string)=>{el.textContent=v;return c;},setDisabled:(v:boolean)=>{el.disabled=v;return c;},setTooltip:(v:string)=>{el.title=v;return c;},onClick:(fn:any)=>{el.onclick=fn;return c;}};callback(c);return this;}
 addToggle(callback:any){const el=this.control.createEl('input',{attr:{type:'checkbox'}});const c={setValue:(v:boolean)=>{el.checked=v;return c;},onChange:(fn:any)=>{el.onchange=()=>fn(el.checked);return c;}};callback(c);return this;}
}
