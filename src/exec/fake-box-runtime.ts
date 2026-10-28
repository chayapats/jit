import { AppError } from "../errors";
import {
  boxDirectories, boxEnvironment, boxName, boxTemporaryDirectory, boxWorkspaceRoot, expectedBoxMounts, pinnedImagePattern, requireBoxMode, sidecarName, validateStreamRequest,
  type BoxEnsureOptions, type BoxExecRequest, type BoxExecResult, type BoxHandle, type BoxMode, type BoxMount, type BoxRef, type BoxRuntime, type BoxStatus,
  type BoxStream, type BoxStreamRequest, type BoxStreams, type SidecarHandle, type SidecarSpec, type StreamTarget,
} from "./box-runtime";

/** One recorded {@link FakeBoxRuntime} call, in order. */
export type FakeBoxCall =
  | { op: "ensure"; projectId: string; mode: BoxMode; profile: boolean; outcome: "created" | "started" | "reused" | "restarted" }
  | { op: "exec"; projectId: string; request: unknown }
  | { op: "stop" | "reset" | "status"; projectId: string; wipeWorkspace?: boolean }
  | { op: "list" }
  | { op: "stream"; projectId: string; target: string; argv: string[]; env: Record<string, string>; secretEnv: Record<string, string>; workdir: string | null }
  | { op: "sidecar.ensure"; projectId: string; name: string; mode: BoxMode; image: string; volume: string | null; env: Record<string, string> }
  | { op: "sidecar.remove"; name: string }
  | { op: "pull"; reference: string };

/** What a box would contain: its environment and mounts, exactly as {@link PodmanBoxRuntime} would create them. */
export interface FakeBox { projectId: string; mode: BoxMode; profile: boolean; running: boolean; env: Record<string, string>; mounts: BoxMount[] }

/** Handles one runner request for a fake box (for example by running `ops/box/runner` locally). */
export type FakeBoxExec = (handle: BoxHandle, request: BoxExecRequest) => Promise<BoxExecResult>;
/** Opens one fake long-lived stream (an MCP server fixture, a fake CDP relay). */
export type FakeBoxStream = (target: StreamTarget, request: BoxStreamRequest) => Promise<BoxStream> | BoxStream;


/**
 * exec.box_runtime/v1 in memory, for every deterministic test. It records every call, models box lifecycle
 * (create, start, restart on a mode or profile change, stop, reset) and the environment and mounts the Podman runtime
 * would apply, so tests can assert that no Jit variable, secret path or state path reaches a box. `exec` delegates to
 * an injected handler; without one it answers `EIO`. `workspaceRoot`/`temporaryDirectory` default to the box layout
 * but may point at local directories when the handler runs the real runner on the host.
 */
export class FakeBoxRuntime implements BoxRuntime, BoxStreams {
  readonly calls: FakeBoxCall[] = [];
  readonly boxes = new Map<string, FakeBox>();
  /** Set to make the next `ensure` fail (one shot), e.g. to test capacity release on failure. */
  failNextEnsure: AppError | null = null;
  readonly #exec: FakeBoxExec | undefined;
  readonly #paths: { workspaceRoot: string; temporaryDirectory: string };
  readonly #executionDirectory: string;
  readonly #proxyUrl: string;

  readonly #stream: FakeBoxStream | undefined;
  /** Sidecars that exist now, by name, with the environment they were created with. */
  readonly sidecars = new Map<string, SidecarHandle & { env: Record<string, string>; volume: string | null }>();
  /** Images pulled so far. */
  readonly pulled: string[] = [];
  /** Set to make the next `pullImage` fail (one shot). */
  failNextPull: AppError | null = null;

  constructor(options: { exec?: FakeBoxExec; workspaceRoot?: string; temporaryDirectory?: string; executionDirectory?: string; proxyUrl?: string;
    stream?: FakeBoxStream } = {}) {
    this.#exec = options.exec;
    this.#stream = options.stream;
    this.#paths = { workspaceRoot: options.workspaceRoot ?? boxWorkspaceRoot, temporaryDirectory: options.temporaryDirectory ?? boxTemporaryDirectory };
    this.#executionDirectory = options.executionDirectory ?? "/srv/jit-execution";
    this.#proxyUrl = options.proxyUrl ?? "http://10.89.0.1:3128";
  }

