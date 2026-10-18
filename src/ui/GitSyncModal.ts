import { App, Modal, Notice, setIcon } from "obsidian";
import { t } from "../i18n";
import { canSelectSyncRow, changedLineSets, defaultSyncSelection, selectedSyncChanges, summarizeWallChange, type SyncDirection, type WallSyncPlan, type WallSyncRow } from "../core/wallSync";
import { applyModalTheme } from "./modalTheme";

export interface GitSyncConfig { repoUrl: string; branch: string; localDirectory: string; remoteDirectory: string; }
export interface GitSyncPreview { plan: WallSyncPlan; branch: string; commit: string | null; apply(selected: Set<string>): Promise<number>; }
export type PrepareSyncPreview = (config: GitSyncConfig, direction: SyncDirection) => Promise<GitSyncPreview>;

/** One reviewable snapshot: folder selection, file differences, then explicit apply. */
export class GitSyncModal extends Modal {
  private preview: GitSyncPreview | null = null;
  private selected = new Set<string>();
  private checkboxes: { input: HTMLInputElement; paths: string[] }[] = [];
  private fields: HTMLInputElement[] = [];
  private busy = false;
  private generation = 0;
  private disposed = false;
  private status: HTMLElement;
  private review: HTMLElement;
  private details: HTMLElement;
  private summary: HTMLElement;
  private confirm: HTMLButtonElement;
  private previewButtons: HTMLButtonElement[] = [];
  private accountButton?: HTMLButtonElement;

  constructor(app: App, private config: GitSyncConfig, private prepare: PrepareSyncPreview, private direction: SyncDirection = "pull", private closed: () => void = () => {}, private account?: { name(): string; open(): Promise<boolean> }) { super(app); }

  onOpen(): void {
    this.modalEl.addClass("mw-modal-zoom", "mw-git-sync"); applyModalTheme(this.modalEl);
    const root = this.contentEl; root.empty();
    root.createEl("h2", { text: t("gitSync.title") });
    root.createEl("p", { cls: "mw-git-sync__hint", text: t("gitSync.scope") });
    if (this.account) {
      const row = root.createDiv({ cls: "mw-git-sync__actions" });
      this.accountButton = row.createEl("button", { text: this.accountLabel(), attr: { "data-action": "github-manage" } });
      this.accountButton.addEventListener("click", () => void this.manageAccount());
    }
    const fields = root.createDiv({ cls: "mw-git-sync__fields" });
    for (const [key, label, placeholder] of [
      ["repoUrl", "repository", "https://github.com/user/music-walls.git"],
      ["branch", "branch", t("gitSync.defaultBranch")],
      ["localDirectory", "localDirectory", t("gitSync.vaultRoot")],
      ["remoteDirectory", "remoteDirectory", t("gitSync.repoRoot")],
    ] as const) {
      const field = fields.createEl("label"); field.createSpan({ text: t(`gitSync.${label}`) });
      const input = field.createEl("input", { type: "text", value: this.config[key], attr: { placeholder, "data-field": key, spellcheck: "false" } });
      input.value = this.config[key];
      this.fields.push(input);
      input.addEventListener("input", () => { this.config = { ...this.config, [key]: input.value }; this.invalidate(); });
    }
    const actions = root.createDiv({ cls: "mw-git-sync__actions" });
    for (const direction of ["push", "pull"] as const) {
      const button = actions.createEl("button", { text: t(`gitSync.preview${direction === "push" ? "Push" : "Pull"}`), cls: direction === this.direction ? "mod-cta" : "", attr: { "data-preview": direction } });
      button.addEventListener("click", () => void this.loadPreview(direction)); this.previewButtons.push(button);
    }
    this.status = root.createDiv({ cls: "mw-git-sync__status", attr: { role: "status", "aria-live": "polite" } });
    this.review = root.createDiv({ cls: "mw-git-sync__review" });
    this.details = root.createDiv({ cls: "mw-git-sync__details" });
    const footer = root.createDiv({ cls: "mw-git-sync__footer" });
    this.summary = footer.createDiv({ cls: "mw-git-sync__summary", attr: { "aria-live": "polite" } });
    const buttons = footer.createDiv({ cls: "mw-git-sync__actions" });
    buttons.createEl("button", { text: t("common.cancel") }).addEventListener("click", () => this.close());
    this.confirm = buttons.createEl("button", { cls: "mod-cta", attr: { "data-action": "apply-sync" } });
    this.confirm.addEventListener("click", () => void this.apply()); this.updateSelection();
    if (this.config.repoUrl) void this.loadPreview(this.direction);
  }

