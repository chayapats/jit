import { AppError } from "../errors";
import type { S14Application, S14Command, S14Receipt } from "./application";
import type { WorkView } from "./authority-types";
import type { MemoryAccess, MemoryClaim, MemoryDecision, MemoryImpact, MemoryLookup, MemoryPacket, MemoryReceipt, MemoryRef, MemoryShare, MemorySource, MemoryWithdrawal } from "./memory-types";
import type { ExternalEvidence, ParallelReceipt, WebRead } from "./parallel-types";
import type { Bot, Conversation, Home, OwnerActor } from "./types";

type Mode = MemoryWithdrawal["mode"];
/** One readable claim as a browse row; `access` is the exact publication revision a later command must carry. */
export interface S14MemoryRow { claim: MemoryClaim; access: MemoryAccess }
/** A claim whose text is withheld: identities and lifecycle words only, never its payload. */
export interface S14MemoryGone { reference: MemoryRef; reason: string; modes: Mode[]; source: MemoryRef | null }
/** One source with the lifecycle modes the owner should see beside it. */
export interface S14MemorySource { source: MemorySource; modes: Mode[] }
/** Owner decision with whether its own source text still exists. */
export interface S14MemoryDecision { decision: MemoryDecision; sourceGone: boolean }
/** Memory browse surface for one Bot, or for owner-published claims when `bot` is null. */
export interface S14MemoryBrowse { kind: "memory"; scope: string; bot: Bot | null; conversation: Conversation | null; query: string; rows: S14MemoryRow[]; gone: S14MemoryGone[]; decisions: S14MemoryDecision[]; sources: S14MemorySource[]; receipt: MemoryReceipt | null; notice: string | null; draft: string; draftForm: string | null }
/** Claim actions that open a preview page; a preview is a read and the command after it holds the authority. */
export type S14MemoryAction = "correct" | "forget" | "delete" | "publish" | "revoke" | "share";
/** What one lifecycle command would touch, resolved into owner-readable text where the owner can read it. */
export interface S14MemoryImpact { impact: MemoryImpact; texts: Record<string, string>; work: { id: string; title: string }[]; contextsChecked: number }
/** One exact claim revision with its history, source, conflicts and the optional action preview. */
export interface S14MemoryClaimView { kind: "memory-claim"; bot: Bot; ref: MemoryRef; lookup: MemoryLookup; history: MemoryAccess[]; shares: MemoryShare[]; source: S14MemorySource | null; gone: S14MemoryGone | null; related: Record<string, MemoryLookup>; privateDependencies: number; action: S14MemoryAction | null; impact: S14MemoryImpact | null; notice: string | null; draft: string }
/** One retained source, or the explanation that its text is gone. */
export interface S14MemorySourceView { kind: "memory-source"; bot: Bot; source: S14MemorySource; rows: S14MemoryRow[] }
/** Optional Parallel configuration page; anonymous public research never needs it. */
export interface S14WebSettings { kind: "settings-web"; read: ReturnType<S14Application["parallel"]["settings"]>; receipt: ParallelReceipt | null; notice: string | null }
/** Memory and web surfaces added to the product view union. */
export type S14MemorySurface = S14MemoryBrowse | S14MemoryClaimView | S14MemorySourceView | S14WebSettings;
/** Actual research record of one work item plus the memory contexts its attempts received. */
export interface S14WorkResearch { reads: WebRead[]; evidence: ExternalEvidence[]; contexts: MemoryPacket[] }

