/* Uses the installed Obsidian/Electron runtime in an isolated, hidden test app. */
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process'),{build}=require('esbuild');
const install=process.env.MW_OBSIDIAN_DIR||'C:\\Program Files\\Obsidian';
async function main(){
 if(!process.env.MW_PROBE_DATA)throw new Error('Set MW_PROBE_DATA to the plugin data.json path before running this check.');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mw-obsidian-runtime-'));
 let child;
 try{
  async function link(source,target){const stat=await fs.stat(source);if(stat.isDirectory()){await fs.mkdir(target,{recursive:true});for(const name of await fs.readdir(source))await link(path.join(source,name),path.join(target,name));}else await fs.copyFile(source,target);}
  for(const item of await fs.readdir(install,{withFileTypes:true}))if(item.name!=='resources'&&!/uninstall/i.test(item.name))await link(path.join(install,item.name),path.join(root,item.name));
  const app=path.join(root,'resources','app');await fs.mkdir(path.join(app,'node_modules','obsidian'),{recursive:true});
  await fs.writeFile(path.join(app,'package.json'),JSON.stringify({name:'music-wall-runtime-check',version:'1.0.0',main:'main.cjs'}));
  await fs.writeFile(path.join(app,'main.cjs'),`const {app,BrowserWindow,ipcMain,protocol}=require('electron');const path=require('path'),fs=require('fs');protocol.registerSchemesAsPrivileged([{scheme:'app',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,stream:true}}]);app.setPath('userData',path.join(__dirname,'profile'));app.commandLine.appendSwitch('mute-audio');app.commandLine.appendSwitch('disable-background-timer-throttling');app.whenReady().then(()=>{protocol.handle('app',req=>new URL(req.url).pathname==='/index.html'?new Response(fs.readFileSync(path.join(__dirname,'index.html')),{headers:{'Content-Type':'text/html'}}):new Response('',{status:404}));const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false,autoplayPolicy:'no-user-gesture-required'}});let downloads=0;win.webContents.session.on('will-download',()=>downloads++);ipcMain.on('result',(_e,result)=>{result.downloads=downloads;result.ok=result.ok&&!downloads;console.log(JSON.stringify(result));app.exit(result.ok?0:1);});win.loadURL('app://obsidian.md/index.html');});setTimeout(()=>app.exit(2),110000);`);
  await fs.writeFile(path.join(app,'node_modules','obsidian','index.js'),`module.exports={Notice:class {},requestUrl:req=>window.probeRequest(req)};`);
  const built=await build({stdin:{contents:`export {AudioTransport} from './src/core/audioTransport';export {InternalPlayer} from './src/core/internalPlayer';export {SongSourceResolver} from './src/core/audioSource';export {CoverBackdrop} from './src/ui/CoverBackdrop';export {installDomHelpers,probeCoverUri} from './tools/obsidian-shim';`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});
  await fs.writeFile(path.join(app,'api.cjs'),built.outputFiles[0].text);
  await fs.copyFile(path.join(__dirname,'runtime-buffercheck-renderer.cjs'),path.join(app,'probe.cjs'));
  await fs.writeFile(path.join(app,'index.html'),`<!doctype html><meta http-equiv="Content-Security-Policy" content="style-src 'unsafe-inline' 'self' https://fonts.googleapis.com"><style>.mw-player__backdrop{position:absolute;inset:0;opacity:0;transition:opacity 650ms ease}#cover{position:relative;width:100px;height:100px}</style><div id="cover"></div><script>require(${JSON.stringify(path.join(app,'probe.cjs'))})</script>`);
  const result=await new Promise((resolve,reject)=>{
   child=spawn(path.join(root,'Obsidian.exe'),[],{windowsHide:true,env:{...process.env,MW_HIRES_FIXTURE:process.env.MW_HIRES_FIXTURE||path.resolve(__dirname,'shots','hires24-192.flac')},stdio:['ignore','pipe','pipe']});
   let output='',errors='';child.stdout.on('data',data=>{output+=data;});child.stderr.on('data',data=>{errors+=data;});child.on('error',reject);child.on('exit',code=>resolve({code,output,errors}));
  });
  console.log(result.output.trim());if(result.code){console.log('Runtime check exit '+result.code);console.log(result.errors.split('\n').filter(x=>/Error|error|failed/.test(x)).slice(-4).join('\n'));process.exitCode=1;}
 }finally{
  if(child&&child.exitCode===null)child.kill();
  const absolute=path.resolve(root);if(absolute.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(absolute).startsWith('mw-obsidian-runtime-'))try{await fs.rm(absolute,{recursive:true,force:true,maxRetries:8,retryDelay:150});}catch{console.log('Temporary runtime retained for cleanup');}
 }
}
main().catch(error=>{console.log('Runtime launcher: '+error.message);process.exitCode=1;});
