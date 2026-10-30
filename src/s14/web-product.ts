import { AppError } from "../errors";
import { dictionaries, type Locale, type MessageKey } from "../i18n";
import type { StaticAsset } from "../web-assets";
import type { S14Application, S14Command, S14Receipt } from "./application";
import type { AuthorityReceipt, Effect, StartWorkCommand, Work, WorkLimits, WorkView } from "./authority-types";
import type { ComputerActivity, ComputerInputReceipt, ComputerReceipt, ComputerView } from "./computer-types";
import type { Bot, BotProposal, Conversation, Home, Message, OwnerActor, Reply } from "./types";
import { lookupS14Asset } from "./web-assets";
import { renderFailure, renderLogin } from "./web-pages";
import { memoryCommand, memoryNext, memoryRecover, memorySurface, memoryView, workResearch, type S14MemorySurface, type S14WorkResearch } from "./web-product-memory";

/** Owner-confirmed research defaults, shown as editable values on every start form; they are not measured host capacity. */
export const defaultWorkLimits = Object.freeze({ concurrent: 2, minutes: 30, reads: 40 });
/** System-chosen output ceiling for one work item; the owner never has to size it. */
export const workOutputBytes = 262144;
/** Inclusive owner-editable bounds, kept inside the service's validated maxima. */
export const workLimitBounds = Object.freeze({ concurrent: [1, 8], minutes: [1, 1440], reads: [1, 256] } as const);

/** Composer content preserved across a refused post, so a stale revision never costs the owner their text. */
export interface S14Draft { text: string; work: boolean; concurrent: number; minutes: number; reads: number; completion: string; bots: string[] }
/** Work pane tabs that have real data in this slice; later slices add theirs when their data exists. */
export type S14WorkTab = "progress" | "grant" | "computer" | "evidence";
/** Query data only the Bot computer tab needs. `runtime` says one is configured, never that it is ready. */
export interface S14ComputerSurface { activity: ComputerActivity[]; runtime: boolean; confirm: "reset" | "delete" | null; input: ComputerInputReceipt | null }
/** One conversation query as rendered, with open proposal history for the exact-revision diff. */
export interface S14Chat { conversation: Conversation; messages: Message[]; proposals: BotProposal[]; replies: Reply[]; history: Record<string, BotProposal[]> }
/** Server-rendered surface selected from the URL; every variant carries only typed query data. */
export type S14View =
  | { kind: "setup"; draft: { ownerName: string; language: Locale } | null; notice: string | null }
  | { kind: "home"; conversation: Conversation; bot: Bot; draft: S14Draft | null; notice: string | null }
  | { kind: "chat"; chat: S14Chat; bot: Bot; draft: S14Draft | null; notice: string | null; pane: { view: WorkView; tab: S14WorkTab; research: S14WorkResearch | null } | null }
  | { kind: "work-list" }
  | { kind: "work"; view: WorkView; tab: S14WorkTab; research: S14WorkResearch | null; conversation: Conversation; bot: Bot }
  | { kind: "team" }
  | { kind: "bot"; bot: Bot; conversation: Conversation | null; computer: S14ComputerSurface | null }
  | { kind: "proposal"; proposal: BotProposal; history: BotProposal[] }
  | { kind: "effect"; effect: Effect; history: Effect[] }
  | { kind: "more" }
  | S14MemorySurface;
/** Query projections every signed-in page needs for attention counts and Bot state; never a proof of authority. */
export interface S14Overview { views: WorkView[]; effects: Effect[]; botStates: Record<string, "working" | "queued" | "waiting" | "idle">; computers: Record<string, ComputerView> }
/** Product routes behind the authenticated handler; every state change still goes through S14Application.execute. */
export interface S14Product {
  asset(pathname: string): StaticAsset | null;
  login(locale: Locale, code: string | null): string;
  failure(locale: Locale, code: string, next: string): string;
  overview(actor: OwnerActor, state: Home, work: Work[]): S14Overview;
  view(url: URL, actor: OwnerActor, state: Home, locale: Locale): S14View;
  command(form: string, fields: Record<string, unknown>, actor: OwnerActor, state: Home, locale: Locale): S14Command;
  recover(form: string, fields: Record<string, unknown>, code: string, actor: OwnerActor, state: Home): S14View | null;
  surface(receipt: S14Receipt, fields?: Record<string, unknown>): string;
  /** Owner-facing page for one no-script input outcome, replacing the JSON redirect of the bare seam. */
  inputSurface(botId: string, requestId: string): string;
  next(form: string | null, value: unknown): string;
}

