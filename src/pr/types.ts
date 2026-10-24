/** Trigger defaults are explicit engineering policy; enabling a monitor accepts this revision. */
export const TRIGGER_POLICY_VERSION = 1 as const;

/** Visible, reversible defaults for PR monitoring (FR-08 / ADR0005). */
export const DEFAULT_TRIGGER_POLICY = Object.freeze({
  version: TRIGGER_POLICY_VERSION,
  skipDraftUntilReady: true,
  reconsiderChangedBaseOrHead: true,
  closeCancelsPending: true,
  reopenReevaluates: true,
} as const);

/** Finite read limits declared when enabling a monitor; not account capacity claims. */
export interface PrReadLimits {
  pollIntervalMs: number;
  pageSize: number;
  maxPages: number;
  maxPayloadBytes: number;
  maxFiles: number;
  maxDiffBytes: number;
  maxEvidenceBytes: number;
}

/** Installation defaults used when the owner does not override a finite limit. */
export const DEFAULT_PR_LIMITS: Readonly<PrReadLimits> = Object.freeze({
  pollIntervalMs: 60_000,
  pageSize: 30,
  maxPages: 10,
  maxPayloadBytes: 262_144,
  maxFiles: 200,
  maxDiffBytes: 524_288,
  maxEvidenceBytes: 65_536,
});

/** Canonical repository identity resolved by the service, never by model-supplied URLs. */
export interface RepositoryIdentity {
  host: string;
  owner: string;
  name: string;
}

/** Allowed read resources under one monitor; credentials stay outside these records. */
export interface AllowedResources {
  issues: boolean;
  specs: boolean;
  ci: boolean;
}

/** Standing authorization for read-only PR monitoring on one allowlisted repository. */
export type MonitorState = "active" | "paused" | "revoked";

export interface PrMonitor {
  id: string;
  projectId: string;
  revision: number;
  state: MonitorState;
  repository: RepositoryIdentity;
  apiBase: string;
  allowed: AllowedResources;
  policy: typeof DEFAULT_TRIGGER_POLICY;
  limits: PrReadLimits;
  acceptedPolicyVersion: number;
  createdAt: number;
  updatedAt: number;
}

/** Durable poll cursor; incomplete pages never claim catch-up completed. */
export interface PollCheckpoint {
  monitorId: string;
  updatedAt: number;
  complete: boolean;
  nextPage: number;
  etag: string | null;
  lastSeenUpdatedAt: string | null;
  reason: string | null;
}

/** Candidate lifecycle stays distinguishable from reviewed-clean (owned by PR02). */
export type CandidateStatus =
  | "draft"
  | "ready"
  | "closed"
  | "captured"
  | "partial"
  | "stale"
  | "superseded"
  | "cancelled";

/** Review scope policy version; enabling a review accepts this exact revision. */
export const REVIEW_POLICY_VERSION = 1 as const;

/** Visible defaults for private static review: every required role plus complete enumeration. */
export const DEFAULT_REVIEW_POLICY = Object.freeze({
  version: REVIEW_POLICY_VERSION,
  requiredRoles: ["correctness", "security"] as const,
  requireCompleteEnumeration: true as const,
} as const);

/**
 * Review scope policy one `pr.review` worker enforces. The installation's
 * accepted policy is `DEFAULT_REVIEW_POLICY`; a different version models an
 * upgraded policy and fences work and reports captured under the old one.
 */
export interface PrReviewPolicy {
  version: number;
  requiredRoles: readonly string[];
}

/** Configuration layer that supplied the captured PR review route. */
export type PrReviewRouteLayer = "project_default" | "owner_default" | "scripted_fixture";

/**
 * Immutable `pr.review` admission capture stored as attempt data. Retries reuse
 * the first capture exactly (no route fallback); a changed review policy fences it.
 */
export interface PrReviewCapture {
  version: 1;
  adapter: string;
  route: { provider: "grok" | "codex"; model: string; authRoute: string };
  layer: PrReviewRouteLayer;
  configuration: { ownerRevision: number; projectRevision: number; roleRevision: number };
  reviewPolicy: { version: number; requiredRoles: string[] };
}

/** What happened to one snapshot item or specialist result on its way into a run. */
export type TransmissionState = "sent" | "truncated" | "omitted" | "unavailable";

/**
 * One bounded item delivered (or not) to the specialists or the synthesizer.
 * `required` items gate completeness: omission forces incomplete, truncation or
 * unavailability forces partial. `chunk` is the manifest source index, if sent.
 */
