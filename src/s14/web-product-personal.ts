import { dictionaries, type Locale } from "../i18n";
import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import type { S14Application, S14Command, S14Receipt } from "./application";
import type { ScopeRef, WorkView } from "./authority-types";
import type { PersonalDraft, PersonalDraftContent, PersonalEffectReceipt, PersonalEffectView, PersonalEventDraft } from "./personal-effect-types";
import type { PersonalClient, PersonalConnection, PersonalFlow, PersonalGrant, PersonalRead, PersonalReceipt, PersonalScope } from "./personal-types";
import type { ReportGap } from "./report-types";
import type { Bot, Home, OwnerActor } from "./types";
import { committed } from "./web-product-memory";

type Settings = ReturnType<S14Application["personal"]["settings"]>;
/** What Google will think of this installation's address. Only `https` works from another device; `private` is https on a name Google may refuse. */
export type S14GoogleAddress = "https" | "private" | "loopback";
/** The exact address to register with Google, derived from the configured origin so the owner never types it. */
export interface S14GoogleRedirect { uri: string; address: S14GoogleAddress }
/** The live state of one connection's sign-in, read from its latest flow. `url` is the owner-only Google address and appears only while the link can work. */
export type S14GoogleFlowStep = { step: "none" } | { step: "open"; url: string; expiresAt: number } | { step: "finish"; flowId: string; expiresAt: number } | { step: "exchanging" } | { step: "expired" };
/** Where one Bot stands with one account. `slot` and `expected` are what a Grant press pins; a label here grants nothing, because the service rechecks all of it. */
export interface S14AccountBot { bot: Bot; state: "granted" | "ready" | "stale" | "needs_ceiling" | "no_slot"; grant: PersonalGrant | null; slot: string | null; expected: number; tools: string[] }
/** `/settings/google`: what exists and the one next action. Secrets never reach this surface. */
export interface S14GoogleHome { kind: "google"; read: Settings; redirect: S14GoogleRedirect; receipt: PersonalReceipt | null; notice: string | null }
/** `/settings/google/guide`: one numbered step per page, so the position lives in the address and needs no script. */
export interface S14GoogleGuide { kind: "google-guide"; step: number; client: PersonalClient | null; open: number; redirect: S14GoogleRedirect; notice: string | null; clientId: string }
/** `/settings/google/new`: one connection form for one service. Values are kept across a refusal, and none is authority until the command commits. */
export interface S14GoogleNew { kind: "google-new"; service: "gmail" | "calendar"; client: PersonalClient | null; notice: string | null; draft: { account: string; calendarId: string; read: boolean; write: boolean } }
/** `/settings/google/connections/:id`. `receipt` is reread, so a link cannot fake a landing banner. */
export interface S14GoogleConnection { kind: "google-connection"; connection: PersonalConnection; client: PersonalClient | null; step: S14GoogleFlowStep; bots: S14AccountBot[]; revoke: boolean; receipt: PersonalReceipt | null; notice: string | null }
/** Form values of one held draft, typed the way the owner sees them. */
export interface S14DraftForm { to: string; cc: string; bcc: string; subject: string; body: string; summary: string; location: string; description: string; start: string; end: string; timezone: string; recurrence: string; attendees: string; sendUpdates: string }
/** `/effects/:id?edit=1`: owner edit of a held draft. Saving makes a new unapproved card. */
export interface S14DraftEdit { kind: "google-draft-edit"; card: S14DraftCard; form: S14DraftForm; notice: string | null }
/** Personal surfaces added to the product view union. */
export type S14PersonalSurface = S14GoogleHome | S14GoogleGuide | S14GoogleNew | S14GoogleConnection | S14DraftEdit;

