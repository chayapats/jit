import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../../errors';
import type { VmHostCommand, VmMachineState } from '../types';
import { vmCanonical, vmRecord } from '../validation';
import { BoundFirecrackerComputer } from './bound';
import { FirecrackerColdStore, type FirecrackerColdContext, type FirecrackerColdControl, type FirecrackerColdManifest } from './cold';
import { firecrackerNativeHost, FirecrackerHostLease, type FirecrackerHostFixture, type FirecrackerHostReadPort, type FirecrackerHostSelection } from './custody';
import { firecrackerProcessStartTicks } from './process';
import { FirecrackerHostJobs, type FirecrackerHostCommand, type FirecrackerHostJob, type FirecrackerHostJobDriver, type FirecrackerHostJournal, type FirecrackerJobObservation } from './jobs';
import { firecrackerLaunchPlan } from './launch';
import type { FirecrackerHostLock } from './lock';
import { FirecrackerHostPreparation } from './prepare';
import { FirecrackerLaunchUnits } from './units';

type Disk = FirecrackerHostSelection['disk'];
type Execute = Parameters<FirecrackerHostJobDriver['execute']>[1];
type Recover = Parameters<FirecrackerHostJobDriver['readBack']>[1];
interface Launch { requestId: string; invocationId: string; process: FirecrackerHostSelection['process'] }
interface Instance { contract: 's16-firecracker-instance/v1'; selectionSha256: string; disk: Disk; launch: Launch | null }
interface Context {
  contract: 's16-firecracker-runtime-job/v1'; before: Instance; wasRunning: boolean;
  cold: FirecrackerColdContext | null; coldDone: boolean;
  launch: { requestId: string; observed: Launch | null } | null;
}
/** Actual Linux/root helper selection. Every injected native seam stays explicitly protocol_fixture. */
export interface FirecrackerRuntimeOptions {
  journal: FirecrackerHostJournal; owner?: FirecrackerHostLock;
  selection: Omit<FirecrackerHostSelection, 'process'>; guestPort: number; listenPort: number;
  /** Current installed selection/enrollment, independent of a transient work actor. Must be synchronous. */
  guard(): void;
  fixture?: {
    basis: 'protocol_fixture'; host: FirecrackerHostFixture; command: VmHostCommand;
    cold: { rootDirectory: string; recoveryDirectory: string };
    removeSocket(path: string): void | Promise<void>;
  };
}
function fail(): never { throw new AppError('vm_firecracker_management_unavailable', 503); }
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const same = (a: unknown, b: unknown) => vmCanonical(a) === vmCanonical(b);

/**
 * One installed computer's protected manager. Durable original context composes actual systemd launch,
 * process/jail/API custody, fixed SSH/vsock forwarding and atomic cold recovery. It owns no Jit policy,
 * model loop or work actor. Callers retain original command IDs and separately authorize every request.
 * Closing releases transports only; it never stops a VM or clears an unknown journal reservation.
 */
