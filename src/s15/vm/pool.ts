import { randomBytes } from "node:crypto";
import type { VmStore } from "./store";
import type { VmSession, WorkingVmPort } from "./types";
import { vmFail, vmId, vmInteger } from "./validation";

/** Protected per-member pool facts. Status, capability rows and facts come from enrollment, not from here. */
export interface VmPoolMember { id: string; isDefault: boolean; drained: boolean; activeSessions: number; capacity: number; works: number }
/** Composition options. The pool id names the team's working-computer resource and its default member. */
export interface VmPoolOptions {
  store: VmStore;
  /** Pool id, which is also the default member id (the Jit-created local VM when present). */
  id: string;
  /** Runtime per-VM session ceiling (`VmLimits.maxSessions`); each member's own maximum is also applied. */
  maxSessions?: number;
  now?: () => number;
  /**
   * TEAM16-01 computer scopes (explicit S16 computers). `privateBot` names the Bot a member is privately
   * assigned to (null: shared); a private member never becomes shared. `assigned` lists a Bot's current
   * (not retired) private members, including one still being set up. Both read protected journal state,
   * never a model or guest claim. Absent, every member is shared and placement ignores Bots.
   */
  scope?: { privateBot(vm: string): string | null; assigned(botId: string): readonly string[] };
  /** TEAM16-01: members Jit stopped for idleness are placeable; the VM service starts them on demand. */
  wakeable?: boolean;
}
interface Candidate { id: string; state: string; networkIsolated: boolean; bindingMac?: string; maxSessions: number; reason: string | null }
/** Registry reason the VM service writes when it stopped an idle member itself (`vmIdleReason`). */
const idleReason = "vm_idle";

/**
 * The team's working computer as a pool of enrolled VMs (POOL15-01). Members are the protected enrollment
 * records in the VM journal; nobody writes a pool list. Placement and drain state are protected journal
 * rows; neither a model, a guest nor a conversation can choose a VM id, endpoint or member.
 *
 * Placement for new work picks only `ready`, isolation-proven, hypervisor-bound, undrained members with a
 * free session slot, least loaded by active sessions over capacity, ties going to the default member and
 * then to enrollment order. Work affinity is durable: once a work opened an execution session on a member,
 * every later attempt of that work returns to it (its workspace lives there), whatever that member's load,
 * drain or state; a stopped member reports `vm_stopped` and other non-ready states keep their own reason.
 * Files never move between members. Leases, POLICY snapshot fences, stop proof and uncertainty fencing stay
 * per member because each member is a separate `WorkingVmService` VM id.
 */
