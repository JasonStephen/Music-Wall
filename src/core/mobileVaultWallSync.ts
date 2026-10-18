import { TFile, TFolder, type Vault } from "obsidian";
import { t } from "../i18n";
import { GitHubWallReader, checkPullCancelled } from "./githubWallPull";
import { applyWallPull, buildSyncPlan, inSyncDirectory, joinSyncPath, syncPath, type WallSyncFile, type WallSyncIO } from "./wallSync";
import type { GitSyncConfig, GitSyncPreview } from "../ui/GitSyncModal";

/** Mobile paths are vault-relative; no filesystem, basePath, or child process. */
export async function prepareMobileVaultPull(vault: Vault, reader: GitHubWallReader, input: GitSyncConfig, backupRoot: string, signal?: AbortSignal): Promise<GitSyncPreview> {
  const directory = syncPath(input.localDirectory), remoteDirectory = syncPath(input.remoteDirectory);
  if (!backupRoot || backupRoot.split("/").some(part => !part || part === "." || part === ".." || /[\\:\x00-\x1f]/.test(part))) throw new Error(t("gitSync.badPath", { path: backupRoot }));
  const target = directory && vault.getAbstractFileByPath(directory);
  if (target && !(target instanceof TFolder)) throw new Error(t("gitSync.badPath", { path: directory }));
  let activeSignal = signal;
  const active = () => { checkPullCancelled(signal); checkPullCancelled(activeSignal); };
  const io: WallSyncIO = {
    async read(relative) {
      active(); const path = joinSyncPath(directory, relative), file = vault.getAbstractFileByPath(path);
      if (!file) return null;
      if (!(file instanceof TFile)) throw new Error(t("gitSync.badPath", { path }));
      return vault.read(file);
    },
    async write(relative, content, expected) {
      active(); const path = joinSyncPath(directory, relative), parts = path.split("/"); parts.pop();
      for (let count = 1; count <= parts.length; count++) {
        active(); const folder = parts.slice(0, count).join("/"), existing = vault.getAbstractFileByPath(folder);
        if (!existing) await vault.createFolder(folder);
        else if (!(existing instanceof TFolder)) throw new Error(t("gitSync.badPath", { path: folder }));
      }
      active(); const file = vault.getAbstractFileByPath(path);
      if (expected === null) {
        if (file) throw new Error(t("gitSync.localChanged", { path }));
        await vault.create(path, content);
      } else {
        if (!(file instanceof TFile)) throw new Error(t("gitSync.localChanged", { path }));
        await vault.process(file, current => { active(); if (current !== expected) throw new Error(t("gitSync.localChanged", { path })); return content; });
      }
    },
    async backup(files) {
      if (!files.length) return;
      const random = Array.from(crypto.getRandomValues(new Uint8Array(12)), byte => byte.toString(16).padStart(2, "0")).join("");
      const root = `${backupRoot}/backups/${Date.now()}-${random}`;
      for (const file of files) {
        active(); const path = `${root}/${joinSyncPath(directory, file.path)}`, parts = path.split("/"); parts.pop();
        for (let count = 1; count <= parts.length; count++) {
          active(); const folder = parts.slice(0, count).join("/");
          if (!(await vault.adapter.exists(folder))) await vault.adapter.mkdir(folder);
        }
        active(); if (await vault.adapter.exists(path)) throw new Error(t("githubPull.backup"));
        await vault.adapter.write(path, file.content);
        if (await vault.adapter.read(path) !== file.content) throw new Error(t("githubPull.backup"));
      }
    },
  };
  const local: WallSyncFile[] = [];
  for (const file of vault.getFiles()) {
    active();
    if (!file.path.endsWith(".mw") || file.path.split("/").some(part => part.startsWith(".")) || !inSyncDirectory(file.path, directory)) continue;
    const relative = directory ? file.path.slice(directory.length + 1) : file.path, content = await io.read(relative);
    if (content !== null) local.push({ path: relative, content });
  }
  const remote = await reader.snapshot(input.repoUrl, input.branch, remoteDirectory, signal);
  active(); const plan = buildSyncPlan("pull", local, remote.files);
  let applied = false;
  return { plan, branch: remote.branch, commit: remote.commit, async apply(selected, applySignal) {
    if (applied) throw new Error(t("gitSync.previewNeeded"));
    activeSignal = applySignal ?? signal; active(); applied = true;
    await remote.assertCurrent(activeSignal); active();
    return applyWallPull(plan, selected, io);
  } };
}