export class FirecrackerHostRuntime {
  readonly basis: FirecrackerJobObservation['basis'];
  readonly computerId: string;
  readonly selectionSha256: string;
  readonly #base: FirecrackerRuntimeOptions['selection'];
  readonly #journal: FirecrackerHostJournal;
  readonly #jobs: FirecrackerHostJobs;
  readonly #owner: FirecrackerHostLock | undefined;
  readonly #guard: () => void;
  readonly #host: FirecrackerHostReadPort;
  readonly #fixture: FirecrackerRuntimeOptions['fixture'];
  readonly #guestPort: number;
  readonly #listenPort: number;
  #bound: BoundFirecrackerComputer | null = null;
  #binding: Promise<BoundFirecrackerComputer> | null = null;
  #inspecting: Promise<VmMachineState> | null = null;
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;
  constructor(options: FirecrackerRuntimeOptions) {
    this.#base = structuredClone(options.selection); this.#journal = options.journal; this.#owner = options.owner; this.#guard = options.guard; this.#fixture = options.fixture;
    if (typeof this.#guard !== 'function' || options.fixture && options.fixture.basis !== 'protocol_fixture' || !Number.isSafeInteger(options.guestPort) || options.guestPort < 1 || options.guestPort >= 0xffffffff || !Number.isSafeInteger(options.listenPort) || options.listenPort < (options.fixture ? 0 : 1) || options.listenPort > 65535) fail();
    this.#guestPort = options.guestPort; this.#listenPort = options.listenPort; this.basis = options.fixture ? 'protocol_fixture' : 'protected_host';
    this.#preparation(this.#base.disk, () => this.#current());
    this.#host = options.fixture?.host ?? firecrackerNativeHost(); this.computerId = this.#base.profile.instanceId;
    this.selectionSha256 = createHash('sha256').update(vmCanonical({ contract: 's16-firecracker-host-selection/v1', profile: this.#base.profile, host: this.#base.host, pins: this.#base.pins, disk: { bytes: this.#base.disk.bytes, initialSha256: this.#base.disk.initialSha256 } })).digest('hex');
    this.#current(); this.#journal.enableInstances();
    this.#journal.db.transaction(() => {
      const known = this.#journal.db.query('SELECT id FROM fc_computers WHERE id=?').get(this.computerId);
      const computer = this.#journal.register({ id: this.computerId, selectionSha256: this.selectionSha256, diskBytes: this.#base.disk.bytes, basis: this.basis });
      if (!this.#journal.db.query('SELECT computer_id FROM fc_instances WHERE computer_id=?').get(this.computerId)) {
        if (known && (computer.revision !== 1 || computer.state !== 'unverified' || computer.launchId !== null || computer.activeRequestId !== null || this.#journal.db.query('SELECT request_id FROM fc_jobs WHERE computer_id=? LIMIT 1').get(this.computerId))) fail();
        this.#journal.db.query('INSERT INTO fc_instances VALUES (?,?)').run(this.computerId, vmCanonical({ contract: 's16-firecracker-instance/v1', selectionSha256: this.selectionSha256, disk: this.#base.disk, launch: null }));
      }
    }).immediate();
    this.#instance();
    const track = <T>(promise: Promise<T>): Promise<T> => { this.#pending.add(promise); void promise.then(() => this.#pending.delete(promise), () => this.#pending.delete(promise)); return promise; };
    const driver: FirecrackerHostJobDriver = { basis: this.basis, execute: (job, control) => track(this.#execute(job, control)), readBack: (job, control) => track(this.#readBack(job, control)) };
    this.#jobs = new FirecrackerHostJobs(this.#journal, driver, this.#owner);
  }
  #current(): void { if (this.#closed) fail(); this.#owner?.current(); this.#guard(); }
  #disk(value: unknown): Disk {
    const r = vmRecord(value, ['device', 'inode', 'bytes', 'initialSha256']);
    if (typeof r.device !== 'string' || !/^(?:0|[1-9][0-9]{0,39})$/.test(r.device) || typeof r.inode !== 'string' || !/^[1-9][0-9]{0,39}$/.test(r.inode) || r.bytes !== this.#base.disk.bytes || r.initialSha256 !== this.#base.disk.initialSha256) return fail();
    return { ...r } as Disk;
  }
  #launchRecord(value: unknown): Launch {
    const r = vmRecord(value, ['requestId', 'invocationId', 'process']), p = vmRecord(r.process, ['pid', 'startTicks', 'hostBootId']);
    if (!uuid(r.requestId) || !uuid(r.invocationId) || !Number.isSafeInteger(p.pid) || Number(p.pid) < 2 || Number(p.pid) > 0x7fffffff || typeof p.startTicks !== 'string' || !/^[1-9][0-9]{0,19}$/.test(p.startTicks) || typeof p.hostBootId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.hostBootId)) return fail();
    return { requestId: r.requestId, invocationId: r.invocationId, process: { pid: Number(p.pid), startTicks: p.startTicks, hostBootId: p.hostBootId } };
  }
  #record(value: unknown): Instance {
    const r = vmRecord(value, ['contract', 'selectionSha256', 'disk', 'launch']);
    if (r.contract !== 's16-firecracker-instance/v1' || r.selectionSha256 !== this.selectionSha256) return fail();
    return { contract: r.contract, selectionSha256: this.selectionSha256, disk: this.#disk(r.disk), launch: r.launch === null ? null : this.#launchRecord(r.launch) };
  }
  #instance(): Instance {
    this.#journal.assertInstances(); const row = this.#journal.db.query<{ data: string }, [string]>('SELECT data FROM fc_instances WHERE computer_id=?').get(this.computerId); if (!row) return fail(); return this.#record(JSON.parse(row.data));
  }
  #job(job: FirecrackerHostJob, recovery: boolean): void {
    this.#current(); if (job.command.computerId !== this.computerId || job.command.selectionSha256 !== this.selectionSha256) fail();
    if (recovery) this.#journal.recovering(job); else this.#journal.current(job);
  }
  #save(job: FirecrackerHostJob, before: Instance, after: Instance, recovery: boolean): void {
    this.#journal.db.transaction(() => { this.#job(job, recovery); const current = this.#instance(); if (!same(current, before) && !same(current, after)) fail(); this.#journal.db.query('UPDATE fc_instances SET data=? WHERE computer_id=?').run(vmCanonical(this.#record(after)), this.computerId); })();
  }
  #preparation(disk: Disk, guard: () => void): FirecrackerHostPreparation {
    return new FirecrackerHostPreparation({ selection: { ...this.#base, disk }, guard, ...(this.#owner ? { owner: this.#owner } : {}), ...(this.#fixture ? { fixture: this.#fixture.host } : {}) });
  }
  #selection(instance: Instance, disk = instance.disk): FirecrackerHostSelection {
    if (!instance.launch) return fail(); return { ...structuredClone(this.#base), disk: { ...disk }, process: { ...instance.launch.process } };
  }
  async #settled(instance: Instance, disk: Disk, guard: () => void | Promise<void>) {
    return FirecrackerHostLease.recoverStopped(this.#selection(instance, disk), { guard, ...(this.#fixture ? { fixture: this.#fixture.host } : {}) });
  }
  #cold(instance: Instance): FirecrackerColdStore {
    return new FirecrackerColdStore({ selection: { ...this.#base, disk: instance.disk }, ...(this.#fixture ? { fixture: { basis: 'protocol_fixture', ...this.#fixture.cold } } : {}) });
  }
  #coldControl(context: Context, control: Recover, record?: Execute['record']): FirecrackerColdControl {
    return { guard: control.guard, settled: disk => this.#settled(context.before, disk, control.guard), context: () => structuredClone(context.cold), record: value => { if (!record) return fail(); context.cold = structuredClone(value); record(structuredClone(context)); } };
  }
  #context(job: FirecrackerHostJob, value: unknown): Context {
    const r = vmRecord(value, ['contract', 'before', 'wasRunning', 'cold', 'coldDone', 'launch']), before = this.#record(r.before);
    if (r.contract !== 's16-firecracker-runtime-job/v1' || typeof r.wasRunning !== 'boolean' || r.wasRunning !== (this.#journal.startState(this.computerId, job.command.requestId) === 'running') || typeof r.coldDone !== 'boolean' || before.launch?.requestId !== (job.command.expectedLaunchId ?? undefined)) return fail();
    let launch: Context['launch'] = null;
    if (r.launch !== null) { const l = vmRecord(r.launch, ['requestId', 'observed']); if (l.requestId !== job.command.requestId) return fail(); launch = { requestId: job.command.requestId, observed: l.observed === null ? null : this.#launchRecord(l.observed) }; if (launch.observed && launch.observed.requestId !== job.command.requestId) return fail(); }
    if (r.cold !== null) {
      const c = vmRecord(r.cold, ['contract', 'kind', 'requestId', 'snapshotId', 'selectionSha256', 'before', 'manifest', 'replacement']);
      if (c.contract !== 's16-firecracker-cold-job/v1' || c.requestId !== job.command.requestId || !('snapshotId' in job.command) || c.snapshotId !== job.command.snapshotId || c.kind !== job.command.kind || c.selectionSha256 !== this.selectionSha256 || !same(c.before, before.disk)) return fail();
    }
    return { contract: r.contract, before, wasRunning: r.wasRunning, cold: structuredClone(r.cold) as FirecrackerColdContext | null, coldDone: r.coldDone, launch };
  }
  #units(job: FirecrackerHostJob, disk: Disk, recovery: boolean): FirecrackerLaunchUnits {
    return new FirecrackerLaunchUnits({ profile: this.#base.profile, host: this.#base.host,
      current: () => this.#job(job, recovery), preflight: () => this.#preparation(disk, () => this.#job(job, false)).verify(), ...(this.#fixture ? { fixture: this.#fixture.command } : {}) });
  }
  async #closeBound(): Promise<void> { if (this.#binding) { try { await this.#binding; } catch {} } const bound = this.#bound; this.#bound = null; if (bound) await bound.close(); }
  async #bind(instance: Instance, scope?: () => void | Promise<void>): Promise<BoundFirecrackerComputer> {
    if (!instance.launch || !same(instance, this.#instance())) return fail();
    if (this.#bound) return this.#bound;
    if (this.#binding) return this.#binding;
    this.#binding = (async () => {
      let opening = true;
      const guard = async () => {
        if (opening) await scope?.(); this.#current(); if (!same(instance, this.#instance())) fail();
        const active = this.current().activeRequestId;
        if (active) { const job = this.receipt(active); if (job.command.kind !== 'retire' && !(active === instance.launch?.requestId && ['launch', 'checkpoint'].includes(job.command.kind))) fail(); }
      };
      const bound = await BoundFirecrackerComputer.open({ selection: this.#selection(instance), guestPort: this.#guestPort, listenPort: this.#listenPort, guard, stopGuard: guard, ...(this.#fixture ? { fixture: this.#fixture.host } : {}) });
      try { await guard(); opening = false; this.#bound = bound; return bound; } catch (error) { await bound.close(); throw error; }
    })();
    try { return await this.#binding; } finally { this.#binding = null; }
  }
  #machine(instance: Instance): VmMachineState {
    const s = this.#base; return { state: 'stopped', identity: `firecracker:${this.computerId}`, boot: 'stopped', cpuCount: s.profile.cpuCount, memoryBytes: s.profile.memoryMiB * 1048576, diskBytes: instance.disk.bytes, network: 'unproven',
      binding: { kind: 'firecracker-vsock', instanceId: this.computerId, guestCid: s.profile.guestCid, guestPort: this.#guestPort, selectionSha256: this.selectionSha256 } };
  }
  async #observe(instance: Instance, guard: () => void | Promise<void>): Promise<VmMachineState> {
    await guard();
    if (!instance.launch) { this.#preparation(instance.disk, () => this.#current()).verify(); await guard(); return this.#machine(instance); }
    try { const state = await (await this.#bind(instance, guard)).inspect(); await guard(); return state; }
    catch { await this.#closeBound(); await this.#settled(instance, instance.disk, guard); await guard(); return this.#machine(instance); }
  }
  async #stop(context: Context, control: Execute): Promise<void> {
    await control.guard(); await this.#closeBound();
    if (!context.wasRunning) { if (context.before.launch) await this.#settled(context.before, context.before.disk, control.guard); else this.#preparation(context.before.disk, () => this.#current()).verify(); return; }
    const lease = await FirecrackerHostLease.open(this.#selection(context.before), { guard: control.guard, ...(this.#fixture ? { fixture: this.#fixture.host } : {}) });
    try { await control.guard(); await lease.stop({ guard: control.guard }); } finally { lease.close(); }
  }
  async #clearSockets(context: Context, control: Execute): Promise<void> {
    if (!context.before.launch) return;
    await this.#settled(context.before, context.before.disk, control.guard); const directory = join(firecrackerLaunchPlan(this.#base.profile, this.#base.host).rootDirectory, 'run');
    for (const name of this.#host.list(directory, 2)) {
      await control.guard(); if (!['api.sock', 'vsock.sock'].includes(name)) return fail(); const path = join(directory, name), m = this.#host.metadata(path);
      if (m.kind !== 'socket' || m.uid !== this.#base.host.uid || m.gid !== this.#base.host.gid || m.mode & 0o7077) return fail();
      if (this.#fixture) await this.#fixture.removeSocket(path); else unlinkSync(path);
    }
    await control.guard();
  }
  async #unitLaunch(job: FirecrackerHostJob, context: Context, control: Execute): Promise<Instance> {
    await control.guard(); context.launch = { requestId: job.command.requestId, observed: null }; control.record(structuredClone(context));
    await this.#clearSockets(context, control); await control.guard();
    const units = this.#units(job, context.before.disk, false);
    if ((await units.inspect(job.command.requestId)).state !== 'missing') return fail();
    await units.launch(job.command.requestId); await control.guard();
    const deadline = performance.now() + 15000;
    for (;;) {
      try { const instance = await this.#readRunning(job, context, control, false); context.launch.observed = instance.launch; control.record(structuredClone(context)); return instance; }
      catch (error) {
        await control.guard();
        // The fixed foreground launcher can still be dropping IDs/creating sockets. Only original
        // read-only readiness acquisition repeats; every publication still requires full custody.
        if (!(error instanceof AppError) || !['vm_firecracker_unavailable', 'vm_firecracker_custody_unproven'].includes(error.code) || performance.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - performance.now()))); await control.guard();
      }
    }
  }
  async #readRunning(job: FirecrackerHostJob, context: Context, control: Recover, recovery: boolean): Promise<Instance> {
    if (!context.launch) return fail(); await control.guard(); const status = await this.#units(job, context.before.disk, recovery).inspect(context.launch.requestId);
    if (status.state !== 'loaded' || status.active !== 'active' || status.sub !== 'running' || status.mainPid < 2) return fail();
    const text = (path: string, maximum: number) => { const bytes = this.#host.read(path, maximum); if (!bytes || bytes.length > maximum) return fail(); return new TextDecoder('utf-8', { fatal: true }).decode(bytes); };
    const launch: Launch = { requestId: job.command.requestId, invocationId: status.invocationId, process: { pid: status.mainPid, startTicks: firecrackerProcessStartTicks(text(`/proc/${status.mainPid}/stat`, 65536), status.mainPid), hostBootId: text('/proc/sys/kernel/random/boot_id', 128).trim() } };
    this.#launchRecord(launch); if (context.launch.observed && !same(context.launch.observed, launch)) return fail();
    const after: Instance = { ...context.before, launch };
    this.#save(job, context.before, after, recovery); await control.guard();
    try { await (await this.#bind(after, control.guard)).inspect(); await control.guard(); return after; } catch (error) { await this.#closeBound(); throw error; }
  }
  #facts(instance: Instance, state: 'running' | 'stopped', manifest?: FirecrackerColdManifest): FirecrackerJobObservation {
    return { state, launchId: instance.launch?.requestId ?? null, basis: this.basis, ...(manifest ? { snapshot: { id: manifest.snapshotId, bytes: manifest.bytes, sha256: manifest.sha256 } } : {}) };
  }
  async #execute(job: FirecrackerHostJob, control: Execute): Promise<FirecrackerJobObservation> {
    this.#job(job, false); if (control.context() !== null) return fail();
    const before = this.#instance(); if ((before.launch?.requestId ?? null) !== job.command.expectedLaunchId) return fail();
    const context: Context = { contract: 's16-firecracker-runtime-job/v1', before, wasRunning: this.#journal.startState(this.computerId, job.command.requestId) === 'running', cold: null, coldDone: false, launch: null };
    control.record(structuredClone(context)); const kind = job.command.kind;
    if (kind === 'launch') return this.#facts(await this.#unitLaunch(job, context, control), 'running');
    if (kind === 'retire') {
      await this.#cold(before).retire(job.command.requestId, job.command.snapshotId, this.#coldControl(context, control, control.record)); context.coldDone = true; control.record(structuredClone(context));
      const machine = await this.#observe(before, control.guard); return this.#facts(before, machine.state);
    }
    await this.#stop(context, control);
    if (kind === 'stop') return this.#facts(before, 'stopped');
    if (!('snapshotId' in job.command)) return fail();
    if (kind === 'checkpoint') {
      const manifest = await this.#cold(before).checkpoint(job.command.requestId, job.command.snapshotId, this.#coldControl(context, control, control.record)); context.coldDone = true; control.record(structuredClone(context));
      return this.#facts(context.wasRunning ? await this.#unitLaunch(job, context, control) : before, context.wasRunning ? 'running' : 'stopped', manifest);
    }
    const replacement = await this.#cold(before).restore(job.command.requestId, job.command.snapshotId, this.#coldControl(context, control, control.record)); context.coldDone = true; control.record(structuredClone(context));
    const after = { ...before, disk: replacement }; this.#save(job, before, after, false); await control.guard(); return this.#facts(after, 'stopped');
  }
  async #readBack(job: FirecrackerHostJob, control: Recover): Promise<FirecrackerJobObservation | null> {
    this.#job(job, true); const raw = control.context(); if (raw === null) return null; const context = this.#context(job, raw), kind = job.command.kind;
    if (kind === 'launch') return this.#facts(await this.#readRunning(job, context, control, true), 'running');
    if (kind === 'stop') { if (context.before.launch) await this.#settled(context.before, context.before.disk, control.guard); else this.#preparation(context.before.disk, () => this.#job(job, true)).verify(); return this.#facts(context.before, 'stopped'); }
    if (!context.cold) return null;
    const cold = this.#cold(context.before), port = this.#coldControl(context, control);
    if (kind === 'checkpoint') {
      const manifest = context.coldDone && context.cold.manifest ? await cold.inspectSnapshot(context.cold.manifest, port) : await cold.readBack(context.cold, port);
      if (!manifest || manifest === true || !('sha256' in manifest)) return null;
      return this.#facts(context.wasRunning ? await this.#readRunning(job, context, control, true) : context.before, context.wasRunning ? 'running' : 'stopped', manifest);
    }
    const result = await cold.readBack(context.cold, port); if (result === null) return null;
    if (kind === 'retire') { if (result !== true) return fail(); const machine = await this.#observe(context.before, control.guard); return this.#facts(context.before, machine.state); }
    if (result === true || !('inode' in result)) return fail(); const after = { ...context.before, disk: this.#disk(result) };
    this.#save(job, context.before, after, true); await control.guard(); return this.#facts(after, 'stopped');
  }
  /** Current protected metadata; no host paths, original process selector or private recovery context. */
  current() { this.#current(); return this.#journal.computer(this.computerId); }
  /** Protected IPC identity check only; this is not a guest/model selector or serialized permission. */
  controllerIdentity(): { uid: number; gid: number } { this.#current(); return { uid: this.#base.host.controllerUid, gid: this.#base.host.controllerGid }; }
  /** Original exact submission. Native admission/driver/publication remain under the current protected guard. */
  submit(command: FirecrackerHostCommand, options: { timeoutMs?: number } = {}): Promise<FirecrackerHostJob> {
    this.#current(); if (command.computerId !== this.computerId) return Promise.reject(new AppError('vm_firecracker_management_unavailable', 503)); return this.#jobs.run(command, () => this.#current(), options);
  }
  /** Existing original receipt only; no execution or replacement command is accepted. */
  receipt(requestId: string): FirecrackerHostJob { this.#current(); return this.#journal.receipt(this.computerId, requestId); }
  /** One original unknown read-back, never a repeated native effect. */
  reconcile(requestId: string): Promise<FirecrackerHostJob> { this.#current(); return this.#jobs.reconcile(this.computerId, requestId, () => this.#current()); }
  /** Actual current machine. An unsettled original job cannot be hidden by an ordinary observation. */
  async inspect(): Promise<VmMachineState> {
    this.#current(); if (this.current().activeRequestId) return fail(); if (this.#inspecting) return this.#inspecting;
    this.#inspecting = (async () => {
      const before = this.#instance(), computer = this.current(), machine = await this.#observe(before, () => this.#current()); this.#current();
      if (!same(before, this.#instance()) || computer.revision !== this.current().revision || this.current().activeRequestId) return fail();
      this.#journal.observe(this.computerId, this.#facts(before, machine.state)); return machine;
    })();
    try { return await this.#inspecting; } finally { this.#inspecting = null; }
  }
  /** Fences new requests and closes only ephemeral API/SSH observation. Systemd retains the original VM. */
  async close(): Promise<void> { if (this.#closed) return; this.#closed = true; await this.#closeBound(); await Promise.allSettled([...this.#pending]); }
}
