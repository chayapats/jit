import { afterEach, expect, test } from "bun:test";
import { AppError } from "../src/errors";
import { LocalVmProvisioning, type LocalVmProvisionStep } from "../src/s15/vm/provisioning";
import { probeLocalVmHost, type LocalVmHostProbe, type LocalVmHostReadiness } from "../src/s15/vm/local";
import { VmStore } from "../src/s15/vm/store";
import type { QemuProvisionStep } from "../src/s15/vm/qemu";
import type { VmStatus } from "../src/s15/vm/types";
import { setupComputer } from "../src/s15/main";

// SETUP15-01: protected host-capability probe and the durable, restart-safe provisioning job.
const GiB = 1_073_741_824;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });

function probe(extra: Partial<{ platform: string; arch: string; kvm: boolean; exists: boolean; tools: boolean; cpus: number; memory: number; total: number; free: number }> = {}): LocalVmHostProbe {
  const f = { platform: "linux", arch: "x64", kvm: true, exists: true, tools: true, cpus: 10, memory: 20 * GiB, total: 200 * GiB, free: 150 * GiB, ...extra };
  return { platform: () => f.platform, arch: () => f.arch, kvm: () => f.kvm, exists: () => f.exists, executable: () => f.tools, readable: () => f.tools, cpus: () => f.cpus, memoryBytes: () => f.memory, disk: () => ({ total: f.total, free: f.free }) };
}

test("host detection fixtures name exactly one missing item and never infer readiness from configuration", () => {
  expect(probeLocalVmHost("/protected", probe())).toMatchObject({ state: "ready", resources: { cpus: 5, memoryMiB: 9216, diskGiB: 60 } });
  expect(probeLocalVmHost("/protected", probe({ kvm: false, exists: false }))).toMatchObject({ state: "missing", code: "vm_kvm_unavailable" });
  expect(probeLocalVmHost("/protected", probe({ kvm: false, exists: true }))).toMatchObject({ state: "missing", code: "vm_kvm_denied" });
  expect(probeLocalVmHost("/protected", probe({ tools: false }))).toMatchObject({ state: "missing", code: "vm_qemu_missing" });
  expect(probeLocalVmHost("/protected", probe({ free: 40 * GiB }))).toMatchObject({ state: "missing", code: "vm_disk_insufficient" });
  expect(probeLocalVmHost("/protected", probe({ cpus: 2, memory: 8 * GiB }))).toMatchObject({ state: "missing", code: "vm_host_too_small" });
  expect(probeLocalVmHost("/protected", probe({ platform: "darwin" }))).toMatchObject({ state: "missing", code: "vm_host_unsupported", facts: null });
  expect(probeLocalVmHost("/protected", probe({ arch: "ia32" }))).toMatchObject({ state: "missing", code: "vm_host_unsupported" });
  // An older probe without platform/exists still works: a closed /dev/kvm reads as unavailable.
  const { platform: _p, exists: _e, ...legacy } = probe({ kvm: false });
  expect(probeLocalVmHost("/protected", legacy)).toMatchObject({ state: "missing", code: "vm_kvm_unavailable" });
});

const status = (id: string): VmStatus => ({ id, generation: 1, state: "ready", networkIsolated: true, recoveryAvailable: true, activeSessions: 0, maxSessions: 2, reason: null, capabilities: [], facts: null });
/**
 * Scripted local manager with the real store and a fake clock. `fail` throws at one step once; `crash` aborts
 * there (a controller stop). Like the real manager it caches a verified image and reuses a finished guest.
 */
