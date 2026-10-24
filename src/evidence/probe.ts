import { Database } from "bun:sqlite";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, readdir, realpath, rename, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { routeEvidence, safeAlias, type NextAction, type RouteState } from "./contract";

/**
 * SKELETON — jit.host.probe/v1 (FEAS02, issue #17).
 *
 * Repeatable host-probe command shape over the concrete Schway bridge.
 * Schway ENG03/05/06/07/08/09 are OPEN, so live inference has no supported
 * transport here: the default ports fail closed without network, accounts or
 * secret reads, and scripted ports cover every classifier state in tests.
 */

export const PROBE_SCHEMA = "jit.host.probe/v1" as const;
/** Fixed non-sensitive live prompt; it names no project, credential, path or person. */
export const PROBE_PROMPT = "jit host probe: report readiness only" as const;
/** Empty tool registry for every live dispatch; strict discovery stays off. */
export const PROBE_TOOLS: readonly [] = [];
/** Discovery policy for every live dispatch; hosted lookup and repository discovery are disabled. */
export const PROBE_DISCOVERY = { repository: false, hosted: false } as const;

export const probeModes = ["preflight", "live"] as const;
export type ProbeMode = typeof probeModes[number];
export const probeLifecycles = ["started", "interrupted", "cancelled"] as const;
export type ProbeLifecycle = typeof probeLifecycles[number];

/** Separately labeled probe observations; inference evidence can never stand in for the others. */
export const probeObservations = ["service-start", "credential-read", "live-request", "renewal"] as const;
export type ProbeObservation = typeof probeObservations[number];
export const probeEvents = ["unobserved", "success", "login", "store", "quota", "rejected", "failed"] as const;
export type ProbeEvent = typeof probeEvents[number];

/** One labeled observation inside a probe record; renewal is never inferred from login. */
export interface ProbeObservationEntry {
  observation: ProbeObservation;
  probeClass: "preflight" | "inference" | "renewal";
  event: ProbeEvent;
  state: RouteState;
  nextAction: NextAction;
  attempts: number;
  elapsedMs: number;
}

/** Persisted probe attempt; terminal route states never overwrite an interrupted/cancelled lifecycle. */
export interface ProbeAttempt {
  schema: typeof PROBE_SCHEMA;
  id: string;
  observedAt: string;
  installationLabel: string;
  mode: ProbeMode;
  route: string;
  model: string | null;
  lifecycle: ProbeLifecycle | RouteState;
  maxAttempts: number;
  attempts: number;
  deadlineMs: number;
  elapsedMs: number;
  observations: ProbeObservationEntry[];
  promptBytes: number;
  nextAction: NextAction;
}

/** Bounded self-process sample for the probe command itself; never environment, tokens or paths. */
export interface ProbeSelfSample {
  elapsedMs: number; attemptsUsed: number; maxAttempts: number;
  /** Own-process heap at completion; a resource sample, never a capacity claim. */
  peakMemoryBytes: number;
  /** Bounded scan of managed probe artifacts; file count caps the walk. */
  managedBytes: number; managedFiles: number;
  /**
   * Exact provider-send counts observed on the counting transport for this
   * probe (inference plus token-endpoint sends). The pinned per-admission
   * structural bound is two of each; a counter-validation failure
   * terminalizes the attempt as failed, never as success.
   */
  providerSends: { inference: number; token: number };
}

/** Best-effort self resource sample; failures report zeros rather than failing the probe. */
async function selfResources(root: string): Promise<Pick<ProbeSelfSample, "peakMemoryBytes" | "managedBytes" | "managedFiles">> {
  let peakMemoryBytes = 0;
  try { peakMemoryBytes = process.memoryUsage().heapUsed; } catch { /* Own-process sample only. */ }
  let managedBytes = 0, managedFiles = 0;
  // One entry budget shared across every managed root: each directory entry
  // is debited before filtering, symlink checks or stats, so skipped entries
  // cannot widen the walk. Streaming directory reads never materialize an
  // unbounded listing, and symlinks are never followed.
  let seen = 0;
  const scan = async (top: string): Promise<void> => {
    const stack: string[] = [top];
    while (stack.length > 0) {
      if (seen >= MAX_SELF_SCAN_FILES) return;
      const current = stack.pop()!;
      let dir;
      try {
        dir = await opendir(current);
      } catch { continue; }
      try {
        for await (const entry of dir) {
          if (seen >= MAX_SELF_SCAN_FILES) return;
          seen++;
          if (entry.name.startsWith(".tmp-")) continue;
          if (entry.isSymbolicLink()) continue;
          const full = resolve(current, entry.name);
          if (entry.isDirectory()) {
            stack.push(full);
            continue;
          }
          if (!entry.isFile()) continue;
          try {
            const stats = await lstat(full);
            if (stats.isFile() && !stats.isSymbolicLink()) { managedFiles++; managedBytes += stats.size; }
          } catch { /* One unreadable artifact does not fail the sample. */ }
        }
      } finally {
        await dir.close().catch(() => {});
      }
    }
  };
  try {
    await scan(resolve(root, ".local", "host-probe"));
    await scan(resolve(root, ".local", "host-probe-host"));
  } catch { /* Missing directories read as empty. */ }
  return { peakMemoryBytes, managedBytes, managedFiles };
}

