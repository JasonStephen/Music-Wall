import { App, Modal } from "obsidian";
import { createQrLogin, checkQrLogin, type QrLoginSession } from "../core/auth";
import type { Requester } from "../core/metadata";
import { t } from "../i18n";
import { LoginDiagnosticError, loginErrorMessage, type LoginStage } from "../core/loginDiagnostics";
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
  private retryButton: HTMLButtonElement;
  private session?: QrLoginSession;
  private phase: "check" | "verify" = "check";
  private failures = 0;
  private stopped = false;
  private inFlight = new Set<number>();
  private suspension = 0;
  private resumeRequested = false;
  private doc: Document;
  private win: Window;
  private readonly resume = () => {
    if (this.doc.hidden) {
      ++this.suspension;
      this.clearTimer();
      return;
    }
    if (this.closed || this.stopped || !this.session) return;
    this.clearTimer();
    if (this.inFlight.has(this.generation)) this.resumeRequested = true;
    else void this.poll(this.generation);
  };

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
    this.retryButton = buttons.createEl("button", { text: t("authDiagnostics.retry"), attr: { type: "button" } });
    this.retryButton.hidden = true;
    this.retryButton.addEventListener("click", () => {
      if (!this.session || this.inFlight.has(this.generation)) return;
      this.failures = 0;
      this.stopped = false;
      this.retryButton.hidden = true;
      void this.poll(this.generation);
    });
    buttons.createEl("button", { text: t("common.cancel"), attr: { type: "button" } })
      .addEventListener("click", () => this.close());
    this.doc = this.contentEl.ownerDocument ?? document;
    this.win = this.doc.defaultView ?? window;
    this.doc.addEventListener("visibilitychange", this.resume);
    this.win.addEventListener("focus", this.resume);
    this.win.addEventListener("pageshow", this.resume);
    void this.generate();
  }

  private async generate(): Promise<void> {
    const generation = ++this.generation;
    this.clearTimer();
    this.session = undefined;
    this.phase = "check";
    this.failures = 0;
    this.stopped = false;
    this.resumeRequested = false;
    this.retryButton.hidden = true;
    this.imageEl.hidden = true;
    this.imageEl.removeAttribute("src");
    this.statusEl.setText(t("auth.preparing"));
    this.refreshButton.disabled = true;
    try {
      const session = await createQrLogin(this.request);
      if (!this.alive(generation)) return;
      this.session = session;
      this.imageEl.src = session.image;
      this.imageEl.hidden = false;
      this.statusEl.setText(t("auth.waiting"));
      this.refreshButton.disabled = false;
      this.schedule(generation);
    } catch (error) {
      this.fail(error, generation, "create");
    }
  }

  private alive(generation: number): boolean {
    return !this.closed && this.generation === generation;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(generation: number): void {
    this.clearTimer();
    if (!this.alive(generation) || this.doc.hidden || this.stopped) return;
    this.timer = setTimeout(() => void this.poll(generation), this.failures ? 3000 : 1500);
  }

  private async poll(generation: number): Promise<void> {
    if (!this.alive(generation) || !this.session || this.doc.hidden || this.inFlight.has(generation)) return;
    this.clearTimer();
    this.inFlight.add(generation);
    const session = this.session;
    const suspension = this.suspension;
    this.retryButton.hidden = true;
    try {
      if (this.phase === "check") {
        const code = await checkQrLogin(this.request, session);
        if (!this.alive(generation)) return;
        if (code === 800) {
          this.stopped = true;
          this.imageEl.hidden = true;
          this.statusEl.setText(t("auth.expired"));
          return;
        }
        this.failures = 0;
        if (code !== 803) {
          this.imageEl.hidden = false;
          this.statusEl.setText(t(code === 802 ? "auth.confirm" : "auth.waiting"));
          this.schedule(generation);
          return;
        }
        // Once authorized, retain the credential and never poll the spent QR again.
        this.phase = "verify";
      }
      if (!this.doc.hidden) {
        this.refreshButton.disabled = true;
        this.imageEl.hidden = true;
        this.statusEl.setText(t("auth.verifying"));
        const accepted = await this.acceptLogin(session.cookie, () => this.alive(generation));
        if (!this.alive(generation)) return;
        if (!accepted) throw new LoginDiagnosticError("verify", "credential", undefined, false);
        this.completed = true;
        this.close();
        return;
      }
    } catch (error) {
      if (!this.alive(generation)) return;
      const retryable = !(error instanceof LoginDiagnosticError) || error.retryable;
      if (retryable && (this.doc.hidden || suspension !== this.suspension)) {
        // App suspension is not a failed foreground attempt.
        this.schedule(generation);
      } else if (retryable && this.failures < 2 && (this.phase === "verify" || Date.now() < session.expiresAt)) {
        ++this.failures;
        this.statusEl.setText(`${t("auth.retrying")} ${loginErrorMessage(error, this.phase)}`);
        this.schedule(generation);
      } else {
        this.fail(error, generation, this.phase);
      }
    } finally {
      this.inFlight.delete(generation);
      if (this.alive(generation) && this.resumeRequested) {
        this.resumeRequested = false;
        if (!this.stopped && !this.doc.hidden) { this.clearTimer(); void this.poll(generation); }
      }
    }
  }

  private fail(error: unknown, generation: number, stage: LoginStage): void {
    if (!this.alive(generation)) return;
    this.stopped = true;
    this.imageEl.hidden = true;
    this.statusEl.setText(loginErrorMessage(error, stage));
    this.refreshButton.disabled = false;
    this.retryButton.hidden = !this.session || (error instanceof LoginDiagnosticError && !error.retryable && error.reason !== "storage");
  }

  onClose(): void {
    this.closed = true;
    ++this.generation;
    this.clearTimer();
    this.session = undefined;
    this.doc?.removeEventListener("visibilitychange", this.resume);
    this.win?.removeEventListener("focus", this.resume);
    this.win?.removeEventListener("pageshow", this.resume);
    this.imageEl?.removeAttribute("src");
    this.contentEl.empty();
    this.settle(this.completed);
  }
}
