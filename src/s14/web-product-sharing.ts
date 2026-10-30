import { AppError } from "../errors";
import type { S14Application, S14Command, S14Receipt } from "./application";
import type { Work } from "./authority-types";
import type { Artifact } from "./report-types";
import { scopeOptions } from "./scope-options";
import type { ShareView, SharingReceipt, SnapshotTarget } from "./sharing-types";
import type { Bot, Home, OwnerActor } from "./types";
import { committed, memoryShareHours, shareExpiry } from "./web-product-memory";

/** One live share a start form may name. A choice is display data: `work.start` rechecks receiver, work and revision. */
export interface S14ScopeChoice { id: string; revision: number; receiverBotId: string; workId: string | null; kind: "snapshot" | "memory"; label: string }
/** One report file the picker offers, with the work it came from. Size past the sharing bound shows no link. */
export interface S14ShareFile { artifact: Artifact; title: string }
/** Share list: active first, every ended share kept, and the files that can start a new one. */
export interface S14ShareList { kind: "shares"; shares: ShareView[]; files: S14ShareFile[]; omitted: number }
/** The exact immutable bytes a share would copy, read through the same gateway the command uses. */
export interface S14ShareSnapshot { target: SnapshotTarget; name: string; mediaType: Artifact["mediaType"]; size: number; sha256: string; ownerBotId: string; text: string }
/** One eligible receiver and the free slot its radio pins, so a retried form stays the same command. */
export interface S14ShareReceiver { bot: Bot; scopeId: string }
/** The share sheet for one exact snapshot. A null `snapshot` carries the gateway's refusal in `refusal` and no control. */
export interface S14ShareSheet { kind: "share-new"; target: SnapshotTarget; snapshot: S14ShareSnapshot | null; refusal: string | null; receivers: S14ShareReceiver[]; others: { bot: Bot; why: "owner" | "no_slot" }[]; tasks: Work[]; work: Work | null; notice: string | null; hours: number; chosen: string }
/** One share with the work that names it. `receipt` is reread for the landing banner, so a link cannot fake it. */
export interface S14ShareDetail { kind: "share"; view: ShareView; work: Work | null; using: Work[]; receipt: SharingReceipt | null }
/** Sharing surfaces added to the product view union. */
export type S14SharingSurface = S14ShareList | S14ShareSheet | S14ShareDetail;

/** Largest copy the gateway accepts, repeated here only to skip a link that could only be refused. */
export const shareableBytes = 32768;
const listedFiles = 40;
/** Gateway codes that are too general to explain a sheet. The size check is a plain integer bound, so its code alone says nothing. */
const refusals: Record<string, string> = { not_found: "snapshot_unavailable", invalid_number: "snapshot_too_large" };
const identityPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const single = (fields: Record<string, unknown>, key: string) => { const v = fields[key]; return typeof v === "string" ? v : ""; };
const position = (value: string | null) => { const n = Number(value); return value && /^[1-9][0-9]{0,9}$/.test(value) ? n : null; };

