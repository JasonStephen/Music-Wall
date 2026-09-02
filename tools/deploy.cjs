/* 构建产物一键同步到 Obsidian 库插件目录。
 * 用法：npm run build && npm run sync
 * 目标路径如库迁移，改 VAULT_DIR 即可。 */
"use strict";
const fs = require("fs");
const path = require("path");

const VAULT_DIR =
  "<你的 Obsidian 库插件目录>";
const FILES = ["main.js", "styles.css", "manifest.json", "versions.json"];

const root = path.join(__dirname, "..");
let changed = 0;
for (const f of FILES) {
  const src = path.join(root, f);
  const dst = path.join(VAULT_DIR, f);
  if (!fs.existsSync(src)) {
    console.error(`✗ 缺少 ${f}（先 npm run build）`);
    process.exit(1);
  }
  const a = fs.readFileSync(src);
  const b = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
  if (b && a.equals(b)) {
    console.log(`· ${f} 已是最新`);
    continue;
  }
  fs.mkdirSync(VAULT_DIR, { recursive: true });
  fs.writeFileSync(dst, a);
  changed++;
  console.log(`✓ ${f} 已同步（${a.length} bytes）`);
}
console.log(changed ? `同步完成，${changed} 个文件更新。请在 Obsidian 重载插件。` : "无变化。");
