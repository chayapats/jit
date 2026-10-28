import { join } from "node:path";
import { AppError } from "../errors";
import { requireId } from "../sources";

/**
 * exec.box_runtime/v1 (EXE03, ADR 0036) — one disposable execution box per project.
 *
 * A box is a rootless container named `jit-box-<projectId>` that holds the project workspace and nothing else of
 * Jit's: no state directory, backup, ledger, secret, socket or service environment. Implementations guarantee:
 *
 * - **Mounts.** Exactly `<execution.directory>/<projectId>/workspace` at `/workspace`, plus
 *   `<execution.directory>/<projectId>/profile` at `/profile` only when the caller asks for a profile (ADR 0039).
 *   No other host path is ever mounted, and a box whose inspected mounts differ from that set is refused.
 * - **Environment.** Only {@link boxEnvironment}: `HOME`, `PATH`, `LANG` and `TZ`, plus the registry proxy variables
 *   in `workspace` mode. The Jit service environment never reaches the box.
 * - **Network.** `workspace` boxes sit on an internal network whose only egress is the registry allowlist proxy;
 *   `full` boxes use the rootless default network. A box ensured in another mode than it runs in is restarted.
 * - **Commands.** {@link BoxRuntime.exec} runs only the box runner (`/opt/jit/runner`, `jit.box.runner/v1`) with one
 *   request on stdin. Nothing else is ever executed in a box by Jit.
 *
 * `read` never reaches a runtime: callers ensure a box only for an effective `workspace` or `full` level.
 */
export type BoxMode = "workspace" | "full";

/** Identifies a project's box without implying that it exists or runs. */
export interface BoxRef { readonly projectId: string }

/** A box that is running in `mode`, with its backend paths. */
export interface BoxHandle extends BoxRef {
  readonly name: string;
  readonly mode: BoxMode;
  readonly profile: boolean;
  /** Absolute workspace root inside the box (`/workspace`). */
  readonly workspaceRoot: string;
  /** Absolute temporary directory inside the box (`/tmp`, a tmpfs). */
  readonly temporaryDirectory: string;
}

