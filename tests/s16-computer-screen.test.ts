import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { QemuVmManagement, qemuArgv, qemuArgvFacts } from "../src/s15/vm/qemu";
import { FakeQemuHost } from "./fixtures/s15-qemu";
import { composedFixture } from "./fixtures/s15-composition";
import { dictionaries } from "../src/i18n";
import { vmScreenCommands, vmScreenFrame, vmScreenInput, type VmScreenDevice, type VmScreenInput } from "../src/s15/vm/screen";
import { WorkingVmService } from "../src/s15/vm/service";
import { VmStore } from "../src/s15/vm/store";
import { VmSshTransport } from "../src/s15/vm/transport";
import type { VmManagement, VmPolicyPort } from "../src/s15/vm/types";
import { ScreenControl, parseScreenCommand, type ScreenCommand } from "../src/s16/computers/screen";

const stores: VmStore[] = [], hosts: FakeQemuHost[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const h of hosts.splice(0)) h.cleanup(); });
const endpoint = { host: "vm.example.test", port: 22, user: "jit", identityFile: "/protected/key", knownHostsFile: "/protected/known" };
const enroll = (store: VmStore, id = "vm1") => store.save({ id, generation: 1, endpoint, managerId: "mgr", state: "ready", networkCheckedAt: 1, networkIsolated: true, maxSessions: 2, reason: null, machineIdentity: "fixture-vm", boot: "boot1", bindingMac: "52:54:00:12:34:56" });

/** A PNG header of the given size; the screen contract checks the signature and IHDR dimensions. */
function png(width = 1280, height = 800): Uint8Array {
  const bytes = new Uint8Array(64); bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer); view.setUint32(8, 13); bytes.set([..."IHDR"].map(c => c.charCodeAt(0)), 12); view.setUint32(16, width); view.setUint32(20, height);
  return bytes;
}
/** Scripted QMP-side screen: records every input; capture and send can be held at a barrier. */
function device() {
  const sent: VmScreenInput[] = []; let unavailable: string | null = null;
  let captureGate: Promise<void> | null = null, sendGate: Promise<void> | null = null;
  const value: VmScreenDevice = {
    async unavailable() { return unavailable; },
    async capture() { await captureGate; return png(); },
    async send(input) { await sendGate; sent.push(input); },
  };
  return { value, sent, setUnavailable: (code: string | null) => { unavailable = code; }, holdCapture: (gate: Promise<void> | null) => { captureGate = gate; }, holdSend: (gate: Promise<void> | null) => { sendGate = gate; } };
}
function control(store = new VmStore(":memory:"), screen = device(), clock = { now: 1000 }) {
  if (!stores.includes(store)) { stores.push(store); enroll(store); }
  const owner = { owner: true };
  const value = new ScreenControl<object>({ store, requireOwner: actor => { if (actor !== owner) throw new Error("owner required"); }, device: () => screen.value, scope: () => ({ kind: "shared" }), now: () => clock.now, leaseMs: 30_000 });
  let n = 0; const id = () => `req_${++n}_${Math.random().toString(36).slice(2, 8)}`;
  const command = (body: Record<string, unknown>) => value.command(owner, { contract: "s16-screen-command/v1", requestId: id(), vmId: "vm1", ...body });
  return { store, screen, clock, owner, control: value, command };
}
const text = (value: string): VmScreenInput => ({ kind: "text", text: value });

