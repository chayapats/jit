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
