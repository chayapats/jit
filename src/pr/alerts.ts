import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { commitDeliveryIntent, type DeliveryReceipt } from "../delivery";
import type { AppTransaction } from "../store";
import { readMonitor } from "./authority";
import { readCandidate } from "./poll";
import { ensurePrSchema } from "./schema";
import { readReport } from "./report";
import type { AlertPolicy, PrivateReport, PrFinding } from "./types";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** Alert policy version; evaluating a report accepts this exact revision. */
export const ALERT_POLICY_VERSION = 1 as const;

/** Visible defaults: actionable evidence-backed correctness/security/behavior only. */
export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  version: ALERT_POLICY_VERSION,
  allowedCategories: ["correctness", "security", "behavior"],
  requireEvidence: true,
  requireActionable: true,
};
Object.freeze(DEFAULT_ALERT_POLICY);
Object.freeze(DEFAULT_ALERT_POLICY.allowedCategories);

export interface AlertEvaluation {
  qualifying: PrFinding[];
  held: Array<{ finding: PrFinding; reason: string }>;
}

/**
 * Applies the versioned notification policy to one committed report.
 * Uncertainties and taste/design suggestions stay in the private report.
 * Severity is never a substitute for evidence.
 */
export function evaluateReport(report: PrivateReport, policy: AlertPolicy = DEFAULT_ALERT_POLICY): AlertEvaluation {
  if (policy.version !== ALERT_POLICY_VERSION) throw new AppError("invalid_alert_policy");
  const qualifying: PrFinding[] = [];
  const held: Array<{ finding: PrFinding; reason: string }> = [];
  for (const finding of report.findings) {
    if (policy.requireActionable && finding.status !== "actionable") {
      held.push({ finding, reason: finding.validationErrors[0] ?? "not_actionable" });
      continue;
    }
    if (!policy.allowedCategories.includes(finding.category)) {
      held.push({ finding, reason: "category_not_notifiable" });
      continue;
    }
    if (policy.requireEvidence && (finding.evidenceType === "none" || finding.validationErrors.length > 0)) {
      held.push({ finding, reason: finding.validationErrors[0] ?? "evidence_required" });
      continue;
    }
    qualifying.push(finding);
  }
  return { qualifying, held };
}

/** Logical alert key from report/revision/finding revision; replay dedupes to one intent. */
export function alertKey(report: Pick<PrivateReport, "id" | "headSha" | "policyVersion">, finding: Pick<PrFinding, "id">, policyVersion: number = ALERT_POLICY_VERSION): string {
  const base = `pr-alert/${report.id}/${finding.id}/v${policyVersion}/${report.headSha.slice(0, 12)}/${report.policyVersion}`;
  if (base.length > 160) return `pr-alert/${digest(`${report.id}:${finding.id}:${policyVersion}`)}`;
  return base;
}

