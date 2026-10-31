import { AppError } from "../errors";
import type { S14Application, S14Command, S14Receipt } from "./application";
import type { BotLifecycle, BotLifecyclePreview, BotLifecycleReceipt, CapabilityProposal } from "./bot-lifecycle-types";
import type { RoutineView } from "./routine-types";
import type { SnapshotTarget } from "./sharing-types";
import type { Bot, Capabilities, Home, OwnerActor } from "./types";
import { committed } from "./web-product-memory";

/** Where a slot added from the share sheet leads back to. It is a plain read of that sheet and carries no authority. */
export type S14ShareReturn = SnapshotTarget;
/** `/team/:id/capabilities`: the live ceiling, its draft form or one exact proposal, and earlier proposals. `slots` is the free-slot query. */
export interface S14BotPolicy { kind: "bot-policy"; bot: Bot; lifecycle: BotLifecycle; proposals: CapabilityProposal[]; proposal: CapabilityProposal | null; slots: ReturnType<S14Application["sharing"]["freeSlots"]>; routines: RoutineView[]; addSlot: boolean; addCoding: boolean; back: S14ShareReturn | null; account: string | null; draft: Capabilities | null; notice: string | null }
/** `/team/:id/retire` and `/team/:id/delete`: the exact preview the single command binds to, by hash. */
export interface S14BotEnd { kind: "bot-end"; action: "retire" | "delete"; bot: Bot; lifecycle: BotLifecycle; preview: BotLifecyclePreview; routines: RoutineView[] }
/** Lifecycle surfaces added to the product view union. */
export type S14LifecycleSurface = S14BotPolicy | S14BotEnd;
/** Query data the Bot overview adds: a reread receipt, and the share sheet to go back to once the Bot settles. */
export interface S14BotLanding { receipt: BotLifecycleReceipt | null; back: S14ShareReturn | null; account: string | null }

const identityPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const single = (fields: Record<string, unknown>, key: string) => { const v = fields[key]; return typeof v === "string" ? v : ""; };
const prefixed = (fields: Record<string, unknown>, prefix: string) => Object.keys(fields).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
const position = (value: string | null) => { const n = Number(value); return value && /^[1-9][0-9]{0,9}$/.test(value) ? n : null; };

/** Reads a share-sheet target out of `?kind=&id=&revision=&generation=`. Anything malformed is simply no way back. */
function shareReturn(search: URLSearchParams): S14ShareReturn | null {
  const kind = search.get("kind"), id = search.get("id"), revision = position(search.get("revision")), generation = position(search.get("generation"));
  return (kind === "artifact" || kind === "source") && id && identityPattern.test(id) && revision && generation ? { kind, id, revision, generation } : null;
}
/** The same target as query text, for form fields and redirects. */
export const shareQuery = (target: S14ShareReturn | null) => target ? `kind=${target.kind}&id=${target.id}&revision=${target.revision}&generation=${target.generation}` : "";
const fieldReturn = (fields: Record<string, unknown>) => shareReturn(new URLSearchParams(single(fields, "share")));
/** The Google connection to return to. Anything malformed is simply no way back. */
const accountReturn = (value: string | null) => value && identityPattern.test(value) ? value : null;
/** The Bot's ceiling plus what an account page asked for. It only ticks boxes: the owner still reads the exact proposal and accepts it. */
function accountDraft(bot: Bot, search: URLSearchParams): Capabilities | null {
  if (!accountReturn(search.get("account"))) return null;
  const slot = search.get("slot"), tools = (search.get("tools") ?? "").split(",").filter(tool => ["personal_read", "effect_send", "effect_calendar"].includes(tool));
  return { tools: [...new Set([...bot.capabilities.tools, ...tools])], resources: [...new Set([...bot.capabilities.resources, ...(slot && identityPattern.test(slot) ? [slot] : [])])] };
}
const routinesOf = (app: S14Application, actor: OwnerActor, botId: string) => app.routines.list(actor).filter(view => view.routine.capture.bots.some(bot => bot.id === botId));
function policy(app: S14Application, actor: OwnerActor, botId: string, search: URLSearchParams, notice: string | null = null, draft: Capabilities | null = null): S14BotPolicy {
  const read = app.botLifecycle.view(actor, botId), wanted = search.get("proposal"), edit = search.get("edit") === "1" || !!notice;
  const proposal = read.proposals.find(item => item.id === wanted) ?? (edit ? null : read.proposals.find(item => item.state === "proposed" && item.botRevision === read.bot.revision)) ?? null;
  return { kind: "bot-policy", ...read, proposal, slots: app.sharing.freeSlots(actor), routines: routinesOf(app, actor, botId), addSlot: search.get("add") === "slot", addCoding: search.get("add") === "coding", back: shareReturn(search), account: accountReturn(search.get("account")), draft: draft ?? accountDraft(read.bot, search), notice };
}
/** Resolves the capability, retire and delete pages; null leaves the path to the other product surfaces. Previews are reads. */
export function lifecycleView(app: S14Application, url: URL, actor: OwnerActor): S14LifecycleSurface | null {
  const match = /^\/team\/([a-zA-Z0-9_-]{1,128})\/(capabilities|retire|delete)$/.exec(url.pathname); if (!match) return null;
  const [, botId, page] = match as unknown as [string, string, "capabilities" | "retire" | "delete"];
  if (page === "capabilities") return policy(app, actor, botId, url.searchParams);
  const read = app.botLifecycle.view(actor, botId);
  return { kind: "bot-end", action: page, bot: read.bot, lifecycle: read.lifecycle, preview: app.botLifecycle.preview(actor, botId, page), routines: routinesOf(app, actor, botId) };
}
/** Reads a lifecycle receipt for this Bot only, so a link cannot show a landing banner on another Bot. */
export function botLanding(app: S14Application, actor: OwnerActor, url: URL, botId: string): S14BotLanding {
  const receipt = committed<BotLifecycleReceipt>(app, actor, url, "bot.");
  return { receipt: receipt && (receipt.bot?.id ?? receipt.proposal?.botId) === botId ? receipt : null, back: shareReturn(url.searchParams), account: accountReturn(url.searchParams.get("account")) };
}

