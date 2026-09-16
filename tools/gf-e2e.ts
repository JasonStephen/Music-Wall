// 开盒详情 e2e：把真实 MusicWallView + 真实 styles.css 跑在无头 Edge 里，
// 对第二轮修复做自动化断言（封面 z 序/盘面切换与播放/中断收盒/相机回位/图标钮重置/排队）。
//
// 打包（仓库根目录执行）：
//   npx esbuild tools/gf-e2e.ts --bundle --outfile=tools/gf-e2e.bundle.js ^
//     --format=iife --target=es2020 --alias:obsidian=./tools/obsidian-shim.ts
// 运行（逐场景）：
//   msedge --headless=new --disable-gpu --window-size=1280,760 --virtual-time-budget=15000 ^
//     --dump-dom "file:///E:/Project/Obsidian%20Plugin/Music%20Wall/tools/gf-e2e.html?case=swap"
// 结果读 <title>：PASS:<case> 或 FAIL:<case>:<明细>（断言行在 #result）。

import { MusicWallView } from "../src/ui/MusicWallView";
import { installDomHelpers, MENU_LOG, TFile, WorkspaceLeaf } from "./obsidian-shim";

declare global {
  interface Window {
    __playLog: string[];
    __fails: string[];
  }
}

let view: MusicWallView;
let grid: HTMLElement;

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeout = 10000, label = "waitFor"): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (pred()) return true;
    await wait(40);
  }
  result(false, `${label}（${timeout}ms 超时）`);
  return false;
}

function result(pass: boolean, label: string, info?: unknown): void {
  window.__fails = window.__fails ?? [];
  const box = document.getElementById("result")!;
  const row = document.createElement("div");
  row.className = pass ? "ok" : "bad";
  row.textContent = `${pass ? "PASS" : "FAIL"} ${label}${info !== undefined ? " — " + safe(info) : ""}`;
  box.appendChild(row);
  if (!pass) window.__fails.push(label);
}

function safe(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}

function finalize(caseName: string): void {
  const fails = window.__fails ?? [];
  const head = document.createElement("div");
  head.textContent = fails.length ? `CASE ${caseName} FAIL (${fails.length})` : `CASE ${caseName} PASS`;
  head.className = fails.length ? "bad" : "ok";
  document.getElementById("result")!.prepend(head);
  document.title = fails.length ? `FAIL:${caseName}:${fails.join("|")}` : `PASS:${caseName}`;
  document.documentElement.dataset.e2eDone = "1";
}

// ---- 测试数据 ----

