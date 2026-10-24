import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../errors";
import type { TransactionStore } from "../store";
import {
  assertSchwayGate,
  SCHWAY_PINNED_REVISION,
  SCHWAY_PINNED_VERSION,
  schwayHostDirs,
} from "../team/schway-port";
import type { BackupNativePort, BackupNativeSnapshot } from "./backup";

/**
 * Concrete native-snapshot port — ops.backup_manifest/v1 over
 * jit.schway.bridge/v1 (OPS01 #18, concrete wiring on JBR01 #15).
 *
 * The backup command path is synchronous, so this port never calls the async
 * native snapshot API. Instead it resolves through the supported synchronous
 * surface: the pinned release gate (no credentials, no network) plus the
 * durable `schway_native_refs` correlation the concrete bridge maintains.
 * Opaque native session ids never leave the store; refs carry app-side run
 * ids and generations only.
 *
 * Fail-closed preserved: a failing gate, an unreadable correlation table,
 * or live refs without any session files on disk never yield a valid
 * snapshot. An available engine with no managed sessions yet is a
 * valid empty snapshot — nothing is missing.
 */
export const schwayBackupEngine =
  `schway-host/${SCHWAY_PINNED_VERSION}+${SCHWAY_PINNED_REVISION.slice(0, 12)}`;

/** Bounded inventory walk; symlinks are never followed and content is never read. */
function measureSessionDir(sessionDir: string): { bytes: number; files: number } {
  let bytes = 0, files = 0;
  const pending: string[] = [sessionDir];
  let seen = 0;
  while (pending.length > 0 && seen < 20000) {
    const dir = pending.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (seen++ >= 20000) break;
      const path = join(dir, entry);
      let stats;
      try {
        stats = lstatSync(path);
      } catch {
        continue;
      }
      if (stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) pending.push(path);
      else if (stats.isFile()) {
        files++;
        bytes = Math.min(Number.MAX_SAFE_INTEGER, bytes + stats.size);
      }
    }
  }
  return { bytes, files };
}

/** Synchronous concrete port; construct per store, no resources held. */
export class SchwayBackupNativePort implements BackupNativePort {
  readonly engine = schwayBackupEngine;

  constructor(readonly store: TransactionStore) {}

  /** Cheap gate probe: pinned release contract plus service-owned directories. */
  available(): boolean {
    try {
      assertSchwayGate(this.store.path);
      return true;
    } catch {
      return false;
    }
  }

  snapshot(): BackupNativeSnapshot {
    assertSchwayGate(this.store.path);
    let rows: { run_id: string; generation: number }[];
    try {
      rows = this.store.read(tx =>
        tx.all<{ run_id: string; generation: number }>(
          "SELECT run_id, generation FROM schway_native_refs WHERE session_id != '' ORDER BY sequence",
        ));
    } catch {
      throw new AppError("native_snapshot_unavailable", 503);
    }
    const refs = rows.map(row => ({ id: row.run_id, generation: row.generation }));
    const sessionDir = schwayHostDirs(this.store.path).sessionDirectory;
    // The gate recreates missing service directories, so presence alone says
    // nothing: live correlations without any session files on disk are
    // missing artifacts and never yield a valid snapshot.
    const measured = measureSessionDir(sessionDir);
    if (refs.length > 0 && measured.files === 0) {
      throw new AppError("native_snapshot_unavailable", 503);
    }
    return { refs, bytes: measured.bytes, engine: schwayBackupEngine };
  }
}

export function createSchwayBackupNativePort(store: TransactionStore): BackupNativePort {
  return new SchwayBackupNativePort(store);
}
