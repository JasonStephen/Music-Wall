// SMTC 自检（仅 Windows，需在网易云设置里勾选「开启SMTC」并处于播放/暂停状态）。
// 把插件内嵌的 PowerShell 脚本写到临时目录跑一次，打印当前系统媒体会话。
//   node .\node_modules\esbuild\bin\esbuild tools\smtccheck.ts --bundle --platform=node --format=cjs --outfile=tools\smtccheck.cjs
//   node tools\smtccheck.cjs            # 读一次状态
//   node tools\smtccheck.cjs next      # 下发控制指令（play/pause/toggle/next/prev）

import { execFile } from "child_process";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SMTC_SCRIPT } from "../src/core/smtcScript";

const scriptPath = join(tmpdir(), "music-wall-smtc.ps1");
writeFileSync(scriptPath, SMTC_SCRIPT, "utf8");

const powershell = join(
  process.env.SystemRoot || "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);

const action = process.argv[2];
const modeArgs = action
  ? ["-Mode", "control", "-Action", action]
  : ["-Mode", "poll", "-Once"];

const args = [
  "-NoProfile",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  scriptPath,
  ...modeArgs,
];

execFile(powershell, args, { windowsHide: true }, (err, stdout, stderr) => {
  if (err) {
    console.error("SMTC 调用失败：", err.message);
    if (stderr) console.error(String(stderr).trim());
    process.exit(1);
  }
  const text = String(stdout).trim();
  console.log(text);
  try {
    const state = JSON.parse(text);
    if (state.supported === false) {
      console.log("!! WinRT 不可用，SMTC 无法读取");
    } else if (!state.active) {
      console.log("!! 没有媒体会话：确认网易云已勾选「开启SMTC」并有播放内容");
    } else {
      console.log(`-- 会话来源 ${state.source}，状态 ${state.status}`);
      if (!state.album && !state.durationMs) {
        console.log(
          "-- 注意：该会话未发布专辑名与时间轴（网易云实测如此），插件会用曲名匹配墙内唱片并本地估算进度"
        );
      }
    }
  } catch {
    /* 控制模式返回 {"ok":...} 或无输出，忽略 */
  }
});
