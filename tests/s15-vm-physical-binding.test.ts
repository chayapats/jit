import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vmHasBinding, vmIdentityMatches, vmManagementMatches } from "../src/s15/vm/binding";
import { VmStore, type VmRegistration } from "../src/s15/vm/store";
import { VmEnrollment } from "../src/s15/vm/enrollment";
import { WorkingVmService } from "../src/s15/vm/service";
import { VmPool } from "../src/s15/vm/pool";
import { VmSshTransport } from "../src/s15/vm/transport";
import { vmHostCommand } from "../src/s15/vm/host";
import type { VmEndpoint, VmHostCommand, VmMachineState, VmManagement, VmPhysicalBinding, VmPolicyPort } from "../src/s15/vm/types";

// Owning-service protocol fixtures, not Linux/KVM host or isolation evidence.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
const directory = () => { const p = mkdtempSync(join(tmpdir(), "jit-physical-binding-")); cleanup.push(() => rmSync(p, { recursive: true, force: true })); return p; };
const store = (path = ":memory:") => { const s = new VmStore(path); cleanup.push(() => s.close()); return s; };
const endpoint: VmEndpoint = { host: "127.0.0.1", port: 22426, user: "jit", identityFile: "/protected/key", knownHostsFile: "/protected/known" };
const binding = (): Extract<VmPhysicalBinding, { kind: "firecracker-vsock" }> => ({ kind: "firecracker-vsock", instanceId: "jit-work-fixture", guestCid: 3, guestPort: 22, selectionSha256: "a".repeat(64) });
const machine = (): VmMachineState => ({ state: "running", identity: "firecracker:fixture", boot: "host-boot:start:1", cpuCount: 2, memoryBytes: 512 * 1048576, diskBytes: 128 * 1048576, network: "isolated", binding: binding(), sshEndpoint: { host: endpoint.host, port: endpoint.port } });
const registration = (id = "vm"): VmRegistration => ({ id, generation: 1, endpoint, managerId: "manager", state: "ready", networkCheckedAt: 0, networkIsolated: true, maxSessions: 2, reason: null, machineIdentity: machine().identity, boot: machine().boot, binding: binding() });

test("NIC-free binding requires exact protected selection/forwarder; guest NIC output cannot supply it", async () => {
  const state = machine(), row = registration(); let guestReads = 0;
  const transport = new VmSshTransport(endpoint, async () => { guestReads++; throw new Error("no guest identity echo"); });
  expect(vmHasBinding(row)).toBe(true); expect(vmManagementMatches(row, state)).toBe(true);
  expect(await vmIdentityMatches(transport, state, endpoint)).toBe(true); expect(guestReads).toBe(0);
  for (const changed of [
    { ...binding(), guestCid: 4 }, { ...binding(), guestPort: 23 }, { ...binding(), instanceId: "jit-work-other" }, { ...binding(), selectionSha256: "b".repeat(64) },
  ]) expect(vmManagementMatches(row, { ...state, binding: changed })).toBe(false);
  for (const changed of [
    { ...state, nicMac: "52:54:00:12:34:56" }, { ...state, sshEndpoint: { host: "127.0.0.1", port: 22427 } },
    { ...state, sshEndpoint: { host: "vm.test", port: endpoint.port } }, { ...state, state: "stopped" as const },
  ]) expect(await vmIdentityMatches(transport, changed, endpoint)).toBe(false);
  const { sshEndpoint: _forwarder, ...missing } = state;
  expect(await vmIdentityMatches(transport, missing, endpoint)).toBe(false);
  expect(await vmIdentityMatches(new VmSshTransport({ ...endpoint, knownHostsFile: "/other/known" }), state, endpoint)).toBe(false);
  expect(vmHasBinding({ binding: { ...binding(), guestCid: 2 } })).toBe(false);
  expect(vmHasBinding({ binding: { ...binding(), guestPort: 0xffffffff } })).toBe(false);
  const extra = { ...binding(), extra: true }; expect(vmHasBinding({ binding: extra })).toBe(false);
  expect(vmHasBinding({ binding: binding(), bindingMac: "52:54:00:12:34:56" })).toBe(false);
  const legacy = { bindingMac: "52:54:00:12:34:56", machineIdentity: "legacy" };
  expect(vmManagementMatches(legacy, { ...machine(), identity: "legacy", binding: { kind: "nic", mac: legacy.bindingMac } })).toBe(true);
  const { binding: _vsock, sshEndpoint: _ep, ...legacyStopped } = machine();
  expect(vmManagementMatches(legacy, { ...legacyStopped, identity: "legacy", state: "stopped" })).toBe(true);
});

