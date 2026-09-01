import {
  searchAlbums,
  fetchAlbumDetail,
  parseAlbumInput,
  type Requester,
} from "../src/core/metadata.js";

const request: Requester = async (req) => {
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
  });
  return { status: res.status, text: await res.text() };
};

async function main() {
  console.log("== 测试 1：parseAlbumInput ==");
  console.log(parseAlbumInput("https://music.163.com/#/album?id=123456"));
  console.log(parseAlbumInput("123456"));

  console.log("== 测试 2：searchAlbums 范特西 ==");
  const albums = await searchAlbums(request, "范特西", 0, 5);
  console.log("结果数:", albums.length);
  for (const a of albums.slice(0, 5)) {
    console.log(` - [${a.albumId}] ${a.name} / ${a.artist} / ${a.year} / ${a.trackCount}曲`);
  }
  if (!albums.length) {
    console.log("!! 搜索返回空，可能加密或接口有误");
    return;
  }

  const target = albums.find((a) => a.name.includes("范特西")) ?? albums[0];
  console.log("== 测试 3：fetchAlbumDetail", target.albumId, "==");
  const detail = await fetchAlbumDetail(request, target.albumId);
  console.log(`专辑: ${detail.name} / ${detail.artist}`);
  console.log(`年份: ${detail.year} 曲目数: ${detail.trackCount}`);
  console.log(`封面: ${detail.cover?.slice(0, 60)}...`);
  console.log("前 5 曲:");
  for (const t of (detail.tracks ?? []).slice(0, 5)) {
    console.log(`   ${t.name} (${Math.round(t.duration / 1000)}s) id=${t.id}`);
  }
  console.log("== 全部通过 ==");
}

main().catch((e) => {
  console.error("测试失败:", e?.message ?? e);
  process.exit(1);
});