/** Scriptable live boundary; production implementations use Schway credential renewal and native transport. */
export interface ProbePorts {
  now(): number;
  id(): string;
  /** Reports local credential-boundary readability only; it never returns secret material. */
  readCredential(signal: AbortSignal): Promise<"ok" | "missing" | "locked">;
  /** One bounded inference attempt with the fixed prompt, empty tools and strict discovery off. */
  infer(input: { route: string; model: string; prompt: typeof PROBE_PROMPT; tools: readonly []; discovery: { repository: false; hosted: false }; deadlineMs: number }, signal: AbortSignal): Promise<ProbeEvent>;
  /**
   * Exact provider-send counts for the last infer call. Absent on scripted
   * ports; the concrete bridge reports every transport send through its
   * counting wrapper so Schway-owned refresh traffic is never hidden.
   */
  takeProviderSends?(): { inference: number; token: number };
}

/** Live options demand explicit opt-in: exact route/model plus finite attempts/deadline. */
export interface LiveProbeOptions { route: string; model: string; maxAttempts: number; deadlineMs: number }

const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const instantPattern = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
/** Cap for every managed-artifact scan; the walk never grows with installation size. */
const MAX_SELF_SCAN_FILES = 4096;

function fail(): never { throw new Error("invalid_probe_record"); }

/** Rejects malformed, unknown-field and oversized probe input before persistence or export. */
export function parseLiveOptions(value: unknown): LiveProbeOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_probe_options");
  const options = value as Record<string, unknown>;
  if (Object.keys(options).sort().join(",") !== "deadlineMs,maxAttempts,model,route") throw new Error("invalid_probe_options");
  const route = safeAlias(options.route), model = safeAlias(options.model);
  if (typeof model !== "string") throw new Error("invalid_probe_options");
  if (!Number.isSafeInteger(options.maxAttempts) || (options.maxAttempts as number) < 1 || (options.maxAttempts as number) > 10) throw new Error("invalid_probe_options");
  if (!Number.isSafeInteger(options.deadlineMs) || (options.deadlineMs as number) < 1 || (options.deadlineMs as number) > 60000) throw new Error("invalid_probe_options");
  return { route, model, maxAttempts: options.maxAttempts as number, deadlineMs: options.deadlineMs as number };
}

/** Validates bounded local probe configuration; route/model selection stays explicit per live call. */
export function parseProbeConfig(raw: unknown): { installationLabel: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_configuration");
  const config = raw as Record<string, unknown>;
  if (Object.keys(config).some(key => !["installationLabel", "routes"].includes(key))) throw new Error("invalid_configuration");
  return { installationLabel: safeAlias(config.installationLabel) };
}

const exactKeys = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** Rejects malformed or unknown-field probe records before any read, write or export. */
export function validateProbeAttempt(value: unknown): asserts value is ProbeAttempt {
  if (!exactKeys(value, ["schema", "id", "observedAt", "installationLabel", "mode", "route", "model", "lifecycle",
      "maxAttempts", "attempts", "deadlineMs", "elapsedMs", "observations", "promptBytes", "nextAction"])) fail();
  const record = value as unknown as ProbeAttempt;
  if (record.schema !== PROBE_SCHEMA || !uuidPattern.test(record.id) || typeof record.observedAt !== "string" ||
      !instantPattern.test(record.observedAt) || !Number.isFinite(Date.parse(record.observedAt)) ||
      safeAlias(record.installationLabel) !== record.installationLabel || !probeModes.includes(record.mode) ||
      safeAlias(record.route) !== record.route || (record.model !== null && safeAlias(record.model) !== record.model) ||
      (!probeLifecycles.includes(record.lifecycle as ProbeLifecycle) &&
        !["not-configured", "configured-unverified", "observed-ready", "needs-login", "store-unavailable", "quota-waiting", "rejected", "failed"].includes(record.lifecycle)) ||
      !Number.isSafeInteger(record.maxAttempts) || record.maxAttempts < 1 || record.maxAttempts > 10 ||
      !Number.isSafeInteger(record.attempts) || record.attempts < 0 || record.attempts > record.maxAttempts ||
      !Number.isSafeInteger(record.deadlineMs) || record.deadlineMs < 1 || record.deadlineMs > 60000 ||
      !Number.isSafeInteger(record.elapsedMs) || record.elapsedMs < 0 || record.elapsedMs > 120000 ||
      !Array.isArray(record.observations) || record.observations.length !== 4 || typeof record.promptBytes !== "number" ||
      record.promptBytes !== Buffer.byteLength(PROBE_PROMPT)) fail();
  const seen = new Set<string>();
  for (const item of record.observations) {
    const itemEntry = item as ProbeObservationEntry;
    if (!exactKeys(itemEntry, ["observation", "probeClass", "event", "state", "nextAction", "attempts", "elapsedMs"]) ||
        !probeObservations.includes(itemEntry.observation) || seen.has(itemEntry.observation) ||
        (itemEntry.observation === "live-request" ? itemEntry.probeClass !== "inference"
          : itemEntry.observation === "renewal" ? itemEntry.probeClass !== "renewal" : itemEntry.probeClass !== "preflight") ||
        !probeEvents.includes(itemEntry.event) || !Number.isSafeInteger(itemEntry.attempts) || itemEntry.attempts < 0 || itemEntry.attempts > record.maxAttempts ||
        !Number.isSafeInteger(itemEntry.elapsedMs) || itemEntry.elapsedMs < 0 || itemEntry.elapsedMs > 120000) fail();
    seen.add(itemEntry.observation);
    const classified = routeEvidence({ route: record.route, model: record.model,
      observation: itemEntry.observation === "service-start" ? "service-start" : itemEntry.observation,
      probeClass: itemEntry.probeClass, maxAttempts: record.maxAttempts, attempts: itemEntry.attempts,
      deadlineMs: record.deadlineMs, elapsedMs: itemEntry.elapsedMs, configured: true, event: itemEntry.event });
    if (classified.state !== itemEntry.state || classified.nextAction !== itemEntry.nextAction) fail();
  }
  if (Buffer.byteLength(JSON.stringify(record)) > 8192) fail();
  // The persisted lifecycle must agree with its labeled observations; a tampered
  // success state over unobserved inference evidence cannot validate.
  if (!probeLifecycles.includes(record.lifecycle as ProbeLifecycle)) {
    const liveEntry = record.observations.find(item => item.observation === "live-request")!;
    const credentialEntry = record.observations.find(item => item.observation === "credential-read")!;
    const expected = liveEntry.event === "unobserved" ? credentialEntry.state : liveEntry.state;
    if (record.lifecycle !== expected) fail();
  }
}

