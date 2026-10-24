import { Database } from "bun:sqlite";
import { chmodSync, constants, existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
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
}

/** Best-effort self resource sample; failures report zeros rather than failing the probe. */
async function selfResources(root: string): Promise<Pick<ProbeSelfSample, "peakMemoryBytes" | "managedBytes" | "managedFiles">> {
  let peakMemoryBytes = 0;
  try { peakMemoryBytes = process.memoryUsage().heapUsed; } catch { /* Own-process sample only. */ }
  let managedBytes = 0, managedFiles = 0;
  const scan = async (dir: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).slice(0, MAX_SELF_SCAN_FILES);
    } catch { return; }
    for (const name of names) {
      if (name.startsWith(".tmp-")) continue;
      try {
        const stats = await lstat(resolve(dir, name));
        if (stats.isFile() && !stats.isSymbolicLink()) { managedFiles++; managedBytes += stats.size; }
      } catch { /* One unreadable artifact does not fail the sample. */ }
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
function lifecycleDb(dir: string): Database {
  const path = resolve(dir, "lifecycle.db");
  const fresh = !existsSync(path);
  const db = new Database(path, { create: true });
  if (fresh) {
    try { chmodSync(path, 0o600); } catch { /* Best effort after create. */ }
  }
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = FULL;");
  db.exec("CREATE TABLE IF NOT EXISTS probe_terminal(id TEXT PRIMARY KEY, lifecycle TEXT NOT NULL)");
  return db;
}

async function transitionTerminal(root: string, id: string,
  build: (current: ProbeAttempt) => ProbeAttempt | null,
): Promise<{ committed: boolean; record: ProbeAttempt }> {
  return withRecordLock(id, async () => {
    const dir = await probeDirectory(root, true);
    const db = lifecycleDb(dir);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = await readProbeAttempt(root, id);
        if (current.lifecycle !== "started") {
          db.exec("ROLLBACK");
          return { committed: false, record: current };
        }
        const next = build(current);
        if (next === null) {
          db.exec("ROLLBACK");
          return { committed: false, record: current };
        }
        validateProbeAttempt(next);
        await atomicWriteFile(dir, `${id}.json`, JSON.stringify(next) + "\n");
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

let tmpCounter = 0;

/**
 * Publishes one record atomically: exclusive temp file, fsync, atomic rename
 * and a required directory sync. Directory-open/sync failures are persistence
 * failures, never best-effort skips: acknowledging them would let dispatch
 * proceed on evidence a restart cannot see. Failed temp files are removed.
 */
async function atomicWriteFile(dir: string, name: string, data: string): Promise<void> {
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
  return { record, self: { elapsedMs: 0, attemptsUsed: 0, maxAttempts: record.maxAttempts, ...(await selfResources(root)) } };
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
  // Every terminal write below goes through the transactional CAS: a
  // concurrent cancel/reconcile/commit wins exactly once, and losers report
  // the settled record byte-for-byte instead of overwriting it.
  const abortTo = async (observations: ProbeObservationEntry[], attemptsUsed: number) => {
    const { record } = await transitionTerminal(root, id, current => ({
      ...current, lifecycle: "cancelled", observations, attempts: attemptsUsed,
      elapsedMs: elapsed(), nextAction: "inspect-sanitized-failure",
    }));
    return { record, self: { elapsedMs: elapsed(), attemptsUsed, maxAttempts, ...(await selfResources(root)) } };
  };
  if (signal.aborted) {
    return abortTo(dispatched.observations, 0);
  }
  let credential: ProbeEvent = "unobserved";
  try {
    const read = await ports.readCredential(signal);
    credential = read === "ok" ? "unobserved" : read === "missing" ? "store" : "login";
  } catch {
    credential = "failed";
  }
  if (signal.aborted) {
    const observations: ProbeObservationEntry[] = [base[0]!, credentialEntry(route, model, bounds, credential), base[2]!, base[3]!];
    return abortTo(observations, 0);
  }
  let attempts = 0, inference: ProbeEvent = "failed", tokenSends = 0;
  for (let turn = 0; turn < maxAttempts; turn++) {
    if (signal.aborted) break;
    attempts++;
    try {
      const outcome = await ports.infer({ route, model, prompt: PROBE_PROMPT, tools: PROBE_TOOLS, discovery: { ...PROBE_DISCOVERY }, deadlineMs }, signal);
      inference = probeEvents.includes(outcome) ? outcome : "failed";
    } catch {
      inference = "failed";
    }
    // Exact provider-send accounting: every transport send during the
    // admitted attempt is reported, including Schway-owned refresh traffic.
    // A silent inference replay therefore always surfaces in the renewal
    // observation instead of hiding inside one recorded attempt.
    const sends = ports.takeProviderSends?.();
    if (sends) tokenSends += Math.max(0, sends.token | 0);
    // A late completion after cancellation is never success evidence.
    if (signal.aborted) { inference = "failed"; break; }
    // Terminal classifications stop immediately; transient store/transport
    // failures consume the next bounded attempt instead of an outer retry.
    if (inference === "success" || inference === "login" || inference === "quota" || inference === "rejected") break;
  }
  // A Schway-owned renewal send is bounded evidence, never readiness: the
  // renewal observation stays configured-unverified by construction.
  const renewalEntry = () => tokenSends > 0
    ? entry(route, model, bounds, "renewal", "success", Math.min(tokenSends, maxAttempts), elapsed())
    : base[3]!;
  if (signal.aborted) {
    // The inference result arrived too late: record that inference was
    // attempted but keep the cancelled lifecycle so it can never read success.
    // The live-request observation stays non-success inside the same terminal
    // transaction, so a cancelled probe is never exported as success.
    const observations: ProbeObservationEntry[] = [base[0]!, credentialEntry(route, model, bounds, credential),
      entry(route, model, bounds, "live-request", "unobserved", attempts, elapsed()), renewalEntry()];
    return abortTo(observations, attempts);
  }
  const observations: ProbeObservationEntry[] = [base[0]!, credentialEntry(route, model, bounds, credential),
    entry(route, model, bounds, "live-request", inference, attempts, elapsed()), renewalEntry()];
  await commitProbeOutcome(root, id, observations, attempts, elapsed());
  // A deadline/cancel that fires during the terminal write converts the
  // owning invocation's own record rather than leaving aborted success
  // behind — but only when the commit did not already terminalize it: a
  // committed success that lost the race to nobody stays success, and a
  // record another owner already settled stays byte-for-byte unchanged.
  if (signal.aborted) {
    const { record: settled } = await transitionTerminal(root, id, current => {
      if (current.lifecycle !== "started") return null;
      const revised: ProbeObservationEntry[] = [current.observations[0]!, current.observations[1]!,
        entry(route, model, bounds, "live-request", "failed", current.attempts, elapsed()), current.observations[3]!];
      return { ...current, lifecycle: "cancelled", observations: revised, elapsedMs: elapsed(), nextAction: "inspect-sanitized-failure" };
    });
    void settled;
  }
  return { record: await readProbeAttempt(root, id), self: { elapsedMs: elapsed(), attemptsUsed: attempts, maxAttempts, ...(await selfResources(root)) } };
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
