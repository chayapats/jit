import { AppError } from "../../errors";
import { ProtectedDataStore } from "../../s15/team/store";
import { canonical, content, digest, exact, identity, integer } from "../../s15/conversation/validation";
import type { PolicyInput, Ref, Rule, S15PolicyService, Selection, StandingPolicy, WorkAuthority } from "../../s15/policy";
import { botLimits, type BotCommand, type BotDetail, type BotDraft, type BotExport, type BotImpact, type BotProposal, type BotReceipt, type BotRecord, type BotResourceChoice, type BotSelectionChoice, type BotSource, type BotView, type BotsView } from "./types";

/** BOTS schema v1: profiles, proposals, immutable conversation bindings and command identities. */
const BOTS_SCHEMA_V1 = `
CREATE TABLE bots (id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
CREATE TABLE proposals (id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
CREATE TABLE bindings (conversation_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL);
CREATE TABLE commands (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE TRIGGER immutable_binding_update BEFORE UPDATE ON bindings BEGIN SELECT RAISE(ABORT,'binding_immutable'); END;
CREATE TRIGGER immutable_binding_delete BEFORE DELETE ON bindings BEGIN SELECT RAISE(ABORT,'binding_immutable'); END;
`;
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
/** Rules that carry the team defaults to another Bot. Personal GitHub rules and recurring payments were approved for named Bots. */
const teamRule = (rule: Rule) => !["personal_github_publish", "personal_github_merge", "recurring_payment"].includes(rule.mode);
const uid = () => crypto.randomUUID().replaceAll("-", "");

/** Protected composition. Every port is trusted host code; none is reachable from a model. */
export interface BotDirectoryOptions<Owner> {
  path: string; installationId: string; create: boolean; now: () => number;
  /** The installation's main Bot and default route; the main Bot is never archived. */
  main: { bot: Ref; selection: Selection };
  policy: S15PolicyService;
  /** The configured catalog for Bots this directory does not own. */
  configured(id: string): { ref: Ref; active: boolean } | null;
  /** Approved routes the owner can choose, already intersected with the current standing policy. */
  selections(owner: Owner): BotSelectionChoice[];
  /** Team resources a new Bot uses by default, with owner-facing labels. */
  resources(owner: Owner): BotResourceChoice[];
  /** Export/import names of approved routes; never credentials or accounts. */
  routes(): { selection: Selection; provider: string; modelId: string }[];
  conversations: {
    /** True once the conversation has any request; a started conversation keeps its Bot. */
    started(conversationId: string): boolean;
    /** Unfinished requests in the given conversations, plus delegated children assigned to the Bot. */
    unfinished(owner: Owner, botId: string, conversationIds: readonly string[]): { requestId: string; conversationId: string }[];
    /** Recent conversations (newest first) among the given IDs, for the Bot page. */
    recent(owner: Owner, conversationIds: readonly string[]): { conversationId: string; firstMessage: string; latestAt: number; assignment: boolean }[];
    stop(owner: Owner, requestId: string): void;
  };
  routines?: { active(owner: Owner, conversationIds: readonly string[]): { id: string; name: string; revision: number }[]; pause(owner: Owner, routineId: string, revision: number): void };
}

/**
 * BOT16-01 protected Bot directory (`s16-bots/v1`, ADR 0088). It owns created Bots' catalog identities, the owner's
 * profile text, exact proposals and the immutable conversation-to-Bot binding. A Bot joins the standing policy only
 * through the owner's acceptance of one exact proposal, which installs a revision naming it in every rule that names
 * the main Bot (the team defaults). Archive makes its catalog identity inactive, so POLICY refuses all of its work at
 * the next guard, and stops (revokes) its unfinished work; restore reactivates the same identity, so history and
 * sourced memory return while nothing revoked can resume.
 */
