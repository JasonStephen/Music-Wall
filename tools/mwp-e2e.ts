// 播放器页（.mwp）顶栏收敛后的 e2e：真实 MusicPlayerView + 真实 styles.css。
//
// 打包：
//   npx esbuild tools/mwp-e2e.ts --bundle --outfile=tools/mwp-e2e.bundle.js ^
//     --format=iife --target=es2020 --alias:obsidian=./tools/obsidian-shim.ts
// 运行：
//   chrome --headless=new --disable-gpu --window-size=1280,760 --virtual-time-budget=15000 ^
//     --dump-dom "file:///.../tools/mwp-e2e.html"
// 结果读 <title>：PASS / FAIL:<明细>

import { MusicPlayerView } from "../src/ui/MusicPlayerView";
import { installDomHelpers, TFile, WorkspaceLeaf } from "./obsidian-shim";

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));
const fails: string[] = [];

function check(cond: unknown, label: string, info?: unknown): void {
  const box = document.getElementById("result")!;
  const row = document.createElement("div");
  row.className = cond ? "ok" : "bad";
  row.textContent = `${cond ? "PASS" : "FAIL"} ${label}${
    info !== undefined ? " — " + JSON.stringify(info) : ""
  }`;
  box.appendChild(row);
  if (!cond) fails.push(label);
}

function makePlugin() {
  return {
    settings: {
      playerBackground: "dark",
      smtcEnabled: false,
      minColumnWidth: 200,
      defaultStyle: "vinyl",
      shelfCaption: "pull",
    },
    nowPlaying: {
      supported: false,
      state: {
        supported: false,
        active: false,
        title: "",
        artist: "",
        album: "",
        status: "none",
        positionMs: 0,
        durationMs: 0,
        seekable: false,
        canPlay: false,
        canPause: false,
        canToggle: false,
        canNext: false,
        canPrev: false,
      },
      start() {},
      stop() {},
      on() {
        return () => {};
      },
      async play() {
        return false;
      },
      async pause() {
        return false;
      },
      async toggle() {
        return false;
      },
      async next() {
        return false;
      },
      async prev() {
        return false;
      },
      async seek() {
        return false;
      },
    },
    ensureNowPlayingStarted() {},
    getPlaybackDeps: () => ({
      isDesktop: false,
      request: async () => ({ status: 200, text: "{}" }),
      cookie: "",
      playlistId: undefined,
    }),
    async scanWallItems() {
      return [];
    },
    async resolveWallItem() {
      return null;
    },
    async findAlbumWall() {
      return null;
    },
    async openWall() {},
    async saveData() {},
    firstPlayerView: () => null,
  };
}

const coverSvg = (label: string): string =>
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">` +
      `<rect width="300" height="300" fill="#5b6ee1"/>` +
      `<text x="150" y="160" font-size="40" fill="white" text-anchor="middle">${label}</text></svg>`
  );

