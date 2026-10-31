import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotPodmanRuntime, probeBotPodman, type BotPodmanOptions } from "../src/s14/computer-podman";
import { defaultComputerLimits } from "../src/s14/computer";
import type { BotComputer } from "../src/s14/computer-types";
import type { CommandRunner } from "../src/exec/podman-runtime";
import type { BoxStream } from "../src/exec/box-runtime";
import { FakeCdp } from "./fixtures/fake-cdp";
import { barrier } from "./fixtures/s14-computer";

const image = `localhost/jit@sha256:${"a".repeat(64)}`;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const bytes = (v: unknown) => new TextEncoder().encode(typeof v === "string" ? v : JSON.stringify(v));
const ok = (v: unknown = "") => ({ exitCode: 0, stdout: bytes(v), stderr: new Uint8Array() });
const host = () => ({ os: "linux", security: { rootless: true }, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"], idMappings: { uidmap: [{ size: 65536 }], gidmap: [{ size: 65536 }] } });
function fixture(change: (info: any) => void = () => {}, kernel = "50000 100000\n536870912\n128\n0\n", stream?: (index: number) => BoxStream, before?: (argv: readonly string[]) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "s14-podman-"))); roots.push(root);
  for (const bot of ["slot-0001", "slot-0002"]) for (const role of ["workspace", "profile"]) mkdirSync(join(root, "slots", bot, role), { recursive: true, mode: 0o700 });
  const networks = new Map<string, any>([["jit-registry-egress", { driver: "bridge", internal: false }]]);
  const runnerInputs: any[] = [];
  let registryFailure = "";
  const calls: string[][] = [], streamCalls: string[][] = [], infos = new Map<string, any>(), cdp = new FakeCdp();
  const requests: { argv: readonly string[]; timeoutMs: number }[] = [];
  const run: CommandRunner = async (argv, options) => {
    requests.push({ argv: [...argv], timeoutMs: options.timeoutMs });
    await before?.(argv);
    calls.push([...argv]);
    if (argv[0] === "--version") return ok("podman version fixture");
    if (argv[0] === "network") {
      const name = argv.at(-1)!;
      if (argv[1] === "exists") return { ...ok(), exitCode: networks.has(name) ? 0 : 1 };
      if (argv[1] === "create") { networks.set(name, { internal: argv.includes("--internal"), driver: "bridge", dns_enabled: registryFailure === "dns" }); return ok(); }
      if (argv[1] === "inspect") return ok([networks.get(name)]);
      if (argv[1] === "rm") { networks.delete(name); return ok(); }
      if (argv[1] === "connect") { infos.get(name).NetworkSettings.Networks[argv[2]!] = { IPAddress: "10.89.0.2" }; return ok(); }
    }
    if (argv[0] === "create") {
      if (registryFailure === "proxy") return { ...ok(), exitCode: 1 };
      const name = argv[argv.indexOf("--name") + 1]!;
      infos.set(name, { State: { Running: true }, ImageName: image, Config: { User: "1000:1000" }, Mounts: [],
        NetworkSettings: { Networks: { "jit-registry-egress": { IPAddress: "10.90.0.2" } } },
        HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], Sysctls: { "net.ipv4.ip_forward": "0", "net.ipv6.conf.all.forwarding": "0" } } });
      return ok();
    }
    if (argv[0] === "start") return ok();
    if (argv[0] === "container" && argv[1] === "inspect") return ok([infos.get(argv[2]!)]);
    if (argv[0] === "info") return ok({ host: host() });
    if (argv[0] === "run") {
      const get = (flag: string) => argv[argv.indexOf(flag) + 1]!;
      const mount = get("--mount").split(","), source = mount.find(x => x.startsWith("src="))!.slice(4), destination = mount.find(x => x.startsWith("dst="))!.slice(4);
      const info = { State: { Running: true }, ImageName: image,
        Config: { User: "1000:1000", Hostname: get("--name"), Labels: { "jit.s14.computer": get("--label").split("=")[1] } },
        Mounts: [{ Type: "bind", Source: source, Destination: destination }],
        HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: argv.find(a => a.startsWith("--network="))!.slice(10), PidMode: "private", IpcMode: "private", UTSMode: "private", CgroupnsMode: "private", SecurityOpt: ["no-new-privileges"], CapDrop: ["ALL"],
          Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=67108864,mode=1777", "/run": "rw,nosuid,nodev,noexec,size=134217728,mode=1777" } } };
      Object.assign(info, { NetworkSettings: { Networks: info.HostConfig.NetworkMode === "none" ? {} : { [info.HostConfig.NetworkMode]: { IPAddress: "10.89.0.3" } } } });
      change(info);
      infos.set(get("--name"), info);
      return ok(get("--name"));
    }
    if (argv[0] === "inspect") return ok([infos.get(argv[1]!)]);
    if (argv[0] === "rm" && registryFailure === "cleanup" && argv.at(-1)!.endsWith("-registry")) return { ...ok(), exitCode: 1 };
    if (argv[0] === "rm") { infos.delete(argv.at(-1)!); return ok(); }
    if (argv[0] === "exec" && argv.includes("/sys/fs/cgroup/cpu.max")) return ok(kernel);
    if (argv[0] === "exec" && argv.includes("/proc/net/route")) return ok(registryFailure === "route"
      ? "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\neth0 00000000 0100590A 0003 0 0 0 00000000 0 0 0\n"
      : "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\neth0 0000590A 00000000 0001 0 0 0 00FFFFFF 0 0 0\n");
    if (argv[0] === "exec" && argv.includes("/opt/jit/runner")) {
      const input = JSON.parse(new TextDecoder().decode(options.stdin)); runnerInputs.push(input);
      return ok({ v: 1, ok: true, result: input.op === "spawn" ? { stdout: Buffer.from("installed").toString("base64"), stderr: "", exitCode: 0, timedOut: false } : { type: "file" } });
    }
    throw Error(`unexpected fixture command ${argv[0]}`);
  };
  const options: BotPodmanOptions = { dataRoot: root, protectedPaths: [join(root, "..", "private-state")], workspaceImage: image, browserImage: image, run,
    streams(argv, extra) {
      streamCalls.push([...argv]); expect(extra).toEqual({});
      if (argv.includes("node")) {
        let output!: ReadableStreamDefaultController<Uint8Array>, exit!: (code: number) => void;
        return { stdout: new ReadableStream({ start(c) { output = c; c.enqueue(bytes({ ready: true, port: 3128 })); c.enqueue(bytes("\n")); } }),
          exited: new Promise<number>(resolve => { exit = resolve; }), write() {}, close() { output.close(); exit(0); } };
      }
      return stream ? stream(streamCalls.length) : cdp.stream(); } };
  const c: BotComputer = { id: "a".repeat(32), botId: "jit", revision: 1, generation: 1, botGeneration: 1, ownerGeneration: 1, workId: "work1", state: "starting", reason: null,
    limits: { ...defaultComputerLimits }, workspaceId: "workspace1", profileId: "profile1", diskSlot: { id: "slot-0001", generation: 1, clean: true }, lastUsedAt: 1800000000000 };
  let disk = "safe";
  class Runtime extends BotPodmanRuntime {
    override diskSlots() { return ["slot-0001", "slot-0002"]; }
    protected override async hostProbe(argv: string[], allowed: () => void) {
      allowed();
      if (argv[0] === "stat") return disk === "oversize" ? "4096 999999999" : "4096 1000";
      const filesystems = ["slot-0001", "slot-0002"].flatMap((bot, i) => ["workspace", "profile"].map((role, j) => ({ target: join(root, "slots", bot, role), source: `/dev/fixture${i * 2 + j}`, fstype: disk === "wrong-fs" ? "overlay" : "ext4", "maj:min": disk === "shared" ? "1:1" : `1:${i * 2 + j}`, fsroot: "/", options: disk === "unsafe-flags" ? "rw" : "rw,nodev,nosuid" })));
      if (disk === "systemd-bind") filesystems.push(...structuredClone(filesystems));
      if (disk === "alias") filesystems.push({ ...filesystems[0]!, target: join(root, "alias") });
      if (disk === "hidden-layer") filesystems.push({ ...filesystems[0]!, "maj:min": "9:9" });
      if (disk === "child-mount") filesystems.push({ ...filesystems[0]!, target: join(filesystems[0]!.target, "child") });
      return JSON.stringify({ filesystems });
    }
  }
  return { root, c, runtime: new Runtime(options), options, calls, requests, streamCalls, runnerInputs, cdp, setRegistryFailure(value: string) { registryFailure = value; }, setDisk(value: string) { disk = value; } };
}

