import { dictionaries, type Locale } from "../i18n";
import { AppError } from "../errors";
import { nextScheduledInstant, validTimezone, wallToUtc } from "../jobs/schedules";
import { containsCredential } from "../security/credentials";
import type { S14Application, S14Command, S14Receipt } from "./application";
import type { ScopeRef, Work } from "./authority-types";
import type { AttentionCommand, AttentionNotice, AttentionReceipt, AttentionSetting, EnableRoutineCommand, RoutineOccurrence, RoutinePurpose, RoutineReceipt, RoutineView } from "./routine-types";
import type { Bot, Home, OwnerActor, Route } from "./types";
import { inferTitle, ownerLimits, workLimits } from "./web-product";
import { generalTool } from "./web-product-coding";
import { accountSelection, briefDraft } from "./web-product-personal";
import { committed } from "./web-product-memory";
import { limitValues, type S14LimitValues } from "./web-product-team";

/** Schedule shapes the form offers; each maps to one `ScheduleRecurrence` the service validates again. */
export type S14RoutineSchedule = "daily" | "interval" | "once" | "weekly";
/** Form values kept exactly as typed across review, edit and refusal. Nothing here is authority until `routine.enable` commits. */
export interface S14RoutineDraft extends S14LimitValues { purpose: string; completion: string; bots: string[]; tools: string[]; scopes: string[]; accounts: string[]; schedule: S14RoutineSchedule; time: string; day: string; weekTime: string; hours: string; at: string; timezone: string; occurrences: string; days: string }
/** Computed review of one draft. `payload` is the exact capture the enable form repeats, and `firstRun` is advisory. */
export interface S14RoutineReview { requestId: string; conversationId: string; expectedRevision: number; payload: RoutinePurpose; firstRun: number; bots: Bot[]; routes: Route[] }
/** `/routines/new`: the form, or its review when `review` is set. A review is a read and starts nothing. */
export interface S14RoutineNew { kind: "routine-new"; draft: S14RoutineDraft; notice: string | null; fresh: boolean; review: S14RoutineReview | null }
/** One out-of-scope finding with the routine run that raised it. It is an unstarted task and grants nothing. */
export interface S14RoutineFinding { work: Work; routineId: string; occurrenceId: string }
/** `/routines`: every standing capture, with findings still waiting on the owner. `receipt` is reread so a link cannot fake the deleted banner, and `level` says where new reports go. */
export interface S14RoutineList { kind: "routines"; items: RoutineView[]; findings: S14RoutineFinding[]; receipt: RoutineReceipt | null; level: AttentionSetting["level"] }
/** `/routines/:id`. `notices` is keyed by occurrence, `receipt` is reread so a link cannot fake the landing banner, `decisions` counts open owner decisions over all history, and `confirm` opens the delete slip. */
export interface S14RoutineDetail { kind: "routine"; view: RoutineView; findings: S14RoutineFinding[]; notices: Record<string, AttentionNotice>; receipt: RoutineReceipt | null; decisions: number; confirm: boolean }
/** Routine surfaces added to the product view union. */
export type S14RoutineSurface = S14RoutineNew | S14RoutineList | S14RoutineDetail;
/** The open notice behind a row, at the revision a Dismiss press binds to. Null means the row has nothing to acknowledge. */
export type S14NoticeRef = Pick<AttentionNotice, "id" | "revision"> | null;
/** One grouped row of "needs me": at most one per routine and kind, so a burst never becomes a burst of rows. Only a failure carries a notice: a decision or a blocked routine leaves by being answered. */
export interface S14RoutineNeed { routineId: string; title: string; need: "decision" | "failed" | "blocked"; count: number; at: number; delivery: "failed" | "unknown" | null; notice: S14NoticeRef }
/** Latest report of a routine. It is listed but not counted, and it leaves when dismissed. */
export interface S14RoutineUpdate { routineId: string; title: string; at: number; workId: string | null; notice: S14NoticeRef }
/** Grouped attention projection; `findings` are work IDs the routine rows already speak for. Display data only. */
export interface S14RoutineAttention { needs: S14RoutineNeed[]; updates: S14RoutineUpdate[]; findings: string[] }

