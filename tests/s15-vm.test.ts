import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coreToolDefinitions } from "schway/host";
import { createVmBackend } from "../src/s15/vm/backend";
import { vmCanonical, vmHash, vmPath, vmBytes, vmEndpoint } from "../src/s15/vm/validation";
import { vmSshArgs, vmHostCommand } from "../src/s15/vm/host";
import { VmSshTransport } from "../src/s15/vm/transport";
import { VmStore } from "../src/s15/vm/store";
import { WorkingVmService } from "../src/s15/vm/service";
import { defaultVmLimits, type VmPolicyPort, type VmPolicyOperation, type VmManagement, type VmMachineState, type VmHostCommand } from "../src/s15/vm/types";
import { LimaVmManagement, ProxmoxVmManagement, limaRestrictedQemu } from "../src/s15/vm/management";
import { VmEnrollment } from "../src/s15/vm/enrollment";
import { vmRunnerSource } from "../src/s15/vm/runner";
import { vmIdentityMatches } from "../src/s15/vm/binding";
import { VmSshDialGate } from "../src/s15/vm/dial";

const limits = { ...defaultVmLimits }, endpoint = { host: "vm.example.test", port: 22, user: "jit", identityFile: "/protected/key", knownHostsFile: "/protected/known" };
const stores: VmStore[] = [], directories: string[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
function fixture(options: Partial<import("../src/s15/vm/service").WorkingVmOptions> = {}) {
  const store = new VmStore(":memory:"); stores.push(store);
  const actor = {}, valid = new WeakSet([actor]); let revoked = false, beforeClaim: (() => Promise<void>) | undefined;
  let afterSend: (() => Promise<void>) | undefined;
  const claims: VmPolicyOperation[] = [], sends: Record<string, unknown>[] = [], scopeLifetimes: number[] = []; let stops = 0, empty = true, snapshot = 0; const retired: string[] = []; let stopBarrier: (() => Promise<boolean>) | undefined;
  const policy: VmPolicyPort = {
    assertCurrent(a) { if (!valid.has(a) || revoked) throw new Error("revoked"); },
    async claim(a, operation) {
      await beforeClaim?.(); policy.assertCurrent(a, operation as never); claims.push(operation);
      return { async dispatch(start) { policy.assertCurrent(a, operation as never); return start(); }, publish(consume) { policy.assertCurrent(a, operation as never); return consume(); }, observe() {} };
    },
  };
  const state: VmMachineState = { state: "running", identity: "fixture-vm", boot: "boot1", cpuCount: 4, memoryBytes: 8388608, diskBytes: 1048576, network: "proxy-only", nicMac: "52:54:00:12:34:56" };
  const manager: VmManagement = { async inspect() { return { ...state }; }, async stop() { state.state = "stopped"; }, async snapshot() { snapshot++; }, async restore() { state.state = "stopped"; }, async retireSnapshot(name) { retired.push(name); } };
  store.save({ id: "vm1", generation: 1, endpoint, managerId: "mgr", state: "ready", networkCheckedAt: 1, networkIsolated: true, maxSessions: 2, reason: null, machineIdentity: "fixture-vm", boot: "boot1", bindingMac: "52:54:00:12:34:56" });
  class Transport extends VmSshTransport {
    override async control(argv: readonly string[]) { if (argv.some(a => a.includes("nicMacs"))) return '{"nicMacs":["52:54:00:12:34:56"]}'; if (argv.includes("-c")) return '{"reachable":[false,false,false,false,false,false]}'; return ""; }
    override async openScope(_unit: string, ms: number, guard: () => void) { guard(); scopeLifetimes.push(ms); }
    override async closeScope() { stops++; return stopBarrier ? stopBarrier() : empty; }
    override async invoke(request: Record<string, unknown>, settings: Parameters<VmSshTransport["invoke"]>[1]) {
      settings.beforeStart(); sends.push(request); await afterSend?.();
      if (request.op === "init" || request.op === "write") return {};
      if (request.op === "spawn") return { stdout: Buffer.from("guest result").toString("base64"), stderr: "", exitCode: 0, timedOut: false, truncated: false, totalBytes: 12 };
      if (request.op === "realpath") return { path: request.path };
      if (request.op === "stat") return { type: "directory" };
      return {};
    }
  }
  const service = new WorkingVmService({ store, policy, managers: new Map([["mgr", manager]]), transport: () => new Transport(endpoint), now: () => 100,
    requireOwner: a => { if (a !== actor) throw new Error("owner required"); }, ...options });
  return { store, service, actor, manager, state, claims, sends, scopeLifetimes, revoke: () => { revoked = true; }, setBeforeClaim: (f: () => Promise<void>) => { beforeClaim = f; },
    setAfterSend: (f: () => Promise<void>) => { afterSend = f; }, setEmpty: (value: boolean) => { empty = value; }, setStopBarrier: (f: () => Promise<boolean>) => { stopBarrier = f; }, retired, stops: () => stops, snapshots: () => snapshot };
}
const open = (f: ReturnType<typeof fixture>, workId = "work1", extra = {}) => f.service.openAttempt(f.actor, { vmId: "vm1", workId, attemptId: `attempt_${workId}`, ...extra });

describe("working VM authority/lifecycle", () => {
  test("two works share the VM, have different workspaces/units; third waits", async () => {
    const f = fixture(), a = await open(f), b = await open(f, "work2");
    expect(f.scopeLifetimes.every(ms => ms > limits.commandMs && ms <= limits.sessionMs)).toBe(true);
    expect(a.backend.workspaceRoot).not.toBe(b.backend.workspaceRoot); expect(a.definitions.map(t => t.name)).toEqual(coreToolDefinitions(a.backend).map(t => t.name));
    await expect(open(f, "work3")).rejects.toMatchObject({ code: "vm_capacity" });
    await a.close(); expect(f.stops()).toBe(1); expect(b.evidence()[0]?.execution).toBe("unsettled");
    await b.close(); await a.close(); expect(f.stops()).toBe(2); expect(a.evidence()[0]?.execution).toBe("guest_scope_empty");
  });
  test("copied/foreign actor cannot obtain a backend", async () => {
    const f = fixture(); await expect(f.service.openAttempt({}, { vmId: "vm1", workId: "work1", attemptId: "a" })).rejects.toThrow("revoked"); expect(f.sends).toHaveLength(0);
  });
  test("revocation while waiting for a claim prevents I/O", async () => {
    const f = fixture(), s = await open(f), before = f.sends.length;
    f.setBeforeClaim(async () => f.revoke());
    await expect(s.backend.spawn({ command: "sudo id", cwd: s.backend.workspaceRoot })).rejects.toThrow("revoked");
    expect(f.sends).toHaveLength(before); await s.close();
  });
  test("system-wide administration is exclusive and takes a protected snapshot", async () => {
    const f = fixture(), a = await open(f);
    await expect(open(f, "admin", { mode: "system" })).rejects.toMatchObject({ code: "vm_capacity" }); await a.close();
    const s = await open(f, "admin", { mode: "system" }); expect(f.snapshots()).toBe(1);
    await expect(open(f, "sibling")).rejects.toMatchObject({ code: "vm_capacity" }); await s.close();
  });
  test("uncertain unit cleanup fences every work and retains capacity", async () => {
    const f = fixture(), a = await open(f), b = await open(f, "work2"); f.setEmpty(false);
    await expect(a.cancel()).rejects.toMatchObject({ code: "vm_stop_unconfirmed" });
    expect(f.store.registration("vm1").state).toBe("uncertain");
    await expect(b.backend.realpath(b.backend.workspaceRoot)).rejects.toHaveProperty("name", "AbortError");
    expect(f.store.db.query<{ n: number }, []>("SELECT count(*) n FROM vm_sessions WHERE state<>'closed'").get()!.n).toBe(2);
    await f.service.recover(f.actor, { vmId: "vm1" }); expect(a.evidence()[0]?.execution).toBe("vm_stopped");
    expect(f.store.registration("vm1").generation).toBe(2); expect(f.store.registration("vm1").state).toBe("stopped");
  });
  test("restart never replays old claims; strong stop cannot rewind evidence", async () => {
    const f = fixture(), s = await open(f); const count = f.sends.length;
    new WorkingVmService({ store: f.store, policy: { assertCurrent() {}, async claim() { throw new Error("no replay"); } }, managers: new Map() });
    expect(f.store.registration("vm1").state).toBe("uncertain"); expect(f.sends).toHaveLength(count);
    await f.service.recover(f.actor, { vmId: "vm1" }); expect(s.evidence()[0]?.outcome).toBe("guest_reported");
  });
  test("inspect setup has its own claim and never grants mutation or bash", async () => {
    const f = fixture(), session = await open(f, "inspection", { access: "inspect" });
    expect(f.claims[0]?.kind).toBe("setup"); expect(session.definitions.map(t => t.name).sort()).toEqual(["find", "grep", "ls", "read"]);
    await expect(session.backend.writeFileAtomically(session.backend.workspaceRoot + "/x", "no")).rejects.toMatchObject({ code: "vm_inspect_only" });
    await expect(session.backend.spawn({ command: "true", cwd: session.backend.workspaceRoot })).rejects.toMatchObject({ code: "vm_inspect_only" }); await session.close();
  });
  test("late output after revocation is retained as guest evidence but never published", async () => {
    const f = fixture(), session = await open(f); f.setAfterSend(async () => f.revoke());
    await expect(session.backend.spawn({ command: "echo late", cwd: session.backend.workspaceRoot })).rejects.toThrow("revoked");
    expect(session.evidence().at(-1)?.outcome).toBe("guest_reported"); expect(session.evidence().at(-1)?.published).toBe(false); await session.close();
  });
  test("cancel fences a late transport response and retains capacity until exact-unit cleanup", async () => {
    const f = fixture(), session = await open(f), barrier = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    f.setAfterSend(async () => { entered.resolve(); await barrier.promise; });
    const command = session.backend.spawn({ command: "echo late", cwd: session.backend.workspaceRoot }); await entered.promise;
    const closing = session.cancel(); expect(f.store.db.query<{ state: string }, []>("SELECT state FROM vm_sessions").get()?.state).toBe("stopping");
    barrier.resolve(); await expect(command).rejects.toHaveProperty("name", "AbortError"); await closing;
    expect(session.evidence().at(-1)?.published).toBe(false); expect(f.stops()).toBe(1);
  });
  test("already aborted request creates no session or send", async () => {
    const f = fixture(), c = new AbortController(); c.abort();
    await expect(open(f, "work", { signal: c.signal })).rejects.toHaveProperty("name", "AbortError"); expect(f.sends).toHaveLength(0);
  });
});

describe("VM protocol and backend", () => {
  test.each(["/etc/passwd", "/workspace/../etc", "/workspace//x", "/workspace/x\0", "/workspace/.hidden/../../x"])("refuses protected/traversal path %s before transport", p => { expect(() => vmPath(p, ["/workspace"])).toThrow(); });
  test.each(["Zg", "Zg===", "****", "Zh=="])("refuses noncanonical base64 %s", value => { expect(() => vmBytes(value, 1024)).toThrow(); });
  test("SSH disables config, agent, forwarding, proxy commands and host-key TOFU", () => {
    const args = vmSshArgs(endpoint).join(" "); for (const value of ["-F /dev/null", "StrictHostKeyChecking=yes", "IdentityAgent=none", "ClearAllForwardings=yes", "ProxyCommand=none", "ControlPath=none"]) expect(args).toContain(value);
    expect(() => vmEndpoint({ ...endpoint, host: "-oProxyCommand=evil" })).toThrow();
  });
  test("malformed/duplicate-key/foreign correlation results cannot become tool output", async () => {
    for (const output of ['{"v":1,"id":"wrong","ok":true,"result":{}}', '{"id":"x","ok":true,"result":{},"v":1,"v":1}', "not JSON"]) {
      const run: VmHostCommand = async (_argv, settings) => { settings.beforeStart?.(); return { stdout: Buffer.from(output), exitCode: 0 }; };
      await expect(new VmSshTransport(endpoint, run).invoke({ id: "x" }, { unit: `jit-${"a".repeat(32)}.slice`, timeoutMs: 1000, maxBytes: 1024, beforeStart() {} })).rejects.toMatchObject({ code: "vm_protocol_invalid" });
    }
  });
  test("connection failure never falls back to host shell", async () => {
    const commands: readonly string[][] = []; const recorded = commands as string[][];
    const run: VmHostCommand = async argv => { recorded.push([...argv]); return { stdout: new Uint8Array(), exitCode: 255 }; };
    await expect(new VmSshTransport(endpoint, run).invoke({ id: "x", op: "spawn", command: "touch /host/pwn" }, { unit: `jit-${"a".repeat(32)}.slice`, timeoutMs: 1000, maxBytes: 1024, beforeStart() {} })).rejects.toMatchObject({ code: "vm_connection_failed" });
    expect(commands).toHaveLength(1); expect(commands[0]?.[0]).toBe("ssh");
  });
  test("opaque file observations reject copies and foreign paths", async () => {
    const calls: Record<string, unknown>[] = [];
    const backend = createVmBackend({ async call(r) { calls.push(r); return r.op === "observe" ? { token: "a".repeat(64), data: null } : {}; } }, "/workspace", "/workspace/.tmp", limits);
    const observed = await backend.observeFile("/workspace/a");
    await expect(backend.writeFileAtomically("/workspace/a", "x", { observed: { ...observed! } })).rejects.toBeInstanceOf(TypeError);
    await expect(backend.writeFileAtomically("/workspace/b", "x", { observed })).rejects.toBeInstanceOf(TypeError);
    await backend.writeFileAtomically("/workspace/a", "x", { observed }); expect(calls.at(-1)?.observed).toBe("a".repeat(64));
  });
  test("unsafe autoload/credential environment is refused before dispatch", async () => {
    let calls = 0; const backend = createVmBackend({ async call() { calls++; return {}; } }, "/workspace", "/workspace/.tmp", limits);
    for (const env of [{ BASH_ENV: "/evil" }, { GITHUB_TOKEN: "no" }, { LD_PRELOAD: "/evil" }, { HTTPS_PROXY: "http://elsewhere" }]) await expect(backend.spawn({ command: "true", cwd: "/workspace", env })).rejects.toMatchObject({ code: "vm_environment_denied" });
    expect(calls).toBe(0);
  });
  test("host process runner bounds bytes and cancellation", async () => {
    await expect(vmHostCommand([process.execPath, "-e", "process.stdout.write('x'.repeat(4096))"], { timeoutMs: 1000, maxBytes: 128 })).rejects.toMatchObject({ code: "vm_output_limit" });
    const controller = new AbortController(); controller.abort(); await expect(vmHostCommand(["false"], { timeoutMs: 1000, maxBytes: 128, signal: controller.signal })).rejects.toHaveProperty("name", "AbortError");
  });
});

describe("protected management", () => {
  test("Lima refuses all pre-existing non-working VM names", () => { for (const instance of ["jit-arm", "jit-vm", "jit-ac12-arm64-20261101", "../jit-work"]) expect(() => new LimaVmManagement({ instance })).toThrow(); });
  test("QEMU wrapper denies host mounts and injects protected restrict/proxy network", () => { const source = limaRestrictedQemu("/trusted/qemu", 3128); expect(source).toContain("restrict=on,ipv6=off"); expect(source).toContain("guestfwd=tcp:192.168.5.100:3128"); expect(source).toContain("'-fsdev','-virtfs'"); });
  test("Lima binds its protected QEMU NIC and exact SSH forward, refusing a different pinned endpoint", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const directory = mkdtempSync(join(tmpdir(), "jit-vm-lima-")); directories.push(directory); mkdirSync(join(directory, "jit-work-test")); writeFileSync(join(directory, "jit-work-test", "qemu.pid"), "123");
    const run: VmHostCommand = async argv => ({ exitCode: 0, stdout: Buffer.from(argv[0] === "limactl" ? JSON.stringify({ name: "jit-work-test", vmType: "qemu", status: "Running", cpus: 4, memory: 1024, disk: 1024, sshLocalPort: 2222,
      config: { plain: true, mounts: [], networks: [], ssh: { forwardAgent: false, loadDotSSHPubKeys: false }, hostResolver: { enabled: false }, propagateProxyEnv: false } }) : "Mon Nov 2 00:00:00 2026 qemu -name lima-jit-work-test -netdev user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22,restrict=on,ipv6=off -device virtio-net-pci,netdev=net0,mac=52:54:00:12:34:56") });
    const machine = await new LimaVmManagement({ instance: "jit-work-test", limaHome: directory, run }).inspect();
    expect(machine.nicMac).toBe("52:54:00:12:34:56"); expect(machine.sshEndpoint).toEqual({ host: "127.0.0.1", port: 2222 });
    let queries = 0; const transport = new VmSshTransport(endpoint, async () => { queries++; return { exitCode: 0, stdout: Buffer.from('{"nicMacs":["52:54:00:12:34:56"]}') }; });
    expect(await vmIdentityMatches(transport, machine, { ...endpoint, host: "127.0.0.1", port: 3333 })).toBe(false); expect(queries).toBe(0);
    expect(await vmIdentityMatches(transport, machine, { ...endpoint, host: "127.0.0.1", port: 2222 })).toBe(true);
  });
  test("Proxmox cannot advertise isolation without enabled audit at every firewall level", async () => {
    const seen: string[] = [];
    const api = new ProxmoxVmManagement({ baseUrl: "https://proxmox.test:8006", node: "node1", vmid: 321, token: () => "fixture-only", proxy: { address: "192.0.2.4", port: 3128 },
      fetch: (async (url: string | URL | Request, options?: RequestInit) => {
        seen.push(String(url)); expect(options?.redirect).toBe("error");
        const p = String(url); let data: unknown = {};
        if (p.endsWith("status/current")) data = { status: "running", pid: 1, maxdisk: 1024 };
        else if (p.endsWith("/config")) data = { cores: 4, memory: 8192, scsi0: "local-lvm:vm-321-disk-0,size=60G", net0: "virtio=52:54:00:12:34:56,firewall=1" };
        else if (p.endsWith("/firewall/rules")) data = [{ type: "out", action: "ACCEPT", enable: 1, dest: "192.0.2.4", dport: "3128", proto: "tcp" }];
        else if (p.endsWith("/firewall/options")) data = { enable: p.includes("/cluster/") ? 0 : 1, policy_out: "DROP" };
        return Response.json({ data });
      }) as typeof fetch });
    const observed = await api.inspect(); expect(observed.nicMac).toBe("52:54:00:12:34:56"); expect(observed.network).toBe("unproven"); expect(seen.some(p => p.includes("/cluster/firewall/options"))).toBe(true);
  });
});