function targetOf(kind: string | null, id: string | null, revision: string | null, generation: string | null): SnapshotTarget | null {
  const rev = position(revision), gen = position(generation);
  return (kind === "artifact" || kind === "source") && id && identityPattern.test(id) && rev && gen ? { kind, id, revision: rev, generation: gen } : null;
}
/** Slots are never reused after revoke, and memory shares occupy the same identity space. */
function usedSlots(app: S14Application, actor: OwnerActor): Set<string> {
  return app.store.read(tx => { app.requireOwner(tx, actor); return new Set(tx.all<{ id: string }>("SELECT id FROM snapshot_shares UNION SELECT id FROM memory_shares").map(row => row.id)); });
}
function reportFiles(app: S14Application, actor: OwnerActor, work: Work[]): S14ShareFile[] {
  const files = new Map<string, S14ShareFile>();
  for (const item of work.filter(entry => entry.grantId)) for (const report of app.reports.list(actor, item.id)) if (report.state === "available") for (const artifact of report.artifacts) files.set(artifact.id, { artifact, title: item.title });
  return [...files.values()].sort((a, b) => b.artifact.createdAt - a.artifact.createdAt);
}
function preview(app: S14Application, actor: OwnerActor, target: SnapshotTarget): { snapshot: S14ShareSnapshot | null; refusal: string | null } {
  try {
    const found = app.store.transaction(tx => { app.requireOwner(tx, actor); return app.artifacts.snapshot(tx, target); });
    return { refusal: null, snapshot: { target, name: found.name, mediaType: found.mediaType, size: found.size, sha256: found.sha256, ownerBotId: found.ownerBotId, text: new TextDecoder().decode(found.bytes) } };
  } catch (error) {
    if (error instanceof AppError && error.code !== "authentication_required") return { snapshot: null, refusal: refusals[error.code] ?? error.code };
    throw error;
  }
}
function sheet(app: S14Application, actor: OwnerActor, state: Home, target: SnapshotTarget, workId: string | null, draft: { notice?: string | null; hours?: number; chosen?: string } = {}): S14ShareSheet {
  const read = preview(app, actor, target), used = usedSlots(app, actor), receivers: S14ShareReceiver[] = [], others: S14ShareSheet["others"] = [];
  for (const bot of state.bots.filter(item => item.enabled)) {
    const scopeId = bot.capabilities.resources.find(id => app.policy.resources.includes(id) && !used.has(id));
    if (bot.id === read.snapshot?.ownerBotId) others.push({ bot, why: "owner" });
    else if (scopeId) receivers.push({ bot, scopeId });
    else others.push({ bot, why: "no_slot" });
  }
  const tasks = app.authority.list(actor).filter(work => work.state === "accepted" && !work.grantId);
  return { kind: "share-new", target, ...read, receivers, others, tasks, work: tasks.find(work => work.id === workId) ?? null, notice: draft.notice ?? null, hours: draft.hours ?? memoryShareHours.min, chosen: draft.chosen ?? "" };
}
function detail(app: S14Application, url: URL, actor: OwnerActor, id: string): S14ShareDetail {
  const view = app.sharing.list(actor).find(item => item.share.id === id); if (!view) throw new AppError("not_found", 404);
  const work = app.authority.list(actor), receipt = committed<SharingReceipt>(app, actor, url, "snapshot.");
  const using = work.filter(item => item.grantId && app.authority.view(actor, item.id).grant?.scopes.some(scope => scope.ref.kind === "share" && scope.ref.id === id));
  return { kind: "share", view, work: work.find(item => item.id === view.share.workId) ?? null, using, receipt: receipt?.share.id === id ? receipt : null };
}

/** Resolves `/shares`, `/shares/new` and `/shares/:id`; null leaves the path to the other product surfaces. */
export function sharingView(app: S14Application, url: URL, actor: OwnerActor, state: Home): S14SharingSurface | null {
  const path = url.pathname;
  if (path === "/shares") {
    const shares = app.sharing.list(actor), files = reportFiles(app, actor, app.authority.list(actor));
    return { kind: "shares", shares, files: files.slice(0, listedFiles), omitted: Math.max(0, files.length - listedFiles) };
  }
  if (path === "/shares/new") {
    const search = url.searchParams, target = targetOf(search.get("kind"), search.get("id"), search.get("revision"), search.get("generation"));
    if (!target) throw new AppError("not_found", 404);
    return sheet(app, actor, state, target, search.get("work"));
  }
  const match = /^\/shares\/([a-zA-Z0-9_-]{1,128})$/.exec(path);
  return match ? detail(app, url, actor, match[1]!) : null;
}