test("existing format-1 files remain unchanged until explicit physical-binding adoption; rollback reader rejects the header", () => {
  const path = join(directory(), "vm.sqlite"), s = store(path);
  s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  expect(readFileSync(path).readUInt32BE(60)).toBe(1);
  expect(() => s.save(registration())).toThrow(expect.objectContaining({ code: "vm_store_format_required" }));
  expect(s.db.query("SELECT id FROM vm_registry").all()).toHaveLength(0);
  expect(() => s.transaction(() => s.enableVsockBindings())).toThrow(expect.objectContaining({ code: "vm_store_format_required" }));
  s.enableVsockBindings(); expect(readFileSync(path).readUInt32BE(60)).toBe(2);
  s.save(registration());
  const reopened = store(path);
  expect(reopened.registration("vm").binding).toEqual(binding());
  expect(reopened.db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  // The old reader's immutable pre-open predicate requires header user_version === 1.
  expect(readFileSync(path).readUInt32BE(60) === 1).toBe(false);
  expect(readFileSync(path).readUInt32BE(68)).toBe(0x4a495456);
});

test("a WAL-only format stamp cannot admit new state while an older reader blocks checkpoint", () => {
  const path = join(directory(), "vm.sqlite"), s = store(path);
  s.db.exec("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA busy_timeout=1");
  const reader = new Database(path); cleanup.push(() => reader.close());
  reader.exec("BEGIN"); reader.query("SELECT * FROM vm_registry").all();
  expect(() => s.enableVsockBindings()).toThrow(expect.objectContaining({ code: "vm_store_format_required" }));
  expect(readFileSync(path).readUInt32BE(60)).toBe(1);
  expect(() => s.save(registration())).toThrow(expect.objectContaining({ code: "vm_store_format_required" }));
  expect(s.db.query("SELECT id FROM vm_registry").all()).toHaveLength(0);
  reader.exec("ROLLBACK"); s.enableVsockBindings(); s.save(registration());
  expect(readFileSync(path).readUInt32BE(60)).toBe(2); expect(s.registration("vm").binding).toEqual(binding());
});

test("actual enrollment retains a protected vsock binding without a fabricated MAC or guest identity echo", async () => {
  const s = store(), owner = {}, state = machine(), keys = join(directory(), "keys"); let publicKey = "", nicReads = 0;
  const run: VmHostCommand = async (argv, opts) => {
    if (argv[0] === "ssh-keygen") { const r = await vmHostCommand(argv, opts); publicKey = readFileSync(`${argv.at(-1)}.pub`, "utf8").trim().split(" ").slice(0, 2).join(" "); return r; }
    const program = argv.at(-1)!;
    if (program.includes("nicMacs")) { nicReads++; throw new Error("no NIC"); }
    return { exitCode: 0, stdout: Buffer.from(program.includes("platform.machine") ? JSON.stringify({ architecture: "aarch64", os: "ubuntu:24.04", cpuCount: 2, memoryBytes: state.memoryBytes, diskBytes: state.diskBytes, sudo: true, docker: false, basis: "guest_reported" }) : program.includes("reachable") ? '{"reachable":[false,false,false,false,false,false]}' : "jit-vm-ready-v1\n") };
  };
  const manager: VmManagement = { async inspect() { return state; }, async stop() {}, async snapshot() {}, async restore() {}, async retireSnapshot() {} };
  const enrollment = new VmEnrollment({ store: s, keyDirectory: keys, requireOwner: a => { if (a !== owner) throw new Error("owner"); }, managers: new Map([["manager", manager]]), run });
  const setup = await enrollment.begin(owner);
  const result = await enrollment.complete(owner, { ...endpoint, setupId: setup.setupId, id: "vm", managerId: "manager", hostPublicKey: publicKey });
  expect(result.state).toBe("ready"); expect(result.recoveryAvailable).toBe(true); expect(nicReads).toBe(0);
  expect(result.capabilities.find(c => c.id === "hypervisor-stop")?.state).toBe("unproven");
  expect(s.registration("vm").binding).toEqual(binding()); expect(s.registration("vm").bindingMac).toBeUndefined();
  expect(s.db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
  expect(JSON.stringify(enrollment.status(owner, "vm"))).not.toContain("selectionSha256");
  const alias = await enrollment.begin(owner);
  await expect(enrollment.complete(owner, { ...endpoint, setupId: alias.setupId, id: "physical-alias", managerId: "manager", hostPublicKey: publicKey })).rejects.toMatchObject({ code: "vm_already_enrolled" });
  expect(s.db.query("SELECT id FROM vm_registry").all()).toHaveLength(1);
});

function serviceFixture(kind: "nic" | "vsock" = "vsock") {
  const s = store(), state = machine(), row = registration();
  if (kind === "vsock") s.enableVsockBindings();
  else { delete row.binding; row.bindingMac = "52:54:00:12:34:56"; delete state.binding; state.nicMac = row.bindingMac; }
  s.save(row);
  const actor = {}, writes = new Map<string, Uint8Array>(); let valid = true, stopUnknown = false, afterRead: (() => Promise<void>) | undefined;
  const manager: VmManagement = { async inspect() { return structuredClone(state); }, async start() { state.state = "running"; state.boot = "host-boot:start:2"; }, async stop() { if (stopUnknown) throw new Error("unknown stop"); state.state = "stopped"; }, async snapshot() {}, async restore() { state.state = "stopped"; }, async retireSnapshot() {} };
  const policy: VmPolicyPort = { assertCurrent(a) { if (a !== actor || !valid) throw new Error("revoked"); }, async claim(a, op) { policy.assertCurrent(a, op as never); return { async dispatch(start) { policy.assertCurrent(a, op as never); return start(); }, publish(consume) { policy.assertCurrent(a, op as never); return consume(); }, observe() {} }; } };
  class Transport extends VmSshTransport {
    override async control(argv: readonly string[]) { return argv.some(a => a.includes("nicMacs")) ? '{"nicMacs":["52:54:00:12:34:56"]}' : '{"reachable":[false,false,false,false,false,false]}'; }
    override async openScope(_unit: string, _ms: number, guard: () => void) { guard(); }
    override async closeScope() { return true; }
    override async invoke(request: Record<string, unknown>, settings: Parameters<VmSshTransport["invoke"]>[1]) {
      settings.beforeStart();
      if (request.op === "write") writes.set(String(request.path), Buffer.from(String(request.data), "base64"));
      if (request.op === "read") { const data = Buffer.from(writes.get(String(request.path)) ?? []).toString("base64"); await afterRead?.(); return { data }; }
      if (request.op === "spawn") return { stdout: Buffer.from("fixture task done").toString("base64"), stderr: "", exitCode: 0, timedOut: false, truncated: false, totalBytes: 17 };
      return {};
    }
  }
  const service = new WorkingVmService({ store: s, policy, managers: new Map([["manager", manager]]), transport: () => new Transport(endpoint), requireOwner: a => policy.assertCurrent(a, {} as never) });
  return { s, actor, state, service, writes, revoke: () => { valid = false; }, unknownStop: () => { stopUnknown = true; }, readBarrier: (value: () => Promise<void>) => { afterRead = value; } };
}

test("owning pool/session and public execution backend run the same bounded task on NIC and vsock fixtures", async () => {
  for (const kind of ["nic", "vsock"] as const) {
  const f = serviceFixture(kind), pool = new VmPool({ store: f.s, id: "vm" });
  expect(pool.place("work")).toBe("vm"); pool.bind("work", "vm");
  const session = await f.service.openAttempt(f.actor, { vmId: pool.place("work"), workId: "work", attemptId: "attempt" });
  const bytes = new Uint8Array([0, 1, 2, 255]), path = await session.transfer!.put({ id: "input", name: "sample.bin", bytes });
  expect(await session.transfer!.take(path)).toEqual(bytes);
  expect((await session.backend.spawn({ command: "fixture task", cwd: session.backend.workspaceRoot })).stdout).toBe("fixture task done");
  await session.close(); expect(session.evidence().every(e => e.execution === "guest_scope_empty")).toBe(true);
  expect(session.evidence().some(e => e.execution === "vm_stopped")).toBe(false);
  await f.service.recover(f.actor, { vmId: "vm" });
  expect(f.s.evidence(session.id).every(e => e.execution === "vm_stopped")).toBe(true);
  expect(f.s.registration("vm").binding).toEqual(kind === "vsock" ? binding() : undefined); expect(f.s.registration("vm").state).toBe("stopped");
  await f.service.start(f.actor, "vm");
  expect(f.s.registration("vm").state).toBe("ready"); expect(f.s.registration("vm").generation).toBe(3);
  expect(f.s.db.query("PRAGMA user_version").get()).toEqual({ user_version: kind === "vsock" ? 2 : 1 });
  }
});

test("vsock pool placement preserves old workspace affinity and private member ceilings", () => {
  const f = serviceFixture(), old = registration("old"); delete old.binding; old.bindingMac = "52:54:00:12:34:56"; f.s.save(old);
  const pool = new VmPool({ store: f.s, id: "old" }); pool.bind("existing", "old");
  f.s.db.query("INSERT INTO vm_sessions VALUES (?,?,?,?,?,?,?,?)").run("busy", "old", "existing", "a", "work", "active", "unit", 1);
  expect(pool.place("new")).toBe("vm"); expect(pool.place("existing")).toBe("old");
  const scoped = new VmPool({ store: f.s, id: "old", scope: { privateBot: vm => vm === "vm" ? "bot-a" : null, assigned: bot => bot === "bot-a" ? ["vm"] : [] } });
  expect(scoped.place("fresh-a", "bot-a")).toBe("vm"); expect(scoped.place("fresh-b", "bot-b")).toBe("old");
  scoped.bind("private", "vm"); expect(() => scoped.place("private", "bot-b")).toThrow(expect.objectContaining({ code: "outside_scope" }));
});

test("a replaced generation rejects a held original result without moving or mutating the current binding", async () => {
  const f = serviceFixture(), session = await f.service.openAttempt(f.actor, { vmId: "vm", workId: "work", attemptId: "attempt" });
  const path = await session.transfer!.put({ id: "input", name: "file", bytes: new Uint8Array([9]) });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.readBarrier(async () => { entered.resolve(); await release.promise; });
  const result = session.transfer!.take(path).catch(error => error); await entered.promise;
  const current = f.s.registration("vm"); current.generation++; f.s.save(current); release.resolve();
  expect(await result).toBeInstanceOf(Error); await session.close();
  expect(f.s.evidence(session.id).at(-1)?.published).toBe(false); expect(f.s.registration("vm").generation).toBe(2);
  expect(f.s.registration("vm").binding).toEqual(binding());
});

test("changed protected selection or host boot refuses work before any guest write", async () => {
  for (const drift of ["binding", "boot"] as const) {
    const f = serviceFixture();
    if (drift === "binding") f.state.binding = { ...binding(), selectionSha256: "b".repeat(64) }; else f.state.boot = "other-boot";
    await expect(f.service.openAttempt(f.actor, { vmId: "vm", workId: "work", attemptId: "attempt" })).rejects.toMatchObject({ code: "vm_identity_unproven" });
    expect(f.writes.size).toBe(0); expect(f.s.registration("vm").state).toBe("uncertain");
  }
});

test("late revoked results stay unpublished, and unknown whole-machine stop does not upgrade cooperative evidence", async () => {
  const f = serviceFixture(), session = await f.service.openAttempt(f.actor, { vmId: "vm", workId: "work", attemptId: "attempt" });
  const path = await session.transfer!.put({ id: "input", name: "file", bytes: new Uint8Array([7]) });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.readBarrier(async () => { entered.resolve(); await release.promise; });
  const result = session.transfer!.take(path).catch(error => error); await entered.promise; f.revoke(); release.resolve();
  expect(await result).toBeInstanceOf(Error); await session.close();
  expect(f.s.evidence(session.id).at(-1)?.published).toBe(false);
  const g = serviceFixture(), second = await g.service.openAttempt(g.actor, { vmId: "vm", workId: "work", attemptId: "attempt" });
  await second.close(); g.unknownStop(); await expect(g.service.recover(g.actor, { vmId: "vm" })).rejects.toThrow("unknown stop");
  expect(g.s.registration("vm").state).toBe("uncertain");
  expect(g.s.evidence(second.id).every(e => e.execution === "guest_scope_empty")).toBe(true);
});
