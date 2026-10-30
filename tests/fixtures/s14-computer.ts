import { AppError } from "../../src/errors";
import type { BoxExecRequest, BoxExecResult } from "../../src/exec/box-runtime";
import type { AgentInput, BotComputer, ComputerHandle, ComputerRuntime, OwnerInput } from "../../src/s14/computer-types";

/** Explicit deterministic barrier; tests decide when a fake runtime may cross its final authority check. */
export function barrier() {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  return { release, reached, async wait() { entered(); await gate; } };
}
/** Minimal valid PNG signature used only by deterministic transport fixtures. */
export const fixturePng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
/** Isolated fake runtime models identity, volume persistence and dispatch barriers without Linux/Podman/provider calls. */
export class FakeComputerRuntime implements ComputerRuntime {
  starts: BotComputer[] = [];
  stops: string[] = [];
  destroyed: string[] = [];
  inputs: { computerId: string; input: OwnerInput | AgentInput }[] = [];
  requests: unknown[] = [];
  volumes = new Map<string, { workspace: Map<string, string>; profile: Map<string, string> }>();
  handles = new WeakMap<ComputerHandle, BotComputer>();
  beforeStart: ReturnType<typeof barrier> | null = null;
  beforeInput: ReturnType<typeof barrier> | null = null;
  afterInput: ReturnType<typeof barrier> | null = null;
  beforeExec: ReturnType<typeof barrier> | null = null;
  beforeDestroy: ReturnType<typeof barrier> | null = null;
  stopFailure = false;
  active = 0;
  maxActive = 0;
  image = fixturePng;
  async start(c: BotComputer, allowed: () => void) {
    this.starts.push(structuredClone(c));
    if (this.beforeStart) await this.beforeStart.wait();
    allowed();
    if (!this.volumes.has(c.id)) this.volumes.set(c.id, { workspace: new Map(), profile: new Map() });
    const handle = Object.freeze({ computerId: c.id, generation: c.generation });
    this.handles.set(handle, c);
    return handle;
  }
  async stop(c: BotComputer) {
    this.stops.push(c.id);
    if (this.stopFailure) throw new AppError("fixture_stop_unconfirmed", 503);
  }
  async destroy(c: BotComputer, allowed: () => void) {
    if (this.beforeDestroy) await this.beforeDestroy.wait();
    allowed();
    this.destroyed.push(c.id);
    this.volumes.delete(c.id);
  }
  private current(handle: ComputerHandle) {
    const c = this.handles.get(handle);
    if (!c) throw new AppError("computer_handle_fenced", 403);
    return c;
  }
  async exec(handle: ComputerHandle, request: BoxExecRequest, allowed: () => void): Promise<BoxExecResult> {
    this.current(handle);
    if (this.beforeExec) await this.beforeExec.wait();
    allowed();
    const parsed = JSON.parse(new TextDecoder().decode(request.input));
    this.requests.push(parsed);
    const result = parsed.op === "spawn" ? { stdout: Buffer.from("bounded report").toString("base64"), stderr: "", exitCode: 0, timedOut: false }
      : parsed.op === "realpath" ? { path: parsed.path } : { type: "file" };
    return { exitCode: 0, stdout: new TextEncoder().encode(JSON.stringify({ v: 1, ok: true, result })), stderr: new Uint8Array() };
  }
  async input(handle: ComputerHandle, input: OwnerInput | AgentInput, allowed: () => void) {
    this.current(handle);
    if (this.beforeInput) await this.beforeInput.wait();
    allowed();
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      this.inputs.push({ computerId: handle.computerId, input: structuredClone(input) });
      if (this.afterInput) await this.afterInput.wait();
      allowed();
    } finally { this.active--; }
  }
  async screenshot(handle: ComputerHandle, allowed: () => void) { this.current(handle); allowed(); return this.image; }
}
