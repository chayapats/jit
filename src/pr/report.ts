import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { requireId } from "../sources";
import { readAttempts } from "../jobs/attempts";
import type { AppTransaction } from "../store";
import { readMonitor } from "./authority";
import { readCandidate } from "./poll";
import { ensurePrSchema } from "./schema";
import { readSnapshot } from "./snapshot";
import {
  DEFAULT_REVIEW_POLICY,
  REVIEW_POLICY_VERSION,
  type CoverageManifest,
  type DismissReportCommand,
  type ImmutableSnapshot,
  type PrEvidenceType,
  type PrFinding,
  type PrFindingCategory,
  type PrReportReceipt,
  type PrReportStatus,
  type PrReviewCapture,
  type PrReviewStateItem,
  type PrivateReport,
  type ReportAnnotation,
  type ReviewCandidate,
  type TransmittedManifest,
} from "./types";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const requestIdOk = (value: string) => /^[a-zA-Z0-9_-]{8,128}$/.test(value);
const findingIdOk = (value: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const SHA = /^[a-f0-9]{40}$/;
const secretLike = /bearer\s|authorization\s*:|x-telegram|bot[_ -]?token|[0-9]{5,}:[A-Za-z0-9_-]{8,}/i;

const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  && Object.keys(value).every(key => keys.includes(key))
  && keys.every(key => Object.hasOwn(value as object, key));

const categories: PrFindingCategory[] = ["correctness", "security", "behavior", "style", "uncertain"];
const evidenceTypes: PrEvidenceType[] = ["diff", "issue", "spec", "ci", "none"];
const severities = ["info", "low", "medium", "high", "critical"] as const;

function pathOk(path: string): boolean {
  if (typeof path !== "string" || path.length < 1 || path.length > 512) return false;
  if (path.includes("\0") || path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) return false;
  return path.isWellFormed();
}

function textOk(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0
    && value.length <= max && value.isWellFormed() && Buffer.byteLength(value) <= max;
}

/** Inclusive line ranges a unified diff patch covers on its old and new sides. */
export function patchRanges(patch: string | null): Array<{ start: number; end: number }> {
  if (patch === null) return [];
  const ranges: Array<{ start: number; end: number }> = [];
  const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (const match of patch.matchAll(hunk)) {
    const oldStart = Number(match[1]), oldCount = match[2] === undefined ? 1 : Number(match[2]);
    const newStart = Number(match[3]), newCount = match[4] === undefined ? 1 : Number(match[4]);
    if (newCount > 0) ranges.push({ start: newStart, end: newStart + newCount - 1 });
    if (oldCount > 0) ranges.push({ start: oldStart, end: oldStart + oldCount - 1 });
  }
  return ranges;
}

/** Evidence keys (`kind:ref`) that the specialists actually received, whole or truncated. */
function transmittedKeys(transmitted: TransmittedManifest): Set<string> {
  return new Set(transmitted.specialist
    .filter(entry => entry.state === "sent" || entry.state === "truncated")
    .map(entry => `${entry.kind}:${entry.ref}`));
}

/**
 * Validates one proposed actionable finding against accessible snapshot references.
 * Actionable requires: a location in a changed snapshot file whose line (when
 * given) falls inside a parsed patch hunk; condition, impact and reasoning; and
 * a declared evidence type whose citation resolves to accessible evidence (diff:
 * `evidenceRef` equals the located file and its patch is readable; issue `#n`
 * and spec path present in the snapshot; CI check present and `available`).
 * When `transmitted` is given the cited evidence must also have reached the
 * specialists. Anything else stays suspected with `validationErrors`.
 * Snapshot content is untrusted data; this function never autoloads instructions or fetches.
 */
export function validateFinding(input: unknown, snapshot: ImmutableSnapshot, transmitted: TransmittedManifest | null = null): PrFinding {
  const errors: string[] = [];
  const raw = (input ?? {}) as Record<string, unknown>;
  const id = typeof raw.id === "string" && findingIdOk(raw.id) ? raw.id : `finding-${errors.push("invalid_id") && "invalid"}`;
  const title = textOk(raw.title, 500) ? (raw.title as string).trim().slice(0, 500) : (errors.push("missing_title"), "untitled finding");
  const category = categories.includes(raw.category as PrFindingCategory) ? (raw.category as PrFindingCategory) : (errors.push("invalid_category"), "uncertain" as PrFindingCategory);
  const severity = (severities as readonly string[]).includes(raw.severity as string) ? (raw.severity as PrFinding["severity"]) : (errors.push("invalid_severity"), "info" as const);
  const loc = (raw.location ?? {}) as Record<string, unknown>;
  const path = typeof loc.path === "string" && pathOk(loc.path) ? loc.path : (errors.push("invalid_location_path"), "");
  const line = loc.line === null || loc.line === undefined ? null
    : Number.isSafeInteger(loc.line) && (loc.line as number) > 0 && (loc.line as number) <= 1_000_000 ? (loc.line as number) : (errors.push("invalid_location_line"), null);
  const condition = textOk(raw.condition, 2000) ? (raw.condition as string).trim() : (errors.push("missing_condition"), "");
  const impact = textOk(raw.impact, 2000) ? (raw.impact as string).trim() : (errors.push("missing_impact"), "");
  const reasoning = textOk(raw.reasoning, 2000) ? (raw.reasoning as string).trim() : (errors.push("missing_reasoning"), "");
  const evidenceType = evidenceTypes.includes(raw.evidenceType as PrEvidenceType) ? (raw.evidenceType as PrEvidenceType) : (errors.push("invalid_evidence_type"), "none" as PrEvidenceType);
  const evidenceRef = typeof raw.evidenceRef === "string" && raw.evidenceRef.length <= 512 ? raw.evidenceRef : (raw.evidenceRef === null ? null : (errors.push("invalid_evidence_ref"), null));

  if (evidenceType === "none") errors.push("evidence_none_not_actionable");
  if (!condition || !impact || !reasoning) errors.push("unsupported_assertion");
  if (typeof raw.title === "string" && secretLike.test(raw.title as string)) errors.push("payload_hygiene_secret");
  for (const field of [condition, impact, reasoning]) {
    if (field && secretLike.test(field)) errors.push("payload_hygiene_secret");
  }

  if (path) {
    const located = snapshot.files.find(f => f.path === path);
    if (!located) errors.push("location_not_in_snapshot");
    else if (line !== null) {
      const ranges = patchRanges(located.patch);
      if (ranges.length === 0) errors.push("location_unverifiable");
      else if (!ranges.some(r => line >= r.start && line <= r.end)) errors.push("invalid_location_line");
    }
    if (evidenceType === "diff") {
      if (typeof evidenceRef !== "string" || !pathOk(evidenceRef)) errors.push("invalid_source_ref");
      else {
        const file = snapshot.files.find(f => f.path === evidenceRef);
        if (!file) errors.push("invalid_source_ref");
        else if (file.patch === null) errors.push("evidence_unavailable");
        if (evidenceRef !== path) errors.push("diff_ref_mismatch");
      }
    }
    if (evidenceType === "issue") {
      const m = /^#(\d+)$/.exec(evidenceRef ?? "");
      const number = m ? Number(m[1]) : NaN;
      if (!m || !Number.isSafeInteger(number) || number < 1) errors.push("invalid_source_ref");
      else if (!snapshot.issues.some(i => i.number === number)) errors.push("evidence_unavailable");
    }
    if (evidenceType === "spec") {
      if (typeof evidenceRef !== "string" || !pathOk(evidenceRef)) errors.push("invalid_source_ref");
      else if (!snapshot.specs.some(s => s.path === evidenceRef)) errors.push("evidence_unavailable");
    }
    if (evidenceType === "ci") {
      if (typeof evidenceRef !== "string" || !evidenceRef) errors.push("invalid_source_ref");
      else {
        const check = snapshot.ci.find(c => c.name === evidenceRef);
        if (!check || !check.available) errors.push("evidence_unavailable");
      }
    }
    if (transmitted && evidenceType !== "none" && typeof evidenceRef === "string" && !errors.includes("invalid_source_ref") && !errors.includes("evidence_unavailable")) {
      if (!transmittedKeys(transmitted).has(`${evidenceType}:${evidenceRef}`)) errors.push("evidence_not_transmitted");
    }
  } else {
    errors.push("invalid_location_path");
  }

  // Severity never substitutes for evidence; style/uncertain never become actionable.
  const actionable = errors.length === 0 && (category === "correctness" || category === "security" || category === "behavior");
  if (!actionable && errors.length === 0) errors.push("category_not_actionable");
  return {
    id: findingIdOk((raw.id as string) ?? "") ? (raw.id as string) : "finding-invalid",
    title, category, severity,
    location: { path, line },
    condition, impact, reasoning,
    evidenceType, evidenceRef: evidenceRef ?? null,
    status: actionable ? "actionable" : "suspected",
    validationErrors: [...new Set(errors)],
  };
}

export interface NormalizedReview {
  findings: PrFinding[];
  analyzedRoles: string[];
  skippedScope: string[];
  disagreements: string[];
  valid: boolean;
}

/**
 * Normalizes untrusted model review output into validated findings.
 * Unknown model fields (route/task/mutation/comment instructions) are ignored, never acted on.
 */
export function normalizeReviewOutput(output: string, snapshot: ImmutableSnapshot, allowedRoles: readonly string[] = DEFAULT_REVIEW_POLICY.requiredRoles, transmitted: TransmittedManifest | null = null): NormalizedReview {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return { findings: [], analyzedRoles: [], skippedScope: [...allowedRoles], disagreements: [], valid: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { findings: [], analyzedRoles: [], skippedScope: [...allowedRoles], disagreements: [], valid: false };
  }
  const raw = parsed as Record<string, unknown>;
  const list = Array.isArray(raw.findings) ? raw.findings.slice(0, 32) : [];
  const findings = list.map(item => {
    try { return validateFinding(item, snapshot, transmitted); }
    catch { return validateFinding({}, snapshot, transmitted); }
  });
  const analyzedRaw = Array.isArray(raw.analyzedRoles) ? raw.analyzedRoles.filter((r): r is string => typeof r === "string" && r.length <= 64) : [];
  const analyzedRoles = [...new Set(analyzedRaw)].slice(0, 8);
  const skippedRaw = Array.isArray(raw.skippedScope) ? raw.skippedScope.filter((s): s is string => typeof s === "string" && s.length <= 256) : [];
  const skippedScope = [...new Set(skippedRaw)].slice(0, 16);
  const disagRaw = Array.isArray(raw.disagreements) ? raw.disagreements.filter((d): d is string => typeof d === "string" && d.length <= 2000) : [];
  const disagreements = disagRaw.map(d => d.slice(0, 2000)).slice(0, 16);
  // Explicit scope policy: roles never analyzed are skipped, never silently complete.
  for (const required of allowedRoles) {
    if (!analyzedRoles.includes(required) && !skippedScope.includes(required)) skippedScope.push(required);
  }
  return { findings, analyzedRoles, skippedScope, disagreements, valid: true };
}

function storedOf(row: { record_json: string }): PrivateReport {
  return JSON.parse(row.record_json) as PrivateReport;
}

/** Current accepted review policy a reader compares stored reports against. */
export interface ReportReadOptions {
  reviewPolicyVersion?: number;
}

const TERMINAL_CANDIDATE = ["superseded", "cancelled", "stale", "closed"];

function isStale(report: PrivateReport, candidate: { baseSha: string; headSha: string; policyVersion: number; status: string }, monitor: { state: string; policy: { version: number } }, ownerGeneration: number | null, reviewPolicyVersion: number): { stale: boolean; reason: string | null } {
  if (ownerGeneration !== null && report.authorityGeneration !== undefined && ownerGeneration !== report.authorityGeneration) {
    return { stale: true, reason: "authorization_changed" };
  }
  if (monitor.state !== "active") return { stale: true, reason: monitor.state === "revoked" ? "monitoring_revoked" : "monitoring_not_active" };
  if (TERMINAL_CANDIDATE.includes(candidate.status)) {
    return { stale: true, reason: candidate.status === "closed" ? "pr_closed" : `candidate_${candidate.status}` };
  }
  if (candidate.baseSha !== report.baseSha || candidate.headSha !== report.headSha) return { stale: true, reason: "revision_changed" };
  if (candidate.policyVersion !== report.policyVersion || monitor.policy.version !== report.policyVersion) return { stale: true, reason: "policy_changed" };
  if (report.reviewPolicyVersion !== reviewPolicyVersion) return { stale: true, reason: "review_policy_changed" };
  return { stale: false, reason: null };
}

function withStale(report: PrivateReport, candidate: { baseSha: string; headSha: string; policyVersion: number; status: string }, monitor: { state: string; policy: { version: number } }, ownerGeneration: number | null = null, reviewPolicyVersion: number = REVIEW_POLICY_VERSION): PrivateReport {
  const { stale, reason } = isStale(report, candidate, monitor, ownerGeneration, reviewPolicyVersion);
  return stale ? { ...report, stale: true, staleReason: reason } : { ...report, stale: false, staleReason: null };
}

function overlay(tx: AppTransaction, projectId: string, report: PrivateReport, options: ReportReadOptions): PrivateReport {
  try {
    const candidate = readCandidate(tx, projectId, report.candidateId);
    const monitor = readMonitor(tx, projectId, report.monitorId);
    const ownerGeneration = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation ?? null;
    return withStale(report, candidate, monitor, ownerGeneration, options.reviewPolicyVersion ?? REVIEW_POLICY_VERSION);
  } catch {
    return { ...report, stale: true, staleReason: "authority_unavailable" };
  }
}

/**
 * Reads one committed report with a computed stale overlay; history rows are never mutated by reads.
 * A report decided under another review policy than the current accepted one reads stale.
 */
export function readReport(tx: AppTransaction, projectId: string, reportId: string, options: ReportReadOptions = {}): PrivateReport {
  ensurePrSchema(tx);
  requireId(projectId); requireId(reportId);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM pr_reports WHERE id = ? AND project_id = ?", reportId, projectId);
  if (!row) throw new AppError("pr_report_not_found", 404);
  return overlay(tx, projectId, storedOf(row), options);
}

/** Lists committed reports newest-first with computed stale overlays. */
export function listReports(tx: AppTransaction, projectId: string, monitorId?: string, options: ReportReadOptions = {}): PrivateReport[] {
  ensurePrSchema(tx);
  requireId(projectId);
  const rows = monitorId
    ? tx.all<{ record_json: string }>("SELECT record_json FROM pr_reports WHERE project_id = ? AND monitor_id = ? ORDER BY rowid DESC", projectId, monitorId)
    : tx.all<{ record_json: string }>("SELECT record_json FROM pr_reports WHERE project_id = ? ORDER BY rowid DESC", projectId);
  return rows.map(row => overlay(tx, projectId, storedOf(row), options));
}

const NONTERMINAL_JOB = ["queued", "admitted", "waiting"];

/**
 * `pr.private_report/v1` review-state read model: one row per candidate (newest
 * first, bounded). Distinguishes not-reviewed (no review admitted), running
 * (admitted nonterminal review job, no report), the committed report status,
 * failed (review job ended without a report) and stale. Reading never admits work.
 */
export function listReviewStates(tx: AppTransaction, projectId: string, monitorId?: string, options: ReportReadOptions & { limit?: number } = {}): PrReviewStateItem[] {
  ensurePrSchema(tx);
  requireId(projectId);
  const limit = Math.min(Math.max(1, options.limit ?? 100), 500);
  const candidates = (monitorId
    ? tx.all<{ record_json: string }>("SELECT record_json FROM pr_candidates WHERE project_id = ? AND monitor_id = ? ORDER BY rowid DESC LIMIT ?", projectId, monitorId, limit)
    : tx.all<{ record_json: string }>("SELECT record_json FROM pr_candidates WHERE project_id = ? ORDER BY rowid DESC LIMIT ?", projectId, limit))
    .map(row => JSON.parse(row.record_json) as ReviewCandidate);
  return candidates.map(candidate => {
    const reportRow = tx.get<{ record_json: string }>("SELECT record_json FROM pr_reports WHERE candidate_id = ? AND project_id = ?", candidate.id, projectId);
    const jobRow = tx.get<{ record_json: string }>(
      "SELECT record_json FROM jobs WHERE project_id = ? AND json_extract(record_json, '$.type') = 'pr.review' AND json_extract(record_json, '$.input.candidateId') = ? ORDER BY rowid DESC LIMIT 1",
      projectId, candidate.id,
    );
    const job = jobRow ? JSON.parse(jobRow.record_json) as { id: string; state: string; reason: string } : null;
    const base = {
      candidateId: candidate.id, monitorId: candidate.monitorId, pullNumber: candidate.pullNumber,
      baseSha: candidate.baseSha, headSha: candidate.headSha, policyVersion: candidate.policyVersion,
      candidateStatus: candidate.status, jobId: job?.id ?? null, jobState: job?.state ?? null, jobReason: job?.reason ?? null,
    };
    if (reportRow) {
      const report = overlay(tx, projectId, storedOf(reportRow), options);
      return { ...base, observed: report.stale ? "stale" : report.status === "running" ? "running" : report.status, reportId: report.id, staleReason: report.staleReason } as PrReviewStateItem;
    }
    if (!job) return { ...base, observed: "not_reviewed", reportId: null, staleReason: null };
    if (NONTERMINAL_JOB.includes(job.state)) return { ...base, observed: "running", reportId: null, staleReason: null };
    if (TERMINAL_CANDIDATE.includes(candidate.status)) return { ...base, observed: "stale", reportId: null, staleReason: `candidate_${candidate.status}` };
    return { ...base, observed: "failed", reportId: null, staleReason: null };
  });
}

/** Bounded run evidence resolved for one report: source manifest, transmission, job and attempts. */
export interface ReportRunEvidence {
  /** Immutable snapshot coverage: every requested/read/unavailable/truncated source with its immutable ref. */
  coverage: CoverageManifest | null;
  transmitted: TransmittedManifest | null;
  job: { id: string; type: string; state: string; reason: string; steps: number; remaining: Record<string, number> } | null;
  attempts: Array<{ id: string; generation: number; state: string; reason: string | null; transport: string; nativeState: string; createdAt: number }>;
}

/**
 * Resolves the report's immutable source manifest (embedded, or from its pinned
 * snapshot row) plus bounded job/attempt summaries. Reading never admits work.
 */
export function reportRunEvidence(tx: AppTransaction, projectId: string, report: PrivateReport): ReportRunEvidence {
  ensurePrSchema(tx);
  let coverage: CoverageManifest | null = report.sourceManifest ?? null;
  if (!coverage) {
    try {
      const snapshot = readSnapshot(tx, report.candidateId);
      if (snapshot.id === report.snapshotId) coverage = snapshot.coverage;
    } catch { coverage = null; }
  }
  let job: ReportRunEvidence["job"] = null;
  let attempts: ReportRunEvidence["attempts"] = [];
  if (report.jobId) {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM jobs WHERE id = ? AND project_id = ?", report.jobId, projectId);
    if (row) {
      const raw = JSON.parse(row.record_json) as { id: string; type: string; state: string; reason: string; steps: number; remaining: Record<string, number> };
      job = { id: raw.id, type: raw.type, state: raw.state, reason: raw.reason, steps: raw.steps, remaining: { ...raw.remaining } };
      attempts = readAttempts(tx, raw.id).slice(-16).map(a => ({
        id: a.id, generation: a.generation, state: a.state, reason: a.reason, transport: a.transport, nativeState: a.nativeState, createdAt: a.createdAt,
      }));
    }
  }
  return { coverage, transmitted: report.transmitted ?? null, job, attempts };
}

/** Reads revisioned annotations for one report in revision order. */
export function readAnnotations(tx: AppTransaction, reportId: string): ReportAnnotation[] {
  ensurePrSchema(tx);
  requireId(reportId);
  return tx.all<{ record_json: string }>(
    "SELECT record_json FROM pr_report_annotations WHERE report_id = ? ORDER BY revision", reportId,
  ).map(row => JSON.parse(row.record_json) as ReportAnnotation);
}

export interface PersistReportInput {
  projectId: string;
  monitorId: string;
  candidateId: string;
  snapshot: ImmutableSnapshot;
  normalized: NormalizedReview;
  requiredRoles: readonly string[];
  specialistRuns: Array<{ role: string; state: string; reason: string | null; mode?: "fixture" | "production" }>;
  synthesis: { state: string; reason: string | null };
  /** Exactly what runs received; absent means completeness cannot be proven (incomplete). */
  transmitted?: TransmittedManifest | null;
  /** Admission capture (route, configuration revisions, review policy). */
  capture?: PrReviewCapture | null;
  /** Synthesis outcome evidence mode. */
  mode?: "fixture" | "production" | null;
  /** Current accepted review policy version; a different captured version is fenced. */
  currentReviewPolicyVersion?: number;
  jobId: string | null;
  attemptId: string | null;
  now: number;
}

/** Required roles whose specialist result completed and actually reached synthesis. */
function deliveredRoles(input: PersistReportInput): Set<string> {
  const completed = new Set(input.specialistRuns.filter(r => r.state === "complete").map(r => r.role));
  if (!input.transmitted) return completed;
  const delivered = new Set(input.transmitted.synthesis
    .filter(e => e.kind === "specialist" && (e.state === "sent" || e.state === "truncated"))
    .map(e => e.ref));
  return new Set([...completed].filter(role => delivered.has(role)));
}

function decideStatus(input: PersistReportInput, analyzedRoles: readonly string[]): PrReportStatus {
  const { snapshot, normalized, requiredRoles, specialistRuns, synthesis, transmitted } = input;
  if (synthesis.state === "failed" || synthesis.state === "error") return "failed";
  if (!normalized.valid) return "failed";
  if (specialistRuns.some(r => r.state === "failed" || r.state === "error")) return "failed";
  if (specialistRuns.some(r => r.state === "incomplete" || r.state === "blocked") || synthesis.state === "incomplete" || synthesis.state === "blocked") return "incomplete";
  // Model-declared roles count only when their specialist result was delivered.
  if (requiredRoles.some(r => !analyzedRoles.includes(r))) return "incomplete";
  if (!snapshot.coverage.enumerationComplete || snapshot.coverage.overall === "incomplete") return "incomplete";
  // Completion follows what runs actually received, never snapshot coverage alone.
  if (!transmitted) return "incomplete";
  const entries = [...transmitted.specialist, ...transmitted.synthesis].filter(e => e.required);
  if (entries.some(e => e.state === "omitted")) return "incomplete";
  if (snapshot.coverage.overall !== "complete") return "partial";
  if (entries.some(e => e.state === "truncated" || e.state === "unavailable")) return "partial";
  if (normalized.findings.some(f => f.status === "actionable")) return "complete_findings";
  return "complete_clean";
}

/**
 * Commits one private report atomically for the current candidate/monitor generation.
 * New revisions, trigger/review policy bumps, cancel/retire/revoke fence late publication via throw.
 * The report embeds the immutable snapshot coverage, the transmitted manifest and the admission capture.
 */
export function persistReport(tx: AppTransaction, input: PersistReportInput): PrivateReport {
  ensurePrSchema(tx);
  requireId(input.projectId); requireId(input.monitorId); requireId(input.candidateId);
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new AppError("invalid_commit_time");
  const currentReviewPolicy = input.currentReviewPolicyVersion ?? REVIEW_POLICY_VERSION;
  const reviewPolicyVersion = input.capture?.reviewPolicy.version ?? currentReviewPolicy;
  if (reviewPolicyVersion !== currentReviewPolicy) throw new AppError("pr_review_policy_changed", 409);
  const monitor = readMonitor(tx, input.projectId, input.monitorId);
  const candidate = readCandidate(tx, input.projectId, input.candidateId);
  if (monitor.state !== "active") throw new AppError("pr_monitor_not_active", 409);
  if (TERMINAL_CANDIDATE.includes(candidate.status)) throw new AppError("pr_candidate_not_current", 409);
  if (candidate.status === "draft") throw new AppError("pr_candidate_draft", 409);
  if (candidate.baseSha !== input.snapshot.baseSha || candidate.headSha !== input.snapshot.headSha) throw new AppError("pr_candidate_not_current", 409);
  if (candidate.policyVersion !== input.snapshot.policyVersion) throw new AppError("pr_candidate_not_current", 409);
  let snapshot: ImmutableSnapshot;
  try { snapshot = readSnapshot(tx, candidate.id); }
  catch { throw new AppError("pr_snapshot_not_found", 404); }
  if (snapshot.id !== input.snapshot.id) throw new AppError("pr_snapshot_not_found", 404);

  const owner = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'");
  const existing = tx.get<{ record_json: string }>("SELECT record_json FROM pr_reports WHERE candidate_id = ?", candidate.id);
  if (existing) return withStale(storedOf(existing), candidate, monitor, owner?.generation ?? null, currentReviewPolicy);

  const delivered = deliveredRoles(input);
  const analyzedRoles = input.normalized.analyzedRoles.filter(role => delivered.has(role));
  const skippedScope = [...input.normalized.skippedScope];
  for (const role of input.requiredRoles) if (!analyzedRoles.includes(role) && !skippedScope.includes(role)) skippedScope.push(role);
  const disagreements = [...input.normalized.disagreements];
  for (const role of input.normalized.analyzedRoles) {
    if (!delivered.has(role)) disagreements.push(`synthesis declared ${role.slice(0, 64)} without a delivered specialist result`);
  }
  const status = decideStatus(input, analyzedRoles);
  const authorityGeneration = owner?.generation ?? 1;
  const report: PrivateReport = {
    id: crypto.randomUUID(),
    projectId: input.projectId,
    monitorId: input.monitorId,
    candidateId: input.candidateId,
    repository: { ...candidate.repository },
    pullNumber: candidate.pullNumber,
    baseSha: candidate.baseSha,
    headSha: candidate.headSha,
    policyVersion: candidate.policyVersion,
    reviewPolicyVersion,
    status,
    stale: false,
    staleReason: null,
    findings: input.normalized.findings,
    analyzedRoles,
    requiredRoles: [...input.requiredRoles],
    skippedScope: skippedScope.slice(0, 32),
    coverageOverall: snapshot.coverage.overall,
    enumerationComplete: snapshot.coverage.enumerationComplete,
    specialistRuns: input.specialistRuns.map(r => ({ ...r })),
    synthesis: { ...input.synthesis },
    disagreements: disagreements.slice(0, 24),
    snapshotId: snapshot.id,
    sourceManifest: structuredClone(snapshot.coverage),
    transmitted: input.transmitted ? structuredClone(input.transmitted) : null,
    capture: input.capture ? structuredClone(input.capture) : null,
    mode: input.mode ?? null,
    jobId: input.jobId,
    attemptId: input.attemptId,
    authorityGeneration,
    revision: 1,
    createdAt: input.now,
    updatedAt: input.now,
  };
  tx.run(
    "INSERT INTO pr_reports(id, candidate_id, project_id, monitor_id, status, record_json) VALUES (?, ?, ?, ?, ?, ?)",
    report.id, report.candidateId, report.projectId, report.monitorId, report.status, JSON.stringify(report),
  );
  return withStale(report, candidate, monitor, authorityGeneration, currentReviewPolicy);
}

/** Canonical identity for revisioned report commands; extra fields are rejected. */
export function prReportIdentity(command: DismissReportCommand): string {
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"])
      || command.kind !== "pr.report.dismiss"
      || !requestIdOk(command.requestId)
      || !/^[a-f0-9-]{36}$/.test(command.projectId)
      || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1
      || !exact(command.payload, ["reportId", "reason"])
      || !/^[a-f0-9-]{36}$/.test(command.payload.reportId)
      || typeof command.payload.reason !== "string" || !command.payload.reason.trim()
      || command.payload.reason.length > 2000 || Buffer.byteLength(command.payload.reason) > 2000) {
    throw new AppError("invalid_pr_report_command");
  }
  return digest(JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload.reportId, command.payload.reason]));
}

