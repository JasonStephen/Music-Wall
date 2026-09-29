/* 构建产物一键同步到 Obsidian 库插件目录。
 * 用法：npm run build && npm run sync
 *
 * 目标库路径（不写死在仓库里，避免把本机个人路径带进提交历史）：
 *   1. 环境变量 MW_VAULT_DIR；或
 *   2. 仓库根的 .deploy.local.json：{ "vaultDir": "D:\\path\\to\\vault" }
 *      该文件已入 .gitignore，仅本机生效。
 * 指向库根即可，本脚本自动拼接 .obsidian/plugins/<manifest.id>。 */
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");

function resolveVaultDir() {
  const fromEnv = process.env.MW_VAULT_DIR;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const localCfg = path.join(root, ".deploy.local.json");
  if (fs.existsSync(localCfg)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(localCfg, "utf8"));
      if (cfg.vaultDir && cfg.vaultDir.trim()) return cfg.vaultDir.trim();
    } catch (e) {
      console.error(`× ${localCfg} 解析失败：${e.message}`);
      process.exit(1);
    }
  }

  console.error(
    "× 未配置目标库路径。请二选一：\n" +
      '  1) 设置环境变量 MW_VAULT_DIR=<你的 Obsidian 库根目录>\n' +
      '  2) 在仓库根新建 .deploy.local.json，内容：{"vaultDir": "你的库根目录"}'
  );
  process.exit(1);
}

const FILES = ["main.js", "styles.css", "manifest.json", "versions.json"];
const pluginId = JSON.parse(
  fs.readFileSync(path.join(root, "manifest.json"), "utf8")
).id;
const VAULT_DIR = path.join(
  resolveVaultDir(),
  ".obsidian",
  "plugins",
  pluginId
);

let changed = 0;
for (const f of FILES) {
  const src = path.join(root, f);
  const dst = path.join(VAULT_DIR, f);
  if (!fs.existsSync(src)) {
    console.error(`× 缺少 ${f}（先 npm run build）`);
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
console.log(
  changed
    ? `同步完成（→ ${VAULT_DIR}），${changed} 个文件更新。请在 Obsidian 重载插件。`
    : "无变化。"
);
