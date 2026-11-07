import { useState } from "react";
import { JitClientError, type JitClient } from "../client";
import type { ClientBotProposal, ClientBotReceipt, ClientBotsView } from "../client/contracts";
import type { Copy } from "./copy";

const uid = () => crypto.randomUUID().replaceAll("-", "");
const privateFailure = (error: unknown) => error instanceof JitClientError && ([401, 403].includes(error.status ?? 0) || ["authentication_required", "authorization_required", "csrf_rejected"].includes(error.code));

/** Props for one exact Bot proposal. Choices come from the same protected Bots page read. */
export interface BotProposalCardProps {
  client: JitClient; t: Copy; proposal: ClientBotProposal;
  choices: Pick<ClientBotsView, "selections" | "resources"> | null;
  onAccepted(receipt: ClientBotReceipt): void;
  /** Opens the editable form prefilled with this draft; an edit becomes a new proposal. */
  onEdit?(proposal: ClientBotProposal): void;
  onDismissed?(): void;
  onFailure(error: unknown): void;
}

/**
 * BOT16-01 proposal card (chat and Bots page). One press accepts exactly the shown revision (`proposalHash`); nothing
 * is created before it, and any edit makes a new proposal. An uncertain response is checked again with the same
 * command identity, never sent as a new acceptance.
 */
export function BotProposalCard({ client, t, proposal, choices, onAccepted, onEdit, onDismissed, onFailure }: BotProposalCardProps) {
  const [state, setState] = useState<{ kind: "idle" } | { kind: "pending" } | { kind: "error"; code: string } | { kind: "unknown"; requestId: string }>({ kind: "idle" });
  const draft = proposal.draft;
  const model = draft.selection ? choices?.selections.find(choice => JSON.stringify(choice.selection) === JSON.stringify(draft.selection))?.label ?? null : null;
  const uses = proposal.resources.filter(resource => !draft.excluded.includes(resource.id));
  async function accept(requestId = uid()) {
    setState({ kind: "pending" });
    try { onAccepted(await client.botCommand({ contract: "s16-bot-command/v1", requestId, kind: "bot.accept", proposalId: proposal.id, proposalHash: proposal.proposalHash })); setState({ kind: "idle" }); }
    catch (error) {
      if (privateFailure(error)) { onFailure(error); return; }
      setState(error instanceof JitClientError && error.outcome === "unknown" ? { kind: "unknown", requestId } : { kind: "error", code: error instanceof JitClientError ? error.code : "client_unavailable" });
    }
  }
  async function dismiss() {
    setState({ kind: "pending" });
    try { await client.botCommand({ contract: "s16-bot-command/v1", requestId: uid(), kind: "bot.dismiss", proposalId: proposal.id }); onDismissed?.(); }
    catch (error) { if (privateFailure(error)) { onFailure(error); return; } setState({ kind: "error", code: error instanceof JitClientError ? error.code : "client_unavailable" }); }
  }
  const busy = state.kind === "pending";
  return <section className="action-card bot-proposal" aria-labelledby={`bot-proposal-${proposal.id}`}>
    <h3 id={`bot-proposal-${proposal.id}`}>{t("s16.bots.proposalTitle", { name: draft.name })}</h3>
    {proposal.source.kind === "chat" && <p className="meta">{t("s16.bots.proposalChat")}</p>}
    {proposal.source.kind === "import" && <p className="meta">{t("s16.bots.proposalImport")}</p>}
    {proposal.source.kind === "duplicate" && <p className="meta">{t("s16.bots.proposalDuplicate")}</p>}
    <dl>
      {draft.responsibility && <><dt>{t("s16.bots.responsibility")}</dt><dd className="owner-text">{draft.responsibility}</dd></>}
      <dt>{t("s16.bots.model")}</dt><dd>{model ?? t("s16.bots.modelDefault")}</dd>
      <dt>{t("s16.bots.resources")}</dt><dd>{uses.length ? uses.map(resource => resource.label).join(", ") : t("s16.bots.noResources")}</dd>
    </dl>
    {!!proposal.missing.length && <p className="notice warn">{t("s16.bots.missing", { items: proposal.missing.join(", ") })}</p>}
    <p className="limits">{t("s16.bots.proposalBody")}</p>
    <div role={state.kind === "error" || state.kind === "unknown" ? "alert" : "status"} aria-live="polite">
      {state.kind === "error" && <p className="notice warn">{state.code === "stale_proposal" ? t("s16.bots.stale") : t("s16.bots.failed", { reason: state.code })}</p>}
      {state.kind === "unknown" && <p className="notice warn">{t("s16.bots.unknown")} <button type="button" onClick={() => void accept(state.requestId)}>{t("s16.bots.checkAgain")}</button></p>}
    </div>
    <div className="actions">
      <button type="button" className="primary" disabled={busy || state.kind === "unknown"} onClick={() => void accept()}>{t("s16.bots.accept")}</button>
      {onEdit && <button type="button" disabled={busy} onClick={() => onEdit(proposal)}>{t("s16.bots.edit")}</button>}
      <button type="button" disabled={busy} onClick={() => void dismiss()}>{t("s16.bots.dismiss")}</button>
    </div>
  </section>;
}
