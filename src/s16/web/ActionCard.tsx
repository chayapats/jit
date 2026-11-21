import { useRef, useState } from "react";
import type { ActionSlip } from "../../s15/policy";
import type { JitClient } from "../client";
import type { Copy } from "./copy";

import { cardFacts } from "../client/action-card";
export { cardFacts, cardAmount, cardPayload } from "../client/action-card";
export type { CardKind, CardRow, CardRequestField } from "../client/action-card";

const uid = () => crypto.randomUUID().replaceAll("-", "");
type Phase = { state: "idle" } | { state: "sending"; decision: "approve" | "deny" } | { state: "done"; decision: "approve" | "deny" } | { state: "stale" } | { state: "failed"; decision: "approve" | "deny"; code: string };

/** One held action, inline in the conversation. `onDecided` refreshes the snapshot so the row shows the outcome. */
export function ActionCard({ slip, conversationId, client, t, onDecided }: { slip: ActionSlip; conversationId: string; client: JitClient; t: Copy; onDecided(): void }) {
  const facts = cardFacts(slip), a = slip.action, [phase, setPhase] = useState<Phase>({ state: "idle" });
  // One request ID per decision of this exact revision, kept for a retry after a lost response.
  const ids = useRef<Record<string, string>>({});
  async function decide(decision: "approve" | "deny") {
    const requestId = ids.current[decision] ??= uid();
    setPhase({ state: "sending", decision });
    try {
      await client.decide({ contract: "s15-conversation-decision/v1", requestId, conversationId, action: { id: a.id, revision: a.revision, actionHash: a.actionHash }, decision });
      setPhase({ state: "done", decision }); onDecided();
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "unavailable";
      setPhase(code === "stale_action" ? { state: "stale" } : { state: "failed", decision, code });
    }
  }
  const busy = phase.state === "sending" || phase.state === "done";
  const field = (label: string, value: string | null) => value ? <><dt>{label}</dt><dd>{value}</dd></> : null;
  const headingId = `card-${a.id}-${a.revision}`;
  return <section className={`action-card action-${facts.kind}`} aria-labelledby={headingId}>
    <h3 id={headingId}>{t(`s16.card.title.${facts.kind}`)}</h3>
    <p className="card-why">{t(slip.reasonCode === "production_approval_required" ? "s16.card.why.production" : slip.reasonCode === "egress_approval_required" ? "s16.card.why.egress" : facts.firstShare.length ? "s16.card.why.firstShare" : facts.kind === "email" || facts.kind === "message" || facts.kind === "calendar" ? "s16.card.why.message" : "s16.card.why.required")}</p>
    <dl className="card-facts">
      {field(t("s16.card.to"), facts.to.join(", ") || null)}{field(t("s16.card.cc"), facts.cc.join(", ") || null)}{field(t("s16.card.bcc"), facts.bcc.join(", ") || null)}
      {field(t("s16.card.subject"), facts.subject)}{field(t("s16.card.amount"), facts.amount)}{field(t("s16.card.target"), facts.target)}{field(t("s16.card.request"), facts.request)}
      {!facts.to.length && field(t("s16.card.recipients"), a.recipients.map(r => r.id).join(", ") || null)}
    </dl>
    {!!facts.rows.length && <dl className="card-facts">{facts.rows.map(([row, value]) => <div key={row} className="card-row"><dt>{t(`s16.card.row.${row}`)}</dt><dd>{value}</dd></div>)}</dl>}
    {!!facts.requestFields.length && <dl className="card-facts card-request-fields">{facts.requestFields.map(({ source, name, value }, index) => <div key={index} className="card-row"><dt>{t(source === "query" ? "s16.card.queryField" : "s16.card.formField", { field: name })}</dt><dd>{value}</dd></div>)}</dl>}
    {facts.body !== null && facts.body !== "" && <pre className="card-body" tabIndex={0} aria-label={t("s16.card.body")}>{facts.body}</pre>}
    {/* The complete exact payload is always available; an action shape without its own rows shows it open. */}
    {facts.payloadText && <details className="card-payload" open={!facts.known}><summary>{t("s16.card.allFields")}</summary><pre className="card-body" tabIndex={0}>{facts.payloadText}</pre></details>}
    {!!facts.firstShare.length && <p className="card-note">{t("s16.card.remembered")}</p>}
    <p className="card-note">{t("s16.card.once")} <a href={`/actions/${encodeURIComponent(a.id)}?r=${a.revision}`}>{t("s16.card.fullReview")}</a></p>
    <div className="card-actions" role="group" aria-label={t(`s16.card.title.${facts.kind}`)}>
      {slip.canApprove ? <button type="button" className="primary" disabled={busy} onClick={() => void decide("approve")}>{phase.state === "sending" && phase.decision === "approve" ? t("s16.card.working") : t("s16.card.approve")}</button> : <p className="card-note">{t("s16.card.cannotApprove")}</p>}
      <button type="button" disabled={busy} onClick={() => void decide("deny")}>{phase.state === "sending" && phase.decision === "deny" ? t("s16.card.working") : t("s16.card.decline")}</button>
    </div>
    <div aria-live="polite">
      {phase.state === "done" && <p role="status">{t(phase.decision === "approve" ? "s16.card.approved" : "s16.card.declined")}</p>}
      {phase.state === "stale" && <p role="alert">{t("s16.card.stale")} <button type="button" className="memory-link" onClick={onDecided}>{t("s16.card.refresh")}</button></p>}
      {phase.state === "failed" && <p role="alert">{t("s16.card.failed")} <button type="button" className="memory-link" onClick={() => void decide(phase.decision)}>{t("s16.card.retry")}</button> <code>{phase.code}</code></p>}
    </div>
  </section>;
}
