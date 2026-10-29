import { createHash } from "node:crypto";
import { MIN_MESSAGE_BYTES } from "../config";
import { AppError } from "../errors";
import { commitAttentionIntent, readDeliveryIntent, registerDeliveryGuard, retireDeliveryIntent, scrubDeliveryIntentText, type DeliveryCurrentness, type DeliveryIntent, type DeliveryReceipt } from "../delivery";
import { containsCredential, redactCredentials } from "../security/credentials";
import { neutralizeDestinations } from "../security/destinations";
import { requireId } from "../sources";
import type { AppTransaction } from "../store";
import { readAlertLink, readAlertLinks, retirePrAlerts } from "./alert-links";
import { readMonitor } from "./authority";
import { readCandidate } from "./poll";
import { ensurePrSchema } from "./schema";
import { listReports, readAnnotations, readReport } from "./report";
import type {
  AlertDecision, AlertFindingDecision, AlertLink, AlertPolicy, AlertPolicyReceipt, PrFinding, PrFindingCategory,
  PrivateReport, ReportAnnotation, SetAlertPolicyCommand, StoredAlertPolicy,
} from "./types";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const requestIdOk = (value: string) => /^[a-zA-Z0-9_-]{8,128}$/.test(value);
const destinationLike = /t\.me\/|telegram\.me|chat_id|sendMessage/i;

/** Delivery guard name under which PR alert intents are rechecked immediately before send. */
export const PR_ALERT_GUARD = "pr-alert" as const;

/** Version of the explicit default policy; persisted owner revisions count up from here. */
export const ALERT_POLICY_VERSION = 1 as const;

/** Categories that may ever notify. Style and uncertain findings stay in the private report. */
export const NOTIFIABLE_CATEGORIES: readonly PrFindingCategory[] = Object.freeze(["correctness", "security", "behavior"]);

const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;

/** Visible defaults: actionable evidence-backed correctness/security/behavior only, no severity threshold. */
export const DEFAULT_ALERT_POLICY: AlertPolicy = {
  version: ALERT_POLICY_VERSION,
  allowedCategories: ["correctness", "security", "behavior"],
  requireEvidence: true,
  requireActionable: true,
  minimumSeverity: "info",
  notifyPartial: true,
};
Object.freeze(DEFAULT_ALERT_POLICY);
Object.freeze(DEFAULT_ALERT_POLICY.allowedCategories);

export interface AlertEvaluation {
  qualifying: PrFinding[];
  held: Array<{ finding: PrFinding; reason: string }>;
}

function checkPolicy(policy: AlertPolicy): void {
  if (!policy || typeof policy !== "object"
      || !Number.isSafeInteger(policy.version) || policy.version < 1
      || !Array.isArray(policy.allowedCategories)
      || new Set(policy.allowedCategories).size !== policy.allowedCategories.length
      || policy.allowedCategories.some(c => !NOTIFIABLE_CATEGORIES.includes(c))
      || typeof policy.requireEvidence !== "boolean" || typeof policy.requireActionable !== "boolean"
      || !(SEVERITIES as readonly string[]).includes(policy.minimumSeverity)
      || typeof policy.notifyPartial !== "boolean") {
    throw new AppError("invalid_alert_policy");
  }
}

const partialScope = (report: Pick<PrivateReport, "status" | "coverageOverall" | "enumerationComplete">) =>
  report.status === "partial" || report.coverageOverall !== "complete" || !report.enumerationComplete;

/**
 * Applies the versioned notification policy to one committed report.
 * Uncertainties and taste/design suggestions stay in the private report.
 * Severity is never a substitute for evidence: the severity floor only narrows evidence-backed findings.
 * Copies sharing a `duplicateGroup` notify at most once: among copies that pass this policy the
 * representative is the first one in `preferred` (copies that already hold a live alert), else the
 * first in report order; other passing copies are held as `duplicate_finding_id`.
 */
export function evaluateReport(report: PrivateReport, policy: AlertPolicy = DEFAULT_ALERT_POLICY, preferred: ReadonlySet<string> = new Set()): AlertEvaluation {
  checkPolicy(policy);
  const passing: PrFinding[] = [];
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
    if (SEVERITIES.indexOf(finding.severity) < SEVERITIES.indexOf(policy.minimumSeverity)) {
      held.push({ finding, reason: "severity_below_minimum" });
      continue;
    }
    if (!policy.notifyPartial && partialScope(report)) {
      held.push({ finding, reason: "partial_scope_held" });
      continue;
    }
    passing.push(finding);
  }
  const chosen = new Map<string, string>();
  for (const finding of passing) {
    if (!finding.duplicateGroup) continue;
    const current = chosen.get(finding.duplicateGroup);
    if (current === undefined || (!preferred.has(current) && preferred.has(finding.id))) chosen.set(finding.duplicateGroup, finding.id);
  }
  const qualifying: PrFinding[] = [];
  for (const finding of passing) {
    if (finding.duplicateGroup && chosen.get(finding.duplicateGroup) !== finding.id) held.push({ finding, reason: "duplicate_finding_id" });
    else qualifying.push(finding);
  }
  return { qualifying, held };
}

