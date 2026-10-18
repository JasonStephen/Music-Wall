import { App, Modal, Platform, setIcon } from "obsidian";
import { t } from "../i18n";
import { applyModalTheme } from "./modalTheme";

export interface WallPickFile { path: string; label: string; }
interface WallLeaf { kind: "file"; path: string; name: string; index: number; }
interface WallFolder { kind: "folder"; path: string; name: string; folders: Map<string, WallFolder>; files: WallLeaf[]; count: number; }
const folder = (path: string, name: string): WallFolder => ({ kind: "folder", path, name, folders: new Map(), files: [], count: 0 });
const normalize = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/\\/g, "/");
const compare = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** Directory buttons only navigate; a specific wall file is the sole write trigger. */
export class WallTreePickerModal extends Modal {
  private tree = folder("", "");
  private expanded = new Set<string>();
  private searchCollapsed = new Set<string>();
  private query = "";
  private list!: HTMLElement;
  private status!: HTMLElement;
  private input!: HTMLInputElement;
  private clear!: HTMLButtonElement;
  private rows: { node: WallFolder | WallLeaf; button: HTMLButtonElement; depth: number; expanded: boolean }[] = [];
  private activePath = "";
  private disposed = false;
  private picked = false;
  private focusTimer?: ReturnType<typeof setTimeout>;

  constructor(app: App, private title: string, files: WallPickFile[], private onPick: (index: number) => void) {
    super(app);
    files.forEach((file, index) => {
      const parts = file.path.split("/").filter(Boolean); const name = parts.pop();
      if (!name || !name.endsWith(".mw")) return;
      let parent = this.tree; parent.count++;
      for (const part of parts) {
        if (!parent.folders.has(part)) parent.folders.set(part, folder(parent.path ? `${parent.path}/${part}` : part, part));
        parent = parent.folders.get(part)!; parent.count++;
      }
      parent.files.push({ kind: "file", path: file.path, name: file.label || name.replace(/\.mw$/, ""), index });
    });
    for (const child of this.tree.folders.values()) this.expanded.add(child.path);
  }

