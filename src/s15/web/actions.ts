import { tr, trMaybe } from "../../i18n";
import { ownerStrip, untrusted } from "../../s14/web-pages";
import type { ConversationOwnerRow } from "../conversation";
import type { ActionClass, ActionSlip, JsonValue, StandingPolicy } from "../policy";
import { banner, clock, clockText, codeText, e, fill, form, hidden, icon, key, pill, statePill, type S15State } from "./render";
import type { S15DecisionCard } from "./types";

/**
 * UX15-02a ActionSlip family (handoff F4, F5, F13, §7.3). Every heading, chip, button and state word comes from
 * typed POLICY slip data and the dictionary; payload text is exact content shown before the OwnerStrip and is
 * never truncated. A button exists only when the slip says the current exact revision is approvable.
 */
export type S15SlipKind = "payment" | "deviation" | "production" | "merge" | "publish" | "reply" | "email" | "message" | "calendar" | "website" | "recipient" | "decision" | "generic";

/** Complete canonical payload bytes from the owner-only slip, parsed for structured exact sections. */
export function slipPayload(slip: ActionSlip): JsonValue | null {
  try { return JSON.parse(Buffer.from(slip.payloadBytesBase64, "base64").toString("utf8")) as JsonValue; } catch { return null; }
}
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown) => typeof value === "string" ? value : "";
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** Mail payload of the protected Gmail adapter (`s15-google-effect/v1`, kind `mail`). */
function mailOf(payload: JsonValue | null) {
  const p = record(payload); if (p?.contract !== "s15-google-effect/v1") return null;
  const account = record(p.account), message = record(p.message);
  if (p.kind !== "mail" || !message) return null;
  const attachments = (Array.isArray(p.attachments) ? p.attachments : []).map(record).filter(Boolean).map(a => ({ name: text(a!.name), mediaType: text(a!.mediaType), bytes: Buffer.from(text(a!.dataBase64), "base64").length }));
  return { from: text(account?.account), to: list(message.to), cc: list(message.cc), bcc: list(message.bcc), subject: text(message.subject), body: text(message.body), attachments };
}
/** Exact GitHub effect (`s15-github-effect/v1`) with its closed operation. */
function githubOf(payload: JsonValue | null) {
  const p = record(payload); if (p?.contract !== "s15-github-effect/v1") return null;
  const op = record(p.operation); if (!op) return null;
  return { repository: text(p.repository), target: text(p.target), branch: text(p.branch), base: text(p.base), head: text(p.head), diffHash: text(p.diffHash), issue: typeof p.issue === "number" ? p.issue : null, kind: text(op.kind), title: text(op.title), body: text(op.body), pull: typeof op.pull === "number" ? op.pull : null, thread: text(op.thread) };
}
/** Exact intercepted website request (`s15-browser-request/v1`). */
function websiteOf(payload: JsonValue | null) {
  const p = record(payload); if (p?.contract !== "s15-browser-request/v1") return null;
  return { method: text(p.method), url: text(p.url), contentType: text(p.contentType), body: Buffer.from(text(p.bodyBase64), "base64").toString("utf8") };
}

