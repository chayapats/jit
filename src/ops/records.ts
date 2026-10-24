import { lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { validateDrillRecord, validateProfileRecord, validateReleaseRecord,
  type LoadDrillRecord, type OpsProfile, type ReleaseChecklist } from "./contracts";
import { opsBounds, opsEvidenceRetention, withinBound } from "./limits";
import { bindToDrill } from "./report";
import { readBoundedJson } from "../evidence/records";

/** Exact deep validation for every ops record kind; used on compose, write, read and export. */
export function validateOpsRecord(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_ops_record");
  const schema = (value as { schema?: unknown }).schema;
  if (schema === "jit.ops.drill/v1") { validateDrillRecord(value); return; }
  if (schema === "jit.ops.profile/v1") { validateProfileRecord(value); return; }
  if (schema === "jit.ops.release/v1") { validateReleaseRecord(value); return; }
  throw new Error("invalid_ops_record");
}

/** Retention applied at record creation: `JIT_OPS_RETENTION_DAYS` plus the fixed count/byte ceilings. */
export interface OpsRetention {
  retentionDays: number;
  /** Wall clock for the age cut-off (injectable for tests). */
  now?: number;
}

const recordName = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/;

/**
 * Prunes `.local/ops-evidence`: regular record files older than the retention
 * age go first, then the oldest beyond `maxRecords` or `maxBytes` (counting the
 * record about to be written). Symlinks and foreign names are never touched.
 * The pass sees the complete directory or nothing: more than
 * `maxDirectoryEntries` entries fails closed (`ops_evidence_overflow`) before
 * anything is removed or written, so unscanned records can never break the
 * count/byte ceilings. Returns the number of removed records.
 */
async function pruneOpsRecords(dir: string, retention: OpsRetention, incomingBytes: number): Promise<number> {
  if (!withinBound(retention.retentionDays, opsBounds.retentionDays)) throw new Error("invalid_ops_retention");
  const now = retention.now ?? Date.now();
  const cutoff = now - retention.retentionDays * 86_400_000;
  const entries: { path: string; mtime: number; bytes: number }[] = [];
  const names: string[] = [];
  let seen = 0;
  const handle = await opendir(dir);
  try {
    for await (const entry of handle) {
      if (++seen > opsEvidenceRetention.maxDirectoryEntries) throw new Error("ops_evidence_overflow");
      if (recordName.test(entry.name)) names.push(entry.name);
    }
  } finally { try { await handle.close(); } catch { /* Already closed by iteration. */ } }
  for (const name of names) {
    const path = join(dir, name);
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink()) continue;
    entries.push({ path, mtime: stats.mtimeMs, bytes: stats.size });
  }
  entries.sort((a, b) => a.mtime - b.mtime || a.path.localeCompare(b.path));
  const victims = new Set(entries.filter(e => e.mtime < cutoff).map(e => e.path));
  let kept = entries.filter(e => !victims.has(e.path));
  let bytes = kept.reduce((sum, e) => sum + e.bytes, 0) + incomingBytes;
  while (kept.length > 0 && (kept.length + 1 > opsEvidenceRetention.maxRecords || bytes > opsEvidenceRetention.maxBytes)) {
    const oldest = kept.shift()!;
    victims.add(oldest.path);
    bytes -= oldest.bytes;
  }
  for (const path of victims) await unlink(path);
  return victims.size;
}

async function localDirectory(root: string, create: boolean): Promise<string> {
  const local = resolve(root, ".local");
  if (create) { try { await mkdir(local, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } }
  const info = await lstat(local);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077) throw new Error("unsafe_local_directory");
  return realpath(local);
}

/** Drill invocation files must resolve beneath this installation's ignored `.local` directory. */
export async function readLocalDrillConfig(root: string, path: string): Promise<unknown> {
  const local = await localDirectory(root, false), file = resolve(root, path);
  const parent = await realpath(dirname(file)), rel = relative(local, parent);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) throw new Error("configuration_must_be_local");
  return readBoundedJson(file, 8192);
}

