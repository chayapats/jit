import { useRef, useState } from "react";
import type { ActionSlip } from "../../s15/policy";
import type { JitClient } from "../client";
import type { Copy } from "./copy";

/**
 * AUTH16-01 in-chat approval (S16-D08, ADR 0084). The card shows the exact prepared action from the owner's
 * slip (recipients, content, amount or target) and its Approve/Decline buttons send the existing exact decision
 * command for this revision only. One press decides once: a retry after a lost response reuses the same request ID,
 * so the service returns the original receipt instead of deciding again. A changed revision refuses with
 * `stale_action` and the card asks for a refresh. Typed replies, page content and notifications never decide.
 */
export type CardKind = "email" | "calendar" | "message" | "publish" | "reply" | "merge" | "production" | "payment" | "recipient" | "website" | "decision" | "tool" | "generic";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value : "";
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
/** Browser-safe exact UTF-8 decoding of the complete canonical payload; malformed bytes show nothing. */
export function cardPayload(slip: Pick<ActionSlip, "payloadBytesBase64">): Json {
  try { const bytes = Uint8Array.from(atob(slip.payloadBytesBase64), c => c.charCodeAt(0)); return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Json; } catch { return null; }
}
const base64Text = (value: string) => { try { return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(value), c => c.charCodeAt(0))); } catch { return ""; } };
/** Decoded byte length of base64 text: padding characters carry no data. */
const base64Bytes = (value: string) => { const clean = value.replace(/\s/g, ""), pad = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0; return Math.max(0, Math.floor(clean.length * 3 / 4) - pad); };
/** Exact amount in minor units with the trusted currency precision; no float arithmetic. */
export function cardAmount(minor: string, minorUnit: number, currency: string): string {
  const digits = minor.replace(/^0+(?=\d)/, "").padStart(minorUnit + 1, "0");
  return `${minorUnit ? `${digits.slice(0, -minorUnit)}.${digits.slice(-minorUnit)}` : digits} ${currency}`;
}

const calendarEvent = (p: Record<string, unknown> | null) => p?.contract === "s15-google-effect/v1" && p.kind === "calendar" ? record(record(p.calendar)?.event) : null;
/** Extra exact fields a card shows under their own labels. */
export type CardRow = "when" | "where" | "attendees" | "attachments" | "payee" | "account" | "quote" | "issue" | "pull" | "branch" | "head" | "thread";
/** What the card shows, from the typed action fields and the exact payload only. */
export function cardFacts(slip: ActionSlip): { kind: CardKind; to: string[]; cc: string[]; bcc: string[]; subject: string | null; body: string | null; amount: string | null; target: string | null; operation: string | null; request: string | null; firstShare: string[]; rows: [CardRow, string][]; payloadText: string; known: boolean } {
  const a = slip.action, has = (c: string) => a.classes.includes(c as never), payload = cardPayload(slip), p = record(payload);
  const mail = p?.contract === "s15-google-effect/v1" && p.kind === "mail" ? record(p.message) : null;
  const github = p?.contract === "s15-github-effect/v1" ? p : null, op = record(github?.operation);
  const website = p?.contract === "s15-browser-request/v1" ? p : null;
  // CONN16-01: a reviewed connected-source tool the owner chose to approve call by call.
  const tool = p?.contract === "s16-source-call/v1" ? p : null;
  const kind: CardKind = has("financial") ? "payment" : has("production") ? "production" : has("github_merge") ? "merge" : tool ? "tool" : has("major_change") ? "decision"
    : has("github_publish") ? (text(op?.kind) === "review_reply" ? "reply" : "publish")
    : has("communication") ? (mail ? "email" : p?.contract === "s15-google-effect/v1" && p.kind === "calendar" ? "calendar" : website ? "website" : "message")
    : has("disclosure") || has("new_egress") ? "recipient" : website ? "website" : "generic";
  const t = a.transaction, g = a.github;
  return { kind, to: list(mail?.to), cc: list(mail?.cc), bcc: list(mail?.bcc), subject: mail ? text(mail.subject) : op ? text(op.title) || null : calendarEvent(p) ? text(calendarEvent(p)!.summary) || null : null,
    body: mail ? text(mail.body) : calendarEvent(p) ? text(calendarEvent(p)!.description) || null : op && typeof op.body === "string" ? op.body : website ? base64Text(text(website.bodyBase64)) || null : null,
    amount: t ? cardAmount(t.amountMinor, t.minorUnit, t.currency) : null,
    target: g ? `${text(github?.repository) || g.repository.id} → ${g.target}` : tool ? `${text(tool.label)} · ${text(tool.endpoint)}` : null, operation: op ? text(op.kind) : a.operation,
    request: website ? `${text(website.method)} ${text(website.url)}` : tool ? `${text(tool.title)}${text(tool.request) ? ` (${text(tool.request)})` : ""}` : null,
    // S16-D07 g: approving registers each first private-data recipient for later work.
    firstShare: has("disclosure") && a.disclosure?.dataClasses.some(c => c !== "public") ? a.disclosure.recipients.map(r => r.id) : [],
    rows: cardRows(p, kind, slip), payloadText: payload === null ? "" : JSON.stringify(payload, null, 2),
    // Kinds whose every owner-relevant field has its own row; anything else opens the complete exact payload.
    known: ["email", "calendar", "payment", "publish", "reply", "merge"].includes(kind) || (kind === "production" && !!github) };
}

function cardRows(p: Record<string, unknown> | null, kind: CardKind, slip: ActionSlip): [CardRow, string][] {
  const rows: [CardRow, string][] = [], add = (row: CardRow, value: string | null | undefined) => { if (value) rows.push([row, value]); };
  if (p?.contract === "s15-google-effect/v1") {
    const event = record(record(p.calendar)?.event);
    if (event) { add("when", [text(event.start), text(event.end)].filter(Boolean).join(" – ")); add("where", text(event.location)); add("attendees", list(event.attendees).join(", ")); }
    const files = (Array.isArray(p.attachments) ? p.attachments : []).map(record).filter((f): f is Record<string, unknown> => !!f);
    add("attachments", files.map(f => `${text(f.name)} (${text(f.mediaType)}, ${base64Bytes(text(f.dataBase64)).toLocaleString()} bytes)`).join(", "));
  }
  const t = slip.action.transaction; if (t) { add("payee", t.payee.id); add("account", t.account.id); add("quote", `${t.quoteId} · ${t.quoteVersion}`); }
  if (p?.contract === "s15-github-effect/v1") {
    const op = record(p.operation);
    add("issue", typeof p.issue === "number" ? `#${p.issue}` : null); add("pull", typeof op?.pull === "number" ? `#${op.pull}` : null);
    add("branch", text(p.branch)); add("head", text(p.head).slice(0, 12)); add("thread", text(op?.thread));
  }
  void kind; return rows;
}

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
