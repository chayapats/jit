import { Database } from 'bun:sqlite';
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, normalize } from 'node:path';
import { AppError } from '../../../errors';
import { vmCanonical, vmInteger, vmRecord } from '../validation';
import { createHash } from 'node:crypto';
import { FirecrackerHostLock } from './lock';

/** Closed protected-helper mutation; neither argv, paths, environment nor a guest observation is input. */
export type FirecrackerHostCommand = {
  contract: 's16-firecracker-host-command/v1'; requestId: string; computerId: string;
  selectionSha256: string; expectedRevision: number; expectedLaunchId: string | null;
} & ({ kind: 'launch' | 'stop' } | { kind: 'checkpoint' | 'restore' | 'retire'; snapshotId: string });
/** Safe independently produced host facts. The journal stores these; it cannot manufacture them. */
export interface FirecrackerJobObservation {
  state: 'running' | 'stopped'; launchId: string | null; basis: 'protected_host' | 'protocol_fixture';
  snapshot?: { id: string; sha256: string; bytes: number };
}
/** Original immutable identity and monotonic result; no protected launch context is returned. */
export interface FirecrackerHostJob {
  command: FirecrackerHostCommand; revision: number; state: 'accepted' | 'dispatched' | 'unknown' | 'committed' | 'not_sent';
  observation: FirecrackerJobObservation | null;
}
/** Host helper's current computer fence. It is not a Jit policy or working-state ancestry grant. */
export interface FirecrackerJobComputer {
  id: string; selectionSha256: string; diskBytes: number; basis: FirecrackerJobObservation['basis'];
  revision: number; state: 'unverified' | 'running' | 'stopped' | 'busy' | 'uncertain'; launchId: string | null; activeRequestId: string | null;
}
interface JobRow { request_id: string; computer_id: string; hash: string; command: string; revision: number; before_state: string; state: FirecrackerHostJob['state']; observation: string | null; context: string | null }
const appId = 0x4a46484a, uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function fail(code = 'vm_firecracker_job_invalid', status = 409): never { throw new AppError(code, status); }
const computerId = (v: unknown): v is string => typeof v === 'string' && /^jit-work(?:-[a-z0-9-]{1,54})?$/.test(v);

/** Copies and validates the complete versioned command before asynchronous work or durable admission. */
export function firecrackerHostCommand(value: unknown): FirecrackerHostCommand {
  const r = vmRecord(value, ['contract', 'requestId', 'computerId', 'selectionSha256', 'expectedRevision', 'expectedLaunchId', 'kind'], ['snapshotId']);
  if (r.contract !== 's16-firecracker-host-command/v1' || !uuid(r.requestId) || !computerId(r.computerId) || !digest(r.selectionSha256) || r.expectedLaunchId !== null && !uuid(r.expectedLaunchId)) return fail();
  vmInteger(r.expectedRevision, Number.MAX_SAFE_INTEGER - 1);
  if (r.kind === 'launch' || r.kind === 'stop') { if (Object.hasOwn(r, 'snapshotId')) return fail(); }
  else if (typeof r.kind !== 'string' || !['checkpoint', 'restore', 'retire'].includes(r.kind) || typeof r.snapshotId !== 'string' || !/^jit-[a-f0-9]{32}$/.test(r.snapshotId)) return fail();
  return Object.freeze({ ...r }) as FirecrackerHostCommand;
}
function observation(value: unknown, computer: FirecrackerJobComputer): FirecrackerJobObservation {
  const r = vmRecord(value, ['state', 'launchId', 'basis'], ['snapshot']);
  if (typeof r.state !== 'string' || !['running', 'stopped'].includes(r.state) || r.launchId !== null && !uuid(r.launchId) || r.state === 'running' && r.launchId === null || r.basis !== computer.basis) return fail('vm_firecracker_job_observation_invalid');
  if (r.snapshot !== undefined) {
    const s = vmRecord(r.snapshot, ['id', 'sha256', 'bytes']);
    if (typeof s.id !== 'string' || !/^jit-[a-f0-9]{32}$/.test(s.id) || !digest(s.sha256) || s.bytes !== computer.diskBytes) return fail('vm_firecracker_job_observation_invalid');
  }
  return JSON.parse(vmCanonical(r));
}

/**
 * Protected helper intent/receipt journal, outside working disks and ordinary exports. All mutations are
 * synchronous transactions; no transaction spans host I/O. Its data never substitutes for host evidence.
 * The installed helper must hold its process-lifetime OS lock before restart recovery or dispatch.
 */
