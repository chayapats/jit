import { AppError } from "../errors";
import { jobData, validateJobLimits } from "../jobs/queue";
import { requireId, requireReference, requireText } from "../sources";
import type { TransactionStore } from "../store";
import type { ApplicationRunPort, ManagedContextOutcome } from "./run-port";
import type { ApplicationRunEvent, ApplicationRunOutcome, ApplicationRunRequest, ManagedContextReference, RunReason, TeamPolicy } from "./types";
import { requireRoleRoute } from "./configuration";

const reasons: RunReason[] = ["complete", "unknown_model", "route_unavailable", "quota", "needs_login", "cancelled", "max_rounds", "budget_exhausted", "invalid_result", "context_retired"];
const emptyUsage = () => ({ calls: 0, rounds: 0, hops: 0, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0 });
/** Constructs finite, safe fixture outcomes without raw provider errors or live-readiness claims. */
export function fixtureOutcome(reason: RunReason, output: string | null = null): ApplicationRunOutcome {
  return { state: reason === "complete" ? "complete" : ["max_rounds", "budget_exhausted", "cancelled"].includes(reason) ? "incomplete" : reason === "invalid_result" ? "error" : "blocked",
    reason, mode: "fixture", output: reason === "complete" ? output : null, usage: emptyUsage(), session: null };
}

/** Rejects unbounded or permissive requests at the app seam before an adapter receives them. */
export function validateRunRequest(request: ApplicationRunRequest, policy: TeamPolicy): void {
  jobData(request, policy.contextBytes);
  for (const id of [request.runId, request.projectId, request.topicId, request.roleId, request.context?.id, request.fence?.jobId]) requireId(id);
  requireText(request.purpose, 1200); requireText(request.instructions?.responsibility, policy.responsibilityBytes);
  requireRoleRoute(request.route);
  if (!Array.isArray(request.instructions?.operator) || request.instructions.operator.length > 8) throw new AppError("invalid_run_request");
  for (const text of request.instructions.operator) requireText(text, 2048);
  for (const value of [request.context.generation, request.fence.generation, request.fence.ownerGeneration, request.configuration.ownerRevision, request.configuration.projectRevision, request.configuration.roleRevision]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new AppError("invalid_run_request");
  }
  if (request.context.generation < 1 || request.fence.generation < 1 || request.fence.ownerGeneration < 1 || request.configuration.roleRevision < 1 ||
      !request.route || !Array.isArray(request.tools) || request.tools.length !== 0 ||
      !request.policy || Object.keys(request.policy).sort().join(",") !== "arbitraryFetch,genericExecution,hostedLookup,repositoryDiscovery" || Object.values(request.policy).some(value => value !== false) ||
      !Array.isArray(request.manifest?.sources) || !Array.isArray(request.manifest.claims) || request.manifest.sources.length + request.manifest.claims.length > policy.sourceLimit) throw new AppError("invalid_run_request");
  for (const source of request.manifest.sources) { requireId(source.projectId); requireReference(source.reference); requireText(source.text, policy.contextBytes); }
  for (const claim of request.manifest.claims) {
    requireId(claim.projectId); requireId(claim.claimId); requireText(claim.text, policy.contextBytes);
    if (![claim.revision, claim.generation].every(value => Number.isSafeInteger(value) && value > 0)) throw new AppError("invalid_run_request");
  }
  validateJobLimits(request.limits, { roles: 10000, calls: 10000, rounds: 10000, hops: 10000, contextTokens: 1e9, outputTokens: 1e9, retries: 100, wallMs: 3600000 });
}

/** Validates result coherence and ceilings, replacing invalid/raw adapter data with a safe error. */
export function normalizeFixtureResult(value: unknown, request: ApplicationRunRequest, outputBytes: number): ApplicationRunOutcome {
  try {
    const result = JSON.parse(jobData(value, outputBytes + 2048)) as ApplicationRunOutcome;
    const expected = fixtureOutcome(result.reason);
    if (!reasons.includes(result.reason) || result.mode !== "fixture" || result.state !== expected.state ||
        (result.reason === "complete" ? typeof result.output !== "string" || !result.output.trim() : result.output !== null) ||
        (typeof result.output === "string" && Buffer.byteLength(result.output) > outputBytes) || !result.usage ||
        Object.keys(result.usage).sort().join(",") !== "calls,contextTokens,hops,outputTokens,retries,rounds,wallMs") return fixtureOutcome("invalid_result");
    if (result.output !== null) requireText(result.output, outputBytes);
    for (const [key, value] of Object.entries(result.usage)) {
      if (!Number.isSafeInteger(value) || value < 0 || value > request.limits[key as keyof typeof result.usage]) return fixtureOutcome("invalid_result");
    }
    if (result.session !== null && (result.session.adapter !== "scripted" || result.session.id !== request.runId ||
        result.session.context.id !== request.context.id || result.session.context.generation !== request.context.generation)) return fixtureOutcome("invalid_result");
    // Return only declared fields, never raw SDK objects or extra model-authored fields.
    return { ...expected, output: result.output, usage: result.usage, session: result.session === null ? null : { adapter: "scripted", id: request.runId, context: { ...request.context } } };
  } catch { return fixtureOutcome("invalid_result"); }
}

