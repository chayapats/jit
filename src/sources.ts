import { AppError } from "./errors";
import type { AppTransaction } from "./store";

/** Identifies one immutable source version within its content-lifecycle generation. */
export interface SourceReference { sourceId: string; revision: number; generation: number }
/** Attributes content to a verified ingress identity or a trusted service producer, never its text. */
export type Attribution = { kind: "owner"; ownerId: "owner" }
  | { kind: "participant"; participantId: string; runId: string }
  | { kind: "service"; service: "source-registry" | "jit-setup" };
/** Describes application data or an external identity without provider wire objects or fetch authority. */
export type SourceDescriptor = { kind: "topic"; topicId: string }
  | { kind: "message"; topicId: string; messageId: string }
  | { kind: "output" }
  | { kind: "external"; system: string; resourceType: string; resourceId: string; revisionHint?: string };
/** Reports the current registry pointer independently from an immutable requested reference. */
export interface SourceCurrent {
  revision: number; generation: number; kind: SourceDescriptor["kind"]; availability: "available" | "unavailable";
}
/** Returns exact committed content or an explicit unavailable result without guessing or fetching. */
export type SourceLookup = {
  state: "available"; projectId: string; reference: SourceReference; current: SourceCurrent;
  descriptor: SourceDescriptor; attribution: Attribution; committedAt: number; text: string;
} | {
  state: "unavailable"; projectId: string; reference: SourceReference; current: SourceCurrent | null;
  reason: "source_not_found" | "generation_unavailable" | "revision_unavailable" | "source_unavailable" | "external_not_imported";
  descriptor?: Extract<SourceDescriptor, { kind: "external" }>;
};

/** Rejects malformed identities before they enter scoped application commands or references. */
export function requireId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) {
    throw new AppError("invalid_identity");
  }
}
/** Validates bounded, well-formed Unicode without normalizing or interpreting its contents. */
export function requireText(value: unknown, maximumBytes: number): asserts value is string {
  if (typeof value !== "string" || value.length > maximumBytes || !value.isWellFormed() ||
      Buffer.byteLength(value) > maximumBytes) throw new AppError("text_too_large_or_invalid", 413);
  if (!value.trim()) throw new AppError("empty_text");
}
/** Checks exact source identity and positive revision/generation values. */
export function requireReference(reference: SourceReference): void {
  requireId(reference?.sourceId);
  if (![reference.revision, reference.generation].every(n => Number.isSafeInteger(n) && n > 0)) throw new AppError("invalid_source_reference");
}

function insert(tx: AppTransaction, projectId: string, descriptor: SourceDescriptor, attribution: Attribution,
  text: string | null, committedAt: number): SourceReference {
  requireId(projectId);
  if (!Number.isSafeInteger(committedAt) || committedAt < 0) throw new AppError("invalid_commit_time");
  const reference: SourceReference = { sourceId: crypto.randomUUID(), revision: 1, generation: 1 };
  tx.run("INSERT INTO sources VALUES (?, ?, ?, 1, 1, ?)", reference.sourceId, projectId, descriptor.kind,
    text === null ? "unavailable" : "available");
  tx.run("INSERT INTO source_versions VALUES (?, 1, 1, ?, ?, ?, ?)", reference.sourceId,
    JSON.stringify(descriptor), JSON.stringify(attribution), text, committedAt);
  return reference;
}

/** Stores an owner source only inside the caller's already-authorized command transaction. */
export function commitOwnerSource(tx: AppTransaction, input: {
  projectId: string; descriptor: Extract<SourceDescriptor, { kind: "topic" | "message" }>; text: string; committedAt: number;
}): SourceReference {
  requireText(input.text, 65536);
  requireId(input.descriptor.topicId);
  if (input.descriptor.kind === "message") requireId(input.descriptor.messageId);
  return insert(tx, input.projectId, input.descriptor, { kind: "owner", ownerId: "owner" }, input.text, input.committedAt);
}

/** Stores a committed output inside a trusted producer transaction with verified participant/run references. */
export function commitOutputSource(tx: AppTransaction, input: {
  projectId: string; participantId: string; runId: string; text: string; committedAt: number;
}): SourceReference {
  requireText(input.text, 65536);
  for (const id of [input.participantId, input.runId]) {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(id)) throw new AppError("invalid_producer_reference");
  }
  return insert(tx, input.projectId, { kind: "output" },
    { kind: "participant", participantId: input.participantId, runId: input.runId }, input.text, input.committedAt);
}

/**
 * Stores fixed service-authored text (app.setup/v1 greeting) inside the caller's owner command transaction.
 * It is product text built from owner configuration, never model output, so it carries service attribution.
 */
export function commitServiceOutput(tx: AppTransaction, input: { projectId: string; service: "jit-setup"; text: string; committedAt: number }): SourceReference {
  requireText(input.text, 65536);
  if (input.service !== "jit-setup") throw new AppError("invalid_producer_reference");
  return insert(tx, input.projectId, { kind: "output" }, { kind: "service", service: input.service }, input.text, input.committedAt);
}

/** Registers only an external descriptor in a trusted service transaction; no content or access is inferred. */
export function registerExternalSource(tx: AppTransaction, input: {
  projectId: string; descriptor: Extract<SourceDescriptor, { kind: "external" }>; committedAt: number;
}): SourceReference {
  const descriptor = input.descriptor;
  if (!descriptor || descriptor.kind !== "external" || Object.keys(descriptor).some(key =>
    !["kind", "system", "resourceType", "resourceId", "revisionHint"].includes(key))) throw new AppError("invalid_source_descriptor");
  for (const value of [descriptor.system, descriptor.resourceType, descriptor.resourceId]) requireText(value, 512);
  if (descriptor.revisionHint !== undefined) requireText(descriptor.revisionHint, 512);
  return insert(tx, input.projectId, descriptor, { kind: "service", service: "source-registry" }, null, input.committedAt);
}

/** Reads one exact version under a caller-authorized project scope without materializing external content. */
export function lookupSource(tx: AppTransaction, projectId: string, reference: SourceReference): SourceLookup {
  requireId(projectId); requireReference(reference);
  const row = tx.get<{ revision: number; generation: number; kind: SourceDescriptor["kind"]; availability: "available" | "unavailable" }>(
    "SELECT current_revision AS revision, generation, kind, availability FROM sources WHERE id = ? AND project_id = ?",
    reference.sourceId, projectId);
  const unavailable = (reason: Extract<SourceLookup, { state: "unavailable" }>["reason"]): SourceLookup =>
    ({ state: "unavailable", projectId, reference: { ...reference }, current: row ? { ...row } : null, reason });
  if (!row) return unavailable("source_not_found");
  if (row.generation !== reference.generation) return unavailable("generation_unavailable");
  const version = tx.get<{ descriptor: string; attribution: string; text: string | null; committedAt: number }>(
    `SELECT descriptor_json AS descriptor, attribution_json AS attribution, content_text AS text, committed_at AS committedAt
     FROM source_versions WHERE source_id = ? AND revision = ? AND generation = ?`,
    reference.sourceId, reference.revision, reference.generation);
  if (!version) return unavailable("revision_unavailable");
  const descriptor = JSON.parse(version.descriptor) as SourceDescriptor;
  if (row.availability !== "available" || version.text === null) {
    if (descriptor.kind === "external") return { ...unavailable("external_not_imported"), descriptor };
    return unavailable("source_unavailable");
  }
  return { state: "available", projectId, reference: { ...reference }, current: { ...row }, descriptor,
    attribution: JSON.parse(version.attribution) as Attribution, committedAt: version.committedAt, text: version.text };
}