function esc(value: string, max: number): string {
  const clean = value.replace(/[\0\x08\x0B\x0C]/g, "").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Builds the private payload for one qualifying finding.
 * Contains only repository/PR/revision, location, condition, impact, evidence type
 * and report link plus a partial-scope warning when applicable.
 * Credentials, provider token values and arbitrary PR-supplied destinations never enter.
 */
export function buildAlertPayload(input: {
  repository: PrivateReport["repository"];
  pullNumber: number;
  baseSha: string;
  headSha: string;
  policyVersion: number;
  reportId: string;
  finding: PrFinding;
  coverageOverall: PrivateReport["coverageOverall"];
  enumerationComplete: boolean;
}): string {
  const lines = [
    `PR ${input.repository.owner}/${input.repository.name}#${input.pullNumber}`,
    `revision ${input.baseSha.slice(0, 12)}...${input.headSha.slice(0, 12)} policy v${input.policyVersion}`,
    `finding ${input.finding.id} [${input.finding.category}/${input.finding.severity}] ${esc(input.finding.title, 200)}`,
    `ที่: ${esc(input.finding.location.path, 256)}${input.finding.location.line ? `:${input.finding.location.line}` : ""}`,
    `เงื่อนไข: ${esc(input.finding.condition, 800)}`,
    `ผลกระทบ: ${esc(input.finding.impact, 800)}`,
    `หลักฐาน: ${input.finding.evidenceType}${input.finding.evidenceRef ? ` ${esc(input.finding.evidenceRef, 256)}` : ""}`,
    `รายงาน: ${input.reportId}`,
  ];
  if (input.coverageOverall !== "complete" || !input.enumerationComplete) {
    lines.push("คำเตือน: ตรวจไม่ครบทุกไฟล์/หลักฐาน รายงานนี้เป็น partial/incomplete");
  }
  const text = lines.join("\n").slice(0, 3500);
  if (/bearer\s|authorization\s*:|x-telegram|bot[_ -]?token|[0-9]{5,}:[A-Za-z0-9_-]{8,}/i.test(text)) {
    throw new AppError("invalid_delivery_payload");
  }
  return text;
}

export interface AdmitAlertResult {
  admitted: DeliveryReceipt[];
  suppressed: Array<{ findingId: string; reason: string }>;
  held: Array<{ findingId: string; reason: string }>;
}

/**
 * Rechecks current base/head/policy, report validity, enabled monitoring and owner
 * generation immediately before outbox admission, then commits at most one logical
 * intent per qualifying finding via `commitDeliveryIntent` replay dedupe.
 * Old revisions are suppressed, never labeled latest.
 */
export function admitReportAlerts(
  tx: AppTransaction,
  input: { projectId: string; reportId: string; maxBytes?: number },
  now: number,
  policy: AlertPolicy = DEFAULT_ALERT_POLICY,
): AdmitAlertResult {
  ensurePrSchema(tx);
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_commit_time");
  const maxBytes = input.maxBytes ?? 4000;
  const report = readReport(tx, input.projectId, input.reportId);
  const admitted: DeliveryReceipt[] = [];
  const suppressed: Array<{ findingId: string; reason: string }> = [];
  const held: Array<{ findingId: string; reason: string }> = [];

  if (report.stale) {
    for (const finding of report.findings) suppressed.push({ findingId: finding.id, reason: report.staleReason ?? "report_stale" });
    return { admitted, suppressed, held };
  }
  if (report.status === "failed" || report.status === "incomplete" || report.status === "running") {
    for (const finding of report.findings) suppressed.push({ findingId: finding.id, reason: `report_${report.status}` });
    return { admitted, suppressed, held };
  }

  let monitor, candidate;
  try {
    monitor = readMonitor(tx, input.projectId, report.monitorId);
    candidate = readCandidate(tx, input.projectId, report.candidateId);
  } catch {
    for (const finding of report.findings) suppressed.push({ findingId: finding.id, reason: "authority_unavailable" });
    return { admitted, suppressed, held };
  }
  if (monitor.state !== "active") {
    for (const finding of report.findings) suppressed.push({ findingId: finding.id, reason: monitor.state === "revoked" ? "monitoring_revoked" : "monitoring_not_active" });
    return { admitted, suppressed, held };
  }
  if (["superseded", "cancelled", "stale", "closed"].includes(candidate.status)) {
    for (const finding of report.findings) suppressed.push({ findingId: finding.id, reason: candidate.status === "closed" ? "pr_closed" : `candidate_${candidate.status}` });
    return { admitted, suppressed, held };
  }
  if (candidate.baseSha !== report.baseSha || candidate.headSha !== report.headSha || candidate.policyVersion !== report.policyVersion) {
    for (const finding of report.findings) suppressed.push({ findingId: finding.id, reason: "revision_changed" });
    return { admitted, suppressed, held };
  }

  const evaluation = evaluateReport(report, policy);
  for (const item of evaluation.held) held.push({ findingId: item.finding.id, reason: item.reason });

  for (const finding of evaluation.qualifying) {
    // Payload hygiene recheck: secrets or PR-supplied destinations never enter the outbox.
    const hygiene = `${finding.title}\n${finding.condition}\n${finding.impact}\n${finding.reasoning}\n${finding.evidenceRef ?? ""}`;
    if (/bearer\s|authorization\s*:|x-telegram|bot[_ -]?token|[0-9]{5,}:[A-Za-z0-9_-]{8,}/i.test(hygiene)
        || /t\.me\/|telegram\.me|chat_id|sendMessage/i.test(hygiene)) {
      held.push({ findingId: finding.id, reason: "payload_hygiene" });
      continue;
    }
    const text = buildAlertPayload({
      repository: report.repository,
      pullNumber: report.pullNumber,
      baseSha: report.baseSha,
      headSha: report.headSha,
      policyVersion: report.policyVersion,
      reportId: report.id,
      finding,
      coverageOverall: report.coverageOverall,
      enumerationComplete: report.enumerationComplete,
    });
    const dedupeKey = alertKey(report, finding, policy.version);
    const receipt = commitDeliveryIntent(tx, {
      projectId: input.projectId,
      kind: "report",
      text,
      dedupeKey,
      maxBytes,
    }, now);
    admitted.push(receipt);
  }
  return { admitted, suppressed, held };
}