/** System class of a slip, in priority order. Overlapping classes stay visible as chips. */
export function slipKind(slip: ActionSlip): S15SlipKind {
  const a = slip.action, has = (c: ActionClass) => a.classes.includes(c), payload = slipPayload(slip), gh = githubOf(payload);
  if (has("financial")) return slip.recurring.some(item => item.deviations.length) ? "deviation" : "payment";
  if (has("github_merge")) return has("production") ? "production" : "merge";
  if (has("production")) return "production";
  if (has("major_change")) return "decision";
  if (has("github_publish")) return gh?.kind === "review_reply" ? "reply" : "publish";
  if (has("communication")) { const p = record(payload); return mailOf(payload) ? "email" : p?.contract === "s15-google-effect/v1" && p.kind === "calendar" ? "calendar" : websiteOf(payload) ? "website" : "message"; }
  if (has("disclosure") || has("new_egress")) return "recipient";
  return websiteOf(payload) ? "website" : "generic";
}
const headings: Record<S15SlipKind, string> = { payment: "s15.hold.asks.payment", deviation: "s15.hold.asks.payment", production: "s15.hold.asks.production", merge: "s15.hold.asks.merge", publish: "s15.hold.asks.github_publish", reply: "s15.hold.asks.github_reply", email: "s15.hold.asks.email", message: "s15.hold.asks.message", calendar: "s15.hold.asks.calendar", website: "s15.hold.asks.website", recipient: "s15.hold.asks.recipient", decision: "s15.hold.asks.decision", generic: "s15.hold.asks.generic" };
const primaries: Record<S15SlipKind, string> = { payment: "s15.hold.pay_once", deviation: "s15.hold.pay_this_once", production: "s15.hold.deploy_once", merge: "s15.hold.merge_once", publish: "s15.hold.publish_once", reply: "s15.hold.reply_once", email: "s15.hold.send_once", message: "s15.hold.send_once", calendar: "s15.hold.save_once", website: "s15.hold.do_once", recipient: "s15.hold.allow_once", decision: "s15.hold.do_once", generic: "s15.hold.do_once" };
const verbs: Record<S15SlipKind, string> = { payment: "s15.slip.verb.pay", deviation: "s15.slip.verb.pay", production: "s15.slip.verb.deploy", merge: "s15.slip.verb.merge", publish: "s15.slip.verb.publish", reply: "s15.slip.verb.reply", email: "s15.slip.verb.send", message: "s15.slip.verb.send", calendar: "s15.slip.verb.save", website: "s15.slip.verb.done", recipient: "s15.slip.verb.allow", decision: "s15.slip.verb.done", generic: "s15.slip.verb.done" };
export const slipHeading = (slip: ActionSlip) => tr(key(headings[slipKind(slip)]));

/** A production consequence that this merge would trigger; the production slip must come before merge (S15-D19). */
const deploysOnMerge = (slip: ActionSlip) => slip.action.classes.includes("github_merge") && (slip.action.classes.includes("production") || slip.action.github?.production === "would_deploy" || slip.action.github?.production === "unknown");
function primaryLabel(slip: ActionSlip): string { return tr(key(deploysOnMerge(slip) ? "s15.hold.merge_deploy_once" : primaries[slipKind(slip)])); }

/** The owner's own decision messages on this exact revision, from committed conversation rows. */
export interface S15SlipDecision { row: ConversationOwnerRow; conversationId: string }
/** Typed web decisions are recorded as this canonical explicit command; typed chat decisions keep the owner's words. */
export const webDecisionText = (row: ConversationOwnerRow) => row.decision !== null && row.ownerMessage === `${row.decision.decision} ${row.decision.action.id}`;

/** §6 state of a slip with its one-line owner text. Unknown is never failure; local success is never verified. */
export function slipState(slip: ActionSlip, decisions: S15SlipDecision[] = []): { state: S15State; line: string } {
  const verb = tr(key(verbs[slipKind(slip)]));
  switch (slip.state) {
    case "pending": return { state: "needs_you", line: slip.canApprove ? tr("s15.slip.pending") : `${tr("s15.hold.cannot_approve")} ${codeText(slip.reasonCode)}` };
    case "approved": case "executing": return { state: "working", line: tr("s15.slip.executing") };
    case "succeeded": {
      const ruled = decisions.length === 0 ? ruleLedger(slip) : "";
      return { state: "done", line: `${ruled || verb} · ${tr(slip.observation?.basis === "remote_verified" ? "s15.hold.verified" : "s15.slip.local_only")}` };
    }
    case "failed": return { state: "failed", line: `${tr("s15.slip.failed")} · ${codeText(slip.reasonCode)}` };
    case "unknown": return { state: "unknown", line: tr("s15.hold.unknown") };
    case "changed": return { state: "changed", line: fill("s15.hold.changed", { n: slip.replacement?.revision ?? slip.action.revision + 1 }) };
    case "expired": return { state: "expired", line: tr("s15.slip.expired") };
    case "denied": return { state: "denied", line: tr("s15.slip.denied") };
    case "unsupported": return { state: "unsupported", line: fill("s15.slip.unsupported", { reason: codeText(slip.reasonCode) }) };
    case "stale_rules": return { state: "blocked", line: tr("s15.slip.stale_rules") };
  }
}
/** Ledger wording for an action that a standing rule (not a slip decision) allowed: recurring payment or personal GitHub. */
function ruleLedger(slip: ActionSlip): string {
  const kind = slipKind(slip);
  if (kind === "payment" && slip.recurring.length) return fill("s15.rules.recurring_ledger", { rule: slip.action.policyRevision });
  if (slip.action.classes.includes("github_publish") || slip.action.classes.includes("github_merge")) {
    const gh = githubOf(slipPayload(slip));
    return fill(gh?.kind === "merge" ? "s15.github.ledger_merge" : gh?.kind === "push" ? "s15.github.ledger_push" : "s15.github.ledger_publish", { n: slip.action.policyRevision });
  }
  return "";
}