describe("desktop VM profile", () => {
  const spec = { name: "jit-work-0123456789ab", architecture: "x86_64" as const, machineDirectory: "/srv/jit/machines/jit-work-0123456789ab", cpus: 4, memoryMiB: 8192, mac: "52:54:00:12:34:56", sshPort: 22022, proxySocket: "/srv/jit/proxy.sock" };
  test("the headless argv is unchanged and the desktop profile adds only a virtio display, tablet and keyboard", () => {
    const headless = qemuArgv(spec), desktop = qemuArgv({ ...spec, desktop: true });
    expect(headless.some(arg => /vga|gpu|tablet|keyboard|vnc|spice/.test(arg))).toBe(false);
    expect(desktop.slice(0, headless.length)).toEqual(headless);
    expect(desktop.slice(headless.length)).toEqual(["-device", "virtio-vga,xres=1280,yres=800", "-device", "virtio-tablet-pci", "-device", "virtio-keyboard-pci"]);
    expect(desktop[desktop.indexOf("-display") + 1]).toBe("none");
    expect(qemuArgv({ ...spec, architecture: "aarch64", desktop: true })).toContain("virtio-gpu-pci,xres=1280,yres=800");
  });
  test("both profiles re-verify as exact; only the desktop profile reports a screen; anything else is not exact", () => {
    expect(qemuArgvFacts(qemuArgv(spec), spec)).toMatchObject({ exact: true }); expect(qemuArgvFacts(qemuArgv(spec), spec).desktop).toBeUndefined();
    expect(qemuArgvFacts(qemuArgv({ ...spec, desktop: true }), spec)).toMatchObject({ exact: true, desktop: true });
    expect(qemuArgvFacts([...qemuArgv(spec), "-vnc", ":0"], spec).exact).toBe(false);
    expect(qemuArgvFacts([...qemuArgv({ ...spec, desktop: true }), "-device", "virtio-tablet-pci"], spec)).toMatchObject({ exact: false });
  });
});

describe("host-side screen of a local QEMU VM", () => {
  const identity = { name: "jit-work-0123456789ab", architecture: "x86_64" as const, mac: "52:54:00:12:34:56", sshPort: 22022, resources: { cpus: 5, memoryMiB: 9216, diskGiB: 60 } };
  test("a desktop VM serves PNG frames and input through QMP only; the frame file does not stay behind", async () => {
    const h = new FakeQemuHost(); hosts.push(h);
    const m = new QemuVmManagement(identity, { ...h.options(), desktop: true }); await m.provision();
    expect(h.launches.at(-1)).toContain("virtio-tablet-pci");
    const screen = m.screen();
    expect(await screen.unavailable()).toBeNull();
    expect(await screen.capture()).toEqual(h.screenBytes);
    expect(existsSync(join(m.hypervisorDirectory, "screen.png"))).toBe(false);
    const before = h.qmpLog.length; await screen.send({ kind: "key", keys: ["ctrl", "l"] });
    expect(h.qmpLog.slice(before).map(c => c.execute)).toEqual(["input-send-event"]);
    h.screenBytes = new Uint8Array(64).fill(1);
    await expect(screen.capture()).rejects.toMatchObject({ code: "vm_screen_invalid" });
    await m.stop(); expect(await screen.unavailable()).toBe("vm_not_running");
    await expect(screen.send({ kind: "text", text: "x" })).rejects.toMatchObject({ code: "vm_not_running" });
  });
  test("a VM still running headless needs a restart before it has a screen; without the opt-in there is none", async () => {
    const h = new FakeQemuHost(); hosts.push(h);
    const headless = new QemuVmManagement(identity, h.options()); await headless.provision();
    expect(await headless.screen().unavailable()).toBe("vm_desktop_unavailable");
    const enabled = new QemuVmManagement(identity, { ...h.options(), desktop: true });
    expect((await enabled.inspect()).network).toBe("proxy-only");
    expect(await enabled.screen().unavailable()).toBe("vm_desktop_restart_required");
    await expect(enabled.screen().capture()).rejects.toMatchObject({ code: "vm_desktop_restart_required" });
  });
});

