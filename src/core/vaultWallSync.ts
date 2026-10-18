import { TFile, TFolder, type Vault } from "obsidian";
import { t } from "../i18n";
import type { GitAuthProvider } from "./githubAuth";
import type { GitSyncConfig, GitSyncPreview } from "../ui/GitSyncModal";
import { assertRemoteUnchanged, backupSyncWalls, prepareGitSync, pushGitWalls } from "./git";
import { applyWallPull, buildSyncPlan, checkLocalSnapshot, inSyncDirectory, joinSyncPath, selectedSyncChanges, syncPath, type SyncDirection, type WallSyncFile, type WallSyncIO } from "./wallSync";

/** Reject filesystem links as well as logical path traversal before reading/writing. */
function checkVaultPath(vault: Vault, relative: string): void {
  const base = (vault.adapter as { basePath?: string }).basePath;
  if (!base) throw new Error(t("main.git.noBasePath"));
  const fs = require("fs") as typeof import("fs"), path = require("path") as typeof import("path");
  let target = path.resolve(base);
  for (const part of syncPath(relative).split("/").filter(Boolean)) {
    target = path.join(target, part);
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error(t("gitSync.badPath", { path: relative }));
  }
}

export async function prepareVaultSync(vault: Vault, cacheRoot: string, input: GitSyncConfig, direction: SyncDirection, authentication?: GitAuthProvider): Promise<GitSyncPreview> {
  const config = { ...input, localDirectory: syncPath(input.localDirectory), remoteDirectory: syncPath(input.remoteDirectory) };
  checkVaultPath(vault, config.localDirectory);
  const directory = config.localDirectory && vault.getAbstractFileByPath(config.localDirectory);
  if (directory && !(directory instanceof TFolder)) throw new Error(t("gitSync.badPath", { path: config.localDirectory }));
  const io: WallSyncIO = {
    async read(relative) {
      const path = joinSyncPath(config.localDirectory, relative); checkVaultPath(vault, path);
      const file = vault.getAbstractFileByPath(path);
      if (!file) return null;
      if (!(file instanceof TFile)) throw new Error(t("gitSync.badPath", { path }));
      return vault.read(file);
    },
    async write(relative, content, expected) {
      const path = joinSyncPath(config.localDirectory, relative); checkVaultPath(vault, path);
      const parts = path.split("/"); parts.pop();
      for (let count = 1; count <= parts.length; count++) {
        const folder = parts.slice(0, count).join("/"), existing = vault.getAbstractFileByPath(folder);
        if (!existing) await vault.createFolder(folder);
        else if (!(existing instanceof TFolder)) throw new Error(t("gitSync.badPath", { path: folder }));
      }
      const file = vault.getAbstractFileByPath(path);
      if (expected === null) {
        if (file) throw new Error(t("gitSync.localChanged", { path }));
        await vault.create(path, content);
      } else {
        if (!(file instanceof TFile)) throw new Error(t("gitSync.localChanged", { path }));
        await vault.process(file, current => { if (current !== expected) throw new Error(t("gitSync.localChanged", { path })); return content; });
      }
    },
    backup: files => backupSyncWalls(cacheRoot, files.map(file => ({ ...file, path: joinSyncPath(config.localDirectory, file.path) }))),
  };
  const local: WallSyncFile[] = [];
  for (const file of vault.getFiles()) {
    if (!file.path.endsWith(".mw") || file.path.split("/").some(part => part.startsWith(".")) || !inSyncDirectory(file.path, config.localDirectory)) continue;
    const relative = config.localDirectory ? file.path.slice(config.localDirectory.length + 1) : file.path;
    syncPath(relative); const content = await io.read(relative);
    if (content !== null) local.push({ path: relative, content });
  }
  const remote = await prepareGitSync(config.repoUrl, cacheRoot, config.branch.trim(), config.remoteDirectory, authentication);
  const plan = buildSyncPlan(direction, local, remote.files);
  let applied = false;
  return {
    plan, branch: remote.branch, commit: remote.commit,
    async apply(selected) {
      if (applied) throw new Error(t("gitSync.previewNeeded"));
      applied = true;
      const rows = selectedSyncChanges(plan, selected);
      await assertRemoteUnchanged(remote);
      if (direction === "pull") return applyWallPull(plan, selected, io);
      await checkLocalSnapshot(rows, io);
      const commit = await pushGitWalls(remote, rows.map(row => row.local!));
      return commit ? rows.length : 0;
    },
  };
}