const single = (fields: Record<string, unknown>, key: string): string => { const v = fields[key]; return typeof v === "string" ? v : ""; };
/** Refuses unknown form fields rather than silently dropping something the owner saw. */
function checked(fields: Record<string, unknown>, fixed: readonly string[], prefixes: readonly string[]): void {
  for (const key of Object.keys(fields)) if (!fixed.includes(key) && !prefixes.some(prefix => key.startsWith(prefix))) throw new AppError("invalid_body");
}
const prefixed = (fields: Record<string, unknown>, prefix: string) => Object.keys(fields).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
function bounded(value: string, fallback: number, [min, max]: readonly [number, number]): number {
  const number = value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new AppError("s14_limit_out_of_range");
  return number;
}
function ownerLimits(fields: Record<string, unknown>) {
  return { concurrent: bounded(single(fields, "concurrent"), defaultWorkLimits.concurrent, workLimitBounds.concurrent), minutes: bounded(single(fields, "minutes"), defaultWorkLimits.minutes, workLimitBounds.minutes), reads: bounded(single(fields, "reads"), defaultWorkLimits.reads, workLimitBounds.reads) };
}
/** One attempt per named Bot; reads and time are the owner's, the rest is inferred so nobody sizes internals. */
function workLimits(limits: ReturnType<typeof ownerLimits>, bots: number): WorkLimits {
  return { attempts: bots, steps: bots, calls: limits.reads, outputBytes: workOutputBytes, wallMs: limits.minutes * 60000 };
}
/** First line of the command, capped to the title's byte limit on a code-point boundary. */
export function inferTitle(text: string): string {
  const line = text.split("\n").map(part => part.trim()).find(Boolean) ?? text.trim();
  let title = "", bytes = 0;
  for (const char of line) { bytes += Buffer.byteLength(char); if (bytes > 190) return `${title}…`; title += char; }
  return title;
}
const start = (identity: { requestId: string; expectedRevision: number; conversationId: string; task: { id: string; revision: number } | null }, content: { title: string; purpose: string; completionRule: string }, fields: Record<string, unknown>, app: S14Application, actor: OwnerActor): StartWorkCommand => {
  const limits = ownerLimits(fields), lead = app.conversation(actor, identity.conversationId).conversation.botId;
  const bots = prefixed(fields, "bot:").map(id => ({ id, revision: Number(single(fields, `bot:${id}`)) })).sort((a, b) => Number(b.id === lead) - Number(a.id === lead));
  if (bots[0]?.id !== lead) throw new AppError("invalid_bots");
  if (bots.length > limits.concurrent) throw new AppError("s14_too_many_bots");
  const shaped = workLimits(limits, bots.length);
  return { kind: "work.start", requestId: identity.requestId, expectedRevision: identity.expectedRevision, payload: { conversationId: identity.conversationId, task: identity.task, ...content, bots, tools: prefixed(fields, "tool:"), scopes: [], limits: shaped, expiresAt: expiryFor(app, actor, identity.requestId, shaped.wallMs) } };
};
/** A retried form reuses its committed expiry, so the same retry key stays the same command and returns one receipt. */
function expiryFor(app: S14Application, actor: OwnerActor, requestId: string, wallMs: number): number {
  const committed = app.store.read(tx => { app.requireOwner(tx, actor); return tx.get<{ result_json: string }>("SELECT result_json FROM command_receipts WHERE owner_id='owner' AND request_id=?", requestId); });
  const receipt = committed ? JSON.parse(committed.result_json) as { grant?: { command?: { payload?: { expiresAt?: number } } } } : null;
  return receipt?.grant?.command?.payload?.expiresAt ?? app.now() + wallMs;
}
const route = (fields: Record<string, unknown>, state: Home) => single(fields, "routeId") || (state.routes.length === 1 ? state.routes[0]!.id : "");
const capabilities = (fields: Record<string, unknown>) => ({ tools: prefixed(fields, "tool:"), resources: prefixed(fields, "resource:") });
const draftOf = (fields: Record<string, unknown>, keepText: boolean): S14Draft => {
  const number = (key: "concurrent" | "minutes" | "reads") => { const value = Number(single(fields, key)); return Number.isSafeInteger(value) && value > 0 ? value : defaultWorkLimits[key]; };
  return { text: keepText ? single(fields, "text") : "", work: single(fields, "work") === "on", concurrent: number("concurrent"), minutes: number("minutes"), reads: number("reads"), completion: single(fields, "completion"), bots: prefixed(fields, "bot:") };
};
const tab = (url: URL): S14WorkTab => { const name = url.searchParams.get("tab"); return name === "grant" || name === "computer" || name === "evidence" ? name : "progress"; };
const computerPath = (botId: string, suffix = "") => `/team/${botId}?tab=computer${suffix}`;
const example = (locale: Locale, url: URL): S14Draft | null => {
  const key = ({ "1": "s14.home.example_1", "2": "s14.home.example_2" } as Record<string, MessageKey>)[url.searchParams.get("example") ?? ""];
  return key ? { ...defaultWorkLimits, text: dictionaries[locale][key], work: true, completion: "", bots: [] } : null;
};

