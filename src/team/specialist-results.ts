import { requireReference, type SourceReference } from "../sources";
import type { AppTransaction } from "../store";
import type { ParticipationResult, SpecialistResultStatus, SpecialistResultV2, SpecialistRun } from "./types";

/** Trusted operator line that asks a specialist for the app.specialist_results/v2 shape. */
export const specialistResultInstruction = "Return one JSON object {\"status\": \"done\"|\"partial\"|\"blocked\"|\"failed\", \"result\": string, \"evidence\": [{\"sourceId\", \"revision\", \"generation\"}, ...] or \"none\", \"unblock\": string|null}. Evidence entries must be manifest source references. \"blocked\" needs exactly one unblock action (one line, at most 200 characters); every other status uses null. Any other shape is stored as incomplete and never counts as done.";
/** Longest unblock action, in characters. */
export const unblockLimit = 200;
/** Longest raw text kept on an incomplete result, in UTF-16 units. */
export const rawLimit = 2000;
/** Statuses a synthesis or team reply may cite; every other committed status is a coverage gap. */
const citableStatuses: readonly SpecialistResultStatus[] = ["done", "partial"];
const modelStatuses = new Set(["done", "partial", "blocked", "failed"]);

/** Whether a committed result may be cited as a team result. Blocked, failed and incomplete results are gaps. */
export function citableResult(result: ParticipationResult | null | undefined): boolean {
  return !result || citableStatuses.includes(result.status);
}

/** Cuts text to `limit` UTF-16 units without splitting a surrogate pair. */
function bounded(text: string, limit: number): string {
  let out = "";
  for (const char of text) {
    if (out.length + char.length > limit) break;
    out += char;
  }
  return out;
}

const incomplete = (output: string): SpecialistResultV2 => ({
  version: 2, status: "incomplete", result: "", evidence: "none", unblock: null,
  raw: output.isWellFormed() ? bounded(output, rawLimit) : bounded(output.toWellFormed(), rawLimit),
});

/**
 * app.specialist_results/v2 normalization of untrusted specialist output (ADR 0033). The output must be one JSON
 * object, optionally inside one ```json fence, with exactly the keys `status`, `result`, `evidence` and optionally
 * `unblock`:
 * - `status` is `done`, `partial`, `blocked` or `failed`; a model cannot report `incomplete`;
 * - `result` is non-empty text;
 * - `evidence` is `"none"` or a list of source references; a well-formed reference that is not one of
 *   `allowedEvidence` (the run's manifest sources) is dropped and counted; an empty list reads as `"none"`;
 * - `blocked` needs exactly one unblock action: one non-empty line of at most 200 characters. Every other status
 *   has no unblock action.
 * Anything else, including plain prose, is `incomplete` with the raw text kept (bounded) for inspection.
 */
export function normalizeSpecialistResult(output: string, allowedEvidence: readonly SourceReference[]): { result: SpecialistResultV2; droppedEvidence: number } {
  const failed = { result: incomplete(output), droppedEvidence: 0 };
  let text = output.trim();
  const fenced = /^```(?:json)?[ \t]*\n([\s\S]*)\n```$/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  if (!text.startsWith("{")) return failed;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return failed; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return failed;
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort().join(",");
  if (keys !== "evidence,result,status" && keys !== "evidence,result,status,unblock") return failed;
  if (typeof value.status !== "string" || !modelStatuses.has(value.status)) return failed;
  const status = value.status as Exclude<SpecialistResultStatus, "incomplete">;
  if (typeof value.result !== "string" || !value.result.trim() || !value.result.isWellFormed()) return failed;
  let unblock: string | null = null;
  if (status === "blocked") {
    if (typeof value.unblock !== "string") return failed;
    unblock = value.unblock.trim();
    if (!unblock || unblock.length > unblockLimit || /[\r\n]/.test(unblock) || !unblock.isWellFormed()) return failed;
  } else if (value.unblock !== undefined && value.unblock !== null) return failed;
  let evidence: SourceReference[] | "none" = "none", droppedEvidence = 0;
  if (value.evidence !== "none") {
    if (!Array.isArray(value.evidence) || value.evidence.length > 64) return failed;
    const allowed = new Set(allowedEvidence.map(key));
    const kept: SourceReference[] = [], seen = new Set<string>();
    for (const entry of value.evidence) {
      const reference = parseReference(entry);
      if (!reference) return failed;
      if (!allowed.has(key(reference))) { droppedEvidence++; continue; }
      if (seen.has(key(reference))) continue;
      seen.add(key(reference));
      kept.push(reference);
    }
    if (kept.length) evidence = kept;
  }
  return { result: { version: 2, status, result: value.result.trim(), evidence, unblock, raw: null }, droppedEvidence };
}