function harness(options: { host?: () => LocalVmHostReadiness; path?: string } = {}) {
  const store = new VmStore(options.path ?? ":memory:"); let now = 1_000;
  const counts = { managers: 0, downloads: 0, disks: 0, boots: 0, removed: 0 };
  let managerId: string | null = null, imageCached = false, guest: "none" | "partial" | "ready" = "none";
  const fault: { fail?: { step: QemuProvisionStep | "checks"; code: string }; crash?: QemuProvisionStep | "checks" } = {};
  const seen: LocalVmProvisionStep[] = [];
  const make = () => new LocalVmProvisioning({ store, vmId: "working", now: () => now, heartbeat: () => () => {},
    host: options.host ?? (() => probeLocalVmHost("/protected", probe())),
    manager: () => { if (!managerId) { counts.managers++; managerId = `manager_${counts.managers}`; } return managerId; },
    async enroll(input) {
      const step = async (name: QemuProvisionStep | "checks") => {
        input.progress(name); now += 1_000;
        if (fault.crash === name) { delete fault.crash; job.close(); await Promise.resolve(); throw new DOMException("Aborted", "AbortError"); }
        if (fault.fail?.step === name) { const code = fault.fail.code; delete fault.fail; throw new AppError(code, 503); }
      };
      if (!imageCached) { await step("download"); counts.downloads++; }
      await step("checksum"); imageCached = true;
      if (guest !== "ready") { if (guest === "partial") counts.removed++; await step("disk"); guest = "partial"; counts.disks++; await step("boot"); counts.boots++; await step("connect"); guest = "ready"; }
      await step("checks");
      store.save({ id: input.id, generation: 1, endpoint: { host: "127.0.0.1", port: 22122, user: "jit", identityFile: "/k", knownHostsFile: "/h" }, managerId: input.managerId, state: "ready", networkCheckedAt: now, networkIsolated: true, maxSessions: 2, reason: null, machineIdentity: "m", boot: "b", bindingMac: "52:54:00:00:00:01" });
      return status(input.id);
    } });
  let job = make();
  const record = () => { const view = job.view(); if (view && seen.at(-1) !== view.step) seen.push(view.step); };
  cleanups.push(async () => { await job.close(); store.close(); });
  return { store, counts, fault, seen, record, get job() { return job; }, restart() { job = make(); return job; }, advance(ms: number) { now += ms; }, get now() { return now; } };
}

test("happy path reaches enrolled through every step with a durable projection and a fake clock", async () => {
  const h = harness();
  const started = h.job.ensure();
  expect(started).toMatchObject({ contract: "s15-vm-provisioning/v1", vmId: "working", state: "running", step: "host", active: true, attempts: 1 });
  await h.job.settled();
  expect(h.job.view()).toMatchObject({ state: "enrolled", step: "enrolled", error: null, failedStep: null, managerId: "manager_1", active: false });
  expect(h.job.view()!.finishedAt! - h.job.view()!.startedAt).toBe(6_000);
  expect(h.store.db.query("SELECT id FROM vm_registry").all()).toEqual([{ id: "working" }]);
  expect(h.counts).toMatchObject({ managers: 1, downloads: 1, disks: 1, boots: 1 });
});

test("progress is recorded per step: the CLI prints each step and the final state as JSON", async () => {
  const h = harness(), lines: Record<string, unknown>[] = [];
  const final = await setupComputer(h.job, line => lines.push(line), async () => { await h.job.settled(); });
  expect(final).toEqual({ state: "enrolled", vmId: "working" });
  expect(lines[0]).toEqual({ state: "s15_computer_progress", step: "host" });
  // Re-running setup with the default computer already enrolled starts nothing.
  const again: Record<string, unknown>[] = [];
  expect(await setupComputer(h.restart(), line => again.push(line))).toEqual({ state: "enrolled", vmId: "working" });
  expect(again).toEqual([]); expect(h.counts.managers).toBe(1);
});

test("a checksum failure stops at verify with its code and waits for the owner's Try again", async () => {
  const h = harness(); h.fault.fail = { step: "checksum", code: "vm_image_unverified" };
  h.job.ensure(); await h.job.settled();
  expect(h.job.view()).toMatchObject({ state: "failed", step: "checksum", failedStep: "checksum", error: "vm_image_unverified", active: false });
  // Automatic triggers never loop on a failed job; only an explicit start re-runs it.
  h.job.ensure(); expect(h.job.view()!.state).toBe("failed"); h.restart().ensure(); expect(h.job.view()!.state).toBe("failed");
  expect(h.store.db.query("SELECT id FROM vm_registry").all()).toHaveLength(0);
});