  onOpen(): void {
    this.modalEl.addClass("mw-modal-zoom", "mw-wall-picker"); applyModalTheme(this.modalEl);
    const root = this.contentEl; root.empty(); root.addClass("mw-wall-picker__content");
    root.createEl("h2", { text: this.title });
    const search = root.createDiv({ cls: "mw-wall-picker__search" }); this.icon(search.createSpan({ cls: "mw-wall-picker__glyph" }), "search");
    this.input = search.createEl("input", { attr: { type: "search", placeholder: t("wallPicker.search"), "aria-label": t("wallPicker.search"), maxlength: "200" } });
    this.clear = this.button(search, "x", t("wallPicker.clear"), () => { this.input.value = ""; this.updateSearch(); this.input.focus(); });
    this.clear.addClass("mw-wall-picker__clear");
    this.input.addEventListener("input", () => this.updateSearch());
    this.input.addEventListener("keydown", event => { if (event.key === "ArrowDown") { event.preventDefault(); this.focusRow(0); } });
    this.status = root.createDiv({ cls: "mw-wall-picker__status", attr: { "aria-live": "polite" } });
    this.list = root.createDiv({ cls: "mw-wall-picker__tree", attr: { role: "tree", "aria-label": this.title } });
    const footer = root.createDiv({ cls: "mw-wall-picker__footer" });
    this.button(footer, "x", t("common.cancel"), () => this.close(), true);
    this.renderTree();
    // Keep the mobile keyboard closed until the user chooses to search.
    if (Platform.isDesktopApp) this.focusTimer = setTimeout(() => { if (!this.disposed) this.input.focus(); }, 0);
  }
  private icon(parent: HTMLElement, name: string): void { parent.setAttr("aria-hidden", "true"); setIcon(parent, name); }
  private button(parent: HTMLElement, icon: string, label: string, action: () => void, text = false): HTMLButtonElement {
    const button = parent.createEl("button", { cls: "clickable-icon mw-wall-picker__button", attr: { type: "button", title: label, "aria-label": label } });
    this.icon(button.createSpan({ cls: "mw-wall-picker__glyph" }), icon);
    if (text) button.createSpan({ text: label });
    button.addEventListener("click", action); return button;
  }
  private updateSearch(): void {
    if (this.disposed) return;
    this.query = this.input.value.trim(); this.searchCollapsed.clear(); this.renderTree();
    this.list.scrollTop = 0;
  }
  private filtered(source: WallFolder, terms: string[]): WallFolder {
    if (!terms.length) return source;
    const result = folder(source.path, source.name);
    result.files = source.files.filter(file => terms.every(term => normalize(`${file.path} ${file.name}`).includes(term)));
    result.count = result.files.length;
    for (const child of source.folders.values()) {
      const found = this.filtered(child, terms);
      if (found.count) { result.folders.set(child.name, found); result.count += found.count; }
    }
    return result;
  }
  private renderTree(focus = false): void {
    this.list.empty(); this.rows = [];
    const searching = !!this.query, tree = this.filtered(this.tree, normalize(this.query).split(/\s+/).filter(Boolean));
    this.clear.hidden = !this.input.value.length;
    this.status.setText(t("wallPicker.count", { count: tree.count }));
    const render = (node: WallFolder, parent: HTMLElement, depth: number) => {
      const children: (WallFolder | WallLeaf)[] = [...[...node.folders.values()].sort(compare), ...[...node.files].sort(compare)];
      for (const child of children) {
        const group = parent.createDiv({ cls: "mw-wall-picker__branch", attr: { role: "none" } });
        const open = child.kind === "folder" && (searching ? !this.searchCollapsed.has(child.path) : this.expanded.has(child.path));
        const row = this.button(group, child.kind === "folder" ? (open ? "chevron-down" : "chevron-right") : "disc", child.path, () => {
          if (this.disposed || this.picked) return;
          this.activePath = child.path;
          if (child.kind === "file") { this.picked = true; this.close(); this.onPick(child.index); }
          else {
            if (searching) { if (open) this.searchCollapsed.add(child.path); else this.searchCollapsed.delete(child.path); }
            else { if (open) this.expanded.delete(child.path); else this.expanded.add(child.path); }
            this.renderTree(true);
          }
        });
        row.addClass("mw-wall-picker__row"); row.dataset.path = child.path; row.dataset.kind = child.kind;
        row.setAttr("role", "treeitem"); row.setAttr("aria-level", String(depth + 1)); row.style.setProperty("--mw-tree-depth", String(Math.min(depth, 6)));
        row.tabIndex = -1;
        if (child.kind === "folder") { row.setAttr("aria-expanded", String(open)); this.icon(row.createSpan({ cls: "mw-wall-picker__glyph" }), open ? "folder-open" : "folder"); }
        row.createSpan({ cls: "mw-wall-picker__name", text: child.name });
        row.createSpan({ cls: "mw-wall-picker__badge", text: child.kind === "folder" ? String(child.count) : ".mw" });
        this.rows.push({ node: child, button: row, depth, expanded: open });
        row.addEventListener("focus", () => { this.activePath = child.path; this.rows.forEach(item => { item.button.tabIndex = item.button === row ? 0 : -1; }); });
        row.addEventListener("keydown", event => this.onKey(event, child.path));
        if (child.kind === "folder" && open) { const subtree = group.createDiv({ cls: "mw-wall-picker__children", attr: { role: "group" } }); render(child, subtree, depth + 1); }
      }
    };
    render(tree, this.list, 0);
    if (!tree.count) this.list.createDiv({ cls: "mw-wall-picker__empty", text: t(this.query ? "wallPicker.noResults" : "library.noWalls") });
    const active = this.rows.find(row => row.node.path === this.activePath) || this.rows[0];
    if (active) { active.button.tabIndex = 0; if (focus) active.button.focus(); }
  }
  private focusRow(index: number): void { this.rows[index]?.button.focus(); }
  private onKey(event: KeyboardEvent, path: string): void {
    const index = this.rows.findIndex(row => row.node.path === path), row = this.rows[index]; if (!row) return;
    if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (event.key === "ArrowDown") this.focusRow(Math.min(this.rows.length - 1, index + 1));
    if (event.key === "ArrowUp") this.focusRow(Math.max(0, index - 1));
    if (event.key === "Home") this.focusRow(0);
    if (event.key === "End") this.focusRow(this.rows.length - 1);
    if (event.key === "ArrowRight" && row.node.kind === "folder") { if (!row.expanded) row.button.click(); else if (this.rows[index + 1]?.depth > row.depth) this.focusRow(index + 1); }
    if (event.key === "ArrowLeft") {
      if (row.node.kind === "folder" && row.expanded) row.button.click();
      else { const parent = path.split("/").slice(0, -1).join("/"); const target = this.rows.findIndex(item => item.node.path === parent); if (target >= 0) this.focusRow(target); }
    }
  }
  onClose(): void { this.disposed = true; if (this.focusTimer !== undefined) clearTimeout(this.focusTimer); this.rows = []; this.contentEl.empty(); }
}