/** Owner-facing bounds, kept inside the service's validated maxima. */
export const routineBounds = Object.freeze({ occurrences: [1, 1000], days: [1, 366], hours: [1, 720] } as const);
const fixedFields = ["csrf", "requestId", "expectedRevision", "conversationId", "purpose", "completion", "concurrent", "minutes", "reads", "schedule", "time", "day", "weekTime", "hours", "at", "timezone", "occurrences", "days", "endsAt"];
const identityPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const single = (fields: Record<string, unknown>, key: string) => { const v = fields[key]; return typeof v === "string" ? v : ""; };
const prefixed = (fields: Record<string, unknown>, prefix: string) => Object.keys(fields).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
const rid = () => crypto.randomUUID().replaceAll("-", "");
/** Browsers post textarea line breaks as CRLF, and the service's text check refuses a carriage return. */
const lines = (value: string) => value.replace(/\r\n?/g, "\n");
/** The host's zone is only a starting value: it stays visible, editable and captured, and script replaces it with the device's. */
const hostTimezone = () => { const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone; return validTimezone(zone) ? zone : "UTC"; };

function checkedFields(fields: Record<string, unknown>): void {
  for (const key of Object.keys(fields)) if (!fixedFields.includes(key) && !["bot:", "tool:", "scope:", "account:"].some(prefix => key.startsWith(prefix))) throw new AppError("invalid_body");
}
function freshDraft(app: S14Application, actor: OwnerActor, state: Home): S14RoutineDraft {
  const jit = state.bots.find(bot => bot.id === "jit" && bot.enabled) ?? state.bots.find(bot => bot.enabled);
  return { ...limitValues(app.graph.defaults(actor)), purpose: "", completion: "", bots: jit ? [jit.id] : [], tools: (jit?.capabilities.tools ?? []).filter(tool => app.policy.tools.includes(tool) && generalTool(tool) && !tool.startsWith("effect_") && tool !== "personal_read"), scopes: [], accounts: [], schedule: "daily", time: "08:00", day: "1", weekTime: "08:00", hours: "24", at: "", timezone: hostTimezone(), occurrences: "30", days: "90" };
}
function draftOf(app: S14Application, actor: OwnerActor, fields: Record<string, unknown>): S14RoutineDraft {
  const fallback = limitValues(app.graph.defaults(actor)), number = (key: keyof S14LimitValues) => { const value = Number(single(fields, key)); return Number.isSafeInteger(value) && value > 0 ? value : fallback[key]; };
  const schedule = single(fields, "schedule");
  return { concurrent: number("concurrent"), minutes: number("minutes"), reads: number("reads"), purpose: lines(single(fields, "purpose")), completion: lines(single(fields, "completion")), bots: prefixed(fields, "bot:"), tools: prefixed(fields, "tool:"), scopes: prefixed(fields, "scope:"), accounts: prefixed(fields, "account:"), schedule: schedule === "interval" || schedule === "once" || schedule === "weekly" ? schedule : "daily", time: single(fields, "time"), day: single(fields, "day"), weekTime: single(fields, "weekTime"), hours: single(fields, "hours"), at: single(fields, "at"), timezone: single(fields, "timezone"), occurrences: single(fields, "occurrences"), days: single(fields, "days") };
}
/** A new form from an old capture, for a routine that can never resume. Bots that left the team simply stay out of the selection. */
function fromRoutine(app: S14Application, actor: OwnerActor, state: Home, routineId: string | null): S14RoutineDraft {
  const fresh = freshDraft(app, actor, state); if (!routineId || !identityPattern.test(routineId)) return fresh;
  const { routine } = app.routines.view(actor, routineId), p = routine.capture.command.payload, deleted = (value: string) => value === "[deleted]" ? "" : value;
  const days = Math.max(1, Math.min(routineBounds.days[1], Math.ceil((p.endsAt - routine.createdAt) / 86400000))), r = p.recurrence;
  return { ...fresh, concurrent: p.limits.concurrency, minutes: Math.max(1, Math.round(p.limits.wallMs / 60000)), reads: p.limits.reads, purpose: deleted(p.purpose), completion: deleted(p.completionRule), bots: p.bots.map(ref => ref.id).filter(id => state.bots.some(bot => bot.id === id && bot.enabled)), tools: p.tools, accounts: p.scopes.filter(scope => scope.kind === "resource").map(scope => scope.id), schedule: r.kind, time: r.kind === "daily" ? r.time : fresh.time, day: r.kind === "weekly" ? String(r.day) : fresh.day, weekTime: r.kind === "weekly" ? r.time : fresh.weekTime, hours: r.kind === "interval" ? String(Math.max(1, Math.round(r.everyMs / 3600000))) : fresh.hours, timezone: p.timezone, occurrences: String(p.occurrenceBudget), days: String(days) };
}
function bounded(value: string, [min, max]: readonly [number, number]): number {
  const number = value.trim() === "" ? NaN : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new AppError("s14_limit_out_of_range");
  return number;
}
/** Wall time in the routine's own zone, so what the owner typed is what `once` means. */
function onceAt(draft: S14RoutineDraft): number {
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2})$/.exec(draft.at); if (!match) throw new AppError("invalid_routine_schedule");
  const [, y, mo, d, h, mi] = match.map(Number) as [number, number, number, number, number, number];
  return wallToUtc(draft.timezone, y, mo, d, h, mi).utc;
}
function recurrenceOf(draft: S14RoutineDraft): RoutinePurpose["recurrence"] {
  if (draft.schedule === "once") return { kind: "once", at: onceAt(draft) };
  if (draft.schedule === "interval") return { kind: "interval", everyMs: bounded(draft.hours, routineBounds.hours) * 3600000 };
  const clock = draft.schedule === "weekly" ? draft.weekTime : draft.time;
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(clock)) throw new AppError("invalid_routine_schedule");
  if (draft.schedule !== "weekly") return { kind: "daily", time: clock };
  if (!/^[0-6]$/.test(draft.day)) throw new AppError("invalid_routine_schedule");
  return { kind: "weekly", day: Number(draft.day), time: clock };
}
/** Builds the exact capture. `endsAt` comes from the review so a retried enable stays the same command; the service rechecks all of it. */
function capture(app: S14Application, actor: OwnerActor, state: Home, fields: Record<string, unknown>, draft: S14RoutineDraft, locale: Locale, conversationId: string): RoutinePurpose {
  const purpose = draft.purpose.trim(), completion = draft.completion.trim() || dictionaries[locale]["s14.work.default_completion"];
  if (containsCredential(purpose) || containsCredential(completion)) throw new AppError("credential_content_refused", 403);
  if (!purpose) throw new AppError("invalid_text");
  if (!validTimezone(draft.timezone)) throw new AppError("invalid_routine_schedule");
  const lead = state.conversations.find(item => item.id === conversationId)?.botId, order = (id: string) => id === lead ? 0 : 1;
  const bots = prefixed(fields, "bot:").map(id => ({ id, revision: Number(single(fields, `bot:${id}`)) })).sort((a, b) => order(a.id) - order(b.id));
  const accounts = accountSelection(fields), limits = workLimits(ownerLimits(fields, limitValues(app.graph.defaults(actor))), bots.length), scopes: ScopeRef[] = [...prefixed(fields, "scope:").map(id => ({ kind: "share" as const, id, revision: Number(single(fields, `scope:${id}`)) })), ...accounts.scopes];
  const recurrence = recurrenceOf(draft), pinned = single(fields, "endsAt"), endsAt = /^[1-9][0-9]{0,15}$/.test(pinned) ? Number(pinned) : app.now() + bounded(draft.days, routineBounds.days) * 86400000;
  return { conversationId, title: inferTitle(purpose), purpose, completionRule: completion, bots, tools: [...new Set([...prefixed(fields, "tool:"), ...accounts.tools])], scopes, limits, timezone: draft.timezone, recurrence, misfire: "coalesce", occurrenceBudget: recurrence.kind === "once" ? 1 : bounded(draft.occurrences, routineBounds.occurrences), endsAt };
}
/** The chat a routine reports into: the first ticked Bot's, Jit's when Jit is ticked. */
function reportChat(state: Home, fields: Record<string, unknown>): string {
  const ticked = prefixed(fields, "bot:"); if (!ticked.length) throw new AppError("invalid_bots");
  const lead = ticked.includes("jit") ? "jit" : ticked[0]!, conversation = state.conversations.find(item => item.botId === lead);
  if (!conversation) throw new AppError("invalid_bots");
  return conversation.id;
}

