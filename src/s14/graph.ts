import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import type { AppTransaction } from "../store";
import { record, save, type S14Application } from "./application";
import type { Attempt, Work, WorkGrant } from "./authority-types";
import type { GraphCommand, GraphReceipt, GraphView, StepGap, StepInput, StepProposal, WorkDefaults, WorkGraph, WorkStep } from "./graph-types";
import type { OwnerActor } from "./types";
import { canonical, exact, identity, integer, text } from "./validation";

const terminal = new Set<WorkStep["state"]>(["committed", "failed", "cancelled", "blocked"]);
const handlers = new Set(["research", "synthesis"]);
const stepId = (workId: string, nodeId: string) => `${workId}_${nodeId}`;

/** Validates a finite typed DAG against captured grants; no executable handler or authority comes from a proposal. */
export function validateWorkGraph(grant: WorkGrant, proposed: StepProposal[]): StepProposal[] {
  if (!Array.isArray(proposed) || !proposed.length || proposed.length > Math.min(64, grant.limits.steps, grant.limits.attempts)) throw new AppError("graph_step_ceiling");
  const ids = new Set<string>();
  let calls = 0, bytes = 0;
  for (const node of proposed) {
    exact(node, ["id", "handler", "dependsOn", "botId", "tools", "scopes", "input", "calls", "outputBytes"]);
    identity(node.id);
    if (node.id.length > 64 || ids.has(node.id)) throw new AppError("invalid_graph_identity");
    ids.add(node.id);
    const bot = grant.bots.find(b => b.id === node.botId);
    if (!bot || !handlers.has(node.handler)) throw new AppError("graph_handler_or_bot_refused", 403);
    if (containsCredential(node.input) || text(node.input) !== node.input) throw new AppError("invalid_graph_input");
    for (const list of [node.tools, node.scopes, node.dependsOn]) if (!Array.isArray(list) || list.length > 64) throw new AppError("invalid_graph_list");
    if (new Set(node.tools).size !== node.tools.length || new Set(node.dependsOn).size !== node.dependsOn.length) throw new AppError("invalid_graph_list");
    if (node.tools.some(tool => !grant.tools.includes(tool) || !bot.capabilities.tools.includes(tool))) throw new AppError("tool_outside_grant", 403);
    if (node.handler === "synthesis" && (node.tools.length || node.scopes.some(scope => scope.kind !== "share"))) throw new AppError("synthesis_tools_refused", 403);
    for (const scope of node.scopes) {
      exact(scope, ["kind", "id", "revision"]);
      const pinned = grant.scopes.find(s => canonical(s.ref) === canonical(scope));
      if (!pinned || !bot.capabilities.resources.includes(scope.id) ||
          (scope.kind === "share" ? pinned.receiverBotId !== bot.id : pinned.ownerBotId !== bot.id) ||
          node.tools.some(tool => !pinned.tools.includes(tool))) throw new AppError("scope_outside_grant", 403);
    }
    if (new Set(node.scopes.map(s => `${s.kind}:${s.id}`)).size !== node.scopes.length) throw new AppError("invalid_graph_list");
    integer(node.calls, 1, grant.limits.calls);
    integer(node.outputBytes, 1, grant.limits.outputBytes);
    calls += node.calls;
    bytes += node.outputBytes;
  }
  if (calls > grant.limits.calls || bytes > grant.limits.outputBytes) throw new AppError("graph_budget_exhausted", 409);
  const done = new Set<string>(), visiting = new Set<string>();
  const visit = (key: string): void => {
    if (done.has(key)) return;
    if (visiting.has(key)) throw new AppError("graph_cycle");
    visiting.add(key);
    const node = proposed.find(n => n.id === key);
    if (!node) throw new AppError("graph_dependency_missing");
    for (const dependency of node.dependsOn) { identity(dependency); visit(dependency); }
    visiting.delete(key);
    done.add(key);
  };
  for (const node of proposed) visit(node.id);
  return structuredClone(proposed);
}

/** Builds a bounded team graph, reserving each output slice by permitted attempts so remaining attempts can retry without refunds. */
export function defaultWorkGraph(grant: WorkGrant): StepProposal[] {
  const count = grant.bots.length + (grant.bots.length > 1 ? 1 : 0);
  const calls = Math.floor(grant.limits.calls / count), outputBytes = Math.floor(grant.limits.outputBytes / grant.limits.attempts);
  const nodes: StepProposal[] = grant.bots.map((bot, index) => ({ id: `research_${index}`, handler: "research", botId: bot.id,
    dependsOn: [], tools: grant.tools.filter(tool => bot.capabilities.tools.includes(tool)),
    scopes: grant.scopes.filter(s => bot.capabilities.resources.includes(s.ref.id) && (s.ref.kind === "share" ? s.receiverBotId === bot.id : s.ownerBotId === bot.id)).map(s => s.ref),
    input: `${grant.purpose}\nCompletion rule: ${grant.command.payload.completionRule}`, calls, outputBytes }));
  if (count > 1) nodes.push({ id: "synthesis", handler: "synthesis", botId: grant.bots[0]!.id, dependsOn: nodes.map(n => n.id),
    tools: [], scopes: nodes[0]!.scopes.filter(scope => scope.kind === "share"), input: `Synthesize the committed evidence for: ${grant.purpose}. Preserve conflicts, missing evidence and failed siblings.`, calls, outputBytes });
  return validateWorkGraph(grant, nodes);
}

