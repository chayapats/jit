import { AppError } from "../errors";
import { lookupSource, type SourceReference } from "../sources";
import type { AppTransaction } from "../store";
import { contextPacketSections } from "../team/types";
import type {
  ContextPacket, ContextPacketOmission, ContextPacketSection, ContextPacketSectionName, ContextPacketSummary, PinnedDecision,
} from "../team/types";
import { memoryDerivation, suppressedSource } from "./read";

/** Owner next action when the pinned decisions alone do not fit a run's context bytes (ADR 0034). */
export const contextTooLargeNextAction = "supersede_or_close_stale_decisions_or_raise_context_budget";

/**
 * app.context_packet/v1 admission refusal: the live decisions in scope do not fit the run's context bytes, and
 * pinned decisions are never trimmed. Nothing is admitted; the owner supersedes or closes stale decisions, or
 * raises the context budget.
 */
export function contextTooLarge(pinnedBytes: number, budgetBytes: number): AppError {
  return new AppError("context_too_large", 409, { nextAction: contextTooLargeNextAction, pinnedBytes, budgetBytes });
}

/** The owner-attributed evidence of one decision: its memory decision source, else its proposal source. */
export function decisionSource(tx: AppTransaction, projectId: string, decisionId: string): SourceReference {
  const owned = tx.get<SourceReference>("SELECT source_id AS sourceId, source_revision AS revision, source_generation AS generation FROM memory_decision_sources WHERE project_id = ? AND decision_id = ?", projectId, decisionId);
  if (owned) return owned;
  return tx.get<SourceReference>("SELECT p.source_id AS sourceId, p.source_revision AS revision, p.source_generation AS generation FROM owner_decisions d JOIN decision_proposals p ON p.id = d.proposal_id WHERE d.project_id = ? AND d.id = ?", projectId, decisionId)!;
}

/**
 * Every committed owner decision that is still live in the project: the run topic's decision first, then the other
 * topics' decisions, newest first. There is no count cap; only the run's context bytes bound the packet.
 */
export function pinnedDecisions(tx: AppTransaction, projectId: string, topicId: string): PinnedDecision[] {
  return tx.all<{ id: string; topicId: string; revision: number; conclusion: string; rationale: string }>(
    "SELECT id, topic_id AS topicId, revision, conclusion, rationale FROM owner_decisions WHERE project_id = ? AND superseded_by IS NULL ORDER BY (topic_id = ?) DESC, created_at DESC, id",
    projectId, topicId,
  ).map(row => ({
    id: row.id, revision: row.revision, topicId: row.topicId, scope: row.topicId === topicId ? "topic" : "project",
    conclusion: row.conclusion, rationale: row.rationale, source: decisionSource(tx, projectId, row.id),
  }));
}

/** Request bytes the pinned decisions take. */
export const pinnedBytes = (pinned: readonly PinnedDecision[]): number =>
  pinned.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item)), 0);

/**
 * Null while the pinned set still equals the project's live decisions at the same revisions. A decision accepted or
 * superseded after assembly makes the packet stale, so pending runs fence through the existing `isCurrent` checks.
 */
export function pinnedCurrent(tx: AppTransaction, projectId: string, pinned: readonly Pick<PinnedDecision, "id" | "revision">[]): "superseded" | null {
  const live = tx.all<{ id: string; revision: number }>("SELECT id, revision FROM owner_decisions WHERE project_id = ? AND superseded_by IS NULL", projectId);
  if (live.length !== pinned.length) return "superseded";
  const recorded = new Map(pinned.map(item => [item.id, item.revision]));
  return live.every(row => recorded.get(row.id) === row.revision) ? null : "superseded";
}

