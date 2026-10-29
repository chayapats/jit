import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, readdirSync, statSync, chmodSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ManagedSearxng, PodmanSearxngRuntime, searxngImage, searxngMemoryMb, searxngSecret, searxngSettings, type SearxngRuntime, type SearxngStatus } from "../src/web-tools/searxng";
import { readConfig } from "../src/config";

const roots: string[] = [];
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
const secret = "a".repeat(64), signal = () => new AbortController().signal;
function fake() {
  let available: SearxngStatus = { state: "ready", reason: null }, running = false, starts = 0, stops = 0, searches = 0, failStart = false;
  const pending = new Map<number, () => void>(); let next = 0;
  const runtime: SearxngRuntime = {
    async status() { return available; }, async running() { return running; },
    async start(config, cap) { starts++; expect(JSON.parse(config).server.secret_key).toBe(secret); expect(cap).toBe(512); if (failStart) throw Error("fixture"); running = true; },
    async stop() { stops++; running = false; },
    async search(query) { searches++; return [{ title: query, url: "https://example.test", snippet: "fixture" }]; },
  };
  const provider = new ManagedSearxng(runtime, { secret: () => secret, memoryMb: 512, timers: { set(fn) { pending.set(++next, fn); return next; }, clear(id) { pending.delete(id as number); } } });
  return { provider, runtime, stats: () => ({ starts, stops, searches }), crash: () => { running = false; }, unavailable: () => { available = { state: "unavailable", reason: "podman" }; }, fail: () => { failStart = true; }, idle: async () => { const fn = [...pending.values()][0]; pending.clear(); fn?.(); await Promise.resolve(); await Promise.resolve(); } };
}
test("WEB02 lazily starts once, reuses, stops idle, and restarts on next search", async () => {
  const f = fake(); expect(await f.provider.status()).toEqual({ state: "ready", reason: null }); expect(f.stats().starts).toBe(0);
  await f.provider.search("fixture", { limit: 1, signal: signal() }); await f.provider.search("second", { limit: 1, signal: signal() });
  expect(f.stats()).toEqual({ starts: 1, stops: 0, searches: 2 }); await f.idle(); expect(f.stats().stops).toBe(1);
  await f.provider.search("third", { limit: 1, signal: signal() }); expect(f.stats().starts).toBe(2); await f.provider.close();
});
test("WEB02 detects a crashed container on the next search", async () => {
  const f = fake(); await f.provider.search("one", { limit: 1, signal: signal() }); f.crash();
  await f.provider.search("two", { limit: 1, signal: signal() }); expect(f.stats().starts).toBe(2); await f.provider.close();
});
test("WEB02 bounds failed startup to two attempts and never submits the query", async () => {
  const f = fake(); f.fail(); await expect(f.provider.search("held", { limit: 1, signal: signal() })).rejects.toMatchObject({ code: "searxng_unavailable" });
  expect(f.stats()).toEqual({ starts: 2, stops: 2, searches: 0 });
});
test("WEB02 missing Podman and opt-out are unavailable without any container or query", async () => {
  const f = fake(); f.unavailable(); expect(await f.provider.status()).toEqual({ state: "unavailable", reason: "podman" });
  await expect(f.provider.search("held", { limit: 1, signal: signal() })).rejects.toMatchObject({ code: "searxng_unavailable" }); expect(f.stats().starts).toBe(0);
  const disabled = new ManagedSearxng(f.runtime, { enabled: false, secret: () => secret }); expect(await disabled.status()).toEqual({ state: "unavailable", reason: "disabled" });
});
test("WEB02 cancellation and close refuse searches before startup", async () => {
  const f = fake(), controller = new AbortController(); controller.abort();
  await expect(f.provider.search("held", { limit: 1, signal: controller.signal })).rejects.toMatchObject({ code: "searxng_unavailable" });
  await f.provider.close(); await expect(f.provider.search("held", { limit: 1, signal: signal() })).rejects.toMatchObject({ code: "searxng_unavailable" }); expect(f.stats().starts).toBe(0);
});
test("WEB02 serializes searches and never stops an in-flight query", async () => {
  const f = fake(); let release!: () => void;
  f.runtime.search = async () => { await new Promise<void>(resolve => { release = resolve; }); return []; };
  const first = f.provider.search("one", { limit: 1, signal: signal() });
  for (let n = 0; n < 15 && !release; n++) await Promise.resolve();
  const closing = f.provider.close(); expect(f.stats().stops).toBe(0); release(); await first; await closing; expect(f.stats().stops).toBe(1);
});
test("WEB02 host-scaled memory and generated config are bounded and disable query recording", () => {
  expect([2, 4, 8, 64].map(gb => searxngMemoryMb(gb * 1024 ** 3))).toEqual([256, 512, 1024, 1024]);
  const config = JSON.parse(searxngSettings(secret)); expect(config.search.formats).toEqual(["json"]); expect(config.general.enable_metrics).toBe(false); expect(config.server.limiter).toBe(false);
  expect(config.use_default_settings.engines.keep_only).toEqual(["duckduckgo", "brave"]);
});
test("WEB02 install secret persists privately and refuses a wider mode or symlinked directory", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-searxng-"))); roots.push(root);
  const directory = join(root, "secret"), one = searxngSecret(directory); expect(one).toMatch(/^[a-f0-9]{64}$/); expect(searxngSecret(directory)).toBe(one);
  expect(statSync(directory).mode & 0o777).toBe(0o700); const file = join(directory, readdirSync(directory)[0]!); expect(statSync(file).mode & 0o777).toBe(0o600);
  chmodSync(file, 0o644); expect(() => searxngSecret(directory)).toThrow(); symlinkSync(directory, join(root, "alias")); expect(() => searxngSecret(join(root, "alias"))).toThrow();
});
test("WEB02 Podman argv hardens container, mounts no host path, publishes no port, and keeps query/secret off argv", async () => {
  const calls: { argv: readonly string[]; stdin: string }[] = [];
  const runtime = new PodmanSearxngRuntime("fixture", async (argv, req) => {
    calls.push({ argv, stdin: req.stdin ? new TextDecoder().decode(req.stdin) : "" });
    const value = argv[0] === "container" ? [{ ImageName: searxngImage, HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], NetworkMode: "slirp4netns" }, Mounts: [] }]
      : argv[0] === "info" ? { host: { security: { rootless: true }, cgroupVersion: "v2", cgroupControllers: ["memory", "cpu", "pids"] } }
      : null;
    return { exitCode: 0, stdout: Buffer.from(value ? JSON.stringify(value) : ""), stderr: new Uint8Array() };
  }, async () => {});
  // The fixed health probe succeeds in the fixture; no real Podman is called.
  await runtime.start(searxngSettings(secret), 512, signal());
  const create = calls.find(c => c.argv[0] === "create")!.argv.join(" ");
  for (const flag of ["--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--memory=512m", "--user=977:977", "--log-driver=none", "--image-volume=ignore"]) expect(create).toContain(flag);
  // Only tmpfs mounts (Podman 4.9 needs --mount type=tmpfs with U=true instead of tmpfs uid=/gid=); never a host path.
  const mounts = calls.find(c => c.argv[0] === "create")!.argv.flatMap((v, i, all) => v === "--mount" ? [all[i + 1]!] : []);
  expect(mounts.length).toBe(2); for (const m of mounts) { expect(m.startsWith("type=tmpfs,")).toBe(true); expect(m).not.toMatch(/source=|bind|volume/); }
  expect(create).not.toMatch(/uid=977,gid=977,|nr_inodes=/);
  expect(create).not.toContain("--publish"); expect(create).not.toContain("--privileged"); expect(create).not.toContain(secret);
  expect(calls.find(c => c.stdin.includes(secret))?.argv.slice(0, 2)).toEqual(["exec", "-i"]);
});
test("WEB02 unavailable runtime diagnostics are sanitized", async () => {
  const runtime = new PodmanSearxngRuntime("fixture", async () => { throw Error("credential-like diagnostic"); });
  expect(await runtime.status()).toEqual({ state: "unavailable", reason: "podman" });
  expect(readConfig({ JIT_SEARXNG_ENABLED: "0" }).searxngEnabled).toBe(false); expect(() => readConfig({ JIT_SEARXNG_ENABLED: "yes" })).toThrow();
});
test.skipIf(process.env.JIT_LIVE_SEARXNG !== "1")("WEB02 opt-in live search (service identity on a prepared Linux host)", async () => {
  const provider = new ManagedSearxng(new PodmanSearxngRuntime("opt-in-live-evidence"), { secret: () => randomSecret() });
  try { expect((await provider.search("SearXNG documentation", { limit: 1, signal: signal() })).length).toBeGreaterThan(0); } finally { await provider.close(); }
}, 60_000);
function randomSecret() { return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", ""); }

for (const phase of ["startup", "query"] as const) {
  test(`WEB02 queued cancellation settles while ${phase} is blocked and preserves the lock`, async () => {
    const f = fake(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
    const original = f.runtime.start;
    const queries: string[] = [];
    if (phase === "startup") f.runtime.start = async (...args) => { entered.resolve(); await gate.promise; await original(...args); };
    f.runtime.search = async query => {
      queries.push(query);
      if (phase === "query" && query === "first") { entered.resolve(); await gate.promise; }
      return [];
    };
    const first = f.provider.search("first", { limit: 1, signal: signal() });
    await entered.promise;
    const controller = new AbortController();
    const cancelled = f.provider.search("cancelled", { limit: 1, signal: controller.signal });
    const rejected = cancelled.then(() => { throw Error("cancelled search resolved"); }, error => error);
    const last = f.provider.search("last", { limit: 1, signal: signal() });
    try {
      controller.abort();
      // This must settle before releasing the preceding runtime operation.
      expect(await rejected).toMatchObject({ code: "searxng_unavailable" });
      expect(queries).toEqual(phase === "query" ? ["first"] : []);
    } finally { gate.resolve(); await first; await last; await f.provider.close(); }
    expect(queries).toEqual(["first", "last"]);
    expect(f.stats().starts).toBe(1);
  });
}

test("Podman 4.9 inspect (per-capability CapDrop, null cap arrays) is proven by the container's own capability sets", async () => {
  const runtime = (capBnd: string) => new PodmanSearxngRuntime("fixture", async argv => {
    const value = argv[0] === "container"
      ? [{ ImageName: searxngImage, BoundingCaps: null, EffectiveCaps: null, Mounts: [],
        HostConfig: { Privileged: false, ReadonlyRootfs: true, CapAdd: [], CapDrop: ["CAP_CHOWN", "CAP_KILL", "CAP_SETUID"], SecurityOpt: ["no-new-privileges"], NetworkMode: "slirp4netns" } }]
      : null;
    const stdout = argv.includes("/proc/1/status")
      ? `CapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t${capBnd}\nCapAmb:\t0000000000000000\n`
      : value ? JSON.stringify(value) : "";
    return { exitCode: 0, stdout: Buffer.from(stdout), stderr: new Uint8Array() };
  }, async () => {});
  expect(await runtime("0000000000000000").running()).toBe(true);
  // The default bounding set (no --cap-drop=ALL) must not pass.
  expect(await runtime("00000000800405fb").running()).toBe(false);
});