describe("screen input and frames", () => {
  test("input shapes are exact and bounded; text outside a US keyboard is refused, not approximated", () => {
    expect(vmScreenInput({ kind: "click", x: 0, y: 799, button: "left", double: false })).toBeTruthy();
    for (const bad of [{ kind: "click", x: 1280, y: 0, button: "left", double: false }, { kind: "click", x: 1, y: 1, button: "left" }, { kind: "key", keys: ["ctrl", "ctrl"] },
      { kind: "key", keys: ["0xff0d"] }, { kind: "scroll", x: 1, y: 1, delta: 0 }, { kind: "text", text: "" }, { kind: "text", text: "a".repeat(513) }, { kind: "drag" }])
      expect(() => vmScreenInput(bad)).toThrow(expect.objectContaining({ code: "invalid_screen_input" }));
    expect(() => vmScreenInput(text("สวัสดี"))).toThrow(expect.objectContaining({ code: "screen_text_unsupported" }));
  });
  test("text maps to press/release qcodes with shift; a combination releases in reverse; a click moves first", () => {
    const events = vmScreenCommands(text("A!")).map(c => (c.arguments as { events: { data: { down: boolean; key: { data: string } } }[] }).events.map(e => `${e.data.down ? "+" : "-"}${e.data.key.data}`));
    expect(events).toEqual([["+shift", "+a", "-a", "-shift"], ["+shift", "+1", "-1", "-shift"]]);
    const combo = vmScreenCommands({ kind: "key", keys: ["ctrl", "l"] })[0]!.arguments as { events: { data: { down: boolean; key: { data: string } } }[] };
    expect(combo.events.map(e => `${e.data.down ? "+" : "-"}${e.data.key.data}`)).toEqual(["+ctrl", "+l", "-l", "-ctrl"]);
    const click = vmScreenCommands({ kind: "click", x: 1279, y: 0, button: "left", double: true });
    expect(click).toHaveLength(3); expect(click.every(c => c.execute === "input-send-event")).toBe(true);
    expect((click[0]!.arguments as { events: { data: { value: number } }[] }).events.map(e => e.data.value)).toEqual([32767, 0]);
  });
  test("a frame must be a bounded PNG of the fixed display size", () => {
    expect(vmScreenFrame(png())).toBeTruthy();
    expect(() => vmScreenFrame(png(1024, 768))).toThrow(expect.objectContaining({ code: "vm_screen_invalid" }));
    expect(() => vmScreenFrame(new TextEncoder().encode("<svg></svg>".padEnd(64)))).toThrow(expect.objectContaining({ code: "vm_screen_invalid" }));
  });
});

