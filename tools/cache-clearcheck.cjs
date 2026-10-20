const assert=require('node:assert/strict'),{buildSync}=require('esbuild');
const result=buildSync({stdin:{contents:"export * from './src/core/lyrics';export * from './src/core/collectionStatsCache';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']});
const mod={exports:{}};new Function('module','exports','require',result.outputFiles[0].text)(mod,mod.exports,require);
(async()=>{
 let disk='';const storage={exists:async()=>!!disk,read:async()=>disk,write:async(_,value)=>{disk=value;}};
 const stats=new mod.exports.CollectionStatsCache(storage,'stats');await stats.put('42','album:1',1,{count:1,duration:1000});
 const revision=stats.revision;await stats.clear();await stats.put('42','album:2',1,{count:1,duration:1000},revision);
 assert.deepEqual(JSON.parse(disk).entries,[]);assert.equal(await stats.get('42','album:1',1),null);assert.equal(await stats.get('42','album:2',1),null);
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const lyrics=new mod.exports.LyricsService(async()=>pending,storage,'lyrics');const work=lyrics.get(99);
 await new Promise(resolve=>setImmediate(resolve));await lyrics.clear();
 release({status:200,text:JSON.stringify({code:200,lrc:{lyric:'[00:01]Old request'}}),headers:{}});await work;await new Promise(resolve=>setImmediate(resolve));
 assert.deepEqual(JSON.parse(disk).entries,[]);assert.equal(lyrics.cache.size,0);
 console.log('Cache clearing removes persisted and memory entries; late statistics and lyric requests cannot restore cleared data');
})().catch(error=>{console.error(error);process.exitCode=1;});
