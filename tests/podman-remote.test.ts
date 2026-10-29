import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { podmanClient, podmanDoctorCommand, podmanReadiness, podmanSocketCommand } from "../src/exec/podman-client";
import { podmanCommandRunner, podmanStreamRunner, type CommandRunner } from "../src/exec/podman-runtime";
import { PodmanSearxngRuntime } from "../src/web-tools/searxng";
import { PodmanAttachmentSanitizer, sanitizerCommandRunner } from "../src/attachments/sanitizer-runtime";
import { readConfig } from "../src/config";
import { ContainerRegistryProxy } from "../src/exec/container-registry-proxy";
import type { BoxStream } from "../src/exec/box-runtime";
import { boxDoctor } from "../src/ops/box-doctor";
import { enableServicePodman, inspectServicePodman } from "../src/ops/podman-service";
import { podmanNotice } from "../src/web-podman";
import { dictionaries, withLocale } from "../src/i18n";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const remoteEnv = { JIT_PODMAN_MODE: "remote", JIT_SERVICE_USER: "jit", XDG_RUNTIME_DIR: "/run/user/1001", PATH: process.env.PATH };
const prefix = ["--remote", "--url", "unix:///run/user/1001/podman/podman.sock"];
const image = `localhost/jit-box-base@sha256:${"a".repeat(64)}`;
const info = { host: { security: { rootless: true }, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"] } };
const result = (value: unknown = "", exitCode = 0) => ({ exitCode, stdout: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)), stderr: new Uint8Array() });

function fakeExecutable() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-remote-fixture-"))); roots.push(root);
  const binary = join(root, "podman-fixture");
  writeFileSync(binary, `#!${process.execPath}
const args = process.argv.slice(2);
const report = stdin => console.log(JSON.stringify({ args, stdin, env: process.env }));
if (args.includes('stream-fixture')) process.stdin.once('data', bytes => { report(bytes.toString()); process.exit(0); });
else report(await Bun.stdin.text());
`, { mode: 0o700 });
  return { binary, env: { ...remoteEnv, HOME: root, JIT_FIXTURE_SECRET: "fixture-only-secret", CONTAINER_HOST: "tcp://unwanted.invalid" } };
}

test("commands use the explicit Unix remote URL, preserve input and never forward service secrets or implicit connection settings", async () => {
  const f = fakeExecutable(), run = podmanCommandRunner(f.env, f.binary);
  for (const argv of [["info", "--format", "json"], ["run", "--network", "none", "--tmpfs", "/out:size=1024", "--userns=keep-id:uid=1000,gid=1000", image],
    ["exec", "-i", "box", "/opt/jit/runner"], ["container", "inspect", "box"], ["rm", "--force", "box"], ["pull", "--quiet", image], ["cp", "/fixture/input", "box:/workspace/input"]]) {
    const value = JSON.parse(Buffer.from((await run(argv, { stdin: Buffer.from("fixture-input"), timeoutMs: 1000 })).stdout).toString());
    expect(value.args).toEqual([...prefix, ...argv]); expect(value.stdin).toBe("fixture-input");
    expect(Object.keys(value.env).sort()).toEqual(["HOME", "PATH", "XDG_RUNTIME_DIR"]);
  }
  const local = JSON.parse(Buffer.from((await podmanCommandRunner({ PATH: f.env.PATH }, f.binary)(["info"], { timeoutMs: 1000 })).stdout).toString());
  expect(local.args).toEqual(["--remote=false", "info"]);
});

test("exec -i streams use the same remote selection; sidecar secret values stay in the client environment, off argv", async () => {
  const f = fakeExecutable(), stream = podmanStreamRunner(f.env, f.binary)(["exec", "-i", "--env", "FIXTURE_KEY", "sidecar", "stream-fixture"], { FIXTURE_KEY: "fixture-sidecar-value" });
  stream.write(Buffer.from("stream-input"));
  let text = ""; for await (const chunk of stream.stdout) text += new TextDecoder().decode(chunk);
  expect(await stream.exited).toBe(0);
  const value = JSON.parse(text); expect(value.args.slice(0, 3)).toEqual(prefix); expect(value.stdin).toBe("stream-input");
  expect(value.args.join(" ")).not.toContain("fixture-sidecar-value"); expect(value.env.FIXTURE_KEY).toBe("fixture-sidecar-value");
  expect(value.env.JIT_FIXTURE_SECRET).toBeUndefined();
});

test("the bounded sanitizer launcher also uses remote mode and the same environment allowlist", async () => {
  const f = fakeExecutable();
  const bytes = (await sanitizerCommandRunner(f.binary, f.env)(["run", "--network", "none", image], { timeoutMs: 1000 })).stdout;
  const value = JSON.parse(Buffer.from(bytes).toString());
  expect(value.args).toEqual([...prefix, "run", "--network", "none", image]); expect(value.env.JIT_FIXTURE_SECRET).toBeUndefined();
});