test("concurrent computers serialize only Podman namespace planning and keep the original keep-id map", async () => {
  const gate = barrier(); let planning = 0, maxPlanning = 0, creates = 0;
  const f = fixture(undefined, undefined, undefined, async argv => {
    if (!["info", "run", "create"].includes(argv[0]!)) return;
    planning++; maxPlanning = Math.max(maxPlanning, planning);
    try { if (argv[0] === "run") { creates++; await gate.wait(); } }
    finally { planning--; }
  });
  const other = structuredClone(f.c); other.id = "b".repeat(32); other.botId = "reader"; other.diskSlot!.id = "slot-0002";
  const starts = [f.runtime.start(f.c, () => {}), f.runtime.start(other, () => {})];
  try {
    await gate.reached; await Bun.sleep(0);
    expect(creates).toBe(1);
    expect(maxPlanning).toBe(1);
  } finally { gate.release(); await Promise.all(starts); }
  expect(creates).toBe(4);
  expect(f.calls.filter(a => a[0] === "run").every(a => a.includes("--userns=keep-id:uid=1000,gid=1000"))).toBe(true);
});

test("concurrent startup shares a fresh slow info probe, reuses its host proof and probes again on a later start", async () => {
  const gate = barrier(); let infos = 0;
  const f = fixture(undefined, undefined, undefined, async argv => {
    if (argv[0] === "info") { infos++; await gate.wait(); }
  });
  const other = structuredClone(f.c); other.id = "b".repeat(32); other.botId = "reader"; other.diskSlot!.id = "slot-0002";
  const starts = [f.runtime.start(f.c, () => {}), f.runtime.start(other, () => {})];
  try { await gate.reached; await Bun.sleep(0); expect(infos).toBe(1); }
  finally { gate.release(); await Promise.all(starts); }
  expect(infos).toBe(1);
  expect(f.requests.filter(r => r.argv[0] === "info").map(r => r.timeoutMs)).toEqual([30000]);
  await f.runtime.stop(f.c);
  await f.runtime.start(f.c, () => {});
  expect(infos).toBe(2);
});

