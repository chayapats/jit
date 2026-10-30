import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import type { S14Application, S14Command, S14Receipt } from "./application";
import type { Effect, Work, WorkView } from "./authority-types";
import type { NativeIntent, RecoveryReceipt, RecoveryView, WorkCheckpoint } from "./recovery-types";
import type { OwnerActor } from "./types";
import { committed } from "./web-product-memory";
import type { S14StatementDraft } from "./web-statement";

/** Where one recovery line sits: the owner decides, Jit cannot confirm yet, a safe step goes on, or nothing resumes. */
export type S14RecoveryGroup = "needs" | "waiting" | "resumed" | "closed";
/** Words chosen for a line. `resumed` needs a recorded replacement attempt, and only a replay-safe checkpoint gets it. */
export type S14RecoveryPhase = "queued" | "resumed" | "waiting" | "unconfirmed" | "closed";
/** One step of a recovery line, named by its Bot and trusted handler. */
export interface S14RecoveryStep { botId: string; botName: string; handler: string | null }
/** One work item for one reason. Several lanes with the same outcome read as one line. `effect` is set for an unknown external action. */
export interface S14RecoveryItem { group: S14RecoveryGroup; phase: S14RecoveryPhase; work: Work; reason: string | null; steps: S14RecoveryStep[]; reports: number; effect: Effect | null }
/** A native session Jit could not confirm, with the work it belongs to when the record survives. */
export interface S14RecoverySession { intent: NativeIntent; work: Work | null }
/** Read-only `/recovery` surface. No field here can start, clean up or retry anything. */
export interface S14RecoverySurface { kind: "recovery"; items: S14RecoveryItem[]; sessions: S14RecoverySession[]; settled: Record<"retired" | "deleted" | "not_created" | "in_use", number>; omitted: number; actualUsage: null }
/** Count for the attention row. Unknown effects have their own rows, so they are not counted here. */
export interface S14RecoverySummary { open: number }

const listedResumed = 20;
const identityPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const single = (fields: Record<string, unknown>, key: string) => { const v = fields[key]; return typeof v === "string" ? v : ""; };
/** Work reasons the recovery page explains, for a link from the work's own banner. */
export const recoveryReason = (reason: string | null) => !!reason && (reason.startsWith("native_") || reason === "old_transport_unsettled" || reason === "handler_requires_reconciliation");

function stepOf(view: WorkView, checkpoint: WorkCheckpoint): S14RecoveryStep[] {
  const attempt = view.attempts.find(item => item.id === checkpoint.id);
  return attempt ? [{ botId: attempt.snapshot.bot.id, botName: attempt.snapshot.bot.name, handler: attempt.step?.handler ?? null }] : [];
}
function placed(checkpoint: WorkCheckpoint, work: Work): Pick<S14RecoveryItem, "group" | "phase" | "reason"> {
  if (work.state === "stopped" || work.state === "stopping") return { group: "closed", phase: "closed", reason: checkpoint.reason ?? "owner_stopped" };
  if (checkpoint.state === "queued" || checkpoint.state === "resumed") {
    if (checkpoint.replay === "replay_safe") return checkpoint.state === "resumed" && checkpoint.replacementAttemptId ? { group: "resumed", phase: "resumed", reason: null } : { group: "resumed", phase: "queued", reason: null };
    return { group: "needs", phase: "waiting", reason: "handler_requires_reconciliation" };
  }
  if (checkpoint.reason === "owner_stopped" || checkpoint.reason === "owner_stopped_step") return { group: "closed", phase: "closed", reason: checkpoint.reason };
  if (checkpoint.reason === "old_transport_unsettled") return { group: "waiting", phase: "unconfirmed", reason: checkpoint.reason };
  return { group: "needs", phase: "waiting", reason: checkpoint.reason };
}
/** Groups checkpoints by work and reason. It keeps the service's reason code and never derives one from model text. */
function collect(read: RecoveryView, views: WorkView[]): S14RecoveryItem[] {
  const byWork = new Map(views.map(view => [view.work.id, view])), lines = new Map<string, S14RecoveryItem>();
  const add = (item: S14RecoveryItem, key: string) => {
    const seen = lines.get(key); if (!seen) { lines.set(key, item); return; }
    for (const step of item.steps) if (!seen.steps.some(known => known.botId === step.botId && known.handler === step.handler)) seen.steps.push(step);
    seen.reports += item.reports;
  };
  for (const view of views) for (const effect of view.effects) if (effect.state === "unknown") add({ group: effect.resolution ? "closed" : "needs", phase: effect.resolution ? "closed" : "waiting", work: view.work, reason: "unknown_effect_reconcile_only", steps: [], reports: 0, effect }, `effect:${effect.id}`);
  for (const checkpoint of read.checkpoints) {
    if (!["waiting", "queued", "resumed"].includes(checkpoint.state)) continue;
    const view = byWork.get(checkpoint.workId); if (!view) continue;
    if (checkpoint.reason === "unknown_effect_reconcile_only" && view.effects.some(effect => effect.state === "unknown")) continue;
    const place = placed(checkpoint, view.work);
    add({ ...place, work: view.work, steps: stepOf(view, checkpoint), reports: checkpoint.evidence.length, effect: null }, `${view.work.id}:${place.group}:${place.phase}:${place.reason ?? ""}`);
  }
  for (const view of views) if (view.work.reason === "native_checkpoint_missing" && view.work.state === "blocked") add({ group: "needs", phase: "waiting", work: view.work, reason: "native_checkpoint_missing", steps: [], reports: 0, effect: null }, `${view.work.id}:missing`);
  return [...lines.values()];
}
const unresolved = (read: RecoveryView) => read.native.filter(intent => intent.state === "unresolved");
const allViews = (app: S14Application, actor: OwnerActor) => app.authority.list(actor).filter(work => work.grantId).map(work => app.authority.view(actor, work.id));