const classChips = (slip: ActionSlip) => `<div class="s15-chips" aria-label="${tr("s15.slip.classes")}">${slip.action.classes.map(name => `<span class="s-chip">${tr(key(`s15.class.${name}`))}</span>`).join("")}</div>`;
/** Exact amount in minor units with the trusted currency precision; no float arithmetic. */
export function exactAmount(minor: string, minorUnit: number, currency: string): string {
  const digits = minor.replace(/^0+(?=\d)/, "").padStart(minorUnit + 1, "0");
  return `${minorUnit ? `${digits.slice(0, -minorUnit)}.${digits.slice(-minorUnit)}` : digits} ${currency}`;
}
const kv = (rows: [string, string][]) => `<dl class="s-kv s15-exact-kv">${rows.map(([label, value]) => `<dt>${e(label)}</dt><dd>${value}</dd>`).join("")}</dl>`;
const mono = (value: string) => `<span class="s-mono s15-break">${e(value)}</span>`;
const exactBlock = (value: string, label: string) => `<div><p class="s-exact-label">${e(label)}</p><pre class="s-exact">${e(value)}</pre></div>`;
const short = (hash: string) => hash.slice(0, 12);

/** The one-line who/what of a compact slip, from typed fields only. */
function slipSummary(slip: ActionSlip): string {
  const t = slip.action.transaction, payload = slipPayload(slip), mail = mailOf(payload), gh = githubOf(payload), web = websiteOf(payload);
  if (t) return `${exactAmount(t.amountMinor, t.minorUnit, t.currency)} → ${t.payee.id}`;
  if (mail) return `${mail.to.join(", ")} · ${mail.subject}`;
  if (gh) return `${gh.repository}${gh.pull !== null ? ` #${gh.pull}` : gh.issue !== null ? ` #${gh.issue}` : ""} · ${gh.kind}`;
  if (web) return `${web.method} ${web.url}`;
  return slip.action.recipients.length ? slip.action.recipients.map(r => r.id).join(", ") : slip.action.operation;
}

/** Compact slip in the thread and on Needs you: class, who/what and the link to decide on the complete content. */
export function compactSlip(slip: ActionSlip, decisions: S15SlipDecision[] = []): string {
  const { state, line } = slipState(slip, decisions), href = `/actions/${e(slip.action.id)}${slip.state === "changed" ? `?r=${slip.action.revision}` : ""}`;
  return `<div class="s15-slip-compact" data-state="${e(slip.state)}"><p class="s-row"><b class="s-grow">${e(slipHeading(slip))}</b>${statePill(state)}</p>${classChips(slip)}
    <p class="s15-text s15-break">${e(slipSummary(slip))}</p><p class="s-meta">r${slip.action.revision} · ${e(line)}</p>${decisionLine(slip, decisions)}<p><a class="s-link-text" href="${href}">${tr(slip.state === "pending" ? "s15.slip.review_decide" : "s15.slip.open")}</a></p></div>`;
}
/** "Approved by your message at …" from the committed owner decision row of this exact revision. */
function decisionLine(slip: ActionSlip, decisions: S15SlipDecision[]): string {
  const row = decisions.find(item => item.row.decision?.action.revision === slip.action.revision)?.row; if (!row?.decision) return "";
  const time = clockText(row.receipt.receivedAt) + " UTC", approve = row.decision.decision === "approve";
  const label = webDecisionText(row) ? fill(approve ? "s15.hold.from_page" : "s15.hold.denied_page", { time }) : fill(approve ? "s15.hold.from_message" : "s15.hold.denied_message", { time });
  const conversation = decisions.find(item => item.row === row)!.conversationId;
  return `<p class="s-meta">${webDecisionText(row) ? e(label) : `<a class="s-link-text" href="/chats/${e(conversation)}#s15-row-${e(row.requestId)}">${e(label)}</a>`}</p>`;
}