/** Resolves the review and edit steps of `/routines/new`. They read only, and return null for every other form. */
export function routineReview(app: S14Application, form: string, fields: Record<string, unknown>, actor: OwnerActor, state: Home, locale: Locale): S14RoutineNew | null {
  if (form !== "routine-preview" && form !== "routine-edit") return null;
  checkedFields(fields);
  const draft = draftOf(app, actor, fields);
  if (form === "routine-edit") return { kind: "routine-new", draft, notice: null, fresh: false, review: null };
  const conversationId = reportChat(state, fields), payload = capture(app, actor, state, fields, draft, locale, conversationId);
  const first = nextScheduledInstant({ recurrence: payload.recurrence, timezone: payload.timezone, cursor: { lastInstant: null, lastRevision: null }, createdAt: app.now() }, app.now());
  if (!first || first.utc > payload.endsAt) throw new AppError("invalid_routine_schedule");
  const bots = payload.bots.flatMap(ref => state.bots.filter(bot => bot.id === ref.id)), routes = bots.flatMap(bot => state.routes.filter(route => route.id === bot.routeId));
  const conversation = state.conversations.find(item => item.id === conversationId)!;
  return { kind: "routine-new", draft, notice: null, fresh: false, review: { requestId: rid(), conversationId, expectedRevision: conversation.revision, payload, firstRun: first.utc, bots, routes } };
}
const dismissFields = ["csrf", "requestId", "expectedRevision", "noticeId", "from", "routineId"], levelFields = ["csrf", "requestId", "expectedRevision", "level"];
/** Translates the attention forms. Dismiss names one notice at its revision and answers nothing; the level is one of two fixed words. */
function attentionCommand(form: string, fields: Record<string, unknown>): AttentionCommand | null {
  if (form !== "attention-dismiss" && form !== "attention-level") return null;
  for (const key of Object.keys(fields)) if (!(form === "attention-dismiss" ? dismissFields : levelFields).includes(key)) throw new AppError("invalid_body");
  const requestId = single(fields, "requestId"), expectedRevision = Number(single(fields, "expectedRevision"));
  if (form === "attention-dismiss") return { kind: "attention.acknowledge", requestId, expectedRevision, payload: { noticeId: single(fields, "noticeId") } };
  return { kind: "attention.set", requestId, expectedRevision, payload: { level: single(fields, "level") as AttentionSetting["level"] } };
}
/** Translates the reviewed form into the exact standing command; it decides nothing and refuses unknown fields. */
export function routineFormCommand(app: S14Application, form: string, fields: Record<string, unknown>, actor: OwnerActor, state: Home, locale: Locale): S14Command | null {
  const attention = attentionCommand(form, fields); if (attention) return attention;
  if (form !== "routine-enable") return null;
  checkedFields(fields);
  const payload = capture(app, actor, state, fields, draftOf(app, actor, fields), locale, single(fields, "conversationId"));
  return { kind: "routine.enable", requestId: single(fields, "requestId"), expectedRevision: Number(single(fields, "expectedRevision")), payload } as EnableRoutineCommand;
}
/** The page a Dismiss came from. Only fixed places and a checked routine ID: the field cannot name an address. */
function dismissedFrom(fields: Record<string, unknown> | undefined): string {
  const from = fields ? single(fields, "from") : "", routineId = fields ? single(fields, "routineId") : "";
  return from === "work" ? "/work" : from === "routine" && identityPattern.test(routineId) ? `/routines/${routineId}` : "/";
}
/** Landing page after a routine or attention receipt; null leaves other receipts to the core product. A deleted routine has no page, so it lands on the list. */
export function routineSurface(receipt: S14Receipt, fields?: Record<string, unknown>): string | null {
  if (receipt.kind === "attention.acknowledge") return dismissedFrom(fields);
  if (receipt.kind === "attention.set") return `/more?receipt=${(receipt as AttentionReceipt).requestId}#s14-attention-level`;
  if (receipt.kind === "routine.delete") return `/routines?receipt=${receipt.requestId}`;
  return receipt.kind.startsWith("routine.") ? `/routines/${(receipt as RoutineReceipt).routine.id}?receipt=${receipt.requestId}` : null;
}
/** Where a refused routine or attention post leads; null leaves other forms to the core product. */
export function routineNext(form: string | null, value: unknown): string | null {
  if (form?.startsWith("routine-")) return "/routines/new";
  if (form === "attention-level") return "/more";
  if (form === "attention-dismiss") return dismissedFrom(value as Record<string, unknown>);
  const command = value as { kind?: string; payload?: { routineId?: unknown } } | null, id = command?.payload?.routineId;
  return command?.kind?.startsWith("routine.") && typeof id === "string" && identityPattern.test(id) ? `/routines/${id}` : null;
}
/** Brings the form back with the cause in words. Credential-shaped text is not echoed, the same rule as the composer. */
export function routineRecover(app: S14Application, form: string, fields: Record<string, unknown>, code: string, actor: OwnerActor): S14RoutineNew | null {
  if (!["routine-preview", "routine-enable"].includes(form)) return null;
  const draft = draftOf(app, actor, fields), kept = code === "credential_content_refused" ? { purpose: "", completion: "" } : {};
  return { kind: "routine-new", draft: { ...draft, ...kept }, notice: code, fresh: false, review: null };
}

