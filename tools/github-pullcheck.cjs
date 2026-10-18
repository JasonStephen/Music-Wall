// Real mobile modules, in-memory vault and public API fixtures. No Git or Node in the bundle.
const assert=require('node:assert/strict'),path=require('node:path'),{createHash}=require('node:crypto');
const {buildSync}=require('esbuild');
class TFile {constructor(path){this.path=path;}}
class TFolder {constructor(path){this.path=path;}}
const built=buildSync({stdin:{contents:"export * from './src/core/githubWallPull';export * from './src/core/mobileVaultWallSync';export * from './src/core/wallSync';export * from './src/i18n';",resolveDir:path.resolve(__dirname,'..'),loader:'ts'},bundle:true,platform:'browser',format:'cjs',write:false,external:['obsidian']});
const loaded={exports:{}};
new Function('module','exports','require','setTimeout','clearTimeout',built.outputFiles[0].text)(loaded,loaded.exports,name=>{assert.equal(name,'obsidian','Mobile bundle cannot require Node');return {TFile,TFolder};},(fn,ms)=>setTimeout(fn,ms===15000?50:ms),clearTimeout);
const api=loaded.exports;api.setLanguage('zh-CN');
const wall=name=>JSON.stringify({version:2,name,style:'vinyl',items:[]});
const ROOT='a'.repeat(40),SUB='b'.repeat(40),COMMIT='c'.repeat(40),BASE='https://api.github.com/repos/owner/walls';
const config={repoUrl:'https://github.com/owner/walls.git',branch:'',localDirectory:'MusicWall',remoteDirectory:'walls'};
const backupRoot='.obsidian/plugins/music-wall/wall-sync';
const json=(body,status=200)=>({status,text:JSON.stringify(body)});
function fixture(files={'更新.mw':wall('new'),'Sub/new.mw':wall('nested'),'unchecked.mw':wall('unchecked')}){
 const calls=[],blobs=new Map();
 const entries=Object.entries(files).map(([path,content])=>{const bytes=Buffer.from(content),sha=createHash('sha1').update('blob '+bytes.length+'\0').update(bytes).digest('hex');blobs.set(sha,{sha,size:bytes.length,encoding:'base64',content:bytes.toString('base64')});return {path,sha,size:bytes.length,type:'blob',mode:'100644'};});
 const state={commit:COMMIT,private:false,entries,blobs,calls,override:null};
 state.request=async url=>{
  calls.push(url);assert.ok(url.startsWith(BASE));
  const override=await state.override?.(url);if(override)return override;
  if(url===BASE)return json({private:state.private,default_branch:'main'});
  if(url===BASE+'/commits/main')return json({sha:state.commit,commit:{tree:{sha:ROOT}}});
  if(url===BASE+'/git/trees/'+ROOT)return json({sha:ROOT,truncated:false,tree:[{path:'walls',type:'tree',mode:'040000',sha:SUB}]});
  if(url===BASE+'/git/trees/'+SUB+'?recursive=1')return json({sha:SUB,truncated:false,tree:state.entries});
  const sha=url.split('/git/blobs/')[1];if(blobs.has(sha))return json(blobs.get(sha));
  return json({},404);
 };
 state.reader=new api.GitHubWallReader(state.request);return state;
}
class Vault {
 constructor(files={}){
  this.files=new Map(Object.entries(files));this.folders=new Set();this.writes=0;this.failBackup=false;
  for(const p of this.files.keys()){const parts=p.split('/');for(let n=1;n<parts.length;n++)this.folders.add(parts.slice(0,n).join('/'));}
  this.adapter={exists:async p=>this.files.has(p)||this.folders.has(p),mkdir:async p=>{if(this.files.has(p))throw Error('file blocks folder');this.folders.add(p);},write:async(p,text)=>{if(this.failBackup)throw Error('no space');this.files.set(p,text);},read:async p=>this.files.get(p)};
 }
 getFiles(){return [...this.files.keys()].map(p=>new TFile(p));}
 getAbstractFileByPath(p){return this.files.has(p)?new TFile(p):this.folders.has(p)?new TFolder(p):null;}
 async read(file){return this.files.get(file.path);}
 async createFolder(p){if(this.files.has(p))throw Error('file blocks folder');this.folders.add(p);}
 async create(p,text){if(this.files.has(p)||this.folders.has(p))throw Error('already exists');this.files.set(p,text);++this.writes;}
 async process(file,fn){this.files.set(file.path,fn(this.files.get(file.path)));++this.writes;this.afterWrite?.();}
}
const preview=(vault,f,settings=config,signal)=>api.prepareMobileVaultPull(vault,f.reader,settings,backupRoot,signal);
let passed=0;const test=async(name,fn)=>{await fn();++passed;console.log('PASS '+name);};
(async()=>{
 await test('Mobile reader rejects credential-bearing, non-GitHub and ambiguous URLs',async()=>{
  assert.equal(api.publicGitHubRepo('https://github.com/owner/walls.git/'),'owner/walls');
  for(const url of ['http://github.com/owner/walls','https://github.com.evil.test/owner/walls','https://user:secret@github.com/owner/walls','https://github.com/owner/walls?token=secret','https://github.com/owner/walls/tree/main','file:///tmp/repo','git@github.com:owner/walls.git'])assert.throws(()=>api.publicGitHubRepo(url));
 });
 await test('Read-only preview resolves default branch, keeps Unicode paths and verifies blob hashes',async()=>{
  const f=fixture(),vault=new Vault({'MusicWall/更新.mw':wall('old'),'MusicWall/local-only.mw':wall('local'),'.obsidian/plugins/music-wall/data.json':'PRIVATE','Notes.md':'keep'});
  const p=await preview(vault,f);assert.equal(p.branch,'main');assert.equal(p.commit,COMMIT);assert.equal(vault.writes,0);
  assert.equal(p.plan.rows.find(r=>r.path==='更新.mw').status,'changed');assert.equal(p.plan.rows.find(r=>r.path==='local-only.mw').status,'kept');
  assert.equal(api.defaultSyncSelection(p.plan).size,3);assert.ok(!p.plan.rows.some(r=>r.path.includes('.obsidian')||r.path==='Notes.md'));
 });
 await test('Selective pull backs up originals, creates folders and preserves unchecked/local-only files',async()=>{
  const f=fixture(),old=wall('old'),vault=new Vault({'MusicWall/更新.mw':old,'MusicWall/local-only.mw':wall('local'),'.obsidian/plugins/music-wall/data.json':'PRIVATE'});
  const p=await preview(vault,f);assert.equal(await p.apply(new Set(['更新.mw','Sub/new.mw'])),2);
  assert.equal(vault.files.get('MusicWall/更新.mw'),wall('new'));assert.equal(vault.files.get('MusicWall/Sub/new.mw'),wall('nested'));
  assert.ok(vault.folders.has('MusicWall/Sub'));assert.equal(vault.files.get('MusicWall/local-only.mw'),wall('local'));assert.ok(!vault.files.has('MusicWall/unchecked.mw'));
  assert.equal(vault.files.get('.obsidian/plugins/music-wall/data.json'),'PRIVATE');
  assert.ok([...vault.files].some(([p,text])=>p.startsWith(backupRoot+'/backups/')&&p.endsWith('/MusicWall/更新.mw')&&text===old));
  await assert.rejects(()=>p.apply(new Set(['更新.mw'])));
 });
 await test('Unchanged immutable blobs are cached while branch freshness is always checked',async()=>{
  const f=fixture(),v=new Vault();await preview(v,f);const before=f.calls.filter(u=>u.includes('/git/blobs/')).length;
  const p=await preview(v,f);assert.equal(f.calls.filter(u=>u.includes('/git/blobs/')).length,before);
  assert.equal(f.calls.filter(u=>u.endsWith('/commits/main')).length,2);await p.apply(new Set(['更新.mw']));assert.equal(f.calls.filter(u=>u.endsWith('/commits/main')).length,3);
 });
 await test('Remote branch changes abort before backups or local writes',async()=>{
  const f=fixture(),v=new Vault({'MusicWall/更新.mw':wall('old')}),p=await preview(v,f);f.commit='d'.repeat(40);
  await assert.rejects(()=>p.apply(new Set(['更新.mw'])),/远端/);assert.equal(v.writes,0);assert.ok(![...v.files.keys()].some(p=>p.includes('/backups/')));
 });
 await test('Local changes after preview cannot be overwritten',async()=>{
  const f=fixture(),v=new Vault({'MusicWall/更新.mw':wall('old')}),p=await preview(v,f);v.files.set('MusicWall/更新.mw',wall('edited'));
  await assert.rejects(()=>p.apply(new Set(['更新.mw'])),/预览后/);assert.equal(v.writes,0);assert.equal(v.files.get('MusicWall/更新.mw'),wall('edited'));
 });
 await test('Backup failure stops overwrite and preserves original wall',async()=>{
  const f=fixture(),v=new Vault({'MusicWall/更新.mw':wall('old')}),p=await preview(v,f);v.failBackup=true;
  await assert.rejects(()=>p.apply(new Set(['更新.mw'])));assert.equal(v.writes,0);assert.equal(v.files.get('MusicWall/更新.mw'),wall('old'));
 });
 await test('Cancelled preview and confirmation never modify the vault',async()=>{
  const f=fixture(),v=new Vault(),abort=new AbortController();abort.abort();await assert.rejects(()=>preview(v,f,config,abort.signal),/取消/);assert.equal(f.calls.length,0);
  const controller=new AbortController(),p=await preview(v,f,config,controller.signal);controller.abort();await assert.rejects(()=>p.apply(new Set(['更新.mw'])),/取消/);assert.equal(v.writes,0);
 });
 await test('Closing during a native request ignores its late response and caches nothing',async()=>{
  const abort=new AbortController();let finish;const reader=new api.GitHubWallReader(()=>new Promise(resolve=>{finish=resolve;}));
  const request=reader.snapshot(config.repoUrl,'','walls',abort.signal);abort.abort();await assert.rejects(request,/取消/);
  finish(json({private:false,default_branch:'main'}));await new Promise(r=>setImmediate(r));assert.equal(reader.blobs.size,0);
 });
 await test('Cancellation during apply stops subsequent files and leaves backups available',async()=>{
  const f=fixture(),v=new Vault({'MusicWall/更新.mw':wall('old')}),abort=new AbortController(),p=await preview(v,f);
  v.afterWrite=()=>abort.abort();await assert.rejects(()=>p.apply(new Set(['更新.mw','Sub/new.mw']),abort.signal),/已写入 1/);
  assert.equal(v.writes,1);assert.ok(!v.files.has('MusicWall/Sub/new.mw'));assert.ok([...v.files.keys()].some(p=>p.includes('/backups/')));
 });
 await test('Invalid wall JSON is shown for review but cannot be applied',async()=>{
  const f=fixture({'bad.mw':'not JSON','ok.mw':wall('ok')}),v=new Vault(),p=await preview(v,f);
  assert.equal(p.plan.rows.find(r=>r.path==='bad.mw').status,'invalid');assert.ok(!api.defaultSyncSelection(p.plan).has('bad.mw'));
  assert.equal(await p.apply(new Set(['bad.mw'])),0);assert.equal(v.writes,0);
 });
 await test('Truncated trees fall back to complete directory traversal',async()=>{
  const f=fixture({'root.mw':wall('root'),'Nested/child.mw':wall('child')}),nested='e'.repeat(40);let fallback=false;
  f.override=async url=>{
   if(url===BASE+'/git/trees/'+SUB+'?recursive=1')return json({sha:SUB,truncated:true,tree:[]});
   if(url===BASE+'/git/trees/'+SUB){fallback=true;return json({sha:SUB,truncated:false,tree:[f.entries[0],{path:'Nested',type:'tree',mode:'040000',sha:nested}]});}
   if(url===BASE+'/git/trees/'+nested)return json({sha:nested,truncated:false,tree:[{...f.entries[1],path:'child.mw'}]});
  };
  const p=await preview(new Vault(),f);assert.equal(fallback,true);assert.equal(p.plan.rows.length,2);
 });
 await test('Hidden and non-wall files are excluded; symlinks, traversal and case collisions are rejected',async()=>{
  for(const entry of [{path:'escape/../bad.mw'}, {path:'/bad.mw'}, {path:'link.mw',mode:'120000'}]){
   const f=fixture({'safe.mw':wall('safe')});f.entries.push({...f.entries[0],...entry});await assert.rejects(()=>preview(new Vault(),f));
  }
  const f=fixture({'same.mw':wall('a'),'Same.mw':wall('b')});await assert.rejects(()=>preview(new Vault(),f),/大小写/);
  const excluded=fixture({'ok.mw':wall('ok')});excluded.entries.push({...excluded.entries[0],path:'.obsidian/secret.mw'},{...excluded.entries[0],path:'data.json'});
  assert.equal((await preview(new Vault(),excluded)).plan.rows.length,1);
 });
 await test('Corrupted blob bytes and wrong object identities cannot enter a preview',async()=>{
  for(const mutate of [blob=>{blob.content=Buffer.from('wrong').toString('base64');},blob=>{blob.sha='f'.repeat(40);},blob=>{blob.encoding='utf-8';}]){
   const f=fixture({'a.mw':wall('a')});mutate([...f.blobs.values()][0]);await assert.rejects(()=>preview(new Vault(),f),/完整性/);
  }
 });
 await test('Public access, limits, malformed data and transport errors are safe and actionable',async()=>{
  const privateRepo=fixture();privateRepo.private=true;await assert.rejects(()=>preview(new Vault(),privateRepo),/公开/);
  for(const [response,pattern] of [[json({},404),/公开/],[json({},403),/限额/],[json({},429),/限额/],[json({},500),/500/],[{status:200,text:'PRIVATE_SECRET'},/完整性/]]){
   const reader=new api.GitHubWallReader(async()=>response);await assert.rejects(()=>reader.snapshot(config.repoUrl,'',''),error=>pattern.test(error.message)&&!error.message.includes('PRIVATE_SECRET'));
  }
  const reader=new api.GitHubWallReader(async()=>{throw Error('PRIVATE_SECRET url');});await assert.rejects(()=>reader.snapshot(config.repoUrl,'',''),error=>/网络/.test(error.message)&&!error.message.includes('PRIVATE_SECRET'));
 });
 await test('Timeouts are bounded and file-size limits fail before downloads',async()=>{
  const reader=new api.GitHubWallReader(()=>new Promise(()=>{}));await assert.rejects(()=>reader.snapshot(config.repoUrl,'',''),/超时/);
  const f=fixture();f.entries[0].size=6*1024*1024;await assert.rejects(()=>preview(new Vault(),f),/过大/);assert.ok(!f.calls.some(u=>u.includes('/git/blobs/')));
 });
 await test('Local file/folder conflicts, unsafe backup paths and invalid branches are rejected',async()=>{
  await assert.rejects(()=>preview(new Vault({'MusicWall':'note'}),fixture()));
  await assert.rejects(()=>api.prepareMobileVaultPull(new Vault(),fixture().reader,config,'../backup'));
  for(const branch of ['../main','a b','a.lock','a//b','a@{b'])await assert.rejects(()=>preview(new Vault(),fixture(),{...config,branch}));
 });
 console.log(`\n${passed} mobile GitHub pull checks passed`);
})().catch(error=>{console.error(error);process.exitCode=1;});
