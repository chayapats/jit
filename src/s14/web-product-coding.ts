import { AppError } from "../errors";
import { dictionaries, type Locale } from "../i18n";
import { containsCredential } from "../security/credentials";
import type { S14Application, S14Command, S14Receipt } from "./application";
import type { Effect, WorkLimits, WorkView } from "./authority-types";
import { codingRegistries } from "./coding-protocol";
import { resourceConfigured } from "./share-slots";
import type { CodingCheck, CodingReceipt, CodingRepository, CodingRun, CodingView } from "./coding-types";
import type { GitAction, GitConnection, GitProgress, GitReceipt } from "./coding-git-types";
import type { Artifact, ReportView } from "./report-types";
import type { Bot, Conversation, Home, OwnerActor } from "./types";
import { committed } from "./web-product-memory";
import { expiryFor, workLimitBounds, workOutputBytes, inferTitle } from "./web-product";

/** Repository and Git pages added to the product view union. Every field is query data and proves nothing about authority. */
export type S14CodingSurface = S14CodingHub | S14CodingNew | S14CodingConnect | S14CodingRepositoryPage | S14CodingStart;
/** `/coding`: granted repositories first, revoked ones kept, and the work done on them. */
export interface S14CodingHub { kind: "coding"; repositories: CodingRepository[]; connections: GitConnection[] }
/** One Bot this grant form can name and the free configured slot its radio pins, so a retried form stays the same command. */
export interface S14CodingReceiver { bot: Bot; scopeId: string }
/** A connection made for a slot before any repository exists there, with the Bots that could take that slot. Empty `receivers` means it can no longer be used. */
export interface S14SlotConnection { connection: GitConnection; receivers: S14CodingReceiver[] }
/** Fields kept across a refused grant. */
export interface S14CodingGrantDraft { url: string; baseCommit: string; hosts: string[]; receiver: string }
/** `/coding/new`: the owner's exact selection. `configured` says whether this installation has any repository slot at all. `selected` is the stored token this grant reads the branch with, and `waiting` lists tokens not used yet. */
export interface S14CodingNew { kind: "coding-new"; receivers: S14CodingReceiver[]; others: { bot: Bot; why: "tools" | "slot" | "stopping" }[]; configured: boolean; draft: S14CodingGrantDraft | null; notice: string | null; selected: S14SlotConnection | null; missing: boolean; waiting: S14SlotConnection[] }
/** `/coding/connect`: a token stored for a Bot's free slot before the repository is granted. It grants nothing. `connection` is the one being finished, null on the first step. */
export interface S14CodingConnect { kind: "coding-connect"; receivers: S14CodingReceiver[]; others: S14CodingNew["others"]; configured: boolean; connection: S14SlotConnection | null; missing: boolean; waiting: S14SlotConnection[]; notice: string | null }
/** Fields kept across a refused branch pin. Never a token. */
export interface S14CodingPinDraft { branch: string; connection: string }
/** `/coding/repositories/:id`. `receipt` is reread for the landing banner, so a link cannot fake it. */
export interface S14CodingRepositoryPage { kind: "coding-repository"; repository: CodingRepository; bot: Bot | null; connections: GitConnection[]; receipt: CodingReceipt | GitReceipt | null; notice: string | null; pin?: S14CodingPinDraft | null }
/** Fields kept across a refused start. Nothing here is a secret; credential-shaped text is dropped before it gets here. */
export interface S14CodingStartDraft { purpose: string; completion: string; install: string; tests: string; timeout: number; coverage: string; minutes: number; installRegistry: boolean; testsRegistry: boolean; push: boolean; connection: string }
/** `/coding/repositories/:id/start`: one Bot, one repository and the real commands to run. */
export interface S14CodingStart { kind: "coding-start"; repository: CodingRepository; bot: Bot | null; conversation: Conversation | null; connections: GitConnection[]; draft: S14CodingStartDraft; notice: string | null }
/** Fields kept across a refused push proposal. */
export interface S14GitDraft { connection: string; branch: string; oldCommit: string; pr: boolean; base: string; baseCommit: string; title: string; body: string; draft: boolean }
/** Why the push form is not offered; `null` means the form is shown. Display only: `git.propose` rechecks every condition. */
export type S14PushBlock = "no_evidence" | "changed" | "no_grant" | "ended" | "repository_revoked" | "no_connection" | "open_card" | null;
/** The committed diff of a run, read from its immutable artifact and checked against the hash the run recorded. */
export interface S14CodingDiff { artifact: Artifact; text: string }
/** Query data of the Coding tab. `mismatch` means a stored file does not hash to the run's record, so it is not shown as evidence. */
export interface S14WorkCoding { view: CodingView; run: CodingRun | null; repository: CodingRepository | null; report: ReportView | null; diff: S14CodingDiff | null; checksFile: Artifact | null; mismatch: boolean; connections: GitConnection[]; block: S14PushBlock; effects: Effect[]; notice: string | null; draft: S14GitDraft | null }
/** Query data of a push card. `readBack` is advisory: `git.reconcile` rechecks the connection and repository. */
export interface S14GitCard { action: GitAction; progress: GitProgress; reconcileRequested: boolean; coding: S14WorkCoding; connection: GitConnection | null; repository: CodingRepository | null; readBack: "ok" | "connection" | "repository" | "deleted"; receipt: GitReceipt | null }