/** One account a start form may name. A row is display data: `work.start` and `routine.enable` recheck the Bot, slot, revision and consent. */
export interface S14AccountChoice { scopeId: string; revision: number; botId: string; service: "gmail" | "calendar"; account: string; read: boolean }
/** One account that needs the owner, for Home and Work. */
export interface S14GoogleNeed { connectionId: string; service: "gmail" | "calendar"; account: string; need: "finish" | "sign_in" }
/** One exact draft with what the card can still do. `usable` is a courtesy: the service rechecks consent and scope at claim and before every request. */
export interface S14DraftCard { view: PersonalEffectView; connection: PersonalConnection | null; usable: boolean }
/** Personal query data every signed-in page needs. It proves nothing about authority. */
export interface S14PersonalOverview { accounts: S14AccountChoice[]; needs: S14GoogleNeed[]; drafts: Record<string, S14DraftCard> }
/** Sourced inputs of one work item. `gaps` are the service's typed gaps, so an input never read is listed even when every read that did happen succeeded. */
export interface S14Brief { status: "complete" | "partial" | "missing"; sections: PersonalRead[]; gaps: Extract<ReportGap, { kind: "read" }>[]; connections: Record<string, PersonalConnection>; slots: Record<string, PersonalConnection> }

const identityPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const single = (fields: Record<string, unknown>, key: string) => { const v = fields[key]; return typeof v === "string" ? v : ""; };
function allow(fields: Record<string, unknown>, keys: readonly string[]): void { for (const key of Object.keys(fields)) if (!keys.includes(key)) throw new AppError("invalid_body"); }
const writeScope = { gmail: "gmail.send", calendar: "calendar.events" } as const satisfies Record<string, PersonalScope>;
const readScope = { gmail: "gmail.readonly", calendar: "calendar.readonly" } as const satisfies Record<string, PersonalScope>;
/** Whether this connection may read inbox or calendar content, the question behind briefs, verification and read-back. */
export const canRead = (connection: PersonalConnection) => connection.scopes.includes(readScope[connection.service]);
/** Whether this connection may send or change anything. */
export const canWrite = (connection: PersonalConnection) => connection.scopes.includes(writeScope[connection.service]);

