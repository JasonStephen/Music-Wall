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
    // 取不到封面（请求失败）→ 不写行内变量，回退 CSS 的强调色
    (view as unknown as { current: unknown }).current = {
      meta: {
        albumId: 8,
        name: "无封面",
        artist: "a",
        cover: "https://example.invalid/nope.png",
        trackCount: 0,
        tracks: [],
      },
      srcPath: "walls/a.mw",
    };
    await view["render"]();
    await wait(150);
    await pickBg("art");
    await wait(350);
    check(
      view.contentEl.style.getPropertyValue("--mw-np-accent").trim() === "",
      "取色失败：回退主题强调色（不残留行内值）",
      view.contentEl.style.getPropertyValue("--mw-np-accent")
    );
    // 封面模式的可读性：顶栏有局部深色渐变、控制键有深色半透明底（不是透明圆 + 淡描边）
    await pickBg("art");
    await wait(200);
    // 注意：render 会重建 DOM，必须重新查询（早先捕获的 bar 引用已脱离文档）
    const liveBar = view.contentEl.querySelector<HTMLElement>(".mw-player__bar")!;
    check(
      view.contentEl.classList.contains("mw-bg--art") &&
        getComputedStyle(liveBar, "::before").backgroundImage.includes("gradient"),
      "封面模式：顶栏有一条局部深色渐变（保证图标/标题可读）",
      getComputedStyle(liveBar, "::before").backgroundImage.slice(0, 60)
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

    // 播放器页的缩放：缩放盒必须精确铺满根节点（与音乐墙同一套机制）
    const rootEl = view.contentEl;
    const prevZoom = document.body.style.getPropertyValue("--mw-zoom");
    document.body.style.setProperty("--mw-zoom", "1.25");
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
    document.body.style.setProperty("--mw-zoom", prevZoom || "1");
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
