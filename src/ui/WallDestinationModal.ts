import { App, Modal, Notice, setIcon } from "obsidian";
import { t } from "../i18n";
import { applyModalTheme } from "./modalTheme";

export interface Destination { id: string | null; name: string; detail?: string; disabled?: boolean; icon?: string; }
export class WallDestinationModal extends Modal {
  constructor(app: App, private heading: string, private choices: Destination[], private pick: (id: string | null) => Promise<unknown>) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("mw-modal-zoom"); applyModalTheme(this.modalEl);
    this.contentEl.addClass("mw-wall-dialog"); this.contentEl.createEl("h2", { text: this.heading });
    const input = this.contentEl.createEl("input", { attr: { type: "search", placeholder: t("localWall.searchPlaceholder"), "aria-label": t("library.search") } });
    const list = this.contentEl.createDiv({ cls: "mw-wall-dialog__choices" });
    const render = () => {
      list.empty();
      for (const c of this.choices.filter(c => `${c.name} ${c.detail || ""}`.toLowerCase().includes(input.value.toLowerCase()))) {
        const b = list.createEl("button", { cls: "mw-wall-dialog__choice", attr: { type: "button" } });
        setIcon(b.createSpan({ cls: "mw-control-icon" }), c.icon || "folder");
        const label = b.createDiv(); label.createDiv({ text: c.name }); if (c.detail) label.createEl("small", { text: c.detail });
        b.disabled = !!c.disabled;
        b.addEventListener("click", () => {
          b.disabled = true;
          void this.pick(c.id).then(() => this.close()).catch(() => { b.disabled = !!c.disabled; new Notice(t("localWall.updateFailed")); });
        });
      }
    };
    input.addEventListener("input", render); render(); input.focus();
  }
}

export class WallTextModal extends Modal {
  constructor(app: App, private heading: string, private value: string, private submit: (value: string) => Promise<unknown>, private multiline = false) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("mw-modal-zoom"); applyModalTheme(this.modalEl); this.contentEl.addClass("mw-wall-dialog");
    this.contentEl.createEl("h2", { text: this.heading });
    const input = this.multiline ? this.contentEl.createEl("textarea") : this.contentEl.createEl("input", { type: "text" });
    input.value = this.value; input.setAttr("aria-label", this.heading);
    const error = this.contentEl.createDiv({ cls: "mw-wall-dialog__error", attr: { role: "alert" } });
    const actions = this.contentEl.createDiv({ cls: "mw-wall-dialog__actions" });
    const cancel = actions.createEl("button", { text: t("common.cancel") }); cancel.addEventListener("click", () => this.close());
    const button = actions.createEl("button", { text: t("common.confirm"), cls: "mod-cta" });
    const save = async () => {
      if (!this.multiline && !input.value.trim()) { error.setText(t("inputModal.empty")); return; }
      button.disabled = true;
      try { await this.submit(input.value.trim()); this.close(); }
      catch { error.setText(t("localWall.folderConflict")); button.disabled = false; }
    };
    button.addEventListener("click", () => void save());
    input.addEventListener("keydown", event => { const key = event as KeyboardEvent; if (key.key === "Enter" && (!this.multiline || key.ctrlKey || key.metaKey)) { event.preventDefault(); void save(); } });
    input.focus();
  }
}