describe("real helper semantics in disposable host-local stand-ins (not VM evidence)", () => {
  test("atomic replacement detects changed content and replaces a symlink entry without touching its target", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "jit-vm-runner-"))); directories.push(directory);
    const root = `${directory}/workspace`, tmp = `${root}/.tmp`;
    const call = async (r: Record<string, unknown>) => {
      const result = await vmHostCommand(["python3", "-I", "-c", vmRunnerSource], { input: Buffer.from(vmCanonical({ id: "fixture", op: "init", root, tmp, cap: 1048576, ...r })), timeoutMs: 3000, maxBytes: 3145728 });
      return JSON.parse(Buffer.from(result.stdout).toString("utf8"));
    };
    expect((await call({})).ok).toBe(true);
    await call({ op: "write", path: `${root}/a`, data: Buffer.from("first").toString("base64"), createParents: false });
    const observed = (await call({ op: "observe", path: `${root}/a`, content: true })).result.token;
    await call({ op: "write", path: `${root}/a`, data: Buffer.from("second").toString("base64"), createParents: false });
    expect((await call({ op: "write", path: `${root}/a`, data: "eA==", observed })).code).toBe("ECHANGED");
    const { symlinkSync, readFileSync } = await import("node:fs"); symlinkSync(`${root}/a`, `${root}/link`);
    expect((await call({ op: "write", path: `${root}/link`, data: "eA==" })).ok).toBe(true);
    expect(readFileSync(`${root}/a`, "utf8")).toBe("second"); expect(readFileSync(`${root}/link`, "utf8")).toBe("x");
    symlinkSync(directory, `${root}/escape`);
    expect((await call({ op: "read", path: `${root}/escape/private` })).ok).toBe(false);
  });
  test("real shell helper strips ambient environment, caps output, and terminates a timed out process group", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jit-vm-spawn-")); directories.push(directory);
    const call = async (command: string, timeoutMs: number) => {
      const r = await vmHostCommand(["python3", "-I", "-c", vmRunnerSource], { input: Buffer.from(vmCanonical({ id: "fixture", op: "spawn", root: directory, tmp: directory, cwd: directory, cap: 32, command, env: {}, timeoutMs })), timeoutMs: 5000, maxBytes: 2048 });
      return JSON.parse(Buffer.from(r.stdout).toString("utf8")).result;
    };
    const capped = await call("printf '%0500d' 1", 1000); expect(capped.truncated).toBe(true); expect(Buffer.from(capped.stdout, "base64")).toHaveLength(32);
    expect((await call("sleep 10", 30)).timedOut).toBe(true);
    expect(Buffer.from((await call("printf '%s' \"${SSH_AUTH_SOCK-unset}\"", 1000)).stdout, "base64").toString()).toBe("unset");
  });
});

