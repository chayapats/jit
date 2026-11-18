import { AppError } from "../errors";
import { canonical, ref } from "./policy/validation";
import type { Ref, WorkActor, WorkAuthority } from "./policy";

/** Protected DATA15 descendant metadata. Selection and privacy inspection perform no release;
 * only the final actual byte handoff inherits the recorded source restrictions. */
export interface DataLineagePort {
  inspect(work: WorkAuthority, descendants: readonly Ref[], history?: boolean): { private: boolean };
  release(actor: WorkActor, descendants: readonly Ref[]): void;
}
/** Canonical bounded union; a repeated descendant is data, never another grant or source registration. */
export function dataRefs(...sets: (readonly Ref[] | undefined)[]): Ref[] {
  const result = new Map<string, Ref>();
  for (const set of sets) for (const value of set ?? []) { ref(value); result.set(canonical(value), structuredClone(value)); }
  if (result.size > 64) throw new AppError("lineage_capacity", 409);
  return [...result].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
}