test("a failure at boot is retried from boot: earlier steps are re-verified, not redone", async () => {
  const h = harness(); h.fault.fail = { step: "boot", code: "vm_management_unavailable" };
  h.job.ensure(); await h.job.settled();
  expect(h.job.view()).toMatchObject({ state: "failed", failedStep: "boot", error: "vm_management_unavailable" });
  h.advance(60_000);
  const retry = h.job.start();
  expect(retry).toMatchObject({ state: "running", step: "boot", attempts: 2, error: null, startedAt: h.now });
  await h.job.settled();
  expect(h.job.view()).toMatchObject({ state: "enrolled", attempts: 2 });
  // The verified image was not downloaded again; the half-made guest was removed and rebuilt once.
  expect(h.counts).toMatchObject({ managers: 1, downloads: 1, removed: 1 });
});

for (const step of ["download", "checksum", "disk", "boot", "connect", "checks"] as const) test(`a controller restart during ${step} resumes without a second VM or manager`, async () => {
  const h = harness(); h.fault.crash = step;
  h.job.ensure(); await h.job.settled();
  // The stop left the job running for the next boot; no live runner holds it now.
  expect(h.job.view()).toMatchObject({ state: "running", step, active: false });
  const resumed = h.restart(); expect(resumed.ensure()).toMatchObject({ state: "running", active: true, attempts: 1 });
  await resumed.settled();
  expect(resumed.view()).toMatchObject({ state: "enrolled", attempts: 1 });
  expect(h.counts.managers).toBe(1); expect(h.store.db.query("SELECT id FROM vm_registry").all()).toEqual([{ id: "working" }]);
  // A guest that never finished was removed by its exact path and recreated, never kept half-made.
  const halfMade = ["boot", "connect"].includes(step);
  // An image whose checksum was never confirmed is discarded and downloaded again; a verified one is kept.
  expect(h.counts).toMatchObject({ disks: halfMade ? 2 : 1, removed: halfMade ? 1 : 0, downloads: step === "checksum" ? 2 : 1 });
});

test("a live runner in another process is never duplicated; a dead one is resumed", async () => {
  const h = harness(); let alive = true;
  const other = () => new LocalVmProvisioning({ store: h.store, vmId: "working", now: () => h.now, heartbeat: () => () => {}, alive: () => alive,
    host: () => probeLocalVmHost("/protected", probe()), manager: () => "manager_x", enroll: async () => { throw new Error("must not run"); } });
  h.store.db.exec("CREATE TABLE IF NOT EXISTS vm_provisioning (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  h.store.db.query("INSERT INTO vm_provisioning VALUES ('working', ?)").run(JSON.stringify({ contract: "s15-vm-provisioning/v1", vmId: "working", managerId: null, state: "running", step: "connect", failedStep: null, error: null, attempts: 1, startedAt: 1, stepStartedAt: 1, updatedAt: h.now, finishedAt: null, runner: { pid: process.pid + 100000, token: "elsewhere" }, heartbeatAt: h.now }));
  const watcher = other(); cleanups.push(() => watcher.close());
  expect(watcher.ensure()).toMatchObject({ state: "running", step: "connect", active: true }); expect(watcher.start()).toMatchObject({ active: true });
  alive = false; expect(watcher.view()!.active).toBe(false);
  const resumed = h.restart(); resumed.ensure(); await resumed.settled(); expect(resumed.view()!.state).toBe("enrolled");
});

test("re-running setup with an existing default computer creates no job", async () => {
  const h = harness();
  h.store.save({ id: "working", generation: 1, endpoint: { host: "vm.test", port: 22, user: "jit", identityFile: "/k", knownHostsFile: "/h" }, managerId: null, state: "ready", networkCheckedAt: 1, networkIsolated: true, maxSessions: 2, reason: null, machineIdentity: null, boot: null });
  expect(h.job.ensure()).toBeNull(); expect(h.job.start()).toBeNull(); expect(h.counts.managers).toBe(0);
});

test("without KVM no job starts; the explicit start records the specific host code at the host step", async () => {
  const h = harness({ host: () => probeLocalVmHost("/protected", probe({ kvm: false, exists: false })) });
  expect(h.job.ensure()).toBeNull();
  h.job.start(); await h.job.settled();
  expect(h.job.view()).toMatchObject({ state: "failed", failedStep: "host", error: "vm_kvm_unavailable" }); expect(h.counts.managers).toBe(0);
});
