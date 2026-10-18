const {ipcRenderer}=require('electron'),fs=require('fs'),path=require('path'),https=require('https');
const {AudioTransport,InternalPlayer,SongSourceResolver,CoverBackdrop,installDomHelpers,probeCoverUri}=require('./api.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));const results=[];let transport,player,backdrop;
function check(value,name,detail){results.push({name,ok:!!value,...(detail?{detail}: {})});if(!value)throw Error(name);}
async function until(test,ms=15000){const start=performance.now();while(!test()&&performance.now()-start<ms)await wait(30);}
window.probeRequest=async req=>{
 const match=/accent-probe-([0-9a-f]{6})/.exec(req.url);
 if(match){const c=document.createElement('canvas');c.width=c.height=8;const ctx=c.getContext('2d');ctx.fillStyle='#'+match[1];ctx.fillRect(0,0,8,8);const b=await new Promise(r=>c.toBlob(r));return {status:200,headers:{'content-type':'image/png'},arrayBuffer:await b.arrayBuffer(),text:''};}
 return new Promise((resolve,reject)=>{const r=https.get(req.url,{headers:{Referer:'https://music.163.com/'}},response=>{const chunks=[];response.on('data',x=>chunks.push(x));response.on('end',()=>{const b=Buffer.concat(chunks);resolve({status:response.statusCode,headers:response.headers,arrayBuffer:b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),text:b.toString()});});});r.on('error',reject);});
};
(async()=>{
 try{
  installDomHelpers();
  check(['http','https','fs/promises','path','crypto','os'].every(name=>!!require(name)),'Obsidian embedded Node provides every runtime dependency',{electron:process.versions.electron,node:process.versions.node,chrome:process.versions.chrome});
  const root=document.getElementById('cover');backdrop=new CoverBackdrop(root);let tone;
  backdrop.set('https://example.invalid/accent-probe-c0392b.png',value=>tone=value);await until(()=>tone,4000);
  check(tone?.accent==='#c0392b','Remote image is decoded before its background and tone are committed',{tone,background:root.style.getPropertyValue('--mw-player-art'),layers:[...root.children].map(x=>({image:x.style.backgroundImage,opacity:x.style.opacity}))});
  const before=root.style.getPropertyValue('--mw-player-art');
  const deliveries=[];const original=window.probeRequest;window.probeRequest=req=>req.url.includes('accent-probe-3274a8')?new Promise(resolve=>{deliveries.push(()=>original(req).then(resolve));}):original(req);
  backdrop.set('https://example.invalid/accent-probe-3274a8.png',value=>tone=value);await wait(80);check(root.style.getPropertyValue('--mw-player-art')===before,'Unprepared next cover never replaces the current background');await Promise.all(deliveries.map(deliver=>deliver()));await until(()=>tone?.accent==='#3274a8',2500);check(tone?.accent==='#3274a8','Decoded next cover crossfades into the prepared background');
  const controller=new AbortController();const cfg=JSON.parse(fs.readFileSync(process.env.MW_PROBE_DATA,'utf8'));
  const request=q=>new Promise((resolve,reject)=>{const r=https.request(q.url,{method:q.method,headers:q.headers},response=>{const chunks=[];response.on('data',x=>chunks.push(x));response.on('end',()=>resolve({status:response.statusCode,text:Buffer.concat(chunks).toString()}));});r.setTimeout(15000,()=>r.destroy(Error('timeout')));r.on('error',reject);r.end(q.body);});
  const resolver=new SongSourceResolver(request);
  const sources={standard:await resolver.resolve(347230,cfg.neteaseCookie||'','standard'),hires:await resolver.resolve(347230,cfg.neteaseCookie||'','hires')};
  let limit=4,downloaded=0,total=0;
  transport=new AudioTransport('isolated-runtime',()=>limit,location.origin,path.join(__dirname,'cache'));
  const bytes=transport.getBytes.bind(transport);transport.getBytes=async(...args)=>{const data=await bytes(...args);downloaded+=data.bytes.length;total=data.size;await wait(60);return data;};
  const notices=[];player=new InternalPlayer({resolve:async(_id,quality)=>({...sources[quality==='standard'?'standard':'hires'],availableQualities:['standard',sources.hires.quality]}),load:async()=>{throw Error('Whole-file fallback must not be needed');},open:(source,id,durationMs,signal)=>transport.open(source,{account:'runtime-test',song:id,durationMs},signal),pauseFade:()=>.15,crossFade:()=>.3,notice:message=>notices.push(message)});player.setVolume(0);
  const meta={albumId:1,name:'Runtime check',artist:'Test',cover:'',tracks:[1,2,3].map(id=>({id,name:'Test '+id,duration:326000}))};
  check(await player.playAlbum(meta),'MP3 starts through the actual streaming transport');await until(()=>player.state.positionMs>100);
  check(downloaded<total&&player.state.positionMs>0,'MP3 plays while the remaining bytes are still downloading',{downloaded,total});
  check(await player.seek(228000),'MP3 seeks into an unbuffered region');await until(()=>player.state.positionMs>=228000);check(player.state.positionMs>=228000,'MP3 resumes after range seeking');
  await player.pause();check(player.state.status==='paused'&&player.media.paused,'Real audio pause fade completes');await player.play();check(player.state.status==='playing','Real audio resumes after the fade');
  const fading=player.pause();await wait(40);await player.play();await fading;await wait(180);check(player.state.status==='playing'&&!player.media.paused,'Rapid resume during a real pause fade preserves playback and visible state');
  await player.next();check(player.index===1,'Manual crossfade advances the queue');await wait(450);check(!player.previous,'Outgoing stream is released after the crossfade');
  check(await player.setQuality(sources.hires.quality),'Lossless quality switch preserves the current song');await until(()=>player.state.positionMs>100);
  check(player.quality===sources.hires.quality&&player.state.status==='playing','FLAC decodes and streams in the Obsidian Chromium runtime',{quality:player.quality,mime:sources.hires.mime});
  check(await player.seek(180000),'FLAC supports seeking before full download');await until(()=>player.state.positionMs>=180000);
  check(await transport.usage()<=limit*1024*1024,'Persistent cache respects the configured budget');await transport.clear();check(await transport.usage()===0,'Clear cache removes persisted blocks');await wait(250);check(player.state.status==='playing','Clearing cache leaves current audio playing');
  check(notices.length===0,'Native stream playback needs no fallback or decoder error');
  if(fs.existsSync(process.env.MW_HIRES_FIXTURE||'')){
   const data=fs.readFileSync(process.env.MW_HIRES_FIXTURE),info=data.readBigUInt64BE(18),rate=Number(info>>44n),depth=Number((info>>36n)&31n)+1;
   check(rate===192000&&depth===24,'Hi-Res fixture contains 24-bit / 192 kHz FLAC');player.dispose();
   const network=transport.getBytes.bind(transport);downloaded=0;
   transport.getBytes=async(url,start,end,signal)=>{if(url!=='https://fixture.test/hires')return network(url,start,end,signal);if(signal.aborted)throw new DOMException('Cancelled','AbortError');await wait(60);const chunk=data.subarray(start,Math.min(end+1,data.length));downloaded+=chunk.length;return {bytes:chunk,size:data.length,tag:'hires-fixture'};};
   player=new InternalPlayer({resolve:async()=>({url:'https://fixture.test/hires',mime:'audio/flac',quality:'hires',availableQualities:['hires'],trial:false}),load:async()=>{throw Error('No fallback');},open:(s,id,durationMs,signal)=>transport.open(s,{account:'runtime-test',song:id,durationMs},signal),notice:message=>notices.push(message)});player.setVolume(0);
   check(await player.playAlbum({albumId:201,name:'Hi-Res',artist:'Test',cover:'',tracks:[{id:201,name:'24/192',duration:15000}]}),'Hi-Res FLAC starts through the same native stream path');await until(()=>player.state.positionMs>100);
   check(player.state.status==='playing'&&player.quality==='hires'&&downloaded<data.length,'24-bit / 192 kHz plays before the full file has downloaded',{downloaded,total:data.length});check(await player.seek(10000),'Hi-Res supports seeking into an unbuffered region');await until(()=>player.state.positionMs>=10000);check(player.state.positionMs>=10000,'Hi-Res resumes at the requested position');
  }
  ipcRenderer.send('result',{ok:true,results});
 }catch(error){ipcRenderer.send('result',{ok:false,results,error:error.message});}
 finally{player?.dispose();transport?.close();backdrop?.dispose();}
})();