/** One runner invocation: a single JSON request, a cancellation signal and a host-side deadline. */
export interface BoxExecRequest {
  readonly input: Uint8Array;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

/** The runner's raw outcome; `exitCode` is the `podman exec` status. */
export interface BoxExecResult { exitCode: number; stdout: Uint8Array; stderr: Uint8Array }

/** Observed lifecycle of a project's box. `mode` and `profile` are null when no box exists. */
export interface BoxStatus {
  projectId: string;
  name: string;
  state: "absent" | "running" | "stopped";
  mode: BoxMode | null;
  profile: boolean | null;
}

/** Options for {@link BoxRuntime.ensure}. */
export interface BoxEnsureOptions { readonly profile?: boolean }

/** exec.box_runtime/v1. Every method validates `projectId`; failures are `AppError`s with finite codes. */
export interface BoxRuntime {
  /** Starts (creating or recreating as needed) the project's box in `mode` and verifies its mounts. */
  ensure(projectId: string, mode: BoxMode, options?: BoxEnsureOptions): Promise<BoxHandle>;
  /** Runs the box runner once with `request.input` on stdin. Aborting `signal` kills the `podman exec` client. */
  exec(handle: BoxHandle, request: BoxExecRequest): Promise<BoxExecResult>;
  /** Stops the box; the workspace persists. Stopping an absent box is a no-op. */
  stop(ref: BoxRef): Promise<void>;
  /** Removes the container and its writable layer; with `wipeWorkspace` also deletes the workspace (and profile). */
  reset(ref: BoxRef, options: { wipeWorkspace: boolean }): Promise<void>;
  status(projectId: string): Promise<BoxStatus>;
  /** Every Jit box the runtime knows, running or stopped. */
  list(): Promise<BoxStatus[]>;
}

/** The runner inside every box image (`ops/box/runner`, mode 0555). */
export const boxRunnerPath = "/opt/jit/runner";
export const boxWorkspaceRoot = "/workspace";
export const boxTemporaryDirectory = "/tmp";
export const boxProfileRoot = "/profile";
/** The internal Podman network of `workspace` boxes. */
export const boxInternalNetwork = "jit-box-internal";
/** The fixed environment allowlist of every box (ADR 0036). */
export const boxEnvironmentNames: readonly string[] = Object.freeze(["HOME", "PATH", "LANG", "TZ"]);
/** Proxy variables a `workspace` box receives so package managers reach the registry allowlist proxy. */
export const boxProxyNames: readonly string[] = Object.freeze(["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"]);

/** `jit-box-<projectId>` after validating the project id. */
export function boxName(projectId: string): string {
  requireId(projectId);
  return `jit-box-${projectId}`;
}

/**
 * The complete box environment. It is a constant set, never derived from the service environment, so no Jit
 * variable, path or credential can reach the box through it. `workspace` adds the registry proxy URL.
 */
export function boxEnvironment(mode: BoxMode, proxyUrl: string | null): Record<string, string> {
  const env: Record<string, string> = { HOME: boxTemporaryDirectory, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TZ: "UTC" };
  if (mode === "workspace") {
    if (!proxyUrl || !/^http:\/\/[0-9a-f.:[\]]+:\d{1,5}$/.test(proxyUrl)) throw new AppError("box_proxy_unavailable", 503);
    for (const name of boxProxyNames) env[name] = name.toLowerCase() === "no_proxy" ? "" : proxyUrl;
  }
  return env;
}

/** Host directories of one project's box under `execution.directory`. */
export function boxDirectories(executionDirectory: string, projectId: string): { project: string; workspace: string; profile: string } {
  requireId(projectId);
  const project = join(executionDirectory, projectId);
  return { project, workspace: join(project, "workspace"), profile: join(project, "profile") };
}

/** One bind mount as compared after `podman inspect`. */
export interface BoxMount { source: string; destination: string }

/** The only mounts a box may have: the workspace, plus the profile when requested. */
export function expectedBoxMounts(workspace: string, profile: string | null): BoxMount[] {
  const mounts = [{ source: workspace, destination: boxWorkspaceRoot }];
  if (profile !== null) mounts.push({ source: profile, destination: boxProfileRoot });
  return mounts;
}

/** True when `actual` is exactly the `expected` mount set (order-insensitive). */
export function sameMounts(actual: readonly BoxMount[], expected: readonly BoxMount[]): boolean {
  const key = (mount: BoxMount) => `${mount.source}\u0000${mount.destination}`;
  const a = actual.map(key).sort(), b = expected.map(key).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Validates a mode argument (`invalid_box_mode`). `read` is never a box mode. */
export function requireBoxMode(mode: unknown): BoxMode {
  if (mode !== "workspace" && mode !== "full") throw new AppError("invalid_box_mode");
  return mode;
}

// ---------------------------------------------------------------------------
// Long-lived streams and MCP sidecars (ADR 0038, ADR 0039)
// ---------------------------------------------------------------------------

/**
 * A container a stream or runner call can reach: the project's box, or one MCP server sidecar of the project. A
 * sidecar runs the same pinned box image (or a digest-pinned OCI server image) with the box hardening, the project's
 * network mode, its own PID namespace and no workspace mount.
 */
export type StreamTarget = { kind: "box"; handle: BoxHandle } | { kind: "sidecar"; handle: SidecarHandle };

/** One long-lived `podman exec -i` into a box or sidecar. */
export interface BoxStreamRequest {
  /** Program and arguments inside the container. */
  readonly argv: readonly string[];
  /** Non-secret variables, passed as `--env NAME=value`. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Secret variables (app.connections/v1 `mcp_env` values for a sidecar). Passed to Podman by name only
   * (`--env NAME`), with the value in the `podman` client's own environment, so it never appears on a command line.
   * Only a sidecar may receive them (`box_secret_refused` for the project box).
   */
  readonly secretEnv?: Readonly<Record<string, string>>;
  readonly workdir?: string;
}

/** The open pipe of a {@link BoxStreamRequest}. Closing kills the `podman exec` client and ends `stdout`. */
export interface BoxStream {
  /** Writes bytes to the process's stdin; throws `box_stream_closed` once closed. */
  write(bytes: Uint8Array): void;
  /** The process's stdout, chunk by chunk, until it exits or the stream closes. */
  readonly stdout: AsyncIterable<Uint8Array>;
  /** The exit status of the exec client (or -1 when killed). */
  readonly exited: Promise<number>;
  close(): void;
}

/**
 * One MCP server sidecar: one per server connection, so concurrent runs of a project never share or replace each
 * other's sidecar. `name` is `jit-mcp-<serverId>-<instance>`; the project is a label.
 */
export interface SidecarHandle { readonly projectId: string; readonly serverId: string; readonly instance: string; readonly name: string; readonly mode: BoxMode; readonly image: string }

/** What a sidecar is created from. `volume` is the server's own install directory, mounted at `/mcp` only there. */
export interface SidecarSpec { projectId: string; serverId: string; instance: string; mode: BoxMode; image: string; volume: string | null }

/** Mount point of a sidecar's install directory. */
export const sidecarInstallRoot = "/mcp";

/**
 * exec.box_streams/v1 — long-lived pipes and sidecars next to {@link BoxRuntime}. Both runtimes implement it. Nothing
 * here opens a listening port: every channel is a `podman exec -i` pipe.
 */
export interface BoxStreams {
  /** Opens a long-lived exec in `target`. */
  stream(target: StreamTarget, request: BoxStreamRequest): Promise<BoxStream>;
  /** Creates (or replaces) and starts a hardened sidecar. */
  ensureSidecar(spec: SidecarSpec): Promise<SidecarHandle>;
  /** Removes a sidecar; removing an absent one is a no-op. */
  removeSidecar(handle: Pick<SidecarHandle, "name">): Promise<void>;
  /** Removes every sidecar left by an earlier process (boot, before any connection); returns how many. */
  pruneSidecars(): Promise<number>;
  /** Pulls a digest-pinned image (`name@sha256:…`); tags are refused (`box_image_unpinned`). */
  pullImage(reference: string): Promise<void>;
}

/** `jit-mcp-<serverId>-<instance>` after validating both ids. */
export function sidecarName(serverId: string, instance: string): string {
  requireId(serverId); requireId(instance);
  return `jit-mcp-${serverId}-${instance}`;
}

/** A digest-pinned OCI reference: `[host[:port]/]path@sha256:<64 hex>`. */
export const pinnedImagePattern = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?(\/[a-z0-9]+([._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$|^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/;

/** Validates stream variable names and values (`invalid_box_stream`): POSIX names, no NUL, bounded. */
export function validateStreamRequest(target: StreamTarget, request: BoxStreamRequest): void {
  const invalid = () => new AppError("invalid_box_stream");
  if (!Array.isArray(request.argv) || request.argv.length < 1 || request.argv.length > 64 ||
      request.argv.some(arg => typeof arg !== "string" || arg.includes("\u0000") || Buffer.byteLength(arg) > 4096)) throw invalid();
  for (const env of [request.env ?? {}, request.secretEnv ?? {}]) for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name) || typeof value !== "string" || value.includes("\u0000") || Buffer.byteLength(value) > 16_384) throw invalid();
  }
  if (request.workdir !== undefined && (typeof request.workdir !== "string" || !request.workdir.startsWith("/") || request.workdir.includes("\u0000"))) throw invalid();
  if (request.secretEnv && Object.keys(request.secretEnv).length && target.kind !== "sidecar") throw new AppError("box_secret_refused", 403);
}

/** The {@link BoxStreams} of a runtime that implements them (both shipped runtimes do), or null. */
export function boxStreamsOf(runtime: BoxRuntime): BoxStreams | null {
  const candidate = runtime as Partial<BoxStreams>;
  return typeof candidate.stream === "function" && typeof candidate.ensureSidecar === "function" && typeof candidate.removeSidecar === "function" && typeof candidate.pruneSidecars === "function" &&
    typeof candidate.pullImage === "function" ? runtime as BoxRuntime & BoxStreams : null;
}
