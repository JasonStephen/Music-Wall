// Real Git integration against disposable local bare repositories. No network.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), cp = require('node:child_process');
const built = require('esbuild').buildSync({stdin:{contents:"export * from './src/core/git';export * from './src/core/wallSync';export * from './src/core/vaultWallSync';",resolveDir:path.resolve(__dirname,'..'),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});
class TFile { constructor(p){this.path=p;this.extension=p.split('.').pop();} }
class TFolder { constructor(p){this.path=p;} }
const loaded={exports:{}};new Function('module','exports','require',built.outputFiles[0].text)(loaded,loaded.exports,n=>n==='obsidian'?{TFile,TFolder}:require(n));
const {prepareGitSync,pushGitWalls,assertRemoteUnchanged,buildSyncPlan,defaultSyncSelection,selectedSyncChanges,prepareVaultSync,applyWallPull,changedLineSets,syncPath}=loaded.exports;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'mw-git-sync-')), cache=path.join(temp,'cache');
const git=(cwd,...args)=>cp.execFileSync('git',args,{cwd,windowsHide:true,encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'test@example.test',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'test@example.test'}}).trim();
const wall=(name,ids=[1])=>JSON.stringify({version:2,name,style:'vinyl',items:ids.map(id=>({albumId:id,source:'manual',locked:false,addedAt:'2026-10-18',meta:{albumId:id,name:'Album '+id,artist:'Test',cover:'',trackCount:0}}))},null,2);
const file=(p,name=p)=>({path:p,content:wall(name)});
let passed=0;const test=async(label,fn)=>{await fn();console.log('PASS '+label);passed++;};
const repo=name=>{const dir=path.join(temp,name+'.git');git(temp,'init','--bare','--initial-branch=main',dir);return dir;};
const write=(base,p,text)=>{const target=path.join(base,p);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,text);};
class Vault {
 constructor(root){this.adapter={basePath:root};this.root=root;fs.mkdirSync(root,{recursive:true});}
 getFiles(){const out=[];const walk=(dir,prefix='')=>{for(const e of fs.readdirSync(dir,{withFileTypes:true})){if(e.name.startsWith('.'))continue;const p=prefix+e.name;if(e.isDirectory())walk(path.join(dir,e.name),p+'/');else out.push(new TFile(p));}};walk(this.root);return out;}
 getAbstractFileByPath(p){const full=path.join(this.root,p);if(!fs.existsSync(full))return null;return fs.statSync(full).isDirectory()?new TFolder(p):new TFile(p);}
 async read(f){return fs.readFileSync(path.join(this.root,f.path),'utf8');}
 async createFolder(p){fs.mkdirSync(path.join(this.root,p));}
 async create(p,text){fs.writeFileSync(path.join(this.root,p),text,{flag:'wx'});return new TFile(p);}
 async process(f,fn){fs.writeFileSync(path.join(this.root,f.path),fn(await this.read(f)));}
}
(async()=>{
 try {
  const remote=repo('remote');
  await test('Empty repositories accept a first selected push with nested Unicode paths',async()=>{
   const snap=await prepareGitSync(remote,cache,'','');assert.equal(snap.commit,null);assert.equal(snap.branch,'main');
   await pushGitWalls(snap,[file('MusicWall/电影 配乐/夜.mw'),file('Keep.mw')]);
   assert.deepEqual(git(remote,'ls-tree','-r','--name-only','main').split('\n').length,2);
  });
  await test('Push defaults select only .mw folders; pull defaults select all eligible remote files',async()=>{
   const files=[file('MusicWall/a.mw'),file('MusicWall/Sub/b.mw'),file('root.mw')];
   const push=buildSyncPlan('push',files,[file('remote-only.mw')]);
   assert.deepEqual([...defaultSyncSelection(push)],['MusicWall/a.mw','MusicWall/Sub/b.mw']);
   assert.equal(defaultSyncSelection(push,true).size,3);
   assert.equal(defaultSyncSelection(buildSyncPlan('pull',[],files)).size,3);
  });
  await test('Selective pushes preserve remote-only walls, non-wall files and unrelated paths',async()=>{
   const work=path.join(temp,'seed');git(temp,'clone',remote,work);write(work,'README.md','keep this');write(work,'unrelated/data.json','private remote fixture');git(work,'add','.');git(work,'commit','-m','seed unrelated');git(work,'push','origin','main');
   const snap=await prepareGitSync(remote,cache,'','');const keep=git(remote,'show','main:Keep.mw');
   await pushGitWalls(snap,[file('MusicWall/a.mw')]);
   assert.equal(git(remote,'show','main:README.md'),'keep this');assert.equal(git(remote,'show','main:Keep.mw'),keep);assert.equal(git(remote,'show','main:unrelated/data.json'),'private remote fixture');
   assert.equal(git(remote,'rev-parse','main^'),snap.commit);
  });
  await test('Remote subfolders map relative paths and changing repository URLs uses separate caches',async()=>{
   const other=repo('other');const a=await prepareGitSync(remote,cache,'main','Shared');await pushGitWalls(a,[file('nested/a.mw')]);
   const b=await prepareGitSync(other,cache,'main','');assert.notEqual(a.cacheDir,b.cacheDir);assert.equal(b.files.length,0);
   const c=await prepareGitSync(remote,cache,'main','Shared');assert.deepEqual(c.files.map(f=>f.path),['nested/a.mw']);
  });
  await test('Concurrent remote changes invalidate previews and never overwrite newer commits',async()=>{
   const a=await prepareGitSync(remote,cache,'main',''),b=await prepareGitSync(remote,cache,'main','');
   await pushGitWalls(b,[file('concurrent.mw')]);const head=git(remote,'rev-parse','main');
   await assert.rejects(()=>pushGitWalls(a,[file('stale.mw')]));await assert.rejects(()=>assertRemoteUnchanged(a));assert.equal(git(remote,'rev-parse','main'),head);
  });
  await test('An identical push produces no empty commit',async()=>{
   const snap=await prepareGitSync(remote,cache,'main','');const head=snap.commit;assert.equal(await pushGitWalls(snap,[snap.files[0]]),null);assert.equal(git(remote,'rev-parse','main'),head);
  });
  await test('Account authentication reaches preview, fetch, freshness checks and push without persisting config',async()=>{
   const calls=[];
   const auth=async url=>{calls.push(url);return ['-c','credential.username=fixture-account'];};
   const snap=await prepareGitSync(remote,cache,'main','',auth);
   assert.equal(calls.length,2);assert.equal(snap.authentication,auth);
   await pushGitWalls(snap,[file('authenticated.mw')]);
   assert.equal(calls.length,4);assert.ok(calls.every(url=>url===remote));
   assert.ok(!fs.readFileSync(path.join(snap.cacheDir,'config'),'utf8').includes('fixture-account'));
   let changed=false;
   const stale=await prepareGitSync(remote,cache,'main','',async()=>{if(changed)throw Error('account changed');return [];});
   changed=true;
   await assert.rejects(()=>pushGitWalls(stale,[file('wrong-account.mw')]),/account changed/);
   assert.ok(!git(remote,'ls-tree','-r','--name-only','main').includes('wrong-account.mw'));
  });
  await test('Simultaneous pushes use a lease so exactly one snapshot can win',async()=>{
   const snap=await prepareGitSync(remote,cache,'main','');
   const results=await Promise.allSettled([pushGitWalls(snap,[file('race-a.mw')]),pushGitWalls(snap,[file('race-b.mw')])]);
   assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.filter(r=>r.status==='rejected').length,1);assert.equal(git(remote,'rev-parse','main^'),snap.commit);
  });
  await test('The remote default branch is resolved again instead of reusing an old checkout',async()=>{
   git(remote,'branch','next','main');git(remote,'symbolic-ref','HEAD','refs/heads/next');const snap=await prepareGitSync(remote,cache,'','');assert.equal(snap.branch,'next');git(remote,'symbolic-ref','HEAD','refs/heads/main');
   await assert.rejects(()=>prepareGitSync(remote,cache,'missing',''));
  });
  await test('Pull previews retain directory structure and preserve unchecked and local-only files',async()=>{
   const vault=new Vault(path.join(temp,'vault'));write(vault.root,'MusicWall/local-only.mw',wall('local'));write(vault.root,'MusicWall/电影 配乐/夜.mw',wall('old'));
   const preview=await prepareVaultSync(vault,cache,{repoUrl:remote,branch:'main',localDirectory:'',remoteDirectory:''},'pull');
   const wanted=new Set(['MusicWall/电影 配乐/夜.mw']);assert.equal(await preview.apply(wanted),1);
   assert.equal(await vault.read(new TFile('MusicWall/电影 配乐/夜.mw')),wall('MusicWall/电影 配乐/夜.mw'));
   assert.equal(await vault.read(new TFile('MusicWall/local-only.mw')),wall('local'));assert.equal(vault.getAbstractFileByPath('Keep.mw'),null);
   const backups=[];const walk=d=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);e.isDirectory()?walk(p):backups.push(fs.readFileSync(p,'utf8'));}};walk(path.join(cache,'backups'));assert.ok(backups.includes(wall('old')));
  });
  await test('Pull creates missing local subfolders and maps a chosen remote directory without flattening',async()=>{
   const vault=new Vault(path.join(temp,'mapped'));const preview=await prepareVaultSync(vault,cache,{repoUrl:remote,branch:'main',localDirectory:'Collections',remoteDirectory:'Shared'},'pull');
   assert.equal(await preview.apply(defaultSyncSelection(preview.plan)),1);assert.ok(vault.getAbstractFileByPath('Collections/nested/a.mw'));assert.equal(vault.getAbstractFileByPath('a.mw'),null);
  });
  await test('Local edits after preview abort both push and pull before writing',async()=>{
   const vault=new Vault(path.join(temp,'stale-local'));write(vault.root,'Keep.mw',wall('initial'));
   for(const direction of ['push','pull']){const preview=await prepareVaultSync(vault,cache,{repoUrl:remote,branch:'main',localDirectory:'',remoteDirectory:''},direction);write(vault.root,'Keep.mw',wall('edited '+direction));await assert.rejects(()=>preview.apply(new Set(['Keep.mw'])));assert.equal(await vault.read(new TFile('Keep.mw')),wall('edited '+direction));}
  });
  await test('Vault scans exclude plugin credentials, notes and invalid wall sources',async()=>{
   const vault=new Vault(path.join(temp,'selection'));write(vault.root,'.obsidian/plugins/music-wall/data.json','secret');write(vault.root,'.obsidian/hidden.mw',wall('hidden'));write(vault.root,'MusicWall/a.mw',wall('a'));write(vault.root,'notes.md','note');write(vault.root,'bad.mw','invalid');
   const preview=await prepareVaultSync(vault,cache,{repoUrl:remote,branch:'main',localDirectory:'',remoteDirectory:''},'push');
   assert.equal(preview.plan.rows.find(r=>r.path==='bad.mw').status,'invalid');assert.ok(!preview.plan.rows.some(r=>r.path.includes('.obsidian')||r.path==='notes.md'));
   await preview.apply(new Set(['MusicWall/a.mw','bad.mw','.obsidian/hidden.mw']));assert.ok(!git(remote,'ls-tree','-r','--name-only','main').includes('bad.mw'));
  });
  await test('Traversal, hidden folders, absolute paths and case collisions are rejected',async()=>{
   for(const p of ['../outside','.obsidian','C:/vault','/absolute','a/../b','dir//file','dir/con.mw'])assert.throws(()=>syncPath(p));
   assert.throws(()=>buildSyncPlan('pull',[],[file('A.mw'),file('a.mw')]));
   await assert.rejects(()=>prepareGitSync(remote,cache,'','../outside'));
  });
  await test('A selected path cannot replace an unrelated remote file or delete a directory',async()=>{
   const work=path.join(temp,'collision-seed');git(temp,'clone',remote,work);write(work,'occupied','preserve');write(work,'directory.mw/child.txt','preserve child');git(work,'add','.');git(work,'commit','-m','collision fixtures');git(work,'push','origin','main');
   const snap=await prepareGitSync(remote,cache,'main',''),head=snap.commit;
   await assert.rejects(()=>pushGitWalls(snap,[file('occupied/wall.mw')]));await assert.rejects(()=>pushGitWalls(snap,[file('directory.mw')]));assert.equal(git(remote,'rev-parse','main'),head);
  });
  await test('Pull rechecks the remote snapshot before applying any selected file',async()=>{
   const vault=new Vault(path.join(temp,'remote-stale-vault'));const preview=await prepareVaultSync(vault,cache,{repoUrl:remote,branch:'main',localDirectory:'',remoteDirectory:''},'pull');
   const snap=await prepareGitSync(remote,cache,'main','');await pushGitWalls(snap,[file('new-remote-change.mw')]);
   await assert.rejects(()=>preview.apply(new Set(['Keep.mw'])));assert.equal(vault.getFiles().length,0);
  });
  await test('A failed pull reports completed files, keeps backups and stops subsequent writes',async()=>{
   const a=file('a.mw','old'),b=file('b.mw','old'),c=file('c.mw','old'), plan=buildSyncPlan('pull',[a,b,c],[file('a.mw','new'),file('b.mw','new'),file('c.mw','new')]);const saved=[],writes=[];
   await assert.rejects(()=>applyWallPull(plan,new Set(['a.mw','b.mw','c.mw']),{read:async p=>wall('old'),backup:async files=>saved.push(...files),write:async p=>{if(p==='b.mw')throw Error('disk');writes.push(p);}}),/1/);assert.equal(saved.length,3);assert.deepEqual(writes,['a.mw']);
  });
  await test('Diff highlighting marks insertions while preserving matching lines',async()=>{
   const [a,b]=changedLineSets('a\nb\nc','a\nx\nb\nc');assert.equal(a.size,0);assert.deepEqual([...b],[1]);
  });
  console.log(`${passed} Git sync checks passed`);
 } finally {
  const resolved=path.resolve(temp),tempRoot=path.resolve(os.tmpdir())+path.sep;
  if(resolved.startsWith(tempRoot)&&path.basename(resolved).startsWith('mw-git-sync-'))fs.rmSync(resolved,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