  private invalidate(): void {
    this.generation++; this.preview = null; this.review?.empty(); this.details?.empty(); this.checkboxes = [];
    this.status?.setText(t("gitSync.previewNeeded")); this.updateSelection();
  }
  private setBusy(busy: boolean): void {
    this.busy = busy;
    if (this.accountButton) this.accountButton.disabled = busy;
    for (const field of this.fields) field.disabled = busy;
    for (const button of this.previewButtons) button.disabled = busy;
    for (const item of this.checkboxes) item.input.disabled = busy || !item.paths.length;
    this.contentEl.setAttr("aria-busy", String(busy)); this.updateSelection();
  }
  private accountLabel(): string { return this.account?.name() ? t("githubAuth.current", { name: this.account.name() }) : t("githubAuth.title"); }
  private async manageAccount(): Promise<void> {
    if (this.busy || !this.account) return;
    this.setBusy(true);
    try {
      const changed = await this.account.open();
      if (!this.disposed) { this.accountButton?.setText(this.accountLabel()); if (changed) this.invalidate(); }
    } catch { if (!this.disposed) this.status.setText(t("githubAuth.failed")); }
    finally { if (!this.disposed) this.setBusy(false); }
  }
  private async loadPreview(direction: SyncDirection): Promise<void> {
    if (this.busy) return;
    this.invalidate(); this.direction = direction;
    const generation = this.generation;
    this.setBusy(true); this.status.setText(t("gitSync.loading")); this.status.removeClass("is-error");
    try {
      const preview = await this.prepare({ ...this.config }, direction);
      if (this.disposed || generation !== this.generation) return;
      this.preview = preview;
      this.selected = defaultSyncSelection(preview.plan, !!this.config.localDirectory.trim());
      this.renderPreview();
      this.status.setText(t("gitSync.snapshot", { branch: preview.branch, commit: preview.commit?.slice(0, 7) ?? t("gitSync.emptyRepo") }));
    } catch (error) { if (!this.disposed) { this.status.setText((error as Error).message); this.status.addClass("is-error"); } }
    finally { this.setBusy(false); }
  }

