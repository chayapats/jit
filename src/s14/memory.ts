import { AppError } from "../errors";
import { activeLineage, lineageClosure } from "../memory/lineage-policy";
import { lexicalScore, lexicalTerms } from "../memory/lexical";
import type { AppTransaction } from "../store";
import type { S14Application } from "./application";
import { record, save } from "./application";
import type { Attempt, ScopePolicy, ScopeRef, Work } from "./authority-types";
import type { Bot, OwnerActor, Reply } from "./types";
import type { MemoryAccess, MemoryClaim, MemoryCommand, MemoryDecision, MemoryImpact, MemoryLookup, MemoryPacket, MemoryReceipt, MemoryRef, MemoryShare, MemorySource, MemoryWithdrawal } from "./memory-types";
import { canonical, digest, exact, identity, integer, text } from "./validation";

const id = () => crypto.randomUUID().replaceAll("-", "");
const ref = (value: MemoryRef): MemoryRef => ({ id: value.id, revision: value.revision, generation: value.generation });
const same = (a: MemoryRef, b: MemoryRef) => a.id === b.id && a.revision === b.revision && a.generation === b.generation;
const unique = (refs: MemoryRef[]) => [...new Map(refs.map(r => [`${r.id}:${r.revision}:${r.generation}`, ref(r)])).values()];
function reference(value: unknown): asserts value is MemoryRef {
  exact(value, ["id", "revision", "generation"]);
  identity(value.id);
  integer(value.revision, 1);
  integer(value.generation, 1);
}
function rows<T>(tx: AppTransaction, table: "memory_claims" | "memory_sources" | "memory_contexts" | "memory_decisions"): T[] {
  const count = tx.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)!.n;
  if (count > 20_000) throw new AppError("memory_lineage_limit", 409);
  return tx.all<{ record_json: string }>(`SELECT record_json FROM ${table} ORDER BY rowid`).map(r => JSON.parse(r.record_json) as T);
}

/** Bot-first memory authority, conservative lineage, owner publication and fresh bounded context packets. */
export class S14Memory {
  constructor(readonly app: S14Application) {}

  private withdrawn(tx: AppTransaction, kind: "source" | "claim", key: string): boolean {
    return !!tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind=? AND id=?", kind, key);
  }

  /** Registers one committed source snapshot; model text cannot select its origin, attribution or scope. */
  source(tx: AppTransaction, input: Omit<MemorySource, "revision" | "generation" | "createdAt">): MemorySource {
    identity(input.id);
    const existing = tx.get<{ record_json: string }>("SELECT record_json FROM memory_sources WHERE id=?", input.id);
    if (existing) return JSON.parse(existing.record_json) as MemorySource;
    const source: MemorySource = { ...structuredClone(input), revision: 1, generation: 1, createdAt: this.app.now(), text: input.text === null ? null : text(input.text, 32768) };
    tx.run("INSERT INTO memory_sources VALUES (?,?,?)", source.id, source.botId, canonical(source));
    return source;
  }

  private sourceCurrent(tx: AppTransaction, source: MemoryRef): boolean {
    let available = true;
    lineageClosure([source], r => `${r.id}:${r.revision}:${r.generation}`, r => {
      const row = tx.get<{ record_json: string }>("SELECT record_json FROM memory_sources WHERE id=?", r.id);
      const item = row ? JSON.parse(row.record_json) as MemorySource : null;
      if (!item || !same(item, r) || item.text === null || this.withdrawn(tx, "source", r.id)) available = false;
      return item?.derived ?? [];
    });
    return available;
  }

