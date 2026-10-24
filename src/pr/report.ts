import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import { requireId } from "../sources";
import type { AppTransaction } from "../store";
import { retirePrAlerts } from "./alert-links";
import { readMonitor } from "./authority";
import { readCandidate } from "./poll";
import { ensurePrSchema } from "./schema";
import { readSnapshot } from "./snapshot";
import {
  DEFAULT_REVIEW_POLICY,
  REVIEW_POLICY_VERSION,
  type DismissReportCommand,
  type ImmutableSnapshot,
  type PrEvidenceType,
  type PrFinding,
  type PrFindingCategory,
  type PrReportReceipt,
  type PrReportStatus,
  type PrivateReport,
  type ReportAnnotation,
} from "./types";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const requestIdOk = (value: string) => /^[a-zA-Z0-9_-]{8,128}$/.test(value);
const findingIdOk = (value: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
const SHA = /^[a-f0-9]{40}$/;

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

/**
 * Validates one proposed actionable finding against accessible snapshot references.
 * Missing/invalid citations or unsupported assertions stay suspected instead of actionable.
 * Snapshot content is untrusted data; this function never autoloads instructions or fetches.
 */
export function validateFinding(input: unknown, snapshot: ImmutableSnapshot): PrFinding {
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
  if (typeof raw.title === "string" && containsCredential(raw.title as string)) errors.push("payload_hygiene_secret");
  for (const field of [condition, impact, reasoning, evidenceRef ?? "", path]) {
    if (field && containsCredential(field)) errors.push("payload_hygiene_secret");
  }

  if (path) {
    if (evidenceType === "diff") {
      const file = snapshot.files.find(f => f.path === path);
      if (!file) errors.push("invalid_source_ref");
      else if (file.patch === null) errors.push("evidence_unavailable");
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
      else if (!snapshot.ci.some(c => c.name === evidenceRef)) errors.push("evidence_unavailable");
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

/**
 * Makes finding IDs unique before a report is persisted without choosing a winner. Copies that
 * repeat a model-supplied ID all record it as `duplicateGroup`; the first keeps the ID and later
 * copies are renamed `<id>-dup<n>`. Each copy keeps its own validated status and errors. Which copy
 * (if any) notifies is decided per policy evaluation (`evaluateReport`), at most one per group.
 */
export function canonicalizeFindingIds(findings: readonly PrFinding[]): PrFinding[] {
  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.id, (counts.get(finding.id) ?? 0) + 1);
  const taken = new Set(counts.keys());
  const seen = new Set<string>();
  return findings.map(finding => {
    if ((counts.get(finding.id) ?? 0) < 2) return finding;
    const group = finding.duplicateGroup ?? finding.id;
    if (!seen.has(finding.id)) { seen.add(finding.id); return { ...finding, duplicateGroup: group }; }
    let n = 2, id = "";
    do { id = `${finding.id.slice(0, 56)}-dup${n++}`; } while (taken.has(id));
    taken.add(id);
    return { ...finding, id, duplicateGroup: group };
  });
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
export function normalizeReviewOutput(output: string, snapshot: ImmutableSnapshot, allowedRoles: readonly string[] = DEFAULT_REVIEW_POLICY.requiredRoles): NormalizedReview {
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
  const findings = canonicalizeFindingIds(list.map(item => {
    try { return validateFinding(item, snapshot); }
    catch { return validateFinding({}, snapshot); }
  }));
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

function isStale(report: PrivateReport, candidate: { baseSha: string; headSha: string; policyVersion: number; status: string }, monitor: { state: string; policy: { version: number } }, ownerGeneration: number | null): { stale: boolean; reason: string | null } {
  if (ownerGeneration !== null && report.authorityGeneration !== undefined && ownerGeneration !== report.authorityGeneration) {
    return { stale: true, reason: "authorization_changed" };
  }
  if (monitor.state !== "active") return { stale: true, reason: monitor.state === "revoked" ? "monitoring_revoked" : "monitoring_not_active" };
  if (["superseded", "cancelled", "stale", "closed"].includes(candidate.status)) {
    return { stale: true, reason: candidate.status === "closed" ? "pr_closed" : `candidate_${candidate.status}` };
  }
  if (candidate.baseSha !== report.baseSha || candidate.headSha !== report.headSha) return { stale: true, reason: "revision_changed" };
  if (candidate.policyVersion !== report.policyVersion || monitor.policy.version !== report.policyVersion) return { stale: true, reason: "policy_changed" };
  return { stale: false, reason: null };
}

function withStale(report: PrivateReport, candidate: { baseSha: string; headSha: string; policyVersion: number; status: string }, monitor: { state: string; policy: { version: number } }, ownerGeneration: number | null = null): PrivateReport {
  const { stale, reason } = isStale(report, candidate, monitor, ownerGeneration);
  return stale ? { ...report, stale: true, staleReason: reason } : { ...report, stale: false, staleReason: null };
}

/** Reads one committed report with a computed stale overlay; history rows are never mutated by reads. */
export function readReport(tx: AppTransaction, projectId: string, reportId: string): PrivateReport {
  ensurePrSchema(tx);
  requireId(projectId); requireId(reportId);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM pr_reports WHERE id = ? AND project_id = ?", reportId, projectId);
  if (!row) throw new AppError("pr_report_not_found", 404);
  const report = storedOf(row);
  try {
    const candidate = readCandidate(tx, projectId, report.candidateId);
    const monitor = readMonitor(tx, projectId, report.monitorId);
    const ownerGeneration = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation ?? null;
    return withStale(report, candidate, monitor, ownerGeneration);
  } catch {
    return { ...report, stale: true, staleReason: "authority_unavailable" };
  }
}

/** Lists committed reports newest-first with computed stale overlays. */
export function listReports(tx: AppTransaction, projectId: string, monitorId?: string): PrivateReport[] {
  ensurePrSchema(tx);
  requireId(projectId);
  const rows = monitorId
    ? tx.all<{ record_json: string }>("SELECT record_json FROM pr_reports WHERE project_id = ? AND monitor_id = ? ORDER BY rowid DESC", projectId, monitorId)
    : tx.all<{ record_json: string }>("SELECT record_json FROM pr_reports WHERE project_id = ? ORDER BY rowid DESC", projectId);
  return rows.map(row => {
    const report = storedOf(row);
    try {
      const candidate = readCandidate(tx, projectId, report.candidateId);
      const monitor = readMonitor(tx, projectId, report.monitorId);
      const ownerGeneration = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation ?? null;
      return withStale(report, candidate, monitor, ownerGeneration);
    } catch {
      return { ...report, stale: true, staleReason: "authority_unavailable" };
    }
  });
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
  specialistRuns: Array<{ role: string; state: string; reason: string | null }>;
  synthesis: { state: string; reason: string | null };
  jobId: string | null;
  attemptId: string | null;
  now: number;
}

function decideStatus(input: PersistReportInput): PrReportStatus {
  const { snapshot, normalized, requiredRoles, specialistRuns, synthesis } = input;
  if (synthesis.state === "failed" || synthesis.state === "error") return "failed";
  if (!normalized.valid) return "failed";
  if (specialistRuns.some(r => r.state === "failed" || r.state === "error")) return "failed";
  if (specialistRuns.some(r => r.state === "incomplete" || r.state === "blocked") || synthesis.state === "incomplete" || synthesis.state === "blocked") return "incomplete";
  const missing = requiredRoles.filter(r => !normalized.analyzedRoles.includes(r));
  if (missing.length > 0) return "incomplete";
  if (!snapshot.coverage.enumerationComplete) return "incomplete";
  if (snapshot.coverage.overall !== "complete") return "partial";
  if (normalized.findings.some(f => f.status === "actionable")) return "complete_findings";
  return "complete_clean";
}

/**
 * Commits one private report atomically for the current candidate/monitor generation.
 * New revisions, policy bumps, cancel/retire/revoke fence late publication via throw.
 */
export function persistReport(tx: AppTransaction, input: PersistReportInput): PrivateReport {
  ensurePrSchema(tx);
  requireId(input.projectId); requireId(input.monitorId); requireId(input.candidateId);
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new AppError("invalid_commit_time");
  const monitor = readMonitor(tx, input.projectId, input.monitorId);
  const candidate = readCandidate(tx, input.projectId, input.candidateId);
  if (monitor.state !== "active") throw new AppError("pr_monitor_not_active", 409);
  if (["superseded", "cancelled", "stale", "closed"].includes(candidate.status)) throw new AppError("pr_candidate_not_current", 409);
  if (candidate.status === "draft") throw new AppError("pr_candidate_draft", 409);
  if (candidate.baseSha !== input.snapshot.baseSha || candidate.headSha !== input.snapshot.headSha) throw new AppError("pr_candidate_not_current", 409);
  if (candidate.policyVersion !== input.snapshot.policyVersion) throw new AppError("pr_candidate_not_current", 409);
  let snapshot: ImmutableSnapshot;
  try { snapshot = readSnapshot(tx, candidate.id); }
  catch { throw new AppError("pr_snapshot_not_found", 404); }
  if (snapshot.id !== input.snapshot.id) throw new AppError("pr_snapshot_not_found", 404);

  const owner = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'");
  const existing = tx.get<{ record_json: string }>("SELECT record_json FROM pr_reports WHERE candidate_id = ?", candidate.id);
  if (existing) return withStale(storedOf(existing), candidate, monitor, owner?.generation ?? null);

  const status = decideStatus(input);
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
    reviewPolicyVersion: REVIEW_POLICY_VERSION,
    status,
    stale: false,
    staleReason: null,
    findings: canonicalizeFindingIds(input.normalized.findings),
    analyzedRoles: [...input.normalized.analyzedRoles],
    requiredRoles: [...input.requiredRoles],
    skippedScope: [...input.normalized.skippedScope],
    coverageOverall: snapshot.coverage.overall,
    enumerationComplete: snapshot.coverage.enumerationComplete,
    specialistRuns: input.specialistRuns.map(r => ({ ...r })),
    synthesis: { ...input.synthesis },
    disagreements: [...input.normalized.disagreements],
    snapshotId: snapshot.id,
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
  return withStale(report, candidate, monitor, authorityGeneration);
}

/** Canonical identity for revisioned report commands; extra fields are rejected. */
export function prReportIdentity(command: DismissReportCommand): string {
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"])
      || command.kind !== "pr.report.dismiss"
      || !requestIdOk(command.requestId)
      || !/^[a-f0-9-]{36}$/.test(command.projectId)
      || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1
      || !(exact(command.payload, ["reportId", "reason"]) || exact(command.payload, ["reportId", "reason", "findingId"]))
      || !/^[a-f0-9-]{36}$/.test(command.payload.reportId)
      || (command.payload.findingId !== undefined && (typeof command.payload.findingId !== "string" || !findingIdOk(command.payload.findingId)))
      || typeof command.payload.reason !== "string" || !command.payload.reason.trim()
      || command.payload.reason.length > 2000 || Buffer.byteLength(command.payload.reason) > 2000) {
    throw new AppError("invalid_pr_report_command");
  }
  const identity: unknown[] = [command.kind, command.projectId, command.expectedRevision, command.payload.reportId, command.payload.reason];
  if (command.payload.findingId !== undefined) identity.push(command.payload.findingId);
  return digest(JSON.stringify(identity));
}

/**
 * Appends a revisioned dismissal/feedback annotation without rewriting finding history.
 * The report revision advances; findings and evidence stay immutable. The annotation links the
 * latest stored alert decision; a dismissal (whole report or one `findingId`) retires pending alert
 * intents in the same transaction and feeds later admission/send rechecks. It never writes memory
 * claims, so a rejected finding is never learned as a confirmed fact.
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
  if (containsCredential(command.payload.reason)) throw new AppError("invalid_pr_report_command");
  const findingId = command.payload.findingId ?? null;
  if (findingId !== null && !report.findings.some(f => f.id === findingId)) throw new AppError("pr_finding_not_found", 404);
  const decision = tx.get<{ id: string }>("SELECT id FROM pr_alert_decisions WHERE report_id = ? ORDER BY sequence DESC LIMIT 1", report.id);
  const annotation: ReportAnnotation = {
    id: crypto.randomUUID(),
    reportId: report.id,
    projectId: command.projectId,
    revision: report.revision + 1,
    kind,
    text: command.payload.reason.trim().slice(0, 2000),
    createdAt: now,
    findingId,
    decisionId: decision?.id ?? null,
  };
  tx.run("INSERT INTO pr_report_annotations(id, report_id, revision, record_json) VALUES (?, ?, ?, ?)",
    annotation.id, annotation.reportId, annotation.revision, JSON.stringify(annotation));
  const next: PrivateReport = { ...report, revision: annotation.revision, updatedAt: now };
  tx.run("UPDATE pr_reports SET status = ?, record_json = ? WHERE id = ?",
    next.status, JSON.stringify(next), next.id);
  if (kind === "dismiss") {
    retirePrAlerts(tx, findingId === null
      ? { projectId: command.projectId, reportId: report.id }
      : { projectId: command.projectId, reportId: report.id, findingId },
    findingId === null ? "report_dismissed" : "finding_dismissed", now, { markSettledStale: false });
  }
  const candidate = (() => { try { return readCandidate(tx, command.projectId, next.candidateId); } catch { return null; } })();
  const monitor = (() => { try { return readMonitor(tx, command.projectId, next.monitorId); } catch { return null; } })();
  const ownerGeneration = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation ?? null;
  const projected = candidate && monitor ? withStale(next, candidate, monitor, ownerGeneration) : { ...next, stale: true, staleReason: "authority_unavailable" };
  return { report: projected, annotation, projectRevision: project.revision };
}
