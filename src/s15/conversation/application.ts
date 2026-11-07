import type { HostClock, HostSteerInput, HostSteerResult, HostSteeringReport, ToolDefinition } from "schway/host";
import type { ModelStepSteering } from "../model/types";
import { AppError } from "../../errors";
import { PolicyError, type ActionRef, type ActionSlip } from "../policy";
import { applyOwnerDecision, rememberActionPresentation, type OwnerDecisionInput } from "./decisions";
import { ConversationStore } from "./store";
import { groundConversationIntent } from "./intent";
import { runConversation } from "./schway";
import { freezeInterpretation } from "./interpretation";
import { canonical, command, content, digest, exact, identity, integer } from "./validation";
import type { ConversationAuthority, ConversationCommand, ConversationDecisionCommand, ConversationEvent, ConversationIntent, ConversationOptions, ConversationReceipt, ConversationDelegationPin, ConversationRequest, ConversationRoutinePin, ConversationSteerCommand, ConversationSteerReceipt, ConversationSteerState, ConversationTools } from "./types";

const safeCodes = new Set(["bot_archived", "bot_unavailable", "delegation_unavailable", "private_context", "context_lost", "parent_unavailable", "material_ambiguity", "owner_start_required", "outside_scope", "authority_revoked", "stale_authority", "expired", "lineage_withdrawn", "selection_pinned", "budget_exhausted", "finite_budget_required", "cost_unknown", "route_unavailable", "capacity_busy", "approval_required", "recipient_approval_required", "merge_authority_required", "production_approval_required", "owner_direction_required", "policy_match_required", "adapter_unproven", "aborted", "tool_unavailable", "result_unavailable", "conversation_run_incomplete", "credential_content_refused", "authentication_required", "output_limit", "context_lost", "conversation_unavailable", "settlement_pending", "approval_reference_required", "stale_action", "already_claimed", "action_denied", "reconciliation_required", "payload_withdrawn", "read_bound_exhausted", "read_operation_unavailable", "recipient_unapproved", "classification_unknown", "recipient_unknown", "disclosure_changed", "disclosure_nonreleasable", "opaque_egress_unavailable", "memory_context_stale", "resource_busy", "stale_lease",
  // MODEL15-02: honest route status and per-send dispatch outcomes.
  "route_needs_login", "route_store_unavailable", "route_store_invalid", "route_rejected", "route_integration_unavailable", "route_renewal_timeout", "route_choice_refused", "quota_exceeded", "auth_retry_refused",
  "images_unsupported", "images_unavailable", "file_validation_failed", "file_extraction_incomplete", "sanitizer_unavailable", "sanitizer_busy", "sanitizer_cleanup_failed", "effort_unsupported", "effort_unproven", "cost_bound_unknown", "route_control_refused", "dispatch_refused", "usage_invalid", "file_unavailable", "file_integrity_failed", "file_read_required", "artifact_required", "file_work_required"]);