/** The callback address of this installation. Google refuses raw IPs and many private names, so such a name is flagged before the owner registers it. */
export function googleRedirect(origin: string): S14GoogleRedirect {
  const url = new URL(origin), uri = `${url.origin}/s14/personal/oauth/callback`, host = url.hostname;
  if (["localhost", "127.0.0.1", "[::1]"].includes(host)) return { uri, address: "loopback" };
  return { uri, address: /^[0-9.]+$/.test(host) || host.startsWith("[") || !host.includes(".") || /\.(local|internal|lan|home|corp)$/i.test(host) ? "private" : "https" };
}
function flowStep(app: S14Application, actor: OwnerActor, connection: PersonalConnection, flows: PersonalFlow[]): S14GoogleFlowStep {
  const flow = flows.filter(item => item.connectionId === connection.id).at(-1);
  if (connection.state !== "authorizing" || !flow) return { step: "none" };
  if (flow.state === "exchanging") return { step: "exchanging" };
  if (flow.expiresAt <= app.now() || flow.connectionRevision !== connection.revision) return { step: "expired" };
  if (flow.state === "received") return { step: "finish", flowId: flow.id, expiresAt: flow.expiresAt };
  if (flow.state !== "pending") return { step: "expired" };
  try { return { step: "open", ...app.personal.authorization(actor, flow.id) }; }
  catch (error) { if (error instanceof AppError) return { step: "expired" }; throw error; }
}
/** Tools a Bot needs before this account is useful to it. The owner still reads and accepts the exact ceiling. */
const wantedTools = (app: S14Application, connection: PersonalConnection) => [...(canRead(connection) ? ["personal_read"] : []), ...(canWrite(connection) ? [connection.service === "gmail" ? "effect_send" : "effect_calendar"] : [])].filter(tool => app.policy.tools.includes(tool));
/** Slots `personal.grant.set` accepts today: free identities the installation configured. Built-in share slots are not accepted by that command. */
const accountSlots = (app: S14Application, actor: OwnerActor) => app.sharing.freeSlots(actor).filter(slot => app.policy.resources.includes(slot.scopeId));
function accountBots(app: S14Application, actor: OwnerActor, connection: PersonalConnection, read: Settings, state: Home): S14AccountBot[] {
  const free = accountSlots(app, actor), wanted = wantedTools(app, connection);
  return state.bots.filter(bot => bot.enabled).map(bot => {
    const held = read.grants.filter(item => item.connectionId === connection.id && item.botId === bot.id), grant = held.find(item => item.active) ?? held.at(-1) ?? null;
    const tools = wanted.filter(tool => !bot.capabilities.tools.includes(tool)), ceiling = (id: string) => bot.capabilities.resources.includes(id);
    if (grant?.active && grant.botGeneration === bot.generation && ceiling(grant.id)) return { bot, state: "granted", grant, slot: grant.id, expected: grant.revision, tools };
    const own = grant && ceiling(grant.id) ? grant : null, slot = own?.id ?? free.find(item => item.receiverBotIds.includes(bot.id))?.scopeId ?? null;
    if (slot && !tools.length) return { bot, state: own?.active ? "stale" : "ready", grant, slot, expected: own?.revision ?? 0, tools };
    const open = slot ?? free.find(item => !item.receiverBotIds.length)?.scopeId ?? free[0]?.scopeId ?? null;
    return open ? { bot, state: "needs_ceiling", grant, slot: open, expected: 0, tools } : { bot, state: "no_slot", grant, slot: null, expected: 0, tools };
  });
}
function draftCard(read: Settings, view: PersonalEffectView): S14DraftCard {
  const connection = read.connections.find(item => item.id === view.draft.connectionId) ?? null, grant = read.grants.find(item => item.id === view.draft.scope.id);
  return { view, connection, usable: !!view.draft.content && connection?.state === "connected" && connection.revision === view.draft.connectionRevision && !!grant?.active && grant.revision === view.draft.scope.revision };
}
/** Accounts, needs and exact drafts for the page overview. It reads records only. */
export function personalOverview(app: S14Application, actor: OwnerActor, views: WorkView[], state: Home): S14PersonalOverview {
  const read = app.personal.settings(actor), usable = (connection: PersonalConnection | undefined): connection is PersonalConnection => connection?.state === "connected";
  const accounts = read.grants.flatMap(grant => { const connection = read.connections.find(item => item.id === grant.connectionId), bot = state.bots.find(item => item.id === grant.botId); return grant.active && usable(connection) && bot?.enabled && bot.generation === grant.botGeneration ? [{ scopeId: grant.id, revision: grant.revision, botId: grant.botId, service: connection.service, account: connection.account, read: canRead(connection) }] : []; });
  const needs = read.connections.flatMap((connection): S14GoogleNeed[] => { const step = flowStep(app, actor, connection, read.flows), base = { connectionId: connection.id, service: connection.service, account: connection.account }; return step.step === "finish" ? [{ ...base, need: "finish" }] : connection.state === "reauth_required" ? [{ ...base, need: "sign_in" }] : []; });
  const drafts = views.filter(view => view.effects.some(effect => effect.action.kind === "send" || effect.action.kind === "calendar")).flatMap(view => app.personal.effects.list(actor, view.work.id)).map(view => draftCard(read, view));
  return { accounts, needs, drafts: Object.fromEntries(drafts.map(card => [card.view.effect.id, card])) };
}
/** Sourced inputs of one work item, or null when its grant never named account reads. */
export function personalBrief(app: S14Application, actor: OwnerActor, view: WorkView): S14Brief | null {
  if (!view.grant?.tools.includes("personal_read")) return null;
  const brief = app.personal.reads.brief(actor, view.work.id), read = app.personal.settings(actor), gaps = app.store.read(tx => { app.requireOwner(tx, actor); return app.personal.reads.gaps(tx, view.work.id); });
  const unread = gaps.some(gap => gap.personal?.missing.includes("required_input_missing"));
  return { status: brief.status === "complete" && unread ? "partial" : brief.status, sections: brief.sections, gaps, connections: Object.fromEntries(read.connections.map(item => [item.id, item])), slots: Object.fromEntries(read.grants.flatMap(grant => { const connection = read.connections.find(item => item.id === grant.connectionId); return connection ? [[grant.id, connection]] : []; })) };
}

