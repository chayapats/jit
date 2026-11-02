import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { opsDirectory, opsRead, opsSyncDirectory, opsWrite } from '../../s14/ops-files';
import { acquireS14RuntimeLock } from '../../s14/runtime-lock';
import { openPolicyService } from '../policy';
import type { AuthenticatedOwner, S15PolicyService, StandingPolicy, PolicyOptions } from '../policy';
import { ProtectedDataStore } from '../team/store';
import { snapshotSource, verifySourceFiles, type SourceSnapshot } from './source';
import { adoptionFail, encode, hash, hashBytes, hashValue, id, nat, validateOptions } from './validation';
import type * as T from './types';

const ddl = `
CREATE TABLE meta (key TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE history (source_table TEXT NOT NULL, ordinal INTEGER NOT NULL, source_hash TEXT NOT NULL, cells_json TEXT NOT NULL, PRIMARY KEY(source_table,ordinal));
CREATE TABLE facts (source_table TEXT NOT NULL, ordinal INTEGER NOT NULL, source_hash TEXT NOT NULL, cells_json TEXT NOT NULL, PRIMARY KEY(source_table,ordinal));
CREATE TABLE source_requests (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, outcome_hash TEXT NOT NULL);
CREATE TABLE receipts (id TEXT PRIMARY KEY, hash TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE TABLE activity (id INTEGER PRIMARY KEY CHECK(id=1), at INTEGER NOT NULL);
CREATE TRIGGER history_no_update BEFORE UPDATE ON history BEGIN SELECT RAISE(ABORT,'immutable_history'); END;
CREATE TRIGGER history_no_delete BEFORE DELETE ON history BEGIN SELECT RAISE(ABORT,'immutable_history'); END;
CREATE TRIGGER facts_no_update BEFORE UPDATE ON facts BEGIN SELECT RAISE(ABORT,'immutable_continuity'); END;
CREATE TRIGGER facts_no_delete BEFORE DELETE ON facts BEGIN SELECT RAISE(ABORT,'immutable_continuity'); END;
`;
interface Stage {
  id: string; revision: number; state: T.AdoptionState; reason: string | null; report: T.AdoptionReport;
  files: SourceSnapshot['files']; candidateHash: string; policyBaseline: string | null;
  policyHash: string | null; actionHash: string | null; releaseHash: string | null;
  ownerGeneration: number;
}
interface Pending { command: T.AdoptionCommand; hash: string; result: T.AdoptionStatus | null }

/**
 * Opens an explicitly selected protected coordinator. Original files are never rewritten or removed.
 * The persisted S14 ops fence is understood by the prior build, including pre-existing S14Store handles;
 * the OS runtime lock excludes its serve/maintenance processes while this coordinator is open.
 * Physical custody and stop/native settlement come from the protected host port, never guest assertions.
 */