test("VM file reads with credential-shaped content are withheld without returning the bytes", async () => {
  const token = ["ghp_", "a".repeat(32)].join("");
  const backend = createVmBackend({ async call() { return { data: Buffer.from(token).toString("base64") }; } }, "/workspace", "/workspace/.tmp", limits);
  await expect((async () => { for await (const _ of backend.readFile("/workspace/a")) throw new Error("leaked"); })()).rejects.toMatchObject({ code: "vm_sensitive_output" });
});
test("malformed guest file results invoke the protocol fence before delivery", async () => {
  let fenced = false;
  const backend = createVmBackend({ protocolError() { fenced = true; }, async call() { return { data: "not valid base64" }; } }, "/workspace", "/workspace/.tmp", limits);
  await expect((async () => { for await (const _ of backend.readFile("/workspace/a")) throw new Error("leaked"); })()).rejects.toMatchObject({ code: "vm_protocol_invalid" }); expect(fenced).toBe(true);
});

test("explicit owner start after strong recovery advances fences and resumes no old command", async () => {
  const f = fixture(), session = await open(f), sent = f.sends.length;
  await session.close(); await f.service.recover(f.actor, { vmId: "vm1" });
  f.manager.start = async () => { f.state.state = "running"; f.state.boot = "boot2"; };
  await f.service.start(f.actor, "vm1"); expect(f.store.registration("vm1").generation).toBe(3); expect(f.sends).toHaveLength(sent);
  const next = await open(f, "new-work"); await next.close();
});
test("strong recovery retires old expiry callbacks and an in-flight failed cleanup", async () => {
  const timers: (() => void)[] = []; let cleared = 0;
  const f = fixture({ expiryTimer: (_ms, expire) => { timers.push(expire); return () => { cleared++; }; } }), session = await open(f);
  const stopping = Promise.withResolvers<boolean>(), entered = Promise.withResolvers<void>();
  f.setStopBarrier(async () => { entered.resolve(); return stopping.promise; });
  const oldClose = session.close(); await entered.promise;
  await f.service.recover(f.actor, { vmId: "vm1" });
  stopping.resolve(false); await oldClose; timers[0]!(); await session.close();
  expect(cleared).toBeGreaterThan(0); expect(f.store.registration("vm1").state).toBe("stopped");
  expect(f.store.db.query<{ state: string }, []>("SELECT state FROM vm_sessions").get()!.state).toBe("closed");
  expect(session.evidence()[0]!.execution).toBe("vm_stopped");
  f.manager.start = async () => { f.state.state = "running"; f.state.boot = "boot2"; };
  await f.service.start(f.actor, "vm1"); timers[0]!(); await session.cancel();
  expect(f.store.registration("vm1").state).toBe("ready"); expect(f.store.registration("vm1").generation).toBe(3);
});
test("late pre-recovery output cannot overwrite strong settlement or fence a new generation", async () => {
  const f = fixture(), session = await open(f), entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  f.setAfterSend(async () => { entered.resolve(); await finish.promise; });
  const old = session.backend.spawn({ command: "old", cwd: session.backend.workspaceRoot }); const outcome = old.catch(error => error);
  await entered.promise; await f.service.recover(f.actor, { vmId: "vm1" });
  f.manager.start = async () => { f.state.state = "running"; f.state.boot = "boot2"; }; await f.service.start(f.actor, "vm1");
  finish.resolve(); expect((await outcome).name).toBe("AbortError");
  expect(session.evidence().every(e => e.execution === "vm_stopped")).toBe(true); expect(f.store.registration("vm1").state).toBe("ready");
});
test("automatic snapshot retirement permits more than eight system sessions and keeps the latest three", async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) { const session = await open(f, `admin${i}`, { mode: "system" }); await session.close(); }
  expect(f.snapshots()).toBe(10); expect(f.retired).toHaveLength(7);
  const remaining = f.store.db.query<{ generation: number }, []>("SELECT generation FROM vm_snapshots ORDER BY rowid").all();
  expect(remaining.map(r => r.generation)).toEqual([9, 10, 11]);
  expect(f.claims.filter(c => JSON.parse(c.payload).kind === "retire_snapshot")).toHaveLength(7);
});
test("owner snapshot retirement refuses an active fence and removes only the exact unpinned tag", async () => {
  const f = fixture(), session = await open(f, "admin", { mode: "system" });
  const snapshotId = f.store.db.query<{ id: string }, []>("SELECT id FROM vm_snapshots").get()!.id;
  await expect(f.service.retireSnapshot(f.actor, { vmId: "vm1", snapshotId })).rejects.toMatchObject({ code: "vm_snapshot_in_use" }); expect(f.retired).toHaveLength(0);
  await session.close(); await expect(f.service.retireSnapshot({}, { vmId: "vm1", snapshotId })).rejects.toThrow("owner required");
  await f.service.retireSnapshot(f.actor, { vmId: "vm1", snapshotId }); expect(f.retired).toEqual([snapshotId]);
  expect(f.store.db.query<{ n: number }, []>("SELECT count(*) n FROM vm_snapshots").get()!.n).toBe(0);
});
test("artifact acquisition shares call accounting with the guest-write queue", async () => {
  let downloads = 0;
  const f = fixture({ limits: { ...limits, calls: 5 }, artifactFetch: async () => { downloads++; return new Uint8Array(); } }), session = await open(f);
  const request = { url: "https://download.test/file", sha256: vmHash(new Uint8Array()), maxBytes: 1024, path: session.backend.workspaceRoot + "/file" };
  await f.service.acquire(f.actor, session, request); await f.service.acquire(f.actor, session, request);
  await expect(f.service.acquire(f.actor, session, request)).rejects.toMatchObject({ code: "vm_limit_exhausted" });
  expect(downloads).toBe(2); expect(f.sends.filter(r => r.op === "write")).toHaveLength(2); await session.close();
});
test("queued acquisition waits behind its sibling and cancellation retains capacity until it settles", async () => {
  let downloads = 0; const entered = Promise.withResolvers<void>(), finished = Promise.withResolvers<Uint8Array>();
  const f = fixture({ artifactFetch: async () => { downloads++; entered.resolve(); return finished.promise; } }), session = await open(f);
  const request = { url: "https://download.test/file", sha256: vmHash(new Uint8Array()), maxBytes: 1024, path: session.backend.workspaceRoot + "/file" };
  const a = f.service.acquire(f.actor, session, request).catch(error => error); await entered.promise;
  const b = f.service.acquire(f.actor, session, request).catch(error => error), closing = session.cancel();
  expect(downloads).toBe(1); expect(f.store.db.query<{ state: string }, []>("SELECT state FROM vm_sessions").get()!.state).toBe("stopping");
  finished.resolve(new Uint8Array()); expect((await a).name).toBe("AbortError"); expect((await b).name).toBe("AbortError"); await closing;
  expect(downloads).toBe(1); expect(f.sends.filter(r => r.op === "write")).toHaveLength(0);
});
test("DNS/download waits cannot exceed the session's finite pending-operation queue", async () => {
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<Uint8Array>(); let downloads = 0;
  const f = fixture({ artifactFetch: async () => { downloads++; entered.resolve(); return finish.promise; } }), session = await open(f);
  const request = { url: "https://download.test/file", sha256: vmHash(new Uint8Array()), maxBytes: 1, path: session.backend.workspaceRoot + "/file" };
  const first = f.service.acquire(f.actor, session, request).catch(error => error); await entered.promise;
  const waiting = Array.from({ length: 32 }, () => f.service.acquire(f.actor, session, request).catch(error => error));
  expect((await waiting.at(-1)).code).toBe("vm_limit_exhausted"); expect(downloads).toBe(1);
  const closing = session.cancel(); finish.resolve(new Uint8Array()); await Promise.all([first, ...waiting]); await closing;
});
test("listing and search reject intermediate/final symlink escapes before opening the target", async () => {
  const { mkdirSync, symlinkSync, writeFileSync } = await import("node:fs");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "jit-vm-link-"))); directories.push(directory);
  const root = `${directory}/workspace`, tmp = `${root}/.tmp`, outside = `${directory}/outside`;
  const call = async (operation: Record<string, unknown>) => {
    const result = await vmHostCommand(["python3", "-I", "-c", vmRunnerSource], { input: Buffer.from(vmCanonical({ id: "links", root, tmp, cap: 65536, ...operation })), timeoutMs: 3000, maxBytes: 262144 });
    return JSON.parse(Buffer.from(result.stdout).toString());
  };
  expect((await call({ op: "init" })).ok).toBe(true);
  mkdirSync(`${outside}/nested`, { recursive: true }); writeFileSync(`${outside}/nested/private.txt`, "outside-only-marker");
  mkdirSync(`${root}/local`); writeFileSync(`${root}/local/ok.txt`, "local marker"); symlinkSync(outside, `${root}/escape`); symlinkSync(`${outside}/nested/private.txt`, `${root}/file-link`);
  const search = { op: "search", cwd: root, pattern: "marker", limit: 10, ignoreCase: false, glob: null, timeoutMs: 1000 };
  for (const operation of [{ op: "list", path: `${root}/escape/nested`, recursive: false }, { ...search, path: `${root}/escape/nested` }, { ...search, path: `${root}/local`, cwd: `${root}/escape/nested` }, { ...search, path: `${root}/file-link` }]) {
    const result = await call(operation); expect(result.ok).toBe(false); expect(["ELOOP", "ENOTDIR"]).toContain(result.code); expect(JSON.stringify(result)).not.toContain("outside-only-marker");
  }
  const local = await call({ op: "list", path: root, recursive: true }); expect(local.ok).toBe(true);
  expect(local.result.entries.some((entry: { name: string }) => entry.name === "local/ok.txt")).toBe(true);
  expect(local.result.entries.some((entry: { name: string }) => entry.name.includes("private.txt"))).toBe(false);
});
test("descriptor-anchored search preserves real rg file/directory paths and empty results", async () => {
  const { mkdirSync, writeFileSync, symlinkSync } = await import("node:fs");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "jit-vm-search-"))); directories.push(directory);
  const root = `${directory}/workspace`, tmp = `${root}/.tmp`, rg = Bun.which("rg"); expect(rg).not.toBeNull();
  mkdirSync(tmp, { recursive: true }); writeFileSync(`${root}/file.txt`, "local marker\n"); writeFileSync(`${directory}/private.txt`, "outside-marker\n"); symlinkSync(`${directory}/private.txt`, `${root}/escape`);
  // Host-local stand-in changes only the executable location; production uses the fixed Linux /usr/bin/rg.
  const source = vmRunnerSource.replace("'/usr/bin/rg'", JSON.stringify(rg));
  const search = async (path: string, pattern = "marker") => {
    const result = await vmHostCommand(["python3", "-I", "-c", source], { input: Buffer.from(vmCanonical({ v: 1, id: "rg", op: "search", root, tmp, cap: 65536, cwd: root, path, pattern, limit: 10, ignoreCase: false, glob: null, timeoutMs: 1000 })), timeoutMs: 3000, maxBytes: 262144 });
    const response = JSON.parse(Buffer.from(result.stdout).toString()); expect(response.ok).toBe(true);
    const output = Buffer.from(response.result.stdout, "base64").toString(); expect(response.result.totalBytes).toBe(Buffer.byteLength(output) + Buffer.from(response.result.stderr, "base64").length);
    return { result: response.result, matches: output.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(event => event.type === "match") };
  };
  for (const path of [root, `${root}/file.txt`]) {
    const found = await search(path); expect(found.result.exitCode).toBe(0); expect(found.matches).toHaveLength(1);
    expect(found.matches[0].data.path.text).toBe(`${root}/file.txt`); expect(found.matches[0].data.lines.text).toBe("local marker\n");
    const absent = await search(path, "unmatched-pattern"); expect(absent.result.exitCode).toBe(1); expect(absent.matches).toHaveLength(0);
  }
});
test("policy hold before a system snapshot leaves the VM available and sends no management mutation", async () => {
  const f = fixture(); f.setBeforeClaim(async () => { throw new Error("held"); });
  await expect(open(f, "admin", { mode: "system" })).rejects.toThrow("held");
  expect(f.snapshots()).toBe(0); expect(f.store.registration("vm1").state).toBe("ready");
  expect(f.store.db.query<{ state: string }, []>("SELECT state FROM vm_sessions").get()?.state).toBe("closed");
});

