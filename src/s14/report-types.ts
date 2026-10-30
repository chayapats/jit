import type { MemoryRef } from "./memory-types";
import type { ExternalEvidence } from "./parallel-types";

/** Owner-defined evidence coverage target; absence never lets a model certify the free-text completion rule. */
export interface EvidenceRequirement { id: string; label: string; url: string | null; coverage: ExternalEvidence["coverage"]; freshness: "any" | "live_reported" }
/** Untrusted citation request bound to evidence read by this run or an accessible committed dependency. */
export interface ReportCitation { attemptId: string; id: string; revision: number; quote: string; scope: "snippet" | "excerpt" | "page" }
/** Untrusted bounded claim suggestion; inference and conflict labels cannot grant authority or owner completion. */
export interface ReportClaimProposal { id: string; text: string; kind: "quote" | "inference"; citations: ReportCitation[]; covers: string[]; conflicts: string[] }
/** Untrusted report data validated atomically by the trusted publication handler. */
export interface ReportProposal { title: string; claims: ReportClaimProposal[]; missing: string[]; limitations: string[]; artifactIds: string[] }
/** Supported claim projection retains actual source coverage, freshness and explicit weaknesses. */
export interface ReportClaim extends ReportClaimProposal {
  support: "supported" | "unsupported";
  flags: ("inference" | "snippet" | "excerpt" | "cached_reported" | "freshness_unknown" | "conflicting" | "unsupported")[];
  evidence: ExternalEvidence[];
}
/** Immutable committed report revision; ready for review is independent from coverage and owner completion. */
export interface Report {
  id: string; workId: string; revision: number; attemptId: string; botIds: string[]; createdAt: number;
  state: "ready_for_review"; coverage: "partial" | "covered"; completion: "owner_review_required";
  title: string; claims: ReportClaim[]; covered: string[]; missing: string[]; limitations: string[];
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
export type ReportView = { state: "available"; report: Report; artifacts: Artifact[] } | { state: "unavailable"; id: string; workId: string; revision: number; reason: "lineage_withdrawn" };