/** Durable bounded graph and lane projections; trusted handlers own all validation and publication. */
export class S14Graph {
  constructor(readonly app: S14Application) {}

  /** Installs an immutable plan in the same transaction as the explicit owner start. */
  install(tx: AppTransaction, grant: WorkGrant, proposed = defaultWorkGraph(grant), priority: WorkGraph["priority"] = "interactive"): WorkGraph {
    const graph: WorkGraph = { id: grant.workId, revision: 1, grantId: grant.id, priority, nodes: validateWorkGraph(grant, proposed) };
    tx.run("INSERT INTO work_graphs VALUES (?,?)", graph.id, canonical(graph));
    for (const node of graph.nodes) {
      const step: WorkStep = { id: stepId(graph.id, node.id), workId: graph.id, revision: 1, nodeId: node.id, botId: node.botId, handler: node.handler,
        state: node.dependsOn.length ? "waiting_evidence" : "queued", reason: node.dependsOn.length ? "dependency_uncommitted" : null,
        queuedAt: node.dependsOn.length ? null : this.app.now(), waitingAt: node.dependsOn.length ? this.app.now() : null, queueCeiling: null,
        attemptId: null, startedAt: null, settledAt: null };
      tx.run("INSERT INTO work_steps VALUES (?,?,?)", step.id, graph.id, canonical(step));
    }
    return graph;
  }

  /** Accepts only a pre-dispatch narrowing proposal inside an already-authorized grant, never a new work command. */
  propose(workId: string, expectedRevision: number, proposed: StepProposal[]): WorkGraph {
    identity(workId);
    return this.app.store.transaction(tx => {
      const graph = record<WorkGraph>(tx, "work_graphs", workId), work = record<Work>(tx, "work_items", workId);
      const grant = record<WorkGrant>(tx, "work_grants", graph.grantId);
      this.app.authority.checkGrant(tx, grant);
      if (graph.revision !== expectedRevision || work.state !== "queued" || tx.get("SELECT id FROM work_attempts WHERE work_id=?", workId)) throw new AppError("graph_already_admitted", 409);
      tx.run("DELETE FROM work_steps WHERE work_id=?", workId);
      tx.run("DELETE FROM work_graphs WHERE id=?", workId);
      const next = this.install(tx, grant, proposed, graph.priority);
      next.revision = graph.revision + 1;
      save(tx, "work_graphs", next);
      return next;
    });
  }

  /** Reads future-work defaults without silently applying them to an existing grant. */
  defaults(actor: OwnerActor): WorkDefaults {
    return this.app.store.read(tx => { this.app.requireOwner(tx, actor); return record<WorkDefaults>(tx, "work_defaults", "work"); });
  }