  private access(tx: AppTransaction, claim: MemoryClaim, botId: string, attempt: Attempt | null): { policy: MemoryAccess; share: MemoryShare | null } | null {
    const policy = record<MemoryAccess>(tx, "memory_access", claim.id);
    if (claim.botId === botId || policy.shared) return { policy, share: null };
    if (!attempt) return null;
    for (const scope of attempt.snapshot.scopes) {
      if (scope.ref.kind !== "share" || scope.snapshot.id !== claim.id) continue;
      const row = tx.get<{ record_json: string }>("SELECT record_json FROM memory_shares WHERE id=?", scope.ref.id);
      const share = row ? JSON.parse(row.record_json) as MemoryShare : null;
      if (share?.active && share.receiverBotId === botId && share.revision === scope.ref.revision && same(share.claim, claim) && share.expiresAt > this.app.now()) return { policy, share };
    }
    return null;
  }

  /** Resolves access before lineage or payload, including guessed IDs and every transitive dependency. */
  lookup(tx: AppTransaction, botId: string, requested: MemoryRef, attempt: Attempt | null = null): MemoryLookup {
    reference(requested);
    const unavailable = (r: MemoryRef, reason: string): MemoryLookup => ({ state: "unavailable", reference: ref(r), reason });
    return activeLineage(requested, r => {
      const row = tx.get<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE id=?", r.id);
      const claim = row ? JSON.parse(row.record_json) as MemoryClaim : null;
      const access = claim && same(claim, r) ? this.access(tx, claim, botId, attempt) : null;
      if (!claim || !access) return { value: unavailable(r, "memory_unavailable"), key: r.id, children: [], available: false };
      if (this.withdrawn(tx, "claim", r.id) || !this.sourceCurrent(tx, claim.source)) return { value: unavailable(r, "memory_withdrawn"), key: r.id, children: [], available: false };
      return { value: { state: "available", claim, access: access.policy } as MemoryLookup, key: r.id,
        children: unique([...claim.dependencies, ...claim.conflicts]), available: true };
    }, unavailable);
  }

  /** Supplies only explicit live snapshot shares to the existing work-grant resource intersection. */
  scope(tx: AppTransaction, scope: ScopeRef): ScopePolicy | null {
    if (scope.kind !== "share") return null;
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM memory_shares WHERE id=?", scope.id);
    if (!row) return null;
    const share = JSON.parse(row.record_json) as MemoryShare;
    const claim = record<MemoryClaim>(tx, "memory_claims", share.claim.id);
    if (!share.active || share.revision !== scope.revision || share.expiresAt <= this.app.now() || this.lookup(tx, claim.botId, share.claim).state !== "available") return null;
    return { ref: scope, active: true, ownerBotId: claim.botId, receiverBotId: share.receiverBotId, workId: null,
      tools: [...this.app.policy.tools], snapshot: { id: claim.id, revision: claim.revision, hash: digest(canonical(claim)) } };
  }

  private createClaim(tx: AppTransaction, source: MemorySource, value: { kind: "fact" | "inference"; text: string; quote: string; dependencies: MemoryRef[]; conflicts: MemoryRef[] }): MemoryClaim {
    const claim: MemoryClaim = { id: id(), revision: 1, generation: 1, botId: source.botId, conversationId: source.conversationId, source: ref(source), createdAt: this.app.now(), ...structuredClone(value) };
    tx.run("INSERT INTO memory_claims VALUES (?,?,?)", claim.id, claim.botId, canonical(claim));
    const access: MemoryAccess = { id: claim.id, revision: 1, shared: false, publishedBy: null, changedAt: this.app.now() };
    tx.run("INSERT INTO memory_access VALUES (?,?)", claim.id, canonical(access));
    tx.run("INSERT INTO memory_access_history VALUES (?,?,?)", claim.id, 1, canonical(access));
    return claim;
  }

