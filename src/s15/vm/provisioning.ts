import { randomBytes } from "node:crypto";
import { AppError } from "../../errors";
import type { LocalVmHostReadiness } from "./local";
import type { QemuProvisionStep } from "./qemu";
import type { VmStore } from "./store";
import type { VmStatus } from "./types";
import { vmFail, vmId } from "./validation";

/** Ordered steps of the automatic working-computer job. `enrolled` is terminal. */
export const localVmProvisionSteps = Object.freeze(["host", "download", "checksum", "disk", "boot", "connect", "checks", "enrolled"] as const);
export type LocalVmProvisionStep = typeof localVmProvisionSteps[number];
/**
 * Durable, credential-free projection of the one provisioning job for the default working computer. Times
 * come from the composed clock. `error` is a stable refusal code; `failedStep` is where it stopped. `active`
 * is true only while a live runner (this process or another live controller process) holds the job.
 */
export interface LocalVmProvisioningView {
  contract: "s15-vm-provisioning/v1"; vmId: string; managerId: string | null;
  state: "running" | "failed" | "enrolled"; step: LocalVmProvisionStep; failedStep: LocalVmProvisionStep | null; error: string | null;
  attempts: number; startedAt: number; stepStartedAt: number; updatedAt: number; finishedAt: number | null; active: boolean;
}
/** Protected composition dependencies. None is reachable from a model, guest, channel or conversation. */
export interface LocalVmProvisioningOptions {
  store: VmStore;
  /** Default pool member id; the job enrolls exactly this id and never a second default computer. */
  vmId: string;
  /** Controller-side host capability probe, read fresh at every run. */
  host(): LocalVmHostReadiness;
  /** Returns this controller's single local manager id, registering it with default sizing only when absent. */
  manager(): string;
  /** Protected provisioning/enrollment (`VmEnrollment.provisionLocal`). */
  enroll(input: { id: string; managerId: string; signal: AbortSignal; progress(step: QemuProvisionStep | "checks"): void }): Promise<VmStatus>;
  now?: () => number;
  /** Liveness of another controller process holding the job; defaults to a signal-0 probe. */
  alive?: (pid: number) => boolean;
  /** A runner whose heartbeat is older than this is treated as gone (default 10 minutes). */
  staleMs?: number;
  /** Heartbeat timer seam for deterministic tests. */
  heartbeat?: (beat: () => void) => () => void;
}
interface Row extends Omit<LocalVmProvisioningView, "active"> { runner: { pid: number; token: string } | null; heartbeatAt: number }
/** Runner tokens held by live job instances in this process; a closed (simulated-crashed) instance drops its own. */
const liveTokens = new Set<string>();
const defaultAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; } };

/**
 * Durable, idempotent provisioning job for the installation's default Jit-created working computer
 * (SETUP15-01). It lives in the protected VM journal, records each step with progress and a stable error
 * code, and runs at most once at a time per default computer across controller processes. A restart
 * resumes a `running` job: the image is re-hashed or re-downloaded, an unfinished machine directory is
 * removed by its exact path and recreated, a finished guest is reused after re-verification, and an
 * enrollment that was already saved simply completes the job. A failed job waits for the owner's explicit
 * "Try again"; nothing retries in a loop. Only trusted composition and the owner's authenticated setup
 * commands start it; model output and conversation cannot.
 */
