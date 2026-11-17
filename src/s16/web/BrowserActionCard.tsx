import { useState } from "react";
import type { BrowserActionCard as Card } from "../computers/browser-cards";
import type { JitClient } from "../client";
import type { Copy } from "./copy";

/** Owner-only values, never an instruction or HTML. A changed live revision cannot be approved from this view. */
export function BrowserActionCard({ card, client, t, refresh, onFailure }: { card: Card; client: JitClient; t: Copy; refresh(): void; onFailure(error: unknown): void }) {
  const { revision: _revision, ref: _ref, ...review } = card.facts;
  const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  async function decide(decision: "approve" | "decline") {
    setBusy(true); setFailed(false);
    try { await client.browserCard(card.conversationId, card.id, decision); refresh(); }
    catch (error) { setFailed(true); onFailure(error); }
    finally { setBusy(false); }
  }
  return <section id={`browser-card-${card.id}`} className="action-card" aria-label={t("s16.browserCard.title")}>
    <h3>{t("s16.browserCard.title")}</h3><p>{t("s16.card.why.required")} · S16-D07 ({card.row})</p>
    <dl className="card-facts"><dt>URL</dt><dd>{card.facts.url}</dd><dt>{t("s16.card.target")}</dt><dd>{card.facts.name} · {card.kind}</dd></dl>
    <details id={`browser-card-values-${card.id}`}><summary>{t("s16.card.allFields")}</summary><pre>{JSON.stringify(review, null, 2)}</pre><dl className="card-facts">{card.value !== undefined && <div><dt>{t("s16.browserCard.input")}</dt><dd><pre>{card.value}</pre></dd></div>}</dl></details>
    <p>{t("s16.card.once")} <a onClick={event => { const details = event.currentTarget.closest("section")?.querySelector("details"); if (details) details.open = true; }} href={`/s16/chat/${encodeURIComponent(card.conversationId)}#browser-card-values-${card.id}`}>{t("s16.card.fullReview")}</a></p>
    {card.state === "pending" ? <div className="card-actions"><button type="button" className="primary" disabled={busy || failed} onClick={() => void decide("approve")}>{t(busy ? "s16.card.working" : "s16.card.approve")}</button><button type="button" disabled={busy || failed} onClick={() => void decide("decline")}>{t("s16.card.decline")}</button></div> : <p role="status">{t(`s16.browserCard.${card.state}`)}</p>}
    {failed && <p role="alert">{t("s16.card.failed")} <button type="button" onClick={refresh}>{t("s16.card.refresh")}</button></p>}
  </section>;
}
