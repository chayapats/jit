import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readServiceConfigFile, serviceDatabasePath } from '../../../ops/package/service-config';
import { opsRead, opsPath } from '../../s14/ops-files';
import { credentialFreeImage, opsLedgerTables, opsSchema } from '../../s14/ops-image';
import { inspectS14Store } from '../../s14/store';
import { containsCredential } from '../../security/credentials';
import type { AppTransaction } from '../../store';
import type { AdoptionCell, AdoptionOptions, AdoptionReport, AdoptionRow } from './types';
import type { PolicyOptions } from '../policy';
import { adoptionFail, containsPath, encode, hash, hashBytes, hashValue, id, validateOptions } from './validation';

// Actual schema-17 DDL, including indexes/triggers/constraints, reproduced by S14Store fixtures.
const sourceSchema = 'c466faccf93d27c5f4cbc8b09d98f0801d08b27697e07e944abe214c97de90b1';
const ledgerSchema = '7ab58eadf4138d44af04011156ada695130b9d28ad7d43eeee1035be5470ecfb';
const maximumBytes = 64 * 1024 * 1024, maximumRows = 200000;
type FileEntry = { path: string; bytes: number; hash: string };
/** Internal bounded snapshot; original files are read with ordinary no-follow reads, never opened by writable SQLite. */
export interface SourceSnapshot {
  report: AdoptionReport; files: FileEntry[]; rows: AdoptionRow[]; facts: AdoptionRow[];
  requests: { id: string; payloadHash: string; outcomeHash: string }[];
  ownerGeneration: number;
  reservations: NonNullable<PolicyOptions['initialReservations']>;
}
function transaction(db: Database, ledger: Database): AppTransaction {
  const query = (sql: string) => sql.includes('lifecycle.') ? ledger.query(sql.replaceAll('lifecycle.', 'main.')) : db.query(sql);
  return { get: (sql, ...args) => query(sql).get(...args) as never, all: (sql, ...args) => query(sql).all(...args) as never, run: () => adoptionFail('transition_read_only') };
}
const cell = (value: unknown): AdoptionCell => {
  if (value === null) return null;
  if (typeof value === 'string') return { text: value };
  if (typeof value === 'bigint') return { integer: value.toString() };
  if (typeof value === 'number' && Number.isFinite(value)) return { real: Object.is(value, -0) ? '-0' : String(value) };
  if (value instanceof Uint8Array) return { blobBase64: Buffer.from(value).toString('base64') };
  return adoptionFail('transition_invalid_cell');
};
function rows(db: Database, table: string, name = table): AdoptionRow[] {
  return (db.query(`SELECT * FROM ${table} ORDER BY rowid LIMIT ${maximumRows + 1}`).all() as Record<string, unknown>[]).map((row, ordinal) => {
    const cells = Object.entries(row).map(([key, value]): [string, AdoptionCell] => [key, cell(value)]);
    return { table: name, ordinal, cells, hash: hashValue({ table: name, ordinal, cells }) };
  });
}
function inventory(o: AdoptionOptions): FileEntry[] {
  const entries = new Map<string, FileEntry>(); let total = 0, visited = 0;
  const fence = join(`${o.source.database}.ops`, 'fence.json');
  const config = readServiceConfigFile(o.source.configPath);
  const visit = (path: string): void => {
    opsPath(path);
    if (path === fence || path === `${o.source.database}.runtime-lock.sqlite`) return;
    if (++visited > 8192) adoptionFail('transition_bounds');
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) return;
    if (stat.isSymbolicLink()) adoptionFail('transition_path_untrusted');
    if (stat.isDirectory()) { for (const child of readdirSync(path).sort()) visit(join(path, child)); return; }
    if (entries.has(path)) return;
    if (entries.size >= 4096 || !stat.isFile() || stat.nlink !== 1 || stat.size > maximumBytes || total + stat.size > 256 * 1024 * 1024) adoptionFail('transition_bounds');
    const bytes = opsRead(path, maximumBytes); total += bytes.length;
    entries.set(path, { path, bytes: bytes.length, hash: hashBytes(bytes) });
  };
  [o.source.database, `${o.source.database}.lifecycle.sqlite`, `${o.source.database}.ops`, `${o.source.database}.owner-setup.json`,
    `${join(dirname(o.source.database), 'native')}.session-store.json`, join(dirname(o.source.database), 'native'),
    ...(config.s14 ? [config.s14.vaultDirectory, config.s14.computerRoot, config.s14.gitScratch] : []),
    o.source.configPath, o.source.build.path, ...o.source.preservedPaths].forEach(visit);
  return [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}
