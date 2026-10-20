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
  createdAt: number;
  updatedAt: number;
}

/** Coverage entry for one requested source under exact immutable refs. */
export type CoverageState = "requested" | "read" | "unavailable" | "truncated";

export interface CoverageEntry {
  kind: "diff" | "files" | "file" | "issue" | "spec" | "ci" | "enumeration";
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
