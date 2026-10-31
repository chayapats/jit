import { join } from "node:path";
import { SNAPSHOT_NATIVE_FORMAT_VERSION } from "schway/host";
import { AppError } from "../errors";
import type { S14Application } from "./application";
import type { S14Store } from "./store";
import { s14SchemaVersion } from "./store";
import type { NativeIntent } from "./recovery-types";
import type { OpsFault } from "./ops";
import { opsDirectory, opsWrite } from "./ops-files";
import { credentialFreeImage, imageArtifacts, opsHash, opsLedger, opsLedgerPosition } from "./ops-image";
import { validateOpsSnapshot } from "./ops-native";
import { opsRoot } from "./ops-state";
import { managedBackupContract, opsLimits, type ManagedBackupManifest, type OpsNativePort } from "./ops-types";

/** Refuses capture until actual managed transports/computer operations have settled; queued work is not started. */
export function assertS14BackupQuiescent(store: S14Store, native: OpsNativePort): void {
  if (!native.supported()) throw new AppError("s14_ops_native_unsupported", 409);
  store.read(tx => {
    opsLedger(tx);
    if (tx.get<{ journal_mode: string }>("PRAGMA main.journal_mode")?.journal_mode !== "delete" ||
        tx.get<{ journal_mode: string }>("PRAGMA lifecycle.journal_mode")?.journal_mode !== "delete") throw new AppError("s14_ops_journal_mode_unsupported", 409);
    if (tx.get("SELECT 1 FROM attempt_transports WHERE active=1") || tx.get("SELECT 1 FROM reply_transports WHERE active=1") ||
        tx.get("SELECT 1 FROM work_attempts WHERE json_extract(record_json,'$.state') IN ('running','interrupted')") ||
        tx.get("SELECT 1 FROM reply_outbox WHERE json_extract(record_json,'$.state')='running'") ||
        tx.get("SELECT 1 FROM effects WHERE json_extract(record_json,'$.state')='executing'") ||
        tx.get("SELECT 1 FROM personal_flows WHERE json_extract(record_json,'$.state')='exchanging'") ||
        tx.get("SELECT 1 FROM personal_reads WHERE json_extract(record_json,'$.outcome')='running'") ||
        tx.get("SELECT 1 FROM bot_computers WHERE json_extract(record_json,'$.state') NOT IN ('stopped','deleted')") ||
        tx.get("SELECT 1 FROM computer_operations WHERE state!='done'") || tx.get("SELECT 1 FROM computer_inputs WHERE state='dispatching'")) throw new AppError("s14_ops_quiesce_required", 409);
  });
}

/** Captures only under an already-held writer fence; publishes files last, leaving registry/retention to the caller. */
export async function captureS14Backup(app: S14Application, native: OpsNativePort, id: string, hooks: {
  fault?: (point: OpsFault) => void;
  check?: () => void;
  progress?: (completed: number, total: number) => void;
} = {}): Promise<ManagedBackupManifest> {
  assertS14BackupQuiescent(app.store, native);
  hooks.check?.();
  const image = credentialFreeImage(app.store), ledger = app.store.read(opsLedger);
  const intents = app.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM native_intents ORDER BY id").map(row => JSON.parse(row.record_json) as NativeIntent));
  if (intents.length > opsLimits.native) throw new AppError("s14_ops_native_bound", 409);
  hooks.fault?.("image_captured");
  const components: { intentId: string; bytes: Uint8Array }[] = [];
  let size = image.length;
  hooks.progress?.(0, intents.length);
  for (const [index, intent] of intents.entries()) {
    hooks.check?.();
    if (!["deleted", "not_created"].includes(intent.state)) {
      if (intent.state !== "retired" || !intent.reference) throw new AppError("s14_ops_native_unsettled", 409);
      const host = await native.open(intent);
      try {
        hooks.check?.();
        const snapshot = await host.snapshotSessions([intent.reference]);
        validateOpsSnapshot(host, snapshot, intent);
        if (!snapshot.sessions.every(session => session.retired)) throw new AppError("s14_ops_native_unsettled", 409);
        const bytes = Buffer.from(JSON.stringify(snapshot));
        size += bytes.length;
        if (size > opsLimits.bytes) throw new AppError("s14_ops_backup_too_large", 409);
        components.push({ intentId: intent.id, bytes });
      } finally {
        try { await host.close(); }
        catch { throw new AppError("s14_ops_native_close_unresolved", 503); }
      }
    }
    hooks.progress?.(index + 1, intents.length);
  }
  hooks.fault?.("native_captured");
  hooks.check?.();
  if (ledger !== app.store.read(opsLedger)) throw new AppError("s14_ops_ledger_changed", 409);
  const component = (name: string, bytes: Uint8Array) => ({ name, size: bytes.length, sha256: opsHash(bytes) });
  const manifest: ManagedBackupManifest = { contract: managedBackupContract, format: "jit.s14/v1", schema: s14SchemaVersion, build: "jit/0.1.0", id,
    installationId: app.store.read(tx => tx.get<{ id: string }>("SELECT id FROM memory_identity")!.id), createdAt: app.now(), state: "complete", ledger, ledgerPosition: opsLedgerPosition(app.store),
    nativeContract: "schway.host.session-snapshot/v1", nativeFormat: SNAPSHOT_NATIVE_FORMAT_VERSION, credentials: "excluded_reconnect_required",
    image: component("application.sqlite", image), native: components.map((entry, index) => ({ intentId: entry.intentId, component: component(`native-${index}.json`, entry.bytes) })), artifacts: imageArtifacts(app.store) };
  const encodedManifest = JSON.stringify(manifest);
  if (Buffer.byteLength(encodedManifest) > opsLimits.journalBytes) throw new AppError("s14_ops_manifest_bound", 409);
  const directory = join(opsRoot(app.store.path), "backups", id);
  opsDirectory(directory);
  opsWrite(join(directory, "application.sqlite"), image);
  for (const [index, entry] of components.entries()) opsWrite(join(directory, `native-${index}.json`), entry.bytes);
  opsWrite(join(directory, "manifest.json"), encodedManifest);
  hooks.fault?.("manifest_committed");
  return manifest;
}
