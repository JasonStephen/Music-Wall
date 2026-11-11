/* node tools/playercheck.cjs - real queue/controller modules, simulated audio/network. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { buildSync } = require('esbuild');
const built = buildSync({
  stdin: { contents: `export * from './src/core/internalPlayer'; export * from './src/core/audioSource';
    export * from './src/core/playbackSession'; export * from './src/core/playback'; export * from './src/core/match'; export * from './src/core/quality';`, resolveDir: path.resolve(__dirname, '..'), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['obsidian'],
});
const loaded = { exports: {} };
new Function('module','exports','require',built.outputFiles[0].text)(loaded,loaded.exports,
  (name) => name === 'obsidian' ? { Notice: class {} } : require(name));
const api = loaded.exports;
const flush = () => new Promise((resolve) => setImmediate(resolve));
class Audio extends EventTarget {
  currentTime = 0; duration = 120; paused = true; ended = false; volume = 1;
  async play() { this.paused = false; this.ended = false; this.dispatchEvent(new Event('playing')); }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')); }
  removeAttribute() { this.src = ''; }
  load() {}
  finish() { this.ended = true; this.currentTime = this.duration; this.dispatchEvent(new Event('ended')); }
}
const album = (id = 1) => ({ albumId: id, name: 'Album ' + id, artist: 'Artist', cover: '', trackCount: 3,
  tracks: [1,2,3].map((n) => ({ id: id * 10 + n, name: 'Track ' + n, duration: 120000 })) });
function player(overrides = {}) {
  const audios = [], resolved = [], notices = [];
  const instance = new api.InternalPlayer({
    resolve: async (id) => { resolved.push(id); return { url: 'https://example.test/' + id, trial: false }; },
    load: async () => new Blob(['test'], { type: 'audio/mpeg' }),
    audio: () => { const audio = new Audio(); audios.push(audio); return audio; },
    notice: (message) => notices.push(message), ...overrides,
  });
  return { instance, audios, resolved, notices };
}
const response = (body) => ({ status: 200, text: JSON.stringify(body) });
let passed = 0;
async function test(name, run) { await run(); passed++; console.log('PASS ' + name); }
async function main() {
  await test('Album plays in order, advances on ended, and stops at the end', async () => {
    const { instance, audios, resolved } = player();
    assert.equal(await instance.playAlbum(album()), true);
    assert.equal(instance.state.source, 'internal');
    assert.equal(instance.state.status, 'playing');
    audios[0].finish(); await flush();
    assert.equal(instance.index, 1);
    audios[1].finish(); await flush();
    assert.equal(instance.index, 2);
    audios[2].finish(); await flush();
    assert.equal(instance.state.status, 'stopped');
    assert.deepEqual(resolved, [11,12,13]); instance.stop();
  });
  await test('Pause, resume, next, previous, seek and volume control the internal audio', async () => {
    const { instance, audios } = player(); await instance.playAlbum(album());
    await instance.pause(); assert.equal(audios[0].paused, true);
    await instance.play(); assert.equal(instance.state.status, 'playing');
    assert.equal(await instance.seek(45000), true); assert.equal(audios[0].currentTime, 45);
    instance.setVolume(.25); assert.equal(audios[0].volume, .25);
    await instance.next(); assert.equal(instance.index, 1); assert.equal(audios[1].volume, .25);
    await instance.prev(); assert.equal(instance.index, 0);
    assert.equal(await instance.prev(), false); instance.stop();
  });
  await test('Track selection retains the album queue and uses the selected index', async () => {
    const { instance, resolved } = player(); await instance.playAlbum(album(), 1);
    assert.equal(instance.index, 1); assert.deepEqual(resolved, [12]);
    assert.equal(await instance.playAlbum(album(2), 99), false);
    assert.equal(instance.album.albumId, 1); instance.stop();
  });
  await test('A cancelled resume cannot overwrite a newer track or report a pause as an error', async () => {
    const { instance, audios, notices } = player(); await instance.playAlbum(album());
    await instance.pause();
    let rejectResume;
    audios[0].play = () => new Promise((_, reject) => { rejectResume = reject; });
    const oldResume = instance.play(); await instance.next();
    rejectResume(Error('cancelled by track change'));
    assert.equal(await oldResume, false); assert.equal(instance.index, 1);
    assert.equal(instance.state.status, 'playing'); assert.equal(instance.error, '');
    await instance.pause();
    audios[1].play = () => new Promise((_, reject) => { rejectResume = reject; });
    const pausedResume = instance.play(); await instance.pause(); rejectResume(Error('cancelled by pause'));
    await pausedResume; assert.equal(instance.state.status, 'paused');
    assert.equal(notices.length, 0); instance.stop();
  });
  await test('Unavailable tracks are skipped, and all-unavailable albums stop without looping', async () => {
    const { instance, resolved, notices } = player({ resolve: async (id) => {
      resolved.push(id); if (id !== 12) throw new api.TrackUnavailableError();
      return { url: 'https://example.test/audio', trial: false };
    } });
    await instance.playAlbum(album()); assert.equal(instance.index, 1); assert.equal(notices.length, 1);
    await instance.next(); assert.equal(instance.state.status, 'stopped'); assert.equal(instance.loading, false);
    assert.deepEqual(resolved, [11,12,13]); instance.stop();
  });
  await test('An old URL response cannot replace a more recently selected album', async () => {
    let finish;
    const { instance, audios } = player({ resolve: async (id) => id === 11 ? new Promise((r) => { finish = r; })
      : { url: 'https://example.test/' + id, trial: false } });
    const old = instance.playAlbum(album()); await instance.playAlbum(album(2));
    finish({ url: 'https://example.test/stale', trial: false });
    assert.equal(await old, false); assert.equal(instance.album.albumId, 2);
    assert.equal(audios.length, 1); instance.stop();
  });
  await test('Stopping during a download prevents late audio from starting', async () => {
    let finish;
    const { instance, audios } = player({ load: () => new Promise((r) => { finish = r; }) });
    const pending = instance.playAlbum(album()); await flush(); instance.stop();
    finish(new Blob(['late'])); assert.equal(await pending, false);
    assert.equal(audios.length, 0); assert.equal(instance.album, null);
  });
  await test('Pausing during a download keeps the loaded track paused until resume', async () => {
    let finish;
    const { instance, audios } = player({ load: () => new Promise((r) => { finish = r; }) });
    const pending = instance.playAlbum(album()); await flush(); await instance.pause();
    finish(new Blob(['data'])); await pending;
    assert.equal(audios[0].paused, true); assert.equal(instance.state.status, 'paused');
    await instance.play(); assert.equal(audios[0].paused, false); instance.stop();
  });
  await test('Transient network errors stop instead of skipping the whole album', async () => {
    const { instance, resolved } = player({ load: async () => { throw Error('offline'); } });
    assert.equal(await instance.playAlbum(album()), false);
    assert.deepEqual(resolved, [11]); assert.equal(instance.loading, false); assert.ok(instance.error); instance.stop();
  });
  await test('Preview clips are labeled and audio errors stop playback', async () => {
    const { instance, audios, notices } = player({ resolve: async () => ({ url: 'https://example.test/trial', trial: true }) });
    await instance.playAlbum(album()); assert.equal(instance.trial, true); assert.equal(notices.length, 1);
    audios[0].dispatchEvent(new Event('error')); assert.ok(instance.error);
    assert.equal(instance.state.status, 'paused'); instance.stop();
  });
  await test('Switching tracks and stopping revoke object URLs', async () => {
    const original = URL.revokeObjectURL; const revoked = [];
    URL.revokeObjectURL = (url) => { revoked.push(url); original(url); };
    try {
      const { instance } = player(); await instance.playAlbum(album()); await instance.next(); instance.stop();
      assert.equal(revoked.length, 2); assert.equal(new Set(revoked).size, 2);
    } finally { URL.revokeObjectURL = original; }
  });
  await test('Internal state takes priority over SMTC; disabling SMTC does not stop internal audio', async () => {
    const { instance } = player(); let stopCount = 0;
    const external = { supported: true, state: { active: true, title: 'External' }, on: () => () => {},
      start() {}, stop() { stopCount++; } };
    const combined = new api.CombinedNowPlayingProvider(external, instance);
    await instance.playAlbum(album()); combined.stop(); assert.equal(stopCount, 1);
    assert.equal(combined.state.source, 'internal'); assert.equal(combined.state.status, 'playing');
    instance.stop(); assert.equal(combined.state.title, 'External'); combined.dispose();
  });
  await test('Album IDs identify wall records precisely, including duplicate track titles', async () => {
    const { instance } = player(); await instance.playAlbum(album(2));
    const items = [album(1),album(2)].map((meta) => ({ albumId: meta.albumId, meta }));
    const match = api.matchNowPlaying(instance.state, items);
    assert.equal(match.albumId, 2); assert.equal(match.trackIndex, 0); instance.stop();
  });
  await test('Internal playback returns before any playlist or external-client operation', async () => {
    const calls = [];
    await api.playAlbum(album(), { isDesktop: false,
      request: async () => { throw Error('Playlist request must not happen'); },
      playInside: async (meta, index) => { calls.push([meta.albumId,index]); return true; } }, 2);
    assert.deepEqual(calls, [[1,2]]);
  });
  await test('Audio source lookup detects preview clips and falls back without changing playlists', async () => {
    const paths = [];
    const source = await api.fetchSongSource(async (req) => {
      paths.push(req.url);
      return response({ code: 200, data: [{ id: 11, url: paths.length <= 5 ? null : 'http://m1.music.126.net/test.mp3', freeTrialInfo: { start: 0, end: 30 } }] });
    },11,'MUSIC_U=test');
    assert.equal(paths.length,6); assert.ok(paths.every((url) => url.includes('/song/enhance/player/url')));
    assert.match(source.url,/^https:/); assert.equal(source.trial,true);
    await assert.rejects(api.fetchSongSource(async () => response({code:200,data:[]}),11,''),api.TrackUnavailableError);
  });
  await test('Quality menus deduplicate actual server levels and Hi-Res falls back to lossless', async () => {
    let calls = 0;
    const result = await api.fetchSongSource(async () => {
      const level = ['standard','higher','exhigh','lossless','lossless'][calls++];
      return response({code:200,data:[{id:11,url:'https://example.test/'+level,level,type:level === 'lossless'?'flac':'mp3'}]});
    },11,'test','hires');
    assert.equal(result.quality,'lossless'); assert.equal(result.mime,'audio/flac');
    assert.deepEqual(result.availableQualities,['standard','higher','exhigh','lossless']);
  });
  await test('An account limited to MP3 exposes no lossless or Hi-Res and never exceeds the preference', async () => {
    const source = await api.fetchSongSource(async()=>response({code:200,data:[{id:11,url:'https://example.test/a',level:'exhigh',type:'mp3'}]}),11,'','hires');
    assert.equal(source.quality,'exhigh'); assert.deepEqual(source.availableQualities,['exhigh']);
    let calls=0;
    const lower = await api.fetchSongSource(async()=>{
      const level=['standard','higher','exhigh','lossless','hires'][calls++];
      return response({code:200,data:[{id:11,url:'https://example.test/a',level,type:'mp3'}]});
    },11,'','higher');
    assert.equal(lower.quality,'higher');
  });
  await test('Cached quality discovery is credential scoped, supports switching, and clears on logout', async () => {
    let calls=0;
    const resolver=new api.SongSourceResolver(async()=>{
      const level=['standard','higher','exhigh','lossless','hires'][calls++ % 5];
      return response({code:200,data:[{id:11,url:'https://example.test/a',level}]});
    });
    await resolver.resolve(11,'account1','standard'); await resolver.resolve(11,'account1','hires');
    assert.equal(calls,5);
    await resolver.resolve(11,'account2','hires'); assert.equal(calls,10);
    resolver.clear(); await resolver.resolve(11,'account2','standard'); assert.equal(calls,15);
  });
  await test('Switching quality keeps pause, position, volume and queue; next track uses session preference', async () => {
    const requested=[];
    const {instance,audios}=player({ defaultQuality:()=> 'hires', resolve:async(id,quality)=>{
      requested.push([id,quality]);
      return {url:'https://example.test/a',trial:false,quality:quality==='hires'?'exhigh':quality,availableQualities:['standard','higher','exhigh']};
    }});
    await instance.playAlbum(album()); assert.deepEqual(requested[0],[11,'hires']);
    await instance.seek(45000); await instance.pause(); instance.setVolume(.3);
    assert.equal(await instance.setQuality('hires'),false);
    assert.equal(await instance.setQuality('higher'),true);
    audios[1].dispatchEvent(new Event('loadedmetadata'));
    assert.equal(instance.state.status,'paused'); assert.equal(instance.state.positionMs,45000);
    assert.equal(instance.volume,.3); assert.equal(instance.index,0);
    await instance.next(); assert.deepEqual(requested.at(-1),[12,'higher']);
    instance.stop(); await instance.playAlbum(album()); assert.deepEqual(requested.at(-1),[11,'hires']); instance.stop();
  });
  await test('Playback session restores a local playlist and song without its progress or network work', async () => {
    const first=player();
    const list={...album(7),albumId:0,localPlaylistId:'local:test',name:'My list'};
    await first.instance.playPlaylist(list,1);first.instance.setOrder('shuffle');
    await first.instance.seek(45000);
    const saved=api.parsePlaybackSession(JSON.stringify(first.instance.exportSession()));
    assert.ok(saved);assert.equal(saved.playing,true);
    assert.ok(!JSON.stringify(saved).includes('positionMs'));
    first.instance.stop();
    const second=player();second.instance.restoreSession(saved);
    assert.equal(second.instance.album.localPlaylistId,'local:test');assert.equal(second.instance.index,1);
    assert.equal(second.instance.state.songId,72);assert.equal(second.instance.order,'shuffle');
    assert.equal(second.instance.state.status,'paused');assert.equal(second.instance.state.positionMs,0);
    assert.deepEqual(second.resolved,[]);assert.equal(second.audios.length,0);
    await second.instance.play();
    assert.equal(second.instance.state.songId,72);assert.equal(second.instance.state.positionMs,0);
    assert.equal(second.instance.state.status,'playing');
    second.instance.stop();
  });
  await test('Playback session keeps both queues, album order, saved songs and new entry IDs', async () => {
    const first=player();await first.instance.playAlbum(album(1),1);await first.instance.seek(30000);
    first.instance.enqueueAlbum(album(2));first.instance.enqueueAlbum(album(3));
    first.instance.moveQueued(first.instance.albumQueue[2].id,1);
    await first.instance.playPlaylist({...album(4),albumId:0,playlistId:55},2);
    await first.instance.pause();
    const saved=api.parsePlaybackSession(JSON.stringify(first.instance.exportSession()));
    assert.ok(saved);assert.equal(saved.playing,false);
    const second=player();second.instance.restoreSession(saved);
    assert.deepEqual(second.instance.albumQueue.map(e=>e.album.albumId),[1,3,2]);
    assert.deepEqual(second.instance.songQueue.map(t=>t.id),[41,42,43]);
    assert.equal(second.instance.index,2);assert.equal(second.instance.state.status,'paused');
    second.instance.enqueueAlbum(album(5));
    assert.equal(new Set(second.instance.albumQueue.map(e=>e.id)).size,4);
    await second.instance.playQueued(second.instance.albumQueue[0].id);
    assert.equal(second.instance.state.songId,12);assert.equal(second.instance.state.positionMs,0);
    const albumSaved=api.parsePlaybackSession(JSON.stringify(second.instance.exportSession()));
    const third=player();third.instance.restoreSession(albumSaved);
    assert.equal(third.instance.album,third.instance.albumQueue[0].album);
    assert.equal(third.instance.state.songId,12);
    await third.instance.resumePlaylist();
    assert.equal(third.instance.state.songId,43);assert.equal(third.instance.state.positionMs,0);
    first.instance.stop();second.instance.stop();third.instance.stop();
  });
  await test('Session storage serializes writes, ignores progress and survives player teardown', async () => {
    const files=new Map();let writes=0;
    const adapter={exists:async p=>files.has(p),read:async p=>files.get(p),write:async(p,text)=>{writes++;await flush();files.set(p,text)}};
    const store=new api.PlaybackSessionStore(adapter,'session.json');
    const first=player();store.watch(first.instance);
    await first.instance.playAlbum(album(1),1);await store.flush();
    const baseline=writes;
    await first.instance.seek(60000);first.instance.setVolume(.5);await store.flush();
    assert.equal(writes,baseline);
    first.instance.enqueueAlbum(album(2));await first.instance.select(2);
    const pending=store.dispose();first.instance.stop();await pending;
    const saved=await new api.PlaybackSessionStore(adapter,'session.json').load();
    assert.equal(saved.index,2);assert.equal(saved.albumQueue.length,2);assert.equal(saved.playing,true);
    const restored=player();restored.instance.restoreSession(saved);
    const nextStore=new api.PlaybackSessionStore(adapter,'session.json');nextStore.watch(restored.instance);
    await restored.instance.play();await restored.instance.pause();await nextStore.flush();
    assert.equal((await nextStore.load()).playing,false);
    await nextStore.dispose();restored.instance.stop();
  });
  await test('Malformed playback sessions are ignored and empty sessions remain valid', async () => {
    assert.equal(api.parsePlaybackSession('{bad'),null);
    assert.equal(api.parsePlaybackSession('{"version":99}'),null);
    const first=player();await first.instance.playAlbum(album(),1);
    const snapshot=JSON.parse(JSON.stringify(first.instance.exportSession()));
    snapshot.index=99;assert.equal(api.parsePlaybackSession(JSON.stringify(snapshot)),null);
    first.instance.stop();assert.ok(api.parsePlaybackSession(JSON.stringify(first.instance.exportSession())));
  });
  await test('Inserted search songs retain source name, identity and original membership', async () => {
    const {instance:p}=player();
    const source={...album(0),playlistId:123,name:'Original playlist',cover:'playlist.jpg',wallEntryId:'saved-list'};
    await p.playPlaylist(source);
    const extra={id:1001,name:'Search result',artists:'Artist',cover:'song.jpg',duration:120000};
    await p.insertTrack(extra,true);
    assert.equal(p.album.name,source.name);assert.equal(p.album.playlistId,123);assert.equal(p.album.wallEntryId,'saved-list');
    assert.equal(p.currentCover,'song.jpg');assert.equal(p.state.title,'Search result');
    assert.equal(p.sourceCollection.name,source.name);assert.equal(p.sourceCollection.trackCount,3);assert.equal(p.sourceCollection.tracks.length,3);
    assert.equal(source.tracks.length,3);assert.equal(p.songQueue.length,4);
    await p.insertTrack({...extra,id:1002,name:'Next search'},false);await p.next();
    assert.equal(p.state.songId,1002);assert.equal(p.album.name,source.name);assert.equal(p.sourceCollection.tracks.length,3);
    await p.playSongQueue(0);assert.equal(p.sourceCollection.trackCount,3);
    p.enqueuePlaylist({...album(6),playlistId:666,name:'Appended playlist'});
    assert.equal(p.sourceCollection.name,source.name);assert.equal(p.album.name,source.name);
    const restored=player().instance;restored.restoreSession(api.parsePlaybackSession(JSON.stringify(p.exportSession())));
    assert.equal(restored.sourceCollection.name,source.name);assert.equal(restored.sourceCollection.tracks.length,3);
    await restored.insertTrack({...extra,id:1003},true);assert.equal(restored.sourceCollection.trackCount,3);
    p.stop();restored.stop();
  });
  await test('Search playback without a playlist uses a queue label and song artwork', async () => {
    const {instance:p}=player();
    await p.insertTrack({id:77,name:'Standalone song',cover:'standalone.jpg',duration:120000},true);
    assert.notEqual(p.album.name,'Standalone song');assert.equal(p.currentCover,'standalone.jpg');
    p.stop();
  });
  console.log(`\n${passed} internal playback checks passed`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