async function recordsDirectory(root: string, create: boolean): Promise<string> {
  const local = await localDirectory(root, create), dir = resolve(local, "ops-evidence");
  if (create) { try { await mkdir(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } }
  const stats = await lstat(dir);
  if (!stats.isDirectory() || stats.isSymbolicLink() || stats.mode & 0o077) throw new Error("unsafe_ops_directory");
  return dir;
}

/**
 * Writes a validated, bounded mode-0600 record once, after applying retention
 * (age from `retention.retentionDays`, default the installation default of 30
 * days, then the count/byte ceilings). Failures remove any incomplete new artifact.
 */
export async function writeOpsRecord(root: string, value: unknown, retention: OpsRetention = { retentionDays: 30 }): Promise<void> {
  validateOpsRecord(value);
  // Profiles and releases are bound to the stored drill they reference before anything is written.
  await bindStored(root, value);
  const dir = await recordsDirectory(root, true), path = join(dir, `${(value as { id: string }).id}.json`);
  const body = JSON.stringify(value) + "\n";
  try { await lstat(path); throw new Error("ops_record_exists"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await pruneOpsRecords(dir, retention, Buffer.byteLength(body));
  const file = await open(path, "wx", 0o600);
  let complete = false;
  try {
    await file.writeFile(body);
    await file.sync();
    const parent = await open(dir, "r");
    try { await parent.sync(); } finally { await parent.close(); }
    complete = true;
  } finally {
    await file.close();
    if (!complete) await unlink(path);
  }
}

/** Reads only a named versioned record; malformed or unknown-field artifacts cannot be exported. */
export async function readOpsRecord(root: string, id: string): Promise<unknown> {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new Error("invalid_ops_record_id");
  const dir = await recordsDirectory(root, false), value = await readBoundedJson(join(dir, `${id}.json`), 32769);
  validateOpsRecord(value);
  await bindStored(root, value);
  return value;
}

/** Loads the referenced drill (exact read, no recursion) and binds a profile/release to it; drills need no binding. */
async function bindStored(root: string, value: unknown): Promise<void> {
  const record = value as OpsProfile | ReleaseChecklist | LoadDrillRecord;
  if (record.schema === "jit.ops.drill/v1") return;
  let drill: LoadDrillRecord | null = null;
  if (record.drillId !== null) {
    try {
      const dir = await recordsDirectory(root, false);
      const raw = await readBoundedJson(join(dir, `${record.drillId}.json`), 32769);
      validateDrillRecord(raw);
      drill = raw;
    } catch { throw new Error("invalid_ops_record"); }
  }
  bindToDrill(record, drill);
}

/**
 * Rebuilds the schema-specific allowlisted export. Profiles and releases need
 * their referenced drill (`drill`) and are bound to it. Every field is re-validated
 * first; route/model detail never leaves local records. Profiles print every
 * field a reviewer needs (revisions, config/workload, measurements, typed
 * exhausted limits, sample limitations and the fixed Pi-readiness disclaimer).
 */
export function exportOpsSummary(value: unknown, drill: LoadDrillRecord | null = null): Record<string, unknown> {
  validateOpsRecord(value);
  const schema = (value as { schema: string }).schema;
  // Profiles and releases export only together with the drill they are bound to.
  if (schema !== "jit.ops.drill/v1") bindToDrill(value as OpsProfile | ReleaseChecklist, drill);
  if (schema === "jit.ops.profile/v1") {
    const p = value as OpsProfile;
    return { schema: p.schema, recordId: p.id, observedAt: p.observedAt, drillId: p.drillId, versions: structuredClone(p.versions),
      config: { ...p.config }, measurements: { ...p.measurements }, exhaustedLimits: [...p.exhaustedLimits],
      sampleLimitations: [...p.sampleLimitations], piReadiness: p.piReadiness,
      readinessDisclaimer: "desktop fixture drill; not a latency SLO and not Pi or capacity readiness evidence", nextAction: p.nextAction };
  }
  if (schema === "jit.ops.release/v1") {
    const r = value as ReleaseChecklist;
    return { schema: r.schema, recordId: r.id, observedAt: r.observedAt, drillId: r.drillId,
      rows: [...r.deterministic, ...r.human].map(row => ({ id: row.id, state: row.state, evidenceId: row.evidenceId })),
      outcome: r.outcome, nextAction: r.nextAction };
  }
  const d = value as LoadDrillRecord;
  return { schema: d.schema, recordId: d.id, observedAt: d.observedAt, versions: structuredClone(d.versions), config: { ...d.config },
    legs: d.legs.map(l => ({ leg: l.leg, state: l.state, elapsedMs: l.elapsedMs })),
    measurements: { ...d.measurements }, exhaustedLimits: [...d.exhaustedLimits], outcome: d.outcome, nextAction: d.nextAction };
}