const key = (reference: SourceReference) => `${reference.sourceId}:${reference.revision}:${reference.generation}`;

function parseReference(value: unknown): SourceReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const reference = value as SourceReference;
  if (Object.keys(reference).sort().join(",") !== "generation,revision,sourceId") return null;
  try { requireReference(reference); } catch { return null; }
  return { sourceId: reference.sourceId, revision: reference.revision, generation: reference.generation };
}

/**
 * Read-only status of a specialist run's committed result, for v2 and v1 records alike. A v2 record returns its
 * normalized status. A v1 record (no `result` key) is derived from its outcome: a committed complete outcome is
 * `done`. A run without a committed complete outcome has no result.
 */
export function specialistResultView(run: Pick<SpecialistRun, "outcome" | "source" | "result">): ParticipationResult | null {
  if (run.result) return { version: 2, status: run.result.status, unblock: run.result.unblock };
  if (run.result === undefined && run.outcome?.state === "complete" && run.source) return { version: 1, status: "done", unblock: null };
  return null;
}

/**
 * Text of the committed output source of a v2 result. It starts with the specialist's name, so a relayed answer
 * names its specialist first; the status and unblock action follow as code lines.
 */
export function renderSpecialistResult(roleName: string, header: string, result: SpecialistResultV2): string {
  return [
    `${roleName} · ${header}`,
    `status: ${result.status}`,
    result.status === "incomplete" ? result.raw ?? "" : result.result,
    ...result.unblock ? [`unblock: ${result.unblock}`] : [],
  ].filter(line => line.trim()).join("\n");
}

/**
 * The run whose latest committed result for this request (same topic, role and purpose) is blocked, or null. Jit
 * does not re-dispatch such a role for the same request (ADR 0033); a different request is unaffected.
 */
export function blockedForRequest(tx: AppTransaction, input: { projectId: string; topicId: string; roleId: string; purpose: string }): { runId: string } | null {
  const row = tx.get<{ record_json: string }>(
    `SELECT record_json FROM team_runs WHERE project_id = ? AND json_extract(record_json, '$.kind') = 'specialist'
       AND json_extract(record_json, '$.topicId') = ? AND json_extract(record_json, '$.roleId') = ?
       AND json_extract(record_json, '$.request.purpose') = ? AND json_extract(record_json, '$.outcome') IS NOT NULL
     ORDER BY sequence DESC LIMIT 1`, input.projectId, input.topicId, input.roleId, input.purpose);
  if (!row) return null;
  const run = JSON.parse(row.record_json) as SpecialistRun;
  return specialistResultView(run)?.status === "blocked" ? { runId: run.id } : null;
}

/**
 * The unblock action of a committed blocked result, read from its run record. Gaps, cards and synthesis keep only the
 * run id and read the action here, so a data deletion that redacts the run record also covers every place it shows.
 */
export function unblockAction(tx: AppTransaction, projectId: string, runId: string): string | null {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM team_runs WHERE project_id = ? AND id = ?", projectId, runId);
  if (!row) return null;
  try {
    const run = JSON.parse(row.record_json) as SpecialistRun;
    return run.kind === "specialist" && run.result?.status === "blocked" ? run.result.unblock : null;
  } catch { return null; }
}
