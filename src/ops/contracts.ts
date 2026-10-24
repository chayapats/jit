import { safeAlias, safeVersion } from "../evidence/contract";
import { containsCredential } from "../security/credentials";
import { drillWorkloadBounds, opsBounds, withinBound } from "./limits";
import type { TestedRevisions } from "./revisions";

/** Versioned ops record kinds. None of these grant authority to login, bill, reboot or publish. */
export const opsSchemas = ["jit.ops.drill/v1", "jit.ops.profile/v1", "jit.ops.release/v1"] as const;
export type OpsSchema = typeof opsSchemas[number];

/** A bounded fixture workload. Every field is a finite operator-chosen ceiling; nothing here means unlimited. */
export interface LoadDrillConfig {
  /** Representative project groups (one project + topic each). */
  groups: number;
  /** Static PR candidates (snapshot → review → alert admission) spread across the groups. */
  prSnapshots: number;
  /** Read-only memory queries against committed state. */
  memoryQueries: number;
  /** Fixture delivery classifications, including unknown outcomes. */
  deliveries: number;
  /** Reminder schedules ticked with an explicit clock. */
  schedules: number;
  /** Managed-state growth ceiling that turns pressure into a blocked result. */
  diskWatermarkBytes: number;
  /** Wall-clock budget for the whole drill. */
  deadlineMs: number;
}

/** Per-leg honesty states. `scripted` means fixture-only: never production or Pi evidence. */
export const drillLegStates = ["passed", "failed", "blocked", "not-run", "scripted"] as const;
export type DrillLegState = typeof drillLegStates[number];

/** One measured drill leg with its sample limits disclosed. */
export interface DrillLeg {
  leg: string;
  state: DrillLegState;
  elapsedMs: number;
  detail: string;
  sampleLimit: string;
}

/** Sanitized measurements. Sizes and durations only; no paths, tokens or process dumps. */
export interface DrillMeasurements {
  /** Process high-water resident set (getrusage `maxrss`, KiB × 1024) at the end of the drill; includes pre-drill usage. */
  peakRssBytes: number;
  stateBytesBefore: number;
  stateBytesAfter: number;
  stateGrowthBytes: number;
  diskPressure: boolean;
  /**
   * Admission wait per drill job: wall time from the enqueue receipt to the
   * first invocation of its work (monotonic clock). Max, nearest-rank p95 and
   * sample count over the sampled jobs; 0/0/0 when nothing was admitted.
   */
  queueWaitMaxMs: number;
  queueWaitP95Ms: number;
  queueWaitSamples: number;
  stopAckMs: number | null;
  fetchCalls: number;
  /** Final persisted outcomes of the drill's own delivery intents after the DeliveryWorker ran, and the attempts it recorded. */
  sentDeliveries: number;
  unknownDeliveries: number;
  failedDeliveries: number;
  deliveryAttempts: number;
  /** Succeeded `pr.snapshot` plus `pr.review` jobs. */
  succeededJobs: number;
  waitingJobs: number;
  cancelledJobs: number;
  /** Committed private PR reports and the alert intents admitted from them. */
  prReports: number;
  alertIntents: number;
  /** Bytes of the verified project export artifact and of the verified managed backup image (0 when not produced). */
  exportBytes: number;
  backupBytes: number;
  /** Owner command acknowledgment (receipt returned) and read-request duration maxima, wall milliseconds. */
  commandAckMaxMs: number;
  requestMaxMs: number;
  /** Owner commands issued through the Application boundary during the drill. */
  commands: number;
}

/** Bounded drill outcome with fixed safe next actions. */
export const drillActions = ["none", "inspect-sanitized-drill", "relieve-disk-pressure", "check-local-drill-configuration",
  "retry-bounded-drill", "resolve-blocked-work", "restore-engine", "integrate-pending-contract"] as const;
export type DrillAction = typeof drillActions[number];

/**
 * Typed operating limits a drill can observe being reached. Only these become
 * `exhaustedLimits`; a blocked or failed leg is never relabelled as a limit.
 */
export const exhaustedLimitKinds = ["drill-deadline", "disk-watermark", "job-budget", "job-deadline", "delivery-retry", "queue-limit"] as const;
export type ExhaustedLimit = typeof exhaustedLimitKinds[number];

