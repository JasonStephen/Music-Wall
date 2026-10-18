import { App, Modal } from "obsidian";
import { t } from "../i18n";
import type { GitHubAccountController, GitHubAccounts } from "../core/githubAuth";
import { applyModalTheme } from "./modalTheme";

/** Browser OAuth runs in GCM, so this UI never receives a password or access token. */
export class GitHubLoginModal extends Modal {
  private abort = new AbortController();
  private disposed = false;
  private busy = false;
  private state: GitHubAccounts = { available: false, accounts: [] };
  private status: HTMLElement;
  private accounts: HTMLSelectElement;
  private login: HTMLButtonElement;
  private use: HTMLButtonElement;
  private disconnect: HTMLButtonElement;
  private refresh: HTMLButtonElement;

  constructor(app: App, private controller: GitHubAccountController, private closed: () => void = () => {}) { super(app); }
  onOpen(): void {
    this.modalEl.addClass("mw-modal-zoom", "mw-github-login"); applyModalTheme(this.modalEl);
    const root = this.contentEl;
    root.createEl("h2", { text: t("githubAuth.title") });
    root.createEl("p", { text: t("githubAuth.description"), cls: "mw-git-sync__hint" });
    const label = root.createEl("label", { cls: "mw-github-login__account" });
    label.createSpan({ text: t("githubAuth.choose") });
    this.accounts = label.createEl("select", { attr: { "data-action": "github-account" } });
    this.accounts.addEventListener("change", () => this.updateControls());
    const actions = root.createDiv({ cls: "mw-git-sync__actions" });
    this.login = actions.createEl("button", { text: t("githubAuth.signIn"), cls: "mod-cta", attr: { "data-action": "github-login" } });
    this.login.addEventListener("click", () => void this.load(true));
    this.refresh = actions.createEl("button", { text: t("githubAuth.refresh"), attr: { "data-action": "github-refresh" } });
    this.refresh.addEventListener("click", () => void this.load(false));
    this.status = root.createDiv({ cls: "mw-git-sync__status", attr: { role: "status", "aria-live": "polite" } });
    const help = root.createEl("p", { cls: "mw-git-sync__hint" });
    help.createEl("a", { text: t("githubAuth.install"), attr: { href: "https://github.com/git-ecosystem/git-credential-manager/blob/release/docs/install.md", target: "_blank", rel: "noopener noreferrer" } });
    root.createEl("p", { text: t("githubAuth.scope"), cls: "mw-git-sync__hint" });
    const footer = root.createDiv({ cls: "mw-git-sync__actions" });
    this.disconnect = footer.createEl("button", { text: t("githubAuth.disconnect"), attr: { "data-action": "github-disconnect" } });
    this.disconnect.addEventListener("click", () => void this.save(""));
    this.use = footer.createEl("button", { text: t("githubAuth.use"), cls: "mod-cta", attr: { "data-action": "github-use" } });
    this.use.addEventListener("click", () => void this.save(this.accounts.value));
    footer.createEl("button", { text: t("common.cancel") }).addEventListener("click", () => this.close());
    void this.load(false);
  }
  private updateControls(): void {
    this.accounts.disabled = this.busy || !this.state.accounts.length;
    this.login.disabled = this.busy || !this.state.available;
    this.refresh.disabled = this.busy;
    this.use.disabled = this.busy || !this.state.accounts.includes(this.accounts.value);
    this.disconnect.disabled = this.busy || !this.controller.selected();
    this.contentEl.setAttr("aria-busy", String(this.busy));
  }
  private async load(login: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.updateControls(); this.status.removeClass("is-error");
    this.status.setText(t(login ? "githubAuth.waiting" : "githubAuth.loading"));
    const before = this.state.accounts, previous = this.accounts.value || this.controller.selected();
    try {
      const state = await (login ? this.controller.login(this.abort.signal) : this.controller.inspect(this.abort.signal));
      if (this.disposed) return;
      this.state = state; this.accounts.empty();
      this.accounts.createEl("option", { attr: { value: "" }, text: t("githubAuth.choose") });
      for (const account of state.accounts) this.accounts.createEl("option", { attr: { value: account }, text: account });
      const added = login ? state.accounts.filter(account => !before.includes(account)) : [];
      this.accounts.value = added.length === 1 ? added[0] : state.accounts.includes(previous) ? previous : state.accounts.length === 1 ? state.accounts[0] : "";
      this.status.setText(t(!state.available ? "githubAuth.missing" : login ? "githubAuth.authorized" : state.accounts.length ? "githubAuth.ready" : "githubAuth.empty"));
    } catch (error) {
      if (!this.disposed) { this.status.setText((error as Error).message); this.status.addClass("is-error"); }
    } finally { if (!this.disposed) { this.busy = false; this.updateControls(); } }
  }
  private async save(account: string): Promise<void> {
    if (this.busy || (account && !this.state.accounts.includes(account))) return;
    this.busy = true; this.updateControls();
    try { await this.controller.select(account); if (!this.disposed) this.close(); }
    catch { if (!this.disposed) { this.status.setText(t("githubAuth.saveFailed")); this.status.addClass("is-error"); } }
    finally { if (!this.disposed) { this.busy = false; this.updateControls(); } }
  }
  onClose(): void { this.disposed = true; this.abort.abort(); this.closed(); this.contentEl.empty(); }
}
