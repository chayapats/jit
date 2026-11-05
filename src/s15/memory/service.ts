import { AppError } from "../../errors";
import { filePins, type FileSourcePin } from "../file-lineage";
import { lexicalScore, lexicalTerms } from "../../memory/lexical";
import { digest } from "../conversation/validation";
import { ProtectedDataStore } from "../team/store";
import { canonical, content, exact, identity, ids, inScope, integer, origin, reference, scope } from "../team/validation";
import { extractMemory } from "./extract";
import { derivativeIdentity, memoryDerivativeId, memoryId } from "./identity";
import { MEMORY_SCHEMA_V1 } from "./store";
import type { ForgetImpact, MemoryOwnerIndex, MemoryUsage, MemoryCandidate, MemoryClaim, MemoryCommand, MemoryDerivative, MemoryInput, MemoryOptions, MemoryPacket, MemoryProvenance, MemoryView, OwnerActor, TeamContext } from "./types";

interface SuppressedSpan { fingerprint: string; length: number }
interface SourceRecord extends MemoryProvenance { id: string; active: boolean; withdrawnSpans?: SuppressedSpan[] }
const id = () => crypto.randomUUID().replaceAll("-", "");
const normalize = (text: string) => text.trim().toLocaleLowerCase("en").replace(/\s+/gu, " ");
const fingerprint = (text: string) => digest(normalize(text));

/**
 * Automatic sourced memory under current standing retention policy. Model extraction and retrieved
 * claims are data only. Corrections supersede, forget suppresses replay, and every derivative carries
 * conservative lineage. Fresh native contexts are retired by CHAT, never resumed as authority.
 */