  /** Validates bounded extractor suggestions against exact admitted evidence; all accepted output remains private. */
  extract(tx: AppTransaction, packetId: string, sourceRef: MemoryRef, output: unknown): { claims: MemoryRef[]; rejected: number } {
    const packet = record<MemoryPacket>(tx, "memory_contexts", packetId);
    if (!this.current(tx, packet) || !packet.sources.some(r => same(r, sourceRef))) throw new AppError("memory_context_stale", 409);
    const source = record<MemorySource>(tx, "memory_sources", sourceRef.id);
    if (source.botId !== packet.botId || source.derived.length || !this.sourceCurrent(tx, sourceRef)) throw new AppError("memory_source_unavailable", 409);
    if (!Array.isArray(output) || output.length > 16) throw new AppError("invalid_memory_extraction");
    const claims: MemoryRef[] = [];
    let rejected = 0;
    for (const assertion of output) {
      try {
        exact(assertion, ["kind", "text", "quote", "conflicts"]);
        if (assertion.kind !== "fact" && assertion.kind !== "inference") throw new AppError("invalid_memory_kind");
        const content = text(assertion.text, 2048), quote = text(assertion.quote, 2048);
        if (!source.text?.includes(quote)) throw new AppError("invalid_memory_quote");
        if (!Array.isArray(assertion.conflicts) || assertion.conflicts.length > 6) throw new AppError("invalid_memory_conflicts");
        for (const conflict of assertion.conflicts) {
          reference(conflict);
          if (!packet.claims.some(c => same(c, conflict))) throw new AppError("memory_reference_not_admitted");
        }
        if (assertion.kind === "fact" && (source.attribution !== "owner" || content !== quote || packet.claims.length)) throw new AppError("invalid_memory_fact");
        const dependencies = packet.claims.map(ref);
        // Include the prospective root in the same depth8/node64 limits as MEM01.
        const options = { depth: 1, remaining: 63, seen: new Set<string>() };
        for (const dependency of unique([...dependencies, ...assertion.conflicts])) {
          const valid = activeLineage(dependency, r => {
            const found = this.lookup(tx, packet.botId, r, this.packetAttempt(tx, packet));
            return { value: found.state === "available", key: r.id, available: found.state === "available",
              children: found.state === "available" ? unique([...found.claim.dependencies, ...found.claim.conflicts]) : [] };
          }, () => false, options);
          if (!valid) throw new AppError("memory_lineage_limit");
        }
        claims.push(ref(this.createClaim(tx, source, { kind: assertion.kind, text: content, quote, dependencies, conflicts: assertion.conflicts as MemoryRef[] })));
      } catch { rejected++; }
    }
    return { claims, rejected };
  }

  private packetAttempt(tx: AppTransaction, packet: MemoryPacket): Attempt | null {
    return packet.attemptId ? record<Attempt>(tx, "work_attempts", packet.attemptId) : null;
  }

