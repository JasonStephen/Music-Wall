import { t } from "../i18n";
import { syncPath, type WallSyncFile } from "./wallSync";

export interface GitHubReadResponse { status: number; text: string; headers?: Record<string, string>; }
export type GitHubReadRequest = (url: string) => Promise<GitHubReadResponse>;
export interface GitHubWallSnapshot { branch: string; commit: string | null; files: WallSyncFile[]; assertCurrent(signal?: AbortSignal): Promise<void>; }
const MAX_FILE = 5 * 1024 * 1024, MAX_TOTAL = 20 * 1024 * 1024, MAX_FILES = 500;
const sha = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
const fail = (key: string, params?: Record<string, string | number>) => new GitHubPullError(key, params);
export function checkPullCancelled(signal?: AbortSignal): void { if (signal?.aborted) throw fail("cancelled"); }

export function publicGitHubRepo(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw fail("url"); }
  const parts = url.pathname.replace(/\/$/, "").split("/").slice(1);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password || url.search || url.hash
    || parts.length !== 2 || parts.some(part => !/^[a-z\d_.-]+$/i.test(part) || /^\.+$/.test(part))) throw fail("url");
  const repo = parts[1].replace(/\.git$/, "");
  if (!repo || /^\.+$/.test(repo)) throw fail("url");
  return `${parts[0]}/${repo}`;
}

/** Public GETs only; never reads system Git, account cookies, or saved credentials. */
export class GitHubWallReader {
  private blobs = new Map<string, string>();
  private cachedBytes = 0;
  constructor(private request: GitHubReadRequest) {}

