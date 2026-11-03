import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VmPool, placeWorkingVm } from "../src/s15/vm/pool";
import { VmStore, type VmRegistration } from "../src/s15/vm/store";
import { WorkingVmService } from "../src/s15/vm/service";
import { VmSshTransport } from "../src/s15/vm/transport";
import type { VmManagement, VmPolicyPort, VmSession, WorkingVmPort } from "../src/s15/vm/types";

// POOL15-01: protected placement across several enrolled working computers.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
const endpoint = { host: "vm.example.test", port: 22, user: "jit", identityFile: "/protected/key", knownHostsFile: "/protected/known" };
const row = (id: string, extra: Partial<VmRegistration> = {}): VmRegistration => ({ id, generation: 1, endpoint, managerId: `mgr_${id}`, state: "ready", networkCheckedAt: 1, networkIsolated: true, maxSessions: 2, reason: null, machineIdentity: `machine_${id}`, boot: "boot1", bindingMac: "52:54:00:12:34:56", ...extra });
function store(path = ":memory:") { const s = new VmStore(path); cleanups.push(() => s.close()); return s; }
let session = 0;
const busy = (s: VmStore, vm: string, mode: "work" | "system" = "work") => s.db.query("INSERT INTO vm_sessions VALUES (?,?,?,?,?,?,?,?)").run(`s${++session}`, vm, `w${session}`, `a${session}`, mode, "active", "unit", 1);

test("placement: loads 1/2 and 0/2 choose the second; ties go to the default member; affinity overrides load", () => {
  const s = store(), pool = new VmPool({ store: s, id: "a" });
  s.save(row("a")); s.save(row("b"));
  expect(pool.place("w_new")).toBe("a"); // 0/2 and 0/2: default member wins the tie.
  busy(s, "a");
  expect(pool.place("w_new")).toBe("b"); // 1/2 versus 0/2.
  pool.bind("w_bound", "a"); busy(s, "b"); busy(s, "b", "work");
  s.save(row("b", { maxSessions: 4 }));
  expect(pool.place("w_new")).toBe("a"); // 1/2 (50%) beats 2/4 only by the default tie-break; equal ratio.
  busy(s, "a");
  expect(pool.place("w_new")).toBe("b"); // a full (2/2), b 2/4.
  expect(pool.place("w_bound")).toBe("a"); // The workspace lives on a; load never moves it.
  expect(pool.bind("w_bound", "b")).toBe("a"); // The first binding wins and is never moved.
});

test("placement: all full returns the single-VM capacity refusal; system sessions are exclusive", () => {
  const s = store(), pool = new VmPool({ store: s, id: "a" });
  s.save(row("a", { maxSessions: 1 })); s.save(row("b"));
  busy(s, "a"); busy(s, "b", "system");
  expect(() => pool.place("w")).toThrow(expect.objectContaining({ code: "vm_capacity" }));
  // The runtime ceiling also applies to every member.
  const tight = new VmPool({ store: s, id: "a", maxSessions: 1 }); s.db.exec("DELETE FROM vm_sessions"); busy(s, "a"); busy(s, "b");
  expect(() => tight.place("w")).toThrow(expect.objectContaining({ code: "vm_capacity" }));
});

test("placement excludes fenced, uncertain, stopped, unbound and drained members; bound work reports the boundary", () => {
  const s = store(), pool = new VmPool({ store: s, id: "a" });
  s.save(row("a", { state: "uncertain", reason: "vm_stop_unconfirmed" })); s.save(row("b", { state: "stopped" })); s.save(row("c", { networkIsolated: false, state: "unproven" }));
  const unbound = row("d"); delete unbound.bindingMac; s.save(unbound); s.save(row("e"));
  expect(pool.place("w")).toBe("e");
  pool.setDrained("e", true);
  expect(() => pool.place("w")).toThrow(expect.objectContaining({ code: "vm_drained" }));
  s.save(row("e", { state: "uncertain" }));
  // No ready member at all: the default member's own service refusal applies, exactly as for one VM.
  expect(pool.place("w")).toBe("a");
  pool.bind("w_on_b", "b"); expect(() => pool.place("w_on_b")).toThrow(expect.objectContaining({ code: "vm_stopped" }));
  // Work bound to a drained member keeps returning to it; draining never evicts.
  s.save(row("e")); pool.bind("w_on_e", "e"); expect(pool.place("w_on_e")).toBe("e");
  pool.setDrained("e", false); expect(pool.place("w_new")).toBe("e");
  expect(() => pool.setDrained("missing", true)).toThrow(expect.objectContaining({ code: "vm_not_enrolled" }));
});

