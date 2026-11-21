import { containsCredential } from '../../security/credentials';
import type { FileSourcePin } from '../../s15/file-lineage';
import type { OwnerActor, Ref, Selection, S15PolicyService, WorkActor, WorkAuthority } from '../../s15/policy';
import type { DisclosureService } from '../../s15/disclosure';
import type { TeamService } from '../../s15/team';
import type { VmPool } from '../../s15/vm/pool';
import type { VmStore } from '../../s15/vm/store';
import type { VmSession, WorkingVmPort } from '../../s15/vm/types';
import { portableFiles, portableId, portableLimits, portablePath, portableTreeHash, type PortableFile } from '../../s15/vm/portable-protocol';
import { vmCanonical, vmFail, vmHash, vmId as validateId, vmRecord } from '../../s15/vm/validation';

/** Complete owning context, resolved from CHAT/MEM/TEAM/files and responsibility stores, never a client body. */
export interface WorkingStateSource {
  requestId: string; conversationId: string; responsibilityIds: string[]; sourceIds: string[];
  filePins: FileSourcePin[]; dataRefs: Ref[]; privateBotId: string | null;
}
/** Immutable reviewed ordinary-file package. No bytes, credential paths, endpoint or reusable actor are projected. */
export interface WorkingStateManifest {
  contract: 's16-working-state/v1'; id: string; manifestSha256: string; treeSha256: string; files: PortableFile[];
  capturedAt: number;
  compatibility: { format: 's16-working-files/v1'; scope: 'same_installation'; execution: 'unverified'; sourceBackend: 'qemu' | 'firecracker' | null; platform: { os: string; architecture: string; basis: 'guest_reported' } | null };
  source: WorkingStateSource & { vmId: string; generation: number; ownerGeneration: number; workId: string; attemptId: string; authoritySha256: string; bot: Ref; purpose: Ref; resources: Ref[]; selection: Selection };
  dataRef: Ref;
}
/** Original protected transfer receipt. Unknown is inspected, never automatically replaced or resumed. */
export interface WorkingStateImport {
  contract: 's16-working-state-import/v1'; id: string; packageId: string; manifestSha256: string; treeSha256: string;
  destination: { vmId: string; workId: string; attemptId: string; generation: number };
  state: 'accepted' | 'dispatched' | 'not_sent' | 'unknown' | 'committed'; path: string | null;
}
/** Protected owner service composition; caller JSON cannot install a lineage resolver or actor. */
export interface WorkingStateOptions {
  store: VmStore; policy: S15PolicyService; team: TeamService; disclosure: DisclosureService; pool: VmPool; vm: WorkingVmPort;
  source(owner: OwnerActor, work: WorkAuthority): WorkingStateSource;
  label?(owner: OwnerActor, work: WorkAuthority): string;
  now?: () => number;
}
/** Authenticated finite recovery directory. Retained bytes are never returned by this metadata endpoint. */
export interface WorkingStateView {
  contract: 's16-working-state-view/v1'; limits: typeof portableLimits;
  sources: { workId: string; vmId: string; label: string }[];
  packages: WorkingStateManifest[]; imports: WorkingStateImport[];
}
const same = (a: unknown, b: unknown) => vmCanonical(a) === vmCanonical(b);