/** Whether one finding passes `policy` on its own, ignoring duplicate-group selection. */
export function findingQualifies(report: PrivateReport, finding: PrFinding, policy: AlertPolicy): boolean {
  return evaluateReport({ ...report, findings: [finding] }, policy).qualifying.length === 1;
}

/**
 * Reads the current project alert policy. Without a persisted row this returns the explicit
 * default (`persisted:false`); reading never writes.
 */
export function readAlertPolicy(tx: AppTransaction, projectId: string): StoredAlertPolicy {
  ensurePrSchema(tx);
  requireId(projectId);
  const row = tx.get<{ record_json: string }>(
    "SELECT record_json FROM pr_alert_policies WHERE project_id = ? ORDER BY version DESC LIMIT 1", projectId);
  if (row) return JSON.parse(row.record_json) as StoredAlertPolicy;
  return { ...DEFAULT_ALERT_POLICY, allowedCategories: [...DEFAULT_ALERT_POLICY.allowedCategories], projectId, persisted: false, createdAt: null };
}

/** Lists every persisted policy version for a project, oldest first. */
export function listAlertPolicies(tx: AppTransaction, projectId: string): StoredAlertPolicy[] {
  ensurePrSchema(tx);
  requireId(projectId);
  return tx.all<{ record_json: string }>("SELECT record_json FROM pr_alert_policies WHERE project_id = ? ORDER BY version", projectId)
    .map(row => JSON.parse(row.record_json) as StoredAlertPolicy);
}

function insertPolicy(tx: AppTransaction, policy: StoredAlertPolicy): void {
  tx.run("INSERT INTO pr_alert_policies(project_id, version, record_json) VALUES (?, ?, ?)",
    policy.projectId, policy.version, JSON.stringify(policy));
}

/** Persists the explicit default (version 1) the first time a project evaluates alerts, then returns the current policy. */
export function ensureAlertPolicy(tx: AppTransaction, projectId: string, now: number): StoredAlertPolicy {
  const current = readAlertPolicy(tx, projectId);
  if (current.persisted) return current;
  const stored: StoredAlertPolicy = { ...current, persisted: true, createdAt: now };
  insertPolicy(tx, stored);
  return stored;
}

/** Logical alert key from report/revision/finding revision; replay dedupes to one intent. */
export function alertKey(report: Pick<PrivateReport, "id" | "headSha" | "policyVersion">, finding: Pick<PrFinding, "id">, policyVersion: number = ALERT_POLICY_VERSION): string {
  const base = `pr-alert/${report.id}/${finding.id}/v${policyVersion}/${report.headSha.slice(0, 12)}/${report.policyVersion}`;
  if (base.length > 160) return `pr-alert/${digest(`${report.id}:${finding.id}:${policyVersion}`)}`;
  return base;
}

/**
 * Service-derived canonical identity of one finding's defect within a PR revision. Built from
 * revision-stable location, declared evidence and normalized triggering condition, never from the
 * model-supplied finding ID, so a generic reused ID for a different defect does not alias across
 * review attempts while an equivalent finding under a fresh ID still does.
 */
export function findingFingerprint(finding: Pick<PrFinding, "location" | "evidenceType" | "evidenceRef" | "condition">): string {
  const norm = (value: string | null) => (value ?? "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  return digest(JSON.stringify(["pr-finding/v1", finding.location.path, finding.location.line ?? null,
    finding.evidenceType, norm(finding.evidenceRef), norm(finding.condition)]));
}

/**
 * Whether an outbox state means the owner was (or may yet be) told: pending, sent and unknown count;
 * a cancelled intent or a definitive `failed` delivery never notified anyone.
 */
const notifiedState = (status: DeliveryIntent["status"]) => status !== "cancelled" && status !== "failed";

function fitBytes(value: string, max: number): string {
  if (Buffer.byteLength(value) <= max) return value;
  const budget = Math.max(0, max - Buffer.byteLength("…"));
  let out = "", used = 0;
  for (const ch of value) {
    const size = Buffer.byteLength(ch);
    if (used + size > budget) break;
    out += ch; used += size;
  }
  return `${out}…`;
}

const clean = (value: string) => neutralizeDestinations(value.replace(/[\0\x08\x0B\x0C]/g, "").trim());

/**
 * Bytes every untrusted alert field (title, location path, condition, impact, evidence ref) is
 * guaranteed, when it has that much text, at any ceiling of at least `MIN_MESSAGE_BYTES`.
 */
export const ALERT_FIELD_RESERVE_BYTES = 64;