  private renderPreview(): void {
    const preview = this.preview!; this.review.empty(); this.checkboxes = [];
    this.review.createDiv({ cls: "mw-git-sync__mapping", text: `${t("gitSync.local")}: ${this.config.localDirectory || "/"} ${this.direction === "push" ? "→" : "←"} ${t("gitSync.remote")}: ${this.config.remoteDirectory || "/"}` });
    this.review.createEl("p", { cls: "mw-git-sync__hint", text: t(this.direction === "push" ? "gitSync.pushDefault" : "gitSync.pullDefault") });
    const tools = this.review.createDiv({ cls: "mw-git-sync__actions" });
    for (const [key, all] of [["selectAll", true], ["selectNone", false]] as const) tools.createEl("button", { text: t(`gitSync.${key}`) }).addEventListener("click", () => {
      if (this.busy) return;
      this.selected = new Set(all ? preview.plan.rows.filter(canSelectSyncRow).map(row => row.path) : []); this.updateSelection();
    });
    if (!preview.plan.rows.length) this.review.createEl("p", { text: t("gitSync.noFiles") });
    const tree = this.review.createDiv({ cls: "mw-git-sync__tree", attr: { "aria-label": t("gitSync.files") } });
    const renderLevel = (parent: HTMLElement, prefix: string) => {
      const rows = preview.plan.rows.filter(row => row.path.startsWith(prefix));
      const directories = new Set(rows.flatMap(row => { const tail = row.path.slice(prefix.length); return tail.includes("/") ? [tail.split("/")[0]] : []; }));
      for (const name of directories) {
        const directory = `${prefix}${name}/`, group = parent.createEl("details", { cls: "mw-git-sync__folder" }); group.open = true;
        const header = group.createEl("summary"), paths = rows.filter(row => row.path.startsWith(directory) && canSelectSyncRow(row)).map(row => row.path);
        this.checkbox(header, paths, name);
        const icon = header.createSpan({ cls: "mw-control-icon", attr: { "aria-hidden": "true" } }); setIcon(icon, "folder");
        header.createSpan({ text: name }); header.createSpan({ cls: "mw-git-sync__count", text: String(rows.filter(row => row.path.startsWith(directory)).length) });
        renderLevel(group.createDiv({ cls: "mw-git-sync__children" }), directory);
      }
      for (const row of rows.filter(row => !row.path.slice(prefix.length).includes("/"))) {
        const item = parent.createDiv({ cls: `mw-git-sync__file is-${row.status}`, attr: { "data-path": row.path } });
        this.checkbox(item, canSelectSyncRow(row) ? [row.path] : [], row.path);
        const button = item.createEl("button", { cls: "mw-git-sync__filename", text: row.path.slice(prefix.length), attr: { title: t("gitSync.viewDiff", { path: row.path }) } });
        button.addEventListener("click", () => this.showDiff(row));
        item.createSpan({ cls: "mw-git-sync__badge", text: t(`gitSync.${row.status}`), attr: { title: row.error ?? t(`gitSync.${row.status}`) } });
      }
    };
    renderLevel(tree, ""); this.updateSelection();
  }
  private checkbox(parent: HTMLElement, paths: string[], label: string): void {
    const input = parent.createEl("input", { type: "checkbox", attr: { "aria-label": t("gitSync.selectPath", { path: label }) } });
    input.disabled = !paths.length; this.checkboxes.push({ input, paths });
    input.addEventListener("click", event => event.stopPropagation());
    input.addEventListener("change", () => { if (this.busy) return; for (const path of paths) input.checked ? this.selected.add(path) : this.selected.delete(path); this.updateSelection(); });
  }
  private updateSelection(): void {
    if (!this.confirm) return;
    const rows = this.preview ? selectedSyncChanges(this.preview.plan, this.selected) : [];
    for (const { input, paths } of this.checkboxes) { const count = paths.filter(path => this.selected.has(path)).length; input.checked = !!paths.length && count === paths.length; input.indeterminate = count > 0 && count < paths.length; }
    this.summary.setText(this.preview ? t("gitSync.selection", { selected: this.selected.size, added: rows.filter(row => row.status === "new").length, changed: rows.filter(row => row.status === "changed").length }) : "");
    this.confirm.setText(t(this.direction === "push" ? "gitSync.confirmPush" : "gitSync.confirmPull", { count: rows.length }));
    this.confirm.disabled = this.busy || !this.preview || !rows.length;
  }
  private showDiff(row: WallSyncRow): void {
    this.details.empty(); this.details.createEl("h3", { text: row.path });
    if (row.error) this.details.createEl("p", { cls: "is-error", text: row.error });
    const before = this.direction === "push" ? row.remote : row.local, after = this.direction === "push" ? row.local : row.remote;
    const summary = summarizeWallChange(before, after);
    if (summary && row.status !== "kept") this.details.createEl("p", { text: t("gitSync.albumDiff", { added: summary.added, removed: summary.removed, updated: summary.updated }) + (summary.settings ? ` · ${t("gitSync.wallSettingsChanged")}` : "") });
    if (row.status === "kept") this.details.createEl("p", { text: t("gitSync.keptHint") });
    const values = [row.local?.content ?? "", row.remote?.content ?? ""], changes = changedLineSets(values[0], values[1]);
    const columns = this.details.createDiv({ cls: "mw-git-sync__diff" });
    for (let side = 0; side < 2; side++) {
      const column = columns.createDiv(); column.createEl("h4", { text: t(side === 0 ? "gitSync.local" : "gitSync.remote") });
      const pre = column.createEl("pre", { attr: { tabindex: "0", "aria-label": t(side === 0 ? "gitSync.local" : "gitSync.remote") } });
      if (!values[side]) pre.setText(t("gitSync.missing"));
      else values[side].split("\n").forEach((line, index) => pre.createSpan({ cls: changes[side].has(index) ? "is-different" : "", text: `${index + 1}  ${line}\n` }));
    }
  }
  private async apply(): Promise<void> {
    const preview = this.preview;
    if (this.busy || !preview || !selectedSyncChanges(preview.plan, this.selected).length) return;
    this.setBusy(true); this.status.setText(t("gitSync.applying"));
    try {
      const count = await preview.apply(new Set(this.selected));
      const message = t(this.direction === "push" ? "gitSync.pushed" : "gitSync.pulled", { count });
      new Notice(message); this.invalidate(); if (!this.disposed) this.status.setText(message);
    } catch (error) { this.invalidate(); if (!this.disposed) { this.status.setText((error as Error).message); this.status.addClass("is-error"); } }
    finally { this.setBusy(false); }
  }
  onClose(): void { this.disposed = true; this.generation++; this.closed(); this.contentEl.empty(); }
}