describe("exclusive owner control", () => {
  test("takeover waits for work admitted before it; work and owner never hold the same writable generation", async () => {
    const f = control(), ticket = f.control.agentInput("vm1");
    let view = (await f.command({ kind: "takeover", generation: 0 })).view;
    expect(view).toMatchObject({ state: "settling", generation: 1, agentBusy: true });
    // The admitted operation can no longer dispatch or publish, and no new work is admitted.
    expect(() => ticket.current()).toThrow(expect.objectContaining({ code: "takeover_active" }));
    expect(() => f.control.agentInput("vm1")).toThrow(expect.objectContaining({ code: "takeover_active" }));
    await expect(f.command({ kind: "input", generation: 1, takeoverId: view.takeoverId, input: text("a") })).rejects.toMatchObject({ code: "takeover_settling" });
    expect(f.screen.sent).toEqual([]);
    ticket.end(); ticket.end();
    view = await f.control.view(f.owner, "vm1");
    expect(view).toMatchObject({ state: "owner", generation: 1, agentBusy: false });
    await f.command({ kind: "input", generation: 1, takeoverId: view.takeoverId, input: text("a") });
    expect(f.screen.sent).toEqual([text("a")]);
  });

  test("old frames and input after hand-back or a second takeover are refused", async () => {
    const f = control();
    const taken = (await f.command({ kind: "takeover", generation: 0 })).view;
    await expect(f.control.frame(f.owner, "vm1", 0)).rejects.toMatchObject({ code: "stale_screen" });
    expect(await f.control.frame(f.owner, "vm1", 1)).toEqual(png());
    const back = (await f.command({ kind: "hand_back", generation: 1, takeoverId: taken.takeoverId })).view;
    expect(back).toMatchObject({ state: "agent", generation: 2, takeoverId: null });
    await expect(f.command({ kind: "input", generation: 1, takeoverId: taken.takeoverId, input: text("x") })).rejects.toMatchObject({ code: "takeover_state_changed" });
    const again = (await f.command({ kind: "takeover", generation: 2 })).view;
    await expect(f.command({ kind: "input", generation: 3, takeoverId: taken.takeoverId, input: text("x") })).rejects.toMatchObject({ code: "stale_screen" });
    await expect(f.command({ kind: "takeover", generation: 2 })).rejects.toMatchObject({ code: "takeover_state_changed" });
    expect(again.generation).toBe(3); expect(f.screen.sent).toEqual([]);
  });

  test("a frame captured across a transition is dropped instead of shown as current", async () => {
    const f = control(), gate = Promise.withResolvers<void>(); f.screen.holdCapture(gate.promise);
    const frame = f.control.frame(f.owner, "vm1", 0);
    await f.command({ kind: "takeover", generation: 0 }); gate.resolve();
    await expect(frame).rejects.toMatchObject({ code: "stale_screen" });
  });

  test("hand-back waits for the owner's input being sent before work may write again", async () => {
    const f = control(), gate = Promise.withResolvers<void>();
    const taken = (await f.command({ kind: "takeover", generation: 0 })).view;
    f.screen.holdSend(gate.promise);
    const typing = f.command({ kind: "input", generation: 1, takeoverId: taken.takeoverId, input: text("pw") });
    await Bun.sleep(1); // The input is now being sent.
    const handing = f.command({ kind: "hand_back", generation: 1, takeoverId: taken.takeoverId });
    await Bun.sleep(5);
    // Still the owner's generation: work is refused and further owner input is refused as closing.
    expect(() => f.control.agentInput("vm1")).toThrow(expect.objectContaining({ code: "takeover_active" }));
    await expect(f.command({ kind: "input", generation: 1, takeoverId: taken.takeoverId, input: text("z") })).rejects.toMatchObject({ code: "stale_screen" });
    gate.resolve(); await typing; expect((await handing).view.state).toBe("agent");
    // An input queued behind a hand-back is refused rather than sent after it.
    const late = f.command({ kind: "input", generation: 1, takeoverId: taken.takeoverId, input: text("late") });
    await expect(late).rejects.toMatchObject({ code: "takeover_state_changed" });
    f.control.agentInput("vm1").end();
    expect(f.screen.sent).toEqual([text("pw")]);
  });

  test("an input still queued when hand-back starts is never sent", async () => {
    const f = control(), taken = (await f.command({ kind: "takeover", generation: 0 })).view;
    const queued = f.command({ kind: "input", generation: 1, takeoverId: taken.takeoverId, input: text("q") });
    const handing = f.command({ kind: "hand_back", generation: 1, takeoverId: taken.takeoverId });
    await expect(queued).rejects.toMatchObject({ code: "stale_screen" });
    expect((await handing).view.state).toBe("agent"); expect(f.screen.sent).toEqual([]);
  });

  test("a closed tab during login keeps the computer fenced until the owner decides", async () => {
    const f = control();
    const taken = (await f.command({ kind: "takeover", generation: 0 })).view;
    f.clock.now += 29_000; await f.command({ kind: "renew", generation: 1, takeoverId: taken.takeoverId });
    f.clock.now += 29_000; expect((await f.control.view(f.owner, "vm1")).state).toBe("owner");
    f.clock.now += 2_000;
    const lapsed = await f.control.view(f.owner, "vm1");
    expect(lapsed).toMatchObject({ state: "fenced", generation: 2, takeoverId: null, expiresAt: null });
    expect(() => f.control.agentInput("vm1")).toThrow(expect.objectContaining({ code: "takeover_active" }));
    expect(f.control.idleBlocked("vm1")).toBe(true);
    await expect(f.command({ kind: "renew", generation: 1, takeoverId: taken.takeoverId })).rejects.toMatchObject({ code: "screen_control_lost" });
    await expect(f.command({ kind: "input", generation: 2, takeoverId: taken.takeoverId, input: text("x") })).rejects.toMatchObject({ code: "screen_control_lost" });
    const resumed = (await f.command({ kind: "takeover", generation: 2 })).view;
    expect(resumed).toMatchObject({ state: "owner", generation: 3 });
    f.clock.now += 31_000; await f.control.view(f.owner, "vm1");
    expect((await f.command({ kind: "hand_back", generation: 4, takeoverId: null })).view).toMatchObject({ state: "agent", generation: 5 });
    expect(f.control.idleBlocked("vm1")).toBe(false);
  });

  test("a controller restart fences control the owner held, under a new generation", async () => {
    const f = control();
    const taken = (await f.command({ kind: "takeover", generation: 0 })).view;
    const restarted = control(f.store, f.screen, f.clock);
    expect(await restarted.control.view(restarted.owner, "vm1")).toMatchObject({ state: "fenced", generation: 2 });
    await expect(restarted.command({ kind: "input", generation: 1, takeoverId: taken.takeoverId, input: text("x") })).rejects.toMatchObject({ code: "screen_control_lost" });
    expect(() => restarted.control.agentInput("vm1")).toThrow(expect.objectContaining({ code: "takeover_active" }));
  });

  test("typed text never reaches the journal: no value or hash of it is stored", async () => {
    const f = control(), secret = "Hunter2-Correct-Horse";
    const taken = (await f.command({ kind: "takeover", generation: 0 })).view;
    await f.command({ kind: "input", generation: 1, takeoverId: taken.takeoverId, input: text(secret) });
    await f.command({ kind: "hand_back", generation: 1, takeoverId: taken.takeoverId });
    const hash = new Bun.CryptoHasher("sha256").update(secret).digest("hex");
    const dump = f.store.db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'").all()
      .flatMap(({ name }) => f.store.db.query<Record<string, unknown>, []>(`SELECT * FROM "${name}"`).all()).map(row => JSON.stringify(row)).join("\n");
    expect(dump).not.toContain(secret); expect(dump).not.toContain(hash);
    expect(f.store.db.query<{ kind: string }, []>("SELECT kind FROM s16_screen_events ORDER BY sequence").all().map(row => row.kind)).toEqual(["takeover", "hand_back"]);
  });

  test("takeover and hand-back are idempotent per request id; input is sent at most once per request id", async () => {
    const f = control(), requestId = "req_takeover";
    const body: ScreenCommand = { contract: "s16-screen-command/v1", requestId, vmId: "vm1", kind: "takeover", generation: 0 };
    const first = await f.control.command(f.owner, body), retried = await f.control.command(f.owner, body);
    expect(retried.view.generation).toBe(first.view.generation);
    await expect(f.control.command(f.owner, { ...body, generation: 1 })).rejects.toMatchObject({ code: "request_id_conflict" });
    const input = { contract: "s16-screen-command/v1", requestId: "req_input", vmId: "vm1", kind: "input", generation: 1, takeoverId: first.view.takeoverId, input: text("once") };
    await f.control.command(f.owner, input); await f.control.command(f.owner, input);
    expect(f.screen.sent).toEqual([text("once")]);
  });

  test("a computer without a desktop cannot be taken over, and only the owner reaches the screen", async () => {
    const f = control(); f.screen.setUnavailable("vm_desktop_restart_required");
    expect(await f.control.view(f.owner, "vm1")).toMatchObject({ available: false, code: "vm_desktop_restart_required", state: "agent" });
    await expect(f.command({ kind: "takeover", generation: 0 })).rejects.toMatchObject({ code: "vm_desktop_restart_required" });
    await expect(f.control.view({}, "vm1")).rejects.toThrow("owner required");
    await expect(f.control.frame({}, "vm1", 0)).rejects.toThrow("owner required");
    await expect(f.control.view(f.owner, "vm2")).rejects.toMatchObject({ code: "vm_not_enrolled" });
    expect(() => parseScreenCommand({ contract: "s16-screen-command/v1", requestId: "r", vmId: "vm1", kind: "takeover", generation: 0, extra: 1 })).toThrow();
  });
});