export interface TransmittedEntry {
  kind: "pr" | "diff" | "ci" | "issue" | "spec" | "specialist";
  ref: string;
  required: boolean;
  state: TransmissionState;
  bytes: number;
  sentBytes: number;
  chunk: number | null;
}

/**
 * Exact transmitted manifest: what every specialist received (identical across
 * specialists) and what the synthesizer received. Completion derives from this,
 * never from snapshot coverage alone or from model-declared roles.
 */
export interface TransmittedManifest {
  version: 1;
  sourceLimit: number;
  contextBytes: number;
  specialist: TransmittedEntry[];
  synthesis: TransmittedEntry[];
}

/** Finding category; only evidence-backed correctness/security/behavior qualify for alerts. */
export type PrFindingCategory = "correctness" | "security" | "behavior" | "style" | "uncertain";

/** Declared evidence kind backing one finding; `none` can never be actionable. */
export type PrEvidenceType = "diff" | "issue" | "spec" | "ci" | "none";

/** Validated finding state; missing/invalid citations stay suspected instead of actionable. */
export type PrFindingStatus = "actionable" | "suspected";

/** Precise location for one finding; line is null when the whole file is implicated. */
export interface PrFindingLocation {
  path: string;
  line: number | null;
}

/** One validated static finding pinned to exact snapshot evidence. */
export interface PrFinding {
  id: string;
  title: string;
  category: PrFindingCategory;
  severity: "info" | "low" | "medium" | "high" | "critical";
  location: PrFindingLocation;
  condition: string;
  impact: string;
  reasoning: string;
  evidenceType: PrEvidenceType;
  evidenceRef: string | null;
  status: PrFindingStatus;
  validationErrors: string[];
  /**
   * Raw model-supplied ID shared by copies that repeated it; absent for unique findings. Each copy
   * keeps its own validated status; alert evaluation notifies at most one copy per group.
   */
  duplicateGroup?: string;
}

/** Persisted review outcome; `stale` is a computed overlay, never a stored status. */
export type PrReportStatus =
  | "running"
  | "complete_clean"
  | "complete_findings"
  | "partial"
  | "incomplete"
  | "failed";

/** Observable report state including computed overlays; absence means not-reviewed. */
export type PrReportObserved = PrReportStatus | "stale";

