import {
  searchAlbums,
  fetchAlbumDetail,
  type Requester,
} from "../src/core/metadata.js";
import {
  emptyWall,
  parseWall,
  serializeWall,
  mergeWalls,
} from "../src/core/store.js";
import {
  moveGroup,
  moveInto,
  moveWithin,
  newGroupId,
  normalizeOrder,
  orderedIds,
  removeFromOrder,
  removeGroup,
  resolveSections,
  UNGROUPED_ID,
  UNGROUPED_LABEL,
} from "../src/core/layout.js";
import {
  WALL_FILE_VERSION,
  type DiscStyle,
  type MusicWallData,
  type WallItem,
} from "../src/types.js";

/** 造一个最小可用条目（离线，不依赖网络） */
function mkItem(albumId: number, opts: Partial<WallItem> = {}): WallItem {
  return {
    albumId,
    source: "manual",
    locked: false,
    addedAt: new Date(2024, 0, 1, 0, 0, albumId % 60).toISOString(),
    meta: {
      albumId,
      name: `专辑 ${albumId}`,
      artist: `artist-${albumId % 3}`,
      cover: "",
      year: String(2000 + (albumId % 20)),
      trackCount: 1,
    },
    ...opts,
  } as WallItem;
}

function mkWall(ids: number[], extra: Partial<MusicWallData> = {}): MusicWallData {
  return { ...emptyWall("测试墙", "vinyl"), items: ids.map((i) => mkItem(i)), ...extra };
}

const request: Requester = async (req) => {
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
  });
  return { status: res.status, text: await res.text() };
};

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error("✗ 断言失败:", msg);
    process.exit(1);
  }
  console.log("✓", msg);
}

