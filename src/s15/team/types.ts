import type { OwnerActor, Ref, S15PolicyService, WorkActor, WorkAuthority } from "../policy";

/** Versioned privacy label; S14 material must retain its exact private Bot owner. */
export type DataScope = { kind: "team" } | { kind: "bot"; botId: string; origin: "s15" | "s14" };
/** Credential-free resource registration, owned by protected configuration, never by model proposals. */
export interface TeamResource extends Ref {
  contract: "s15-team-resource/v1";
  label: string;
  kind: "account" | "browser" | "workspace" | "data";
  scope: DataScope;
  purposes: string[];
  /** Null means the enabled team; an empty array permits no Bots. Denials always win. */
  allowedBots: string[] | null;
  deniedBots: string[];
  operations: ("read" | "write" | "input")[];
  active: boolean;
  /** Protected physical alias identity. All aliases of the same object/session use the same key. */
  coordinationKey: string;
}
/** Provenance is service-observed data, not an instruction or a dispatch permit. */
export interface SourceOrigin { kind: "owner_message" | "work" | "historical"; id: string; conversationId: string | null; at: number }
/** Immutable source bytes with conservative complete ancestry, including uncited generated content. */
export interface TeamSource {
  contract: "s15-team-source/v1"; id: string; text: string; scope: DataScope;
  origin: SourceOrigin; resources: Ref[]; parents: string[];
  producer: { workId: string; bot: Ref; policyRevision: number; ownerGeneration: number };
  active: boolean;
}
declare const contextBrand: unique symbol, leaseBrand: unique symbol;
/** Process-local identity; JSON, source text and stored metadata cannot recreate it. */
export interface TeamContext { readonly [contextBrand]: true }
/** Single original lease identity; copying its metadata never creates dispatch authority. */
export interface TeamLease { readonly [leaseBrand]: true }
/** Protected composition only. The policy service authenticates and guards every actual work actor. */
export interface TeamOptions {
  runtime: "s15"; path: string; create: boolean; installationId: string;
  policy: S15PolicyService; now?: () => number;
  /** Finite cooperative slots, not a new operating-cost allowance. */
  maxConcurrentOperations: number;
  /** Current producer fences, resolved by the owning service; missing evidence withholds descendants. */
  producerCurrent: (producer: TeamSource["producer"]) => boolean;
}
/** Explicit current resource view for protected UI; it contains no credential/profile/session handles. */
export interface TeamResourcesView {
  contract: "s15-team-resources-view/v1";
  resources: (TeamResource & { whoCanUse: "enabled_team" | string[]; restrictions: string[] })[];
}
/** Independent committed sibling evidence survives a missing/failed sibling. */
export interface TeamResult { contract: "s15-team-result/v1"; state: "complete" | "partial" | "blocked"; sources: TeamSource[]; gaps: { botId: string; code: string }[] }
/** Protected actor resolution never accepts a serialized WorkAuthority as authority. */
export type TeamActor = WorkActor;
/** Exported owning-policy types simplify explicit migration/composition without changing their meaning. */
export type { OwnerActor, Ref, WorkAuthority };