/** Binds the product routes to one application; it reads queries and builds typed commands, and decides nothing. */
export function createS14Product(app: S14Application): S14Product {
  const main = (state: Home) => {
    const conversation = state.conversations.find(c => c.botId === "jit") ?? state.conversations[0], bot = state.bots.find(b => b.id === conversation?.botId);
    if (!conversation || !bot) throw new AppError("not_found", 404); return { conversation, bot };
  };
  const botOf = (state: Home, id: string) => { const bot = state.bots.find(b => b.id === id); if (!bot) throw new AppError("not_found", 404); return bot; };
  const chat = (actor: OwnerActor, id: string): S14Chat => {
    const read = app.conversation(actor, id);
    return { ...read, history: Object.fromEntries(read.proposals.filter(p => p.revision > 1).map(p => [p.id, app.proposal(actor, p.id).history])) };
  };
  /** A stale, foreign or malformed outcome link shows no outcome; it must not cost the owner the computer page. */
  const inputOutcome = (actor: OwnerActor, botId: string, requestId: string | null) => {
    if (!requestId) return null;
    try { const receipt = app.computers.inputReceipt(actor, requestId); return receipt.computerId === app.computers.view(actor, botId).computer?.id ? receipt : null; }
    catch (error) { if (error instanceof AppError && ["not_found", "invalid_identity"].includes(error.code)) return null; throw error; }
  };
  return {
    asset: lookupS14Asset,
    login: (locale, code) => renderLogin(locale, code, !!app.store.read(tx => tx.get("SELECT id FROM owner"))),
    failure: renderFailure,
    overview(actor, state, work) {
      const views = work.filter(w => w.grantId).map(w => app.authority.view(actor, w.id)), botStates: S14Overview["botStates"] = {};
      for (const bot of state.bots) botStates[bot.id] = "idle";
      for (const view of views) for (const bot of view.grant?.bots ?? []) {
        const state = view.work.state === "running" || view.work.state === "stopping" ? "working" : view.work.state === "queued" ? "queued" : view.work.state === "waiting" ? "waiting" : null;
        if (state && botStates[bot.id] !== "working") botStates[bot.id] = state;
      }
      for (const reply of state.replies) if (reply.state === "running") botStates[reply.snapshot.bot.id] = "working";
      return { views, effects: views.flatMap(view => view.effects), botStates, computers: Object.fromEntries(state.bots.map(bot => [bot.id, app.computers.view(actor, bot.id)])) };
    },
    view(url, actor, state, locale) {
      if (!state.owner) return { kind: "setup", draft: null, notice: null };
      const path = url.pathname;
      if (path === "/") return { kind: "home", ...main(state), draft: example(locale, url), notice: null };
      if (path === "/work") return { kind: "work-list" };
      if (path === "/team") return { kind: "team" };
      if (path === "/more") return { kind: "more" };
      const surface = memoryView(app, url, actor, state); if (surface) return surface;
      const match = /^\/(chats|work|team|proposals|effects)\/([a-zA-Z0-9_-]+)$/.exec(path);
      if (!match) throw new AppError("not_found", 404);
      const [, area, id] = match as unknown as [string, string, string];
      if (area === "chats") {
        const read = chat(actor, id), workId = url.searchParams.get("work"), source = read.messages.find(m => m.id === url.searchParams.get("start") && m.role === "owner");
        const pane = workId ? app.authority.view(actor, workId) : null;
        if (pane && pane.work.conversationId !== id) throw new AppError("not_found", 404);
        return { kind: "chat", chat: read, bot: botOf(state, read.conversation.botId), draft: source ? { ...defaultWorkLimits, text: source.text, work: true, completion: "", bots: [] } : null, notice: null, pane: pane ? { view: pane, tab: tab(url), research: workResearch(app, actor, pane) } : null };
      }
      if (area === "work") {
        const view = app.authority.view(actor, id), conversation = app.conversation(actor, view.work.conversationId).conversation;
        return { kind: "work", view, tab: tab(url), research: workResearch(app, actor, view), conversation, bot: botOf(state, conversation.botId) };
      }
      if (area === "team") {
        const confirm = url.searchParams.get("confirm"), computer = url.searchParams.get("tab") === "computer";
        return { kind: "bot", bot: botOf(state, id), conversation: state.conversations.find(c => c.botId === id) ?? null, computer: computer ? { activity: app.computers.activity(actor, id), runtime: !!app.computers.options.runtime, confirm: confirm === "reset" || confirm === "delete" ? confirm : null, input: inputOutcome(actor, id, url.searchParams.get("input")) } : null };
      }
      if (area === "proposals") return { kind: "proposal", ...app.proposal(actor, id) };
      return { kind: "effect", ...app.authority.effect(actor, id) };
    },
    command(form, fields, actor, state, locale) {
      const requestId = single(fields, "requestId"), expectedRevision = Number(single(fields, "expectedRevision"));
      const extended = memoryCommand(app, form, fields, actor); if (extended) return extended;
      if (form === "setup") {
        checked(fields, ["csrf", "requestId", "expectedRevision", "ownerName", "language", "routeId"], ["tool:", "resource:"]);
        return { kind: "setup", requestId, expectedRevision, payload: { ownerName: single(fields, "ownerName"), language: single(fields, "language") as Locale, routeId: route(fields, state), capabilities: capabilities(fields) } };
      }
      if (form === "compose") {
        checked(fields, ["csrf", "requestId", "expectedRevision", "conversationId", "from", "text", "work", "concurrent", "minutes", "reads", "completion"], ["bot:", "tool:"]);
        const text = single(fields, "text"), conversationId = single(fields, "conversationId");
        if (single(fields, "work") !== "on") return { kind: "message.post", requestId, expectedRevision, payload: { conversationId, text } };
        return start({ requestId, expectedRevision, conversationId, task: null }, { title: inferTitle(text), purpose: text, completionRule: single(fields, "completion").trim() || dictionaries[locale]["s14.work.default_completion"] }, fields, app, actor);
      }
      if (form === "task-start") {
        checked(fields, ["csrf", "requestId", "expectedRevision", "taskId", "taskRevision", "concurrent", "minutes", "reads"], ["bot:", "tool:"]);
        const task = app.authority.view(actor, single(fields, "taskId")).work;
        return start({ requestId, expectedRevision, conversationId: task.conversationId, task: { id: task.id, revision: Number(single(fields, "taskRevision")) } }, { title: task.title, purpose: task.purpose, completionRule: task.completionRule }, fields, app, actor);
      }
      if (form === "proposal-accept") {
        checked(fields, ["csrf", "requestId", "expectedRevision", "proposalId"], ["tool:", "resource:"]);
        return { kind: "bot.proposal.accept", requestId, expectedRevision, payload: { proposalId: single(fields, "proposalId"), capabilities: capabilities(fields) } };
      }
      if (form === "proposal-revise") {
        checked(fields, ["csrf", "requestId", "expectedRevision", "proposalId", "name", "responsibility", "routeId"], []);
        return { kind: "bot.proposal.revise", requestId, expectedRevision, payload: { proposalId: single(fields, "proposalId"), name: single(fields, "name"), responsibility: single(fields, "responsibility"), routeId: route(fields, state) } };
      }
      throw new AppError("not_found", 404);
    },
    recover(form, fields, code, actor, state) {
      if (form === "setup" && state.owner === null) return { kind: "setup", draft: { ownerName: single(fields, "ownerName"), language: single(fields, "language") === "en" ? "en" : "th" }, notice: code };
      if (form !== "compose") return memoryRecover(app, form, fields, code, actor, state);
      // Credential-shaped text is not echoed back into the page.
      const draft = draftOf(fields, code !== "credential_content_refused"), conversationId = single(fields, "conversationId");
      if (single(fields, "from") === "home") return { kind: "home", ...main(state), draft, notice: code };
      const read = chat(actor, conversationId);
      return { kind: "chat", chat: read, bot: botOf(state, read.conversation.botId), draft, notice: code, pane: null };
    },
    surface(receipt, fields) {
      const extended = memorySurface(receipt, fields); if (extended) return extended;
      if (receipt.kind === "setup") return "/";
      if (receipt.kind === "conversation.create") return `/chats/${receipt.conversation!.id}`;
      if (receipt.kind === "owner.preferences.set") return "/more";
      if (receipt.kind === "message.post") return `/chats/${receipt.conversation!.id}#latest`;
      if (receipt.kind === "bot.proposal.accept") return `/team/${receipt.bot!.id}`;
      if (receipt.kind === "bot.proposal.reject" || receipt.kind === "bot.proposal.revise") return `/proposals/${receipt.proposal!.id}`;
      if (receipt.kind === "approval.decide") return `/effects/${receipt.effect!.id}`;
      if (receipt.kind.startsWith("computer.") || receipt.kind.startsWith("takeover.")) return computerPath((receipt as ComputerReceipt).computer!.botId, receipt.kind === "takeover.start" ? "#screen" : "");
      const work = (receipt as AuthorityReceipt).work!;
      return `/chats/${work.conversationId}?work=${work.id}#latest`;
    },
    inputSurface: (botId, requestId) => computerPath(botId, `&input=${requestId}#screen`),
    next(form, value) {
      const extended = memoryNext(form, value); if (extended) return extended;
      const data = value as { kind?: string; payload?: Record<string, string>; proposalId?: string; taskId?: string; conversationId?: string } | null;
      if (form === "proposal-accept" || form === "proposal-revise") return `/proposals/${data?.proposalId ?? ""}`;
      if (form === "task-start") return `/work/${data?.taskId ?? ""}`;
      const payload = data?.payload ?? {};
      if (payload.botId) return computerPath(payload.botId);
      if (payload.proposalId) return `/proposals/${payload.proposalId}`;
      if (payload.effectId) return `/effects/${payload.effectId}`;
      if (payload.workId) return `/work/${payload.workId}`;
      if (payload.taskId) return `/work/${payload.taskId}`;
      return "/";
    },
  };
}