const proposeFields = ["csrf", "requestId", "expectedRevision", "botId", "share", "account"], acceptFields = ["csrf", "requestId", "expectedRevision", "botId", "proposalId", "proposalHash", "share", "account"];
/** Translates the exact capability forms; they decide nothing, and the owner's whole selection is sent, with nothing inferred. */
export function lifecycleCommand(form: string, fields: Record<string, unknown>): S14Command | null {
  if (form === "capability-propose" || form === "capability-reenable") {
    for (const key of Object.keys(fields)) if (!proposeFields.includes(key) && !key.startsWith("tool:") && !key.startsWith("resource:")) throw new AppError("invalid_body");
    return { kind: form === "capability-reenable" ? "bot.reenable.propose" : "bot.capabilities.propose", requestId: single(fields, "requestId"), expectedRevision: Number(single(fields, "expectedRevision")), payload: { botId: single(fields, "botId"), capabilities: { tools: prefixed(fields, "tool:"), resources: prefixed(fields, "resource:") } } };
  }
  if (form !== "capability-accept") return null;
  for (const key of Object.keys(fields)) if (!acceptFields.includes(key)) throw new AppError("invalid_body");
  return { kind: "bot.capabilities.accept", requestId: single(fields, "requestId"), expectedRevision: Number(single(fields, "expectedRevision")), payload: { proposalId: single(fields, "proposalId"), proposalHash: single(fields, "proposalHash") } };
}
/** Landing page after a lifecycle receipt; null leaves other receipts to the core product. The share target survives each step. */
export function lifecycleSurface(receipt: S14Receipt, fields?: Record<string, unknown>): string | null {
  if (!receipt.kind.startsWith("bot.") || receipt.kind.startsWith("bot.proposal")) return null;
  const done = receipt as BotLifecycleReceipt, botId = done.bot?.id ?? done.proposal?.botId, share = shareQuery(fields ? fieldReturn(fields) : null), account = fields ? accountReturn(single(fields, "account")) : null, tail = `${share ? `&${share}` : ""}${account ? `&account=${account}` : ""}`;
  if (done.kind === "bot.capabilities.propose" || done.kind === "bot.reenable.propose") return `/team/${botId}/capabilities?proposal=${done.proposal!.id}${tail}#slip`;
  return `/team/${botId}?receipt=${done.requestId}${tail}`;
}
/** Where a refused lifecycle post leads. Every way back rereads the page, so a changed preview is seen before it can be pressed. */
export function lifecycleNext(form: string | null, value: unknown): string | null {
  const data = value as { kind?: string; botId?: unknown; payload?: { botId?: unknown; proposalId?: unknown } } | null;
  const page = (botId: unknown, tail: string) => typeof botId === "string" && identityPattern.test(botId) ? `/team/${botId}/${tail}` : "/team";
  if (form?.startsWith("capability-")) return page(data?.botId, "capabilities");
  if (data?.kind === "bot.retire") return page(data.payload?.botId, "retire");
  if (data?.kind === "bot.delete") return page(data.payload?.botId, "delete");
  return data?.kind?.startsWith("bot.") && !data.kind.startsWith("bot.proposal") ? page(data.payload?.botId, "capabilities") : null;
}
/** Brings the capability page back with the cause in words and the owner's selection kept, never accepting a refreshed card. */
export function lifecycleRecover(app: S14Application, form: string, fields: Record<string, unknown>, code: string, actor: OwnerActor, state: Home): S14BotPolicy | null {
  if (!form.startsWith("capability-")) return null;
  const botId = single(fields, "botId"); if (!identityPattern.test(botId) || !state.bots.some(bot => bot.id === botId)) return null;
  const draft = form === "capability-accept" ? null : { tools: prefixed(fields, "tool:"), resources: prefixed(fields, "resource:") };
  const search = new URLSearchParams(single(fields, "share")), account = accountReturn(single(fields, "account")); if (account) search.set("account", account);
  return policy(app, actor, botId, search, code, draft);
}
/** Every Bot's lifecycle for the page overview. It reads records only and starts no cleanup. */
export function lifecycleOverview(app: S14Application, actor: OwnerActor, bots: Bot[]): Record<string, BotLifecycle> {
  return Object.fromEntries(bots.map(bot => [bot.id, app.botLifecycle.view(actor, bot.id).lifecycle]));
}
