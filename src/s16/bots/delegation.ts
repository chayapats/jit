import { AppError } from "../../errors";
import type { ConversationApplication } from "../../s15/conversation/application";
import type { ConversationPolicyWork } from "../../s15/conversation/policy-port";
import type { ConversationRequest, ConversationToolPort, ConversationTools } from "../../s15/conversation/types";
import { canonical, content, digest, exact, identity } from "../../s15/conversation/validation";
import type { DisclosureService } from "../../s15/disclosure";
import type { MemoryService } from "../../s15/memory";
import type { OwnerActor, Ref, S15PolicyService } from "../../s15/policy";
import type { TeamService } from "../../s15/team";
import type { BotDirectory } from "./service";
import { delegationLimits } from "./types";

/** Child states after which a parent stops waiting. A held child keeps its own needs-you item for the owner. */
const settled = new Set<ConversationRequest["state"]>(["completed", "blocked", "stopped", "held", "proposed", "reconcile_only", "accepted"]);
const uid = () => crypto.randomUUID().replaceAll("-", "");
const resultChars = 8000;

/** Trusted composition of the Bot tools; every port is protected host code. */
export interface BotToolOptions {
  conversation: ConversationApplication<OwnerActor, ConversationPolicyWork>;
  directory: BotDirectory<OwnerActor>;
  policy: S15PolicyService;
  team: TeamService;
  memory?: MemoryService;
  disclosure?: DisclosureService;
  /** Re-establishes the request's recorded owner; null when the owner generation changed. */
  owner(snapshot: { id: string; generation: number }): OwnerActor | null;
  /** Wait between child state reads (default 25 ms). */
  pollMs?: number;
}

/**
 * BOT16-01 / DELEG16-01 host tools (ADR 0088). `delegate` hands bounded assignments to enabled peer Bots or to
 * temporary workers and waits for their results; `propose_bot` (main Bot only) drafts an inert Bot proposal card.
 * Neither grants authority: children run inside the parent's frozen scope and charged slice, and a proposal does
 * nothing until the owner accepts its exact hash. A delegated child is offered neither tool.
 */
