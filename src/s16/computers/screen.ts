import { AppError } from "../../errors";
import { canonical, digest, exact, identity, integer } from "../../s15/conversation/validation";
import { vmScreenHeight, vmScreenInput, vmScreenWidth, type VmScreenDevice, type VmScreenInput } from "../../s15/vm/screen";
import type { VmStore } from "../../s15/vm/store";
import type { ComputerScope } from "./scopes";

/**
 * Who may write to a working computer's screen (`s16-computer-screen/v1`, DESK16-01):
 * - `agent`: work may use the computer; the owner can watch.
 * - `settling`: the owner asked for control; new work operations are refused and the owner waits until every
 *   work operation admitted under the previous generation has settled.
 * - `owner`: only the owner's input reaches the screen, under the current generation and takeover id.
 * - `fenced`: control was lost while the owner held it (lease expiry, closed tab, controller restart). Nobody
 *   writes until the owner takes control again or hands the computer back.
 */
export type ScreenControlState = "agent" | "settling" | "owner" | "fenced";
/** Owner projection of one computer's screen. Frames are this computer's private data in `scope`. */
export interface ScreenView {
  contract: "s16-computer-screen/v1"; vmId: string;
  /** Whether frames can be read now; `code` is the stable reason when not. */
  available: boolean; code: string | null; width: number; height: number;
  state: ScreenControlState; generation: number; takeoverId: string | null;
  /** When owner control lapses without a renewal; null outside `settling`/`owner`. */
  expiresAt: number | null;
  /** Work operations still running from before the takeover (only meaningful while `settling`). */
  agentBusy: boolean;
  /** Lineage of every frame: the computer's scope. A private computer's frames are its Bot's private data. */
  scope: ComputerScope;
}
/** Exact owner command. `generation` is the one the owner last saw; any change makes the command stale. */
export type ScreenCommand = { contract: "s16-screen-command/v1"; requestId: string; vmId: string } & (
  | { kind: "takeover"; generation: number }
  | { kind: "renew"; generation: number; takeoverId: string }
  | { kind: "input"; generation: number; takeoverId: string; input: VmScreenInput }
  | { kind: "hand_back"; generation: number; takeoverId: string | null });
export interface ScreenCommandResult { contract: "s16-screen-command-result/v1"; requestId: string; view: ScreenView }

/** Protected composition only; none of these ports is reachable from a model, guest or conversation. */
export interface ScreenControlOptions<Owner> {
  store: VmStore;
  requireOwner(actor: Owner): void;
  /** Host-side screen of an enrolled computer, or null when its manager has no desktop profile. */
  device(vmId: string): VmScreenDevice | null;
  scope(vmId: string): ComputerScope;
  now?: () => number;
  /** Owner control lapses this long after the last renewal (default 30 s). */
  leaseMs?: number;
}
interface Row { vm_id: string; generation: number; state: ScreenControlState; takeover_id: string | null; expires_at: number | null }
/** A work operation admitted under one generation. `current()` refuses once the owner asked for control. */
export interface ScreenAgentTicket { current(): void; end(): void }

const uuid = () => crypto.randomUUID().replaceAll("-", "");
const stale = () => new AppError("stale_screen", 409);

/**
 * DESK16-01 exclusive screen control for working computers. Every transition advances the generation, so
 * frames and input from before a takeover, fence or hand-back are refused (`stale_screen`). Work operations
 * hold an agent ticket from admission until settlement; owner input starts only after every ticket of the
 * previous generation ended, and work starts again only after the owner's last input settled. Owner input is
 * sent once and never stored: no typed text, hash of it or frame enters the journal, history or memory.
 */
