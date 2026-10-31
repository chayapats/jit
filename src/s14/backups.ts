import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../errors";
import type { S14Application } from "./application";
import { assertS14BackupQuiescent, captureS14Backup } from "./ops-capture";
import { opsAtomic, opsDirectory, opsPath, opsRead, opsSyncDirectory, opsWrite } from "./ops-files";
import { assertS14BackupUnfenced, opsRoot, readS14Ops } from "./ops-state";
import { managedBackupContract, opsLimits, type OnlineBackupCommand, type OnlineBackupControl, type OnlineBackupReceipt, type OpsNativePort } from "./ops-types";
import type { OwnerActor } from "./types";
import { canonical, digest, exact, identity, integer } from "./validation";

const journal = (path: string) => join(opsRoot(path), "online-backups.json");
const marker = (path: string) => join(opsRoot(path), "capture.json");
const archive = (path: string, id: string) => { identity(id); return join(opsRoot(path), "backups", id); };
const save = (path: string, control: OnlineBackupControl) => opsAtomic(journal(path), control);
const read = (path: string): OnlineBackupControl => {
  if (!existsSync(journal(path))) return { contract: managedBackupContract, revision: 0, managedIds: [], requests: [] };
  const value = JSON.parse(opsRead(journal(path), opsLimits.journalBytes).toString()) as OnlineBackupControl;
  if (value.contract !== managedBackupContract || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.requests) || value.requests.length > 100 ||
      !Array.isArray(value.managedIds) || value.managedIds.length > opsLimits.backups) throw new AppError("s14_ops_journal_invalid", 503);
  for (const id of value.managedIds) identity(id);
  for (const entry of value.requests) {
    identity(entry.result.requestId); identity(entry.result.backupId);
    if (!Array.isArray(entry.replaces) || entry.replaces.length > opsLimits.backups) throw new AppError("s14_ops_journal_invalid", 503);
    for (const id of entry.replaces) identity(id);
    if (!/^[a-f0-9]{64}$/.test(entry.hash) || !["capturing", "complete", "blocked"].includes(entry.result.state)) throw new AppError("s14_ops_journal_invalid", 503);
  }
  return value;
};
const removeArchive = (path: string, id: string) => { const directory = archive(path, id); opsPath(directory); rmSync(directory, { recursive: true, force: true }); };
const clearMarker = (path: string) => { rmSync(marker(path), { force: true }); opsSyncDirectory(opsRoot(path)); };
const finish = (result: OnlineBackupReceipt, complete: boolean, reason: string | null) => {
  result.state = complete ? "complete" : "blocked";
  result.reason = reason;
  result.workers = "running";
  result.progress.phase = complete ? "complete" : "blocked";
};

/** Under the exclusive runtime lock, resolves interrupted capture only; it cannot activate or import an image. */
export function reconcileOnlineBackups(path: string): void {
  const control = read(path), registry = readS14Ops(path);
  if (existsSync(marker(path))) {
    const active = JSON.parse(opsRead(marker(path), 4096).toString()) as { contract: string; requestId: string; backupId: string };
    if (active.contract !== managedBackupContract || !control.requests.some(entry => entry.result.requestId === active.requestId && entry.result.backupId === active.backupId)) throw new AppError("s14_ops_journal_invalid", 503);
  }
  let changed = false;
  for (const entry of control.requests) {
    const result = entry.result, committed = registry.backups.includes(result.backupId);
    if (result.state === "capturing") {
      finish(result, committed, committed ? null : "s14_backup_interrupted_no_auto_retry");
      if (committed) control.managedIds = [...control.managedIds.filter(id => registry.backups.includes(id)), result.backupId];
      else removeArchive(path, result.backupId);
      changed = true;
    }
    if (result.state === "blocked" && result.workers === "paused") { result.workers = "running"; changed = true; }
    if (committed) for (const id of entry.replaces) if (!registry.backups.includes(id)) removeArchive(path, id);
  }
  if (changed) save(path, control);
  if (existsSync(marker(path))) clearMarker(path);
}

