import type { DataScope, OwnerActor, Ref, SourceOrigin, TeamContext, TeamService, WorkAuthority } from "../team";
import type { FileSourcePin } from "../file-lineage";
/** Claim classification is distinct from evidence status; no memory classification grants authority. */
export interface MemoryCandidate { kind: "fact" | "inference"; category: "fact" | "preference" | "working_knowledge"; text: string; quote: string }
/** Provenance-preserving future interoperability seam. It is data only; no Jod transport/import is implemented. */
export interface MemoryProvenance { origin: SourceOrigin; scope: DataScope; resources: Ref[]; teamSourceId: string | null; sourceHash: string; filePins?: FileSourcePin[] }
/** Version-one retained assertion. A fact records a statement/observation, never an authenticated decision. */
export interface MemoryClaim extends MemoryCandidate {
  contract: "s15-memory-claim/v1"; id: string; revision: number; sourceId: string;
  provenance: MemoryProvenance; createdAt: number;
  lifecycle: "active" | "superseded" | "forgotten";
  confirmation: "owner_stated" | "observed" | "unconfirmed";
  supersedes: string | null; correction: string | null;
  /** Trusted context supplies every dependency, including uncited generated text. */
  dependencies: string[];
  authority: "none";
}
/** Exact revision commands are authenticated through the protected owner HTTP/session adapter. */
export type MemoryCommand =
  | { contract: "s15-memory-command/v1"; requestId: string; kind: "memory.correct"; claim: { id: string; revision: number }; text: string }
  | { contract: "s15-memory-command/v1"; requestId: string; kind: "memory.forget" | "memory.impact"; claim: { id: string; revision: number } };
/** Counts describe retained application lineage; previously seen remote/model bytes cannot be recalled. */
export interface ForgetImpact { claims: number; sources: number; summaries: number; artifacts: number; contexts: number; nativeSessions: number; workItems: number }
/** Read-only owner source status is separate from per-work retrieval eligibility. */
export interface MemoryClaimView extends MemoryClaim { sourceState: "current" | "withdrawn" }
/** JSON owner inspection contains lifecycle/provenance even when forgotten text has been removed. */
export interface MemoryView { contract: "s15-memory-view/v1"; claims: MemoryClaimView[]; nativePolicy: "fresh_sessions_retire_on_close" }
/** Every derivative conservatively retains the complete original context lineage, regardless of citations. */
export interface MemoryDerivative { id: string; kind: "context" | "native" | "summary" | "artifact" | "work"; claimIds: string[]; sourceIds: string[]; state: "active" | "retired"; text: string | null; workId: string | null; filePins?: FileSourcePin[] }
/** Fresh bounded data packet; private/revoked claims are filtered before relevance selection. */
export interface MemoryPacket { id: string; claims: MemoryClaim[]; section: string; retained: { id: string; kind: MemoryClaim["kind"]; category: MemoryClaim["category"]; source: SourceOrigin }[] }
/** Protected composition controls retention scope. Absence of current approval disables retention. */
export interface MemoryOptions {
  runtime: "s15"; path: string; create: boolean; installationId: string; team: TeamService;
  retention: (authority: WorkAuthority) => DataScope | null;
  now?: () => number;
}
/** Original trusted ingress/observation; candidates are untrusted extraction proposals grounded in its bytes. */
export interface MemoryInput { id: string; text: string; origin: SourceOrigin; scope: DataScope; resources: Ref[]; parents: string[]; filePins?: FileSourcePin[] }
/** Generic protected data API seam used by CHAT; memory receives no policy installation/approval method. */
export interface MemoryOwnerApi<Actor = OwnerActor> { view(actor: Actor): MemoryView; command(actor: Actor, input: unknown): unknown }
export type { OwnerActor, TeamContext };