export class ScreenControl<Owner> {
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #tickets = new Map<string, Set<object>>();
  readonly #ownerTail = new Map<string, Promise<void>>();
  readonly #closing = new Set<string>();
  /**
   * Input request ids attempted under the current owner generation, kept in memory only (never the text). A retry
   * joins a running send, returns the view after a finished one, and is refused (`screen_input_unknown`) after a
   * send that failed once events may have reached the VM; only a refusal before sending releases the id. Entries of
   * earlier generations are dropped on every transition: a retry under an old generation is refused as stale anyway.
   */
  readonly #inputs = new Map<string, { generation: number; vm: string; state: "sending" | "sent" | "unknown"; run: Promise<void> }>();
  constructor(readonly options: ScreenControlOptions<Owner>) {
    this.#now = options.now ?? Date.now; this.#leaseMs = options.leaseMs ?? 30_000; integer(this.#leaseMs, 1000, 600_000);
    options.store.db.exec(`CREATE TABLE IF NOT EXISTS s16_screen_control (vm_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('agent','settling','owner','fenced')), takeover_id TEXT, expires_at INTEGER);
      CREATE TABLE IF NOT EXISTS s16_screen_commands (id TEXT PRIMARY KEY, hash TEXT NOT NULL, vm_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS s16_screen_events (sequence INTEGER PRIMARY KEY, vm_id TEXT NOT NULL, kind TEXT NOT NULL, generation INTEGER NOT NULL, at INTEGER NOT NULL);`);
    // Controller restart: control the owner held (or was acquiring) is fenced, never silently returned to work.
    options.store.transaction(() => {
      for (const row of options.store.db.query<Row, []>("SELECT * FROM s16_screen_control WHERE state IN ('settling','owner')").all()) this.write(row.vm_id, row.generation + 1, "fenced", null, null, "fenced_restart");
    });
  }
  private write(vm: string, generation: number, state: ScreenControlState, takeover: string | null, expires: number | null, event: string): Row {
    for (const [id, entry] of this.#inputs) if (entry.vm === vm && entry.generation < generation) this.#inputs.delete(id);
    this.options.store.db.query("INSERT INTO s16_screen_control VALUES (?,?,?,?,?) ON CONFLICT(vm_id) DO UPDATE SET generation=excluded.generation, state=excluded.state, takeover_id=excluded.takeover_id, expires_at=excluded.expires_at").run(vm, generation, state, takeover, expires);
    this.options.store.db.query("INSERT INTO s16_screen_events(vm_id,kind,generation,at) VALUES (?,?,?,?)").run(vm, event, generation, this.#now());
    return { vm_id: vm, generation, state, takeover_id: takeover, expires_at: expires };
  }
  /** Current row; a lapsed owner lease becomes `fenced` under a new generation as it is read. */
  private row(vm: string): Row {
    const row = this.options.store.db.query<Row, [string]>("SELECT * FROM s16_screen_control WHERE vm_id=?").get(vm) ?? { vm_id: vm, generation: 0, state: "agent", takeover_id: null, expires_at: null };
    if ((row.state === "owner" || row.state === "settling") && row.expires_at !== null && row.expires_at <= this.#now())
      return this.options.store.transaction(() => this.write(vm, row.generation + 1, "fenced", null, null, "fenced_lapsed"));
    return row;
  }
  private known(vm: string): void { identity(vm); this.options.store.registration(vm); }
  private busy(vm: string): boolean { return (this.#tickets.get(vm)?.size ?? 0) > 0; }
  /** `settling` becomes `owner` once the last ticket of the previous generation ended. */
  private settle(vm: string): void {
    if (this.busy(vm)) return;
    this.options.store.transaction(() => {
      const row = this.row(vm);
      if (row.state === "settling") this.write(vm, row.generation, "owner", row.takeover_id, row.expires_at, "owner_control");
    });
  }

  /**
   * Admits one work operation on `vm` (WorkingVmService). Refused with `takeover_active` unless work holds the
   * screen. The ticket must be ended exactly once, after the operation settled (finished, failed or unknown).
   */
  agentInput(vm: string): ScreenAgentTicket {
    const admitted = this.row(vm);
    if (admitted.state !== "agent") throw new AppError("takeover_active", 409);
    const token = {}, set = this.#tickets.get(vm) ?? new Set<object>(); set.add(token); this.#tickets.set(vm, set);
    let ended = false;
    return {
      current: () => { const row = this.row(vm); if (ended || row.state !== "agent" || row.generation !== admitted.generation) throw new AppError("takeover_active", 409); },
      end: () => { if (ended) return; ended = true; set.delete(token); if (!set.size) this.#tickets.delete(vm); this.settle(vm); },
    };
  }
  /** Idle release never stops a computer the owner holds or lost control of. */
  idleBlocked(vm: string): boolean { return this.row(vm).state !== "agent"; }

  /** Authenticated owner projection. Reading starts, stops or changes nothing except lapsing an expired lease. */
  async view(actor: Owner, vm: string): Promise<ScreenView> {
    this.options.requireOwner(actor); this.known(vm);
    const device = this.options.device(vm), code = device ? await device.unavailable() : "vm_desktop_unavailable";
    this.options.requireOwner(actor);
    const row = this.row(vm);
    return { contract: "s16-computer-screen/v1", vmId: vm, available: code === null, code, width: vmScreenWidth, height: vmScreenHeight,
      state: row.state, generation: row.generation, takeoverId: row.state === "owner" || row.state === "settling" ? row.takeover_id : null,
      expiresAt: row.state === "owner" || row.state === "settling" ? row.expires_at : null, agentBusy: row.state === "settling" && this.busy(vm), scope: this.options.scope(vm) };
  }
  /**
   * One PNG frame for the owner, under the generation the owner last saw. A frame captured across a
   * transition is dropped (`stale_screen`), so an old frame never appears as the current screen.
   */
  async frame(actor: Owner, vm: string, generation: number): Promise<Uint8Array> {
    this.options.requireOwner(actor); this.known(vm); integer(generation);
    if (this.row(vm).generation !== generation) throw stale();
    const device = this.options.device(vm); if (!device) throw new AppError("vm_desktop_unavailable", 409);
    const bytes = await device.capture();
    this.options.requireOwner(actor);
    if (this.row(vm).generation !== generation) throw stale();
    return bytes;
  }

  /** One exact owner command. Takeover and hand-back are idempotent per `requestId`; input is sent at most once per `requestId` in this process. */
  async command(actor: Owner, input: unknown): Promise<ScreenCommandResult> {
    this.options.requireOwner(actor);
    const command = parseScreenCommand(input), vm = command.vmId; this.known(vm);
    const result = async (): Promise<ScreenCommandResult> => ({ contract: "s16-screen-command-result/v1", requestId: command.requestId, view: await this.view(actor, vm) });
    if (command.kind === "input") {
      const prior = this.#inputs.get(command.requestId);
      if (prior) {
        if (prior.state === "unknown") throw new AppError("screen_input_unknown", 409);
        await prior.run;
        return result();
      }
      let reached = false;
      const entry = { generation: command.generation, vm, state: "sending" as "sending" | "sent" | "unknown", run: Promise.resolve() };
      this.#inputs.set(command.requestId, entry);
      entry.run = this.input(actor, command, () => { reached = true; });
      try { await entry.run; entry.state = "sent"; }
      catch (error) { if (reached) entry.state = "unknown"; else if (this.#inputs.get(command.requestId) === entry) this.#inputs.delete(command.requestId); throw error; }
      return result();
    }
    if (command.kind === "renew") {
      // Renewal is idempotent by itself, so it is not journaled per request.
      this.options.store.transaction(() => {
        this.options.requireOwner(actor);
        this.held(vm, command.generation, command.takeoverId);
        this.options.store.db.query("UPDATE s16_screen_control SET expires_at=? WHERE vm_id=?").run(this.#now() + this.#leaseMs, vm);
      });
      return result();
    }
    const hash = digest(canonical(command));
    const prior = this.options.store.db.query<{ hash: string }, [string]>("SELECT hash FROM s16_screen_commands WHERE id=?").get(command.requestId);
    if (prior) { if (prior.hash !== hash) throw new AppError("request_id_conflict", 409); return result(); }
    if (command.kind === "takeover") {
      const device = this.options.device(vm), code = device ? await device.unavailable() : "vm_desktop_unavailable";
      if (code) throw new AppError(code, 409);
      this.options.store.transaction(() => {
        this.options.requireOwner(actor);
        const row = this.row(vm);
        if (row.state !== "agent" && row.state !== "fenced") throw new AppError("takeover_state_changed", 409);
        if (row.generation !== command.generation) throw stale();
        this.write(vm, row.generation + 1, this.busy(vm) ? "settling" : "owner", uuid(), this.#now() + this.#leaseMs, this.busy(vm) ? "takeover_settling" : "takeover");
        this.record(command.requestId, hash, vm);
      });
      return result();
    }
    // Hand-back: refuse new owner input, wait for the owner's last input to settle, then return the screen to work.
    const row = this.row(vm);
    if (row.state === "agent") throw new AppError("takeover_state_changed", 409);
    if (row.generation !== command.generation || (row.state !== "fenced" && row.takeover_id !== command.takeoverId)) throw stale();
    this.#closing.add(vm);
    try {
      await (this.#ownerTail.get(vm) ?? Promise.resolve()).catch(() => {});
      this.options.store.transaction(() => {
        this.options.requireOwner(actor);
        const current = this.row(vm);
        if (current.generation !== row.generation || current.state === "agent") throw stale();
        this.write(vm, current.generation + 1, "agent", null, null, "hand_back");
        this.record(command.requestId, hash, vm);
      });
    } finally { this.#closing.delete(vm); }
    return result();
  }
  private record(id: string, hash: string, vm: string): void { this.options.store.db.query("INSERT INTO s16_screen_commands VALUES (?,?,?)").run(id, hash, vm); }
  private held(vm: string, generation: number, takeover: string): Row {
    const row = this.row(vm);
    if (row.state !== "owner" && row.state !== "settling") throw new AppError(row.state === "fenced" ? "screen_control_lost" : "takeover_state_changed", 409);
    if (row.generation !== generation || row.takeover_id !== takeover) throw stale();
    return row;
  }
  /** Owner input, serialized per computer and checked against the live row immediately before it is sent. */
  private async input(actor: Owner, command: Extract<ScreenCommand, { kind: "input" }>, sending: () => void): Promise<void> {
    const vm = command.vmId, device = this.options.device(vm); if (!device) throw new AppError("vm_desktop_unavailable", 409);
    const check = () => {
      this.options.requireOwner(actor);
      if (this.#closing.has(vm)) throw stale();
      const row = this.held(vm, command.generation, command.takeoverId);
      if (row.state === "settling") throw new AppError("takeover_settling", 409);
    };
    check();
    const previous = this.#ownerTail.get(vm) ?? Promise.resolve(), turn = previous.catch(() => {}).then(async () => { check(); sending(); await device.send(command.input); });
    const tail = turn.catch(() => {}); this.#ownerTail.set(vm, tail);
    try { await turn; } finally { if (this.#ownerTail.get(vm) === tail) this.#ownerTail.delete(vm); }
  }
}

/** Closed parser for `s16-screen-command/v1`. Input bounds are checked by `vmScreenInput`. */
export function parseScreenCommand(value: unknown): ScreenCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_body");
  const kind = (value as { kind?: unknown }).kind, base = ["contract", "requestId", "kind", "vmId", "generation"];
  if (kind === "takeover") exact(value, base);
  else if (kind === "renew" || kind === "hand_back") exact(value, [...base, "takeoverId"]);
  else if (kind === "input") exact(value, [...base, "takeoverId", "input"]);
  else throw new AppError("invalid_body");
  const v = value as Record<string, unknown>;
  if (v.contract !== "s16-screen-command/v1") throw new AppError("invalid_contract");
  identity(v.requestId); identity(v.vmId); integer(v.generation);
  if (kind === "renew" || kind === "input" || kind === "hand_back" && v.takeoverId !== null) identity(v.takeoverId);
  if (kind === "input") return { ...(structuredClone(value) as ScreenCommand), input: vmScreenInput(v.input) } as ScreenCommand;
  return structuredClone(value) as ScreenCommand;
}