export class FirecrackerHostJournal {
  readonly db: Database;
  readonly #path: string;
  constructor(path: string, options: { create?: boolean } = {}) {
    this.#path = path;
    let fresh = path === ':memory:';
    if (path !== ':memory:') {
      if (!path.startsWith('/') || normalize(path) !== path) fail();
      const existing = lstatSync(path, { throwIfNoEntry: false });
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.mode & 0o077 || process.getuid && existing.uid !== process.getuid()) fail('vm_firecracker_journal_invalid');
        const fd = openSync(path, 'r'), header = Buffer.alloc(100);
        try { if (readSync(fd, header, 0, 100, 0) !== 100 || header.subarray(0, 16).toString() !== 'SQLite format 3\0' || header.readUInt32BE(68) !== appId || ![1, 2].includes(header.readUInt32BE(60))) fail('vm_firecracker_journal_invalid'); }
        finally { closeSync(fd); }
      } else { if (!options.create) fail('vm_firecracker_journal_missing'); fresh = true; mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
    }
    this.db = new Database(path, { create: options.create ?? path === ':memory:', strict: true });
    const version = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
    const application = this.db.query<{ application_id: number }, []>('PRAGMA application_id').get()!.application_id;
    if (fresh ? version !== 0 || application !== 0 : ![1, 2].includes(version) || application !== appId) { this.db.close(); fail('vm_firecracker_journal_invalid'); }
    if (fresh) this.db.exec('PRAGMA user_version=1');
    this.db.exec(`PRAGMA application_id=${appId}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS fc_computers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fc_jobs (request_id TEXT PRIMARY KEY, computer_id TEXT NOT NULL, hash TEXT NOT NULL, command TEXT NOT NULL,
        revision INTEGER NOT NULL, before_state TEXT NOT NULL, state TEXT NOT NULL, observation TEXT, context TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS fc_one_active ON fc_jobs(computer_id) WHERE state IN ('accepted','dispatched','unknown');
      CREATE TABLE IF NOT EXISTS fc_snapshots (computer_id TEXT NOT NULL,id TEXT NOT NULL,sha256 TEXT NOT NULL,bytes INTEGER NOT NULL,retired INTEGER NOT NULL,PRIMARY KEY(computer_id,id));`);
    if (path !== ':memory:') chmodSync(path, 0o600);
  }
  /** Explicit monotonic helper reader transition before any instance record or VM effect. Never runs in a transaction. */
  enableInstances(): void {
    if (this.db.inTransaction) fail('vm_firecracker_journal_format');
    const version = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
    if (![1, 2].includes(version)) fail('vm_firecracker_journal_invalid');
    if (version === 1) this.db.exec('PRAGMA user_version=2');
    if (this.#path !== ':memory:') {
      const check = this.db.query<{ busy: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get();
      if (!check || check.busy !== 0) fail('vm_firecracker_journal_format');
    }
    this.assertInstances();
    this.db.exec('CREATE TABLE IF NOT EXISTS fc_instances (computer_id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  }
  /** Checks both live WAL and actual database header before storing the new custody contract. */
  assertInstances(): void {
    if (this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version !== 2) fail('vm_firecracker_journal_format');
    if (this.#path === ':memory:') return;
    const fd = openSync(this.#path, 'r'), header = Buffer.alloc(100);
    try { if (readSync(fd, header, 0, 100, 0) !== 100 || header.readUInt32BE(60) !== 2) fail('vm_firecracker_journal_format'); } finally { closeSync(fd); }
  }
  #transaction<T>(run: () => T): T { return this.db.transaction(run).immediate(); }
  #save(value: FirecrackerJobComputer): void { this.db.query('UPDATE fc_computers SET data=? WHERE id=?').run(vmCanonical(value), value.id); }
  #row(computer: string, request: string): JobRow {
    if (!computerId(computer) || !uuid(request)) return fail();
    const row = this.db.query<JobRow, [string, string]>('SELECT * FROM fc_jobs WHERE computer_id=? AND request_id=?').get(computer, request);
    if (!row) return fail('vm_firecracker_job_not_found', 404); return row;
  }
  #view(row: JobRow): FirecrackerHostJob { return { command: JSON.parse(row.command), revision: row.revision, state: row.state, observation: row.observation ? JSON.parse(row.observation) : null }; }
  /** Installs metadata only, initially unverified. Neither an existing selection nor its state is overwritten. */
  register(input: Pick<FirecrackerJobComputer, 'id' | 'selectionSha256' | 'diskBytes' | 'basis'>): FirecrackerJobComputer {
    vmRecord(input, ['id', 'selectionSha256', 'diskBytes', 'basis']);
    if (!computerId(input.id) || !digest(input.selectionSha256) || !['protected_host', 'protocol_fixture'].includes(input.basis)) return fail();
    vmInteger(input.diskBytes, 64 * 1073741824, 128 * 1048576);
    return this.#transaction(() => {
      const prior = this.db.query<{ data: string }, [string]>('SELECT data FROM fc_computers WHERE id=?').get(input.id);
      if (prior) { const row: FirecrackerJobComputer = JSON.parse(prior.data); if (row.selectionSha256 !== input.selectionSha256 || row.diskBytes !== input.diskBytes || row.basis !== input.basis) return fail('vm_firecracker_selection_changed'); return row; }
      if (this.db.query<{ n: number }, []>('SELECT count(*) n FROM fc_computers').get()!.n >= 64) return fail('vm_firecracker_job_capacity');
      const row: FirecrackerJobComputer = { ...input, revision: 1, state: 'unverified', launchId: null, activeRequestId: null };
      this.db.query('INSERT INTO fc_computers VALUES (?,?)').run(row.id, vmCanonical(row)); return row;
    });
  }
  /** Protected metadata projection only; readiness still requires fresh independent driver evidence. */
  computer(id: string): FirecrackerJobComputer {
    if (!computerId(id)) return fail(); const row = this.db.query<{ data: string }, [string]>('SELECT data FROM fc_computers WHERE id=?').get(id);
    if (!row) return fail('vm_firecracker_computer_not_found', 404); return JSON.parse(row.data);
  }
  /** Stores fresh trusted read-back only when no original mutation is unsettled; it cannot clear a fence. */
  observe(id: string, value: FirecrackerJobObservation): FirecrackerJobComputer {
    return this.#transaction(() => {
      const row = this.computer(id), facts = observation(value, row);
      if (row.activeRequestId || facts.snapshot || facts.launchId !== row.launchId) return fail('vm_firecracker_job_unsettled');
      row.state = facts.state; this.#save(row); return row;
    });
  }
  /** Atomically retains original identity, reserves one computer and advances its fence before any host effect. */
  admit(value: FirecrackerHostCommand): { job: FirecrackerHostJob; fresh: boolean } {
    const command = firecrackerHostCommand(value), canonical = vmCanonical(command), hash = createHash('sha256').update(canonical).digest('hex');
    return this.#transaction(() => {
      const prior = this.db.query<JobRow, [string]>('SELECT * FROM fc_jobs WHERE request_id=?').get(command.requestId);
      if (prior) { if (prior.computer_id !== command.computerId || prior.hash !== hash || prior.command !== canonical) return fail('vm_firecracker_job_conflict'); return { job: this.#view(prior), fresh: false }; }
      const computer = this.computer(command.computerId);
      if (computer.selectionSha256 !== command.selectionSha256 || computer.revision !== command.expectedRevision || computer.launchId !== command.expectedLaunchId) return fail('vm_firecracker_job_stale');
      if (computer.activeRequestId || !['running', 'stopped'].includes(computer.state) || command.kind === 'launch' && computer.state !== 'stopped') return fail('vm_firecracker_job_unsettled');
      if (this.db.query<{ n: number }, []>('SELECT count(*) n FROM fc_jobs').get()!.n >= 4096) return fail('vm_firecracker_job_capacity');
      if ('snapshotId' in command) {
        const snapshot = this.db.query<{ retired: number }, [string, string]>('SELECT retired FROM fc_snapshots WHERE computer_id=? AND id=?').get(command.computerId, command.snapshotId);
        if (command.kind === 'checkpoint' ? !!snapshot : !snapshot || snapshot.retired !== 0) return fail('vm_firecracker_snapshot_unavailable');
        if (command.kind === 'checkpoint' && this.db.query<{ n: number }, [string]>('SELECT count(*) n FROM fc_snapshots WHERE computer_id=? AND retired=0').get(command.computerId)!.n >= 9) return fail('vm_firecracker_snapshot_capacity');
      }
      const revision = computer.revision + 1;
      this.db.query('INSERT INTO fc_jobs VALUES (?,?,?,?,?,?,?,NULL,NULL)').run(command.requestId, command.computerId, hash, canonical, revision, computer.state, 'accepted');
      computer.revision = revision; computer.state = 'busy'; computer.activeRequestId = command.requestId; this.#save(computer);
      return { job: this.receipt(command.computerId, command.requestId), fresh: true };
    });
  }
  /** Existing receipt by both original computer and request, never an execute/replacement path. */
  receipt(computer: string, request: string): FirecrackerHostJob { return this.#view(this.#row(computer, request)); }
  /** Original admitted state, independent of the now-busy current projection. Never grants authority. */
  startState(computer: string, request: string): 'running' | 'stopped' { return this.#row(computer, request).before_state as 'running' | 'stopped'; }
  /** Mandatory actual-dispatch/publication fence. Read-only recovery has its separate current-owner guard. */
  current(job: Pick<FirecrackerHostJob, 'command' | 'revision'>): void {
    const row = this.#row(job.command.computerId, job.command.requestId), computer = this.computer(row.computer_id);
    if (row.state !== 'dispatched' || row.revision !== job.revision || computer.activeRequestId !== row.request_id || computer.revision !== row.revision) return fail('vm_firecracker_job_stale');
  }
  /** Read-only original recovery fence; unlike current(), this never authorizes a host mutation. */
  recovering(job: Pick<FirecrackerHostJob, 'command' | 'revision'>): void {
    const row = this.#row(job.command.computerId, job.command.requestId), computer = this.computer(row.computer_id);
    if (row.state !== 'unknown' || row.revision !== job.revision || computer.activeRequestId !== row.request_id || computer.revision !== row.revision) return fail('vm_firecracker_job_stale');
  }
  /** Persists the one-way dispatch marker before a driver can enter the host boundary. */
  dispatched(computer: string, request: string): FirecrackerHostJob {
    return this.#transaction(() => { const row = this.#row(computer, request); if (row.state !== 'accepted' || this.computer(computer).activeRequestId !== request) return fail('vm_firecracker_job_stale'); this.db.query("UPDATE fc_jobs SET state='dispatched' WHERE request_id=?").run(request); return this.receipt(computer, request); });
  }
  /** Before-dispatch refusal only; the advanced revision and original receipt remain durable. */
  notSent(computer: string, request: string): void {
    this.#transaction(() => { const row = this.#row(computer, request); if (row.state !== 'accepted') return fail('vm_firecracker_job_stale'); const current = this.computer(computer); if (current.activeRequestId !== request) return fail('vm_firecracker_job_stale');
      this.db.query("UPDATE fc_jobs SET state='not_sent' WHERE request_id=?").run(request); current.state = row.before_state as 'running' | 'stopped'; current.activeRequestId = null; this.#save(current); });
  }
  /** Unknown retains its original computer reservation, revision and context; never refunds/retries a dispatch. */
  unknown(computer: string, request: string): void {
    this.#transaction(() => { const row = this.#row(computer, request); if (!['dispatched', 'unknown'].includes(row.state)) return fail('vm_firecracker_job_stale'); const current = this.computer(computer); if (current.activeRequestId !== request) return fail('vm_firecracker_job_stale');
      this.db.query("UPDATE fc_jobs SET state='unknown' WHERE request_id=?").run(request); current.state = 'uncertain'; this.#save(current); });
  }
  /** Protected recovery context only, bounded and absent from receipts. Driver code owns its schema and provenance. */
  context(computer: string, request: string): unknown { const row = this.#row(computer, request); return row.context ? JSON.parse(row.context) : null; }
  /** Writes original protected context before its corresponding side effect. It never grants execution authority. */
  record(job: FirecrackerHostJob, value: unknown): void {
    const data = vmCanonical(value); if (Buffer.byteLength(data) > 65536) return fail('vm_firecracker_job_limit');
    this.#transaction(() => { this.current(job); this.db.query('UPDATE fc_jobs SET context=? WHERE request_id=?').run(data, job.command.requestId); });
  }
  /** Commits only operation-consistent, independently observed original results, including read-back of unknown. */
  finish(computerId: string, request: string, value: FirecrackerJobObservation): FirecrackerHostJob {
    return this.#transaction(() => {
      const row = this.#row(computerId, request), computer = this.computer(computerId), command: FirecrackerHostCommand = JSON.parse(row.command), facts = observation(value, computer);
      if (!['dispatched', 'unknown'].includes(row.state) || computer.activeRequestId !== request || computer.revision !== row.revision) return fail('vm_firecracker_job_stale');
      const resumed = command.kind === 'launch' || command.kind === 'checkpoint' && row.before_state === 'running';
      const expectedState = resumed ? 'running' : command.kind === 'stop' || command.kind === 'restore' ? 'stopped' : row.before_state;
      if (facts.state !== expectedState || facts.launchId !== (resumed ? request : command.expectedLaunchId) || (command.kind === 'checkpoint' ? facts.snapshot?.id !== command.snapshotId : facts.snapshot !== undefined)) return fail('vm_firecracker_job_observation_invalid');
      if (command.kind === 'checkpoint') this.db.query('INSERT INTO fc_snapshots VALUES (?,?,?,?,0)').run(computerId, command.snapshotId, facts.snapshot!.sha256, facts.snapshot!.bytes);
      if (command.kind === 'retire') this.db.query('UPDATE fc_snapshots SET retired=1 WHERE computer_id=? AND id=?').run(computerId, command.snapshotId);
      this.db.query("UPDATE fc_jobs SET state='committed',observation=? WHERE request_id=?").run(vmCanonical(facts), request);
      computer.state = facts.state; computer.launchId = facts.launchId; computer.activeRequestId = null; this.#save(computer); return this.receipt(computerId, request);
    });
  }
  /**
   * Called only after the installed helper acquired its exclusive process-lifetime lock and the previous
   * helper is gone. Accepted means no driver dispatch occurred; dispatched becomes unknown, not replayable.
   */
  recover(owner?: FirecrackerHostLock): void {
    if (this.db.query<{ data: string }, []>('SELECT data FROM fc_computers').all().some(row => JSON.parse(row.data).basis === 'protected_host')) {
      if (!(owner instanceof FirecrackerHostLock) || owner.basis !== 'protected_host') return fail('vm_firecracker_helper_locked', 503);
      owner.current();
    } else owner?.current();
    this.#transaction(() => { const rows = this.db.query<JobRow, []>("SELECT * FROM fc_jobs WHERE state IN ('accepted','dispatched')").all();
      for (const row of rows) { if (row.state === 'accepted') this.notSent(row.computer_id, row.request_id); else this.unknown(row.computer_id, row.request_id); } });
  }
  /** Closes this connection only; it neither stops a VM nor clears unsettled receipts. */
  close(): void { this.db.close(); }
}

