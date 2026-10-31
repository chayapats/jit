import type { MemoryRef } from "./memory-types";
import type { WorkStep } from "./graph-types";
import type { ExternalEvidence, WebRead } from "./parallel-types";
import type { Envelope } from "./types";
import type { PersonalReportEvidence } from "./personal-types";

/** Actually-read public or account-private evidence; provider and tool identities stay distinct. */
export type ReportEvidence = ExternalEvidence | PersonalReportEvidence;

/** Owner-defined evidence coverage target; absence never lets a model certify the free-text completion rule. */
export interface EvidenceRequirement { id: string; label: string; url: string | null; coverage: ExternalEvidence["coverage"]; freshness: "any" | "live_reported" }
/** Untrusted citation request bound to evidence read by this run or an accessible committed dependency. */
export interface ReportCitation { attemptId: string; id: string; revision: number; quote: string; scope: "snippet" | "excerpt" | "page" }
/** Untrusted bounded claim suggestion; covers declares Bot intent, never validated per-claim coverage or owner completion. */
export interface ReportClaimProposal { id: string; text: string; kind: "quote" | "inference"; citations: ReportCitation[]; covers: string[]; conflicts: string[] }
/** Untrusted report data validated atomically by the trusted publication handler. */
export interface ReportProposal { title: string; claims: ReportClaimProposal[]; missing: string[]; limitations: string[]; artifactIds: string[] }
/** Supported claim projection retains actual source coverage, freshness and explicit weaknesses. */
export interface ReportClaim extends ReportClaimProposal {
  support: "supported" | "unsupported";
  flags: ("inference" | "snippet" | "excerpt" | "cached_reported" | "freshness_unknown" | "conflicting" | "unsupported")[];
  evidence: ReportEvidence[];
}
/** Service-observed gaps; model prose can never create one of these facts. */
export type ReportGap =
  | { kind: "completion_rule_not_machine_verified" }
  | { kind: "required_evidence"; targetId: string }
  | { kind: "unsupported_claim" | "conflicting_claim"; claimId: string }
  | { kind: "step"; stepId: string; state: WorkStep["state"] }
  | { kind: "handoff"; stepId: string; reason: string }
  | { kind: "read"; readId: string; outcome: WebRead["outcome"]; personal?: { scopeId: string; stale: boolean; missing: string[] } }
  | { kind: "missing_url"; url: string }
  | { kind: "failed_url"; url: string; failureKind: string };
/** Immutable owner acceptance evidence, bound to one report revision rather than its coverage. */
export interface ReportAcceptance { reportId: string; reportRevision: number; ownerGeneration: number; requestId: string; acceptedAt: number }
/** Revisioned current review target; publishing a new revision or withdrawing lineage invalidates acceptance. */
export interface ReportReview {
  workId: string; revision: number; reportId: string | null; reportRevision: number | null;
  completion: "owner_review_required" | "owner_accepted"; acceptance: ReportAcceptance | null;
}
/** Accepts the exact latest available report; expectedRevision is the current ReportReview revision. */
export type ReportCommand = Envelope<"report.review.accept", { reportId: string; reportRevision: number }>;
/** Bounded review receipt carries no report body and grants no execution or coverage. */
export interface ReportReceipt { kind: ReportCommand["kind"]; requestId: string; conversationId: string; review: ReportReview }
/** Immutable committed report revision; ready for review is independent from coverage and owner completion. */
export interface Report {
  id: string; workId: string; revision: number; attemptId: string; botIds: string[]; createdAt: number;
  state: "ready_for_review"; coverage: "partial" | "covered";
  title: string; claims: ReportClaim[]; covered: string[]; missing: ReportGap[]; modelMissing: string[]; limitations: string[];
  source: MemoryRef; artifactIds: string[];
}
/** Bounded immutable delivered file metadata; download identity contains no path or execution handle. */
export interface Artifact {
  id: string; reportId: string; workId: string; attemptId: string; name: string;
  mediaType: "text/markdown" | "text/plain" | "application/json"; size: number; sha256: string;
  source: MemoryRef; createdAt: number;
}
/** Exact bounded workspace snapshot request; paths remain confined to the producing Bot backend. */
export interface ArtifactRequest { path: string; name: string; mediaType: Artifact["mediaType"]; size: number; sha256: string }
/** Private staged snapshot metadata; staging does not make a report or downloadable artifact. */
export interface StagedArtifact extends Omit<Artifact, "reportId"> {}
/** Owner projection withholds withdrawn payload and keeps stable revision identities. */
export type ReportView = { state: "available"; report: Report; completion: ReportReview["completion"]; acceptance: ReportAcceptance | null; artifacts: Artifact[] } | { state: "unavailable"; id: string; workId: string; revision: number; reason: "lineage_withdrawn" };