/** Attention count over the page's own work views: lines that wait on the owner or on Jit, plus unconfirmed sessions. */
export function recoverySummary(app: S14Application, actor: OwnerActor, views: WorkView[]): S14RecoverySummary {
  const read = app.recovery.view(actor);
  return { open: collect(read, views).filter(item => !item.effect && (item.group === "needs" || item.group === "waiting")).length + unresolved(read).length };
}
/** Resolves `/recovery`; null leaves the path to the other product surfaces. It reads metadata and starts nothing. */
export function recoveryView(app: S14Application, url: URL, actor: OwnerActor): S14RecoverySurface | null {
  if (url.pathname !== "/recovery") return null;
  const read = app.recovery.view(actor), views = allViews(app, actor), byWork = new Map(views.map(view => [view.work.id, view.work])), items = collect(read, views);
  const resumed = items.filter(item => item.group === "resumed"), count = (...states: NativeIntent["state"][]) => read.native.filter(intent => states.includes(intent.state)).length;
  return { kind: "recovery", items: [...items.filter(item => item.group !== "resumed"), ...resumed.slice(-listedResumed).reverse()], omitted: Math.max(0, resumed.length - listedResumed),
    sessions: unresolved(read).map(intent => ({ intent, work: intent.workId ? byWork.get(intent.workId) ?? null : null })),
    settled: { retired: count("retired"), deleted: count("deleted"), not_created: count("not_created"), in_use: count("creating", "correlated") }, actualUsage: read.actualUsage };
}

const statementFields = ["csrf", "requestId", "expectedRevision", "effectId", "actionHash", "outcome", "note"];
/** Translates the owner's statement into the typed command; it decides nothing and refuses unknown fields. A missing choice reaches the service and refuses there. */
export function recoveryCommand(form: string, fields: Record<string, unknown>): S14Command | null {
  if (form !== "effect-reconcile") return null;
  for (const key of Object.keys(fields)) if (!statementFields.includes(key)) throw new AppError("invalid_body");
  return { kind: "effect.reconcile", requestId: single(fields, "requestId"), expectedRevision: Number(single(fields, "expectedRevision")), payload: { effectId: single(fields, "effectId"), actionHash: single(fields, "actionHash"), outcome: single(fields, "outcome") as "occurred" | "did_not_occur", note: single(fields, "note") } };
}
/** Landing page after a statement receipt; null leaves other receipts to the core product. */
export function recoverySurface(receipt: S14Receipt): string | null {
  return receipt.kind === "effect.reconcile" ? `/effects/${receipt.effect.id}?receipt=${receipt.requestId}#slip` : null;
}
/** Where a refused statement leads; null leaves other forms to the core product. */
export function recoveryNext(form: string | null, value: unknown): string | null {
  if (form !== "effect-reconcile") return null;
  const id = single((value ?? {}) as Record<string, unknown>, "effectId");
  return identityPattern.test(id) ? `/effects/${id}` : "/recovery";
}
/** Reads a statement receipt for this effect only, so a link cannot show the saved banner on another card. */
export function statementSaved(app: S14Application, actor: OwnerActor, url: URL, effectId: string): boolean {
  return committed<RecoveryReceipt>(app, actor, url, "effect.reconcile")?.effect.id === effectId;
}
/** Brings the card back with the cause in words. The note survives unless it looks like a credential, which is never echoed. */
export function statementRecover(app: S14Application, form: string, fields: Record<string, unknown>, code: string, actor: OwnerActor) {
  if (form !== "effect-reconcile") return null;
  const id = single(fields, "effectId"); if (!identityPattern.test(id)) return null;
  const note = single(fields, "note"), outcome = single(fields, "outcome");
  const draft: S14StatementDraft = { outcome: outcome === "occurred" || outcome === "did_not_occur" ? outcome : null, note: containsCredential(note) ? "" : note };
  return { kind: "effect" as const, ...app.authority.effect(actor, id), notice: code, draft };
}