/** Trusted installed helper driver. Its implementation, never request data, owns the native evidence basis. */
export interface FirecrackerHostJobDriver {
  readonly basis: FirecrackerJobObservation['basis'];
  /** Each actual side effect and publication calls guard; protected context precedes its corresponding effect. */
  execute(job: Readonly<FirecrackerHostJob>, control: { guard(): Promise<void>; record(value: unknown): void; context(): unknown }): Promise<FirecrackerJobObservation>;
  /** Read-only original observation: no launch, signal, file replacement, deletion or replacement command. */
  readBack(job: Readonly<FirecrackerHostJob>, control: { guard(): Promise<void>; context(): unknown }): Promise<FirecrackerJobObservation | null>;
}
function deadline(milliseconds: number, maximum: number) {
  vmInteger(milliseconds, maximum); const until = performance.now() + milliseconds;
  const expired = Promise.withResolvers<never>(); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; expired.reject(new AppError('vm_firecracker_job_timeout', 503)); }, milliseconds);
  const check = () => { if (timedOut || performance.now() >= until) return fail('vm_firecracker_job_timeout', 503); };
  return { check, async wait<T>(action: () => Promise<T> | T): Promise<T> { check(); return Promise.race([Promise.resolve().then(() => { check(); return action(); }).then(value => { check(); return value; }), expired.promise]); }, close() { clearTimeout(timer); } };
}
/**
 * Owning original-job dispatcher. Durable admission and dispatch markers precede driver I/O; duplicate
 * submission returns the original receipt. A deadline fences later driver work, preserves context and
 * capacity, and never dispatches a replacement. This class does not certify an arbitrary driver as native.
 */