function entry(route: string, model: string | null, bounds: { maxAttempts: number; deadlineMs: number },
  observation: ProbeObservation, event: ProbeEvent, attempts: number, elapsedMs: number): ProbeObservationEntry {
  const probeClass = observation === "live-request" ? "inference" as const : observation === "renewal" ? "renewal" as const : "preflight" as const;
  const classified = routeEvidence({ route, model, observation: observation === "service-start" ? "service-start" : observation,
    probeClass, maxAttempts: bounds.maxAttempts, attempts, deadlineMs: bounds.deadlineMs, elapsedMs, configured: true, event });
  return { observation, probeClass, event, state: classified.state, nextAction: classified.nextAction, attempts, elapsedMs };
}

/** A credential read is one observation; only an actual read outcome counts as an attempt. */
function credentialEntry(route: string, model: string | null, bounds: { maxAttempts: number; deadlineMs: number }, event: ProbeEvent): ProbeObservationEntry {
  return entry(route, model, bounds, "credential-read", event, event === "unobserved" ? 0 : 1, 0);
}

function summarize(observations: ProbeObservationEntry[], lifecycle: ProbeAttempt["lifecycle"]): { state: ProbeAttempt["lifecycle"]; nextAction: NextAction } {
  if (lifecycle === "started" || lifecycle === "interrupted" || lifecycle === "cancelled") return { state: lifecycle, nextAction: "inspect-sanitized-failure" };
  const inference = observations.find(item => item.observation === "live-request")!;
  const credential = observations.find(item => item.observation === "credential-read")!;
  // Preflight performs no inference, so the credential observation carries the route state.
  if (inference.event === "unobserved") return { state: credential.state, nextAction: credential.nextAction };
  return { state: inference.state, nextAction: inference.nextAction };
}

function serviceUid(): number | null {
  try {
    const getuid = (process as unknown as { getuid?: () => number }).getuid;
    return typeof getuid === "function" ? getuid() : null;
  } catch { return null; }
}

/**
 * Canonical installation-local directory: the convention path itself must
 * resolve to a real directory with restrictive mode and service ownership.
 * An ancestor or self symlink would redirect managed state outside the
 * installation, so canonical identity is checked, not just the final link.
 */
function missingProbeDirectory(): NodeJS.ErrnoException {
  const missing = new Error("missing_probe_directory") as NodeJS.ErrnoException;
  missing.code = "ENOENT";
  return missing;
}