/** Versioned drill record persisted under private `.local/ops-evidence`. */
export interface LoadDrillRecord {
  schema: "jit.ops.drill/v1";
  id: string;
  observedAt: string;
  installationLabel: string;
  /** Tested revisions: app version, Bun, drilled schema, git commit, source content hash and engine contracts. */
  versions: TestedRevisions;
  config: LoadDrillConfig;
  legs: DrillLeg[];
  measurements: DrillMeasurements;
  /** Typed limit events observed during the drill (unique, fixed order). */
  exhaustedLimits: ExhaustedLimit[];
  fixtureHonesty: string[];
  outcome: "passed" | "blocked" | "failed";
  nextAction: DrillAction;
}

/** Release checklist item states. Human rows are linked by evidence ID only, never auto-passed. */
export const checklistStates = ["passed", "failed", "blocked", "not-run"] as const;
export type ChecklistState = typeof checklistStates[number];

export const deterministicChecklistIds = ["J01", "J02", "J03", "J04", "J05", "crash", "trust"] as const;
export type DeterministicChecklistId = typeof deterministicChecklistIds[number];

export const humanChecklistIds = ["FEAS", "OPS"] as const;
export type HumanChecklistId = typeof humanChecklistIds[number];

/** One release gate row. `note` carries no credentials, addresses or raw diagnostics. */
export interface ChecklistItem {
  id: string;
  state: ChecklistState;
  /** Sanitized evidence record ID, or null when the gate has not run. */
  evidenceId: string | null;
  note: string;
}

export interface ReleaseChecklist {
  schema: "jit.ops.release/v1";
  id: string;
  observedAt: string;
  installationLabel: string;
  drillId: string | null;
  deterministic: ChecklistItem[];
  human: ChecklistItem[];
  outcome: "passed" | "blocked" | "failed";
  nextAction: DrillAction;
}

/** Versioned operating profile: what was measured, under which limits, with explicit sample bounds. */
export interface OpsProfile {
  schema: "jit.ops.profile/v1";
  id: string;
  observedAt: string;
  installationLabel: string;
  drillId: string;
  versions: LoadDrillRecord["versions"];
  config: LoadDrillConfig;
  measurements: DrillMeasurements;
  exhaustedLimits: ExhaustedLimit[];
  sampleLimitations: string[];
  piReadiness: "not-claimed";
  nextAction: DrillAction;
}