/** Everything the full slip needs besides the slip itself. */
export interface S15SlipPage {
  csrf: string; conversationId: string; slip: ActionSlip; decisions: S15SlipDecision[]; policy: StandingPolicy | null;
  /** Newer revision when this one changed, for the diff. */
  replacement: ActionSlip | null;
  card: S15DecisionCard | null; canDecide: boolean; canCheck: boolean; recurring: boolean; refused: string | null; checked: boolean;
}

/** Class-specific exact sections, all from the prepared action and its complete payload. */
function exactSections(page: S15SlipPage): string {
  const slip = page.slip, a = slip.action, payload = slipPayload(slip), kind = slipKind(slip), parts: string[] = [];
  const mail = mailOf(payload), gh = githubOf(payload), web = websiteOf(payload), t = a.transaction;
  if (mail) {
    parts.push(kv([[tr("s15.slip.from"), mono(mail.from)], [tr("s15.slip.to"), mail.to.map(mono).join("<br>") || "—"], [tr("s15.slip.cc"), mail.cc.map(mono).join("<br>") || "—"], [tr("s15.slip.bcc"), mail.bcc.map(mono).join("<br>") || "—"], [tr("s15.slip.subject"), `<span class="s15-text">${e(mail.subject)}</span>`]]));
    parts.push(exactBlock(mail.body, tr("s15.slip.body")));
    parts.push(`<div><p class="s-exact-label">${tr("s15.slip.attachments")}</p>${mail.attachments.length ? `<ul class="s15-facts">${mail.attachments.map((file, index) => `<li>${mono(file.name)} · ${e(file.mediaType)} · ${fill("s15.slip.bytes", { n: file.bytes })} · <a class="s-link-text" href="/actions/${e(a.id)}/attachments/${index}?r=${a.revision}" download>${tr("s15.slip.open_file")}</a></li>`).join("")}</ul>` : `<p class="s-sub">${tr("s15.slip.no_attachments")}</p>`}</div>`);
  } else if (gh) {
    const rows: [string, string][] = [[tr("s15.slip.repository"), mono(gh.repository)], [tr("s15.slip.branch"), `${mono(gh.base)} → ${mono(gh.branch || gh.target)}`], [tr("s15.slip.head"), mono(gh.head)], [tr("s15.slip.diff"), `${mono(short(gh.diffHash))} <span class="s-meta">${tr("s15.slip.diff_note")}</span>`]];
    if (gh.pull !== null) rows.push([tr("s15.slip.pull"), mono(`#${gh.pull}`)]);
    if (gh.thread) rows.push([tr("s15.slip.thread"), mono(gh.thread)]);
    parts.push(kv(rows));
    if (gh.title) parts.push(exactBlock(gh.title, tr("s15.slip.pr_title")));
    if (gh.body) parts.push(exactBlock(gh.body, tr(gh.kind === "review_reply" ? "s15.slip.reply_body" : "s15.slip.pr_body")));
  } else if (web) {
    parts.push(kv([[tr("s15.slip.method"), mono(web.method)], [tr("s15.slip.url"), mono(web.url)], [tr("s15.slip.content_type"), mono(web.contentType)]]));
    parts.push(exactBlock(web.body || "—", tr("s15.slip.request_body")));
  }
  if (t) {
    const one = slip.recurring.length && !slip.recurring.some(item => item.deviations.length) ? tr("s15.slip.recurring") : tr("s15.slip.one_time");
    parts.push(kv([[tr("s15.slip.payee"), mono(t.payee.id)], [tr("s15.slip.account"), mono(t.account.id)], [tr("s15.slip.amount"), `<b class="s-mono">${e(exactAmount(t.amountMinor, t.minorUnit, t.currency))}</b>`], [tr("s15.slip.kind"), e(one)], [tr("s15.slip.reference"), mono(`${t.quoteId} · ${t.quoteVersion}`)], [tr("s15.slip.quote_expires"), clock(t.quoteExpiresAt)]]));
    const memo = text(record(payload)?.memo);
    if (memo) parts.push(untrusted(`<pre class="s-exact">${e(memo)}</pre>`, tr("s15.slip.memo")));
  }
  for (const item of slip.recurring) if (item.deviations.length) parts.push(`<div class="s15-deviation">${banner("warn", fill("s15.rules.deviates", { rule: item.rule.id }), item.deviations.map(code => tr(key(`s15.rules.deviation.${code}`))).join(" · "))}</div>`);
  if (a.github) parts.push(githubChecklist(slip));
  const disclosure = (a as { disclosure?: { recipients: { id: string }[]; purpose: { id: string }; sources: { ref: { id: string }; classification: string }[]; dataClasses: string[]; exactBytes: { length: number; sha256: string } } }).disclosure;
  if (kind === "recipient" || disclosure) {
    const rows: [string, string][] = [[tr("s15.slip.recipients"), (disclosure?.recipients ?? a.recipients).map(r => mono(r.id)).join("<br>") || "—"]];
    if (disclosure) rows.push([tr("s15.slip.data"), disclosure.sources.map(s => `${mono(s.ref.id)} · ${e(trMaybe(`s15.slip.data_class.${s.classification}`) ?? s.classification)}`).join("<br>") || "—"], [tr("s15.slip.purpose"), mono(disclosure.purpose.id)], [tr("s15.slip.exact_bytes"), `${fill("s15.slip.bytes", { n: disclosure.exactBytes.length })} · ${mono(short(disclosure.exactBytes.sha256))}`]);
    parts.push(kv(rows), `<p class="s-note">${tr("s15.slip.new_recipient")}</p>`);
  } else if (!mail && !t && a.recipients.length) parts.push(kv([[tr("s15.slip.recipients"), a.recipients.map(r => mono(r.id)).join("<br>")]]));
  if (a.resources.length) parts.push(kv([[tr("s15.slip.resources"), a.resources.map(r => mono(r.id)).join(" · ")]]));
  // The complete canonical payload always follows; when no structured section exists it is the exact content itself.
  const raw = (() => { try { return JSON.stringify(payload, null, 2); } catch { return Buffer.from(slip.payloadBytesBase64, "base64").toString("utf8"); } })();
  const structured = !!(mail || gh || web || t);
  parts.push(structured ? `<details class="s-more"><summary>${tr("s15.slip.all_exact")}</summary>${exactBlock(raw, tr("s15.slip.exact_payload"))}</details>` : exactBlock(raw, tr("s15.slip.exact_payload")));
  return parts.join("");
}

