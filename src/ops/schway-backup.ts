import { createHash } from "node:crypto";
import {
  HostError,
  MAX_SNAPSHOT_SESSIONS,
  SNAPSHOT_NATIVE_FORMAT_VERSION,
  hostCapabilities,
} from "schway/host";
import type { HostRuntime, HostSessionReference, HostSessionSnapshot } from "schway/host";
import type { AppConfig } from "../config";
import { AppError } from "../errors";
import type { AppTransaction, TransactionStore } from "../store";
import {
  assertSchwayGate,
  SCHWAY_PINNED_REVISION,
  SCHWAY_PINNED_VERSION,
  SCHWAY_SNAPSHOT_CONTRACT,
  SchwayRunPort,
} from "../team/schway-port";
import type { BackupNativeArtifact, BackupNativePlan, BackupNativePort, BackupNativeSnapshot } from "./backup";

/**
 * Concrete native-snapshot port — ops.backup_manifest/v1 over
 * jit.schway.bridge/v1 and schway.host.session-snapshot/v1 (OPS01 #18).
 *
 * Staged and asynchronous: `resolve` reads the exact durable correlation set
 * (`schway_native_refs` joined with app context state) inside the backup's
 * application snapshot transaction; `snapshot` then opens the pinned
 * lifecycle host and calls the supported `snapshotSessions`, which quiesces
 * the set under one lease set and rejects open writers (`busy`) and replaced
 * aliases (`conflict`). Each captured `HostSessionSnapshot` is validated with
 * `validateSessionSnapshot`, its contract/format version and exact reference
 * set are checked, and the serialized snapshot is returned as one opaque
 * artifact. Jit never reads or rewrites native session bytes.
 *
 * Fail-closed: a failing gate, an unresolved creation intent, a running
 * session, a missing or changed native session, an incompatible snapshot
 * capability or an over-limit set never yields a valid native snapshot.
 * Contexts the app already deleted are excluded: their native sessions are
 * gone by design and are not part of committed state.
 */
export const schwayBackupEngine =
  `schway-host/${SCHWAY_PINNED_VERSION}+${SCHWAY_PINNED_REVISION.slice(0, 12)}`;

/** Default ceiling on managed sessions captured by one backup. */
export const SCHWAY_BACKUP_MAX_SESSIONS = 1024;

export interface SchwayBackupOptions {
  /** Sessions per backup; a larger resolved set fails closed as `native_snapshot_over_limit`. */
  maxSessions?: number;
  /** Sessions per `snapshotSessions` call, at most the host's `MAX_SNAPSHOT_SESSIONS`. */
  chunkSize?: number;
}

interface PlanEntry {
  runId: string; generation: number; sessionId: string; branchId: string;
  state: "running" | "finished"; contextState: string;
}

interface SchwayPlanDetail { entries: PlanEntry[]; unresolved: number; busy: number }

/** Lifecycle-only policy: no inference ever runs through the backup host. */
const LIFECYCLE_POLICY = { roleLimit: 24, responsibilityBytes: 2048, sourceLimit: 8, contextBytes: 32768 };

function mapHostError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof HostError) {
    if (error.code === "busy") return new AppError("native_sessions_busy", 409);
    if (error.code === "conflict") return new AppError("native_snapshot_conflict", 409);
    if (error.code === "storage" || error.code === "invalid-reference") return new AppError("native_artifact_missing", 409);
    if (error.code === "workspace-mismatch") return new AppError("native_snapshot_incompatible", 409);
  }
  return new AppError("native_snapshot_failed", 500);
}

/**
 * Validates one supported snapshot against the exact requested references.
 * Only the documented envelope and Schway's own validator are consulted.
 */
export function verifySchwaySnapshot(host: Pick<HostRuntime, "validateSessionSnapshot">, snapshot: HostSessionSnapshot,
  requested: readonly HostSessionReference[]): void {
  if (!snapshot || snapshot.snapshotContract !== SCHWAY_SNAPSHOT_CONTRACT) throw new AppError("native_snapshot_incompatible", 409);
  if (snapshot.nativeFormatVersion !== SNAPSHOT_NATIVE_FORMAT_VERSION) throw new AppError("native_snapshot_incompatible", 409);
  const verdict = host.validateSessionSnapshot(snapshot);
  if (verdict.status !== "valid") {
    throw new AppError(verdict.reason === "unsupported-version" || verdict.reason === "workspace-mismatch"
      ? "native_snapshot_incompatible" : verdict.reason === "missing-artifact" ? "native_artifact_missing" : "native_snapshot_invalid", 409);
  }
  const got = verdict.sessions.map(ref => `${ref.id}/${ref.branchId}`);
  const want = requested.map(ref => `${ref.id}/${ref.branchId}`);
  if (got.length !== want.length || got.some((value, index) => value !== want[index])) throw new AppError("native_snapshot_mismatch", 409);
}

/** Staged concrete port; construct per store. Holds no resources between calls. */
export class SchwayBackupNativePort implements BackupNativePort {
  readonly engine = schwayBackupEngine;
  readonly staged = true;
  readonly #maxSessions: number;
  readonly #chunkSize: number;