/** Longest command the seam accepts. */
export const codingTimeoutMinutes = Object.freeze([1, 5] as const);
/** Coding time also covers the owner's review, because a push must be approved inside the grant. Editable on the form. */
export const codingDefaultMinutes = 120;
/** Tools only a typed coding start may carry; `work.start` forms never offer them, because they would do nothing there. */
export const generalTool = (tool: string) => tool !== "coding" && tool !== "effect_push";

const identityPattern = /^[a-zA-Z0-9_-]{1,128}$/, proposalMinutes = 60;
const single = (fields: Record<string, unknown>, key: string) => { const v = fields[key]; return typeof v === "string" ? v : ""; };
const prefixed = (fields: Record<string, unknown>, prefix: string) => Object.keys(fields).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
function only(fields: Record<string, unknown>, allowed: readonly string[], prefix = ""): void {
  for (const key of Object.keys(fields)) if (!allowed.includes(key) && !(prefix && key.startsWith(prefix))) throw new AppError("invalid_body");
}
const clean = (value: string) => containsCredential(value) ? "" : value;

/** Exact argv of one owner command line, split on spaces with single and double quotes. It runs without a shell, so nothing else is special. */
export function commandWords(line: string): string[] {
  const words: string[] = []; let word = "", quote = "", open = false;
  for (const char of line) {
    if (quote) { if (char === quote) quote = ""; else word += char; }
    else if (char === "'" || char === '"') { quote = char; open = true; }
    else if (char === " " || char === "\t") { if (open) words.push(word); word = ""; open = false; }
    else { word += char; open = true; }
  }
  if (quote) throw new AppError("coding_command_invalid");
  if (open) words.push(word);
  return words;
}
/** Accepts the address GitHub shows in a browser; the service still refuses anything but an exact credential-free origin. */
export const repositoryUrl = (value: string) => { const url = value.trim().replace(/\/+$/, ""); return url && !url.endsWith(".git") ? `${url}.git` : url; };
const bounded = (value: string, fallback: number, [min, max]: readonly [number, number]) => {
  const number = value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new AppError("s14_limit_out_of_range");
  return number;
};
/** Fixed internals of one coding run: one attempt on one Bot, and the most model calls the seam lets a run use. */
export const codingLimits = (minutes: number): WorkLimits => ({ attempts: 1, steps: 1, calls: 256, concurrency: 1, reads: 1, outputBytes: workOutputBytes, wallMs: minutes * 60000 });

