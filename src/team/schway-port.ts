import { AppError } from "../errors";
import { requireId } from "../sources";
import type { TransactionStore } from "../store";
import type { ApplicationRunPort, ManagedContextOutcome, NativeRunInspection } from "./run-port";
import { fixtureOutcome, validateRunRequest } from "./scripted-port";
import type { ApplicationRunEvent, ApplicationRunOutcome, ApplicationRunRequest, ManagedContextReference, RunReason, TeamPolicy } from "./types";

/**
 * SKELETON — jit.schway.bridge/v1 (JBR01, issue #15).
 *
 * Schway ENG03/05/06/07/08/09 are OPEN, so no pinned `schway.host.release/v1`
 * artifact exists in the integration base. This adapter therefore validates
 * every request against the application seam and then fails closed without
 * touching native execution, provider protocols or credentials.
 *
 * It imports nothing from Schway, spawns nothing, fetches nothing and reads
 * no environment. Deleting this file cannot affect any live route.
 */

/** Supported host contract required before any native dispatch; nothing is pinned yet. */
export const SCHWAY_RELEASE_CONTRACT = "schway.host.release/v1" as const;
/** Supported snapshot contract required before native snapshot evidence; nothing is pinned yet. */
export const SCHWAY_SNAPSHOT_CONTRACT = "schway.host.session-snapshot/v1" as const;
/** Owner next action while the supported host artifact is absent from the integration base. */
export const SCHWAY_NEXT_ACTION = "pin_supported_schway_host_release" as const;
/** Owner next action for an explicitly unsupported native snapshot read. */
export const SCHWAY_SNAPSHOT_NEXT_ACTION = "await_supported_schway_snapshot_api" as const;

/** Fail-closed bridge status: the adapter is present, the host artifact is not. */
export interface SchwayBridgeStatus {
  available: false;
  contract: typeof SCHWAY_RELEASE_CONTRACT;
  release: null;
  nextAction: typeof SCHWAY_NEXT_ACTION;
}

/** Explicitly unsupported native snapshot diagnostic; never raw native bytes. */
export interface SchwaySnapshotResult {
  supported: false;
  contract: typeof SCHWAY_SNAPSHOT_CONTRACT;
  nextAction: typeof SCHWAY_SNAPSHOT_NEXT_ACTION;
}

const emptyUsage = () => ({ calls: 0, rounds: 0, hops: 0, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0 });

/**
 * Documents the future blocked/waiting mapping for a pinned host artifact.
 * Only `route_unavailable` is reachable while the artifact gate is closed;
 * unknown future events normalize to `invalid_result` instead of success.
 */
export function classifyBridgeOutcome(reason: RunReason | "unknown"): ApplicationRunOutcome {
  if (reason === "unknown") {
    return { state: "error", reason: "invalid_result", mode: "fixture", output: null, usage: emptyUsage(), session: null };
  }
  return fixtureOutcome(reason);
}

function requireContextReference(context: ManagedContextReference): void {
  requireId(context.id);
  if (!Number.isSafeInteger(context.generation) || context.generation < 1) throw new AppError("invalid_context_reference");
}

/** Fail-closed Schway application port; every dispatch ends at the artifact gate. */
export class SchwayRunPort implements ApplicationRunPort {
  readonly #requests: ApplicationRunRequest[] = [];

  constructor(readonly store: TransactionStore, readonly policy: TeamPolicy, readonly outputBytes: number) {
    const maximum = { roleLimit: 100, responsibilityBytes: 8192, sourceLimit: 32, contextBytes: 65536 };
    if (Object.keys(policy).sort().join(",") !== Object.keys(maximum).sort().join(",") ||
        Object.entries(maximum).some(([key, max]) => !Number.isSafeInteger(policy[key as keyof TeamPolicy]) || policy[key as keyof TeamPolicy] < 1 || policy[key as keyof TeamPolicy] > max) ||
        !Number.isSafeInteger(outputBytes) || outputBytes < 1 || outputBytes > 65536) throw new AppError("invalid_team_policy");
    this.policy = Object.freeze({ ...policy });
  }

  /** Reports the closed artifact gate without probing credentials or inferring readiness. */
  status(): SchwayBridgeStatus {
    return { available: false, contract: SCHWAY_RELEASE_CONTRACT, release: null, nextAction: SCHWAY_NEXT_ACTION };
  }

