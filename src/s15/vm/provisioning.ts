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
  /** Every shown step transition of the current attempt, in order (bounded), so no completed step goes unreported. */
  history: { step: LocalVmProvisionStep; at: number }[];
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
  enroll(input: { id: string; managerId: string; signal: AbortSignal; progress(step: QemuProvisionStep | "checks"): void;
    /** Throws unless this runner still holds the job; called before every host side effect. */
    guard(): void }): Promise<VmStatus>;
  now?: () => number;
  /** Process identity of this runner (defaults to `process.pid`); a seam for multi-process tests. */
  pid?: number;
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
const maxHistory = 64;

/**
 * Durable, idempotent provisioning job for the installation's default Jit-created working computer
 * (SETUP15-01). It lives in the protected VM journal, records each step with progress and a stable error
 * code, and runs at most once at a time per default computer across controller processes: a runner claims
 * the job with one compare-and-set transaction on its state and runner token, and re-checks that it still
 * holds the claim before every side effect (manager registration, image write, disk creation, start, stop,
 * removal by exact path, enrollment). A runner that lost the claim stops without touching the machine. A
 * restart resumes a `running` job: the image is re-hashed or re-downloaded, an unfinished machine directory
 * is removed by its exact path and recreated, a finished guest is reused after re-verification, and an
 * enrollment that was already saved simply completes the job. A failed job waits for the owner's explicit
 * "Try again"; nothing retries in a loop. Only trusted composition and the owner's authenticated setup
 * commands start it; model output and conversation cannot.
 */