/** F5 auto-merge eligibility and production consequence rows, from protected `GithubConditions` only. */
function githubChecklist(slip: ActionSlip): string {
  const g = slip.action.github!, row = (ok: boolean, label: string) => `<li>${ok ? "✓" : "×"} ${e(label)} <span class="sr-only">${tr(ok ? "s15.slip.passed" : "s15.slip.not_passed")}</span></li>`;
  const production = tr(key(`s15.github.production.${g.production}`));
  const warn = deploysOnMerge(slip) ? `<div role="note">${banner("warn", tr("s15.github.prod_before_merge"))}</div>` : "";
  return `<section class="s15-checklist" aria-label="${tr("s15.github.checklist")}"><h4 class="s-section-t">${tr("s15.github.checklist")}</h4><ul class="s15-facts">${row(!!g.head, `${tr("s15.github.check.head")}: ${short(g.head)}`)}${row(g.acceptancePassed, tr("s15.github.check.acceptance"))}${row(g.checksPassed, tr("s15.github.check.checks"))}${row(g.reviewsPassed, tr("s15.github.check.reviews"))}${row(g.production === "none" || g.production === "protected_gate", `${tr("s15.github.check.production")}: ${production}`)}</ul>
    ${slip.action.classes.includes("production") ? `<p class="s-note">${tr(g.deploymentFence ? "s15.github.rollback_known" : "s15.github.rollback_unknown")}</p>` : ""}${warn}</section>`;
}

