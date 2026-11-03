import { AppError } from "../../errors";
import { digest } from "../conversation/validation";
import { ProtectedDataStore, TEAM_SCHEMA_V1 } from "./store";
import { canonical, content, exact, identity, ids, inScope, integer, origin, reference, resource, scope } from "./validation";
import type { OwnerActor, Ref, TeamActor, TeamContext, TeamLease, TeamLeaseSubject, TeamOptions, TeamResource, TeamResourcesView, TeamResult, TeamSource, WorkAuthority } from "./types";

interface Context { actor: TeamActor; authority: WorkAuthority }
interface LeaseRecord { id: string; workId: string; resources: string[]; keys: { key: string; fence: number }[]; mode: "write" | "input"; expiresAt: number; state: "reserved" | "in_flight" | "unknown" | "settled"; subject?: TeamLeaseSubject }
const key = () => crypto.randomUUID().replaceAll("-", "");
/** Digest of the exact registration rows shown to the owner; any change refuses the confirmation. */
export const teamCandidatesHash = (items: readonly TeamResource[]): string => digest(canonical({ contract: "s15-team-registration/v1", items }));
const same = (a: Ref, b: Ref) => a.id === b.id && a.revision === b.revision && a.generation === b.generation;

/**
 * Protected team resource mediation. Every member uses existing standing-policy work authority;
 * no per-Bot account grant or credential copy is created. Leases coordinate cooperative adapters;
 * they do not prove hostile guest-root CAS or replace POLICY/browser external-effect gates.
 */
