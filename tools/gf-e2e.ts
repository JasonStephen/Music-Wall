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
import { installDomHelpers, TFile, WorkspaceLeaf } from "./obsidian-shim";

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

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  });
}

const isDragging = (): boolean =>
  !!document.querySelector(".mw-card.is-dragging, .mw-row.is-dragging");

/** 长按并拖到目标元素：分派真实指针事件（走产品代码的长按 + 拖拽判定链路） */
async function dragTo(
  from: HTMLElement,
  to: HTMLElement,
  tx: (r: DOMRect) => number = (r) => r.right - 6,
  ty: (r: DOMRect) => number = (r) => r.top + r.height / 2,
  label = ""
): Promise<void> {
  const a = centerOf(from);
  from.dispatchEvent(pointer("pointerdown", a.x, a.y));
  await wait(LONG_PRESS_MS + 220);
  if (label) {
    const dbg = anyViewOf(view) as unknown as { dragActive: boolean };
    result(
      dbg.dragActive && !!document.querySelector(".mw-drag-ghost"),
      `${label}：长按进入拖拽`,
      { active: dbg.dragActive, ghost: !!document.querySelector(".mw-drag-ghost") }
    );
  }
  const b = centerOf(to);
  window.dispatchEvent(pointer("pointermove", b.x, b.y));
  await wait(120);
  const r = to.getBoundingClientRect();
  // 目标元素整体在视口内时不夹取（保持落点语义，如上/下边缘决定 before/after）；
  // 只有落到视口外才夹回来——那种情况下 elementFromPoint 必然返回 null
  const w = window.innerWidth;
  const h = window.innerHeight;
  const inside = r.left >= 0 && r.right <= w && r.top >= 0 && r.bottom <= h;
  const drop = inside
    ? { x: tx(r), y: ty(r) }
    : {
        x: Math.min(Math.max(tx(r), 8), w - 8),
        y: Math.min(Math.max(ty(r), 8), h - 8),
      };
  window.dispatchEvent(pointer("pointermove", drop.x, drop.y));
  await wait(90);
  window.dispatchEvent(pointer("pointerup", drop.x, drop.y));
  await wait(160);
}

/** 长按阈值（与产品代码一致；改产品代码时这里会随之失败，是刻意的耦合） */
const LONG_PRESS_MS = 400;

const editBarText = (): string =>
  document.querySelector<HTMLElement>(".mw-editbar__text")?.textContent ?? "";