export class MemoryService {
  readonly store: ProtectedDataStore;
  readonly now: () => number;
  constructor(readonly options: MemoryOptions) {
    if (options.runtime !== "s15") throw new AppError("s15_opt_in_required");
    this.now = options.now ?? Date.now;
    this.store = new ProtectedDataStore(options.path, options.installationId, options.create, 0x4a495437, MEMORY_SCHEMA_V1, !!options.team.options.fileLineage, options.team.options.fileLineage ? [1, 2, 3, 4] : [1, 3]);
  }
  private owner(actor: OwnerActor): void { this.options.team.options.policy.owner.current(actor); }
  private rows<T>(table: "sources" | "claims" | "derivatives"): T[] {
    return this.store.db.query<{ record_json: string }, []>(`SELECT record_json FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(row.record_json) as T);
  }
  private claim(claimId: string): MemoryClaim {
    identity(claimId);
    const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM claims WHERE id=?").get(claimId);
    if (!row) throw new AppError("not_found", 404); return JSON.parse(row.record_json) as MemoryClaim;
  }
  private source(sourceId: string): SourceRecord {
    const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM sources WHERE id=?").get(sourceId);
    if (!row) throw new AppError("memory_context_stale", 409); return JSON.parse(row.record_json) as SourceRecord;
  }
  private suppressed(text: string): boolean { return !!this.store.db.query("SELECT 1 FROM suppressions WHERE fingerprint=?").get(fingerprint(text)); }
  private saveClaim(claim: MemoryClaim): void { this.store.db.query("INSERT INTO claims VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET lifecycle=excluded.lifecycle,record_json=excluded.record_json").run(claim.id, claim.lifecycle, canonical(claim)); }
  private format(): number { return this.store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version; }
  private fileFormat(pins: readonly FileSourcePin[] | undefined): void { if (pins?.length) { if (!this.options.team.options.fileLineage) throw new AppError("file_memory_required", 503); this.store.db.exec(`PRAGMA user_version=${this.format() >= 3 ? 4 : 2}`); } }
  private saveSource(source: SourceRecord): void { this.fileFormat(source.filePins); this.store.db.query("INSERT INTO sources VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json").run(source.id, source.sourceHash, canonical(source)); }
  private saveDerivative(value: MemoryDerivative): void {
    const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM derivatives WHERE id=?").get(value.id);
    if (row) {
      const previous = JSON.parse(row.record_json) as MemoryDerivative;
      if (previous.kind !== value.kind || previous.workId !== value.workId || previous.state === "retired" && value.state !== "retired" || previous.claimIds.some(id => !value.claimIds.includes(id)) || previous.sourceIds.some(id => !value.sourceIds.includes(id)) || filePins(previous.filePins).some(pin => !filePins(value.filePins).some(next => canonical(next) === canonical(pin)))) throw new AppError("source_id_conflict", 409);
    }
    // Stamp inside the caller's transaction. Old prefix writers must refuse this store on rollback.
    if (value.id.startsWith("memory:")) this.store.db.exec(`PRAGMA user_version=${[2, 4].includes(this.format()) ? 4 : 3}`);
    this.fileFormat(value.filePins);
    this.store.db.query("INSERT INTO derivatives VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,record_json=excluded.record_json").run(value.id, value.state, canonical(value));
  }
  /** Access is checked before payload relevance, including transitive claims, sources and resources. */
  private accessible(context: TeamContext, claim: MemoryClaim, seen = new Set<string>(), memo = new Map<string, boolean>(), history = false): boolean {
    const known = memo.get(claim.id); if (known !== undefined) return known;
    if (seen.has(claim.id)) return false; seen.add(claim.id);
    // Cache only inside this synchronous traversal. Every new retrieval/guard must recheck current
    // authority, privacy, source withdrawal and corrections; no cached permit survives a wait.
    const check = (): boolean => {
      const work = this.options.team.guard(context), source = this.source(claim.sourceId);
      if (claim.lifecycle !== "active" || !source.active || !inScope(source.scope, work.request.bot.id)) return false;
      for (const pin of source.resources) { const current = history ? this.options.team.historyResource(context, pin.id) : this.options.team.resource(context, pin.id); if (current.revision !== pin.revision || current.generation !== pin.generation) return false; }
      if (source.filePins?.length && !this.options.team.options.fileLineage?.current(source.filePins)) return false;
      if (source.teamSourceId) { if (history) this.options.team.historyAncestry(context, [source.teamSourceId]); else this.options.team.ancestry(context, [source.teamSourceId]); }
      for (const parent of claim.dependencies) if (!this.accessible(context, this.claim(parent), seen, memo, history)) return false;
      return true;
    };
    try { const allowed = check(); memo.set(claim.id, allowed); return allowed; }
    catch { memo.set(claim.id, false); return false; }
    finally { seen.delete(claim.id); }
  }

  /**
   * Retains bounded relevant candidates without a per-claim ceremony. Trusted callers supply original
   * provenance/scope and all parent claims; every fact is grounded in exact source bytes. Historical
   * private data remains private and cannot create execution, decisions, grants or account changes.
   */
  retain(context: TeamContext, input: MemoryInput, candidates: readonly MemoryCandidate[] = extractMemory(input.text)): MemoryClaim[] {
    canonical(input); exact(input, ["id", "text", "origin", "scope", "resources", "parents", ...(input.filePins ? ["filePins"] : [])]); identity(input.id); content(input.text, 32768); origin(input.origin); scope(input.scope); ids(input.parents, 128);
    if (!Array.isArray(input.resources) || input.resources.length > 32) throw new AppError("invalid_source"); input.resources.forEach(reference);
    if (!Array.isArray(candidates) || candidates.length > 16) throw new AppError("invalid_memory_extraction");
    const work = this.options.team.guard(context), allowed = this.options.retention(work);
    if (!allowed) return [];
    scope(allowed);
    if (!inScope(input.scope, work.request.bot.id) || allowed.kind === "bot" && canonical(allowed) !== canonical(input.scope)) throw new AppError("outside_scope", 403);
    if (input.origin.kind === "historical" && (input.scope.kind !== "bot" || input.scope.origin !== "s14")) throw new AppError("private_promotion_requires_migration", 409);
    input.resources.forEach(pin => { const current = this.options.team.resource(context, pin.id); if (current.revision !== pin.revision || current.generation !== pin.generation) throw new AppError("stale_authority", 409); });
    const dependencies = input.parents.map(parent => this.claim(parent));
    dependencies.forEach(parent => { if (!this.accessible(context, parent)) throw new AppError("memory_context_stale", 409); });
    // Materialize inherited privacy/resource ceilings now so a later owner correction cannot erase
    // an uncited private ancestor merely by replacing the assertion's content.
    const effectiveScope = input.scope.kind === "bot" ? input.scope : dependencies.find(parent => parent.provenance.scope.kind === "bot")?.provenance.scope ?? input.scope;
    const resourceMap = new Map(input.resources.map(pin => [pin.id, pin]));
    const pins = filePins(input.filePins, ...dependencies.map(parent => parent.provenance.filePins)); this.options.team.verifyFiles(context, pins);
    for (const pin of pins) { const before = resourceMap.get(pin.resource.id); if (before && canonical(before) !== canonical(pin.resource)) throw new AppError("stale_authority", 409); resourceMap.set(pin.resource.id, pin.resource); }
    for (const parent of dependencies) for (const pin of parent.provenance.resources) {
      const existing = resourceMap.get(pin.id); if (existing && canonical(existing) !== canonical(pin)) throw new AppError("stale_authority", 409);
      resourceMap.set(pin.id, pin);
    }
    const effectiveResources = [...resourceMap.values()];
    const sourceHash = digest(input.text), existing = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM sources WHERE id=?").get(input.id);
    if (existing) {
      const source = JSON.parse(existing.record_json) as SourceRecord;
      if (source.sourceHash !== sourceHash || canonical(source.origin) !== canonical(input.origin) || canonical(source.scope) !== canonical(effectiveScope) || canonical(source.resources) !== canonical(effectiveResources) || canonical(filePins(source.filePins)) !== canonical(pins)) throw new AppError("source_id_conflict", 409);
      return source.active ? this.rows<MemoryClaim>("claims").filter(claim => claim.sourceId === input.id && this.accessible(context, claim)) : [];
    }
    if (this.store.db.query("SELECT 1 FROM suppressions WHERE fingerprint=?").get(sourceHash)) return [];
    const accepted: MemoryCandidate[] = [];
    for (const candidate of candidates) {
      canonical(candidate); exact(candidate, ["kind", "category", "text", "quote"]); content(candidate.text, 2048); content(candidate.quote, 2048);
      if (!["fact", "inference"].includes(candidate.kind as string) || !["fact", "preference", "working_knowledge"].includes(candidate.category as string) || !input.text.includes(candidate.quote)) throw new AppError("invalid_memory_extraction");
      // Facts cannot paraphrase an approval, exaggerate an observation or invent an owner decision.
      if (candidate.kind === "fact" && candidate.text !== candidate.quote) throw new AppError("invalid_memory_extraction");
      if (this.suppressed(candidate.text) || this.suppressed(candidate.quote)) continue;
      accepted.push({ ...structuredClone(candidate) as unknown as MemoryCandidate, kind: input.origin.kind === "work" ? "inference" : candidate.kind as MemoryCandidate["kind"] });
    }
    if (!accepted.length) return [];
    // Capture before MEM commit. A stranded protected source is inaccessible without a retained claim.
    const parents = [...new Set(input.parents.flatMap(parent => this.claim(parent).provenance.teamSourceId ?? []))];
    const captured = this.options.team.capture(context, { ...input, ...(pins.length ? { filePins: pins } : {}), text: [...new Set(accepted.map(candidate => candidate.quote))].join("\n"), scope: effectiveScope, resources: effectiveResources, parents });
    return this.store.transaction(() => {
      this.store.capacity(); this.options.team.guard(context);
      const source: SourceRecord = { id: input.id, active: true, origin: input.origin, scope: effectiveScope, resources: effectiveResources, teamSourceId: captured.id, sourceHash, ...(pins.length ? { filePins: pins } : {}) };
      this.saveSource(source);
      const retained = accepted.map(candidate => {
        const claim: MemoryClaim = { contract: "s15-memory-claim/v1", id: id(), revision: 1, ...candidate, sourceId: source.id, provenance: { origin: source.origin, scope: source.scope, resources: source.resources, teamSourceId: source.teamSourceId, sourceHash, ...(pins.length ? { filePins: pins } : {}) }, createdAt: this.now(), lifecycle: "active", confirmation: candidate.kind === "inference" || input.origin.kind === "historical" ? "unconfirmed" : input.origin.kind === "owner_message" ? "owner_stated" : "observed", supersedes: null, correction: null, dependencies: input.parents, authority: "none" };
        this.saveClaim(claim); return claim;
      });
      return retained;
    });
  }
  /** Fresh independent packet; automatic preferences can be reused without asking the owner again. */
  prepare(context: TeamContext, requestId: string, query: string, selectedFiles: readonly FileSourcePin[] = []): MemoryPacket {
    identity(requestId); content(query); this.options.team.guard(context);
    const existing = this.store.db.query("SELECT 1 FROM derivatives WHERE id=?").get(requestId);
    if (existing) throw new AppError("memory_context_stale", 409);
    const terms = lexicalTerms(query);
    const accessible = this.rows<MemoryClaim>("claims").filter(claim => this.accessible(context, claim));
    const ranked = accessible.map(claim => ({ claim, score: lexicalScore(terms, claim.text) + (claim.category === "preference" ? 3 : 0) })).filter(item => item.score >= 3).sort((a, b) => b.score - a.score || b.claim.createdAt - a.claim.createdAt);
    const claims: MemoryClaim[] = []; let bytes = 0;
    for (const { claim } of ranked) { const next = Buffer.byteLength(canonical(claim)); if (claims.length >= 16 || bytes + next > 16384) continue; bytes += next; claims.push(claim); }
    const sourceIds = [...new Set(claims.map(claim => claim.sourceId))];
    const pins = filePins(selectedFiles, ...claims.map(claim => claim.provenance.filePins)); this.options.team.verifyFiles(context, pins);
    this.store.transaction(() => {
      this.store.capacity(); claims.forEach(claim => { if (!this.accessible(context, claim)) throw new AppError("memory_context_stale", 409); });
      const workId = this.options.team.guard(context).id;
      const at = this.now();
      this.saveDerivative({ id: requestId, kind: "context", claimIds: claims.map(c => c.id), sourceIds, state: "active", text: null, workId, ...(pins.length ? { filePins: pins } : {}), at });
      this.saveDerivative({ id: memoryDerivativeId("native", requestId), kind: "native", claimIds: claims.map(c => c.id), sourceIds, state: "active", text: null, workId, ...(pins.length ? { filePins: pins } : {}), at });
    });
    return { id: requestId, claims, section: canonical({ authority: "none", claims }), retained: [] };
  }
  /** Adds actual tool-observed knowledge to the complete context lineage before its bytes reach the model. */
  include(context: TeamContext, packetId: string, claimIds: string[]): void {
    ids(claimIds, 128);
    this.store.transaction(() => {
      this.guard(context, packetId);
      for (const claimId of claimIds) if (!this.accessible(context, this.claim(claimId))) throw new AppError("memory_context_stale", 409);
      const native = memoryDerivativeId("native", packetId);
      // Existing protected packets remain readable without rekeying their persisted native row.
      const nativeId = this.store.db.query("SELECT 1 FROM derivatives WHERE id=?").get(native) ? native : memoryId(`native_${packetId}`);
      for (const derivativeId of [packetId, nativeId]) {
        const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM derivatives WHERE id=?").get(derivativeId);
        if (!row) throw new AppError("memory_context_stale", 409);
        const derivative = JSON.parse(row.record_json) as MemoryDerivative;
        if (derivative.kind !== (derivativeId === packetId ? "context" : "native")) throw new AppError("memory_context_stale", 409);
        derivative.claimIds = [...new Set([...derivative.claimIds, ...claimIds])];
        derivative.sourceIds = [...new Set([...derivative.sourceIds, ...claimIds.map(id => this.claim(id).sourceId)])];
        const pins = filePins(derivative.filePins, ...claimIds.map(id => this.claim(id).provenance.filePins)); if (pins.length) derivative.filePins = pins;
        if (derivative.claimIds.length > 128 || derivative.sourceIds.length > 128) throw new AppError("output_limit");
        this.saveDerivative(derivative);
      }
    });
  }
  /** Final context guard used before models, tools, result commit and subsequent publication. */
  guard(context: TeamContext, packetId: string): void {
    const value = this.packet(context, packetId); this.options.team.verifyFiles(context, value.filePins ?? []);
  }
  private packet(context: TeamContext, packetId: string, history = false): MemoryDerivative {
    this.options.team.guard(context); derivativeIdentity(packetId);
    const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM derivatives WHERE id=?").get(packetId);
    const value = row ? JSON.parse(row.record_json) as MemoryDerivative : null;
    if (!value || value.state !== "active" || value.claimIds.some(id => !this.accessible(context, this.claim(id), new Set(), new Map(), history)) || value.sourceIds.some(id => !this.source(id).active) || value.filePins?.length && !this.options.team.options.fileLineage?.current(value.filePins)) throw new AppError("memory_context_stale", 409);
    return value;
  }
  /** Exact metadata-only packet ancestry; it never scans unrelated files or returns private claim bytes. */
  ancestry(context: TeamContext, packetId: string): FileSourcePin[] { return filePins(this.packet(context, packetId).filePins); }
  /** A generated paraphrase cannot silently become a new source after an ancestor was forgotten or
   * corrected. Actual independent observations still use ordinary quote/hash suppression. */
  retainGeneratedFiles(context: TeamContext, packetId: string): boolean {
    const pins = this.ancestry(context, packetId); if (!pins.length) return false;
    return !this.rows<SourceRecord>("sources").some(source => source.filePins?.some(pin => pins.some(selected => canonical(selected) === canonical(pin))) && (!source.active || source.teamSourceId !== null && this.options.team.isWithdrawn(source.teamSourceId)));
  }
  /** Dedicated history check under an opaque inference context, repeated at each physical send. */
  history(context: TeamContext, packetId: string, text: string): FileSourcePin[] {
    if (!this.allowHistory(packetId, text)) throw new AppError("memory_context_stale", 409);
    const work = this.options.team.guard(context); if (work.mode !== "interpretation") throw new AppError("outside_scope", 403);
    const value = this.packet(context, packetId, true);
    const pins = filePins(value.filePins); this.options.team.verifyFiles(context, pins, true); return pins;
  }
  /** Conservative derived summaries/artifacts inherit all input claims, even when no citation is emitted. */
  derive(context: TeamContext, packetId: string, value: Pick<MemoryDerivative, "id" | "kind" | "text" | "workId">): void {
    canonical(value); exact(value, ["id", "kind", "text", "workId"]); derivativeIdentity(value.id, value.kind);
    if (!["summary", "artifact", "work"].includes(value.kind)) throw new AppError("invalid_derivative");
    if (value.text !== null) content(value.text, 32768); if (value.workId !== null) identity(value.workId);
    this.store.transaction(() => {
      this.guard(context, packetId);
      const parent = JSON.parse(this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM derivatives WHERE id=?").get(packetId)!.record_json) as MemoryDerivative;
      if (this.store.db.query("SELECT 1 FROM derivatives WHERE id=?").get(value.id)) throw new AppError("source_id_conflict", 409);
      this.store.capacity(); this.saveDerivative({ ...structuredClone(value), claimIds: parent.claimIds, sourceIds: parent.sourceIds, state: "active", ...(parent.filePins?.length ? { filePins: parent.filePins } : {}), at: this.now() });
    });
  }
  /** Derived content read always rechecks original claim/resource/private scope before returning bytes. */
  derivative(context: TeamContext, derivativeId: string): MemoryDerivative { this.guard(context, derivativeId); return JSON.parse(this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM derivatives WHERE id=?").get(derivativeId)!.record_json) as MemoryDerivative; }
  /** Ordinary CHAT history/replay cannot reintroduce forgotten/corrected source or retired summaries. */
  allowHistory(requestId: string, text: string): boolean {
    identity(requestId);
    const fingerprints = new Set(this.store.db.query<{ fingerprint: string }, []>("SELECT fingerprint FROM suppressions").all().map(row => row.fingerprint));
    const normalized = normalize(text);
    if (fingerprints.has(digest(text)) || fingerprints.has(digest(normalized))) return false;
    const covered = new Set<string>(), lengths = new Set<number>();
    for (const source of this.rows<SourceRecord>("sources")) {
      // File withdrawal is already bound precisely to packet/claim metadata. It must not turn an
      // unrelated source without MEM erasure spans into a blanket installation history hold.
      if (source.active && source.filePins?.length && !this.options.team.options.fileLineage?.current(source.filePins)) { if (source.origin.id === requestId) return false; continue; }
      if (source.active && (source.teamSourceId === null || !this.options.team.isWithdrawn(source.teamSourceId))) continue;
      // Legacy tombstones or an interrupted cross-store withdrawal cannot prove a history fragment
      // safe. Withhold history until current metadata is available; never resurrect forgotten bytes.
      if (source.origin.id === requestId || source.withdrawnSpans === undefined) return false;
      covered.add(source.sourceHash);
      for (const span of source.withdrawnSpans) { covered.add(span.fingerprint); if (fingerprints.has(span.fingerprint)) lengths.add(span.length); }
    }
    if ([...fingerprints].some(value => !covered.has(value))) return false;
    // Hash only saved normalized span lengths, including quotes embedded inside larger sentences
    // or words. Refuse excessive comparison work rather than passing unchecked history to a model.
    if ([...lengths].reduce((total, length) => total + Math.max(0, normalized.length - length + 1), 0) > 65536) return false;
    for (const length of lengths) for (let start = 0; start + length <= normalized.length; start++) {
      if (fingerprints.has(digest(normalized.slice(start, start + length)))) return false;
    }
    const row = this.store.db.query<{ state: string; record_json: string }, [string]>("SELECT state,record_json FROM derivatives WHERE id=?").get(requestId);
    const pins = row ? (JSON.parse(row.record_json) as MemoryDerivative).filePins : [];
    return row?.state !== "retired" && (!pins?.length || this.options.team.options.fileLineage?.current(pins) === true);
  }
  /** JSON claim inspection retains labels/provenance while forgotten claim/quote bytes are erased. */
  view(actor: OwnerActor): MemoryView { this.owner(actor); return { contract: "s15-memory-view/v1", claims: this.rows<MemoryClaim>("claims").map(claim => { const source = this.source(claim.sourceId), filesWithdrawn = !!source.filePins?.length && !this.options.team.options.fileLineage?.current(source.filePins); return { ...claim, ...(filesWithdrawn ? { text: "", quote: "" } : {}), sourceState: filesWithdrawn || !source.active || source.teamSourceId !== null && this.options.team.isWithdrawn(source.teamSourceId) ? "withdrawn" as const : "current" as const }; }), nativePolicy: "fresh_sessions_retire_on_close" }; }
  /**
   * Owner inspection index for client search/detail. It uses the same erasure as view(); usage counts
   * include retired lineage so the owner can see where an item was used, not only current contexts.
   */
  ownerIndex(actor: OwnerActor): MemoryOwnerIndex {
    const claims = this.view(actor).claims, usage: Record<string, MemoryUsage & { work: Set<string> }> = {};
    for (const claim of claims) usage[claim.id] = { contexts: 0, summaries: 0, artifacts: 0, workItems: 0, lastUsedAt: null, work: new Set() };
    for (const derivative of this.rows<MemoryDerivative>("derivatives")) for (const claimId of new Set(derivative.claimIds)) {
      const entry = usage[claimId]; if (!entry) continue;
      if (derivative.kind === "context") { entry.contexts++; if (typeof derivative.at === "number" && (entry.lastUsedAt === null || derivative.at > entry.lastUsedAt)) entry.lastUsedAt = derivative.at; }
      else if (derivative.kind === "summary") entry.summaries++; else if (derivative.kind === "artifact") entry.artifacts++;
      if (derivative.workId) entry.work.add(derivative.workId);
    }
    const files: MemoryOwnerIndex["files"] = {};
    for (const claim of claims) files[claim.id] = filePins(claim.provenance.filePins).map(pin => ({ sourceId: pin.source.id, sha256: pin.sha256, representationSha256: pin.representationSha256, current: this.options.team.options.fileLineage?.current([pin]) === true }));
    return { claims, files, usage: Object.fromEntries(Object.entries(usage).map(([claimId, { work, ...entry }]) => [claimId, { ...entry, workItems: work.size }])) };
  }
  private affected(root: MemoryClaim): { claims: MemoryClaim[]; sources: SourceRecord[]; derivatives: MemoryDerivative[]; impact: ForgetImpact } {
    const all = this.rows<MemoryClaim>("claims"), affected = new Set([root.id]);
    // Independently extracted copies of the exact same scoped assertion must not survive an owner
    // correction/forget and compete with its replacement in a later relevance-ranked packet.
    if (root.text) for (const claim of all) if (claim.text && fingerprint(claim.text) === fingerprint(root.text) && canonical(claim.provenance.scope) === canonical(root.provenance.scope) && canonical(claim.provenance.resources) === canonical(root.provenance.resources)) affected.add(claim.id);
    // A source-level withdrawal conservatively suppresses its sibling claims and every descendant.
    const sourceIds = new Set(all.filter(claim => affected.has(claim.id)).map(claim => claim.sourceId));
    let changed = true;
    while (changed) { changed = false; for (const claim of all) if (!affected.has(claim.id) && (sourceIds.has(claim.sourceId) || claim.dependencies.some(parent => affected.has(parent)) || claim.supersedes !== null && affected.has(claim.supersedes))) { affected.add(claim.id); sourceIds.add(claim.sourceId); changed = true; } }
    const claims = all.filter(c => affected.has(c.id)), sources = this.rows<SourceRecord>("sources").filter(s => sourceIds.has(s.id));
    const derivatives = this.rows<MemoryDerivative>("derivatives").filter(d => d.claimIds.some(c => affected.has(c)) || d.sourceIds.some(s => sourceIds.has(s)));
    const count = (kind: MemoryDerivative["kind"]) => derivatives.filter(d => d.kind === kind).length;
    return { claims, sources, derivatives, impact: { claims: claims.length, sources: sources.length, summaries: count("summary"), artifacts: count("artifact"), contexts: count("context"), nativeSessions: count("native"), workItems: new Set(derivatives.flatMap(d => d.workId ?? [])).size } };
  }
  /** Authenticated revision-bound correction/forget/impact commands; no model/tool port exposes them. */
  command(actor: OwnerActor, value: unknown): unknown {
    this.owner(actor); canonical(value);
    const isCorrection = value && typeof value === "object" && "kind" in value && value.kind === "memory.correct";
    exact(value, isCorrection ? ["contract", "requestId", "kind", "claim", "text"] : ["contract", "requestId", "kind", "claim"]);
    if (value.contract !== "s15-memory-command/v1" || !["memory.correct", "memory.forget", "memory.impact"].includes(value.kind as string)) throw new AppError("invalid_memory_command");
    identity(value.requestId); exact(value.claim, ["id", "revision"]); identity(value.claim.id); integer(value.claim.revision, 1);
    if (isCorrection) content(value.text, 2048);
    const input = value as unknown as MemoryCommand, hash = digest(canonical(input));
    const prior = this.store.db.query<{ payload_hash: string; result_json: string }, [string]>("SELECT * FROM commands WHERE id=?").get(input.requestId);
    if (prior) { if (prior.payload_hash !== hash) throw new AppError("request_id_conflict", 409); return JSON.parse(prior.result_json) as unknown; }
    const root = this.claim(input.claim.id);
    if (root.revision !== input.claim.revision) throw new AppError("stale_revision", 409);
    const affected = this.affected(root);
    if (input.kind === "memory.impact") return { contract: "s15-memory-impact/v1", claim: input.claim, impact: affected.impact };
    if (input.kind === "memory.correct" && root.lifecycle !== "active") throw new AppError("stale_revision", 409);
    // Withdraw TEAM ancestry first. A crash between stores can only withhold more data, never revive it.
    // Retry completes MEM tombstones idempotently; a team withdrawal is never rolled back.
    for (const source of affected.sources) if (source.teamSourceId) this.options.team.withdraw(actor, source.teamSourceId);
    return this.store.transaction(() => {
      this.owner(actor); this.store.capacity();
      if (this.claim(root.id).revision !== input.claim.revision) throw new AppError("stale_revision", 409);
      const replacementId = input.kind === "memory.correct" ? id() : null;
      const spansBySource = new Map<string, Map<string, SuppressedSpan>>();
      for (const claim of affected.claims) for (const text of [claim.text, claim.quote]) if (text) {
        const span = { fingerprint: fingerprint(text), length: normalize(text).length };
        let spans = spansBySource.get(claim.sourceId);
        if (!spans) { spans = new Map(); spansBySource.set(claim.sourceId, spans); }
        spans.set(span.fingerprint, span);
      }
      for (const source of affected.sources) {
        const spans = new Map((source.withdrawnSpans ?? []).map(span => [span.fingerprint, span]));
        for (const [fingerprint, span] of spansBySource.get(source.id) ?? []) spans.set(fingerprint, span);
        if (spans.size || source.withdrawnSpans !== undefined) source.withdrawnSpans = [...spans.values()];
        source.active = false; this.saveSource(source);
        this.store.db.query("INSERT OR IGNORE INTO suppressions VALUES (?,?)").run(source.sourceHash, this.now());
      }
      for (const claim of affected.claims) {
        if (claim.text) this.store.db.query("INSERT OR IGNORE INTO suppressions VALUES (?,?)").run(fingerprint(claim.text), this.now());
        if (claim.quote) this.store.db.query("INSERT OR IGNORE INTO suppressions VALUES (?,?)").run(fingerprint(claim.quote), this.now());
        claim.lifecycle = input.kind === "memory.correct" ? "superseded" : "forgotten"; claim.revision++; claim.correction = replacementId; claim.text = ""; claim.quote = ""; this.saveClaim(claim);
      }
      for (const derivative of affected.derivatives) { derivative.state = "retired"; derivative.text = null; this.saveDerivative(derivative); }
      let corrected: MemoryClaim | null = null;
      if (input.kind === "memory.correct") {
        const source: SourceRecord = { ...structuredClone(root.provenance), id: `correction_${replacementId}`, active: true, teamSourceId: null, sourceHash: digest(input.text), origin: { kind: "owner_message", id: input.requestId, conversationId: root.provenance.origin.conversationId, at: this.now() } };
        this.saveSource(source);
        corrected = { ...structuredClone(root), id: replacementId!, revision: 1, text: input.text, quote: input.text, kind: "fact", confirmation: "owner_stated", sourceId: source.id, provenance: { origin: source.origin, resources: source.resources, scope: source.scope, teamSourceId: null, sourceHash: source.sourceHash, ...(source.filePins?.length ? { filePins: source.filePins } : {}) }, lifecycle: "active", createdAt: this.now(), supersedes: root.id, correction: null, dependencies: [], authority: "none" };
        this.saveClaim(corrected);
      }
      const result = { contract: "s15-memory-receipt/v1", requestId: input.requestId, kind: input.kind, claim: corrected ? { id: corrected.id, revision: corrected.revision } : null, impact: affected.impact };
      this.store.db.query("INSERT INTO commands VALUES (?,?,?)").run(input.requestId, hash, canonical(result)); return result;
    });
  }
  /** Explicit host close after all readers/models using these contexts have retired. */
  close(): void { this.store.close(); }
}
