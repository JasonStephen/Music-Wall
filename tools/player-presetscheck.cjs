const assert=require('node:assert/strict'),{buildSync}=require('esbuild');
const code=buildSync({stdin:{contents:'export { DEFAULT_SETTINGS } from "./src/types"; export * from "./src/ui/playerPresets";',resolveDir:process.cwd()},bundle:true,format:'cjs',platform:'node',write:false}).outputFiles[0].text;
const mod={exports:{}};new Function('module','exports',code)(mod,mod.exports);
const {DEFAULT_SETTINGS,resolvePlayerPreset,normalizePlayerPresets,presetForeground}=mod.exports;
const fresh=()=>JSON.parse(JSON.stringify(DEFAULT_SETTINGS));let checks=0;
const check=(ok,label)=>{assert.ok(ok,label);checks++;};
const s=fresh();check(resolvePlayerPreset(s,true).background==='dark','system dark');check(resolvePlayerPreset(s,false).background==='white','system light');
s.libraryAppearance='light';check(resolvePlayerPreset(s,true).background==='white','library day overrides OS night');s.libraryAppearance='dark';check(resolvePlayerPreset(s,false).background==='dark','library night overrides OS day');
s.playerPresetTone='light';check(resolvePlayerPreset(s,true).background==='white','preset explicit light');s.playerPresetTone='dark';check(resolvePlayerPreset(s,false).background==='dark','preset explicit dark');
const before=JSON.stringify([s.playerBackground,s.playerCase,s.playerVinylFinish,s.playerVinylMachine,s.playerCdMachine]);
for(const [group,choices] of Object.entries({vinyl:['classic','white','color'],cd:['classic','color'],cover:['record','full'],machine:['vinyl','colorVinyl','cd','colorCd']}))for(const choice of choices){s.playerPresetGroup=group;s.playerPresetChoices[group]=choice;const p=resolvePlayerPreset(s,true);check(p.machine===(group==='machine'),'machine ownership '+group+choice);check(p.fullCover===(group==='cover'&&choice==='full'),'full cover ownership '+group+choice);}
check(JSON.stringify([s.playerBackground,s.playerCase,s.playerVinylFinish,s.playerVinylMachine,s.playerCdMachine])===before,'custom settings preserved');
s.playerPresetGroup='custom';check(resolvePlayerPreset(s,true)===null,'custom is always available');s.playerExperimental=true;check(resolvePlayerPreset(s,true)===null,'experimental custom');
const bad=fresh();Object.assign(bad,{playerPresetChoices:{vinyl:'bad',cd:'color',cover:'full',machine:'bad'},playerPresetGroup:'bad',playerPresetTone:'bad',playerCustomStyle:'bad',playerColorGlass:'bad'});normalizePlayerPresets(bad);check(bad.playerPresetGroup==='vinyl'&&bad.playerPresetChoices.vinyl==='classic'&&bad.playerPresetChoices.cd==='color'&&bad.playerPresetChoices.cover==='full'&&bad.playerPresetChoices.machine==='vinyl','validate corrupt saved choices');
const restored=JSON.parse(JSON.stringify(s));normalizePlayerPresets(restored);check(restored.playerPresetGroup==='custom'&&restored.playerPresetChoices.cd===s.playerPresetChoices.cd,'round trip persistence');
check(presetForeground('#c2a476')==='#111111'&&presetForeground('#ffffff')==='#111111'&&presetForeground('#000000')==='#ffffff','contrast on solid cover colors');
console.log(checks+' player preset checks passed');