/** Live snapshot and memory shares the start forms can name. It reads only, because `sharing.list` takes the writer lock and this runs on every page. */
export function scopeChoices(app: S14Application, actor: OwnerActor, bots: Bot[]): S14ScopeChoice[] {
  const snapshots = app.store.read(tx => {
    app.requireOwner(tx, actor);
    return tx.all<{ id: string; record_json: string }>("SELECT id,record_json FROM snapshot_shares").flatMap(row => {
      const share = JSON.parse(row.record_json) as ShareView["share"];
      return share.active && app.sharing.scope(tx, { kind: "share", id: share.id, revision: share.revision }) ? [{ id: share.id, revision: share.revision, receiverBotId: share.receiverBotId, workId: share.workId, kind: "snapshot" as const, label: share.name }] : [];
    });
  });
  const memories = bots.filter(bot => bot.enabled).flatMap(bot => scopeOptions(app, actor, bot.id).map(({ label, scope }) => ({ id: scope.ref.id, revision: scope.ref.revision, receiverBotId: bot.id, workId: scope.workId, kind: "memory" as const, label })));
  return [...snapshots, ...memories];
}

const fields = ["csrf", "requestId", "targetKind", "targetId", "targetRevision", "targetGeneration", "receiver", "workId", "hours"];
/** Translates the share sheet into the typed command; it decides nothing and refuses unknown fields. The revision and slot come from the radio the owner pressed. */
export function sharingCommand(app: S14Application, form: string, data: Record<string, unknown>, actor: OwnerActor): S14Command | null {
  if (form !== "snapshot-share") return null;
  for (const key of Object.keys(data)) if (!fields.includes(key)) throw new AppError("invalid_body");
  const requestId = single(data, "requestId"), [botId = "", revision = "", scopeId = "", extra] = single(data, "receiver").split(":"), hours = Number(single(data, "hours"));
  const target = targetOf(single(data, "targetKind"), single(data, "targetId"), single(data, "targetRevision"), single(data, "targetGeneration")), expected = position(revision);
  if (extra !== undefined || !botId || !scopeId || !target || !expected || !Number.isSafeInteger(hours) || hours < memoryShareHours.min || hours > memoryShareHours.max) throw new AppError("snapshot_share_invalid");
  return { kind: "snapshot.share", requestId, expectedRevision: expected, payload: { scopeId, target, receiverBotId: botId, workId: single(data, "workId") || null, expiresAt: shareExpiry(app, actor, requestId, hours) } };
}
/** Landing page after a share or revoke receipt; null leaves other receipts to the core product. */
export function sharingSurface(receipt: S14Receipt): string | null {
  return receipt.kind === "snapshot.share" || receipt.kind === "snapshot.revoke" ? `/shares/${receipt.share.id}?receipt=${receipt.requestId}` : null;
}
/** Where a refused share or revoke post leads; null leaves other forms to the core product. */
export function sharingNext(form: string | null, value: unknown): string | null {
  if (form === "snapshot-share") return "/shares";
  const command = value as { kind?: string; payload?: { shareId?: unknown } } | null, id = command?.payload?.shareId;
  return command?.kind === "snapshot.revoke" && typeof id === "string" && identityPattern.test(id) ? `/shares/${id}` : null;
}
/** Rebuilds the sheet with the cause in words, keeping the receiver and hours the owner picked. */
export function sharingRecover(app: S14Application, form: string, data: Record<string, unknown>, code: string, actor: OwnerActor, state: Home): S14ShareSheet | null {
  if (form !== "snapshot-share") return null;
  const target = targetOf(single(data, "targetKind"), single(data, "targetId"), single(data, "targetRevision"), single(data, "targetGeneration")); if (!target) return null;
  const hours = Number(single(data, "hours")), workId = single(data, "workId");
  return sheet(app, actor, state, target, workId || null, { notice: code, hours: Number.isSafeInteger(hours) && hours >= memoryShareHours.min && hours <= memoryShareHours.max ? hours : memoryShareHours.min, chosen: single(data, "receiver") });
}
