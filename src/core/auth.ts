// 扫码流程参考 NeteaseCloudMusicApiEnhanced 的 login_qr_key / login_qr_check。
// 使用现有 weapi 加密直接请求网易云，不依赖第三方 API 服务器或 Node 子进程。
// https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced/tree/main/module
import qrcode from "qrcode-generator";
import { encryptWeApi } from "./crypto";
import type { HttpResponse, Requester } from "./metadata";
import { hasLoginCookie } from "./playlist";
import { t } from "../i18n";

export interface QrLoginSession {
  key: string;
  cookie: string;
  image: string;
  expiresAt: number;
}

export type QrLoginStatus = 800 | 801 | 802 | 803;

/** 解析多个 Set-Cookie，避免 Expires 中的逗号被误当作 cookie 分隔符。 */
export function mergeSetCookies(cookie: string, headers: HttpResponse["headers"]): string {
  const jar = new Map<string, string>();
  for (const pair of cookie.split(/;\s*/)) {
    const equal = pair.indexOf("=");
    if (equal > 0) jar.set(pair.slice(0, equal), pair.slice(equal + 1));
  }
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (name.toLowerCase() !== "set-cookie") continue;
    for (const line of Array.isArray(value) ? value : [value]) {
      for (const entry of line.split(/,(?=\s*[^;,\s=]+=)/)) {
        const pair = entry.trim().split(";", 1)[0];
        const equal = pair.indexOf("=");
        if (equal <= 0) continue;
        const key = pair.slice(0, equal).trim();
        const val = pair.slice(equal + 1);
        if (!/^[\w!#$%&'*+.^`|~-]+$/.test(key)) continue;
        if (!val || /;\s*max-age=0(?:;|$)/i.test(entry)) jar.delete(key);
        else jar.set(key, val);
      }
    }
  }
  return Array.from(jar, ([key, value]) => `${key}=${value}`).join("; ");
}

async function loginPost(request: Requester, path: string, data: Record<string, unknown>, cookie: string) {
  const csrf = /(?:^|;\s*)__csrf=([^;]*)/.exec(cookie)?.[1] ?? "";
  const encrypted = encryptWeApi(JSON.stringify({ csrf_token: csrf, ...data }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      request({
        url: `https://music.163.com/weapi/login/qrcode/${path}`,
        method: "POST",
        headers: {
          Referer: "https://music.163.com/",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Cookie: cookie,
        },
        body: new URLSearchParams(encrypted).toString(),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(t("auth.networkError"))), 15000);
      }),
    ]);
    if (response.status >= 400) throw new Error(t("auth.networkError"));
    return { body: JSON.parse(response.text), cookie: mergeSetCookies(cookie, response.headers) };
  } catch {
    // 不将可能含认证信息的底层网络错误展示或写入日志。
    throw new Error(t("auth.networkError"));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function createQrLogin(request: Requester): Promise<QrLoginSession> {
  const result = await loginPost(request, "unikey", { type: 3 }, "os=pc; appver=3.0.18");
  const key = result.body?.unikey ?? result.body?.data?.unikey;
  if (result.body?.code !== 200 || typeof key !== "string" || !/^[\w-]{1,256}$/.test(key)) {
    throw new Error(t("auth.createFailed"));
  }
  const qr = qrcode(0, "M");
  qr.addData(`https://music.163.com/login?codekey=${encodeURIComponent(key)}`);
  qr.make();
  return { key, cookie: result.cookie, image: qr.createDataURL(6), expiresAt: Date.now() + 5 * 60_000 };
}

export async function checkQrLogin(request: Requester, session: QrLoginSession): Promise<QrLoginStatus> {
  if (Date.now() >= session.expiresAt) return 800;
  const result = await loginPost(request, "client/login", { key: session.key, type: 3 }, session.cookie);
  session.cookie = result.cookie;
  const code = result.body?.code;
  if (![800, 801, 802, 803].includes(code)) throw new Error(t("auth.checkFailed"));
  if (code === 803 && !hasLoginCookie(session.cookie)) throw new Error(t("auth.missingCredential"));
  return code as QrLoginStatus;
}
