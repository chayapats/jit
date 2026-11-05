import type { HostClock, ToolDefinition } from "schway/host";
import { AppError } from "../../errors";
import { PolicyError, type ActionRef, type ActionSlip } from "../policy";
import { applyOwnerDecision, ownerDecision, rememberActionPresentation } from "./decisions";
import { ConversationStore } from "./store";
import { groundConversationIntent } from "./intent";
import { runConversation } from "./schway";
import { freezeInterpretation } from "./interpretation";
import { canonical, command, content, digest, exact, identity, integer } from "./validation";
import type { ConversationAuthority, ConversationCommand, ConversationDecisionCommand, ConversationEvent, ConversationIntent, ConversationOptions, ConversationReceipt, ConversationRequest, ConversationTools } from "./types";

const safeCodes = new Set(["material_ambiguity", "owner_start_required", "outside_scope", "authority_revoked", "stale_authority", "expired", "lineage_withdrawn", "selection_pinned", "budget_exhausted", "finite_budget_required", "cost_unknown", "route_unavailable", "capacity_busy", "approval_required", "recipient_approval_required", "merge_authority_required", "production_approval_required", "owner_direction_required", "policy_match_required", "adapter_unproven", "aborted", "tool_unavailable", "result_unavailable", "conversation_run_incomplete", "credential_content_refused", "authentication_required", "output_limit", "context_lost", "conversation_unavailable", "settlement_pending", "approval_reference_required", "stale_action", "already_claimed", "action_denied", "reconciliation_required", "payload_withdrawn", "read_bound_exhausted", "read_operation_unavailable", "recipient_unapproved", "classification_unknown", "recipient_unknown", "disclosure_changed", "disclosure_nonreleasable", "opaque_egress_unavailable", "memory_context_stale", "resource_busy", "stale_lease",
  // MODEL15-02: honest route status and per-send dispatch outcomes.
  "route_needs_login", "route_store_unavailable", "route_store_invalid", "route_rejected", "route_integration_unavailable", "route_renewal_timeout", "route_choice_refused", "quota_exceeded", "auth_retry_refused",
  "effort_unsupported", "effort_unproven", "cost_bound_unknown", "route_control_refused", "dispatch_refused", "usage_invalid"]);
const safeCode = (error: unknown): string => (error instanceof AppError || error instanceof PolicyError) && safeCodes.has(error.code) ? error.code : "conversation_unavailable";
const clock: HostClock = { now: Date.now, sleep: (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new AppError("aborted")); return; }
  const abort = () => { clearTimeout(timer); reject(new AppError("aborted")); };
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
  signal?.addEventListener("abort", abort, { once: true });
}) };

function authority(value: ConversationAuthority): ConversationAuthority {
  canonical(value); identity(value.id); identity(value.purposeId); integer(value.policyRevision, 1);
  exact(value, ["id", "purposeId", "policyRevision", "resources", "route", "limits"]);
  exact(value.route, ["provider", "model"]); exact(value.limits, ["modelCalls", "toolCalls", "outputBytes", "activeMs"]);
  if (!Array.isArray(value.resources) || value.resources.length > 64 || new Set(value.resources).size !== value.resources.length) throw new AppError("outside_scope");
  value.resources.forEach(identity);
  if (!["codex", "grok"].includes(value.route.provider)) throw new AppError("route_unavailable");
  content(value.route.model, 128);
  integer(value.limits.modelCalls, 1, 64); integer(value.limits.toolCalls, 0, 64);
  integer(value.limits.outputBytes, 1, 32768); integer(value.limits.activeMs, 1, 3600000);
  return structuredClone(value);
}

/**
 * Explicit S15 server-side conversation path. S14 message.post/work.start remain unchanged. Trusted
 * owner admission precedes the Schway loop; only policy-approved scoped tools are supplied to it.
 * Receipt/queue/claim/result transitions commit before acknowledgement and never replay a claimed run.
 */