test("decoded/sanitized process output stays inside its UTF-8 byte ceiling", async () => {
  const invalid = Buffer.alloc(32, 0xff), backend = createVmBackend({ async call() { return { stdout: invalid.toString("base64"), stderr: "", exitCode: 0, timedOut: false, truncated: false, totalBytes: 32 }; } }, "/workspace", "/workspace/.tmp", { ...limits, outputBytes: 32 });
  const result = await backend.spawn({ command: "fixture", cwd: "/workspace" }); expect(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(32); expect(result.stderr).toContain("truncated");
});

test("owner-edited session settings replace the initial default of two", async () => {
  const f = fixture(), row = f.store.registration("vm1"); row.maxSessions = 3; f.store.save(row);
  const a = await open(f, "one"), b = await open(f, "two"); let c;
  try { c = await open(f, "three"); await expect(open(f, "four")).rejects.toMatchObject({ code: "vm_capacity" }); }
  finally { await Promise.all([a.close(), b.close(), c?.close()]); }
});

test.each([{ unexpected: true }, { path: "/outside" }, { path: 1 }])("every malformed returned path/record fences the VM: %j", async response => {
  let fenced = false;
  const backend = createVmBackend({ protocolError() { fenced = true; }, async call() { return response; } }, "/workspace", "/workspace/.tmp", limits);
  await expect(backend.realpath("/workspace")).rejects.toMatchObject({ code: "vm_protocol_invalid" }); expect(fenced).toBe(true);
});
