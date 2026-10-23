import type { JobLimits } from "../jobs/types";
import type { SourceLookup, SourceReference } from "../sources";
import type { ApplicationRunRequest } from "../team/types";

/** Exact immutable derived-memory identity; it never identifies a task or owner decision. */
export interface ClaimReference { claimId: string; revision: number; generation: number }
/** An exact owner decision record; current authority remains in the decision/continuity query. */
export interface MemoryDecisionReference { kind: "owner_decision"; id: string; revision: number; topicId: string }
/** A retained assertion with evidence; explicit_fact means only that the owner stated the quoted text. */
export interface MemoryClaim extends ClaimReference {
  projectId: string; extractionId: string; kind: "explicit_fact" | "inference"; text: string;
  source: SourceReference; quote: string; dependencies: ClaimReference[]; conflicts: ClaimReference[];
  status: "active" | "corrected" | "forgotten"; createdAt: number;
  decision: MemoryDecisionReference | null;
  /** Set once by app.memory_correction/v1; points at the owner-approved replacement claim. */
  correctionId?: string; replacement?: ClaimReference;
}
/** Unavailable derived material carries identity and reason, never withdrawn payload. */
export type ClaimLookup = { state: "available"; claim: MemoryClaim; source: SourceLookup }
  | { state: "unavailable"; reference: ClaimReference; reason: string;
      provenance?: Pick<MemoryClaim, "projectId" | "source" | "dependencies" | "conflicts" | "decision"> };
/** One explicit owner authorization to correct one exact claim revision with an approved replacement. */
export interface CorrectMemoryCommand {
  kind: "memory.correct"; requestId: string; projectId: string; expectedRevision: number;
  payload: { claim: ClaimReference; text: string; quote: string; source: SourceReference; reason: string };
}
/** Durable owner-approved correction; the replacement is an ordinary claim whose lineage is this record. */
export interface MemoryCorrection {
  id: string; projectId: string; claimId: string; fromRevision: number; fromGeneration: number;
  replacement: ClaimReference; correction: SourceReference; quote: string; reason: string;
  ownerRevision: number; projectRevision: number; createdAt: number;
}
/** Inspector preview: what one correction would fence or retire before the owner confirms. */
export interface CorrectionImpact {
  claim: ClaimLookup;
  correction: MemoryCorrection | null;
  dependents: { projectId: string; reference: ClaimReference; text: string | null }[];
  contexts: { id: string; projectId: string; ownerKind: string; ownerId: string }[];
  pendingJobs: { id: string; projectId: string }[];
  /** True per category when the preview list was capped; counts below are then lower bounds. */
  truncated: { dependents: boolean; contexts: boolean; pendingJobs: boolean };
  note: string;
}
/** Owner-approved correction result; the replacement is readable through the ordinary claim query. */
export interface CorrectionReceipt { correction: MemoryCorrection; replacement: ClaimReference }
/** One explicit owner authorization to forget one exact claim revision with acknowledged scope.
 *  Forgetting never cancels tasks, never withdraws decisions and never deletes raw sources. */