export function openAdoptionService(o: T.AdoptionOptions): T.AdoptionService {
  validateOptions(o);
  if (o.source.runtime !== 's14') adoptionFail('transition_legacy_continuity_unsupported');
  const existingTarget = existsSync(join(o.directory, 'adoption.sqlite'));
  if (!existingTarget && (lstatSync(join(`${o.source.database}.ops`, 'fence.json'), { throwIfNoEntry: false }) || existsSync(o.directory) && readdirSync(o.directory).length)) adoptionFail('transition_continuity_unavailable');
  // Source identity/schema/refusals are checked before a target, coordinator lock or policy can be created.
  if (!existingTarget) snapshotSource(o);
  const now = o.now ?? Date.now, owners = new WeakMap<T.AdoptionOwner, { proof: unknown; principal: AuthenticatedOwner }>();
  opsDirectory(o.directory);
  const store = new ProtectedDataStore(join(o.directory, 'adoption.sqlite'), o.source.installationId, true, 0x4a495432, ddl);
  const db = store.db;
  const get = <V>(key: string): V | null => {
    const row = db.query<{ json: string }, [string]>('SELECT json FROM meta WHERE key=?').get(key);
    try { return row ? JSON.parse(row.json) as V : null; }
    catch { return adoptionFail('transition_integrity_failed'); }
  };
  const put = (key: string, value: unknown) => db.query('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json').run(key, encode(value));
  const configHash = hashValue({ source: o.source, directory: o.directory, target: o.target });
  let policy: S15PolicyService | null = null, sourceUnlock: (() => void) | null = null, closed = false;
  const fencePath = join(`${o.source.database}.ops`, 'fence.json');
  function fenceBytes(stage: Stage): string { return encode({ contract: 's15-state-transition/v1', stageId: stage.id, installationId: o.source.installationId }); }
  function assertFence(stage: Stage): void {
    if (!existsSync(fencePath) || opsRead(fencePath, 4096).toString() !== fenceBytes(stage)) adoptionFail('transition_prior_boot_fence_missing');
  }
  function releaseSource(stage: Stage): void {
    if (!lstatSync(fencePath, { throwIfNoEntry: false })) return;
    assertFence(stage); unlinkSync(fencePath); opsSyncDirectory(`${o.source.database}.ops`);
  }
  function auth(actor: T.AdoptionOwner): { proof: unknown; principal: AuthenticatedOwner } {
    if (closed) adoptionFail('transition_service_closed');
    const entry = actor && owners.get(actor), current = entry && o.policy.verifyOwner(entry.proof);
    const t = now(); nat(t);
    if (!entry || !current || current.id !== entry.principal.id || current.generation !== entry.principal.generation || current.generation !== o.policy.ownerGeneration() || current.expiresAt <= t) adoptionFail('transition_authentication_required');
    return entry;
  }
  function boundary(stage: Stage): void {
    const b = o.boundary.observe();
    if (!b.protected || !b.settled || !b.priorBuildFenceVerified || b.hostId !== stage.report.hostId || b.evidenceHash !== stage.report.hostEvidenceHash || b.sourceArtifact !== o.source.build.sha256 || b.targetArtifact !== o.target.sha256) adoptionFail('transition_protected_settlement_required');
  }
  function candidateHash(): string {
    return hashValue(['history', 'facts', 'source_requests'].map(t => [t, db.query(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
  }
  function policyFilesHash(): string {
    const path = join(o.directory, 'policy.sqlite');
    if (['-wal', '-journal'].some(s => existsSync(path + s))) adoptionFail('transition_policy_settlement_required');
    return hashBytes(opsRead(path, 64 * 1024 * 1024));
  }
  function openPolicy(create: boolean): S15PolicyService {
    const initialReservations = get<NonNullable<PolicyOptions['initialReservations']>>('reservations');
    if (!initialReservations) adoptionFail('transition_continuity_unavailable');
    return openPolicyService({ ...o.policy, runtime: 's15', path: join(o.directory, 'policy.sqlite'), create, installationId: o.source.installationId, activityGuard: guardActivity,
      initialReservations,
      requestGuard: requestId => { if (db.query('SELECT 1 FROM source_requests WHERE id=?').get(requestId)) adoptionFail('transition_historical_request_no_replay'); },
    });
  }
  function currentPolicy(actor: T.AdoptionOwner): StandingPolicy | null {
    const entry = auth(actor);
    if (!policy) return null;
    return policy.owner.current(policy.owner.authenticate(entry.proof));
  }
  const activity = () => !!db.query('SELECT 1 FROM activity').get();
  function rollbackHash(stage: Stage): string {
    return hashValue({ kind: 'rollback', id: stage.id, revision: stage.revision, candidateHash: stage.candidateHash, policyBaseline: stage.policyBaseline, checkpoint: stage.report.checkpointHash, activity: activity() });
  }
  function status(stage: Stage, p: StandingPolicy | null): T.AdoptionStatus {
    const selected = ['active_fenced', 'complete', 'rolling_back', 'blocked'].includes(stage.state) && get('activated') === true;
    return { contract: 's15-adoption-status/v1', id: stage.id, revision: stage.revision, state: stage.state,
      selectedRuntime: selected ? 's15' : o.source.runtime, workers: stage.state === 'complete' ? 'released' : 'fenced', reason: stage.reason,
      report: stage.report, actionHash: stage.actionHash, releaseHash: stage.releaseHash, rollbackHash: rollbackHash(stage),
      policyRevision: p?.revision ?? null, activityRecorded: activity(), historyPreserved: true, privateScopePreserved: true, reverseProjection: 'unsupported_after_activity' };
  }
  function checkpoint(point: T.AdoptionCheckpoint): void { o.fault?.(point); }
  function finish(stage: Stage, actor: T.AdoptionOwner): void {
    const result = status(stage, currentPolicy(actor));
    store.transaction(() => {
      auth(actor); put('stage', stage);
      const pending = get<Pending>('pending');
      if (!pending) adoptionFail('transition_integrity_failed');
      put('pending', { ...pending, result });
    });
  }
  function unchanged(stage: Stage): void {
    if (stage.state !== 'preparing' || existsSync(fencePath)) assertFence(stage);
    boundary(stage); verifySourceFiles(o, stage.files);
    if (stage.candidateHash && candidateHash() !== stage.candidateHash) adoptionFail('transition_integrity_failed');
  }
  /** Durable before I/O; failed or uncertain admissions conservatively count as S15 activity. */
  function guardActivity(): void {
    if (closed) adoptionFail('transition_service_closed');
    const stage = get<Stage>('stage');
    if (!stage || stage.state !== 'complete') adoptionFail('transition_workers_fenced');
    assertFence(stage);
    const b = o.boundary.observe();
    if (!b.protected || b.hostId !== stage.report.hostId || b.evidenceHash !== stage.report.hostEvidenceHash || b.targetArtifact !== o.target.sha256) adoptionFail('transition_host_evidence_changed');
    if (!activity()) {
      store.transaction(() => db.query('INSERT OR IGNORE INTO activity VALUES (1,?)').run(now()));
      checkpoint('activity_recorded');
    }
  }
  function resumePrepare(stage: Stage, actor: T.AdoptionOwner): Stage {
    if (!existsSync(fencePath)) {
      const control = join(`${o.source.database}.ops`, 'control.json');
      if (existsSync(control)) {
        const previous = JSON.parse(opsRead(control, 2 * 1024 * 1024).toString());
        if (previous.stage && !['complete', 'discarded'].includes(previous.stage.state)) adoptionFail('transition_source_maintenance_required');
      }
      if (existsSync(join(`${o.source.database}.ops`, 'capture.json'))) adoptionFail('transition_source_maintenance_required');
      opsWrite(fencePath, fenceBytes(stage));
    }
    assertFence(stage); checkpoint('source_fenced');
    const snapshot = snapshotSource(o);
    if (snapshot.report.planHash !== stage.report.planHash || snapshot.report.refusals.length) adoptionFail('transition_stale_validation');
    boundary(stage); auth(actor);
    store.transaction(() => put('reservations', snapshot.reservations));
    if (!policy) policy = openPolicy(!existsSync(join(o.directory, 'policy.sqlite')));
    store.transaction(() => {
      for (const [table, entries] of [['history', snapshot.rows], ['facts', snapshot.facts]] as const) for (const row of entries) db.query(`INSERT INTO ${table} VALUES (?,?,?,?)`).run(row.table, row.ordinal, row.hash, encode(row.cells));
      for (const row of snapshot.requests) db.query('INSERT INTO source_requests VALUES (?,?,?)').run(row.id, row.payloadHash, row.outcomeHash);
      stage.files = snapshot.files; stage.candidateHash = candidateHash(); stage.state = 'validated'; stage.revision++;
      store.capacity();
      put('stage', stage);
      const pending = get<Pending>('pending');
      if (!pending) adoptionFail('transition_integrity_failed');
      put('pending', { ...pending, result: status(stage, currentPolicy(actor)) });
    });
    checkpoint('candidate_committed'); return stage;
  }
  try {
    const priorConfig = get<string>('config');
    if (priorConfig !== null && priorConfig !== configHash) adoptionFail('transition_installation_mismatch');
    const expected = new Database(':memory:');
    try {
      expected.exec(`CREATE TABLE identity (id TEXT PRIMARY KEY); ${ddl}`);
      const schema = (database: Database) => hashValue(database.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all());
      if (schema(db) !== schema(expected)) adoptionFail('transition_schema_unreviewed');
    } finally { expected.close(); }
    if (priorConfig === null) store.transaction(() => put('config', configHash));
    const stage = get<Stage>('stage');
    if (stage && !['preparing', 'discarded'].includes(stage.state) && !existsSync(join(o.directory, 'policy.sqlite'))) adoptionFail('transition_continuity_unavailable');
    if (stage?.candidateHash && candidateHash() !== stage.candidateHash) adoptionFail('transition_integrity_failed');
    // Terminal journals cannot accidentally fence/reselect another installation on reopen.
    if (stage && !['rolled_back', 'discarded'].includes(stage.state)) sourceUnlock = acquireS14RuntimeLock(o.source.database);
    if (existsSync(join(o.directory, 'policy.sqlite'))) policy = openPolicy(false);
    if (stage && ['rolled_back', 'discarded'].includes(stage.state)) releaseSource(stage);
    else if (stage?.candidateHash) unchanged(stage);
  } catch (error) { policy?.control.close(); sourceUnlock?.(); store.close(); throw error; }

  return {
    authenticate(proof) {
      if (closed) adoptionFail('transition_service_closed');
      const principal = o.policy.verifyOwner(proof);
      if (!principal || principal.generation !== o.policy.ownerGeneration() || principal.expiresAt <= now()) adoptionFail('transition_authentication_required');
      id(principal.id); nat(principal.generation); nat(principal.expiresAt);
      const actor = Object.freeze({}) as T.AdoptionOwner; owners.set(actor, { proof, principal }); return actor;
    },
    status(actor) { auth(actor); const stage = get<Stage>('stage'); return stage ? status(stage, currentPolicy(actor)) : null; },
    policy() { if (closed || !policy) adoptionFail('transition_prepare_required'); return policy; },
    guardActivity,
    historicalRequest(actor, requestId, payloadHash) {
      auth(actor); id(requestId); hash(payloadHash);
      const row = db.query<{ payload_hash: string }, [string]>('SELECT payload_hash FROM source_requests WHERE id=?').get(requestId);
      if (!row) return null;
      if (row.payload_hash !== payloadHash) adoptionFail('transition_request_id_conflict');
      return 'historical_request_no_replay';
    },
    command(actor, command) {
      const principal = auth(actor).principal;
      if (Object.keys(command).sort().join(',') !== 'expectedRevision,hash,kind,requestId' || !['prepare', 'validate', 'activate', 'release', 'rollback', 'discard'].includes(command.kind)) adoptionFail('transition_invalid_command');
      id(command.requestId); nat(command.expectedRevision); hash(command.hash);
      const requestHash = hashValue(command);
      const aborted = get<{ requestId: string; hash: string }>('aborted_prepare');
      if (aborted?.requestId === command.requestId) {
        if (aborted.hash !== requestHash) adoptionFail('transition_request_id_conflict');
        const retained = get<Stage>('stage');
        if (!retained) adoptionFail('transition_integrity_failed');
        return status(retained, currentPolicy(actor));
      }
      const existing = db.query<{ hash: string; result_json: string }, [string]>('SELECT hash,result_json FROM receipts WHERE id=?').get(command.requestId);
      if (existing) { if (existing.hash !== requestHash) adoptionFail('transition_request_id_conflict'); return JSON.parse(existing.result_json) as T.AdoptionStatus; }
      let pending = get<Pending>('pending');
      const interrupted = get<Stage>('stage');
      if (pending?.command.kind === 'prepare' && command.kind === 'discard' && interrupted?.state === 'preparing' && command.expectedRevision === interrupted.revision && command.hash === rollbackHash(interrupted) && principal.generation === interrupted.ownerGeneration) {
        const old = pending;
        store.transaction(() => { put('aborted_prepare', { requestId: old.command.requestId, hash: old.hash }); put('pending', null); }); pending = null;
      }
      if (pending && (pending.command.requestId !== command.requestId || pending.hash !== requestHash)) adoptionFail('transition_request_in_progress');
      if (pending?.result) {
        const recoveredResult = pending.result;
        const terminal = get<Stage>('stage');
        if (terminal && ['rolled_back', 'discarded'].includes(terminal.state)) { releaseSource(terminal); sourceUnlock?.(); sourceUnlock = null; }
        store.transaction(() => { auth(actor); db.query('INSERT INTO receipts VALUES (?,?,?)').run(command.requestId, requestHash, encode(recoveredResult)); put('pending', null); });
        return recoveredResult;
      }
      // Imported request IDs are reserved even when their old result payload is withdrawn.
      if (db.query('SELECT 1 FROM source_requests WHERE id=?').get(command.requestId)) adoptionFail('transition_historical_request_no_replay');
      let stage = get<Stage>('stage');
      if (!pending && command.expectedRevision !== (stage?.revision ?? 0)) adoptionFail('transition_stale_revision');
      if (stage && stage.ownerGeneration !== principal.generation) adoptionFail('transition_owner_generation_changed');
      const begin = () => { if (!pending) { store.transaction(() => put('pending', { command, hash: requestHash, result: null })); pending = get<Pending>('pending'); } };
      if (command.kind === 'prepare') {
        if (stage && stage.state !== 'preparing') adoptionFail('transition_already_prepared');
        if (stage && command.hash !== stage.report.planHash) adoptionFail('transition_stale_validation');
        if (!stage) {
          const snapshot = snapshotSource(o);
          if (snapshot.ownerGeneration !== principal.generation) adoptionFail('transition_owner_generation_changed');
          if (snapshot.requests.some(r => r.id === command.requestId)) adoptionFail('transition_historical_request_no_replay');
          if (snapshot.report.refusals.length || command.hash !== snapshot.report.planHash) adoptionFail('transition_stale_validation');
          if (existsSync(fencePath)) adoptionFail('transition_source_maintenance_required');
          sourceUnlock ??= acquireS14RuntimeLock(o.source.database);
          stage = { id: randomUUID().replaceAll('-', ''), revision: 0, state: 'preparing', reason: null, report: snapshot.report,
            files: snapshot.files, candidateHash: '', policyBaseline: null, policyHash: null, actionHash: null, releaseHash: null, ownerGeneration: principal.generation };
          begin();
          store.transaction(() => put('stage', stage)); checkpoint('preparing');
        }
        begin();
        stage = resumePrepare(stage, actor);
      } else {
        if (!stage) adoptionFail('transition_prepare_required');
        if (command.kind === 'validate') {
          if (stage.state !== 'validated') adoptionFail('transition_invalid_state');
          if (command.hash !== stage.report.planHash) adoptionFail('transition_stale_validation');
          unchanged(stage); const p = currentPolicy(actor);
          begin();
          stage.policyHash = hashValue(p); stage.revision++;
          stage.actionHash = hashValue({ kind: 'activate', revision: stage.revision, plan: stage.report.planHash, checkpoint: stage.report.checkpointHash, candidate: stage.candidateHash, policy: stage.policyHash, owner: stage.ownerGeneration });
          finish(stage, actor);
        } else if (command.kind === 'activate') {
          // Retrying an interrupted intent rechecks the exact recorded third-state-free handoff.
          if (!['validated', 'activating', 'active_fenced'].includes(stage.state) || !stage.actionHash || command.hash !== stage.actionHash) adoptionFail('transition_stale_validation');
          unchanged(stage);
          if (hashValue(currentPolicy(actor)) !== stage.policyHash) adoptionFail('transition_stale_validation');
          auth(actor);
          begin();
          if (stage.state === 'validated') { stage.state = 'activating'; store.transaction(() => put('stage', stage)); checkpoint('activation_intent'); }
          stage.state = 'active_fenced'; stage.policyBaseline = policyFilesHash(); stage.revision++;
          stage.releaseHash = hashValue({ kind: 'release', id: stage.id, revision: stage.revision, plan: stage.report.planHash, policy: stage.policyHash });
          store.transaction(() => { put('activated', true); finish(stage!, actor); }); checkpoint('active_fenced');
        } else if (command.kind === 'release') {
          if (stage.state !== 'active_fenced' || command.hash !== stage.releaseHash) adoptionFail('transition_stale_validation');
          unchanged(stage); const p = currentPolicy(actor);
          if (!p || !p.budget || p.expiresAt <= now() || p.budget.expiresAt <= now() || hashValue(p) !== stage.policyHash) adoptionFail('transition_policy_install_required');
          begin();
          stage.state = 'complete'; stage.revision++; finish(stage, actor); checkpoint('workers_released');
        } else if (command.kind === 'rollback' || command.kind === 'discard') {
          const discard = command.kind === 'discard';
          if (discard ? !['preparing', 'validated'].includes(stage.state) : !['activating', 'active_fenced', 'complete', 'rolling_back', 'rolled_back'].includes(stage.state)) adoptionFail('transition_invalid_state');
          if (command.hash !== rollbackHash(stage)) adoptionFail('transition_stale_validation');
          if (activity() || stage.policyBaseline !== null && policyFilesHash() !== stage.policyBaseline ||
              readdirSync(o.directory).some(x => !['adoption.sqlite', 'adoption.sqlite.runtime-lock.sqlite', 'adoption.sqlite.runtime-lock.sqlite-journal', 'policy.sqlite'].includes(x))) {
            stage.state = 'blocked'; stage.reason = 'transition_new_s15_facts_require_reverse_projection'; stage.revision++;
            store.transaction(() => put('stage', stage)); adoptionFail('transition_rollback_unsupported');
          }
          if (discard) {
            // Before activation, the original remains current. Discard never rewinds newer source facts.
            const current = snapshotSource(o);
            if (current.report.refusals.length || current.ownerGeneration !== principal.generation) adoptionFail('transition_protected_settlement_required');
            if (existsSync(fencePath)) assertFence(stage);
            boundary(stage);
          } else unchanged(stage);
          begin();
          stage.state = 'rolling_back'; store.transaction(() => put('stage', stage)); checkpoint('rollback_intent');
          auth(actor); stage.state = discard ? 'discarded' : 'rolled_back'; stage.revision++;
          store.transaction(() => { put('activated', false); finish(stage!, actor); }); checkpoint('prior_selected');
          releaseSource(stage); checkpoint('source_released'); sourceUnlock?.(); sourceUnlock = null;
        }
      }
      const result = status(stage!, currentPolicy(actor));
      store.transaction(() => { auth(actor); store.capacity(); db.query('INSERT INTO receipts VALUES (?,?,?)').run(command.requestId, requestHash, encode(result)); put('pending', null); });
      return result;
    },
    close() { if (!closed) { closed = true; policy?.control.close(); sourceUnlock?.(); store.close(); } },
  };
}
