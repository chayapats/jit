import { AppError } from "../errors";
import { canonical, exact } from "./conversation/validation";
import { ref } from "./policy/validation";
import type { Ref, WorkAuthority } from "./policy";

/** Exact immutable original/representation ancestry. Metadata cannot authenticate a reader or grant work. */
export interface FileSourcePin {
  contract: "s16-file-source/v1"; source: Ref; resource: Ref; sha256: string; representationSha256: string | null;
}
/** Owning-store facts and final selected-byte verification, never supplied by a model or serialized actor. */
export interface FileLineagePort {
  current(pins: readonly FileSourcePin[]): boolean;
  verify(work: WorkAuthority, pins: readonly FileSourcePin[]): void;
}
/** Closed finite union; two generations/hashes of one original cannot be silently substituted. */
export function filePins(...groups: (readonly FileSourcePin[] | undefined)[]): FileSourcePin[] {
  const found = new Map<string, FileSourcePin>();
  for (const group of groups) {
    if (group === undefined) continue;
    if (!Array.isArray(group) || group.length > 128) throw new AppError("invalid_file_lineage");
    for (const raw of group) {
      exact(raw, ["contract", "source", "resource", "sha256", "representationSha256"]); const pin = raw as unknown as FileSourcePin; ref(pin.source); ref(pin.resource);
      if (pin.contract !== "s16-file-source/v1" || typeof pin.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pin.sha256) || pin.representationSha256 !== null && (typeof pin.representationSha256 !== "string" || !/^[a-f0-9]{64}$/.test(pin.representationSha256))) throw new AppError("invalid_file_lineage");
      const before = found.get(pin.source.id);
      if (before && canonical(before) !== canonical(pin)) throw new AppError("lineage_withdrawn", 409);
      found.set(pin.source.id, structuredClone(pin));
      if (found.size > 128) throw new AppError("output_limit");
    }
  }
  return [...found.values()];
}