export class LocalVmProvisioning {
  readonly #now: () => number;
  #run: { token: string; controller: AbortController; done: Promise<void> } | null = null;
  #closed = false;
  constructor(readonly options: LocalVmProvisioningOptions) {
    vmId(options.vmId); this.#now = options.now ?? Date.now;
    options.store.db.exec("CREATE TABLE IF NOT EXISTS vm_provisioning (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  }
  private row(): Row | null {
    const found = this.options.store.db.query<{ data: string }, [string]>("SELECT data FROM vm_provisioning WHERE id=?").get(this.options.vmId);
    return found ? JSON.parse(found.data) as Row : null;
  }
  private save(row: Row): void { this.options.store.db.query("INSERT INTO vm_provisioning VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(this.options.vmId, JSON.stringify(row)); }
  private enrolled(): boolean { return !!this.options.store.db.query("SELECT id FROM vm_registry WHERE id=?").get(this.options.vmId); }
  private live(row: Row): boolean {
    if (!row.runner || row.state !== "running") return false;
    if (row.runner.pid === process.pid) return liveTokens.has(row.runner.token);
    return (this.options.alive ?? defaultAlive)(row.runner.pid) && this.#now() - row.heartbeatAt < (this.options.staleMs ?? 600_000);
  }
  /** Owner-safe projection; null when no job was ever needed or started. Reads only the protected journal. */
  view(): LocalVmProvisioningView | null {
    const row = this.row(); if (!row) return null;
    const { runner: _runner, heartbeatAt: _heartbeat, ...view } = row;
    return { ...view, active: this.live(row) };
  }
  /**
   * Protected idempotent trigger used by `setup --s15` and controller boot: resumes a `running` job no live
   * runner holds, or starts the first job when the host probe is ready and the default computer is not
   * enrolled. A failed job is left for the owner's "Try again". Returns the current projection.
   */
  ensure(): LocalVmProvisioningView | null {
    if (this.#closed || this.#run) return this.view();
    const row = this.row();
    if (row?.state === "running" && !this.live(row)) this.begin(row, false);
    else if (!row && !this.enrolled() && this.options.host().state === "ready") this.begin(null, false);
    return this.view();
  }
  /**
   * Owner "Try again" (or the first explicit start when automatic start found nothing to do): re-runs a
   * failed job from its failed step. Earlier steps are re-verified, never trusted from the record.
   */
  start(): LocalVmProvisioningView | null {
    if (this.#closed) vmFail("service_closed", 503);
    if (this.#run) return this.view();
    const row = this.row();
    if (this.enrolled()) { if (row && row.state !== "enrolled") { this.complete(row); this.save(row); } return this.view(); }
    if (row?.state === "running" && this.live(row)) return this.view();
    this.begin(row, true);
    return this.view();
  }
  /** Foreground run for the CLI: starts or resumes, then waits for the terminal state. */
  async run(): Promise<LocalVmProvisioningView | null> {
    this.ensure();
    await this.#run?.done;
    return this.view();
  }
  /** Awaits the current in-process run, if any. */
  async settled(): Promise<void> { await this.#run?.done; }
  /** Aborts the in-process run, as a controller stop would; the journal keeps `running` for the next boot. */
  async close(): Promise<void> {
    this.#closed = true; const run = this.#run; if (!run) return;
    run.controller.abort(); await run.done;
  }
  private complete(row: Row): void {
    const at = this.#now();
    Object.assign(row, { state: "enrolled", step: "enrolled", error: null, failedStep: null, stepStartedAt: at, updatedAt: at, finishedAt: at, runner: null, heartbeatAt: at });
  }
  private begin(previous: Row | null, retry: boolean): void {
    const at = this.#now(), token = randomBytes(16).toString("hex"), controller = new AbortController();
    const row: Row = previous ? { ...previous, state: "running", error: null, finishedAt: null, attempts: previous.attempts + (retry || previous.state !== "running" ? 1 : 0), updatedAt: at, heartbeatAt: at, runner: { pid: process.pid, token } }
      : { contract: "s15-vm-provisioning/v1", vmId: this.options.vmId, managerId: null, state: "running", step: "host", failedStep: null, error: null, attempts: 1, startedAt: at, stepStartedAt: at, updatedAt: at, finishedAt: null, runner: { pid: process.pid, token }, heartbeatAt: at };
    if (retry && previous?.state === "failed") { row.startedAt = at; row.step = previous.failedStep ?? previous.step; row.stepStartedAt = at; }
    this.save(row); liveTokens.add(token);
    const done = this.execute(token, controller.signal, previous ? row.step : null).finally(() => { liveTokens.delete(token); if (this.#run?.token === token) this.#run = null; });
    this.#run = { token, controller, done };
  }
  /** Updates the current row only while this runner still holds it; a superseded runner writes nothing. */
  private update(token: string, change: (row: Row) => void): void {
    this.options.store.transaction(() => {
      const row = this.row(); if (!row || row.runner?.token !== token || row.state !== "running") return;
      change(row); row.updatedAt = this.#now(); row.heartbeatAt = row.updatedAt; this.save(row);
    });
  }
  /**
   * Runs every step from the start; a resumed or retried job re-verifies the steps before `from` (cached image
   * hash, existing guest) while the projection stays on `from`, so progress never appears to go backwards.
   * A failure is recorded at the step that actually failed.
   */
  private async execute(token: string, signal: AbortSignal, from: LocalVmProvisionStep | null): Promise<void> {
    let step: LocalVmProvisionStep = "host";
    const order = (value: LocalVmProvisionStep) => localVmProvisionSteps.indexOf(value);
    const enter = (next: LocalVmProvisionStep) => {
      step = next; const shown = from && order(next) < order(from) ? from : next;
      this.update(token, row => { if (row.step !== shown) { row.step = shown; row.stepStartedAt = this.#now(); } });
    };
    const stopBeat = (this.options.heartbeat ?? (beat => { const timer = setInterval(beat, 30_000); timer.unref?.(); return () => clearInterval(timer); }))(() => this.update(token, () => {}));
    try {
      // The trigger returns the recorded projection first; the steps run after it.
      await Promise.resolve();
      if (this.enrolled()) { this.update(token, row => this.complete(row)); return; }
      enter("host");
      const host = this.options.host();
      if (host.state !== "ready") vmFail(host.code, 422);
      const managerId = this.options.manager();
      this.update(token, row => { row.managerId = managerId; });
      await this.options.enroll({ id: this.options.vmId, managerId, signal, progress: next => { if (signal.aborted) throw new DOMException("Aborted", "AbortError"); enter(next); } });
      this.update(token, row => this.complete(row));
    } catch (error) {
      // A controller stop leaves the job running for the next boot; it is not a failure of this step.
      if (signal.aborted) return;
      if (error instanceof AppError && error.code === "vm_already_enrolled" && this.enrolled()) { this.update(token, row => this.complete(row)); return; }
      const code = error instanceof AppError && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : "vm_provisioning_failed";
      this.update(token, row => { const at = this.#now(); Object.assign(row, { state: "failed", error: code, failedStep: step, finishedAt: at, runner: null }); });
    } finally { stopBeat(); }
  }
}
