import type { HttpRequest, HttpResponse, Requester } from "./metadata";
import { t } from "../i18n";

export type LoginStage = "create" | "check" | "verify" | "save";
type LoginFailure = "network" | "timeout" | "http" | "response" | "code" | "credential" | "risk" | "expired" | "storage";

/** Only fixed labels and bounded numeric status codes may enter login diagnostics. */
export class LoginDiagnosticError extends Error {
  readonly status?: number;
  constructor(readonly stage: LoginStage, readonly reason: LoginFailure, status?: unknown, readonly retryable = true) {
    const safeStatus = typeof status === "number" && Number.isInteger(status) && status >= 0 && status <= 999999 ? status : undefined;
    super(`${t(`authDiagnostics.${stage}`)} · ${t(`authDiagnostics.${reason}`)}${safeStatus === undefined ? "" : ` (${safeStatus})`}`);
    this.status = safeStatus;
  }
}

export function loginErrorMessage(error: unknown, stage: LoginStage): string {
  return error instanceof LoginDiagnosticError ? error.message : new LoginDiagnosticError(stage, "network").message;
}

/** Bound foreground waits; late native responses cannot mutate the login session. */
export async function requestLogin(request: Requester, req: HttpRequest, stage: LoginStage): Promise<HttpResponse> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      request(req),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new LoginDiagnosticError(stage, "timeout")), 15000); }),
    ]);
    if (response.status < 200 || response.status >= 300) throw new LoginDiagnosticError(stage, "http", response.status);
    return response;
  } catch (error) {
    if (error instanceof LoginDiagnosticError) throw error;
    throw new LoginDiagnosticError(stage, "network");
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

export function parseLoginResponse(response: HttpResponse, stage: LoginStage): Record<string, any> {
  try {
    const body = JSON.parse(response.text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new LoginDiagnosticError(stage, "response"); }
}

export function loginApiError(stage: LoginStage, code: unknown): LoginDiagnosticError {
  const risk = code === 8821 || code === 8810 || code === 460;
  return new LoginDiagnosticError(stage, risk ? "risk" : "code", code, !risk);
}
