import { ScriptedNativeLedger } from "../jobs/scripted-ledger";
import { AppError } from "../errors";
import { jobData, validateJobLimits } from "../jobs/queue";
import type { JobLimits } from "../jobs/types";
import { requireId, requireReference, requireText } from "../sources";
import type { TransactionStore } from "../store";
import type { ApplicationRunPort, ManagedContextOutcome } from "./run-port";
import type { ApplicationRunEvent, ApplicationRunOutcome, ApplicationRunRequest, ManagedContextReference, RunReason, TeamPolicy } from "./types";
import { contextPacketSections } from "./types";
import { requireRoleRoute } from "./configuration";
import { renderContextAnswer } from "../memory/context-answer";
import { specialistResultInstruction } from "./specialist-results";
import { openRunTools, runMaxTurns, runToolsFailure, validateGrant, webCallLimit, type RunExecution, type RunTools, type ToolExecutionResult } from "../exec/run-tools";

const reasons: RunReason[] = ["complete", "unknown_model", "route_unavailable", "quota", "needs_login", "cancelled", "max_rounds", "budget_exhausted", "invalid_result", "context_retired"];
const emptyUsage = () => ({ calls: 0, rounds: 0, hops: 0, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0, tokensUnknown: false });
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
  const sourceIds = new Set<string>();
  for (const source of request.manifest.sources) {
    const key = `${source.projectId}/${source.reference.sourceId}`;
    if (sourceIds.has(key)) throw new AppError("invalid_run_request");
    sourceIds.add(key);
  }
  for (const claim of request.manifest.claims) {
    requireId(claim.projectId); requireId(claim.claimId); requireText(claim.text, policy.contextBytes);
    if (![claim.revision, claim.generation].every(value => Number.isSafeInteger(value) && value > 0)) throw new AppError("invalid_run_request");
  }
  const claimIds = new Set<string>();
  for (const claim of request.manifest.claims) {
    const key = `${claim.projectId}/${claim.claimId}`;
    if (claimIds.has(key)) throw new AppError("invalid_run_request");
    claimIds.add(key);
  }
  if (request.attachments !== undefined) {
    if (!Array.isArray(request.attachments) || request.attachments.length > 20) throw new AppError("invalid_run_request");
    const ids = new Set<string>();
    for (const ref of request.attachments) {
      requireId(ref?.attachmentId);
      requireReference({ sourceId: ref.attachmentId, revision: ref.revision, generation: ref.generation });
      if (!["image", "pdf", "text"].includes(ref.kind) || typeof ref.inline !== "boolean" || ids.has(ref.attachmentId)) throw new AppError("invalid_run_request");
      ids.add(ref.attachmentId);
    }
  }
  if (request.web !== undefined && typeof request.web !== "boolean") throw new AppError("invalid_run_request");
  validateGrant(request);
  if (request.manifest.context !== undefined) validateContextLayout(request, policy);
  validateJobLimits(request.limits, { roles: 10000, calls: 10000, rounds: 10000, hops: 10000, contextTokens: 1e9, outputTokens: 1e9, retries: 100, wallMs: 3600000 });
}

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
/** app.memory_context/v1 layout shape: labels only; it can never add tools, routes or authority to a request. */
function validateContextLayout(request: ApplicationRunRequest, policy: TeamPolicy): void {
  const context = request.manifest.context!;
  if (!context || typeof context !== "object" || context.version !== 1 || context.policy !== 1 ||
      !Array.isArray(context.constraints) || context.constraints.length > 32 || !Array.isArray(context.claims) ||
      context.claims.length !== request.manifest.claims.length || !context.omitted || !context.derivation ||
      ![context.omitted.constraints, context.omitted.claims, context.omitted.unavailable, context.derivation.inputDepth].every(count) ||
      ![context.omitted.budget, context.omitted.loopGuard].every(value => typeof value === "boolean")) throw new AppError("invalid_run_request");
  requireId(context.recordId);
  for (const item of context.constraints) {
    if (!["task", "decision"].includes(item.kind) || !["proposed", "accepted", "ready_for_review", "current"].includes(item.state) ||
        typeof item.truncated !== "boolean" || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new AppError("invalid_run_request");
    requireId(item.id); requireId(item.topicId); requireReference(item.source); requireText(item.text, policy.contextBytes);
  }
  for (const item of context.claims) {
    if (!["explicit_preference", "inference"].includes(item.layer) || !["project", "cross_project"].includes(item.scope) ||
        !["explicit_fact", "inference"].includes(item.kind) || !Array.isArray(item.conflicts) || item.conflicts.length > 7 ||
        (item.scope === "cross_project" && item.layer !== "inference")) throw new AppError("invalid_run_request");
    requireReference(item.source);
    for (const ref of item.conflicts) {
      requireId(ref.claimId);
      if (![ref.revision, ref.generation].every(value => Number.isSafeInteger(value) && value > 0)) throw new AppError("invalid_run_request");
    }
  }
  if (context.packet !== undefined) validatePacket(request, policy);
}

const sectionStates = ["included", "trimmed", "dropped", "empty", "withheld"];
const omissionReasons = ["budget", "ceiling", "loop_guard", "unavailable", "run_policy"];
/** app.context_packet/v1 shape: eight labelled sections in fixed order; pinned decisions and indexes only label data. */
function validatePacket(request: ApplicationRunRequest, policy: TeamPolicy): void {
  const packet = request.manifest.context!.packet!;
  const sources = request.manifest.sources.length;
  const index = (value: unknown) => count(value) && (value as number) < sources;
  if (!packet || typeof packet !== "object" || packet.contract !== "app.context_packet/v1" || packet.version !== 1 ||
      !Array.isArray(packet.sections) || packet.sections.length !== contextPacketSections.length ||
      packet.sections.some((section, at) => !section || section.order !== at + 1 || section.name !== contextPacketSections[at] ||
        !sectionStates.includes(section.state) || !count(section.items) || !count(section.bytes)) ||
      !Array.isArray(packet.pinned) || !Array.isArray(packet.omissions) || packet.omissions.length > 32 ||
      packet.omissions.some(item => !item || !contextPacketSections.includes(item.section) || (item.section as string) === "pinned_decisions" ||
        !omissionReasons.includes(item.reason) || !count(item.items)) ||
      !packet.sourceIndexes || !Array.isArray(packet.sourceIndexes.currentRequest) || !Array.isArray(packet.sourceIndexes.recentMessages) ||
      ![...packet.sourceIndexes.currentRequest, ...packet.sourceIndexes.recentMessages].every(index) ||
      !packet.budget || ![packet.budget.bytes, packet.budget.pinned, packet.budget.used].every(count)) throw new AppError("invalid_run_request");
  const pinnedIds = new Set<string>();
  for (const item of packet.pinned) {
    if (!item || !["topic", "project"].includes(item.scope) || !Number.isSafeInteger(item.revision) || item.revision < 1 || pinnedIds.has(item.id)) throw new AppError("invalid_run_request");
    requireId(item.id); requireId(item.topicId); requireReference(item.source);
    requireText(item.conclusion, policy.contextBytes); requireText(item.rationale, policy.contextBytes);
    pinnedIds.add(item.id);
  }
  if (packet.summary !== null) {
    const summary = packet.summary;
    if (!summary || !Number.isSafeInteger(summary.summaryRevision) || summary.summaryRevision < 1 || !index(summary.index) || !count(summary.depth) ||
        !Array.isArray(summary.sourceIds) || summary.sourceIds.length > 256) throw new AppError("invalid_run_request");
    requireReference(summary.source);
    const cited = request.manifest.sources[summary.index]!.reference;
    if (cited.sourceId !== summary.source.sourceId || cited.revision !== summary.source.revision || cited.generation !== summary.source.generation) throw new AppError("invalid_run_request");
    for (const id of summary.sourceIds) requireId(id);
  }
}

/** Validates result coherence and ceilings, replacing invalid/raw adapter data with a safe error. */
export function normalizeFixtureResult(value: unknown, request: ApplicationRunRequest, outputBytes: number): ApplicationRunOutcome {
  const outcome = normalizePortResult(value, request, outputBytes);
  return outcome.mode === "fixture" ? outcome : fixtureOutcome("invalid_result");
}

/**
 * Validates one port outcome (fixture or production) against the request and
 * ceilings. Fixture scripts stay fixture-strict through normalizeFixtureResult;
 * work executors accept either mode so the concrete bridge can commit.
 *
 * Fixture usage is authoritatively bounded by the request limits. Production
 * usage is measured by the trusted host across bounded retries, so call/round
 * counts are checked against the worst-case admission while token overrun is
 * preserved as measured evidence instead of rejected.
 */
export function normalizePortResult(value: unknown, request: ApplicationRunRequest, outputBytes: number): ApplicationRunOutcome {
  let mode: ApplicationRunOutcome["mode"] | null = null;
  const invalidFor = (recognized: ApplicationRunOutcome["mode"]): ApplicationRunOutcome =>
    recognized === "production"
      ? { state: "error", reason: "invalid_result", mode: "production", output: null,
          usage: { calls: 0, rounds: 0, hops: 0, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0, tokensUnknown: false }, session: null }
      : fixtureOutcome("invalid_result");
  try {
    const result = JSON.parse(jobData(value, outputBytes + 2048)) as ApplicationRunOutcome;
    if (result.mode !== "fixture" && result.mode !== "production") return fixtureOutcome("invalid_result");
    mode = result.mode;
    const expected = fixtureOutcome(result.reason);
    if (!reasons.includes(result.reason) || result.state !== expected.state ||
        (result.reason === "complete" ? typeof result.output !== "string" || !result.output.trim() : result.output !== null) ||
        (typeof result.output === "string" && Buffer.byteLength(result.output) > outputBytes) || !result.usage ||
        Object.keys(result.usage).sort().join(",") !== "calls,contextTokens,hops,outputTokens,retries,rounds,tokensUnknown,wallMs" ||
        typeof result.usage.tokensUnknown !== "boolean") return invalidFor(mode);
    if (result.output !== null) requireText(result.output, outputBytes);
    if (!validUsage(result, request)) return invalidFor(mode);
    const adapter = mode === "production" ? "schway" : "scripted";
    if (result.session !== null && (result.session.adapter !== adapter || result.session.id !== request.runId ||
        result.session.context.id !== request.context.id || result.session.context.generation !== request.context.generation)) return invalidFor(mode);
    // Return only declared fields, never raw SDK objects or extra model-authored fields.
    return { ...expected, mode, output: result.output, usage: result.usage, session: result.session === null ? null : { adapter, id: request.runId, context: { ...request.context } } };
  } catch { return invalidFor(mode ?? "fixture"); }
}

/**
 * Usage validation by mode and reason. Fixture usage stays authoritatively
 * bounded by the request limits. Production usage is host-measured: completed
 * runs carry the worst-case admission shape with measured token overrun, while
 * pre-model blocked/error outcomes carry coherent zero-attempt usage.
 */
function validUsage(result: ApplicationRunOutcome, request: ApplicationRunRequest): boolean {
  const usage = result.usage;
  const integers = [usage.calls, usage.rounds, usage.hops, usage.retries, usage.contextTokens, usage.outputTokens, usage.wallMs]
    .every(value => Number.isSafeInteger(value) && value >= 0);
  if (!integers) return false;
  if (result.mode === "fixture") {
    if (usage.tokensUnknown !== false) return false;
    return Object.entries(usage).every(([key, value]) => key === "tokensUnknown" || (value as number) <= request.limits[key as keyof JobLimits]);
  }
  // Each model turn may take every host attempt; a run without an execution grant has exactly one turn.
  const maxCalls = Math.min(Math.max(1, Math.ceil(request.limits.retries + 1)), 10) * runMaxTurns(request);
  const attempted = usage.rounds >= 1 && usage.rounds <= maxCalls &&
    usage.calls >= usage.rounds && usage.calls - usage.rounds <= webCallLimit(request) && usage.retries === usage.rounds - 1 && usage.hops === 0;
  if (result.reason === "complete") return attempted;
  const zeroAttempt = usage.calls === 0 && usage.rounds === 0 && usage.retries === 0 &&
    usage.hops === 0 && usage.contextTokens === 0 && usage.outputTokens === 0;
  return zeroAttempt || attempted;
}

/** Appends the deterministic app.memory_context/v1 fixture answer within the run's output ceiling. */
export function withContextAnswer(prefix: string, request: ApplicationRunRequest, outputBytes: number): string {
  const room = Math.min(outputBytes, request.limits.outputTokens * 4, 65000) - Buffer.byteLength(prefix) - 1;
  return request.manifest.context && room >= 256 ? `${prefix}\n${renderContextAnswer(request, room)}` : prefix;
}

/**
 * Default fixture text. A specialist run asks for app.specialist_results/v2, so its fixture answers in that shape
 * (status `done`, citing the manifest sources); every other run gets the prose fixture.
 */
function fixtureText(request: ApplicationRunRequest, outputBytes: number): string {
  const prose = `ตัวอย่างจำลอง · ${request.purpose}\nบทบาท: ${request.instructions.responsibility}\nผลนี้เป็น fixture ไม่ได้เรียก Grok หรือ Codex`;
  return request.instructions.operator.includes(specialistResultInstruction)
    ? specialistFixtureResult(prose, request, outputBytes) : withContextAnswer(prose, request, outputBytes);
}

/**
 * A `done` app.specialist_results/v2 fixture answer whose result is {@link withContextAnswer}'s text and whose
 * evidence cites every manifest source, within the run's output ceiling.
 */
export function specialistFixtureResult(prefix: string, request: ApplicationRunRequest, outputBytes: number): string {
  const evidence = request.manifest.sources.length ? request.manifest.sources.map(source => source.reference) : "none";
  const shell = Buffer.byteLength(JSON.stringify({ status: "done", result: "", evidence, unblock: null }));
  // JSON escaping can grow the text, so the prose gets half of the remaining room.
  const room = Math.max(1, Math.floor((Math.min(outputBytes, request.limits.outputTokens * 4, 65000) - shell) / 2));
  return JSON.stringify({ status: "done", result: withContextAnswer(prefix, request, room), evidence, unblock: null });
}

/**
 * exec.run_tools/v1 for fixture scripts: the run's admitted tool registry, with Schway's exact-registry semantics.
 * `call` of a tool that was not admitted settles as `Unknown tool: <name>` without reaching anything, exactly as the
 * Schway host does; an admitted tool runs in the project box (a `FakeBoxRuntime` in tests).
 */
export interface ScriptedTools {
  readonly names: readonly string[];
  call(name: string, input: unknown): Promise<ToolExecutionResult>;
}
/** A fixture run script; `tools` is the run's admitted registry (empty without an execution grant). */
export type RunScript = (request: ApplicationRunRequest, signal: AbortSignal, observe: (event: ApplicationRunEvent) => void, tools: ScriptedTools) => unknown | Promise<unknown>;

function scriptedTools(opened: RunTools, signal: AbortSignal): ScriptedTools {
  const byName = new Map(opened.definitions.map(definition => [definition.name, definition]));
  return {
    names: Object.freeze([...byName.keys()]),
    async call(name, input) {
      const definition = byName.get(name);
      if (!definition) return { content: `Unknown tool: ${name}`, isError: true };
      // The core tools resolve paths against the backend root; the workspace identity mirrors the host's.
      const root = "/workspace";
      try { return await definition.execute(input, { workspace: { root, launchCwd: root, extraRoots: [] }, signal }); }
      catch (error) { return { content: error instanceof Error ? error.message : "Tool failed", isError: true }; }
    },
  };
}

/** Deterministic in-process fixture; it contains no network, SDK, discovery or model protocol loop. */
export class ScriptedRunPort implements ApplicationRunPort {
  readonly adapter = "scripted" as const;
  readonly #requests: ApplicationRunRequest[] = [];
  readonly #native: ScriptedNativeLedger;
  /** exec.run_tools/v1: present when this port can open project boxes; work then grants execution at admission. */
  readonly execution: RunExecution | undefined;
  constructor(readonly store: TransactionStore, readonly policy: TeamPolicy, readonly outputBytes: number,
    private readonly script: RunScript = request => ({
      ...fixtureOutcome("complete", fixtureText(request, outputBytes)),
      usage: { ...emptyUsage(), calls: 1, rounds: 1, hops: 1 }, session: { adapter: "scripted", id: request.runId, context: request.context },
    }), private readonly deleteFails: () => boolean = () => false, private readonly retireFails: () => boolean = () => false,
    options: { execution?: RunExecution } = {}) {
    this.execution = options.execution;
    this.#native = new ScriptedNativeLedger(`${store.path}.scripted-native.sqlite`);
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
    const active = () => [null, "active"].includes(this.#native.contextState(snapshot.context)) && this.store.read(tx => tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", snapshot.context.id, snapshot.context.generation)?.state === "active");
    if (!active()) return fixtureOutcome("context_retired");
    if (signal.aborted) return fixtureOutcome("cancelled");
    this.#requests.push(structuredClone(snapshot)); if (this.#requests.length > 32) this.#requests.shift();
    const native = { adapter: "scripted", runId: snapshot.runId, sessionId: snapshot.runId, context: snapshot.context, state: "running" as const, contextState: "active" as const };
    this.#native.put(native);
    observe({ kind: "started", runId: snapshot.runId, context: { ...snapshot.context } });
    observe({ kind: "progress", runId: snapshot.runId, text: "provisional fixture progress" });
    let result: ApplicationRunOutcome = fixtureOutcome("invalid_result");
    let tools: RunTools | null = null;
    try {
      try { tools = await openRunTools(this.store, this.execution, snapshot); }
      catch (error) { tools = null; result = fixtureOutcome(runToolsFailure(error)); }
      if (tools) {
        try { result = normalizeFixtureResult(await this.script(structuredClone(snapshot), signal, observe, scriptedTools(tools, signal)), snapshot, this.outputBytes); }
        catch { result = fixtureOutcome("invalid_result"); }
      }
    } finally { tools?.release(); }
    if (!active()) result = fixtureOutcome("context_retired");
    else if (signal.aborted) result = fixtureOutcome("cancelled");
    this.#native.put({ ...native, state: "finished", contextState: active() ? "active" : "retired" });
    observe({ kind: "finished", runId: snapshot.runId, outcome: structuredClone(result) }); return result;
  }

  /** Reads only durable fixture native evidence; it cannot manufacture an app result after a crash. */
  async inspectRuns(after = 0) {
    if (!Number.isSafeInteger(after) || after < 0) throw new AppError("invalid_cursor");
    return this.#native.page(after);
  }

  /** Fences this exact generation durably; an unknown reference cannot create a live context. */
  async retire(context: ManagedContextReference): Promise<ManagedContextOutcome> {
    requireId(context.id);
    if (!Number.isSafeInteger(context.generation) || context.generation < 1) throw new AppError("invalid_context_reference");
    if (this.#native.contextState(context) === "deleted" || this.store.read(tx => tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", context.id, context.generation)?.state === "deleted")) return { state: "deleted", context: { ...context } };
    let failed = true;
    try { failed = this.retireFails() !== false; } catch { /* Keep adapter diagnostics private. */ }
    // The application fence is durable even when the transport cannot acknowledge retirement.
    this.store.transaction(tx => {
      if (!tx.get("SELECT id FROM team_contexts WHERE id = ? AND generation = ?", context.id, context.generation) && !this.#native.hasContext(context)) throw new AppError("context_not_found", 404);
      tx.run("UPDATE team_contexts SET state = 'retired' WHERE id = ? AND generation = ? AND state = 'active'", context.id, context.generation);
    });
    if (failed) return { state: "retire_failed", context: { ...context }, nextAction: "retry_managed_retire" };
    this.#native.context(context, "retired");
    return { state: "retired", context: { ...context } };
  }

  /** Deletion always retires first; a visible failure keeps replay fenced and permits an explicit retry. */
  async delete(context: ManagedContextReference): Promise<ManagedContextOutcome> {
    const retired = await this.retire(context);
    if (retired.state === "retire_failed" || retired.state === "deleted") return retired;
    if (this.store.read(tx => tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", context.id, context.generation)?.state === "deleted")) return { state: "deleted", context: { ...context } };
    let failed = true;
    try { failed = this.deleteFails() !== false; } catch { /* Native/adapter diagnostics never cross the managed lifecycle port. */ }
    this.store.transaction(tx => { tx.run("UPDATE team_contexts SET state = ? WHERE id = ? AND generation = ?", failed ? "delete_failed" : "deleted", context.id, context.generation); });
    this.#native.context(context, failed ? "delete_failed" : "deleted");
    return failed ? { state: "delete_failed", context: { ...context }, nextAction: "retry_managed_delete" } : { state: "deleted", context: { ...context } };
  }
}