test("invalid or non-local remote selection fails closed instead of choosing another backend", () => {
  for (const env of [{ JIT_PODMAN_MODE: "auto" }, { JIT_PODMAN_MODE: "remote" }, { ...remoteEnv, XDG_RUNTIME_DIR: "/tmp/other" }, { ...remoteEnv, XDG_RUNTIME_DIR: "/run/user/0" }]) {
    expect(() => podmanClient(env)).toThrow("invalid_podman_client");
  }
});

test("readiness distinguishes missing Podman, a stopped socket, rootful/cgroup failures and a ready backend without containers", async () => {
  const calls: string[][] = []; let version = 0, backend = 125, value: unknown = info;
  const run: CommandRunner = async args => { calls.push([...args]); return args.includes("--version") ? result("podman version 4.9.3", version) : result(value, backend); };
  expect(await podmanReadiness(run, true)).toEqual({ state: "unavailable", reason: "socket" });
  version = 127; expect(await podmanReadiness(run, true)).toEqual({ state: "unavailable", reason: "podman" });
  version = 0; backend = 0; value = { host: { security: { rootless: false } } };
  expect(await podmanReadiness(run, true)).toEqual({ state: "unavailable", reason: "rootless" });
  value = info; expect(await podmanReadiness(run, true)).toEqual({ state: "ready", reason: null });
  expect(calls.every(args => args[0] === "info" || args.includes("--version"))).toBe(true);
});

test("SearXNG and sanitizer distinguish executable failures; sanitizer image readiness remains independent", async () => {
  let installed = true, hostReady = true, imageReady = true;
  const run: CommandRunner = async args => args.includes("--version") ? result("4.9.3", installed ? 0 : 127)
    : args[0] === "info" ? result(info, hostReady ? 0 : 125) : result([{ Config: { Labels: { "jit.sanitize.version": imageReady ? "2" : "1" } } }]);
  Object.assign(run, { client: podmanClient(remoteEnv) });
  const search = new PodmanSearxngRuntime("fixture", run), sanitizer = new PodmanAttachmentSanitizer(image, "fixture", readConfig({}).attachments, run);
  expect(await search.status()).toEqual({ state: "ready", reason: null }); expect(await sanitizer.available()).toBe(true);
  imageReady = false; expect(await sanitizer.status()).toEqual({ state: "unavailable", reason: "runtime" });
  hostReady = false; expect((await search.status()).reason).toBe("socket"); expect((await sanitizer.status()).reason).toBe("socket");
  installed = false;
  expect((await search.status()).reason).toBe("podman"); expect((await sanitizer.status()).reason).toBe("podman");
});

test("socket provisioning is idempotent, runs user systemctl as the service identity and keeps missing Podman chat-only", async () => {
  const calls: string[][] = [];
  const run = async (argv: string[]) => { calls.push(argv); return { exitCode: 0, stdout: "", timedOut: false }; };
  for (let i = 0; i < 2; i++) expect(await enableServicePodman(run, "jit", 1001)).toEqual({ state: "ready", nextAction: null });
  expect(calls.filter(args => args.includes("enable-linger"))).toHaveLength(2);
  expect(calls.filter(args => args.includes("podman.socket"))).toEqual(Array(2).fill(["runuser", "-u", "jit", "--", "env", "XDG_RUNTIME_DIR=/run/user/1001", "DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus", "systemctl", "--user", "enable", "--now", "podman.socket"]));
  expect((await enableServicePodman(async () => ({ exitCode: 127, stdout: "", timedOut: false }), "jit", 1001)).state).toBe("not-installed");
  const failed = await enableServicePodman(async args => ({ exitCode: args.includes("podman.socket") ? 1 : 0, stdout: "", timedOut: false }), "jit", 1001);
  expect(failed.state).toBe("socket-unavailable"); expect(failed.nextAction).toContain("systemctl --user enable --now podman.socket");
});

test("box-doctor checks the selected API and reports the exact service identity socket repair command", () => {
  const calls: string[][] = [];
  const report = boxDoctor({ clientEnv: remoteEnv, uid: 1001, stat: () => null, run: args => {
    calls.push(args); return { exitCode: args.includes("--version") ? 0 : 125, stdout: args.includes("--version") ? "podman version 4.9.3" : "" };
  } }, readConfig({}).execution);
  expect(report.checks.find(c => c.name === "podman-installed")?.ok).toBe(true);
  expect(report.checks.find(c => c.name === "podman-api-socket")).toMatchObject({ ok: false, nextAction: podmanSocketCommand(remoteEnv) });
  expect(calls.find(args => args.includes("info"))).toEqual(["podman", ...prefix, "info", "--format", "json"]);
});

test("both locales explain missing executable versus stopped API with an actionable command", () => {
  for (const locale of ["th", "en"] as const) for (const reason of ["podman", "socket", "rootless", "runtime"] as const) {
    const html = withLocale(locale, () => podmanNotice({ state: "unavailable", reason }));
    expect(html).toContain(dictionaries[locale][`podman.reason_${reason}`]);
    expect(html).toContain(reason === "socket" ? "systemctl --user enable --now podman.socket" : reason === "podman" ? "apt install podman" : "box-doctor");
  }
});