/** F5 profile badge: personal only when an installed personal rule names this repository and target. */
export function profileBadge(slip: ActionSlip, policy: StandingPolicy | null): string {
  const g = slip.action.github; if (!g) return "";
  const rule = policy?.rules.find(r => r.mode.startsWith("personal_github") && r.github && r.github.repository.id === g.repository.id && r.github.target === g.target);
  return `<a class="s-chip s15-badge" href="/rules#s15-rules-github">${rule ? fill("s15.github.personal", { n: policy!.revision }) : tr("s15.github.default")}</a>`;
}

/** F4 DecisionCard: options are system rows, the recommendation is untrusted text, and a retained direction is never re-asked. */
function decisionCard(page: S15SlipPage): string {
  const card = page.card!, slip = page.slip;
  const impacts = card.impacts.map(code => e(trMaybe(`s15.decision.impact.${code}`) ?? code)).join(" · ");
  const evidence = card.evidence.length ? `<ul class="s15-facts">${card.evidence.map(item => `<li>${pill(tr(key(`s15.decision.evidence.${item.status}`)), item.status === "fact" ? "ok" : "warn")} ${untrusted(`<p class="s15-text">${e(item.value)}</p>`, tr("s15.decision.evidence_source"))}<span class="s-meta s-mono">${e(item.id)} r${item.revision}</span></li>`).join("")}</ul>` : `<p class="s-sub">${tr("s15.result.no_evidence")}</p>`;
  if (card.retained) return `<section class="s15-decision"><p><b>${impacts}</b></p>${banner("", fill("s15.decision.already", { date: clockText(card.retained.at) + " UTC", option: tr(key(`s15.decision.option.${card.retained.option}`)) }))}</section>`;
  // Option rows describe consequences only; their controls live in the OwnerStrip after the exact content (§7.3).
  const options = card.options.map(option => `<li class="s15-option"><p><b>${tr(key(`s15.decision.option.${option.id}`))}</b> · ${tr(option.reversible ? "s15.decision.reversible" : "s15.decision.irreversible")}</p><p class="s-sub s15-text">${e(option.consequence)}</p></li>`).join("");
  return `<section class="s15-decision" aria-label="${tr("s15.hold.asks.decision")}"><p><b>${impacts || e(tr("s15.hold.asks.decision"))}</b></p>${kv([[tr("s15.decision.target"), `${mono(card.target)} · v${card.version}`]])}
    <h4 class="s-section-t">${tr("s15.decision.evidence")}</h4>${evidence}<ul class="s15-options">${options}</ul>${untrusted(`<p class="s15-text">${tr(key(`s15.decision.option.${card.recommendation.option}`))}: ${e(card.recommendation.text)}</p>`, tr("s15.decision.recommend"))}</section>`;
}

const refFields = (page: S15SlipPage) => `${hidden("conversationId", page.conversationId)}${hidden("actionId", page.slip.action.id)}${hidden("revision", page.slip.action.revision)}${hidden("actionHash", page.slip.action.actionHash)}`;
function decideForm(page: S15SlipPage, decision: "approve" | "deny", label: string, tone = ""): string {
  return form("/s15/forms/action/decide", page.csrf, `${refFields(page)}${hidden("decision", decision)}<button class="s-btn${tone ? ` ${tone}` : ""}">${e(label)}</button>`);
}