  constructor(readonly store: TransactionStore, options: SchwayBackupOptions = {}) {
    this.#maxSessions = options.maxSessions ?? SCHWAY_BACKUP_MAX_SESSIONS;
    this.#chunkSize = Math.min(options.chunkSize ?? MAX_SNAPSHOT_SESSIONS, MAX_SNAPSHOT_SESSIONS);
    if (!Number.isSafeInteger(this.#maxSessions) || this.#maxSessions < 1 || !Number.isSafeInteger(this.#chunkSize) || this.#chunkSize < 1) {
      throw new AppError("invalid_backup_native_options", 500);
    }
  }

  /** Cheap gate probe: pinned release contract, supported snapshot contract and service-owned directories. */
  available(): boolean {
    try {
      assertSchwayGate(this.store.path);
      return hostCapabilities().snapshotContract === SCHWAY_SNAPSHOT_CONTRACT;
    } catch {
      return false;
    }
  }

  /**
   * Exact native reference set as committed in `tx`. Rows of app-deleted
   * contexts are excluded; reserved intents without a native id and running
   * sessions are counted so `snapshot` can fail closed.
   */
  resolve(tx: AppTransaction): BackupNativePlan {
    const rows = tx.all<{ run_id: string; generation: number; session_id: string; branch_id: string; state: "running" | "finished"; context_state: string | null }>(
      `SELECT r.run_id, r.generation, r.session_id, r.branch_id, r.state, c.state AS context_state
       FROM schway_native_refs r LEFT JOIN team_contexts c ON c.id = r.context_id AND c.generation = r.generation
       ORDER BY r.sequence`);
    const live = rows.filter(row => row.context_state === "active" || row.context_state === "retired" || row.context_state === "delete_failed");
    const entries: PlanEntry[] = [];
    let unresolved = 0, busy = 0;
    for (const row of live) {
      if (row.session_id === "") { unresolved++; continue; }
      if (row.state === "running") busy++;
      entries.push({ runId: row.run_id, generation: row.generation, sessionId: row.session_id, branchId: row.branch_id, state: row.state, contextState: row.context_state! });
    }
    const fingerprint = createHash("sha256").update(JSON.stringify([
      unresolved, live.map(row => [row.run_id, row.session_id, row.branch_id, row.state, row.context_state]),
    ])).digest("hex");
    const detail: SchwayPlanDetail = { entries, unresolved, busy };
    return { refs: entries.map(entry => ({ id: entry.runId, generation: entry.generation })), fingerprint, detail };
  }

  /** Captures the resolved set through the supported host snapshot API. */
  async snapshot(plan?: BackupNativePlan): Promise<BackupNativeSnapshot> {
    const resolved = plan ?? this.store.read(tx => this.resolve(tx));
    const detail = resolved.detail as SchwayPlanDetail | undefined;
    if (!detail || !Array.isArray(detail.entries)) throw new AppError("native_snapshot_invalid", 500);
    try { assertSchwayGate(this.store.path); } catch { throw new AppError("native_snapshot_unavailable", 503); }
    if (detail.unresolved > 0) throw new AppError("native_ref_unresolved", 409);
    if (detail.busy > 0) throw new AppError("native_sessions_busy", 409);
    if (detail.entries.length > this.#maxSessions) throw new AppError("native_snapshot_over_limit", 409);
    const base = { refs: resolved.refs.map(ref => ({ ...ref })), engine: schwayBackupEngine, contract: SCHWAY_SNAPSHOT_CONTRACT, formatVersion: SNAPSHOT_NATIVE_FORMAT_VERSION };
    if (detail.entries.length === 0) return { ...base, bytes: 0, artifacts: [] };
    let host: HostRuntime | null = null;
    const artifacts: BackupNativeArtifact[] = [];
    try {
      try {
        host = await new SchwayRunPort(this.store, LIFECYCLE_POLICY, 4096).openLifecycleHost();
      } catch {
        throw new AppError("native_snapshot_unavailable", 503);
      }
      if (host.capabilities.snapshotContract !== SCHWAY_SNAPSHOT_CONTRACT) throw new AppError("native_snapshot_incompatible", 409);
      for (let offset = 0, index = 0; offset < detail.entries.length; offset += this.#chunkSize, index++) {
        const requested = detail.entries.slice(offset, offset + this.#chunkSize).map(entry => ({ id: entry.sessionId, branchId: entry.branchId }));
        let snapshot: HostSessionSnapshot;
        try { snapshot = await host.snapshotSessions(requested); }
        catch (error) { throw mapHostError(error); }
        verifySchwaySnapshot(host, snapshot, requested);
        const bytes = new TextEncoder().encode(JSON.stringify(snapshot));
        artifacts.push({ name: `session-snapshot-${index}`, bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    } finally {
      try { await host?.close(); } catch { /* Best effort after capture. */ }
    }
    return { ...base, bytes: artifacts.reduce((sum, a) => sum + a.bytes.length, 0), artifacts };
  }
}

export function createSchwayBackupNativePort(store: TransactionStore, options: SchwayBackupOptions = {}): BackupNativePort {
  return new SchwayBackupNativePort(store, options);
}

/**
 * Single selection rule shared by `serve` and `startFullApp`: the concrete
 * port only under explicit `JIT_RUN_PORT=schway`; the scripted default has no
 * native port, so its backups stay explicitly `incomplete`.
 */
export function backupNativePortFor(config: Pick<AppConfig, "runPort">, store: TransactionStore): BackupNativePort | undefined {
  return config.runPort === "schway" ? createSchwayBackupNativePort(store) : undefined;
}
