import { attachmentOutboundEntries } from "../attachments/run-content";
import { runAttachmentCurrent } from "../attachments/run-references";
import { writeAttachmentEvent } from "../attachments/records";
import { createCard, type ApprovalCard, type EffectAction, type OutboundReleaseAction } from "../exec/approval-cards";
import type { EffectPerformer } from "../exec/effect-executor";
import { contextCurrent } from "../memory/context";
import { lookupSource } from "../sources";
import type { AppTransaction, TransactionStore } from "../store";
import type { ApplicationRunRequest } from "../team/types";
import { buildOutboundCorpus, findVerbatimSpan, type OutboundMatch } from "./outbound-guard";
import { serviceToolCurrent } from "./service-tools";

/** Exact string values only, recursively including nested MCP arrays/objects; keys never substitute for outbound values. */
export function outboundValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(outboundValues);
  return value && typeof value === "object" ? Object.values(value).flatMap(outboundValues) : [];
}
/** Full attachment and private-context corpus shared by every guarded channel of one run. */
export function runOutboundGuard(store: TransactionStore, request: ApplicationRunRequest): (value: unknown) => OutboundMatch | null {
  const corpus = buildOutboundCorpus([...attachmentOutboundEntries(store, request), ...request.manifest.sources, ...request.manifest.claims,
    ...(request.manifest.context?.constraints ?? []), ...(request.manifest.context?.packet?.pinned ?? []).map(item => ({ text: `${item.conclusion}\n${item.rationale}` })), { text: request.purpose }]);
  return value => { for (const text of outboundValues(value)) { const match = findVerbatimSpan(corpus, text); if (match) return match; } return null; };
}
/** Adds a digest-bound disclosure marker to a card the call already requires; it never grants authority. */
export function markOutboundAction<T extends EffectAction>(action: T, match: OutboundMatch | null): T {
  return match ? { ...action, outbound: { ...match } } : action;
}
/** First held call wins across all channels; later calls record content-free counts without creating another card. */
export function holdOutboundCall(store: TransactionStore, request: ApplicationRunRequest, action: Omit<OutboundReleaseAction, "kind" | "contextId" | "contextGeneration" | "ownerGeneration" | "matchedSpan" | "outbound">,
  match: OutboundMatch, now: number): ApprovalCard | null {
  return store.transaction(tx => {
    if (!serviceToolCurrent(tx, request)) return null;
    let card = tx.get<{ id: string }>("SELECT id FROM approval_cards WHERE kind = 'outbound_release' AND run_id = ?", request.runId);
    const created = !card ? createCard(tx, { projectId: request.projectId, topicId: request.topicId, runId: request.runId, jobId: request.fence.jobId, roleId: request.roleId }, {
      ...action, kind: "outbound_release", matchedSpan: match.span, contextId: request.context.id, contextGeneration: request.context.generation,
      ownerGeneration: request.fence.ownerGeneration, outbound: match,
    }, now, { autoApprove: false }) : null;
    card ??= created;
    if (!created) writeAttachmentEvent(tx, { projectId: request.projectId, attachmentId: match.attachmentId ?? null, kind: "outbound_block", status: "refused", reason: "outbound_blocked",
      runId: request.runId, jobId: request.fence.jobId, detail: { channel: action.tool, count: match.chars, ...(card ? { cardId: card.id } : {}) }, createdAt: now });
    return created;
  });
}
/** Live owner, context, source and carried-file checks for a held release after its proposing run has settled. */
export function outboundReleaseCurrent(tx: AppTransaction, card: ApprovalCard): boolean {
  if (card.action.kind !== "outbound_release") return false;
  const action = card.action;
  if (tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation !== action.ownerGeneration ||
    tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", action.contextId, action.contextGeneration)?.state !== "active") return false;
  const attempt = tx.get<{ json: string }>("SELECT json_extract(record_json, '$.data') AS json FROM job_attempts WHERE json_extract(record_json, '$.data.runId') = ? ORDER BY rowid DESC LIMIT 1", card.runId);
  const run = attempt?.json ? null : tx.get<{ json: string }>("SELECT json_extract(record_json, '$.request') AS json FROM team_runs WHERE id = ? OR json_extract(record_json, '$.request.runId') = ?", card.runId, card.runId);
  const json = attempt?.json ?? run?.json; if (!json) return false;
  const request = JSON.parse(json) as ApplicationRunRequest;
  return contextCurrent(tx, request.projectId, request.manifest) === null && request.manifest.sources.every(source => lookupSource(tx, source.projectId, source.reference).state === "available") &&
    (request.attachments ?? []).every(ref => runAttachmentCurrent(tx, request, ref));
}
/** Routes one claimed single-use release to its existing service performer, preserving the channel's authority and session checks. */
export function outboundReleasePerformer(store: TransactionStore, performers: { web: EffectPerformer; browser?: EffectPerformer; computer?: EffectPerformer; mcp?: EffectPerformer }): EffectPerformer {
  return async (card, signal, allowed) => {
    if (card.action.kind !== "outbound_release") return { outcome: "failed", reason: "wrong_card_kind", detail: {} };
    const current = () => allowed() && store.read(tx => outboundReleaseCurrent(tx, card));
    if (!current()) return { outcome: "failed", reason: "source_retired", detail: {} };
    const tool = card.action.tool;
    const performer = tool === "web_search" || tool === "web_fetch" ? performers.web : tool === "computer_type" ? performers.computer : tool === "mcp_tool" ? performers.mcp : performers.browser;
    if (!performer) return { outcome: "failed", reason: "performer_not_configured", detail: {} };
    const result = await performer(card, signal, current);
    if (!current() || signal.aborted) return { outcome: "failed", reason: "source_retired", detail: {} };
    if (typeof result.detail.result === "string") return { ...result, detail: { untrustedData: result.detail.result } };
    return result;
  };
}
