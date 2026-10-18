/** PR01 public surface: monitoring authority and immutable snapshot capture. */

export {
  DEFAULT_PR_LIMITS,
  DEFAULT_TRIGGER_POLICY,
  TRIGGER_POLICY_VERSION,
} from "./types";
export type {
  AllowedResources,
  CandidateStatus,
  CoverageEntry,
  CoverageManifest,
  EnableMonitorCommand,
  GitHubReadPort,
  ImmutableSnapshot,
  MonitorReceipt,
  MonitorState,
  PauseMonitorCommand,
  PollCheckpoint,
  PrMonitor,
  PrMonitorCommand,
  PrReadLimits,
  ProtocolCheck,
  ProtocolFile,
  ProtocolIssue,
  ProtocolPull,
  ProtocolSpec,
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