/** Connections on a slot that has no repository yet. Only the service's own records: nothing here is a grant. */
const slotConnections = (app: S14Application, actor: OwnerActor) => { const used = new Set(app.coding.repositories(actor).map(item => item.id)); return app.git.connections(actor).filter(item => !item.removed && !used.has(item.repositoryId)); };
function receivers(app: S14Application, actor: OwnerActor, state: Home) {
  const used = new Set(app.coding.repositories(actor).map(item => item.id)), slots = app.sharing.freeSlots(actor).filter(slot => resourceConfigured(app.policy, slot.scopeId) && !used.has(slot.scopeId)), held = new Set(slotConnections(app, actor).map(item => item.repositoryId));
  const eligible: S14CodingReceiver[] = [], others: S14CodingNew["others"] = [];
  for (const bot of state.bots) {
    if (!bot.enabled) { const { state: phase, target } = app.botLifecycle.view(actor, bot.id).lifecycle; if (phase === "stopping" && target === "active") others.push({ bot, why: "stopping" }); continue; }
    if (!["computer", "coding"].every(tool => bot.capabilities.tools.includes(tool))) { others.push({ bot, why: "tools" }); continue; }
    // Pending private connections reserve their slots until explicitly selected or removed.
    const mine = slots.filter(slot => slot.receiverBotIds.includes(bot.id)), scopeId = mine.find(slot => !held.has(slot.scopeId))?.scopeId;
    if (scopeId) eligible.push({ bot, scopeId }); else others.push({ bot, why: "slot" });
  }
  return { receivers: eligible, others, configured: slots.length > 0 };
}
/** Every Bot that could take one slot right now. The service rechecks the Bot, the slot and the connection revision on the press. */
function slotReceivers(app: S14Application, actor: OwnerActor, state: Home, connection: GitConnection): S14SlotConnection {
  const slot = app.sharing.freeSlots(actor).find(item => item.scopeId === connection.repositoryId), bots = state.bots.filter(bot => bot.enabled && ["computer", "coding"].every(tool => bot.capabilities.tools.includes(tool)) && slot?.receiverBotIds.includes(bot.id));
  return { connection, receivers: bots.map(bot => ({ bot, scopeId: connection.repositoryId })) };
}
const waitingOn = (app: S14Application, actor: OwnerActor, state: Home) => slotConnections(app, actor).map(item => slotReceivers(app, actor, state, item));
/** Selects one waiting connection. A stale or foreign identity is simply not found, so the page says so and offers a fresh start. `botId` keeps the Bot chosen on the first step; it only narrows the page, and an unknown one shows every Bot. */
function selectedConnection(app: S14Application, actor: OwnerActor, state: Home, id: string | null, botId: string | null) {
  const found = id ? slotConnections(app, actor).find(item => item.id === id) : null, read = found ? slotReceivers(app, actor, state, found) : null, chosen = read?.receivers.filter(item => item.bot.id === botId) ?? [];
  return { selected: read && chosen.length ? { ...read, receivers: chosen } : read, missing: !!id && !found };
}
function grantView(app: S14Application, actor: OwnerActor, state: Home, id: string | null, botId: string | null, draft: S14CodingGrantDraft | null = null, notice: string | null = null): S14CodingNew {
  const { selected, missing } = selectedConnection(app, actor, state, id, botId), usable = selected && selected.connection.secret === "set" && selected.receivers.length ? selected : null;
  return { kind: "coding-new", ...receivers(app, actor, state), draft, notice, selected: usable, missing: missing || (!!selected && !usable), waiting: waitingOn(app, actor, state) };
}
function connectView(app: S14Application, actor: OwnerActor, state: Home, id: string | null, botId: string | null, notice: string | null = null): S14CodingConnect {
  const { selected, missing } = selectedConnection(app, actor, state, id, botId), held = new Set(slotConnections(app, actor).map(item => item.repositoryId)), read = receivers(app, actor, state);
  return { kind: "coding-connect", ...read, receivers: read.receivers.filter(item => !held.has(item.scopeId)), connection: selected, missing, waiting: waitingOn(app, actor, state), notice };
}
const repositoryOf = (app: S14Application, actor: OwnerActor, id: string) => { const repository = app.coding.repositories(actor).find(item => item.id === id); if (!repository) throw new AppError("coding_repository_not_found", 404); return repository; };
const connectionsOf = (app: S14Application, actor: OwnerActor, id: string) => app.git.connections(actor).filter(item => item.repositoryId === id);
function repositoryPage(app: S14Application, actor: OwnerActor, state: Home, id: string, url: URL | null, notice: string | null = null, pin: S14CodingPinDraft | null = null): S14CodingRepositoryPage {
  const repository = repositoryOf(app, actor, id), connections = connectionsOf(app, actor, id);
  const read = url ? committed<CodingReceipt | GitReceipt>(app, actor, url, "coding.repository.") ?? committed<GitReceipt>(app, actor, url, "git.connection.") : null;
  const mine = (read as CodingReceipt | null)?.repository?.id === id || (read as GitReceipt | null)?.connection?.repositoryId === id;
  return { kind: "coding-repository", repository, bot: state.bots.find(bot => bot.id === repository.botId) ?? null, connections, receipt: mine ? read : null, notice, pin };
}
const emptyStart: S14CodingStartDraft = { purpose: "", completion: "", install: "", tests: "", timeout: codingTimeoutMinutes[1], coverage: "", minutes: codingDefaultMinutes, installRegistry: false, testsRegistry: false, push: false, connection: "" };
function startPage(app: S14Application, actor: OwnerActor, state: Home, id: string, draft: S14CodingStartDraft = emptyStart, notice: string | null = null): S14CodingStart {
  const repository = repositoryOf(app, actor, id);
  return { kind: "coding-start", repository, bot: state.bots.find(bot => bot.id === repository.botId) ?? null, conversation: state.conversations.find(item => item.botId === repository.botId) ?? null, connections: connectionsOf(app, actor, id), draft, notice };
}
/** Resolves the repository pages; null leaves the path to the other product surfaces. Every page is a read and starts nothing. */
export function codingView(app: S14Application, url: URL, actor: OwnerActor, state: Home): S14CodingSurface | null {
  if (url.pathname === "/coding") return { kind: "coding", repositories: app.coding.repositories(actor), connections: app.git.connections(actor) };
  if (url.pathname === "/coding/new") return grantView(app, actor, state, url.searchParams.get("connection"), url.searchParams.get("bot"));
  if (url.pathname === "/coding/connect") return connectView(app, actor, state, url.searchParams.get("connection"), url.searchParams.get("bot"));
  const match = /^\/coding\/repositories\/([a-zA-Z0-9_-]{1,128})(\/start)?$/.exec(url.pathname); if (!match) return null;
  return match[2] ? startPage(app, actor, state, match[1]!) : repositoryPage(app, actor, state, match[1]!, url);
}

