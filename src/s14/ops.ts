import { reconcileOnlineBackups } from "./backups";
import { existingResourceCeilings } from "./scope-options";
import { Database } from "bun:sqlite";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { SNAPSHOT_NATIVE_FORMAT_VERSION } from "schway/host";
import { AppError } from "../errors";
import { S14Application, type S14Options } from "./application";
import { S14Store, inspectS14Store, s14SchemaVersion } from "./store";
import { acquireS14RuntimeLock } from "./runtime-lock";
import { canonical, digest, exact, identity, integer } from "./validation";
import type { OwnerActor } from "./types";
import type { NativeIntent } from "./recovery-types";
import { opsAtomic, opsDirectory, opsPath, opsRead, opsRename, opsSyncDirectory, opsWrite } from "./ops-files";
import { imageArtifacts, inspectOpsImage, opsHash, opsLedger, opsSchema, opsLiveHash, opsManagedHash, verifyOpsLedgerPosition } from "./ops-image";
import { nativeSessionDirectory, opsRoot, readS14Ops } from "./ops-state";
import { managedBackupContract, opsLimits, restoreActivationContract, type ManagedBackupManifest, type OpsCommand, type OpsControl, type OpsNativePort, type OpsReceipt, type OpsStage } from "./ops-types";
import { validateOpsSnapshot } from "./ops-native";
import { assertS14BackupQuiescent, captureS14Backup } from "./ops-capture";
import { reconcileOpsComputers, reconcileOpsImage } from "./ops-reconcile";

