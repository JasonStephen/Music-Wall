// Real HTMLAudioElement + real MusicPlayerView. Invoked with a browser user gesture.
import { InternalPlayer, CombinedNowPlayingProvider } from "../src/core/internalPlayer";
import { EMPTY_NOW_PLAYING } from "../src/core/nowPlaying";
import { MusicPlayerView } from "../src/ui/MusicPlayerView";
import { DEFAULT_SETTINGS } from "../src/types";
import { setLanguage } from "../src/i18n";
import { installDomHelpers, WorkspaceLeaf, TFile } from "./obsidian-shim";
installDomHelpers(); setLanguage("zh-CN");
const live = new URLSearchParams(location.search).has("live");
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const failed: string[] = [];
function check(condition: unknown, name: string) {
  document.getElementById("result")!.createEl("div", { cls: condition ? "ok" : "bad", text: `${condition ? "PASS" : "FAIL"} ${name}` });
  if (!condition) failed.push(name);
}
async function until(test: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) { if (test()) return; await wait(30); }
}
function wave(): Blob {
  const samples = 8000 * 3;
  const bytes = new ArrayBuffer(44 + samples * 2); const view = new DataView(bytes);
  const text = (offset: number, value: string) => [...value].forEach((letter, i) => view.setUint8(offset + i, letter.charCodeAt(0)));
  text(0,"RIFF"); view.setUint32(4,36+samples*2,true); text(8,"WAVEfmt "); view.setUint32(16,16,true);
  view.setUint16(20,1,true); view.setUint16(22,1,true); view.setUint32(24,8000,true);
  view.setUint32(28,16000,true); view.setUint16(32,2,true); view.setUint16(34,16,true);
  text(36,"data"); view.setUint32(40,samples*2,true);
  for(let i=0;i<samples;i++) view.setInt16(44+i*2,Math.sin(i*2*Math.PI*440/8000)*2000,true);
  return new Blob([bytes],{type:"audio/wav"});
}
(window as any).runInternalTest = async () => {
  const notices: string[] = [];
  const engine = new InternalPlayer({
    resolve: async () => ({ url: "/probe-audio.json", trial: false }),
    load: async () => {
      if (!live) return wave();
      // A JSON transport avoids OS download managers intercepting a test media URL.
      const data = await (await fetch("/probe-audio.json")).json();
      const bytes = Uint8Array.from(atob(data.audio), (letter) => letter.charCodeAt(0));
      return new Blob([bytes], { type: "audio/mpeg" });
    },
    notice: (message) => notices.push(message),
  });
  engine.setVolume(0);
  const external = { supported:false, state:{...EMPTY_NOW_PLAYING}, on:()=>()=>{},start(){},stop(){},
    async play(){return false;},async pause(){return false;},async toggle(){return false;},async next(){return false;},async prev(){return false;},async seek(){return false;} };
  const provider = new CombinedNowPlayingProvider(external,engine);
  const meta = { albumId:1,name:live ? "真实 MP3 解码验证" : "插件内播放测试",artist:"Music Wall",cover:"",trackCount:2,
    tracks:[{id:11,name:"第一首",duration:3000},{id:12,name:"第二首",duration:3000}] };
  const app = { vault:{on:()=>({})},workspace:{on:()=>({})} };
  const plugin = {
    settings:{...DEFAULT_SETTINGS,playbackMode:"internal"},internalPlayer:engine,nowPlaying:provider,
    ensureNowPlayingStarted(){},async ensureNeteaseLogin(){return true;},
    getPlaybackDeps:()=>({isDesktop:false, request:async()=>{throw Error("No playlist requests allowed");},
      playInside:(album: any,index: number)=>engine.playAlbum(album,index)}),
    async scanWallItems(){return [{albumId:1,meta}];},async findAlbumWall(){return null;},async saveData(){},
  };
  const player = new MusicPlayerView(new WorkspaceLeaf(app),plugin as never);
  (player as any).file = new TFile("Player.mwp");
  document.getElementById("mount")!.appendChild(player.contentEl);
  try {
    check(await engine.playAlbum(meta),"Real audio decoder starts playback");
    await player.onOpen(); await wait(150);
    check(engine.state.status === "playing","Internal playback state is playing");
    await until(()=>engine.state.positionMs > 0);
    check(engine.state.positionMs > 0,"Audio timeline advances");
    check(!player.contentEl.querySelector(".mw-np__timeline")!.classList.contains("is-hidden"),"Progress controls are visible");
    check(player.contentEl.querySelectorAll(".mw-np__track.is-playable").length === 2,"Album tracks can be selected");
    await engine.pause(); check(engine.state.status === "paused","Pause works with real audio");
    const position = engine.state.positionMs; await wait(100);
    check(Math.abs(engine.state.positionMs-position)<50,"Paused timeline stays still");
    check(await engine.seek(500),"Seeking is supported");
    await engine.play(); check(engine.state.status === "playing","Resume works");
    if (!live) {
      await engine.seek(2900); await until(()=>engine.index === 1 && engine.state.status === "playing");
      check(engine.index === 1,"Track end automatically advances the queue");
      player.contentEl.querySelector<HTMLElement>(".mw-np__track.is-playable")!.click();
      await until(()=>engine.index === 0 && engine.state.status === "playing");
      check(engine.index === 0,"Clicking a track starts that track");
    }
    await player.onClose(); check(engine.state.status === "playing","Closing the view keeps the global player running");
    engine.stop(); check(!engine.state.active && !engine.album,"Stop clears audio and the temporary queue");
    check(notices.length === 0,"Playback completes without errors");
    document.title = failed.length ? "FAIL:" + failed.join("|") : "PASS:internal-audio";
  } catch(error) { document.title = "FAIL:" + (error as Error).message; }
  finally { provider.dispose(); }
};
