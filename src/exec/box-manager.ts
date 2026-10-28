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
  /**
   * exec.browser/v1 (ADR 0039): open every box with the project profile, so the browser image and its `/profile`
   * mount are used whenever a pinned `browser` image is configured. One setting for every open keeps runs, MCP
   * servers and browser sessions on the same container (a mismatch would restart the box under them).
   */
  profile?: boolean;
}

interface Slot {
  handle: BoxHandle | null; busy: number; lastUsedAt: number; opening: Promise<BoxHandle> | null; resetting: boolean; verified?: boolean;
  /** A stop in flight; the slot (and its capacity) is held until the runtime confirms the box stopped. */
  stopping?: Promise<void> | null;
}

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
  /** Bumped by every access change of a project; an open that saw another generation re-checks before it returns. */
  readonly #accessGeneration = new Map<string, number>();
  readonly #now: () => number;
  readonly #onCapacity: (() => void) | undefined;
  readonly #backend: BoxBackendOptions;
  readonly #profile: boolean;
  readonly #stopListeners = new Set<(projectId: string) => void>();

  constructor(readonly store: TransactionStore, readonly config: AppConfig, readonly runtime: BoxRuntime, options: BoxManagerOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#onCapacity = options.onCapacity;
    this.#backend = options.backend ?? {};
    this.#profile = options.profile === true;
  }

  /** Called after a project's box stopped or was reset (browser sessions close with it). Returns the unsubscribe. */
  onStopped(listener: (projectId: string) => void): () => void {
    this.#stopListeners.add(listener);
    return () => this.#stopListeners.delete(listener);
  }

  #stopped(projectId: string): void {
    for (const listener of [...this.#stopListeners]) { try { listener(projectId); } catch { /* Listeners never block a stop. */ } }
  }

  /**
   * Admission check for one execution job (`jobs.queue_admission/v1`), inside the queue's transaction: true when the
   * project already holds a box, or when the projects holding one — running, opening or stopping boxes and projects
   * with an admitted execution job — leave a free slot. A project whose box is being reset admits nothing until the
   * reset has committed.
   */
  hasCapacity(tx: AppTransaction, projectId: string): boolean {
    if (this.#slots.get(projectId)?.resetting) return false;
    const holders = this.#holders(tx);
    return holders.has(projectId) || holders.size < this.config.execution.maxBoxes;
  }

  #holders(tx: AppTransaction | null): Set<string> {
    const holders = new Set([...this.#slots].filter(([, slot]) => slot.handle || slot.opening || slot.stopping || slot.resetting).map(([id]) => id));
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

  /** The level one role may use now, or the refusal; the guard every open and every runner call goes through. */
  #mode(projectId: string, roleId: string | null): BoxMode {
    return this.store.read(tx => assertExecutionAllowed(tx, projectId, roleId, "workspace")) === "full" ? "full" : "workspace";
  }

  /**
   * Opens the project's box for one role's work and returns a Schway `ExecutionBackend` over it. The effective level
   * decides the mode; `read` and a halted project never reach the runtime. The level is checked again after the box
   * is ensured and before every runner call, so a narrowing or halt that commits while a box is opening or in use
   * refuses further commands (only `kill` still reaches the runner). Refuses `box_busy` during a reset and
   * `box_capacity` when every slot is held by other projects.
   */
  async open(projectId: string, roleId: string | null, requested: { profile?: boolean } = {}): Promise<BoxSession> {
    const options = { profile: requested.profile ?? this.#profile };
    let mode = this.#mode(projectId, roleId);
    let slot = this.#slots.get(projectId);
    while (slot?.stopping) { await slot.stopping.catch(() => undefined); slot = this.#slots.get(projectId); }
    if (slot?.resetting) throw new AppError("box_busy", 409);
    if (!slot?.handle && !slot?.opening) {
      const holders = this.store.read(tx => this.#holders(tx));
      holders.delete(projectId);
      if (holders.size >= this.config.execution.maxBoxes) throw new AppError("box_capacity", 409);
    }
    if (!slot) { slot = { handle: null, busy: 0, lastUsedAt: this.#now(), opening: null, resetting: false }; this.#slots.set(projectId, slot); }
    const own = slot;
    own.busy++;
    try {
      for (let attempt = 0; ; attempt++) {
        const generation = this.#accessGeneration.get(projectId) ?? 0;
        while (own.opening) await own.opening.catch(() => undefined);
        if (!own.handle || own.verified === false || own.handle.mode !== mode || own.handle.profile !== (options.profile === true)) {
          const opening = this.runtime.ensure(projectId, mode, options);
          own.opening = opening;
          try { own.handle = await opening; own.verified = true; }
          catch (error) { own.handle = null; throw error; }
          finally { own.opening = null; }
        }
        // The access level may have changed while the box was being ensured: always re-read it, and start over when an
        // access command committed in between (`accessChanged` bumped the generation).
        const now = this.#mode(projectId, roleId);
        if (now === own.handle!.mode && generation === (this.#accessGeneration.get(projectId) ?? 0)) break;
        if (levelRank(now) < levelRank(own.handle!.mode) || attempt >= 2) { await this.#stopSlot(projectId, own).catch(() => undefined); throw new AppError("access_level_insufficient", 409, { effective: now, needed: own.handle!.mode }); }
        mode = now;
      }
    } catch (error) {
      own.busy--;
      if (!own.handle && own.busy === 0 && this.#slots.get(projectId) === own) { this.#slots.delete(projectId); this.#onCapacity?.(); }
      if (error instanceof AppError && (error.code === "execution_halted" || error.code === "access_level_insufficient") && own.handle) {
        await this.#stopSlot(projectId, own).catch(() => undefined);
      }
      throw error;
    }
    own.lastUsedAt = this.#now();
    const handle = own.handle!;
    let released = false;
    const guarded: Pick<BoxRuntime, "exec"> = {
      exec: (target, request) => {
        // Cancellation must always reach the runner; every other request needs the level the box runs in.
        const op = (() => { try { return (JSON.parse(new TextDecoder().decode(request.input)) as { op?: unknown }).op; } catch { return null; } })();
        if (op !== "kill") {
          // A session is bound to the container it opened: once another open restarted the box (in another mode, for
          // another role), this session's commands would reach a box with different network rights, so they are refused.
          if (own.handle !== handle || this.#slots.get(projectId) !== own) throw new AppError("access_level_insufficient", 409, { effective: handle.mode, needed: handle.mode, reason: "box_restarted" });
          const now = this.#mode(projectId, roleId);
          if (levelRank(now) < levelRank(handle.mode)) throw new AppError("access_level_insufficient", 409, { effective: now, needed: handle.mode });
        }
        return this.runtime.exec(target, request);
      },
    };
    return {
      handle,
      backend: createBoxBackend(guarded, handle, this.#backend),
      release: () => {
        if (released) return;
        released = true; own.busy--; own.lastUsedAt = this.#now();
      },
    };
  }

  /** True while any open session uses the project's box or a reset or stop is in progress. */
  busy(projectId: string): boolean {
    const slot = this.#slots.get(projectId);
    return !!slot && (slot.busy > 0 || slot.resetting || !!slot.opening || !!slot.stopping);
  }

  /** Projects whose box Jit currently holds (running, opening or stopping), sorted. */
  holding(): string[] { return [...this.#holders(null)].sort(); }

  /**
   * Stops one slot's box. The slot keeps its capacity until the runtime confirms the stop; a failed stop leaves the
   * slot in place (still counted, retried by the next sweep or stop) and rethrows.
   */
  #stopSlot(projectId: string, slot: Slot): Promise<void> {
    if (slot.stopping) return slot.stopping;
    const stopping = (async () => {
      await this.runtime.stop({ projectId });
      if (this.#slots.get(projectId) === slot) this.#slots.delete(projectId);
      slot.handle = null;
      this.#stopped(projectId);
      this.#onCapacity?.();
    })().finally(() => { slot.stopping = null; });
    slot.stopping = stopping;
    return stopping;
  }

  /** Stops every box idle for `execution.idleMinutes` at `now`; returns the project ids whose stop was confirmed. */
  async sweep(now = this.#now()): Promise<string[]> {
    const idleMs = this.config.execution.idleMinutes * 60_000, stopped: string[] = [];
    for (const [projectId, slot] of [...this.#slots]) {
      if (slot.busy > 0 || slot.opening || slot.stopping || slot.resetting || now - slot.lastUsedAt < idleMs) continue;
      if (!slot.handle) { this.#slots.delete(projectId); continue; }
      try { await this.#stopSlot(projectId, slot); stopped.push(projectId); }
      catch { /* Still running: the slot keeps its capacity and the next sweep retries. */ }
    }
    return stopped;
  }

  /** Stops the project's box now (kill switch, narrowing); the halt already fenced the work using it. */
  async stop(projectId: string): Promise<void> {
    const slot = this.#slots.get(projectId);
    if (slot) return this.#stopSlot(projectId, slot);
    await this.runtime.stop({ projectId });
    this.#stopped(projectId);
  }

  /**
   * After an access command commits: a halt, a level of `read`, or a level below the running box's mode stops the
   * box (commands in it are killed). Every change bumps the project's access generation, so an open still waiting for
   * its box re-reads the level once the box is ensured and refuses if it fell. A wider
   * level applies on the next open, which restarts the box in the new mode.
   */
  async accessChanged(projectId: string): Promise<void> {
    this.#accessGeneration.set(projectId, (this.#accessGeneration.get(projectId) ?? 0) + 1);
    const slot = this.#slots.get(projectId);
    if (!slot?.handle) return;
    const access = this.store.read(tx => readProjectAccess(tx, projectId, this.config));
    const level: AccessLevel = effectiveAccess(access, null).level;
    if (level === "read" || levelRank(level) < levelRank(slot.handle.mode)) await this.stop(projectId);
  }

  /**
   * Removes the project's box (and with `wipeWorkspace` its workspace), then runs `commit` (the owner receipt) while
   * still holding the reset: from the start of the reset until `commit` returns, the project admits no execution job
   * (`hasCapacity` is false) and opens are `box_busy`. `before` runs once the reset holds, before anything is removed
   * (the caller re-checks admitted execution work there). Refuses `box_busy` while the box is in use.
   */
  async reset<T>(projectId: string, wipeWorkspace: boolean, steps: { before?: () => void; commit: () => T }): Promise<T> {
    if (this.busy(projectId)) throw new AppError("box_busy", 409);
    const slot: Slot = this.#slots.get(projectId) ?? { handle: null, busy: 0, lastUsedAt: this.#now(), opening: null, resetting: false };
    slot.resetting = true;
    this.#slots.set(projectId, slot);
    try {
      steps.before?.();
      slot.handle = null;
      await this.runtime.reset({ projectId }, { wipeWorkspace });
      this.#stopped(projectId);
      return steps.commit();
    } finally {
      if (this.#slots.get(projectId) === slot) this.#slots.delete(projectId);
      this.#onCapacity?.();
    }
  }
}