const findingsOf = (views: RoutineView[], work: Work[]): S14RoutineFinding[] => views.flatMap(({ routine, history }) => history.flatMap(occurrence => occurrence.proposals.flatMap(id => {
  const item = work.find(entry => entry.id === id); return item ? [{ work: item, routineId: routine.id, occurrenceId: occurrence.id }] : [];
})));
/** Resolves `/routines`, `/routines/new` and `/routines/:id`; null leaves the path to the other product surfaces. */
export function routineView(app: S14Application, url: URL, actor: OwnerActor, state: Home, locale: Locale): S14RoutineSurface | null {
  const path = url.pathname;
  if (path === "/routines") { const items = app.routines.list(actor); return { kind: "routines", items, findings: findingsOf(items, app.authority.list(actor)).filter(item => item.work.state === "proposed"), receipt: committed<RoutineReceipt>(app, actor, url, "routine.delete"), level: app.attention.view(actor).setting.level }; }
  if (path === "/routines/new") {
    const from = url.searchParams.get("from"), base = fromRoutine(app, actor, state, from);
    if (url.searchParams.get("brief") === "1") { const brief = briefDraft(app, actor, state, locale); return { kind: "routine-new", draft: { ...base, ...brief, bots: brief.bots.length ? brief.bots : base.bots }, notice: null, fresh: true, review: null }; }
    return { kind: "routine-new", draft: base, notice: null, fresh: !from, review: null };
  }
  const match = /^\/routines\/([a-zA-Z0-9_-]{1,128})$/.exec(path); if (!match) return null;
  const view = app.routines.view(actor, match[1]!), notices = Object.fromEntries(app.attention.view(actor).items.filter(item => view.history.some(run => run.id === item.groupId)).map(item => [item.groupId, item]));
  const receipt = committed<RoutineReceipt>(app, actor, url, "routine."), decisions = app.routines.attention(actor).find(item => item.routine.id === view.routine.id)?.decisions.count ?? 0;
  return { kind: "routine", view, findings: findingsOf([view], app.authority.list(actor)), notices, receipt: receipt?.routine.id === view.routine.id ? receipt : null, decisions, confirm: url.searchParams.get("confirm") === "delete" && view.routine.state === "revoked" };
}