export class BotDirectory<Owner> {
  readonly store: ProtectedDataStore;
  constructor(readonly options: BotDirectoryOptions<Owner>) {
    this.store = new ProtectedDataStore(options.path, options.installationId, options.create, 0x4a494236, BOTS_SCHEMA_V1);
  }
  close(): void { this.store.close(); }

  #records(): BotRecord[] { return this.store.db.query<{ record_json: string }, []>("SELECT record_json FROM bots ORDER BY rowid").all().map(row => JSON.parse(row.record_json) as BotRecord); }
  #record(id: string): BotRecord | null { const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM bots WHERE id=?").get(id); return row ? JSON.parse(row.record_json) as BotRecord : null; }
  #save(record: BotRecord): void { this.store.db.query("INSERT INTO bots VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json").run(record.id, canonical(record)); }
  #proposal(id: string): BotProposal | null { const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM proposals WHERE id=?").get(id); return row ? JSON.parse(row.record_json) as BotProposal : null; }
  #saveProposal(value: BotProposal): void { this.store.db.query("INSERT INTO proposals VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json").run(value.id, canonical(value)); }
  #policy(owner: Owner): StandingPolicy | null { return this.options.policy.owner.current(owner as never); }
  #owner(owner: Owner): void { this.options.policy.owner.current(owner as never); }

  /** POLICY catalog for Bots this directory owns (created, or a configured Bot it archived/restored). Others fall through. */
  catalog(id: string): { ref: Ref; active: boolean } | null {
    const record = this.#record(id);
    return record?.ref ? { ref: structuredClone(record.ref), active: record.state === "active" } : null;
  }
  /** Catalog identities of created Bots in creation order, for the default standing-policy proposal. */
  createdRefs(): Ref[] { return this.#records().filter(record => record.origin === "created" && record.ref).map(record => structuredClone(record.ref!)); }
  isMain(botId: string): boolean { return botId === this.options.main.bot.id; }
  /** Current profile of a Bot: stored record, or the default of the main/configured Bot. */
  profile(botId: string): BotRecord | null {
    identity(botId);
    const stored = this.#record(botId); if (stored) return stored;
    if (this.isMain(botId)) return this.#default(this.options.main.bot, "main");
    const configured = this.options.configured(botId);
    return configured ? this.#default(configured.ref, "configured") : null;
  }
  #default(ref: Ref, origin: "main" | "configured"): BotRecord {
    return { contract: "s16-bot/v1", id: ref.id, revision: 0, origin, ref: null, name: origin === "main" ? "" : ref.id, responsibility: "", selection: null, excluded: [], assignments: true, state: "active", source: { kind: "owner" }, createdAt: 0, updatedAt: 0, archivedAt: null };
  }
  /** The Bot a conversation talks to: its immutable binding, or the main Bot. */
  conversationBot(conversationId: string): string {
    identity(conversationId);
    return this.store.db.query<{ bot_id: string }, [string]>("SELECT bot_id FROM bindings WHERE conversation_id=?").get(conversationId)?.bot_id ?? this.options.main.bot.id;
  }
  /** Conversations bound to a Bot (the main Bot's unbound conversations are not listed here). */
  boundConversations(botId: string): string[] { return this.store.db.query<{ conversation_id: string }, [string]>("SELECT conversation_id FROM bindings WHERE bot_id=? ORDER BY rowid DESC LIMIT 512").all(botId).map(row => row.conversation_id); }
  /**
   * Admission resolution for a conversation's Bot: its current catalog reference, the route new work uses and its
   * excluded resources. An archived Bot refuses (`bot_archived`) before anything is accepted.
   */
  resolve(conversationId: string, policySelections?: readonly Selection[]): { bot: Ref; selection: Selection; excluded: string[]; record: BotRecord } {
    const botId = this.conversationBot(conversationId), record = this.profile(botId);
    if (!record) throw new AppError("bot_unavailable", 409);
    if (record.state !== "active") throw new AppError("bot_archived", 409);
    const ref = this.isMain(botId) ? this.options.main.bot : record.ref ?? this.options.configured(botId)?.ref;
    if (!ref) throw new AppError("bot_unavailable", 409);
    const selection = record.selection && (!policySelections || policySelections.some(s => same(s, record.selection))) ? record.selection : this.options.main.selection;
    return { bot: structuredClone(ref), selection: structuredClone(selection), excluded: [...record.excluded], record };
  }
  /** Ingress fence: a conversation of an archived Bot accepts no new message, routine run or assignment. */
  admitConversation(conversationId: string): void { this.resolve(conversationId); }
  /** Catalog `allows` intersection: a Bot never uses a team resource the owner excluded for it. */
  allows(work: WorkAuthority, resources: readonly Ref[]): boolean {
    const record = this.#record(work.request.bot.id);
    return !record || !resources.some(resource => record.excluded.includes(resource.id));
  }

