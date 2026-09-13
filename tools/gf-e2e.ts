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
  grid.scrollTop = 260;
  const initial = grid.scrollTop;
  await openAndWait(7);
  const moved = grid.scrollTop;
  result(Math.abs(moved - initial) > 40, "开盒时相机已居中移动", { initial, moved });
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
    };
    if (fn[caseName]) await fn[caseName]();
    else result(false, `未知场景 ${caseName}`);
  } catch (e) {
    result(false, "场景异常", String((e as Error)?.stack ?? e));
  }
  finalize(caseName);
})();

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
