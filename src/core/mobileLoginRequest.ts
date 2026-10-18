import type { HttpRequest, HttpResponse, Requester } from "./metadata";

interface NativeHttpOptions {
  url: string;
  method: string;
  headers: Record<string, string>;
  data: string;
  responseType: "text";
  connectTimeout: number;
  readTimeout: number;
  disableRedirects: boolean;
}

interface CapacitorBridge {
  getPlatform?: () => string;
  nativePromise?: (plugin: string, method: string, options: NativeHttpOptions) => Promise<unknown>;
}

const QR_URLS = new Set([
  "https://music.163.com/weapi/login/qrcode/unikey",
  "https://music.163.com/weapi/login/qrcode/client/login",
]);

/**
 * Obsidian Android 1.14.4 AppPlugin.requestUrlAndroid keeps only getHeaderFields()
 * list.get(0), losing repeated Set-Cookie values. The bundled CapacitorHttp bridge
 * joins all values instead. Use it only for these two QR endpoints on Android.
 * https://github.com/ionic-team/capacitor/blob/main/android/capacitor/src/main/java/com/getcapacitor/plugin/util/HttpRequestHandler.java
 * This bridge is host-dependent; older hosts can retain the normal requester.
 */
export function qrLoginRequester(fallback: Requester): Requester {
  const cap = typeof window === "undefined" ? undefined
    : (window as Window & { Capacitor?: CapacitorBridge }).Capacitor;
  if (cap?.getPlatform?.() !== "android" || typeof cap.nativePromise !== "function") return fallback;
  let available = true;
  return async (req: HttpRequest): Promise<HttpResponse> => {
    if (!available || !QR_URLS.has(req.url)) return fallback(req);
    let response: unknown;
    try {
      response = await cap.nativePromise!("CapacitorHttp", "request", {
        url: req.url,
        method: req.method,
        headers: { ...req.headers },
        data: req.body,
        responseType: "text",
        connectTimeout: 10000,
        readTimeout: 10000,
        disableRedirects: true,
      });
    } catch (error) {
      // Only an absent native implementation may use the old transport. Network
      // failures must follow the modal's bounded retry path, without double sends.
      if ((error as { code?: unknown } | null)?.code === "UNIMPLEMENTED") {
        available = false;
        return fallback(req);
      }
      throw error;
    }
    if (!response || typeof response !== "object") throw new Error("Invalid native HTTP response");
    const native = response as { status?: unknown; data?: unknown; headers?: unknown };
    if (typeof native.status !== "number" || !Number.isInteger(native.status)) throw new Error("Invalid native HTTP status");
    // Capacitor parses application/json into an object even for responseType=text.
    const text = typeof native.data === "string" ? native.data : JSON.stringify(native.data);
    if (typeof text !== "string") throw new Error("Invalid native HTTP body");
    const headers: NonNullable<HttpResponse["headers"]> = {};
    if (native.headers && typeof native.headers === "object") {
      for (const [name, value] of Object.entries(native.headers)) {
        if (typeof value === "string" || (Array.isArray(value) && value.every(item => typeof item === "string"))) headers[name] = value;
      }
    }
    return { status: native.status, text, headers };
  };
}
