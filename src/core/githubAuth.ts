import { t } from "../i18n";

export type CredentialManager = "credential-manager" | "credential-manager-core";
export type GitAuthProvider = (repoUrl: string) => Promise<string[]>;
export interface GitHubAccounts { available: boolean; accounts: string[]; }
export interface GitHubAccountController {
  selected(): string;
  inspect(signal: AbortSignal): Promise<GitHubAccounts>;
  login(signal: AbortSignal): Promise<GitHubAccounts>;
  select(account: string): Promise<void>;
}
type CredentialCommand = (args: string[], signal?: AbortSignal) => Promise<string>;
const HOST = "https://github.com";
const accountName = (value: string) => /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value);

/** GCM owns OAuth and OS credential storage. Neither tokens nor passwords enter the plugin. */
const command: CredentialCommand = (args, signal) => new Promise((resolve, reject) => {
  const cp = require("child_process") as typeof import("child_process");
  const child = cp.execFile("git", args, {
    windowsHide: true, timeout: args.includes("login") ? 300_000 : 15_000,
    maxBuffer: 1024 * 1024, encoding: "utf8", signal,
    env: { ...process.env, GCM_INTERACTIVE: "Always", GIT_TERMINAL_PROMPT: "0" },
  }, (error, stdout) => {
    // Never expose OAuth output, callback URLs or credential diagnostics in notices/logs.
    if (error) reject(new Error(t(signal?.aborted ? "githubAuth.cancelled" : "githubAuth.failed")));
    else resolve(stdout);
  });
  child.stdin?.on("error", () => {}); child.stdin?.end();
});

export class GitHubAuth {
  private manager: CredentialManager | null = null;
  constructor(private run: CredentialCommand = command) {}

  private async detect(signal?: AbortSignal): Promise<CredentialManager | null> {
    if (signal?.aborted) throw new Error(t("githubAuth.cancelled"));
    if (this.manager) return this.manager;
    for (const manager of ["credential-manager", "credential-manager-core"] as const) {
      try { await this.run([manager, "--version"], signal); this.manager = manager; return manager; }
      catch { if (signal?.aborted) throw new Error(t("githubAuth.cancelled")); }
    }
    return null;
  }

  async inspect(signal?: AbortSignal): Promise<GitHubAccounts> {
    const manager = await this.detect(signal);
    if (!manager) return { available: false, accounts: [] };
    const output = await this.run([manager, "github", "list", "--url", HOST, "--no-ui"], signal);
    return { available: true, accounts: [...new Set(output.split(/\r?\n/).map(line => line.trim()).filter(accountName))] };
  }

  async login(signal?: AbortSignal): Promise<GitHubAccounts> {
    const manager = await this.detect(signal);
    if (!manager) throw new Error(t("githubAuth.missing"));
    await this.run([manager, "github", "login", "--url", HOST, "--browser", "--no-ui", "--force"], signal);
    return this.inspect(signal);
  }

  /** Per-command configuration; leaves global Git config and other hosts untouched. */
  async gitArguments(repoUrl: string, account: string): Promise<string[]> {
    if (!account) return [];
    let url: URL;
    try { url = new URL(repoUrl); } catch { return []; }
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.port || url.username || url.password) return [];
    if (!accountName(account)) throw new Error(t("githubAuth.choose"));
    const state = await this.inspect();
    if (!state.available) throw new Error(t("githubAuth.missing"));
    if (!state.accounts.includes(account)) throw new Error(t("githubAuth.expired"));
    return ["-c", "credential.helper=", "-c", `credential.helper=${this.manager === "credential-manager-core" ? "manager-core" : "manager"}`,
      "-c", "credential.https://github.com.username=" + account, "-c", "credential.https://github.com.useHttpPath=false"];
  }
}
