import { AppError } from "../errors";
import { lookupSource, requireId, requireReference, requireText } from "../sources";
import type { AppTransaction } from "../store";
import type { ClaimLookup, ClaimReference, MemoryClaim, MemoryExtraction } from "./types";

/** Rejects malformed or nonpositive claim revisions before any query or model admission. */
export function requireClaimReference(ref: ClaimReference): void {
  requireId(ref?.claimId);
  if (Object.keys(ref).sort().join(",") !== "claimId,generation,revision" ||
      ![ref.revision, ref.generation].every(n => Number.isSafeInteger(n) && n > 0)) throw new AppError("invalid_claim_reference");
}
function unique(refs: ClaimReference[]): ClaimReference[] {
  return [...new Map(refs.map(ref => [`${ref.claimId}:${ref.revision}:${ref.generation}`, ref])).values()];
}
function resolve(tx: AppTransaction, projectId: string, reference: ClaimReference, seen: Set<string>, depth: number, budget: { remaining: number }): ClaimLookup {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE project_id = ? AND id = ? AND revision = ? AND generation = ?", projectId, reference.claimId, reference.revision, reference.generation);
  const claim = row ? JSON.parse(row.record_json) as MemoryClaim : null;
  const unavailable = (reason: string): ClaimLookup => ({ state: "unavailable", reference, reason,
    ...(claim ? { provenance: { projectId: claim.projectId, source: claim.source, dependencies: claim.dependencies, conflicts: claim.conflicts, decision: claim.decision } } : {}) });
  if (--budget.remaining < 0 || depth > 8 || seen.has(reference.claimId)) return unavailable("lineage_limit");
  if (!claim) return unavailable("claim_unavailable");
  if (claim.status === "deleted" || deletedClaim(tx, claim.claimId)) return unavailable("claim_deleted");
  if (claim.status === "forgotten" || suppressedClaim(tx, claim.claimId)) return unavailable("claim_forgotten");
  if (claim.status === "corrected") return unavailable("claim_corrected");
  if (claim.status !== "active") return unavailable("claim_inactive");
  if (deletedSource(tx, claim.source)) return unavailable("source_deleted");
  if (suppressedSource(tx, claim.source)) return unavailable("source_suppressed");
  const source = lookupSource(tx, projectId, claim.source);
  if (source.state !== "available" || source.current.revision !== claim.source.revision) return unavailable("source_unavailable");
  const next = new Set(seen).add(reference.claimId);
  for (const dependency of unique([...claim.dependencies, ...claim.conflicts])) {
    if (resolve(tx, projectId, dependency, next, depth + 1, budget).state !== "available") return unavailable("dependency_unavailable");
  }
  return { state: "available", claim, source };
}

/** app.memory_active_generation/v1: all consumers resolve lineage here; no raw transcript/index read grants active memory. */
export function lookupActiveClaim(tx: AppTransaction, projectId: string, ref: ClaimReference): ClaimLookup {
  requireId(projectId); requireClaimReference(ref);
  return resolve(tx, projectId, ref, new Set(), 0, { remaining: 64 });
}

/** Checks prospective children with the new root's depth/node cost, before a claim can be published as readable. */
export function canExtendMemoryLineage(tx: AppTransaction, projectId: string, references: ClaimReference[]): boolean {
  requireId(projectId); references.forEach(requireClaimReference);
  const budget = { remaining: 63 };
  return unique(references).every(ref => resolve(tx, projectId, ref, new Set(), 1, budget).state === "available");
}

/** Bounded offline memory inspection with current availability; every returned payload passed the active-generation query. */
export function readMemory(tx: AppTransaction, projectId: string, after: number, limit: number, query = "") {
  requireId(projectId);
  if (!Number.isSafeInteger(after) || after < 0 || after > 1000000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new AppError("invalid_cursor");
  if (query !== "") requireText(query, 200);
  const rows = tx.all<{ sequence: number; id: string; revision: number; generation: number }>("SELECT sequence, id, revision, generation FROM memory_claims WHERE project_id = ? AND sequence > ? AND instr(lower(json_extract(record_json, '$.text')), lower(?)) > 0 ORDER BY sequence LIMIT ?", projectId, after, query, limit + 1);
  const items = rows.slice(0, limit).map(row => ({ sequence: row.sequence, ...lookupActiveClaim(tx, projectId, { claimId: row.id, revision: row.revision, generation: row.generation }) }));
  return { items, hasMore: rows.length > limit, nextAfter: rows.length > limit ? rows[limit - 1]!.sequence : null };
}

/** Reads one logical extraction without dispatching/replaying work. */
export function readExtraction(tx: AppTransaction, projectId: string, id: string): MemoryExtraction {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM memory_extractions WHERE project_id = ? AND id = ?", projectId, id);
  if (!row) throw new AppError("extraction_not_found", 404);
  return JSON.parse(row.record_json) as MemoryExtraction;
}

/** Tests a committed exact source for extraction eligibility; memory results are never inserted as sources. */
export function eligibleMemorySource(tx: AppTransaction, projectId: string, reference: import("../sources").SourceReference) {
  requireReference(reference);
  const source = lookupSource(tx, projectId, reference);
  if (source.state !== "available" || source.current.revision !== reference.revision || source.descriptor.kind === "external") throw new AppError("memory_source_unavailable", 409);
  if (deletedSource(tx, reference)) throw new AppError("memory_source_deleted", 409);
  if (suppressedSource(tx, reference)) throw new AppError("memory_source_suppressed", 409);
  if (memoryDerivation(tx, projectId, reference.sourceId) > 0) throw new AppError("memory_source_derived", 409);
  return source;
}

/** Generation-fenced suppression: this exact source lineage must never feed automatic memory again. */
export function suppressedSource(tx: AppTransaction, reference: import("../sources").SourceReference): boolean {
  requireReference(reference);
  return !!tx.get("SELECT 1 FROM memory_suppressed_sources WHERE source_id = ? AND revision = ? AND generation = ?",
    reference.sourceId, reference.revision, reference.generation);
}

/** Whether this claim identity was withdrawn by an owner forget; payload stays out of the ledger. */
export function suppressedClaim(tx: AppTransaction, claimId: string): boolean {
  requireId(claimId);
  return !!tx.get("SELECT 1 FROM memory_suppressed_claims WHERE claim_id = ?", claimId);
}

/** Whether this exact source lineage was deleted; payload is never stored in the ledger. */
export function deletedSource(tx: AppTransaction, reference: import("../sources").SourceReference): boolean {
  requireReference(reference);
  try {
    return !!tx.get("SELECT 1 FROM deletion_ledger WHERE kind = 'source' AND source_id = ? AND revision = ? AND generation = ?",
      reference.sourceId, reference.revision, reference.generation);
  } catch { return false; }
}

/** Whether this claim identity was deleted; payload stays out of the ledger. */
export function deletedClaim(tx: AppTransaction, claimId: string): boolean {
  requireId(claimId);
  try {
    return !!tx.get("SELECT 1 FROM deletion_ledger WHERE kind = 'claim' AND claim_id = ?", claimId);
  } catch { return false; }
}

/** app.context_provenance/v1 loop depth: 0 for owner/raw sources, >0 for outputs produced with memory in context. */
export function memoryDerivation(tx: AppTransaction, projectId: string, sourceId: string): number {
  return tx.get<{ depth: number }>("SELECT depth FROM memory_derived_sources WHERE project_id = ? AND source_id = ?", projectId, sourceId)?.depth ?? 0;
}
