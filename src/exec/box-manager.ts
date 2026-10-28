import type { ExecutionBackend } from "schway/host";
import type { AppConfig } from "../config";
import { AppError } from "../errors";
import type { AppTransaction, TransactionStore } from "../store";
import { assertExecutionAllowed, effectiveAccess, levelRank, readProjectAccess, type AccessLevel } from "./access";
import { createBoxBackend, type BoxBackendOptions } from "./box-backend";
import { boxTemporaryDirectory, boxWorkspaceRoot, type BoxHandle, type BoxMode, type BoxRuntime } from "./box-runtime";

/** One open use of a project's box. `release` must be called once the caller is done with the backend. */
export interface BoxSession { readonly handle: BoxHandle; readonly backend: ExecutionBackend; release(): void }

/** Options of {@link BoxManager}. */
export interface BoxManagerOptions {
  now?: () => number;
  /** Called after a box stops or is reset, so the queue can admit work waiting as `box_capacity`. */
  onCapacity?: () => void;
  backend?: BoxBackendOptions;
}

interface Slot { handle: BoxHandle | null; busy: number; lastUsedAt: number; opening: Promise<BoxHandle> | null; resetting: boolean; verified?: boolean }

/**
 * Box lifecycle and capacity over a {@link BoxRuntime} (EXE03, ADR 0036).
 *
 * - **Access.** {@link open} reads the effective level in its own transaction (`assertExecutionAllowed`): `read`
 *   never ensures a box (`access_level_insufficient`), a halted project is `execution_halted`, and the box runs in
 *   the effective mode (`workspace` or `full`), so a level change restarts it on the next open.
 * - **Capacity.** At most `execution.maxBoxes` projects hold a box: projects with a running or opening box plus
 *   projects with an admitted execution job ({@link hasCapacity}, called by the queue inside admission). Work beyond
 *   that waits as `box_capacity` without spinning and is admitted after a box stops ({@link BoxManagerOptions.onCapacity}).
 * - **Idle stop.** {@link sweep} (on the scheduler tick) stops every box idle for `execution.idleMinutes`; the
 *   workspace persists.
 * - **Reset and halt.** {@link reset} refuses while the box is in use (`box_busy`); {@link stop} (kill switch,
 *   narrowing) stops it regardless.
 */
export class BoxManager {
  readonly #slots = new Map<string, Slot>();
  readonly #now: () => number;
  readonly #onCapacity: (() => void) | undefined;
  readonly #backend: BoxBackendOptions;

  constructor(readonly store: TransactionStore, readonly config: AppConfig, readonly runtime: BoxRuntime, options: BoxManagerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#onCapacity = options.onCapacity;
    this.#backend = options.backend ?? {};
  }

  /**
   * Admission check for one execution job (`jobs.queue_admission/v1`), inside the queue's transaction: true when the
   * project already holds a box, or when the projects holding one — running or opening boxes and projects with an
   * admitted execution job — leave a free slot.
   */
  hasCapacity(tx: AppTransaction, projectId: string): boolean {
    const holders = this.#holders(tx);
    return holders.has(projectId) || holders.size < this.config.execution.maxBoxes;
  }

