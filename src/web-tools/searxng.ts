import { randomBytes, createHash } from "node:crypto";
import { totalmem } from "node:os";
import type { SearchProvider, SearchResult } from "schway/host";
import { AppError } from "../errors";
import { ConnectionVault } from "../exec/connections";
import { podmanCommandRunner, type CommandRunner } from "../exec/podman-runtime";
import { podmanReadiness } from "../exec/podman-client";

/** Official multi-architecture index, release 2026.10.28-c360868e5 (amd64/arm64/arm). */
export const searxngImage = "docker.io/searxng/searxng@sha256:268a4b460136dcefc8f2e896b6098ba3f770c8218dbbddcb86811b06b06816f1";
/** Sanitized operator status; diagnostics and provider response bodies never cross this boundary. */
export type SearxngStatus = { state: "ready"; reason: null } | { state: "unavailable"; reason: "disabled" | "podman" | "socket" | "rootless" | "runtime" };
/** Fakeable service-owned runtime; it has no workspace, state or credential mounts. */
export interface SearxngRuntime {
  status(): Promise<SearxngStatus>;
  running(): Promise<boolean>;
  start(settings: string, memoryMb: number, signal: AbortSignal): Promise<void>;
  search(query: string, limit: number, signal: AbortSignal): Promise<readonly SearchResult[]>;
  stop(): Promise<void>;
}
/** Host-scaled cap: one eighth of RAM, bounded to 256–1024 MiB on every supported Linux host. */
export function searxngMemoryMb(bytes = totalmem()): number { return Math.max(256, Math.min(1024, Math.floor(bytes / 1024 / 1024 / 8))); }
/** Only allowlisted general-purpose, keyless engines; no autocomplete, query metrics, access logs or public limiter. */
export function searxngSettings(secret: string): string {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new AppError("searxng_unavailable", 503);
  return JSON.stringify({ use_default_settings: { engines: { keep_only: ["duckduckgo", "brave"] } },
    general: { debug: false, enable_metrics: false }, search: { formats: ["json"], safe_search: 2, autocomplete: "" },
    server: { secret_key: secret, limiter: false, public_instance: false, image_proxy: false },
    outgoing: { request_timeout: 5, max_request_timeout: 8 }, engines: [{ name: "duckduckgo", disabled: false }, { name: "brave", disabled: false }] });
}
/** Creates one install-specific 0600 secret under a service-only 0700 directory; never mounts or exports it. */
export function searxngSecret(directory: string): string {
  const vault = new ConnectionVault(directory, { forbidden: [] }), id = "00000000-0000-4000-8000-000000000178";
  if (vault.inspect(id) === "missing") vault.write(id, randomBytes(32).toString("hex"));
  const secret = vault.read(id);
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new AppError("searxng_unavailable", 503);
  return secret;
}

const python = "/usr/local/searxng/.venv/bin/python";
// Fixed code only. Query and settings travel on stdin, never argv, environment or a host mount.
const installSettings = "import sys,os; os.umask(0o077); open('/etc/searxng/settings.yml','w').write(sys.stdin.read())";
const relay = `import sys,json,urllib.request,urllib.parse
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
data=json.load(sys.stdin)
body=urllib.parse.urlencode({'q':data['query'],'format':'json','safesearch':'2','engines':'duckduckgo,brave'}).encode()
with opener.open(urllib.request.Request('http://127.0.0.1:8080/search',data=body),timeout=10) as r:
 b=r.read(262145)
 if len(b)>262144: raise ValueError('response_limit')
 value=json.loads(b)
 rows=value.get('results',[])
 if not rows: raise ValueError('no_results')
 print(json.dumps([{'title':x['title'],'url':x['url'],'snippet':x.get('content','')} for x in rows[:data['limit']]]))`;
const health = "import urllib.request; o=urllib.request.build_opener(urllib.request.ProxyHandler({})); r=o.open('http://127.0.0.1:8080/healthz',timeout=1); assert r.status==200";

