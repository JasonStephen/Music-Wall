import { App, Modal } from "obsidian";
import { createQrLogin, checkQrLogin, type QrLoginSession } from "../core/auth";
import type { Requester } from "../core/metadata";
import { t } from "../i18n";
import { applyModalTheme } from "./modalTheme";

/** 关闭、刷新、登出及卸载均作废旧请求；一次只轮询一个二维码。 */
export class NeteaseLoginModal extends Modal {
  readonly result: Promise<boolean>;
  private settle: (success: boolean) => void;
  private generation = 0;
  private closed = false;
  private completed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private statusEl: HTMLElement;
  private imageEl: HTMLImageElement;
  private refreshButton: HTMLButtonElement;

  constructor(
    app: App,
    private request: Requester,
    private acceptLogin: (cookie: string, valid: () => boolean) => Promise<boolean>
  ) {
    super(app);
    this.result = new Promise((resolve) => { this.settle = resolve; });
  }

  onOpen(): void {
    this.modalEl.addClass("mw-modal-zoom", "mw-login-modal");
    applyModalTheme(this.modalEl);
    this.contentEl.addClass("mw-login");
    this.contentEl.createEl("h2", { text: t("auth.title") });
    this.contentEl.createEl("p", { text: t("auth.scanHint") });
    const frame = this.contentEl.createDiv({ cls: "mw-login__frame" });
    this.imageEl = frame.createEl("img", { attr: { alt: t("auth.qrAlt") } });
    this.imageEl.hidden = true;
    this.statusEl = this.contentEl.createDiv({ cls: "mw-login__status", attr: { role: "status", "aria-live": "polite" } });
    this.contentEl.createEl("p", { cls: "mw-login__note", text: t("auth.modalNote") });
    const buttons = this.contentEl.createDiv({ cls: "mw-login__buttons" });
    this.refreshButton = buttons.createEl("button", { text: t("auth.refresh"), attr: { type: "button" } });
    this.refreshButton.addEventListener("click", () => void this.generate());
    buttons.createEl("button", { text: t("common.cancel"), attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    void this.generate();
  }

  private async generate(): Promise<void> {
    const generation = ++this.generation;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.imageEl.hidden = true;
    this.imageEl.removeAttribute("src");
    this.statusEl.setText(t("auth.preparing"));
    this.refreshButton.disabled = true;
    try {
      const session = await createQrLogin(this.request);
      if (!this.alive(generation)) return;
      this.imageEl.src = session.image;
      this.imageEl.hidden = false;
      this.statusEl.setText(t("auth.waiting"));
      this.refreshButton.disabled = false;
      this.schedule(session, generation);
    } catch (error) {
      this.fail(error, generation);
    }
  }

  private alive(generation: number): boolean {
    return !this.closed && this.generation === generation;
  }

  private schedule(session: QrLoginSession, generation: number, failures = 0): void {
    this.timer = setTimeout(() => void this.poll(session, generation, failures), failures ? 3000 : 1500);
  }

  private async poll(session: QrLoginSession, generation: number, failures: number): Promise<void> {
    if (!this.alive(generation)) return;
    try {
      const code = await checkQrLogin(this.request, session);
      if (!this.alive(generation)) return;
      if (code === 800) {
        this.imageEl.hidden = true;
        this.statusEl.setText(t("auth.expired"));
        return;
      }
      if (code === 803) {
        this.refreshButton.disabled = true;
        this.imageEl.hidden = true;
        this.statusEl.setText(t("auth.verifying"));
        const accepted = await this.acceptLogin(session.cookie, () => this.alive(generation));
        if (!this.alive(generation)) return;
        if (!accepted) throw new Error(t("auth.verifyFailed"));
        this.completed = true;
        this.close();
        return;
      }
      this.statusEl.setText(t(code === 802 ? "auth.confirm" : "auth.waiting"));
      this.schedule(session, generation);
    } catch (error) {
      if (!this.alive(generation)) return;
      if (failures < 2 && Date.now() < session.expiresAt) {
        this.statusEl.setText(t("auth.retrying"));
        this.schedule(session, generation, failures + 1);
      } else {
        this.fail(error, generation);
      }
    }
  }

  private fail(error: unknown, generation: number): void {
    if (!this.alive(generation)) return;
    this.imageEl.hidden = true;
    this.statusEl.setText(error instanceof Error ? error.message : t("auth.networkError"));
    this.refreshButton.disabled = false;
  }

  onClose(): void {
    this.closed = true;
    ++this.generation;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.imageEl?.removeAttribute("src");
    this.contentEl.empty();
    this.settle(this.completed);
  }
}