async function canonicalLocal(root: string, create: boolean): Promise<string> {
  const canonRoot = await realpath(root);
  const local = resolve(canonRoot, ".local");
  if (create) { try { await mkdir(local, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
  // The convention directory itself must be a real directory: an ancestor or
  // self symlink would redirect managed state outside the installation.
  const present = await lstat(local).catch(() => null);
  if (present === null) {
    if (create) throw new Error("unsafe_local_directory");
    throw missingProbeDirectory();
  }
  if (await realpath(local) !== local) throw new Error("unsafe_local_directory");
  const uid = serviceUid();
  if (!present.isDirectory() || present.isSymbolicLink() || (present.mode & 0o077) !== 0 || (uid !== null && present.uid !== uid)) {
    throw new Error("unsafe_local_directory");
  }
  return local;
}

async function probeDirectory(root: string, create: boolean): Promise<string> {
  const local = await canonicalLocal(root, create);
  const dir = resolve(local, "host-probe");
  if (create) { try { await mkdir(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
  const present = await lstat(dir).catch(() => null);
  if (present === null) {
    if (create) throw new Error("unsafe_probe_directory");
    throw missingProbeDirectory();
  }
  if (await realpath(dir) !== dir) throw new Error("unsafe_probe_directory");
  const uid = serviceUid();
  if (!present.isDirectory() || present.isSymbolicLink() || (present.mode & 0o077) !== 0 || (uid !== null && present.uid !== uid)) {
    throw new Error("unsafe_probe_directory");
  }
  return dir;
}

/** One in-process mutex per record id so concurrent lifecycle transitions serialize. */
const recordLocks = new Map<string, Promise<void>>();

async function withRecordLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const prior = recordLocks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>(resolve => { release = resolve; });
  recordLocks.set(id, mine);
  await prior.catch(() => {});
  try {
    return await work();
  } finally {
    release();
    if (recordLocks.get(id) === mine) recordLocks.delete(id);
  }
}

/**
 * Cross-process terminal compare-and-set. Every lifecycle transition runs
 * inside one SQLite `BEGIN IMMEDIATE` transaction: the record is re-read
 * under the lock, a non-started record is returned byte-for-byte unchanged,
 * and only the first claimant writes its terminal record. The file write
 * happens inside the same critical section, so no stale-takeover race or
 * owner-age rule exists: a crashed holder's transaction rolls back and the
 * next contender re-reads authoritative state. Losers never acknowledge.
 */
/**
 * Opens the installation-local lifecycle ledger without following planted
 * symlinks or foreign files. An existing ledger must be a service-owned
 * regular mode-0600 file; a missing ledger is created exclusively before
 * SQLite touches the path, so terminalization can never create or modify a
 * database outside the managed directory. A lost exclusive-create race
 * (EEXIST) reopens through the same validation instead of failing: the
 * winner's file is verified, never trusted blindly.
 */
async function lifecycleDb(dir: string): Promise<Database> {
  const path = await ensureLedgerFile(dir);
  const db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("CREATE TABLE IF NOT EXISTS probe_terminal(id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL)");
  return db;
}

/** Thrown when the deadline fires between payload build and publication. */
class PublishAborted extends Error {
  constructor() { super("publish_aborted"); }
}

/**
 * In-process serialization for first-use ledger creation. The cross-process
 * EEXIST retry below remains the correctness mechanism; this gate only
 * avoids redundant creation races inside one process.
 */
const ledgerInit = new Map<string, Promise<void>>();

async function ensureLedgerFile(dir: string): Promise<string> {
  const path = resolve(dir, "lifecycle.db");
  let init = ledgerInit.get(dir);
  if (!init) {
    init = (async () => {
      const present = await lstat(path).catch(() => null);
      if (present !== null) {
        assertLedgerFile(dir, path, present);
      } else {
        try {
          const handle = await open(path, "wx", 0o600);
          await handle.close();
        } catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
          const raced = await lstat(path).catch(() => null);
          if (raced === null) throw error;
          assertLedgerFile(dir, path, raced);
        }
      }
    })();
    ledgerInit.set(dir, init);
    init.then(
      () => { if (ledgerInit.get(dir) === init) ledgerInit.delete(dir); },
      () => { if (ledgerInit.get(dir) === init) ledgerInit.delete(dir); },
    );
  }
  await init;
  return path;
}

function assertLedgerFile(dir: string, path: string, present: { isFile(): boolean; isSymbolicLink(): boolean; mode: number; uid: number }): void {
  if (!present.isFile() || present.isSymbolicLink()) throw new Error("unsafe_probe_ledger");
  // The parent directory is canonical-checked by probeDirectory, so a
  // non-symlink regular file here cannot escape the managed directory; a
  // hardlink to outside content would still require write access to this
  // service-owned mode-0700 directory, which already owns the evidence.
  void dir; void path;
  const uid = serviceUid();
  if ((present.mode & 0o077) !== 0 || (uid !== null && present.uid !== uid)) throw new Error("unsafe_probe_ledger");
}

async function transitionTerminal(root: string, id: string,
  build: (current: ProbeAttempt) => ProbeAttempt | null,
  opts: { signal?: AbortSignal; abortBuild?: (current: ProbeAttempt) => ProbeAttempt | null } = {},
): Promise<{ committed: boolean; record: ProbeAttempt }> {
  return withRecordLock(id, async () => {
    const dir = await probeDirectory(root, true);
    const db = await lifecycleDb(dir);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = await readProbeAttempt(root, id);
        if (current.lifecycle !== "started") {
          db.exec("ROLLBACK");
          return { committed: false, record: current };
        }
        let next = build(current);
        if (next === null) {
          db.exec("ROLLBACK");
          return { committed: false, record: current };
        }
        validateProbeAttempt(next);
        try {
          await atomicWriteFile(dir, `${id}.json`, JSON.stringify(next) + "\n", () => {
            if (opts.signal?.aborted) throw new PublishAborted();
          });
        } catch (error) {
          if (!(error instanceof PublishAborted)) throw error;
          // The deadline fired during publication: publish cancelled with
          // non-success evidence in this same winning transaction instead of
          // the success payload that was already built.
          const fallback = opts.abortBuild?.(current) ?? null;
          if (fallback === null) {
            db.exec("ROLLBACK");
            return { committed: false, record: current };
          }
          validateProbeAttempt(fallback);
          await atomicWriteFile(dir, `${id}.json`, JSON.stringify(fallback) + "\n");
          next = fallback;
        }
        db.query("INSERT OR IGNORE INTO probe_terminal(id, lifecycle) VALUES (?, ?)").run(id, next.lifecycle);
        db.exec("COMMIT");
        return { committed: true, record: next };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* Already rolled back. */ }
        throw error;
      }
    } finally {
      db.close();
    }
  });
}

/**
 * Durably reserves one admission before any provider contact. The persisted
 * attempt count grows inside the same cross-process transaction that
 * rechecks `started`, so a separate cancel serializes against the
 * reservation (no new request starts after cancellation acknowledges) and a
 * crash/restart preserves the admitted count instead of recording zero.
 */
async function reserveAttempt(root: string, id: string): Promise<{ admitted: boolean; attempts: number }> {
  return withRecordLock(id, async () => {
    const dir = await probeDirectory(root, true);
    const db = await lifecycleDb(dir);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = await readProbeAttempt(root, id);
        if (current.lifecycle !== "started" || current.attempts >= current.maxAttempts) {
          db.exec("ROLLBACK");
          return { admitted: false, attempts: current.attempts };
        }
        const next: ProbeAttempt = { ...current, attempts: current.attempts + 1 };
        validateProbeAttempt(next);
        await atomicWriteFile(dir, `${id}.json`, JSON.stringify(next) + "\n");
        db.exec("COMMIT");
        return { admitted: true, attempts: next.attempts };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* Already rolled back. */ }
        throw error;
      }
    } finally {
      db.close();
    }
  });
}