export class LocalVmProvisioning {
  readonly #now: () => number;
  readonly #pid: number;
  #run: { token: string; controller: AbortController; done: Promise<void> } | null = null;
  #closed = false;
  constructor(readonly options: LocalVmProvisioningOptions) {
    vmId(options.vmId); this.#now = options.now ?? Date.now; this.#pid = options.pid ?? process.pid;
    options.store.db.exec("CREATE TABLE IF NOT EXISTS vm_provisioning (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  }
  private row(): Row | null {
    const found = this.options.store.db.query<{ data: string }, [string]>("SELECT data FROM vm_provisioning WHERE id=?").get(this.options.vmId);
    if (!found) return null;
    const row = JSON.parse(found.data) as Row; row.history ??= []; return row;
  }
  private save(row: Row): void { this.options.store.db.query("INSERT INTO vm_provisioning VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(this.options.vmId, JSON.stringify(row)); }
  private enrolled(): boolean { return !!this.options.store.db.query("SELECT id FROM vm_registry WHERE id=?").get(this.options.vmId); }
  private live(row: Row): boolean {
    if (!row.runner || row.state !== "running") return false;
    if (row.runner.pid === this.#pid) return liveTokens.has(row.runner.token);
    return (this.options.alive ?? defaultAlive)(row.runner.pid) && this.#now() - row.heartbeatAt < (this.options.staleMs ?? 600_000);
  }
  /** Owner-safe projection; null when no job was ever needed or started. Reads only the protected journal. */
  view(): LocalVmProvisioningView | null {
    const row = this.row(); if (!row) return null;
    const { runner: _runner, heartbeatAt: _heartbeat, ...view } = row;
    return { ...view, history: [...row.history], active: this.live(row) };
  }
  /**
   * Protected idempotent trigger used by `setup --s15` and controller boot: resumes a `running` job no live
   * runner holds, or starts the first job when the host probe is ready and the default computer is not
   * enrolled. A failed job is left for the owner's "Try again". Returns the current projection.
   */
  ensure(): LocalVmProvisioningView | null {
    if (this.#closed || this.#run) return this.view();
    this.claim(row => row?.state === "running" && !this.live(row) ? "resume" : !row && !this.enrolled() && this.options.host().state === "ready" ? "new" : null);
    return this.view();
  }
  /**
   * Owner "Try again" (or the first explicit start when automatic start found nothing to do): re-runs a
   * failed job from its failed step. Earlier steps are re-verified, never trusted from the record.
   */
  start(): LocalVmProvisioningView | null {
    if (this.#closed) vmFail("service_closed", 503);
    if (this.#run) return this.view();
    this.claim(row => {
      if (this.enrolled()) { if (row && row.state !== "enrolled") { this.complete(row); this.save(row); } return null; }
      return row?.state === "running" && this.live(row) ? null : "retry";
    });
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
    if (row.history.at(-1)?.step !== "enrolled") row.history = [...row.history, { step: "enrolled" as const, at }].slice(-maxHistory);
    Object.assign(row, { state: "enrolled", step: "enrolled", error: null, failedStep: null, stepStartedAt: at, updatedAt: at, finishedAt: at, runner: null, heartbeatAt: at });
  }
  /**
   * Atomic claim: inside one immediate transaction the current row is re-read, `decide` judges it, and the
   * runner token is written only if it still decides to run. Two controller processes therefore cannot both
   * take the same job; the one that loses sees the winner's live claim and does nothing.
   */
  private claim(decide: (row: Row | null) => "new" | "resume" | "retry" | null): void {
    const token = randomBytes(16).toString("hex");
    const claimed = this.options.store.transaction(() => {
      const previous = this.row(), kind = decide(previous); if (!kind) return null;
      const at = this.#now(), runner = { pid: this.#pid, token };
      const row: Row = previous ? { ...previous, state: "running", error: null, finishedAt: null, attempts: previous.attempts + (kind === "retry" || previous.state !== "running" ? 1 : 0), updatedAt: at, heartbeatAt: at, runner }
        : { contract: "s15-vm-provisioning/v1", vmId: this.options.vmId, managerId: null, state: "running", step: "host", failedStep: null, error: null, attempts: 1, startedAt: at, stepStartedAt: at, updatedAt: at, finishedAt: null, history: [{ step: "host", at }], runner, heartbeatAt: at };
      if (kind === "retry" && previous?.state === "failed") { row.startedAt = at; row.step = previous.failedStep ?? previous.step; row.stepStartedAt = at; row.history = [{ step: row.step, at }]; }
      this.save(row); return { from: previous ? row.step : null };
    });
    if (!claimed) return;
    const controller = new AbortController(); liveTokens.add(token);
    const done = this.execute(token, controller.signal, claimed.from).finally(() => { liveTokens.delete(token); if (this.#run?.token === token) this.#run = null; });
    this.#run = { token, controller, done };
  }
  /** Whether this runner still holds the job; read fresh from the journal. */
  private owns(token: string): boolean { const row = this.row(); return !!row && row.state === "running" && row.runner?.token === token; }
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
   * Every shown step transition is retained in `history`. A failure is recorded at the step that actually failed.
   */
  private async execute(token: string, signal: AbortSignal, from: LocalVmProvisionStep | null): Promise<void> {
    let step: LocalVmProvisionStep = "host";
    const order = (value: LocalVmProvisionStep) => localVmProvisionSteps.indexOf(value);
    // Ownership is checked before cancellation, so a stopping runner that also lost the job reports `superseded`.
    const guard = () => { if (!this.owns(token)) vmFail("vm_provisioning_superseded", 409); if (signal.aborted) throw new DOMException("Aborted", "AbortError"); };
    const enter = (next: LocalVmProvisionStep) => {
      step = next; const shown = from && order(next) < order(from) ? from : next;
      this.update(token, row => { if (row.step !== shown) { const at = this.#now(); row.step = shown; row.stepStartedAt = at; row.history = [...row.history, { step: shown, at }].slice(-maxHistory); } });
    };
    const stopBeat = (this.options.heartbeat ?? (beat => { const timer = setInterval(beat, 30_000); timer.unref?.(); return () => clearInterval(timer); }))(() => this.update(token, () => {}));
    try {
      // The trigger returns the recorded projection first; the steps run after it.
      await Promise.resolve();
      guard();
      if (this.enrolled()) { this.update(token, row => this.complete(row)); return; }
      enter("host");
      const host = this.options.host();
      if (host.state !== "ready") vmFail(host.code, 422);
      guard();
      const managerId = this.options.manager();
      this.update(token, row => { row.managerId = managerId; });
      await this.options.enroll({ id: this.options.vmId, managerId, signal, guard, progress: next => { guard(); enter(next); } });
      this.update(token, row => this.complete(row));
    } catch (error) {
      // A controller stop leaves the job running for the next boot; it is not a failure of this step. A runner
      // that lost its claim writes nothing: the job belongs to the runner that holds it now.
      if (signal.aborted || !this.owns(token)) return;
      if (error instanceof AppError && error.code === "vm_already_enrolled" && this.enrolled()) { this.update(token, row => this.complete(row)); return; }
      const code = error instanceof AppError && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : "vm_provisioning_failed";
      this.update(token, row => { const at = this.#now(); Object.assign(row, { state: "failed", error: code, failedStep: step, finishedAt: at, runner: null }); });
    } finally { stopBeat(); }
  }
}
