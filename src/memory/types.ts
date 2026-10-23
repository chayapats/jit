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
  status: "active"; createdAt: number;
  decision: MemoryDecisionReference | null;
}
/** Unavailable derived material carries identity and reason, never withdrawn payload. */
export type ClaimLookup = { state: "available"; claim: MemoryClaim; source: SourceLookup }
  | { state: "unavailable"; reference: ClaimReference; reason: string;
      provenance?: Pick<MemoryClaim, "projectId" | "source" | "dependencies" | "conflicts" | "decision"> };
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
  owner: { kind: "discussion" | "synthesis"; id: string };
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
