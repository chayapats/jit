import { AppError } from "../../errors";
import { ProtectedDataStore } from "../../s15/team/store";
import { canonical, digest, equal } from "../../s15/policy/validation";
import { exact, identity, integer } from "../../s15/conversation/validation";
import type { Ref, WorkAuthority } from "../../s15/policy";
import type { SourceNetwork } from "../connections/net";
import type { SourceRecord } from "../connections/types";
import { githubSkillSource, importGithubSkill } from "./github";
import { parseSkillPackage } from "./package";
import { skillLimits } from "./types";
import { canonicalSkill, skillCommandHash } from "./encoding";
import type { SkillAvailability, SkillCommand, SkillCommandStatus, SkillImport, SkillOrigin, SkillPackage, SkillReceipt, SkillRecord, SkillReview, SkillUse, SkillVmCopy } from "./types";

const schema = `CREATE TABLE skills(id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
CREATE TABLE packages(pin TEXT PRIMARY KEY,record_json TEXT NOT NULL);
CREATE TABLE commands(id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,owner_generation INTEGER NOT NULL,kind TEXT NOT NULL,result_json TEXT NOT NULL);
CREATE TABLE pending(id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,owner_generation INTEGER NOT NULL,resolved_json TEXT,input_json TEXT NOT NULL);
CREATE TABLE reviews(id INTEGER PRIMARY KEY,skill_id TEXT NOT NULL,record_json TEXT NOT NULL);
CREATE TABLE vm_copies(id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
CREATE TABLE uses(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,work_id TEXT NOT NULL,skill_id TEXT NOT NULL,pin TEXT NOT NULL,record_json TEXT NOT NULL);`;
const fail = (code: string): never => { throw new AppError(code, 409); };
/** Protected ports; the directory never receives a host shell, service credential or model principal. */
export interface SkillDirectoryOptions<Owner> {
  path: string; installationId: string; create: boolean; now(): number; ownerGeneration(): number; requireOwner(owner: Owner): void;
  network: SourceNetwork; bots(owner: Owner): readonly { id: string; name: string }[];
  dependency(id: string): SourceRecord | null;
  /** Current configured model recipients. Review freezes this set; later providers require another exact review. */
  recipients(): readonly Ref[];
  /** Reconcile only exact already-reviewed resource membership; custom rules stay behind their own owner review. */
  membership(owner: Owner, requestId: string): "installed" | "unchanged" | "review_required";
}
/** Durable inert import, exact review/update/revoke and current scoped-use checks; no imported code runs here. */
export class SkillDirectory<Owner> {
  readonly store: ProtectedDataStore;
  #tail: Promise<unknown> = Promise.resolve();
  readonly #queued = new Map<string, { generation: number; hash: string; count: number }>();
  readonly #active = new Set<string>();
  constructor(readonly options: SkillDirectoryOptions<Owner>) { this.store = new ProtectedDataStore(options.path, options.installationId, options.create, 0x4a49534b, schema); }
  /** Current protected records for catalog/disclosure composition; not an unguarded client endpoint. */
  records(): SkillRecord[] { return this.store.db.query<{ record_json: string }, []>("SELECT record_json FROM skills ORDER BY rowid").all().map(row => JSON.parse(row.record_json)); }
  /** Protected lookup. Public readers must authenticate and enforce the stored owner generation. */
  record(id: string): SkillRecord | null { identity(id); const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM skills WHERE id=?").get(id); return row ? JSON.parse(row.record_json) : null; }
  /** Immutable bytes for protected tooling; callers guard the exact active review before disclosure. */
  package(pin: string): SkillPackage { if (!/^[a-f0-9]{64}$/.test(pin)) return fail("skill_pin_invalid"); const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM packages WHERE pin=?").get(pin); if (!row) return fail("skill_package_missing"); return JSON.parse(row.record_json); }
  private save(record: SkillRecord): void { this.store.db.query("INSERT INTO skills VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json").run(record.id, canonical(record)); }
  private owner(owner: Owner, record?: SkillRecord): void { this.options.requireOwner(owner); if (record && record.ownerGeneration !== this.options.ownerGeneration()) fail("owner_changed"); }
  private get(owner: Owner, id: string): SkillRecord { const record = this.record(id); if (!record) return fail("not_found"); this.owner(owner, record); return record; }
  private availability(owner: Owner, value: unknown): SkillAvailability {
    const v = value as SkillAvailability;
    if (v?.kind === "team") { exact(v, ["kind"]); return { kind: "team" }; }
    exact(v, ["kind", "botIds"]);
    if (v.kind !== "bots" || !Array.isArray(v.botIds) || v.botIds.length > 64 || new Set(v.botIds).size !== v.botIds.length) return fail("skill_availability_invalid");
    const bots = new Set(this.options.bots(owner).map(bot => bot.id)); v.botIds.forEach(id => { identity(id); if (!bots.has(id)) fail("bot_unavailable"); });
    return { kind: "bots", botIds: [...v.botIds].sort() };
  }
  private dependencies(pkg: SkillPackage, bindings: SkillReview["dependencies"]): void {
    if (!bindings || typeof bindings !== "object" || Array.isArray(bindings) || !equal(Object.keys(bindings).sort(), pkg.dependencies.map(dep => dep.key).sort())) fail("skill_dependency_unavailable");
    exact(bindings, pkg.dependencies.map(dep => dep.key));
    for (const dep of pkg.dependencies) {
      const bound = bindings[dep.key]!; exact(bound, ["sourceId", "catalogHash", "reviewRevision"]); identity(bound.sourceId); integer(bound.reviewRevision, 1);
      const record = this.options.dependency(bound.sourceId);
      if (!record || record.state !== "active" || record.endpoint !== dep.endpoint || !record.catalog || !record.review || record.review.catalogHash !== record.catalog.hash || bound.catalogHash !== record.catalog.hash || bound.reviewRevision !== record.review.revision || !record.catalog.tools.some(tool => ["read", "change", "approval"].includes(record.review!.decisions[tool.name] ?? "off"))) fail("skill_dependency_unavailable");
    }
  }
  /** Exact package-only sharing preview. Dependency mapping confers no consent for other private sources. */
  recipients(owner: Owner, id: string, pin: string, bindings: SkillReview["dependencies"]): { hash: string; recipients: Ref[] } {
    const record = this.get(owner, id);
    if (pin !== record.activePin && pin !== record.candidatePin) return fail("skill_pin_invalid");
    const pkg = this.package(pin); this.dependencies(pkg, bindings);
    const values = [...this.options.recipients(), ...Object.values(bindings).map(binding => this.options.dependency(binding.sourceId)!.recipient)];
    const recipients = [...new Map(values.map(value => [canonical(value), structuredClone(value)])).values()].sort((a, b) => canonical(a).localeCompare(canonical(b)));
    return { hash: digest("s16.skill.recipients.v1", recipients), recipients };
  }
  /** Protected lookup of released copies, including copies of older or revoked package pins. */
  copies(): SkillVmCopy[] { return this.store.db.query<{ record_json: string }, []>("SELECT record_json FROM vm_copies ORDER BY rowid").all().map(row => JSON.parse(row.record_json)); }
  /** DATA15-only projection, after it validated the original admitted source. No guest/model can register custody. */
  copy(work: WorkAuthority, vmId: string, source: Ref, resource: Ref, privateBot: string | null): Ref {
    identity(vmId); const record = this.records().find(row => equal(row.source, source));
    if (!record?.activePin) return fail("skill_unavailable");
    this.guard(work, { skillId: record.id, pin: record.activePin, unitId: null, resource: record.resource });
    if (!record.review!.executable) return fail("skill_computer_use_disabled");
    if (!work.request.resources.some(value => equal(value, resource))) return fail("outside_scope");
    if (record.review!.availability.kind === "bots" && privateBot !== work.request.bot.id) return fail("skill_private_computer_required");
    if (privateBot !== null && privateBot !== work.request.bot.id) return fail("outside_scope");
    const botIds = privateBot === null ? null : [privateBot];
    const id = "skv_" + digest("s16.skill.vm-copy.v1", { source, resource, vmId, botIds, ownerGeneration: work.ownerGeneration }).slice(0, 24);
    const value: SkillVmCopy = { contract: "s16-skill-vm-copy/v1", ref: { id, revision: 1, generation: 1 }, resource: structuredClone(resource), source: structuredClone(source), skillId: record.id, pin: record.activePin, ownerGeneration: work.ownerGeneration, vmId, botIds, recipients: structuredClone(record.review!.recipients), createdAt: this.options.now() };
    return this.store.transaction(() => { this.store.capacity(); const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM vm_copies WHERE id=?").get(id);
      if (row) { const before = JSON.parse(row.record_json) as SkillVmCopy; if (!equal({ ...before, createdAt: 0 }, { ...value, createdAt: 0 })) return fail("lineage_changed"); return before.ref; }
      this.store.db.query("INSERT INTO vm_copies VALUES(?,?)").run(id, canonical(value)); return value.ref;
    });
  }
  private receipt(requestId: string, record: SkillRecord): SkillReceipt { return { contract: "s16-skill-receipt/v1", requestId, skillId: record.id, revision: record.revision, pin: record.activePin ?? record.candidatePin, state: record.state, policy: "not_needed" }; }
  private member(owner: Owner, command: Pick<SkillCommand, "kind" | "requestId">, receipt: SkillReceipt): SkillReceipt {
    if (!["skill.review", "skill.availability", "skill.revoke"].includes(command.kind)) return receipt;
    const current = this.get(owner, receipt.skillId);
    // A lost reply never reinstalls an old review over a later update/revocation.
    if (current.revision !== receipt.revision || (current.activePin ?? current.candidatePin) !== receipt.pin) return receipt;
    const state = this.options.membership(owner, command.requestId), result = { ...receipt, policy: state === "review_required" ? "review_required" as const : "installed" as const };
    this.owner(owner, current); this.store.db.query("UPDATE commands SET result_json=? WHERE id=?").run(canonical(result), command.requestId); return result;
  }
  /** Authenticated owner ingress: inert imports serialize, revocations bypass network waits. Exact IDs replay receipts or resume a pinned inert import, never code. */
  command(owner: Owner, value: unknown): Promise<SkillReceipt> {
    let snapshot: SkillCommand, generation: number, hash: string;
    try { this.owner(owner); snapshot = structuredClone(value) as SkillCommand; canonicalSkill(snapshot); identity(snapshot.requestId); generation = this.options.ownerGeneration(); hash = skillCommandHash(snapshot); }
    catch (error) { return Promise.reject(error); }
    const previous = this.#queued.get(snapshot.requestId);
    if (previous && (previous.generation !== generation || previous.hash !== hash)) return Promise.reject(new AppError("request_id_conflict", 409));
    const queued = previous ?? { generation, hash, count: 0 }; queued.count++; this.#queued.set(snapshot.requestId, queued);
    const execute = async () => {
      this.#active.add(snapshot.requestId);
      try { return await this.execute(owner, snapshot, generation); }
      finally { this.#active.delete(snapshot.requestId); if (--queued.count === 0) this.#queued.delete(snapshot.requestId); }
    };
    // Revocation commits its fence immediately, even while an unrelated network import is waiting.
    // Import guards below re-read the record so an older in-flight update cannot restore revoked state.
    const run = snapshot.kind === "skill.revoke" ? execute() : this.#tail.then(execute);
    this.#tail = Promise.allSettled([this.#tail, run]).then(() => undefined); return run;
  }
  private async execute(owner: Owner, value: unknown, generation: number): Promise<SkillReceipt> {
    this.owner(owner); if (generation !== this.options.ownerGeneration()) return fail("owner_changed"); canonicalSkill(value); const command = value as SkillCommand;
    if (command.contract !== "s16-skill-command/v1") return fail("invalid_contract"); identity(command.requestId);
    const hash = skillCommandHash(command);
    const old = this.store.db.query<{ payload_hash: string; owner_generation: number; result_json: string }, [string]>("SELECT * FROM commands WHERE id=?").get(command.requestId);
    if (old) { if (old.payload_hash !== hash) return fail("request_id_conflict"); if (old.owner_generation !== generation) return fail("owner_changed"); return this.member(owner, command, JSON.parse(old.result_json)); }
    let record: SkillRecord | null = null;
    if (command.kind !== "skill.import") { identity(command.skillId); integer(command.expectedRevision, 1); record = this.get(owner, command.skillId); if (record.revision !== command.expectedRevision || record.state === "revoked") return fail("stale_revision"); }
    let candidate: SkillPackage | undefined, sharing: { hash: string; recipients: Ref[] } | undefined;
    if (command.kind === "skill.import" || command.kind === "skill.update") {
      exact(command, ["contract", "requestId", "kind", ...(record ? ["skillId", "expectedRevision"] : []), "input"]);
      const input = command.input as SkillImport; let folder: SkillPackage | undefined;
      if (input?.kind === "folder") { exact(input, ["kind", "label", "files"]); folder = parseSkillPackage({ origin: { kind: "upload", label: input.label }, files: input.files }); }
      else { exact(input, ["kind", "url"]); if (input.kind !== "github") return fail("skill_origin_invalid"); githubSkillSource(input.url); }
      const pending = this.store.db.query<{ payload_hash: string; owner_generation: number; resolved_json: string | null }, [string]>("SELECT * FROM pending WHERE id=?").get(command.requestId);
      if (pending && (pending.payload_hash !== hash || pending.owner_generation !== generation)) return fail("request_id_conflict");
      this.store.transaction(() => { this.store.capacity(); this.store.db.query("INSERT OR IGNORE INTO pending VALUES(?,?,?,NULL,?)").run(command.requestId, hash, generation, canonicalSkill(command)); });
      const guard = () => { this.owner(owner); if (generation !== this.options.ownerGeneration()) fail("owner_changed"); if (record) { const current = this.get(owner, record.id); if (current.revision !== record.revision || current.state === "revoked") fail("stale_revision"); } };
      if (folder) candidate = folder;
      else {
        const frozen = pending?.resolved_json ? JSON.parse(pending.resolved_json) as Extract<SkillOrigin, { kind: "github" }> : null;
        const url = frozen ? `https://github.com/${frozen.repository}/tree/${frozen.commit}${frozen.folder ? "/" + frozen.folder.split("/").map(encodeURIComponent).join("/") : ""}` : (input as Extract<SkillImport, { kind: "github" }>).url;
        candidate = await importGithubSkill(url, { network: this.options.network, guard, now: this.options.now, resolved: origin => {
          guard(); if (frozen && !equal(frozen, origin)) fail("skill_pin_invalid");
          this.store.db.query("UPDATE pending SET resolved_json=? WHERE id=?").run(canonical(origin), command.requestId);
        } });
      }
      guard();
    } else if (command.kind === "skill.review") {
      exact(command, ["contract", "requestId", "kind", "skillId", "expectedRevision", "pin", "availability", "executable", "dependencies", "recipientsHash"]);
      if (command.pin !== (record!.candidatePin ?? record!.activePin) || typeof command.executable !== "boolean") return fail("skill_pin_invalid");
      const pkg = this.package(command.pin);
      if (!pkg.units.length && !pkg.dependencies.length && !pkg.scripts.length) return fail("skill_parts_unavailable");
      this.availability(owner, command.availability); this.dependencies(pkg, command.dependencies);
      sharing = this.recipients(owner, record!.id, command.pin, command.dependencies); if (command.recipientsHash !== sharing.hash) return fail("skill_recipients_changed");
    } else if (command.kind === "skill.availability") {
      exact(command, ["contract", "requestId", "kind", "skillId", "expectedRevision", "availability", "executable", "recipientsHash"]);
      if (!record!.review || typeof command.executable !== "boolean") return fail("skill_review_required");
      this.availability(owner, command.availability);
      sharing = this.recipients(owner, record!.id, record!.activePin!, record!.review!.dependencies); if (command.recipientsHash !== sharing.hash) return fail("skill_recipients_changed");
    } else if (command.kind === "skill.revoke") exact(command, ["contract", "requestId", "kind", "skillId", "expectedRevision"]);
    else return fail("invalid_body");
    const result = this.store.transaction(() => {
      this.owner(owner, record ?? undefined); if (generation !== this.options.ownerGeneration()) fail("owner_changed"); this.store.capacity();
      const now = this.options.now();
      if (!record && this.records().length >= skillLimits.packages) return fail("skill_capacity");
      if (!record) { const key = digest("s16.skill.identity.v1", command.requestId).slice(0, 24); record = { contract: "s16-skill/v1", id: `sk_${key}`, revision: 0, ownerGeneration: generation, state: "needs_review", activePin: null, candidatePin: null, review: null, resource: { id: `skr_${key}`, revision: 1, generation: 1 }, source: { id: `sks_${key}`, revision: 1, generation: 1 }, createdAt: now, updatedAt: now }; }
      if (candidate) { this.store.db.query("INSERT OR IGNORE INTO packages VALUES(?,?)").run(candidate.pin, canonicalSkill(candidate)); record.candidatePin = candidate.pin === record.activePin ? null : candidate.pin; if (command.kind === "skill.import" || command.kind === "skill.update") record.importSource = command.input.kind === "github" ? { kind: "github", url: command.input.url } : { kind: "folder", label: command.input.label }; }
      if (command.kind === "skill.review") { record.activePin = command.pin; record.candidatePin = null; record.state = "active"; record.review = { recipientsHash: sharing!.hash, recipients: sharing!.recipients, pin: command.pin, availability: this.availability(owner, command.availability), executable: command.executable, dependencies: structuredClone(command.dependencies), at: now }; }
      if (command.kind === "skill.availability") record.review = { ...record.review!, recipientsHash: sharing!.hash, recipients: sharing!.recipients, availability: this.availability(owner, command.availability), executable: command.executable, at: now };
      if (command.kind === "skill.revoke") record.state = "revoked";
      if (["skill.review", "skill.availability", "skill.revoke"].includes(command.kind)) { record.resource.revision++; record.source.revision++; this.store.db.query("INSERT INTO reviews(skill_id,record_json) VALUES(?,?)").run(record.id, canonical({ revision: record.revision + 1, review: record.review, state: record.state })); }
      record.revision++; record.updatedAt = now; this.save(record); const receipt = this.receipt(command.requestId, record);
      if (["skill.review", "skill.availability", "skill.revoke"].includes(command.kind)) receipt.policy = "review_required";
      this.store.db.query("INSERT INTO commands VALUES(?,?,?,?,?)").run(command.requestId, hash, generation, command.kind, canonical(receipt)); this.store.db.query("DELETE FROM pending WHERE id=?").run(command.requestId); return receipt;
    });
    return this.member(owner, command, result);
  }
  /** Fresh identity-only recovery read. It never resumes an import or applies resource membership. */
  status(owner: Owner, requestId: string): SkillCommandStatus {
    this.owner(owner); identity(requestId); const generation = this.options.ownerGeneration();
    const done = this.store.db.query<{ owner_generation: number; result_json: string }, [string]>("SELECT owner_generation,result_json FROM commands WHERE id=?").get(requestId);
    if (done) { if (done.owner_generation !== generation) return fail("owner_changed"); return { contract: "s16-skill-command-status/v1", requestId, state: "complete", receipt: JSON.parse(done.result_json) }; }
    const pending = this.store.db.query<{ owner_generation: number }, [string]>("SELECT owner_generation FROM pending WHERE id=?").get(requestId);
    if (pending) { if (pending.owner_generation !== generation) return fail("owner_changed"); return { contract: "s16-skill-command-status/v1", requestId, state: this.#active.has(requestId) ? "importing" : "interrupted" }; }
    const queued = this.#queued.get(requestId); if (!queued) return fail("not_found"); if (queued.generation !== generation) return fail("owner_changed");
    return { contract: "s16-skill-command-status/v1", requestId, state: "queued" };
  }
  /** Explicit authenticated recovery of the original inert import or already-committed exact membership action. */
  async resume(owner: Owner, requestId: string): Promise<SkillReceipt> {
    this.owner(owner); identity(requestId); const generation = this.options.ownerGeneration();
    const done = this.store.db.query<{ owner_generation: number; kind: SkillCommand["kind"]; result_json: string }, [string]>("SELECT owner_generation,kind,result_json FROM commands WHERE id=?").get(requestId);
    if (done) { if (done.owner_generation !== generation) return fail("owner_changed"); return this.member(owner, { kind: done.kind, requestId }, JSON.parse(done.result_json)); }
    const pending = this.store.db.query<{ owner_generation: number; input_json: string }, [string]>("SELECT owner_generation,input_json FROM pending WHERE id=?").get(requestId);
    if (!pending) return fail("not_found"); if (pending.owner_generation !== generation) return fail("owner_changed");
    return this.command(owner, JSON.parse(pending.input_json));
  }
  /** Authenticated preview, including candidate bytes; never a model/source route. */
  detail(owner: Owner, id: string): { record: SkillRecord; active: SkillPackage | null; candidate: SkillPackage | null } {
    const record = this.get(owner, id); return { record, active: record.activePin ? this.package(record.activePin) : null, candidate: record.candidatePin ? this.package(record.candidatePin) : null };
  }
  /** Caller separately reacquires POLICY/TEAM/DATA15; this check only narrows the exact imported-data dependency. */
  guard(work: WorkAuthority, use: SkillUse): SkillRecord {
    if (work.mode !== "work") return fail("outside_scope");
    const record = this.record(use.skillId);
    if (!record || record.ownerGeneration !== work.ownerGeneration || record.ownerGeneration !== this.options.ownerGeneration() || record.state !== "active" || !record.review || record.activePin !== use.pin || !equal(record.resource, use.resource)) return fail("skill_unavailable");
    if (!work.request.resources.some(resource => equal(resource, record.resource)) || record.review.availability.kind === "bots" && !record.review.availability.botIds.includes(work.request.bot.id)) return fail("outside_scope");
    const pkg = this.package(use.pin); if (use.unitId !== null && !pkg.units.some(unit => unit.id === use.unitId)) return fail("skill_unit_unavailable");
    this.dependencies(pkg, record.review.dependencies);
    for (const dep of Object.values(record.review.dependencies)) { const source = this.options.dependency(dep.sourceId)!; if (!work.request.resources.some(resource => equal(resource, source.resource))) return fail("skill_dependency_outside_scope"); }
    return record;
  }
  /** Retained provenance after the owning CHAT dependency has been persisted, before its bytes are released. */
  used(work: WorkAuthority, requestId: string, use: SkillUse): void {
    identity(requestId); this.guard(work, use); const id = crypto.randomUUID().replaceAll("-", "");
    this.store.transaction(() => { this.store.capacity(); this.store.db.query("INSERT INTO uses VALUES(?,?,?,?,?,?)").run(id, requestId, work.id, use.skillId, use.pin, canonical({ ...use, at: this.options.now() })); });
  }
  /** Wait for inert import commands before closing the protected store; no execution worker exists here. */
  async close(): Promise<void> { await this.#tail; this.store.close(); }
}
