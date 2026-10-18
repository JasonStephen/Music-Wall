import type { SongSource } from "./audioSource";

export interface AudioLease { url: string; release(): void; warm(seconds: number, signal: AbortSignal): Promise<void>; }
export interface AudioIdentity { account: string; song: number; durationMs: number; }
export class StreamUnavailableError extends Error {}
const BLOCK = 256 * 1024;
const FIRST = 64 * 1024;
const blockStart = (index: number) => index ? FIRST + (index - 1) * BLOCK : 0;
const blockIndex = (offset: number) => offset < FIRST ? 0 : 1 + Math.floor((offset - FIRST) / BLOCK);
const aborted = () => new DOMException("Cancelled", "AbortError");
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const cancel = () => { cleanup(); reject(aborted()); };
    const cleanup = () => signal.removeEventListener("abort", cancel);
    signal.addEventListener("abort", cancel, { once: true });
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
type Entry = { key: string; size: number; tag: string; mime: string; url: string; durationMs: number; touched: number; refs: number; epoch: number; hot: Map<number, Uint8Array>; };
type Job = { controller: AbortController; users: Set<symbol>; promise: Promise<Uint8Array>; };

/** Desktop-only, bounded byte cache and private Range server. No external executable. */
export class AudioTransport {
  private node: { http: typeof import("http"); https: typeof import("https"); fs: typeof import("fs/promises"); path: typeof import("path"); crypto: typeof import("crypto"); os: typeof import("os") } | null = null;
  private server: import("http").Server | null = null;
  private opening: Promise<void> | null = null;
  private address = "";
  private secret = "";
  private directory = "";
  private entries = new Map<string, Entry>();
  private routes = new Map<string, Entry>();
  private blocks = new Map<string, { size: number; used: number }>();
  private jobs = new Map<string, Job>();
  private requests = new Set<import("http").ClientRequest>();
  private responses = new Set<import("http").ServerResponse>();
  private clients = new Map<string, Set<import("http").ServerResponse>>();
  private foreground = 0;
  private controllers = new Set<AbortController>();
  private epoch = 0;
  private closed = false;
  private diskReady = false;
  private diskOpening: Promise<void> | null = null;
  private maintenance: Promise<void> = Promise.resolve();
  constructor(private scope: string, private limitMB: () => number, private origin: string, cacheRoot?: string) {
    try {
      this.node = { http: require("http"), https: require("https"), fs: require("fs/promises"), path: require("path"), crypto: require("crypto"), os: require("os") };
      const n = this.node, env = typeof process === "undefined" ? {} : process.env;
      const base = process.platform === "win32" ? env.LOCALAPPDATA || n.path.join(n.os.homedir(), "AppData", "Local") : process.platform === "darwin" ? n.path.join(n.os.homedir(), "Library", "Caches") : env.XDG_CACHE_HOME || n.path.join(n.os.homedir(), ".cache");
      this.directory = n.path.join(cacheRoot || n.path.join(base, "MusicWall", "audio-cache"), this.hash(scope).slice(0, 24));
      this.secret = n.crypto.randomBytes(24).toString("hex");
    } catch { this.node = null; }
  }
  get supported(): boolean { return !!this.node && !this.closed; }
  private hash(text: string): string { return this.node!.crypto.createHash("sha256").update(text).digest("hex"); }
  private get limit(): number { return Math.max(0, Number(this.limitMB()) || 0) * 1024 * 1024; }
  private file(name: string): string {
    if (!/^[a-f0-9]{64}\.\d+\.bin$/.test(name)) throw new Error("Invalid cache key");
    return this.node!.path.join(this.directory, name);
  }
  private async loadDisk(): Promise<void> {
    if (this.closed || !this.node) throw new StreamUnavailableError();
    if (this.diskOpening) return this.diskOpening;
    this.diskOpening = (async () => {
      const n = this.node!;
      try {
        await n.fs.mkdir(this.directory, { recursive: true });
        for (const file of await n.fs.readdir(this.directory)) if (/^[a-f0-9]{64}\.\d+\.bin$/.test(file)) {
          const stat = await n.fs.stat(this.file(file));
          if (stat.isFile() && stat.size > 0 && stat.size <= BLOCK) this.blocks.set(file, { size: stat.size, used: stat.mtimeMs });
        }
        this.diskReady = true;
      } catch { this.diskReady = false; }
    })();
    return this.diskOpening;
  }
  private async init(): Promise<void> {
    if (this.closed || !this.node) throw new StreamUnavailableError();
    if (this.opening) return this.opening;
    this.opening = (async () => {
      await this.loadDisk();
      const n = this.node!;
      if (this.closed) throw aborted();
      const server = n.http.createServer((req, res) => void this.serve(req, res));
      this.server = server;
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error) => { server.removeListener("listening", ready); reject(error); };
        const ready = () => { server.removeListener("error", failed); resolve(); };
        server.once("error", failed); server.once("listening", ready); server.listen(0, "127.0.0.1");
      });
      server.on("error", () => {});
      if (this.closed) { server.close(); throw aborted(); }
      const address = server.address();
      if (!address || typeof address === "string") throw new StreamUnavailableError();
      this.address = `http://127.0.0.1:${address.port}`;
      await this.trim();
    })();
    try { await this.opening; } catch (error) { this.opening = null; this.server?.close(); this.server = null; throw error; }
  }
  private getBytes(url: string, start: number, end: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; size: number; tag: string }> {
    return new Promise((resolve, reject) => {
      if (signal.aborted || this.closed) { reject(aborted()); return; }
      let request: import("http").ClientRequest;
      let finished = false;
      const finish = (error?: Error, result?: { bytes: Uint8Array; size: number; tag: string }) => {
        if (finished) return; finished = true; clearTimeout(timer); signal.removeEventListener("abort", cancel);
        if (request) this.requests.delete(request);
        error ? reject(error) : resolve(result!);
      };
      const cancel = () => { request?.destroy(); finish(aborted()); };
      const timer = setTimeout(() => { request?.destroy(); finish(new Error("Audio request timed out")); }, 20000);
      signal.addEventListener("abort", cancel, { once: true });
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:") throw new StreamUnavailableError();
        request = this.node!.https.get(parsed, { headers: { Referer: "https://music.163.com/", Range: `bytes=${start}-${end}`, "Accept-Encoding": "identity" } }, response => {
          const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers["content-range"] || ""));
          if (response.statusCode !== 206 || !match || Number(match[1]) !== start || Number(match[2]) > end || !Number.isSafeInteger(Number(match[3]))) {
            response.destroy(); finish(new StreamUnavailableError("Range unavailable")); return;
          }
          const expected = Number(match[2]) - start + 1, chunks: Uint8Array[] = []; let received = 0;
          response.on("data", (data: Buffer) => {
            received += data.length;
            if (received > expected || received > BLOCK) { response.destroy(); finish(new Error("Invalid audio range")); return; }
            chunks.push(data);
          });
          response.on("end", () => {
            if (received !== expected) { finish(new Error("Incomplete audio range")); return; }
            finish(undefined, { bytes: Buffer.concat(chunks), size: Number(match[3]), tag: String(response.headers.etag || response.headers["last-modified"] || "") });
          });
          response.on("error", error => finish(error));
          response.on("aborted", () => finish(new Error("Incomplete audio range")));
        });
        this.requests.add(request); request.on("error", error => finish(error));
      } catch (error) { finish(error as Error); }
    });
  }
  async open(source: SongSource, identity: AudioIdentity, signal: AbortSignal): Promise<AudioLease> {
    await this.init();
    if (signal.aborted) throw aborted();
    const probe = await this.getBytes(source.url, 0, 0, signal);
    if (!probe.size || probe.size > 2 ** 40) throw new StreamUnavailableError();
    const key = this.hash(JSON.stringify(["blocks-v1", FIRST, BLOCK, identity.account, identity.song, source.quality, source.mime, probe.size, probe.tag]));
    let entry = this.entries.get(key);
    if (!entry) { entry = { key, size: probe.size, tag: probe.tag, mime: source.mime || "audio/mpeg", url: source.url, durationMs: identity.durationMs, touched: Date.now(), refs: 0, epoch: this.epoch, hot: new Map() }; this.entries.set(key, entry); }
    entry.url = source.url; entry.touched = Date.now(); entry.refs++;
    const token = this.node!.crypto.randomBytes(18).toString("hex"); this.routes.set(token, entry);
    let released = false;
    return {
      url: `${this.address}/${this.secret}/${token}`,
      warm: async (seconds, warmSignal) => {
        const target = Math.min(entry!.size, Math.max(FIRST + BLOCK, entry!.size / Math.max(1, entry!.durationMs / 1000) * seconds));
        for (let i = 0; i < 32 && blockStart(i) < target; i++) {
          while (this.foreground > 0) { if (released || warmSignal.aborted) throw aborted(); await new Promise(resolve => setTimeout(resolve, 25)); }
          if (released || warmSignal.aborted) throw aborted();
          const data = await this.block(entry!, i, warmSignal, true);
          if (!released && !warmSignal.aborted) entry!.hot.set(i, data);
        }
      },
      release: () => { if (released) return; released = true; this.routes.delete(token); for (const client of this.clients.get(token) || []) client.destroy(); this.clients.delete(token); entry!.refs--; if (!entry!.refs) this.entries.delete(key); void this.trim(); },
    };
  }
  private async block(entry: Entry, index: number, signal: AbortSignal, background = false): Promise<Uint8Array> {
    const name = `${entry.key}.${index}.bin`, start = blockStart(index), expected = Math.min(index ? BLOCK : FIRST, entry.size - start);
    if (signal.aborted) throw aborted();
    const hot = entry.hot.get(index); if (hot) { if (!background) entry.hot.delete(index); return hot; }
    if (entry.epoch === this.epoch && this.blocks.has(name)) {
      try {
        const bytes = await this.node!.fs.readFile(this.file(name));
        if (bytes.length === expected) { const cached = this.blocks.get(name); if (cached) cached.used = Date.now(); void this.node!.fs.utimes(this.file(name), new Date(), new Date()).catch(() => {}); return bytes; }
      } catch {}
      try { await this.node!.fs.unlink(this.file(name)); this.blocks.delete(name); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") this.blocks.delete(name); }
    }
    let job = this.jobs.get(name);
    if (!job || job.controller.signal.aborted) {
      const controller = new AbortController();
      const created: Job = { controller, users: new Set(), promise: null! };
      created.promise = this.getBytes(entry.url, start, start + expected - 1, controller.signal).then(async result => {
        if (result.size !== entry.size || result.bytes.length !== expected || entry.tag && result.tag && entry.tag !== result.tag) throw new Error("Audio resource changed");
        if (this.diskReady && this.limit >= expected && entry.epoch === this.epoch && !this.closed) {
          try {
            await this.serial(async () => {
              await this.evict(expected, name);
              if (entry.epoch !== this.epoch || this.closed || this.bytes + expected > this.limit) return;
              await this.node!.fs.writeFile(this.file(name), result.bytes, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
              this.blocks.set(name, { size: expected, used: Date.now() });
            });
          } catch { /* Disk failure must not prevent playback. */ }
        }
        return result.bytes;
      }).finally(() => { if (this.jobs.get(name) === created) this.jobs.delete(name); });
      this.jobs.set(name, created); job = created;
    }
    const user = Symbol(); job.users.add(user);
    if (!background) this.foreground++;
    try { return await raceAbort(job.promise, signal); }
    finally { if (!background) this.foreground--; job.users.delete(user); if (!job.users.size) job.controller.abort(); }
  }
  private async serve(req: import("http").IncomingMessage, res: import("http").ServerResponse): Promise<void> {
    const parts = (req.url || "").split("/");
    const entry = parts.length === 3 && parts[1] === this.secret ? this.routes.get(parts[2]) : undefined;
    const host = req.headers.host;
    if (!entry || host !== this.address.slice(7) || req.headers.origin && req.headers.origin !== this.origin) { res.writeHead(403).end(); return; }
    const headers: Record<string, string | number> = { "Access-Control-Allow-Origin": this.origin, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "Range", "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length", "Access-Control-Allow-Private-Network": "true", "Content-Type": entry.mime, "Content-Disposition": "inline", "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
    if (req.method === "OPTIONS") { res.writeHead(204, headers).end(); return; }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    let start = 0, end = entry.size - 1;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || !match[1] && !match[2]) { res.writeHead(416, { "Content-Range": `bytes */${entry.size}` }).end(); return; }
      if (!match[1]) start = Math.max(0, entry.size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || start < 0 || start > end) { res.writeHead(416, { "Content-Range": `bytes */${entry.size}` }).end(); return; }
      headers["Content-Range"] = `bytes ${start}-${end}/${entry.size}`;
    }
    headers["Content-Length"] = end - start + 1;
    if (req.method === "HEAD") { res.writeHead(req.headers.range ? 206 : 200, headers).end(); return; }
    const controller = new AbortController(); this.controllers.add(controller); this.responses.add(res);
    let clients = this.clients.get(parts[2]); if (!clients) { clients = new Set(); this.clients.set(parts[2], clients); } clients.add(res);
    res.on("close", () => controller.abort());
    try {
      // Obtain the first block before sending headers so a failure is an HTTP error.
      let data = await this.block(entry, blockIndex(start), controller.signal);
      if (controller.signal.aborted) return;
      res.writeHead(req.headers.range ? 206 : 200, headers);
      for (let offset = start; offset <= end;) {
        if (controller.signal.aborted) throw aborted();
        const within = offset - blockStart(blockIndex(offset)), count = Math.min(data.length - within, end - offset + 1);
        if (!res.write(data.subarray(within, within + count))) await raceAbort(new Promise<void>(resolve => res.once("drain", resolve)), controller.signal);
        offset += count;
        if (offset <= end) data = await this.block(entry, blockIndex(offset), controller.signal);
      }
      res.end();
    } catch { if (!res.headersSent) res.writeHead(502, headers); res.destroy(); }
    finally { controller.abort(); this.controllers.delete(controller); this.responses.delete(res); clients.delete(res); if (!clients.size) this.clients.delete(parts[2]); }
  }
  private get bytes(): number { let size = 0; for (const value of this.blocks.values()) size += value.size; return size; }
  private serial(work: () => Promise<void>): Promise<void> { const next = this.maintenance.then(work, work); this.maintenance = next.catch(() => {}); return next; }
  private async evict(extra = 0, except = ""): Promise<void> {
    if (this.bytes + extra <= this.limit) return;
    for (const [name] of [...this.blocks].sort((a, b) => a[1].used - b[1].used)) {
      if (this.bytes + extra <= this.limit) break;
      if (name === except) continue;
      try { await this.node!.fs.unlink(this.file(name)); this.blocks.delete(name); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") this.blocks.delete(name); }
    }
  }
  async trim(): Promise<void> { if (this.supported) { await this.loadDisk(); await this.serial(() => this.evict()); } }
  async usage(): Promise<number> { if (!this.supported) return 0; await this.loadDisk(); await this.maintenance; return this.bytes; }
  async clear(): Promise<void> {
    if (!this.supported) return; await this.loadDisk(); ++this.epoch;
    await this.serial(async () => { for (const name of [...this.blocks.keys()]) { try { await this.node!.fs.unlink(this.file(name)); this.blocks.delete(name); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") this.blocks.delete(name); } } });
  }
  close(): void {
    this.closed = true; ++this.epoch; this.routes.clear();
    for (const controller of this.controllers) controller.abort();
    for (const job of this.jobs.values()) job.controller.abort();
    for (const request of this.requests) request.destroy();
    for (const response of this.responses) response.destroy();
    this.server?.close(); this.server = null;
  }
}