/** Deterministic in-process fixture; it contains no network, SDK, discovery or model protocol loop. */
export class ScriptedRunPort implements ApplicationRunPort {
  readonly #requests: ApplicationRunRequest[] = [];
  constructor(readonly store: TransactionStore, readonly policy: TeamPolicy, readonly outputBytes: number,
    private readonly script: (request: ApplicationRunRequest, signal: AbortSignal) => unknown | Promise<unknown> = request => ({
      ...fixtureOutcome("complete", `ตัวอย่างจำลอง · ${request.purpose}\nบทบาท: ${request.instructions.responsibility}\nผลนี้เป็น fixture ไม่ได้เรียก Grok หรือ Codex`),
      usage: { ...emptyUsage(), calls: 1, rounds: 1, hops: 1 }, session: { adapter: "scripted", id: request.runId, context: request.context },
    }), private readonly deleteFails: () => boolean = () => false) {
    const maximum = { roleLimit: 100, responsibilityBytes: 8192, sourceLimit: 32, contextBytes: 65536 };
    if (Object.keys(policy).sort().join(",") !== Object.keys(maximum).sort().join(",") ||
        Object.entries(maximum).some(([key, max]) => !Number.isSafeInteger(policy[key as keyof TeamPolicy]) || policy[key as keyof TeamPolicy] < 1 || policy[key as keyof TeamPolicy] > max) ||
        !Number.isSafeInteger(outputBytes) || outputBytes < 1 || outputBytes > 65536) throw new AppError("invalid_team_policy");
    this.policy = Object.freeze({ ...policy });
  }

  /** Returns isolated evidence of the last 32 exact invocations, without unbounded in-memory retention. */
  get requests(): readonly ApplicationRunRequest[] { return structuredClone(this.#requests); }

  /** Performs exactly one scripted invocation, checking retirement and cancellation again after awaiting it. */
  async invoke(request: ApplicationRunRequest, signal: AbortSignal, observe: (event: ApplicationRunEvent) => void): Promise<ApplicationRunOutcome> {
    validateRunRequest(request, this.policy);
    const snapshot = structuredClone(request);
    const active = () => this.store.read(tx => tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", snapshot.context.id, snapshot.context.generation)?.state === "active");
    if (!active()) return fixtureOutcome("context_retired");
    if (signal.aborted) return fixtureOutcome("cancelled");
    this.#requests.push(structuredClone(snapshot)); if (this.#requests.length > 32) this.#requests.shift();
    observe({ kind: "started", runId: snapshot.runId, context: { ...snapshot.context } });
    let result: ApplicationRunOutcome;
    try { result = normalizeFixtureResult(await this.script(structuredClone(snapshot), signal), snapshot, this.outputBytes); }
    catch { result = fixtureOutcome("invalid_result"); }
    if (!active()) result = fixtureOutcome("context_retired");
    else if (signal.aborted) result = fixtureOutcome("cancelled");
    observe({ kind: "finished", runId: snapshot.runId, outcome: structuredClone(result) }); return result;
  }

  /** Fences this exact generation durably; an unknown reference cannot create a live context. */
  async retire(context: ManagedContextReference): Promise<ManagedContextOutcome> {
    requireId(context.id);
    if (!Number.isSafeInteger(context.generation) || context.generation < 1) throw new AppError("invalid_context_reference");
    this.store.transaction(tx => {
      if (!tx.get("SELECT id FROM team_contexts WHERE id = ? AND generation = ?", context.id, context.generation)) throw new AppError("context_not_found", 404);
      tx.run("UPDATE team_contexts SET state = 'retired' WHERE id = ? AND generation = ? AND state = 'active'", context.id, context.generation);
    });
    return { state: "retired", context: { ...context } };
  }

  /** Deletion always retires first; a visible failure keeps replay fenced and permits an explicit retry. */
  async delete(context: ManagedContextReference): Promise<ManagedContextOutcome> {
    await this.retire(context);
    if (this.store.read(tx => tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", context.id, context.generation)?.state === "deleted")) return { state: "deleted", context: { ...context } };
    const failed = this.deleteFails();
    this.store.transaction(tx => { tx.run("UPDATE team_contexts SET state = ? WHERE id = ? AND generation = ?", failed ? "delete_failed" : "deleted", context.id, context.generation); });
    return failed ? { state: "delete_failed", context: { ...context }, nextAction: "retry_managed_delete" } : { state: "deleted", context: { ...context } };
  }
}