/** Deterministic crash boundaries; production maintenance supplies no injection hook. */
export type OpsFault = "image_captured" | "native_captured" | "manifest_committed" | "candidate_imported" | "candidate_reconciled" | "activation_intent" | "application_renamed" | "native_pointer_written";
/** Owner-authenticated offline maintenance with one OS lock and an independent durable boot fence. */
export class S14Maintenance {
  readonly root: string;
  readonly nativeRoot: string;
  readonly control: OpsControl;
  store: S14Store;
  app: S14Application;
  readonly options: S14Options;
  #release: () => void;
  #closed = false;
  #busy = false;
  constructor(readonly path: string, options: S14Options, readonly native: OpsNativePort, readonly fault?: (point: OpsFault) => void) {
    opsPath(path);
    if (inspectS14Store(path) !== "s14") throw new AppError("s14_ops_existing_store_required", 409);
    opsPath(`${path}.lifecycle.sqlite`);
    if (!existsSync(`${path}.lifecycle.sqlite`)) throw new AppError("s14_lifecycle_ledger_unavailable", 503);
    this.root = opsRoot(path);
    this.nativeRoot = join(dirname(path), "native");
    opsPath(`${path}.runtime-lock.sqlite`);
    this.#release = acquireS14RuntimeLock(path);
    let opened: S14Store | undefined;
    try {
      reconcileOnlineBackups(path);
      this.control = readS14Ops(path);
      opened = new S14Store(path, {});
      this.store = opened;
      this.store.read(opsLedger);
      this.options = { ...options, policy: { ...options.policy, resources: [...new Set([...this.store.read(existingResourceCeilings), ...options.policy.resources])] } };
      this.app = new S14Application(this.store, this.options);
    } catch (error) { opened?.close(); this.#release(); throw error; }
  }
  /** Releases only the process lock; unfinished operations deliberately retain their durable boot fence. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.store.close();
    this.#release();
  }
  /** Returns sanitized owner metadata, never image bytes, paths, credentials or native payloads. */
  status(actor: OwnerActor): { revision: number; backups: string[]; pendingBackupId: string | null; stage: Omit<OpsStage, "nativeDirectory" | "priorNativeDirectory"> | null; workers: "fenced" | "stopped" } {
    this.store.read(tx => this.app.requireOwner(tx, actor));
    const stage = this.control.stage;
    const publicStage = stage ? (({ nativeDirectory: _n, priorNativeDirectory: _p, ...rest }) => rest)(stage) : null;
    return { revision: this.control.revision, backups: [...this.control.backups], pendingBackupId: this.control.pendingBackupId, stage: publicStage, workers: existsSync(this.fencePath()) ? "fenced" : "stopped" };
  }
  private fencePath(): string { return join(this.root, "fence.json"); }
  private persist(): void { opsAtomic(join(this.root, "control.json"), this.control); }
  private fence(id: string): void {
    opsDirectory(this.root);
    if (existsSync(this.fencePath())) {
      const fence = JSON.parse(opsRead(this.fencePath(), 4096).toString()) as { id: string };
      if (fence.id !== id) throw new AppError("s14_ops_in_progress", 409);
    } else opsWrite(this.fencePath(), JSON.stringify({ contract: restoreActivationContract, id }));
  }
  private unfence(): void {
    rmSync(this.fencePath());
    opsSyncDirectory(this.root);
  }
  private stageDirectory(id: string): string { identity(id); return join(this.root, "stages", id); }
  private archiveDirectory(id: string): string { identity(id); return join(this.root, "backups", id); }
  private nativeSupported(): void { if (!this.native.supported()) throw new AppError("s14_ops_native_unsupported", 409); }
  private intents(store = this.store): NativeIntent[] {
    return store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM native_intents ORDER BY id").map(row => JSON.parse(row.record_json)));
  }
  private async nativeDigest(intents: NativeIntent[], directory: string): Promise<string> {
    this.nativeSupported();
    const entries: unknown[] = [];
    let count = 0;
    for (const intent of intents) {
      const host = await this.native.open(intent, directory);
      try {
        const inventory = [];
        let after: string | undefined;
        const cursors = new Set<string>();
        do {
          const page = await host.listSessions({ limit: 64, ...(after ? { after } : {}) });
          count += page.sessions.length;
          if (count > opsLimits.native || page.next && cursors.has(page.next)) throw new AppError("s14_ops_native_bound", 409);
          inventory.push(...page.sessions);
          after = page.next;
          if (after) cursors.add(after);
        } while (after);
        if (intent.state === "retired" && intent.reference) {
          const snapshot = await host.snapshotSessions([intent.reference]);
          validateOpsSnapshot(host, snapshot, intent);
          if (!snapshot.sessions.every(session => session.retired)) throw new AppError("s14_ops_native_unsettled", 409);
          entries.push({ id: intent.id, inventory, sessions: snapshot.sessions });
        } else {
          if (!["deleted", "not_created"].includes(intent.state) || inventory.some(session => session.state !== "deleted")) throw new AppError("s14_ops_native_unsettled", 409);
          entries.push({ id: intent.id, inventory });
        }
      } finally { await host.close(); }
    }
    return opsHash(JSON.stringify(entries));
  }
  private preflight(): void { assertS14BackupQuiescent(this.store, this.native); }
  private verifyFile(directory: string, component: ManagedBackupManifest["image"]): Buffer {
    exact(component, ["name", "size", "sha256"]);
    if (!/^(application\.sqlite|native-[0-9]{1,4}\.json)$/.test(component.name)) throw new AppError("s14_ops_component_path", 409);
    integer(component.size, 1, opsLimits.bytes);
    if (!/^[a-f0-9]{64}$/.test(component.sha256)) throw new AppError("s14_ops_integrity_failed", 409);
    const bytes = opsRead(join(directory, component.name), component.size);
    if (bytes.length !== component.size || opsHash(bytes) !== component.sha256) throw new AppError("s14_ops_integrity_failed", 409);
    return bytes;
  }
  private manifest(id: string): ManagedBackupManifest {
    if (!this.control.backups.includes(id)) throw new AppError("s14_ops_backup_not_found", 404);
    const directory = this.archiveDirectory(id);
    const value = JSON.parse(opsRead(join(directory, "manifest.json"), opsLimits.journalBytes).toString()) as ManagedBackupManifest;
    exact(value, ["contract", "format", "schema", "build", "id", "installationId", "createdAt", "state", "ledger", "ledgerPosition", "nativeContract", "nativeFormat", "image", "native", "artifacts", "credentials"]);
    if (value.contract !== managedBackupContract || value.format !== "jit.s14/v1" || value.schema !== s14SchemaVersion || value.build !== "jit/0.1.0" || value.id !== id || value.state !== "complete" || value.credentials !== "excluded_reconnect_required" ||
        value.nativeContract !== "schway.host.session-snapshot/v1" || value.nativeFormat !== SNAPSHOT_NATIVE_FORMAT_VERSION) throw new AppError("s14_ops_version_unsupported", 409);
    if (value.installationId !== this.store.read(tx => tx.get<{ id: string }>("SELECT id FROM memory_identity")!.id)) throw new AppError("s14_ops_foreign_installation", 409);
    if (!Array.isArray(value.native) || value.native.length > opsLimits.native || !Array.isArray(value.artifacts) || value.artifacts.length > opsLimits.rows) throw new AppError("s14_ops_bounds_or_type", 409);
    this.nativeSupported();
    verifyOpsLedgerPosition(this.store, value.ledgerPosition);
    const image = this.verifyFile(directory, value.image);
    if (value.image.name !== "application.sqlite") throw new AppError("s14_ops_component_path", 409);
    inspectOpsImage(image, this.store.read(opsSchema));
    let size = image.length;
    const ids = new Set<string>();
    for (const [index, entry] of value.native.entries()) {
      exact(entry, ["intentId", "component"]);
      identity(entry.intentId);
      if (ids.has(entry.intentId) || entry.component.name !== `native-${index}.json`) throw new AppError("s14_ops_native_inventory_invalid", 409);
      ids.add(entry.intentId);
      size += this.verifyFile(directory, entry.component).length;
      if (size > opsLimits.bytes) throw new AppError("s14_ops_backup_too_large", 409);
    }
    return value;
  }
  private async capture(id: string): Promise<ManagedBackupManifest> {
    if (this.control.backups.length >= opsLimits.backups) throw new AppError("s14_ops_retention_full", 409);
    const manifest = await captureS14Backup(this.app, this.native, id, this.fault ? { fault: this.fault } : {});
    this.control.backups.push(id);
    this.persist();
    return manifest;
  }
  /** Executes a strict typed owner maintenance command; failures never include transport text or secret bytes. */
  async execute(actor: OwnerActor, command: OpsCommand): Promise<OpsReceipt> {
    if (this.#busy || this.#closed) throw new AppError("s14_ops_in_progress", 409);
    exact(command, ["kind", "requestId", "expectedRevision", "payload"]);
    identity(command.requestId); integer(command.expectedRevision);
    const fields: Record<OpsCommand["kind"], string[]> = { "backup.create": [], "restore.prepare": ["backupId"], "upgrade.prepare": ["targetSchema"], "restore.validate": ["stageId"], "restore.discard": ["stageId"], "upgrade.rollback": ["stageId"], "restore.activate": ["stageId", "actionHash"] };
    if (!Object.hasOwn(fields, command.kind)) throw new AppError("s14_ops_command_invalid");
    exact(command.payload, fields[command.kind]);
    this.store.read(tx => this.app.requireOwner(tx, actor));
    const hash = digest(canonical(command));
    const prior = this.control.receipts.find(r => r.requestId === command.requestId);
    if (prior) {
      if (prior.hash !== hash) throw new AppError("request_id_conflict", 409);
      if (["complete", "discarded"].includes(prior.result.state) && existsSync(this.fencePath())) {
        const fence = JSON.parse(opsRead(this.fencePath(), 4096).toString()) as { id: string };
        if (fence.id === (prior.result.stage?.id ?? prior.result.backupId)) this.unfence();
      }
      return structuredClone(prior.result);
    }
    if (command.expectedRevision !== this.control.revision) throw new AppError("stale_revision", 409);
    const terminal = ["backup.create", "restore.activate", "restore.discard", "upgrade.rollback"].includes(command.kind);
    if (this.control.receipts.length >= 100 || this.control.receipts.length >= 99 && !terminal) throw new AppError("s14_ops_receipt_bound", 409);
    this.#busy = true;
    try {
      const result = await this.apply(command);
      this.control.revision++;
      result.revision = this.control.revision;
      this.control.receipts.push({ requestId: command.requestId, hash, result: structuredClone(result) });
      this.persist();
      if (["complete", "discarded"].includes(result.state) && existsSync(this.fencePath())) this.unfence();
      return result;
    } finally { this.#busy = false; }
  }
  private result(command: OpsCommand, state: OpsReceipt["state"], reason: string | null = null): OpsReceipt {
    return { requestId: command.requestId, revision: this.control.revision, state, reason, workers: state === "complete" || state === "discarded" ? "stopped" : "fenced", reconnectionRequired: true };
  }
  private async apply(command: OpsCommand): Promise<OpsReceipt> {
    const current = this.control.stage;
    if (command.kind === "backup.create" || command.kind === "restore.prepare" || command.kind === "upgrade.prepare") {
      if (existsSync(this.fencePath())) throw new AppError("s14_ops_in_progress", 409);
      if (command.kind === "upgrade.prepare" && command.payload.targetSchema !== s14SchemaVersion) throw new AppError("s14_ops_version_unsupported", 409);
      const manifest = command.kind === "restore.prepare" ? this.manifest(command.payload.backupId) : null;
      this.preflight();
      const id = crypto.randomUUID().replaceAll("-", "");
      this.fence(id);
      if (command.kind === "backup.create") {
        this.control.pendingBackupId = id;
        this.persist();
        try { await this.capture(id); this.control.pendingBackupId = null; return { ...this.result(command, "complete"), backupId: id }; }
        catch (error) { this.control.pendingBackupId = null; this.persist(); this.unfence(); throw error; }
      }
      const stage: OpsStage = { id, mode: command.kind === "upgrade.prepare" ? "upgrade" : "restore", backupId: manifest?.id ?? id,
        state: "preparing", reason: null, candidateHash: null, liveHash: opsLiveHash(this.store), ledger: this.store.read(opsLedger), actionHash: null, priorHash: null, targetHash: null, activationHash: null,
        nativeDigest: null, nativeDirectory: join(this.stageDirectory(id), "native-sessions"), priorNativeDirectory: nativeSessionDirectory(this.nativeRoot), recoveryBackupId: id };
      this.control.stage = stage;
      this.persist();
      try {
        await this.capture(id); // A credential-free consistent recovery point, with native snapshots, before staging.
        const source = manifest ?? this.manifest(id);
        stage.backupId = source.id;
        opsDirectory(this.stageDirectory(id));
        opsWrite(join(this.stageDirectory(id), "candidate.sqlite"), this.verifyFile(this.archiveDirectory(source.id), source.image));
        this.fault?.("candidate_imported");
        return await this.validate(command, stage);
      } catch (error) {
        stage.state = "blocked";
        stage.reason = error instanceof AppError ? error.code : "s14_ops_stage_interrupted";
        this.persist();
        throw error;
      }
    }
    if (command.kind === "restore.discard" && this.control.pendingBackupId === command.payload.stageId) {
      this.fence(command.payload.stageId);
      if (!this.control.backups.includes(command.payload.stageId)) rmSync(this.archiveDirectory(command.payload.stageId), { recursive: true, force: true });
      this.control.pendingBackupId = null;
      return this.result(command, "discarded");
    }
    if (!current || current.id !== command.payload.stageId) throw new AppError("s14_ops_stage_not_found", 404);
    this.fence(current.id);
    if (command.kind === "restore.discard" || command.kind === "upgrade.rollback") {
      if (["activating", "complete"].includes(current.state)) throw new AppError("s14_ops_use_quarantined_restore_for_rollback", 409);
      current.state = "discarded";
      current.reason = null;
      opsPath(this.stageDirectory(current.id));
      rmSync(this.stageDirectory(current.id), { recursive: true, force: true });
      return { ...this.result(command, "discarded"), stage: this.publicStage(current) };
    }
    if (command.kind === "restore.validate") return this.validate(command, current);
    return this.activate(command, current);
  }
  private publicStage(stage: OpsStage): OpsStage {
    // Public receipts retain field shape without exposing service filesystem locations.
    return { ...structuredClone(stage), nativeDirectory: "[service-owned]", priorNativeDirectory: "[service-owned]" };
  }
  private async validate(command: OpsCommand, stage: OpsStage): Promise<OpsReceipt> {
    if (["activating", "complete", "discarded"].includes(stage.state)) throw new AppError("s14_ops_stage_state", 409);
    let candidate: S14Store | undefined;
    try {
      const manifest = this.manifest(stage.backupId), path = join(this.stageDirectory(stage.id), "candidate.sqlite");
      const original = this.verifyFile(this.archiveDirectory(manifest.id), manifest.image);
      if (existsSync(path)) rmSync(path);
      opsWrite(path, original);
      opsPath(stage.nativeDirectory);
      rmSync(stage.nativeDirectory, { recursive: true, force: true });
      inspectOpsImage(opsRead(path, opsLimits.bytes), this.store.read(opsSchema));
      candidate = new S14Store(path, { lifecyclePath: `${this.path}.lifecycle.sqlite` });
      const artifacts = imageArtifacts(candidate);
      if (JSON.stringify(artifacts) !== JSON.stringify(manifest.artifacts)) throw new AppError("s14_ops_artifact_inventory_invalid", 409);
      candidate.transaction(tx => {
        const generation = this.store.read(live => live.get<{ generation: number }>("SELECT generation FROM owner")!.generation);
        tx.run("UPDATE owner SET generation=?", generation);
      });
      reconcileOpsComputers(this.store, candidate);
      const candidateApp = new S14Application(candidate, this.options);
      const intents = this.intents(candidate);
      const wanted = intents.filter(intent => !["deleted", "not_created"].includes(intent.state));
      if (wanted.some(intent => !manifest.native.some(entry => entry.intentId === intent.id))) throw new AppError("s14_ops_native_inventory_invalid", 409);
      opsDirectory(stage.nativeDirectory);
      for (const entry of manifest.native) {
        const intent = intents.find(i => i.id === entry.intentId)!;
        const snapshot: unknown = JSON.parse(this.verifyFile(this.archiveDirectory(manifest.id), entry.component).toString());
        const host = await this.native.open(intent, stage.nativeDirectory);
        try {
          validateOpsSnapshot(host, snapshot, intent);
          const restored = await host.restoreSessionSnapshot(snapshot);
          if (restored.status !== "restored") {
            stage.state = restored.status === "partial" ? "partial" : "blocked";
            throw new AppError(restored.status === "partial" ? "s14_ops_native_partial" : "s14_ops_native_quarantined", 409);
          }
        } finally { await host.close(); }
      }
      reconcileOpsImage(candidateApp);
      await candidateApp.recovery.boot({ open: intent => this.native.open(intent, stage.nativeDirectory) });
      reconcileOpsImage(candidateApp);
      await candidateApp.computers.drain();
      await candidateApp.botLifecycle.drain({ open: intent => this.native.open(intent, stage.nativeDirectory) });
      candidate.read(tx => {
        if (tx.get("SELECT 1 FROM bot_computers WHERE json_extract(record_json,'$.state') NOT IN ('stopped','deleted')") ||
            tx.get("SELECT 1 FROM bot_lifecycle WHERE json_extract(record_json,'$.state') IN ('stopping','deleting')")) throw new AppError("s14_ops_computer_or_bot_cleanup_unresolved", 409);
      });
      if (this.intents(candidate).some(intent => intent.state === "unresolved")) throw new AppError("s14_ops_native_reconciliation_unresolved", 409);
      candidate.read(tx => {
        if (tx.get("PRAGMA foreign_key_check") || tx.get<{ integrity_check: string }>("PRAGMA integrity_check")?.integrity_check !== "ok") throw new AppError("s14_ops_candidate_invalid", 409);
      });
      this.fault?.("candidate_reconciled");
      stage.nativeDigest = await this.nativeDigest(this.intents(candidate), stage.nativeDirectory);
      stage.candidateHash = opsHash(candidate.snapshotBytes());
      stage.ledger = this.store.read(opsLedger);
      stage.liveHash = opsLiveHash(this.store);
      stage.state = "validated";
      stage.reason = null;
      stage.actionHash = opsHash(JSON.stringify({ contract: restoreActivationContract, id: stage.id, candidate: stage.candidateHash, live: stage.liveHash, ledger: stage.ledger, backupId: stage.backupId }));
      return { ...this.result(command, "validated"), stage: this.publicStage(stage) };
    } catch (error) {
      if (stage.state !== "partial") stage.state = "blocked";
      stage.reason = error instanceof AppError ? error.code : "s14_ops_validation_failed";
      return { ...this.result(command, stage.state, stage.reason), stage: this.publicStage(stage) };
    } finally { candidate?.close(); this.persist(); }
  }
  private async activate(command: Extract<OpsCommand, { kind: "restore.activate" }>, stage: OpsStage): Promise<OpsReceipt> {
    if (command.payload.actionHash !== stage.actionHash || !stage.actionHash || !["validated", "activating", "complete"].includes(stage.state)) throw new AppError("s14_ops_stale_cutover", 409);
    if (stage.state === "complete") return { ...this.result(command, "complete"), stage: this.publicStage(stage) };
    const directory = this.stageDirectory(stage.id), activation = join(directory, "activation.sqlite");
    const candidateBytes = opsRead(join(directory, "candidate.sqlite"), opsLimits.bytes);
    if (opsHash(candidateBytes) !== stage.candidateHash) throw new AppError("s14_ops_integrity_failed", 409);
    const nativeCandidate = Database.deserialize(candidateBytes);
    const nativeIntents = (nativeCandidate.query("SELECT record_json FROM native_intents ORDER BY id").all() as { record_json: string }[]).map(row => JSON.parse(row.record_json) as NativeIntent);
    nativeCandidate.close();
    if (!stage.nativeDigest || stage.nativeDigest !== await this.nativeDigest(nativeIntents, stage.nativeDirectory)) throw new AppError("s14_ops_native_integrity_changed", 409);
    if (stage.state === "validated") {
      if (stage.ledger !== this.store.read(opsLedger) || stage.liveHash !== opsLiveHash(this.store)) throw new AppError("s14_ops_live_or_ledger_changed", 409);
      const candidatePath = join(directory, "candidate.sqlite");
      const bytes = opsRead(candidatePath, opsLimits.bytes);
      if (opsHash(bytes) !== stage.candidateHash) throw new AppError("s14_ops_integrity_failed", 409);
      const db = Database.deserialize(bytes);
      try {
        const owner = this.store.read(tx => tx.get<{ password_hash: string; generation: number }>("SELECT password_hash,generation FROM owner")!);
        db.query("UPDATE owner SET password_hash=?,generation=? WHERE id='owner'").run(owner.password_hash, owner.generation);
        db.exec("DELETE FROM sessions; VACUUM");
        if (existsSync(activation)) rmSync(activation);
        opsWrite(activation, db.serialize());
        stage.targetHash = opsManagedHash({ all: <T>(sql: string) => db.query(sql).all() as T[] });
      } finally { db.close(); }
      stage.priorHash = opsLiveHash(this.store);
      stage.activationHash = opsHash(opsRead(activation, opsLimits.bytes));
      // Prior active credentials are installation-local recovery state, never an ordinary backup/export.
      if (!existsSync(join(directory, "prior.sqlite"))) opsWrite(join(directory, "prior.sqlite"), this.store.snapshotBytes());
      stage.state = "activating";
      this.persist();
      this.fault?.("activation_intent");
    }
    const liveHash = opsLiveHash(this.store);
    this.store.close();
    if (liveHash === stage.priorHash) {
      if (opsHash(opsRead(activation, opsLimits.bytes)) !== stage.activationHash) throw new AppError("s14_ops_integrity_failed", 409);
      opsRename(activation, this.path);
    } else if (liveHash !== stage.targetHash) throw new AppError("s14_ops_activation_state_unknown", 503);
    this.fault?.("application_renamed");
    opsAtomic(`${this.nativeRoot}.session-store.json`, { contract: restoreActivationContract, directory: stage.nativeDirectory });
    this.fault?.("native_pointer_written");
    this.store = new S14Store(this.path, {});
    this.app = new S14Application(this.store, this.options);
    if (stage.ledger !== this.store.read(opsLedger)) throw new AppError("s14_ops_ledger_changed", 503);
    stage.state = "complete";
    stage.reason = null;
    this.persist();
    return { ...this.result(command, "complete"), stage: this.publicStage(stage) };
  }
}