describe("working VM operations under screen control", () => {
  function vm(screen: ScreenControl<object>, store: VmStore) {
    const actor = {}; let afterSend: (() => Promise<void>) | undefined; const sends: Record<string, unknown>[] = [];
    const policy: VmPolicyPort = {
      assertCurrent() {},
      async claim() { return { async dispatch(start) { return start(); }, publish(consume) { return consume(); }, observe() {} }; },
    };
    const manager: VmManagement = { async inspect() { return { state: "running", identity: "fixture-vm", boot: "boot1", cpuCount: 4, memoryBytes: 8388608, diskBytes: 1048576, network: "proxy-only", nicMac: "52:54:00:12:34:56" }; }, async stop() {}, async snapshot() {}, async restore() {}, async retireSnapshot() {} };
    class Transport extends VmSshTransport {
      override async control(argv: readonly string[]) { if (argv.some(a => a.includes("nicMacs"))) return '{"nicMacs":["52:54:00:12:34:56"]}'; if (argv.includes("-c")) return '{"reachable":[false,false,false,false,false,false]}'; return ""; }
      override async openScope(_unit: string, _ms: number, guard: () => void) { guard(); }
      override async closeScope() { return true; }
      override async invoke(request: Record<string, unknown>, settings: Parameters<VmSshTransport["invoke"]>[1]) {
        settings.beforeStart(); sends.push(request); await afterSend?.();
        if (request.op === "spawn") return { stdout: "", stderr: "", exitCode: 0, timedOut: false, truncated: false, totalBytes: 0 };
        if (request.op === "realpath") return { path: request.path };
        if (request.op === "stat") return { type: "directory" };
        return {};
      }
    }
    const service = new WorkingVmService({ store, policy, managers: new Map([["mgr", manager]]), transport: () => new Transport(endpoint), now: () => 100, screen });
    return { service, actor, sends, setAfterSend: (f: () => Promise<void>) => { afterSend = f; } };
  }
  test("a running command delays owner control; nothing new is admitted until hand-back", async () => {
    const f = control(), w = vm(f.control, f.store);
    const session = await w.service.openAttempt(w.actor, { vmId: "vm1", workId: "work1", attemptId: "attempt1" });
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    w.setAfterSend(async () => { entered.resolve(); await release.promise; });
    const running = session.backend.spawn({ command: "sleep 1", cwd: session.backend.workspaceRoot });
    await entered.promise;
    const taken = (await f.command({ kind: "takeover", generation: 0 })).view;
    expect(taken).toMatchObject({ state: "settling", agentBusy: true });
    release.resolve();
    // The response arrived after the takeover: it is not published to the work.
    await expect(running).rejects.toMatchObject({ code: "takeover_active" });
    expect((await f.control.view(f.owner, "vm1")).state).toBe("owner");
    w.setAfterSend(async () => {}); const before = w.sends.length;
    await expect(session.backend.spawn({ command: "true", cwd: session.backend.workspaceRoot })).rejects.toMatchObject({ code: "takeover_active" });
    expect(w.sends.length).toBe(before);
    await f.command({ kind: "hand_back", generation: 1, takeoverId: taken.takeoverId });
    await session.backend.spawn({ command: "true", cwd: session.backend.workspaceRoot });
    expect(w.sends.length).toBe(before + 1);
    await session.close();
  });
});

