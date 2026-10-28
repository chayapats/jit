import type { TransactionStore } from "../store";
import type { ApprovalCard } from "../exec/approval-cards";
import { readBinding } from "./binding";
import { createCallbackRef } from "./callbacks";
import { commitDeliveryIntent } from "../delivery/outbox";
import { renderApprovalMessage } from "./approval-messages";
import { readPersona } from "../persona";

/**
 * telegram.approval_cards/v1 notify (EXE10): subscribes to EXE07 card creation.
 * EXE07 exposes no card-created event; the merged equivalent is the `ApprovalCard`
 * returned by `createCard` (and by the effect tools). Call this after card creation;
 * it creates two revision- and digest-bound callback refs (Approve/Deny) expiring
 * with the card and enqueues one delivery outbox intent (`approval/<cardId>`).
 * Exactly once per card: a second call finds the dedupe key and creates nothing.
 */
export function notifyApprovalCard(store: TransactionStore, card: ApprovalCard, now: number): { intentId: string; approveData: string; denyData: string } | null {
  if (!card.telegramEligible) return null;
  return store.transaction(tx => {
    const binding = readBinding(tx);
    if (binding.state !== "bound" || binding.telegramChatId === null) return null;
    const dedupeKey = `approval/${card.id}`;
    if (tx.get("SELECT id FROM delivery_intents WHERE dedupe_key = ?", dedupeKey)) return null;
    const locale = (() => { try { return readPersona(tx).language; } catch { return "th" as const; } })();
    let projectName: string | undefined, topicTitle: string | undefined;
    try {
      projectName = tx.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", card.projectId)?.name;
      topicTitle = (tx.get<{ title: string | null }>("SELECT title FROM topics WHERE project_id = ? AND id = ?", card.projectId, card.topicId)?.title) ?? undefined;
    } catch { /* Names are best-effort; IDs in the card still identify it. */ }
    const rendered = renderApprovalMessage(card, locale, { projectName, topicTitle });
    const approve = createCallbackRef(tx, {
      telegramChatId: binding.telegramChatId!, bindingRevision: binding.revision, contextRevision: 0,
      projectId: card.projectId, topicId: card.topicId, action: "approval.approve",
      taskId: card.id, proposalId: card.id, expectedRevision: card.revision, expectedDigest: card.digest,
      requestId: `tg-approve-${card.id}`,
    }, now, card.expiresAt);
    const deny = createCallbackRef(tx, {
      telegramChatId: binding.telegramChatId!, bindingRevision: binding.revision, contextRevision: 0,
      projectId: card.projectId, topicId: card.topicId, action: "approval.deny",
      taskId: card.id, proposalId: card.id, expectedRevision: card.revision, expectedDigest: card.digest,
      requestId: `tg-deny-${card.id}`,
    }, now, card.expiresAt);
    const text = `${rendered.text}\n/approve ${approve.data}\n/deny ${deny.data}`;
    const receipt = commitDeliveryIntent(tx, { projectId: card.projectId, kind: "report", text, dedupeKey, maxBytes: 4000 }, now);
    return { intentId: receipt.intent.id, approveData: approve.data, denyData: deny.data };
  });
}