  /** Applies exact owner lane stops or finite future-work defaults under the receipt transaction. */
  apply(tx: AppTransaction, command: GraphCommand): GraphReceipt {
    const receipt = { kind: command.kind, requestId: command.requestId };
    if (command.kind === "work.defaults.set") {
      exact(command.payload, ["concurrency", "wallMs", "reads"]);
      integer(command.payload.concurrency, 1, 8);
      integer(command.payload.wallMs, 1, 86400000);
      integer(command.payload.reads, 1, 256);
      const current = record<WorkDefaults>(tx, "work_defaults", "work");
      if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      const defaults: WorkDefaults = { id: "work", revision: current.revision + 1, ...command.payload };
      save(tx, "work_defaults", defaults);
      return { ...receipt, defaults };
    }
    exact(command.payload, ["workId", "stepId"]);
    identity(command.payload.workId); identity(command.payload.stepId);
    const step = record<WorkStep>(tx, "work_steps", command.payload.stepId);
    if (step.workId !== command.payload.workId || step.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
    tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('step_stop',?,'stopped')", step.id);
    if (!terminal.has(step.state)) {
      step.state = step.state === "running" || step.state === "stopping" ? "stopping" : "cancelled";
      step.queueCeiling = null;
      step.reason = "owner_stopped_step";
      step.revision++;
      save(tx, "work_steps", step);
    }
    const work = record<Work>(tx, "work_items", step.workId);
    return { ...receipt, step, conversationId: work.conversationId };
  }

  /** Returns finite actual lanes and configured ceilings; unknown usage is never measured zero. */
  view(actor: OwnerActor, workId: string): GraphView {
    identity(workId);
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      const graph = record<WorkGraph>(tx, "work_graphs", workId), grant = record<WorkGrant>(tx, "work_grants", graph.grantId), steps = this.steps(tx, workId);
      for (const step of steps) if (step.state === "queued") {
        const node = graph.nodes.find(n => n.id === step.nodeId)!, bot = grant.bots.find(b => b.id === step.botId)!;
        const route = grant.routes.find(r => r.id === bot.routeId)!;
        step.queueCeiling = this.app.authority.capacityCeiling(tx, grant, bot, route.provider, node.tools.includes("computer"));
      }
      return { graph, steps, active: steps.filter(s => s.state === "running" || s.state === "stopping").length,
        concurrency: grant.limits.concurrency, limits: this.app.authority.schedulerLimits, actualUsage: null };
    });
  }

  /** Reads all bounded lane records belonging to one work item inside an authority transaction. */
  steps(tx: AppTransaction, workId: string): WorkStep[] {
    return tx.all<{ record_json: string }>("SELECT record_json FROM work_steps WHERE work_id=? ORDER BY rowid", workId).map(r => JSON.parse(r.record_json));
  }

  /** Fences a cancelled lane at every tool and final-result barrier. */
  guard(tx: AppTransaction, attempt: Attempt): void {
    if (!attempt.step) return;
    const step = record<WorkStep>(tx, "work_steps", attempt.step.id);
    // Coding's committed waiting result keeps its original exact-effect seam usable after transport settlement.
    // It never queues the lane again; all ordinary live Bot/grant/computer checks still apply at every call.
    const codingReview = step.state === "blocked" && step.reason === "handler_waiting" && step.settledAt !== null &&
      attempt.state === "waiting" && attempt.snapshot.tools.includes("effect_push") &&
      !tx.get("SELECT 1 FROM attempt_transports WHERE attempt_id=? AND active=1", attempt.id) &&
      !!tx.get(`SELECT 1 FROM coding_runs c JOIN reports r ON r.attempt_id=c.attempt_id
        JOIN work_results w ON w.attempt_id=c.attempt_id
        WHERE c.attempt_id=? AND w.state='waiting' AND r.content_json IS NOT NULL
        AND json_extract(c.record_json,'$.reportId')=r.id
        AND json_extract(c.record_json,'$.state') IN ('reviewable','partial')`, attempt.id);
    if (tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='step_stop' AND id=?", step.id) || step.attemptId !== attempt.id || step.state !== "running" && !codingReview) throw new AppError("step_fenced", 403);
  }

  /** Selects dependencies only after actual sibling settlement and committed evidence, retaining explicit gaps. */
  inputs(tx: AppTransaction, step: WorkStep, node: StepProposal): { inputs: StepInput[]; gaps: StepGap[] } | null {
    const steps = this.steps(tx, step.workId), inputs: StepInput[] = [], gaps: StepGap[] = [];
    for (const dependency of node.dependsOn) {
      const prior = steps.find(s => s.nodeId === dependency)!;
      if (!terminal.has(prior.state) || prior.settledAt === null && prior.attemptId !== null) return null;
      const result = prior.state === "committed" && prior.attemptId ? tx.get<{ content: string }>("SELECT content FROM work_results WHERE attempt_id=?", prior.attemptId) : null;
      if (result) inputs.push({ stepId: prior.id, attemptId: prior.attemptId!, sourceId: `result_${prior.attemptId}`, text: result.content, evidence: [] });
      else gaps.push({ stepId: prior.id, reason: prior.reason ?? "dependency_unavailable" });
    }
    if (node.handler !== "synthesis" && gaps.length) {
      step.state = "blocked"; step.reason = "dependency_failed"; step.revision++;
      save(tx, "work_steps", step);
      return null;
    }
    return { inputs, gaps };
  }

  /** Records actual settlement independently from any model claim or cancellation request. */
  finish(tx: AppTransaction, attempt: Attempt, reason: string | null): void {
    if (!attempt.step) return;
    const step = record<WorkStep>(tx, "work_steps", attempt.step.id);
    if (step.attemptId !== attempt.id) return;
    const result = tx.get<{ state: string }>("SELECT state FROM work_results WHERE attempt_id=?", attempt.id);
    step.state = step.state === "stopping" ? "cancelled" : reason ? "failed" : result?.state === "waiting" ? "blocked" : "committed";
    if (!reason && result?.state === "waiting") reason = "handler_waiting";
    step.queueCeiling = null;
    step.reason = step.reason ?? reason;
    step.settledAt = this.app.now();
    step.revision++;
    save(tx, "work_steps", step);
  }

  /** Cancels pending lanes and fences dispatched lanes without pretending their transports stopped. */
  stop(tx: AppTransaction, workId: string): void {
    for (const step of this.steps(tx, workId)) if (!terminal.has(step.state)) {
      step.state = step.state === "running" || step.state === "stopping" ? "stopping" : "cancelled";
      step.queueCeiling = null;
      step.reason = "work_stopped"; step.revision++;
      save(tx, "work_steps", step);
    }
  }
}
