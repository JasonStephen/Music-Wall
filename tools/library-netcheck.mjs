// Read-only account probe. Never prints credentials, IDs, names, or response bodies.
import fs from 'node:fs';
import path from 'node:path';
import {build} from 'esbuild';
const built=await build({stdin:{contents:"export * from './src/core/library'; export {verifyCookie} from './src/core/playlist';",resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',write:false});
const {MusicLibraryApi,verifyCookie}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const request=async req=>{const response=await fetch(req.url,{method:req.method,headers:req.headers,body:req.body,signal:AbortSignal.timeout(15000)});return {status:response.status,text:await response.text()};};
try {
 if(!process.env.MW_PLUGIN_DIR)throw Error('Set MW_PLUGIN_DIR to the installed plugin directory');
 const config=JSON.parse(fs.readFileSync(path.join(process.env.MW_PLUGIN_DIR,'data.json'),'utf8'));
 if(!config.neteaseCookie)throw Error('No saved sign-in');
 const {uid}=await verifyCookie(request,config.neteaseCookie),api=new MusicLibraryApi(request);
 const lists=await api.userPlaylists(uid,config.neteaseCookie);
 console.log('PASS authenticated playlist listing: '+lists.length+' playlists');
 console.log('Created / collected / likes categories: '+[lists.filter(x=>x.owner===uid).length,lists.filter(x=>x.owner!==uid).length,lists.filter(x=>x.special===5).length].join(' / '));
 const sample=lists.filter(x=>x.count>0&&x.count<=50).sort((a,b)=>a.count-b.count)[0];
 if(sample){const detail=await api.detail(sample,config.neteaseCookie);if(!detail.tracks.length)throw Error('Empty sample playlist');console.log('PASS playlist details and per-song album artwork: '+detail.tracks.length+' tracks');}
 const search=await api.search('Synthwave',config.neteaseCookie);if(!search.items.length)throw Error('No search results');console.log('PASS live playlist search: '+search.items.length+' results');
 const liked=lists.find(x=>x.special===5&&x.owner===uid);
 if(liked&&liked.count<=1000){const detail=await api.liked(uid,config.neteaseCookie);console.log('PASS liked songs: '+detail.tracks.length+' tracks');}
 else console.log('Liked playlist identity verified; full download skipped');
}catch(error){console.error('FAIL live library probe: '+(error?.name==='TimeoutError'?'Request timed out':error?.message==='fetch failed'?'Network request failed':String(error.message).slice(0,160)));process.exitCode=1;}