test("rootless workspace/browser use separate mounts, private namespaces, finite limits and no egress/socket/environment inheritance", async () => {
  const f = fixture(), handle = await f.runtime.start(f.c, () => {});
  const creates = f.calls.filter(a => a[0] === "run");
  expect(creates).toHaveLength(2);
  for (const args of creates) {
    for (const flag of ["--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--unsetenv-all", "--http-proxy=false", "--pull=never", "--pid=private", "--ipc=private", "--cgroupns=private"]) expect(args).toContain(flag);
    expect(args).not.toContain("--privileged");
    expect(args).not.toContain("--publish");
    expect(args.filter(a => a.startsWith("type=bind"))).toHaveLength(1);
    expect(args[args.indexOf("--memory") + 1]).toBe("536870912");
    expect(args.join(" ")).not.toMatch(/podman\.sock|docker\.sock|API_KEY|TOKEN|\.sqlite|\/home\//);
  }
  expect(creates[0]!.join(" ")).toContain(`src=${join(f.root, "slots/slot-0001/workspace")},dst=/workspace`);
  expect(creates[0]!.join(" ")).not.toContain("/profile");
  expect(creates[1]!.join(" ")).toContain(`src=${join(f.root, "slots/slot-0001/profile")},dst=/profile`);
  expect(creates[1]!.join(" ")).not.toContain("dst=/workspace");
  await expect(f.runtime.exec({ ...handle }, { input: bytes({}), timeoutMs: 1000 }, () => {})).rejects.toThrow("computer_handle_fenced");
  await f.runtime.exec(handle, { input: bytes({ v: 1, op: "stat", path: "/workspace/report" }), timeoutMs: 1000 }, () => {});
  expect(f.calls.at(-1)).toEqual(["exec", "-i", `jit-s14-${f.c.id}-workspace`, "/opt/jit/runner"]);
  await f.runtime.input(handle, { kind: "text", text: "private browser input" }, () => {});
  expect(f.streamCalls).toEqual([["exec", "-i", `jit-s14-${f.c.id}-browser`, "/opt/jit/cdp-relay"]]);
  expect(f.calls.some(args => args.join(" ").includes("private browser input"))).toBe(false);
  await f.runtime.stop(f.c);
  await expect(f.runtime.screenshot(handle, () => {})).rejects.toThrow("computer_handle_fenced");
});

test.each(["get-error", "no-page", "attach-error", "missing-session"])("failed browser Target setup (%s) closes its pipe and a later request reconnects without replaying input", async failure => {
  const sent: { method: string; params: Record<string, unknown> }[] = [], closed: number[] = [];
  const f = fixture(undefined, undefined, index => {
    let output!: ReadableStreamDefaultController<Uint8Array>;
    let exit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { exit = resolve; });
    return {
      stdout: new ReadableStream({ start(controller) { output = controller; } }), exited,
      close() { closed.push(index); output.close(); exit(0); },
      write(bytes) {
        const command = JSON.parse(new TextDecoder().decode(bytes).replace(/\0$/, ""));
        sent.push(command);
        const failed = index === 1;
        let result: Record<string, unknown> = {}, error = false;
        if (command.method === "Target.getTargets") {
          result = { targetInfos: failed && failure === "no-page" ? [] : [{ type: "page", targetId: "page-1" }] };
          error = failed && failure === "get-error";
        }
        if (command.method === "Target.attachToTarget") { result = failed && failure === "missing-session" ? {} : { sessionId: "session-1" }; error = failed && failure === "attach-error"; }
        if (command.method === "Page.captureScreenshot") result = { data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") };
        output.enqueue(new TextEncoder().encode(JSON.stringify({ id: command.id, ...(error ? { error: { code: -32000 } } : { result }) }) + "\0"));
      },
    };
  });
  const handle = await f.runtime.start(f.c, () => {});
  await expect(f.runtime.input(handle, { kind: "text", text: "do not replay" }, () => {})).rejects.toThrow();
  expect(closed).toEqual([1]);
  expect(sent.some(c => c.method.startsWith("Input."))).toBe(false);
  expect(await f.runtime.screenshot(handle, () => {})).toHaveLength(8);
  await f.runtime.input(handle, { kind: "text", text: "new explicit input" }, () => {});
  expect(f.streamCalls).toHaveLength(2);
  expect(sent.filter(c => c.method === "Input.insertText").map(c => c.params.text)).toEqual(["new explicit input"]);
  await f.runtime.stop(f.c);
  expect(closed).toEqual([1, 2]);
});

test.each(["other-bot", "profile", "socket", "writable-root", "egress", "namespace", "capability", "privilege", "unbounded-tmpfs", "image"])("inspect tampering (%s) refuses and removes containers before any runner or CDP call", async change => {
  const f = fixture(info => {
    if (change === "other-bot") info.Mounts[0].Source += "/reader";
    if (change === "profile") info.Mounts.push({ Type: "bind", Source: "/private-profile", Destination: "/profile" });
    if (change === "socket") info.Mounts.push({ Type: "bind", Source: "/run/podman.sock", Destination: "/run/control.sock" });
    if (change === "writable-root") info.HostConfig.ReadonlyRootfs = false;
    if (change === "egress") info.HostConfig.NetworkMode = "host";
    if (change === "namespace") info.HostConfig.PidMode = "host";
    if (change === "capability") info.HostConfig.CapAdd = ["SYS_ADMIN"];
    if (change === "privilege") info.HostConfig.Privileged = true;
    if (change === "unbounded-tmpfs") info.HostConfig.Tmpfs["/tmp"] = "rw";
    if (change === "image") info.ImageName = "unreviewed:latest";
  });
  await expect(f.runtime.start(f.c, () => {})).rejects.toThrow("computer_isolation_unverified");
  expect(f.calls.filter(a => a[0] === "rm").length).toBeGreaterThanOrEqual(4);
  expect(f.streamCalls).toHaveLength(0);
  expect(f.calls.some(a => a.includes("/opt/jit/runner"))).toBe(false);
});

test.each(["max 100000\n536870912\n128\n0", "50000 100000\nmax\n128\n0", "50000 100000\n536870912\nmax\n0", "50000 100000\n536870912\n128\nmax", "100001 100000\n536870912\n128\n0"])("kernel-unenforced finite limits fail closed: %s", async kernel => {
  const f = fixture(() => {}, kernel);
  await expect(f.runtime.start(f.c, () => {})).rejects.toThrow("computer_cgroup_limits_unenforced");
});

test.each(["oversize", "shared", "wrong-fs", "unsafe-flags", "alias", "hidden-layer", "child-mount"])("unproven persistent disk (%s) never starts a process", async disk => {
  const f = fixture(); f.setDisk(disk);
  await expect(f.runtime.start(f.c, () => {})).rejects.toThrow();
  expect(f.calls.some(a => a[0] === "run")).toBe(false);
});

test("symlinked volume boundary, state collision and unpinned image refuse before container creation", async () => {
  const f = fixture();
  rmSync(join(f.root, "slots/slot-0001/workspace"), { recursive: true });
  symlinkSync(join(f.root, "slots/slot-0002/workspace"), join(f.root, "slots/slot-0001/workspace"));
  await expect(f.runtime.start(f.c, () => {})).rejects.toThrow("computer_data_path_unsafe");
  expect(f.calls.some(a => a[0] === "run")).toBe(false);
  expect(() => new BotPodmanRuntime({ ...f.options, protectedPaths: [f.root] })).toThrow("computer_data_state_collision");
  symlinkSync(join(f.root, "slots"), join(f.root, "state-alias"));
  expect(() => new BotPodmanRuntime({ ...f.options, protectedPaths: [join(f.root, "state-alias", "future-state")] })).toThrow("computer_data_state_collision");
  expect(() => new BotPodmanRuntime({ ...f.options, workspaceImage: "latest" })).toThrow("computer_image_digest_required");
});

test("destruction removes only the selected Bot's contents and never follows an internal link into a sibling", async () => {
  const f = fixture();
  const sibling = join(f.root, "slots/slot-0002/workspace/report");
  writeFileSync(sibling, "B evidence");
  writeFileSync(join(f.root, "slots/slot-0001/workspace/report"), "A evidence");
  symlinkSync(join(f.root, "slots/slot-0002/workspace"), join(f.root, "slots/slot-0001/profile/escape"));
  await f.runtime.destroy(f.c, () => {});
  expect(existsSync(sibling)).toBe(true);
  expect(existsSync(join(f.root, "slots/slot-0001/workspace/report"))).toBe(false);
  expect(existsSync(join(f.root, "slots/slot-0001/profile/escape"))).toBe(false);
  expect(existsSync(join(f.root, "slots/slot-0001/profile"))).toBe(true);
});

test.each(["rootless", "subuid", "cgroup", "linux"])("readiness distinguishes missing %s without starting any container", async change => {
  const value = host();
  if (change === "rootless") value.security.rootless = false;
  if (change === "subuid") value.idMappings.uidmap = [{ size: 1 }];
  if (change === "cgroup") value.cgroupControllers = ["cpu"];
  if (change === "linux") value.os = "darwin";
  const run: CommandRunner = async args => args[0] === "--version" ? ok("fixture") : ok({ host: value });
  expect(await probeBotPodman(run)).toMatchObject({ state: "unavailable", reason: { rootless: "rootless_required", subuid: "subuid_subgid_range_required", cgroup: "cgroup_delegation_required", linux: "linux_required" }[change] });
});

test.each([["/dev/fuse: permission denied", "fuse_device_or_storage_driver_unavailable"], ["/dev/net/tun unavailable", "nested_network_device_unavailable"], ["newuidmap: write to uid_map failed", "subuid_subgid_range_required"], ["cannot clone: operation not permitted", "nested_user_namespace_unavailable"]])("nested diagnostics are safe reason codes (%s)", async (stderr, reason) => {
  const run: CommandRunner = async args => args[0] === "--version" ? ok() : { exitCode: 1, stdout: new Uint8Array(), stderr: bytes(`${stderr} secret=should-not-be-returned`) };
  expect(await probeBotPodman(run)).toEqual({ state: "unavailable", reason });
});


test("registry command reuses CONNECT proxy on its own internal bridge and cleans every descendant without changing ordinary components", async () => {
  const f = fixture(), handle = await f.runtime.start(f.c, () => {});
  const result = await f.runtime.registrySpawn(handle, { cwd: "/workspace/coding/work1", command: "'bun' 'install'", timeoutMs: 1000 }, ["registry.npmjs.org"], () => {});
  expect(result.exitCode).toBe(0);
  const creates = f.calls.filter(a => a[0] === "run");
  expect(creates.slice(0, 2).every(a => a.includes("--network=none"))).toBe(true);
  expect(creates[2]!.find(a => a.startsWith("--network="))).toEndWith("-registry-net");
  expect(creates[2]!.filter(a => a.startsWith("type=bind"))).toEqual([`type=bind,src=${join(f.root, "slots/slot-0001/workspace")},dst=/workspace,rw`]);
  expect(f.calls.some(a => a[0] === "network" && a.includes("--internal") && a.includes("--disable-dns"))).toBe(true);
  expect(f.streamCalls[0]!.at(-1)).toBe('["registry.npmjs.org"]');
  expect(f.runnerInputs[0].command).toContain("HTTPS_PROXY=http://10.89.0.2:3128");
  expect(f.runnerInputs[0].command).toContain("'env' '-i'");
  expect(f.calls.some(a => a[0] === "network" && a[1] === "rm")).toBe(true);
  await f.runtime.exec(handle, { input: bytes({ v: 1, op: "stat", path: "/workspace/report" }), timeoutMs: 1000 }, () => {});
  expect(f.calls.at(-1)).toContain(`jit-s14-${f.c.id}-workspace`);
});

test.each(["proxy", "route", "dns"])("registry boundary unavailable (%s) fails closed before executing a runner command", async failure => {
  const f = fixture(), handle = await f.runtime.start(f.c, () => {});
  f.setRegistryFailure(failure);
  await expect(f.runtime.registrySpawn(handle, { cwd: "/workspace", command: "'bun' 'install'", timeoutMs: 1000 }, ["registry.npmjs.org"], () => {})).rejects.toThrow();
  expect(f.runnerInputs).toHaveLength(0);
  expect(f.calls.some(a => a[0] === "network" && a[1] === "rm")).toBe(true);
});


test("unconfirmed registry cleanup fences the runtime handle and cannot certify a successful check", async () => {
  const f = fixture(), handle = await f.runtime.start(f.c, () => {});
  f.setRegistryFailure("cleanup");
  await expect(f.runtime.registrySpawn(handle, { cwd: "/workspace", command: "'npm' 'install'", timeoutMs: 1000 }, ["registry.npmjs.org"], () => {})).rejects.toThrow("coding_registry_cleanup_unconfirmed");
  await expect(f.runtime.exec(handle, { input: bytes({ v: 1, op: "stat", path: "/workspace/file" }), timeoutMs: 1000 }, () => {})).rejects.toThrow("computer_handle_fenced");
});

test("Podman 4.9 CgroupMode is accepted only for an exact private namespace; conflicting or missing proof refuses", async () => {
  const f = fixture(info => { info.HostConfig.CgroupMode = "private"; delete info.HostConfig.CgroupnsMode; });
  const handle = await f.runtime.start(f.c, () => {}); await f.runtime.stop(f.c);
  await expect(f.runtime.screenshot(handle, () => {})).rejects.toThrow("computer_handle_fenced");
  for (const mode of ["host", undefined]) {
    const bad = fixture(info => { info.HostConfig.CgroupMode = mode; delete info.HostConfig.CgroupnsMode; });
    await expect(bad.runtime.start(bad.c, () => {})).rejects.toThrow("computer_isolation_unverified");
  }
  const conflict = fixture(info => { info.HostConfig.CgroupMode = "host"; });
  await expect(conflict.runtime.start(conflict.c, () => {})).rejects.toThrow("computer_isolation_unverified");
});

test("a missing, foreign or stale-generation slot binding cannot start or wipe another disk", async () => {
  for (const diskSlot of [undefined, { id: "slot-0002", generation: 0, clean: true }, { id: "slot-9999", generation: 1, clean: true }]) {
    const f = fixture();
    const c = { ...f.c, ...(diskSlot ? { diskSlot } : { diskSlot: null }) };
    await expect(f.runtime.start(c, () => {})).rejects.toThrow("computer_disk_binding_invalid");
    await expect(f.runtime.destroy(c, () => {})).rejects.toThrow("computer_disk_binding_invalid");
    expect(f.calls.some(a => a[0] === "run")).toBe(false);
  }
});


test("identical systemd overmounts at the same target retain dedicated filesystem proof", async () => {
  const f = fixture(); f.setDisk("systemd-bind");
  const handle = await f.runtime.start(f.c, () => {});
  expect(handle.generation).toBe(f.c.generation);
  await f.runtime.stop(f.c);
});


test("confirmed stop clears only stale Chromium singleton links, retaining website data and link targets", async () => {
  const f = fixture(), profile = join(f.root, "slots/slot-0001/profile");
  const keep = join(profile, "website-data"); writeFileSync(keep, "synthetic persistent session");
  for (const entry of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) symlinkSync(keep, join(profile, entry));
  await f.runtime.start(f.c, () => {});
  expect(readFileSync(keep, "utf8")).toBe("synthetic persistent session");
  for (const entry of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) expect(existsSync(join(profile, entry))).toBe(false);
  for (const args of f.calls.filter(a => a[0] === "run")) expect(args[args.indexOf("--hostname") + 1]).toBe(args[args.indexOf("--name") + 1]);
  await f.runtime.stop(f.c);
});

test("an unconfirmed stop cannot remove browser locks or touch persistent website data", async () => {
  const f = fixture(), profile = join(f.root, "slots/slot-0001/profile"), keep = join(profile, "website-data");
  writeFileSync(keep, "synthetic session"); symlinkSync(keep, join(profile, "SingletonLock"));
  f.setRegistryFailure("cleanup");
  await expect(f.runtime.start(f.c, () => {})).rejects.toThrow("coding_registry_cleanup_unconfirmed");
  expect(existsSync(join(profile, "SingletonLock"))).toBe(true);
  expect(readFileSync(keep, "utf8")).toBe("synthetic session");
  expect(f.calls.some(a => a[0] === "run")).toBe(false);
});