export class ConversationApplication<OwnerActor, WorkContext> {
  readonly clock: HostClock;
  #draining: Promise<void> | null = null;
  #closing = false;
  #running = new Map<string, AbortController>();
  #owners = new Map<string, { actor: OwnerActor; commandId: string }>();
  constructor(readonly store: ConversationStore, readonly options: ConversationOptions<OwnerActor, WorkContext>) {
    this.clock = options.clock ?? clock;
    if (!options.memory && store.db.query("SELECT 1 FROM requests WHERE json_type(record_json,'$.memory')='object' LIMIT 1").get()) throw new AppError("memory_required", 503);
    // Store lifetime holds the exclusive process lock; another live worker cannot be declared lost.
    this.store.transaction(() => {
      for (const row of this.store.db.query<{ id: string }, []>("SELECT id FROM requests WHERE state='running'").all()) {
        const request = this.store.request(row.id); request.state = "reconcile_only"; request.code = "context_lost"; request.revision++;
        this.store.save(request); this.store.event(request, "needs_me", this.clock.now(), request.code);
      }
    });
  }
  /** Ordinary authenticated text starts clear work immediately; duplicate ingress returns its original receipt. */
  submit(actor: OwnerActor, value: unknown): ConversationReceipt {
    this.options.policy.requireOwner(actor); command(value);
    const input = structuredClone(value), hash = digest(`s15.chat.command.v1\n${canonical(input)}`);
    const receipt = this.store.transaction(() => {
      const owner = this.options.policy.requireOwner(actor);
      const prior = this.store.db.query<{ payload_hash: string; receipt_json: string; root_id: string }, [string]>("SELECT payload_hash,receipt_json,root_id FROM commands WHERE id=?").get(input.requestId);
      if (prior) {
        this.owner(actor, this.store.request(prior.root_id));
        if (prior.payload_hash !== hash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(prior.receipt_json) as ConversationReceipt;
      }
      if (this.#closing) throw new AppError("conversation_unavailable", 503);
      this.store.capacity();
      let intent = groundConversationIntent(input.text);
      let request: ConversationRequest;
      const receipt: ConversationReceipt = { contract: "s15-conversation-receipt/v1", requestId: input.requestId, rootRequestId: input.continuation?.requestId ?? input.requestId, conversationId: input.conversationId, receivedAt: this.clock.now() };
      if (input.continuation) {
        request = this.store.request(input.continuation.requestId); this.owner(actor, request);
        if (request.receipt.conversationId !== input.conversationId || request.revision !== input.continuation.revision || request.state !== "held" || request.code !== "material_ambiguity" || request.phase !== "interpretation") throw new AppError("stale_revision", 409);
        if ((request.clarifications ?? 0) >= 4) throw new AppError("budget_exhausted", 409);
        request.clarifications = (request.clarifications ?? 0) + 1;
        intent = this.clarification(request.command, input, intent);
      } else {
        request = { receipt, command: input, interpretationRequest: input, owner, revision: 0, intent, state: "held", code: null, authority: null, phase: "interpretation", interpretation: null, interpretationCalls: 0, modelCalls: 0, toolCalls: 0, result: null, usage: null, actions: [], decision: null };
        this.store.db.query("INSERT INTO requests VALUES (?,?,?,?)").run(input.requestId, input.conversationId, request.state, canonical(request));
      }
      request.intent = intent; request.interpretationRequest = input; request.revision++;
      const exactDecision = ownerDecision(input.text);
      if (exactDecision && input.continuation === null) {
        try { applyOwnerDecision(this, actor, request, exactDecision); }
        catch (error) { request.state = "held"; request.code = safeCode(error); }
      }
      else if (intent.kind === "ambiguous" && !intent.hold && new Set([...input.text.matchAll(/(?:issue\s*|#)(\d+)/gi)].map(match => match[1])).size > 1) { request.state = "held"; request.code = "material_ambiguity"; }
      else if (intent.kind === "accept") { request.state = "accepted"; request.code = null; }
      else {
        // Inference-only authority exists before interpretation; no tool/retrieval path is open yet.
        const decision = this.options.policy.prepareInterpretation(actor, input);
        this.owner(actor, request);
        if (decision.state === "admitted") {
          if (!decision.purposes.length || decision.purposes.length > 64) throw new AppError("outside_scope");
          if (decision.resources.length > 64) throw new AppError("outside_scope");
          decision.purposes.forEach(identity); decision.resources.forEach(identity);
          request.interpretationAttempt = (request.interpretationAttempt ?? (request.interpretation ? 1 : 0)) + 1;
          request.interpretation = { authority: authority(decision.authority), purposes: [...decision.purposes], resources: [...decision.resources] }; request.state = "queued"; request.code = null;
        }
        else { request.state = decision.state; request.code = safeCodes.has(decision.code) ? decision.code : "policy_match_required"; }
      }
      this.store.save(request);
      this.store.db.query("INSERT INTO commands VALUES (?,?,?,?,?)").run(input.requestId, hash, receipt.rootRequestId, canonical(receipt), canonical(input));
      this.store.event(request, "received", this.clock.now());
      request.contextSequence = this.store.db.query<{ sequence: number }, []>("SELECT last_insert_rowid() AS sequence").get()!.sequence;
      this.store.save(request);
      this.store.event(request, request.decision ? "decision" : request.state === "queued" ? "admitted" : "needs_me", this.clock.now(), request.code);
      this.options.beforeCommit?.();
      return receipt;
    });
    // Process-local actor registration is never reconstructed from a serialized owner identity.
    if (this.store.request(receipt.rootRequestId).state === "queued") this.#owners.set(receipt.rootRequestId, { actor, commandId: this.store.request(receipt.rootRequestId).interpretationRequest.requestId });
    return receipt;
  }
  /**
   * Typed exact owner decision from an authenticated slip form (`s15-conversation-decision/v1`). The posted
   * revision and hash must equal both the revision last presented to this owner in this conversation and the
   * current pending, approvable POLICY slip; a changed, expired or settled action refuses with `stale_action`.
   * It then records one ordinary explicit decision command through the same ingress writer and dedupe path as
   * a typed `approve <id>`, so a replayed request ID returns the original receipt and never decides twice.
   */
  decide(actor: OwnerActor, value: unknown): ConversationReceipt {
    this.options.policy.requireOwner(actor); canonical(value);
    exact(value, ["contract", "requestId", "conversationId", "action", "decision"]);
    const input = value as unknown as ConversationDecisionCommand;
    if (input.contract !== "s15-conversation-decision/v1" || (input.decision !== "approve" && input.decision !== "deny")) throw new AppError("invalid_contract");
    identity(input.requestId); identity(input.conversationId); exact(input.action, ["id", "revision", "actionHash"]); identity(input.action.id); integer(input.action.revision, 1);
    if (typeof input.action.actionHash !== "string" || !/^[a-f0-9]{64}$/.test(input.action.actionHash)) throw new AppError("invalid_body");
    const text = `${input.decision} ${input.action.id}`;
    const fingerprint = digest(`s15.chat.decision.v1\n${canonical(input)}`);
    return this.store.transaction(() => {
      const prior = this.store.db.query<{ root_id: string }, [string]>("SELECT root_id FROM commands WHERE id=?").get(input.requestId);
      if (prior) {
        const retained = this.store.request(prior.root_id); this.owner(actor, retained);
        const same = retained.decision?.decision === input.decision && retained.decision.action.id === input.action.id && retained.decision.action.revision === input.action.revision && retained.decision.action.actionHash === input.action.actionHash;
        // Old successful typed decisions retained the exact action but predate the full command hash.
        if (retained.decisionCommandHash ? retained.decisionCommandHash !== fingerprint : !same) throw new AppError("request_id_conflict", 409);
      } else {
        const principal = this.options.policy.requireOwner(actor);
        const presented = this.store.db.query<{ record_json: string }, [string, string, number]>("SELECT record_json FROM presentations WHERE conversation_id=? AND action_id=? AND owner_generation=?").get(input.conversationId, input.action.id, principal.generation);
        const same = (a: ActionRef) => a.id === input.action.id && a.revision === input.action.revision && a.actionHash === input.action.actionHash;
        if (!presented || !same((JSON.parse(presented.record_json) as { action: ActionRef }).action)) throw new AppError("stale_action", 409);
        const current = this.options.policy.actionSlips?.(actor, [input.action]) ?? [];
        // Approval needs an approvable revision; a denial (which only narrows authority) needs only a pending one.
        if (!current.some(slip => same(slip.action) && slip.state === "pending" && (slip.canApprove || input.decision === "deny"))) throw new AppError("stale_action", 409);
      }
      const receipt = this.submit(actor, { contract: "s15-conversation/v1", requestId: input.requestId, conversationId: input.conversationId, text, continuation: null });
      const retained = this.store.request(receipt.rootRequestId);
      retained.decisionCommandHash = fingerprint; this.store.save(retained);
      return receipt;
    });
  }
  private owner(actor: OwnerActor, request: ConversationRequest): void {
    const current = this.options.policy.requireOwner(actor);
    if (current.id !== request.owner.id || current.generation !== request.owner.generation) throw new AppError("authentication_required", 401);
  }
  private clarification(original: ConversationCommand, next: ConversationCommand, intent: ConversationIntent): ConversationIntent {
    // This slice resolves a selected issue only. Other material changes use a distinct clear request.
    const candidates = [...original.text.matchAll(/(?:issue\s*|#)(\d+)/gi)].map(match => `issue:${match[1]}`);
    const selected = [...next.text.matchAll(/(?:issue\s*|#)(\d+)/gi)].map(match => `issue:${match[1]}`);
    if (selected.length !== 1 || !candidates.includes(selected[0]!) || !/^(?:please\s+)?(?:implement|fix|start|ทำ|แก้|เริ่ม)/iu.test(original.text.trim()) || !["execute", "accept", "ambiguous"].includes(intent.kind)) throw new AppError("outside_scope", 403);
    if (!/^(?:(?:implement|fix|start|select|choose|เลือก|ทำ|แก้|เริ่ม)\s*)?(?:issue\s*)?#?\d+[.!\s]*$/iu.test(next.text.trim())) throw new AppError("outside_scope", 403);
    return { kind: "execute", subject: selected[0]!, instruction: `${original.text}\nOwner selected only ${selected[0]}.` };
  }
  /** Recover exact committed ingress metadata under its original owner; a clarification names its root work. */
  receipt(actor: OwnerActor, commandId: string): ConversationReceipt {
    this.options.policy.requireOwner(actor); identity(commandId);
    const command = this.store.db.query<{ receipt_json: string; root_id: string }, [string]>("SELECT receipt_json,root_id FROM commands WHERE id=?").get(commandId);
    if (!command) throw new AppError("not_found", 404);
    this.owner(actor, this.store.request(command.root_id));
    return JSON.parse(command.receipt_json) as ConversationReceipt;
  }
  /** Read-only current request projection; a stale/revoked authority withholds result and evidence bodies. */
  view(actor: OwnerActor, requestId: string): ConversationRequest & { evidence: ReturnType<ConversationStore["evidence"]>; slips: ActionSlip[] } {
    const request = this.store.request(requestId); this.owner(actor, request);
    const projected = structuredClone(request);
    let slips: ActionSlip[] = [];
    try {
      slips = this.options.policy.actionSlips?.(actor, request.actions) ?? [];
      // A re-prepared action keeps its id in the same protected slot. Follow POLICY's own `replacement`
      // reference so the owner sees (and can decide on) the current revision, never a model-chosen one.
      for (let hop = 0; hop < 8 && request.phase === "work" && request.actions.length < 64; hop++) {
        const known = (ref: ActionRef) => request.actions.some(a => a.id === ref.id && a.revision === ref.revision && a.actionHash === ref.actionHash);
        const missing = slips.filter(slip => slip.state === "changed" && slip.replacement && slip.replacement.id === slip.action.id && !known(slip.replacement)).map(slip => slip.replacement!);
        if (!missing.length) break;
        const next = (this.options.policy.actionSlips?.(actor, missing) ?? []).filter(slip => missing.some(ref => ref.id === slip.action.id && ref.revision === slip.action.revision && ref.actionHash === slip.action.actionHash));
        if (!next.length) break;
        this.store.transaction(() => {
          const current = this.store.request(requestId);
          for (const slip of next) if (!current.actions.some(a => a.id === slip.action.id && a.revision === slip.action.revision)) current.actions.push({ id: slip.action.id, revision: slip.action.revision, actionHash: slip.action.actionHash });
          this.store.save(current); request.actions = current.actions;
        });
        slips = [...slips, ...next];
      }
      rememberActionPresentation(this, request, slips);
    } catch (error) { return { ...projected, result: null, code: safeCode(error), evidence: [], slips: [] }; }
    if (projected.decision && projected.decision.observation === null) {
      const exact = projected.decision.action;
      const observed = slips.find(slip => slip.action.id === exact.id && slip.action.revision === exact.revision && slip.action.actionHash === exact.actionHash)?.observation;
      // POLICY may have committed before CHAT lost its process. Project known facts without clearing
      // the stored interrupted claim or reconstructing a dispatch/model context.
      if (observed) {
        projected.decision.observation = observed;
        if (projected.state !== "stopped" && observed.outcome !== "unknown") { projected.state = "accepted"; projected.code = observed.code ?? `action_${observed.outcome}`; }
      }
    }
    if (request.result !== null) {
      try { this.publication(request); }
      catch (error) { return { ...projected, result: null, code: safeCode(error), evidence: [], slips }; }
    }
    return { ...projected, evidence: request.state === "completed" ? this.store.evidence(requestId) : [], slips };
  }
  /** Bounded conversation-bound cursor; reconnect never starts a model, tool, queue or remote delivery. */
  events(actor: OwnerActor, conversationId: string, after = 0): { events: ConversationEvent[]; cursor: number } {
    this.options.policy.requireOwner(actor); identity(conversationId); integer(after, 0, Number.MAX_SAFE_INTEGER);
    if (after) {
      const cursor = this.store.db.query<{ conversation_id: string }, [number]>("SELECT conversation_id FROM events WHERE sequence=?").get(after);
      if (!cursor || cursor.conversation_id !== conversationId) throw new AppError("cursor_invalid", 409);
    }
    const events = this.store.db.query<ConversationEvent, [string, number]>("SELECT sequence,request_id AS requestId,conversation_id AS conversationId,at,kind,code FROM events WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT 64").all(conversationId, after);
    for (const event of events) this.owner(actor, this.store.request(event.requestId));
    return { events, cursor: events.at(-1)?.sequence ?? after };
  }
  /** Final synchronous publication guard; no model/tool work or effect approval occurs on result reads. */
  publish(actor: OwnerActor, requestId: string, consume: (text: string) => void): void {
    const request = this.store.request(requestId); this.owner(actor, request); this.publication(request);
    consume(request.result!);
  }
  private publication(request: ConversationRequest): void {
    if (request.state !== "completed" || request.result === null || !request.authority) throw new AppError("result_unavailable", 409);
    const work = this.options.policy.open(request.authority);
    this.options.policy.guard(work, "publication");
    if (request.memory) { if (!this.options.memory) throw new AppError("memory_context_stale", 409); this.options.memory.guard(work, request.receipt.rootRequestId); }
  }
  /** Stops only this request. Unknown guest/effect claims remain retained by their owning service. */
  stop(actor: OwnerActor, requestId: string): void {
    this.store.transaction(() => {
      const request = this.store.request(requestId); this.owner(actor, request);
      if (request.state === "stopped") return;
      if (request.authority) this.options.policy.stopWork?.(actor, request.authority, requestId);
      request.state = "stopped"; request.code = "aborted"; request.revision++;
      this.store.save(request); this.store.event(request, "stopped", this.clock.now(), "aborted");
    });
    this.#running.get(requestId)?.abort();
  }
  /** Wakes one local durable queue drain. Concurrent callers share it; a claim is committed before I/O. */
  drain(): Promise<void> {
    if (this.#draining) return this.#draining;
    const done = Promise.withResolvers<void>(); this.#draining = done.promise;
    void (async () => {
      try {
        while (!this.#closing) {
          // Only process-local authenticated registrations are runnable after restart.
          const id = [...this.#owners.keys()].find(id => this.store.request(id).state === "queued");
          if (!id) break;
          if (this.store.request(id).phase === "decision") await this.runDecision(id);
          else await this.run(id);
        }
        done.resolve();
      } catch (error) { done.reject(error); }
      finally { this.#draining = null; }
    })();
    return done.promise;
  }
  private async runDecision(id: string): Promise<void> {
    try {
      const request = this.store.transaction(() => {
        const current = this.store.request(id);
        if (current.state !== "queued" || !current.decision || !current.authority || !this.options.policy.dispatchAction) throw new AppError("approval_reference_required");
        current.state = "running"; current.revision++; this.store.save(current); this.options.beforeCommit?.(); return current;
      });
      const observation = await this.options.policy.dispatchAction!(request.authority!, request.decision!.action);
      this.store.transaction(() => {
        const current = this.store.request(id); current.decision!.observation = observation;
        if (current.state !== "stopped") { current.state = observation.outcome === "unknown" ? "reconcile_only" : "accepted"; current.code = observation.code ?? `action_${observation.outcome}`; }
        current.revision++; this.store.save(current); this.store.event(current, "decision", this.clock.now(), current.code);
      });
    } catch (error) {
      this.store.transaction(() => { const current = this.store.request(id); if (current.state !== "stopped") { current.state = "held"; current.code = safeCode(error); current.revision++; this.store.save(current); this.store.event(current, "needs_me", this.clock.now(), current.code); } });
    } finally { this.#owners.delete(id); }
  }
  private async run(id: string): Promise<void> {
    const registration = this.#owners.get(id);
    const abort = new AbortController(); this.#running.set(id, abort);
    let tools: ConversationTools | undefined, cancel: Promise<void> | undefined;
    let startedAt = this.clock.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let work: WorkContext;
    const guard = (stage: "model" | "tool" | "publication" = "tool") => {
      const current = this.store.request(id);
      if (abort.signal.aborted || current.state !== "running") throw new AppError("aborted");
      if (current.code) throw new AppError(current.code);
      if (this.clock.now() - startedAt >= (current.phase === "interpretation" ? current.interpretation!.authority : current.authority!).limits.activeMs) throw new AppError("expired");
      this.options.policy.guard(work, stage);
      if (current.phase === "work" && current.memory) { if (!this.options.memory) throw new AppError("memory_context_stale", 409); this.options.memory.guard(work, id); }
    };
    const cancelTools = () => { if (tools && !cancel) cancel = Promise.resolve().then(() => tools!.cancel()).catch(() => {}); };
    abort.signal.addEventListener("abort", cancelTools, { once: true });
    try {
      let request = this.store.transaction(() => {
        const request = this.store.request(id);
        if (request.state !== "queued" || !request.interpretation) throw new AppError("already_claimed", 409);
        const actor = registration?.actor; if (!actor) throw new AppError("authentication_required", 401);
        this.owner(actor, request);
        work = this.options.policy.open(request.interpretation.authority); this.options.policy.guard(work, "model");
        request.state = "running"; request.revision++;
        this.store.save(request); this.store.event(request, "progress", this.clock.now());
        this.options.beforeCommit?.(); return request;
      });
      timer = setTimeout(() => abort.abort(), request.interpretation!.authority.limits.activeMs);
      const interpretationContext = this.interpretationContext(request);
      const interpreted = await runConversation({ directory: this.options.nativeDirectory, request, definitions: [], signal: abort.signal, clock: this.clock, scripted: this.options.interpreterModel ?? this.options.model, ...(this.options.routeAuth ? { routeAuth: this.options.routeAuth } : {}),
        interpretation: { ...request.interpretation!, context: interpretationContext }, guard: () => guard("model"),
        onUsage: usage => this.store.transaction(() => { const current = this.store.request(id); current.interpretationUsage = usage; this.store.save(current); }),
        ...(this.options.guardInterpretation ? { guardContext: (payload: unknown) => this.options.guardInterpretation!(work!, payload) } : {}),
        reserveModel: () => this.store.transaction(() => {
          guard("model"); const current = this.store.request(id);
          const attempt = current.interpretationAttempt ?? 1;
          if (current.interpretationCallAttempt === attempt || !current.interpretationAttempt && current.interpretationCalls !== 0) throw new AppError("budget_exhausted");
          const reservation = this.options.policy.reserveModel(work!, `${id}_interpretation_${attempt}`);
          current.interpretationCallAttempt = attempt; current.interpretationCalls++; this.store.save(current); return reservation;
        }), correlated: (sessionId, branchId) => { this.store.db.query("INSERT INTO native_sessions VALUES (?,?,?,?)").run(id, `interpretation_${request.interpretationAttempt ?? 1}`, sessionId, branchId); },
      });
      request = this.store.transaction(() => {
        guard("model"); const current = this.store.request(id), actor = registration!.actor;
        this.owner(actor, current);
        const selectedSubjects = interpretationContext.filter(message => message.role === "owner").map(message => groundConversationIntent(message.text)).filter(intent => intent.kind === "accept" || intent.kind === "execute").flatMap(intent => intent.subject ? [intent.subject] : []);
        current.intent = freezeInterpretation(interpreted.text, current.intent, { purposes: current.interpretation!.purposes, resources: current.interpretation!.resources, selectedSubjects });
        if (current.intent.kind === "ambiguous" || current.intent.kind === "accept") {
          current.state = current.intent.kind === "accept" ? "accepted" : "held"; current.code = current.intent.kind === "accept" ? null : "material_ambiguity";
        } else {
          const decision = this.options.policy.admit(actor, current.command, current.intent);
          this.owner(actor, current);
          if (decision.state !== "admitted") { current.state = decision.state; current.code = safeCodes.has(decision.code) ? decision.code : "policy_match_required"; }
          else {
            const admitted = authority(decision.authority), scope = current.intent.scope!;
            if (admitted.purposeId !== scope.purposeId || admitted.resources.some(resource => !scope.resourceIds.includes(resource))) throw new AppError("outside_scope");
            current.authority = admitted; current.phase = "work";
          }
        }
        current.revision++; this.store.save(current);
        this.store.event(current, current.state === "running" ? "admitted" : "needs_me", this.clock.now(), current.code);
        this.options.beforeCommit?.(); return current;
      });
      if (request.state !== "running") return;
      work = this.options.policy.open(request.authority!); guard("model");
      clearTimeout(timer); startedAt = this.clock.now(); timer = setTimeout(() => abort.abort(), request.authority!.limits.activeMs);
      // Persist continuity dependency before MEM can retain/withdraw anything. A later boot without
      // that protected service must refuse rather than replay raw owner/history or publish old data.
      if (this.options.memory) this.store.transaction(() => { const current = this.store.request(id); current.memory = { retained: [] }; this.store.save(current); });
      const ingress = this.store.db.query<{ receipt_json: string }, [string]>("SELECT receipt_json FROM commands WHERE id=?").get(request.interpretationRequest.requestId)!;
      const memory = this.options.memory?.prepare(work!, request, { receivedAt: (JSON.parse(ingress.receipt_json) as ConversationReceipt).receivedAt });
      if (memory) {
        this.store.transaction(() => { const current = this.store.request(id); current.memory = { retained: memory.retained }; this.store.save(current); });
        request = this.store.request(id); guard("model");
      }
      const mode = request.intent.kind === "inspect" ? "inspect" : "execute";
      if (request.intent.kind !== "answer") {
        tools = await this.options.tools.open(work!, { mode, signal: abort.signal, guard, onAction: (action: ActionRef) => this.store.transaction(() => {
          guard(); exact(action, ["id", "revision", "actionHash"]); identity(action.id); integer(action.revision, 1);
          if (!/^[a-f0-9]{64}$/.test(action.actionHash)) throw new AppError("invalid_data");
          const current = this.store.request(id);
          if (current.actions.some(ref => ref.id === action.id && ref.revision === action.revision && ref.actionHash === action.actionHash)) return;
          if (current.actions.length >= 64) throw new AppError("output_limit");
          current.actions.push(structuredClone(action)); this.store.save(current);
        }) });
        if (abort.signal.aborted) cancelTools();
        guard();
      }
      const admitted = (tools?.tools ?? []).filter(tool => tool.access === "read" || mode === "execute" && (request.intent.scope!.access === "effect" || tool.access === "reversible_write" && request.intent.scope!.access === "reversible_write"));
      if (request.intent.kind !== "answer" && !admitted.length) throw new AppError("tool_unavailable");
      if (admitted.length > 64 || new Set(admitted.map(tool => tool.definition.name)).size !== admitted.length) throw new AppError("tool_unavailable");
      const definitions: ToolDefinition[] = admitted.map(tool => {
        const definition = tool.definition;
        identity(definition.name); content(definition.description, 4096); content(canonical(definition.inputSchema), 16384);
        return { name: definition.name, description: definition.description, inputSchema: structuredClone(definition.inputSchema), execution: "exclusive", effect: tool.access === "read" ? "read-only" : "mutating",
          execute: async (input, context) => {
            let slot: string | undefined;
            try {
              guard(); const inputHash = digest(canonical(input));
              slot = this.store.transaction(() => {
                guard(); const current = this.store.request(id);
                if (current.toolCalls >= current.authority!.limits.toolCalls) throw new AppError("budget_exhausted");
                const slot = `${id}_tool_${current.toolCalls + 1}`;
                current.toolCalls++; this.store.save(current);
                this.store.db.query("INSERT INTO tool_calls VALUES (?,?,?,?,?,NULL)").run(slot, id, definition.name, inputHash, "claimed");
                this.options.beforeCommit?.(); return slot;
              });
              // Adapter receives no raw progress callback, host env or authority-bearing model fields.
              const result = await definition.execute(input, { workspace: context.workspace, signal: abort.signal });
              content(result.content, request.authority!.limits.outputBytes);
              if (this.store.evidence(id).reduce((bytes, evidence) => bytes + Buffer.byteLength(evidence.content), 0) + Buffer.byteLength(result.content) > request.authority!.limits.outputBytes) throw new AppError("output_limit");
              const evidence = { id: slot, tool: definition.name, inputHash, outputHash: digest(result.content), content: result.content, isError: result.isError === true, at: this.clock.now() };
              this.store.transaction(() => {
                this.store.db.query("UPDATE tool_calls SET state='returned',evidence_json=? WHERE id=?").run(canonical(evidence), slot!);
                this.store.event(this.store.request(id), "evidence", this.clock.now());
              });
              guard();
              if (request.memory && this.options.memory?.observe) {
                const retained = this.options.memory.observe(work!, request, evidence);
                if (retained.length) this.store.transaction(() => { const current = this.store.request(id); current.memory!.retained.push(...retained); this.store.save(current); });
              }
              return { content: result.content, isError: evidence.isError };
            } catch (error) {
              const code = safeCode(error);
              this.store.transaction(() => {
                if (slot) this.store.db.query("UPDATE tool_calls SET state='unknown' WHERE id=? AND state='claimed'").run(slot);
                const current = this.store.request(id);
                if (current.state === "running") { current.code = code; this.store.save(current); this.store.event(current, "needs_me", this.clock.now(), code); }
              });
              throw new AppError(code);
            }
          } };
      });
      // The conversation's own durable per-call ceiling applies on every path; MODEL/POLICY limits are separate and also apply.
      const countModelCall = () => this.store.transaction(() => {
        guard("model"); const current = this.store.request(id);
        if (current.modelCalls >= current.authority!.limits.modelCalls) throw new AppError("budget_exhausted");
        current.modelCalls++; this.store.save(current);
      });
      const output = this.options.runWork ? await this.options.runWork({ work: work!, request, definitions, memorySection: memory?.section, signal: abort.signal, guard: () => guard("model"), countModelCall }) : await runConversation({ directory: this.options.nativeDirectory, request, definitions, memorySection: memory?.section, signal: abort.signal, clock: this.clock, scripted: this.options.model, ...(this.options.routeAuth ? { routeAuth: this.options.routeAuth } : {}),
        guard: () => guard("model"),
        // Usage evidence is kept on a failed run too; publication below still requires completion.
        onUsage: usage => this.store.transaction(() => { const current = this.store.request(id); current.usage = usage; this.store.save(current); }),
        reserveModel: () => this.store.transaction(() => {
          guard("model"); const current = this.store.request(id);
          if (current.modelCalls >= current.authority!.limits.modelCalls) throw new AppError("budget_exhausted");
          const reservation = this.options.policy.reserveModel(work!, `${id}_model_${current.modelCalls + 1}`);
          current.modelCalls++; this.store.save(current); return reservation;
        }), correlated: (sessionId, branchId) => {
          this.store.db.query("INSERT INTO native_sessions VALUES (?,?,?,?)").run(id, "work", sessionId, branchId);
        } });
      this.store.transaction(() => {
        guard("publication"); const current = this.store.request(id), evidence = this.store.evidence(id);
        if (current.code) throw new AppError(current.code);
        if (current.intent.kind !== "answer" && !evidence.some(item => !item.isError)) throw new AppError("result_unavailable");
        if (current.memory) this.options.memory?.complete(work!, id, output.text);
        current.state = "completed"; current.code = current.intent.hold ? "owner_start_required" : null; current.result = output.text; current.usage = output.usage; current.revision++;
        this.store.save(current); this.store.event(current, "result", this.clock.now());
        if (current.code) this.store.event(current, "needs_me", this.clock.now(), current.code);
        this.options.beforeCommit?.();
      });
    } catch (error) {
      this.store.transaction(() => {
        const current = this.store.request(id);
        if (current.state === "stopped") return;
        current.state = "held"; current.code = current.code ?? safeCode(error); current.revision++;
        this.store.save(current); this.store.event(current, "needs_me", this.clock.now(), current.code);
      });
      abort.abort();
    } finally {
      if (timer) clearTimeout(timer);
      abort.signal.removeEventListener("abort", cancelTools);
      await cancel;
      try { await tools?.close(); } catch { /* Adapter retains unsettled capacity; no retries or raw diagnostics. */ }
      this.options.memory?.release(id);
      this.#running.delete(id);
      if (this.#owners.get(id)?.commandId === registration?.commandId) this.#owners.delete(id);
    }
  }
  private interpretationContext(request: ConversationRequest): { role: "owner" | "assistant"; text: string }[] {
    const context: { role: "owner" | "assistant"; text: string }[] = []; let bytes = 0;
    if (request.interpretationRequest.requestId !== request.command.requestId) context.push({ role: "owner", text: request.command.text });
    const cutoff = request.contextSequence ?? this.store.db.query<{ sequence: number }, [string]>("SELECT min(sequence) AS sequence FROM events WHERE request_id=? AND kind='received'").get(request.receipt.rootRequestId)!.sequence;
    const prior = this.store.db.query<{ id: string; command_json: string }, [string, string, string]>(`SELECT r.id,c.command_json FROM commands c JOIN requests r ON r.id=c.root_id
      WHERE r.conversation_id=? AND c.rowid<(SELECT rowid FROM commands WHERE id=?) AND r.id<>? ORDER BY c.rowid DESC LIMIT 8`).all(request.receipt.conversationId, request.interpretationRequest.requestId, request.receipt.rootRequestId);
    for (const row of prior) {
      const value = this.store.request(row.id);
      if (value.owner.id !== request.owner.id || value.owner.generation !== request.owner.generation) continue;
      const ownerCommand = JSON.parse(row.command_json) as ConversationCommand;
      if (this.options.memory && (!this.options.memory.allowHistory(ownerCommand.requestId, ownerCommand.text) || !this.options.memory.allowHistory(row.id, ownerCommand.text))) continue;
      const next: { role: "owner" | "assistant"; text: string }[] = [{ role: "owner", text: ownerCommand.text }];
      // Only tool-free answers published before this ingress may enter owner/assistant context.
      const answeredBefore = this.store.db.query<{ sequence: number }, [string, number]>("SELECT sequence FROM events WHERE request_id=? AND kind='result' AND sequence<? LIMIT 1").get(row.id, cutoff);
      if (value.intent.kind === "answer" && value.toolCalls === 0 && value.result && answeredBefore) {
        try { this.publication(value); next.push({ role: "assistant", text: value.result }); }
        catch { /* Withdrawn/unpublishable retained answers are not interpretation context. */ }
      }
      const size = Buffer.byteLength(JSON.stringify(next)); if (bytes + size > 16384) continue;
      bytes += size; context.unshift(...next);
    }
    return context;
  }
  /** Graceful stop fences late publication and waits before closing the protected store. */
  async shutdown(): Promise<void> {
    this.#closing = true;
    for (const abort of this.#running.values()) abort.abort();
    await this.#draining;
  }
}