/** Per-field ceilings for untrusted alert text, in UTF-8 bytes. */
const ALERT_FIELD_CAPS = { title: 300, path: 256, condition: 1600, impact: 1600, evidenceRef: 256 } as const;
type AlertField = keyof typeof ALERT_FIELD_CAPS;

/**
 * Builds the private payload for one qualifying finding within `maxBytes` (default and upper bound
 * 3500; below `MIN_MESSAGE_BYTES` it throws `invalid_delivery_payload`).
 * The mandatory skeleton (repository/PR/revision, finding identity, location, condition, impact,
 * evidence type, the service-owned report link and the partial-scope warning when applicable) is
 * always present: it is laid out first with every untrusted field empty, then the remaining bytes
 * are shared fairly among the untrusted fields (each cut on a code-point boundary with `…`).
 * There is no final whole-message cut. `MIN_MESSAGE_BYTES` covers the worst-case skeleton plus
 * {@link ALERT_FIELD_RESERVE_BYTES} for each untrusted field.
 * Credentials, provider token values and arbitrary PR-supplied destinations never enter: every
 * PR-derived field passes `neutralizeDestinations`, and any credential match (`containsCredential`)
 * throws instead of leaking.
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
  projectId?: string;
  maxBytes?: number;
}): string {
  const maxBytes = Math.min(input.maxBytes ?? 3500, 3500);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_MESSAGE_BYTES) throw new AppError("invalid_delivery_payload");
  const finding = input.finding;
  const hasRef = !!finding.evidenceRef;
  const render = (v: Record<AlertField, string>) => {
    const lines = [
      `PR ${input.repository.owner}/${input.repository.name}#${input.pullNumber}`,
      `revision ${input.baseSha.slice(0, 12)}...${input.headSha.slice(0, 12)} policy v${input.policyVersion}`,
      `finding ${fitBytes(finding.id, 80)} [${finding.category}/${finding.severity}] ${v.title}`,
      `ที่: ${v.path}${finding.location.line ? `:${finding.location.line}` : ""}`,
      `เงื่อนไข: ${v.condition}`,
      `ผลกระทบ: ${v.impact}`,
      `หลักฐาน: ${finding.evidenceType}${hasRef ? ` ${v.evidenceRef}` : ""}`,
      input.projectId ? `รายงาน: /projects/${input.projectId}/pr/reports/${input.reportId}` : `รายงาน: ${input.reportId}`,
    ];
    if (input.coverageOverall !== "complete" || !input.enumerationComplete) {
      lines.push("คำเตือน: ตรวจไม่ครบทุกไฟล์/หลักฐาน รายงานนี้เป็น partial/incomplete");
    }
    return lines.join("\n");
  };
  const keys = Object.keys(ALERT_FIELD_CAPS) as AlertField[];
  const texts: Record<AlertField, string> = {
    title: clean(finding.title), path: clean(finding.location.path), condition: clean(finding.condition),
    impact: clean(finding.impact), evidenceRef: hasRef ? clean(finding.evidenceRef!) : "",
  };
  const empty = { title: "", path: "", condition: "", impact: "", evidenceRef: "" };
  let room = maxBytes - Buffer.byteLength(render(empty));
  if (room < 0) throw new AppError("invalid_delivery_payload");
  // Fair (water-filling) share of the remaining bytes; a field never takes more than it needs.
  const need = Object.fromEntries(keys.map(k => [k, Math.min(Buffer.byteLength(texts[k]), ALERT_FIELD_CAPS[k] + 1)])) as Record<AlertField, number>;
  const alloc: Record<AlertField, number> = { title: 0, path: 0, condition: 0, impact: 0, evidenceRef: 0 };
  let open = keys.filter(k => need[k] > 0);
  while (open.length && room >= open.length) {
    const share = Math.floor(room / open.length);
    for (const k of open) { const give = Math.min(need[k] - alloc[k], share); alloc[k] += give; room -= give; }
    open = open.filter(k => alloc[k] < need[k]);
  }
  const fitted = Object.fromEntries(keys.map(k => {
    const bound = Math.min(alloc[k], ALERT_FIELD_CAPS[k]);
    return [k, Buffer.byteLength(texts[k]) <= bound ? texts[k] : bound >= 4 ? fitBytes(texts[k], bound) : ""];
  })) as Record<AlertField, string>;
  const text = render(fitted);
  if (containsCredential(text)) throw new AppError("invalid_delivery_payload");
  if (Buffer.byteLength(text) > maxBytes) throw new AppError("invalid_delivery_payload");
  return text;
}

export interface AdmitAlertResult {
  admitted: DeliveryReceipt[];
  suppressed: Array<{ findingId: string; reason: string }>;
  held: Array<{ findingId: string; reason: string }>;
  /** Stored owner-inspectable decision; replay with identical outcomes returns the existing record. */
  decision: AlertDecision;
}