export class FirecrackerHostJobs {
  readonly #execute: FirecrackerHostJobDriver['execute'];
  readonly #readBack: FirecrackerHostJobDriver['readBack'];
  readonly #basis: FirecrackerJobObservation['basis'];
  readonly #owner: FirecrackerHostLock | undefined;
  readonly #running = new Set<string>();
  readonly #reading = new Set<string>();
  constructor(readonly journal: FirecrackerHostJournal, driver: FirecrackerHostJobDriver, owner?: FirecrackerHostLock) {
    if (!['protected_host', 'protocol_fixture'].includes(driver.basis) || typeof driver.execute !== 'function' || typeof driver.readBack !== 'function') fail();
    if (driver.basis === 'protected_host' && (!(owner instanceof FirecrackerHostLock) || owner.basis !== 'protected_host')) fail('vm_firecracker_helper_locked', 503);
    owner?.current(); this.#owner = owner;
    this.#basis = driver.basis; this.#execute = driver.execute.bind(driver); this.#readBack = driver.readBack.bind(driver);
  }
  /** Runs one newly admitted original command; authorization is rechecked at actual driver I/O and publication. */
  async run(value: FirecrackerHostCommand, authorize: () => void | Promise<void>, options: { timeoutMs?: number } = {}): Promise<FirecrackerHostJob> {
    const command = firecrackerHostCommand(value), limit = deadline(options.timeoutMs ?? 360000, 360000);
    let original: FirecrackerHostJob | null = null, dispatched = false, local = false, driverPending = false;
    try {
      this.#owner?.current();
      await limit.wait(authorize);
      this.#owner?.current();
      if (this.journal.computer(command.computerId).basis !== this.#basis) return fail('vm_firecracker_job_observation_invalid');
      const admission = this.journal.admit(command); original = admission.job;
      if (!admission.fresh) return original;
      this.#running.add(command.requestId); local = true; await limit.wait(authorize);
      original = this.journal.dispatched(command.computerId, command.requestId); dispatched = true;
      const job = original;
      const guard = async () => { limit.check(); this.#owner?.current(); this.journal.current(job); await limit.wait(authorize); this.#owner?.current(); this.journal.current(job); limit.check(); };
      const execution = Promise.resolve().then(() => { limit.check(); return this.#execute(structuredClone(job), {
        guard, record: value => { limit.check(); this.#owner?.current(); this.journal.record(job, value); }, context: () => this.journal.context(command.computerId, command.requestId),
      }); });
      driverPending = true;
      void execution.then(() => this.#running.delete(command.requestId), () => this.#running.delete(command.requestId));
      const observed = await limit.wait(() => execution);
      await guard(); return this.journal.finish(command.computerId, command.requestId, observed);
    } catch (error) {
      if (!original) throw error;
      const latest = this.journal.receipt(command.computerId, command.requestId);
      if (dispatched && latest.state === 'dispatched') this.journal.unknown(command.computerId, command.requestId);
      else if (!dispatched && latest.state === 'accepted') this.journal.notSent(command.computerId, command.requestId);
      return this.journal.receipt(command.computerId, command.requestId);
    } finally { limit.close(); if (local && !driverPending) this.#running.delete(command.requestId); }
  }
  /** Existing unknown read-back only, under current read authority; an active local driver is never duplicated. */
  async reconcile(computer: string, request: string, authorize: () => void | Promise<void>, options: { timeoutMs?: number } = {}): Promise<FirecrackerHostJob> {
    const limit = deadline(options.timeoutMs ?? 15000, 15000);
    let acquired = false, settled = false, released = false;
    try {
      this.#owner?.current();
      await limit.wait(authorize); const job = this.journal.receipt(computer, request);
      if (job.state !== 'unknown' || this.#running.has(request) || this.#reading.has(request)) return job;
      if (this.journal.computer(computer).basis !== this.#basis) return fail('vm_firecracker_job_observation_invalid');
      const guard = async () => { this.#owner?.current(); this.journal.recovering(job); await limit.wait(authorize); this.#owner?.current(); this.journal.recovering(job); limit.check(); };
      this.#reading.add(request); acquired = true;
      const reading = Promise.resolve().then(() => { limit.check(); return this.#readBack(structuredClone(job), { guard, context: () => this.journal.context(computer, request) }); });
      const done = () => { settled = true; if (released) this.#reading.delete(request); };
      void reading.then(done, done);
      const observed = await limit.wait(() => reading);
      await guard(); return observed === null ? this.journal.receipt(computer, request) : this.journal.finish(computer, request, observed);
    } finally { limit.close(); released = true; if (acquired && settled) this.#reading.delete(request); }
  }
}
