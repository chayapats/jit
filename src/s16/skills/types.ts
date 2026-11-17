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
export const skillLimits = Object.freeze({ files: 128, fileBytes: 65536, totalBytes: 2 * 1024 * 1024, units: 16, bodyBytes: 32000, dependencies: 16, metadataBytes: 16384, importRequests: 132, importMs: 60000 });