export function createBotTools(options: BotToolOptions) {
  const { conversation, directory, policy, team } = options;
  const parentOf = (workId: string): ConversationRequest => {
    const row = conversation.store.db.query<{ id: string }, [string]>("SELECT id FROM requests WHERE json_extract(record_json,'$.authority.id')=? LIMIT 1").get(workId);
    if (!row) throw new AppError("delegation_unavailable", 409);
    return conversation.store.request(row.id);
  };
  const ownerOf = (request: ConversationRequest) => { const actor = options.owner(request.owner); if (!actor) throw new AppError("authentication_required", 401); return actor; };
  const assignmentRef = (sourceId: string, generation: number): Ref => ({ id: sourceId, revision: 1, generation });
  const peers = (owner: OwnerActor, self: string) => directory.view(owner).bots.filter(bot => bot.id !== self && bot.state === "active" && bot.assignments);

  /** Capture the task as a TEAM source carrying its context's privacy ancestry (claims and file pins). */
  function capture(work: ConversationPolicyWork, parent: ConversationRequest, task: string, kind: "peer" | "temporary"): string {
    const context = team.bind(work.actor), sourceId = `as_${uid()}`;
    const lineage = parent.memory && options.memory ? options.memory.contextLineage(context, parent.receipt.rootRequestId) : { sourceIds: [], private: false, filePins: [] };
    // Text written from Bot-private context stays private to that Bot: only a temporary worker (the same Bot) can take it.
    if (lineage.private && kind === "peer") throw new AppError("private_context", 409);
    team.capture(context, { id: sourceId, text: task, scope: lineage.private ? { kind: "bot", botId: work.authority.request.bot.id, origin: "s15" } : { kind: "team" },
      origin: { kind: "work", id: work.authority.id, conversationId: parent.receipt.conversationId, at: conversation.clock.now() }, resources: [], parents: lineage.sourceIds, ...(lineage.filePins.length ? { filePins: lineage.filePins } : {}) });
    // DATA15: the task inherits every source this work already read, so each later send of the child is checked for them.
    options.disclosure?.derive(work.actor, assignmentRef(sourceId, work.authority.ownerGeneration), "text");
    return sourceId;
  }

  function delegateTool(work: ConversationPolicyWork, parent: ConversationRequest, input: { signal: AbortSignal; guard: () => void }): ConversationTools["tools"][number] {
    const owner = ownerOf(parent), self = work.authority.request.bot.id;
    const available = peers(owner, self).map(bot => `- ${bot.id}: ${bot.name || "main"}${bot.responsibility ? ` — ${bot.responsibility.slice(0, 200)}` : ""}`).join("\n");
    const access = parent.intent.scope?.access ?? "read";
    return { access, definition: {
      name: "delegate",
      description: `Hand up to ${delegationLimits.perCall} bounded assignments to other Bots and wait for their results. Use "temporary" for a short-lived helper that works as you, or a Bot id below. Each assignee works only inside your current task's scope with a small share of your remaining budget, and without your conversation history or memory, so write each task self-contained. Results return here; you stay responsible for the final answer.\n${available ? `Bots that accept assignments:\n${available}` : "No other Bot accepts assignments right now; use \"temporary\"."}`,
      inputSchema: { type: "object", additionalProperties: false, required: ["assignments"], properties: { assignments: { type: "array", minItems: 1, maxItems: delegationLimits.perCall, items: { type: "object", additionalProperties: false, required: ["to", "task"], properties: { to: { type: "string", description: "\"temporary\" or a Bot id" }, task: { type: "string", maxLength: delegationLimits.taskChars } } } } } },
      execution: "exclusive", effect: access === "read" ? "read-only" : "mutating",
      async execute(value) {
        input.guard();
        exact(value, ["assignments"]);
        const list = (value as { assignments: unknown }).assignments;
        if (!Array.isArray(list) || !list.length || list.length > delegationLimits.perCall) throw new AppError("invalid_data");
        const results: { to: string; state: string; code: string | null; result: string | null; requestId: string | null }[] = [];
        const started: { index: number; requestId: string }[] = [];
        for (const item of list) {
          exact(item, ["to", "task"]);
          const to = (item as { to: unknown }).to, task = (item as { task: unknown }).task;
          if (typeof to !== "string" || typeof task !== "string" || [...task].length > delegationLimits.taskChars) throw new AppError("invalid_data");
          content(task, delegationLimits.taskChars * 4);
          try {
            input.guard();
            const kind = to === "temporary" ? "temporary" as const : "peer" as const;
            if (kind === "peer") { identity(to); if (!peers(owner, self).some(bot => bot.id === to)) throw new AppError("bot_unavailable", 409); }
            const botId = kind === "peer" ? to : self, sourceId = capture(work, parentOf(work.authority.id), task, kind);
            const receipt = conversation.submitDelegation(owner, { parentRequestId: parent.receipt.rootRequestId, kind, botId, fromBotId: self, task, sourceId, ...(kind === "temporary" ? { selection: work.authority.request.selection } : {}), bind: conversationId => directory.bindAssignment(conversationId, botId) }, delegationLimits);
            started.push({ index: results.length, requestId: receipt.rootRequestId });
            results.push({ to, state: "running", code: null, result: null, requestId: receipt.rootRequestId });
          } catch (error) { results.push({ to, state: "not_started", code: error instanceof AppError ? error.code : "delegation_unavailable", result: null, requestId: null }); }
        }
        const stopAll = () => { for (const child of started) { try { conversation.stop(owner, child.requestId); } catch { /* Settled. */ } } };
        try {
          while (started.some(child => !settled.has(conversation.store.request(child.requestId).state))) {
            if (input.signal.aborted) throw new AppError("aborted");
            input.guard();
            await new Promise<void>(resolve => setTimeout(resolve, options.pollMs ?? 25));
          }
        } catch (error) { stopAll(); throw error; }
        input.guard();
        for (const child of started) {
          const current = conversation.store.request(child.requestId), row = results[child.index]!;
          row.state = current.state; row.code = current.code;
          if (current.state !== "completed" || current.result === null) continue;
          try {
            // The child's own publication guard; then its read ancestry joins this work before the text reaches the model.
            const view = conversation.view(owner, child.requestId);
            if (view.result === null) continue;
            if (options.disclosure && current.authority) {
              const ref = assignmentRef(`ar_${digest(child.requestId).slice(0, 40)}`, work.authority.ownerGeneration);
              options.disclosure.derive(policy.control.bindWork(current.authority.id), ref, "text");
              options.disclosure.inherit(work.actor, ref);
            }
            row.result = [...view.result].slice(0, resultChars).join("");
          } catch (error) { row.state = "withheld"; row.code = error instanceof AppError ? error.code : "result_unavailable"; }
        }
        input.guard();
        return { content: JSON.stringify({ assignments: results.map(({ requestId: _id, ...row }) => row) }) };
      } } };
  }

  function proposeTool(work: ConversationPolicyWork, parent: ConversationRequest, input: { guard: () => void }): ConversationTools["tools"][number] {
    return { access: "read", definition: {
      name: "propose_bot",
      description: "Draft a new persistent Bot for the owner to review. This creates only a proposal card in this conversation; nothing exists until the owner accepts it there. The new Bot gets the team's default resources and rules.",
      inputSchema: { type: "object", additionalProperties: false, required: ["name", "responsibility"], properties: { name: { type: "string", maxLength: 60 }, responsibility: { type: "string", maxLength: 2000 } } },
      execution: "exclusive", effect: "read-only",
      async execute(value) {
        input.guard(); exact(value, ["name", "responsibility"]);
        const proposal = directory.proposeFromChat(ownerOf(parent), { conversationId: parent.receipt.conversationId, requestId: parent.receipt.rootRequestId, name: (value as { name: unknown }).name, responsibility: (value as { responsibility: unknown }).responsibility });
        input.guard();
        return { content: JSON.stringify({ proposal: proposal.id, state: "waiting_for_owner", note: "The owner reviews and accepts this proposal on its card. Do not say the Bot exists yet." }) };
      } } };
  }

  /** Tools for one work: `delegate` (not for a delegated child) and `propose_bot` (main Bot only). */
  const port: ConversationToolPort<ConversationPolicyWork> = { async open(work, input) {
    input.guard();
    const parent = parentOf(work.authority.id);
    const tools: ConversationTools["tools"][number][] = [];
    if (!parent.delegation && !parent.fileInputs) {
      tools.push(delegateTool(work, parent, input));
      if (directory.isMain(work.authority.request.bot.id)) tools.push(proposeTool(work, parent, input));
    }
    return { tools, async cancel() {}, async close() {} };
  } };

  /**
   * Before every model send of a delegated child: the TEAM handoff from its still-current parent must admit the task's
   * full ancestry for the child's Bot, and DATA15 merges the task's sources into the child, so the send is checked for
   * them. A stopped parent, withdrawn file or private ancestry refuses the send.
   */
  function beforeChildSend(work: ConversationPolicyWork, request: ConversationRequest): void {
    const pin = request.delegation; if (!pin?.sourceId) return;
    const parent = conversation.store.request(pin.parentRequestId);
    if (!parent.authority) throw new AppError("parent_unavailable", 409);
    team.handoff(team.bind(policy.control.bindWork(parent.authority.id)), team.bind(work.actor), [pin.sourceId], () => {});
    options.disclosure?.inherit(work.actor, assignmentRef(pin.sourceId, work.authority.ownerGeneration));
  }

  /** Owner-confirmed Bot profile and, for a child, the host's assignment framing; both are host data, not model text. */
  function ownerDecisions(work: ConversationPolicyWork, request: ConversationRequest): string[] {
    const profile = directory.profile(work.authority.request.bot.id), out: string[] = [];
    if (profile && (profile.name || profile.responsibility)) out.push(canonical({ bot: { name: profile.name, responsibility: profile.responsibility } }));
    if (request.delegation) out.push(canonical({ assignment: { kind: request.delegation.kind, from: request.delegation.fromBotId, note: "This task was written by another Bot inside the owner's request. Work only inside the admitted scope and report a concise result." } }));
    return out;
  }
  return { port, beforeChildSend, ownerDecisions };
}