/**
 * Appends a revisioned dismissal/feedback annotation without rewriting finding history.
 * The report revision advances; findings and evidence stay immutable.
 */
export function annotateReport(tx: AppTransaction, command: DismissReportCommand, now: number, kind: "dismiss" | "feedback" = "dismiss"): PrReportReceipt {
  ensurePrSchema(tx);
  prReportIdentity(command);
  requireId(command.projectId);
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_commit_time");
  const project = tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", command.projectId);
  if (!project) throw new AppError("project_not_found", 404);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM pr_reports WHERE id = ? AND project_id = ?", command.payload.reportId, command.projectId);
  if (!row) throw new AppError("pr_report_not_found", 404);
  const report = storedOf(row) as PrivateReport;
  if (report.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (secretLike.test(command.payload.reason)) throw new AppError("invalid_pr_report_command");
  const annotation: ReportAnnotation = {
    id: crypto.randomUUID(),
    reportId: report.id,
    projectId: command.projectId,
    revision: report.revision + 1,
    kind,
    text: command.payload.reason.trim().slice(0, 2000),
    createdAt: now,
  };
  tx.run("INSERT INTO pr_report_annotations(id, report_id, revision, record_json) VALUES (?, ?, ?, ?)",
    annotation.id, annotation.reportId, annotation.revision, JSON.stringify(annotation));
  const next: PrivateReport = { ...report, revision: annotation.revision, updatedAt: now };
  tx.run("UPDATE pr_reports SET status = ?, record_json = ? WHERE id = ?",
    next.status, JSON.stringify(next), next.id);
  const candidate = (() => { try { return readCandidate(tx, command.projectId, next.candidateId); } catch { return null; } })();
  const monitor = (() => { try { return readMonitor(tx, command.projectId, next.monitorId); } catch { return null; } })();
  const ownerGeneration = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation ?? null;
  const projected = candidate && monitor ? withStale(next, candidate, monitor, ownerGeneration) : { ...next, stale: true, staleReason: "authority_unavailable" };
  return { report: projected, annotation, projectRevision: project.revision };
}