let tmpCounter = 0;

/**
 * Publishes one record atomically: exclusive temp file, fsync, atomic rename
 * and a required directory sync. Directory-open/sync failures are persistence
 * failures, never best-effort skips: acknowledging them would let dispatch
 * proceed on evidence a restart cannot see. Failed temp files are removed.
 * The optional pre-rename hook runs immediately before the rename — the
 * linearization point — and may throw PublishAborted to cancel publication.
 */
async function atomicWriteFile(dir: string, name: string, data: string, preRename?: () => void): Promise<void> {
  const tmp = resolve(dir, `${name}.tmp-${process.pid}-${(tmpCounter = (tmpCounter + 1) % 1000000)}.json`);
  const file = await open(tmp, "wx", 0o600);
  try {
    await file.writeFile(data);
    await file.sync();
  } catch (error) {
    try { await unlink(tmp); } catch { /* Best-effort temp cleanup. */ }
    throw error;
  } finally {
    await file.close();
  }
  try {
    preRename?.();
  } catch (error) {
    try { await unlink(tmp); } catch { /* Best-effort temp cleanup. */ }
    throw error;
  }
  try {
    await rename(tmp, resolve(dir, name));
  } catch (error) {
    try { await unlink(tmp); } catch { /* Best-effort temp cleanup. */ }
    throw error;
  }
  const dirFd = await open(dir, "r");
  try {
    await dirFd.sync();
  } finally {
    await dirFd.close();
  }
}