/** OwnerStrip for the current state. The primary is never focused by default and has no shortcut (§9). */
function controls(page: S15SlipPage): string {
  const slip = page.slip, kind = slipKind(slip), conv = e(page.conversationId), id = e(slip.action.id);
  const revise = `<a class="s-btn" href="/chats/${conv}?revise=${id}#s15-text">${tr("s15.hold.revise")}</a>`;
  const again = `<a class="s-btn" href="/chats/${conv}?again=${id}#s15-text">${tr("s15.slip.prepare_again")}</a>`;
  switch (slip.state) {
    case "pending": {
      if (!page.canDecide) return ownerStrip(revise, tr("s15.slip.no_decide_port"));
      if (kind === "decision" && page.card) {
        if (page.card.retained) return "";
        // One control per system option, below the exact content; "keep" is the denial of this exact revision.
        const buttons = page.card.options.map(option => option.id === "apply_exact" ? (slip.canApprove ? decideForm(page, "approve", tr("s15.decision.option.apply_exact"), "primary") : "")
          : option.id === "keep" ? decideForm(page, "deny", tr("s15.decision.option.keep"))
          : `<a class="s-btn" href="/chats/${conv}?again=${id}&amp;mode=investigate#s15-text">${tr("s15.decision.option.investigate")}</a>`).join("");
        return ownerStrip(`${buttons}${page.card.options.some(option => option.id === "keep") ? "" : decideForm(page, "deny", tr("s15.decision.not_now"))}${revise}`, slip.canApprove ? tr("s15.hold.single_use") : `${tr("s15.hold.cannot_approve")} ${codeText(slip.reasonCode)}`);
      }
      const primary = slip.canApprove ? decideForm(page, "approve", primaryLabel(slip), "primary") : "";
      const note = slip.canApprove ? tr("s15.hold.single_use") : slip.reasonCode === "adapter_unproven" ? tr("s15.hold.unsupported") : `${tr("s15.hold.cannot_approve")} ${codeText(slip.reasonCode)}`;
      const recurring = page.recurring && kind === "payment" && slip.action.classes.every(c => c === "financial") ? `<p class="s15-secondary"><a class="s-link-text" href="/rules/recurring?from=${id}&amp;r=${slip.action.revision}">${tr("s15.rules.recurring_from_payment")}</a> <span class="s-meta">${tr("s15.rules.recurring_separate")}</span></p>` : "";
      return ownerStrip(`${primary}${decideForm(page, "deny", tr("s15.hold.deny"))}${revise}`, note, "", recurring);
    }
    case "unknown": {
      const check = page.canCheck ? form("/s15/forms/action/check", page.csrf, `${refFields(page)}<button class="s-btn">${tr("s15.recovery.check_again")}</button>`) : "";
      const statements = page.canCheck ? `<fieldset class="s15-statement"><legend>${tr("s15.slip.tell_outcome")}</legend><div class="s-strip-acts">${(["occurred", "did_not_occur"] as const).map(outcome => form("/s15/forms/action/statement", page.csrf, `${refFields(page)}${hidden("outcome", outcome)}<button class="s-btn">${tr(key(`s15.slip.statement.${outcome}`))}</button>`)).join("")}</div><p class="s-note">${tr("s15.slip.statement_note")}</p></fieldset>` : "";
      const said = slip.statements.length ? `<p class="s-sub">${slip.statements.map(item => fill("s15.slip.you_said", { outcome: tr(key(`s15.slip.statement.${item.outcome}`)) })).join(" · ")}</p>` : "";
      return ownerStrip(check || `<span class="s-sub">${tr("s15.slip.no_check_port")}</span>`, tr("s15.slip.unknown_note"), "", `${said}${statements}`);
    }
    case "changed": return slip.replacement ? `<div class="s-strip"><div class="s-strip-acts"><a class="s-btn primary" href="/actions/${id}?r=${slip.replacement.revision}">${fill("s15.slip.open_revision", { n: slip.replacement.revision })}</a></div></div>` : "";
    case "expired": case "stale_rules": return `<div class="s-strip"><div class="s-strip-acts">${again}</div></div>`;
    case "failed": return `<div class="s-strip"><div class="s-strip-acts">${revise}</div></div>`;
    default: return "";
  }
}

