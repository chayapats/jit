import { AppError } from "../../errors";
import { canonical, digest, exact, identity } from "../../s15/conversation/validation";
import type { LocalVmProvisioning, LocalVmProvisioningView } from "../../s15/vm/provisioning";
import type { VmPool } from "../../s15/vm/pool";
import type { WorkingVmService } from "../../s15/vm/service";
import { vmIdleReason } from "../../s15/vm/service";
import type { VmStore } from "../../s15/vm/store";
import type { VmStatus } from "../../s15/vm/types";
import type { ComputerScope, ComputerScopes } from "./scopes";

/** Owner-visible lifecycle of one working computer, derived only from protected journal facts. */
export type ComputerState = "running" | "sleeping" | "starting" | "stopping" | "stopped" | "setting_up" | "setup_failed" | "attention";
/** One computer row of `s16-client-computers/v1`. Ids are opaque; no endpoint, key or manager detail. */
export interface ComputerView {
  id: string; isDefault: boolean; scope: ComputerScope; retired: boolean; local: boolean;
  state: ComputerState; reason: string | null;
  activeSessions: number; capacity: number; works: number; drained: boolean;
  /** When idle release will stop it if nothing starts first; null while busy, stopped or without idle release. */
  sleepsAt: number | null;
  /** Setup progress of a Jit-created private computer, or null. */
  setup: { step: LocalVmProvisioningView["step"]; error: string | null; active: boolean } | null;
}
/** Bots of the current standing policy and the computer their new work uses. */
export interface ComputerBotView { id: string; main: boolean; computer: { kind: "shared" } | { kind: "private"; vmId: string } }
/** Authenticated owner projection (`s16-client-computers/v1`). */
export interface ComputersView {
  contract: "s16-client-computers/v1"; idleStopMs: number | null; computers: ComputerView[]; bots: ComputerBotView[];
  /** Whether "give a Bot its own computer" can create one on this controller now, else the stable reason. */
  privateCreation: { available: true } | { available: false; code: string };
}
/** Exact owner command (`s16-computer-command/v1`). `requestId` makes a retried submission return its first result. */
export type ComputerCommand = { contract: "s16-computer-command/v1"; requestId: string } & (
  { kind: "create_private"; botId: string } | { kind: "retry_private"; vmId: string } | { kind: "retire_private"; vmId: string } | { kind: "sleep"; vmId: string });
/** Command result: the affected computer id and the fresh projection. */
export interface ComputerCommandResult { contract: "s16-computer-command-result/v1"; requestId: string; vmId: string; view: ComputersView }

/** Protected composition only. None of these ports is reachable from a model, guest or conversation. */
export interface ComputerDirectoryOptions<Owner extends object> {
  store: VmStore; pool: VmPool; scopes: ComputerScopes; vm: WorkingVmService;
  requireOwner(actor: Owner): void;
  status(actor: Owner, vmId: string): VmStatus;
  /** Bots of the current standing policy; `main` is the conversation Bot. */
  bots(actor: Owner): { id: string; main: boolean }[];
  /** Jit-created private computers on this KVM controller; absent when this controller creates no local VMs. */
  local?: {
    /** Null when a private computer can be created now, else the stable host refusal. Never creates anything. */
    unavailable(): string | null;
    /** Protected setup job for exactly this member id (resumable, idempotent). */
    job(vmId: string): LocalVmProvisioning;
    /** Whether a member is a Jit-created local VM. */
    isLocal(vmId: string): boolean;
  };
}

/**
 * TEAM16-01 owner directory of working computers: the shared pool members, each Bot's private computer and
 * its setup job, and idle release. Commands are authenticated, exact and idempotent per `requestId`.
 * Nothing here grants work authority; placement, leases, POLICY and the VM service still decide every use.
 */