describe("owner screen API under the real composition", () => {
  const closers: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const close of closers.splice(0)) await close(); });
  test("the owner watches, takes over (work is refused), types once and hands back; nothing without the opt-in", async () => {
    const screen = device();
    const f = await composedFixture("default", false, undefined, o => ({ ...o, computers: { idleStopMs: 30 * 60_000, sweepMs: 0 }, screen: {},
      vm: { ...o.vm, managers: new Map([...o.vm.managers].map(([id, manager]) => [id, Object.assign(manager, { screen: () => screen.value })])) } }));
    closers.push(() => f.close());
    expect((await (await f.request("/api/s16/client/bootstrap")).json()).capabilities.computers).toMatchObject({ available: true, screen: true });
    // The page shows frames only from in-memory blob URLs; no remote or data image source is allowed.
    expect((await f.request("/s16/computers")).headers.get("content-security-policy")).toContain("img-src blob:;");
    const view = await (await f.request("/api/s16/client/computers/vm/screen")).json();
    expect(view).toMatchObject({ contract: "s16-computer-screen/v1", vmId: "vm", available: true, state: "agent", generation: 0, scope: { kind: "shared" } });
    const frame = await f.request("/api/s16/client/computers/vm/screen/frame?generation=0");
    expect(frame.status).toBe(200); expect(frame.headers.get("content-type")).toBe("image/png"); expect(frame.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await frame.arrayBuffer())).toEqual(png());
    expect((await f.request("/api/s16/client/computers/vm/screen/frame?generation=1")).status).toBe(409);
    expect((await f.request("/api/s16/client/computers/vm/screen/frame?generation=0&x=1")).status).toBe(400);
    expect((await f.request("/api/s16/client/computers/vm/screen?x=1")).status).toBe(400);
    const takeover = { contract: "s16-screen-command/v1", requestId: "take_1", vmId: "vm", kind: "takeover", generation: 0 };
    expect((await f.request("/api/s16/client/computers/screen/commands", "POST", takeover, { "x-csrf-token": "forged" })).status).toBe(403);
    const taken = await (await f.request("/api/s16/client/computers/screen/commands", "POST", takeover)).json();
    expect(taken.view).toMatchObject({ state: "owner", generation: 1 });
    // Work cannot start on the computer while the owner holds it.
    const work = f.service.policy.owner.admit(f.owner, { requestId: "screen_work", intent: "execute", access: "reversible_write", purpose: f.policyInput.purposes[0]!, bot: f.policyInput.bots[0]!, resources: [f.policyInput.resources[0]!], recipients: [], selection: f.choice, selectionPin: null, expiresAt: 800000 }).work!;
    const actor = f.service.policy.control.bindWork(work.id), input = { vmId: "vm", workId: work.id, attemptId: "chat_" + work.id };
    await expect(f.service.workingVm.openAttempt(actor, input)).rejects.toMatchObject({ code: "takeover_active" });
    const typed = { contract: "s16-screen-command/v1", requestId: "type_1", vmId: "vm", kind: "input", generation: 1, takeoverId: taken.view.takeoverId, input: { kind: "text", text: "owner-secret" } };
    expect((await f.request("/api/s16/client/computers/screen/commands", "POST", typed)).status).toBe(200);
    expect(screen.sent).toEqual([{ kind: "text", text: "owner-secret" }]);
    const back = await (await f.request("/api/s16/client/computers/screen/commands", "POST", { contract: "s16-screen-command/v1", requestId: "back_1", vmId: "vm", kind: "hand_back", generation: 1, takeoverId: taken.view.takeoverId })).json();
    expect(back.view).toMatchObject({ state: "agent", generation: 2 });
    expect((await f.request("/api/s16/client/computers/screen/commands", "POST", typed)).status).toBe(200); // Same request id: not sent again.
    expect(screen.sent).toHaveLength(1);
    const session = await f.service.workingVm.openAttempt(actor, input); await session.close();
    const plain = await composedFixture(); closers.push(() => plain.close());
    expect((await plain.request("/api/s16/client/computers/vm/screen")).status).toBe(503);
    for (const locale of ["en", "th"] as const) for (const key of ["s16.screen.watch", "s16.screen.takeOver", "s16.screen.handBack", "s16.screen.fenced", "s16.screen.typeHint"]) expect((dictionaries[locale] as Record<string, string>)[key]).toBeTruthy();
  });
});