/** Line diff between two exact revisions. Bounded, ordered, and never hides a changed line. */
function revisionDiff(before: ActionSlip, after: ActionSlip): string {
  const lines = (slip: ActionSlip) => JSON.stringify(slipPayload(slip), null, 2).split("\n").slice(0, 400);
  const old = lines(before), next = lines(after), oldSet = new Set(old), nextSet = new Set(next);
  const removed = old.filter(line => !nextSet.has(line)), added = next.filter(line => !oldSet.has(line));
  if (!removed.length && !added.length) return `<p class="s-sub">${tr("s15.slip.diff_metadata")}</p>`;
  return `<div class="s15-diff" aria-label="${tr("s15.slip.diff_title")}"><p class="s-exact-label">${fill("s15.slip.diff_between", { a: before.action.revision, b: after.action.revision })}</p><pre class="s-exact">${removed.map(line => `<span class="s-diff-old"><span class="sr-only">${tr("s15.slip.removed")} </span>${e(line)}</span>`).join("\n")}${removed.length && added.length ? "\n" : ""}${added.map(line => `<span class="s-diff-new"><span class="sr-only">${tr("s15.slip.added")} </span>${e(line)}</span>`).join("\n")}</pre></div>`;
}

/** Full ActionSlip at `/actions/:id`: heading, chips, exact content, meta, then the OwnerStrip (§7.3). */
export function fullSlip(page: S15SlipPage): string {
  const slip = page.slip, a = slip.action, { state, line } = slipState(slip, page.decisions);
  const coverage = slip.recurring.length ? fill("s15.rules.recurring_applies", { rule: slip.recurring[0]!.rule.id }) : tr("s15.hold.no_rule");
  const meta = `<p class="s-meta">r${a.revision} · ${slip.state === "pending" ? `${tr("s15.slip.expires")} ${clock(slip.expiresAt)} · ` : ""}${e(coverage)} · ${fill("s15.intent.under_rule", { n: a.policyRevision })}</p>`;
  const observed = slip.observation && (slip.observation as { evidence?: unknown }).evidence !== undefined ? `<details class="s-more"><summary>${tr("s15.slip.evidence")}</summary>${exactBlock(JSON.stringify((slip.observation as { evidence?: unknown }).evidence, null, 2), tr(slip.observation.basis === "remote_verified" ? "s15.vm.verified_outside" : "s15.slip.local_only"))}</details>` : "";
  const notices = `${page.refused ? `<div role="alert">${banner("warn", codeText(page.refused), "", `<p class="s-mono s-meta">${e(page.refused)}</p>`)}</div>` : ""}${page.checked ? `<div role="status">${banner(slip.state === "unknown" ? "" : "ok", tr(slip.state === "unknown" ? "s15.slip.still_unknown" : "s15.slip.check_done"))}</div>` : ""}`;
  const diff = slip.state === "changed" && page.replacement ? revisionDiff(slip, page.replacement) : "";
  return `${notices}<article class="s-slip s15-slip" data-state="${slip.state === "pending" ? "open" : slip.state === "unknown" ? "unknown" : "closed"}" aria-labelledby="s15-slip-title">
    <div class="s-slip-hd"><div><h2 id="s15-slip-title" tabindex="-1">${e(slipHeading(slip))}</h2>${classChips(slip)}${profileBadge(slip, page.policy)}</div>${statePill(state)}</div>
    <div class="s-slip-body"><p class="s15-state-line">${e(line)}</p>${decisionLine(slip, page.decisions)}${page.card && slipKind(slip) === "decision" ? decisionCard(page) : ""}${exactSections(page)}${diff}${observed}${meta}</div>
    ${controls(page)}</article><p class="s-note">${icon("info")} ${tr("s15.slip.authority_note")}</p>`;
}
