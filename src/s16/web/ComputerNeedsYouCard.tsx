import { useState } from "react";
import type { JitClient } from "../client";
import type { ComputerNeedsYouCard as Card } from "../computers/needs-you-types";
import { ComputerScreen } from "./ComputerScreen";
import type { Copy } from "./copy";

/** Origin-only owner handoff. The existing screen owns input, renewal and hand-back; this card holds no secrets. */
export function ComputerNeedsYouCard({ card, botName, client, t, refresh, onFailure }: { card: Card; botName: string; client: JitClient; t: Copy; refresh(): void; onFailure(error: unknown): void }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  async function command(kind: "watch" | "decline") {
    if (busy || card.generation === null) return;
    setBusy(true); setFailed(false);
    try {
      const result = await client.needsYou({ contract: "s16-computer-needs-you/v1", requestId: crypto.randomUUID().replaceAll("-", ""), conversationId: card.conversationId, cardId: card.id, kind, generation: card.generation });
      if (kind === "watch" && result.screen) setOpen(true);
      refresh();
    } catch (error) { setFailed(true); onFailure(error); }
    finally { setBusy(false); }
  }
  const title = t("s16.needsYou.title", { bot: botName, origin: card.origin });
  return <section id={`needs-you-${card.id}`} className="action-card" aria-label={title}>
    <h3>{title}</h3><p>{t(`s16.needsYou.${card.reason}`)}</p><p role="status">{t(`s16.needsYou.${card.state}`)}</p>
    {card.state === "pending" && <div className="card-actions">
      {card.canWatch && <button type="button" className="primary" disabled={busy || failed} onClick={() => void command("watch")}>{t("s16.needsYou.watch")}</button>}
      {card.canDecline && <button type="button" disabled={busy || failed} onClick={() => void command("decline")}>{t("s16.needsYou.decline")}</button>}
    </div>}
    {card.code && <p>{t("s16.needsYou.protected")}</p>}
    {card.state === "resumed" && <p>{t("s16.needsYou.continue")}</p>}
    {failed && <p role="alert">{t("s16.needsYou.failed")} <button type="button" onClick={() => { setFailed(false); refresh(); }}>{t("s16.card.refresh")}</button></p>}
    {open && <ComputerScreen client={client} t={t} vmId={card.vmId} title={title} onClose={() => { setOpen(false); refresh(); }} onFailure={onFailure} />}
  </section>;
}
