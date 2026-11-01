import { AppError } from "../../src/errors";
import type { BoxStream } from "../../src/exec/box-runtime";
import { cdpRelayPath } from "../../src/exec/cdp-stream";
import type { CommandRunner, StreamRunner } from "../../src/exec/podman-runtime";

/** Operator-only bounds; none changes the runtime's 15-second CDP deadline. */
export const inputEvidenceBounds = Object.freeze({ gateMs: 4500, frameBytes: 65536, transportBytes: 2097152, traceEntries: 256, pending: 16, streams: 8 });
/** Only protocol routing/order metadata survives parsing; bodies are never evidence. */
export interface InputTrace { order: number; pipe: number; stage: "write" | "received" | "delivered"; id: number; method: string }
/** Fake timers belong only in deterministic tests; the live entrypoint uses this real timer. */
export type EvidenceTimer = (callback: () => void, ms: number) => () => void;
const realTimer: EvidenceTimer = (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); };
const fail = (code: string): never => { throw new AppError(code); };

/**
 * Prepares the next matching dispatch, then binds once to its exact pipe/id. Its unchanged 4500 ms monotonic
 * deadline covers acquisition plus hold from that dispatch, not arm-to-release or unrelated lazy initialization.
 * Only that command's real successful reply can be held; early failure/close settles the prepared gate too.
 */