test("a fresh pool with nothing enrolled names its default member and gives the next owner-supplied id", () => {
  const s = store(), pool = new VmPool({ store: s, id: "working" });
  expect(pool.place("w")).toBe("working"); expect(pool.nextId()).toBe("working");
  expect(pool.nextId(true)).toMatch(/^computer_[a-f0-9]{8}$/);
  s.save(row("working")); expect(pool.nextId()).toMatch(/^computer_[a-f0-9]{8}$/);
  expect(pool.members()).toEqual([{ id: "working", isDefault: true, drained: false, activeSessions: 0, capacity: 2, works: 0 }]);
});

test("work affinity and drain state persist across a controller restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "jit-s15-pool-")); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "vm.sqlite"), first = new VmStore(path);
  first.save(row("a")); first.save(row("b"));
  const pool = new VmPool({ store: first, id: "a" }); pool.bind("w", "b"); pool.setDrained("a", true); first.close();
  const reopened = store(path), again = new VmPool({ store: reopened, id: "a" });
  expect(again.holder("w")).toBe("b"); expect(again.place("w")).toBe("b"); expect(again.place("other")).toBe("b");
  expect(again.members().map(m => [m.id, m.drained, m.works])).toEqual([["a", true, 0], ["b", false, 1]]);
});

test("the placing port refuses member ids, binds only execution sessions and serialises one work's first placement", async () => {
  const s = store(), pool = new VmPool({ store: s, id: "pool" }); s.save(row("pool")); s.save(row("b"));
  const opened: string[] = []; let release!: () => void, hold = false; const gate = new Promise<void>(resolve => { release = resolve; });
  const inner: WorkingVmPort = { async openAttempt(_actor, input) { opened.push(input.vmId); busy(s, input.vmId); if (hold) { hold = false; await gate; } return { id: input.vmId } as unknown as VmSession; } };
  const port = placeWorkingVm(inner, pool);
  await expect(port.openAttempt({}, { vmId: "b", workId: "w", attemptId: "a" })).rejects.toMatchObject({ code: "vm_policy_denied" });
  const inspect = await port.openAttempt({}, { vmId: "pool", workId: "peek", attemptId: "a", access: "inspect" });
  expect(inspect.id).toBe("pool"); expect(pool.holder("peek")).toBeNull();
  // Two first attempts of one work: the second waits for the first placement and lands on the same member.
  s.db.exec("DELETE FROM vm_sessions"); opened.length = 0; hold = true;
  const one = port.openAttempt({}, { vmId: "pool", workId: "w", attemptId: "a1" }), two = port.openAttempt({}, { vmId: "pool", workId: "w", attemptId: "a2" });
  await Promise.resolve(); release();
  await Promise.all([one, two]);
  // Without serialisation the second attempt would have gone to the less loaded member b.
  expect(opened).toEqual(["pool", "pool"]); expect(pool.holder("w")).toBe("pool");
});

/** Two real `WorkingVmService` VMs with scripted transports and separate fake hypervisors. */
function service() {
  const s = store(), actor = {}, snapshots: Record<string, number> = { a: 0, b: 0 };
  const policy: VmPolicyPort = { assertCurrent() {}, async claim() { return { async dispatch(start) { return start(); }, publish(consume) { return consume(); }, observe() {} }; } };
  const manager = (id: string): VmManagement => ({ async inspect() { return { state: "running", identity: `machine_${id}`, boot: "boot1", cpuCount: 2, memoryBytes: 1, diskBytes: 1, network: "isolated", nicMac: "52:54:00:12:34:56" }; },
    async stop() {}, async snapshot() { snapshots[id]!++; }, async restore() {}, async retireSnapshot() {} });
  class Transport extends VmSshTransport {
    override async control(argv: readonly string[]) { return argv.some(a => a.includes("nicMacs")) ? '{"nicMacs":["52:54:00:12:34:56"]}' : '{"reachable":[false,false,false,false,false,false]}'; }
    override async openScope(_unit: string, _ms: number, guard: () => void) { guard(); }
    override async closeScope() { return true; }
    override async invoke(request: Record<string, unknown>, settings: Parameters<VmSshTransport["invoke"]>[1]) { settings.beforeStart(); return request.op === "realpath" ? { path: request.path } : {}; }
  }
  s.save(row("a")); s.save(row("b"));
  const vm = new WorkingVmService({ store: s, policy, managers: new Map([["mgr_a", manager("a")], ["mgr_b", manager("b")]]), transport: () => new Transport(endpoint), now: () => 100, requireOwner: () => {} });
  const pool = new VmPool({ store: s, id: "a" });
  return { s, vm, pool, port: placeWorkingVm(vm, pool), actor, snapshots };
}

