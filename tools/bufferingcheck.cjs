/* Real HTTP/byte-cache integration plus playback lifecycle and fade races. */
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const {buildSync} = require('esbuild');
const wait = ms => new Promise(r=>setTimeout(r,ms));
const flush = () => new Promise(r=>setImmediate(r));
const build = entry => buildSync({entryPoints:[entry],bundle:true,platform:'node',format:'cjs',write:false,external:['obsidian']}).outputFiles[0].text;
const load = (code, extras={}) => {const m={exports:{}};new Function('module','exports','require',code)(m,m.exports,name=>extras[name]||(name==='obsidian'?{Notice:class {}}:require(name)));return m.exports;};
let passed=0;
async function test(name,run){await run();console.log('PASS '+name);passed++;}
class Audio extends EventTarget {
 currentTime=0;duration=120;paused=true;ended=false;volume=1;
 async play(){this.paused=false;this.ended=false;this.dispatchEvent(new Event('playing'));}
 pause(){this.paused=true;this.dispatchEvent(new Event('pause'));}
 removeAttribute(){this.src='';}load(){}
}
const album={albumId:1,name:'Test',artist:'Test',cover:'',tracks:[1,2,3].map(id=>({id,name:'Track '+id,duration:120000}))};
async function main(){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mw-cache-check-'));
 const bytes=Buffer.alloc(2*1024*1024+157);for(let i=0;i<bytes.length;i++)bytes[i]=i%251;
 let transferred=0,queries=0,slow=false,aborts=0;
 const origin=http.createServer((req,res)=>{
  queries++;const m=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');assert(m);const start=+m[1],end=Math.min(+m[2],bytes.length-1);
  res.writeHead(206,{'Content-Range':`bytes ${start}-${end}/${bytes.length}`,'Content-Length':end-start+1,ETag:'"same-audio"'});
  let timer;res.on('close',()=>{clearTimeout(timer);if(!res.writableEnded)aborts++;});
  if(slow){let offset=start;const send=()=>{if(res.destroyed)return;const chunk=bytes.subarray(offset,Math.min(end+1,offset+4096));transferred+=chunk.length;res.write(chunk);offset+=chunk.length;if(offset<=end)timer=setTimeout(send,20);else res.end();};send();}
  else {transferred+=end-start+1;res.end(bytes.subarray(start,end+1));}
 });await new Promise(r=>origin.listen(0,'127.0.0.1',r));
 const {AudioTransport}=load(build('src/core/audioTransport.ts'),{https:{get:(_url,options,callback)=>http.get(`http://127.0.0.1:${origin.address().port}/audio`,options,callback)}});
 let transport,lease,limit=2;
 const source={url:'https://fixture.test/audio',mime:'audio/flac',quality:'lossless',trial:false};
 const identity={account:'account-A',song:1,durationMs:120000};
 const request=async(range,url=lease.url)=>{const response=await fetch(url,{headers:range?{Range:range}:{}});return {response,data:Buffer.from(await response.arrayBuffer())};};
 try{
  transport=new AudioTransport('vault',()=>limit,'app://obsidian.md',root);lease=await transport.open(source,identity,new AbortController().signal);
  await test('First byte ranges are served before the whole audio is downloaded',async()=>{const {response,data}=await request('bytes=103-601');assert.equal(response.status,206);assert.deepEqual(data,bytes.subarray(103,602));assert(transferred<bytes.length/2);assert.equal(response.headers.get('content-type'),'audio/flac');});
  await test('Unbuffered seeking and suffix ranges return exact bytes',async()=>{const r=await request('bytes=1572871-1573478');assert.deepEqual(r.data,bytes.subarray(1572871,1573479));const tail=await request('bytes=-100');assert.deepEqual(tail.data,bytes.subarray(-100));});
  await test('Ranges spanning the small initial block and subsequent block boundaries are exact',async()=>{for(const [start,end] of [[65520,65580],[327660,327710]]){const r=await request(`bytes=${start}-${end}`);assert.deepEqual(r.data,bytes.subarray(start,end+1));}});
  await test('Repeated byte ranges reuse the cache without an upstream download',async()=>{const before=queries;await request('bytes=105-600');assert.equal(queries,before);});
  await test('HEAD, invalid ranges, origins and private URLs are handled safely',async()=>{assert.equal((await fetch(lease.url,{method:'HEAD'})).headers.get('content-length'),String(bytes.length));assert.equal((await fetch(lease.url,{headers:{Range:'bytes=99999999-'}})).status,416);assert.equal((await fetch(lease.url,{headers:{Origin:'https://unrelated.test'}})).status,403);assert.equal((await fetch(lease.url+'/extra')).status,403);});
  await test('Cache budget evicts older blocks and never exceeds the limit',async()=>{limit=.25;await transport.trim();assert(await transport.usage()<=256*1024);await request('bytes=1048576-1048676');assert(await transport.usage()<=256*1024);});
  await test('Clearing cache keeps active audio routes usable and cannot repopulate old jobs',async()=>{await transport.clear();assert.equal(await transport.usage(),0);const r=await request('bytes=500-900');assert.deepEqual(r.data,bytes.subarray(500,901));assert.equal(await transport.usage(),0);});
  await test('Zero budget disables disk storage while retaining the next-song warm buffer',async()=>{lease.release();limit=0;lease=await transport.open(source,identity,new AbortController().signal);await lease.warm(1,new AbortController().signal);const before=queries;await request('bytes=0-100');assert.equal(queries,before);assert.equal(await transport.usage(),0);});
  await test('Cached blocks survive plugin restart and remain account scoped',async()=>{limit=1;await request('bytes=0-100');lease.release();transport.close();transport=new AudioTransport('vault',()=>limit,'app://obsidian.md',root);lease=await transport.open(source,identity,new AbortController().signal);const count=queries;await request('bytes=0-100');assert.equal(queries,count);const other=await transport.open(source,{...identity,account:'account-B'},new AbortController().signal);const before=queries;await request('bytes=0-100',other.url);assert.equal(queries,before+1);other.release();});
  await test('Cancelling a stream stops its unfinished upstream block',async()=>{await transport.clear();slow=true;const controller=new AbortController();const pending=fetch(lease.url,{headers:{Range:'bytes=1200000-1400000'},signal:controller.signal}).then(r=>r.arrayBuffer());await wait(70);controller.abort();await assert.rejects(pending);await wait(70);assert(aborts>0);slow=false;});
 }finally{lease?.release();transport?.close();origin.closeAllConnections();await new Promise(r=>origin.close(r));const resolved=path.resolve(root);assert(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('mw-cache-check-'));await fs.rm(resolved,{recursive:true,force:true});}
 const {InternalPlayer}=load(build('src/core/internalPlayer.ts'));
 function engine(overrides={}){const audios=[],opens=[],released=[],warmed=[];let blobs=0;const player=new InternalPlayer({resolve:async id=>({url:'https://fixture.test/'+id,quality:'standard',availableQualities:['standard','higher'],trial:false}),load:async()=>{blobs++;return new Blob(['test']);},audio:()=>{const audio=new Audio();audios.push(audio);return audio;},open:async(source,id,_duration,signal)=>{if(signal.aborted)throw new DOMException('Cancelled','AbortError');opens.push(id);let done=false;return {url:'http://fixture/'+id,warm:async()=>{warmed.push(id);},release(){if(!done){done=true;released.push(id);}}};},notice(){},...overrides});return {player,audios,opens,released,warmed,get blobs(){return blobs;}};}
 await test('Streaming starts without loading a complete Blob and preloads the next song once',async()=>{const e=engine();await e.player.playAlbum(album);await flush();assert.equal(e.blobs,0);assert.deepEqual(e.opens,[1,2]);assert.deepEqual(e.warmed,[2]);await e.player.next();await flush();assert.equal(e.opens.filter(id=>id===2).length,1);assert.equal(e.player.index,1);e.player.stop();await flush();assert.equal(e.released.length,e.opens.length);});
 await test('Changing the queue cancels stale preloads and shuffle adopts its reserved next song',async()=>{const e=engine();await e.player.playPlaylist(album);e.player.setOrder('shuffle');await flush();const reserved=e.opens.at(-1);await e.player.next();assert.equal(e.player.state.songId,reserved);e.player.stop();});
 await test('Pause fades preserve user volume and rapid resume cannot be paused by an old fade',async()=>{const e=engine({pauseFade:()=>.08});await e.player.playAlbum(album);e.player.setVolume(.4);const pause=e.player.pause();await wait(25);assert(e.audios[0].volume<.4&&e.audios[0].volume>0);await e.player.play();await pause;await wait(100);assert.equal(e.audios[0].paused,false);assert.equal(e.player.volume,.4);assert(Math.abs(e.audios[0].volume-.4)<.001);e.player.stop();});
 await test('Crossfade overlaps two tracks and releases the outgoing stream after the fade',async()=>{const e=engine({crossFade:()=>.08});await e.player.playAlbum(album);await flush();await e.player.next();assert.equal(e.audios[0].paused,false);assert.equal(e.audios[1].paused,false);assert(!e.released.includes(1));await wait(110);assert.equal(e.audios[0].paused,true);assert(e.released.includes(1));e.player.stop();});
 await test('Automatic crossfade starts before song end and paused next songs are audible',async()=>{const e=engine({crossFade:()=>.08,pauseFade:()=>0});await e.player.playAlbum(album);await flush();e.audios[0].currentTime=119.96;e.audios[0].dispatchEvent(new Event('timeupdate'));await flush();await flush();assert.equal(e.player.index,1);await e.player.pause();await e.player.next();assert.equal(e.audios.at(-1).volume,1);e.player.stop();});
 await test('Unavailable streaming falls back to whole-file playback without losing the queue',async()=>{const e=engine({open:async()=>{throw Error('Range unavailable');}});assert.equal(await e.player.playAlbum(album),true);assert.equal(e.blobs,1);assert.equal(e.player.albumQueue.length,1);e.player.stop();});
 await test('Stream decoder failure falls back once and never starts a stale request',async()=>{let count=0;const e=engine({audio:()=>{const a=new Audio();if(!count++)a.play=async()=>{throw Error('Blocked stream');};return a;}});assert.equal(await e.player.playAlbum(album),true);assert.equal(e.blobs,1);e.player.stop();});
 await test('A pause near song end cannot automatically start another song',async()=>{const e=engine({pauseFade:()=>.08});await e.player.playAlbum(album);const pending=e.player.pause();e.audios[0].ended=true;e.audios[0].dispatchEvent(new Event('ended'));await pending;assert.equal(e.player.index,0);assert.equal(e.player.playingRequested,false);e.player.stop();});
 await test('Paused buffering media can resume without getting stuck in the loading state',async()=>{const e=engine();await e.player.playAlbum(album);e.audios[0].dispatchEvent(new Event('waiting'));assert.equal(e.player.loading,true);await e.player.pause();await e.player.play();assert.equal(e.player.state.status,'playing');e.player.stop();});
 console.log(`${passed} streaming, cache, preloading and fade checks passed`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