function withSavepoint<T>(tx: AppTransaction, name: string, run: () => T): T {
  tx.run(`SAVEPOINT ${name}`);
  try {
    const result = run();
    tx.run(`RELEASE ${name}`);
    return result;
  } catch (error) {
    tx.run(`ROLLBACK TO ${name}`);
    tx.run(`RELEASE ${name}`);
    throw error;
  }
}

function dismissals(annotations: ReportAnnotation[]): { report: boolean; findings: Set<string> } {
  const findings = new Set<string>();
  let report = false;
  for (const annotation of annotations) {
    if (annotation.kind !== "dismiss") continue;
    if (annotation.findingId) findings.add(annotation.findingId);
    else report = true;
  }
  return { report, findings };
}

/** Reads stored alert decisions for one report, oldest first. */
export function readAlertDecisions(tx: AppTransaction, reportId: string): AlertDecision[] {
  ensurePrSchema(tx);
  requireId(reportId);
  return tx.all<{ record_json: string }>("SELECT record_json FROM pr_alert_decisions WHERE report_id = ? ORDER BY sequence", reportId)
    .map(row => JSON.parse(row.record_json) as AlertDecision);
}

function recordDecision(tx: AppTransaction, draft: Omit<AlertDecision, "id" | "createdAt">, now: number): AlertDecision {
  const key = digest(JSON.stringify([draft.reportId, draft.reportRevision, draft.policyVersion, draft.baseSha, draft.headSha,
    draft.triggerPolicyVersion, draft.suppressedReason, draft.findings]));
  const latest = tx.get<{ digest: string; record_json: string }>(
    "SELECT digest, record_json FROM pr_alert_decisions WHERE report_id = ? ORDER BY sequence DESC LIMIT 1", draft.reportId);
  if (latest?.digest === key) return JSON.parse(latest.record_json) as AlertDecision;
  const decision: AlertDecision = { id: crypto.randomUUID(), ...draft, createdAt: now };
  tx.run("INSERT INTO pr_alert_decisions(id, project_id, report_id, digest, record_json) VALUES (?, ?, ?, ?, ?)",
    decision.id, decision.projectId, decision.reportId, key, JSON.stringify(decision));
  return decision;
}

function repeatedFindingIds(report: Pick<PrivateReport, "findings">): Set<string> {
  const seen = new Set<string>(), repeated = new Set<string>();
  for (const finding of report.findings) (seen.has(finding.id) ? repeated : seen).add(finding.id);
  return repeated;
}

function wholeReportSuppression(tx: AppTransaction, projectId: string, report: PrivateReport, annotations: ReportAnnotation[]): string | null {
  if (report.stale) return report.staleReason ?? "report_stale";
  if (report.status === "failed" || report.status === "incomplete" || report.status === "running") return `report_${report.status}`;
  let monitor, candidate;
  try {
    monitor = readMonitor(tx, projectId, report.monitorId);
    candidate = readCandidate(tx, projectId, report.candidateId);
  } catch { return "authority_unavailable"; }
  if (monitor.state !== "active") return monitor.state === "revoked" ? "monitoring_revoked" : "monitoring_not_active";
  if (["superseded", "cancelled", "stale", "closed"].includes(candidate.status)) return candidate.status === "closed" ? "pr_closed" : `candidate_${candidate.status}`;
  if (candidate.baseSha !== report.baseSha || candidate.headSha !== report.headSha || candidate.policyVersion !== report.policyVersion) return "revision_changed";
  if (dismissals(annotations).report) return "report_dismissed";
  return null;
}

/**
 * Rechecks current base/head/policy, report validity, enabled monitoring, owner generation and owner
 * dismissal immediately before outbox admission, evaluates the persisted project policy, then commits
 * at most one logical guarded intent per qualifying finding via `commitDeliveryIntent` replay dedupe.
 * A finding grouping that already holds a pending/sent/unknown alert (an earlier policy version of this
 * report, or an earlier attempt's report on the same revision with an equal `findingFingerprint`) is
 * `already_notified`; cancelled and definitively `failed` deliveries do not count as notified.
 * The outcome is stored as an owner-inspectable `AlertDecision`. Old revisions are suppressed, never labeled latest.
 * Per-finding outbox failures roll back to a savepoint and are held as `admission_failed`.
 */