/** Rootless Podman adapter with container-local loopback only; the service identity's exec channel is the sole ingress. */
export class PodmanSearxngRuntime implements SearxngRuntime {
  readonly #name: string;
  constructor(installation: string, readonly run: CommandRunner = podmanCommandRunner(), readonly pause: (ms: number) => Promise<unknown> = Bun.sleep) {
    this.#name = `jit-searxng-${createHash("sha256").update(installation).digest("hex").slice(0, 16)}`;
  }
  async status(): Promise<SearxngStatus> {
    return podmanReadiness(this.run);
  }
  async running(): Promise<boolean> {
    const inspect = await this.run(["container", "inspect", this.#name], { timeoutMs: 2000 });
    if (inspect.exitCode !== 0) return false;
    const [info] = JSON.parse(new TextDecoder().decode(inspect.stdout));
    if (info?.ImageName !== searxngImage || info?.HostConfig?.Privileged !== false || info?.HostConfig?.ReadonlyRootfs !== true ||
        info?.HostConfig?.SecurityOpt?.includes("no-new-privileges") !== true || (info?.HostConfig?.CapAdd ?? []).length ||
        !((info?.HostConfig?.CapDrop ?? []).some((v: string) => v.toUpperCase() === "ALL") || (Array.isArray(info?.BoundingCaps) && info.BoundingCaps.length === 0 && Array.isArray(info?.EffectiveCaps) && info.EffectiveCaps.length === 0)) ||
        Object.keys(info?.HostConfig?.PortBindings ?? {}).length || ["host", "container"].some(v => info?.HostConfig?.NetworkMode?.startsWith(v)) ||
        (info?.Mounts ?? []).some((m: { Type: string }) => m.Type !== "tmpfs")) return false;
    const result = await this.run(["exec", this.#name, python, "-c", health], { timeoutMs: 2000 });
    return result.exitCode === 0;
  }
  async start(settings: string, memoryMb: number, signal: AbortSignal): Promise<void> {
    await this.stop();
    const present = await this.run(["image", "exists", searxngImage], { timeoutMs: 5000, signal });
    if (present.exitCode !== 0) await this.#command(["pull", "--quiet", searxngImage], signal, undefined, 120_000);
    await this.#command(["create", "--name", this.#name, "--pull=never", "--image-volume=ignore", "--label", "jit.searxng=1",
      "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only", "--http-proxy=false", "--userns=keep-id:uid=977,gid=977", "--user=977:977",
      "--pids-limit=128", `--memory=${memoryMb}m`, "--cpus=1", "--log-driver=none", "--stop-timeout=2",
      ...["/tmp:rw,nosuid,nodev,size=64m,mode=1777", "/run:rw,nosuid,nodev,size=16m,mode=1777", "/etc/searxng:rw,nosuid,nodev,noexec,size=1m,mode=0700,uid=977,gid=977", "/var/cache/searxng:rw,nosuid,nodev,noexec,size=32m,mode=0700,uid=977,gid=977"].flatMap(v => ["--tmpfs", v]),
      "--env", "PYTHONDONTWRITEBYTECODE=1", "--env", "SEARXNG_SETTINGS_PATH=/etc/searxng/settings.yml",
      "--env", "GRANIAN_HOST=127.0.0.1", "--env", "GRANIAN_LOG_LEVEL=critical", "--env", "GRANIAN_ACCESS_LOG=false",
      "--entrypoint", "/bin/sleep", searxngImage, "infinity"], signal);
    // Recreated each service process / crash: no unverified stale container is reused.
    await this.#command(["start", this.#name], signal);
    await this.#command(["exec", "-i", this.#name, python, "-c", installSettings], signal, settings);
    await this.#command(["exec", "-d", this.#name, "/usr/local/searxng/.venv/bin/granian", "--host", "127.0.0.1", "--port", "8080", "--interface", "wsgi", "--workers", "1", "--log-level", "critical", "--no-access-log", "searx.webapp:app"], signal);
    for (let attempt = 0; attempt < 12; attempt++) {
      signal.throwIfAborted();
      if (await this.running()) return;
      await this.pause(250);
    }
    throw new AppError("searxng_unavailable", 503);
  }
  async search(query: string, limit: number, signal: AbortSignal): Promise<readonly SearchResult[]> {
    const bytes = await this.#command(["exec", "-i", this.#name, python, "-c", relay], signal, JSON.stringify({ query, limit }), 12_000);
    const rows: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(rows) || rows.length > limit || rows.some(row => !row || typeof row.title !== "string" || typeof row.url !== "string" || typeof row.snippet !== "string")) throw new AppError("searxng_unavailable", 503);
    return rows;
  }
  async stop(): Promise<void> {
    const result = await this.run(["rm", "--force", "--ignore", "--time", "2", this.#name], { timeoutMs: 5000 });
    if (result.exitCode !== 0) throw new AppError("searxng_unavailable", 503);
  }
  async #command(argv: string[], signal: AbortSignal, stdin?: string, timeoutMs = 10_000): Promise<Uint8Array> {
    signal.throwIfAborted();
    const result = await this.run(argv, { signal, timeoutMs, ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }) });
    if (result.exitCode !== 0 || result.stdout.byteLength > 262144) throw new AppError("searxng_unavailable", 503);
    signal.throwIfAborted();
    return result.stdout;
  }
}