/** Exact field values of a stored draft, one recipient per line. */
function formOf(content: PersonalDraftContent | null): S14DraftForm {
  const empty: S14DraftForm = { to: "", cc: "", bcc: "", subject: "", body: "", summary: "", location: "", description: "", start: "", end: "", timezone: "", recurrence: "", attendees: "", sendUpdates: "none" };
  if (content?.kind === "mail") return { ...empty, to: content.to.join("\n"), cc: content.cc.join("\n"), bcc: content.bcc.join("\n"), subject: content.subject, body: content.body };
  if (content?.kind !== "event") return empty;
  return { ...empty, timezone: content.timezone, sendUpdates: content.sendUpdates, ...(content.event ? { summary: content.event.summary, location: content.event.location, description: content.event.description, start: content.event.start, end: content.event.end, recurrence: content.event.recurrence.join("\n"), attendees: content.event.attendees.join("\n") } : {}) };
}
const editable = (view: PersonalEffectView) => !!view.draft.content && ["pending", "approved"].includes(view.effect.state);
/** Resolves the Google pages and the draft edit page; null leaves the path to the other product surfaces. Everything here reads. */
export function personalView(app: S14Application, url: URL, actor: OwnerActor, state: Home): S14PersonalSurface | null {
  const path = url.pathname, redirect = googleRedirect(url.origin);
  const effect = /^\/effects\/([a-zA-Z0-9_-]{1,128})$/.exec(path);
  if (effect) {
    if (url.searchParams.get("edit") !== "1") return null;
    const effectView = app.authority.effect(actor, effect[1]!).effect, read = app.personal.settings(actor), view = app.personal.effects.list(actor, effectView.workId).find(item => item.effect.id === effectView.id);
    return view && editable(view) ? { kind: "google-draft-edit", card: draftCard(read, view), form: formOf(view.draft.content), notice: null } : null;
  }
  if (!path.startsWith("/settings/google")) return null;
  const read = app.personal.settings(actor), receipt = committed<PersonalReceipt>(app, actor, url, "personal.");
  if (path === "/settings/google") return { kind: "google", read, redirect, receipt, notice: null };
  if (path === "/settings/google/guide") {
    const step = Number(url.searchParams.get("step") ?? "1");
    return { kind: "google-guide", step: Number.isInteger(step) && step >= 1 && step <= 6 ? step : 1, client: read.client, open: read.connections.filter(item => item.state !== "revoked").length, redirect, notice: null, clientId: "" };
  }
  if (path === "/settings/google/new") return { kind: "google-new", service: url.searchParams.get("service") === "calendar" ? "calendar" : "gmail", client: read.client, notice: null, draft: { account: "", calendarId: "primary", read: true, write: false } };
  const match = /^\/settings\/google\/connections\/([a-zA-Z0-9_-]{1,128})$/.exec(path); if (!match) throw new AppError("not_found", 404);
  const connection = read.connections.find(item => item.id === match[1]); if (!connection) throw new AppError("not_found", 404);
  return { kind: "google-connection", connection, client: read.client, step: flowStep(app, actor, connection, read.flows), bots: connection.state === "connected" ? accountBots(app, actor, connection, read, state) : [], revoke: url.searchParams.get("action") === "revoke" && connection.state !== "revoked", receipt: receipt && connectionOf(receipt) === connection.id ? receipt : null, notice: null };
}
const connectionOf = (receipt: PersonalReceipt) => receipt.connection?.id ?? receipt.grant?.connectionId ?? null;

