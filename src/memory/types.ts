import type { JobLimits } from "../jobs/types";
import type { SourceLookup, SourceReference } from "../sources";
import type { ApplicationRunRequest } from "../team/types";

/** Exact immutable derived-memory identity; it never identifies a task or owner decision. */
export interface ClaimReference { claimId: string; revision: number; generation: number }
/** A retained assertion with evidence; explicit_fact means only that the owner stated the quoted text. */
export interface MemoryClaim extends ClaimReference {
  projectId: string; extractionId: string; kind: "explicit_fact" | "inference"; text: string;
  source: SourceReference; quote: string; dependencies: ClaimReference[]; conflicts: ClaimReference[];
  status: "active"; createdAt: number;
}
/** Unavailable derived material carries identity and reason, never withdrawn payload. */
export type ClaimLookup = { state: "available"; claim: MemoryClaim; source: SourceLookup }
  | { state: "unavailable"; reference: ClaimReference; reason: string };
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
