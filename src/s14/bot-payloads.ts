import type { AppTransaction } from "../store";
import { record, save, type S14Application } from "./application";
import type { Attempt, Work, WorkGrant } from "./authority-types";
import type { BotProposal, Reply } from "./types";
import { canonical } from "./validation";

/** Erases tombstoned Bot-owned payload caches while retaining identity/hash facts and independently owned originals. */
export function eraseBotPayloads(app: S14Application, tx: AppTransaction, botId: string): void {
  const conversations = new Set(tx.all<{ id: string }>("SELECT id FROM conversations WHERE bot_id=?", botId).map(row => row.id));
  const attempts = new Set(tx.all<{ id: string }>("SELECT id FROM work_attempts WHERE json_extract(record_json,'$.snapshot.bot.id')=?", botId).map(row => row.id));
  for (const row of tx.all<{ record_json: string }>(`SELECT c.record_json FROM memory_contexts c JOIN lifecycle.withdrawals w
    ON w.kind='bot_context' AND w.id=? AND w.mode=c.id`, botId)) {
    const context = JSON.parse(row.record_json);
    if (context.attemptId) attempts.add(context.attemptId);
  }
  const impact = app.memory.botImpact(tx, botId), withdrawnSources = new Set(impact.sources.map(source => source.id));
  const works = new Set(tx.all<{ id: string }>(`SELECT w.id FROM work_items w JOIN conversations c ON c.id=w.conversation_id
    WHERE c.bot_id=? AND NOT EXISTS (SELECT 1 FROM work_grants g,json_each(g.record_json,'$.bots') b
      WHERE g.work_id=w.id AND json_extract(b.value,'$.id')<>?)`, botId, botId).map(row => row.id));
  for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM work_items")) {
    const work = JSON.parse(row.record_json) as Work;
    if (work.source && withdrawnSources.has(work.source.id) || work.sourceMessageId && withdrawnSources.has(work.sourceMessageId)) works.add(work.id);
  }
  for (const row of tx.all<{ id: string; record_json: string }>("SELECT id,record_json FROM memory_decisions")) {
    const decision = JSON.parse(row.record_json);
    if (!conversations.has(decision.conversationId) && !withdrawnSources.has(decision.source.id)) continue;
    decision.text = "[deleted]";
    decision.key = "[deleted]";
    save(tx, "memory_decisions", decision);
  }
  for (const row of tx.all<{ id: string; record_json: string }>("SELECT id,record_json FROM routines")) {
    const routine = JSON.parse(row.record_json);
    for (const captured of routine.capture.bots) if (captured.id === botId) {
      captured.name = "[deleted]";
      captured.responsibility = "[deleted]";
    }
    if (conversations.has(routine.capture.command.payload.conversationId)) {
      routine.capture.command.payload.title = "[deleted]";
      routine.capture.command.payload.purpose = "[deleted]";
      routine.capture.command.payload.completionRule = "[deleted]";
      delete routine.capture.command.payload.requiredEvidence;
    }
    tx.run("UPDATE routines SET record_json=? WHERE id=?", canonical(routine), row.id);
  }
  for (const conversationId of conversations) {
    for (const row of tx.all<{ id: string; record_json: string }>("SELECT id,record_json FROM messages WHERE conversation_id=?", conversationId)) {
      tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('source',?,'deleted')", row.id);
      const message = JSON.parse(row.record_json);
      message.text = "[deleted]";
      tx.run("UPDATE messages SET record_json=? WHERE id=?", canonical(message), row.id);
    }
    tx.run("DELETE FROM parallel_sessions WHERE conversation_id=?", conversationId);
  }
  for (const workId of works) {
    const work = record<Work>(tx, "work_items", workId);
    work.title = "[deleted]";
    work.purpose = "[deleted]";
    work.completionRule = "[deleted]";
    work.result = null;
    save(tx, "work_items", work);
    tx.run("INSERT OR IGNORE INTO work_payload_deletions VALUES (?)", workId);
    if (work.grantId) {
      const grant = record<WorkGrant>(tx, "work_grants", work.grantId);
      grant.purpose = "[deleted]";
      grant.command.payload.title = "[deleted]";
      grant.command.payload.purpose = "[deleted]";
      grant.command.payload.completionRule = "[deleted]";
      delete grant.command.payload.requiredEvidence;
      tx.run("UPDATE work_grants SET record_json=? WHERE id=?", canonical(grant), grant.id);
    }
    for (const row of tx.all<{ id: string; record_json: string }>("SELECT id,record_json FROM work_graphs WHERE id=?", workId)) {
      const graph = JSON.parse(row.record_json);
      for (const node of graph.nodes) node.input = "[deleted]";
      save(tx, "work_graphs", graph);
    }
  }
  const effectIds = new Set<string>();
  for (const attemptId of attempts) {
    tx.run("INSERT OR IGNORE INTO attempt_payload_deletions VALUES (?)", attemptId);
    const attempt = record<Attempt>(tx, "work_attempts", attemptId);
    attempt.snapshot.input = "[deleted]";
    if (attempt.snapshot.bot.id === botId) {
      attempt.snapshot.bot.name = "[deleted]";
      attempt.snapshot.bot.responsibility = "[deleted]";
    }
    if (works.has(attempt.workId)) {
      attempt.snapshot.grant = record<WorkGrant>(tx, "work_grants", attempt.snapshot.grant.id);
    }
    if (attempt.step) attempt.step.inputs = [];
    save(tx, "work_attempts", attempt);
    tx.run("DELETE FROM work_results WHERE attempt_id=?", attemptId);
    app.artifacts.discard(tx, attemptId);
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM effects WHERE attempt_id=?", attemptId)) {
      const effect = JSON.parse(row.record_json);
      effectIds.add(effect.id);
      effect.action.content = "[deleted]";
      effect.action.destination = "[deleted]";
      effect.payloadState = "deleted";
      save(tx, "effects", effect);
      for (const version of tx.all<{ revision: number; record_json: string }>("SELECT revision,record_json FROM effect_versions WHERE effect_id=?", effect.id)) {
        const data = JSON.parse(version.record_json);
        data.action.content = "[deleted]";
        data.action.destination = "[deleted]";
        data.payloadState = "deleted";
        tx.run("UPDATE effect_versions SET record_json=? WHERE effect_id=? AND revision=?", canonical(data), effect.id, version.revision);
      }
    }
  }
  for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM work_graphs")) {
    const graph = JSON.parse(row.record_json);
    for (const node of graph.nodes) if (node.botId === botId) node.input = "[deleted]";
    save(tx, "work_graphs", graph);
  }
  for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM reply_outbox WHERE json_extract(record_json,'$.snapshot.bot.id')=?", botId)) {
    const reply = JSON.parse(row.record_json) as Reply;
    reply.snapshot.messages = [];
    delete reply.snapshot.memory;
    reply.snapshot.bot.name = "[deleted]";
    reply.snapshot.bot.responsibility = "[deleted]";
    if (["queued", "running"].includes(reply.state)) { reply.state = "blocked"; reply.reason = "bot_deleted"; }
    save(tx, "reply_outbox", reply);
  }
  for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM bot_proposals")) {
    const proposal = JSON.parse(row.record_json) as BotProposal;
    if (!conversations.has(proposal.conversationId)) continue;
    proposal.name = "[deleted]";
    proposal.responsibility = "[deleted]";
    if (proposal.state === "proposed") proposal.state = "rejected";
    save(tx, "bot_proposals", proposal);
    for (const version of tx.all<{ revision: number; record_json: string }>("SELECT revision,record_json FROM proposal_versions WHERE proposal_id=?", proposal.id)) {
      const data = JSON.parse(version.record_json);
      data.name = "[deleted]";
      data.responsibility = "[deleted]";
      tx.run("UPDATE proposal_versions SET record_json=? WHERE proposal_id=? AND revision=?", canonical(data), proposal.id, version.revision);
    }
  }
  // Receipts retain hashes and logical identities; nested snapshots are never a second payload archive.
  const scrub = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(scrub);
    if (!value || typeof value !== "object") return value;
    const item = value as Record<string, unknown>;
    const owned = item.id === botId || typeof item.conversationId === "string" && conversations.has(item.conversationId) ||
      typeof item.workId === "string" && works.has(item.workId) || typeof item.id === "string" && (attempts.has(item.id) || works.has(item.id));
    if ((item.botId === botId || typeof item.id === "string" && effectIds.has(item.id)) && typeof item.actionHash === "string" && item.action && typeof item.action === "object") {
      const action = item.action as Record<string, unknown>;
      action.content = "[deleted]";
      action.destination = "[deleted]";
      item.payloadState = "deleted";
    }
    if (owned) {
      for (const key of ["text", "quote", "title", "purpose", "completionRule", "responsibility", "name", "input"]) if (typeof item[key] === "string") item[key] = "[deleted]";
      if ("messages" in item) item.messages = [];
      if ("memory" in item) delete item.memory;
    }
    for (const key of Object.keys(item)) item[key] = scrub(item[key]);
    return item;
  };
  for (const row of tx.all<{ request_id: string; result_json: string }>("SELECT request_id,result_json FROM command_receipts")) {
    tx.run("UPDATE command_receipts SET result_json=? WHERE owner_id='owner' AND request_id=?", canonical(scrub(JSON.parse(row.result_json))), row.request_id);
  }
}