  /** Returns isolated evidence of the last 32 validated invocations, without unbounded retention. */
  get requests(): readonly ApplicationRunRequest[] { return structuredClone(this.#requests); }

  /**
   * Validates the request at the application seam, fences retired contexts
   * and cancelled calls, then fails closed: no native dispatch exists until
   * a supported `schway.host.release/v1` artifact is pinned.
   */
  async invoke(request: ApplicationRunRequest, signal: AbortSignal, observe: (event: ApplicationRunEvent) => void): Promise<ApplicationRunOutcome> {
    validateRunRequest(request, this.policy);
    const snapshot = structuredClone(request);
    const fenced = () => this.store.read(tx =>
      tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", snapshot.context.id, snapshot.context.generation)?.state !== "active");
    if (fenced()) return classifyBridgeOutcome("context_retired");
    if (signal.aborted) return classifyBridgeOutcome("cancelled");
    this.#requests.push(structuredClone(snapshot));
    if (this.#requests.length > 32) this.#requests.shift();
    observe({ kind: "started", runId: snapshot.runId, context: { ...snapshot.context } });
    observe({ kind: "progress", runId: snapshot.runId, text: `blocked: missing ${SCHWAY_RELEASE_CONTRACT}; no native dispatch attempted` });
    // Recheck fencing after the gate so a concurrent retirement or cancellation still wins.
    if (fenced()) {
      const retired = classifyBridgeOutcome("context_retired");
      observe({ kind: "finished", runId: snapshot.runId, outcome: structuredClone(retired) });
      return retired;
    }
    if (signal.aborted) {
      const cancelled = classifyBridgeOutcome("cancelled");
      observe({ kind: "finished", runId: snapshot.runId, outcome: structuredClone(cancelled) });
      return cancelled;
    }
    const blocked = classifyBridgeOutcome("route_unavailable");
    observe({ kind: "finished", runId: snapshot.runId, outcome: structuredClone(blocked) });
    return blocked;
  }

  /** No native run references exist without a pinned host artifact; pagination stays empty. */
  async inspectRuns(after = 0): Promise<{ items: NativeRunInspection[]; nextAfter: number | null }> {
    if (!Number.isSafeInteger(after) || after < 0) throw new AppError("invalid_cursor");
    return { items: [], nextAfter: null };
  }

  /**
   * Persists the application fence first, then reports the missing native
   * acknowledgment. Replay stays fenced even though no transport was asked.
   */
  async retire(context: ManagedContextReference): Promise<ManagedContextOutcome> {
    requireContextReference(context);
    const state = this.store.transaction(tx => {
      const row = tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", context.id, context.generation);
      if (!row) throw new AppError("context_not_found", 404);
      if (row.state === "deleted") return "deleted" as const;
      tx.run("UPDATE team_contexts SET state = 'retired' WHERE id = ? AND generation = ? AND state = 'active'", context.id, context.generation);
      return "retire_failed" as const;
    });
    if (state === "deleted") return { state: "deleted", context: { ...context } };
    return { state: "retire_failed", context: { ...context }, nextAction: "retry_managed_retire" };
  }

  /**
   * Retires first, then records the missing managed deletion. Nothing edits
   * native bytes; the blocker remains visible until a supported lifecycle API
   * acknowledges deletion.
   */
  async delete(context: ManagedContextReference): Promise<ManagedContextOutcome> {
    requireContextReference(context);
    const state = this.store.transaction(tx => {
      const row = tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", context.id, context.generation);
      if (!row) throw new AppError("context_not_found", 404);
      if (row.state === "deleted") return "deleted" as const;
      tx.run("UPDATE team_contexts SET state = 'retired' WHERE id = ? AND generation = ? AND state = 'active'", context.id, context.generation);
      tx.run("UPDATE team_contexts SET state = 'delete_failed' WHERE id = ? AND generation = ?", context.id, context.generation);
      return "delete_failed" as const;
    });
    if (state === "deleted") return { state: "deleted", context: { ...context } };
    return { state: "delete_failed", context: { ...context }, nextAction: "retry_managed_delete" };
  }

  /**
   * Native snapshot reads have no supported API in this skeleton.
   * Returns an explicit unsupported diagnostic instead of native bytes.
   */
  async snapshot(context: ManagedContextReference): Promise<SchwaySnapshotResult> {
    requireContextReference(context);
    return { supported: false, contract: SCHWAY_SNAPSHOT_CONTRACT, nextAction: SCHWAY_SNAPSHOT_NEXT_ACTION };
  }
}