/** Bounded same-installation file recovery. Work affinity, grants and native runtime sessions never move. */
export class WorkingStateService {
  readonly #inflight = new Set<string>();
  constructor(readonly options: WorkingStateOptions) {
    options.store.db.exec(`CREATE TABLE IF NOT EXISTS vm_working_packages (id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, data TEXT);
      CREATE TABLE IF NOT EXISTS vm_working_files (package_id TEXT NOT NULL,path TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(package_id,path));
      CREATE TABLE IF NOT EXISTS vm_working_imports (id TEXT PRIMARY KEY, hash TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL);`);
    // Process loss cannot restore a mutation permit. Its independently retained ancestry is never removed.
    options.store.db.exec("UPDATE vm_working_packages SET state='failed' WHERE state='capturing'");
    for (const row of options.store.db.query<{ id: string; state: string; data: string }, []>("SELECT id,state,data FROM vm_working_imports WHERE state IN ('accepted','dispatched')").all()) {
      const value = JSON.parse(row.data) as WorkingStateImport; value.state = row.state === 'accepted' ? 'not_sent' : 'unknown'; this.saveImport(value);
    }
  }
  private owner(owner: OwnerActor): void { this.options.policy.owner.current(owner, { requireUsable: true }); }
  private work(id: string): { actor: WorkActor; work: WorkAuthority } {
    validateId(id); const actor = this.options.policy.control.bindWork(id), work = this.options.policy.work.guard(actor); if (work.mode !== 'work') vmFail('outside_scope', 403); return { actor, work };
  }
  private guardSource(manifest: WorkingStateManifest, actor: WorkActor): void {
    const source = manifest.source;
    const context = this.options.team.bind(actor); source.resources.forEach(r => { const current = this.options.team.resource(context, r.id); if (!same(r, { id: current.id, revision: current.revision, generation: current.generation })) vmFail('lineage_withdrawn', 409); });
    this.options.team.verifyFiles(context, source.filePins); this.options.team.verifyData(context, source.dataRefs);
    this.options.team.ancestry(context, source.sourceIds); this.options.disclosure.lineage(actor, manifest.dataRef);
    if (source.privateBotId !== null && this.options.policy.work.guard(actor).request.bot.id !== source.privateBotId) vmFail('outside_scope', 403);
  }
  private ownerSources(owner: OwnerActor, manifest: WorkingStateManifest): void {
    this.owner(owner); const source = manifest.source;
    for (const pin of source.resources) { const current = this.options.team.currentResource(pin.id); if (!current?.active || !same(current.ref, pin)) vmFail('lineage_withdrawn', 409); }
    if (source.filePins.length && !this.options.team.options.fileLineage?.current(source.filePins) || source.sourceIds.some(id => this.options.team.isWithdrawn(id))) vmFail('lineage_withdrawn', 409);
    this.options.disclosure.ownerAncestry(owner, manifest.dataRef); for (const pin of source.dataRefs) this.options.disclosure.ownerAncestry(owner, pin);
  }
  /** Rechecked for all later computer operations; failed/unknown imports retain their source restrictions. */
  current(vmId: string, actor: object): void {
    const rows = this.options.store.db.query<{ data: string }, [string]>("SELECT data FROM vm_working_imports WHERE json_extract(data,'$.destination.vmId')=?").all(vmId);
    for (const row of rows) { const receipt = JSON.parse(row.data) as WorkingStateImport; this.guardSource(this.package(receipt.packageId), actor as WorkActor); }
  }
  private package(id: string): WorkingStateManifest {
    portableId(id); const row = this.options.store.db.query<{ state: string; data: string | null }, [string]>('SELECT state,data FROM vm_working_packages WHERE id=?').get(id);
    if (!row || row.state !== 'ready' || !row.data) vmFail('vm_portable_unavailable', 409); return JSON.parse(row.data) as WorkingStateManifest;
  }
  /** Owner metadata read, without opening a VM or returning retained bytes. */
  manifest(owner: OwnerActor, id: string): WorkingStateManifest { this.owner(owner); const value = this.package(id); this.ownerSources(owner, value); return structuredClone(value); }
  /** Current readable sources and complete packages only; unavailable lineage is withheld. Reads start nothing. */
  view(owner: OwnerActor): WorkingStateView {
    this.owner(owner); const sources: WorkingStateView['sources'] = [];
    for (const row of this.options.store.db.query<{ work_id: string; vm_id: string }, []>('SELECT work_id,vm_id FROM vm_affinity ORDER BY rowid DESC LIMIT 256').all()) {
      if (sources.length >= 64) break;
      try { const { work } = this.work(row.work_id); this.options.source(owner, work); sources.push({ workId: work.id, vmId: row.vm_id, label: (this.options.label?.(owner, work) ?? work.id).slice(0, 120) }); } catch { /* Stale authority/source bytes are withheld. */ }
    }
    const packages: WorkingStateManifest[] = [];
    for (const row of this.options.store.db.query<{ id: string }, []>("SELECT id FROM vm_working_packages WHERE state='ready' ORDER BY rowid DESC LIMIT 32").all()) { try { packages.push(this.manifest(owner, row.id)); } catch { /* Metadata does not revive withdrawn lineage. */ } }
    const ids = new Set(packages.map(p => p.id)), imports = this.options.store.db.query<{ data: string }, []>('SELECT data FROM vm_working_imports ORDER BY rowid DESC LIMIT 64').all().map(row => JSON.parse(row.data) as WorkingStateImport).filter(row => ids.has(row.packageId));
    return { contract: 's16-working-state-view/v1', limits: portableLimits, sources, packages, imports };
  }
  /** Capture exact selected files; a repeated identity returns the first complete package or its retained failure. */
  async capture(owner: OwnerActor, input: unknown): Promise<WorkingStateManifest> {
    this.owner(owner); const r = vmRecord(input, ['requestId', 'workId', 'paths']), id = portableId(r.requestId); validateId(r.workId);
    if (!Array.isArray(r.paths) || !r.paths.length || r.paths.length > portableLimits.files) vmFail('vm_portable_limit'); const paths = r.paths.map(portablePath);
    portableFiles(paths.map(path => ({ path, bytes: 0, sha256: '0'.repeat(64) }))); const hash = vmHash(vmCanonical(r));
    const old = this.options.store.db.query<{ hash: string; state: string }, [string]>('SELECT hash,state FROM vm_working_packages WHERE id=?').get(id);
    if (old) { if (old.hash !== hash) vmFail('request_id_conflict', 409); return this.manifest(owner, id); }
    const { actor, work } = this.work(r.workId as string), holder = this.options.pool.holder(work.id); if (!holder) vmFail('vm_portable_unavailable');
    const sessions = this.options.store.db.query<{ attempt_id: string }, [string, string]>('SELECT DISTINCT attempt_id FROM vm_sessions WHERE work_id=? AND vm_id=?').all(work.id, holder);
    if (sessions.length !== 1) vmFail('vm_portable_scope'); const attemptId = sessions[0]!.attempt_id, row = this.options.store.registration(holder); this.options.disclosure.vmOutput(actor, holder); const source = this.options.source(owner, work);
    const sourceGuard = () => { this.owner(owner); const current = this.work(work.id).work, vm = this.options.store.registration(holder); if (!same(current, work) || vm.generation !== row.generation || vm.state !== 'ready' || !same(this.options.source(owner, current), source)) vmFail('lineage_withdrawn', 409); };
    sourceGuard(); this.options.store.enablePortableState();
    this.options.store.transaction(() => { sourceGuard(); const count = this.options.store.db.query<{ n: number }, []>('SELECT count(*) n FROM vm_working_packages').get()!.n; if (count >= 32) vmFail('vm_portable_capacity', 423); this.options.store.db.query("INSERT INTO vm_working_packages VALUES (?,?,'capturing',NULL)").run(id, hash); });
    let session: VmSession | undefined;
    try {
      session = await this.options.vm.openAttempt(actor, { vmId: holder, workId: work.id, attemptId, guard: sourceGuard, access: 'inspect' });
      if (!session.portable) vmFail('vm_portable_unavailable'); const bytes = await session.portable.capture(paths); sourceGuard();
      const files = portableFiles(bytes.map(({ data: _data, ...file }) => file)), dataRef = { id: 'portable_' + id, revision: 1, generation: work.ownerGeneration };
      this.options.disclosure.derive(actor, dataRef, 'artifact'); await session.close(); session = undefined; sourceGuard();
      const body = { contract: 's16-working-state/v1' as const, id, treeSha256: portableTreeHash(files), files, dataRef, capturedAt: (this.options.now ?? Date.now)(),
        compatibility: { format: 's16-working-files/v1' as const, scope: 'same_installation' as const, execution: 'unverified' as const, sourceBackend: row.backend?.profile.provider ?? null, platform: row.facts ? { os: row.facts.os, architecture: row.facts.architecture, basis: 'guest_reported' as const } : null },
        source: { ...source, vmId: holder, generation: row.generation, ownerGeneration: work.ownerGeneration, workId: work.id, attemptId, authoritySha256: vmHash(vmCanonical(work)), bot: work.request.bot, purpose: work.request.purpose, resources: work.request.resources, selection: work.request.selection } };
      const manifest: WorkingStateManifest = { ...body, manifestSha256: vmHash(vmCanonical(body)) }; if (Buffer.byteLength(vmCanonical(manifest)) > 65536 || containsCredential(vmCanonical(manifest))) vmFail('vm_portable_limit');
      this.options.store.transaction(() => { sourceGuard(); this.guardSource(manifest, actor); for (const file of bytes) this.options.store.db.query('INSERT INTO vm_working_files VALUES (?,?,?)').run(id, file.path, file.data); this.options.store.db.query("UPDATE vm_working_packages SET state='ready',data=? WHERE id=?").run(vmCanonical(manifest), id); });
      return structuredClone(manifest);
    } catch (error) { this.options.store.db.query("UPDATE vm_working_packages SET state='failed' WHERE id=? AND state='capturing'").run(id); throw error; }
    finally { await session?.close(); }
  }
  private saveImport(value: WorkingStateImport): void { this.options.store.db.query('UPDATE vm_working_imports SET state=?,data=? WHERE id=?').run(value.state, vmCanonical(value), value.id); }
  /** Stored original receipt only. Unlike explicit inspection, this read opens no guest session. */
  receipt(owner: OwnerActor, id: string): WorkingStateImport {
    this.owner(owner); portableId(id); const row = this.options.store.db.query<{ data: string }, [string]>('SELECT data FROM vm_working_imports WHERE id=?').get(id); if (!row) vmFail('vm_portable_unavailable', 404);
    const value = JSON.parse(row.data) as WorkingStateImport; this.manifest(owner, value.packageId); return structuredClone(value);
  }
  /** Exact reviewed package to a fresh workspace under a new current owner-admitted copy scope. */
  async import(owner: OwnerActor, input: unknown): Promise<WorkingStateImport> {
    this.owner(owner); const r = vmRecord(input, ['requestId', 'packageId', 'manifestSha256', 'vmId']), id = portableId(r.requestId), manifest = this.manifest(owner, portableId(r.packageId)); validateId(r.vmId);
    if (r.manifestSha256 !== manifest.manifestSha256) vmFail('vm_portable_changed'); const hash = vmHash(vmCanonical(r));
    const prior = this.options.store.db.query<{ hash: string; data: string }, [string]>('SELECT hash,data FROM vm_working_imports WHERE id=?').get(id);
    if (prior) { if (prior.hash !== hash) vmFail('request_id_conflict', 409); const value = JSON.parse(prior.data) as WorkingStateImport; if (this.#inflight.has(id)) return value; return value.state === 'unknown' ? this.inspect(owner, id) : value; }
    if (this.options.store.db.query<{ n: number }, []>('SELECT count(*) n FROM vm_working_imports').get()!.n >= 64) vmFail('vm_portable_capacity', 423);
    const source = manifest.source, vmId = r.vmId as string; this.target(manifest, vmId, source.bot.id);
    this.options.store.enablePortableState();
    const policy = this.options.policy.owner.current(owner, { requireUsable: true }); if (!policy) vmFail('execution_not_authorized', 403);
    const admission = this.options.policy.owner.admit(owner, { requestId: 'working_state_' + id, intent: 'execute', access: 'reversible_write', purpose: source.purpose,
      bot: source.bot, resources: source.resources, recipients: [], selection: source.selection, selectionPin: source.selection,
      expiresAt: Math.min(policy.expiresAt, policy.budget?.expiresAt ?? policy.expiresAt, (this.options.now ?? Date.now)() + 900000) });
    if (!admission.work || admission.work.id === source.workId) vmFail('execution_not_authorized', 403);
    const { actor, work } = this.work(admission.work.id), destination = { vmId, workId: work.id, attemptId: `chat_${work.id}`, generation: this.options.store.registration(vmId).generation };
    const value: WorkingStateImport = { contract: 's16-working-state-import/v1', id, packageId: manifest.id, manifestSha256: manifest.manifestSha256, treeSha256: manifest.treeSha256, destination, state: 'accepted', path: null };
    this.guardSource(manifest, actor); this.options.team.releaseData(this.options.team.bind(actor), manifest.source.dataRefs); this.options.disclosure.inherit(actor, manifest.dataRef); this.options.disclosure.vmInput(actor, vmId);
    this.options.store.transaction(() => { this.owner(owner); this.target(manifest, vmId, work.request.bot.id); this.guardSource(manifest, actor); if (this.options.pool.holder(work.id) || this.options.store.db.query('SELECT id FROM vm_sessions WHERE work_id=?').get(work.id)) vmFail('vm_portable_scope'); this.options.pool.bind(work.id, vmId); this.options.store.db.query('INSERT INTO vm_working_imports VALUES (?,?,?,?)').run(id, hash, value.state, vmCanonical(value)); });
    this.#inflight.add(id); let session: VmSession | undefined;
    const guard = () => { this.owner(owner); this.options.policy.work.guard(actor); this.guardSource(manifest, actor); const vm = this.options.store.registration(vmId); if (vm.generation !== destination.generation || vm.state !== 'ready') vmFail('vm_fenced'); };
    try {
      value.state = 'dispatched'; this.saveImport(value); guard();
      session = await this.options.vm.openAttempt(actor, { ...destination, guard }); if (!session.portable) vmFail('vm_portable_unavailable');
      await session.portable.begin(id, manifest.files);
      for (const file of manifest.files) { guard(); const row = this.options.store.db.query<{ data: Uint8Array }, [string, string]>('SELECT data FROM vm_working_files WHERE package_id=? AND path=?').get(manifest.id, file.path); if (!row || row.data.length !== file.bytes || vmHash(row.data) !== file.sha256) vmFail('vm_portable_changed'); await session.portable.put(id, manifest.files, { ...file, data: row.data }); }
      value.path = await session.portable.commit(id, manifest.files); await session.close(); session = undefined; guard(); value.state = 'committed'; this.saveImport(value); return structuredClone(value);
    } catch (error) { value.state = 'unknown'; value.path = null; this.saveImport(value); return structuredClone(value); }
    finally { try { await session?.close(); } finally { this.#inflight.delete(id); } }
  }
  private target(manifest: WorkingStateManifest, vmId: string, botId: string): void {
    const member = this.options.pool.members().find(m => m.id === vmId), row = this.options.store.registration(vmId), scope = this.options.pool.options.scope, privateBot = scope?.privateBot(vmId) ?? null, sourcePrivate = scope?.privateBot(manifest.source.vmId) ?? null, own = scope?.assigned(botId) ?? [];
    if (!member || member.drained || row.state !== 'ready' || member.activeSessions >= member.capacity || privateBot !== null && (privateBot !== botId || !own.includes(vmId)) || own.length && !own.includes(vmId) || sourcePrivate !== null && privateBot !== sourcePrivate || manifest.source.privateBotId !== null && privateBot !== manifest.source.privateBotId) vmFail('vm_portable_scope', 403);
  }
  /** Read back only the original final subtree. Missing or partial state stays unknown, with ancestry retained. */
  async inspect(owner: OwnerActor, id: string): Promise<WorkingStateImport> {
    this.owner(owner); portableId(id); const row = this.options.store.db.query<{ data: string }, [string]>('SELECT data FROM vm_working_imports WHERE id=?').get(id); if (!row) vmFail('vm_portable_unavailable', 404);
    const value = JSON.parse(row.data) as WorkingStateImport, manifest = this.manifest(owner, value.packageId); if (value.state !== 'unknown' || this.#inflight.has(id)) return value;
    const { actor } = this.work(value.destination.workId), guard = () => { this.owner(owner); this.guardSource(manifest, actor); if (this.options.store.registration(value.destination.vmId).generation !== value.destination.generation) vmFail('vm_fenced'); };
    this.#inflight.add(id); let session: VmSession | undefined;
    try { guard(); session = await this.options.vm.openAttempt(actor, { ...value.destination, access: 'inspect', guard }); if (!session.portable) vmFail('vm_portable_unavailable'); const path = await session.portable.inspect(id, manifest.files); await session.close(); session = undefined; guard(); if (path) { value.state = 'committed'; value.path = path; this.saveImport(value); } return structuredClone(value); }
    finally { try { await session?.close(); } finally { this.#inflight.delete(id); } }
  }
}
