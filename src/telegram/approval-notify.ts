import type { TransactionStore } from "../store";
import type { ApprovalCard } from "../exec/approval-cards";
import { readBinding } from "./binding";
import { createCallbackRef } from "./callbacks";
import { commitDeliveryIntent } from "../delivery/outbox";
import { approvalDetailParts } from "./approval-messages";
import { readPersona } from "../persona";
import { withLocale, tr } from "../i18n";

/** Delivery budget for one approval notice; `commitDeliveryIntent` refuses anything larger. */
export const approvalNoticeBudget = 4000;
/** Readability cap per detail line before the byte budget packs whole lines. */
const maxLineChars = 240;
const cutLine = (line: string): string => line.length <= maxLineChars ? line : `${line.slice(0, maxLineChars)}…`;

/**
 * Packs the notice within the byte budget: the decision header and the refs always fit;
 * flexible lines (commit summaries, bodies) are dropped from the end first, then pinned
 * lines, each cut ending with the `more` line for what was omitted.
 */
export function fitApprovalText(options: { header: string[]; pinned: string[]; flexible: string[]; refs: string[]; more: (omitted: number) => string; maxBytes?: number }): string {
  const maxBytes = options.maxBytes ?? approvalNoticeBudget;
  const pinned = options.pinned.map(cutLine), flexible = options.flexible.map(cutLine);
  const bytes = (lines: string[]) => Buffer.byteLength(lines.join("\n"));
  const full = [...options.header, ...pinned, ...flexible, ...options.refs];
  if (bytes(full) <= maxBytes) return full.join("\n");
  const drop = (keepPinned: number, keepFlexible: number): string[] => {
    const omitted = (pinned.length - keepPinned) + (flexible.length - keepFlexible);
    return [...options.header, ...pinned.slice(0, keepPinned), ...flexible.slice(0, keepFlexible), options.more(omitted), ...options.refs];
  };
  for (let keep = flexible.length - 1; keep >= 0; keep--) {
    const candidate = drop(pinned.length, keep);
    if (bytes(candidate) <= maxBytes) return candidate.join("\n");
  }
  for (let keep = pinned.length - 1; keep >= 0; keep--) {
    const candidate = drop(keep, 0);
    if (bytes(candidate) <= maxBytes) return candidate.join("\n");
  }
  // Last resort: the first header line (shortened) plus the refs, so the buttons always survive.
  let head = options.header[0] ?? "";
  while (head.length > 1 && bytes([`${head}…`, ...options.refs]) > maxBytes) head = head.slice(0, -10);
  return [`${head}…`, ...options.refs].join("\n");
}

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
    const kindTitle = withLocale(locale, () => tr(`approval.kind_${card.kind.replace(/^effect\./, "")}` as never));
    const { pinned, flexible } = approvalDetailParts(card);
    const more = (omitted: number): string => locale === "en" ? `…and ${omitted} more` : `…และอีก ${omitted} รายการ`;
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
    const refs = [`/approve ${approve.data}`, `/deny ${deny.data}`];
    const text = fitApprovalText({ header: [kindTitle, projectName ?? card.projectId, topicTitle ?? card.topicId], pinned, flexible, refs, more });
    const receipt = commitDeliveryIntent(tx, { projectId: card.projectId, kind: "report", text, dedupeKey, maxBytes: approvalNoticeBudget }, now);
    return { intentId: receipt.intent.id, approveData: approve.data, denyData: deny.data };
  });
}