/** Stopped by the owner's own pause or revoke: recorded in history, but nothing the owner needs to come back to. */
export const ownerStoppedRun = (run: RoutineOccurrence) => run.reason === "owner_routine_control";
const failedRun = (run: RoutineOccurrence) => (run.state === "failed" || run.state === "stopped") && !ownerStoppedRun(run);
/**
 * Groups actual open decisions by routine, without a recent-notice window. A failure stays in "needs me" until the owner dismisses it or a newer run of that routine
 * settles without failing, and a blocked routine stays until the owner revokes it. History keeps all of them. The notice reference only offers Dismiss: the row itself comes from the routine query.
 */
export function routineAttention(app: S14Application, actor: OwnerActor, work: Work[]): S14RoutineAttention {
  const needs: S14RoutineNeed[] = [], updates: S14RoutineUpdate[] = [], open = new Map(app.attention.view(actor).items.filter(item => item.resolvedAt === null).map(item => [item.groupId, item]));
  const notice = (groupId: string): S14NoticeRef => { const item = open.get(groupId); return item ? { id: item.id, revision: item.revision } : null; };
  for (const { routine, decisions, settled, report, delivery } of app.routines.attention(actor)) {
    const title = routine.capture.command.payload.title;
    if (decisions.count) needs.push({ routineId: routine.id, title, need: "decision", count: decisions.count, at: decisions.at!, delivery, notice: null });
    if (routine.state === "blocked" && routine.occurrencesRemaining > 0) needs.push({ routineId: routine.id, title, need: "blocked", count: 1, at: settled?.createdAt ?? routine.createdAt, delivery, notice: null });
    else if (routine.state !== "revoked" && settled && failedRun(settled)) needs.push({ routineId: routine.id, title, need: "failed", count: 1, at: settled.createdAt, delivery, notice: notice(settled.id) });
    if (report) updates.push({ routineId: routine.id, title, at: report.createdAt, workId: report.workId, notice: notice(report.id) });
  }
  return { needs: needs.sort((a, b) => b.at - a.at), updates: updates.sort((a, b) => b.at - a.at), findings: work.filter(item => item.reason === "routine_out_of_scope").map(item => item.id) };
}