test("system administration takes the exclusive slot and snapshot on the work's member only; the other keeps serving", async () => {
  const f = service();
  f.pool.bind("admin", "a");
  const system = await f.port.openAttempt(f.actor, { vmId: "a", workId: "admin", attemptId: "attempt_admin", mode: "system" });
  expect(f.snapshots).toEqual({ a: 1, b: 0 });
  // New work avoids the exclusively held member; a sibling bound to it waits with the capacity refusal.
  const other = await f.port.openAttempt(f.actor, { vmId: "a", workId: "other", attemptId: "attempt_other" });
  expect(f.pool.holder("other")).toBe("b");
  f.pool.bind("sibling", "a");
  await expect(f.port.openAttempt(f.actor, { vmId: "a", workId: "sibling", attemptId: "attempt_sibling" })).rejects.toMatchObject({ code: "vm_capacity" });
  const second = await f.port.openAttempt(f.actor, { vmId: "a", workId: "third", attemptId: "attempt_third" });
  expect(f.pool.holder("third")).toBe("b");
  await Promise.all([system.close(), other.close(), second.close()]);
  // Generations and snapshot fences moved on member a only.
  expect([f.s.registration("a").generation, f.s.registration("b").generation]).toEqual([2, 1]);
  expect(f.s.db.query<{ vm_id: string }, []>("SELECT vm_id FROM vm_snapshots").all()).toEqual([{ vm_id: "a" }]);
});

test("uncertainty on one member fences only that member", async () => {
  const f = service();
  const first = await f.port.openAttempt(f.actor, { vmId: "a", workId: "w1", attemptId: "attempt_w1" });
  f.s.save({ ...f.s.registration("a"), state: "uncertain", reason: "vm_stop_unconfirmed" });
  await expect(f.port.openAttempt(f.actor, { vmId: "a", workId: "w1", attemptId: "attempt_w1b" })).rejects.toMatchObject({ code: "vm_stop_unconfirmed" });
  const fresh = await f.port.openAttempt(f.actor, { vmId: "a", workId: "w2", attemptId: "attempt_w2" });
  expect(f.pool.holder("w2")).toBe("b"); expect(f.s.registration("b").state).toBe("ready");
  await fresh.close(); await first.close().catch(() => {});
});

test("an existing installation seeds affinity from recorded sessions, so old work keeps its computer when B is added", () => {
  const s = store();
  // Before the pool existed: work ran on A only (its first session is the workspace holder).
  s.save(row("a"));
  s.db.query("INSERT INTO vm_sessions VALUES (?,?,?,?,?,?,?,?)").run("old1", "a", "old_work", "chat_old_work", "work", "closed", "unit", 1);
  s.db.query("INSERT INTO vm_sessions VALUES (?,?,?,?,?,?,?,?)").run("old2", "a", "old_work", "chat_old_work", "work", "closed", "unit", 1);
  // The owner adds B; A is now busier, yet the old work returns to A.
  s.save(row("b")); busy(s, "a");
  const pool = new VmPool({ store: s, id: "a" });
  expect(pool.holder("old_work")).toBe("a"); expect(pool.place("old_work")).toBe("a");
  expect(pool.place("new_work")).toBe("b");
  // Seeding happens once, when the pool tables are created; reopening never rebinds or duplicates.
  s.db.query("INSERT INTO vm_sessions VALUES (?,?,?,?,?,?,?,?)").run("later", "b", "inspected_only", "a1", "work", "closed", "unit", 1);
  const again = new VmPool({ store: s, id: "a" });
  expect(again.holder("old_work")).toBe("a"); expect(again.holder("inspected_only")).toBeNull();
  // Exactly the two works that had sessions when the tables were created: old_work and the busy work on A.
  expect(s.db.query<{ n: number }, []>("SELECT count(*) n FROM vm_affinity").get()!.n).toBe(2);
});
