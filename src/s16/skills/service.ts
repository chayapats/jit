import { AppError } from "../../errors";
import { ProtectedDataStore } from "../../s15/team/store";
import { canonical, digest, equal } from "../../s15/policy/validation";
import { exact, identity, integer } from "../../s15/conversation/validation";
import type { WorkAuthority } from "../../s15/policy";
import type { SourceNetwork } from "../connections/net";
import type { SourceRecord } from "../connections/types";
import { githubSkillSource, importGithubSkill } from "./github";
import { parseSkillPackage } from "./package";
import type { SkillAvailability, SkillCommand, SkillImport, SkillOrigin, SkillPackage, SkillReceipt, SkillRecord, SkillReview, SkillUse } from "./types";

const schema = `CREATE TABLE skills(id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
CREATE TABLE packages(pin TEXT PRIMARY KEY,record_json TEXT NOT NULL);
CREATE TABLE commands(id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,owner_generation INTEGER NOT NULL,result_json TEXT NOT NULL);
CREATE TABLE pending(id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,owner_generation INTEGER NOT NULL,resolved_json TEXT);
CREATE TABLE reviews(id INTEGER PRIMARY KEY,skill_id TEXT NOT NULL,record_json TEXT NOT NULL);
CREATE TABLE uses(id TEXT PRIMARY KEY,request_id TEXT NOT NULL,work_id TEXT NOT NULL,skill_id TEXT NOT NULL,pin TEXT NOT NULL,record_json TEXT NOT NULL);`;
const fail = (code: string): never => { throw new AppError(code, 409); };
/** Protected ports; the directory never receives a host shell, service credential or model principal. */
export interface SkillDirectoryOptions<Owner> {
  path: string; installationId: string; create: boolean; now(): number; ownerGeneration(): number; requireOwner(owner: Owner): void;
  network: SourceNetwork; bots(owner: Owner): readonly { id: string; name: string }[];
  dependency(id: string): SourceRecord | null;
  /** Reconcile only exact already-reviewed resource membership; custom rules stay behind their own owner review. */
  membership(owner: Owner, requestId: string): "installed" | "unchanged" | "review_required";
}
/** Durable inert import, exact review/update/revoke and current scoped-use checks; no imported code runs here. */
export class SkillDirectory<Owner> {
  readonly store: ProtectedDataStore;
  #tail: Promise<unknown> = Promise.resolve();
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
  private receipt(requestId: string, record: SkillRecord): SkillReceipt { return { contract: "s16-skill-receipt/v1", requestId, skillId: record.id, revision: record.revision, pin: record.activePin ?? record.candidatePin, state: record.state, policy: "not_needed" }; }
  private member(owner: Owner, command: SkillCommand, receipt: SkillReceipt): SkillReceipt {
    if (!["skill.review", "skill.availability", "skill.revoke"].includes(command.kind)) return receipt;
    const current = this.get(owner, receipt.skillId);
    // A lost reply never reinstalls an old review over a later update/revocation.
    if (current.revision !== receipt.revision || (current.activePin ?? current.candidatePin) !== receipt.pin) return receipt;
    const state = this.options.membership(owner, command.requestId), result = { ...receipt, policy: state === "review_required" ? "review_required" as const : "installed" as const };
    this.owner(owner, current); this.store.db.query("UPDATE commands SET result_json=? WHERE id=?").run(canonical(result), command.requestId); return result;
  }
  /** Serialized authenticated owner ingress. Exact IDs replay receipts or resume a pinned inert import, never code. */
  command(owner: Owner, value: unknown): Promise<SkillReceipt> {
    let snapshot: unknown; try { snapshot = structuredClone(value); } catch { return Promise.reject(new AppError("invalid_body")); }
    const run = this.#tail.then(() => this.execute(owner, snapshot)); this.#tail = run.catch(() => {}); return run;
  }
  private async execute(owner: Owner, value: unknown): Promise<SkillReceipt> {
    this.owner(owner); canonical(value); const command = value as SkillCommand;
    if (command.contract !== "s16-skill-command/v1") return fail("invalid_contract"); identity(command.requestId);
    const hash = digest("s16.skills.command.v1", command), generation = this.options.ownerGeneration();
    const old = this.store.db.query<{ payload_hash: string; owner_generation: number; result_json: string }, [string]>("SELECT * FROM commands WHERE id=?").get(command.requestId);
    if (old) { if (old.payload_hash !== hash) return fail("request_id_conflict"); if (old.owner_generation !== generation) return fail("owner_changed"); return this.member(owner, command, JSON.parse(old.result_json)); }
    let record: SkillRecord | null = null;
    if (command.kind !== "skill.import") { identity(command.skillId); integer(command.expectedRevision, 1); record = this.get(owner, command.skillId); if (record.revision !== command.expectedRevision || record.state === "revoked") return fail("stale_revision"); }
    let candidate: SkillPackage | undefined;
    if (command.kind === "skill.import" || command.kind === "skill.update") {
      exact(command, ["contract", "requestId", "kind", ...(record ? ["skillId", "expectedRevision"] : []), "input"]);
      const input = command.input as SkillImport; let folder: SkillPackage | undefined;
      if (input?.kind === "folder") { exact(input, ["kind", "label", "files"]); folder = parseSkillPackage({ origin: { kind: "upload", label: input.label }, files: input.files }); }
      else { exact(input, ["kind", "url"]); if (input.kind !== "github") return fail("skill_origin_invalid"); githubSkillSource(input.url); }
      const pending = this.store.db.query<{ payload_hash: string; owner_generation: number; resolved_json: string | null }, [string]>("SELECT * FROM pending WHERE id=?").get(command.requestId);
      if (pending && (pending.payload_hash !== hash || pending.owner_generation !== generation)) return fail("request_id_conflict");
      this.store.transaction(() => { this.store.capacity(); this.store.db.query("INSERT OR IGNORE INTO pending VALUES(?,?,?,NULL)").run(command.requestId, hash, generation); });
      const guard = () => { this.owner(owner); if (generation !== this.options.ownerGeneration()) fail("owner_changed"); };
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
      exact(command, ["contract", "requestId", "kind", "skillId", "expectedRevision", "pin", "availability", "executable", "dependencies"]);
      if (command.pin !== record!.candidatePin || typeof command.executable !== "boolean") return fail("skill_pin_invalid");
      const pkg = this.package(command.pin);
      if (!pkg.units.length && !pkg.dependencies.length && !pkg.scripts.length) return fail("skill_parts_unavailable");
      if (command.executable && !pkg.scripts.length) return fail("skill_execution_unsupported");
      this.availability(owner, command.availability); this.dependencies(pkg, command.dependencies);
    } else if (command.kind === "skill.availability") {
      exact(command, ["contract", "requestId", "kind", "skillId", "expectedRevision", "availability", "executable"]);
      if (!record!.review || typeof command.executable !== "boolean") return fail("skill_review_required");
      if (command.executable && !this.package(record!.activePin!).scripts.length) return fail("skill_execution_unsupported"); this.availability(owner, command.availability);
    } else if (command.kind === "skill.revoke") exact(command, ["contract", "requestId", "kind", "skillId", "expectedRevision"]);
    else return fail("invalid_body");
    const result = this.store.transaction(() => {
      this.owner(owner, record ?? undefined); if (generation !== this.options.ownerGeneration()) fail("owner_changed"); this.store.capacity();
      const now = this.options.now();
      if (!record) { const key = digest("s16.skill.identity.v1", command.requestId).slice(0, 24); record = { contract: "s16-skill/v1", id: `sk_${key}`, revision: 0, ownerGeneration: generation, state: "needs_review", activePin: null, candidatePin: null, review: null, resource: { id: `skr_${key}`, revision: 1, generation: 1 }, source: { id: `sks_${key}`, revision: 1, generation: 1 }, createdAt: now, updatedAt: now }; }
      if (candidate) { this.store.db.query("INSERT OR IGNORE INTO packages VALUES(?,?)").run(candidate.pin, canonical(candidate)); record.candidatePin = candidate.pin; }
      if (command.kind === "skill.review") { record.activePin = command.pin; record.candidatePin = null; record.state = "active"; record.review = { pin: command.pin, availability: this.availability(owner, command.availability), executable: command.executable, dependencies: structuredClone(command.dependencies), at: now }; }
      if (command.kind === "skill.availability") record.review = { ...record.review!, availability: this.availability(owner, command.availability), executable: command.executable, at: now };
      if (command.kind === "skill.revoke") record.state = "revoked";
      if (["skill.review", "skill.availability", "skill.revoke"].includes(command.kind)) { record.resource.revision++; record.source.revision++; this.store.db.query("INSERT INTO reviews(skill_id,record_json) VALUES(?,?)").run(record.id, canonical({ revision: record.revision + 1, review: record.review, state: record.state })); }
      record.revision++; record.updatedAt = now; this.save(record); const receipt = this.receipt(command.requestId, record);
      this.store.db.query("INSERT INTO commands VALUES(?,?,?,?)").run(command.requestId, hash, generation, canonical(receipt)); this.store.db.query("DELETE FROM pending WHERE id=?").run(command.requestId); return receipt;
    });
    return this.member(owner, command, result);
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