export class TeamService {
  readonly store: ProtectedDataStore;
  readonly now: () => number;
  #contexts = new WeakMap<TeamContext, Context>();
  #leases = new WeakMap<TeamLease, { id: string; context: TeamContext }>();
  constructor(readonly options: TeamOptions) {
    if (options.runtime !== "s15") throw new AppError("s15_opt_in_required");
    integer(options.maxConcurrentOperations, 1, 64);
    this.now = options.now ?? Date.now;
    this.store = new ProtectedDataStore(options.path, options.installationId, options.create, 0x4a495436, TEAM_SCHEMA_V1);
    // Process loss cannot prove that input, a file write or a transport has stopped.
    this.store.db.query("UPDATE leases SET state='unknown' WHERE state IN ('reserved','in_flight')").run();
  }
  private owner(actor: OwnerActor): void { this.options.policy.owner.current(actor); }
  /** One authenticated revision-bound owner registration; raw accounts remain in their owning brokers. */
  register(actor: OwnerActor, requestId: string, expectedRevision: number, value: TeamResource): TeamResource {
    this.owner(actor); identity(requestId); integer(expectedRevision, 0); resource(value);
    return this.store.transaction(() => {
      this.owner(actor); this.store.capacity();
      const hash = digest(canonical({ expectedRevision, value }));
      const prior = this.store.db.query<{ payload_hash: string; result_json: string }, [string]>("SELECT * FROM commands WHERE id=?").get(requestId);
      if (prior) { if (prior.payload_hash !== hash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as TeamResource; }
      this.put(value, expectedRevision);
      this.store.db.query("INSERT INTO commands VALUES (?,?,?)").run(requestId, hash, canonical(value));
      return structuredClone(value);
    });
  }
  /** Compare-and-set write inside the caller's transaction. Revisions only increase, so a first
   * registration can adopt the owning catalog's current revision; private S14 scope never widens here. */
  private put(value: TeamResource, expectedRevision: number): void {
    const existing = this.findResource(value.id);
    if ((existing?.revision ?? 0) !== expectedRevision || value.revision <= expectedRevision || existing && value.generation < existing.generation) throw new AppError("stale_revision", 409);
    if (existing && existing.coordinationKey !== value.coordinationKey) throw new AppError("coordination_identity_changed", 409);
    if (existing?.scope.kind === "bot" && existing.scope.origin === "s14" && canonical(existing.scope) !== canonical(value.scope)) throw new AppError("private_promotion_requires_migration", 409);
    this.store.db.query("INSERT INTO resources VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json").run(value.id, canonical(value));
  }
  /**
   * One authenticated owner confirmation of an exact reviewed list of new registrations. `candidates`
   * is recomputed from protected state inside the transaction; if its digest differs from what the owner
   * saw, nothing is registered. All items register atomically; a repeated request returns its result.
   */
  registerReviewed(actor: OwnerActor, requestId: string, reviewedHash: string, candidates: () => readonly TeamResource[]): string[] {
    this.owner(actor); identity(requestId);
    if (!/^[a-f0-9]{64}$/.test(reviewedHash)) throw new AppError("invalid_body");
    return this.store.transaction(() => {
      this.owner(actor); this.store.capacity();
      const prior = this.store.db.query<{ payload_hash: string; result_json: string }, [string]>("SELECT * FROM commands WHERE id=?").get(requestId);
      if (prior) { if (prior.payload_hash !== reviewedHash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as string[]; }
      const items = candidates().map(item => structuredClone(item));
      items.forEach(resource);
      if (!items.length || items.length > 64 || teamCandidatesHash(items) !== reviewedHash) throw new AppError("team_resources_changed", 409);
      for (const item of items) { if (this.findResource(item.id)) throw new AppError("team_resources_changed", 409); this.put(item, 0); }
      const ids = items.map(item => item.id);
      this.store.db.query("INSERT INTO commands VALUES (?,?,?)").run(requestId, reviewedHash, canonical(ids));
      return ids;
    });
  }
  /** Read-only owner projection. A team default is still bounded by current enabled Bot/work policy. */
  resources(actor: OwnerActor): TeamResourcesView {
    this.owner(actor);
    return { contract: "s15-team-resources-view/v1", resources: this.store.db.query<{ record_json: string }, []>("SELECT record_json FROM resources ORDER BY id").all().map(row => {
      const item = JSON.parse(row.record_json) as TeamResource;
      return { ...item, whoCanUse: item.scope.kind === "bot" ? [item.scope.botId] : item.allowedBots ?? "enabled_team", restrictions: [
        ...(!item.active ? ["inactive"] : []), ...(item.scope.kind === "bot" ? [item.scope.origin === "s14" ? "s14_private" : "bot_private"] : []),
        ...item.deniedBots.map(bot => `deny:${bot}`), ...item.purposes.map(purpose => `purpose:${purpose}`), "current_standing_policy", "mediated_credentials",
      ] };
    }) };
  }
  private findResource(id: string): TeamResource | null {
    const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM resources WHERE id=?").get(id);
    return row ? JSON.parse(row.record_json) as TeamResource : null;
  }
  /** Host-only current catalog projection; this supplies a fence, never an actor or resource grant. */
  currentResource(id: string): { ref: Ref; active: boolean } | null {
    const resource = this.findResource(id); return resource ? { ref: { id: resource.id, revision: resource.revision, generation: resource.generation }, active: resource.active } : null;
  }
  /** Pure current resource ceiling for POLICY's catalog intersection. It cannot call POLICY recursively or authenticate a serialized work object. */
  allowsWork(work: WorkAuthority): boolean {
    return work.request.resources.every(ref => {
      const item = this.findResource(ref.id), bot = work.request.bot.id;
      return !!item && item.active && same(ref, item) && item.purposes.includes(work.request.purpose.id) && inScope(item.scope, bot) && (item.allowedBots === null || item.allowedBots.includes(bot)) && !item.deniedBots.includes(bot);
    });
  }
  /** Binds a real POLICY actor to independent process-local context, never to another Bot's native session. */
  bind(actor: TeamActor): TeamContext {
    const authority = this.options.policy.work.guard(actor);
    if (authority.mode !== "work") throw new AppError("outside_scope", 403);
    const handle = Object.freeze({}) as TeamContext;
    this.#contexts.set(handle, { actor, authority: structuredClone(authority) }); return handle;
  }
  /** Fresh authority check at every tool/read/handoff/publication boundary. */
  guard(context: TeamContext): WorkAuthority {
    const saved = this.#contexts.get(context);
    if (!saved) throw new AppError("authentication_required", 401);
    const current = this.options.policy.work.guard(saved.actor);
    if (canonical(current) !== canonical(saved.authority) || current.expiresAt <= this.now()) throw new AppError("stale_authority", 409);
    return structuredClone(current);
  }
  /** Intersects current work, explicit resource policy and private scope before any resource bytes. */
  resource(context: TeamContext, id: string, operation: "read" | "write" | "input" = "read"): TeamResource {
    identity(id); const work = this.guard(context), item = this.findResource(id), bot = work.request.bot.id;
    if (!item || !item.active || !work.request.resources.some(r => same(r, item)) || !item.purposes.includes(work.request.purpose.id) || !inScope(item.scope, bot) || item.allowedBots !== null && !item.allowedBots.includes(bot) || item.deniedBots.includes(bot) || !item.operations.includes(operation)) throw new AppError("outside_scope", 403);
    if (operation !== "read" && (work.request.intent !== "execute" || work.request.access === "read")) throw new AppError("outside_scope", 403);
    return item;
  }
  /** Captures only a bounded immutable work/message subset; every ancestor keeps its original fences. */
  capture(context: TeamContext, value: Pick<TeamSource, "id" | "text" | "scope" | "origin" | "resources" | "parents">): TeamSource {
    canonical(value); exact(value, ["id", "text", "scope", "origin", "resources", "parents"]); identity(value.id); content(value.text, 32768); scope(value.scope); origin(value.origin); ids(value.parents, 128);
    if (!Array.isArray(value.resources) || value.resources.length > 32) throw new AppError("invalid_source");
    value.resources.forEach(reference);
    if (new Set(value.resources.map(r => r.id)).size !== value.resources.length) throw new AppError("invalid_source");
    return this.store.transaction(() => {
      this.store.capacity(); const work = this.guard(context);
      if (!inScope(value.scope, work.request.bot.id) || value.origin.kind === "historical" && (value.scope.kind !== "bot" || value.scope.origin !== "s14")) throw new AppError("outside_scope", 403);
      value.resources.forEach(pin => { if (!same(this.resource(context, pin.id), pin)) throw new AppError("stale_authority", 409); });
      value.parents.forEach(id => this.source(context, id));
      const source: TeamSource = { contract: "s15-team-source/v1", ...structuredClone(value), producer: { workId: work.id, bot: work.request.bot, policyRevision: work.policyRevision, ownerGeneration: work.ownerGeneration }, active: true };
      const prior = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM sources WHERE id=?").get(source.id);
      if (prior) { if (canonical(source) !== prior.record_json) throw new AppError("source_id_conflict", 409); return JSON.parse(prior.record_json) as TeamSource; }
      this.store.db.query("INSERT INTO sources VALUES (?,?)").run(source.id, canonical(source)); return source;
    });
  }
  /** Full ancestry and producer/resource fences are checked before returning content or scoring relevance. */
  source(context: TeamContext, id: string): TeamSource {
    identity(id); const work = this.guard(context), seen = new Set<string>();
    const visit = (currentId: string): TeamSource => {
      if (seen.has(currentId) || seen.size >= 256) throw new AppError("lineage_withdrawn", 409);
      seen.add(currentId);
      const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM sources WHERE id=?").get(currentId);
      const item = row ? JSON.parse(row.record_json) as TeamSource : null;
      if (!item || !item.active || !inScope(item.scope, work.request.bot.id) || this.store.db.query("SELECT 1 FROM withdrawals WHERE id=?").get(currentId) || !this.options.producerCurrent(item.producer)) throw new AppError("lineage_withdrawn", 409);
      for (const pin of item.resources) if (!same(this.resource(context, pin.id), pin)) throw new AppError("lineage_withdrawn", 409);
      for (const parent of item.parents) { if (!seen.has(parent)) visit(parent); }
      return item;
    };
    return visit(id);
  }
  /** Current withdrawal metadata for replay filtering, including a withdrawal committed before MEM's transaction. */
  isWithdrawn(sourceId: string): boolean {
    identity(sourceId); const pending = [sourceId], seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!; if (seen.has(current)) continue; seen.add(current);
      if (seen.size > 256 || this.store.db.query("SELECT 1 FROM withdrawals WHERE id=?").get(current)) return true;
      const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM sources WHERE id=?").get(current);
      if (!row) return true;
      pending.push(...(JSON.parse(row.record_json) as TeamSource).parents);
    }
    return false;
  }
  /** Revokes a source and all future descendant reads without deleting valid independent sibling evidence. */
  withdraw(actor: OwnerActor, sourceId: string): void {
    this.owner(actor); identity(sourceId);
    this.store.transaction(() => { this.owner(actor); this.store.db.query("INSERT OR IGNORE INTO withdrawals VALUES (?,?)").run(sourceId, this.now()); });
  }
  /** Synchronous final byte handoff to the actual independently authorized receiver, after every wait. */
  handoff(sender: TeamContext, receiver: TeamContext, sourceIds: string[], consume: (sources: readonly TeamSource[]) => void): void {
    ids(sourceIds, 32);
    this.store.transaction(() => {
      const a = this.guard(sender), b = this.guard(receiver);
      if (a.request.purpose.id !== b.request.purpose.id || a.ownerGeneration !== b.ownerGeneration) throw new AppError("outside_scope", 403);
      sourceIds.forEach(id => this.source(sender, id));
      const sources = sourceIds.map(id => this.source(receiver, id));
      if (Buffer.byteLength(canonical(sources)) > 65536) throw new AppError("output_limit");
      consume(sources);
    });
  }
  /**
   * Atomic all-or-none physical resource locks. Immutable reads need no exclusive lease. `partition` names one
   * physical unit of a pooled resource (a working-computer pool member): the lock and its fence apply to that
   * unit only, so siblings keep serving; the resource's own authority checks are unchanged.
   */
  acquire(context: TeamContext, resourceIds: string[], mode: "write" | "input", lifetimeMs: number, partition?: string): TeamLease {
    ids(resourceIds, 32); integer(lifetimeMs, 1, 3600000);
    if (partition !== undefined) identity(partition);
    if (!resourceIds.length || !["write", "input"].includes(mode)) throw new AppError("invalid_lease");
    const record = this.store.transaction(() => {
      this.store.capacity(); const work = this.guard(context);
      const resources = resourceIds.map(id => this.resource(context, id, mode));
      const keys = [...new Set(resources.map(r => partition === undefined ? r.coordinationKey : `${r.coordinationKey}#${partition}`))].sort();
      const count = this.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM leases WHERE state<>'settled'").get()!.n;
      if (count >= this.options.maxConcurrentOperations || keys.some(k => this.store.db.query("SELECT 1 FROM lease_keys WHERE coordination_key=?").get(k))) throw new AppError("resource_busy", 409);
      const record: LeaseRecord = { id: key(), workId: work.id, resources: resourceIds, mode, expiresAt: Math.min(work.expiresAt, this.now() + lifetimeMs), state: "reserved", keys: keys.map(k => {
        const prior = this.store.db.query<{ generation: number }, [string]>("SELECT generation FROM fences WHERE coordination_key=?").get(k)?.generation ?? 0;
        integer(prior + 1, 1);
        this.store.db.query("INSERT INTO fences VALUES (?,?) ON CONFLICT(coordination_key) DO UPDATE SET generation=excluded.generation").run(k, prior + 1);
        return { key: k, fence: prior + 1 };
      }) };
      this.store.db.query("INSERT INTO leases VALUES (?,?,?)").run(record.id, record.state, canonical(record));
      for (const k of keys) this.store.db.query("INSERT INTO lease_keys VALUES (?,?)").run(k, record.id);
      return record;
    });
    const handle = Object.freeze({}) as TeamLease; this.#leases.set(handle, { id: record.id, context }); return handle;
  }
  private lease(handle: TeamLease): { record: LeaseRecord; context: TeamContext } {
    const saved = this.#leases.get(handle); if (!saved) throw new AppError("stale_lease", 409);
    const row = this.store.db.query<{ state: LeaseRecord["state"]; record_json: string }, [string]>("SELECT state,record_json FROM leases WHERE id=?").get(saved.id);
    if (!row) throw new AppError("stale_lease", 409);
    return { record: { ...JSON.parse(row.record_json) as LeaseRecord, state: row.state }, context: saved.context };
  }
  /** Externally enforced fencing numbers for a trusted broker, never exposed as reusable agent permits. */
  guardLease(handle: TeamLease): readonly { key: string; fence: number }[] {
    const { record, context } = this.lease(handle); this.guard(context);
    if (!["reserved", "in_flight"].includes(record.state) || record.expiresAt <= this.now()) throw new AppError("stale_lease", 409);
    record.resources.forEach(id => this.resource(context, id, record.mode));
    for (const k of record.keys) if (!this.store.db.query("SELECT 1 FROM lease_keys WHERE coordination_key=? AND lease_id=?").get(k.key, record.id)) throw new AppError("stale_lease", 409);
    return structuredClone(record.keys);
  }
  /**
   * Commits once before synchronous dispatch. The adapter owns actual I/O, effect policy, CAS and
   * settlement proof. An exception/unknown transport retains the lock across expiry and restart.
   */
  async dispatch<T>(handle: TeamLease, send: (fences: readonly { key: string; fence: number }[]) => Promise<{ value: T; settled: boolean }>): Promise<T> {
    let pending!: Promise<{ value: T; settled: boolean }>;
    const { record, context } = this.lease(handle);
    this.store.transaction(() => {
      this.guardLease(handle);
      if (this.lease(handle).record.state !== "reserved") throw new AppError("already_claimed", 409);
      this.store.db.query("UPDATE leases SET state='in_flight' WHERE id=?").run(record.id);
    });
    try {
      // No await between current guards and the actual trusted send callback.
      const fences = this.guardLease(handle); pending = send(fences);
      const result = await pending;
      if (result.settled === true) this.settle(record.id);
      else { this.store.db.query("UPDATE leases SET state='unknown' WHERE id=?").run(record.id); throw new AppError("settlement_pending", 409); }
      this.guard(context);
      if (record.expiresAt <= this.now()) throw new AppError("stale_lease", 409);
      record.resources.forEach(id => this.resource(context, id, record.mode));
      return result.value;
    } catch (error) {
      this.store.db.query("UPDATE leases SET state='unknown' WHERE id=? AND state<>'settled'").run(record.id);
      throw error;
    }
  }
  private settle(id: string): void { this.store.transaction(() => { this.store.db.query("UPDATE leases SET state='settled' WHERE id=?").run(id); this.store.db.query("DELETE FROM lease_keys WHERE lease_id=?").run(id); }); }
  /** Cancelling an unused reservation is safe; dispatched/unknown work requires protected reconciliation. */
  release(handle: TeamLease): void {
    const { record } = this.lease(handle);
    if (record.state !== "reserved") throw new AppError("settlement_pending", 409);
    this.settle(record.id);
  }
  /** Protected manager callback only, after real process/input/transport settlement, never an owner/model assertion. */
  reconcileSettled(id: string, verify: (lease: Readonly<LeaseRecord>) => boolean): void {
    identity(id);
    this.store.transaction(() => {
      const row = this.store.db.query<{ state: LeaseRecord["state"]; record_json: string }, [string]>("SELECT state,record_json FROM leases WHERE id=?").get(id);
      if (!row) throw new AppError("not_found", 404);
      const record = { ...JSON.parse(row.record_json) as LeaseRecord, state: row.state };
      if (!verify(structuredClone(record))) throw new AppError("settlement_pending", 409);
      this.settle(id);
    });
  }
  /**
   * Durably binds a dispatched lease to the protected subject whose own settlement proof can later release
   * it (for example one working-VM session). Linking grants nothing; it only names what must be proven.
   */
  link(handle: TeamLease, subject: TeamLeaseSubject): void {
    const saved = this.#leases.get(handle); if (!saved) throw new AppError("stale_lease", 409);
    this.store.transaction(() => {
      const row = this.store.db.query<{ state: LeaseRecord["state"]; record_json: string }, [string]>("SELECT state,record_json FROM leases WHERE id=?").get(saved.id);
      if (!row || row.state !== "in_flight") throw new AppError("stale_lease", 409);
      this.store.db.query("UPDATE leases SET record_json=? WHERE id=?").run(canonical({ ...JSON.parse(row.record_json) as LeaseRecord, subject: structuredClone(subject) }), saved.id);
    });
  }
  /**
   * Protected reconciliation pass, including after restart: every unknown lease linked to a subject of
   * `kind` is released only when the owning service's `proven` callback observes real stop/settlement
   * proof for that exact subject. Unlinked or unproven leases stay fenced. Returns the released lease ids.
   */
  reconcileSubjects<K extends TeamLeaseSubject["kind"]>(kind: K, proven: (subject: Extract<TeamLeaseSubject, { kind: K }>) => boolean): string[] {
    const released: string[] = [];
    for (const row of this.store.db.query<{ id: string; record_json: string }, []>("SELECT id,record_json FROM leases WHERE state='unknown'").all()) {
      const subject = (JSON.parse(row.record_json) as LeaseRecord).subject;
      if (subject?.kind !== kind) continue;
      try { this.reconcileSettled(row.id, lease => lease.state === "unknown" && !!lease.subject && canonical(lease.subject) === canonical(subject) && proven(structuredClone(subject) as Extract<TeamLeaseSubject, { kind: K }>)); released.push(row.id); }
      catch (error) { if (!(error instanceof AppError) || error.code !== "settlement_pending") throw error; }
    }
    return released;
  }
  /** Retains independent valid siblings and reports precise gaps; model completion never proves completeness. */
  result(context: TeamContext, expected: { botId: string; sourceId: string | null }[]): TeamResult {
    this.guard(context); if (!expected.length || expected.length > 32) throw new AppError("output_limit");
    const sources: TeamSource[] = [], gaps: TeamResult["gaps"] = [];
    for (const item of expected) {
      identity(item.botId);
      try { if (!item.sourceId) throw new AppError("sibling_unavailable"); const source = this.source(context, item.sourceId); if (source.producer.bot.id !== item.botId) throw new AppError("sibling_unavailable"); sources.push(source); }
      catch { gaps.push({ botId: item.botId, code: "sibling_unavailable" }); }
    }
    return { contract: "s15-team-result/v1", state: gaps.length ? sources.length ? "partial" : "blocked" : "complete", sources, gaps };
  }
  /** Host shutdown must await dispatched adapters before closing current continuity state. */
  close(): void { this.store.close(); }
}