/** Deterministic clock seam: idle stop is serialized with searches and never interrupts an in-flight request. */
export interface SearxngTimers { set(fn: () => void, ms: number): unknown; clear(id: unknown): void }
const timers: SearxngTimers = { set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return timer; }, clear: id => clearTimeout(id as ReturnType<typeof setTimeout>) };
/** Lazy, bounded managed provider: two startup attempts, no retry of an outbound query, idle teardown and next-search crash recovery. */
export class ManagedSearxng implements SearchProvider {
  readonly id = "searxng";
  #started = false;
  #closed = false;
  #failed = false;
  #tail: Promise<unknown> = Promise.resolve();
  #idle: unknown;
  constructor(readonly runtime: SearxngRuntime, readonly options: { enabled?: boolean; secret: () => string; memoryMb?: number; idleMs?: number; timers?: SearxngTimers }) {}
  /** Checks readiness without starting a container, pulling an image or issuing an engine query. */
  async status(): Promise<SearxngStatus> {
    if (this.options.enabled === false) return { state: "unavailable", reason: "disabled" };
    const status = await this.runtime.status();
    return status.state === "ready" && this.#failed ? { state: "unavailable", reason: "runtime" } : status;
  }
  #lock<T>(fn: () => Promise<T>): Promise<T> { const next = this.#tail.then(fn); this.#tail = next.catch(() => {}); return next; }
  async search(query: string, options: { limit: number; signal: AbortSignal }): Promise<readonly SearchResult[]> {
    if (!query.trim() || Buffer.byteLength(query) > 8192 || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 20) throw new AppError("invalid_web_search");
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(45_000)]), clock = this.options.timers ?? timers;
    const pending = this.#lock(async () => {
      if (signal.aborted) throw new AppError("searxng_unavailable", 503);
      clock.clear(this.#idle);
      try {
        signal.throwIfAborted();
        if (this.#closed || this.options.enabled === false || (await this.runtime.status()).state !== "ready") throw new AppError("searxng_unavailable", 503);
        if (!this.#started || !await this.runtime.running().catch(() => false)) {
          this.#started = false;
          for (let attempt = 0; attempt < 2; attempt++) {
            try { await this.runtime.start(searxngSettings(this.options.secret()), this.options.memoryMb ?? searxngMemoryMb(), signal); this.#started = true; break; }
            catch { await this.runtime.stop().catch(() => {}); signal.throwIfAborted(); }
          }
          if (!this.#started) throw new AppError("searxng_unavailable", 503);
        }
        signal.throwIfAborted();
        const result = await this.runtime.search(query, options.limit, signal);
        this.#failed = false;
        return result;
      } catch { this.#failed = true; throw new AppError("searxng_unavailable", 503); }
      finally { if (this.#started && !this.#closed) this.#idle = clock.set(() => { void this.#lock(async () => { await this.runtime.stop(); this.#started = false; }).catch(() => {}); }, this.options.idleMs ?? 300_000); }
    });
    // Settle the caller promptly, but retain serialization until the queued work
    // finishes or skips its aborted slot. Aborting must never release an active lock.
    return new Promise((resolve, reject) => {
      const abort = () => reject(new AppError("searxng_unavailable", 503));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); }
      pending.then(
        result => { signal.removeEventListener("abort", abort); resolve(result); },
        error => { signal.removeEventListener("abort", abort); reject(error); },
      );
    });
  }
  /** Stops this process's container and refuses subsequent searches; no image, file or host state is deleted. */
  async close(): Promise<void> {
    this.#closed = true; (this.options.timers ?? timers).clear(this.#idle);
    await this.#lock(async () => { if (this.#started) await this.runtime.stop(); this.#started = false; });
  }
}
