// Git 导入：调用系统 git CLI（仅桌面端）。

import { t } from "../i18n";
// clone/pull 到插件缓存目录，扫描 .mw 文件供用户选择导入（覆盖前由调用方弹确认框）。

export interface GitWallFile {
  /** 缓存目录内的相对路径 */
  relPath: string;
  name: string;
  sizeBytes: number;
  /** 文件原文 */
  content: string;
}

function requireNode(): {
  cp: typeof import("child_process");
  fs: typeof import("fs");
  path: typeof import("path");
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return {
      cp: require("child_process"),
      fs: require("fs"),
      path: require("path"),
    };
  } catch {
    return null;
  }
}

function runGit(
  cp: typeof import("child_process"),
  args: string[],
  cwd?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    cp.execFile(
      "git",
      args,
      { cwd, windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(String(stdout));
      }
    );
  });
}

/** 检测 git 是否可用 */
export async function checkGit(): Promise<boolean> {
  const n = requireNode();
  if (!n) return false;
  try {
    await runGit(n.cp, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * 拉取远程仓库到 cacheDir（.git 存在则 fetch+reset，否则浅克隆）。
 * branch 缺省用仓库默认分支。
 */
export async function syncRepo(
  repoUrl: string,
  cacheDir: string,
  branch?: string
): Promise<void> {
  const n = requireNode();
  if (!n) throw new Error(t("main.git.noNode"));
  const { fs, path, cp } = n;
  const gitDir = path.join(cacheDir, ".git");
  if (fs.existsSync(gitDir)) {
    if (branch) {
      await runGit(cp, ["fetch", "--depth", "1", "origin", branch], cacheDir);
      await runGit(cp, ["reset", "--hard", `origin/${branch}`], cacheDir);
    } else {
      await runGit(cp, ["pull", "--ff-only"], cacheDir);
    }
  } else {
    fs.mkdirSync(cacheDir, { recursive: true });
    const args = ["clone", "--depth", "1"];
    if (branch) args.push("--branch", branch);
    args.push(repoUrl, cacheDir);
    await runGit(cp, args);
  }
}

/** 扫描仓库目录（或子目录）下的 .mw 文件并读取内容 */
export async function listWallFiles(
  cacheDir: string,
  subdir?: string
): Promise<GitWallFile[]> {
  const n = requireNode();
  if (!n) throw new Error(t("main.git.noFs"));
  const { fs, path } = n;
  const root = subdir ? path.join(cacheDir, subdir) : cacheDir;
  const out: GitWallFile[] = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== ".git") walk(full);
      } else if (entry.name.endsWith(".mw")) {
        const content = fs.readFileSync(full, "utf-8");
        out.push({
          relPath: path.relative(cacheDir, full).replace(/\\/g, "/"),
          name: entry.name,
          sizeBytes: Buffer.byteLength(content, "utf-8"),
          content,
        });
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
}
