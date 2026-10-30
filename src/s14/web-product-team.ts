import { AppError } from "../errors";
import type { S14Application, S14Command, S14Receipt } from "./application";
import type { Work, WorkView } from "./authority-types";
import type { GraphReceipt, GraphView, SchedulerLimits, WorkDefaults, WorkStep } from "./graph-types";
import type { EvidenceRequirement, Report, ReportView } from "./report-types";
import type { OwnerActor } from "./types";
import { workLimitBounds, type S14Overview } from "./web-product";

/** Owner-facing form values of the stored defaults; a wall limit that is not whole minutes rounds, never to zero. */
export interface S14LimitValues { concurrent: number; minutes: number; reads: number }
/** Graph lanes and committed report history of one opened work item, plus the revision being read. */
export interface S14WorkTeam { graph: GraphView | null; reports: ReportView[]; selected: ReportView | null }
/** Latest readable report of a work item, for work lists and cards. It is a link hint and proves nothing. */
export interface S14ReportHint { id: string; revision: number; coverage: Report["coverage"] }
/** Settings page for future-work defaults; `limits` are read-only installation ceilings, never owner authority. */
export interface S14WorkSettings { kind: "settings-work"; defaults: WorkDefaults; limits: SchedulerLimits; saved: WorkDefaults | null; notice: string | null; draft: S14LimitValues | null }

const single = (fields: Record<string, unknown>, key: string) => { const v = fields[key]; return typeof v === "string" ? v : ""; };

export const limitValues = (defaults: WorkDefaults): S14LimitValues => ({ concurrent: defaults.concurrency, minutes: Math.max(1, Math.round(defaults.wallMs / 60000)), reads: defaults.reads });

