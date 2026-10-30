import { S14BotLifecycle } from "./bot-lifecycle";
import { S14Backups } from "./backups";
import type { OpsNativePort } from "./ops-types";
import type { BotLifecycleCommand, BotLifecycleOptions, BotLifecycleReceipt } from "./bot-lifecycle-types";
import { S14Attention } from "./attention";
import { S14Routines } from "./routines";
import type { AttentionCommand, AttentionPort, AttentionReceipt, RoutineCommand, RoutineReceipt } from "./routine-types";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "../errors";
import { requireOwnerSetup, removeOwnerSetupLink } from "../ops/owner-setup";
import { applyOwnerCommand } from "./owner-commands";
import { S14SignIns } from "./sign-in";
import { ReplyUnavailable, type ReplyUnavailableReason } from "./reply-failure";
import type { SignInOptions } from "../device-sign-in";
import type { AppTransaction } from "../store";
import { registerSecretFingerprint } from "../security/secret-fingerprints";
import type { S14Store } from "./store";
import type { Bot, BotCommand, BotProposal, BotReceipt, ChatInput, ChatPort, Conversation, Home, Message, OwnerActor, Policy, Reply } from "./types";
import { canonical, canonicalByteLimit, capabilities, digest, exact, identity, integer, text } from "./validation";
import { ParallelWeb, type ParallelWebOptions } from "./parallel";
import type { ParallelCommand, ParallelReceipt } from "./parallel-types";
import { S14Memory } from "./memory";
import type { MemoryCommand, MemoryReceipt } from "./memory-types";
import { S14Authority, suggestTask } from "./authority";
import type { AuthorityCommand, AuthorityOptions, AuthorityReceipt } from "./authority-types";
import type { ReportCommand, ReportReceipt } from "./report-types";
import { S14Reports } from "./reports";
import { S14Recovery } from "./recovery";
import type { RecoveryCommand, RecoveryReceipt } from "./recovery-types";
import { S14Sharing } from "./sharing";
import type { SharingCommand, SharingReceipt } from "./sharing-types";
import { S14Artifacts } from "./artifacts";
import { S14Graph } from "./graph";
import type { GraphCommand, GraphReceipt } from "./graph-types";
import { S14Computers } from "./computer";
import type { ComputerCommand, ComputerOptions, ComputerReceipt } from "./computer-types";

/** Stable complete typed owner ingress union for the S14 logic foundation. */
export type S14Command = BotCommand | AuthorityCommand | MemoryCommand | ParallelCommand | ComputerCommand | GraphCommand | ReportCommand | SharingCommand | RecoveryCommand | RoutineCommand | AttentionCommand | BotLifecycleCommand;
/** Committed typed result of the S14 owner command boundary. */
export type S14Receipt = BotReceipt | AuthorityReceipt | MemoryReceipt | ParallelReceipt | ComputerReceipt | GraphReceipt | ReportReceipt | SharingReceipt | RecoveryReceipt | RoutineReceipt | AttentionReceipt | BotLifecycleReceipt;

const id = () => crypto.randomUUID().replaceAll("-", "");
const tokenPattern = /^[a-f0-9]{64}$/;
/** Service-owned JSON tables; request/model input never selects a SQL identifier. */
export type RecordTable = "bots" | "bot_proposals" | "reply_outbox" | "work_items" | "work_grants" | "work_attempts" | "effects" | "memory_sources" | "memory_claims" | "memory_access" | "memory_shares" | "memory_contexts" | "memory_decisions" | "parallel_settings" | "parallel_connections" | "web_reads" | "external_evidence" | "work_graphs" | "work_steps" | "work_defaults";
/** Loads an opaque record from a trusted table name; callers enforce command and scope first. */
export function record<T>(tx: AppTransaction, table: RecordTable, key: string): T {
  const row = tx.get<{ record_json: string }>(`SELECT record_json FROM ${table} WHERE id=?`, key);
  if (!row) throw new AppError("not_found", 404);
  return JSON.parse(row.record_json) as T;
}
/** Updates a trusted table's immutable-identity record inside its caller's transaction. */
export function save(tx: AppTransaction, table: RecordTable, value: { id: string }): void { tx.run(`UPDATE ${table} SET record_json=? WHERE id=?`, canonical(value), value.id); }
/** Reads bounded identity records from a trusted table name without starting workers. */
export function records<T>(tx: AppTransaction, table: RecordTable): T[] { return tx.all<{ record_json: string }>(`SELECT record_json FROM ${table} ORDER BY rowid DESC LIMIT 100`).map(row => JSON.parse(row.record_json) as T); }
/** Injectable deterministic inference/clock and rollback fault seams; production never enables fixture inference. */
export interface S14Options { policy: Policy; chat: ChatPort; authority?: AuthorityOptions; parallel?: ParallelWebOptions; computers?: ComputerOptions; botLifecycle?: BotLifecycleOptions; attention?: AttentionPort; now?: () => number; beforeCommit?: () => void; signIn?: SignInOptions; backups?: OpsNativePort;
  /** Production composition holds every worker before the first complete REC14 boot, including native close. */
  requireBootReconciliation?: boolean;
}

