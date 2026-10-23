/** PR01 public surface: monitoring authority and immutable snapshot capture. */

export {
  DEFAULT_PR_LIMITS,
  DEFAULT_REVIEW_POLICY,
  DEFAULT_TRIGGER_POLICY,
  REVIEW_POLICY_VERSION,
  TRIGGER_POLICY_VERSION,
} from "./types";
export type {
  AlertPolicy,
  AllowedResources,
  CandidateStatus,
  CoverageEntry,
  CoverageManifest,
  DismissReportCommand,
  EnableMonitorCommand,
  GitHubReadPort,
  ImmutableSnapshot,
  MonitorReceipt,
  MonitorState,
  PauseMonitorCommand,
  PollCheckpoint,
  PrEvidenceType,
  PrFinding,
  PrFindingCategory,
  PrFindingLocation,
  PrFindingStatus,
  PrMonitor,
  PrMonitorCommand,
  PrReadLimits,
  PrReportCommand,
  PrReportObserved,
  PrReportReceipt,
  PrReportStatus,
  PrReviewInput,
  PrivateReport,
  ProtocolCheck,
  ProtocolFile,
  ProtocolIssue,
  ProtocolPull,
  ProtocolSpec,
  ReportAnnotation,
  RepositoryIdentity,
  ResumeMonitorCommand,
  ReviewCandidate,
  RevokeMonitorCommand,
} from "./types";

export { ensurePrSchema } from "./schema";
export { mutateMonitor, prMonitorIdentity, readMonitor, readMonitors } from "./authority";
export { FakeGitHubFixture, TrustedGitHubConnector, fixturePull } from "./github";
export { pollMonitorCatchUp, pollMonitorPage, readCandidate, readCandidates } from "./poll";
export {
  captureSnapshot,
  collectSnapshotMaterials,
  persistSnapshot,
  readSnapshot,
  type SnapshotMaterials,
} from "./snapshot";
export { fencePrCandidateJobs, prSnapshotWork, type PrSnapshotInput } from "./work";
export {
  annotateReport,
  listReports,
  normalizeReviewOutput,
  persistReport,
  prReportIdentity,
  readAnnotations,
  readReport,
  validateFinding,
  type NormalizedReview,
  type PersistReportInput,
} from "./report";
export { prReviewWork, fencePrReviewJobs, type PrReviewWorkOptions } from "./review";
export {
  ALERT_POLICY_VERSION,
  DEFAULT_ALERT_POLICY,
  admitReportAlerts,
  alertKey,
  buildAlertPayload,
  evaluateReport,
  type AdmitAlertResult,
  type AlertEvaluation,
} from "./alerts";