  #holders(tx: AppTransaction | null): Set<string> {
    const holders = new Set([...this.#slots].filter(([, slot]) => slot.handle || slot.opening).map(([id]) => id));
    if (tx) for (const row of tx.all<{ projectId: string }>(`SELECT DISTINCT project_id AS projectId FROM jobs WHERE state = 'admitted'
      AND json_extract(record_json, '$.execution') = 1`)) holders.add(row.projectId);
    return holders;
  }

  /** Seeds the running set from the runtime after a restart, so capacity counts boxes left running. */
  async reconcile(): Promise<void> {
    for (const box of await this.runtime.list()) {
      if (box.state !== "running" || this.#slots.has(box.projectId) || !box.mode) continue;
      // The next open re-ensures (and so re-verifies) the box; until then it counts for capacity and the idle sweep.
      const handle = Object.freeze({ projectId: box.projectId, name: box.name, mode: box.mode, profile: box.profile === true,
        workspaceRoot: boxWorkspaceRoot, temporaryDirectory: boxTemporaryDirectory });
      this.#slots.set(box.projectId, { handle, busy: 0, lastUsedAt: this.#now(), opening: null, resetting: false, verified: false });
    }
  }

  /**
   * Opens the project's box for one role's work and returns a Schway `ExecutionBackend` over it. The effective level
   * decides the mode; `read` and a halted project never reach the runtime. Refuses `box_busy` during a reset and
   * `box_capacity` when every slot is held by other projects.
   */
  async open(projectId: string, roleId: string | null, options: { profile?: boolean } = {}): Promise<BoxSession> {
    const level = this.store.read(tx => assertExecutionAllowed(tx, projectId, roleId, "workspace"));
    const mode: BoxMode = level === "full" ? "full" : "workspace";
    let slot = this.#slots.get(projectId);
    if (slot?.resetting) throw new AppError("box_busy", 409);
    if (!slot?.handle && !slot?.opening) {
      const holders = this.store.read(tx => this.#holders(tx));
      holders.delete(projectId);
      if (holders.size >= this.config.execution.maxBoxes) throw new AppError("box_capacity", 409);
    }
    if (!slot) { slot = { handle: null, busy: 0, lastUsedAt: this.#now(), opening: null, resetting: false }; this.#slots.set(projectId, slot); }
    slot.busy++;
    try {
      while (slot.opening) await slot.opening.catch(() => undefined);
      if (!slot.handle || slot.verified === false || slot.handle.mode !== mode || slot.handle.profile !== (options.profile === true)) {
        const opening = this.runtime.ensure(projectId, mode, options);
        slot.opening = opening;
        try { slot.handle = await opening; slot.verified = true; } finally { slot.opening = null; }
      }
    } catch (error) {
      slot.busy--;
      if (!slot.handle && slot.busy === 0) { this.#slots.delete(projectId); this.#onCapacity?.(); }
      throw error;
    }
    slot.lastUsedAt = this.#now();
    const handle = slot.handle!;
    let released = false;
    return {
      handle,
      backend: createBoxBackend(this.runtime, handle, this.#backend),
      release: () => {
        if (released) return;
        released = true; slot.busy--; slot.lastUsedAt = this.#now();
      },
    };
  }

  /** True while any open session uses the project's box or a reset is in progress. */
  busy(projectId: string): boolean {
    const slot = this.#slots.get(projectId);
    return !!slot && (slot.busy > 0 || slot.resetting || !!slot.opening);
  }

  /** Projects whose box Jit currently holds (running or opening), sorted. */
  holding(): string[] { return [...this.#holders(null)].sort(); }

  /** Stops every box idle for `execution.idleMinutes` at `now`; returns the stopped project ids. */
  async sweep(now = this.#now()): Promise<string[]> {
    const idleMs = this.config.execution.idleMinutes * 60_000, stopped: string[] = [];
    for (const [projectId, slot] of [...this.#slots]) {
      if (slot.busy > 0 || slot.opening || slot.resetting || now - slot.lastUsedAt < idleMs) continue;
      this.#slots.delete(projectId);
      if (slot.handle) { await this.runtime.stop({ projectId }).catch(() => undefined); stopped.push(projectId); }
    }
    if (stopped.length) this.#onCapacity?.();
    return stopped;
  }

  /** Stops the project's box now (kill switch, narrowing); the halt already fenced the work using it. */
  async stop(projectId: string): Promise<void> {
    const slot = this.#slots.get(projectId);
    this.#slots.delete(projectId);
    await this.runtime.stop({ projectId });
    if (slot) this.#onCapacity?.();
  }

  /**
   * After an access command commits: a halt, a level of `read`, or a level below the running box's mode stops the
   * box (commands in it are killed). A wider level applies on the next open, which restarts the box in the new mode.
   */
  async accessChanged(projectId: string): Promise<void> {
    const slot = this.#slots.get(projectId);
    if (!slot?.handle) return;
    const access = this.store.read(tx => readProjectAccess(tx, projectId, this.config));
    const level: AccessLevel = effectiveAccess(access, null).level;
    if (level === "read" || levelRank(level) < levelRank(slot.handle.mode)) await this.stop(projectId);
  }

  /**
   * Removes the project's box (and with `wipeWorkspace` its workspace). Refuses `box_busy` while the box is in use;
   * the caller also refuses while an execution attempt of the project is admitted. New opens wait out the reset.
   */
  async reset(projectId: string, wipeWorkspace: boolean): Promise<void> {
    if (this.busy(projectId)) throw new AppError("box_busy", 409);
    const slot: Slot = this.#slots.get(projectId) ?? { handle: null, busy: 0, lastUsedAt: this.#now(), opening: null, resetting: false };
    slot.resetting = true; slot.handle = null;
    this.#slots.set(projectId, slot);
    try { await this.runtime.reset({ projectId }, { wipeWorkspace }); }
    finally { this.#slots.delete(projectId); this.#onCapacity?.(); }
  }
}