export class VmPool {
  readonly id: string;
  readonly #maxSessions: number;
  readonly #now: () => number;
  constructor(readonly options: VmPoolOptions) {
    vmId(options.id); vmInteger(options.maxSessions ?? 16, 64); this.id = options.id; this.#maxSessions = options.maxSessions ?? 16; this.#now = options.now ?? Date.now;
    options.store.transaction(() => {
      const created = !options.store.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='vm_affinity'").get();
      options.store.db.exec(`CREATE TABLE IF NOT EXISTS vm_pool (vm_id TEXT PRIMARY KEY, drained INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS vm_affinity (work_id TEXT PRIMARY KEY, vm_id TEXT NOT NULL, placed_at INTEGER NOT NULL);`);
      // An installation from before the pool already has workspaces: seed each work's affinity once, from the
      // VM of its first recorded session, before any placement can send that work elsewhere.
      if (created) options.store.db.query(`INSERT INTO vm_affinity (work_id, vm_id, placed_at) SELECT work_id, vm_id, 0 FROM vm_sessions
        WHERE rowid IN (SELECT min(rowid) FROM vm_sessions GROUP BY work_id) ON CONFLICT(work_id) DO NOTHING`).run();
    });
  }
  /** Whether `vm` is the default member or an enrolled member of this pool. */
  has(vm: string): boolean { return vm === this.id || !!this.options.store.db.query("SELECT id FROM vm_registry WHERE id=?").get(vm); }
  private rows(): Candidate[] {
    return this.options.store.db.query<{ data: string }, []>("SELECT data FROM vm_registry ORDER BY rowid").all().map(row => JSON.parse(row.data) as Candidate);
  }
  private drained(vm: string): boolean { return this.options.store.db.query<{ drained: number }, [string]>("SELECT drained FROM vm_pool WHERE vm_id=?").get(vm)?.drained === 1; }
  private active(vm: string): { count: number; system: boolean } {
    const rows = this.options.store.db.query<{ mode: string }, [string]>("SELECT mode FROM vm_sessions WHERE vm_id=? AND state<>'closed'").all(vm);
    return { count: rows.length, system: rows.some(row => row.mode === "system") };
  }
  private capacity(row: Candidate): number { return Math.max(0, Math.min(row.maxSessions, this.#maxSessions)); }
  /** Member that holds this work's workspace, if any. */
  holder(workId: string): string | null {
    vmId(workId);
    return this.options.store.db.query<{ vm_id: string }, [string]>("SELECT vm_id FROM vm_affinity WHERE work_id=?").get(workId)?.vm_id ?? null;
  }
  /**
   * Protected placement for one attempt of `workId`. Returns the member that holds the work's workspace, or
   * for new work the least-loaded eligible member. With no eligible member it returns the same refusal the
   * single VM gives: `vm_capacity` when ready members are full, `vm_drained` when every ready member is
   * drained, otherwise the default member id so the VM service reports its own exact reason.
   */
  place(workId: string, botId?: string): string {
    const scope = this.options.scope;
    if (scope && botId === undefined) vmFail("outside_scope", 403);
    const sleeping = (row: Candidate) => !!this.options.wakeable && row.state === "stopped" && row.reason === idleReason && !!row.bindingMac;
    const bound = this.holder(workId);
    if (bound) {
      // A work's workspace never moves, and a private member never serves another Bot's work.
      const owner = scope?.privateBot(bound) ?? null;
      if (owner !== null && owner !== botId) vmFail("outside_scope", 403);
      const row = this.rows().find(candidate => candidate.id === bound);
      if (row?.state === "stopped" && !sleeping(row)) vmFail("vm_stopped", 423);
      return bound;
    }
    // TEAM16-01: a Bot with a private computer uses only it (waiting while it is set up); other Bots use shared members.
    const own = scope ? scope.assigned(botId!) : [];
    const rows = this.rows().filter(row => !scope || (own.length ? own.includes(row.id) && scope.privateBot(row.id) === botId : scope.privateBot(row.id) === null));
    if (own.length && !rows.length) vmFail("vm_private_preparing", 423);
    const ready = rows.filter(row => row.state === "ready" && row.networkIsolated && !!row.bindingMac || sleeping(row));
    const open = ready.filter(row => !this.drained(row.id));
    const scored = open.map(row => ({ row, active: this.active(row.id), capacity: this.capacity(row), asleep: sleeping(row) })).filter(item => !item.active.system && item.active.count < item.capacity);
    if (!scored.length) {
      if (open.length) vmFail("vm_capacity");
      if (ready.length) vmFail("vm_drained", 423);
      // The VM service reports the exact reason; a private Bot's work never falls back to a shared member.
      return own.length ? rows[0]!.id : this.id;
    }
    // A running member before one that must be started; then lowest load ratio (exact integer comparison,
    // a/b < c/d ⇔ a·d < c·b), then the default member.
    scored.sort((a, b) => Number(a.asleep) - Number(b.asleep) || a.active.count * b.capacity - b.active.count * a.capacity || Number(b.row.id === this.id) - Number(a.row.id === this.id));
    return scored[0]!.row.id;
  }
  /** Records the member now holding this work's workspace. The first binding wins and is never moved. */
  bind(workId: string, vm: string): string {
    vmId(workId); vmId(vm);
    this.options.store.db.query("INSERT INTO vm_affinity VALUES (?,?,?) ON CONFLICT(work_id) DO NOTHING").run(workId, vm, this.#now());
    return this.holder(workId)!;
  }
  /** Drains (no new placement; bound work keeps its member) or returns a member to service. Never evicts work. */
  setDrained(vm: string, drained: boolean): void {
    vmId(vm); if (!this.options.store.db.query("SELECT id FROM vm_registry WHERE id=?").get(vm)) vmFail("vm_not_enrolled", 404);
    this.options.store.db.query("INSERT INTO vm_pool VALUES (?,?) ON CONFLICT(vm_id) DO UPDATE SET drained=excluded.drained").run(vm, drained ? 1 : 0);
  }
  /** Members in enrollment order, default first, with protected load and drain facts. */
  members(): VmPoolMember[] {
    const rows = this.rows();
    return [...rows.filter(row => row.id === this.id), ...rows.filter(row => row.id !== this.id)].map(row => {
      const active = this.active(row.id);
      return { id: row.id, isDefault: row.id === this.id, drained: this.drained(row.id), activeSessions: active.count, capacity: this.capacity(row),
        works: this.options.store.db.query<{ n: number }, [string]>("SELECT count(*) n FROM vm_affinity WHERE vm_id=?").get(row.id)!.n };
    });
  }
  /**
   * Id for the next owner-supplied member; the owner never types one. The default id goes to the first
   * computer unless `reserveDefault` (a Jit-created default is being provisioned) keeps it for that job.
   */
  nextId(reserveDefault = false): string {
    if (!reserveDefault && !this.options.store.db.query("SELECT id FROM vm_registry WHERE id=?").get(this.id)) return this.id;
    for (;;) { const id = `computer_${randomBytes(4).toString("hex")}`; if (!this.has(id)) return id; }
  }
}

/**
 * Pool-placing working-VM port. Consumers pass the pool id as `vmId`; any other id is refused. Placement
 * runs per attempt, serialised per work so two first attempts of one work cannot land on different members.
 * An execution session binds the work's affinity once it opened; inspection reads from the holder (or a
 * placed member for work with no workspace yet) without creating affinity.
 */
export function placeWorkingVm(port: WorkingVmPort, pool: VmPool, bot?: (actor: object) => string): WorkingVmPort {
  const chains = new Map<string, Promise<unknown>>();
  return { async openAttempt(actor, input) {
    if (input.vmId !== pool.id) vmFail("vm_policy_denied", 403);
    vmId(input.workId);
    const previous = chains.get(input.workId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(async (): Promise<VmSession> => {
      const vm = pool.place(input.workId, bot?.(actor));
      const session = await port.openAttempt(actor, { ...input, vmId: vm });
      if ((input.access ?? "execute") === "execute") {
        try { pool.bind(input.workId, vm); } catch (error) { await session.close().catch(() => {}); throw error; }
      }
      return session;
    });
    chains.set(input.workId, run);
    try { return await run; } finally { if (chains.get(input.workId) === run) chains.delete(input.workId); }
  } };
}
