import { commitOwnerSource, type SourceReference } from "../sources";
import type { AppTransaction } from "../store";
import type { MemoryDecisionReference } from "./types";

/** Commits exact owner-selected wording as a source in the same decision transaction; no extraction starts. */
export function commitDecisionMemorySource(tx: AppTransaction, decision: {
  id: string; projectId: string; topicId: string; revision: number; conclusion: string; rationale: string; createdAt: number;
}): void {
  if (tx.get("SELECT 1 FROM memory_decision_sources WHERE decision_id = ?", decision.id)) return;
  const source = commitOwnerSource(tx, { projectId: decision.projectId, descriptor: { kind: "topic", topicId: decision.topicId },
    text: `${decision.conclusion}\n${decision.rationale}`, committedAt: decision.createdAt });
  tx.run("INSERT INTO memory_decision_sources VALUES (?, ?, ?, ?, ?, ?, ?)", decision.id, decision.projectId, decision.topicId,
    decision.revision, source.sourceId, source.revision, source.generation);
}

/** Supersession fences the old derived-memory source, while authoritative decision history retains the owner action. */
export function retireDecisionMemorySource(tx: AppTransaction, projectId: string, decisionId: string): void {
  tx.run("UPDATE sources SET availability = 'unavailable', generation = generation + 1 WHERE availability = 'available' AND project_id = ? AND id IN (SELECT source_id FROM memory_decision_sources WHERE decision_id = ? AND project_id = ?)", projectId, decisionId, projectId);
}

/** Resolves a source's exact decision identity without inferring current owner authority from model text. */
export function memorySourceDecision(tx: AppTransaction, projectId: string, source: SourceReference): MemoryDecisionReference | null {
  const row = tx.get<{ id: string; revision: number; topicId: string }>("SELECT decision_id AS id, decision_revision AS revision, topic_id AS topicId FROM memory_decision_sources WHERE project_id = ? AND source_id = ? AND source_revision = ? AND source_generation = ?", projectId, source.sourceId, source.revision, source.generation);
  return row ? { kind: "owner_decision", ...row } : null;
}