const accessRank = { read: 0, reversible_write: 1, effect: 2 } as const;
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
  /** Live steer sinks of running requests: the run's Schway steer function once its first send is authorized. */
  #steerSinks = new Map<string, { steer: ((input: HostSteerInput) => HostSteerResult) | null }>();
  /** Process-local owner of each steer that may still need one ordinary follow-up; never rebuilt from storage. */
  #steerActors = new Map<string, OwnerActor>();
  #wake: (() => void) | null = null;
  constructor(readonly store: ConversationStore, readonly options: ConversationOptions<OwnerActor, WorkContext>) {
    if (options.memory?.fileContract && (!store.fileMemory || !options.guardInterpretation)) throw new AppError("file_memory_required", 503);
    if (!options.memory?.fileContract && store.db.query("SELECT 1 FROM requests WHERE json_type(record_json,'$.fileMemory')='text' LIMIT 1").get()) throw new AppError("file_memory_required", 503);
    this.clock = options.clock ?? clock;
    if (!options.memory && store.db.query("SELECT 1 FROM requests WHERE json_type(record_json,'$.memory')='object' LIMIT 1").get()) throw new AppError("memory_required", 503);
    if (!options.files && store.db.query("SELECT 1 FROM requests WHERE json_type(record_json,'$.fileInputs')='array' LIMIT 1").get()) throw new AppError("files_required", 503);
    // Store lifetime holds the exclusive process lock; another live worker cannot be declared lost.
    this.store.transaction(() => {
      // A steer handed to a lost run may be in its native history; one never handed has no live owner to resubmit it.
      for (const row of this.store.db.query<{ id: string; request_id: string; state: ConversationSteerState }, []>("SELECT id,request_id,state FROM steers WHERE state IN ('queued','sent')").all()) {
        const next = row.state === "sent" ? "uncertain" : "unapplied"; this.store.setSteer(row.id, next);
        this.store.event(this.store.request(row.request_id), "steer", this.clock.now(), `steer_${next}`);
      }
      // A delegated child that never started has no live owner registration and its parent is reconcile-only now.
      for (const row of this.store.db.query<{ id: string }, []>("SELECT id FROM requests WHERE state='queued' AND json_type(record_json,'$.delegation')='object'").all()) {
        const request = this.store.request(row.id); request.state = "blocked"; request.code = "context_lost"; request.revision++;
        this.store.save(request); this.store.event(request, "stopped", this.clock.now(), request.code);
      }
      for (const row of this.store.db.query<{ id: string }, []>("SELECT id FROM requests WHERE state='running'").all()) {
        const request = this.store.request(row.id); request.state = "reconcile_only"; request.code = "context_lost"; request.revision++;
        this.store.save(request); this.store.event(request, "needs_me", this.clock.now(), request.code);
      }
    });
  }
  /** Ordinary authenticated text starts clear work immediately; duplicate ingress returns its original receipt. */
  submit(actor: OwnerActor, value: unknown): ConversationReceipt { return this.#submit(actor, value, null); }
  /**
   * Protected routine occurrence ingress (`s16-routine-run/v1`). Only the routine service calls this, with the
   * owner-confirmed pin of one occurrence. The pin narrows interpretation to its purpose, resources and access
   * ceiling and is part of the request identity: the same request ID with another pin or as an ordinary
   * message is a conflict. The text never decides a held action and cannot continue a clarification.
   */
  submitRoutine(actor: OwnerActor, value: unknown, pin: ConversationRoutinePin): ConversationReceipt {
    canonical(pin); exact(pin, ["contract", "routineId", "occurrenceId", "purposeId", "resourceIds", "access", "quiet"]);
    if (pin.contract !== "s16-routine-run/v1" || !Array.isArray(pin.resourceIds) || !pin.resourceIds.length || pin.resourceIds.length > 64 || new Set(pin.resourceIds).size !== pin.resourceIds.length || !["read", "reversible_write", "effect"].includes(pin.access) || typeof pin.quiet !== "boolean") throw new AppError("invalid_data");
    [pin.routineId, pin.occurrenceId, pin.purposeId, ...pin.resourceIds].forEach(identity);
    if (!value || typeof value !== "object" || (value as { continuation?: unknown }).continuation !== null) throw new AppError("invalid_data");
    return this.#submit(actor, value, structuredClone(pin));
  }
  /**
   * DELEG16-01 protected assignment ingress. Only the trusted delegation tool calls this, while the parent request is
   * running. In one transaction it charges the child's finite slice to the parent's own model/tool counters (never
   * refunded), checks the per-request and concurrent bounds and records the queued child with its immutable pin. The
   * child inherits the parent's frozen purpose, resources and access, never more. `bind` records the child
   * conversation's Bot before the child exists. Children are numbered per parent, so a repeated call never doubles.
   */
  submitDelegation(actor: OwnerActor, input: { parentRequestId: string; kind: ConversationDelegationPin["kind"]; botId: string; fromBotId: string; task: string; selection?: import("../policy").Selection; sourceId: string | null; bind(conversationId: string): void }, bounds: { perRequest: number; concurrent: number }): ConversationReceipt {
    this.options.policy.requireOwner(actor); identity(input.parentRequestId); identity(input.botId); identity(input.fromBotId); content(input.task, 16384);
    if (input.sourceId !== null) identity(input.sourceId);
    if (!["peer", "temporary"].includes(input.kind)) throw new AppError("invalid_data");
    const receipt = this.store.transaction(() => {
      const parent = this.store.request(input.parentRequestId); this.owner(actor, parent);
      if (this.#closing) throw new AppError("conversation_unavailable", 503);
      if (parent.state !== "running" || parent.phase !== "work" || !parent.authority || !parent.intent.scope || parent.delegation || parent.code) throw new AppError("delegation_unavailable", 409);
      const children = this.store.db.query<{ state: string }, [string]>("SELECT state FROM requests WHERE json_extract(record_json,'$.delegation.parentRequestId')=?").all(parent.receipt.rootRequestId);
      if (children.length >= bounds.perRequest) throw new AppError("budget_exhausted", 409);
      if (children.filter(child => child.state === "queued" || child.state === "running").length >= bounds.concurrent) throw new AppError("capacity_busy", 409);
      // No computer session can be free for a child while ordinary work (waiting parents included) holds them all.
      if (this.#delegationCapacity() === 0) throw new AppError("capacity_busy", 409);
      const limits = parent.authority.limits, slice = { modelCalls: Math.max(2, Math.floor(limits.modelCalls / 3)), toolCalls: Math.max(1, Math.floor(limits.toolCalls / 3)) };
      // Shared finite budget: the parent keeps at least one model call to report; the slice is never refunded.
      if (parent.modelCalls + slice.modelCalls >= limits.modelCalls || parent.toolCalls + slice.toolCalls > limits.toolCalls) throw new AppError("budget_exhausted", 409);
      this.store.capacity();
      const ordinal = children.length + 1, key = digest(`s16.delegation.child.v1\n${parent.receipt.rootRequestId}\n${ordinal}`);
      const childId = `dl_${key.slice(0, 40)}`, conversationId = `dc_${key.slice(0, 40)}`;
      input.bind(conversationId);
      this.options.admitConversation?.(conversationId);
      parent.modelCalls += slice.modelCalls; parent.toolCalls += slice.toolCalls; parent.revision++; this.store.save(parent);
      const scope = parent.intent.scope, command: ConversationCommand = { contract: "s15-conversation/v1", requestId: childId, conversationId, text: input.task, continuation: null };
      const pin: ConversationDelegationPin = { contract: "s16-delegation-run/v1", parentRequestId: parent.receipt.rootRequestId, parentConversationId: parent.receipt.conversationId, ordinal, kind: input.kind, botId: input.botId, fromBotId: input.fromBotId, purposeId: scope.purposeId, resourceIds: [...scope.resourceIds], access: scope.access, limits: slice, ...(input.kind === "temporary" && input.selection ? { selection: structuredClone(input.selection) } : {}), sourceId: input.sourceId };
      const intent: ConversationIntent = { kind: scope.access === "read" ? "inspect" : "execute", subject: null, instruction: input.task, scope: { purposeId: scope.purposeId, resourceIds: [...scope.resourceIds], access: scope.access } };
      const receipt: ConversationReceipt = { contract: "s15-conversation-receipt/v1", requestId: childId, rootRequestId: childId, conversationId, receivedAt: this.clock.now() };
      const request: ConversationRequest = { receipt, command, interpretationRequest: command, owner: { ...parent.owner }, revision: 1, intent, state: "queued", code: null, authority: null, phase: "work", interpretation: null, interpretationCalls: 0, modelCalls: 0, toolCalls: 0, result: null, usage: null, actions: [], decision: null, delegation: pin };
      this.store.db.query("INSERT INTO requests VALUES (?,?,?,?)").run(childId, conversationId, request.state, canonical(request));
      this.store.db.query("INSERT INTO commands VALUES (?,?,?,?,?)").run(childId, digest(`s16.delegation.command.v1\n${canonical({ command, pin })}`), childId, canonical(receipt), canonical(command));
      this.store.event(request, "received", this.clock.now());
      this.store.event(request, "admitted", this.clock.now());
      this.options.beforeCommit?.();
      return receipt;
    });
    this.#owners.set(receipt.rootRequestId, { actor, commandId: receipt.requestId });
    this.#wakeDrain();
    return receipt;
  }
  /** Children that may run now: the pool, bounded by computer sessions that no running ordinary request may hold. */
  #delegationCapacity(): number {
    const pool = Math.max(1, Math.min(this.options.maxDelegatedRuns ?? 3, 8));
    if (!this.options.delegationSessions) return pool;
    const sessions = this.options.delegationSessions(), ordinary = this.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM requests WHERE state='running' AND json_type(record_json,'$.delegation') IS NULL").get()!.n;
    return Math.max(0, Math.min(pool, (Number.isSafeInteger(sessions) ? sessions : 0) - ordinary));
  }
  /** `decision` comes only from the exact one-press decision command (`decide`); typed text never decides. */
  #submit(actor: OwnerActor, value: unknown, pin: ConversationRoutinePin | null, decision: OwnerDecisionInput | null = null): ConversationReceipt {
    this.options.policy.requireOwner(actor); command(value);
    const input = structuredClone(value), hash = pin ? digest(`s16.routine.command.v1\n${canonical({ input, pin })}`) : digest(`s15.chat.command.v1\n${canonical(input)}`);
    const receipt = this.store.transaction(() => {
      const owner = this.options.policy.requireOwner(actor);
      const prior = this.store.db.query<{ payload_hash: string; receipt_json: string; root_id: string }, [string]>("SELECT payload_hash,receipt_json,root_id FROM commands WHERE id=?").get(input.requestId);
      if (prior) {
        this.owner(actor, this.store.request(prior.root_id));
        if (prior.payload_hash !== hash) throw new AppError("request_id_conflict", 409);
        return JSON.parse(prior.receipt_json) as ConversationReceipt;
      }
      if (this.#closing) throw new AppError("conversation_unavailable", 503);
      // BOT16-01: an archived Bot's conversation accepts nothing new (messages, clarifications, routine runs).
      this.options.admitConversation?.(input.conversationId);
      this.store.capacity();
      let intent = groundConversationIntent(input.text, { fileOutput: input.contract === "s16-conversation/v2" });
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
        if (pin) request.routine = pin;
        if (input.contract === "s16-conversation/v2") {
          if (!this.options.files) throw new AppError("upload_unavailable", 503);
          this.store.requireFileContract();
          request.fileInputs = this.options.files.accept(actor, input);
          if (request.fileInputs.some(file => file.contract === "s16-file-receipt/v2")) this.store.requireFileContract(3); request.artifacts = [];
          if (this.options.memory?.fileContract) { this.store.requireFileContract(4); request.fileMemory = this.options.memory.fileContract; }
          if (input.text === "") intent = { kind: "accept", subject: null, instruction: "" };
        }
        this.store.db.query("INSERT INTO requests VALUES (?,?,?,?)").run(input.requestId, input.conversationId, request.state, canonical(request));
      }
      request.intent = intent; request.interpretationRequest = input; request.revision++;
      // S16-D08 (ADR 0084): typed text never decides a held action, not even "approve" or "อนุมัติ" from the owner;
      // only the one-press exact decision command does. Any other text is an ordinary message.
      if (decision && !pin && input.continuation === null && !request.fileInputs) {
        try { applyOwnerDecision(this, actor, request, decision); }
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
   * `s16-conversation-steer/v1` (CHAT16-02): authenticated owner text that steers one unfinished request of this
   * conversation. It is owner input inside that request's frozen scope: tools, resources and access stay as admitted,
   * and it never decides a held action. While the request runs, the text is handed to its live Schway run
   * (`schway.host.steering/v1`), which applies it at the next tool boundary. Whatever that run reports unapplied becomes
   * exactly one ordinary follow-up message; a steer the run may have recorded stays `uncertain` and is never resent. A
   * request that is no longer running (held, settled, stopped) receives the text at once as one ordinary follow-up,
   * except a stopped request, whose steers are only recorded. A repeated request ID returns the same steer's state.
   */
  steer(actor: OwnerActor, value: unknown): ConversationSteerReceipt {
    this.options.policy.requireOwner(actor); canonical(value);
    exact(value, ["contract", "requestId", "conversationId", "target", "text"]);
    const input = structuredClone(value) as unknown as ConversationSteerCommand;
    if (input.contract !== "s16-conversation-steer/v1") throw new AppError("invalid_contract");
    identity(input.requestId); identity(input.conversationId); identity(input.target); content(input.text);
    const hash = digest(`s16.chat.steer.v1\n${canonical(input)}`);
    const live = this.store.transaction(() => {
      const prior = this.store.db.query<{ payload_hash: string; root_id: string }, [string]>("SELECT payload_hash,root_id FROM commands WHERE id=?").get(input.requestId);
      if (prior) { this.owner(actor, this.store.request(prior.root_id)); if (prior.payload_hash !== hash) throw new AppError("request_id_conflict", 409); return null; }
      if (this.#closing) throw new AppError("conversation_unavailable", 503);
      this.store.capacity();
      const target = this.store.request(input.target); this.owner(actor, target);
      if (target.receipt.conversationId !== input.conversationId || target.receipt.rootRequestId !== input.target) throw new AppError("outside_scope", 403);
      const receipt: ConversationReceipt = { contract: "s15-conversation-receipt/v1", requestId: input.requestId, rootRequestId: input.target, conversationId: input.conversationId, receivedAt: this.clock.now() };
      this.store.db.query("INSERT INTO commands VALUES (?,?,?,?,?)").run(input.requestId, hash, input.target, canonical(receipt), canonical(input));
      this.store.db.query("INSERT INTO steers VALUES (?,?,?,NULL,?)").run(input.requestId, input.target, "queued", receipt.receivedAt);
      this.store.event(target, "steer", receipt.receivedAt, "steer_queued");
      this.options.beforeCommit?.();
      // Only a request this process will still run can take the steer; its work phase opens the live sink.
      return target.phase !== "decision" && (this.#steerSinks.has(input.target) || target.state === "queued" && this.#owners.has(input.target));
    });
    if (live !== null) {
      this.#steerActors.set(input.requestId, actor);
      if (!live) this.#followUp(input.requestId);
      else this.#deliverSteers(input.target);
    }
    return this.steerReceipt(actor, input.requestId);
  }
  /** Current owner-checked disposition of one steer command. */
  steerReceipt(actor: OwnerActor, steerId: string): ConversationSteerReceipt {
    this.options.policy.requireOwner(actor); identity(steerId);
    const row = this.store.db.query<{ request_id: string }, [string]>("SELECT request_id FROM steers WHERE id=?").get(steerId);
    if (!row) throw new AppError("not_found", 404);
    const target = this.store.request(row.request_id); this.owner(actor, target);
    const steer = this.store.steers(row.request_id).find(item => item.id === steerId)!;
    return { contract: "s16-conversation-steer-receipt/v1", requestId: steerId, conversationId: target.receipt.conversationId, target: row.request_id, state: steer.state, followUp: steer.followUp };
  }
  /** Hands every still-queued steer of a live run to it, in acceptance order. */
  #deliverSteers(requestId: string): void {
    for (const row of this.store.steers(requestId)) {
      const sink = this.#steerSinks.get(requestId);
      if (!sink?.steer) return;
      if (row.state !== "queued") continue;
      let result: HostSteerResult;
      try { result = sink.steer({ id: row.id, text: row.text }); } catch { result = { kind: "rejected", id: row.id, reason: "limit" }; }
      if (result.kind === "queued" || result.kind === "applied") this.#setSteer(row.id, result.kind === "queued" ? "sent" : "applied");
      else if (result.kind === "rejected" && result.reason === "uncertain") this.#setSteer(row.id, "uncertain");
      else this.#followUp(row.id);
    }
  }
  #setSteer(steerId: string, state: ConversationSteerState, followUp: string | null = null): void {
    this.store.transaction(() => {
      const row = this.store.db.query<{ request_id: string; state: ConversationSteerState }, [string]>("SELECT request_id,state FROM steers WHERE id=?").get(steerId);
      if (!row || row.state === state || ["applied", "resubmitted", "unapplied", "uncertain"].includes(row.state)) return;
      this.store.setSteer(steerId, state, followUp);
      this.store.event(this.store.request(row.request_id), "steer", this.clock.now(), `steer_${state}`);
    });
    if (state !== "queued" && state !== "sent") this.#steerActors.delete(steerId);
  }
  /** Resends one never-applied steer as exactly one ordinary message, or records it unapplied without a live owner. */
  #followUp(steerId: string): void {
    const actor = this.#steerActors.get(steerId);
    const row = this.store.db.query<{ request_id: string; state: ConversationSteerState }, [string]>("SELECT request_id,state FROM steers WHERE id=?").get(steerId);
    if (!row || (row.state !== "queued" && row.state !== "sent")) return;
    if (!actor || this.store.request(row.request_id).state === "stopped" || this.#closing) { this.#setSteer(steerId, "unapplied"); return; }
    const followUp = `${steerId.slice(0, 100)}_f${digest(`s16.chat.steer.follow-up.v1\n${steerId}`).slice(0, 16)}`;
    try {
      this.store.transaction(() => {
        const steer = this.store.steers(row.request_id).find(item => item.id === steerId)!, target = this.store.request(row.request_id);
        this.#submit(actor, { contract: "s15-conversation/v1", requestId: followUp, conversationId: target.receipt.conversationId, text: steer.text, continuation: null }, null);
        this.store.setSteer(steerId, "resubmitted", followUp);
        this.store.event(target, "steer", this.clock.now(), "steer_resubmitted");
      });
      this.#steerActors.delete(steerId);
      this.#wakeDrain();
    } catch { this.#setSteer(steerId, "unapplied"); }
  }
  /** Settles a finished run's steers from its exact Schway report; anything handed without a report is uncertain. */
  #closeSteers(requestId: string, report: HostSteeringReport | null | undefined): void {
    this.#steerSinks.delete(requestId);
    const applied = new Set(report?.applied.map(item => item.id) ?? []), unapplied = new Set(report?.unapplied.map(item => item.id) ?? []);
    for (const row of this.store.steers(requestId)) {
      if (row.state === "queued") this.#followUp(row.id);
      else if (row.state !== "sent") continue;
      else if (applied.has(row.id)) this.#setSteer(row.id, "applied");
      else if (unapplied.has(row.id)) this.#followUp(row.id);
      else this.#setSteer(row.id, "uncertain");
    }
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
      const receipt = this.#submit(actor, { contract: "s15-conversation/v1", requestId: input.requestId, conversationId: input.conversationId, text, continuation: null }, null, { decision: input.decision, actionId: input.action.id });
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
    } catch (error) { return { ...projected, ...(request.fileInputs ? { artifacts: [] } : {}), result: null, code: safeCode(error), evidence: [], slips: [] }; }
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
      catch (error) { return { ...projected, ...(request.fileInputs ? { artifacts: [] } : {}), result: null, code: safeCode(error), evidence: [], slips }; }
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
    if (request.fileInputs) { if (!this.options.files) throw new AppError("file_unavailable"); this.options.files.guard(work, request); }
    if (request.memory) { if (!this.options.memory) throw new AppError("memory_context_stale", 409); this.options.memory.guard(work, request.receipt.rootRequestId); }
  }
  /** Stops only this request. Unknown guest/effect claims remain retained by their owning service. */
  stop(actor: OwnerActor, requestId: string): void {
    this.store.transaction(() => {
      const request = this.store.request(requestId); this.owner(actor, request);
      if (request.state === "stopped") return;
      // Versioned file publication is already delivered if its commit won this race. Source withdrawal
      // has its own explicit lifecycle; a late stop must not erase the earlier committed deliverable.
      if (request.fileInputs && request.state === "completed") return;
      if (request.authority) this.options.policy.stopWork?.(actor, request.authority, requestId);
      request.state = "stopped"; request.code = "aborted"; request.revision++;
      this.store.save(request); this.store.event(request, "stopped", this.clock.now(), "aborted");
    });
    this.#running.get(requestId)?.abort();
    // DELEG16-01: stopping the originating request stops its unfinished children; a child's stop leaves its siblings.
    for (const child of this.store.db.query<{ id: string }, [string]>("SELECT id FROM requests WHERE json_extract(record_json,'$.delegation.parentRequestId')=? AND state IN ('queued','running','held','proposed')").all(requestId)) {
      try { this.stop(actor, child.id); } catch { /* Settled meanwhile. */ }
    }
  }
  /**
   * Wakes the local durable queue drain. Concurrent callers share it; a claim is committed before I/O. Up to
   * `maxConcurrentRuns` requests (default 2) run at once, never two of one conversation, so an independent
   * conversation proceeds while another waits or works. The promise settles once nothing runnable remains.
   */
  drain(): Promise<void> {
    if (this.#draining) { this.#wakeDrain(); return this.#draining; }
    const done = Promise.withResolvers<void>(); this.#draining = done.promise;
    const max = Math.max(1, Math.min(this.options.maxConcurrentRuns ?? 2, 8));
    const delegatedPool = () => this.#delegationCapacity();
    void (async () => {
      const active = new Map<string, Promise<void>>(), children = new Set<string>();
      let failure: unknown = null;
      try {
        while (!this.#closing) {
          const busy = new Set([...active.keys()].map(id => this.store.request(id).receipt.conversationId));
          // Only process-local authenticated registrations are runnable after restart. Delegated children use their own
          // finite pool: a parent waiting on its children holds an ordinary slot and must not starve them.
          const delegated = delegatedPool();
          const runnable = (id: string) => { const request = this.store.request(id); return !active.has(id) && request.state === "queued" && !busy.has(request.receipt.conversationId) && (request.delegation ? children.size < delegated : active.size - children.size < max); };
          const id = [...this.#owners.keys()].find(runnable);
          if (id) {
            if (this.store.request(id).delegation) children.add(id);
            const run = (this.store.request(id).phase === "decision" ? this.runDecision(id) : this.run(id)).catch(error => { failure ??= error; }).finally(() => { active.delete(id); children.delete(id); });
            active.set(id, run); continue;
          }
          if (!active.size) break;
          const woken = new Promise<void>(resolve => { this.#wake = resolve; });
          await Promise.race([...active.values(), woken]);
          this.#wake = null;
        }
        await Promise.all(active.values());
        if (failure) done.reject(failure); else done.resolve();
      } catch (error) { await Promise.allSettled(active.values()); done.reject(error); }
      finally { this.#draining = null; this.#wake = null; }
    })();
    return done.promise;
  }
  #wakeDrain(): void { this.#wake?.(); }
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
    // CHAT16-02: steers wait here until the work run's first authorized send opens its live Schway sink.
    this.#steerSinks.set(id, { steer: null });
    let steerReport: HostSteeringReport | null | undefined;
    const steering: ModelStepSteering = {
      open: steer => { const sink = this.#steerSinks.get(id); if (sink && !abort.signal.aborted) { sink.steer = steer; this.#deliverSteers(id); } },
      settle: report => { const sink = this.#steerSinks.get(id); if (sink) sink.steer = null; steerReport = report; },
    };
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
      if (current.phase === "work" && current.fileInputs) { if (!this.options.files) throw new AppError("file_unavailable"); this.options.files.guard(work, current); }
      if (current.phase === "work" && current.memory) { if (!this.options.memory) throw new AppError("memory_context_stale", 409); this.options.memory.guard(work, id); }
    };
    const cancelTools = () => { if (tools && !cancel) cancel = Promise.resolve().then(() => tools!.cancel()).catch(() => {}); };
    abort.signal.addEventListener("abort", cancelTools, { once: true });
    try {
      let request: ConversationRequest;
      // DELEG16-01: a delegated child has no interpretation call; its pin already fixes the narrowed scope.
      if (this.store.request(id).delegation) request = this.store.transaction(() => this.admitDelegation(id, registration?.actor));
      else {
      request = this.store.transaction(() => {
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
      const interpretationContext = this.interpretationContext(request, work!);
      const interpreted = await runConversation({ directory: this.options.nativeDirectory, request, definitions: [], signal: abort.signal, clock: this.clock, scripted: this.options.interpreterModel ?? this.options.model, ...(this.options.routeAuth ? { routeAuth: this.options.routeAuth } : {}),
        interpretation: { ...request.interpretation!, context: interpretationContext.messages }, guard: () => { guard("model"); this.options.memory?.guardHistory?.(work!, interpretationContext.fragments); },
        onUsage: usage => this.store.transaction(() => { const current = this.store.request(id); current.interpretationUsage = usage; this.store.save(current); }),
        ...(this.options.guardInterpretation ? { guardContext: (payload: unknown) => { const pins = this.options.memory?.guardHistory?.(work!, interpretationContext.fragments) ?? []; this.options.guardInterpretation!(work!, payload, pins); } } : {}),
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
        const selectedSubjects = interpretationContext.messages.filter(message => message.role === "owner").map(message => groundConversationIntent(message.text)).filter(intent => intent.kind === "accept" || intent.kind === "execute").flatMap(intent => intent.subject ? [intent.subject] : []);
        // A routine occurrence may only interpret within its owner-confirmed pin; it can narrow, never broaden.
        const pin = current.routine, purposes = pin ? current.interpretation!.purposes.filter(purpose => purpose === pin.purposeId) : current.interpretation!.purposes;
        const resources = pin ? current.interpretation!.resources.filter(resource => pin.resourceIds.includes(resource)) : current.interpretation!.resources;
        if (pin && (!purposes.length || !resources.length)) throw new AppError("outside_scope");
        current.intent = freezeInterpretation(interpreted.text, current.intent, { purposes, resources, selectedSubjects, fileOutput: current.command.contract === "s16-conversation/v2" });
        if (pin && current.intent.scope && accessRank[current.intent.scope.access] > accessRank[pin.access]) throw new AppError("outside_scope");
        if (current.fileInputs && current.intent.kind === "answer") throw new AppError("file_work_required");
        if (current.intent.kind === "ambiguous" || current.intent.kind === "accept") {
          current.state = current.intent.kind === "accept" ? "accepted" : "held"; current.code = current.intent.kind === "accept" ? null : "material_ambiguity";
        } else {
          const imageInputs = current.fileInputs?.filter(file => file.contract === "s16-file-receipt/v2" && file.representation.mime !== "text/plain").length ?? 0;
          const decision = this.options.policy.admit(actor, current.command, current.intent, { imageInputs, ownerMessage: !current.routine });
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
      }
      if (request.state !== "running") return;
      work = this.options.policy.open(request.authority!); guard("model");
      clearTimeout(timer); startedAt = this.clock.now(); timer = setTimeout(() => abort.abort(), request.authority!.limits.activeMs);
      // Persist continuity dependency before MEM can retain/withdraw anything. A later boot without
      // that protected service must refuse rather than replay raw owner/history or publish old data.
      if (this.options.memory && !request.delegation && (!request.fileInputs || request.fileMemory)) this.store.transaction(() => { const current = this.store.request(id); current.memory = { retained: [] }; this.store.save(current); });
      const ingress = this.store.db.query<{ receipt_json: string }, [string]>("SELECT receipt_json FROM commands WHERE id=?").get(request.interpretationRequest.requestId)!;
      // A delegated child works from its assignment only: no sourced memory is retrieved or retained for it.
      const memory = request.delegation || request.fileInputs && !request.fileMemory ? undefined : this.options.memory?.prepare(work!, request, { receivedAt: (JSON.parse(ingress.receipt_json) as ConversationReceipt).receivedAt });
      if (memory) {
        this.store.transaction(() => { const current = this.store.request(id); current.memory = { retained: memory.retained }; this.store.save(current); });
        request = this.store.request(id); guard("model");
      }
      const mode: "inspect" | "execute" = request.intent.kind === "inspect" ? "inspect" : "execute";
      if (request.intent.kind !== "answer") {
        const toolInput = { mode, signal: abort.signal, guard, onAction: (action: ActionRef) => this.store.transaction(() => {
          guard(); exact(action, ["id", "revision", "actionHash"]); identity(action.id); integer(action.revision, 1);
          if (!/^[a-f0-9]{64}$/.test(action.actionHash)) throw new AppError("invalid_data");
          const current = this.store.request(id);
          if (current.actions.some(ref => ref.id === action.id && ref.revision === action.revision && ref.actionHash === action.actionHash)) return;
          if (current.actions.length >= 64) throw new AppError("output_limit");
          current.actions.push(structuredClone(action)); this.store.save(current);
        }) };
        tools = request.fileInputs ? await this.options.files!.open(work!, request, toolInput) : await this.options.tools.open(work!, toolInput);
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
              const evidenceContent = tool.evidenceContent?.(result.content) ?? result.content;
              content(evidenceContent, request.authority!.limits.outputBytes);
              if (this.store.evidence(id).reduce((bytes, evidence) => bytes + Buffer.byteLength(evidence.content), 0) + Buffer.byteLength(evidenceContent) > request.authority!.limits.outputBytes) throw new AppError("output_limit");
              const evidence = { id: slot, tool: definition.name, inputHash, outputHash: digest(result.content), content: evidenceContent, isError: result.isError === true, at: this.clock.now() };
              this.store.transaction(() => {
                this.store.db.query("UPDATE tool_calls SET state='returned',evidence_json=? WHERE id=?").run(canonical(evidence), slot!);
                this.store.event(this.store.request(id), "evidence", this.clock.now());
              });
              guard();
              if (request.memory && this.options.memory?.observe) {
                const retained = this.options.memory.observe(work!, request, evidence, this.store.evidence(id));
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
      const observeInput = (evidence: import("./types").ConversationEvidence) => this.store.transaction(() => {
        guard("model"); canonical(evidence); content(evidence.content, 4096); const current = this.store.request(id);
        if (!current.fileInputs || evidence.kind !== "input" || evidence.isError) throw new AppError("outside_scope");
        current.inputEvidence ??= []; if (current.inputEvidence.some(row => row.id === evidence.id)) return;
        if (current.inputEvidence.length >= 64) throw new AppError("output_limit"); current.inputEvidence.push(evidence); this.store.save(current); this.store.event(current, "evidence", this.clock.now());
      });
      const output = this.options.runWork ? await this.options.runWork({ work: work!, request, definitions, memorySection: memory?.section, signal: abort.signal, guard: () => guard("model"), countModelCall, observeInput, steering }) : await runConversation({ directory: this.options.nativeDirectory, request, definitions, memorySection: memory?.section, signal: abort.signal, clock: this.clock, scripted: this.options.model, steering, ...(this.options.routeAuth ? { routeAuth: this.options.routeAuth } : {}),
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
        if (current.fileInputs) current.artifacts = this.options.files!.complete(work!, current, evidence);
        if (current.memory) { const retained = this.options.memory?.complete(work!, id, output.text); if (retained?.length) current.memory.retained.push(...retained); }
        if (current.memory && current.artifacts?.length) this.options.memory?.artifacts?.(work!, id, current.artifacts);
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
      try { this.#closeSteers(id, steerReport); } catch { /* Steers keep their stored state; a later boot settles them. */ }
      if (this.#owners.get(id)?.commandId === registration?.commandId) this.#owners.delete(id);
    }
  }
  /** Claims one queued delegated child and admits it under current policy inside its pin; a refusal blocks it. */
  private admitDelegation(id: string, actor: OwnerActor | undefined): ConversationRequest {
    const current = this.store.request(id);
    if (current.state !== "queued" || !current.delegation) throw new AppError("already_claimed", 409);
    if (!actor) throw new AppError("authentication_required", 401);
    this.owner(actor, current);
    const pin = current.delegation;
    let code: string | null = null;
    try {
      if (this.store.request(pin.parentRequestId).state !== "running") throw new AppError("parent_unavailable", 409);
      this.options.admitConversation?.(current.receipt.conversationId);
      const decision = this.options.policy.admit(actor, current.command, current.intent, { imageInputs: 0, ownerMessage: false, delegation: { ...pin.limits, ...(pin.selection ? { selection: pin.selection } : {}) } });
      if (decision.state !== "admitted") code = safeCodes.has(decision.code) ? decision.code : "policy_match_required";
      else {
        const admitted = authority(decision.authority);
        if (admitted.purposeId !== pin.purposeId || admitted.resources.some(resource => !pin.resourceIds.includes(resource))) throw new AppError("outside_scope");
        current.authority = admitted; current.state = "running";
      }
    } catch (error) { code = safeCode(error); }
    if (code) { current.state = "blocked"; current.code = code; }
    current.revision++; this.store.save(current);
    this.store.event(current, current.state === "running" ? "progress" : "stopped", this.clock.now(), current.code);
    this.options.beforeCommit?.();
    return current;
  }
  private interpretationContext(request: ConversationRequest, work: WorkContext): { messages: { role: "owner" | "assistant"; text: string }[]; fragments: { id: string; text: string }[] } {
    const context: { role: "owner" | "assistant"; text: string }[] = []; let bytes = 0;
    const fragments: { id: string; text: string }[] = [];
    if (request.interpretationRequest.requestId !== request.command.requestId) context.push({ role: "owner", text: request.command.text });
    const cutoff = request.contextSequence ?? this.store.db.query<{ sequence: number }, [string]>("SELECT min(sequence) AS sequence FROM events WHERE request_id=? AND kind='received'").get(request.receipt.rootRequestId)!.sequence;
    const prior = this.store.db.query<{ id: string; command_json: string }, [string, string, string]>(`SELECT r.id,c.command_json FROM commands c JOIN requests r ON r.id=c.root_id
      WHERE r.conversation_id=? AND c.rowid<(SELECT rowid FROM commands WHERE id=?) AND r.id<>? ORDER BY c.rowid DESC LIMIT 8`).all(request.receipt.conversationId, request.interpretationRequest.requestId, request.receipt.rootRequestId);
    for (const row of prior) {
      const value = this.store.request(row.id);
      if (value.owner.id !== request.owner.id || value.owner.generation !== request.owner.generation) continue;
      // Older file commands keep their frozen memory/history fence. New file-aware history is admitted
      // only with an existing current packet, precise ancestry and a final per-send disclosure check.
      if (value.fileInputs && (!value.fileMemory || !this.options.memory?.fileContract)) continue;
      const ownerCommand = JSON.parse(row.command_json) as ConversationCommand;
      if (this.options.memory && (!this.options.memory.allowHistory(ownerCommand.requestId, ownerCommand.text) || !this.options.memory.allowHistory(row.id, ownerCommand.text))) continue;
      if (value.memory && this.options.memory?.history && !this.options.memory.history(work, row.id, ownerCommand.text)) continue;
      if (value.fileInputs && !value.memory) continue;
      const next: { role: "owner" | "assistant"; text: string }[] = [{ role: "owner", text: ownerCommand.text }];
      // Only tool-free answers published before this ingress may enter owner/assistant context.
      const answeredBefore = this.store.db.query<{ sequence: number }, [string, number]>("SELECT sequence FROM events WHERE request_id=? AND kind='result' AND sequence<? LIMIT 1").get(row.id, cutoff);
      if (value.intent.kind === "answer" && value.toolCalls === 0 && value.result && answeredBefore) {
        try { this.publication(value); next.push({ role: "assistant", text: value.result }); }
        catch { /* Withdrawn/unpublishable retained answers are not interpretation context. */ }
      }
      const size = Buffer.byteLength(JSON.stringify(next)); if (bytes + size > 16384) continue;
      bytes += size; context.unshift(...next);
      if (value.memory && this.options.memory?.guardHistory) fragments.push({ id: row.id, text: ownerCommand.text });
    }
    return { messages: context, fragments };
  }
  /** Graceful stop fences late publication and waits before closing the protected store. */
  async shutdown(): Promise<void> {
    this.#closing = true;
    for (const abort of this.#running.values()) abort.abort();
    await this.#draining;
  }
}