export function admitReportAlerts(
  tx: AppTransaction,
  input: { projectId: string; reportId: string; maxBytes?: number; trigger?: AlertDecision["trigger"] },
  now: number,
): AdmitAlertResult {
  ensurePrSchema(tx);
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_commit_time");
  const maxBytes = input.maxBytes ?? 4000;
  const report = readReport(tx, input.projectId, input.reportId);
  const policy = ensureAlertPolicy(tx, input.projectId, now);
  const annotations = readAnnotations(tx, report.id);
  const ownerGeneration = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation ?? 0;
  const admitted: DeliveryReceipt[] = [];
  const suppressed: Array<{ findingId: string; reason: string }> = [];
  const held: Array<{ findingId: string; reason: string }> = [];
  const decisions: AlertDecision["findings"] = [];
  const pending: Array<Omit<AlertLink, "decisionId">> = [];
  const decide = (findingId: string, decision: AlertFindingDecision, reason: string | null, intentId: string | null) =>
    decisions.push({ findingId, decision, reason, intentId });

  const suppressedReason = wholeReportSuppression(tx, input.projectId, report, annotations);
  if (suppressedReason) {
    for (const finding of report.findings) {
      suppressed.push({ findingId: finding.id, reason: suppressedReason });
      decide(finding.id, "suppressed", suppressedReason, null);
    }
  } else {
    // Legacy rows may repeat a finding ID; such IDs are ambiguous, so every copy is held.
    const repeated = repeatedFindingIds(report);
    for (const finding of report.findings.filter(f => repeated.has(f.id))) {
      held.push({ findingId: finding.id, reason: "duplicate_finding_id" });
      decide(finding.id, "held", "duplicate_finding_id", null);
    }
    const links = readAlertLinks(tx, report.id);
    const priorLinks = tx.all<{ record_json: string }>("SELECT record_json FROM pr_alerts WHERE project_id = ? AND candidate_id = ? AND report_id <> ? ORDER BY rowid",
      input.projectId, report.candidateId, report.id).map(row => JSON.parse(row.record_json) as AlertLink);
    const intentOf = (link: AlertLink) => { try { return readDeliveryIntent(tx, input.projectId, link.intentId); } catch { return null; } };
    const liveIntent = (findingId: string) => links
      .filter(link => link.findingId === findingId)
      .map(intentOf)
      .find((intent): intent is DeliveryIntent => !!intent && notifiedState(intent.status)) ?? null;
    // Prior attempts are matched by canonical fingerprint; legacy links without one derive it from their
    // report when the finding ID is unambiguous there, otherwise they never suppress.
    const priorReports = new Map<string, PrivateReport | null>();
    const linkFingerprint = (link: AlertLink): string | null => {
      if (link.fingerprint) return link.fingerprint;
      if (!priorReports.has(link.reportId)) {
        try { priorReports.set(link.reportId, readReport(tx, input.projectId, link.reportId)); } catch { priorReports.set(link.reportId, null); }
      }
      const matches = priorReports.get(link.reportId)?.findings.filter(f => f.id === link.findingId) ?? [];
      return matches.length === 1 ? findingFingerprint(matches[0]!) : null;
    };
    // Copies already holding a live alert stay the group representative, so a policy change never re-alerts the group.
    const preferred = new Set(report.findings.filter(f => f.duplicateGroup && liveIntent(f.id)).map(f => f.id));
    const evaluation = evaluateReport({ ...report, findings: report.findings.filter(f => !repeated.has(f.id)) }, policy, preferred);
    const dismissed = dismissals(annotations).findings;
    for (const item of evaluation.held) {
      held.push({ findingId: item.finding.id, reason: item.reason });
      decide(item.finding.id, "held", item.reason, null);
    }
    for (const finding of evaluation.qualifying) {
      if (dismissed.has(finding.id)) {
        held.push({ findingId: finding.id, reason: "finding_dismissed" });
        decide(finding.id, "held", "finding_dismissed", null);
        continue;
      }
      // Payload hygiene recheck: secrets or PR-supplied destinations never enter the outbox.
      const hygiene = `${finding.title}\n${finding.condition}\n${finding.impact}\n${finding.reasoning}\n${finding.evidenceRef ?? ""}`;
      if (containsCredential(`${hygiene}\n${finding.location.path}`) || destinationLike.test(hygiene)) {
        held.push({ findingId: finding.id, reason: "payload_hygiene" });
        decide(finding.id, "held", "payload_hygiene", null);
        continue;
      }
      const dedupeKey = alertKey(report, finding, policy.version);
      const siblings = finding.duplicateGroup ? report.findings.filter(f => f.duplicateGroup === finding.duplicateGroup && f.id !== finding.id) : [];
      // The grouping (this finding plus same-report duplicate-group copies) is one logical alert. Within this
      // report, service-canonical finding IDs identify members (an earlier policy version's intent). Earlier
      // reviews of the same PR revision (per-attempt reports) match only by canonical fingerprint, never by
      // the raw model ID. Pending, sent or unknown alerts (even if now stale) are not repeated; cancelled
      // ones and definitive `failed` deliveries never reached the owner, so the current report re-alerts.
      const members = [finding, ...siblings];
      const memberIds = new Set(members.map(f => f.id));
      const memberPrints = new Set(members.map(findingFingerprint));
      const earlier = [
        ...links.filter(link => memberIds.has(link.findingId)),
        ...priorLinks.filter(link => { const print = linkFingerprint(link); return print !== null && memberPrints.has(print); }),
      ]
        .map(intentOf)
        .find((intent): intent is DeliveryIntent => !!intent && intent.dedupeKey !== dedupeKey && notifiedState(intent.status));
      if (earlier) {
        held.push({ findingId: finding.id, reason: "already_notified" });
        decide(finding.id, "already_notified", null, earlier.id);
        continue;
      }
      let receipt: DeliveryReceipt | null;
      try {
        // Owner-configured PR monitors explicitly request finding alerts, including under needs-me.
        receipt = withSavepoint(tx, "pr_alert_intent", () => commitAttentionIntent(tx, {
          projectId: input.projectId,
          kind: "report",
          text: buildAlertPayload({
            repository: report.repository, pullNumber: report.pullNumber, baseSha: report.baseSha, headSha: report.headSha,
            policyVersion: report.policyVersion, reportId: report.id, finding, coverageOverall: report.coverageOverall,
            enumerationComplete: report.enumerationComplete, projectId: input.projectId, maxBytes,
          }),
          dedupeKey,
          maxBytes,
          guard: PR_ALERT_GUARD,
          attention: { class: "needs_owner", item: null, workGroupId: null },
        }, now));
      } catch {
        held.push({ findingId: finding.id, reason: "admission_failed" });
        decide(finding.id, "held", "admission_failed", null);
        continue;
      }
      if (!receipt) {
        suppressed.push({ findingId: finding.id, reason: "attention_needs_me" });
        decide(finding.id, "suppressed", "attention_needs_me", null);
        continue;
      }
      if (receipt.intent.status === "cancelled") {
        const reason = receipt.intent.staleReason ?? receipt.intent.failureReason ?? "intent_cancelled";
        suppressed.push({ findingId: finding.id, reason });
        decide(finding.id, "suppressed", reason, receipt.intent.id);
        continue;
      }
      admitted.push(receipt);
      decide(finding.id, "notified", null, receipt.intent.id);
      if (receipt.created) {
        pending.push({
          intentId: receipt.intent.id, projectId: input.projectId, reportId: report.id, findingId: finding.id,
          fingerprint: findingFingerprint(finding), candidateId: report.candidateId, monitorId: report.monitorId, policyVersion: policy.version,
          reportRevision: report.revision, baseSha: report.baseSha, headSha: report.headSha,
          triggerPolicyVersion: report.policyVersion, ownerGeneration, createdAt: now,
        });
      }
    }
  }
  const decision = recordDecision(tx, {
    projectId: input.projectId, reportId: report.id, reportRevision: report.revision, candidateId: report.candidateId,
    baseSha: report.baseSha, headSha: report.headSha, triggerPolicyVersion: report.policyVersion, policyVersion: policy.version,
    trigger: input.trigger ?? "owner_admit", suppressedReason, findings: decisions,
  }, now);
  for (const link of pending) {
    const stored: AlertLink = { ...link, decisionId: decision.id };
    tx.run(`INSERT OR IGNORE INTO pr_alerts(intent_id, project_id, report_id, finding_id, candidate_id, monitor_id, policy_version, record_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, stored.intentId, stored.projectId, stored.reportId, stored.findingId,
    stored.candidateId, stored.monitorId, stored.policyVersion, JSON.stringify(stored));
  }
  return { admitted, suppressed, held, decision };
}

/**
 * Report-commit hook for the `pr.review` job: admits alerts in the same transaction as the report.
 * Admission failure rolls back only its own savepoint and returns null, so an outbox problem never
 * loses the committed report or faults the job queue.
 */
export function admitCommittedReportAlerts(
  tx: AppTransaction,
  input: { projectId: string; reportId: string; maxBytes?: number },
  now: number,
): AdmitAlertResult | null {
  try {
    return withSavepoint(tx, "pr_alert_commit", () => admitReportAlerts(tx, { ...input, trigger: "report_commit" }, now));
  } catch {
    return null;
  }
}

/**
 * `pr-alert` delivery guard: rechecks the linked report immediately before claim/send and when a
 * result lands. Stale revisions, closed/superseded candidates, revoked monitoring, owner rotation,
 * failed/incomplete reports, owner dismissal and a current policy that no longer qualifies the
 * finding all retire the intent. Paused monitoring holds it waiting.
 */
export function prAlertCurrentness(tx: AppTransaction, intent: DeliveryIntent): DeliveryCurrentness {
  const link = readAlertLink(tx, intent.id) ?? backfillLegacyAlertLink(tx, intent);
  if (!link) {
    // Quarantine: the outbox cancels it; any credential in its stored text is redacted first.
    scrubDeliveryIntentText(tx, intent, redactCredentials);
    return { current: false, reason: "legacy_alert_unverifiable" };
  }
  if (link.projectId !== intent.projectId) return { current: false, reason: "alert_link_missing" };
  let report: PrivateReport;
  try { report = readReport(tx, link.projectId, link.reportId); }
  catch { return { current: false, reason: "authority_unavailable" }; }
  if (report.stale) {
    const reason = report.staleReason ?? "report_stale";
    return { current: false, reason, hold: reason === "monitoring_not_active" };
  }
  if (report.status === "failed" || report.status === "incomplete" || report.status === "running") return { current: false, reason: `report_${report.status}` };
  if (report.baseSha !== link.baseSha || report.headSha !== link.headSha || report.policyVersion !== link.triggerPolicyVersion) {
    return { current: false, reason: "revision_changed" };
  }
  const ownerGeneration = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation ?? null;
  if (ownerGeneration !== link.ownerGeneration) return { current: false, reason: "authorization_changed" };
  const dismissed = dismissals(readAnnotations(tx, report.id));
  if (dismissed.report) return { current: false, reason: "report_dismissed" };
  if (dismissed.findings.has(link.findingId)) return { current: false, reason: "finding_dismissed" };
  const matches = report.findings.filter(item => item.id === link.findingId);
  if (matches.length > 1) return { current: false, reason: "duplicate_finding_id" };
  const finding = matches[0];
  if (!finding) return { current: false, reason: "finding_missing" };
  if (!findingQualifies(report, finding, readAlertPolicy(tx, link.projectId))) return { current: false, reason: "alert_policy_changed" };
  return { current: true };
}

const LEGACY_KEY = /^pr-alert\/([a-f0-9-]{36})\/([a-z0-9][a-z0-9_-]{0,63})\/v([1-9][0-9]{0,8})\/([a-f0-9]{12})\/([1-9][0-9]{0,8})$/;

/**
 * Upgrades one pre-guard `pr-alert/` intent (no `pr_alerts` link) inside the caller's transaction.
 * It is verifiable only when its dedupe key names an existing report/finding/head/trigger policy in
 * the same project and its stored text is exactly what today's sanitized payload builder produces
 * for that finding (so no credential or PR-supplied destination can ride along). Verified intents get
 * an `AlertLink` (decision `legacy-backfill`) and are then rechecked like any guarded alert; anything
 * else returns null and the outbox cancels it visibly as `legacy_alert_unverifiable`.
 */
export function backfillLegacyAlertLink(tx: AppTransaction, intent: DeliveryIntent): AlertLink | null {
  const match = LEGACY_KEY.exec(intent.dedupeKey);
  if (!match || intent.payload?.kind !== "report") return null;
  const [, reportId, findingId, policyVersion, head12, triggerPolicy] = match;
  let report: PrivateReport;
  try { report = readReport(tx, intent.projectId, reportId!); } catch { return null; }
  const matches = report.findings.filter(f => f.id === findingId);
  if (matches.length !== 1 || report.headSha.slice(0, 12) !== head12 || report.policyVersion !== Number(triggerPolicy)) return null;
  let expected: string;
  try {
    expected = buildAlertPayload({
      repository: report.repository, pullNumber: report.pullNumber, baseSha: report.baseSha, headSha: report.headSha,
      policyVersion: report.policyVersion, reportId: report.id, finding: matches[0]!, coverageOverall: report.coverageOverall,
      enumerationComplete: report.enumerationComplete,
    });
  } catch { return null; }
  if (intent.payload.text !== expected || containsCredential(intent.payload.text)) return null;
  const link: AlertLink = {
    intentId: intent.id, projectId: intent.projectId, reportId: report.id, findingId: findingId!,
    fingerprint: findingFingerprint(matches[0]!), candidateId: report.candidateId,
    monitorId: report.monitorId, decisionId: "legacy-backfill", policyVersion: Number(policyVersion), reportRevision: report.revision,
    baseSha: report.baseSha, headSha: report.headSha, triggerPolicyVersion: report.policyVersion,
    ownerGeneration: intent.authorityGeneration, createdAt: intent.createdAt,
  };
  tx.run(`INSERT OR IGNORE INTO pr_alerts(intent_id, project_id, report_id, finding_id, candidate_id, monitor_id, policy_version, record_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, link.intentId, link.projectId, link.reportId, link.findingId, link.candidateId, link.monitorId,
  link.policyVersion, JSON.stringify(link));
  return link;
}

/**
 * Boot-time sweep over every pre-guard `pr-alert/` intent without a link, including settled ones the
 * send guard never revisits. Verifiable intents are backfilled; the rest have credentials redacted
 * from intent payload, delivery report and source version, and are cancelled (unsent) or marked
 * stale (settled) as `legacy_alert_unverifiable`, keeping honest delivery outcome fields.
 * Returns the IDs of quarantined intents.
 */
export function quarantineLegacyPrAlerts(tx: AppTransaction, now: number): string[] {
  ensurePrSchema(tx);
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_commit_time");
  const quarantined: string[] = [];
  for (const row of tx.all<{ id: string; project_id: string }>(
    "SELECT id, project_id FROM delivery_intents WHERE dedupe_key LIKE 'pr-alert/%' AND id NOT IN (SELECT intent_id FROM pr_alerts) ORDER BY sequence",
  )) {
    const intent = readDeliveryIntent(tx, row.project_id, row.id);
    if (intent.staleReason === "legacy_alert_unverifiable") continue; // already quarantined; the sweep is idempotent
    if (backfillLegacyAlertLink(tx, intent)) continue;
    scrubDeliveryIntentText(tx, intent, redactCredentials);
    retireDeliveryIntent(tx, row.project_id, row.id, "legacy_alert_unverifiable", now, { markSettledStale: true });
    quarantined.push(row.id);
  }
  return quarantined;
}

registerDeliveryGuard(PR_ALERT_GUARD, prAlertCurrentness);

/** Canonical identity for `pr.alert_policy.set`; extra fields and evidence-disabling shapes are rejected. */
export function alertPolicyIdentity(command: SetAlertPolicyCommand): string {
  const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
    !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value as object, key));
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"])
      || command.kind !== "pr.alert_policy.set"
      || !requestIdOk(command.requestId)
      || !/^[a-f0-9-]{36}$/.test(command.projectId)
      || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1
      || !exact(command.payload, ["allowedCategories", "minimumSeverity", "notifyPartial"])
      || !Array.isArray(command.payload.allowedCategories) || command.payload.allowedCategories.length > NOTIFIABLE_CATEGORIES.length
      || command.payload.allowedCategories.some(c => typeof c !== "string" || !NOTIFIABLE_CATEGORIES.includes(c))
      || new Set(command.payload.allowedCategories).size !== command.payload.allowedCategories.length
      || !(SEVERITIES as readonly string[]).includes(command.payload.minimumSeverity)
      || typeof command.payload.notifyPartial !== "boolean") {
    throw new AppError("invalid_alert_policy");
  }
  const categories = NOTIFIABLE_CATEGORIES.filter(c => command.payload.allowedCategories.includes(c));
  return digest(JSON.stringify([command.kind, command.projectId, command.expectedRevision, categories, command.payload.minimumSeverity, command.payload.notifyPartial]));
}