/** One owner line per target. A URL line asks for that page in full; any other line is a topic a cited source must cover. */
export function evidenceTargets(raw: string): EvidenceRequirement[] {
  const lines = raw.split("\n").map(line => line.trim()).filter(Boolean);
  return lines.map((label, index) => { const url = /^https?:\/\//i.test(label) ? label : null; return { id: `target_${index + 1}`, label, url, coverage: url ? "full_content_returned" : "snippet", freshness: "any" }; });
}

/** Reads the lanes and reports of one opened work. `?report=` selects a revision; anything else opens the latest. */
export function workTeam(app: S14Application, actor: OwnerActor, view: WorkView, url: URL): S14WorkTeam {
  if (!view.work.grantId) return { graph: null, reports: [], selected: null };
  const reports = app.reports.list(actor, view.work.id), wanted = url.searchParams.get("report");
  const selected = (wanted ? reports.find(item => (item.state === "available" ? item.report.id : item.id) === wanted) : undefined) ?? reports.at(-1) ?? null;
  return { graph: app.graph.view(actor, view.work.id), reports, selected };
}

/** One query over all reports for list hints. Its text is never read, so a withheld revision cannot leak through it. */
function reportHints(app: S14Application, actor: OwnerActor): Record<string, S14ReportHint> {
  const rows = app.store.read(tx => { app.requireOwner(tx, actor); return tx.all<{ id: string; work_id: string; revision: number; coverage: Report["coverage"] }>("SELECT id,work_id,revision,json_extract(content_json,'$.coverage') coverage FROM reports WHERE content_json IS NOT NULL ORDER BY revision"); });
  return Object.fromEntries(rows.map(row => [row.work_id, { id: row.id, revision: row.revision, coverage: row.coverage }]));
}

const activeSteps = new Set<WorkStep["state"]>(["running", "stopping"]), pendingSteps = new Set<WorkStep["state"]>(["queued", "waiting_evidence"]);
/** Bot state from its own lanes once the graph has admitted anything, so only the Bots really running breathe. */
function botState(view: WorkView, botId: string, steps: WorkStep[]): S14Overview["botStates"][string] | null {
  const state = view.work.state, mine = steps.filter(step => step.botId === botId);
  if (state === "waiting") return "waiting";
  if (mine.some(step => activeSteps.has(step.state))) return "working";
  if (state === "queued" || mine.some(step => pendingSteps.has(step.state))) return "queued";
  if (state === "stopping" || state === "running") return steps.some(step => step.attemptId) ? null : "working";
  return null;
}
/** Team fields of the page overview; every read here is query data and proves nothing about authority. */
export function teamOverview(app: S14Application, actor: OwnerActor, views: WorkView[], bots: { id: string }[]): Pick<S14Overview, "botStates" | "defaults" | "lanes" | "reports"> {
  const lanes = Object.fromEntries(views.map(view => [view.work.id, app.graph.view(actor, view.work.id).steps])), botStates: S14Overview["botStates"] = {};
  for (const bot of bots) botStates[bot.id] = "idle";
  for (const view of views) for (const bot of view.grant?.bots ?? []) {
    const state = botState(view, bot.id, lanes[view.work.id] ?? []);
    if (state && botStates[bot.id] !== "working") botStates[bot.id] = state;
  }
  return { botStates, defaults: app.graph.defaults(actor), lanes, reports: reportHints(app, actor) };
}

function savedDefaults(app: S14Application, actor: OwnerActor, url: URL): WorkDefaults | null {
  const id = url.searchParams.get("receipt"); if (!id || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) return null;
  const row = app.store.read(tx => { app.requireOwner(tx, actor); return tx.get<{ result_json: string }>("SELECT result_json FROM command_receipts WHERE owner_id='owner' AND request_id=?", id); });
  const receipt = row ? JSON.parse(row.result_json) as GraphReceipt : null;
  return receipt?.kind === "work.defaults.set" ? receipt.defaults ?? null : null;
}
const settings = (app: S14Application, actor: OwnerActor): Omit<S14WorkSettings, "saved" | "notice" | "draft"> => ({ kind: "settings-work", defaults: app.graph.defaults(actor), limits: app.authority.schedulerLimits });
/** Resolves `/settings/work`; null leaves the path to the other product surfaces. */
export function teamView(app: S14Application, url: URL, actor: OwnerActor): S14WorkSettings | null {
  return url.pathname === "/settings/work" ? { ...settings(app, actor), saved: savedDefaults(app, actor, url), notice: null, draft: null } : null;
}

function bounded(value: string, [min, max]: readonly [number, number]): number {
  const number = value.trim() === "" ? NaN : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new AppError("s14_limit_out_of_range");
  return number;
}
/** Translates the settings form into the typed defaults command; it decides nothing and refuses unknown fields. */
export function teamCommand(form: string, fields: Record<string, unknown>): S14Command | null {
  if (form !== "work-defaults") return null;
  for (const key of Object.keys(fields)) if (!["csrf", "requestId", "expectedRevision", "concurrent", "minutes", "reads"].includes(key)) throw new AppError("invalid_body");
  return { kind: "work.defaults.set", requestId: single(fields, "requestId"), expectedRevision: Number(single(fields, "expectedRevision")),
    payload: { concurrency: bounded(single(fields, "concurrent"), workLimitBounds.concurrent), wallMs: bounded(single(fields, "minutes"), workLimitBounds.minutes) * 60000, reads: bounded(single(fields, "reads"), workLimitBounds.reads) } };
}
/** Landing page after a lane stop or defaults receipt; null leaves other receipts to the core product. */
export function teamSurface(receipt: S14Receipt): string | null {
  if (receipt.kind === "work.defaults.set") return `/settings/work?receipt=${receipt.requestId}`;
  if (receipt.kind === "work.step.stop") return `/work/${(receipt as GraphReceipt).step!.workId}`;
  return null;
}
/** Where a refused defaults post leads. A refused lane stop keeps the generic `payload.workId` path. */
export function teamNext(form: string | null, value: unknown): string | null {
  return form === "work-defaults" || (value as { kind?: string } | null)?.kind === "work.defaults.set" ? "/settings/work" : null;
}
/** Rebuilds settings with the cause in words. A stale form shows the fresh saved values, so nothing is overwritten unseen. */
export function teamRecover(app: S14Application, form: string, fields: Record<string, unknown>, code: string, actor: OwnerActor): S14WorkSettings | null {
  if (form !== "work-defaults") return null;
  const number = (key: string) => { const value = Number(single(fields, key)); return Number.isSafeInteger(value) && value > 0 ? value : 1; };
  return { ...settings(app, actor), saved: null, notice: code, draft: code === "stale_revision" ? null : { concurrent: number("concurrent"), minutes: number("minutes"), reads: number("reads") } };
}
/** True when a work item finished with at least one lane that did not commit. */
export const partialWork = (work: Work) => work.state === "ready" && work.reason === "partial_graph_evidence";