const memoryForms = ["memory-remember", "memory-correct", "memory-forget", "memory-delete", "memory-publish", "memory-revoke", "memory-share", "memory-decision"] as const;
const actions: readonly S14MemoryAction[] = ["correct", "forget", "delete", "publish", "revoke", "share"];
const shareHours = [1, 24] as const;
/** Inclusive owner-editable share lifetime; the service refuses anything past 24 hours. */
export const memoryShareHours = Object.freeze({ min: shareHours[0], max: shareHours[1] });
const single = (fields: Record<string, unknown>, key: string) => { const v = fields[key]; return typeof v === "string" ? v : ""; };
function allow(fields: Record<string, unknown>, keys: readonly string[]): void { for (const key of Object.keys(fields)) if (!keys.includes(key)) throw new AppError("invalid_body"); }
const identityPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const refOf = (url: URL, id: string): MemoryRef => ({ id, revision: Number(url.searchParams.get("revision")), generation: Number(url.searchParams.get("generation")) });
/** Bounded lexical search text: the service accepts 200 UTF-8 bytes, so the page trims rather than refusing a long paste. */
function searchTerm(raw: string | null): string {
  let out = "", bytes = 0;
  for (const char of (raw ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim()) { bytes += Buffer.byteLength(char); if (bytes > 200) break; out += char; }
  return out.trim();
}
function committed<T>(app: S14Application, actor: OwnerActor, url: URL, prefix: string): T | null {
  const id = url.searchParams.get("receipt");
  if (!id || !identityPattern.test(id)) return null;
  const row = app.store.read(tx => { app.requireOwner(tx, actor); return tx.get<{ result_json: string }>("SELECT result_json FROM command_receipts WHERE owner_id='owner' AND request_id=?", id); });
  const receipt = row ? JSON.parse(row.result_json) as { kind?: string } : null;
  return receipt?.kind?.startsWith(prefix) ? receipt as T : null;
}
const modesOf = (withdrawals: MemoryWithdrawal[], kind: MemoryWithdrawal["kind"], id: string) => withdrawals.filter(w => w.kind === kind && w.id === id).map(w => w.mode);

function goneRow(item: Extract<MemoryLookup, { state: "unavailable" }>, withdrawals: MemoryWithdrawal[]): S14MemoryGone {
  const row = withdrawals.find(w => w.kind === "claim" && w.id === item.reference.id);
  return { reference: item.reference, reason: item.reason, modes: modesOf(withdrawals, "claim", item.reference.id), source: row?.source ?? null };
}
function botOf(state: Home, id: string): Bot { const bot = state.bots.find(b => b.id === id); if (!bot) throw new AppError("not_found", 404); return bot; }

function browse(app: S14Application, url: URL, actor: OwnerActor, state: Home): S14MemoryBrowse {
  const scope = url.searchParams.get("scope") ?? "jit", query = searchTerm(url.searchParams.get("q")), receipt = committed<MemoryReceipt>(app, actor, url, "memory.");
  const base = { kind: "memory" as const, scope, query, receipt, notice: null, draft: "", draftForm: null };
  if (scope === "shared") {
    const rows = state.bots.flatMap(bot => app.memory.inspect(actor, bot.id, query).claims.flatMap(item => item.state === "available" && item.access.shared && item.claim.botId === bot.id ? [{ claim: item.claim, access: item.access }] : []));
    return { ...base, bot: null, conversation: null, rows: rows.sort((a, b) => b.claim.createdAt - a.claim.createdAt), gone: [], decisions: [], sources: [] };
  }
  const bot = botOf(state, scope), read = app.memory.inspect(actor, bot.id, query);
  const rows = read.claims.flatMap(item => item.state === "available" ? [{ claim: item.claim, access: item.access }] : []).reverse();
  const gone = read.claims.flatMap(item => item.state === "unavailable" ? [goneRow(item, read.withdrawals)] : []).reverse();
  const decisions = read.decisions.map(decision => ({ decision, sourceGone: modesOf(read.withdrawals, "source", decision.source.id).includes("deleted") }));
  const sources = read.sources.map(source => ({ source, modes: modesOf(read.withdrawals, "source", source.id) })).reverse();
  return { ...base, bot, conversation: state.conversations.find(c => c.botId === bot.id) ?? null, rows, gone, decisions, sources };
}

function impactOf(app: S14Application, actor: OwnerActor, ref: MemoryRef, botId: string): S14MemoryImpact {
  const impact = app.memory.preview(actor, ref), read = app.memory.inspect(actor, botId), texts: Record<string, string> = {};
  for (const item of read.claims) if (item.state === "available") texts[item.claim.id] = item.claim.text;
  // Bounded projection: a context names its work, and the fence withdraws that work's result.
  const checked = impact.contexts.slice(0, 64), titles = new Map(app.authority.list(actor).map(work => [work.id, work.title]));
  const ids = new Set(checked.map(id => app.memory.context(actor, id).workId).filter((id): id is string => id !== null));
  return { impact, texts, work: [...ids].map(id => ({ id, title: titles.get(id) ?? id })), contextsChecked: checked.length };
}

function claimView(app: S14Application, url: URL, actor: OwnerActor, state: Home, botId: string, id: string): S14MemoryClaimView {
  const bot = botOf(state, botId), ref = refOf(url, id), { claim: lookup, history, shares } = app.memory.claim(actor, bot.id, ref), read = app.memory.inspect(actor, bot.id);
  const requested = url.searchParams.get("action"), action = actions.find(item => item === requested) ?? null;
  const gone = lookup.state === "unavailable" ? goneRow(lookup, read.withdrawals) : null;
  const sourceRef = lookup.state === "available" ? lookup.claim.source : gone?.source ?? null, found = sourceRef ? read.sources.find(s => s.id === sourceRef.id) : undefined;
  const related: Record<string, MemoryLookup> = {}, claim = lookup.state === "available" ? lookup.claim : null;
  for (const item of [...(claim?.dependencies ?? []), ...(claim?.conflicts ?? [])]) related[item.id] = app.memory.claim(actor, bot.id, item).claim;
  const privateDependencies = (claim?.dependencies ?? []).filter(item => { const found = related[item.id]; return found?.state !== "available" || !found.access.shared; }).length;
  const previewable = action === "correct" || action === "forget" || action === "delete";
  const usable = lookup.state === "available" || (action === "delete" && lookup.reason === "memory_withdrawn");
  return { kind: "memory-claim", bot, ref, lookup, history, shares, gone, related, privateDependencies, action, notice: null, draft: "",
    source: found ? { source: found, modes: modesOf(read.withdrawals, "source", found.id) } : null,
    impact: previewable && usable ? impactOf(app, actor, ref, bot.id) : null };
}

function sourceView(app: S14Application, actor: OwnerActor, state: Home, botId: string, id: string): S14MemorySourceView {
  const bot = botOf(state, botId), read = app.memory.inspect(actor, bot.id), source = read.sources.find(s => s.id === id);
  if (!source) throw new AppError("not_found", 404);
  return { kind: "memory-source", bot, source: { source, modes: modesOf(read.withdrawals, "source", id) },
    rows: read.claims.flatMap(item => item.state === "available" && item.claim.source.id === id ? [{ claim: item.claim, access: item.access }] : []) };
}

/** Resolves the memory and web settings routes; null leaves the path to the core product surfaces. */
export function memoryView(app: S14Application, url: URL, actor: OwnerActor, state: Home): S14MemorySurface | null {
  const path = url.pathname;
  if (path === "/settings/web") return { kind: "settings-web", read: app.parallel.settings(actor), receipt: committed<ParallelReceipt>(app, actor, url, "web.parallel."), notice: null };
  if (path === "/memory") return browse(app, url, actor, state);
  const claim = /^\/memory\/([a-zA-Z0-9_-]+)\/claims\/([a-zA-Z0-9_-]+)$/.exec(path);
  if (claim) return claimView(app, url, actor, state, claim[1]!, claim[2]!);
  const source = /^\/memory\/([a-zA-Z0-9_-]+)\/sources\/([a-zA-Z0-9_-]+)$/.exec(path);
  if (source) return sourceView(app, actor, state, source[1]!, source[2]!);
  return null;
}

/** Research queries for one work item, including the exact memory context each attempt was given. */
export function workResearch(app: S14Application, actor: OwnerActor, view: WorkView): S14WorkResearch | null {
  if (!view.work.grantId) return null;
  const ids = [...new Set(view.attempts.flatMap(attempt => attempt.memoryId ? [attempt.memoryId] : []))];
  return { ...app.parallel.inspect(actor, view.work.id), contexts: ids.map(id => app.memory.context(actor, id)) };
}

function shareExpiry(app: S14Application, actor: OwnerActor, requestId: string, hours: number): number {
  const row = app.store.read(tx => { app.requireOwner(tx, actor); return tx.get<{ result_json: string }>("SELECT result_json FROM command_receipts WHERE owner_id='owner' AND request_id=?", requestId); });
  const receipt = row ? JSON.parse(row.result_json) as { share?: { expiresAt?: number } } : null;
  return receipt?.share?.expiresAt ?? app.now() + hours * 3600000;
}

/** Translates memory and Parallel forms into the same typed commands; it decides nothing and refuses unknown fields. */
export function memoryCommand(app: S14Application, form: string, fields: Record<string, unknown>, actor: OwnerActor): S14Command | null {
  const requestId = single(fields, "requestId"), expectedRevision = Number(single(fields, "expectedRevision"));
  const base = ["csrf", "requestId", "expectedRevision", "botId"], claimFields = [...base, "claimId", "revision", "generation"];
  const claim = (): MemoryRef => ({ id: single(fields, "claimId"), revision: Number(single(fields, "revision")), generation: Number(single(fields, "generation")) });
  if (form === "memory-remember") { allow(fields, [...base, "conversationId", "text"]); return { kind: "memory.remember", requestId, expectedRevision, payload: { conversationId: single(fields, "conversationId"), text: single(fields, "text") } }; }
  if (form === "memory-decision") { allow(fields, [...base, "conversationId", "key", "text"]); return { kind: "memory.decision.set", requestId, expectedRevision, payload: { conversationId: single(fields, "conversationId"), key: single(fields, "key"), text: single(fields, "text") } }; }
  if (form === "memory-correct") { allow(fields, [...claimFields, "text"]); return { kind: "memory.correct", requestId, expectedRevision, payload: { claim: claim(), text: single(fields, "text") } }; }
  if (form === "memory-forget" || form === "memory-delete" || form === "memory-publish" || form === "memory-revoke") {
    allow(fields, claimFields);
    const kind = ({ "memory-forget": "memory.forget", "memory-delete": "memory.delete", "memory-publish": "memory.publish", "memory-revoke": "memory.revoke" } as const)[form];
    return { kind, requestId, expectedRevision, payload: { claim: claim() } };
  }
  if (form === "memory-share") {
    allow(fields, [...claimFields, "target", "hours"]);
    const [receiverBotId = "", scopeId = "", extra] = single(fields, "target").split(":"), hours = Number(single(fields, "hours"));
    if (extra !== undefined || !Number.isSafeInteger(hours) || hours < memoryShareHours.min || hours > memoryShareHours.max) throw new AppError("memory_share_invalid");
    return { kind: "memory.share", requestId, expectedRevision, payload: { claim: claim(), scopeId, receiverBotId, expiresAt: shareExpiry(app, actor, requestId, hours) } };
  }
  if (form === "parallel-key") { allow(fields, ["csrf", "requestId", "expectedRevision", "secret"]); return { kind: "web.parallel.key.set", requestId, expectedRevision, payload: { secret: single(fields, "secret") } }; }
  if (form === "parallel-enable") {
    allow(fields, ["csrf", "requestId", "expectedRevision", "connectionId", "billing"]);
    return { kind: "web.parallel.configure", requestId, expectedRevision, payload: { mode: "authenticated", connectionId: single(fields, "connectionId"), billingAcknowledged: single(fields, "billing") === "on" } };
  }
  return null;
}

const botField = (fields: Record<string, unknown>) => { const id = single(fields, "botId"); return identityPattern.test(id) ? id : "jit"; };
/** Landing page after a memory or Parallel receipt; the receipt's own kind and counts are reread, not trusted from the URL. */
export function memorySurface(receipt: S14Receipt, fields?: Record<string, unknown>): string | null {
  if (receipt.kind.startsWith("web.parallel.")) return `/settings/web?receipt=${receipt.requestId}`;
  if (receipt.kind.startsWith("memory.")) return `/memory?scope=${botField(fields ?? {})}&receipt=${receipt.requestId}`;
  return null;
}
/** Where a refused memory or Parallel post leads; null leaves other forms to the core product. */
export function memoryNext(form: string | null, value: unknown): string | null {
  const data = value as { kind?: string; botId?: string } | null;
  if (form?.startsWith("parallel-") || data?.kind?.startsWith("web.parallel.")) return "/settings/web";
  if (memoryForms.some(name => name === form)) return `/memory?scope=${botField((value ?? {}) as Record<string, unknown>)}`;
  return null;
}
/** Rebuilds the page with the cause in words; typed text survives except credential-shaped input, and a key never does. */
export function memoryRecover(app: S14Application, form: string, fields: Record<string, unknown>, code: string, actor: OwnerActor, state: Home): S14MemorySurface | null {
  if (form.startsWith("parallel-")) return { kind: "settings-web", read: app.parallel.settings(actor), receipt: null, notice: code };
  if (!memoryForms.some(name => name === form)) return null;
  const draft = code === "credential_content_refused" ? "" : single(fields, "text"), botId = botField(fields);
  if (form === "memory-remember" || form === "memory-decision") return { ...browse(app, new URL(`http://s14/memory?scope=${botId}`), actor, state), notice: code, draft, draftForm: form };
  const claimId = single(fields, "claimId"); if (!identityPattern.test(claimId)) return null;
  const params = new URLSearchParams({ revision: single(fields, "revision"), generation: single(fields, "generation"), action: form.slice("memory-".length) });
  return { ...claimView(app, new URL(`http://s14/memory/${botId}/claims/${claimId}?${params}`), actor, state, botId, claimId), notice: code, draft };
}