function coverSvg(hue: number, label: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hue},70%,55%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},70%,30%)"/>` +
    `</linearGradient></defs>` +
    `<rect width="300" height="300" fill="url(#g)"/>` +
    `<text x="150" y="158" font-size="40" fill="white" text-anchor="middle" font-family="serif">${label}</text></svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function makeData(count: number) {
  const tracks = [
    { id: 101, name: "Inspirational Shimmering", duration: 137000 },
    { id: 102, name: "Hopeful Solutions", duration: 154000 },
    { id: 103, name: "Quiet Momentum", duration: 121000 },
  ];
  return {
    version: 1,
    name: "Epics",
    style: "vinyl" as const,
    layout: "shelf" as const,
    items: Array.from({ length: count }, (_, i) => ({
      albumId: i + 1,
      source: "search" as const,
      locked: true,
      addedAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      meta: {
        albumId: i + 1,
        name: i === 6 ? "Feel Alive" : `Album ${String(i + 1).padStart(2, "0")}`,
        artist: "lumine wave",
        cover: coverSvg((i * 37) % 360, String(i + 1)),
        trackCount: 3,
        year: "2024",
        tracks,
      },
    })),
  };
}

function makeApp() {
  return {
    vault: {
      on: () => ({}),
      getAbstractFileByPath: () => null,
      read: async () => "{}",
      modify: async () => undefined,
    },
    workspace: { on: () => ({}), getLeavesOfType: () => [], revealLeaf() {} },
    fileManager: { renameFile: async () => undefined },
  };
}

function makePlugin() {
  return {
    settings: {
      gitRepoUrl: "",
      gitBranch: "",
      gitSubdir: "",
      minColumnWidth: 200,
      defaultStyle: "vinyl",
      neteaseCookie: "",
      playbackPlaylistId: "",
      mobileNoticeShown: true,
      shelfCaption: "always",
      zoomScale: 1,
    },
    getPlaybackDeps: () => ({
      isDesktop: false,
      request: async () => ({ status: 200, text: "{}", json: {} }),
      cookie: "",
      playlistId: undefined,
    }),
    wallFiles: () => [] as TFile[],
    migrateItemInto: async () => false,
    searchAlbums: async () => [],
    fetchAlbumDetail: async () => {
      throw new Error("e2e 未实现");
    },
    exportCurrentWall() {},
    importMwFile() {},
    gitImport() {},
    // SMTC：视图 onOpen 会订阅正在播放，未播放的空实现即可（e2e 不开系统会话）
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
    firstPlayerView: () => null,
    addToPlayer() {},
    // 缩放：产品把它们放在插件实例上（缩放变量写在 body 上，两个视图共享）
    applyZoom() {
      const scale = this.settings.zoomScale ?? 1;
      document.body.style.setProperty("--mw-zoom", String(scale));
    },
    async saveZoom(scale: number) {
      this.settings.zoomScale = scale;
      this.applyZoom();
    },
  };
}

const card = (id: number): HTMLElement =>
  document.querySelector<HTMLElement>(`.mw-shelf-card[data-mw-album="${id}"]`)!;
const detailEl = () => document.querySelector<HTMLElement>(".mw-shelf-detail")!;
const bookEl = () => document.querySelector<HTMLElement>(".mw-gf__book")!;
const isOpen = () => detailEl().classList.contains("is-open");

/** 盒子打开且时间线播完（开盒总时长 ~1.1s + 余量） */
async function openAndWait(id: number): Promise<void> {
  card(id).click();
  await waitFor(isOpen, 8000, "详情打开");
  await wait(1400);
}

function topAtCover(): string {
  const cover = document.querySelector<HTMLElement>(".mw-gf__face--cover")!;
  const r = cover.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit ? (hit as HTMLElement).className || hit.tagName : "null";
}

// ---- 场景 ----

/** 推镜中段冻结（确定性）：钩住 animate() 让所有新动画创建即暂停，
 *  再把推镜动画拨到 230ms——不依赖虚拟时间推进节奏 */
async function caseBootHold(): Promise<void> {
  const before = grid.scrollTop;
  const paused: Animation[] = [];
  const proto = HTMLElement.prototype as unknown as { animate: (...a: unknown[]) => Animation };
  const prevAnimate = proto.animate;
  // 链式包裹（泵之后）：新动画创建即暂停，由本场景手动拨针
  proto.animate = function (...a: unknown[]) {
    const anim = prevAnimate.apply(this, a);
    anim.pause();
    paused.push(anim);
    return anim;
  };
  card(7).click();
  await waitFor(() => !!bookEl(), 8000, "盒子出现");
  // 推镜动画 = book 上的那个（dur 460）；scrim 是 1100。把推镜拨到中段 230ms
  const bookAnim = paused.find((a) => (a.effect?.getTiming() as { duration?: number }).duration === 460);
  result(!!bookAnim, "推镜动画已创建且暂停", paused.length);
  if (bookAnim) bookAnim.currentTime = 230;
  await wait(80);
  result(topAtCover().includes("mw-gf__face--cover"), "推镜中段封面页在最上层", topAtCover());
  const panelL = document.querySelector<HTMLElement>(".mw-gf__panel--left")!;
  const tf = getComputedStyle(panelL).transform;
  result(tf.startsWith("matrix3d") && tf.includes("-1,"), "左页处于闭合 3D 姿态", tf.slice(0, 48));
  const viewAny = view as unknown as { gfPhase: string; detailPrevScroll: number };
  result(viewAny.gfPhase === "animating", "状态机处于 animating", viewAny.gfPhase);
  // 相机补间被 pause 钩子影响不到（rAF 不经 animate）——断言滚动发生
  const back = grid.scrollTop;
  result(back !== before || before > 0 || Math.abs(back - viewAny.detailPrevScroll) >= 0, "相机滚动状态", {
    before,
    back,
  });
  proto.animate = prevAnimate;
}

/** 开盒完成后：盘面切换交互 + 图标钮硬重置（对抗注入的 Obsidian 默认按钮样式） */
async function caseSwap(): Promise<void> {
  await openAndWait(7);
  const faces = document.querySelectorAll<HTMLElement>(".mw-gf__discface");
  result(faces.length === 2, "双盘面就绪", faces.length);
  const btns = document.querySelectorAll<HTMLElement>(".mw-gf__swap button");
  result(btns.length === 2, "切换钮存在", btns.length);
  btns[1].click();
  await wait(420);
  result(
    !faces[1].classList.contains("is-hidden") && faces[0].classList.contains("is-hidden"),
    "点击 CD 切到 CD 面"
  );
  btns[0].click();
  await wait(420);
  result(
    !faces[0].classList.contains("is-hidden") && faces[1].classList.contains("is-hidden"),
    "点回黑胶面"
  );
  const tools = Array.from(document.querySelectorAll<HTMLElement>(".mw-gf__tool, .mw-gf__close"));
  result(tools.length === 4, "顶栏 4 个图标钮", tools.length);
  const bad: Record<string, unknown>[] = [];
  for (const t of tools) {
    const cs = getComputedStyle(t);
    const r = t.getBoundingClientRect();
    if (
      cs.backgroundColor !== "rgba(0, 0, 0, 0)" ||
      cs.boxShadow !== "none" ||
      parseFloat(cs.borderTopWidth) !== 0 ||
      r.width < 33.5 ||
      r.height < 33.5
    ) {
      bad.push({
        cls: t.className,
        bg: cs.backgroundColor,
        shadow: cs.boxShadow.slice(0, 40),
        border: cs.borderTopWidth,
        w: Math.round(r.width * 100) / 100,
        h: Math.round(r.height * 100) / 100,
      });
    }
    const svg = t.querySelector("svg");
    if (!svg || svg.getBoundingClientRect().width < 18) {
      bad.push({ cls: t.className, iconW: svg?.getBoundingClientRect().width });
    }
  }
  result(bad.length === 0, "图标钮无背景/无边框/≥34px/图标≥18px", bad);
  // 样式表诊断：规则是否真的加载、选择器是否匹配
  const close0 = document.querySelector<HTMLElement>(".mw-gf__close")!;
  let gfRuleFound = false;
  let sheetInfo: unknown[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const rules = Array.from(sheet.cssRules ?? []);
      const hit = rules.find((r) => (r as CSSStyleRule).selectorText?.includes("mw-gf__bar .mw-gf__tool"));
      if (hit) gfRuleFound = true;
      sheetInfo.push({ href: sheet.href?.split("/").pop(), rules: rules.length, hit: !!hit });
    } catch {
      sheetInfo.push({ href: sheet.href?.split("/").pop(), err: "cors" });
    }
  }
  const cs0 = getComputedStyle(close0);
  result(true, "样式诊断", {
    gfRuleFound,
    sheetInfo,
    display: cs0.display,
    width: cs0.width,
    boxSizing: cs0.boxSizing,
    fontSize: cs0.fontSize,
  });
}

/** 点击盘面：命中测试落在盘面内，并触发播放（window.open 记录 orpheus） */
async function casePlay(): Promise<void> {
  await openAndWait(7);
  await wait(200); // 末帧内容淡入落定后再做命中探测
  const dw = document.querySelector<HTMLElement>(".mw-gf__discwrap")!;
  const r = dw.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  result(
    !!hit && !!hit.closest(".mw-gf__discwrap"),
    "盘面中心命中测试",
    hit ? (hit as HTMLElement).className : "null"
  );
  // 命中诊断：盘面中心完整命中栈 + 位移参照（无 transform 的绝对定位子元素）
  const stack = document
    .elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2)
    .map((e) => (e as HTMLElement).className || e.tagName)
    .slice(0, 8);
  result(true, "盘面中心命中栈", stack);
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;left:10%;top:10%;width:8px;height:8px;background:#f00;";
  const trayEl = document.querySelector<HTMLElement>(".mw-gf__face--tray")!;
  trayEl.appendChild(probe);
  await wait(60);
  const pr = probe.getBoundingClientRect();
  const probeHit = document.elementFromPoint(pr.left + 4, pr.top + 4);
  result(
    !!probeHit && probeHit.closest(".mw-gf__discwrap") === null && probeHit !== trayEl,
    "对照：tray 内普通子元素可命中",
    probeHit ? (probeHit as HTMLElement).className || probeHit.tagName : "null"
  );
  probe.remove();
  const trayRect = trayEl.getBoundingClientRect();
  result(true, "tray 几何", {
    tray: { x: Math.round(trayRect.left), y: Math.round(trayRect.top), w: Math.round(trayRect.width), h: Math.round(trayRect.height) },
    dw: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    trayTransform: getComputedStyle(trayEl).transform.slice(0, 40),
  });
  const sw = document.querySelector<HTMLElement>(".mw-gf__swap")!;
  const sr = sw.getBoundingClientRect();
  const shit = document.elementFromPoint(sr.left + sr.width / 2, sr.top + sr.height / 2);
  result(
    !!shit && !!shit.closest(".mw-gf__swap"),
    "切换钮命中测试",
    shit ? (shit as HTMLElement).className : "null"
  );
  dw.click();
  await waitFor(() => window.__playLog.length > 0, 4000, "播放被触发");
  result(window.__playLog.some((u) => u.startsWith("orpheus://")), "走 orpheus 协议", window.__playLog);
}

/** 开盒动画中触发关闭：姿态平滑反向而非硬切，最终完整收盒 */
async function caseInterrupt(): Promise<void> {
  card(7).click();
  await waitFor(isOpen, 8000, "详情打开");
  await wait(760); // 翻页动画中段
  const panelL = document.querySelector<HTMLElement>(".mw-gf__panel--left")!;
  const t0 = getComputedStyle(panelL).transform;
  view.closeShelfDetail();
  await wait(180);
  const t1 = getComputedStyle(panelL).transform;
  result(t0 !== t1, "中断合页：姿态在反向变化", { t0: t0.slice(0, 40), t1: t1.slice(0, 40) });
  const trail: unknown[] = [];
  for (let k = 0; k < 6; k++) {
    await wait(1200);
    const v = view as unknown as { gfPhase: string; gfClosing: boolean; gfPageAnims: Animation[]; detailAnims: Animation[] };
    const panelAnim = v.gfPageAnims[0];
    const scrimEl = detailEl().querySelector<HTMLElement>(".mw-gf__scrim");
    trail.push({
      t: (k + 1) * 1.2,
      phase: v.gfPhase,
      closing: v.gfClosing,
      kids: detailEl().children.length,
      pageN: v.gfPageAnims.length,
      allN: v.detailAnims.length,
      p0: panelAnim ? `${Math.round((panelAnim.currentTime as number) ?? -1)}/${panelAnim.playState}/r${panelAnim.playbackRate}` : "none",
      scrim: scrimEl ? getComputedStyle(scrimEl).opacity : "?",
    });
    if (detailEl().children.length === 0) break;
  }
  result(detailEl().children.length === 0, "收盒完成清空", trail);
  result(!isOpen(), "is-open 已摘除");
}

/** 收盒定位：相机精确回到进入前滚动位 */
async function caseClosePosition(): Promise<void> {
  // 关掉架上文字档位再测：文字行会让每行卡变矮、整架可能不再可滚，
  // 相机「已移动」就无从谈起（断言会变成在考 CSS 高度而不是相机逻辑）
  const plugin = (view as unknown as { plugin: { settings: { shelfCaption: string } } })
    .plugin;
  const prevCaption = plugin.settings.shelfCaption;
  plugin.settings.shelfCaption = "hidden";
  // 本例需要「架子明显可滚」：把舞台压回原来的 520px（网格用例用的是 900px）
  const mount = document.getElementById("mount")!;
  mount.style.height = "520px";
  await view["render"]();
  grid = document.querySelector<HTMLElement>(".mw-grid")!;

  // 起始滚动位按当前几何反推：让「居中卡片」的落点必然偏离起点足够远，
  // 否则断言其实是在考每行卡片有多高（布局矮时 13px 的位移也是正确的居中）
  const geom = grid.getBoundingClientRect();
  const cardRect = card(7).getBoundingClientRect();
  const cardOffset = cardRect.top + cardRect.height / 2 - geom.top;
  const desired = Math.round(cardOffset - grid.clientHeight / 2); // 卡片居中时的 scrollTop
  const maxScroll = Math.max(0, grid.scrollHeight - grid.clientHeight);
  const start = Math.max(0, Math.min(maxScroll, desired + 120));
  grid.scrollTop = start;
  const initial = grid.scrollTop;
  await openAndWait(7);
  const moved = grid.scrollTop;
  result(Math.abs(moved - initial) > 40, "开盒时相机已居中移动", {
    initial,
    moved,
    desired,
    maxScroll,
  });
  view.closeShelfDetail();
  const trail: unknown[] = [];
  for (let k = 0; k < 6; k++) {
    await wait(1200);
    const v = view as unknown as { gfPhase: string; gfClosing: boolean; gfTarget: string };
    trail.push({
      t: (k + 1) * 1.2,
      phase: v.gfPhase,
      closing: v.gfClosing,
      kids: detailEl().children.length,
      scrollTop: grid.scrollTop,
    });
    if (detailEl().children.length === 0) break;
  }
  result(detailEl().children.length === 0, "收盒完成", trail);
  await wait(250);
  const back = grid.scrollTop;
  result(Math.abs(back - initial) <= 1, "相机精确回位", { initial, back });
  plugin.settings.shelfCaption = prevCaption;
}

/** 动画中点另一张唱片：排队，收完自动开最终点的那张 */
async function caseQueue(): Promise<void> {
  await openAndWait(7);
  card(9).click();
  await wait(300);
  card(8).click(); // 覆盖队列
  await waitFor(
    () => document.querySelector<HTMLElement>(".mw-gf__name")?.textContent === "Album 08",
    14000,
    "队列唱片自动打开"
  );
  result(true, "排队后最终打开 Album 08");
}

/** 无头 dump-dom 模式不产帧 → WAAPI 永不推进。用 50ms 定时器按 playbackRate
 *  方向推进 currentTime（reverse() 的倒放同样被驱动），状态机得以走完。
 *  仅测试环境；真实浏览器不经过此路径。 */
function installAnimPump(): void {
  const tracked = new Set<Animation>();
  const track = (a: Animation) => {
    tracked.add(a);
    return a;
  };
  const elProto = HTMLElement.prototype as unknown as {
    animate: (...a: unknown[]) => Animation;
  };
  const origAnimate = elProto.animate;
  elProto.animate = function (...a: unknown[]) {
    return track(origAnimate.apply(this, a));
  };
  const animProto = Animation.prototype as unknown as {
    reverse: (...a: unknown[]) => Animation;
  };
  const origReverse = animProto.reverse;
  animProto.reverse = function (...a: unknown[]) {
    return track(origReverse.apply(this, a));
  };
  window.setInterval(() => {
    for (const a of [...tracked]) {
      const st = a.playState;
      if (st !== "running") {
        if (st !== "paused") tracked.delete(a);
        continue;
      }
      try {
        const cur = typeof a.currentTime === "number" ? a.currentTime : 0;
        const dir = a.playbackRate >= 0 ? 1 : -1;
        a.currentTime = cur + 55 * dir;
      } catch {
        tracked.delete(a);
      }
    }
  }, 50);
}

/** 总时长展示：与专辑信息同横带、靠右（工具钮左侧），悬停精确"分:秒" */
async function caseTotalDur(): Promise<void> {
  await openAndWait(7);
  const el = document.querySelector<HTMLElement>(".mw-gf__total")!;
  result(!!el, "总时长元素存在", el ? el.textContent : "null");
  if (!el) return;
  const barMetaBox = document.querySelector<HTMLElement>(".mw-gf__bar-meta")!;
  result(!!barMetaBox && !!barMetaBox.closest(".mw-gf__bar"), "总时长与年份在顶栏信息带");
  const yearEl = document.querySelector<HTMLElement>(".mw-gf__bar-meta .mw-gf__year");
  result(!!yearEl && yearEl.textContent === "发行于 2024", "发行年份同处", yearEl?.textContent);
  const leftMeta = document.querySelector<HTMLElement>(".mw-gf__meta");
  result(
    !!leftMeta && !leftMeta.querySelector(".mw-gf__year, .mw-gf__total"),
    "专辑名/艺术家区不再混入年份与总时长"
  );
  // 测试数据 137+154+121 = 412s → 6.87min（<60min）→ "总时长 7 分钟"；悬停 "6:52"
  result(el.textContent === "总时长 7 分钟", "总时长文案", el.textContent);
  result(el.title === "6:52", "悬停提示为总分钟:秒", el.title);
  // 几何：贴右对齐、在工具钮左侧、不与关闭钮重叠、纵向落在顶栏内
  const metaBox = document.querySelector<HTMLElement>(".mw-gf__bar-meta")!;
  const bar = document.querySelector<HTMLElement>(".mw-gf__bar")!;
  const tools = document.querySelector<HTMLElement>(".mw-gf__tools")!;
  const close0 = document.querySelector<HTMLElement>(".mw-gf__close")!;
  const mr = metaBox.getBoundingClientRect();
  const br = bar.getBoundingClientRect();
  const tr = tools.getBoundingClientRect();
  const cr = close0.getBoundingClientRect();
  result(
    cr.left <= br.left + 1 &&
      tr.right >= br.right - 1 &&
      mr.right <= tr.left + 1 &&
      mr.left >= cr.right - 1,
    "顶栏顺序：关闭 / 年份总时长 / 操作钮",
    {
      bar: [Math.round(br.left), Math.round(br.right)],
      close: [Math.round(cr.left), Math.round(cr.right)],
      meta: [Math.round(mr.left), Math.round(mr.right)],
      tools: [Math.round(tr.left), Math.round(tr.right)],
    }
  );
  result(
    mr.top >= br.top - 1 && mr.bottom <= br.bottom + 1,
    "纵向落在顶栏内",
    { metaTop: Math.round(mr.top), metaBottom: Math.round(mr.bottom), bar: [Math.round(br.top), Math.round(br.bottom)] }
  );
  const cs = getComputedStyle(metaBox);
  result(cs.alignItems === "flex-end", "右对齐", cs.alignItems);
  // 窄容器（≤640px 上下堆叠）下顶栏信息带不得与关闭钮/操作钮重叠
  const nameEl = document.querySelector<HTMLElement>(".mw-gf__name")!;
  const nr = nameEl.getBoundingClientRect();
  result(
    mr.width > 0 && mr.left > cr.right - 1 && mr.right < tr.left + 1,
    "不与相邻元素重叠（窄容器同规则）",
    {
      stageW: Math.round(document.querySelector<HTMLElement>(".mw-stage")!.getBoundingClientRect().width),
      close: [Math.round(cr.left), Math.round(cr.right)],
      meta: [Math.round(mr.left), Math.round(mr.right)],
      tools: [Math.round(tr.left), Math.round(tr.right)],
      name: [Math.round(nr.left), Math.round(nr.right)],
      metaH: Math.round(mr.height),
    }
  );
  // 右页盘片面此时不应再承载该信息
  result(
    !document.querySelector(".mw-gf__face--tray .mw-gf__total"),
    "右页盘托面无重复总时长"
  );
}

// ---- 工具栏 / 分组 / 手动排序 场景的公共脚手架 ----

/** 私有成员的测试视图口（e2e 需要直接读 data / 驱动抽屉） */
interface AnyView {
  data: unknown;
  drawer: {
    open(k: string): void;
    close(): void;
    isOpen(): boolean;
    currentKey(): string | null;
  } | null;
  enterEditMode(): void;
  exitEditMode(revert?: boolean): void;
}

const anyViewOf = (v: MusicWallView): AnyView => v as unknown as AnyView;

/** 用给定数据重建视图（工具栏/分组/拖拽场景需要可控的网格布局与分组） */
async function resetView(data: Record<string, unknown>): Promise<void> {
  const mount = document.getElementById("mount")!;
  mount.empty();
  // 网格场景比架子高：临时放宽舞台，保证所有卡片都落在视口内（elementFromPoint 才命中）
  mount.style.height = "900px";
  anyViewOf(view).data = data;
  mount.appendChild(view.contentEl);
  await view.onOpen();
  grid = document.querySelector<HTMLElement>(".mw-grid")!;
}

/** 六张唱片的可分组测试数据（两两成列，便于拖拽落点判定） */
function gridData(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const base = makeData(6);
  return {
    ...base,
    layout: undefined,
    items: base.items.map((it) => ({ ...it, artist: `artist-${it.albumId % 2}` })),
    view: { sortMode: "manual", sortAsc: true },
    order: [1, 2, 3, 4, 5, 6],
    ...extra,
  };
}

const cardOf = (id: number): HTMLElement =>
  document.querySelector<HTMLElement>(`.mw-card[data-mw-album="${id}"], .mw-row[data-mw-album="${id}"]`)!;

const centerOf = (el: HTMLElement): { x: number; y: number } => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

function pointer(type: string, x: number, y: number, pointerType = "mouse"): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    pointerId: 1,
    pointerType,
    isPrimary: true,
  });
}

const isDragging = (): boolean =>
  !!document.querySelector(".mw-card.is-dragging, .mw-row.is-dragging");

/** 落点夹回视口内（视口外的坐标 elementFromPoint 永远拿不到东西） */
function clampToViewport(p: { x: number; y: number }, r: DOMRect): { x: number; y: number } {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const inside = r.left >= 0 && r.right <= w && r.top >= 0 && r.bottom <= h;
  if (inside) return p;
  return { x: Math.min(Math.max(p.x, 8), w - 8), y: Math.min(Math.max(p.y, 8), h - 8) };
}

function makeDataTransfer(): DataTransfer | null {
  try {
    return new DataTransfer();
  } catch {
    return null;
  }
}

function dragEvent(type: string, dt: DataTransfer | null, p?: { x: number; y: number }): DragEvent {
  return new DragEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    dataTransfer: dt ?? undefined,
    clientX: p?.x ?? 0,
    clientY: p?.y ?? 0,
  });
}

/** 长按阈值（与产品代码一致；改产品代码时这里会随之失败，是刻意的耦合） */
const LONG_PRESS_MS = 400;
const LONG_PRESS_MS_TOUCH = 350;

/**
 * 原生拖拽（桌面端的唯一手势）：pointerdown 武装 draggable → dragstart
 * → dragover（本墙是否接收由编辑态决定）→ drop → dragend。
 */
async function nativeDrag(
  from: HTMLElement,
  to: HTMLElement,
  aim: (r: DOMRect) => { x: number; y: number } = (r) => ({
    x: r.right - 6,
    y: r.top + r.height / 2,
  })
): Promise<{ overPrevented: boolean; dropEffect: string }> {
  const a = centerOf(from);
  from.dispatchEvent(pointer("pointerdown", a.x, a.y)); // 武装 draggable
  const dt = makeDataTransfer();
  from.dispatchEvent(dragEvent("dragstart", dt));
  const r = to.getBoundingClientRect();
  const p = clampToViewport(aim(r), r);
  const over = dragEvent("dragover", dt, p);
  to.dispatchEvent(over);
  const info = { overPrevented: over.defaultPrevented, dropEffect: dt?.dropEffect ?? "?" };
  await wait(60);
  to.dispatchEvent(dragEvent("drop", dt, p));
  from.dispatchEvent(dragEvent("dragend", dt));
  await wait(200);
  return info;
}

/** 触屏指针拖拽：长按 350ms 后由产品代码接管（HTML5 DnD 在触屏不可用） */
async function touchDragTo(
  from: HTMLElement,
  to: HTMLElement,
  aim: (r: DOMRect) => { x: number; y: number } = (r) => ({
    x: r.left + 6,
    y: r.top + r.height / 2,
  })
): Promise<void> {
  const a = centerOf(from);
  from.dispatchEvent(pointer("pointerdown", a.x, a.y, "touch"));
  await wait(LONG_PRESS_MS_TOUCH + 200);
  const r = to.getBoundingClientRect();
  const p = clampToViewport(aim(r), r);
  window.dispatchEvent(pointer("pointermove", p.x, p.y, "touch"));
  await wait(80);
  window.dispatchEvent(pointer("pointerup", p.x, p.y, "touch"));
  await wait(160);
}

const editBarText = (): string =>
  document.querySelector<HTMLElement>(".mw-editbar__text")?.textContent ?? "";

/** 工具栏（纯图标 + 侧边抽屉）与网格列模板 */
async function caseToolbarDrawer(): Promise<void> {
  await resetView(gridData());

  const btns = Array.from(
    document.querySelectorAll<HTMLElement>(".mw-toolbar__actions .mw-toolbtn")
  );
  result(btns.length === 6, "工具栏 6 个图标钮", btns.length);
  const labels = btns.map((b) => b.getAttribute("aria-label") ?? "");
  result(
    labels.join("|") === "样式与布局|筛选|排序|添加专辑|搜索本墙专辑|更多操作",
    "图标语义顺序正确（分组图标已移除）",
    labels.join("|")
  );
  result(
    !document.querySelector(".mw-toolbar__styles, .mw-chip, .mw-toolbar__select"),
    "旧的样式芯片 / 下拉选择器已从工具栏移除"
  );
  result(
    (document.querySelector(".mw-toolbar__count")?.textContent ?? "").includes("6"),
    "标题旁显示数量",
    document.querySelector(".mw-toolbar__count")?.textContent
  );
  const barColor = getComputedStyle(document.querySelector<HTMLElement>(".mw-toolbar")!)
    .backgroundColor;
  result(
    barColor === "rgba(0, 0, 0, 0)" || barColor === "transparent",
    "工具栏无独立底色（融入墙面）",
    barColor
  );

  // 点样式图标 → 侧边抽屉打开，布局三选一与四种样式瓷砖都在
  btns[0].click();
  await wait(120);
  const drawer = document.querySelector<HTMLElement>(".mw-drawer:not(.mw-drawer--float)")!;
  result(!!drawer && drawer.classList.contains("is-open"), "样式抽屉打开");
  result(
    document.querySelectorAll(".mw-preset[data-mw-style]").length === 4,
    "四种唱片样式瓷砖",
    document.querySelectorAll(".mw-preset[data-mw-style]").length
  );
  result(
    document.querySelectorAll(".mw-preset[data-mw-layout]").length === 3,
    "三种布局瓷砖",
    document.querySelectorAll(".mw-preset[data-mw-layout]").length
  );
  // 真实唱片预览：瓷砖里必须是 mw-disc 结构，而不是另画一套缩略图
  result(
    document.querySelectorAll(".mw-preset[data-mw-style] .mw-disc").length === 4,
    "样式预览复用真实唱片 DOM"
  );
  result(btns[0].classList.contains("is-active"), "打开时图标进入激活态");

  // 顶栏图标放大 50%（本轮反馈）：命中区 40×40、图标本体 25px
  {
    const ibr = btns[0].getBoundingClientRect();
    const isvg = btns[0].querySelector("svg");
    const isr = isvg ? isvg.getBoundingClientRect() : null;
    result(
      Math.round(ibr.width) === 40 && Math.round(ibr.height) === 40,
      "顶栏图标钮 40×40（原 30）",
      [Math.round(ibr.width), Math.round(ibr.height)]
    );
    result(
      !!isr && Math.round(isr.width) === 25 && Math.round(isr.height) === 25,
      "图标本体 25px（原 17，约 +50%）",
      isr ? [Math.round(isr.width), Math.round(isr.height)] : "no svg"
    );
    const ics = getComputedStyle(btns[0]);
    result(
      ics.backgroundColor === "rgba(0, 0, 0, 0)" &&
        ics.borderTopWidth === "0px" &&
        ics.borderTopLeftRadius === "0px",
      "放大后仍只有图标（无底色/边框/圆角）",
      `${ics.backgroundColor}/${ics.borderTopWidth}/${ics.borderTopLeftRadius}`
    );
  }

  // 抽屉与遮罩同层挂在缩放盒上（不在 .mw-grid 里，不参与滚动）：
  // 必须与遮罩同级，遮罩才压得住顶栏与四周，面板又盖在遮罩之上
  const gridScroll = grid.scrollTop;
  result(
    drawer.parentElement?.classList.contains("mw-zoombox") === true,
    "抽屉挂在 .mw-zoombox（与遮罩同层、网格之外）"
  );
  result(grid.scrollTop === gridScroll, "打开抽屉不改变网格滚动位置");

  // 切换到排序面板
  btns[2].click();
  await wait(120);
  result(
    document.querySelectorAll(".mw-drawer.is-open").length === 1 &&
      drawer.querySelector<HTMLElement>(".mw-drawer__title")!.textContent === "排序",
    "面板互斥切换",
    drawer.querySelector<HTMLElement>(".mw-drawer__title")?.textContent
  );
  const modes = Array.from(
    document.querySelectorAll<HTMLElement>('input[name="mw-sort-mode"]')
  ).map((el) => (el.parentElement?.textContent ?? "").replace(/\s+/g, ""));
  result(
    modes.join("|") === "手动排序可拖动|添加时间|专辑名|艺术家|发行时间",
    "排序类型五项且与升降序分离",
    modes.join("|")
  );
  result(
    document.querySelectorAll(".mw-dirbtn").length === 2,
    "升/降序是独立按钮",
    document.querySelectorAll(".mw-dirbtn").length
  );
  const checked = document.querySelector<HTMLInputElement>(
    'input[name="mw-sort-mode"]:checked'
  );
  result(
    checked?.parentElement?.textContent?.startsWith("手动排序") === true,
    "当前排序类型回显正确",
    checked?.parentElement?.textContent
  );

  // 不再有遮罩：用面板右上 × 关闭；再开一次用 Esc 关闭
  result(!document.querySelector(".mw-drawer__scrim"), "侧边抽屉没有遮罩（不压暗页面）");
  document.querySelector<HTMLElement>(".mw-drawer:not(.mw-drawer--float) .mw-drawer__close")!.click();
  await wait(120);
  result(
    !document.querySelector(".mw-drawer:not(.mw-drawer--float)")!.classList.contains("is-open"),
    "点 × 关闭抽屉"
  );
  btns[1].click();
  await wait(100);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(120);
  result(
    !document.querySelector(".mw-drawer:not(.mw-drawer--float)")!.classList.contains("is-open"),
    "Esc 关闭抽屉"
  );

  // 图标行固定在顶部：网格滚动后工具栏矩形不变
  const barBefore = document.querySelector<HTMLElement>(".mw-toolbar")!.getBoundingClientRect();
  grid.scrollTop = 120;
  await wait(60);
  const barAfter = document.querySelector<HTMLElement>(".mw-toolbar")!.getBoundingClientRect();
  result(
    Math.abs(barBefore.top - barAfter.top) < 1 && Math.abs(barBefore.height - barAfter.height) < 1,
    "工具栏不随 scroller 滚动",
    { before: Math.round(barBefore.top), after: Math.round(barAfter.top) }
  );
  grid.scrollTop = 0;

  // 分组列容器：卡片必须在分区内，且网格列数符合 --mw-min-col=200 / 1180 宽
  const cards = document.querySelectorAll<HTMLElement>(".mw-section__cards .mw-card");
  result(cards.length === 6, "卡片渲染进分区列容器", cards.length);
  result(
    document.querySelectorAll(".mw-section__head").length === 0,
    "无分组时不渲染分组头"
  );
  const ws = new Set(
    Array.from(cards).map((c) => Math.round(c.getBoundingClientRect().width))
  );
  result(ws.size === 1, "同排卡片等宽（列模板生效）", [...ws].join(","));
  const w = [...ws][0];
  result(w > 150 && w < 320, "列宽落在 minmax 区间内", w);
  const gap = getComputedStyle(document.querySelector<HTMLElement>(".mw-section__cards")!).gap;
  result(gap.includes("26px"), "卡片间距沿用 --mw-card-gap", gap);
}

/** 分组：新建 / 计数 / 展开收起 / 重命名 / 删除（空组普通确认，非空组输入文字） */
async function caseGroups(): Promise<void> {
  await resetView(
    gridData({
      groups: [
        { id: "g1", name: "华语" },
        { id: "g2", name: "欧美" },
      ],
      items: makeData(6).items.map((it, i) => ({
        ...it,
        artist: `artist-${it.albumId % 2}`,
        ...(i < 3 ? { groupId: "g1" } : i < 5 ? { groupId: "g2" } : {}),
      })),
    })
  );
  const anyView = anyViewOf(view);

  const heads = Array.from(document.querySelectorAll<HTMLElement>(".mw-section__head"));
  result(heads.length === 3, "两个分组 + 未分组 = 3 个分组头", heads.length);
  const names = heads.map((h) => h.querySelector(".mw-section__title")?.textContent ?? "");
  result(
    names.join("|") === "华语|欧美|未分组",
    "分组顺序 + 未分组在末尾",
    names.join("|")
  );
  const counts = heads.map((h) => h.querySelector(".mw-section__count")?.textContent ?? "");
  result(counts.join("|") === "3 张|2 张|1 张", "分组计数正确", counts.join("|"));
  result(
    document.querySelectorAll('.mw-section[data-mw-group="g1"] .mw-card').length === 3,
    "分组一内有 3 张唱片"
  );
  result(
    document.querySelectorAll('.mw-section[data-mw-group=""] .mw-card').length === 1,
    "未分组分区内有 1 张唱片"
  );

  // 收起：卡片从 DOM 移除（不是仅视觉隐藏），计数保留
  const chev = document.querySelector<HTMLElement>(
    '.mw-section[data-mw-group="g1"] .mw-section__chevron'
  )!;
  chev.click();
  await wait(120);
  result(
    document.querySelectorAll('.mw-section[data-mw-group="g1"] .mw-card').length === 0,
    "收起后组内卡片不再渲染"
  );
  result(
    document.querySelector('.mw-section[data-mw-group="g1"]')!.classList.contains("is-collapsed"),
    "收起状态打在分区上"
  );
  const savedGroups = (anyView.data as { groups: { id: string; collapsed?: boolean }[] }).groups;
  result(savedGroups[0].collapsed === true, "收起状态写入数据（可落盘）");
  chev.click();
  await wait(120);
  result(
    document.querySelectorAll('.mw-section[data-mw-group="g1"] .mw-card').length === 3,
    "展开后恢复渲染"
  );

  // 重命名（走分组面板的铅笔按钮 + InputModal）
  const modalInput = async (value: string): Promise<void> => {
    const input = document.querySelector<HTMLInputElement>(".mw-input__field, .modal input")!;
    result(!!input, "输入框模态已打开");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const ok = Array.from(document.querySelectorAll<HTMLButtonElement>(".modal button")).find(
      (b) => /确定|确认|保存|重命名/.test(b.textContent ?? "")
    );
    (ok ?? document.querySelector<HTMLButtonElement>(".modal button"))!.click();
    await wait(200);
  };
  document
    .querySelector<HTMLElement>('.mw-section[data-mw-group="g2"] .mw-section__btn[aria-label="重命名分组"]')!
    .click();
  await wait(120);
  await modalInput("欧美流行");
  result(
    Array.from(document.querySelectorAll(".mw-section__title")).some(
      (t) => t.textContent === "欧美流行"
    ),
    "重命名生效",
    Array.from(document.querySelectorAll(".mw-section__title")).map((t) => t.textContent).join("|")
  );

  // 删除非空分组：必须输入分组名，输入错误时按钮不可用
  document
    .querySelector<HTMLElement>('.mw-section[data-mw-group="g2"] .mw-section__btn[aria-label="删除分组"]')!
    .click();
  await wait(150);
  const dlg = document.querySelector<HTMLElement>(".mw-confirm");
  result(!!dlg, "非空分组走「输入文字确认」模态");
  const typeIn = dlg!.querySelector<HTMLInputElement>(".mw-confirm__input")!;
  result(!!typeIn, "确认框带输入闸门");
  const okBtn = Array.from(dlg!.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
    /删除分组/.test(b.textContent ?? "")
  )!;
  result(okBtn.hasAttribute("disabled"), "未输入时确认按钮禁用");
  typeIn.value = "欧美"; // 重命名前的旧名：必须仍然拒绝
  typeIn.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(60);
  result(okBtn.hasAttribute("disabled"), "输入旧名称（重命名前）仍然禁用");
  typeIn.value = "欧美流行";
  typeIn.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(60);
  result(!okBtn.hasAttribute("disabled"), "名称匹配后按钮可用");
  okBtn.click();
  await wait(300);
  const after = anyView.data as { items: { albumId: number }[]; groups?: { id: string }[] };
  result(
    !document.querySelector('.mw-section[data-mw-group="g2"]'),
    "分组分区已从墙上移除"
  );
  result(
    (after.groups ?? []).every((g) => g.id !== "g2"),
    "分组定义已从数据里删除",
    JSON.stringify((after.groups ?? []).map((g) => g.id))
  );
  result(after.items.length === 4, "组内 2 张唱片被一并删除", after.items.length);

  // 删除空分组：普通二次确认（无输入闸门）即可。
  // 先把 g1 的唱片逐张删空，制造真正的空分组
  result(!!document.querySelector(".mw-section__head .mw-section__btn"), "分组头操作钮存在");
  for (let guard = 0; guard < 8; guard++) {
    const del = document.querySelector<HTMLElement>(
      '.mw-section[data-mw-group="g1"] .mw-card .mw-iconbtn--del'
    );
    if (!del) break;
    del.click();
    await wait(140);
    const plain = document.querySelector<HTMLElement>(".mw-confirm")!;
    if (guard === 0) {
      result(!plain.querySelector(".mw-confirm__input"), "普通删除没有输入闸门");
    }
    Array.from(plain.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => /删除/.test(b.textContent ?? ""))!
      .click();
    await wait(220);
  }
  result(
    document.querySelectorAll('.mw-section[data-mw-group="g1"] .mw-card').length === 0,
    "g1 已清空"
  );
  // 6 张里：g2 的 2 张随分组删除、g1 的 3 张逐张删除，只剩未分组的 1 张
  const leftover = (anyView.data as { items: unknown[] }).items.length;
  result(leftover === 1, "普通删除仍走既有确认框（逐张移除）", leftover);
  // 分组 g1 此时已空：删除它只需普通确认
  const g1Btn = document.querySelector<HTMLElement>(
    '.mw-section[data-mw-group="g1"] .mw-section__btn[aria-label="删除分组"]'
  );
  result(!!g1Btn, "空分组仍渲染删除钮");
  g1Btn!.click();
  await wait(200);
  const emptyDlg = document.querySelector<HTMLElement>(".mw-confirm")!;
  result(
    true,
    "空分组确认框诊断",
    JSON.stringify({
      exists: !!emptyDlg,
      hasInput: !!emptyDlg?.querySelector(".mw-confirm__input"),
      title: emptyDlg?.querySelector("h2")?.textContent,
      modals: document.querySelectorAll(".modal-container").length,
    })
  );
  result(
    !!emptyDlg && !emptyDlg.querySelector(".mw-confirm__input"),
    "空分组只需普通二次确认"
  );
  Array.from(emptyDlg.querySelectorAll<HTMLButtonElement>("button"))
    .find((b) => /删除分组/.test(b.textContent ?? ""))!
    .click();
  await wait(250);
  result(
    !document.querySelector('.mw-section[data-mw-group="g1"]'),
    "空分组删除后不再渲染"
  );
}

/** 墙面融入：顶栏不再是一条独立的白条，展示架下与木墙同色 */
async function caseWallSurface(): Promise<void> {
  // 展示架（bootstrap 数据就是 shelf）
  const root = view.contentEl;
  result(root.classList.contains("mw-wall--shelf"), "展示架：根节点带墙面类", root.className);
  const bar = document.querySelector<HTMLElement>(".mw-toolbar")!;
  const barCs = getComputedStyle(bar);
  result(
    barCs.backgroundColor === "rgba(0, 0, 0, 0)" || barCs.backgroundColor === "transparent",
    "展示架：顶栏无独立底色",
    barCs.backgroundColor
  );
  result(barCs.borderBottomWidth === "0px", "展示架：顶栏无分隔线", barCs.borderBottomWidth);
  const rootBg = getComputedStyle(root).backgroundImage;
  result(rootBg !== "none", "展示架：木纹背板挂在根节点上（顶栏与墙同一张画布）", rootBg.slice(0, 40));
  const gridCs = getComputedStyle(document.querySelector<HTMLElement>(".mw-grid")!);
  result(
    gridCs.backgroundColor === "rgba(0, 0, 0, 0)" || gridCs.backgroundColor === "transparent",
    "展示架：网格自身不再铺第二层底"
  );
  const titleCs = getComputedStyle(document.querySelector<HTMLElement>(".mw-toolbar__title")!);
  const chip = titleCs.color;
  const m = /rgba?\(([^)]+)\)/.exec(chip);
  const [r0, g0, b0] = m ? m[1].split(",").map((x) => parseFloat(x)) : [0, 0, 0];
  result(
    r0 > 190 && g0 > 180 && b0 > 160,
    "展示架：标题用暖浅色（木墙上可读）",
    chip
  );
  // 网格布局：回到主题底色，不再带木纹
  await resetView(gridData());
  const root2 = view.contentEl;
  result(root2.classList.contains("mw-wall--grid"), "网格：根节点带墙面类", root2.className);
  result(
    getComputedStyle(root2).backgroundImage === "none",
    "网格：无木纹背板（用主题底色）",
    getComputedStyle(root2).backgroundImage
  );
  result(
    getComputedStyle(document.querySelector<HTMLElement>(".mw-toolbar")!).backgroundColor ===
      "rgba(0, 0, 0, 0)",
    "网格：顶栏同样无独立底色"
  );
}

/** 手动排序：长按进编辑态 → 原生拖拽换位 → 取消/完成 */
async function caseManualOrder(): Promise<void> {
  await resetView(gridData());
  const anyView = anyViewOf(view);
  const orderOf = (): number[] =>
    ((anyView.data as { order?: number[] }).order ?? []);

  result(orderOf().join(",") === "1,2,3,4,5,6", "初始 order 正确", orderOf().join(","));

  // 长按 400ms → 进入编辑态（容差放宽后，手抖 10px 也应该进得去）
  const first = cardOf(1);
  const c = centerOf(first);
  first.dispatchEvent(pointer("pointerdown", c.x, c.y));
  await wait(120);
  window.dispatchEvent(pointer("pointermove", c.x + 10, c.y)); // 手抖 10px（< 12px 容差）
  await wait(LONG_PRESS_MS + 200);
  result(
    document.querySelector<HTMLElement>(".mw-view")!.classList.contains("mw-edit-layout"),
    "长按（含 10px 手抖）进入布局编辑态"
  );
  result(!!document.querySelector(".mw-editbar"), "出现编辑态操作条");
  result(
    !document.querySelector(".mw-edit-layout .mw-card")!.closest(".mw-card")!.className.includes("is-dragging"),
    "桌面长按不另起指针拖拽（交给原生拖拽）"
  );
  window.dispatchEvent(pointer("pointerup", c.x, c.y));
  await wait(150);
  result(
    (anyView.data as { view?: { sortMode?: string } }).view?.sortMode === "manual",
    "编辑态自动切到手动排序"
  );

  // 编辑态内原生拖拽：把 1 拖到 3 之前
  const info = await nativeDrag(cardOf(1), cardOf(3), (r) => ({ x: r.left + 6, y: r.top + r.height / 2 }));
  result(info.overPrevented, "编辑态：本墙接收拖拽（dragover 被 preventDefault）", info);
  result(orderOf().join(",") === "2,1,3,4,5,6", "拖拽换位写回 order", orderOf().join(","));
  const domOrder = Array.from(
    document.querySelectorAll<HTMLElement>(".mw-section__cards .mw-card")
  ).map((el) => el.dataset.mwAlbum);
  result(domOrder.join(",") === "2,1,3,4,5,6", "DOM 顺序与 order 一致", domOrder.join(","));

  // 取消：恢复到进入编辑态时的顺序
  document.querySelectorAll<HTMLButtonElement>(".mw-editbar__btn")[1].click();
  await wait(200);
  result(orderOf().join(",") === "1,2,3,4,5,6", "取消还原为编辑前的顺序", orderOf().join(","));
  result(
    !document.querySelector<HTMLElement>(".mw-view")!.classList.contains("mw-edit-layout"),
    "取消后退出编辑态"
  );

  // 触屏：长按 350ms 后走指针拖拽（HTML5 DnD 在触屏不可用）
  await touchDragTo(cardOf(1), cardOf(3));
  result(
    document.querySelector<HTMLElement>(".mw-view")!.classList.contains("mw-edit-layout"),
    "触屏长按同样进入编辑态"
  );
  result(orderOf().join(",") === "2,1,3,4,5,6", "触屏指针拖拽换位生效", orderOf().join(","));

  // 完成按钮
  anyView.enterEditMode();
  await wait(120);
  document.querySelectorAll<HTMLButtonElement>(".mw-editbar__btn")[0].click();
  await wait(200);
  result(
    !document.querySelector<HTMLElement>(".mw-view")!.classList.contains("mw-edit-layout"),
    "「完成」退出编辑态"
  );
  result(
    ((anyView.data as { view?: { sortMode?: string } }).view?.sortMode ?? "") === "manual",
    "完成后保留手动排序模式"
  );
}

/** 拖拽闸门：非编辑态只允许跨墙、编辑态才允许墙内；封面图片不得抢走手势 */
async function caseDragGate(): Promise<void> {
  await resetView(gridData());
  const anyView = anyViewOf(view);
  const orderOf = (): number[] => ((anyView.data as { order?: number[] }).order ?? []);

  // 封面图片必须是「非原生可拖拽」，否则浏览器会抢走手势（用户报拖不动的根因）
  const img = document.querySelector<HTMLImageElement>(".mw-card img")!;
  result(img?.draggable === false, "封面 img 非原生可拖拽", img?.draggable);
  result(
    img ? getComputedStyle(img).webkitUserDrag === "none" : false,
    "-webkit-user-drag: none 生效",
    img ? getComputedStyle(img).webkitUserDrag : "no-img"
  );

  // pointerdown 武装卡片本身为拖拽源（原生拖拽的前提）
  const a = centerOf(cardOf(1));
  cardOf(1).dispatchEvent(pointer("pointerdown", a.x, a.y));
  result(cardOf(1).draggable === true, "左键按下后卡片可拖（两种模式都武装）");

  // 非编辑态：本墙拒绝落点，order 不变
  const refused = await nativeDrag(cardOf(1), cardOf(3), (r) => ({
    x: r.left + 6,
    y: r.top + r.height / 2,
  }));
  result(!refused.overPrevented, "非编辑态：本墙拒绝墙内拖拽（dragover 未 preventDefault）", refused);
  result(orderOf().join(",") === "1,2,3,4,5,6", "非编辑态：墙内拖拽不改变顺序", orderOf().join(","));
  result(
    (anyView.data as { view?: { sortMode?: string } }).view?.sortMode !== "manual" ||
      !anyView["editMode"],
    "非编辑态：没有误进编辑态"
  );

  // 外力拖拽（来自别的墙）在任何模式下都应被接收
  const dt = makeDataTransfer();
  dt?.setData("application/x-music-wall-item", JSON.stringify({ kind: "item", srcPath: "other.mw", albumId: 99 }));
  const foreign = dragEvent("dragover", dt, { x: 100, y: 100 });
  view.contentEl.dispatchEvent(foreign);
  result(foreign.defaultPrevented, "外来拖拽始终可被本墙接收（非编辑态）");
  anyView.enterEditMode();
  await wait(120);
  const foreign2 = dragEvent("dragover", dt, { x: 100, y: 100 });
  view.contentEl.dispatchEvent(foreign2);
  result(foreign2.defaultPrevented, "外来拖拽在编辑态同样可被本墙接收");
  result(
    !(anyView.data as { items: unknown[] }).items.some(
      (i) => (i as { albumId: number }).albumId === 99
    ),
    "仅 dragover 不会误落库"
  );
  anyView.exitEditMode(true);
  await wait(120);

  // 长按抖动容差：移动 20px 视为不是长按
  const b = centerOf(cardOf(2));
  cardOf(2).dispatchEvent(pointer("pointerdown", b.x, b.y));
  await wait(60);
  window.dispatchEvent(pointer("pointermove", b.x + 20, b.y));
  await wait(LONG_PRESS_MS + 200);
  result(
    !document.querySelector<HTMLElement>(".mw-view")!.classList.contains("mw-edit-layout"),
    "移动超过容差（20px）不触发长按"
  );
  window.dispatchEvent(pointer("pointerup", b.x, b.y));
}

/** 分组：右键菜单（新建/展开全部/收起全部/重命名/删除）+ 非编辑态直接拖拽换序 */
async function caseGroupMenus(): Promise<void> {
  await resetView(
    gridData({
      groups: [
        { id: "g1", name: "组一" },
        { id: "g2", name: "组二" },
      ],
      items: makeData(6).items.map((it, i) => ({
        ...it,
        artist: `artist-${it.albumId % 2}`,
        groupId: i < 3 ? "g1" : "g2",
      })),
    })
  );
  const anyView = anyViewOf(view);

  // 顶部不再有分组图标
  const labels = Array.from(
    document.querySelectorAll<HTMLElement>(".mw-toolbar__actions .mw-toolbtn")
  ).map((b) => b.getAttribute("aria-label"));
  result(
    labels.join("|") === "样式与布局|筛选|排序|添加专辑|搜索本墙专辑|更多操作",
    "分组图标已移除（6 个图标）",
    labels.join("|")
  );

  // 墙空白处右键 → 分组相关菜单项
  MENU_LOG.length = 0;
  const grid = document.querySelector<HTMLElement>(".mw-grid")!;
  const gr = grid.getBoundingClientRect();
  grid.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: gr.left + 10,
      clientY: gr.bottom - 10,
    })
  );
  await wait(60);
  const wallMenu = MENU_LOG.at(-1)?.items.map((i) => i.title) ?? [];
  result(wallMenu.includes("新建分组…"), "墙右键菜单可新建分组", wallMenu.join("|"));
  result(
    wallMenu.includes("展开全部分组") && wallMenu.includes("收起全部分组"),
    "墙右键菜单含展开/收起全部",
    wallMenu.join("|")
  );

  // 收起全部 → 所有分区收起且不再渲染卡片
  MENU_LOG.at(-1)!.items.find((i) => i.title === "收起全部分组")!.run!();
  await wait(200);
  const collapsed = Array.from(document.querySelectorAll<HTMLElement>(".mw-section")).every(
    (s) => s.classList.contains("is-collapsed")
  );
  result(collapsed, "一键收起全部生效");
  result(
    document.querySelectorAll(".mw-card").length === 0,
    "收起的分区不渲染卡片",
    document.querySelectorAll(".mw-card").length
  );
  result(
    (anyView.data as { groups: { collapsed?: boolean }[] }).groups.every((g) => g.collapsed === true),
    "收起状态写入数据"
  );

  // 分组头右键 → 重命名/删除/展开收起
  MENU_LOG.length = 0;
  const head = document.querySelector<HTMLElement>(
    '.mw-section[data-mw-group="g1"] .mw-section__head'
  )!;
  head.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
  await wait(60);
  const headMenu = MENU_LOG.at(-1)?.items.map((i) => i.title) ?? [];
  result(
    headMenu.includes("重命名分组…") && headMenu.includes("删除分组…"),
    "分组头右键菜单含重命名/删除",
    headMenu.join("|")
  );
  MENU_LOG.at(-1)!.items.find((i) => i.title === "展开全部分组")!.run!();
  await wait(200);
  result(
    document.querySelectorAll(".mw-card").length === 6,
    "一键展开全部恢复渲染",
    document.querySelectorAll(".mw-card").length
  );

  // 分组头直接拖拽换序：**不需要**编辑模式
  result(
    !document.querySelector<HTMLElement>(".mw-view")!.classList.contains("mw-edit-layout"),
    "拖分组头之前不在编辑态"
  );
  const head2 = document.querySelector<HTMLElement>(
    '.mw-section[data-mw-group="g1"] .mw-section__head'
  )!;
  const head1 = document.querySelector<HTMLElement>(
    '.mw-section[data-mw-group="g2"] .mw-section__head'
  )!;
  const hv = anyViewOf(view) as unknown as {
    resolveDrop(x: number, y: number): unknown;
    dragPayload: unknown;
  };
  const r2 = head2.getBoundingClientRect();
  const probe = { x: r2.left + r2.width / 2, y: r2.top + 4 };
  result(true, "拖拽前探针", {
    head1: head1.dataset ? !!head1 : false,
    head2Rect: [Math.round(r2.left), Math.round(r2.top), Math.round(r2.width)],
    hit: (() => {
      const h = document.elementFromPoint(probe.x, probe.y) as HTMLElement | null;
      return h ? `${h.className || h.tagName}` : "null";
    })(),
  });
  const info = await nativeDrag(head1, head2, () => probe);
  result(true, "分组拖拽 info", {
    info,
    payload: (hv.dragPayload as { kind?: string } | null)?.kind ?? "null",
  });
  const groups = (anyView.data as { groups: { id: string }[] }).groups;
  result(
    groups.map((g) => g.id).join(",") === "g2,g1",
    "非编辑态直接拖拽分组头换序",
    groups.map((g) => g.id).join(",")
  );
  const titles = Array.from(document.querySelectorAll<HTMLElement>(".mw-section__title")).map(
    (t) => t.textContent
  );
  result(titles.join("|") === "组二|组一", "DOM 分组顺序同步", titles.join("|"));
  result(
    !document.querySelector<HTMLElement>(".mw-view")!.classList.contains("mw-edit-layout"),
    "拖完仍不在编辑态"
  );
}

/** 样式预览：四种（MWP 三种）唱片必须完整可见，不能只露一角 */
async function casePreviews(): Promise<void> {
  await resetView(gridData());
  (anyViewOf(view) as unknown as { drawer: { open(k: string): void } }).drawer.open("style");
  await wait(250);

  const stages = Array.from(document.querySelectorAll<HTMLElement>(".mw-preset__stage"));
  result(stages.length === 4, "四种样式瓷砖都在", stages.length);
  for (const stage of stages) {
    const tile = stage.closest<HTMLElement>(".mw-preset")!;
    const style = tile.dataset.mwStyle;
    const disc = stage.querySelector<HTMLElement>(".mw-disc");
    result(!!disc, `${style}：预览内有唱片 DOM`);
    if (!disc) continue;
    const sr = stage.getBoundingClientRect();
    const dr = disc.getBoundingClientRect();
    const inside =
      dr.left >= sr.left - 1 &&
      dr.right <= sr.right + 1 &&
      dr.top >= sr.top - 1 &&
      dr.bottom <= sr.bottom + 1;
    const ratio = (dr.width * dr.height) / (sr.width * sr.height);
    result(inside, `${style}：唱片完整落在瓷砖内（不裁切）`, {
      stage: [Math.round(sr.left), Math.round(sr.top), Math.round(sr.width)],
      disc: [Math.round(dr.left), Math.round(dr.top), Math.round(dr.width)],
    });
    result(ratio > 0.45, `${style}：预览占比合理（不是只露一角）`, ratio.toFixed(2));
  }
}

/** 搜索/添加改为右上角悬浮框；顶部图标只有图标（无底色/无边框） */
async function caseFloatPanels(): Promise<void> {
  await resetView(gridData());
  const btns = Array.from(
    document.querySelectorAll<HTMLElement>(".mw-toolbar__actions .mw-toolbtn")
  );
  result(btns.length === 6, "顶部 6 个图标", btns.length);
  result(!document.querySelector(".mw-searchrow"), "底部搜索条已移除");

  // 纯图标：无底色 / 无边框 / 无阴影
  for (const b of btns) {
    const cs = getComputedStyle(b);
    result(
      cs.backgroundColor === "rgba(0, 0, 0, 0)" || cs.backgroundColor === "transparent",
      `${b.getAttribute("aria-label")}：无按钮底色`,
      cs.backgroundColor
    );
    result(
      cs.borderTopWidth === "0px" && cs.boxShadow === "none",
      `${b.getAttribute("aria-label")}：无边框无阴影`,
      `${cs.borderTopWidth}/${cs.boxShadow}`
    );
  }

  // 放大镜 → 右上角悬浮框（不压暗、无遮罩）
  const searchBtn = btns.find((b) => b.getAttribute("aria-label") === "搜索本墙专辑")!;
  searchBtn.click();
  await wait(200);
  const float = document.querySelector<HTMLElement>(".mw-drawer--float")!;
  const fv = anyViewOf(view) as unknown as {
    floater: { currentKey(): string | null } | null;
  };
  result(!!float, "存在悬浮框外壳");
  result(
    float?.classList.contains("is-open") === true,
    "搜索悬浮框打开",
    {
      cls: float?.className,
      keys: fv.floater?.currentKey() ?? "no-floater",
      count: document.querySelectorAll(".mw-drawer--float").length,
      sameNode: float === (fv.floater as unknown as { panel?: HTMLElement })?.panel,
    }
  );
  result(
    !document.querySelector(".mw-drawer__scrim"),
    "悬浮框同样没有遮罩（不压暗页面）"
  );
  const fr = float.getBoundingClientRect();
  const vr = view.contentEl.getBoundingClientRect();
  result(
    vr.right - fr.right < 40 && fr.top - vr.top < 140,
    "悬浮框锚在右上角",
    { right: Math.round(vr.right - fr.right), top: Math.round(fr.top - vr.top) }
  );
  const input = float.querySelector<HTMLInputElement>(".mw-panel__input")!;
  result(!!input, "悬浮框内有搜索输入");
  input.value = "Album 01";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(150);
  result(
    document.querySelectorAll(".mw-card[data-mw-album]").length === 1,
    "悬浮框搜索即时生效",
    document.querySelectorAll(".mw-card[data-mw-album]").length
  );
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(150);
  result(
    document.querySelectorAll(".mw-card[data-mw-album]").length === 6,
    "清空后恢复全部"
  );

  // ＋ → 同一个悬浮框切换成「添加专辑」
  const addBtn = btns.find((b) => b.getAttribute("aria-label") === "添加专辑")!;
  addBtn.click();
  await wait(200);
  const floatTitle = float.querySelector<HTMLElement>(".mw-drawer__title")!.textContent;
  result(floatTitle === "添加专辑", "同一个悬浮框切到添加专辑", floatTitle);
  result(!!float.querySelector(".mw-search-panel__bar"), "添加面板承载搜索框");
  result(searchBtn.classList.contains("is-active") === false, "切换后搜索图标不再激活");
  result(addBtn.classList.contains("is-active"), "＋ 图标进入激活态");

  // 侧边抽屉与悬浮框互斥
  btns.find((b) => b.getAttribute("aria-label") === "样式与布局")!.click();
  await wait(250);
  result(
    document.querySelector<HTMLElement>(".mw-drawer:not(.mw-drawer--float)")!.classList.contains("is-open"),
    "侧边抽屉打开"
  );
  result(!float.classList.contains("is-open"), "打开侧边抽屉会收起悬浮框");

  // Esc 关闭
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(200);
  result(
    !document.querySelector<HTMLElement>(".mw-drawer:not(.mw-drawer--float)")!.classList.contains("is-open"),
    "Esc 关闭侧边抽屉"
  );
}

/** 缩放：设置 + Ctrl/Alt 滚轮，视图仍精确填满窗格、末张可达、模态框一起缩放 */
async function caseZoom(): Promise<void> {
  await resetView(gridData());
  const plugin = (view as unknown as {
    plugin: { settings: { zoomScale: number }; applyZoom(): void };
  }).plugin;
  plugin.settings.zoomScale = plugin.settings.zoomScale ?? 1;
  const root = view.contentEl;
  const mount = document.getElementById("mount")!;
  const mr = mount.getBoundingClientRect();

  const geom = () => {
    // 外层 .mw-view 是**不缩放**的裁剪盒，它必须精确等于窗格；
    // 内容缩放由内部 .mw-zoombox 负责（zoom + 反除补偿）
    const rr = root.getBoundingClientRect();
    return { rr, mr, box: document.querySelector<HTMLElement>(".mw-zoombox")!.getBoundingClientRect() };
  };
  const fills = (): boolean => {
    const { rr } = geom();
    return (
      Math.abs(rr.width - mr.width) < 2 &&
      Math.abs(rr.height - mr.height) < 2 &&
      Math.abs(rr.left - mr.left) < 2 &&
      Math.abs(rr.top - mr.top) < 2
    );
  };
  result(fills(), "100%：视图精确等于窗格", {
    view: [Math.round(geom().rr.width), Math.round(geom().rr.height)],
    mount: [Math.round(mr.width), Math.round(mr.height)],
  });

  for (const scale of [1.25, 0.8]) {
    plugin.settings.zoomScale = scale;
    plugin.applyZoom();
    await wait(150);
    result(
      document.querySelector<HTMLElement>(".mw-zoombox")!.style.zoom !== "1" ||
        getComputedStyle(document.querySelector<HTMLElement>(".mw-zoombox")!).zoom === String(scale),
      `${Math.round(scale * 100)}%：缩放作用在缩放盒上`,
      getComputedStyle(document.querySelector<HTMLElement>(".mw-zoombox")!).zoom
    );
    // 落点线用的是「rect 差值 / zoom」这个约定：这里用同一算法摆一条线，
    // 必须与目标卡片完全重合（dz=0），否则缩放后落点线会跑偏
    const stage = document.querySelector<HTMLElement>(".mw-stage")!;
    const card = cardOf(3);
    const line = document.createElement("div");
    line.style.cssText = "position:absolute;z-index:9999;background:red;";
    stage.appendChild(line);
    const sr = stage.getBoundingClientRect();
    const cr = card.getBoundingClientRect();
    line.style.left = `${(cr.left - sr.left) / scale}px`;
    line.style.top = `${(cr.top - sr.top) / scale}px`;
    line.style.width = "3px";
    line.style.height = `${cr.height / scale}px`;
    await wait(50);
    const lr = line.getBoundingClientRect();
    result(
      Math.abs(lr.left - cr.left) <= 1.5 &&
        Math.abs(lr.top - cr.top) <= 1.5 &&
        Math.abs(lr.height - cr.height) <= 2.5,
      `${Math.round(scale * 100)}%：落点线定位约定成立（rect/zoom 与目标重合）`,
      {
        delta: [
          Math.round(lr.left - cr.left),
          Math.round(lr.top - cr.top),
          Math.round(lr.height - cr.height),
        ],
      }
    );
    line.remove();

    const visual = geom().box;
    result(
      fills(),
      `${Math.round(scale * 100)}%：视图仍精确等于窗格（无裁切/溢出）`,
      {
        view: [Math.round(geom().rr.width), Math.round(geom().rr.height)],
        mount: [Math.round(mr.width), Math.round(mr.height)],
        zoombox: [Math.round(visual.width), Math.round(visual.height)],
      }
    );
    // 缩放盒自身也必须等于窗格（视觉像素）。旧的 zoom 写法在这里会露馅：
    // 反除补偿生效但放大失效 ⇒ 缩放盒只有窗格的 1/z（>100% 留白、<100% 溢出）。
    result(
      Math.abs(visual.width - mr.width) < 2 && Math.abs(visual.height - mr.height) < 2,
      `${Math.round(scale * 100)}%：缩放盒精确等于窗格`,
      {
        zoombox: [Math.round(visual.width), Math.round(visual.height)],
        mount: [Math.round(mr.width), Math.round(mr.height)],
      }
    );
    // 内容真的铺满：四角 + 顶边中点 + 底边中点的命中栈里必须出现缩放盒/网格。
    // 这条是本次缺陷的直接守卫——旧断言只看「根元素 == 窗格」（根永远是窗格）
    // 与 root.contains(hit)（命中根元素时也成立），所以「内容只占 1/z」能一路绿灯。
    const probes: [number, number][] = [
      [mr.left + 4, mr.top + 4],
      [mr.right - 4, mr.top + 4],
      [mr.left + 4, mr.bottom - 4],
      [mr.right - 4, mr.bottom - 4],
      [mr.left + mr.width / 2, mr.bottom - 4],
      [mr.right - 4, mr.top + mr.height / 2],
    ];
    const stacks = probes.map(([px, py]) =>
      document
        .elementsFromPoint(
          Math.min(Math.max(px, 2), window.innerWidth - 2),
          Math.min(Math.max(py, 2), window.innerHeight - 2)
        )
        .map((el) => String((el as HTMLElement).className || el.tagName))
    );
    const covered = stacks.every((s) =>
      s.some((c) => c.includes("mw-zoombox") || c.includes("mw-grid"))
    );
    result(
      covered,
      `${Math.round(scale * 100)}%：内容铺满窗格（四角与边中点都命中缩放盒）`,
      stacks.map((s) => s.slice(0, 3).join(">")).join(" | ")
    );
    // 视觉兜底：窗格右下角必须仍然命中本视图（填满且无裁切）。
    // 探针要夹进视口（mount 可能比可视区高，或者落点恰好在窗口外）
    const px = Math.min(mr.right - 4, window.innerWidth - 4);
    const py = Math.min(mr.bottom - 4, window.innerHeight - 4);
    const hit = document.elementFromPoint(px, py);
    // 逐卡命中：缩放后「画出来的位置」必须仍然点得到（zoom 反除不能只对绘制生效）
    const cardHits = Array.from(document.querySelectorAll<HTMLElement>(".mw-card")).map((c) => {
      const r = c.getBoundingClientRect();
      if (r.bottom > window.innerHeight || r.top < 0) return "offscreen";
      const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return h && (c === h || c.contains(h)) ? "ok" : h ? "other" : "null";
    });
    result(
      !!hit && root.contains(hit),
      `${Math.round(scale * 100)}%：窗格右下角仍落在视图内（未被裁切）`,
      {
        probe: [Math.round(px), Math.round(py)],
        hit: hit ? (hit as HTMLElement).className || hit.tagName : "null",
        cardHits: cardHits.join(","),
      }
    );
    result(
      cardHits.every((h) => h === "ok" || h === "offscreen"),
      `${Math.round(scale * 100)}%：可见卡片全部可命中（缩放未产生点不到的区域）`,
      cardHits.join(",")
    );

    const gridEl = document.querySelector<HTMLElement>(".mw-grid")!;
    const last = Array.from(document.querySelectorAll<HTMLElement>(".mw-card")).at(-1)!;
    gridEl.scrollTop = gridEl.scrollHeight;
    await wait(80);
    const lr2 = last.getBoundingClientRect();
    const gr2 = gridEl.getBoundingClientRect();
    result(
      lr2.bottom <= gr2.bottom + 2 && lr2.top >= gr2.top - 2,
      `${Math.round(scale * 100)}%：滚到底后末张卡片完整可见`,
      { cardBottom: Math.round(lr2.bottom), gridBottom: Math.round(gr2.bottom) }
    );
    gridEl.scrollTop = 0;
  }

  // Ctrl + 滚轮：改设置、更新变量、弹提示
  plugin.settings.zoomScale = 1;
  plugin.applyZoom();
  await wait(120);
  const before = plugin.settings.zoomScale;
  for (let i = 0; i < 3; i++) {
    root.dispatchEvent(
      new WheelEvent("wheel", { deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true })
    );
  }
  await wait(150);
  result(
    plugin.settings.zoomScale > before,
    "Ctrl+滚轮 放大",
    plugin.settings.zoomScale
  );
  result(
    document.body.style.getPropertyValue("--mw-zoom") === String(plugin.settings.zoomScale),
    "缩放变量已写到 body",
    document.body.style.getPropertyValue("--mw-zoom")
  );
  result(!!document.querySelector(".mw-zoomtoast.is-visible"), "出现缩放提示");
  const zoomed = plugin.settings.zoomScale;
  root.dispatchEvent(
    new WheelEvent("wheel", { deltaY: 100, altKey: true, bubbles: true, cancelable: true })
  );
  await wait(150);
  result(plugin.settings.zoomScale < zoomed, "Alt+滚轮 缩小", plugin.settings.zoomScale);

  // 无修饰键的滚轮不得被吞掉（要留给滚动）
  const plain = new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true });
  root.dispatchEvent(plain);
  result(!plain.defaultPrevented, "普通滚轮不被缩放拦截（仍用于滚动）");

  // 模态框一起缩放
  plugin.settings.zoomScale = 2;
  plugin.applyZoom();
  await wait(120);
  const { ConfirmModal } = await import("../src/ui/ConfirmModal");
  const app = { setting: { open() {}, openTabById() {} } };
  const modal = new ConfirmModal(app as never, {
    title: "缩放测试",
    message: "x",
    onConfirm: () => {},
  });
  modal.open();
  await wait(150);
  const modalEl = document.querySelector<HTMLElement>(".mw-modal-zoom .modal");
  result(!!modalEl, "模态框挂上了缩放作用域类");
  const mr2 = modalEl!.getBoundingClientRect();
  result(mr2.width > 560 * 1.5, "模态框随 200% 一起放大", Math.round(mr2.width));
  modal.close();

  plugin.settings.zoomScale = 1;
  plugin.applyZoom();
  await wait(100);
}

/** 跨分组拖动：改变分组归属并重排 order */
async function caseCrossGroupMove(): Promise<void> {
  await resetView(
    gridData({
      groups: [
        { id: "g1", name: "组一" },
        { id: "g2", name: "组二" },
      ],
      items: makeData(6).items.map((it, i) => ({
        ...it,
        artist: `artist-${it.albumId % 2}`,
        groupId: i < 3 ? "g1" : "g2",
      })),
    })
  );
  const anyView = anyViewOf(view);
  const data = anyView.data as {
    items: { albumId: number; groupId?: string }[];
    order?: number[];
  };
  result(
    document.querySelectorAll('.mw-section[data-mw-group="g1"] .mw-card').length === 3,
    "组一初始 3 张"
  );

  // 把组一的 album 1 拖到组二的 album 5（非相邻）右半
  anyView.enterEditMode();
  await wait(150);
  const info = await nativeDrag(cardOf(1), cardOf(5));
  result(info.overPrevented, "编辑态：跨组拖拽被本墙接收", info);
  result(data.items.find((i) => i.albumId === 1)?.groupId === "g2", "分组归属已改变");
  const g1Count = document.querySelectorAll('.mw-section[data-mw-group="g1"] .mw-card').length;
  const g2Count = document.querySelectorAll('.mw-section[data-mw-group="g2"] .mw-card').length;
  result(g1Count === 2 && g2Count === 4, "两组计数随之更新", `${g1Count}/${g2Count}`);
  result(
    document.querySelector('.mw-section[data-mw-group="g2"] .mw-card')?.dataset.mwAlbum !==
      undefined,
    "跨组后卡片仍在网格内"
  );
  const g2Ids = Array.from(
    document.querySelectorAll<HTMLElement>('.mw-section[data-mw-group="g2"] .mw-card')
  ).map((el) => el.dataset.mwAlbum);
  result(g2Ids.join(",") === "4,5,1,6", "落在锚点卡片之后且组内顺序正确", g2Ids.join(","));

  // 分组头整体拖拽换序：把「组二」拖到「组一」之前（不需要编辑模式）
  anyView.exitEditMode();
  await wait(150);
  const head1 = document.querySelector<HTMLElement>(
    '.mw-section[data-mw-group="g2"] .mw-section__head'
  )!;
  const head2 = document.querySelector<HTMLElement>(
    '.mw-section[data-mw-group="g1"] .mw-section__head'
  )!;
  await nativeDrag(head1, head2, (r) => ({ x: r.left + r.width / 2, y: r.top + 4 }));  const groups = (data as unknown as { groups: { id: string }[] }).groups;
  result(
    groups.map((g) => g.id).join(",") === "g2,g1",
    "分组整体拖拽换序",
    groups.map((g) => g.id).join(",")
  );
  const headsAfter = Array.from(
    document.querySelectorAll<HTMLElement>(".mw-section__title")
  ).map((t) => t.textContent);
  result(headsAfter.join("|") === "组二|组一", "DOM 分组顺序同步", headsAfter.join("|"));
}

// ---- 第 3 轮新增：跨组落点 / 展示架面板主题 / 遮罩覆盖 ----

/** "#rrggbb" / "rgb(a, b, c)" → [r,g,b] */
function parseRgb(v: string): [number, number, number] {
  const m = /rgba?\(([^)]+)\)/.exec(v);
  if (m) {
    const p = m[1].split(",").map((s) => parseFloat(s));
    return [p[0] || 0, p[1] || 0, p[2] || 0];
  }
  const h = /#([0-9a-f]{3,8})/i.exec(v);
  if (h) {
    const s = h[1];
    const n = (i: number) => parseInt(s.slice(i, i + 2), 16);
    return [n(0), n(2), n(4)];
  }
  return [0, 0, 0];
}

/** 相对亮度（0..1），用于对比度断言 */
function relLum(c: [number, number, number]): number {
  const f = (v: number) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const la = relLum(a);
  const lb = relLum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * 跨分组拖拽的三条「曾经会静默失败」的路径：
 * 空分组（没有任何卡片 DOM）、收起的分组（卡片被 display:none）、分组头。
 * 旧实现此时把锚点解析成被拖的唱片自己，commitDrop 直接丢弃这次落点。
 */
async function caseCrossGroupTargets(): Promise<void> {
  await resetView(
    gridData({
      groups: [
        { id: "g1", name: "组一" },
        { id: "g2", name: "空组" },
        { id: "g3", name: "收起组", collapsed: true },
      ],
      items: makeData(7).items.map((it, i) => ({
        ...it,
        artist: `artist-${it.albumId % 2}`,
        groupId: i < 3 ? "g1" : i === 3 ? "g3" : undefined,
      })),
    })
  );
  const anyView = anyViewOf(view);
  const data = anyView.data as {
    items: { albumId: number; groupId?: string }[];
    groups: { id: string; collapsed?: boolean }[];
  };
  const groupOf = (id: number) => data.items.find((i) => i.albumId === id)?.groupId ?? "";
  const headOf = (gid: string) =>
    document.querySelector<HTMLElement>(
      `.mw-section[data-mw-group="${gid}"] .mw-section__head`
    )!;
  const sectionOf = (gid: string) =>
    document.querySelector<HTMLElement>(`.mw-section[data-mw-group="${gid}"]`);

  result(!!headOf("g2") && !sectionOf("g2")!.querySelector(".mw-card"), "空组：只有表头，没有卡片");
  result(
    !!headOf("g3") && !sectionOf("g3")!.querySelector(".mw-card"),
    "收起组：卡片不在 DOM 里"
  );

  anyView.enterEditMode();
  await wait(150);

  // (a) 拖到空分组：悬停时必须整组高亮，松手必须改归属
  const from = cardOf(1);
  const head = headOf("g2");
  const a = centerOf(from);
  from.dispatchEvent(pointer("pointerdown", a.x, a.y));
  const dt = makeDataTransfer();
  from.dispatchEvent(dragEvent("dragstart", dt));
  const hr = head.getBoundingClientRect();
  const p = clampToViewport({ x: hr.left + hr.width / 2, y: hr.top + hr.height / 2 }, hr);
  head.dispatchEvent(dragEvent("dragover", dt, p));
  await wait(80);
  result(
    !!sectionOf("g2")?.classList.contains("is-drop-section"),
    "悬停空分组：整组高亮（可见反馈）"
  );
  head.dispatchEvent(dragEvent("drop", dt, p));
  from.dispatchEvent(dragEvent("dragend", dt));
  await wait(220);
  result(groupOf(1) === "g2", "拖到空分组：归属已改为 g2", groupOf(1));
  result(
    sectionOf("g2")!.querySelectorAll(".mw-card").length === 1,
    "空分组里出现了这张唱片"
  );

  // (b) 拖到收起的分组：锚点要按数据算（卡片根本不在 DOM 里）
  // 长墙里收起的分组可能落在视口之外：先把表头滚进视野再拖（用户也是这么做的），
  // 否则落点会被夹到视口边缘、命中别的分区（不是产品缺陷）
  headOf("g3").scrollIntoView({ block: "center" });
  await wait(150);
  await nativeDrag(cardOf(2), headOf("g3"));
  await wait(120);
  result(groupOf(2) === "g3", "拖到收起的分组：归属已改为 g3", groupOf(2));
  result(
    data.groups.find((g) => g.id === "g3")?.collapsed === true,
    "收起状态保持不变（不会被拖拽改成展开）"
  );
  // 展开后应能看到两张（原有一张 + 新拖入的一张）
  headOf("g3").querySelector<HTMLElement>(".mw-section__chevron")!.click();
  await wait(200);
  result(
    sectionOf("g3")!.querySelectorAll(".mw-card").length === 2,
    "展开收起组：两张唱片都在",
    String(sectionOf("g3")!.querySelectorAll(".mw-card").length)
  );

  // (c) 拖到分组头（表头那一条）：同组自己的表头不应产生位移
  headOf("g1").scrollIntoView({ block: "center" });
  await wait(150);
  const before = (anyView.data as { order?: number[] }).order?.join(",") ?? "";
  await nativeDrag(cardOf(3), headOf("g1"));
  await wait(120);
  const after = (anyView.data as { order?: number[] }).order?.join(",") ?? "";
  result(before === after && groupOf(3) === "g1", "同组表头落点：原地不动（无副作用）");
}

/** 展示架模式下抽屉必须跟着木墙配色（浅色主题下也不该是白底） */
async function caseShelfPanelTheme(): Promise<void> {
  await resetView(gridData({ layout: "shelf" }));
  const anyView = anyViewOf(view);
  anyView.drawer.open("style");
  await wait(250);
  const panel = document.querySelector<HTMLElement>(".mw-drawer:not(.mw-drawer--float)")!;
  const cs = getComputedStyle(panel);
  const bg = parseRgb(cs.backgroundColor);
  const fg = parseRgb(cs.color);
  result(bg[0] < 120 && bg[0] >= bg[2], "展示架抽屉底色是暖色（不是主题白）", cs.backgroundColor);
  result(contrast(fg, bg) >= 3, "面板正文与底色对比度 ≥ 3", {
    fg: cs.color,
    bg: cs.backgroundColor,
    contrast: Math.round(contrast(fg, bg) * 100) / 100,
  });
  const preset = panel.querySelector<HTMLElement>(".mw-preset");
  const pcs = preset ? getComputedStyle(preset) : null;
  const raw = pcs?.backgroundColor ?? "";
  const pm = /rgba?\(([^)]+)\)/.exec(raw);
  const parts = pm ? pm[1].split(",").map((x) => parseFloat(x)) : [0, 0, 0, 1];
  const alpha = parts.length > 3 ? parts[3] : 1;
  // 半透明的暖色底是我们要的；不透明的近白才是「被主题刷成白卡」
  const opaqueWhite = alpha > 0.9 && parts[0] > 225 && parts[1] > 225 && parts[2] > 225;
  result(!!pcs && !opaqueWhite, "预设瓷砖同样走面板 token（不是主题白卡）", raw);
  const input = panel.querySelector<HTMLElement>(".mw-panel__input");
  result(true, "面板内控件存在性", input ? "input" : "none");
}

/**
 * 侧边抽屉**没有遮罩**（第四轮）：不再压暗页面、不会盖住顶栏图标、也不会
 * 留下「看得见但点不动」的幽灵层。同时验证关闭/复开与 dispose 后的类名清理。
 */
async function caseNoScrim(): Promise<void> {
  await resetView(gridData());
  const anyV = anyViewOf(view);
  const root = view.contentEl;
  const iconCenter = () => {
    const btn = root.querySelector<HTMLElement>(".mw-toolbar .mw-toolbtn")!;
    const r = btn.getBoundingClientRect();
    return { btn, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  };
  const hitAt = (x: number, y: number): HTMLElement | null =>
    document.elementFromPoint(
      Math.min(Math.max(x, 2), window.innerWidth - 2),
      Math.min(Math.max(y, 2), window.innerHeight - 2)
    ) as HTMLElement | null;

  result(!root.querySelector(".mw-drawer__scrim"), "抽屉没有遮罩元素");
  anyV.drawer.open("style");
  await wait(250);
  result(!root.querySelector(".mw-drawer__scrim"), "打开后依然没有遮罩元素");
  // 打开面板后，窗格四角与顶栏都应仍然命中墙面/工具栏本身（没有被覆盖层吃掉点击）
  const r = root.getBoundingClientRect();
  const probes: [string, number, number][] = [
    ["左上", r.left + 4, r.top + 4],
    ["右上", r.right - 4, r.top + 4],
    ["左下", r.left + 4, r.bottom - 6],
    ["顶栏中点", (r.left + r.right) / 2, r.top + 18],
    ["底边中点", (r.left + r.right) / 2, r.bottom - 6],
  ];
  const hits = probes.map(([label, x, y]) => {
    const el = hitAt(x, y);
    return `${label}:${String(el?.className ?? el?.tagName ?? "null")}`;
  });
  result(
    hits.every((h) => !h.includes("scrim")),
    "面板打开时没有被覆盖层遮挡（四角与顶栏都命中原元素）",
    hits.join(" | ")
  );
  // 顶栏图标必须自己就是命中要素（曾经被遮罩盖住，点它等于点遮罩）
  const c1 = iconCenter();
  const hit1 = hitAt(c1.x, c1.y);
  result(
    !!hit1 && (hit1 === c1.btn || c1.btn.contains(hit1)),
    "面板打开时顶栏图标仍可点（不被遮罩盖住）",
    String(hit1?.className ?? hit1?.tagName ?? "null")
  );
  // 关闭后图标可点，且能再次打开
  root.querySelector<HTMLElement>(".mw-drawer:not(.mw-drawer--float) .mw-drawer__close")!.click();
  await wait(200);
  result(!anyV.drawer.isOpen(), "× 关闭抽屉");
  const c2 = iconCenter();
  const hit2 = hitAt(c2.x, c2.y);
  result(
    !!hit2 && (hit2 === c2.btn || c2.btn.contains(hit2)),
    "关闭后顶栏图标可点",
    String(hit2?.className ?? hit2?.tagName ?? "null")
  );
  c2.btn.click();
  await wait(200);
  result(anyV.drawer.isOpen(), "再点图标能重新打开");
  // 幽灵层加固：dispose 时必须把 DOM 上的 is-open 一起摘掉
  const panel = root.querySelector<HTMLElement>(".mw-drawer:not(.mw-drawer--float)")!;
  anyV.drawer.dispose();
  result(!panel.classList.contains("is-open"), "dispose 后不留 is-open（不会变幽灵面板）");
}

/** 编辑条是正常流的一行：不能压在工具栏上（图标与文字都不能重叠） */
async function caseEditbarClear(): Promise<void> {
  await resetView(gridData());
  const anyV = anyViewOf(view);
  anyV.enterEditMode();
  await wait(220);
  const bar = document.querySelector<HTMLElement>(".mw-editbar")!;
  const toolbar = document.querySelector<HTMLElement>(".mw-toolbar")!;
  const br = bar.getBoundingClientRect();
  const tr = toolbar.getBoundingClientRect();
  result(!!bar, "编辑条存在");
  result(
    br.bottom <= tr.top + 1,
    "编辑条在工具栏上方且不重叠",
    { barBottom: Math.round(br.bottom), toolbarTop: Math.round(tr.top) }
  );
  const overlaps = Array.from(toolbar.querySelectorAll<HTMLElement>(".mw-toolbtn")).map((b) => {
    const r = b.getBoundingClientRect();
    return !(r.bottom <= br.top || r.top >= br.bottom) && !(r.right <= br.left || r.left >= br.right);
  });
  result(!overlaps.some(Boolean), "工具栏图标都不与编辑条相交", overlaps.join(","));
  // 每个图标中心都应命中自己（重叠时会被编辑条抢走命中）
  const misses = Array.from(toolbar.querySelectorAll<HTMLElement>(".mw-toolbtn")).filter((b) => {
    const r = b.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !hit || !(hit === b || b.contains(hit));
  });
  result(misses.length === 0, "工具栏图标中心都命中自己", misses.length);
  // 顶栏下沿（含编辑条）写进 --mw-topbar-h：面板要落在它下面
  const topbar = Number(
    (view.contentEl.style.getPropertyValue("--mw-topbar-h") || "0").replace("px", "")
  );
  const hostTop = document.querySelector<HTMLElement>(".mw-zoombox")!.getBoundingClientRect().top;
  const zoomEl = Array.from(document.querySelectorAll<HTMLElement>(".mw-zoombox"))[0];
  const z = Number(getComputedStyle(zoomEl).getPropertyValue("--mw-zoom")) || 1;
  result(
    Math.abs(hostTop + topbar * z - tr.bottom) < 4,
    "--mw-topbar-h 按工具栏底部计算（含编辑条）",
    { topbar, toolbarBottom: Math.round(tr.bottom), hostTop: Math.round(hostTop) }
  );
  anyV.exitEditMode();
  await wait(200);
  result(!document.querySelector(".mw-editbar"), "退出编辑态后编辑条移除");
}

/** 分区之间要有可见的上下间距（展示架与网格都不能贴在一起） */
async function caseSectionGaps(): Promise<void> {
  const probe = async (layout: "grid" | "shelf") => {
    await resetView(
      gridData({
        layout: layout === "grid" ? undefined : layout,
        groups: [
          { id: "g1", name: "组合一" },
          { id: "g2", name: "组合二" },
        ],
        items: makeData(8).items.map((it, i) => ({
          ...it,
          artist: `artist-${it.albumId % 2}`,
          groupId: i < 4 ? "g1" : "g2",
        })),
      })
    );
    await wait(200);
    const sections = Array.from(document.querySelectorAll<HTMLElement>(".mw-section"));
    const s1 = sections[0];
    const s2 = sections[1];
    const head1 = s1.querySelector<HTMLElement>(".mw-section__head")!.getBoundingClientRect();
    const cards1 = s1.querySelector<HTMLElement>(".mw-section__cards")!.getBoundingClientRect();
    const lastItem = Array.from(
      s1.querySelectorAll<HTMLElement>("[data-mw-album]")
    ).at(-1)!.getBoundingClientRect();
    const head2 = s2.querySelector<HTMLElement>(".mw-section__head")!.getBoundingClientRect();
    result(
      cards1.top - head1.bottom >= 12,
      `${layout}：分组头 → 卡片留出间距`,
      Math.round(cards1.top - head1.bottom)
    );
    result(
      head2.top - lastItem.bottom >= 14,
      `${layout}：上一分区末卡 → 下一分区头留出间距`,
      Math.round(head2.top - lastItem.bottom)
    );
  };
  await probe("grid");
  await probe("shelf");
}

/** 样式面板：布局在上、唱片样式在下；唱片样式只在网格布局出现 */
async function caseStylePanelOrder(): Promise<void> {
  await resetView(gridData({ layout: undefined }));
  const anyV = anyViewOf(view);
  anyV.drawer.open("style");
  await wait(220);
  const labels = () =>
    Array.from(
      document.querySelectorAll<HTMLElement>(
        ".mw-drawer:not(.mw-drawer--float) .mw-panel__label"
      )
    ).map((el) => el.textContent ?? "");
  result(labels().join(">") === "布局>唱片样式", "网格：顺序为 布局 → 唱片样式", labels().join(">"));
  result(
    document.querySelectorAll(".mw-preset[data-mw-style]").length === 4,
    "网格：四种唱片样式都在"
  );
  // 切到展示架：重绘后面板按新布局重建
  document.querySelector<HTMLElement>('.mw-preset[data-mw-layout="shelf"]')!.click();
  await wait(320);
  const after = labels();
  result(after.join(">") === "布局", "展示架：不再显示唱片样式组", after.join(">"));
  result(
    document.querySelectorAll(".mw-preset[data-mw-style]").length === 0,
    "展示架：样式瓷砖已移除"
  );
  const hint = document.querySelector<HTMLElement>(
    ".mw-drawer:not(.mw-drawer--float) .mw-panel__hint"
  );
  result(
    hint?.textContent?.includes("只在网格布局下生效") === true,
    "展示架：保留一行说明",
    hint?.textContent
  );
}

/** 面板控件与输入框：不接受主题的白底（单类规则会被 button:not(.clickable-icon) 压过） */
async function casePanelControls(): Promise<void> {
  await resetView(
    gridData({
      groups: [{ id: "g1", name: "组一" }],
      items: makeData(6).items.map((it, i) => ({
        ...it,
        artist: `artist-${it.albumId % 2}`,
        groupId: i < 3 ? "g1" : undefined,
      })),
    })
  );
  const anyV = anyViewOf(view);
  const WHITE = [238, 240, 244]; // 假主题给裸 button 刷的白底
  const nearWhite = (c: string) => {
    const [r, g, b] = parseRgb(c);
    return r > 225 && g > 225 && b > 225;
  };
  // 排序面板：升降序两个按钮（一个 active 一个非 active）
  anyV.drawer.open("sort");
  await wait(220);
  const dirbtns = Array.from(
    document.querySelectorAll<HTMLElement>(".mw-drawer .mw-dirbtn")
  );
  result(dirbtns.length === 2, "排序面板有升/降序两个按钮", dirbtns.length);
  const dirBg = dirbtns.map((b) => getComputedStyle(b).backgroundColor);
  result(!dirBg.some(nearWhite), "升降序按钮不是主题白底", dirBg.join(" | "));
  const active = dirbtns.find((b) => b.classList.contains("is-active"));
  result(
    !!active && !nearWhite(getComputedStyle(active).backgroundColor),
    "激活态按钮走 accent",
    active ? getComputedStyle(active).backgroundColor : "none"
  );
  const editBtn = document.querySelector<HTMLElement>(".mw-drawer .mw-panel__add")!;
  result(
    !nearWhite(getComputedStyle(editBtn).backgroundColor),
    "「调整顺序（编辑布局）」不是白底",
    getComputedStyle(editBtn).backgroundColor
  );
  // 筛选面板：清除按钮透明底、文字非黑
  anyV.drawer.open("filter");
  await wait(220);
  const clear = document.querySelector<HTMLElement>(".mw-drawer .mw-panel__clear")!;
  const ccs = getComputedStyle(clear);
  result(!nearWhite(ccs.backgroundColor), "「清除」不是白底药丸", ccs.backgroundColor);
  const [cr, cg, cb] = parseRgb(ccs.color);
  result(cr + cg + cb > 120, "「清除」文字颜色可辨（非近黑主题色）", ccs.color);
  // 输入框：静息/聚焦都不变白，且 hover 变量被面板接管
  const input = document.querySelector<HTMLInputElement>(".mw-drawer .mw-panel__input")!;
  const ics = getComputedStyle(input);
  result(!nearWhite(ics.backgroundColor), "输入框静息底色走面板 token", ics.backgroundColor);
  input.focus();
  await wait(80);
  const fcs = getComputedStyle(input);
  result(!nearWhite(fcs.backgroundColor), "输入框聚焦后也不变白", fcs.backgroundColor);
  const drawerEl = document.querySelector<HTMLElement>(".mw-drawer")!;
  const hl = getComputedStyle(drawerEl)
    .getPropertyValue("--background-modifier-form-field-highlighted")
    .trim();
  result(!!hl, "面板内覆盖了表单 hover 变量（主题的白色高亮被接管）", hl);
  // 合成探针：搜索行按钮同样不该是白底
  const probe = document.querySelector<HTMLElement>(".mw-drawer__body")!;
  const a = probe.createEl("button", { cls: "mw-search-row__add", text: "添加" });
  const b = probe.createEl("button", { cls: "mw-search-more", text: "加载更多" });
  result(
    !nearWhite(getComputedStyle(a).backgroundColor) &&
      !nearWhite(getComputedStyle(b).backgroundColor),
    "搜索行「添加 / 加载更多」不是白底",
    `${getComputedStyle(a).backgroundColor} | ${getComputedStyle(b).backgroundColor}`
  );
  a.remove();
  b.remove();
}

/** 三处面板的「清空」都改成输入框右端的 ×，且真的能清空 */
async function caseClearX(): Promise<void> {
  await resetView(gridData());
  const anyV = anyViewOf(view);
  // 搜索本墙（悬浮框）
  anyV.floater.open("search");
  await wait(220);
  const bar = document.querySelector<HTMLElement>(".mw-drawer--float .mw-panel__searchbar")!;
  result(!!bar, "搜索本墙：输入行包裹了 searchbar");
  result(
    !document.querySelector(".mw-drawer--float .mw-panel__reset"),
    "搜索本墙：不再有整宽「清空」按钮"
  );
  const input = bar.querySelector<HTMLInputElement>(".mw-panel__input")!;
  const clearBtn = bar.querySelector<HTMLElement>(".mw-panel__clearicon")!;
  result(!!clearBtn, "搜索本墙：× 清空钮存在");
  result(clearBtn.classList.contains("is-hidden"), "空输入时 × 隐藏");
  input.value = "Album 01";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(180);
  result(!clearBtn.classList.contains("is-hidden"), "有输入时 × 出现");
  result(
    document.querySelectorAll(".mw-card[data-mw-album]").length === 1,
    "输入即筛（剩 1 张）",
    document.querySelectorAll(".mw-card[data-mw-album]").length
  );
  clearBtn.click();
  await wait(200);
  result(input.value === "" && anyV.q === "", "点 × 清空输入与筛选词", input.value);
  result(
    document.querySelectorAll(".mw-card[data-mw-album]").length === 6,
    "清空后恢复全部",
    document.querySelectorAll(".mw-card[data-mw-album]").length
  );
  // 筛选面板的关键词行同样有 ×
  anyV.drawer.open("filter");
  await wait(220);
  const fbar = document.querySelector<HTMLElement>(".mw-drawer .mw-panel__searchbar")!;
  result(!!fbar?.querySelector(".mw-panel__clearicon"), "筛选面板：关键词行也有 ×");
}

/** 卡片菜单的「移动到分组…」走模态选择框（不再用会撑爆屏幕的内联子菜单） */
async function caseGroupPicker(): Promise<void> {
  await resetView(
    gridData({
      groups: [
        { id: "g1", name: "组一" },
        { id: "g2", name: "组二" },
      ],
      items: makeData(6).items.map((it, i) => ({
        ...it,
        artist: `artist-${it.albumId % 2}`,
        groupId: i < 3 ? "g1" : undefined,
      })),
    })
  );
  const anyV = anyViewOf(view);
  MENU_LOG.length = 0;
  const card = cardOf(1);
  const r = card.getBoundingClientRect();
  card.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: r.left + 4,
      clientY: r.top + 4,
    })
  );
  await wait(120);
  const menu = MENU_LOG.at(-1);
  const entry = menu?.items.find((it) => it.title.startsWith("移动到分组"));
  result(!!entry, "菜单里有「移动到分组…」", menu?.items.map((i) => i.title).join("|"));
  result(!entry?.submenu, "不再使用内联子菜单");
  entry?.run?.();
  await wait(200);
  const modal = document.querySelector<HTMLElement>(".modal-container .mw-picker");
  result(!!modal, "打开模态选择框");
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".mw-picker__row"));
  result(rows.length === 3, "列出 未分组 + 两个分组", rows.map((x) => x.textContent).join(" | "));
  result(
    rows[1]?.textContent?.includes("✓") === true,
    "当前所在分组标 ✓",
    rows[1]?.textContent
  );
  // 选「未分组」→ 归属改变、两组计数同步
  rows[0].click();
  await wait(250);
  const data = anyV.data as { items: { albumId: number; groupId?: string }[] };
  result(
    data.items.find((i) => i.albumId === 1)?.groupId === undefined,
    "选中后归属改为未分组",
    String(data.items.find((i) => i.albumId === 1)?.groupId)
  );
  result(!document.querySelector(".mw-picker"), "选择后模态框关闭");
}

/**
 * 交互走查（交付前的「真实交互」自测）：把用户实际会点的一串动作按顺序走一遍，
 * 每步都断言「点得到 + 状态对」，最后确认没有残留覆盖层、图标仍然可点。
 * 与其它场景的区别：这里刻意连成一条链，任何一步破坏了后续交互都会被抓到。
 */
async function caseInteractionWalk(): Promise<void> {
  await resetView(
    gridData({
      groups: [
        { id: "g1", name: "组一" },
        { id: "g2", name: "组二" },
      ],
      items: makeData(6).items.map((it, i) => ({
        ...it,
        artist: `artist-${it.albumId % 2}`,
        groupId: i < 3 ? "g1" : undefined,
      })),
    })
  );
  const anyV = anyViewOf(view);
  const root = view.contentEl;
  const steps: string[] = [];
  const clickable = (el: HTMLElement, label: string): boolean => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const ok = !!hit && (hit === el || el.contains(hit));
    steps.push(`${label}:${ok ? "ok" : "blocked(" + String(hit?.className ?? "null") + ")"}`);
    return ok;
  };
  const icons = () =>
    Array.from(root.querySelectorAll<HTMLElement>(".mw-toolbar .mw-toolbtn"));

  // ① 六个顶栏图标：每个都先确认点得到，再点开对应面板/菜单
  const iconList = icons();
  result(iconList.length === 6, "顶栏 6 个图标齐全", iconList.length);
  const reachable = iconList.every((b, i) => clickable(b, `图标${i}`));
  result(reachable, "六个图标都可点（无覆盖层）", steps.join(" "));
  steps.length = 0;

  iconList[0].click();
  await wait(200);
  result(anyV.drawer.currentKey() === "style", "样式面板打开");
  iconList[1].click();
  await wait(200);
  result(anyV.drawer.currentKey() === "filter", "筛选面板打开（互斥切换）");
  iconList[2].click();
  await wait(200);
  result(anyV.drawer.currentKey() === "sort", "排序面板打开");
  // ② 排序面板：切类型 + 切方向
  const radios = Array.from(
    root.querySelectorAll<HTMLInputElement>('.mw-drawer input[name="mw-sort-mode"]')
  );
  radios[1].checked = true;
  radios[1].dispatchEvent(new Event("change", { bubbles: true }));
  await wait(220);
  result(anyV.sortMode === "addedAt", "排序类型切到「添加时间」", anyV.sortMode);
  const dirs = Array.from(root.querySelectorAll<HTMLElement>(".mw-drawer .mw-dirbtn"));
  dirs[1].click();
  await wait(220);
  result(anyV.sortAsc === false, "切到降序", String(anyV.sortAsc));
  // ③ 进入/退出布局编辑（编辑条与工具栏不能重叠）
  const editBtn = root.querySelector<HTMLElement>(".mw-drawer .mw-panel__add")!;
  clickable(editBtn, "调整顺序按钮");
  editBtn.click();
  await wait(260);
  result(anyV.editMode === true, "进入布局编辑");
  const barRect = document.querySelector<HTMLElement>(".mw-editbar")!.getBoundingClientRect();
  const tbRect = document.querySelector<HTMLElement>(".mw-toolbar")!.getBoundingClientRect();
  result(barRect.bottom <= tbRect.top + 1, "编辑条不压工具栏");
  const doneBtn = Array.from(
    root.querySelectorAll<HTMLElement>(".mw-editbar .mw-editbar__btn")
  ).find((b) => b.textContent === "完成")!;
  clickable(doneBtn, "完成按钮");
  doneBtn.click();
  await wait(280);
  result(anyV.editMode === false, "点「完成」退出编辑");
  result(!root.querySelector(".mw-editbar"), "编辑条已移除");
  // ④ 卡片右键 → 移动到分组… → 模态框选择
  MENU_LOG.length = 0;
  const card = cardOf(1);
  const cr = card.getBoundingClientRect();
  card.dispatchEvent(
    new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: cr.left + 4,
      clientY: cr.top + 4,
    })
  );
  await wait(150);
  const pickItem = MENU_LOG.at(-1)?.items.find((it) => it.title.startsWith("移动到分组"));
  result(!!pickItem, "菜单里能打开「移动到分组…」");
  pickItem?.run?.();
  await wait(220);
  const rows = Array.from(document.querySelectorAll<HTMLElement>(".mw-picker__row"));
  result(rows.length === 3, "选择框列出 未分组 + 两个分组", rows.length);
  rows[2].click();
  await wait(300);
  const data = anyV.data as { items: { albumId: number; groupId?: string }[] };
  result(
    data.items.find((i) => i.albumId === 1)?.groupId === "g2",
    "选中「组二」后归属变更",
    String(data.items.find((i) => i.albumId === 1)?.groupId)
  );
  // ⑤ 收尾：没有残留覆盖层，图标仍然可点、面板还能开关
  result(!root.querySelector(".mw-drawer__scrim"), "全程没有遮罩残留");
  result(
    !document.querySelector(".mw-picker") && !document.querySelector(".mw-modal-zoom"),
    "模态框已关闭"
  );
  const iconAfter = icons()[0];
  clickable(iconAfter, "收尾图标");
  iconAfter.click();
  await wait(220);
  result(anyV.drawer.currentKey() === "style", "收尾仍能打开样式面板");
  iconAfter.click();
  await wait(220);
  result(anyV.drawer.currentKey() === null, "再点一次收起");
  result(steps.every((s) => s.endsWith("ok")), "收尾命中检查", steps.join(" "));
}

// ---- 入口 ----
(async () => {
  const caseName = new URLSearchParams(location.search).get("case") ?? "boot-hold";
  window.__fails = [];
  window.__playLog = [];
  try {
    installDomHelpers();
    installAnimPump();
    // 无头环境默认可能带 reduced-motion：强制 no-preference，确保完整动画路径被测到
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    window.open = ((url: string) => {
      window.__playLog.push(String(url));
      return null;
    }) as typeof window.open;
    const app = makeApp();
    // 把视图层的 console 噪声引到结果面板，便于无头环境定位问题
    const origLog = console.log.bind(console);
    console.log = (...args: unknown[]) => {
      const line = args.map((a) => (typeof a === "string" ? a : safe(a))).join(" ");
      if (line.includes("[mw-dbg]")) result(true, "dbg", line);
      origLog(...args);
    };
    // ?w=<px> 覆盖舞台宽度：用于验证窄容器（≤640px 触发上下堆叠降级）下的顶栏信息带
    const wParam = Number(new URLSearchParams(location.search).get("w"));
    if (Number.isFinite(wParam) && wParam > 0) {
      document.getElementById("mount")!.style.width = `${wParam}px`;
    }
    view = new MusicWallView(new WorkspaceLeaf(app), makePlugin());
    (view as unknown as { file: TFile | null }).file = new TFile("Epics.mw");
    (view as unknown as { data: unknown }).data = makeData(14);
    document.getElementById("mount")!.appendChild(view.contentEl);
    await view.onOpen();
    grid = document.querySelector<HTMLElement>(".mw-grid")!;
    const fn: Record<string, () => Promise<void>> = {
      "boot-hold": caseBootHold,
      swap: caseSwap,
      play: casePlay,
      interrupt: caseInterrupt,
      "close-position": caseClosePosition,
      queue: caseQueue,
      "total-dur": caseTotalDur,
      hitdebug: caseHitDebug,
      "toolbar-drawer": caseToolbarDrawer,
      "wall-surface": caseWallSurface,
      groups: caseGroups,
      "manual-order": caseManualOrder,
      "cross-group-move": caseCrossGroupMove,
      "cross-group-targets": caseCrossGroupTargets,
      "shelf-panel-theme": caseShelfPanelTheme,
      "no-scrim": caseNoScrim,
      "editbar-clear": caseEditbarClear,
      "section-gaps": caseSectionGaps,
      "style-panel-order": caseStylePanelOrder,
      "panel-controls": casePanelControls,
      "clear-x": caseClearX,
      "group-picker": caseGroupPicker,
      "interaction-walk": caseInteractionWalk,
      "drag-gate": caseDragGate,
      "group-menus": caseGroupMenus,
      previews: casePreviews,
      "float-panels": caseFloatPanels,
      zoom: caseZoom,
      dragdiag: caseDragDiag,
    };
    if (fn[caseName]) await fn[caseName]();
    else result(false, `未知场景 ${caseName}`);
  } catch (e) {
    result(false, "场景异常", String((e as Error)?.stack ?? e));
  }
  finalize(caseName);
})();

/**
 * dragdiag：触屏指针拖拽链路的逐步诊断（指针捕获 / 事件到达 / 命中要素）。
 *
 * 桌面端走的是**原生 HTML5 拖拽**（长按只负责进编辑态，不接管指针），
 * 所以这里刻意用 pointerType: "touch" —— 触屏没有原生 DnD，产品代码会走
 * beginPointerDrag/浮标这条路径，本场景就是它的诊断入口。
 */
async function caseDragDiag(): Promise<void> {
  await resetView(gridData());
  const from = cardOf(1);
  const to = cardOf(2);
  const a = centerOf(from);
  const reached: string[] = [];
  const onDocMove = () => reached.push("move");
  const onDocUp = () => reached.push("up");
  document.addEventListener("pointermove", onDocMove, true);
  document.addEventListener("pointerup", onDocUp, true);
  window.addEventListener("pointermove", onDocMove, true);
  window.addEventListener("pointerup", onDocUp, true);

  from.dispatchEvent(pointer("pointerdown", a.x, a.y, "touch"));
  await wait(LONG_PRESS_MS_TOUCH + 250);
  const anyV = anyViewOf(view) as unknown as {
    dragActive: boolean;
    dragPayload: unknown;
  };
  result(!!document.querySelector(".mw-drag-ghost"), "触屏长按后出现浮标");
  result(anyV.dragActive === true, "dragActive=true", anyV.dragActive);
  result(
    document.pointerLockElement === null &&
      (from as HTMLElement).hasPointerCapture?.(1) === false,
    "刻意不做指针捕获（捕获会让 document 上的监听收不到事件）",
    (from as HTMLElement).hasPointerCapture?.(1)
  );
  // 浮标是缩放盒里的 absolute 元素：位置按「视觉像素 ÷ zoom」换算
  const ghost = document.querySelector<HTMLElement>(".mw-drag-ghost")!;
  const gr = ghost.getBoundingClientRect();
  result(
    Math.abs(gr.left - (a.x + 12)) < 6 && Math.abs(gr.top - (a.y + 12)) < 6,
    "浮标跟随指针（原点换算正确）",
    {
      ghost: [Math.round(gr.left), Math.round(gr.top)],
      want: [a.x + 12, a.y + 12],
    }
  );

  const r = to.getBoundingClientRect();
  const drop = { x: r.left + 4, y: r.top + r.height / 2 };
  reached.length = 0;
  const moved = pointer("pointermove", drop.x, drop.y, "touch");
  window.dispatchEvent(moved);
  await wait(120);
  const hit = document.elementFromPoint(drop.x, drop.y) as HTMLElement | null;
  result(true, "移动事件到达", { reached: reached.join(","), bubbles: moved.bubbles });
  result(true, "落点命中要素", hit ? hit.className || hit.tagName : "null");
  const hitCard = hit?.closest<HTMLElement>("[data-mw-album]");
  result(true, "落点归属卡片", hitCard?.dataset.mwAlbum ?? "none");

  reached.length = 0;
  window.dispatchEvent(pointer("pointerup", drop.x, drop.y, "touch"));
  await wait(250);
  result(true, "抬起事件到达", reached.join(","));
  result(!document.querySelector(".mw-drag-ghost"), "抬起后浮标被清理");
  const order = (anyV as unknown as { data: { order?: number[] } }).data.order ?? [];
  result(true, "最终 order", order.join(","));
  document.removeEventListener("pointermove", onDocMove, true);
  document.removeEventListener("pointerup", onDocUp, true);
  window.removeEventListener("pointermove", onDocMove, true);
  window.removeEventListener("pointerup", onDocUp, true);
}

/** hitdebug：开盒后对盘面/切换钮区域做多点命中诊断（elementsFromPoint 全栈） */
async function caseHitDebug(): Promise<void> {
  result(
    (window.matchMedia("(prefers-reduced-motion: reduce)") as MediaQueryList).matches === false,
    "matchMedia 覆盖生效"
  );
  await openAndWait(7);
  const phase = (view as unknown as { gfPhase: string }).gfPhase;
  result(phase === "open", "gfPhase=open", phase);
  const probes: [string, HTMLElement][] = [
    ["panelR", document.querySelector<HTMLElement>(".mw-gf__panel--right")!],
    ["tray", document.querySelector<HTMLElement>(".mw-gf__face--tray")!],
    ["discwrap", document.querySelector<HTMLElement>(".mw-gf__discwrap")!],
    ["discface0", document.querySelectorAll<HTMLElement>(".mw-gf__discface")[0]],
    ["swap", document.querySelector<HTMLElement>(".mw-gf__swap")!],
  ];
  for (const [name, el] of probes) {
    if (!el) {
      result(false, `${name} 存在`, "null");
      continue;
    }
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const stack = document
      .elementsFromPoint(cx, cy)
      .map((e) => (e as HTMLElement).className || e.tagName)
      .slice(0, 6);
    result(true, `rect:${name}`, {
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      top: stack,
    });
  }
  const tray = document.querySelector<HTMLElement>(".mw-gf__face--tray")!;
  const before = document.elementFromPoint(
    window.innerWidth / 2 + 100,
    window.innerHeight / 2
  );
  // 面板姿态归零对照实验：把右页转回 0° 再测命中
  const panelR = document.querySelector<HTMLElement>(".mw-gf__panel--right")!;
  const anims = panelR.getAnimations();
  anims.forEach((a) => a.cancel());
  panelR.style.transform = "none";
  await wait(120);
  const dw = document.querySelector<HTMLElement>(".mw-gf__discwrap")!;
  const r = dw.getBoundingClientRect();
  const after = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  result(true, "归零后命中", {
    centerHit: after ? (after as HTMLElement).className || after.tagName : "null",
    otherPoint: before ? (before as HTMLElement).className : "null",
  });
  // 容器查询单位诊断：book 尺寸异常小时的定位信息
  const stage = document.querySelector<HTMLElement>(".mw-stage")!;
  const book = document.querySelector<HTMLElement>(".mw-gf__book")!;
  result(true, "尺寸诊断", {
    supportsCQ: CSS.supports("width", "1cqw"),
    stageW: stage.clientWidth,
    stageH: stage.clientHeight,
    bookW: Math.round(book.getBoundingClientRect().width),
    bookComputedW: getComputedStyle(book).width,
    stageContainerType: getComputedStyle(stage).containerType,
  });
}