export class ReceivedReplyGate {
  readonly #reached = Promise.withResolvers<void>();
  readonly #released = Promise.withResolvers<void>();
  readonly reached = this.#reached.promise;
  readonly released = this.#released.promise;
  #cancel?: () => void;
  #deadline?: number;
  #binding?: { pipe: number; id: number };
  #state: "prepared" | "dispatched" | "held" | "released" | "closed" = "prepared";
  constructor(readonly method: string, readonly timer: EvidenceTimer, readonly now: () => number, readonly onTimeout: () => void) {
    // Register rejection handling even when dispatch fails before the caller awaits reached.
    void this.reached.catch(() => {});
  }
  private expire(): void {
    if (this.#state !== "dispatched" && this.#state !== "held") return;
    this.close(); this.onTimeout();
  }
  private beforeDeadline(): void {
    // A slow synchronous authority commit may delay JS timers. It must never turn an overdue hold into a pass.
    if (this.#deadline !== undefined && this.now() >= this.#deadline) { this.expire(); fail("input_evidence_gate_timeout"); }
  }
  get state() { return this.#state; }
  /** Binds synchronously just before forwarding the matching command; no later dispatch can rebind it. */
  dispatch(pipe: number, id: number): void {
    if (this.#state !== "prepared") fail("input_evidence_gate_stale");
    this.#binding = { pipe, id }; this.#state = "dispatched";
    this.#deadline = this.now() + inputEvidenceBounds.gateMs;
    this.#cancel = this.timer(() => this.expire(), inputEvidenceBounds.gateMs);
  }
  /** Exact routing identity, independent of method equality and reply arrival order. */
  matches(pipe: number, id: number): boolean {
    return this.#state === "dispatched" && this.#binding?.pipe === pipe && this.#binding.id === id;
  }
  /** Called by the pass-through reader only after the exact bound real response has arrived. */
  capture(pipe: number, id: number): void {
    if (!this.matches(pipe, id)) fail("input_evidence_gate_stale");
    this.beforeDeadline();
    this.#state = "held"; this.#reached.resolve();
  }
  /** Releases a received response unchanged. Releasing twice cannot latch a later response. */
  release(): void {
    if (this.#state === "released" || this.#state === "closed") return;
    if (this.#state !== "held") fail("input_evidence_reply_not_received");
    this.beforeDeadline();
    this.#state = "released"; this.#cancel?.(); this.#released.resolve();
  }
  /** Failure/interruption closes the latch and unblocks its reader; it never synthesizes a response. */
  close(): void {
    if (this.#state === "closed" || this.#state === "released") return;
    this.#state = "closed"; this.#cancel?.();
    this.#reached.reject(new AppError("input_evidence_gate_closed")); this.#released.resolve();
  }
}

// A fixed frame buffer prevents an unterminated or fragmented message growing parser memory.
class Frames {
  #buffer = new Uint8Array(inputEvidenceBounds.frameBytes + 1);
  #used = 0;
  push(bytes: Uint8Array, visit: (frame: Uint8Array) => void): void {
    if (bytes.length > inputEvidenceBounds.frameBytes) fail("input_evidence_chunk_bound");
    for (const byte of bytes) {
      if (this.#used >= this.#buffer.length) fail("input_evidence_frame_bound");
      this.#buffer[this.#used++] = byte;
      if (byte === 0) {
        visit(this.#buffer.slice(0, this.#used)); this.#buffer.fill(0, 0, this.#used); this.#used = 0;
      }
    }
  }
  finish(): void { if (this.#used) fail("input_evidence_truncated_frame"); }
}
function message(frame: Uint8Array): Record<string, unknown> {
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame.subarray(0, -1)));
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("input_evidence_protocol");
    return value;
  } catch { return fail("input_evidence_protocol"); }
}
const methods = new Set(["Target.getTargets", "Target.attachToTarget", "Input.dispatchMouseEvent", "Input.dispatchKeyEvent"]);

/**
 * Bounded observation/latches around actual public runners; writes stay synchronous and byte-for-byte.
 * Prepared gates do not time unrelated getTargets (the runtime still allows 15 s). Normal command failures,
 * work bounds, 180 s admission and the outer 240 s cap still bound preparation; 30 s runtime startup is unchanged.
 */
export class InputEvidenceTransport {
  readonly trace: InputTrace[] = [];
  readonly #gates = new Set<ReceivedReplyGate>();
  readonly #pipes = new Set<BoxStream>();
  readonly #joins: Promise<unknown>[] = [];
  readonly #commands = new Set<Promise<unknown>>();
  #bytes = 0;
  #pipe = 0;
  #runnerId = 0;
  #closed = false;
  #failure: string | null = null;
  constructor(readonly timer: EvidenceTimer = realTimer, readonly now: () => number = () => performance.now()) {}
  get failure() { return this.#failure; }
  get held() { return [...this.#gates].filter(g => g.state === "held").length; }
  /** Prepares the next future matching dispatch; at most two prepared/dispatched/held gates and 16 total. */
  arm(method: "Target.attachToTarget" | "Input.dispatchMouseEvent" | "runner.spawn"): ReceivedReplyGate {
    this.check();
    const active = [...this.#gates].filter(g => ["prepared", "dispatched", "held"].includes(g.state));
    if (active.length >= 2 || this.#gates.size >= 16 || active.some(g => g.method === method)) fail("input_evidence_gate_capacity");
    const gate = new ReceivedReplyGate(method, this.timer, this.now, () => this.abort("input_evidence_gate_timeout"));
    this.#gates.add(gate); return gate;
  }
  check(): void { if (this.#failure || this.#closed) fail(this.#failure ?? "input_evidence_transport_closed"); }
  private count(bytes: number): void {
    this.#bytes += bytes;
    if (this.#bytes > inputEvidenceBounds.transportBytes) fail("input_evidence_transport_bound");
  }
  private record(pipe: number, stage: InputTrace["stage"], id: number, method: string): void {
    if (this.trace.length >= inputEvidenceBounds.traceEntries) fail("input_evidence_trace_bound");
    this.trace.push({ order: this.trace.length + 1, pipe, stage, id, method });
  }
  private dispatched(pipe: number, id: number, method: string): void {
    this.record(pipe, "write", id, method);
    [...this.#gates].find(g => g.method === method && g.state === "prepared")?.dispatch(pipe, id);
  }
  private async received(pipe: number, id: number, method: string): Promise<void> {
    this.record(pipe, "received", id, method);
    const gate = [...this.#gates].find(g => g.matches(pipe, id));
    if (gate) { gate.capture(pipe, id); await gate.released; }
    this.check(); this.record(pipe, "delivered", id, method);
  }
  /** Accepts only the runtime's exact protected-browser exec, with no extra environment or raw-CDP sender. */
  streams(actual: StreamRunner): StreamRunner {
    return (argv, extra) => {
      let raw: BoxStream;
      try {
        this.check();
        if (argv.length !== 4 || argv[0] !== "exec" || argv[1] !== "-i" || !/^jit-s14-[a-f0-9]{32}-browser$/.test(argv[2]!) || argv[3] !== cdpRelayPath || Object.keys(extra).length) fail("input_evidence_stream_refused");
        if (++this.#pipe > inputEvidenceBounds.streams) fail("input_evidence_stream_bound");
        raw = actual(argv, extra);
      } catch (error) { this.abort(error instanceof AppError ? error.code : "input_evidence_pipe_failed"); throw error; }
      const pipe = this.#pipe, input = new Frames(), output = new Frames();
      const pending = new Map<number, string>(), readDone = Promise.withResolvers<void>();
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true; raw.close();
          // Peer/client failure while a response is latched closes it immediately, before the timer.
          if ([...this.#gates].some(g => ["prepared", "dispatched", "held"].includes(g.state))) this.abort("input_evidence_pipe_closed");
        }
      };
      const self = this;
      let wrapped!: BoxStream;
      wrapped = {
        write(bytes) {
          self.check();
          try {
            self.count(bytes.length);
            input.push(bytes, frame => {
              const m = message(frame), id = m.id, method = m.method;
              if (!Number.isSafeInteger(id) || (id as number) < 1 || typeof method !== "string" || !methods.has(method) || pending.has(id as number) || pending.size >= inputEvidenceBounds.pending) fail("input_evidence_dispatch_refused");
              pending.set(id as number, method as string); self.dispatched(pipe, id as number, method as string);
            });
            // No await, promise, rewrite or second CDP command between the final runtime guard and dispatch.
            raw.write(bytes);
          } catch (error) { self.abort("input_evidence_dispatch_failed"); throw error; }
        },
        stdout: (async function* () {
          try {
            for await (const chunk of raw.stdout) {
              self.check(); self.count(chunk.length);
              // At most one bounded chunk plus one partial frame. Yielding/holding applies pipe backpressure.
              const frames: Uint8Array[] = [];
              output.push(chunk, frame => frames.push(frame));
              for (const frame of frames) {
                const m = message(frame);
                if (typeof m.id === "number") {
                  const method = pending.get(m.id);
                  if (!method || m.error || !m.result || typeof m.result !== "object") fail("input_evidence_reply_failed");
                  pending.delete(m.id);
                  await self.received(pipe, m.id, method!);
                }
                // Events pass through unchanged and are not retained as metadata or authority.
                yield frame;
              }
            }
            output.finish(); input.finish();
            if (pending.size && !closed) fail("input_evidence_unsettled_reply");
          } catch (error) {
            if (!closed) { self.abort(error instanceof AppError ? error.code : "input_evidence_pipe_failed"); throw error; }
          } finally { close(); self.#pipes.delete(wrapped); readDone.resolve(); }
        })(),
        exited: raw.exited.then(code => { close(); return code; }, () => { self.abort("input_evidence_pipe_failed"); return -1; }),
        close,
      };
      this.#pipes.add(wrapped);
      this.#joins.push(raw.exited, readDone.promise);
      return wrapped;
    };
  }
  /** Binds runner.spawn at actual invocation using pipe 0/id; holds only its successful result after process completion. */
  commands(actual: CommandRunner): CommandRunner {
    const run: CommandRunner = (argv, request) => {
      // Closing evidence transport must still permit the runtime's supported named stop/drain cleanup.
      const cleanup = argv[0] === "rm" || argv[0] === "info" || argv[0] === "network" && ["exists", "rm"].includes(argv[1] ?? "");
      if (!cleanup) this.check();
      let method: string | null = null, id = 0;
      try {
        if (argv.at(-1) === "/opt/jit/runner") {
          if (!request.stdin || request.stdin.length > 8192) fail("input_evidence_runner_bound");
          const op = JSON.parse(new TextDecoder().decode(request.stdin)).op;
          if (!["spawn", "write"].includes(op)) fail("input_evidence_runner_refused");
          method = `runner.${op}`;
        }
        id = method ? ++this.#runnerId : 0;
        if (method) this.dispatched(0, id, method);
      } catch (error) { this.abort(error instanceof AppError ? error.code : "input_evidence_dispatch_failed"); throw error; }
      const task = (async () => {
        try {
          const result = await actual(argv, request);
          if (method) {
            this.count(result.stdout.length + result.stderr.length);
            if (result.stdout.length + result.stderr.length > inputEvidenceBounds.frameBytes || result.exitCode !== 0) fail("input_evidence_runner_failed");
            const parsed = JSON.parse(new TextDecoder().decode(result.stdout));
            if (parsed.v !== 1 || parsed.ok !== true) fail("input_evidence_runner_failed");
            if (method === "runner.spawn" && (parsed.result?.exitCode !== 0 || parsed.result?.timedOut !== false || typeof parsed.result?.stdout !== "string" || !parsed.result.stdout)) fail("input_evidence_runner_failed");
            await this.received(0, id, method);
          }
          return result;
        } catch (error) { this.abort(error instanceof AppError ? error.code : "input_evidence_runner_failed"); throw error; }
      })();
      this.#commands.add(task);
      void task.finally(() => this.#commands.delete(task)).catch(() => {});
      return task;
    };
    return Object.assign(run, actual.client ? { client: actual.client } : {});
  }
  /** Closes every prepared/dispatched/held gate and actual pipe; metadata stays bounded and payload-free. */
  abort(reason = "input_evidence_interrupted"): void { this.#failure ??= reason; this.close(); }
  close(): void {
    this.#closed = true;
    for (const gate of this.#gates) gate.close();
    for (const pipe of this.#pipes) pipe.close();
  }
  /** Must be awaited after typed cleanup; no actual exec/read promise is detached from the run. */
  async join(): Promise<void> { await Promise.allSettled([...this.#joins, ...this.#commands]); }
}
