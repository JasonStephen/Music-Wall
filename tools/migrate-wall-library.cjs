const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildSync } = require('esbuild');
const vault = process.argv[2];
if (!vault || !fs.statSync(vault).isDirectory()) throw Error('Provide a vault directory');
const built = buildSync({ entryPoints: ['src/core/wallLibrary.ts'], bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian'] });
const m={exports:{}};new Function('module','exports','require',built.outputFiles[0].text)(m,m.exports,require);
const {emptyLibrary,parseLibrary,migrateWall,folderPath,WALL_LIBRARY_PATH}=m.exports;
const dest=path.join(vault,WALL_LIBRARY_PATH);
const files=[];
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.name.startsWith('.'))continue;const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(entry.name.toLowerCase().endsWith('.mw'))files.push(full);}}
walk(vault);files.sort();
const data=fs.existsSync(dest)?parseLibrary(fs.readFileSync(dest,'utf8')):emptyLibrary();
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const sources=[];let sourceItems=0,added=0;
for(const file of files){const raw=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(raw.items))throw Error('Invalid source: '+file);const relative=path.relative(vault,file).replace(/\\/g,'/');sources.push({file:relative,hash:hash(file),count:raw.items.length});sourceItems+=raw.items.length;added+=migrateWall(data,relative,raw);}
parseLibrary(JSON.stringify(data));
for(const source of sources){const raw=JSON.parse(fs.readFileSync(path.join(vault,source.file),'utf8'));const base=source.file.replace(/\.mw$/i,'').split('/').join(' / ');
 for(const item of raw.items){const kind=item.meta.playlistId?'playlists':'albums';const id=`${kind}:${item.meta.playlistId||item.meta.albumId}`;const group=(raw.groups||[]).find(g=>g.id===item.groupId);const expected=base+(group?' / '+group.name:'');
  const entry=data.entries.find(e=>e.collection===id&&folderPath(data,e.folder)===expected);if(!entry)throw Error('Missing migrated item: '+expected+'/'+id);
  if(entry.rating!==item.rating||entry.addedAt!==item.addedAt||entry.metaEdited!==item.metaEdited||JSON.stringify(entry.snapshot)!==JSON.stringify(item.meta))throw Error('Metadata mismatch: '+expected+'/'+id);
 }
}
if(!fs.existsSync(dest)||added){fs.mkdirSync(path.dirname(dest),{recursive:true});if(fs.existsSync(dest))fs.copyFileSync(dest,dest+'.before-migration-'+Date.now()+'.bak');const temp=dest+'.pending';fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n');fs.renameSync(temp,dest);}
const saved=parseLibrary(fs.readFileSync(dest,'utf8'));for(const source of sources)if(hash(path.join(vault,source.file))!==source.hash)throw Error('Source changed');
console.log(JSON.stringify({files:files.length,sourceItems,added,entries:saved.entries.length,collections:saved.collections.length,folders:saved.folders.length,sourceFilesUnchanged:true,destination:dest},null,2));
