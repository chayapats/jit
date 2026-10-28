import { join } from "node:path";
import { AppError } from "../errors";

/** Fixed port of the registry proxy inside the rootless network namespace; only Jit's own processes listen there. */
export const netnsProxyPort = 3128;

/** One running proxy child: its ready report, its exit, and a kill switch. */
export interface ProxyChild {
  readonly ready: Promise<{ port: number; netns: string }>;
  readonly exited: Promise<number>;
  kill(): void;
}

/** Starts one proxy child from a fixed argv (the default runs `podman unshare --rootless-netns <bun> <entry> …`). */
export type ProxySpawner = (argv: readonly string[]) => ProxyChild;

/** Options of {@link NetnsRegistryProxy}. */
export interface NetnsRegistryProxyOptions {
  /** `config.execution.registryHosts`. */
  hosts: readonly string[];
  port?: number;
  spawn?: ProxySpawner;
  /** Identity (`/proc/self/ns/net` inode) of the current rootless network namespace, or null when unknown. */
  currentNetns?: () => Promise<string | null>;
  /** Bun binary and proxy entry the child runs; default this process's Bun and `registry-proxy-main.ts`. */
  bun?: string;
  entry?: string;
  /** How long a child may take to report ready. */
  readyMs?: number;
}

/** The default child: stdout's first line is the ready report; stderr (refusal lines) goes to the service log. */
export function podmanProxySpawner(): ProxySpawner {
  return argv => {
    const child = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
    const ready = (async () => {
      const reader = child.stdout.getReader();
      let text = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) throw new AppError("box_proxy_unavailable", 503);
        text += new TextDecoder().decode(value);
        const line = text.split("\n")[0];
        if (text.includes("\n") && line) {
          reader.releaseLock();
          const report = JSON.parse(line) as { ready?: boolean; port?: number; netns?: string };
          if (report.ready !== true || typeof report.port !== "number" || typeof report.netns !== "string") throw new AppError("box_proxy_unavailable", 503);
          return { port: report.port, netns: report.netns };
        }
      }
    })();
    return { ready, exited: child.exited, kill: () => { try { child.stdin.end(); } catch { /* Already closed. */ } child.kill(); } };
  };
}

/** The current rootless network namespace's inode, through Podman (it creates the namespace when none exists). */
export async function podmanRootlessNetns(): Promise<string | null> {
  try {
    const child = Bun.spawn(["podman", "unshare", "--rootless-netns", "stat", "-L", "-c", "%i", "/proc/self/ns/net"], { stdout: "pipe", stderr: "ignore" });
    const [code, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return code === 0 && /^\d+$/.test(text.trim()) ? text.trim() : null;
  } catch { return null; }
}

/**
 * exec.registry_proxy/v1 on rootless Podman (#163). The internal network's gateway exists only inside Podman's
 * rootless network namespace, so the allowlist proxy (`startRegistryProxy`, unchanged) runs there as a child process
 * on a fixed port. {@link url} is known before any box exists, so a box can be created with it; {@link ensure} runs
 * after a `workspace` box is up (the gateway is then present) and restarts the child when it exited, or when the
 * namespace was recreated (Podman tears it down after the last box stops). The child exits with the service: it
 * stops when its stdin closes.
 */
export class NetnsRegistryProxy {
  readonly #hosts: readonly string[];
  readonly #port: number;
  readonly #spawn: ProxySpawner;
  readonly #currentNetns: () => Promise<string | null>;
  readonly #bun: string;
  readonly #entry: string;
  readonly #readyMs: number;
  #child: { process: ProxyChild; gateway: string; netns: string; alive: boolean } | null = null;
  #pending: Promise<void> | null = null;

  constructor(options: NetnsRegistryProxyOptions) {
    if (!options.hosts.length) throw new AppError("box_proxy_unavailable", 503);
    this.#hosts = options.hosts;
    this.#port = options.port ?? netnsProxyPort;
    this.#spawn = options.spawn ?? podmanProxySpawner();
    this.#currentNetns = options.currentNetns ?? podmanRootlessNetns;
    this.#bun = options.bun ?? process.execPath;
    this.#entry = options.entry ?? join(import.meta.dir, "registry-proxy-main.ts");
    this.#readyMs = options.readyMs ?? 15_000;
  }

  /** The proxy URL boxes on `gateway` use; stable across restarts of the child. */
  url(gateway: string): string {
    return `http://${gateway.includes(":") ? `[${gateway}]` : gateway}:${this.#port}`;
  }

  /** Makes sure a live child serves `gateway` in the current namespace; concurrent callers share one start. */
  ensure(gateway: string): Promise<void> {
    const run = async () => {
      const current = await this.#currentNetns();
      const child = this.#child;
      if (child?.alive && child.gateway === gateway && (current === null || child.netns === current)) return;
      child?.process.kill();
      this.#child = null;
      const proc = this.#spawn(["podman", "unshare", "--rootless-netns", this.#bun, this.#entry,
        "--hostname", gateway, "--port", String(this.#port), "--hosts", this.#hosts.join(",")]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const report = await Promise.race([
          proc.ready,
          proc.exited.then(() => { throw new AppError("box_proxy_unavailable", 503); }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new AppError("box_proxy_unavailable", 503)), this.#readyMs); }),
        ]);
        if (report.port !== this.#port) throw new AppError("box_proxy_unavailable", 503);
        const entry = { process: proc, gateway, netns: report.netns, alive: true };
        this.#child = entry;
        void proc.exited.then(() => { entry.alive = false; });
      } catch (error) {
        proc.kill();
        throw error instanceof AppError ? error : new AppError("box_proxy_unavailable", 503);
      } finally { clearTimeout(timer); }
    };
    const next = (this.#pending ?? Promise.resolve()).catch(() => undefined).then(run);
    this.#pending = next;
    return next;
  }

  /** Stops the child, if any. */
  async close(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    child.process.kill();
    await child.process.exited.catch(() => undefined);
  }
}
