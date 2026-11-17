/** Immutable provenance. Uploaded origin labels are assertions; their verified pin is the actual file digest. */
export type SkillOrigin = { kind: "github"; repository: string; commit: string; folder: string } | { kind: "upload"; label: string };
/** Inert regular-file bytes; no ambient host path, symlink, executable flag or installation callback is accepted. */
export interface SkillFileInput { path: string; base64: string }
/** One immutable file, retained for license review, resource reading and guarded VM staging. */
export interface SkillFile extends SkillFileInput { sha256: string; bytes: number }
/** Named part that will not be installed or executed by the protected host. */
export interface UnsupportedSkillPart { path: string; code: string }
/** Bounded SKILL.md instruction body; it is know-how, never owner, system or action authority. */
export interface SkillUnit { id: string; path: string; name: string; description: string; body: string; bodyHash: string; license: string | null; userOnly: boolean }
/** A plugin's inert requirement, to be mapped explicitly to an already reviewed Jit connection. */
export interface SkillDependency { key: string; endpoint: string; transport: "streamable-http" }
/** An executable part may run only after review and within an actual work-scoped VM session. */
export interface SkillScript { path: string; runtime: "bash" | "python3" | "node" | "bun" }
/** Complete bounded immutable candidate. No field in an imported file is an execution permission. */
export interface SkillPackage {
  contract: "s16-skill-package/v1"; pin: string; origin: SkillOrigin;
  name: string; description: string; version: string | null; license: string | null; licenseFiles: string[];
  files: SkillFile[]; units: SkillUnit[]; scripts: SkillScript[]; dependencies: SkillDependency[]; unsupported: UnsupportedSkillPart[];
}
/** Independent finite custody and model-input bounds; oversize imports refuse rather than silently dropping files. */
export const skillLimits = Object.freeze({ files: 128, fileBytes: 65536, totalBytes: 2 * 1024 * 1024, units: 16, bodyBytes: 32000, dependencies: 16, metadataBytes: 16384, importRequests: 144, importMs: 60000 });

/** Owner-reviewed existing connection; imports never create or change that connection or its tool decisions. */
export interface SkillDependencyBinding { sourceId: string; catalogHash: string; reviewRevision: number }
/** Availability narrows use of this know-how; it is not a work grant or connection permission. */
export type SkillAvailability = { kind: "team" } | { kind: "bots"; botIds: string[] };
/** Frozen owner review of one exact candidate. */
export interface SkillReview { pin: string; availability: SkillAvailability; executable: boolean; dependencies: Record<string, SkillDependencyBinding>; at: number }
/** Protected current pointers; immutable package bytes and past reviews remain in the owning journal. */
export interface SkillRecord {
  contract: "s16-skill/v1"; id: string; revision: number; ownerGeneration: number; state: "needs_review" | "active" | "revoked";
  activePin: string | null; candidatePin: string | null; review: SkillReview | null;
  resource: import("../../s15/policy").Ref; source: import("../../s15/policy").Ref; createdAt: number; updatedAt: number;
}
/** Guarded CHAT dependency, recorded before imported bytes reach a model or the working computer. */
export interface SkillUse { skillId: string; pin: string; unitId: string | null; resource: import("../../s15/policy").Ref }
/** Inert owner ingress; remote provenance is constructed by the importer, never asserted by a folder upload. */
export type SkillImport = { kind: "github"; url: string } | { kind: "folder"; label: string; files: SkillFileInput[] };
/** Each command has an exact receipt identity. Update discovery never replaces a reviewed pin by itself. */
export type SkillCommand =
  | { contract: "s16-skill-command/v1"; requestId: string; kind: "skill.import"; input: SkillImport }
  | { contract: "s16-skill-command/v1"; requestId: string; kind: "skill.update"; skillId: string; expectedRevision: number; input: SkillImport }
  | { contract: "s16-skill-command/v1"; requestId: string; kind: "skill.review"; skillId: string; expectedRevision: number; pin: string; availability: SkillAvailability; executable: boolean; dependencies: Record<string, SkillDependencyBinding> }
  | { contract: "s16-skill-command/v1"; requestId: string; kind: "skill.availability"; skillId: string; expectedRevision: number; availability: SkillAvailability; executable: boolean }
  | { contract: "s16-skill-command/v1"; requestId: string; kind: "skill.revoke"; skillId: string; expectedRevision: number };
/** A compact durable command result; package contents are obtained through a fresh authenticated detail read. */
export interface SkillReceipt { contract: "s16-skill-receipt/v1"; requestId: string; skillId: string; revision: number; pin: string | null; state: SkillRecord["state"]; policy: "installed" | "review_required" | "not_needed" }

/** A read-only import/review recovery projection; querying it starts no work or network request. */
export type SkillCommandStatus = { contract: "s16-skill-command-status/v1"; requestId: string } & ({ state: "complete"; receipt: SkillReceipt } | { state: "queued" | "importing" | "interrupted" });