async function main() {
  // 1. 空墙结构
  const wall = emptyWall("测试墙", "vinyl");
  assert(wall.version === WALL_FILE_VERSION, "空墙版本正确");
  assert(wall.items.length === 0, "空墙无条目");

  // 2. 实时拉一个专辑并入库
  const found = await searchAlbums(request, "范特西", 0, 5);
  assert(found.length > 0, "搜索到专辑");
  const meta = await fetchAlbumDetail(request, found[0].albumId);
  wall.items.push({
    albumId: meta.albumId,
    source: "search",
    locked: true,
    meta,
    addedAt: new Date().toISOString(),
  });

  // 3. 序列化 → 回读往返一致
  const text = serializeWall(wall);
  const back = parseWall(text);
  assert(back.items[0].albumId === meta.albumId, "回读 albumId 一致");
  assert(back.items[0].meta.tracks === undefined || Array.isArray(back.items[0].meta.tracks), "tracks 结构合法");
  assert(JSON.parse(text).items[0].locked === true, "锁定状态持久化");

  // 4. 合并去重
  const wall2 = emptyWall("另一墙", "cd");
  wall2.items.push({
    albumId: meta.albumId,
    source: "manual",
    locked: false,
    meta,
    addedAt: new Date().toISOString(),
  });
  const merged = emptyWall("合并", "cover");
  const res = mergeWalls(merged, wall);
  // merged 空，导入 wall(1 项) 应新增 1
  assert(res.addedCount === 1, "合并新增 1");
  const res2 = mergeWalls(merged, wall);
  assert(res2.skippedCount === 1 && res2.addedCount === 0, "重复项被跳过");

  // 5. 迁移：拒绝未来版本
  const future = JSON.stringify({ version: 999, name: "x", style: "vinyl", items: [] });
  let threw = false;
  try {
    parseWall(future);
  } catch {
    threw = true;
  }
  assert(threw, "拒绝高于当前版本的文件");

  // 6. 损坏 JSON
  let threw2 = false;
  try {
    parseWall("{not json");
  } catch {
    threw2 = true;
  }
  assert(threw2, "拒绝非法 JSON");

  // ================= 7. 手动顺序（core/layout） =================
  const items = [1, 2, 3, 4].map((i) => mkItem(i));
  assert(
    JSON.stringify(normalizeOrder(items, undefined)) === "[1,2,3,4]",
    "order 残缺时按 items 顺序补齐"
  );
  assert(
    JSON.stringify(normalizeOrder(items, [3, 99, 1])) === "[3,1,2,4]",
    "order 保留幸存者并追加新条目、剔除已删 id"
  );
  assert(
    JSON.stringify(normalizeOrder(items, [3, 3, 3])) === "[3,1,2,4]",
    "order 重复 id 去重"
  );
  assert(
    JSON.stringify(orderedIds(items, [1, 2, 3, 4])) === "[1,2,3,4]",
    "orderedIds 与 normalizeOrder 一致"
  );

  assert(
    JSON.stringify(moveWithin([1, 2, 3, 4], 4, 1, "before")) === "[4,1,2,3]",
    "同分区重排：拖到最前"
  );
  assert(
    JSON.stringify(moveWithin([1, 2, 3, 4], 1, 3, "after")) === "[2,3,1,4]",
    "同分区重排：拖到中间"
  );
  assert(
    JSON.stringify(moveWithin([1, 2, 3], 2, 2, "before")) === "[1,2,3]",
    "同分区重排：锚点=自身时原样返回"
  );
  assert(
    JSON.stringify(moveWithin([1, 2, 3], 1, 99, "before")) === "[1,2,3]",
    "同分区重排：锚点不存在时原样返回"
  );
  assert(
    JSON.stringify(moveInto([1, 2, 3, 4], [4], 2, "after")) === "[1,2,4,3]",
    "跨分区移动：插入锚点之后"
  );
  assert(
    JSON.stringify(moveInto([1, 2], [7], null)) === "[1,2,7]",
    "跨分区移动：无锚点=追加到末尾"
  );
  assert(
    JSON.stringify(moveInto([1, 2], [2], 2, "after")) === "[1,2]",
    "跨分区移动：锚点属于被移动集合时按追加处理"
  );
  assert(
    JSON.stringify(removeFromOrder([1, 2, 3], [2])) === "[1,3]",
    "删除条目时清理顺序"
  );

  // ================= 8. 分组（core/layout） =================
  const g1 = { id: "g1", name: "华语" };
  const g2 = { id: "g2", name: "欧美", collapsed: true };
  assert(newGroupId([]) === "g1", "首个分组 id = g1");
  assert(newGroupId([g1, g2]) === "g3", "新分组 id 递增不撞车");
  assert(newGroupId([{ id: "album", name: "x" }]) === "g1", "非 gN 形式的 id 不参与递增");
  assert(
    JSON.stringify(moveGroup([g1, g2], "g2", "g1", "before").map((g) => g.id)) ===
      '["g2","g1"]',
    "分组整体拖拽换序"
  );
  assert(
    JSON.stringify(moveGroup([g1, g2], "g1", "g1", "before").map((g) => g.id)) ===
      '["g1","g2"]',
    "分组拖到自身位置：原样返回"
  );
  assert(
    removeGroup([g1, g2], "g1").length === 1 &&
      removeGroup([g1, g2], "g1")[0].id === "g2",
    "删除分组返回剩余分组"
  );

  // 分组分区切分：分组顺序 + 末尾未分组
  const gItems = [
    mkItem(1, { groupId: "g2" }),
    mkItem(2, { groupId: "g1" }),
    mkItem(3),
    mkItem(4, { groupId: "g1" }),
  ];
  const sections = resolveSections(gItems, [g1, g2], [1, 2, 3, 4]);
  assert(sections.length === 3, "两个分组 + 未分组 = 3 个分区");
  assert(
    JSON.stringify(sections.map((s) => s.id)) === '["g1","g2",""]',
    "分区顺序 = 分组声明顺序 + 末尾未分组"
  );
  assert(
    JSON.stringify(sections[0].items.map((i) => i.albumId)) === "[2,4]",
    "分区内条目按 order 排列"
  );
  assert(sections[1].collapsed === true, "收起状态透传给分区");
  assert(sections[2].name === UNGROUPED_LABEL, "未分组分区名称固定");
  assert(UNGROUPED_ID === "", "未分组 id 为空串");

  // 筛选态：空分区不显示；非筛选态保留（便于恢复）
  const filtered = resolveSections([mkItem(1, { groupId: "g2" })], [g1, g2], [1], true);
  assert(
    JSON.stringify(filtered.map((s) => s.id)) === '["g2"]',
    "筛选态下空分组分区被隐藏"
  );
  assert(
    resolveSections([], [], [], false).length === 1,
    "无分组的空墙仍产出一个分区（承载空态）"
  );
  assert(
    resolveSections([mkItem(1), mkItem(2)], [], [1, 2], false)[0].items.length === 2,
    "无分组时全部条目落在唯一分区"
  );
  // 孤儿 groupId 在纯逻辑层也会被当作未分组（store 层另有清理）
  const orphans = resolveSections([mkItem(1, { groupId: "ghost" })], [g1], [1]);
  assert(
    orphans.length === 2 && orphans[1].items.length === 1,
    "孤儿 groupId 落回未分组分区"
  );

  // 未分组分区的收起状态（第五轮 A1）：它不在 groups 里，单独由 ungroupedCollapsed 承载
  const ugCollapsed = resolveSections(gItems, [g1, g2], [1, 2, 3, 4], false, true);
  assert(ugCollapsed[2].collapsed === true, "未分组分区也能收起（ungroupedCollapsed）");
  assert(
    ugCollapsed[0].collapsed === false && ugCollapsed[1].collapsed === true,
    "未分组收起不影响其它分组（各自保留自己的状态）"
  );
  assert(
    resolveSections(gItems, [g1, g2], [1, 2, 3, 4], false, false)[2].collapsed === false,
    "缺省未分组是展开的"
  );
  // 没有任何分组时未分组分区是无头的：不落收起标记，否则用户没有任何入口再展开
  assert(
    resolveSections([mkItem(1)], [], [1], false, true)[0].collapsed === false,
    "无分组时忽略未分组收起标记"
  );

  // ================= 9. schema v2 迁移与往返 =================
  const v2: MusicWallData = {
    ...mkWall([1, 2]),
    groups: [g1, { id: "g2", name: "欧美" }],
    order: [2, 1],
    view: {
      sortMode: "manual",
      sortAsc: false,
      filterArtists: ["周杰伦", "周杰伦", ""],
      filterDecades: ["2010s"],
    },
  };
  v2.items[0].groupId = "g1";
  v2.items[1].groupId = "g2";
  const round = parseWall(serializeWall(v2));
  assert(round.version === WALL_FILE_VERSION, "往返后版本 = 当前版本");
  assert(
    JSON.stringify(round.groups?.map((g) => g.id)) === '["g1","g2"]',
    "分组往返一致"
  );
  assert(JSON.stringify(round.order) === "[2,1]", "手动顺序往返一致");
  assert(
    round.view?.sortMode === "manual" && round.view?.sortAsc === false,
    "视图状态往返一致"
  );
  assert(
    JSON.stringify(round.view?.filterArtists) === '["周杰伦"]',
    "筛选数组去重去空"
  );
  assert(round.items[0].groupId === "g1", "条目分组归属往返一致");

  // 未分组收起状态必须能往返（它不在 groups 里，序列化器单独处理的一位）
  const ugRound = parseWall(serializeWall({ ...v2, ungroupedCollapsed: true }));
  assert(ugRound.ungroupedCollapsed === true, "未分组收起状态往返一致");
  const ugNoGroups = parseWall(
    serializeWall({ ...mkWall([1]), groups: undefined, ungroupedCollapsed: true })
  );
  assert(ugNoGroups.ungroupedCollapsed === undefined, "无分组时不保留未分组收起状态");

  // v1 旧文件：不应凭空长出 order / groups / view
  const v1 = {
    version: 1,
    name: "旧墙",
    style: "cd",
    items: [mkItem(1, { groupId: "g1" }), mkItem(2)],
  };
  const upgraded = parseWall(JSON.stringify(v1));
  assert(upgraded.version === WALL_FILE_VERSION, "v1 文件升级到当前版本");
  assert(upgraded.order === undefined, "v1 文件不注入 order（避免无意义 diff）");
  assert(upgraded.groups === undefined, "v1 文件不注入 groups");
  assert(
    upgraded.items.every((i) => i.groupId === undefined),
    "无分组的文件里 groupId 被清理，条目不会消失"
  );
  assert(upgraded.items.length === 2 && upgraded.style === "cd", "v1 其余字段保留");

  // 非法数据清洗
  const dirty = parseWall(
    JSON.stringify({
      version: 2,
      name: "脏数据",
      style: "vinyl",
      items: [mkItem(1, { groupId: "ghost" }), mkItem(2, { groupId: "g1" })],
      groups: [
        { id: "g1", name: "好组", collapsed: true },
        { id: "", name: "无 id" },
        { id: "g1", name: "重复 id" },
        { id: "g9", name: "" },
      ],
      order: [2, "x", 1, null],
      view: { sortMode: "bogus", sortAsc: "yes", filterTags: ["t", 5] },
    })
  );
  assert(dirty.groups?.length === 1, "非法/重复分组被丢弃");
  assert(dirty.groups?.[0].collapsed === true, "分组收起状态保留");
  assert(JSON.stringify(dirty.order) === "[2,1]", "order 非数字项被剔除");
  assert(dirty.items[0].groupId === undefined, "孤儿 groupId 被清空");
  assert(dirty.items[1].groupId === "g1", "有效 groupId 保留");
  assert(
    dirty.view === undefined || dirty.view.sortMode === undefined,
    "非法排序类型被丢弃"
  );
  assert(
    JSON.stringify(dirty.view?.filterTags) === '["t"]',
    "筛选数组过滤非字符串"
  );

  // 合并/迁移：条目不会带着目标墙不存在的分组 id 进去
  const target = mkWall([9], { groups: [{ id: "g1", name: "目标组" }] });
  const incoming = mkWall([1, 2], { groups: [g1, { id: "g2", name: "x" }] });
  incoming.items[0].groupId = "g1";
  incoming.items[1].groupId = "g2";
  mergeWalls(target, incoming);
  assert(target.items.length === 3, "合并新增 2 条");
  assert(target.items[1].groupId === "g1", "同名分组 id 保留归属");
  assert(target.items[2].groupId === undefined, "目标墙没有的分组退回未分组");

  console.log("\n== store 集成测试全部通过 ==");
}

main().catch((e) => {
  console.error("测试失败:", e?.message ?? e);
  process.exit(1);
});
