import type { DeletionEnvironment } from "../memory/delete";
import type { AppConfig } from "../config";
import { composeJobQueue, type ComposeOptions, type ComposedQueue } from "../composition";
import { AppError } from "../errors";
import type { JobQueue } from "../jobs/queue";
import type { ApplicationRunPort } from "../team/run-port";
import type { TransactionStore } from "../store";
import type { UpgradeQuiesceResult, UpgradeResumeResult, UpgradeServiceControl } from "./upgrade";
import { upgradeFenced } from "./upgrade-fence";

/** Default bound for waiting on in-flight attempts to settle during quiesce. */
export const upgradeDrainTimeoutMs = 30_000;

export interface ManagedServiceOptions {
  /** Upper bound on waiting for in-flight attempts after admission stops. */
  drainTimeoutMs?: number;
  /** Deterministic sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Service lifecycle owner for the job scheduler and its ports, shared by
 * `serve` and `startFullApp` (ops.schema_migrations/v1). It holds the one
 * current composition and implements the upgrade's quiesce/resume contract:
 *
 * - `quiesce` stops admission and fences in-flight attempts through the
 *   existing job contract (`JobQueue.close`: admitted attempts are
 *   invalidated as interrupted and aborted, ownership is retained until the
 *   adapters settle), then waits, bounded, until nothing occupies admission.
 * - `resume` rebuilds the scheduler and ports through `composeJobQueue` for
 *   the current (possibly swapped) store and reconciles native sessions
 *   (`jobs.session_reconcile/v1`) before the new queue is exposed to the
 *   pump. On reconciliation failure the new queue is closed and nothing is
 *   admitted.
 *
 * The durable upgrade fence keeps a freshly booted queue from admitting
 * anything while an upgrade is in progress; boot reconciliation runs only
 * when no fence holds.
 */
export class ManagedService implements UpgradeServiceControl {
  #current: ComposedQueue | undefined;
  #deletionEnvironment: DeletionEnvironment = {};
  #drainMs: number;
  #sleep: (ms: number) => Promise<void>;

  constructor(readonly store: TransactionStore, readonly compose: () => ComposedQueue, options: ManagedServiceOptions = {}) {
    this.#drainMs = options.drainTimeoutMs ?? upgradeDrainTimeoutMs;
    if (!Number.isSafeInteger(this.#drainMs) || this.#drainMs < 0 || this.#drainMs > 300_000) throw new AppError("invalid_drain_options", 500);
    this.#sleep = options.sleep ?? (ms => Bun.sleep(ms));
  }

  /** The production composition for `config` (same workers and port policy as serve). */
  static forConfig(store: TransactionStore, config: AppConfig, compose: ComposeOptions = {}, options: ManagedServiceOptions = {}): ManagedService {
    return new ManagedService(store, () => composeJobQueue(store, config, compose), options);
  }

  /** Adopts an already composed queue (startFullApp composes synchronously). */
  adopt(composed: ComposedQueue): this {
    if (composed.queue.store !== this.store) throw new AppError("invalid_job_store", 500);
    composed.queue.setDeletionEnvironment(this.#deletionEnvironment);
    this.#current = composed;
    return this;
  }

  /** Carries service-owned deletion hooks across boot, upgrade and restore queue recomposition. */
  setDeletionEnvironment(environment: DeletionEnvironment): void {
    this.#deletionEnvironment = environment;
    this.#current?.queue.setDeletionEnvironment(environment);
  }

  #compose(): ComposedQueue {
    const composed = this.compose();
    composed.queue.setDeletionEnvironment(this.#deletionEnvironment);
    return composed;
  }

  /** Current scheduler; closed while an upgrade holds the service quiesced. */
  get queue(): JobQueue | undefined { return this.#current?.queue; }
  get composed(): ComposedQueue | undefined { return this.#current; }

  /**
   * Boot: composes the scheduler and reconciles native sessions unless the
   * durable upgrade fence holds, in which case the queue stays unreconciled
   * and admission stays fenced until the upgrade activates or rolls back.
   */
  async start(): Promise<UpgradeResumeResult> {
    if (!this.#current) this.#current = this.#compose();
    if (upgradeFenced(this.store.path)) return { reconciled: false, detail: "upgrade_fence_held" };
    await this.#current.queue.reconcile(this.#current.teamPort);
    return { reconciled: true, detail: "jobs_sessions_reconciled" };
  }

  async quiesce(): Promise<UpgradeQuiesceResult> {
    const queue = this.#current?.queue;
    if (!queue) return { settled: true, fencedJobs: 0, detail: "no_scheduler_in_process" };
    queue.close();
    const deadline = Date.now() + this.#drainMs;
    for (;;) {
      const unsettled = this.#unsettled();
      if (unsettled === 0) break;
      if (Date.now() >= deadline) return { settled: false, fencedJobs: unsettled, detail: `unsettled_${unsettled}` };
      await this.#sleep(5);
    }
    try { await queue.idle(); } catch { /* Settlement already fenced. */ }
    const fenced = this.store.read(tx => {
      try { return tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state = 'waiting' AND json_extract(record_json, '$.reason') = 'interrupted'")!.n; }
      catch { return 0; }
    });
    return { settled: true, fencedJobs: fenced, detail: fenced ? `interrupted_${fenced}_fenced` : "admission_stopped_no_inflight" };
  }

  async resume(): Promise<UpgradeResumeResult> {
    if (upgradeFenced(this.store.path)) return { reconciled: false, detail: "upgrade_fence_held" };
    const previous = this.#current;
    try { previous?.queue.close(); } catch { /* Already closed or store swapped. */ }
    let next: ComposedQueue;
    try { next = this.#compose(); }
    catch (error) { return { reconciled: false, detail: error instanceof AppError ? error.code : "scheduler_unavailable" }; }
    try {
      await next.queue.reconcile(next.teamPort);
    } catch (error) {
      try { next.queue.close(); } catch { /* Teardown only. */ }
      return { reconciled: false, detail: error instanceof AppError ? error.code : "reconcile_failed" };
    }
    this.#current = next;
    const unknown = this.store.read(tx => {
      try { return tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents WHERE json_extract(record_json, '$.status') = 'unknown'")!.n; }
      catch { return 0; }
    });
    // Unknown deliveries stay visible and are never resent by reconciliation.
    return { reconciled: true, detail: unknown ? `jobs_sessions_reconciled_unknown_deliveries_${unknown}` : "jobs_sessions_reconciled" };
  }

  /**
   * Runs `run` with a freshly composed team port while the durable fence still
   * holds (ops.quarantined_restore/v1): the composed queue claims the
   * scheduler but cannot admit or pump anything under the fence, so managed
   * native-session deletions can complete before any reader or worker is
   * enabled. The temporary queue is closed afterwards; `resume` composes the
   * serving queue.
   */
  async fencedLifecycle<T>(run: (port: ApplicationRunPort) => Promise<T>): Promise<T> {
    try { this.#current?.queue.close(); } catch { /* Already closed or store swapped. */ }
    const composed = this.#compose();
    try { return await run(composed.teamPort); }
    finally {
      try { composed.queue.close(); await composed.queue.idle(); } catch { /* Teardown only. */ }
    }
  }

  close(): void { try { this.#current?.queue.close(); } catch { /* Teardown only. */ } }

  #unsettled(): number {
    return this.store.read(tx => {
      try { return tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE occupies = 1 OR state = 'admitted'")!.n; }
      catch { return 1; }
    });
  }
}