/** Owner-only, credential-free online capture; restore/cutover commands never enter this service. */
export class S14Backups {
  #running: Promise<void> | null = null;
  constructor(readonly app: S14Application, readonly native?: OpsNativePort) {}
  /** True until the actual native operation and durable finalization settle, including after a deadline. */
  get busy(): boolean { return this.#running !== null || existsSync(marker(this.app.store.path)); }
  /** Reads bounded progress and retention metadata without capturing or granting authority. */
  status(actor: OwnerActor) {
    this.app.store.read(tx => this.app.requireOwner(tx, actor));
    const control = read(this.app.store.path), registry = readS14Ops(this.app.store.path);
    return { revision: control.revision, latest: control.requests.at(-1)?.result ?? null, retention: { limit: opsLimits.backups - 1,
      count: registry.backups.length, automatic: "oldest_online_only" as const, protected: registry.backups.filter(id => !control.managedIds.includes(id)) } };
  }
  /** Reads one durable logical outcome; retrying its request never starts another capture. */
  receipt(actor: OwnerActor, requestId: string): OnlineBackupReceipt {
    identity(requestId);
    this.app.store.read(tx => this.app.requireOwner(tx, actor));
    const receipt = read(this.app.store.path).requests.find(entry => entry.result.requestId === requestId)?.result;
    if (!receipt) throw new AppError("not_found", 404);
    return structuredClone(receipt);
  }
  /** Reserves one strict owner request synchronously, then returns progress while capture runs without a terminal. */
  execute(actor: OwnerActor, command: OnlineBackupCommand): OnlineBackupReceipt {
    exact(command, ["kind", "requestId", "expectedRevision", "payload"]);
    if (command.kind !== "backup.create") throw new AppError("s14_ops_offline_required", 409);
    identity(command.requestId); integer(command.expectedRevision); exact(command.payload, []);
    const hash = digest(canonical(command)), path = this.app.store.path;
    // Reads permit an identical request/status while the capture writer fence is held.
    this.app.store.read(tx => this.app.requireOwner(tx, actor));
    const previous = read(path).requests.find(entry => entry.result.requestId === command.requestId);
    if (previous) {
      if (previous.hash !== hash) throw new AppError("request_id_conflict", 409);
      return structuredClone(previous.result);
    }
    if (this.busy) throw new AppError("s14_backup_in_progress", 409);
    const control = read(path), registry = readS14Ops(path);
    const native = this.native;
    if (!native) throw new AppError("s14_ops_native_unsupported", 409);
    let replaces: string[] = [];
    this.app.store.transaction(tx => {
      this.app.requireOwner(tx, actor);
      assertS14BackupUnfenced(path);
      if (command.expectedRevision !== control.revision) throw new AppError("stale_revision", 409);
      if (control.requests.length >= 100) throw new AppError("s14_ops_receipt_bound", 409);
      if (this.app.recovery.booting || this.app.signIns.flows.busy("codex") || this.app.signIns.flows.busy("grok") ||
          tx.get("SELECT 1 FROM attention_notices WHERE json_extract(record_json,'$.state')='claimed'") ||
          tx.get("SELECT 1 FROM bot_lifecycle WHERE json_extract(record_json,'$.state') IN ('stopping','deleting')")) throw new AppError("s14_ops_quiesce_required", 409);
      assertS14BackupQuiescent(this.app.store, native);
      if (registry.backups.length >= opsLimits.backups - 1) {
        const count = registry.backups.length - opsLimits.backups + 2;
        replaces = control.managedIds.filter(id => registry.backups.includes(id) && id !== registry.stage?.backupId && id !== registry.stage?.recoveryBackupId).slice(0, count);
        if (replaces.length !== count) throw new AppError("s14_ops_retention_full", 409);
      }
      const result: OnlineBackupReceipt = { kind: "backup.create", requestId: command.requestId, revision: ++control.revision, backupId: crypto.randomUUID().replaceAll("-", ""),
        state: "capturing", reason: null, progress: { phase: "application", completed: 0, total: 0 }, startedAt: this.app.now(), deadlineAt: this.app.now() + 60000, workers: "paused", reconnectionRequired: true };
      control.requests.push({ hash, replaces, result });
      opsDirectory(opsRoot(path));
      save(path, control); // Persist intent before any capture bytes; boot resolves even a crash before the marker write.
      opsWrite(marker(path), JSON.stringify({ contract: managedBackupContract, requestId: result.requestId, backupId: result.backupId }));
    });
    const entry = control.requests.at(-1)!;
    this.#running = Promise.resolve().then(() => this.capture(actor, control, entry, native)).finally(() => { this.#running = null; });
    // Failed durable finalization deliberately retains the marker; no background rejection may escape the service.
    void this.#running.catch(() => {});
    return structuredClone(entry.result);
  }
  /** Waits for actual capture settlement during shutdown; a deadline never releases an unsettled host. */
  async settle(): Promise<void> { await this.#running; }
  private async capture(actor: OwnerActor, control: OnlineBackupControl, entry: OnlineBackupControl["requests"][number], native: OpsNativePort): Promise<void> {
    const path = this.app.store.path, result = entry.result;
    const timer = setTimeout(() => {
      result.progress.phase = "waiting_native_settlement"; result.reason = "s14_backup_deadline_waiting_for_settlement";
      try { save(path, control); } catch { /* Keep the durable fence; finalization or boot must resolve a failed journal write. */ }
    }, 60000);
    try {
      await captureS14Backup(this.app, native, result.backupId, {
        check: () => {
          this.app.store.read(tx => this.app.requireOwner(tx, actor));
          if (this.app.now() >= result.deadlineAt) throw new AppError("s14_backup_deadline_exceeded", 409);
        },
        progress: (completed, total) => { result.progress = { phase: "native", completed, total }; save(path, control); },
      });
      const registry = readS14Ops(path);
      registry.backups = [...registry.backups.filter(id => !entry.replaces.includes(id)), result.backupId];
      registry.revision++;
      opsAtomic(join(opsRoot(path), "control.json"), registry); // Register only durable, fully verified components.
      control.managedIds = [...control.managedIds.filter(id => registry.backups.includes(id)), result.backupId];
      finish(result, true, null);
      save(path, control);
      for (const id of entry.replaces) removeArchive(path, id);
    } catch (error) {
      if (readS14Ops(path).backups.includes(result.backupId)) throw error; // Boot resolves a committed registry/finalization crash.
      finish(result, false, error instanceof AppError ? error.code : "s14_backup_capture_failed");
      const unresolvedClose = result.reason === "s14_ops_native_close_unresolved";
      if (unresolvedClose) result.workers = "paused";
      save(path, control);
      removeArchive(path, result.backupId);
      if (unresolvedClose) return; // A failed close cannot release native occupancy in this process; exclusive boot reconciles it.
    } finally { clearTimeout(timer); }
    clearMarker(path);
  }
}