/** Project-free owner command boundary; registered actors are revalidated on every read and commit. */
export class S14Application {
  readonly policy: Policy;
  readonly now: () => number;
  readonly authority: S14Authority;
  readonly memory: S14Memory;
  readonly parallel: ParallelWeb;
  readonly computers: S14Computers;
  readonly graph: S14Graph;
  readonly reports: S14Reports;
  readonly artifacts: S14Artifacts;
  readonly sharing: S14Sharing;
  readonly recovery: S14Recovery;
  readonly botLifecycle: S14BotLifecycle;
  readonly routines: S14Routines;
  readonly attention: S14Attention;
  readonly signIns: S14SignIns;
  readonly backups: S14Backups;
  #actors = new WeakMap<OwnerActor, string>();
  #replyBusy = false;
  #replyRunning = new Map<string, AbortController>();
  constructor(readonly store: S14Store, readonly options: S14Options) {
    this.policy = structuredClone(options.policy); this.now = options.now ?? Date.now;
    if (this.policy.routes.length > 16 || new Set(this.policy.routes.map(r => r.id)).size !== this.policy.routes.length) throw new AppError("invalid_policy");
    for (const r of this.policy.routes) {
      exact(r, ["id", "provider", "model"]); identity(r.id);
      if (!["codex", "grok"].includes(r.provider) || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(r.model)) throw new AppError("invalid_route");
    }
    capabilities({ tools: this.policy.tools, resources: this.policy.resources }, this.policy);
    this.memory = new S14Memory(this);
    this.sharing = new S14Sharing(this);
    const externalScopes = options.authority?.scopes;
    this.authority = new S14Authority(this, { ...options.authority, scopes: {
      current: (tx, scope) => this.sharing.scope(tx, scope) ?? this.memory.scope(tx, scope) ?? externalScopes?.current(tx, scope) ?? null,
    } });
    this.graph = new S14Graph(this);
    this.parallel = new ParallelWeb(this, options.parallel);
    this.reports = new S14Reports(this);
    this.artifacts = new S14Artifacts(this);
    this.recovery = new S14Recovery(this);
    this.attention = new S14Attention(this, options.attention);
    this.routines = new S14Routines(this);
    this.computers = new S14Computers(this, options.computers);
    this.botLifecycle = new S14BotLifecycle(this, options.botLifecycle);
    this.store.transaction(tx => { this.botLifecycle.reconcile(tx); this.recovery.reconcileReservations(tx); this.recovery.reconcileEffects(tx); this.attention.recover(tx); this.routines.reconcile(tx); });
    this.signIns = new S14SignIns(this, options.signIn);
    this.backups = new S14Backups(this, options.backups);
  }
  /** Trusted local bootstrap creates only the authentication principal, never resets an existing installation. */
  async provisionOwner(password: string, capability?: string): Promise<void> {
    if (typeof password !== "string" || password.length < 12 || password.length > 256) throw new AppError("password_length_12_to_256");
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    this.store.transaction(tx => {
      if (capability !== undefined) requireOwnerSetup(this.store, tx, capability, this.now());
      if (tx.get("SELECT id FROM owner")) throw new AppError("owner_already_configured", 409);
      tx.run("INSERT INTO owner VALUES ('owner',?,1)", hash);
      tx.run("DELETE FROM sessions");
      tx.run("DELETE FROM login_throttle");
    });
    registerSecretFingerprint(password);
  }
  /** Validates the unchanged legacy capability without consuming or authenticating it. */
  checkOwnerSetup(capability: unknown): void {
    this.store.read(tx => requireOwnerSetup(this.store, tx, capability, this.now()));
  }
  /** Creates the first password with a writer-locked capability recheck and durable owner single-use fence. */
  async completeOwnerSetup(capability: string, password: string): Promise<void> {
    this.checkOwnerSetup(capability);
    await this.provisionOwner(password, capability);
    removeOwnerSetupLink(this.store);
  }
  /** Authenticates under a persisted finite login budget and returns a write-only session credential. */
  async login(password: string): Promise<string> {
    const owner = this.store.transaction(tx => {
      const row = tx.get<{ window_start: number; attempts: number }>("SELECT * FROM login_throttle WHERE id=1"), now = this.now();
      const fresh = !row || now >= row.window_start + 900000;
      if (!fresh && row.attempts >= 10) throw new AppError("login_limited_try_later", 429);
      tx.run("INSERT OR REPLACE INTO login_throttle VALUES (1,?,?)", fresh ? now : row.window_start, fresh ? 1 : row.attempts + 1);
      return tx.get<{ password_hash: string; generation: number }>("SELECT password_hash,generation FROM owner WHERE id='owner'");
    });
    if (!owner || typeof password !== "string" || password.length > 256 || !await Bun.password.verify(password, owner.password_hash)) throw new AppError("login_failed", 401);
    const token = randomBytes(32).toString("hex");
    this.store.transaction(tx => {
      if (tx.get<{ generation: number }>("SELECT generation FROM owner")?.generation !== owner.generation) throw new AppError("login_failed", 401);
      tx.run("DELETE FROM sessions WHERE expires_at<=?", this.now());
      tx.run("DELETE FROM sessions WHERE token_hash NOT IN (SELECT token_hash FROM sessions ORDER BY expires_at DESC LIMIT 15)");
      tx.run("INSERT INTO sessions VALUES (?,?,?)", digest(token), owner.generation, this.now() + 86400000);
    });
    registerSecretFingerprint(password); registerSecretFingerprint(token);
    return token;
  }
  /** Issues an opaque owner actor and distinct CSRF proof from a live authenticated session. */
  authenticate(token: string): { actor: OwnerActor; csrf: string } {
    if (!tokenPattern.test(token)) throw new AppError("authentication_required", 401);
    const actor: OwnerActor = Object.freeze({ ownerId: "owner" }); this.#actors.set(actor, digest(token));
    this.store.read(tx => this.requireOwner(tx, actor));
    const csrf = digest(`s14.csrf.v1:${token}`);
    registerSecretFingerprint(token);
    registerSecretFingerprint(csrf);
    return { actor, csrf };
  }
  /** Rejects forged, expired and revoked actors even after a command has waited for the writer lock. */
  requireOwner(tx: AppTransaction, actor: OwnerActor): void {
    const key = this.#actors.get(actor);
    if (!key || !tx.get("SELECT s.token_hash FROM sessions s JOIN owner o ON s.generation=o.generation WHERE s.token_hash=? AND s.expires_at>?", key, this.now())) throw new AppError("authentication_required", 401);
  }
  /** Verifies a session-bound proof in constant time without accepting client-supplied actors. */
  verifyCsrf(expected: string, supplied: unknown): void {
    if (typeof supplied !== "string" || !tokenPattern.test(supplied) || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) throw new AppError("csrf_rejected", 403);
  }
  /** Revokes the session and every actor issued from it. */
  logout(actor: OwnerActor): void { this.store.transaction(tx => { this.requireOwner(tx, actor); tx.run("DELETE FROM sessions WHERE token_hash=?", this.#actors.get(actor)!); }); }
  /** Returns setup/team/chat state with revisions and configured-unverified routes, never credentials. */
  home(actor: OwnerActor): Home { return this.store.read(tx => {
    this.requireOwner(tx, actor);
    const row = tx.get<{ revision: number; profile_json: string | null }>("SELECT * FROM installation")!;
    return { revision: row.revision, owner: row.profile_json ? JSON.parse(row.profile_json) : null, routes: structuredClone(this.policy.routes), bots: records<Bot>(tx, "bots"),
      conversations: tx.all<Conversation>("SELECT id,bot_id AS botId,revision FROM conversations ORDER BY rowid DESC LIMIT 100"), proposals: records<BotProposal>(tx, "bot_proposals"), replies: records<Reply>(tx, "reply_outbox") };
  }); }
  /** Returns one bounded conversation and its typed proposal/reply cards; text has no command semantics. */
  conversation(actor: OwnerActor, conversationId: string): { conversation: Conversation; messages: Message[]; proposals: BotProposal[]; replies: Reply[] } {
    identity(conversationId);
    return this.store.read(tx => {
      this.requireOwner(tx, actor); const conversation = this.readConversation(tx, conversationId);
      return { conversation, messages: tx.all<{ record_json: string }>("SELECT record_json FROM (SELECT sequence,record_json FROM messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 100) ORDER BY sequence", conversationId).map(r => {
        const message = JSON.parse(r.record_json) as Message;
        return this.memory.sourceCurrent(tx, { id: message.id, revision: 1, generation: 1 }) ? message : { ...message, contextState: "withdrawn" as const };
      }),
        proposals: records<BotProposal>(tx, "bot_proposals").filter(p => p.conversationId === conversationId), replies: records<Reply>(tx, "reply_outbox").filter(r => r.conversationId === conversationId) };
    });
  }
  /** Returns the current Bot proposal and retained content revisions for exact owner review. */
  proposal(actor: OwnerActor, proposalId: string): { proposal: BotProposal; history: BotProposal[] } {
    identity(proposalId);
    return this.store.read(tx => { this.requireOwner(tx, actor); return { proposal: record<BotProposal>(tx, "bot_proposals", proposalId), history: tx.all<{ record_json: string }>("SELECT record_json FROM proposal_versions WHERE proposal_id=? ORDER BY revision", proposalId).map(r => JSON.parse(r.record_json)) }; });
  }
  /** Executes a typed owner command exactly once with its audit and queue intent in the same transaction. */
  execute(actor: OwnerActor, command: BotCommand): BotReceipt;
  /** Executes obligation, work-start, stop and exact approval decisions under the same owner receipt boundary. */
  execute(actor: OwnerActor, command: AuthorityCommand): AuthorityReceipt;
  /** Executes revisioned memory publication and lifecycle decisions under authenticated owner authority. */
  execute(actor: OwnerActor, command: MemoryCommand): MemoryReceipt;
  /** Executes explicit optional Parallel mode and write-only key commands under the same owner receipt boundary. */
  execute(actor: OwnerActor, command: ParallelCommand): ParallelReceipt;
  /** Executes exact computer lifecycle and input ownership intents without embedding transient browser input. */
  execute(actor: OwnerActor, command: ComputerCommand): ComputerReceipt;
  /** Executes lane stops and future-work defaults without granting execution authority. */
  execute(actor: OwnerActor, command: GraphCommand): GraphReceipt;
  /** Executes owner-only immutable sharing and revocation through the receipt boundary. */
  execute(actor: OwnerActor, command: SharingCommand): SharingReceipt;
  /** Records an exact owner statement about an unknown effect without retrying it. */
  execute(actor: OwnerActor, command: RecoveryCommand): RecoveryReceipt;
  /** Executes exact captured routine authority and dispatch control through the owner receipt boundary. */
  execute(actor: OwnerActor, command: RoutineCommand): RoutineReceipt;
  /** Executes revisioned future attention filtering without changing history or authority. */
  execute(actor: OwnerActor, command: AttentionCommand): AttentionReceipt;
  /** Executes exact Bot policy proposals and lifecycle previews through the authenticated owner boundary. */
  execute(actor: OwnerActor, command: BotLifecycleCommand): BotLifecycleReceipt;
  /** Accepts an exact report revision separately from coverage, execution and immutable report bytes. */
  execute(actor: OwnerActor, command: ReportCommand): ReportReceipt;
  /** Executes the complete typed HTTP command union without client-controlled actor identities. */
  execute(actor: OwnerActor, command: S14Command): S14Receipt;
  execute(actor: OwnerActor, command: S14Command): S14Receipt {
    let encoded = canonical(command);
    if (command.kind === "web.parallel.key.set") encoded = canonical({ ...command, payload: { ...command.payload, secret: "[write-only]" } });
    exact(command, ["kind", "requestId", "expectedRevision", "payload"]);
    identity(command.requestId); integer(command.expectedRevision);
    const receipt = this.store.transaction(tx => {
      this.requireOwner(tx, actor);
      if (tx.get("SELECT request_id FROM computer_inputs WHERE request_id=?", command.requestId)) throw new AppError("request_id_conflict", 409);
      const previous = tx.get<{ payload_hash: string; result_json: string }>("SELECT payload_hash,result_json FROM command_receipts WHERE owner_id='owner' AND request_id=?", command.requestId);
      if (previous) { if (previous.payload_hash !== digest(encoded)) throw new AppError("request_id_conflict", 409); return JSON.parse(previous.result_json) as S14Receipt; }
      let result: S14Receipt;
      if (["bot.capabilities.propose", "bot.reenable.propose", "bot.capabilities.accept", "bot.retire", "bot.delete"].includes(command.kind)) {
        result = this.botLifecycle.apply(tx, command as BotLifecycleCommand);
        this.botLifecycle.reconcile(tx);
        if (result.bot) result.bot = record<Bot>(tx, "bots", result.bot.id);
      } else if (command.kind.startsWith("routine.")) {
        result = this.routines.apply(tx, command as RoutineCommand);
      } else if (command.kind === "attention.set") {
        result = this.attention.apply(tx, command as AttentionCommand);
      } else if (command.kind === "effect.reconcile") {
        result = this.recovery.apply(tx, command as RecoveryCommand);
      } else if (command.kind.startsWith("snapshot.")) {
        result = this.sharing.apply(tx, command as SharingCommand);
      } else if (["work.step.stop", "work.defaults.set"].includes(command.kind)) {
        result = this.graph.apply(tx, command as GraphCommand);
      } else if (command.kind === "report.review.accept") {
        result = this.reports.apply(tx, command as ReportCommand);
      } else if (command.kind.startsWith("web.parallel.")) {
        result = this.parallel.apply(tx, command as ParallelCommand);
      } else if (command.kind.startsWith("memory.")) {
        result = this.memory.apply(tx, command as MemoryCommand);
        this.memory.reconcile(tx);
        this.sharing.fence(tx);
        this.parallel.reconcile(tx);
      } else if (["computer.open", "computer.stop", "computer.reset", "computer.delete", "takeover.start", "takeover.end", "takeover.renew"].includes(command.kind)) {
        result = this.computers.apply(tx, command as ComputerCommand);
      } else if (["task.accept", "task.reject", "work.start", "work.stop", "work.retry", "work.summarize", "approval.decide"].includes(command.kind)) {
        result = this.authority.apply(tx, command as AuthorityCommand);
      } else {
        result = this.applyBot(tx, command as BotCommand);
      }
      this.reports.reconcile(tx);
      this.routines.reconcile(tx);
      tx.run("INSERT INTO command_receipts VALUES ('owner',?,?,?,?)", command.requestId, digest(encoded), canonical(result), this.now());
      tx.run("INSERT INTO audit(kind,request_id,committed_at) VALUES (?,?,?)", command.kind, command.requestId, this.now());
      this.options.beforeCommit?.(); return structuredClone(result);
    });
    this.authority.cancelFenced();
    this.cancelRepliesFenced();
    this.computers.sweep();
    this.authority.wake();
    return receipt;
  }
  /** Resolves an exact configured route; no provider, account, model or billing fallback exists. */
  route(routeId: unknown) { const route = this.policy.routes.find(r => r.id === routeId); if (!route) throw new AppError("route_unconfigured", 403); return structuredClone(route); }
  /** Resolves one conversation by identity, independent of names and permission scopes. */
  readConversation(tx: AppTransaction, key: string): Conversation {
    const row = tx.get<Conversation>("SELECT id,bot_id AS botId,revision FROM conversations WHERE id=?", key);
    if (!row) throw new AppError("not_found", 404); return row;
  }
  /** Applies Bot commands only inside the shared authenticated receipt transaction. */
  applyBot(tx: AppTransaction, c: BotCommand): BotReceipt {
    if (c.kind === "owner.preferences.set" || c.kind === "conversation.create") return applyOwnerCommand(this, tx, c);
    const result: BotReceipt = { kind: c.kind, requestId: c.requestId };
    if (c.kind === "setup") {
      const p = c.payload;
      exact(p, ["ownerName", "language", "routeId", "capabilities"]);
      const row = tx.get<{ revision: number; profile_json: string | null }>("SELECT * FROM installation")!;
      if (c.expectedRevision !== row.revision || row.profile_json) throw new AppError("stale_revision", 409);
      if (p.language !== "th" && p.language !== "en") throw new AppError("invalid_language");
      this.route(p.routeId); const caps = capabilities(p.capabilities, this.policy);
      const bot: Bot = { id: "jit", revision: 1, generation: 1, enabled: true, name: "Jit", responsibility: "Coordinate and answer within the owner's explicit authority", routeId: p.routeId, capabilities: caps, computerId: null, profileId: null };
      tx.run("INSERT INTO bots VALUES (?,?)", bot.id, canonical(bot));
      const conversation: Conversation = { id: id(), botId: bot.id, revision: 1 };
      tx.run("INSERT INTO conversations VALUES (?,?,?)", conversation.id, bot.id, 1);
      tx.run("UPDATE installation SET revision=revision+1,profile_json=?", canonical({ name: text(p.ownerName, 200), language: p.language, theme: "system" }));
      return { ...result, bot, conversation };
    }
    if (c.kind === "message.post") {
      const p = c.payload;
      exact(p, ["conversationId", "text"]); identity(p.conversationId);
      const conversation = this.readConversation(tx, p.conversationId);
      if (conversation.revision !== c.expectedRevision) throw new AppError("stale_revision", 409);
      const bot = record<Bot>(tx, "bots", conversation.botId); if (!bot.enabled) throw new AppError("bot_disabled", 403);
      const message: Message = { id: id(), conversationId: conversation.id, role: "owner", text: text(p.text), createdAt: this.now() };
      tx.run("INSERT INTO messages(id,conversation_id,record_json) VALUES (?,?,?)", message.id, conversation.id, canonical(message));
      const owner = JSON.parse(tx.get<{ profile_json: string }>("SELECT profile_json FROM installation")!.profile_json) as { name: string; language: "th" | "en" };
      const source = this.memory.source(tx, { id: message.id, botId: bot.id, conversationId: conversation.id, attribution: "owner", text: message.text, derived: [] });
      const memory = this.memory.assemble(tx, { botId: bot.id, conversationId: conversation.id, purpose: message.text,
        sources: [{ id: source.id, revision: source.revision, generation: source.generation }] });
      const snapshot: ChatInput = { route: this.route(bot.routeId), bot, ownerName: owner.name, language: owner.language, messages: [message], memory };
      const reply: Reply = { id: id(), conversationId: conversation.id, messageId: message.id, state: "queued", reason: null, snapshot };
      tx.run("UPDATE conversations SET revision=revision+1 WHERE id=?", conversation.id); conversation.revision++;
      const receipt = { ...result, conversation, message, reply };
      // Reserve the complete receipt, including pinned memory and the duplicated new message.
      let remaining = canonicalByteLimit - Buffer.byteLength(canonical(receipt));
      for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM messages WHERE conversation_id=? AND id<>? AND NOT EXISTS (SELECT 1 FROM lifecycle.withdrawals WHERE kind='source' AND id=messages.id) ORDER BY sequence DESC LIMIT 11", conversation.id, message.id)) {
        const prior = JSON.parse(row.record_json) as Message;
        if (!this.memory.sourceCurrent(tx, { id: prior.id, revision: 1, generation: 1 })) continue;
        const candidate = { ...memory, sources: [{ id: prior.id, revision: 1, generation: 1 }, ...memory.sources] };
        candidate.bytes = Buffer.byteLength(canonical(candidate));
        const bytes = Buffer.byteLength(canonical(prior)) + 1 + Buffer.byteLength(canonical(candidate)) - Buffer.byteLength(canonical(memory));
        if (bytes > remaining) break;
        this.memory.source(tx, { id: prior.id, botId: bot.id, conversationId: conversation.id, attribution: prior.role === "owner" ? "owner" : "bot", text: prior.text, derived: [] });
        memory.sources = candidate.sources; memory.bytes = candidate.bytes;
        snapshot.messages.unshift(prior); remaining -= bytes;
      }
      save(tx, "memory_contexts", memory);
      tx.run("INSERT INTO reply_outbox VALUES (?,?,?,?)", reply.id, conversation.id, message.id, canonical(reply));
      return receipt;
    }
    if (["bot.proposal.accept", "bot.proposal.reject", "bot.proposal.revise"].includes(c.kind)) {
      const p = c.payload;
      exact(p, c.kind === "bot.proposal.accept" ? ["proposalId", "capabilities"] : c.kind === "bot.proposal.revise" ? ["proposalId", "name", "responsibility", "routeId"] : ["proposalId"]);
      const proposal = record<BotProposal>(tx, "bot_proposals", (p as { proposalId: string }).proposalId);
      if (proposal.revision !== c.expectedRevision || proposal.state !== "proposed") throw new AppError("stale_revision", 409);
      if (c.kind === "bot.proposal.revise") { proposal.name = text(c.payload.name, 200); proposal.responsibility = text(c.payload.responsibility, 4000); this.route(c.payload.routeId); proposal.routeId = c.payload.routeId; proposal.revision++; proposal.author = "owner"; }
      if (c.kind === "bot.proposal.reject") proposal.state = "rejected";
      if (c.kind === "bot.proposal.accept") {
        if (!proposal.routeId) throw new AppError("route_unconfigured", 403); this.route(proposal.routeId);
        const bot: Bot = { id: id(), revision: 1, generation: 1, enabled: true, name: proposal.name, responsibility: proposal.responsibility, routeId: proposal.routeId, capabilities: capabilities(c.payload.capabilities, this.policy), computerId: null, profileId: null };
        tx.run("INSERT INTO bots VALUES (?,?)", bot.id, canonical(bot)); proposal.state = "accepted"; proposal.botId = bot.id;
        const conversation: Conversation = { id: id(), botId: bot.id, revision: 1 }; tx.run("INSERT INTO conversations VALUES (?,?,?)", conversation.id, bot.id, 1);
        tx.run("UPDATE installation SET revision=revision+1"); result.bot = bot; result.conversation = conversation;
      }
      save(tx, "bot_proposals", proposal);
      tx.run("INSERT OR REPLACE INTO proposal_versions VALUES (?,?,?)", proposal.id, proposal.revision, canonical(proposal));
      return { ...result, proposal };
    }
    throw new AppError("unknown_command");
  }
  /** Requests cancellation of fenced chat while its independent transport occupancy remains held until actual return. */
  cancelRepliesFenced(): void {
    for (const [replyId, abort] of this.#replyRunning) {
      const live = this.store.read(tx => {
        const reply = record<Reply>(tx, "reply_outbox", replyId);
        return reply.state === "running" && !!reply.snapshot.memory && this.memory.current(tx, reply.snapshot.memory);
      });
      if (!live) abort.abort();
    }
  }
  /** Marks orphaned chat inference blocked on exclusive boot; never silently resubmits an uncertain call. */
  recoverReplies(): void { this.store.transaction(tx => { for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM reply_outbox WHERE json_extract(record_json,'$.state')='running'")) { const reply = JSON.parse(row.record_json) as Reply; reply.state = "blocked"; reply.reason = "interrupted_no_auto_replay"; save(tx, "reply_outbox", reply); } }); }
  /** Drains committed chat intents serially with bounded context; this never admits persistent work or tools. */
  async drainReplies(): Promise<void> {
    if (this.recovery.booting || this.backups.busy) return;
    if (this.#replyBusy) return; this.#replyBusy = true;
    try { for (;;) {
      const reply = this.store.transaction(tx => {
        const row = tx.get<{ record_json: string }>("SELECT record_json FROM reply_outbox WHERE json_extract(record_json,'$.state')='queued' ORDER BY rowid LIMIT 1"); if (!row) return null;
        const next = JSON.parse(row.record_json) as Reply;
        if (next.snapshot.memory && !this.memory.current(tx, next.snapshot.memory)) {
          next.state = "blocked"; next.reason = "memory_context_stale"; save(tx, "reply_outbox", next); return null;
        }
        next.state = "running"; save(tx, "reply_outbox", next);
        tx.run("INSERT OR REPLACE INTO reply_transports VALUES (?,?,1)", next.id, next.snapshot.memory?.id ?? null);
        return next;
      });
      if (!reply) return;
      let output: Awaited<ReturnType<ChatPort["reply"]>> | null = null;
      let unavailableReason: ReplyUnavailableReason = "unknown";
      const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 60000);
      this.#replyRunning.set(reply.id, abort);
      try { output = await this.options.chat.reply(structuredClone(reply.snapshot), abort.signal); } catch (error) {
        if (error instanceof ReplyUnavailable && ["sign-in", "quota", "provider", "timeout", "unknown"].includes(error.category)) unavailableReason = error.category;
        // Arbitrary transport text and category fields may contain credentials.
      }
      finally {
        clearTimeout(timer);
        this.#replyRunning.delete(reply.id);
        this.store.transaction(tx => tx.run("UPDATE reply_transports SET active=0 WHERE reply_id=?", reply.id));
      }
      this.store.transaction(tx => {
        const current = record<Reply>(tx, "reply_outbox", reply.id); if (current.state !== "running") return;
        if (reply.snapshot.memory && !this.memory.current(tx, reply.snapshot.memory)) {
          current.state = "blocked"; current.reason = "memory_context_stale"; save(tx, "reply_outbox", current); return;
        }
        let content: string | null = null; try { if (output && !abort.signal.aborted) content = text(output.text); } catch { /* Invalid output remains blocked. */ }
        current.state = content ? "succeeded" : "blocked"; current.reason = content ? null : "reply_unavailable";
        if (!content) current.unavailableReason = abort.signal.aborted ? "timeout" : unavailableReason;
        if (content) {
          const message: Message = { id: id(), conversationId: reply.conversationId, role: "bot", text: content, createdAt: this.now() };
          tx.run("INSERT INTO messages(id,conversation_id,record_json) VALUES (?,?,?)", message.id, message.conversationId, canonical(message));
          tx.run("UPDATE conversations SET revision=revision+1 WHERE id=?", message.conversationId);
          const packet = reply.snapshot.memory;
          this.memory.source(tx, { id: message.id, botId: reply.snapshot.bot.id, conversationId: message.conversationId, attribution: "bot", text: content,
            ...(packet ? this.memory.derive(tx, packet) : { derived: [], access: [] }) });
          if (packet && output?.memory !== undefined) {
            try { this.memory.extract(tx, packet.id, { id: reply.messageId, revision: 1, generation: 1 }, output.memory); }
            catch { /* Unsupported extraction stays untrusted data and never publishes globally. */ }
          }
          if (output?.task !== undefined) suggestTask(tx, message.conversationId, message.id, output.task, this.now());
          const item = output?.proposal;
          if (item && typeof item === "object" && !Array.isArray(item)) {
            const data = item as Record<string, unknown>;
            try {
              let routeId: string | null = null; try { routeId = this.route(data.routeId ?? reply.snapshot.route.id).id; } catch { /* Held for owner revision. */ }
              const proposal: BotProposal = { id: id(), conversationId: reply.conversationId, messageId: message.id, revision: 1, author: "bot", proposerBotId: reply.snapshot.bot.id, state: "proposed", name: text(data.name, 200), responsibility: text(data.responsibility, 4000), routeId,
                dropped: [...Object.keys(data).filter(k => !["name", "responsibility", "routeId"].includes(k)).map(() => "unsupported_field"), ...(!routeId ? ["route_unconfigured"] : [])].slice(0, 8), botId: null };
              tx.run("INSERT INTO bot_proposals VALUES (?,?,?,?)", proposal.id, proposal.conversationId, proposal.messageId, canonical(proposal));
              tx.run("INSERT INTO proposal_versions VALUES (?,?,?)", proposal.id, 1, canonical(proposal));
            } catch { /* Malformed model suggestions never become authority cards. */ }
          }
        }
        save(tx, "reply_outbox", current);
      });
    } } finally { this.#replyBusy = false; }
  }
}