export class ComputerDirectory<Owner extends object> {
  readonly #jobs = new Map<string, LocalVmProvisioning>();
  constructor(readonly options: ComputerDirectoryOptions<Owner>) {
    options.store.db.exec("CREATE TABLE IF NOT EXISTS s16_computer_commands (id TEXT PRIMARY KEY, hash TEXT NOT NULL, vm_id TEXT NOT NULL)");
    // Controller boot: a private computer whose setup was interrupted resumes; a failed one waits for "Try again".
    if (options.local) for (const row of options.scopes.all()) if (row.retiredAt === null && !this.enrolled(row.vmId)) { try { this.job(row.vmId).ensure(); } catch { /* Visible as setup_failed. */ } }
  }
  private enrolled(vm: string): boolean { return !!this.options.store.db.query("SELECT 1 FROM vm_registry WHERE id=?").get(vm); }
  private job(vm: string): LocalVmProvisioning {
    let job = this.#jobs.get(vm);
    if (!job) { if (!this.options.local) throw new AppError("computer_local_unavailable", 409); job = this.options.local.job(vm); this.#jobs.set(vm, job); }
    return job;
  }
  /** Authenticated owner projection, read from the VM journal, scopes and setup jobs. */
  view(actor: Owner): ComputersView {
    this.options.requireOwner(actor);
    const members = this.options.pool.members(), stopAfter = this.options.vm.idleStopAfterMs, now = this.options.vm.options.now?.() ?? Date.now();
    const computers: ComputerView[] = members.map(member => {
      const status = this.options.status(actor, member.id), scope = this.options.scopes.scope(member.id);
      const retired = scope.kind === "private" && !this.options.scopes.assigned(scope.botId).includes(member.id);
      const last = this.options.vm.lastActivity(member.id);
      const state: ComputerState = status.state === "ready" ? "running" : status.state === "stopped" ? (status.reason === vmIdleReason ? "sleeping" : "stopped")
        : status.reason === "vm_waking" ? "starting" : status.reason === "vm_idle_stopping" ? "stopping" : "attention";
      return { id: member.id, isDefault: member.isDefault, scope, retired, local: this.options.local?.isLocal(member.id) ?? false, state,
        reason: state === "attention" || state === "stopped" ? status.reason : null, activeSessions: member.activeSessions, capacity: member.capacity, works: member.works, drained: member.drained,
        sleepsAt: state === "running" && stopAfter !== null && member.activeSessions === 0 && last !== null ? last + stopAfter : null, setup: null };
    });
    for (const row of this.options.scopes.all()) {
      if (this.enrolled(row.vmId)) continue;
      const job = this.options.local ? this.job(row.vmId).view() : null;
      computers.push({ id: row.vmId, isDefault: false, scope: { kind: "private", botId: row.botId }, retired: row.retiredAt !== null, local: true,
        state: job?.state === "failed" ? "setup_failed" : "setting_up", reason: job?.error ?? null, activeSessions: 0, capacity: 0, works: 0, drained: false, sleepsAt: null,
        setup: job ? { step: job.step, error: job.error, active: job.active } : { step: "host", error: null, active: false } });
    }
    const bots = this.options.bots(actor).map(bot => {
      const own = this.options.scopes.assigned(bot.id)[0];
      return { id: bot.id, main: bot.main, computer: own ? { kind: "private" as const, vmId: own } : { kind: "shared" as const } };
    });
    const unavailable = this.options.local ? this.options.local.unavailable() : "computer_local_unavailable";
    return { contract: "s16-client-computers/v1", idleStopMs: stopAfter, computers, bots, privateCreation: unavailable === null ? { available: true } : { available: false, code: unavailable } };
  }
  /** One exact authenticated owner command; a repeated `requestId` with the same body returns its first result. */
  async command(actor: Owner, input: unknown): Promise<ComputerCommandResult> {
    this.options.requireOwner(actor);
    const command = parseComputerCommand(input), hash = digest(canonical(command));
    const prior = this.options.store.db.query<{ hash: string; vm_id: string }, [string]>("SELECT hash, vm_id FROM s16_computer_commands WHERE id=?").get(command.requestId);
    if (prior) { if (prior.hash !== hash) throw new AppError("request_id_conflict", 409); return { contract: "s16-computer-command-result/v1", requestId: command.requestId, vmId: prior.vm_id, view: this.view(actor) }; }
    let vm: string;
    if (command.kind === "create_private") {
      if (!this.options.bots(actor).some(bot => bot.id === command.botId)) throw new AppError("outside_scope", 403);
      const code = this.options.local ? this.options.local.unavailable() : "computer_local_unavailable";
      if (code) throw new AppError(code, 409);
      vm = this.options.pool.nextId(true);
      this.options.store.transaction(() => {
        this.options.requireOwner(actor);
        this.options.scopes.assignPrivate(vm, command.botId);
        this.options.store.db.query("INSERT INTO s16_computer_commands VALUES (?,?,?)").run(command.requestId, hash, vm);
      });
      this.job(vm).start();
    } else {
      vm = command.vmId;
      const scope = this.options.scopes.scope(vm);
      if (command.kind === "sleep") await this.options.vm.sleepNow(actor, vm);
      else {
        if (scope.kind !== "private") throw new AppError("computer_not_private", 409);
        if (command.kind === "retry_private") { if (this.enrolled(vm) || !this.options.scopes.assigned(scope.botId).includes(vm)) throw new AppError("computer_setup_not_failed", 409); this.job(vm).start(); }
        else this.options.scopes.retire(vm);
      }
      this.options.requireOwner(actor);
      this.options.store.db.query("INSERT OR IGNORE INTO s16_computer_commands VALUES (?,?,?)").run(command.requestId, hash, vm);
    }
    return { contract: "s16-computer-command-result/v1", requestId: command.requestId, vmId: vm, view: this.view(actor) };
  }
  /** Awaits in-process setup jobs (tests and orderly shutdown). */
  async settled(): Promise<void> { await Promise.all([...this.#jobs.values()].map(job => job.settled())); }
  /** Aborts in-process setup runs; their journal rows resume on the next boot. */
  async close(): Promise<void> { await Promise.all([...this.#jobs.values()].map(job => job.close())); }
}

/** Closed parser for `s16-computer-command/v1`. */
export function parseComputerCommand(value: unknown): ComputerCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_body");
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "create_private") exact(value, ["contract", "requestId", "kind", "botId"]);
  else if (kind === "retry_private" || kind === "retire_private" || kind === "sleep") exact(value, ["contract", "requestId", "kind", "vmId"]);
  else throw new AppError("invalid_body");
  const v = value as Record<string, unknown>;
  if (v.contract !== "s16-computer-command/v1") throw new AppError("invalid_contract");
  identity(v.requestId); identity(kind === "create_private" ? v.botId : v.vmId);
  return structuredClone(value) as ComputerCommand;
}
