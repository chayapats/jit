import type { JobLimits } from "../jobs/types";
import type { SourceReference } from "../sources";

/** An atomic selected subscription route; the auth reference names configured access and never contains credentials. */
export interface RoleRoute { provider: "grok" | "codex"; model: string; authRoute: string }
/** One owner-configured responsibility, independent of a model, session or execution permission. */
export interface Role {
  id: string; sequence: number; revision: number; name: string; kind: "specialist" | "coordinator";
  responsibility: string; enabled: boolean; route: RoleRoute | null; createdAt: number; updatedAt: number;
}
/** The complete winning route and the revisioned layer that supplied it, without inferred live readiness. */
export interface EffectiveRoleRoute {
  route: RoleRoute | null;
  layer: "project_role" | "project_default" | "owner_role" | "owner_default" | "missing";
  ownerRevision: number; projectRevision: number; roleRevision: number;
  status: "unverified" | "blocked"; nextAction: string;
}
/** Finite service configuration ceilings; these values do not claim measured host or provider capacity. */
export interface TeamPolicy { roleLimit: number; responsibilityBytes: number; sourceLimit: number; contextBytes: number }
/** An opaque independently owned context whose generation is permanently fenced by retirement. */
export interface ManagedContextReference { id: string; generation: number }
/** Explicit provenance and revisions for untrusted retained material, separate from trusted instructions. */
export interface RunSourceManifest {
  sources: readonly { projectId: string; reference: SourceReference; text: string }[];
  claims: readonly { projectId: string; claimId: string; revision: number; generation: number; text: string }[];
}
/** Service-owned read tools that later consumers may select explicitly; preview selects none. */
export type ApplicationReadTool = "project.read" | "source.read" | "memory.read";
/** The immutable scope/configuration and finite authority supplied to one application run invocation. */
export interface ApplicationRunRequest {
  runId: string; projectId: string; topicId: string; roleId: string; purpose: string;
  route: RoleRoute; configuration: { ownerRevision: number; projectRevision: number; roleRevision: number };
  context: ManagedContextReference;
  fence: { jobId: string; generation: number; ownerGeneration: number };
  instructions: { operator: readonly string[]; responsibility: string };
  manifest: RunSourceManifest;
  tools: readonly ApplicationReadTool[];
  policy: { genericExecution: false; arbitraryFetch: false; hostedLookup: false; repositoryDiscovery: false };
  limits: JobLimits;
}
/** Normalized reasons retain incomplete/blocked/cancelled states without raw provider diagnostics or route fallback. */
export type RunReason = "complete" | "unknown_model" | "route_unavailable" | "quota" | "needs_login" | "cancelled"
  | "max_rounds" | "budget_exhausted" | "invalid_result" | "context_retired";
/** Usage reports are finite nonnegative measurements, distinct from permission to spend any resource. */
export interface ApplicationRunUsage {
  calls: number; rounds: number; hops: number; contextTokens: number; outputTokens: number; retries: number; wallMs: number;
}
/** Opaque adapter-owned session identity, never a native file path or provider wire object. */
export interface ApplicationSessionReference { adapter: string; id: string; context: ManagedContextReference }
/** A normalized final result whose evidence mode prevents scripted work from claiming live inference. */
export interface ApplicationRunOutcome {
  state: "complete" | "incomplete" | "blocked" | "error";
  reason: RunReason; mode: "fixture" | "production"; output: string | null;
  usage: ApplicationRunUsage; session: ApplicationSessionReference | null;
}
/** Finite typed observations carry no credential, authorization-changing command or raw SDK event. */
export type ApplicationRunEvent = { kind: "started"; runId: string; context: ManagedContextReference }
  | { kind: "progress"; runId: string; text: string }
  | { kind: "finished"; runId: string; outcome: ApplicationRunOutcome };

/** Owner mutations use shared durable receipts; saving configuration never starts a run. */
export type TeamCommand = {
  kind: "role.save"; requestId: string; projectId: null; expectedRevision: number;
  payload: { roleId: string | null; name: string; kind: Role["kind"]; responsibility: string; enabled: boolean; route: RoleRoute | null };
} | {
  kind: "route.save"; requestId: string; projectId: string | null; expectedRevision: number;
  payload: { roleId: string | null; route: RoleRoute | null };
} | {
  kind: "role.preview"; requestId: string; projectId: string; expectedRevision: number;
  payload: { roleId: string; topicId: string; purpose: string; sources: SourceReference[]; limits: JobLimits };
};
/** A durable fixture run records immutable configuration separately from current effective settings. */
export interface RolePreview {
  id: string; projectId: string; topicId: string; roleId: string; roleName: string; jobId: string;
  request: ApplicationRunRequest; mode: "fixture"; createdAt: number;
  outcome: ApplicationRunOutcome | null; source: SourceReference | null;
}
/** Owner-visible command result is acknowledged only together with its audit and receipt. */
export interface TeamReceipt { revision: number; role?: Role; preview?: RolePreview }