const openStates: Effect["state"][] = ["pending", "approved", "executing"];
function pushBlock(app: S14Application, view: WorkView, read: CodingView, run: CodingRun | null, repository: CodingRepository | null, connections: GitConnection[], report: ReportView | null): S14PushBlock {
  if (view.effects.some(effect => openStates.includes(effect.state) || (effect.state === "unknown" && !effect.resolution))) return "open_card";
  if (!view.grant?.tools.includes("effect_push")) return "no_grant";
  if (view.authority?.revoked || app.now() >= view.grant.expiresAt || ["stopped", "stopping"].includes(view.work.state)) return "ended";
  if (run?.reason === "coding_changed_during_tests") return "changed";
  if (!read.available || !run?.reportId || !run.headCommit || !run.diffHash || !["reviewable", "partial"].includes(run.state) || report?.state !== "available") return "no_evidence";
  if (!repository?.active) return "repository_revoked";
  return connections.some(item => !item.removed && item.secret === "set") ? null : "no_connection";
}
/** Reads what a coding work actually produced. It never starts anything and never treats model text as a result. */
export function workCoding(app: S14Application, actor: OwnerActor, view: WorkView, notice: string | null = null, draft: S14GitDraft | null = null): S14WorkCoding {
  const read = app.coding.view(actor, view.work.id), run = read.runs.at(-1) ?? null, repositoryId = read.job?.repository.id ?? view.grant?.scopes[0]?.ref.id ?? "";
  const repository = app.coding.repositories(actor).find(item => item.id === repositoryId) ?? null, connections = connectionsOf(app, actor, repositoryId);
  const report = run?.reportId ? app.reports.view(actor, run.reportId) : null, files = report?.state === "available" ? report.artifacts : [];
  const file = files.find(item => item.name === "coding-diff.txt") ?? null;
  let diff: S14CodingDiff | null = null, mismatch = false;
  if (file && read.available) {
    mismatch = file.sha256 !== run!.diffHash;
    try { if (!mismatch) diff = { artifact: file, text: new TextDecoder().decode(app.artifacts.download(actor, file.id).bytes) }; }
    catch (error) { if (!(error instanceof AppError)) throw error; }
  }
  return { view: read, run, repository, report, diff, mismatch, checksFile: read.available ? files.find(item => item.name === "coding-checks.json") ?? null : null, connections, block: pushBlock(app, view, read, run, repository, connections, report), effects: view.effects.filter(effect => gitAction(effect)), notice, draft };
}
/** The typed action inside a push card, or null for a push that did not come from `git.propose`. Parsing grants nothing: approval binds the hash. */
export function gitAction(effect: Pick<Effect, "action">): GitAction | null {
  if (effect.action.kind !== "push") return null;
  try { const action = JSON.parse(effect.action.content) as GitAction; return action?.version === "app.git-effects/v2" ? action : null; }
  catch { return null; }
}
/** Everything the exact push card shows before a decision. Null leaves the ordinary effect card in charge. */
export function gitCard(app: S14Application, actor: OwnerActor, effect: Effect, url: URL): S14GitCard | null {
  const action = gitAction(effect); if (!action) return null;
  let read: ReturnType<S14Application["git"]["view"]>;
  try { read = app.git.view(actor, effect.id); } catch (error) { if (error instanceof AppError && error.code === "git_effect_not_found") return null; throw error; }
  const coding = workCoding(app, actor, app.authority.view(actor, effect.workId)), connection = coding.connections.find(item => item.id === action.connection.id) ?? null, repository = coding.repository;
  const readBack = effect.payloadState === "deleted" ? "deleted" : !repository?.active ? "repository" : !connection || connection.removed || connection.revision !== action.connection.revision ? "connection" : "ok";
  const receipt = committed<GitReceipt>(app, actor, url, "git.reconcile");
  return { action, progress: read.progress, reconcileRequested: read.reconcileRequested, coding, connection, repository, readBack, receipt: receipt?.effect?.id === effect.id ? receipt : null };
}

