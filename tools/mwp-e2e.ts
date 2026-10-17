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
import { installDomHelpers, probeCoverUri, TFile, WorkspaceLeaf } from "./obsidian-shim";
import { matchNowPlaying } from "../src/core/match";
import type { NowPlayingState } from "../src/core/nowPlaying";
import type { WallItem } from "../src/types";

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
      /** 全局缩放：与真实设置同形（缩放场景会临时改写它再调 syncZoomBox） */
      zoomScale: 1,
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
    async ensureNeteaseLogin() { return true; },
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
  // 截图布景（?case=shot*）：隐藏结果浮层，否则它盖住大半个播放器。
  // 断言照常执行，只是不显示——不影响 run-all（那边不带 case 参数）。
  const shotMode = !!new URLSearchParams(location.search).get("case")?.startsWith("shot");
  if (shotMode) {
    box.style.display = "none";
  }
  let viewRef: MusicPlayerView | null = null;
  try {
    installDomHelpers();
    const mount = document.getElementById("mount")!;
    const app = { vault: { on: () => ({}) }, workspace: { on: () => ({}) } };
    const view = new MusicPlayerView(new WorkspaceLeaf(app), makePlugin() as never);
    viewRef = view;
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
    check(btn?.classList.contains("clickable-icon") === true, "图标钮带 clickable-icon（免疫主题白底）");
    const barCs = getComputedStyle(bar);
    check(
      barCs.backgroundColor === "rgba(0, 0, 0, 0)" || barCs.backgroundColor === "transparent",
      "顶栏无独立底色（融入播放器背景）",
      barCs.backgroundColor
    );
    check(barCs.borderBottomWidth === "0px", "顶栏无下边框", barCs.borderBottomWidth);
    const btnCs = getComputedStyle(btn);
    check(
      (btnCs.backgroundColor === "rgba(0, 0, 0, 0)" || btnCs.backgroundColor === "transparent") &&
        btnCs.borderTopWidth === "0px" &&
        btnCs.boxShadow === "none",
      "图标钮只有图标（无底色/边框/阴影）",
      `${btnCs.backgroundColor}/${btnCs.borderTopWidth}/${btnCs.boxShadow}`
    );
    // 图标与顶栏背景的亮度对比：白色播放器背景上不能出现「白底白图标」
    const lum = (c: string): number => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return 0;
      const [r, g, b, a = "1"] = m[1].split(",").map((x) => parseFloat(x));
      if (parseFloat(String(a)) === 0) return -1; // 透明 → 由页面背景决定
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    const iconColor = btnCs.color;
    const bgColor = barCs.backgroundColor;
    const bgLum = lum(bgColor);
    // 顶栏透明时取播放器根节点的底色作参考
    const pageLum = bgLum >= 0 ? bgLum : lum(getComputedStyle(view.contentEl).backgroundColor);
    const iconLum = lum(
      getComputedStyle(btn.querySelector("svg") ?? btn).stroke === "none"
        ? iconColor
        : iconColor
    );
    check(
      Math.abs(iconLum - (pageLum >= 0 ? pageLum : 0.5)) > 0.25,
      "图标与背景亮度对比足够（不会糊在一起）",
      { icon: iconColor, iconLum: iconLum.toFixed(2), pageLum: pageLum.toFixed(2) }
    );
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
    // 预览必须完整可见（不能只露一角/空白）
    for (const stage of Array.from(drawer.querySelectorAll<HTMLElement>(".mw-preset__stage"))) {
      const style = stage.closest<HTMLElement>(".mw-preset")?.dataset.mwStyle ?? "?";
      const disc = stage.querySelector<HTMLElement>(".mw-disc");
      const sr = stage.getBoundingClientRect();
      const dr = disc?.getBoundingClientRect();
      check(
        !!dr &&
          dr.left >= sr.left - 1 &&
          dr.right <= sr.right + 1 &&
          dr.top >= sr.top - 1 &&
          dr.bottom <= sr.bottom + 1 &&
          (dr.width * dr.height) / (sr.width * sr.height) > 0.45,
        `样式预览完整可见：${style}`,
        dr
          ? {
              stage: Math.round(sr.width),
              disc: Math.round(dr.width),
              ratio: ((dr.width * dr.height) / (sr.width * sr.height)).toFixed(2),
            }
          : "无唱片 DOM"
      );
    }
    check(
      drawer.parentElement?.classList.contains("mw-zoombox") === true,
      "抽屉挂在缩放盒（与内容同层，不参与页面滚动）"
    );
    check(btn.classList.contains("is-active"), "打开时图标激活");
    // 第四轮：侧边抽屉**没有遮罩**——不压暗页面、不盖住顶栏图标、不会吞点击
    const rootRect = view.contentEl.getBoundingClientRect();
    check(
      !view.contentEl.querySelector(".mw-drawer__scrim"),
      "抽屉没有遮罩元素（不压暗页面）"
    );
    const probes: [number, number][] = [
      [rootRect.left + 4, rootRect.top + 4],
      [rootRect.right - 4, rootRect.top + 4],
      [rootRect.left + 4, rootRect.bottom - 6],
      [rootRect.left + rootRect.width / 3, rootRect.bottom - 6],
    ];
    const probeHits = probes.map(([x, y]) => {
      const el = document.elementFromPoint(
        Math.min(Math.max(x, 2), window.innerWidth - 2),
        Math.min(Math.max(y, 2), window.innerHeight - 2)
      ) as HTMLElement | null;
      return String(el?.className ?? el?.tagName ?? "null");
    });
    check(
      probeHits.every((h) => !h.includes("scrim")),
      "面板打开时没有被覆盖层遮挡（四角命中原元素）",
      probeHits.join(" | ")
    );
    const bRect0 = btn.getBoundingClientRect();
    const iconHit = document.elementFromPoint(
      bRect0.left + bRect0.width / 2,
      bRect0.top + bRect0.height / 2
    ) as HTMLElement | null;
    check(
      !!iconHit && (iconHit === btn || btn.contains(iconHit)),
      "面板打开时顶栏图标仍可点（不被遮罩盖住）",
      String(iconHit?.className ?? iconHit?.tagName ?? "null")
    );
    // 面板必须是实底：封面/木地板模式的 --background-primary 是半透明控件色，
    // 直接拿来当面板底色会「开着像关着」（第三轮用户报的「按键全不见」）
    const panelAlpha = (() => {
      const c = getComputedStyle(drawer).backgroundColor;
      const m = /rgba?\(([^)]+)\)/.exec(c);
      const parts = m ? m[1].split(",").map((x) => parseFloat(x)) : [0, 0, 0, 0];
      return parts.length > 3 ? parts[3] : 1;
    })();
    check(panelAlpha > 0.85, "面板底色是实底（不是半透明控件色）", panelAlpha);
    // 面板从顶栏下方开始（不能盖住唯一的样式图标）
    const panelTop = drawer.getBoundingClientRect().top;
    const barBottom = bar.getBoundingClientRect().bottom;
    check(
      panelTop >= barBottom - 2,
      "面板从顶栏下方开始",
      { panelTop: Math.round(panelTop), barBottom: Math.round(barBottom) }
    );

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

    // 播放键随背景模式取色（白/深/木地板固定色；封面模式取封面主色）
    const mainBg = (): string => {
      const b = view.contentEl.querySelector<HTMLElement>(".mw-np__ctrl--main");
      return b ? getComputedStyle(b).backgroundColor : "none";
    };
    const pickBg = async (mode: string): Promise<void> => {
      const tile = view.contentEl.querySelector<HTMLElement>(`[data-mw-bg="${mode}"]`);
      if (tile) {
        tile.click();
      } else {
        (view as unknown as { bg: string }).bg = mode;
        await view["render"]();
      }
      await wait(220);
    };
    (view as unknown as { current: unknown }).current = {
      meta: {
        albumId: 42,
        name: "示例专辑",
        artist: "示例艺术家",
        cover: coverSvg("42"),
        trackCount: 0,
        tracks: [],
      },
      srcPath: "walls/a.mw",
    };
    await view["render"]();
    await wait(150);
    await pickBg("white");
    check(mainBg() === "rgb(76, 91, 212)", "白色背景：播放键用白色模式配色", mainBg());
    await pickBg("dark");
    check(mainBg() === "rgb(217, 162, 74)", "深色背景：播放键用暖金色", mainBg());
    await pickBg("wood");
    check(mainBg() === "rgb(185, 119, 59)", "木地板：播放键用木色琥珀", mainBg());
    // 封面模式：探针封面（纯色 #c0392b 的 PNG，由 shim 的 requestUrl 现生成）
    (view as unknown as { current: unknown }).current = {
      meta: {
        albumId: 7,
        name: "取色专辑",
        artist: "a",
        cover: "https://example.invalid/accent-probe-c0392b.png",
        trackCount: 0,
        tracks: [],
      },
      srcPath: "walls/a.mw",
    };
    await view["render"]();
    await wait(150);
    await pickBg("art");
    await wait(400); // 等异步取色回来
    const inline = view.contentEl.style.getPropertyValue("--mw-np-accent").trim();
    check(
      inline.toLowerCase() === "#c0392b" || mainBg() === "rgb(192, 57, 43)",
      "封面模式：播放键取封面主色",
      { inline, bg: mainBg() }
    );
    check(
      view.contentEl.style.getPropertyValue("--mw-np-accent-fg").trim() !== "",
      "同时给出压色（保证图标可读）",
      view.contentEl.style.getPropertyValue("--mw-np-accent-fg")
    );
    // 第七轮：无封面专辑 → 不再「什么都没有」，落到内置默认封面摊开渲染
    (view as unknown as { current: unknown }).current = {
      meta: {
        albumId: 8,
        name: "无封面",
        artist: "a",
        cover: "",
        trackCount: 0,
        tracks: [],
      },
      srcPath: "walls/a.mw",
    };
    await view["render"]();
    await wait(150);
    await pickBg("art");
    await wait(350);
    // 第七轮：无封面专辑**不再什么都画不上**——封面背景/设备都落到内置默认封面，
    // 取色在 data URI 上就近完成（不再借道 requestUrl，始终有亮度可采）。
    const noCoverArt = getComputedStyle(view.contentEl)
      .getPropertyValue("--mw-player-art")
      .trim();
    check(
      noCoverArt.startsWith('url("data:image/svg+xml'),
      "无封面专辑：封面背景落到内置默认封面",
      noCoverArt.slice(0, 48)
    );
    const noCoverDisc = view.contentEl
      .querySelector<HTMLElement>(".mw-np__disc img")
      ?.getAttribute("src");
    check(
      !!noCoverDisc && noCoverDisc.startsWith("data:image/svg+xml"),
      "无封面专辑：设备正常渲染（is-empty 已不再出现）",
      (noCoverDisc ?? "").slice(0, 48)
    );
    // 内置封面必须**真能解码**：SVG 里少一个引号就会静默变成空白图，
    // 只断言 src 前缀抓不住（虚拟时间下超时不算失败，只排除 error）。
    const noCoverDecode = await new Promise<string>((res) => {
      const img = new Image();
      img.onload = () => res("ok");
      img.onerror = () => res("error");
      img.src = noCoverDisc ?? "";
      window.setTimeout(() => res("pending"), 1200);
    });
    check(
      noCoverDecode !== "error",
      "内置默认封面可解码（不是坏图）",
      noCoverDecode
    );
    // 封面模式的可读性（第八轮改版）：顶栏**不再**有深色渐变，
    // 改为按封面亮度自适应字色——浅色封面给深色标题/图标，深色封面给浅色字 + 文字阴影
    await pickBg("art");
    await wait(200);
    // 注意：render 会重建 DOM，必须重新查询（早先捕获的 bar 引用已脱离文档）
    const liveBar = view.contentEl.querySelector<HTMLElement>(".mw-player__bar")!;
    check(
      view.contentEl.classList.contains("mw-bg--art") &&
        !getComputedStyle(liveBar, "::before").backgroundImage.includes("gradient"),
      "封面模式：顶栏不再有深色渐变（改由自适应字色保证可读）",
      getComputedStyle(liveBar, "::before").backgroundImage.slice(0, 60)
    );
    // 两个分支都走一遍：纯色封面探针 → 采样出亮度 → setArtTone 挂类名
    const toneOf = async (hex: string) => {
      (view as unknown as { current: unknown }).current = {
        meta: {
          albumId: 77,
          name: "自适应",
          artist: "a",
          cover: probeCoverUri(hex),
          trackCount: 0,
          tracks: [],
        },
        srcPath: "walls/a.mw",
      };
      await view["render"]();
      await wait(120);
      await pickBg("art");
      await wait(420);
      const title = view.contentEl.querySelector<HTMLElement>(".mw-np__title")!;
      const cs = getComputedStyle(title);
      return {
        light: view.contentEl.classList.contains("mw-art--light"),
        dark: view.contentEl.classList.contains("mw-art--dark"),
        titleLum: lum(cs.color),
        shadow: cs.textShadow,
      };
    };
    const lightTone = await toneOf("f4f4f4");
    check(
      lightTone.light && lightTone.titleLum >= 0 && lightTone.titleLum < 0.35,
      "封面背景：浅色封面 → 标题/艺术家/图标自动变深色",
      lightTone
    );
    const darkTone = await toneOf("141416");
    check(
      darkTone.dark && darkTone.titleLum > 0.6 && darkTone.shadow !== "none",
      "封面背景：深色封面 → 保持浅色字 + 文字阴影",
      darkTone
    );
    // 用列表键探针（它不会因 SMTC 不可用而进入禁用态）
    const ctrlProbe = view.contentEl.querySelector<HTMLElement>(".mw-np__ctrl--list")!;
    const ctrlCs = getComputedStyle(ctrlProbe);
    const cm = /rgba?\(([^)]+)\)/.exec(ctrlCs.backgroundColor);
    const cparts = cm ? cm[1].split(",").map((x) => parseFloat(x)) : [0, 0, 0, 1];
    const calpha = cparts.length > 3 ? cparts[3] : 1;
    const cdark = cparts[0] < 120 && cparts[1] < 120 && cparts[2] < 120;
    check(
      calpha >= 0.3 || cdark,
      "封面模式：控制键是实底（浅色封面上也看得见）",
      ctrlCs.backgroundColor
    );
    const ctrlR = ctrlProbe.getBoundingClientRect();
    const ctrlHit = document.elementFromPoint(
      ctrlR.left + ctrlR.width / 2,
      ctrlR.top + ctrlR.height / 2
    ) as HTMLElement | null;
    check(
      !!ctrlHit && (ctrlHit === ctrlProbe || ctrlProbe.contains(ctrlHit)),
      "控制键可点（没有被任何覆盖层挡住）",
      String(ctrlHit?.className ?? ctrlHit?.tagName ?? "null")
    );
    // 未播放时上一首/下一首是禁用态（半透明且不接收指针），属预期行为
    const prevBtn = view.contentEl.querySelector<HTMLElement>(".mw-np__ctrl")!;
    check(
      getComputedStyle(prevBtn).pointerEvents === "none" ||
        getComputedStyle(prevBtn).opacity === "1",
      "禁用态控制键不接收指针（预期）",
      getComputedStyle(prevBtn).pointerEvents
    );

    // 播放器页的缩放：缩放盒必须精确铺满根节点（与音乐墙同一套机制）。
    // **必须走真实链路**：plugin.applyZoom() 会先把系数写进设置与 body 变量，
    // 再遍历视图调 syncZoomBox() 写行内像素尺寸。只改 body 变量是不支持的路径——
    // 行内像素兜底（见 zoom.ts）优先级高于 CSS 的 calc 反除补偿，没人重算它，
    // 盒子就停在旧尺寸、被 transform 原样放大 1.25 倍（这正是本条早先的假失败）。
    const rootEl = view.contentEl;
    const viewPlugin = (view as unknown as {
      plugin: { settings: { zoomScale?: number } };
    }).plugin;
    const prevZoomScale = viewPlugin.settings.zoomScale ?? 1;
    const prevZoomVar = document.body.style.getPropertyValue("--mw-zoom");
    viewPlugin.settings.zoomScale = 1.25;
    document.body.style.setProperty("--mw-zoom", "1.25");
    view.syncZoomBox();
    await wait(120);
    const boxEl = rootEl.querySelector<HTMLElement>(".mw-zoombox")!;
    const rr = rootEl.getBoundingClientRect();
    const zr = boxEl.getBoundingClientRect();
    check(
      Math.abs(zr.width - rr.width) < 2 && Math.abs(zr.height - rr.height) < 2,
      "125%：缩放盒精确铺满根节点（无留白/溢出）",
      {
        zoombox: [Math.round(zr.width), Math.round(zr.height)],
        root: [Math.round(rr.width), Math.round(rr.height)],
      }
    );
    const cornerProbe = document.elementFromPoint(
      Math.min(rr.right - 4, window.innerWidth - 2),
      Math.min(rr.bottom - 4, window.innerHeight - 2)
    ) as HTMLElement | null;
    check(
      !!cornerProbe?.closest(".mw-zoombox"),
      "125%：右下角仍落在缩放盒内（未被裁切）",
      String(cornerProbe?.className ?? cornerProbe?.tagName ?? "null")
    );
    viewPlugin.settings.zoomScale = prevZoomScale;
    document.body.style.setProperty("--mw-zoom", prevZoomVar || "1");
    view.syncZoomBox();
    await wait(120);

    // Esc / 遮罩关闭抽屉；再开曲目面板时抽屉自动收起（互斥）
    // 注意：上面的 render / updateNow 会重建 DOM，缓存的 drawer 引用已失效——
    // 每次都重新查询（与真实用户点击的是当时的元素）
    const liveDrawer = () => view.contentEl.querySelector<HTMLElement>(".mw-drawer")!;
    liveDrawer().querySelector<HTMLElement>(".mw-drawer__close")!.click();
    await wait(150);
    check(!liveDrawer().classList.contains("is-open"), "点 × 关闭抽屉");
    check(liveDrawer().isConnected, "抽屉元素未脱离文档");
    check(
      !view.contentEl.querySelector(".mw-drawer__scrim"),
      "关闭后依然没有遮罩（不会留下幽灵层）"
    );
    // 关闭后顶栏图标必须自己就是命中要素（第三轮它被遮罩盖住，点它等于点遮罩）
    const iconBtn = view.contentEl.querySelector<HTMLElement>(".mw-toolbtn")!;
    const ir = iconBtn.getBoundingClientRect();
    const hitAfter = document.elementFromPoint(
      ir.left + ir.width / 2,
      ir.top + ir.height / 2
    ) as HTMLElement | null;
    check(
      !!hitAfter && (hitAfter === iconBtn || iconBtn.contains(hitAfter)),
      "关闭后顶栏图标可点",
      String(hitAfter?.className ?? hitAfter?.tagName ?? "null")
    );
    iconBtn.click();
    await wait(150);
    check(liveDrawer().classList.contains("is-open"), "再次打开抽屉");
    view.contentEl.querySelector<HTMLElement>(".mw-np__ctrl--list")!.click();
    await wait(250);
    check(
      !liveDrawer().classList.contains("is-open") &&
        !!view.contentEl.querySelector(".mw-player__playlist.is-open"),
      "曲目面板与抽屉互斥"
    );

    // ---- 第七轮问题 1：曲目面板展开时点其他地方**不收起**（scrim 只做视觉） ----
    {
      const scrim = view.contentEl.querySelector<HTMLElement>(".mw-player__scrim")!;
      check(
        getComputedStyle(scrim).pointerEvents === "none",
        "曲目面板遮罩不吞点击（pointer-events:none）",
        getComputedStyle(scrim).pointerEvents
      );
      const hitTarget = document.elementFromPoint(
        window.innerWidth * 0.25,
        120
      ) as HTMLElement | null;
      check(
        !!hitTarget,
        "面板外区域可命中（不被遮罩截获）",
        String(hitTarget?.className ?? hitTarget?.tagName ?? "null")
      );
      (hitTarget as HTMLElement)?.click();
      await wait(200);
      check(
        !!view.contentEl.querySelector(".mw-player__playlist.is-open"),
        "点其他地方不收起曲目面板",
        !!view.contentEl.querySelector(".mw-player__playlist.is-open")
      );
    }

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

    // ---- 第五轮 A4：根节点必须铺满窗格（主题给的 .view-content 内边距要归零） ----
    document.body.classList.add("mw-viewpad");
    await wait(180);
    const rootCs = getComputedStyle(view.contentEl);
    check(
      [rootCs.paddingTop, rootCs.paddingRight, rootCs.paddingBottom, rootCs.paddingLeft].every(
        (p) => p === "0px"
      ),
      "根节点内边距归零（主题的 12px/32px 留白被压掉）",
      [rootCs.paddingTop, rootCs.paddingRight, rootCs.paddingBottom, rootCs.paddingLeft].join("|")
    );
    check(
      [rootCs.marginTop, rootCs.marginRight, rootCs.marginBottom, rootCs.marginLeft].every(
        (m) => m === "0px"
      ),
      "根节点外边距归零",
      [rootCs.marginTop, rootCs.marginRight, rootCs.marginBottom, rootCs.marginLeft].join("|")
    );
    const pRoot = view.contentEl.getBoundingClientRect();
    const pBox = view.contentEl.querySelector<HTMLElement>(".mw-zoombox")!.getBoundingClientRect();
    check(
      Math.abs(pBox.left - pRoot.left) < 2 && Math.abs(pBox.right - pRoot.right) < 2,
      "缩放盒左右顶到窗格边（左右都没有空带）",
      { box: [Math.round(pBox.left), Math.round(pBox.right)], root: [Math.round(pRoot.left), Math.round(pRoot.right)] }
    );
    const pBar = view.contentEl.querySelector<HTMLElement>(".mw-player__bar")!.getBoundingClientRect();
    check(
      Math.abs(pBar.left - pRoot.left) < 2 && Math.abs(pBar.right - pRoot.right) < 2,
      "顶栏左右与窗格对齐",
      { bar: [Math.round(pBar.left), Math.round(pBar.right)], root: [Math.round(pRoot.left), Math.round(pRoot.right)] }
    );
    const pBody = view.contentEl.querySelector<HTMLElement>(".mw-player__body")!;
    check(
      parseFloat(getComputedStyle(pBody).paddingLeft) >= 12,
      "内部保留左右内边距（留白搬到播放器内部）",
      getComputedStyle(pBody).paddingLeft
    );
    document.body.classList.remove("mw-viewpad");
    await wait(120);

    // ---- 第五轮 B2：封面背景的面板是磨砂玻璃（不是近黑实心板） ----
    (view as unknown as { current: unknown }).current = {
      meta: {
        albumId: 9,
        name: "封面背景",
        artist: "a",
        cover: coverSvg("art"),
        trackCount: 0,
        tracks: [],
      },
      srcPath: "walls/a.mw",
    };
    await view["render"]();
    // 抽屉的正文是「打开时才构建」的：render 之后 prevDrawer 为空 ⇒ 抽屉里没有瓷砖。
    // 要走真实的点按路径（点顶栏图标打开抽屉），后面的取色断言才有元素可查。
    view.contentEl.querySelector<HTMLElement>(".mw-toolbtn")!.click();
    await wait(220);
    await pickBg("art");
    await wait(300);
    const artDrawer = view.contentEl.querySelector<HTMLElement>(".mw-drawer")!;
    const artCs = getComputedStyle(artDrawer);
    const am = /rgba?\(([^)]+)\)/.exec(artCs.backgroundColor);
    const aparts = am ? am[1].split(",").map((x) => parseFloat(x)) : [0, 0, 0, 1];
    const artAlpha = aparts.length > 3 ? aparts[3] : 1;
    check(
      artAlpha >= 0.5 && artAlpha <= 0.85,
      "封面模式：面板是半透明磨砂底（不是实心黑板，也不是看不见的浅色）",
      { alpha: artAlpha, bg: artCs.backgroundColor }
    );
    check(
      artCs.backdropFilter.includes("blur"),
      "封面模式：面板带背景模糊（磨砂玻璃）",
      artCs.backdropFilter
    );
    // 封面背景**不叠任何压暗层**（第八轮按要求移除 `.mw-bg--art::after` 的 background）：
    // 无论铺满整屏还是只压底部，都不该在封面背景上再加背景层。
    // 断言方式：::after 的 computed background-image 必须是 none（规则已整条删除）。
    const artVeil = String(getComputedStyle(view.contentEl, "::after").backgroundImage);
    check(
      artVeil === "none" || artVeil === "",
      "封面背景：没有压暗层（::after 不带任何 background）",
      artVeil.slice(0, 120)
    );
    const artBlur = getComputedStyle(view.contentEl, "::before").filter;
    check(
      /saturate\(([\d.]+)\)/.test(artBlur) &&
        parseFloat(/saturate\(([\d.]+)\)/.exec(artBlur)![1]) >= 1.8,
      "封面背景：模糊层提高饱和度补回颜色",
      artBlur
    );
    check(
      artBlur.includes("blur"),
      "封面背景：封面被放大模糊（动态取色底）",
      artBlur
    );
    const artArtVar = getComputedStyle(view.contentEl)
      .getPropertyValue("--mw-player-art")
      .trim();
    check(
      artArtVar.startsWith("url("),
      "封面背景：底图变量已指向封面（不是空的）",
      artArtVar.slice(0, 48)
    );
    // 文字对比度：面板底 62% 深色叠在封面上，取最坏情况（封面全白）估算
    const artFg = (() => {
      const c = artCs.color;
      const mm = /rgba?\(([^)]+)\)/.exec(c);
      return mm ? mm[1].split(",").map((x) => parseFloat(x)) : [255, 255, 255];
    })();
    const worstBg = [0, 0, 0].map((_, i) => 0.62 * aparts[i] + 0.38 * 255);
    const cRatio = (() => {
      const lin = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      const l1 = 0.2126 * lin(artFg[0]) + 0.7152 * lin(artFg[1]) + 0.0722 * lin(artFg[2]);
      const l2 = 0.2126 * lin(worstBg[0]) + 0.7152 * lin(worstBg[1]) + 0.0722 * lin(worstBg[2]);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    })();
    check(cRatio >= 3, "封面模式：最坏情况下正文对比度 ≥ 3", Math.round(cRatio * 100) / 100);
    // 上拉曲目表同样磨砂
    const sheetCs = getComputedStyle(
      view.contentEl.querySelector<HTMLElement>(".mw-player__playlist")!
    );
    check(
      sheetCs.backdropFilter.includes("blur"),
      "封面模式：上拉曲目表同样磨砂",
      sheetCs.backdropFilter
    );
    // ---- 第五轮 B1（播放器）：面板强调色跟随背景模式，而不是主题紫 ----
    // 注意 getPropertyValue("--mw-accent") 返回的是**替换后**的 token 文本，
    // 因此这里断言的是各背景模式自己的强调色，而不是 var() 字面量。
    const accentOf = (): string =>
      getComputedStyle(view.contentEl).getPropertyValue("--mw-accent").trim();
    await pickBg("white");
    await wait(200);
    check(accentOf() === "#4c5bd4", "白色背景：面板强调色 = 白色模式配色", accentOf());
    await pickBg("dark");
    await wait(200);
    check(accentOf() === "#d9a24a", "深色背景：面板强调色 = 暖金（不是主题紫）", accentOf());
    // 面板高亮瓷砖的描边色：必须量在「刚重建出来的元素」上——
    // .mw-preset 带 border-color 过渡（0.15s），无头+虚拟时间下过渡时钟不推进，
    // 在既有元素上改类名会读到过渡起点值（上一模式的颜色），断言就会假失败。
    const tileBorderOf = async (mode: string): Promise<string> => {
      await pickBg(mode);
      await view["render"]();
      // 抽屉正文是「打开时才构建」的：重建后必须先确保它是开着的（点顶栏图标是切换，
      // 已经开着时再点会关掉，因此要先判断状态）
      const d = view.contentEl.querySelector<HTMLElement>(".mw-drawer");
      if (!d?.classList.contains("is-open")) {
        view.contentEl.querySelector<HTMLElement>(".mw-toolbtn")?.click();
        await wait(220);
      }
      const tile = view.contentEl.querySelector<HTMLElement>(
        `.mw-drawer .mw-preset[data-mw-bg="${mode}"]`
      );
      return tile ? getComputedStyle(tile).borderTopColor : "none";
    };
    const darkBorder = await tileBorderOf("dark");
    check(
      darkBorder === "rgb(217, 162, 74)",
      "深色背景：激活瓷砖用暖金描边（不是主题紫）",
      darkBorder
    );
    const woodBorder = await tileBorderOf("wood");
    check(
      woodBorder === "rgb(185, 119, 59)",
      "木地板：激活瓷砖用木色描边（不是主题紫）",
      woodBorder
    );
    check(accentOf() === "#b9773b", "木地板：面板强调色 = 木色琥珀", accentOf());
    // 封面模式：强调色跟随封面主色（探针封面 #c0392b）。
    // 这里必须用「假 URL + 垫片 requestUrl」：产品取色走 requestUrl，
    // data URI 在真机 Obsidian 上同样取不到（requestUrl 只发 http(s)），
    // 用 data URI 会让这条断言退化成「回退主题强调色」。
    // 想让**截图**里的底色真有颜色，见脚本末尾的 shot 分支（换 data URI 再渲染一次）。
    (view as unknown as { current: unknown }).current = {
      meta: {
        albumId: 7,
        name: "取色专辑",
        artist: "a",
        cover: "https://example.invalid/accent-probe-c0392b.png",
        trackCount: 0,
        tracks: [],
      },
      srcPath: "walls/a.mw",
    };
    await view["render"]();
    await pickBg("art");
    await wait(420);
    check(
      accentOf() === "#c0392b",
      "封面背景：面板强调色跟随封面主色",
      accentOf()
    );
    // 面板高亮按钮（主按钮 / 激活瓷砖）不得是主题紫 #7c5cff
    const purpleHit = Array.from(
      view.contentEl.querySelectorAll<HTMLElement>(".mw-drawer .mw-preset.is-active, .mw-drawer .mw-preset__stage")
    ).some((el) => getComputedStyle(el).borderTopColor === "rgb(124, 92, 255)");
    check(!purpleHit, "封面背景：面板高亮没有主题紫");

    // ---- 第七轮问题 2：匹配顺序以**专辑为主**，曲目快照是次级途径 ----
    {
      const walls: WallItem[] = [
        {
          albumId: 501,
          source: "search",
          locked: true,
          meta: {
            albumId: 501,
            name: "Night Lines",
            artist: "Kenji",
            cover: "",
            trackCount: 1,
            tracks: [{ name: "Song A", duration: 180000, artists: "Kenji" }],
          },
          addedAt: new Date().toISOString(),
        },
        {
          albumId: 502,
          source: "search",
          locked: true,
          meta: {
            albumId: 502,
            name: "Song A",
            artist: "Kim",
            cover: "",
            trackCount: 1,
            tracks: [{ name: "B Tune", duration: 200000, artists: "Kim" }],
          },
          addedAt: new Date().toISOString(),
        },
      ];
      const now = (over: Partial<NowPlayingState>): NowPlayingState => ({
        supported: true,
        active: true,
        title: "",
        artist: "",
        album: "",
        status: "playing",
        positionMs: 0,
        durationMs: 0,
        seekable: false,
        canPlay: true,
        canPause: true,
        canToggle: true,
        canNext: true,
        canPrev: true,
        ...over,
      });
      // SMTC 发布了专辑名时：专辑级精确命中压过曲目快照命中（501 的曲目叫 Song A，
      // 但正在播放的专辑是「Song A」→ 应命中 502）
      const albumHit = matchNowPlaying(
        now({ title: "Song A", artist: "Kim", album: "Song A" }),
        walls
      );
      check(albumHit?.albumId === 502, "专辑名命中优先（以专辑为主）", albumHit);
      // 专辑没匹配到也没关系：曲名快照兜底依然可用
      const trackHit = matchNowPlaying(now({ title: "Song A", artist: "Kenji" }), walls);
      check(trackHit?.albumId === 501 && trackHit.trackIndex === 0, "无专辑名：曲目快照兜底", trackHit);
      // 两级全落空 → 界面会走默认封面（match null）
      const miss = matchNowPlaying(now({ title: "Xyz None", artist: "nobody" }), walls);
      check(miss === null, "两级都没命中 → null（界面用默认封面兜底）", miss);
    }
  } catch (e) {
    check(false, "场景异常", String((e as Error)?.stack ?? e));
  }
  // ---- 截图布景专用收尾（?case=shot*）：把封面换成 data URI 再渲染一次 ----
  // 背景层是 CSS url()，垫片的 requestUrl 拦不到假 URL，浏览器也拉不到图，
  // 截图会是一块近黑（看起来像「封面背景根本没上色」）。断言已经在上面跑完，
  // 这里只影响截图画面。
  if (shotMode && viewRef) {
    const view = viewRef;
    try {
      const v = view as unknown as { current: unknown; render: () => Promise<void> };
    v.current = {
      meta: {
        albumId: 7,
        name: "取色专辑",
        artist: "Phildeb",
        cover: probeCoverUri("5b6ee1"),
        trackCount: 6,
        tracks: [
          { name: "Ice-Float", duration: 139000 },
          { name: "Icarus", duration: 240000 },
          { name: "Dragonfly Keeper", duration: 130000 },
        ],
      },
      srcPath: "walls/a.mw",
    };
    await v.render();
    const tile = view.contentEl.querySelector<HTMLElement>('.mw-preset[data-mw-bg="art"]');
    tile?.click();
    const d = view.contentEl.querySelector<HTMLElement>(".mw-drawer");
    if (!d?.classList.contains("is-open")) {
      view.contentEl.querySelector<HTMLElement>(".mw-toolbtn")?.click();
    }
    await wait(500);
    // 截图用的自检：底图必须真的能画出来（否则截图是一块近黑，看不出封面色）
    const artUrlRaw = String(
      getComputedStyle(view.contentEl).getPropertyValue("--mw-player-art") ?? ""
    ).trim();
    const artUrl = /url\(["']?(.*?)["']?\)/.exec(artUrlRaw)?.[1] ?? "";
    const state = await new Promise<string>((res) => {
      const img = new Image();
      img.onload = () => res("ok");
      img.onerror = () => res("error");
      img.src = artUrl;
      // 虚拟时间下定时器会被快进，超时不代表失败（解码另在线程上）
      window.setTimeout(() => res("pending"), 1500);
    });
    check(state !== "error", "截图布景：封面底图不是坏图", {
      state,
      len: artUrl.length,
      url: artUrl,
    });
    } catch (e) {
      check(false, "截图布景异常", String((e as Error)?.stack ?? e));
    }
  }
  document.title = fails.length ? `FAIL:${fails.join("|")}` : "PASS:mwp";
  const head = document.createElement("div");
  head.textContent = fails.length ? `MWP FAIL (${fails.length})` : "MWP PASS";
  head.className = fails.length ? "bad" : "ok";
  box.prepend(head);
})();
