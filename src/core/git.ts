// Git objects stay in an isolated bare cache; user files are never reset or staged.
import { t } from "../i18n";
import type { GitAuthProvider } from "./githubAuth";
import { inSyncDirectory, joinSyncPath, syncPath, type WallSyncFile } from "./wallSync";

function node() {
  return { cp: require("child_process") as typeof import("child_process"), fs: require("fs") as typeof import("fs"), path: require("path") as typeof import("path"), crypto: require("crypto") as typeof import("crypto") };
}
function runGit(args: string[], cwd?: string, input?: string, environment: NodeJS.ProcessEnv = {}): Promise<string> {
  const { cp } = node();
  return new Promise((resolve, reject) => {
    const child = cp.execFile("git", args, {
      cwd, windowsHide: true, timeout: 120_000, maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_ALLOW_PROTOCOL: "https:ssh:file", ...environment }, encoding: "utf8",
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1***@")));
      else resolve(stdout);
    });
    child.stdin?.on("error", () => {}); child.stdin?.end(input);
  });
}
export async function checkGit(): Promise<boolean> { try { await runGit(["--version"]); return true; } catch { return false; } }
export interface GitSyncSnapshot { cacheDir: string; branch: string; commit: string | null; remoteDirectory: string; files: WallSyncFile[]; repoUrl: string; authentication?: GitAuthProvider; }
async function networkGit(snapshot: Pick<GitSyncSnapshot, "cacheDir" | "repoUrl" | "authentication">, args: string[]): Promise<string> {
  const credentials = await snapshot.authentication?.(snapshot.repoUrl) ?? [];
  return runGit([...credentials, ...args], snapshot.cacheDir);
}
async function remoteHeads(snapshot: Pick<GitSyncSnapshot, "cacheDir" | "repoUrl" | "authentication">): Promise<{ branch: string; heads: Map<string, string> }> {
  const output = await networkGit(snapshot, ["ls-remote", "--symref", "origin", "HEAD", "refs/heads/*"]);
  const branch = /^ref: refs\/heads\/(.+)\tHEAD$/m.exec(output)?.[1] ?? "main";
  const heads = new Map<string, string>();
  for (const line of output.split("\n")) { const match = /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/.exec(line); if (match) heads.set(match[2], match[1]); }
  return { branch, heads };
}
export async function prepareGitSync(repoUrl: string, cacheRoot: string, branch: string, remoteDirectory: string, authentication?: GitAuthProvider): Promise<GitSyncSnapshot> {
  const { fs, path, crypto } = node(), url = repoUrl.trim();
  if (!url || url.startsWith("-") || /[\r\n\x00]/.test(url)) throw new Error(t("main.git.needUrl"));
  remoteDirectory = syncPath(remoteDirectory);
  if (branch) await runGit(["check-ref-format", "--branch", branch]);
  const key = crypto.createHash("sha256").update(`${url}\n${branch}`).digest("hex").slice(0, 24), cacheDir = path.join(cacheRoot, key);
  fs.mkdirSync(cacheDir, { recursive: true });
  if (!fs.existsSync(path.join(cacheDir, "HEAD"))) {
    await runGit(["init", "--bare", cacheDir]); await runGit(["remote", "add", "origin", url], cacheDir);
  } else await runGit(["remote", "set-url", "origin", url], cacheDir);
  const connection = { cacheDir, repoUrl: url, authentication };
  const remote = await remoteHeads(connection), effectiveBranch = branch || remote.branch;
  if (!remote.heads.has(effectiveBranch) && remote.heads.size) throw new Error(t("gitSync.branchMissing", { branch: effectiveBranch }));
  let commit: string | null = null;
  const files: WallSyncFile[] = [];
  if (remote.heads.has(effectiveBranch)) {
    const ref = `refs/music-wall/${crypto.randomBytes(12).toString("hex")}`;
    try {
      await networkGit(connection, ["fetch", "--depth=1", "--no-tags", "origin", `refs/heads/${effectiveBranch}:${ref}`]);
      commit = (await runGit(["rev-parse", ref], cacheDir)).trim();
    } finally { await runGit(["update-ref", "-d", ref], cacheDir); }
    for (const entry of (await runGit(["ls-tree", "-r", "-z", commit], cacheDir)).split("\x00")) {
      const match = /^(\d+) blob ([0-9a-f]+)\t([\s\S]+)$/.exec(entry);
      if (!match || !match[3].endsWith(".mw") || !inSyncDirectory(match[3], remoteDirectory)) continue;
      const filePath = match[3], relative = remoteDirectory ? filePath.slice(remoteDirectory.length + 1) : filePath;
      if (filePath.split("/").some(part => part.startsWith("."))) continue;
      if (match[1] !== "100644" && match[1] !== "100755") throw new Error(t("gitSync.badPath", { path: filePath }));
      syncPath(relative); files.push({ path: relative, content: await runGit(["cat-file", "blob", match[2]], cacheDir) });
    }
  }
  return { ...connection, branch: effectiveBranch, commit, remoteDirectory, files };
}
export async function assertRemoteUnchanged(snapshot: GitSyncSnapshot): Promise<void> {
  const { heads } = await remoteHeads(snapshot);
  if ((heads.get(snapshot.branch) ?? null) !== snapshot.commit) throw new Error(t("gitSync.remoteChanged"));
}
export async function pushGitWalls(snapshot: GitSyncSnapshot, files: WallSyncFile[]): Promise<string | null> {
  if (!files.length) return null;
  await assertRemoteUnchanged(snapshot);
  const { path, fs, crypto } = node(), index = path.join(snapshot.cacheDir, `sync-index-${crypto.randomBytes(12).toString("hex")}`), environment = { GIT_INDEX_FILE: index };
  try {
    await runGit(snapshot.commit ? ["read-tree", snapshot.commit] : ["read-tree", "--empty"], snapshot.cacheDir, undefined, environment);
    for (const file of files) {
      const filePath = joinSyncPath(snapshot.remoteDirectory, file.path);
      if (!filePath.endsWith(".mw")) throw new Error(t("gitSync.badPath", { path: filePath }));
      const blob = (await runGit(["hash-object", "-w", "--stdin"], snapshot.cacheDir, file.content)).trim();
      await runGit(["update-index", "--add", "--cacheinfo", "100644", blob, filePath], snapshot.cacheDir, undefined, environment);
    }
    const tree = (await runGit(["write-tree"], snapshot.cacheDir, undefined, environment)).trim();
    if (snapshot.commit && tree === (await runGit(["rev-parse", `${snapshot.commit}^{tree}`], snapshot.cacheDir)).trim()) return null;
    if (snapshot.commit) {
      const allowed = new Set(files.map(file => joinSyncPath(snapshot.remoteDirectory, file.path)));
      const changes = (await runGit(["diff-tree", "--no-commit-id", "--no-renames", "--name-status", "-r", "-z", snapshot.commit, tree], snapshot.cacheDir)).split("\x00");
      for (let i = 0; i + 1 < changes.length; i += 2) {
        if (!/^[AM]$/.test(changes[i]) || !allowed.has(changes[i + 1])) throw new Error(t("gitSync.badPath", { path: changes[i + 1] }));
      }
    }
    const config = async (key: string, fallback: string) => { try { return (await runGit(["config", "--get", key], snapshot.cacheDir)).trim() || fallback; } catch { return fallback; } };
    const name = await config("user.name", "Music Wall"), email = await config("user.email", "music-wall@users.noreply.github.com");
    const commit = (await runGit(["commit-tree", tree, ...(snapshot.commit ? ["-p", snapshot.commit] : []), "-m", `Sync ${files.length} Music Wall file(s)`], snapshot.cacheDir, undefined,
      { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email })).trim();
    // New commits descend from the previewed commit; the lease rejects concurrent remote updates.
    await networkGit(snapshot, ["push", "--porcelain", `--force-with-lease=refs/heads/${snapshot.branch}:${snapshot.commit ?? ""}`, "origin", `${commit}:refs/heads/${snapshot.branch}`]);
    return commit;
  } finally { for (const suffix of ["", ".lock"]) { try { fs.unlinkSync(index + suffix); } catch { /* already removed */ } } }
}
export async function backupSyncWalls(cacheRoot: string, files: WallSyncFile[]): Promise<void> {
  if (!files.length) return;
  const { fs, path, crypto } = node(), directory = path.join(cacheRoot, "backups", `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`);
  for (const file of files) { const target = path.join(directory, syncPath(file.path)); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, file.content, { encoding: "utf8", flag: "wx" }); }
}