  private async get(url: string, signal?: AbortSignal): Promise<any> {
    checkPullCancelled(signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted: (() => void) | undefined;
    try {
      const response = await Promise.race([
        this.request(url),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(fail("timeout")), 15000); }),
        new Promise<never>((_, reject) => { aborted = () => reject(fail("cancelled")); signal?.addEventListener("abort", aborted, { once: true }); if (signal?.aborted) aborted(); }),
      ]);
      checkPullCancelled(signal);
      if (response.status === 404) throw fail("unavailable");
      if (response.status === 403 || response.status === 429) throw fail("limited");
      if (response.status === 409) throw fail("empty");
      if (response.status !== 200) throw fail("http", { status: response.status });
      if (response.text.length > MAX_TOTAL * 2) throw fail("large");
      let body: any;
      try { body = JSON.parse(response.text); } catch { throw fail("response"); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw fail("response");
      return body;
    } catch (error) {
      if (error instanceof GitHubPullError) throw error;
      throw fail("network");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (aborted) signal?.removeEventListener("abort", aborted);
    }
  }

  async snapshot(repoUrl: string, branch: string, directory: string, signal?: AbortSignal): Promise<GitHubWallSnapshot> {
    const repo = publicGitHubRepo(repoUrl), base = `https://api.github.com/repos/${repo}`;
    directory = syncPath(directory);
    return this.readSnapshot(base, branch.trim(), directory, signal);
  }

  private async readSnapshot(base: string, branch: string, directory: string, signal?: AbortSignal): Promise<GitHubWallSnapshot> {
    const metadata = await this.get(base, signal);
    if (metadata.private !== false || typeof metadata.default_branch !== "string") throw fail("unavailable");
    branch ||= metadata.default_branch;
    if (!branch || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch) || /\.\.|@\{|\/\//.test(branch)
      || branch.startsWith("/") || branch.endsWith("/") || branch.endsWith(".") || branch.split("/").some(part => part.startsWith(".") || part.endsWith(".lock"))) throw fail("branch");
    const commitUrl = `${base}/commits/${encodeURIComponent(branch)}`;
    let head: any;
    try { head = await this.get(commitUrl, signal); }
    catch (error) { if (error instanceof GitHubPullError && error.key === "empty") return { branch, commit: null, files: [], assertCurrent: async () => { throw new Error(t("gitSync.remoteChanged")); } }; throw error; }
    if (!sha(head.sha) || !sha(head.commit?.tree?.sha)) throw fail("response");
    const commit = head.sha;
    let treeSha = head.commit.tree.sha;
    let treeRequests = 0;
    const tree = async (id: string, recursive = false): Promise<any> => {
      if (++treeRequests > 100) throw fail("large");
      const value = await this.get(`${base}/git/trees/${id}${recursive ? "?recursive=1" : ""}`, signal);
      if (!Array.isArray(value.tree) || value.sha !== id || typeof value.truncated !== "boolean") throw fail("response");
      return value;
    };
    for (const part of directory.split("/").filter(Boolean)) {
      const listing = await tree(treeSha);
      if (listing.truncated) throw fail("large");
      const entry = listing.tree.find((item: any) => item.path === part);
      if (!entry || entry.type !== "tree" || entry.mode !== "040000" || !sha(entry.sha)) throw fail("directory");
      treeSha = entry.sha;
    }
    const entries: { path: string; sha: string; size: number }[] = [];
    let bytes = 0;
    const add = (entry: any, prefix = "") => {
      if (typeof entry.path !== "string" || !entry.path.endsWith(".mw")) return;
      const path = prefix + entry.path;
      if (path.split("/").some(part => part === "." || part === "..")) throw fail("response");
      if (path.split("/").some(part => part.startsWith("."))) return;
      if (syncPath(path) !== path || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)
        || !sha(entry.sha) || !Number.isSafeInteger(entry.size) || entry.size < 0) throw fail("response");
      if (entry.size > MAX_FILE || (bytes += entry.size) > MAX_TOTAL || entries.length >= MAX_FILES) throw fail("large");
      entries.push({ path, sha: entry.sha, size: entry.size });
    };
    const recursive = await tree(treeSha, true);
    if (!recursive.truncated) recursive.tree.forEach((entry: any) => add(entry));
    else {
      // Never treat a truncated recursive listing as the complete directory.
      const walk = async (id: string, prefix = "", depth = 0): Promise<void> => {
        if (depth > 40) throw fail("large");
        const listing = await tree(id);
        if (listing.truncated) throw fail("large");
        for (const entry of listing.tree) {
          if (typeof entry.path !== "string" || entry.path.includes("/")) throw fail("response");
          if (entry.path.startsWith(".")) continue;
          if (syncPath(entry.path) !== entry.path) throw fail("response");
          if (entry.type === "tree") {
            if (entry.mode !== "040000" || !sha(entry.sha)) throw fail("response");
            await walk(entry.sha, `${prefix}${entry.path}/`, depth + 1);
          } else add(entry, prefix);
        }
      };
      await walk(treeSha);
    }
    const files: WallSyncFile[] = [];
    // Sequential reads respect anonymous API limits; immutable blobs are cached.
    for (const entry of entries) {
      checkPullCancelled(signal);
      let content = this.blobs.get(entry.sha);
      if (content === undefined) {
        const blob = await this.get(`${base}/git/blobs/${entry.sha}`, signal);
        if (blob.sha !== entry.sha || blob.size !== entry.size || blob.encoding !== "base64" || typeof blob.content !== "string"
          || blob.content.length > MAX_FILE * 2) throw fail("response");
        let raw: Uint8Array;
        try { raw = Uint8Array.from(atob(blob.content.replace(/\s/g, "")), char => char.charCodeAt(0)); }
        catch { throw fail("response"); }
        if (raw.length !== entry.size) throw fail("response");
        const header = new TextEncoder().encode(`blob ${raw.length}\0`), object = new Uint8Array(header.length + raw.length);
        object.set(header); object.set(raw, header.length);
        let digest: string;
        try { digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-1", object)), byte => byte.toString(16).padStart(2, "0")).join(""); }
        catch { throw fail("response"); }
        if (digest !== entry.sha) throw fail("response");
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { throw fail("response"); }
        checkPullCancelled(signal);
        if (this.cachedBytes + raw.length > MAX_TOTAL) { this.blobs.clear(); this.cachedBytes = 0; }
        this.blobs.set(entry.sha, content); this.cachedBytes += raw.length;
      }
      files.push({ path: entry.path, content });
    }
    return { branch, commit, files, assertCurrent: async currentSignal => {
      const latest = await this.get(commitUrl, currentSignal);
      if (latest.sha !== commit) throw new Error(t("gitSync.remoteChanged"));
    } };
  }
}

class GitHubPullError extends Error {
  constructor(readonly key: string, params?: Record<string, string | number>) { super(t(`githubPull.${key}`, params)); }
}