  #bots(owner: Owner): BotRecord[] {
    const policy = this.#policy(owner), stored = new Map(this.#records().map(record => [record.id, record] as const));
    const ids = [this.options.main.bot.id, ...(policy?.bots ?? []).map(bot => bot.id), ...stored.keys()].filter((id, index, all) => all.indexOf(id) === index);
    return ids.flatMap(id => { const record = this.profile(id); return record ? [record] : []; }).slice(0, botLimits.bots * 2);
  }
  #view(record: BotRecord, selections: readonly BotSelectionChoice[]): BotView {
    const chosen = record.selection ? selections.find(choice => same(choice.selection, record.selection)) ?? null : null;
    return { id: record.id, revision: record.revision, origin: record.origin, main: this.isMain(record.id), name: record.name, responsibility: record.responsibility,
      selection: record.selection ? structuredClone(record.selection) : null, selectionLabel: chosen?.label ?? null, selectionUnavailable: !!record.selection && !chosen,
      excluded: [...record.excluded], assignments: record.assignments, state: record.state, createdAt: record.createdAt, archivedAt: record.archivedAt };
  }
  /** Owner Bots page: profiles, pending proposals and current choices. Reading changes nothing. */
  view(owner: Owner): BotsView {
    this.#owner(owner);
    const selections = this.options.selections(owner), policy = this.#policy(owner);
    const proposals = this.store.db.query<{ record_json: string }, []>("SELECT record_json FROM proposals ORDER BY rowid DESC LIMIT 64").all().map(row => JSON.parse(row.record_json) as BotProposal).filter(p => p.state === "pending").reverse();
    return { contract: "s16-client-bots/v1", bots: this.#bots(owner).map(record => this.#view(record, selections)), proposals, selections, resources: this.options.resources(owner),
      creation: !policy ? { available: false, code: "policy_required" } : this.#records().filter(r => r.origin === "created").length >= botLimits.bots ? { available: false, code: "bot_capacity" } : { available: true } };
  }
  /** One Bot with its recent conversations and what archiving would stop and pause. */
  detail(owner: Owner, botId: string): BotDetail {
    this.#owner(owner); const record = this.profile(botId);
    if (!record || !this.#bots(owner).some(r => r.id === botId)) throw new AppError("not_found", 404);
    return { contract: "s16-client-bot/v1", bot: this.#view(record, this.options.selections(owner)), conversations: this.options.conversations.recent(owner, this.boundConversations(botId)).slice(0, 32), impact: this.impact(owner, botId) };
  }
  impact(owner: Owner, botId: string): BotImpact {
    const conversations = this.boundConversations(botId);
    return { running: this.options.conversations.unfinished(owner, botId, conversations), routines: (this.options.routines?.active(owner, conversations) ?? []).map(({ id, name }) => ({ id, name })) };
  }

  #draft(owner: Owner, value: unknown): BotDraft {
    canonical(value); exact(value, ["contract", "name", "responsibility", "selection", "excluded", "assignments"]);
    if (value.contract !== "s16-bot-draft/v1" || typeof value.assignments !== "boolean") throw new AppError("invalid_bot");
    const name = this.#name(value.name), responsibility = this.#responsibility(value.responsibility);
    if (!Array.isArray(value.excluded) || value.excluded.length > botLimits.excluded || new Set(value.excluded).size !== value.excluded.length) throw new AppError("invalid_bot");
    value.excluded.forEach(identity);
    const resources = this.options.resources(owner);
    if ((value.excluded as string[]).some(id => !resources.some(r => r.id === id))) throw new AppError("outside_scope", 409);
    if (value.selection !== null && !this.options.selections(owner).some(choice => same(choice.selection, value.selection))) throw new AppError("selection_unavailable", 409);
    return { contract: "s16-bot-draft/v1", name, responsibility, selection: value.selection === null ? null : structuredClone(value.selection as Selection), excluded: [...(value.excluded as string[])].sort(), assignments: value.assignments };
  }
  #name(value: unknown): string {
    if (typeof value !== "string" || !value.trim() || [...value].length > botLimits.nameChars || /[\n\r\t]/.test(value)) throw new AppError("invalid_bot_name");
    content(value, botLimits.nameChars * 4); return value.trim();
  }
  #responsibility(value: unknown): string {
    if (typeof value !== "string" || [...value].length > botLimits.responsibilityChars) throw new AppError("invalid_bot_responsibility");
    if (value.trim()) content(value, botLimits.responsibilityChars * 4); return value.trim();
  }
  #propose(owner: Owner | null, draft: BotDraft, source: BotSource, missing: string[], resources: BotResourceChoice[], policyRevision: number): BotProposal {
    const value = { draft, source, policyRevision, resources, missing };
    const proposalHash = digest(`s16.bot.proposal.v1\n${canonical(value)}`);
    return this.store.transaction(() => {
      if (owner) this.#owner(owner);
      const prior = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM proposals WHERE json_extract(record_json,'$.proposalHash')=? AND json_extract(record_json,'$.state')='pending'").get(proposalHash);
      if (prior) return JSON.parse(prior.record_json) as BotProposal;
      const pending = this.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM proposals WHERE json_extract(record_json,'$.state')='pending'").get()!.n;
      if (pending >= botLimits.proposals) throw new AppError("bot_proposal_capacity", 409);
      this.store.capacity();
      const proposal: BotProposal = { contract: "s16-bot-proposal/v1", id: `bp_${uid()}`, ...structuredClone(value), proposalHash, state: "pending", createdAt: this.options.now(), botId: null };
      this.#saveProposal(proposal); return proposal;
    });
  }
  /** Owner form or edited card: a new exact proposal. Nothing is created until the owner accepts this hash. */
  propose(owner: Owner, raw: unknown, source: BotSource = { kind: "owner" }): BotProposal {
    const policy = this.#policy(owner); if (!policy) throw new AppError("policy_required", 409);
    return this.#propose(owner, this.#draft(owner, raw), source, [], this.options.resources(owner), policy.revision);
  }
  /**
   * The main Bot's chat proposal (`propose_bot` tool). It is inert data shown as a card in the conversation; model
   * text only fills the name and responsibility, and the owner still reviews and accepts the exact proposal.
   */
  proposeFromChat(owner: Owner, input: { conversationId: string; requestId: string; name: unknown; responsibility: unknown }): BotProposal {
    identity(input.conversationId); identity(input.requestId);
    const policy = this.#policy(owner); if (!policy) throw new AppError("policy_required", 409);
    const draft: BotDraft = { contract: "s16-bot-draft/v1", name: this.#name(input.name), responsibility: this.#responsibility(input.responsibility), selection: null, excluded: [], assignments: true };
    return this.#propose(owner, draft, { kind: "chat", conversationId: input.conversationId, requestId: input.requestId }, [], this.options.resources(owner), policy.revision);
  }
  /** Duplicate copies configuration only: never history, memory, files, computer or account data. */
  duplicate(owner: Owner, botId: string, name: unknown): BotProposal {
    const record = this.profile(botId); if (!record) throw new AppError("not_found", 404);
    const policy = this.#policy(owner); if (!policy) throw new AppError("policy_required", 409);
    const resources = this.options.resources(owner), selections = this.options.selections(owner);
    const missing = [...record.excluded.filter(id => !resources.some(r => r.id === id)), ...(record.selection && !selections.some(s => same(s.selection, record.selection)) ? ["model"] : [])];
    const draft: BotDraft = { contract: "s16-bot-draft/v1", name: this.#name(name), responsibility: record.responsibility, selection: record.selection && selections.some(s => same(s.selection, record.selection)) ? structuredClone(record.selection) : null,
      excluded: record.excluded.filter(id => resources.some(r => r.id === id)), assignments: record.assignments };
    return this.#propose(owner, draft, { kind: "duplicate", botId }, missing, resources, policy.revision);
  }
  /** Credential-free configuration export. */
  exportBot(owner: Owner, botId: string): BotExport {
    this.#owner(owner); const record = this.profile(botId); if (!record) throw new AppError("not_found", 404);
    const route = record.selection ? this.options.routes().find(r => same(r.selection, record.selection)) : undefined, labels = new Map(this.options.resources(owner).map(r => [r.id, r.label] as const));
    return { contract: "s16-bot-export/v1", name: record.name, responsibility: record.responsibility, model: route ? { provider: route.provider, modelId: route.modelId, effort: route.selection.effort } : null,
      excluded: record.excluded.map(id => ({ id, label: labels.get(id) ?? id })), assignments: record.assignments, exportedAt: this.options.now() };
  }
  /** Import validates a bounded export and turns it into a new proposal; unknown references are listed, never guessed. */
  importBot(owner: Owner, raw: unknown): BotProposal {
    if (Buffer.byteLength(canonical(raw)) > botLimits.exportBytes) throw new AppError("body_too_large", 413);
    exact(raw, ["contract", "name", "responsibility", "model", "excluded", "assignments", "exportedAt"]);
    if (raw.contract !== "s16-bot-export/v1" || typeof raw.assignments !== "boolean" || !Array.isArray(raw.excluded) || raw.excluded.length > botLimits.excluded) throw new AppError("invalid_bot_export");
    integer(raw.exportedAt, 0, Number.MAX_SAFE_INTEGER);
    const policy = this.#policy(owner); if (!policy) throw new AppError("policy_required", 409);
    const resources = this.options.resources(owner), selections = this.options.selections(owner), missing: string[] = [], excluded: string[] = [];
    for (const item of raw.excluded) {
      exact(item, ["id", "label"]); identity(item.id); content(item.label, 1024);
      if (resources.some(r => r.id === item.id)) excluded.push(item.id as string); else missing.push(item.label as string);
    }
    let selection: Selection | null = null;
    if (raw.model !== null) {
      exact(raw.model, ["provider", "modelId", "effort"]); content(raw.model.provider, 256); content(raw.model.modelId, 256); identity(raw.model.effort);
      const model = raw.model as { provider: string; modelId: string; effort: string };
      const route = this.options.routes().find(r => r.provider === model.provider && r.modelId === model.modelId && r.selection.effort === model.effort && selections.some(s => same(s.selection, r.selection)));
      if (route) selection = structuredClone(route.selection); else missing.push(`${model.provider} · ${model.modelId}`);
    }
    const draft: BotDraft = { contract: "s16-bot-draft/v1", name: this.#name(raw.name), responsibility: this.#responsibility(raw.responsibility), selection, excluded: [...new Set(excluded)].sort(), assignments: raw.assignments };
    return this.#propose(owner, draft, { kind: "import" }, missing, resources, policy.revision);
  }

  /** Exact owner commands. Each runs once per request ID; a changed payload under the same ID refuses. */
  command(owner: Owner, raw: unknown): BotReceipt {
    canonical(raw);
    if (!raw || typeof raw !== "object" || (raw as { contract?: unknown }).contract !== "s16-bot-command/v1") throw new AppError("invalid_bot_command");
    const kind = (raw as { kind?: unknown }).kind, shapes: Record<string, string[]> = { "bot.accept": ["proposalId", "proposalHash"], "bot.dismiss": ["proposalId"], "bot.update": ["botId", "expectedRevision", "name", "responsibility", "selection", "assignments"], "bot.archive": ["botId", "expectedRevision"], "bot.restore": ["botId", "expectedRevision"], "conversation.bind": ["conversationId", "botId"] };
    if (typeof kind !== "string" || !shapes[kind]) throw new AppError("invalid_bot_command");
    exact(raw, ["contract", "requestId", "kind", ...shapes[kind]!]);
    const command = raw as BotCommand; identity(command.requestId);
    const hash = digest(`s16.bot.command.v1\n${canonical(command)}`);
    const prior = this.store.db.query<{ payload_hash: string; result_json: string }, [string]>("SELECT payload_hash,result_json FROM commands WHERE id=?").get(command.requestId);
    if (prior) { this.#owner(owner); if (prior.payload_hash !== hash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as BotReceipt; }
    const receipt = this.#execute(owner, command);
    this.store.transaction(() => { if (!this.store.db.query("SELECT 1 FROM commands WHERE id=?").get(command.requestId)) this.store.db.query("INSERT INTO commands VALUES (?,?,?)").run(command.requestId, hash, canonical(receipt)); });
    return receipt;
  }
  #receipt(command: BotCommand, bot: BotRecord | null, proposal: BotProposal | null, owner: Owner, stopped = 0, paused = 0): BotReceipt {
    return { contract: "s16-bot-receipt/v1", requestId: command.requestId, kind: command.kind, bot: bot ? this.#view(bot, this.options.selections(owner)) : null, proposal, stopped, paused };
  }
  #execute(owner: Owner, command: BotCommand): BotReceipt {
    this.#owner(owner);
    switch (command.kind) {
      case "bot.accept": return this.#accept(owner, command);
      case "bot.dismiss": {
        identity(command.proposalId);
        const proposal = this.store.transaction(() => { const value = this.#proposal(command.proposalId); if (!value) throw new AppError("not_found", 404); if (value.state !== "pending") throw new AppError("stale_proposal", 409); value.state = "dismissed"; this.#saveProposal(value); return value; });
        return this.#receipt(command, null, proposal, owner);
      }
      case "bot.update": {
        identity(command.botId); integer(command.expectedRevision, 0);
        if (typeof command.assignments !== "boolean") throw new AppError("invalid_bot");
        const name = this.#name(command.name), responsibility = this.#responsibility(command.responsibility);
        if (command.selection !== null && !this.options.selections(owner).some(choice => same(choice.selection, command.selection))) throw new AppError("selection_unavailable", 409);
        const record = this.store.transaction(() => {
          const current = this.profile(command.botId);
          if (!current || !this.#bots(owner).some(r => r.id === command.botId)) throw new AppError("not_found", 404);
          if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
          if (current.state !== "active") throw new AppError("bot_archived", 409);
          const next: BotRecord = { ...current, revision: current.revision + 1, name, responsibility, selection: command.selection ? structuredClone(command.selection) : null, assignments: command.assignments, updatedAt: this.options.now(), ...(current.revision === 0 ? { createdAt: this.options.now() } : {}) };
          this.#save(next); return next;
        });
        return this.#receipt(command, record, null, owner);
      }
      case "bot.archive": return this.#archive(owner, command);
      case "bot.restore": return this.#restore(owner, command);
      case "conversation.bind": {
        identity(command.conversationId); identity(command.botId);
        const record = this.profile(command.botId);
        if (!record || !this.#bots(owner).some(r => r.id === command.botId)) throw new AppError("not_found", 404);
        if (record.state !== "active") throw new AppError("bot_archived", 409);
        this.store.transaction(() => {
          const bound = this.store.db.query<{ bot_id: string }, [string]>("SELECT bot_id FROM bindings WHERE conversation_id=?").get(command.conversationId);
          if (bound) { if (bound.bot_id !== command.botId) throw new AppError("conversation_bot_fixed", 409); return; }
          // A conversation keeps the Bot it started with: an unbound started conversation belongs to the main Bot.
          if (this.options.conversations.started(command.conversationId)) { if (!this.isMain(command.botId)) throw new AppError("conversation_bot_fixed", 409); return; }
          if (this.isMain(command.botId)) return;
          this.store.capacity(); this.store.db.query("INSERT INTO bindings VALUES (?,?)").run(command.conversationId, command.botId);
        });
        return this.#receipt(command, record, null, owner);
      }
    }
  }
  /** Bind a delegated child conversation to the Bot that runs it (protected host path, not an owner command). */
  bindAssignment(conversationId: string, botId: string): void {
    identity(conversationId); identity(botId);
    this.store.transaction(() => {
      const bound = this.store.db.query<{ bot_id: string }, [string]>("SELECT bot_id FROM bindings WHERE conversation_id=?").get(conversationId);
      if (bound) { if (bound.bot_id !== botId) throw new AppError("conversation_bot_fixed", 409); return; }
      if (this.isMain(botId)) return;
      this.store.capacity(); this.store.db.query("INSERT INTO bindings VALUES (?,?)").run(conversationId, botId);
    });
  }
  /** Install the owner's next standing-policy revision with `transform`; nothing else in the policy changes. */
  #install(owner: Owner, requestId: string, transform: (policy: PolicyInput) => PolicyInput): void {
    const current = this.#policy(owner); if (!current) throw new AppError("policy_required", 409);
    const { contract: _contract, revision, ownerGeneration: _generation, ...input } = structuredClone(current);
    this.options.policy.owner.install(owner as never, `bot_${digest(requestId).slice(0, 40)}`, revision, transform(input));
  }
  #accept(owner: Owner, command: Extract<BotCommand, { kind: "bot.accept" }>): BotReceipt {
    identity(command.proposalId); if (typeof command.proposalHash !== "string" || !/^[a-f0-9]{64}$/.test(command.proposalHash)) throw new AppError("invalid_bot_command");
    const proposal = this.#proposal(command.proposalId);
    if (!proposal) throw new AppError("not_found", 404);
    if (proposal.state !== "pending" || proposal.proposalHash !== command.proposalHash) throw new AppError("stale_proposal", 409);
    const policy = this.#policy(owner); if (!policy) throw new AppError("policy_required", 409);
    const id = `bot_${digest(command.requestId).slice(0, 24)}`, ref: Ref = { id, revision: 1, generation: 1 };
    if (this.#record(id) || this.options.configured(id) || this.isMain(id)) throw new AppError("request_id_conflict", 409);
    // This exact command already installed the Bot when the process stopped before recording it.
    const installed = policy.bots.some(b => same(b, ref));
    // The owner reviewed this revision's defaults; a changed policy or resource list needs a fresh proposal.
    if (!installed && (policy.revision !== proposal.policyRevision || !same(this.options.resources(owner), proposal.resources))) throw new AppError("stale_proposal", 409);
    if (proposal.draft.selection && !this.options.selections(owner).some(choice => same(choice.selection, proposal.draft.selection))) throw new AppError("stale_proposal", 409);
    if (this.#records().filter(r => r.origin === "created").length >= botLimits.bots) throw new AppError("bot_capacity", 409);
    const main = this.options.main.bot;
    // Team defaults: the new Bot joins every rule that names the main Bot, so it works under exactly the same rules.
    // Separately approved personal rules and recurring payments stay with the Bots the owner approved them for. A retry
    // after a crash between this install and the record below finds the Bot already installed and only records it.
    if (!installed) this.#install(owner, command.requestId, input => ({ ...input, bots: [...input.bots, ref], rules: input.rules.map(rule => teamRule(rule) && rule.bots.some(b => b.id === main.id) ? { ...rule, bots: [...rule.bots, ref] } : rule) }));
    const now = this.options.now();
    const record: BotRecord = { contract: "s16-bot/v1", id, revision: 1, origin: "created", ref, name: proposal.draft.name, responsibility: proposal.draft.responsibility, selection: proposal.draft.selection, excluded: [...proposal.draft.excluded], assignments: proposal.draft.assignments,
      state: "active", source: structuredClone(proposal.source), createdAt: now, updatedAt: now, archivedAt: null };
    const accepted = this.store.transaction(() => {
      const current = this.#proposal(proposal.id)!; if (current.state !== "pending") throw new AppError("stale_proposal", 409);
      this.store.capacity(); this.#save(record); current.state = "accepted"; current.botId = id; this.#saveProposal(current); return current;
    });
    return this.#receipt(command, record, accepted, owner);
  }
  #archive(owner: Owner, command: Extract<BotCommand, { kind: "bot.archive" | "bot.restore" }>): BotReceipt {
    identity(command.botId); integer(command.expectedRevision, 0);
    if (this.isMain(command.botId)) throw new AppError("bot_main_required", 409);
    const record = this.store.transaction(() => {
      const current = this.profile(command.botId);
      if (!current || !this.#bots(owner).some(r => r.id === command.botId)) throw new AppError("not_found", 404);
      if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      if (current.state !== "active") throw new AppError("bot_archived", 409);
      const ref = current.ref ?? this.options.configured(current.id)?.ref ?? null;
      if (!ref) throw new AppError("bot_unavailable", 409);
      // The catalog identity turns inactive here, before any stop below: POLICY refuses this Bot's work at its next guard.
      const next: BotRecord = { ...current, revision: current.revision + 1, ref: structuredClone(ref), state: "archived", updatedAt: this.options.now(), archivedAt: this.options.now() };
      this.#save(next); return next;
    });
    let stopped = 0, paused = 0;
    const conversations = this.boundConversations(record.id);
    for (const item of this.options.conversations.unfinished(owner, record.id, conversations)) { try { this.options.conversations.stop(owner, item.requestId); stopped++; } catch { /* Already settled or fenced by POLICY. */ } }
    for (const routine of this.options.routines?.active(owner, conversations) ?? []) { try { this.options.routines!.pause(owner, routine.id, routine.revision); paused++; } catch { /* Its ingress refuses an archived Bot anyway. */ } }
    return this.#receipt(command, record, null, owner, stopped, paused);
  }
  #restore(owner: Owner, command: Extract<BotCommand, { kind: "bot.archive" | "bot.restore" }>): BotReceipt {
    identity(command.botId); integer(command.expectedRevision, 0);
    // The same identity returns, so the Bot's history and sourced memory are readable again. Nothing it had unfinished
    // resumes: archive revoked those works, and a settled or reconcile-only request never runs again by itself.
    const record = this.store.transaction(() => {
      const current = this.#record(command.botId);
      if (!current) throw new AppError("not_found", 404);
      if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      if (current.state !== "archived" || !current.ref) throw new AppError("bot_not_archived", 409);
      const next: BotRecord = { ...current, revision: current.revision + 1, state: "active", updatedAt: this.options.now(), archivedAt: null };
      this.#save(next); return next;
    });
    return this.#receipt(command, record, null, owner);
  }

}