const grantFields = ["csrf", "requestId", "expectedRevision", "url", "baseCommit", "receiver", "connection"], secretFields = ["csrf", "requestId", "expectedRevision", "repositoryId", "connectionId", "secret", "waiting", "bot"];
const pinFields = ["csrf", "requestId", "expectedRevision", "repositoryId", "branch", "connection"], slotFields = ["csrf", "requestId", "expectedRevision", "receiver", "label"];
const startFields = ["csrf", "requestId", "expectedRevision", "repositoryId", "repositoryRevision", "botRevision", "conversationId", "purpose", "completion", "install", "tests", "timeout", "coverage", "minutes", "installRegistry", "testsRegistry", "push", "connection"];
const proposeFields = ["csrf", "requestId", "expectedRevision", "workId", "attemptId", "newCommit", "expiresAt", "connection", "branch", "oldCommit", "pr", "base", "baseCommit", "title", "body", "draft"];
const pinned = (value: string) => { const [id, revision] = value.split(":"); return { id: id ?? "", revision: Number(revision) }; };
const check = (line: string, registry: boolean, coverage: string, timeoutMs: number): CodingCheck => ({ argv: commandWords(line), timeoutMs, network: registry ? "registry" : "none", coverage });
function codingStart(app: S14Application, fields: Record<string, unknown>, actor: OwnerActor, locale: Locale): S14Command {
  only(fields, startFields);
  const purpose = single(fields, "purpose"), repositoryId = single(fields, "repositoryId"), revision = Number(single(fields, "repositoryRevision")), repository = repositoryOf(app, actor, repositoryId), minutes = bounded(single(fields, "minutes"), codingDefaultMinutes, workLimitBounds.minutes);
  const timeoutMs = bounded(single(fields, "timeout"), codingTimeoutMinutes[1], codingTimeoutMinutes) * 60000, coverage = single(fields, "coverage").trim() || dictionaries[locale]["s14.coding.coverage_none"];
  const install = single(fields, "install").trim(), tests = single(fields, "tests").split("\n").map(line => line.trim()).filter(Boolean), connection = single(fields, "connection"), requestId = single(fields, "requestId"), limits = codingLimits(minutes);
  return { kind: "coding.start", requestId, expectedRevision: Number(single(fields, "expectedRevision")), payload: {
    repository: { id: repository.id, revision }, install: install ? check(install, single(fields, "installRegistry") === "on", coverage, timeoutMs) : null,
    tests: tests.map(line => check(line, single(fields, "testsRegistry") === "on", coverage, timeoutMs)), connection: connection ? pinned(connection) : null,
    work: { conversationId: single(fields, "conversationId"), task: null, title: inferTitle(purpose), purpose, completionRule: single(fields, "completion").trim() || dictionaries[locale]["s14.coding.completion_default"], bots: [{ id: repository.botId, revision: Number(single(fields, "botRevision")) }],
      tools: ["computer", "coding", ...(single(fields, "push") === "on" ? ["effect_push"] : [])], scopes: [{ kind: "resource", id: repository.id, revision }], limits, expiresAt: expiryFor(app, actor, requestId, limits.wallMs) } } };
}
/** Translates the coding and Git forms into the same typed commands; it decides nothing, and unknown fields are refused. */
export function codingCommand(app: S14Application, form: string, fields: Record<string, unknown>, actor: OwnerActor, locale: Locale): S14Command | null {
  const requestId = single(fields, "requestId"), expectedRevision = Number(single(fields, "expectedRevision"));
  if (form === "coding-grant") {
    only(fields, grantFields, "registry:");
    const [botId, id] = single(fields, "receiver").split(":"), hosts = prefixed(fields, "registry:");
    if (!botId || !id) throw new AppError("coding_receiver_required");
    const base = single(fields, "baseCommit").trim(), connection = single(fields, "connection");
    // Selecting a waiting connection explicitly binds its reserved slot even for a full commit.
    return { kind: "coding.repository.grant", requestId, expectedRevision, payload: { id, botId, url: repositoryUrl(single(fields, "url")),
      ...(/^[a-fA-F0-9]{40}$/.test(base) ? { baseCommit: base.toLowerCase() } : { baseBranch: base }), ...(connection ? { connection: pinned(connection) } : {}), registry: hosts.length ? { hosts } : null } };
  }
  if (form === "coding-repin") {
    only(fields, pinFields);
    return { kind: "coding.repository.resolve", requestId, expectedRevision, payload: { repositoryId: single(fields, "repositoryId"), baseBranch: single(fields, "branch").trim(), connection: pinned(single(fields, "connection")) } };
  }
  if (form === "coding-start") return codingStart(app, fields, actor, locale);
  if (form === "git-connection") {
    only(fields, ["csrf", "requestId", "expectedRevision", "repositoryId", "label"]);
    return { kind: "git.connection.create", requestId, expectedRevision, payload: { repositoryId: single(fields, "repositoryId"), label: single(fields, "label").trim() } };
  }
  if (form === "git-slot-connection") {
    only(fields, slotFields);
    const [botId, id] = single(fields, "receiver").split(":");
    if (!botId || !id) throw new AppError("coding_receiver_required");
    return { kind: "git.connection.create", requestId, expectedRevision, payload: { repositoryId: id, botId, label: single(fields, "label").trim() } };
  }
  if (form === "git-slot-remove") {
    only(fields, ["csrf", "requestId", "expectedRevision", "connectionId"]);
    return { kind: "git.connection.remove", requestId, expectedRevision, payload: { connectionId: single(fields, "connectionId") } };
  }
  if (form === "git-secret" || form === "git-rotate") {
    only(fields, secretFields);
    return { kind: form === "git-secret" ? "git.connection.secret.set" : "git.connection.rotate", requestId, expectedRevision, payload: { connectionId: single(fields, "connectionId"), secret: single(fields, "secret") } };
  }
  if (form !== "git-propose") return null;
  only(fields, proposeFields);
  const pr = single(fields, "pr") === "on", oldCommit = single(fields, "oldCommit").trim().toLowerCase();
  return { kind: "git.propose", requestId, expectedRevision, payload: { attemptId: single(fields, "attemptId"), connection: pinned(single(fields, "connection")),
    update: { ref: `refs/heads/${single(fields, "branch").trim()}`, oldCommit: oldCommit || null, newCommit: single(fields, "newCommit") },
    pr: pr ? { base: single(fields, "base").trim(), baseCommit: single(fields, "baseCommit").trim().toLowerCase(), title: single(fields, "title").trim(), body: single(fields, "body"), draft: single(fields, "draft") === "on" } : null,
    expiresAt: Number(single(fields, "expiresAt")) } };
}
/** Hidden expiry of a push form: an hour, or the end of the grant if that comes first. It is rendered once, so a retried post stays the same command. */
export const proposalExpiry = (now: number, grantExpires: number) => Math.min(now + proposalMinutes * 60000, grantExpires);
/** Landing page after a coding or Git receipt; null leaves other receipts to the core product. A connection made before its repository has no repository page, so its steps carry their own way forward. */
export function codingSurface(receipt: S14Receipt, fields?: Record<string, unknown>): string | null {
  const step = (receipt as GitReceipt).connection, onSlot = !!fields && !("repositoryId" in fields);
  const bot = encodeURIComponent(fields ? single(fields, "bot") || single(fields, "receiver").split(":")[0]! : "");
  if (onSlot && receipt.kind === "git.connection.create") return `/coding/connect?connection=${step!.id}&bot=${bot}`;
  if (onSlot && receipt.kind === "git.connection.remove") return "/coding/new";
  if (fields && single(fields, "waiting") === "on" && step) return `/coding/new?connection=${step.id}&bot=${bot}`;
  if (receipt.kind === "coding.start") return `/work/${(receipt as CodingReceipt).work!.id}?tab=coding`;
  if (receipt.kind.startsWith("coding.repository.")) return `/coding/repositories/${(receipt as CodingReceipt).repository!.id}?receipt=${receipt.requestId}`;
  if (receipt.kind.startsWith("git.connection.")) return `/coding/repositories/${(receipt as GitReceipt).connection!.repositoryId}?receipt=${receipt.requestId}#connections`;
  if (receipt.kind === "git.propose") return `/effects/${(receipt as GitReceipt).effect!.id}#slip`;
  return receipt.kind === "git.reconcile" ? `/effects/${(receipt as GitReceipt).effect!.id}?receipt=${receipt.requestId}#slip` : null;
}
/** Where a refused coding post leads. Every way back rereads the page, so a changed state is seen before anything can be pressed. */
export function codingNext(form: string | null, value: unknown): string | null {
  const data = (value ?? {}) as { kind?: string; repositoryId?: unknown; workId?: unknown; payload?: { repositoryId?: unknown } };
  const repository = (id: unknown, tail = "") => typeof id === "string" && identityPattern.test(id) ? `/coding/repositories/${id}${tail}` : "/coding";
  if (form === "coding-grant") return "/coding/new";
  if (form === "git-slot-connection" || form === "git-slot-remove") return "/coding/connect";
  if (form === "git-secret" && (value as { waiting?: unknown } | null)?.waiting === "on") return "/coding/connect";
  if (form === "coding-repin") return repository(data.repositoryId);
  if (form === "coding-start") return repository(data.repositoryId, "/start");
  if (form === "git-connection" || form === "git-secret" || form === "git-rotate") return repository(data.repositoryId);
  if (form === "git-propose") return typeof data.workId === "string" && identityPattern.test(data.workId) ? `/work/${data.workId}?tab=coding` : "/coding";
  if (data.kind === "coding.repository.revoke") return repository(data.payload?.repositoryId);
  return data.kind === "git.connection.remove" || data.kind === "git.connection.test" ? "/coding" : null;
}
/** Brings a form back with the cause in words. The token is never carried, and credential-shaped text is not echoed. */
export function codingRecover(app: S14Application, form: string, fields: Record<string, unknown>, code: string, actor: OwnerActor, state: Home): S14CodingNew | S14CodingConnect | S14CodingRepositoryPage | S14CodingStart | null {
  const id = single(fields, "repositoryId"), connectionId = single(fields, "connection").split(":")[0] ?? "";
  if (form === "coding-grant") return grantView(app, actor, state, connectionId || null, single(fields, "receiver").split(":")[0] ?? null, { url: clean(single(fields, "url")), baseCommit: clean(single(fields, "baseCommit")), hosts: prefixed(fields, "registry:"), receiver: single(fields, "receiver") }, code);
  if (form === "git-slot-connection") return connectView(app, actor, state, null, null, code);
  if (form === "git-secret" && single(fields, "waiting") === "on") return connectView(app, actor, state, single(fields, "connectionId"), single(fields, "bot"), code);
  if (!identityPattern.test(id)) return null;
  if (form === "coding-repin") return repositoryPage(app, actor, state, id, null, code, { branch: clean(single(fields, "branch")), connection: single(fields, "connection") });
  if (form === "git-connection" || form === "git-secret" || form === "git-rotate") return repositoryPage(app, actor, state, id, null, code);
  if (form !== "coding-start") return null;
  const number = (key: string, fallback: number) => { const value = Number(single(fields, key)); return Number.isSafeInteger(value) && value > 0 ? value : fallback; };
  return startPage(app, actor, state, id, { purpose: clean(single(fields, "purpose")), completion: clean(single(fields, "completion")), install: clean(single(fields, "install")), tests: clean(single(fields, "tests")), coverage: clean(single(fields, "coverage")), timeout: number("timeout", emptyStart.timeout), minutes: number("minutes", emptyStart.minutes), installRegistry: single(fields, "installRegistry") === "on", testsRegistry: single(fields, "testsRegistry") === "on", push: single(fields, "push") === "on", connection: single(fields, "connection") }, code);
}
/** A refused push form returns to its Coding tab with the typed text kept, except credential-shaped text. */
export function gitDraft(fields: Record<string, unknown>): S14GitDraft {
  return { connection: single(fields, "connection"), branch: single(fields, "branch"), oldCommit: single(fields, "oldCommit"), pr: single(fields, "pr") === "on", base: single(fields, "base"), baseCommit: single(fields, "baseCommit"), title: clean(single(fields, "title")), body: clean(single(fields, "body")), draft: single(fields, "draft") === "on" };
}
/** Hosts the seam can allow, in the order a form lists them. */
export const registryHosts: readonly string[] = codingRegistries;