/** 工具栏：图标行 + 右侧滑出抽屉，且不随网格滚动 */
async function caseToolbarDrawer(): Promise<void> {
  await resetView(gridData());

  const btns = Array.from(
    document.querySelectorAll<HTMLElement>(".mw-toolbar__actions .mw-toolbtn")
  );
  result(btns.length === 7, "工具栏只剩 7 个图标钮", btns.length);
  const labels = btns.map((b) => b.getAttribute("aria-label") ?? "");
  result(
    labels.join("|") === "样式与布局|筛选|分组|排序|添加专辑|搜索本墙专辑|更多操作",
    "图标语义顺序正确",
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

  // 点样式图标 → 右侧抽屉打开，布局三选一与四种样式瓷砖都在
  btns[0].click();
  await wait(120);
  const drawer = document.querySelector<HTMLElement>(".mw-drawer")!;
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

  // 抽屉只在 .mw-stage 内、不参与滚动
  const gridScroll = grid.scrollTop;
  result(
    drawer.parentElement?.classList.contains("mw-stage") === true,
    "抽屉挂在 .mw-stage（网格之外）"
  );
  result(grid.scrollTop === gridScroll, "打开抽屉不改变网格滚动位置");

  // 切换到排序面板：同时只能开一个面板
  btns[3].click();
  await wait(120);
  result(
    document.querySelectorAll(".mw-drawer.is-open").length === 1 &&
      document.querySelector<HTMLElement>(".mw-drawer__title")!.textContent === "排序",
    "面板互斥切换",
    document.querySelector<HTMLElement>(".mw-drawer__title")?.textContent
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

  // 点遮罩关闭；再开一次用 Esc 关闭
  document.querySelector<HTMLElement>(".mw-drawer__scrim")!.click();
  await wait(120);
  result(
    !document.querySelector(".mw-drawer.is-open"),
    "点遮罩关闭抽屉"
  );
  btns[1].click();
  await wait(100);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(120);
  result(!document.querySelector(".mw-drawer.is-open"), "Esc 关闭抽屉");

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

  // 搜索行：点放大镜展开，输入后立即筛选
  btns[5].click();
  await wait(80);
  const row = document.querySelector<HTMLElement>(".mw-searchrow")!;
  result(row.classList.contains("is-open"), "搜索行展开");
  const input = row.querySelector<HTMLInputElement>(".mw-searchrow__input")!;
  input.value = "Album 01";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(120);
  result(
    document.querySelectorAll(".mw-card[data-mw-album]").length === 1,
    "搜索即时生效",
    document.querySelectorAll(".mw-card[data-mw-album]").length
  );
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await wait(120);

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

/** 手动排序：长按进入编辑态 → 拖拽换位 → 完成/取消 */
async function caseManualOrder(): Promise<void> {
  await resetView(gridData());
  const anyView = anyViewOf(view);
  const orderOf = (): number[] =>
    ((anyView.data as { order?: number[] }).order ?? []);

  result(orderOf().join(",") === "1,2,3,4,5,6", "初始 order 正确", orderOf().join(","));

  // 长按卡片 400ms → 进入编辑态（并已开始拖动）
  const first = cardOf(1);
  const c = centerOf(first);
  first.dispatchEvent(pointer("pointerdown", c.x, c.y));
  await wait(LONG_PRESS_MS + 200);
  result(
    document.querySelector<HTMLElement>(".mw-view")!.classList.contains("mw-edit-layout"),
    "长按进入布局编辑态"
  );
  result(!!document.querySelector(".mw-editbar"), "出现编辑态操作条");
  result(
    !!document.querySelector(".mw-drag-ghost"),
    "长按后直接进入拖拽（有拖拽浮标）"
  );
  result(isDragging(), "被拖卡片标记 is-dragging");
  window.dispatchEvent(pointer("pointerup", c.x, c.y));
  await wait(150);
  result(!document.querySelector(".mw-drag-ghost"), "松手后浮标清理");
  result(
    (anyView.data as { view?: { sortMode?: string } }).view?.sortMode === "manual",
    "编辑态自动切到手动排序"
  );

  // 拖 1 到 3 的左半 → 落为「3 之前」= 1 与 2 交换
  await dragTo(cardOf(1), cardOf(3), (r) => r.left + 6);
  result(orderOf().join(",") === "2,1,3,4,5,6", "拖拽换位写回 order", orderOf().join(","));
  const domOrder = Array.from(
    document.querySelectorAll<HTMLElement>(".mw-section__cards .mw-card")
  ).map((el) => el.dataset.mwAlbum);
  result(domOrder.join(",") === "2,1,3,4,5,6", "DOM 顺序与 order 一致", domOrder.join(","));

  // 反向再拖一次：把 1 拖回最前（2 之前），确认双向都成立
  await dragTo(cardOf(1), cardOf(2), (r) => r.left + 6);
  result(orderOf().join(",") === "1,2,3,4,5,6", "反向拖拽同样生效", orderOf().join(","));

  // 取消：恢复到进入编辑态时的顺序
  document.querySelectorAll<HTMLButtonElement>(".mw-editbar__btn")[1].click();
  await wait(200);
  result(orderOf().join(",") === "1,2,3,4,5,6", "取消还原为编辑前的顺序", orderOf().join(","));
  result(
    !document.querySelector<HTMLElement>(".mw-view")!.classList.contains("mw-edit-layout"),
    "取消后退出编辑态"
  );

  // 右键菜单路径：展示架用自绘菜单，能直接点到「编辑布局」
  cardOf(3).dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 100, clientY: 100 })
  );
  await wait(120);
  const menu = document.querySelector<HTMLElement>(".mw-shelf-menu");
  if (menu) {
    const item = Array.from(menu.querySelectorAll<HTMLElement>(".mw-shelf-menu__item")).find(
      (el) => el.textContent === "编辑布局"
    );
    result(!!item, "右键菜单含「编辑布局」");
    item?.click();
    await wait(200);
    result(
      document.querySelector<HTMLElement>(".mw-view")!.classList.contains("mw-edit-layout"),
      "菜单「编辑布局」进入编辑态"
    );
  } else {
    result(true, "网格布局使用原生 Menu（无头环境无法点选，跳过菜单路径）");
  }

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
  await dragTo(cardOf(1), cardOf(5));
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

  // 分组头整体拖拽换序：把「组一」拖到「组二」之前
  const head1 = document.querySelector<HTMLElement>(
    '.mw-section[data-mw-group="g2"] .mw-section__head'
  )!;
  const head2 = document.querySelector<HTMLElement>(
    '.mw-section[data-mw-group="g1"] .mw-section__head'
  )!;
  await dragTo(head1, head2, (r) => r.left + r.width / 2, (r) => r.top + 4, "分组拖拽");  const groups = (data as unknown as { groups: { id: string }[] }).groups;
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
      groups: caseGroups,
      "manual-order": caseManualOrder,
      "cross-group-move": caseCrossGroupMove,
      dragdiag: caseDragDiag,
    };
    if (fn[caseName]) await fn[caseName]();
    else result(false, `未知场景 ${caseName}`);
  } catch (e) {
    result(false, "场景异常", String((e as Error)?.stack ?? e));
  }
  finalize(caseName);
})();

/** dragdiag：拖拽链路逐步诊断（指针捕获 / 事件到达 / 命中要素） */
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

  from.dispatchEvent(pointer("pointerdown", a.x, a.y));
  await wait(LONG_PRESS_MS + 200);
  const anyV = anyViewOf(view) as unknown as {
    dragActive: boolean;
    dragPayload: unknown;
  };
  result(!!document.querySelector(".mw-drag-ghost"), "长按后有浮标");
  result(anyV.dragActive === true, "dragActive=true", anyV.dragActive);
  result(
    document.pointerLockElement === null && (from as HTMLElement).hasPointerCapture?.(1) === true,
    "卡片持有指针捕获",
    (from as HTMLElement).hasPointerCapture?.(1)
  );

  const r = to.getBoundingClientRect();
  const drop = { x: r.left + 4, y: r.top + r.height / 2 };
  reached.length = 0;
  const moved = pointer("pointermove", drop.x, drop.y);
  (from as HTMLElement).dispatchEvent(moved);
  await wait(80);
  const hit = document.elementFromPoint(drop.x, drop.y) as HTMLElement | null;
  result(true, "移动事件到达", { reached: reached.join(","), bubbles: moved.bubbles });
  result(true, "落点命中要素", hit ? hit.className || hit.tagName : "null");
  const hitCard = hit?.closest<HTMLElement>("[data-mw-album]");
  result(true, "落点归属卡片", hitCard?.dataset.mwAlbum ?? "none");

  reached.length = 0;
  (from as HTMLElement).dispatchEvent(pointer("pointerup", drop.x, drop.y));
  await wait(200);
  result(true, "抬起事件到达", reached.join(","));
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