const secretLike = /bearer\s|authorization\s*:|x-telegram|bot[_-]?token|password|secret|ssh:\/\/|[0-9]{5,}:[A-Za-z0-9_-]{8,}/i;
/** Network addresses: IPv4, IPv6 (incl. bracketed), any URL scheme, or host:port. */
const addressLike = /\b\d{1,3}(?:\.\d{1,3}){3}\b|\[[0-9a-f:]*:[0-9a-f:]*\]|\b(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{0,4}\b|\b[a-z][a-z0-9+.-]*:\/\/|\b[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d{2,5}\b/i;
/** Filesystem paths: absolute POSIX (`/x`), home (`~/`), relative traversal (`./`, `../`) or a Windows drive. */
const pathLike = /(?:^|[\s(=:,'"])(?:\/[A-Za-z0-9._-]|~\/|\.{1,2}\/)|\b[A-Za-z]:\\/;

/**
 * Rejects notes that could carry credentials, addresses, paths or raw transport
 * output. Credentials use the shared detector (`containsCredential`, the same
 * patterns as outbox and export hygiene) plus ops-specific labels.
 */
export function safeNote(value: unknown): string {
  if (typeof value !== "string" || !value.length || value.length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error("invalid_ops_note");
  if (secretLike.test(value) || containsCredential(value) || addressLike.test(value) || pathLike.test(value)) throw new Error("invalid_ops_note");
  return value;
}

/** Admits only allowlisted non-sensitive identifier aliases; the export layer still redacts them. */
export function safeOpsAlias(value: unknown): string {
  return safeAlias(value);
}

/** Export replaces stored route/model identifiers with ordinal references, mirroring host evidence. */
export function redactRouteId(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 1023) throw new Error("invalid_ops_reference");
  return `route-${index + 1}`;
}

export function redactModel(value: string | null): "redacted" | "unselected" {
  return value === null ? "unselected" : "redacted";
}

const uuidPattern = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

/** Admits only sanitized evidence record references. */
export function safeEvidenceId(value: unknown): string {
  if (typeof value !== "string" || !uuidPattern.test(value)) throw new Error("invalid_ops_evidence_id");
  return value;
}

const exact = (o: unknown, keys: string[]): o is Record<string, unknown> => !!o && typeof o === "object" && !Array.isArray(o) &&
  Object.keys(o).length === keys.length && keys.every(k => Object.hasOwn(o, k));

/** Exact measurement field set, shared by drill and profile validation. */
export const measurementKeys = ["peakRssBytes", "stateBytesBefore", "stateBytesAfter", "stateGrowthBytes", "diskPressure",
  "queueWaitMaxMs", "queueWaitP95Ms", "queueWaitSamples",
  "stopAckMs", "fetchCalls", "sentDeliveries", "unknownDeliveries", "failedDeliveries", "deliveryAttempts", "succeededJobs", "waitingJobs", "cancelledJobs",
  "prReports", "alertIntents", "exportBytes", "backupBytes", "commandAckMaxMs", "requestMaxMs", "commands"];

const contractId = /^[a-z][a-z0-9_.-]{0,63}\/v[0-9]{1,3}$/;

/** Rejects revisions that are not plain identity values (versions, hex digests, contract IDs). */
export function validateRevisions(value: unknown): asserts value is TestedRevisions {
  const fail = (): never => { throw new Error("invalid_ops_record"); };
  if (!exact(value, ["app", "bun", "schema", "git", "contentHash", "engine"])) fail();
  const v = value as TestedRevisions;
  if (safeVersion(v.app) !== v.app || (v.bun !== null && safeVersion(v.bun) !== v.bun) ||
      !Number.isSafeInteger(v.schema) || v.schema < 1 || v.schema > 100000 ||
      (v.git !== null && (typeof v.git !== "string" || !/^[a-f0-9]{40}$/.test(v.git))) ||
      (v.contentHash !== null && (typeof v.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(v.contentHash)))) fail();
  const e = v.engine;
  if (!exact(e, ["package", "release", "bridge", "snapshot", "snapshotFormat"]) ||
      (e.package !== null && safeVersion(e.package) !== e.package) ||
      [e.release, e.bridge, e.snapshot].some(c => typeof c !== "string" || !contractId.test(c)) ||
      !Number.isSafeInteger(e.snapshotFormat) || e.snapshotFormat < 1 || e.snapshotFormat > 1000) fail();
}

/** Note check for record validators: any unsafe note is an invalid record, not a separate error class. */
const noteOk = (v: unknown): boolean => { try { return safeNote(v) === v; } catch { return false; } };
const isoTime = (v: unknown): boolean => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v));
const configKeys = ["groups", "prSnapshots", "memoryQueries", "deliveries", "schedules", "diskWatermarkBytes", "deadlineMs"];

/** Exact drill config under the shared bounds (src/ops/limits.ts). */
export function validateDrillConfig(value: unknown): asserts value is LoadDrillConfig {
  if (!exact(value, configKeys)) throw new Error("invalid_ops_record");
  const c = value as unknown as Record<string, unknown>;
  for (const [name, bound] of Object.entries(drillWorkloadBounds)) if (!withinBound(c[name], bound)) throw new Error("invalid_ops_record");
  if (!withinBound(c.diskWatermarkBytes, opsBounds.diskWatermarkBytes) || !withinBound(c.deadlineMs, opsBounds.drillDeadlineMs)) throw new Error("invalid_ops_record");
}

/** Exact measurement set: bounded non-negative integers, `diskPressure` boolean, `stopAckMs` nullable. */
export function validateMeasurements(value: unknown): asserts value is DrillMeasurements {
  const fail = (): never => { throw new Error("invalid_ops_record"); };
  if (!exact(value, measurementKeys)) fail();
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === "diskPressure") { if (typeof v !== "boolean") fail(); continue; }
    if (key === "stopAckMs") { if (v !== null && (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > 3600000)) fail(); continue; }
    if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > 1099511627776) fail();
  }
}

function validateExhaustedLimits(value: unknown): asserts value is ExhaustedLimit[] {
  if (!Array.isArray(value) || value.length > exhaustedLimitKinds.length || new Set(value).size !== value.length ||
      value.some(v => !exhaustedLimitKinds.includes(v))) throw new Error("invalid_ops_record");
}