  /** Assembles a finite packet after access filtering; every live decision is pinned or admission refuses. */
  assemble(tx: AppTransaction, input: { botId: string; conversationId: string; purpose: string; sources: MemoryRef[]; attempt?: Attempt; bytes?: number }): MemoryPacket {
    const bot = record<Bot>(tx, "bots", input.botId);
    if (!bot.enabled) throw new AppError("bot_disabled", 403);
    const conversation = this.app.readConversation(tx, input.conversationId);
    if (conversation.botId !== bot.id && !input.attempt?.snapshot.grant.bots.some(b => b.id === bot.id)) throw new AppError("memory_scope_denied", 403);
    const attempt = input.attempt ?? null, budget = input.bytes ?? 16384;
    integer(budget, 1024, 65536);
    const decisions = rows<MemoryDecision>(tx, "memory_decisions").filter(d => d.conversationId === conversation.id);
    const packet: MemoryPacket = { id: id(), botId: bot.id, botRevision: bot.revision, botGeneration: bot.generation,
      ownerGeneration: tx.get<{ generation: number }>("SELECT generation FROM owner")!.generation,
      conversationId: conversation.id, workId: attempt?.workId ?? null, attemptId: attempt?.id ?? null,
      sources: unique(input.sources), claims: [], decisions, access: [], omitted: 0, bytes: 0, state: "current", createdAt: this.app.now() };
    if (packet.sources.some(r => !this.sourceCurrent(tx, r))) throw new AppError("memory_source_unavailable", 409);
    const cost = () => Buffer.byteLength(canonical(packet));
    if (cost() > budget) throw new AppError("context_too_large", 409);
    const query = lexicalTerms(input.purpose);
    const accessible = rows<MemoryClaim>(tx, "memory_claims").filter(c => !!this.access(tx, c, bot.id, attempt));
    const candidates = accessible.map(c => ({ claim: c, score: lexicalScore(query, c.text) }))
      .filter(c => c.score >= 3 || c.claim.kind === "fact")
      .sort((a, b) => b.score - a.score || b.claim.createdAt - a.claim.createdAt || a.claim.id.localeCompare(b.claim.id));
    for (const { claim } of candidates) {
      const found = this.lookup(tx, bot.id, ref(claim), attempt);
      if (found.state !== "available") continue;
      const access = this.access(tx, claim, bot.id, attempt)!;
      if (packet.claims.length >= 6) { packet.omitted++; continue; }
      packet.claims.push(claim);
      packet.access.push({ id: claim.id, revision: access.policy.revision, shareId: access.share?.id ?? null, shareRevision: access.share?.revision ?? null });
      if (cost() > budget - 128) { packet.claims.pop(); packet.access.pop(); packet.omitted++; }
    }
    packet.bytes = cost();
    tx.run("INSERT INTO memory_contexts VALUES (?,?,?)", packet.id, bot.id, canonical(packet));
    return packet;
  }

  /** Rechecks live decisions, access revisions, source lineage and owner/Bot generations before use or publication. */
  current(tx: AppTransaction, packet: MemoryPacket): boolean {
    if (packet.state !== "current") return false;
    const stored = record<MemoryPacket>(tx, "memory_contexts", packet.id);
    if (stored.state !== "current") return false;
    const bot = record<Bot>(tx, "bots", packet.botId);
    if (!bot.enabled || bot.revision !== packet.botRevision || bot.generation !== packet.botGeneration || tx.get<{ generation: number }>("SELECT generation FROM owner")?.generation !== packet.ownerGeneration) return false;
    if (packet.sources.some(r => !this.sourceCurrent(tx, r))) return false;
    const live = rows<MemoryDecision>(tx, "memory_decisions").filter(d => d.conversationId === packet.conversationId);
    if (canonical(live.map(ref)) !== canonical(packet.decisions.map(ref))) return false;
    if (packet.decisions.some(d => !this.sourceCurrent(tx, d.source))) return false;
    const attempt = this.packetAttempt(tx, packet);
    for (const claim of packet.claims) {
      if (this.lookup(tx, packet.botId, ref(claim), attempt).state !== "available") return false;
      const access = this.access(tx, claim, packet.botId, attempt), pinned = packet.access.find(a => a.id === claim.id);
      if (!access || !pinned || access.policy.revision !== pinned.revision || (access.share?.id ?? null) !== pinned.shareId || (access.share?.revision ?? null) !== pinned.shareRevision) return false;
    }
    return true;
  }