  async ensure(projectId: string, mode: BoxMode, options: BoxEnsureOptions = {}): Promise<BoxHandle> {
    requireBoxMode(mode);
    const name = boxName(projectId), profile = options.profile === true;
    if (this.failNextEnsure) { const error = this.failNextEnsure; this.failNextEnsure = null; throw error; }
    const existing = this.boxes.get(projectId);
    let outcome: "created" | "started" | "reused" | "restarted";
    if (!existing) outcome = "created";
    else if (existing.mode !== mode || existing.profile !== profile) outcome = "restarted";
    else outcome = existing.running ? "reused" : "started";
    if (outcome === "created" || outcome === "restarted") {
      const dirs = boxDirectories(this.#executionDirectory, projectId);
      this.boxes.set(projectId, { projectId, mode, profile, running: true, env: boxEnvironment(mode, mode === "workspace" ? this.#proxyUrl : null),
        mounts: expectedBoxMounts(dirs.workspace, profile ? dirs.profile : null) });
    } else existing!.running = true;
    this.calls.push({ op: "ensure", projectId, mode, profile, outcome });
    return Object.freeze({ projectId, name, mode, profile, ...this.#paths });
  }

  async exec(handle: BoxHandle, request: BoxExecRequest): Promise<BoxExecResult> {
    let parsed: unknown = null;
    try { parsed = JSON.parse(new TextDecoder().decode(request.input)); } catch { /* Recorded as null. */ }
    this.calls.push({ op: "exec", projectId: handle.projectId, request: parsed });
    if (!this.boxes.get(handle.projectId)?.running) throw new AppError("box_runtime_unavailable", 503);
    if (!this.#exec) return { exitCode: 0, stdout: new TextEncoder().encode('{"v":1,"ok":false,"error":{"code":"EIO"}}'), stderr: new Uint8Array() };
    return this.#exec(handle, request);
  }

  async stop(ref: BoxRef): Promise<void> {
    this.calls.push({ op: "stop", projectId: ref.projectId });
    const box = this.boxes.get(ref.projectId);
    if (box) box.running = false;
  }

  async reset(ref: BoxRef, options: { wipeWorkspace: boolean }): Promise<void> {
    this.calls.push({ op: "reset", projectId: ref.projectId, wipeWorkspace: options.wipeWorkspace });
    this.boxes.delete(ref.projectId);
    // The workspace survives a plain reset; the wipe count models deleting the workspace volume.
    if (options.wipeWorkspace) this.#wipes.set(ref.projectId, this.wipes(ref.projectId) + 1);
  }
  readonly #wipes = new Map<string, number>();
  /** How many times the project's workspace was wiped. */
  wipes(projectId: string): number { return this.#wipes.get(projectId) ?? 0; }

  async status(projectId: string): Promise<BoxStatus> {
    this.calls.push({ op: "status", projectId });
    const box = this.boxes.get(projectId), name = boxName(projectId);
    return box ? { projectId, name, state: box.running ? "running" : "stopped", mode: box.mode, profile: box.profile }
      : { projectId, name, state: "absent", mode: null, profile: null };
  }

  async list(): Promise<BoxStatus[]> {
    this.calls.push({ op: "list" });
    return [...this.boxes.values()].map(box => ({ projectId: box.projectId, name: boxName(box.projectId), state: box.running ? "running" : "stopped", mode: box.mode, profile: box.profile }));
  }

  async stream(target: StreamTarget, request: BoxStreamRequest): Promise<BoxStream> {
    validateStreamRequest(target, request);
    const projectId = target.handle.projectId;
    this.calls.push({ op: "stream", projectId, target: target.kind === "box" ? boxName(projectId) : target.handle.name, argv: [...request.argv],
      env: { ...request.env }, secretEnv: { ...request.secretEnv }, workdir: request.workdir ?? null });
    if (target.kind === "box" ? !this.boxes.get(projectId)?.running : !this.sidecars.has(target.handle.name)) throw new AppError("box_runtime_unavailable", 503);
    if (!this.#stream) throw new AppError("box_runtime_unavailable", 503);
    return this.#stream(target, request);
  }

  async ensureSidecar(spec: SidecarSpec): Promise<SidecarHandle> {
    requireBoxMode(spec.mode);
    const name = sidecarName(spec.projectId, spec.serverId);
    const env = boxEnvironment(spec.mode, spec.mode === "workspace" ? this.#proxyUrl : null);
    this.calls.push({ op: "sidecar.ensure", projectId: spec.projectId, name, mode: spec.mode, image: spec.image, volume: spec.volume, env });
    const handle = Object.freeze({ projectId: spec.projectId, serverId: spec.serverId, name, mode: spec.mode, image: spec.image });
    this.sidecars.set(name, { ...handle, env, volume: spec.volume });
    return handle;
  }

  async removeSidecar(handle: Pick<SidecarHandle, "name">): Promise<void> {
    this.calls.push({ op: "sidecar.remove", name: handle.name });
    this.sidecars.delete(handle.name);
  }

  async pullImage(reference: string): Promise<void> {
    if (!pinnedImagePattern.test(reference)) throw new AppError("box_image_unpinned", 409);
    this.calls.push({ op: "pull", reference });
    if (this.failNextPull) { const error = this.failNextPull; this.failNextPull = null; throw error; }
    this.pulled.push(reference);
  }

  /** Projects whose box is running now. */
  running(): string[] { return [...this.boxes.values()].filter(box => box.running).map(box => box.projectId).sort(); }
}