async function writeAttempt(root: string, record: ProbeAttempt): Promise<void> {
  validateProbeAttempt(record);
  const dir = await probeDirectory(root, true);
  // Create-only: a terminal record is never replaced by a fresh dispatch.
  try {
    await lstat(resolve(dir, `${record.id}.json`));
    throw new Error("invalid_probe_record");
  } catch (error) {
    if (error instanceof Error && error.message === "invalid_probe_record") throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWriteFile(dir, `${record.id}.json`, JSON.stringify(record) + "\n");
}

async function overwriteAttempt(root: string, record: ProbeAttempt): Promise<void> {
  validateProbeAttempt(record);
  const dir = await probeDirectory(root, true);
  await atomicWriteFile(dir, `${record.id}.json`, JSON.stringify(record) + "\n");
}

/** Reads one named probe attempt; malformed records cannot be exported. */
export async function readProbeAttempt(root: string, id: string): Promise<ProbeAttempt> {
  if (!uuidPattern.test(id)) throw new Error("invalid_probe_id");
  const dir = await probeDirectory(root, false);
  const file = await open(resolve(dir, `${id}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await file.stat();
    if (!stats.isFile() || stats.size > 8192) throw new Error("invalid_probe_record");
    const buffer = Buffer.alloc(8193);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 8192) throw new Error("invalid_probe_record");
    const record = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(buffer.subarray(0, bytesRead)));
    validateProbeAttempt(record);
    return record;
  } finally {
    await file.close();
  }
}

/** Lists persisted attempts in bounded filename order for restart reconciliation. */
export async function listProbeAttempts(root: string): Promise<ProbeAttempt[]> {
  return (await listProbeKeys(root)).map(({ id, record }) => record);
}

const MAX_RECONCILE_FILES = 4096;

async function listProbeKeys(root: string): Promise<{ id: string; record: ProbeAttempt }[]> {
  let dir: string;
  try {
    dir = await probeDirectory(root, false);
  } catch (error) {
    // A missing probe directory means no attempts; anything else fails closed.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const names = (await readdir(dir)).filter(name => uuidPattern.test(name.replace(/\.json$/, ""))).sort();
  if (names.length > MAX_RECONCILE_FILES) throw new Error("reconciliation_overflow");
  const records: { id: string; record: ProbeAttempt }[] = [];
  const failures: string[] = [];
  for (const name of names) {
    const id = name.replace(/\.json$/, "");
    try {
      records.push({ id, record: await readProbeAttempt(root, id) });
    } catch {
      failures.push(id);
    }
  }
  if (failures.length > 0) throw new Error(`reconcile-unreadable: ${failures.slice(0, 8).join(",")}`);
  return records;
}

/** Marks attempts orphaned by a restart as interrupted; terminal records are never rewritten. */
export async function reconcileProbeAttempts(root: string): Promise<ProbeAttempt[]> {
  const updated: ProbeAttempt[] = [];
  const failures: string[] = [];
  for (const { id } of await listProbeKeys(root)) {
    try {
      const { committed, record } = await transitionTerminal(root, id, current => ({
        ...current, lifecycle: "interrupted", nextAction: "inspect-sanitized-failure",
      }));
      if (committed) updated.push(record);
      else if (record.lifecycle === "started") failures.push(`${id}:contended`);
    } catch {
      failures.push(id);
    }
  }
  if (failures.length > 0) throw new Error(`reconcile-unreadable: ${failures.slice(0, 8).join(",")}`);
  return updated;
}

/**
 * Cancels a dispatched attempt after an owner stop. Later completions can no
 * longer promote it to success; the transactional CAS keeps the first
 * terminal state byte-for-byte across CLI invocations.
 */
export async function cancelProbeAttempt(root: string, id: string): Promise<ProbeAttempt> {
  const { record } = await transitionTerminal(root, id, current => ({
    ...current, lifecycle: "cancelled", nextAction: "inspect-sanitized-failure",
  }));
  return record;
}

/**
 * Commits a terminal outcome only when the attempt is still dispatched.
 * Late completions after cancel/restart change nothing and report the
 * settled record instead of success.
 */
export async function commitProbeOutcome(root: string, id: string, observations: ProbeObservationEntry[], attempts: number, elapsedMs: number): Promise<boolean> {
  const { committed } = await transitionTerminal(root, id, current => {
    const inference = observations.find(item => item.observation === "live-request")!;
    const credential = observations.find(item => item.observation === "credential-read")!;
    const terminal = inference.event === "unobserved"
      ? { state: credential.state, nextAction: credential.nextAction }
      : { state: inference.state, nextAction: inference.nextAction };
    return { ...current, lifecycle: terminal.state, observations, attempts, elapsedMs, nextAction: terminal.nextAction };
  });
  return committed;
}

/** Default preflight: reports configured-unverified with zero credential/inference invocations. */
export async function preflightProbe(installationLabel: string, route: string, model: string | null, ports: Pick<ProbePorts, "now" | "id">, root: string,
  bounds: { maxAttempts: number; deadlineMs: number } = { maxAttempts: 1, deadlineMs: 2000 }): Promise<{ record: ProbeAttempt; self: ProbeSelfSample }> {
  safeAlias(installationLabel);
  safeAlias(route);
  if (model !== null) safeAlias(model);
  if (!Number.isSafeInteger(bounds.maxAttempts) || bounds.maxAttempts < 1 || bounds.maxAttempts > 10 ||
      !Number.isSafeInteger(bounds.deadlineMs) || bounds.deadlineMs < 1 || bounds.deadlineMs > 60000) throw new Error("invalid_probe_options");
  const started = ports.now(), id = ports.id();
  if (!uuidPattern.test(id) || !Number.isSafeInteger(started) || started < 0) throw new Error("invalid_probe_clock");
  const observations: ProbeObservationEntry[] = [
    entry(route, model, bounds, "service-start", "unobserved", 0, 0),
    credentialEntry(route, model, bounds, "unobserved"),
    entry(route, model, bounds, "live-request", "unobserved", 0, 0),
    entry(route, model, bounds, "renewal", "unobserved", 0, 0),
  ];
  const summary = summarize(observations, "configured-unverified");
  const record: ProbeAttempt = { schema: PROBE_SCHEMA, id, observedAt: new Date(started).toISOString(), installationLabel,
    mode: "preflight", route, model, lifecycle: summary.state, maxAttempts: bounds.maxAttempts, attempts: 0,
    deadlineMs: bounds.deadlineMs, elapsedMs: 0, observations, promptBytes: Buffer.byteLength(PROBE_PROMPT), nextAction: summary.nextAction };
  // A preflight commits atomically: create the file directly in its terminal
  // state through the durable writer (file fsync plus required
  // parent-directory sync), so no restart can mistake it for a dispatched
  // live attempt and no power loss can erase the acknowledged filename.
  await writeAttempt(root, record);
  return { record, self: { elapsedMs: 0, attemptsUsed: 0, maxAttempts: record.maxAttempts,
    providerSends: { inference: 0, token: 0 }, ...(await selfResources(root)) } };
}

/**
 * Bounded live probe: persists the dispatched attempt before any inference,
 * counts every admitted request honestly, and never lets a late completion
 * after cancellation or deadline become success evidence.
 */
export async function liveProbe(installationLabel: string, options: LiveProbeOptions, ports: ProbePorts, root: string, signal: AbortSignal = new AbortController().signal): Promise<{ record: ProbeAttempt; self: ProbeSelfSample }> {
  safeAlias(installationLabel);
  const { route, model, maxAttempts, deadlineMs } = parseLiveOptions(options);
  const started = ports.now(), id = ports.id();
  if (!uuidPattern.test(id) || !Number.isSafeInteger(started) || started < 0) throw new Error("invalid_probe_clock");
  const bounds = { maxAttempts, deadlineMs };
  const base: ProbeObservationEntry[] = [
    entry(route, model, bounds, "service-start", "unobserved", 0, 0),
    credentialEntry(route, model, bounds, "unobserved"),
    entry(route, model, bounds, "live-request", "unobserved", 0, 0),
    entry(route, model, bounds, "renewal", "unobserved", 0, 0),
  ];
  const dispatched: ProbeAttempt = { schema: PROBE_SCHEMA, id, observedAt: new Date(started).toISOString(), installationLabel,
    mode: "live", route, model, lifecycle: "started", maxAttempts, attempts: 0, deadlineMs, elapsedMs: 0,
    observations: base, promptBytes: Buffer.byteLength(PROBE_PROMPT), nextAction: "run-opt-in-probe" };
  // Persist the attempt before any account request so a crash leaves explicit started evidence.
  await writeAttempt(root, dispatched);
  const elapsed = () => Math.max(0, Math.min(120000, ports.now() - started));
  // Compose the caller signal with an internally owned deadline: the public
  // orchestration enforces its configured bound even when invoked directly
  // without a CLI timeout signal. A blocked credential store therefore fails
  // closed at the deadline instead of hanging forever.
  const owned = new AbortController();
  const timer = setTimeout(() => owned.abort(), deadlineMs);
  const onCallerAbort = () => owned.abort();
  if (signal.aborted) owned.abort();
  else signal.addEventListener("abort", onCallerAbort, { once: true });
  const effective = owned.signal;
  try {
    return await runLive(root, id, dispatched, base, bounds, route, model, maxAttempts, ports, effective, elapsed);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onCallerAbort);
  }
}

/** Live probe body running under the composed deadline signal. */
async function runLive(root: string, id: string, dispatched: ProbeAttempt, base: ProbeObservationEntry[],
  bounds: { maxAttempts: number; deadlineMs: number }, route: string, model: string, maxAttempts: number,
  ports: ProbePorts, effective: AbortSignal, elapsed: () => number,
): Promise<{ record: ProbeAttempt; self: ProbeSelfSample }> {
  // Every terminal write below goes through the transactional CAS: a
  // concurrent cancel/reconcile/commit wins exactly once, and losers report
  // the settled record byte-for-byte instead of overwriting it.
  let attempts = 0, inference: ProbeEvent = "failed", inferenceSends = 0, tokenSends = 0;
  const finishSelf = async (attemptsUsed: number) => ({ elapsedMs: elapsed(), attemptsUsed, maxAttempts,
    providerSends: { inference: inferenceSends, token: tokenSends }, ...(await selfResources(root)) });
  const abortTo = async (observations: ProbeObservationEntry[], attemptsUsed: number) => {
    const { record } = await transitionTerminal(root, id, current => ({
      ...current, lifecycle: "cancelled", observations, attempts: attemptsUsed,
      elapsedMs: elapsed(), nextAction: "inspect-sanitized-failure",
    }));
    return { record, self: await finishSelf(attemptsUsed) };
  };
  if (effective.aborted) {
    return abortTo(dispatched.observations, 0);
  }
  // Ports are not trusted to honor cancellation: every port call runs
  // through a deadline race, and the port is invoked only after the race's
  // abort check (thunk factory), so even a deadline that fires while a
  // durable admission is being written starts no provider contact afterward.
  // Late settlements are ignored; they never touch the record.
  const withDeadline = async <T>(work: () => Promise<T>): Promise<T> => {
    if (effective.aborted) throw new Error("aborted");
    return await Promise.race([
      work(),
      new Promise<never>((_, reject) => effective.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    ]);
  };
  let credential: ProbeEvent = "unobserved";
  try {
    const read = await withDeadline(() => ports.readCredential(effective));
    credential = read === "ok" ? "unobserved" : read === "missing" ? "store" : "login";
  } catch {
    credential = "failed";
  }
  if (effective.aborted) {
    const observations: ProbeObservationEntry[] = [base[0]!, credentialEntry(route, model, bounds, credential), base[2]!, base[3]!];
    return abortTo(observations, 0);
  }
  for (let turn = 0; turn < maxAttempts; turn++) {
    if (effective.aborted) break;
    // Reserve the admission durably before any provider contact: the
    // reservation rechecks `started` inside the cross-process transaction, so
    // a concurrent cancel serializes against it (no new request starts after
    // cancellation acknowledges) and a crash preserves the admitted count
    // instead of recording zero.
    const reservation = await reserveAttempt(root, id);
    if (!reservation.admitted) break;
    // A deadline that fires while the reservation was being written must not
    // start provider contact afterward: recheck before invoking the port.
    if (effective.aborted) break;
    attempts = reservation.attempts;
    try {
      const outcome = await withDeadline(() => ports.infer({ route, model, prompt: PROBE_PROMPT, tools: PROBE_TOOLS, discovery: { ...PROBE_DISCOVERY }, deadlineMs: bounds.deadlineMs }, effective));
      inference = probeEvents.includes(outcome) ? outcome : "failed";
    } catch {
      inference = "failed";
    }
    // Exact provider-send accounting: every transport send during the
    // admitted attempt is counted, including Schway-owned refresh traffic.
    // A silent inference replay therefore always surfaces in the count
    // instead of hiding inside one recorded attempt.
    const sends = ports.takeProviderSends?.();
    if (sends) {
      inferenceSends += Math.max(0, sends.inference | 0);
      tokenSends += Math.max(0, sends.token | 0);
    }
    // Counter-validation failure terminalizes as failed, never as success
    // and never by leaving the record started: the pinned per-admission
    // structural bound is two inference sends plus two token sends.
    if (inferenceSends > 2 * attempts || tokenSends > 2 * attempts) {
      inference = "failed";
      break;
    }
    // A late completion after cancellation is never success evidence.
    if (effective.aborted) { inference = "failed"; break; }
    // Terminal classifications stop immediately; transient store/transport
    // failures consume the next bounded attempt instead of an outer retry.
    if (inference === "success" || inference === "login" || inference === "quota" || inference === "rejected") break;
  }
  if (effective.aborted) {
    // The inference result arrived too late: record that inference was
    // attempted but keep the cancelled lifecycle so it can never read success.
    // The live-request observation stays non-success inside the same terminal
    // transaction, so a cancelled probe is never exported as success.
    const observations: ProbeObservationEntry[] = [base[0]!, credentialEntry(route, model, bounds, credential),
      entry(route, model, bounds, "live-request", "unobserved", attempts, elapsed()), base[3]!];
    return abortTo(observations, attempts);
  }
  const observations: ProbeObservationEntry[] = [base[0]!, credentialEntry(route, model, bounds, credential),
    entry(route, model, bounds, "live-request", inference, attempts, elapsed()), base[3]!];
  // The signal is rechecked inside the winning transaction, immediately
  // before publication: an abort that fires during the terminal file write
  // publishes cancelled with non-success evidence in that same transaction
  // instead of leaving aborted success behind.
  await transitionTerminal(root, id, current => {
    if (effective.aborted) {
      const revised: ProbeObservationEntry[] = [current.observations[0]!, current.observations[1]!,
        entry(route, model, bounds, "live-request", "failed", current.attempts, elapsed()), current.observations[3]!];
      return { ...current, lifecycle: "cancelled", observations: revised, elapsedMs: elapsed(), nextAction: "inspect-sanitized-failure" };
    }
    const liveEntry = observations.find(item => item.observation === "live-request")!;
    const credentialEntryItem = observations.find(item => item.observation === "credential-read")!;
    const terminal = liveEntry.event === "unobserved"
      ? { state: credentialEntryItem.state, nextAction: credentialEntryItem.nextAction }
      : { state: liveEntry.state, nextAction: liveEntry.nextAction };
    return { ...current, lifecycle: terminal.state, observations, attempts, elapsedMs: elapsed(), nextAction: terminal.nextAction };
  }, { signal: effective, abortBuild: current => {
    const revised: ProbeObservationEntry[] = [current.observations[0]!, current.observations[1]!,
      entry(route, model, bounds, "live-request", "failed", current.attempts, elapsed()), current.observations[3]!];
    return { ...current, lifecycle: "cancelled", observations: revised, elapsedMs: elapsed(), nextAction: "inspect-sanitized-failure" };
  } });
  return { record: await readProbeAttempt(root, id), self: await finishSelf(attempts) };
}

/** Projects only allowlisted readiness facts; aliases, timing and identifiers never carry secrets. */
export function exportProbeSummary(record: ProbeAttempt) {
  validateProbeAttempt(record);
  return { schema: record.schema, probeId: record.id, observedAt: record.observedAt, mode: record.mode,
    route: "redacted-local-alias", model: record.model === null ? "unselected" : "redacted",
    lifecycle: record.lifecycle, maxAttempts: record.maxAttempts, attempts: record.attempts,
    deadlineMs: record.deadlineMs, elapsedMs: record.elapsedMs,
    observations: record.observations.map(item => ({ observation: item.observation, probeClass: item.probeClass,
      event: item.event === "success" ? "success" : "not-success", state: item.state, nextAction: item.nextAction,
      attempts: item.attempts, elapsedMs: item.elapsedMs })),
    promptBytes: record.promptBytes, nextAction: record.nextAction };
}