export interface ForgetMemoryCommand {
  kind: "memory.forget"; requestId: string; projectId: string; expectedRevision: number;
  payload: { claim: ClaimReference; reason: string; acknowledged: boolean };
}
/** One withdrawn claim identity bound to its suppression checkpoint; payload is never stored here. */
export interface SuppressedClaimIdentity { projectId: string; claimId: string; revision: number; generation: number }
/** One old source lineage bound to a suppression checkpoint; raw history stays manually readable. */
export interface SuppressedSourceIdentity { projectId: string; source: SourceReference }
/** One native context generation covered by a suppression checkpoint for run_port retirement. */
export interface SuppressedContextIdentity { id: string; generation: number }
/** Durable owner-approved forget; the receipt of app.memory_suppression/v1. */
export interface MemorySuppression {
  id: string; projectId: string; claimId: string; fromRevision: number; fromGeneration: number;
  withdrawn: SuppressedClaimIdentity[]; sources: SuppressedSourceIdentity[]; contexts: SuppressedContextIdentity[];
  overlaps: { kind: "task" | "decision"; id: string; title: string }[];
  reason: string; acknowledged: boolean;
  ownerRevision: number; projectRevision: number; createdAt: number;
}
/** Inspector preview: what one forget would withdraw or retire before the owner confirms. */
export interface SuppressionImpact {
  claim: ClaimLookup;
  suppression: MemorySuppression | null;
  dependents: { projectId: string; reference: ClaimReference; text: string | null }[];
  /** Sibling claims from the same exact source that the conservative source granularity also withdraws. */
  siblings: { projectId: string; reference: ClaimReference }[];
  contexts: { id: string; generation: number; projectId: string; ownerKind: string; ownerId: string }[];
  pendingJobs: { id: string; projectId: string }[];
  overlaps: { kind: "task" | "decision"; id: string; title: string }[];
  note: string;
}
/** app.suppression_ledger/v1: the durable checkpoint with live retirement status per covered context. */
export interface SuppressionLedger {
  suppression: MemorySuppression;
  retire: { state: "complete" | "incomplete"; contexts: (SuppressedContextIdentity & { appState: string; lifecycle: string })[] };
  note: string;
}
/** Owner-approved forget result; retirement completes later through the run_port reconcile lifecycle. */
export interface SuppressionReceipt { suppression: MemorySuppression; withdrawn: SuppressedClaimIdentity[] }
/** One explicit owner authorization to extract one committed source under the fixed extractor/policy v1. */
export interface ExtractMemoryCommand {
  kind: "memory.extract"; requestId: string; projectId: string; expectedRevision: number;
  payload: { topicId: string; roleId: string; source: SourceReference; dependencies: ClaimReference[]; limits: JobLimits };
}
/** Durable logical extraction, separate from its bounded attempts and from canonical conversation sources. */
export interface MemoryExtraction {
  id: string; projectId: string; jobId: string; extractor: "claims/v1"; policy: 1;
  request: ApplicationRunRequest; source: SourceReference; dependencies: ClaimReference[];
  state: "queued" | "complete" | "partial" | "failed"; reason: string;
  claimIds: string[]; rejected: number; createdAt: number; mode: "fixture";
}
/** Logical dedupe can return an earlier extraction even under a fresh owner request ID. */
export interface MemoryReceipt { extraction: Omit<MemoryExtraction, "request">; duplicate: boolean }

/** app.context_provenance/v1 entry: one exact item a run was allowed to use, with the layer it occupied. */
export interface ContextProvenanceEntry {
  layer: "project_constraint" | "explicit_preference" | "source_evidence" | "inference";
  scope: "project" | "cross_project";
  kind: "task" | "decision" | "source" | "claim";
  /** Origin project; cross_project entries keep the project that owns them. */
  projectId: string; id: string; revision: number;
  /** Source or claim generation; tasks and decisions have revisions only. */
  generation: number | null;
  /** Task state, `current` decision, `available` source, or `active` claim at assembly. */
  status: string;
  claimKind: MemoryClaim["kind"] | null; topicId: string | null;
  source: SourceReference | null; conflicts: ClaimReference[]; score: number | null;
}
/** A recorded contradiction; both sides stay separate and become an owner question. */
export interface ContextConflict { claim: ClaimReference & { projectId: string }; with: ClaimReference; included: boolean }
/** app.context_provenance/v1 immutable run source manifest that later lifecycle work can fence or retire. */
export interface MemoryContextRecord {
  id: string; contract: "app.memory_context/v1"; projectId: string; topicId: string;
  owner: { kind: "discussion" | "synthesis" | "schedule"; id: string };
  policy: {
    version: 1; constraints: number; claims: number; crossProject: number; window: number;
    bytes: number; constraintBytes: number; derivedDepth: number;
  };
  purpose: string; entries: ContextProvenanceEntry[]; conflicts: ContextConflict[];
  omitted: { constraints: number; claims: number; unavailable: number; budget: boolean; loopGuard: boolean };
  snapshot: { assembledAt: number; ownerGeneration: number; projectRevision: number };
  derivation: { inputDepth: number; claimsUsed: number };
  /** False when a finite ceiling dropped constraints/claims or the loop guard withheld memory. */
  complete: boolean;
}
/** Inspect projection: recorded entries with current lifecycle status; withdrawn payload is never returned. */
export interface MemoryContextView {
  record: Omit<MemoryContextRecord, "entries">;
  current: boolean;
  entries: (ContextProvenanceEntry & { current: boolean; reason: string | null; text: string | null })[];
}