/** Rejects malformed, unknown-field or oversized drill records before persistence or export. */
export function validateDrillRecord(value: unknown): asserts value is LoadDrillRecord {
  const fail = (): never => { throw new Error("invalid_ops_record"); };
  if (!exact(value, ["schema", "id", "observedAt", "installationLabel", "versions", "config", "legs", "measurements", "exhaustedLimits", "fixtureHonesty", "outcome", "nextAction"])) fail();
  const r = value as LoadDrillRecord;
  if (r.schema !== "jit.ops.drill/v1" || !uuidPattern.test(r.id) || !isoTime(r.observedAt) ||
      safeOpsAlias(r.installationLabel) !== r.installationLabel || !["passed", "blocked", "failed"].includes(r.outcome) || !drillActions.includes(r.nextAction)) fail();
  validateRevisions(r.versions);
  validateDrillConfig(r.config);
  if (!Array.isArray(r.legs) || r.legs.length > 16) fail();
  for (const leg of r.legs) {
    if (!exact(leg, ["leg", "state", "elapsedMs", "detail", "sampleLimit"]) || safeOpsAlias(leg.leg) !== leg.leg ||
        !drillLegStates.includes(leg.state) || !Number.isSafeInteger(leg.elapsedMs) || leg.elapsedMs < 0 || leg.elapsedMs > 3600000 ||
        !noteOk(leg.detail) || !noteOk(leg.sampleLimit)) fail();
  }
  validateMeasurements(r.measurements);
  validateExhaustedLimits(r.exhaustedLimits);
  if (!Array.isArray(r.fixtureHonesty) || r.fixtureHonesty.length > 16 || r.fixtureHonesty.some(n => !noteOk(n))) fail();
  if (Buffer.byteLength(JSON.stringify(r)) > 32768) fail();
}

/** Exact profile record: identity, tested revisions, bounded config/measurements, typed limits, sanitized limitations, no readiness claim. */
export function validateProfileRecord(value: unknown): asserts value is OpsProfile {
  const fail = (): never => { throw new Error("invalid_ops_record"); };
  if (!exact(value, ["schema", "id", "observedAt", "installationLabel", "drillId", "versions", "config", "measurements", "exhaustedLimits", "sampleLimitations", "piReadiness", "nextAction"])) fail();
  const r = value as OpsProfile;
  if (r.schema !== "jit.ops.profile/v1" || !uuidPattern.test(r.id) || !isoTime(r.observedAt) ||
      safeOpsAlias(r.installationLabel) !== r.installationLabel || typeof r.drillId !== "string" || !uuidPattern.test(r.drillId) ||
      r.piReadiness !== "not-claimed" || !drillActions.includes(r.nextAction)) fail();
  validateRevisions(r.versions);
  validateDrillConfig(r.config);
  validateMeasurements(r.measurements);
  validateExhaustedLimits(r.exhaustedLimits);
  if (!Array.isArray(r.sampleLimitations) || r.sampleLimitations.length > 32 || r.sampleLimitations.some(n => !noteOk(n))) fail();
  if (Buffer.byteLength(JSON.stringify(r)) > 32768) fail();
}

function validateRows(rows: unknown, ids: readonly string[], human: boolean): ChecklistItem[] {
  const fail = (): never => { throw new Error("invalid_ops_record"); };
  if (!Array.isArray(rows) || rows.length !== ids.length) fail();
  return (rows as unknown[]).map((row, index) => {
    if (!exact(row, ["id", "state", "evidenceId", "note"])) fail();
    const item = row as ChecklistItem;
    if (item.id !== ids[index] || !checklistStates.includes(item.state) ||
        (item.evidenceId !== null && (typeof item.evidenceId !== "string" || !uuidPattern.test(item.evidenceId))) ||
        (item.state === "not-run" && item.evidenceId !== null) || (human && item.state !== "not-run" && item.evidenceId === null) ||
        !noteOk(item.note)) fail();
    return item;
  });
}

/** Exact release record: fixed row order, row invariants, and outcome/next action consistent with the rows. */
export function validateReleaseRecord(value: unknown): asserts value is ReleaseChecklist {
  const fail = (): never => { throw new Error("invalid_ops_record"); };
  if (!exact(value, ["schema", "id", "observedAt", "installationLabel", "drillId", "deterministic", "human", "outcome", "nextAction"])) fail();
  const r = value as ReleaseChecklist;
  if (r.schema !== "jit.ops.release/v1" || !uuidPattern.test(r.id) || !isoTime(r.observedAt) ||
      safeOpsAlias(r.installationLabel) !== r.installationLabel ||
      (r.drillId !== null && (typeof r.drillId !== "string" || !uuidPattern.test(r.drillId)))) fail();
  const states = [...validateRows(r.deterministic, deterministicChecklistIds, false), ...validateRows(r.human, humanChecklistIds, true)].map(i => i.state);
  if (r.drillId === null && r.deterministic.some(i => i.state !== "not-run")) fail();
  const outcome = states.includes("failed") ? "failed" : states.includes("blocked") || states.includes("not-run") ? "blocked" : "passed";
  const nextAction = outcome === "passed" ? "none" : outcome === "failed" ? "inspect-sanitized-drill" : "resolve-blocked-work";
  if (r.outcome !== outcome || r.nextAction !== nextAction) fail();
  if (Buffer.byteLength(JSON.stringify(r)) > 32768) fail();
}