function proxyFixture() {
  const calls: string[][] = []; let ip = "10.89.0.2", fail: string | null = null, invalid = false, stop!: (code: number) => void, bundle = "";
  const run: CommandRunner = async args => {
    calls.push([...args]);
    if (fail && args.includes(fail)) return result("", 125);
    if (args[0] === "network" && args[1] === "inspect") return result([{ internal: false, driver: "bridge" }]);
    if (args[0] === "container") return result([{ ImageName: image, Config: { User: "1000:1000" }, State: { Running: true }, Mounts: [],
      HostConfig: { Privileged: invalid, ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Sysctls: { "net.ipv4.ip_forward": "0", "net.ipv6.conf.all.forwarding": "0" } },
      NetworkSettings: { Networks: { "jit-box-internal": { IPAddress: ip }, "jit-registry-egress": {} } } }]);
    return result("", args[1] === "exists" ? 1 : 0);
  };
  const streams = (args: readonly string[]): BoxStream => {
    calls.push([...args]); bundle = args[5]!;
    const exited = new Promise<number>(resolve => { stop = resolve; });
    return { write() {}, stdout: (async function* () { yield Buffer.from('{"ready":true,"port":3128}\n'); })(), exited, close() { stop(0); } };
  };
  const proxy = new ContainerRegistryProxy(image, ["registry.npmjs.org"], run, streams);
  return { proxy, calls, crash() { stop(1); ip = "10.89.0.3"; }, fail(command: string) { fail = command; }, invalid() { invalid = true; }, bundle: () => bundle };
}

test("remote proxy uses two bridges with no mounts, published ports or forwarding; restarts return a new URL", async () => {
  const f = proxyFixture(); expect(await f.proxy.url()).toBe("http://10.89.0.2:3128");
  const create = f.calls.find(args => args[0] === "create")!;
  for (const flag of ["--cap-drop=ALL", "--read-only", "--security-opt=no-new-privileges", "--user=1000:1000", "--pull=never", "--http-proxy=false", "net.ipv4.ip_forward=0", "net.ipv6.conf.all.forwarding=0"]) expect(create).toContain(flag);
  expect(create.some(arg => /--mount|--volume|--publish|privileged|podman.sock/.test(arg))).toBe(false);
  expect(f.calls).toContainEqual(["network", "connect", "jit-box-internal", "jit-registry-proxy"]);
  expect(f.calls.some(args => args.includes("unshare"))).toBe(false);
  // The actual generated bundle must remain runnable by the image's Node, not require Bun or TypeScript.
  const syntax = Bun.spawnSync(["node", "--check", "--input-type=commonjs"], { stdin: Buffer.from(f.bundle()), stdout: "pipe", stderr: "pipe" }); expect(syntax.exitCode).toBe(0);
  expect(f.bundle()).not.toContain("bun:");
  expect(await f.proxy.url()).toBe("http://10.89.0.2:3128"); expect(f.calls.filter(args => args[0] === "create")).toHaveLength(1);
  f.crash(); await Promise.resolve(); expect(await f.proxy.url()).toBe("http://10.89.0.3:3128");
  await f.proxy.close(); expect(f.calls.at(-1)).toEqual(["rm", "--force", "--ignore", "jit-registry-proxy"]);
});

test("remote proxy refuses unexpected hardening or a failed attach without dropping workspace isolation", async () => {
  for (const kind of ["inspect", "network", "stream"] as const) {
    const f = proxyFixture(); if (kind === "inspect") f.invalid(); else f.fail(kind === "network" ? "connect" : "start");
    await expect(f.proxy.url()).rejects.toMatchObject({ code: "box_proxy_unavailable" });
    expect(f.calls.at(-1)).toEqual(["rm", "--force", "--ignore", "jit-registry-proxy"]);
  }
});

test("service status probes as the configured identity for root, and remains read-only for a non-root caller", async () => {
  const calls: string[][] = [];
  const run = async (args: string[]) => { calls.push(args); return { exitCode: args.includes("info") ? 125 : 0, stdout: "", timedOut: false }; };
  expect((await inspectServicePodman(run, "jit", 1001)).state).toBe("socket-unavailable");
  expect(calls.every(args => args.slice(0, 4).join(" ") === "runuser -u jit --")).toBe(true);
  calls.length = 0;
  expect((await inspectServicePodman(run, "jit", 1001, false)).state).toBe("socket-unavailable");
  expect(calls.every(args => args[0] === "podman")).toBe(true);
  expect(calls.at(-1)).toContain("unix:///run/user/1001/podman/podman.sock");
});

test("the displayed doctor command carries only checked unit configuration, quotes paths and excludes secrets", () => {
  const command = podmanDoctorCommand({ ...remoteEnv, JIT_EXECUTION_DIR: "/fixture/path'quote", JIT_FIXTURE_SECRET: "fixture-secret" });
  expect(command).toContain("sudo runuser -u jit -- env"); expect(command).toContain("/opt/jit/current/src/ops-cli.ts box-doctor");
  expect(command).toContain("JIT_EXECUTION_DIR='/fixture/path'\\''quote'"); expect(command).not.toContain("fixture-secret");
});