/** Connection label: the owner names an account, and repeating that name is all a label is for. It fits the service's 80-byte limit on a code-point boundary. */
function labelOf(service: "gmail" | "calendar", account: string): string {
  let label = service === "gmail" ? "Gmail " : "Calendar ";
  for (const char of account) { if (Buffer.byteLength(label + char) > 80) break; label += char; }
  return label;
}
const lines = (value: string) => value.split(/[\n,;]/).map(item => item.trim()).filter(Boolean);
function contentOf(stored: PersonalDraft, fields: Record<string, unknown>): PersonalDraftContent {
  const content = stored.content; if (!content) throw new AppError("personal_draft_changed", 409);
  const field = (key: keyof S14DraftForm) => single(fields, key);
  if (content.kind === "mail") return { kind: "mail", to: lines(field("to")), cc: lines(field("cc")), bcc: lines(field("bcc")), subject: field("subject"), body: field("body") };
  const event: PersonalEventDraft["event"] = content.event ? { summary: field("summary"), description: field("description"), location: field("location"), start: field("start").trim(), end: field("end").trim(), recurrence: field("recurrence").split("\n").map(rule => rule.trim()).filter(Boolean), attendees: lines(field("attendees")) } : null;
  return { ...content, timezone: field("timezone").trim(), sendUpdates: field("sendUpdates") === "all" ? "all" : "none", event };
}
const clientFields = ["csrf", "requestId", "expectedRevision", "clientId", "clientSecret", "redirectUri"], newFields = ["csrf", "requestId", "expectedRevision", "service", "account", "calendarId", "consent_read", "consent_write"];
const draftFields = ["csrf", "requestId", "expectedRevision", "effectId", "draftId", "draftHash", "expiresAt", "to", "cc", "bcc", "subject", "body", "summary", "location", "description", "start", "end", "timezone", "recurrence", "attendees", "sendUpdates"];
/** Translates the Google forms. Each builds one typed command with exact fields and decides nothing. */
export function personalCommand(app: S14Application, form: string, fields: Record<string, unknown>, actor: OwnerActor): S14Command | null {
  const requestId = single(fields, "requestId"), expectedRevision = Number(single(fields, "expectedRevision"));
  if (form === "google-client") {
    allow(fields, clientFields);
    return { kind: "personal.client.set", requestId, expectedRevision, payload: { clientId: single(fields, "clientId").trim(), clientSecret: single(fields, "clientSecret").trim(), redirectUri: single(fields, "redirectUri") } };
  }
  if (form === "google-connection") {
    allow(fields, newFields);
    const service = single(fields, "service") === "calendar" ? "calendar" : "gmail", account = single(fields, "account").trim();
    const scopes: PersonalScope[] = [...(single(fields, "consent_read") === "on" ? [readScope[service]] : []), ...(single(fields, "consent_write") === "on" ? [writeScope[service]] : [])];
    return { kind: "personal.connection.create", requestId, expectedRevision, payload: { label: labelOf(service, account), service, scopes, account, calendarId: service === "calendar" ? single(fields, "calendarId").trim() || "primary" : null } };
  }
  if (form !== "draft-revise") return null;
  allow(fields, draftFields);
  const draftId = single(fields, "draftId");
  return { kind: "personal.draft.revise", requestId, expectedRevision, payload: { draftId, draftHash: single(fields, "draftHash"), content: contentOf(app.personal.effects.view(actor, draftId).draft, fields), expiresAt: Number(single(fields, "expiresAt")) } };
}
/** Landing page after a personal receipt; null leaves other receipts to the core product. */
export function personalSurface(receipt: S14Receipt): string | null {
  if (!receipt.kind.startsWith("personal.")) return null;
  if (receipt.kind === "personal.draft.revise") return `/effects/${(receipt as PersonalEffectReceipt).effect.id}#slip`;
  const done = receipt as PersonalReceipt, id = connectionOf(done);
  return id ? `/settings/google/connections/${id}?receipt=${done.requestId}#next` : `/settings/google?receipt=${done.requestId}`;
}
/** Where a refused personal post leads; null leaves other forms to the core product. */
export function personalNext(form: string | null, value: unknown): string | null {
  const data = value as { kind?: string; effectId?: unknown; service?: unknown; payload?: { connectionId?: unknown } } | null;
  if (form === "google-client") return "/settings/google/guide?step=6";
  if (form === "google-connection") return `/settings/google/new?service=${data?.service === "calendar" ? "calendar" : "gmail"}`;
  if (form === "draft-revise") return typeof data?.effectId === "string" && identityPattern.test(data.effectId) ? `/effects/${data.effectId}#slip` : "/work";
  const id = data?.payload?.connectionId;
  return data?.kind?.startsWith("personal.") ? typeof id === "string" && identityPattern.test(id) ? `/settings/google/connections/${id}` : "/settings/google" : null;
}
/** Brings a refused form back with the cause in words. The client secret is never echoed, and credential-shaped text falls back to the stored draft. */
export function personalRecover(app: S14Application, form: string, fields: Record<string, unknown>, code: string, actor: OwnerActor, state: Home): S14PersonalSurface | null {
  if (form === "google-client") {
    const read = app.personal.settings(actor), uri = single(fields, "redirectUri");
    const redirect = (() => { try { return googleRedirect(new URL(uri).origin); } catch { return { uri, address: "private" as const }; } })();
    return { kind: "google-guide", step: 6, client: read.client, open: read.connections.filter(item => item.state !== "revoked").length, redirect, notice: code, clientId: containsCredential(single(fields, "clientId")) ? "" : single(fields, "clientId") };
  }
  if (form === "google-connection") return { kind: "google-new", service: single(fields, "service") === "calendar" ? "calendar" : "gmail", client: app.personal.settings(actor).client, notice: code, draft: { account: containsCredential(single(fields, "account")) ? "" : single(fields, "account"), calendarId: containsCredential(single(fields, "calendarId")) ? "primary" : single(fields, "calendarId"), read: single(fields, "consent_read") === "on", write: single(fields, "consent_write") === "on" } };
  if (form !== "draft-revise") return null;
  const draftId = single(fields, "draftId"); if (!identityPattern.test(draftId)) return null;
  const view = app.personal.effects.view(actor, draftId); if (!editable(view)) return null;
  const stored = formOf(view.draft.content), typed = Object.fromEntries((Object.keys(stored) as (keyof S14DraftForm)[]).map(key => [key, containsCredential(single(fields, key)) ? stored[key] : single(fields, key)])) as unknown as S14DraftForm;
  return { kind: "google-draft-edit", card: draftCard(app.personal.settings(actor), view), form: typed, notice: code };
}

/** Exact account refs and the read tool from a start form. One tick names both, so a readable account can never be selected without the tool that reads it. A write-only account is a separate field and adds no read tool. */
export function accountSelection(fields: Record<string, unknown>): { tools: string[]; scopes: ScopeRef[] } {
  const refs = (prefix: string) => Object.keys(fields).filter(key => key.startsWith(prefix)).map(key => ({ kind: "resource" as const, id: key.slice(prefix.length), revision: Number(single(fields, key)) }));
  const read = refs("account:");
  return { tools: read.length ? ["personal_read"] : [], scopes: [...read, ...refs("account-write:")] };
}
/** Prefilled text and accounts for the morning brief. It only opens the ordinary routine form: review and enable are still the owner's presses. */
export function briefDraft(app: S14Application, actor: OwnerActor, state: Home, locale: Locale): { purpose: string; time: string; accounts: string[]; bots: string[] } {
  const accounts = personalOverview(app, actor, [], state).accounts.filter(item => item.read), bots = [...new Set(accounts.map(item => item.botId))];
  return { purpose: dictionaries[locale]["s14.google.brief.purpose"], time: "07:00", accounts: accounts.map(item => item.scopeId), bots };
}