/** Verifies all sealed source files, including presence; refuses drift instead of rewriting a source or sidecar. */
export function verifySourceFiles(o: AdoptionOptions, files: FileEntry[]): void {
  assertNoSidecars(o.source.database); assertNoSidecars(`${o.source.database}.lifecycle.sqlite`);
  if (hashValue(inventory(o)) !== hashValue(files)) adoptionFail('transition_stale_validation');
  if (hashBytes(opsRead(o.target.path, maximumBytes)) !== o.target.sha256) adoptionFail('transition_stale_validation');
}
function assertNoSidecars(path: string): void {
  if (['-wal', '-shm', '-journal'].some(suffix => lstatSync(path + suffix, { throwIfNoEntry: false }))) adoptionFail('transition_sqlite_settlement_required');
}
/** Reads only quiescent schema-17 source bytes into memory. Unknown/legacy continuity is refused explicitly. */
export function snapshotSource(o: AdoptionOptions): SourceSnapshot {
  validateOptions(o);
  if (o.source.runtime !== 's14') adoptionFail('transition_legacy_continuity_unsupported');
  if (inspectS14Store(o.source.database) !== 's14') adoptionFail('transition_source_unsupported');
  const config = readServiceConfigFile(o.source.configPath);
  if (config.runtime !== 's14' || serviceDatabasePath(config) !== o.source.database ||
      encode(o.source.argv) !== encode(['serve', '--s14', '--no-refusal-page'])) adoptionFail('transition_installation_mismatch');
  if ([config.s14!.vaultDirectory, config.s14!.computerRoot, config.s14!.gitScratch].some(path => containsPath(path, o.directory) || containsPath(o.directory, path))) adoptionFail('transition_path_overlap');
  assertNoSidecars(o.source.database); assertNoSidecars(`${o.source.database}.lifecycle.sqlite`);
  const before = inventory(o);
  if (!before.some(x => x.path === `${o.source.database}.lifecycle.sqlite`) ||
      !before.some(x => x.path === o.source.build.path && x.hash === o.source.build.sha256) ||
      hashBytes(opsRead(o.target.path, maximumBytes)) !== o.target.sha256) adoptionFail('transition_build_or_continuity_unavailable');
  const db = Database.deserialize(opsRead(o.source.database, maximumBytes));
  const ledger = Database.deserialize(opsRead(`${o.source.database}.lifecycle.sqlite`, maximumBytes), { safeIntegers: true });
  let clean: Database | undefined;
  try {
    const tx = transaction(db, ledger);
    const schema = (d: Database) => hashBytes(JSON.stringify(d.query("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()));
    if (opsSchema(tx) !== sourceSchema || schema(ledger) !== ledgerSchema) adoptionFail('transition_schema_unreviewed');
    if ((db.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check !== 'ok' ||
        (ledger.query('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check !== 'ok' || db.query('PRAGMA foreign_key_check').get()) adoptionFail('transition_integrity_failed');
    const mainIds = db.query('SELECT id FROM memory_identity').all() as { id: string }[];
    const ledgerIds = ledger.query('SELECT id FROM identity').all() as { id: string }[];
    if (mainIds.length !== 1 || ledgerIds.length !== 1 || mainIds[0]?.id !== o.source.installationId || ledgerIds[0]?.id !== o.source.installationId) adoptionFail('transition_installation_mismatch');
    for (const sql of [
      'SELECT 1 FROM attempt_transports WHERE active=1', 'SELECT 1 FROM reply_transports WHERE active=1',
      "SELECT 1 FROM bot_computers WHERE json_extract(record_json,'$.state') NOT IN ('stopped','deleted')",
      "SELECT 1 FROM computer_operations WHERE state!='done'", "SELECT 1 FROM computer_inputs WHERE state='dispatching'",
      "SELECT 1 FROM personal_flows WHERE json_extract(record_json,'$.state')='exchanging'",
      "SELECT 1 FROM personal_reads WHERE json_extract(record_json,'$.outcome')='running'",
    ]) if (db.query(sql).get()) adoptionFail('transition_settlement_required');
    const checkNative = (d: Database) => {
      for (const row of d.query('SELECT record_json FROM native_intents').all() as { record_json: string }[]) {
        const intent = JSON.parse(row.record_json);
        if (!['retired', 'deleted', 'not_created'].includes(intent.state) || intent.state === 'retired' && !intent.reference) adoptionFail('transition_native_settlement_required');
      }
    };
    checkNative(db); checkNative(ledger);
    const original = db.serialize();
    const sanitized = credentialFreeImage({ read: fn => fn(tx), snapshotBytes: () => original });
    clean = Database.deserialize(sanitized, { safeIntegers: true });
    const history = (clean.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[]).flatMap(x => rows(clean!, x.name));
    const facts = opsLedgerTables.flatMap(t => rows(ledger, t, `lifecycle.${t}`));
    // Keep every orphan high-water mark. The projection is a maximum, never a new allowance.
    const usage = new Map<string, Record<string, bigint | string>>();
    for (const d of [clean, ledger]) for (const row of d.query('SELECT * FROM grant_usage ORDER BY grant_id').all() as Record<string, bigint | string>[]) {
      const prior = usage.get(row.grant_id as string);
      if (!prior) usage.set(row.grant_id as string, { ...row });
      else for (const key of ['attempts', 'steps', 'calls', 'output_bytes', 'reads']) prior[key] = BigInt(prior[key]!) > BigInt(row[key]!) ? prior[key]! : row[key]!;
    }
    for (const [ordinal, value] of [...usage.values()].entries()) {
      if (Object.entries(value).some(([k, v]) => k !== 'grant_id' && BigInt(v) < 0n)) adoptionFail('transition_integrity_failed');
      const cells = Object.entries(value).map(([key, value]): [string, AdoptionCell] => [key, cell(value)]);
      facts.push({ table: 'continuity.grant_usage', ordinal, cells, hash: hashValue(cells) });
    }
    const floor = { attempts: 0, steps: 0, calls: 0, reads: 0, outputBytes: 0 };
    for (const [key, column] of [['attempts', 'attempts'], ['steps', 'steps'], ['calls', 'calls'], ['reads', 'reads'], ['outputBytes', 'output_bytes']] as const) {
      const sum = [...usage.values()].reduce((n, row) => n + BigInt(row[column]!), 0n);
      if (sum > BigInt(Number.MAX_SAFE_INTEGER)) adoptionFail('transition_usage_unrepresentable');
      floor[key] = Number(sum);
    }
    let unknownEffects = 0;
    const claimed = ledger.query("SELECT id,mode FROM withdrawals WHERE kind='effect_claim'").all() as { id: string; mode: string }[];
    for (const [ordinal, row] of (db.query('SELECT id,record_json FROM effects ORDER BY id').all() as { id: string; record_json: string }[]).entries()) {
      const effect = JSON.parse(row.record_json);
      if (effect.id !== row.id || !Number.isSafeInteger(effect.revision) || effect.revision < 1 || !['pending', 'approved', 'executing', 'unknown', 'succeeded', 'failed', 'denied', 'expired', 'changed'].includes(effect.state)) adoptionFail('transition_effect_unrepresentable');
      hash(effect.actionHash);
      if (claimed.some(c => c.id === effect.id && c.mode !== `revision_${effect.revision}`) ||
          ledger.query('SELECT 1 FROM effect_outcomes WHERE effect_id=? AND action_hash!=?').get(effect.id, effect.actionHash)) adoptionFail('transition_effect_revision_conflict');
      let state = effect.state;
      if (['pending', 'approved', 'executing'].includes(state)) state = state === 'executing' || claimed.some(c => c.id === effect.id && c.mode === `revision_${effect.revision}`) ? 'unknown' : 'expired';
      if (state === 'unknown') unknownEffects++;
      const cells: AdoptionRow['cells'] = [['id', cell(row.id)], ['record_json', cell(encode({ id: row.id, revision: effect.revision, actionHash: effect.actionHash, state, executable: false }))]];
      facts.push({ table: 'continuity.effects', ordinal, cells, hash: hashValue(cells) });
    }
    const requests = (db.query('SELECT request_id,payload_hash,result_json FROM command_receipts ORDER BY request_id').all() as { request_id: string; payload_hash: string; result_json: string }[]).map(r => {
      id(r.request_id); hash(r.payload_hash);
      return { id: r.request_id, payloadHash: r.payload_hash, outcomeHash: hashBytes(r.result_json) };
    });
    if (history.length + facts.length + requests.length > maximumRows || facts.some(row => containsCredential(encode(row)))) adoptionFail('transition_bounds_or_credential_content');
    verifySourceFiles(o, before);
    const boundary = o.boundary.observe(); id(boundary.hostId); hash(boundary.evidenceHash);
    const refusals: string[] = [];
    if (!boundary.protected || !boundary.settled || !boundary.priorBuildFenceVerified || boundary.sourceArtifact !== o.source.build.sha256 || boundary.targetArtifact !== o.target.sha256) refusals.push('transition_protected_settlement_required');
    const checkpointHash = hashValue(before);
    const body = { contract: 's15-state-transition/v1' as const, sourceRuntime: o.source.runtime, installationId: o.source.installationId,
      sourceBuild: { commit: o.source.build.commit, sha256: o.source.build.sha256 }, targetBuild: { commit: o.target.commit, sha256: o.target.sha256 },
      hostId: boundary.hostId, hostEvidenceHash: boundary.evidenceHash, checkpointHash,
      historyRows: history.length, continuityRows: facts.length, pendingRequests: requests.length, unknownEffects,
      privateItems: Number((db.query('SELECT count(*) n FROM memory_sources').get() as { n: number }).n) + Number((db.query('SELECT count(*) n FROM memory_claims').get() as { n: number }).n),
      files: before.length, bytes: before.reduce((sum, x) => sum + x.bytes, 0), policy: 'empty_requires_owner_install' as const,
      importedExecution: 'disabled' as const, teamConversions: 0 as const, refusals };
    const owner = db.query('SELECT generation FROM owner').get() as { generation: number } | null;
    if (!owner || !Number.isSafeInteger(owner.generation) || owner.generation < 1) adoptionFail('transition_owner_unavailable');
    return { report: { ...body, planHash: hashValue(body) }, files: before, rows: history, facts, requests, ownerGeneration: owner.generation,
      reservations: { sourceHash: checkpointHash, usage: floor } };
  } finally { clean?.close(); db.close(); ledger.close(); }
}

/** Dry run creates no files, locks, candidate, policy, credentials or workers. Safe refusal codes contain no payload. */
export function reportAdoption(o: AdoptionOptions): AdoptionReport { return snapshotSource(o).report; }