/**
 * Writes the next owner alert policy version (`expectedRevision` = current version), retires pending
 * intents whose finding no longer qualifies (`alert_policy_changed`, delivered alerts untouched), and
 * re-evaluates current non-stale reports so newly qualifying findings get one logical intent.
 * Evidence and actionability stay mandatory; only categories, severity floor and partial handling adjust.
 */
export function setAlertPolicy(tx: AppTransaction, command: SetAlertPolicyCommand, now: number, maxBytes = 4000): AlertPolicyReceipt {
  ensurePrSchema(tx);
  alertPolicyIdentity(command);
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_commit_time");
  if (!tx.get("SELECT 1 FROM projects WHERE id = ?", command.projectId)) throw new AppError("project_not_found", 404);
  const current = readAlertPolicy(tx, command.projectId);
  if (current.version !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (!current.persisted) insertPolicy(tx, { ...current, persisted: true, createdAt: now });
  const policy: StoredAlertPolicy = {
    version: current.version + 1,
    allowedCategories: NOTIFIABLE_CATEGORIES.filter(c => command.payload.allowedCategories.includes(c)),
    requireEvidence: true,
    requireActionable: true,
    minimumSeverity: command.payload.minimumSeverity,
    notifyPartial: command.payload.notifyPartial,
    projectId: command.projectId,
    persisted: true,
    createdAt: now,
  };
  insertPolicy(tx, policy);
  const retiredIntentIds: string[] = [];
  const decisions: AlertDecision[] = [];
  // Every report of the project is processed in this transaction; there is no silent cap.
  for (const report of listReports(tx, command.projectId)) {
    // Per-copy qualification: a live duplicate-group alert that still passes is kept, not churned.
    const stillQualifies = new Set(report.findings.filter(f => findingQualifies(report, f, policy)).map(f => f.id));
    retiredIntentIds.push(...retirePrAlerts(tx, { projectId: command.projectId, reportId: report.id }, "alert_policy_changed", now, {
      markSettledStale: false, filter: link => !stillQualifies.has(link.findingId),
    }));
    if (!report.stale) decisions.push(admitReportAlerts(tx, { projectId: command.projectId, reportId: report.id, maxBytes, trigger: "policy_change" }, now).decision);
  }
  return { policy, previousVersion: current.version, retiredIntentIds, decisions };
}
