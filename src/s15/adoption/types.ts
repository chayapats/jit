import type { PolicyOptions, S15PolicyService, AuthenticatedOwner } from '../policy';

/** Exact immutable executable, independently hashed; a commit alone never identifies installed bytes. */
export interface AdoptionBuild { commit: string; path: string; sha256: string }
/** Explicit installation selection. Paths are protected host configuration, never model input or discovery hints. */
export interface AdoptionSource {
  runtime: 's14' | 'legacy'; database: string; installationId: string; build: AdoptionBuild;
  configPath: string; argv: string[];
  /** Explicit additional native/volume/profile/control recovery roots. Bytes remain in their original custody. */
  preservedPaths: string[];
}
/** Re-observed by trusted host code outside the working guest. A JSON hash supplied by an agent is insufficient. */
export interface AdoptionBoundary {
  protected: boolean;
  /** The prior runtime/transports/computers/native state remain settled; new S15 activity need not be idle. */
  settled: boolean;
  priorBuildFenceVerified: boolean;
  hostId: string; evidenceHash: string;
  sourceArtifact: string; targetArtifact: string;
}
/** Each checkpoint is durable before the fault hook; production composition omits this deterministic test seam. */
export type AdoptionCheckpoint = 'preparing' | 'source_fenced' | 'candidate_committed' | 'activation_intent' | 'active_fenced' | 'workers_released' | 'activity_recorded' | 'rollback_intent' | 'prior_selected' | 'source_released';
/** Protected offline coordinator. No live host default, provider, network, native relocation or imported grant exists. */
export interface AdoptionOptions {
  runtime: 's15'; directory: string; source: AdoptionSource; target: AdoptionBuild;
  boundary: { observe(): AdoptionBoundary };
  policy: Omit<PolicyOptions, 'runtime' | 'path' | 'create' | 'installationId' | 'activityGuard' | 'requestGuard' | 'initialReservations'>;
  now?: () => number; fault?: (point: AdoptionCheckpoint) => void;
}
/** Fixed, bounded typed SQL cells preserve integers and BLOBs without JS-number coercion or text rewriting. */
export type AdoptionCell = null | { text: string } | { integer: string } | { real: string } | { blobBase64: string };
/** Private host-only history row. It never enters a tool, prompt, team resource or execution queue. */
export interface AdoptionRow { table: string; ordinal: number; cells: [string, AdoptionCell][]; hash: string }
/** Safe counts and tested identities for UX15 F11/F12; no content, credentials, filesystem paths or private IDs. */
export interface AdoptionReport {
  contract: 's15-state-transition/v1'; sourceRuntime: 's14' | 'legacy'; installationId: string;
  sourceBuild: { commit: string; sha256: string }; targetBuild: { commit: string; sha256: string };
  hostId: string; hostEvidenceHash: string; planHash: string; checkpointHash: string;
  historyRows: number; continuityRows: number; pendingRequests: number; unknownEffects: number;
  privateItems: number; files: number; bytes: number;
  policy: 'empty_requires_owner_install'; importedExecution: 'disabled'; teamConversions: 0;
  refusals: string[];
}
/** A present unfinished stage fences S15. The old-build fence remains until verified rollback/discard completes. */
export type AdoptionState = 'preparing' | 'validated' | 'activating' | 'active_fenced' | 'complete' | 'rolling_back' | 'rolled_back' | 'discarded' | 'blocked';
/** Owner-visible status and exact revision-bound activation/release/rollback decisions. Hashes grant no authority. */
export interface AdoptionStatus {
  contract: 's15-adoption-status/v1'; id: string; revision: number; state: AdoptionState;
  selectedRuntime: 's14' | 'legacy' | 's15'; workers: 'fenced' | 'released'; reason: string | null;
  report: AdoptionReport; actionHash: string | null; releaseHash: string | null; rollbackHash: string;
  policyRevision: number | null; activityRecorded: boolean;
  historyPreserved: true; privateScopePreserved: true; reverseProjection: 'unsupported_after_activity';
}
declare const adoptionOwner: unique symbol;
/** Process-local authenticated owner identity; copying or deserializing this value cannot authenticate. */
export interface AdoptionOwner { readonly [adoptionOwner]: true }
/** Explicit owner request with independent durable idempotency and stale-revision protection. */
export interface AdoptionCommand {
  requestId: string; expectedRevision: number;
  kind: 'prepare' | 'validate' | 'activate' | 'release' | 'rollback' | 'discard';
  hash: string;
}
/** Trusted host API. Keep all control ports outside the guest and provide the policy service only to protected composition. */
export interface AdoptionService {
  authenticate(proof: unknown): AdoptionOwner;
  command(actor: AdoptionOwner, command: AdoptionCommand): AdoptionStatus;
  status(actor: AdoptionOwner): AdoptionStatus | null;
  policy(): S15PolicyService;
  /** Must run before every S15 admission/dispatch, including non-policy consumers. Records activity durably before I/O. */
  guardActivity(): void;
  /** Reserves old request IDs without returning withdrawn outcomes or permitting fresh execution. */
  historicalRequest(actor: AdoptionOwner, requestId: string, payloadHash: string): 'historical_request_no_replay' | null;
  close(): void;
}
/** Authenticator signature shared with POLICY; verify live ingress/generation/CSRF rather than structural owner JSON. */
export type AdoptionAuthenticator = (proof: unknown) => AuthenticatedOwner | null;
