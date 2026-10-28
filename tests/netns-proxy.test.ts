import { afterEach, expect, test } from "bun:test";
import { connect } from "node:net";
import { join } from "node:path";
import { AppError } from "../src/errors";
import { NetnsRegistryProxy, type ProxyChild } from "../src/exec/netns-proxy";

/** A scripted proxy child: resolves ready (or never), exits on demand. */
function scriptedChild(report: { port: number; netns: string } | "never" | "exit") {
  let exit!: (code: number) => void, killed = false;
  const exited = new Promise<number>(resolve => { exit = resolve; });
  const ready = report === "never" ? new Promise<never>(() => {}) : report === "exit" ? new Promise<never>(() => {}) : Promise.resolve(report);
  if (report === "exit") queueMicrotask(() => exit(1));
  const child: ProxyChild & { exit: (code: number) => void; killed: () => boolean } = {
    ready, exited, kill: () => { killed = true; exit(143); }, exit, killed: () => killed,
  };
  return child;
}

function fixture(reports: (({ port: number; netns: string }) | "never" | "exit")[], netns: { current: string | null }) {
  const spawned: { argv: readonly string[]; child: ReturnType<typeof scriptedChild> }[] = [];
  const proxy = new NetnsRegistryProxy({
    hosts: ["registry.npmjs.org", "pypi.org"], bun: "/opt/bun", entry: "/opt/jit/current/src/exec/registry-proxy-main.ts", readyMs: 50,
    currentNetns: async () => netns.current,
    spawn: argv => { const child = scriptedChild(reports.shift() ?? { port: 3128, netns: netns.current ?? "1" }); spawned.push({ argv, child }); return child; },
  });
  return { proxy, spawned };
}

test("the URL is known before any box and the child runs in the rootless netns with fixed argv", async () => {
  const netns = { current: "4026532001" };
  const { proxy, spawned } = fixture([{ port: 3128, netns: "4026532001" }], netns);
  expect(proxy.url("10.89.0.1")).toBe("http://10.89.0.1:3128");
  expect(proxy.url("fd00::1")).toBe("http://[fd00::1]:3128");
  await proxy.ensure("10.89.0.1");
  expect(spawned.map(entry => entry.argv)).toEqual([["podman", "unshare", "--rootless-netns", "/opt/bun", "/opt/jit/current/src/exec/registry-proxy-main.ts",
    "--hostname", "10.89.0.1", "--port", "3128", "--hosts", "registry.npmjs.org,pypi.org"]]);
  // A live child in the same namespace is reused; concurrent callers share one start.
  await Promise.all([proxy.ensure("10.89.0.1"), proxy.ensure("10.89.0.1")]);
  expect(spawned).toHaveLength(1);
  await proxy.close();
  expect(spawned[0]!.child.killed()).toBe(true);
});

test("a child that exited, or a recreated namespace, restarts the proxy", async () => {
  const netns = { current: "4026532001" };
  const { proxy, spawned } = fixture([], netns);
  await proxy.ensure("10.89.0.1");
  spawned[0]!.child.exit(1);
  await Bun.sleep(0);
  await proxy.ensure("10.89.0.1");
  expect(spawned).toHaveLength(2);
  // Podman tore the namespace down after the last box stopped and made a new one for the next box.
  netns.current = "4026532999";
  await proxy.ensure("10.89.0.1");
  expect(spawned).toHaveLength(3);
  expect(spawned[1]!.child.killed()).toBe(true);
  await proxy.close();
});

test("a child that exits or never reports ready is killed and refused as box_proxy_unavailable", async () => {
  for (const report of ["exit", "never", { port: 4000, netns: "1" }] as const) {
    const { proxy, spawned } = fixture([report], { current: "1" });
    const error = await proxy.ensure("10.89.0.1").then(() => null, e => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe("box_proxy_unavailable");
    expect(spawned[0]!.child.killed() || report === "exit").toBe(true);
  }
});

test("the proxy entry reports ready with its netns, enforces the allowlist and exits when stdin closes", async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/exec/registry-proxy-main.ts"), "--hostname", "127.0.0.1", "--port", String(port), "--hosts", "registry.npmjs.org"],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const reader = child.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) { const { value, done } = await reader.read(); if (done) break; text += new TextDecoder().decode(value); }
  const report = JSON.parse(text.split("\n")[0]!) as { ready: boolean; port: number; netns: string };
  expect(report.ready).toBe(true);
  expect(report.port).toBe(port);
  expect(report.netns).toMatch(process.platform === "linux" ? /^\d+$/ : /^none$/);
  const status = await new Promise<string>(resolve => {
    const socket = connect(port, "127.0.0.1", () => socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n"));
    socket.once("data", chunk => { resolve(chunk.toString("latin1").split("\r\n")[0]!); socket.destroy(); });
  });
  expect(status).toBe("HTTP/1.1 403 Forbidden");
  child.stdin.end();
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toContain("registry proxy refused example.com");
});

test("the proxy entry refuses invalid arguments", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/exec/registry-proxy-main.ts"), "--hostname", "example.com", "--port", "3128", "--hosts", "x"], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(2);
});