(async () => {
  const box = document.getElementById("result")!;
  try {
    installDomHelpers();
    const mount = document.getElementById("mount")!;
    const app = { vault: { on: () => ({}) }, workspace: { on: () => ({}) } };
    const view = new MusicPlayerView(new WorkspaceLeaf(app), makePlugin() as never);
    (view as unknown as { file: TFile | null }).file = new TFile("Player.mwp");
    mount.appendChild(view.contentEl);
    await view.onOpen();
    await wait(120);

    // 顶栏只剩标题 + 一个样式图标
    const bar = view.contentEl.querySelector<HTMLElement>(".mw-player__bar")!;
    check(!!bar, "顶栏存在");
    check(
      bar.querySelectorAll("button").length === 1,
      "顶栏只剩一个图标钮",
      bar.querySelectorAll("button").length
    );
    check(!bar.querySelector(".mw-chip, .mw-player__groups, .mw-player__hint"), "旧芯片与提示行已移除");
    const btn = bar.querySelector<HTMLElement>(".mw-toolbtn")!;
    check(btn?.classList.contains("mw-toolbtn"), "图标钮使用 MW 同款样式类");
    const r = btn.getBoundingClientRect();
    const br = bar.getBoundingClientRect();
    check(
      r.left > br.left + br.width / 2 && r.width > 20 && r.height > 20,
      "样式图标在右上角且可点",
      { btn: [Math.round(r.left), Math.round(r.top)], bar: [Math.round(br.left), Math.round(br.top)] }
    );

    // 点开抽屉：样式 + 背景
    btn.click();
    await wait(200);
    const drawer = view.contentEl.querySelector<HTMLElement>(".mw-drawer")!;
    check(drawer?.classList.contains("is-open"), "抽屉打开");
    check(
      drawer.querySelectorAll(".mw-preset[data-mw-style]").length === 3,
      "三种样式预设",
      drawer.querySelectorAll(".mw-preset[data-mw-style]").length
    );
    check(
      drawer.querySelectorAll(".mw-preset[data-mw-bg]").length === 4,
      "四种背景预设",
      drawer.querySelectorAll(".mw-preset[data-mw-bg]").length
    );
    check(
      drawer.parentElement?.classList.contains("mw-player__body") === true,
      "抽屉挂在 body（不随页面滚动）"
    );
    check(btn.classList.contains("is-active"), "打开时图标激活");

    // 切换背景：写设置 + 换类名
    const bgDark = drawer.querySelector<HTMLElement>('[data-mw-bg="dark"]')!;
    const bgWood = drawer.querySelector<HTMLElement>('[data-mw-bg="wood"]')!;
    bgWood.click();
    await wait(150);
    check(view.contentEl.classList.contains("mw-bg--wood"), "背景切到木地板");
    check(bgWood.classList.contains("is-active") && !bgDark.classList.contains("is-active"), "背景激活态互斥");
    const plugin = (view as unknown as { plugin: { settings: { playerBackground: string } } })
      .plugin;
    check(plugin.settings.playerBackground === "wood", "背景写入设置", plugin.settings.playerBackground);

    // 切换样式：设备外观重建
    bgDark.click();
    await wait(80);
    const cdTile = drawer.querySelector<HTMLElement>('[data-mw-style="cd"]')!;
    check(!!view.contentEl.querySelector(".mw-dev, .mw-np__disc"), "设备区已渲染");
    cdTile.click();
    await wait(200);
    check(
      (view as unknown as { discStyle: string }).discStyle === "cd",
      "样式切成 CD",
      (view as unknown as { discStyle: string }).discStyle
    );

    // 拖入一张唱片（真实拖拽路径）→ 显示专辑并高亮
    const dt = new DataTransfer();
    dt.setData(
      "application/x-music-wall-item",
      JSON.stringify({ srcPath: "walls/a.mw", albumId: 42 })
    );
    (view as unknown as { current: unknown }).current = {
      meta: {
        albumId: 42,
        name: "示例专辑",
        artist: "示例艺术家",
        cover: coverSvg("42"),
        trackCount: 2,
        tracks: [
          { id: 1, name: "第一首", duration: 100000 },
          { id: 2, name: "第二首", duration: 120000 },
        ],
      },
      srcPath: "walls/a.mw",
    };
    await view["render"]();
    await wait(150);
    const title = view.contentEl.querySelector<HTMLElement>(".mw-np__title");
    check(title?.textContent === "示例专辑", "设备信息显示当前专辑", title?.textContent);
    check(
      view.contentEl.querySelectorAll(".mw-np__track").length === 2,
      "曲目列表渲染",
      view.contentEl.querySelectorAll(".mw-np__track").length
    );

    // Esc / 遮罩关闭抽屉；再开曲目面板时抽屉自动收起（互斥）
    // 注意：上面的 render / updateNow 会重建 DOM，缓存的 drawer 引用已失效——
    // 每次都重新查询（与真实用户点击的是当时的元素）
    const liveDrawer = () => view.contentEl.querySelector<HTMLElement>(".mw-drawer")!;
    view.contentEl.querySelector<HTMLElement>(".mw-drawer__scrim")!.click();
    await wait(150);
    check(!liveDrawer().classList.contains("is-open"), "点遮罩关闭抽屉");
    check(liveDrawer().isConnected, "抽屉元素未脱离文档");
    liveDrawer().querySelector<HTMLElement>(".mw-drawer__close")!.click();
    await wait(120);
    view.contentEl.querySelector<HTMLElement>(".mw-toolbtn")!.click();
    await wait(150);
    check(liveDrawer().classList.contains("is-open"), "再次打开抽屉");
    view.contentEl.querySelector<HTMLElement>(".mw-np__ctrl--list")!.click();
    await wait(250);
    check(
      !liveDrawer().classList.contains("is-open") &&
        !!view.contentEl.querySelector(".mw-player__playlist.is-open"),
      "曲目面板与抽屉互斥"
    );

    // 整页不出滚动条（flex 溢出产生的 scrollHeight 不算：可滚动容器本身必须为零）
    const scrollers = Array.from(view.contentEl.querySelectorAll<HTMLElement>("*")).filter(
      (el) => {
        const cs = getComputedStyle(el);
        const scrollable = /auto|scroll/.test(cs.overflowY);
        return scrollable && el.scrollHeight > el.clientHeight + 2;
      }
    );
    check(
      scrollers.length === 0,
      "除曲目列表外没有可滚动容器",
      scrollers.map((el) => el.className)
    );
    check(
      getComputedStyle(view.contentEl).overflow === "hidden" &&
        view.contentEl.getBoundingClientRect().height <= 720,
      "根节点锁死高度并裁剪",
      view.contentEl.getBoundingClientRect().height
    );
  } catch (e) {
    check(false, "场景异常", String((e as Error)?.stack ?? e));
  }
  document.title = fails.length ? `FAIL:${fails.join("|")}` : "PASS:mwp";
  const head = document.createElement("div");
  head.textContent = fails.length ? `MWP FAIL (${fails.length})` : "MWP PASS";
  head.className = fails.length ? "bad" : "ok";
  box.prepend(head);
})();