/** A durable private review report pinned to one repository/PR/base/head/policy tuple. */
export interface PrivateReport {
  id: string;
  projectId: string;
  monitorId: string;
  candidateId: string;
  repository: RepositoryIdentity;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  policyVersion: number;
  reviewPolicyVersion: number;
  status: PrReportStatus;
  stale: boolean;
  staleReason: string | null;
  findings: PrFinding[];
  analyzedRoles: string[];
  requiredRoles: string[];
  skippedScope: string[];
  coverageOverall: CoverageManifest["overall"];
  enumerationComplete: boolean;
  specialistRuns: Array<{ role: string; state: string; reason: string | null; mode?: "fixture" | "production" }>;
  synthesis: { state: string; reason: string | null };
  disagreements: string[];
  /** Proposed findings beyond the validation bound; nonzero means incomplete. */
  findingsOverflow: number;
  snapshotId: string;
  /** Immutable snapshot coverage (source manifest) the report was decided against. */
  sourceManifest: CoverageManifest;
  /** Exactly what the runs received; null only for reports persisted without runs. */
  transmitted: TransmittedManifest | null;
  /** Route, layer and configuration revisions captured at admission; null without runs. */
  capture: PrReviewCapture | null;
  /** Evidence mode of the synthesis run; fixture output never claims live inference. */
  mode: "fixture" | "production" | null;
  jobId: string | null;
  attemptId: string | null;
  authorityGeneration: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * Observable review state per candidate (`pr.private_report/v1` read model).
 * `not_reviewed`: no review admitted; `running`: newest review job nonterminal
 * without a report; `failed`: newest review job ended without committing a report
 * (jobState says failed/blocked/partial);
 * `stale`: retained report (or fenced work) no longer current.
 */
export type PrReviewObserved = "not_reviewed" | "running" | "stale" | Exclude<PrReportStatus, "running">;

export interface PrReviewStateItem {
  candidateId: string;
  monitorId: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  policyVersion: number;
  candidateStatus: CandidateStatus;
  observed: PrReviewObserved;
  /** Report backing `observed`; null when the projected (newest) attempt has no report. */
  reportId: string | null;
  /** Earlier report kept as historical context while a newer attempt is projected. */
  previousReportId: string | null;
  staleReason: string | null;
  jobId: string | null;
  jobState: string | null;
  jobReason: string | null;
}

/** A revisioned owner annotation on a report; history rows are never rewritten. */
export interface ReportAnnotation {
  id: string;
  reportId: string;
  projectId: string;
  revision: number;
  kind: "dismiss" | "feedback";
  text: string;
  createdAt: number;
  /** Finding this annotation applies to; null or absent means the whole report. */
  findingId?: string | null;
  /** Latest stored alert decision the annotation responds to, when one existed. */
  decisionId?: string | null;
}

/** Job input identifying one durable candidate for private review. */
export interface PrReviewInput {
  monitorId: string;
  candidateId: string;
}

/** Owner revisioned dismissal/feedback on a private report. */
export interface DismissReportCommand {
  kind: "pr.report.dismiss";
  requestId: string;
  projectId: string;
  expectedRevision: number;
  /** `findingId` narrows the dismissal to one finding; omitted means the whole report. */
  payload: { reportId: string; reason: string; findingId?: string };
}

export type PrReportCommand = DismissReportCommand;

/** Receipt for a revisioned report annotation; findings history is unchanged. */
export interface PrReportReceipt {
  report: PrivateReport;
  annotation: ReportAnnotation;
  projectRevision: number;
}

/** Versioned private alert policy; severity never substitutes for evidence. */
export interface AlertPolicy {
  /** Persisted policy revision; the explicit default is version 1. */
  version: number;
  allowedCategories: PrFindingCategory[];
  requireEvidence: boolean;
  requireActionable: boolean;
  /** Additional owner floor applied after evidence; `info` means no severity threshold. */
  minimumSeverity: PrFinding["severity"];
  /** Whether partial/incomplete-scope reports may notify (always with the partial-scope warning). */
  notifyPartial: boolean;
}

/** Project-scoped policy as read from `pr_alert_policies`; `persisted:false` is the explicit unwritten default. */
export interface StoredAlertPolicy extends AlertPolicy {
  projectId: string;
  persisted: boolean;
  createdAt: number | null;
}

/** Owner command that writes the next alert policy version. `expectedRevision` is the current policy version. */
export interface SetAlertPolicyCommand {
  kind: "pr.alert_policy.set";
  requestId: string;
  projectId: string;
  expectedRevision: number;
  payload: { allowedCategories: PrFindingCategory[]; minimumSeverity: PrFinding["severity"]; notifyPartial: boolean };
}

/** Per-finding outcome of one stored alert evaluation. */
export type AlertFindingDecision = "notified" | "already_notified" | "held" | "suppressed";

/** Stored, owner-inspectable record of why each finding of one report was notified, held or suppressed. */
export interface AlertDecision {
  id: string;
  projectId: string;
  reportId: string;
  reportRevision: number;
  candidateId: string;
  baseSha: string;
  headSha: string;
  triggerPolicyVersion: number;
  policyVersion: number;
  trigger: "report_commit" | "owner_admit" | "policy_change";
  /** Whole-report suppression reason (stale, failed, dismissed, ...); null when findings were evaluated. */
  suppressedReason: string | null;
  findings: Array<{ findingId: string; decision: AlertFindingDecision; reason: string | null; intentId: string | null }>;
  createdAt: number;
}

/** Receipt for `pr.alert_policy.set`; pending intents that no longer qualify are retired, current reports re-evaluated. */
export interface AlertPolicyReceipt {
  policy: StoredAlertPolicy;
  previousVersion: number;
  retiredIntentIds: string[];
  decisions: AlertDecision[];
}

/** Durable link from one outbox intent back to the report/finding/revision that produced it. */
export interface AlertLink {
  intentId: string;
  projectId: string;
  reportId: string;
  findingId: string;
  /** `findingFingerprint` of the linked finding; absent on links written before cross-attempt fingerprints. */
  fingerprint?: string;
  candidateId: string;
  monitorId: string;
  decisionId: string;
  policyVersion: number;
  reportRevision: number;
  baseSha: string;
  headSha: string;
  triggerPolicyVersion: number;
  ownerGeneration: number;
  createdAt: number;
}

/** A durable review candidate keyed by repository/PR/base/head/policy. */
export interface ReviewCandidate {
  id: string;
  projectId: string;
  monitorId: string;
  repository: RepositoryIdentity;
  pullNumber: number;
  title: string;
  draft: boolean;
  state: "open" | "closed";
  baseSha: string;
  headSha: string;
  policyVersion: number;
  dedupeKey: string;
  generation: number;
  status: CandidateStatus;
  jobId: string | null;
  snapshotId: string | null;
  /** Durable lifecycle reason recorded when the candidate became stale (for example `source_retired`). */
  staleReason?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Coverage entry for one requested source under exact immutable refs. */
export type CoverageState = "requested" | "read" | "unavailable" | "truncated";

export interface CoverageEntry {
  /** `pr` covers the PR title/body (path `title` or `body`) when a byte ceiling cut it. */
  kind: "diff" | "files" | "file" | "issue" | "spec" | "ci" | "enumeration" | "pr";
  path: string | null;
  state: CoverageState;
  immutableRef: string | null;
  limit: number | null;
  bytes: number | null;
  reason: string | null;
}

/**
 * Honest input coverage for one base/head capture.
 * Reading selected files is not proof the complete change set was enumerated.
 */
export interface CoverageManifest {
  baseSha: string;
  headSha: string;
  policyVersion: number;
  enumerationComplete: boolean;
  overall: "complete" | "partial" | "incomplete";
  entries: CoverageEntry[];
}

/** Immutable static review inputs; never an executable workspace. */
export interface ImmutableSnapshot {
  id: string;
  candidateId: string;
  repository: RepositoryIdentity;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  policyVersion: number;
  title: string;
  body: string;
  files: Array<{ path: string; status: string; patch: string | null; truncated: boolean }>;
  issues: Array<{ number: number; title: string; body: string }>;
  specs: Array<{ path: string; text: string; truncated: boolean }>;
  ci: Array<{ name: string; conclusion: string | null; available: boolean; reason: string | null }>;
  coverage: CoverageManifest;
  createdAt: number;
}

/** Owner project commands that configure standing PR monitoring authority. */
export interface EnableMonitorCommand {
  kind: "pr.monitor.enable";
  requestId: string;
  projectId: string;
  expectedRevision: number;
  payload: {
    repository: RepositoryIdentity;
    apiBase: string;
    allowed: AllowedResources;
    limits?: Partial<PrReadLimits>;
    acceptPolicyVersion: number;
  };
}

export interface PauseMonitorCommand {
  kind: "pr.monitor.pause";
  requestId: string;
  projectId: string;
  expectedRevision: number;
  payload: { monitorId: string };
}

export interface ResumeMonitorCommand {
  kind: "pr.monitor.resume";
  requestId: string;
  projectId: string;
  expectedRevision: number;
  payload: { monitorId: string };
}

export interface RevokeMonitorCommand {
  kind: "pr.monitor.revoke";
  requestId: string;
  projectId: string;
  expectedRevision: number;
  payload: { monitorId: string };
}

export type PrMonitorCommand =
  | EnableMonitorCommand
  | PauseMonitorCommand
  | ResumeMonitorCommand
  | RevokeMonitorCommand;

export interface MonitorReceipt {
  monitor: PrMonitor;
  projectRevision: number;
  displayedPolicy: typeof DEFAULT_TRIGGER_POLICY;
}

/** Protocol-level PR listing row used by the trusted connector and fixtures. */
export interface ProtocolPull {
  number: number;
  title: string;
  body: string;
  draft: boolean;
  state: "open" | "closed";
  updatedAt: string;
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
}

export interface ProtocolFile {
  filename: string;
  status: string;
  patch: string | null;
  truncated?: boolean;
}

export interface ProtocolIssue {
  number: number;
  title: string;
  body: string;
}

export interface ProtocolSpec {
  path: string;
  text: string;
}

export interface ProtocolCheck {
  name: string;
  conclusion: string | null;
}

/** Fake or live connector surface; mutations and arbitrary URLs are out of scope. */
export interface GitHubReadPort {
  listPulls(page: number): { items: ProtocolPull[]; incomplete: boolean; etag: string | null; reason: string | null };
  resolvePull(number: number): ProtocolPull | null;
  listFiles(number: number, baseSha: string, headSha: string, page: number): {
    items: ProtocolFile[]; incomplete: boolean; truncated: boolean; reason: string | null;
  };
  readIssue(number: number): ProtocolIssue | { denied: true; reason: string };
  readSpec(path: string, ref: string): ProtocolSpec | { denied: true; reason: string } | { truncated: true; path: string; text: string };
  readChecks(headSha: string): ProtocolCheck[] | { denied: true; reason: string };
}
