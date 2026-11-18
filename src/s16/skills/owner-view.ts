import { AppError } from "../../errors";
import type { SkillDirectory } from "./service";
import { skillLimits, type SkillFile, type SkillPackage, type SkillRecord, type SkillUnit } from "./types";

/** Authenticated preview omits raw file/body bytes. Each file has a separate bounded owner read. */
export type SkillPackagePreview = Omit<SkillPackage, "files" | "units"> & { files: Omit<SkillFile, "base64">[]; units: Omit<SkillUnit, "body">[] };
export interface SkillDetail { contract: "s16-client-skill/v1"; record: SkillRecord; active: SkillPackagePreview | null; candidate: SkillPackagePreview | null; releasedCopies: number }
export interface SkillsView {
  contract: "s16-client-skills/v1"; limits: typeof skillLimits;
  items: { record: SkillRecord; name: string; description: string }[];
  bots: { id: string; name: string }[];
  dependencies: { id: string; label: string; endpoint: string; state: string; catalogHash: string | null; reviewRevision: number | null }[];
}
const preview = (pkg: SkillPackage | null): SkillPackagePreview | null => pkg ? { ...pkg, units: pkg.units.map(({ body: _body, ...unit }) => unit), files: pkg.files.map(({ base64: _base64, ...file }) => file) } : null;
/** Fresh protected owner read. It does not resume a command, open a connection or run code. */
export function skillsView<Owner>(directory: SkillDirectory<Owner>, owner: Owner, dependencies: SkillsView["dependencies"]): SkillsView {
  directory.options.requireOwner(owner);
  return { contract: "s16-client-skills/v1", limits: { ...skillLimits }, items: directory.records().filter(record => record.ownerGeneration === directory.options.ownerGeneration()).map(record => { const pkg = directory.package((record.activePin ?? record.candidatePin)!); return { record, name: pkg.name, description: pkg.description }; }), bots: [...directory.options.bots(owner)], dependencies };
}
/** Current exact pin/parts/license inventory; imported bytes stay inert and render only as text. */
export function skillDetail<Owner>(directory: SkillDirectory<Owner>, owner: Owner, id: string): SkillDetail {
  const detail = directory.detail(owner, id); return { contract: "s16-client-skill/v1", record: detail.record, active: preview(detail.active), candidate: preview(detail.candidate), releasedCopies: directory.copies().filter(copy => copy.skillId === id).length };
}
/** Bounded selected-file owner preview. No ambient path or guessed pin can select another package's bytes. */
export function skillFile<Owner>(directory: SkillDirectory<Owner>, owner: Owner, id: string, pin: string, path: string): SkillFile {
  const detail = directory.detail(owner, id), pkg = [detail.active, detail.candidate].find(pkg => pkg?.pin === pin), file = pkg?.files.find(file => file.path === path);
  if (!file) throw new AppError("not_found", 404); return file;
}
