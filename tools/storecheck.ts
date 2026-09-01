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
import { WALL_FILE_VERSION, type DiscStyle } from "../src/types.js";

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

  console.log("\n== store 集成测试全部通过 ==");
}

main().catch((e) => {
  console.error("测试失败:", e?.message ?? e);
  process.exit(1);
});