/** The newest committed scheduled summary of a topic, with its text, or null; `skipped` counts unavailable newer ones. */
export function topicSummary(tx: AppTransaction, projectId: string, topicId: string):
  { summary: Omit<ContextPacketSummary, "index">; text: string; skipped: number } | { summary: null; text: null; skipped: number } {
  // Every committed summary of the topic, newest first; rows are identities only, and the walk stops at the first
  // available one, so an older summary is still found when every newer one was withdrawn.
  const rows = tx.all<{ id: string; sequence: number; reference: string | null }>(
    `SELECT o.id, o.sequence, json_extract(o.record_json, '$.outputSource') AS reference FROM job_schedule_occurrences o
       JOIN job_schedules s ON s.id = o.schedule_id
     WHERE s.project_id = ? AND json_extract(s.record_json, '$.topicId') = ? AND json_extract(o.record_json, '$.kind') = 'summary'
       AND json_extract(o.record_json, '$.state') = 'complete' AND json_extract(o.record_json, '$.outputSource') IS NOT NULL
     ORDER BY o.sequence DESC`, projectId, topicId);
  const total = rows.length;
  let skipped = 0;
  for (const row of rows) {
    const reference = JSON.parse(row.reference!) as SourceReference;
    const found = available(tx, projectId, reference);
    if (!found) { skipped++; continue; }
    const context = tx.get<{ json: string }>("SELECT record_json AS json FROM memory_contexts WHERE project_id = ? AND owner_kind = 'schedule' AND owner_id = ?", projectId, row.id);
    const sourceIds = context
      ? [...new Set((JSON.parse(context.json) as { entries: { kind: string; id: string }[] }).entries.filter(entry => entry.kind === "source").map(entry => entry.id))]
      : [];
    return {
      summary: { summaryRevision: total - skipped, source: { ...found.reference }, sourceIds, depth: memoryDerivation(tx, projectId, reference.sourceId) },
      text: found.text, skipped,
    };
  }
  return { summary: null, text: null, skipped };
}

/** Whether the summary a packet recorded is still the same available, unsuppressed source revision. */
export function summaryCurrent(tx: AppTransaction, projectId: string, summary: ContextPacketSummary | null): boolean {
  return !summary || available(tx, projectId, summary.source) !== null;
}

function available(tx: AppTransaction, projectId: string, reference: SourceReference) {
  try {
    const found = lookupSource(tx, projectId, reference);
    return found.state === "available" && found.current.revision === reference.revision && !suppressedSource(tx, reference) ? found : null;
  } catch { return null; }
}

/** Per-section measurement given to {@link packetSections}; the state follows from candidates, kept and withholding. */
export interface SectionMeasure { candidates: number; kept: number; bytes: number; withheld?: boolean }

/** The eight labelled sections in their fixed order. */
export function packetSections(measures: Readonly<Record<ContextPacketSectionName, SectionMeasure>>): ContextPacketSection[] {
  return contextPacketSections.map((name, index) => {
    const measure = measures[name];
    const state: ContextPacketSection["state"] = measure.withheld ? "withheld"
      : measure.candidates === 0 ? "empty"
      : measure.kept >= measure.candidates ? "included"
      : measure.kept === 0 ? "dropped" : "trimmed";
    return { order: index + 1, name, state, items: measure.kept, bytes: measure.bytes };
  });
}

/**
 * Bottom-up trim over ordered candidate sections: each section is filled in order, and once one candidate does not
 * fit, it and every later candidate (lower in its section and in every section below) are dropped. The result is the
 * same as removing candidates from section 8 upward until the rest fit. Returns how many of each section were kept.
 */
export function trimBottomUp(budget: number, sections: readonly (readonly number[])[]): { kept: number[]; used: number } {
  let room = Math.max(0, budget), open = true, used = 0;
  const kept = sections.map(costs => {
    let count = 0;
    for (const cost of costs) {
      if (!open || cost > room) { open = false; break; }
      room -= cost; used += cost; count++;
    }
    return count;
  });
  return { kept, used };
}

/** Adds one omission record unless nothing was lost. */
export function omit(list: ContextPacketOmission[], section: ContextPacketOmission["section"], reason: ContextPacketOmission["reason"], items: number): void {
  if (items > 0) list.push({ section, reason, items });
}

/** Assembles the packet record from measured sections. */
export function contextPacket(input: Omit<ContextPacket, "contract" | "version">): ContextPacket {
  return { contract: "app.context_packet/v1", version: 1, ...input };
}