  /** Returns an owner-only scoped inspector; query matching runs only after active access validation. */
  inspect(actor: OwnerActor, botId: string, query = ""): { claims: MemoryLookup[]; decisions: MemoryDecision[]; sources: MemorySource[]; withdrawals: MemoryWithdrawal[] } {
    identity(botId);
    if (query) text(query, 200);
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      record<Bot>(tx, "bots", botId);
      const terms = lexicalTerms(query);
      const claims = rows<MemoryClaim>(tx, "memory_claims").filter(c => this.access(tx, c, botId, null)).map(c => this.lookup(tx, botId, ref(c)));
      const decisions = rows<MemoryDecision>(tx, "memory_decisions").filter(d => this.app.readConversation(tx, d.conversationId).botId === botId);
      const sources = rows<MemorySource>(tx, "memory_sources").filter(s => s.botId === botId).slice(-200);
      const selected = claims.filter(c => !query || c.state === "available" && (lexicalScore(terms, c.claim.text) >= 3 || c.claim.text.toLowerCase().includes(query.toLowerCase()))).slice(-200);
      const returned = new Set([...selected.map(c => c.state === "available" ? c.claim.id : c.reference.id), ...sources.map(s => s.id), ...decisions.map(d => d.source.id)]);
      const withdrawals = tx.all<Omit<MemoryWithdrawal, "source">>("SELECT kind,id,mode FROM lifecycle.withdrawals").filter(w => returned.has(w.id))
        .map(w => ({ ...w, source: w.kind === "claim" ? record<MemoryClaim>(tx, "memory_claims", w.id).source : null }));
      return { claims: selected, decisions, sources, withdrawals };
    });
  }

  /** Exact owner claim inspector retains publication history while withholding withdrawn payload. */
  claim(actor: OwnerActor, botId: string, requested: MemoryRef) {
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      const claim = this.lookup(tx, botId, requested);
      const history = claim.state === "available" ? tx.all<{ record_json: string }>("SELECT record_json FROM memory_access_history WHERE id=? ORDER BY revision", requested.id).map(r => JSON.parse(r.record_json) as MemoryAccess) : [];
      const shares = claim.state === "available" ? tx.all<{ record_json: string }>("SELECT record_json FROM memory_shares WHERE json_extract(record_json,'$.claim.id')=?", requested.id).map(r => JSON.parse(r.record_json) as MemoryShare) : [];
      return { claim, history, shares };
    });
  }

  /** Shows affected identities and contexts before correction, forget or deletion without changing any state. */
  preview(actor: OwnerActor, requested: MemoryRef): MemoryImpact {
    return this.app.store.read(tx => { this.app.requireOwner(tx, actor); return this.impact(tx, requested); });
  }

  private impact(tx: AppTransaction, requested: MemoryRef): MemoryImpact {
    const claim = record<MemoryClaim>(tx, "memory_claims", requested.id);
    if (!same(claim, requested)) throw new AppError("stale_revision", 409);
    const claims = rows<MemoryClaim>(tx, "memory_claims"), sources = rows<MemorySource>(tx, "memory_sources");
    type Node = { kind: "claim" | "source"; ref: MemoryRef };
    const closure = lineageClosure<Node>([{ kind: "claim", ref: requested }, { kind: "source", ref: claim.source }], n => `${n.kind}:${n.ref.id}`, node => {
      const children: Node[] = [];
      for (const candidate of claims) {
        if (node.kind === "source" ? same(candidate.source, node.ref) : [...candidate.dependencies, ...candidate.conflicts].some(r => same(r, node.ref))) {
          children.push({ kind: "claim", ref: ref(candidate) }, { kind: "source", ref: candidate.source });
        }
      }
      if (node.kind === "source") for (const candidate of sources) if (candidate.derived.some(r => same(r, node.ref))) children.push({ kind: "source", ref: ref(candidate) });
      return children;
    });
    const affectedClaims = closure.filter(n => n.kind === "claim").map(n => n.ref), affectedSources = closure.filter(n => n.kind === "source").map(n => n.ref);
    const contexts = rows<MemoryPacket>(tx, "memory_contexts").filter(p => p.claims.some(c => affectedClaims.some(r => same(r, c))) || [...p.sources, ...p.decisions.map(d => d.source)].some(s => affectedSources.some(r => same(r, s)))).map(p => p.id);
    return { claim: requested, claims: affectedClaims, sources: affectedSources, contexts, nativePolicy: "fresh_sessions_retire_on_close" };
  }

  private withdraw(tx: AppTransaction, requested: MemoryRef, mode: "corrected" | "forgotten" | "deleted"): MemoryImpact {
    const impact = this.impact(tx, requested);
    for (const [kind, refs] of [["claim", impact.claims], ["source", impact.sources]] as const) {
      for (const item of refs) {
        tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES (?,?,?)", kind, item.id, mode);
        if (mode !== "deleted") continue;
        if (kind === "claim") {
          const claim = record<MemoryClaim>(tx, "memory_claims", item.id);
          claim.text = "[deleted]"; claim.quote = "[deleted]";
          save(tx, "memory_claims", claim);
        } else {
          const source = record<MemorySource>(tx, "memory_sources", item.id);
          source.text = null; save(tx, "memory_sources", source);
          const message = tx.get<{ record_json: string }>("SELECT record_json FROM messages WHERE id=?", item.id);
          if (message) { const data = JSON.parse(message.record_json); data.text = "[deleted]"; tx.run("UPDATE messages SET record_json=? WHERE id=?", canonical(data), item.id); }
        }
      }
    }
    for (const key of impact.contexts) {
      const packet = record<MemoryPacket>(tx, "memory_contexts", key);
      packet.state = "retired"; packet.claims = []; packet.decisions = [];
      save(tx, "memory_contexts", packet);
    }
    return impact;
  }

  /** Applies memory commands only in the application's authenticated receipt transaction. */
  apply(tx: AppTransaction, command: MemoryCommand): MemoryReceipt {
    const receipt: MemoryReceipt = { kind: command.kind, requestId: command.requestId };
    if (command.kind === "memory.remember") {
      exact(command.payload, ["conversationId", "text"]);
      const conversation = this.app.readConversation(tx, command.payload.conversationId);
      if (conversation.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
      const content = text(command.payload.text, 2048);
      const source = this.source(tx, { id: id(), botId: conversation.botId, conversationId: conversation.id, attribution: "owner", text: content, derived: [] });
      const claim = this.createClaim(tx, source, { kind: "fact", text: content, quote: content, dependencies: [], conflicts: [] });
      tx.run("UPDATE conversations SET revision=revision+1 WHERE id=?", conversation.id);
      return { ...receipt, claim: ref(claim), access: record<MemoryAccess>(tx, "memory_access", claim.id) };
    }
    if (command.kind === "memory.decision.set") {
      exact(command.payload, ["conversationId", "key", "text"]);
      const p = command.payload, conversation = this.app.readConversation(tx, p.conversationId);
      identity(p.key);
      const previous = tx.get<{ record_json: string }>("SELECT record_json FROM memory_decisions WHERE conversation_id=? AND json_extract(record_json,'$.key')=?", conversation.id, p.key);
      const old = previous ? JSON.parse(previous.record_json) as MemoryDecision : null;
      if (command.expectedRevision !== (old?.revision ?? 0)) throw new AppError("stale_revision", 409);
      const content = text(p.text, 4000), source = this.source(tx, { id: id(), botId: conversation.botId, conversationId: conversation.id, attribution: "owner", text: content, derived: [] });
      const decision: MemoryDecision = { id: old?.id ?? id(), revision: (old?.revision ?? 0) + 1, generation: (old?.generation ?? 0) + 1, conversationId: conversation.id, key: p.key, text: content, source: ref(source) };
      if (old) tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('source',?,'corrected')", old.source.id);
      tx.run("INSERT OR REPLACE INTO memory_decisions VALUES (?,?,?)", decision.id, conversation.id, canonical(decision));
      return { ...receipt, decision: ref(decision) };
    }
    const p = command.payload;
    exact(p, command.kind === "memory.correct" ? ["claim", "text"] : command.kind === "memory.share" ? ["claim", "scopeId", "receiverBotId", "expiresAt"] : ["claim"]);
    reference(p.claim);
    const claim = record<MemoryClaim>(tx, "memory_claims", p.claim.id);
    if (!same(claim, p.claim)) throw new AppError("stale_revision", 409);
    const access = record<MemoryAccess>(tx, "memory_access", claim.id);
    if (["memory.correct", "memory.forget", "memory.delete"].includes(command.kind)) {
      if (command.expectedRevision !== claim.revision) throw new AppError("stale_revision", 409);
      if (command.kind !== "memory.delete" && this.lookup(tx, claim.botId, p.claim).state !== "available") throw new AppError("memory_unavailable", 409);
      const content = command.kind === "memory.correct" ? text(command.payload.text, 2048) : null;
      const impact = this.withdraw(tx, p.claim, command.kind === "memory.delete" ? "deleted" : command.kind === "memory.correct" ? "corrected" : "forgotten");
      if (content !== null) {
        const source = this.source(tx, { id: id(), botId: claim.botId, conversationId: claim.conversationId, attribution: "owner", text: content, derived: [] });
        receipt.claim = ref(this.createClaim(tx, source, { kind: "fact", text: content, quote: content, dependencies: [], conflicts: [] }));
      }
      return { ...receipt, withdrawn: impact.claims.length };
    }
    if (command.expectedRevision !== access.revision) throw new AppError("stale_revision", 409);
    if (this.lookup(tx, claim.botId, p.claim).state !== "available") throw new AppError("memory_unavailable", 409);
    if (command.kind === "memory.share") {
      const s = command.payload;
      identity(s.scopeId); identity(s.receiverBotId); integer(s.expiresAt, this.app.now() + 1, this.app.now() + 86400000);
      const receiver = record<Bot>(tx, "bots", s.receiverBotId);
      if (!receiver.enabled || !this.app.policy.resources.includes(s.scopeId) || !receiver.capabilities.resources.includes(s.scopeId)) throw new AppError("memory_scope_denied", 403);
      if (tx.get("SELECT id FROM memory_shares WHERE id=?", s.scopeId)) throw new AppError("memory_share_exists", 409);
      const share: MemoryShare = { id: s.scopeId, revision: 1, claim: ref(claim), receiverBotId: receiver.id, expiresAt: s.expiresAt, active: true };
      tx.run("INSERT INTO memory_shares VALUES (?,?)", share.id, canonical(share));
      return { ...receipt, share };
    }
    if (command.kind !== "memory.publish" && command.kind !== "memory.revoke") throw new AppError("unknown_command");
    access.revision++; access.shared = command.kind === "memory.publish"; access.publishedBy = "owner"; access.changedAt = this.app.now();
    save(tx, "memory_access", access);
    tx.run("INSERT INTO memory_access_history VALUES (?,?,?)", access.id, access.revision, canonical(access));
    if (command.kind === "memory.revoke") for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM memory_shares WHERE json_extract(record_json,'$.claim.id')=?", claim.id)) {
      const share = JSON.parse(row.record_json) as MemoryShare;
      share.active = false; share.revision++; save(tx, "memory_shares", share);
    }
    return { ...receipt, access };
  }

  /** Replays the independent deletion ledger into a restored image before any worker or owner projection. */
  reconcile(tx: AppTransaction): void {
    const deleted = tx.all<{ kind: string; id: string }>("SELECT kind,id FROM lifecycle.withdrawals WHERE mode='deleted'");
    const sources = new Set(deleted.filter(e => e.kind === "source").map(e => e.id));
    const claims = new Set(deleted.filter(e => e.kind === "claim").map(e => e.id));
    for (const sourceId of sources) {
      const row = tx.get<{ record_json: string }>("SELECT record_json FROM memory_sources WHERE id=?", sourceId);
      if (row) { const source = JSON.parse(row.record_json) as MemorySource; source.text = null; save(tx, "memory_sources", source); }
      const message = tx.get<{ record_json: string }>("SELECT record_json FROM messages WHERE id=?", sourceId);
      if (message) { const data = JSON.parse(message.record_json); data.text = "[deleted]"; tx.run("UPDATE messages SET record_json=? WHERE id=?", canonical(data), sourceId); }
    }
    for (const claimId of claims) {
      const row = tx.get<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE id=?", claimId);
      if (row) { const claim = JSON.parse(row.record_json) as MemoryClaim; claim.text = "[deleted]"; claim.quote = "[deleted]"; save(tx, "memory_claims", claim); }
    }
    // Receipts keep their request hash and identities; deleted payload is not an export or replay source.
    const scrub = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(scrub);
      if (!value || typeof value !== "object") return value;
      const item = value as Record<string, unknown>;
      if (typeof item.id === "string" && (sources.has(item.id) || claims.has(item.id))) {
        if (typeof item.text === "string") item.text = "[deleted]";
        if (typeof item.quote === "string") item.quote = "[deleted]";
      }
      for (const key of Object.keys(item)) item[key] = scrub(item[key]);
      return item;
    };
    if (deleted.length) for (const row of tx.all<{ request_id: string; result_json: string }>("SELECT request_id,result_json FROM command_receipts")) {
      tx.run("UPDATE command_receipts SET result_json=? WHERE owner_id='owner' AND request_id=?", canonical(scrub(JSON.parse(row.result_json))), row.request_id);
    }
  }

  /** Fences stored chat inputs and work contexts after committed changes; retained private snapshots are scrubbed. */
  fence(tx: AppTransaction): void {
    const packets = rows<MemoryPacket>(tx, "memory_contexts");
    const stale = new Set<string>();
    for (const packet of packets) if (!this.current(tx, packet)) {
      stale.add(packet.id);
      packet.state = "retired"; packet.claims = []; packet.decisions = [];
      save(tx, "memory_contexts", packet);
    }
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM reply_outbox")) {
      const reply = JSON.parse(row.record_json) as Reply;
      if (!reply.snapshot.memory || !stale.has(reply.snapshot.memory.id)) continue;
      reply.snapshot.messages = []; delete reply.snapshot.memory;
      if (reply.state === "queued" || reply.state === "running") { reply.state = "blocked"; reply.reason = "memory_context_stale"; }
      save(tx, "reply_outbox", reply);
    }
    for (const packet of packets) if (stale.has(packet.id) && packet.workId) {
      const work = record<Work>(tx, "work_items", packet.workId);
      if (work.result !== null) { work.result = null; work.reason = "memory_context_stale"; work.state = "blocked"; work.revision++; save(tx, "work_items", work); }
      tx.run("DELETE FROM work_results WHERE work_id=?", packet.workId);
    }
  }

  /** Retrieves a current packet for a running attempt; stale or retired contexts never enter another tool or result. */
  attemptCurrent(tx: AppTransaction, attemptId: string): boolean {
    const packets = tx.all<{ record_json: string }>("SELECT record_json FROM memory_contexts WHERE json_extract(record_json,'$.attemptId')=?", attemptId);
    return packets.every(row => this.current(tx, JSON.parse(row.record_json) as MemoryPacket));
  }

  /** Loads the immutable packet captured for a live attempt without relying on native history. */
  attemptPacket(tx: AppTransaction, attemptId: string): MemoryPacket {
    const attempt = record<Attempt>(tx, "work_attempts", attemptId);
    if (!attempt.memoryId) throw new AppError("memory_context_missing", 409);
    const packet = record<MemoryPacket>(tx, "memory_contexts", attempt.memoryId);
    if (!this.current(tx, packet)) throw new AppError("memory_context_stale", 409);
    return packet;
  }

  /** Projects a packet for the owner without returning any stale private payload. */
  context(actor: OwnerActor, key: string): MemoryPacket {
    identity(key);
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      const packet = record<MemoryPacket>(tx, "memory_contexts", key);
      return this.current(tx, packet) ? packet : { ...packet, state: "retired", claims: [], decisions: [] };
    });
  }
}
