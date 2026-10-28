import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import type { ExecutionConfig } from "../config";
import { AppError } from "../errors";
import {
  boxDirectories, boxEnvironment, boxInternalNetwork, boxName, boxRunnerPath, boxTemporaryDirectory, boxWorkspaceRoot, expectedBoxMounts, requireBoxMode, sameMounts,
  type BoxEnsureOptions, type BoxExecRequest, type BoxExecResult, type BoxHandle, type BoxMode, type BoxMount, type BoxRef, type BoxRuntime, type BoxStatus,
} from "./box-runtime";

/** One CLI invocation for the injected command runner. Aborting `signal` or passing `timeoutMs` kills the process. */
export interface CommandRequest { readonly stdin?: Uint8Array; readonly signal?: AbortSignal; readonly timeoutMs: number }
export interface CommandResult { exitCode: number; stdout: Uint8Array; stderr: Uint8Array }
/** Runs `podman <argv…>`. Production uses {@link podmanCommandRunner}; tests inject a scripted runner. */
export type CommandRunner = (argv: readonly string[], request: CommandRequest) => Promise<CommandResult>;

/** Client variables rootless Podman needs; the rest of the service environment never reaches the `podman` process. */
const podmanClientEnvironment = ["PATH", "HOME", "XDG_RUNTIME_DIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "DBUS_SESSION_BUS_ADDRESS", "LANG"];

/**
 * Runs the `podman` CLI as the service user: rootless, no socket and no daemon API. The child environment is the
 * small client allowlist above, so no `JIT_*` variable or credential path reaches Podman (or, through it, a box).
 */
export function podmanCommandRunner(serviceEnv: Record<string, string | undefined> = process.env, binary = "podman"): CommandRunner {
  const env = Object.fromEntries(podmanClientEnvironment.flatMap(name => serviceEnv[name] === undefined ? [] : [[name, serviceEnv[name]!]]));
  return async (argv, request) => {
    const proc = Bun.spawn([binary, ...argv], { env, stdin: request.stdin ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
    const kill = () => { try { proc.kill("SIGKILL"); } catch { /* Already exited. */ } };
    const timer = setTimeout(kill, request.timeoutMs);
    request.signal?.addEventListener("abort", kill, { once: true });
    try {
      if (request.stdin && proc.stdin) { proc.stdin.write(request.stdin); await proc.stdin.end(); }
      const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).bytes(), proc.exited]);
      return { exitCode, stdout, stderr };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", kill);
    }
  };
}

/** The `podman container inspect` fields the runtime verifies. */
interface Inspected {
  State?: { Running?: boolean };
  ImageName?: string;
  Config?: { Labels?: Record<string, string> | null };
  Mounts?: { Type?: string; Source?: string; Destination?: string }[];
  HostConfig?: { Privileged?: boolean; ReadonlyRootfs?: boolean; NetworkMode?: string; CapAdd?: string[] | null };
}

/** Options of {@link PodmanBoxRuntime}. */
export interface PodmanBoxRuntimeOptions {
  /** `ops.execution_config/v1`; `directory` and `images.base` must be configured. */
  config: ExecutionConfig;
  run?: CommandRunner;
  /** Starts (once) the registry allowlist proxy on the internal network gateway and returns its `http://` URL. */
  registryProxy?: (gateway: string) => Promise<string>;
  /** The service uid that must own the execution directories (defaults to the process uid). */
  uid?: number;
}

const commandMs = 120_000;
const tmpfs = ["/tmp:rw,nosuid,nodev,size=1g,mode=1777", "/run:rw,nosuid,nodev,size=128m,mode=1777"];

/**
 * The production {@link BoxRuntime} on rootless Podman. Every container is created with the ADR 0036 hardening:
 * `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--read-only`, tmpfs `/tmp` and `/run`, `--pids-limit`,
 * `--memory`, `--cpus`, `--userns=keep-id`, never `--privileged`, `--pull=never` (images are pinned by digest), the
 * constant {@link boxEnvironment} and exactly the expected bind mounts. After creation (and before every reuse)
 * `podman container inspect` must show exactly those mounts, no privilege, a read-only root and the mode's network;
 * a box that differs is removed and refused with `box_mount_mismatch` (or `box_hardening_mismatch`).
 */
export class PodmanBoxRuntime implements BoxRuntime {
  readonly #config: ExecutionConfig;
  readonly #directory: string;
  readonly #run: CommandRunner;
  readonly #registryProxy: ((gateway: string) => Promise<string>) | undefined;
  readonly #uid: number | undefined;
  #proxyUrl: Promise<string> | null = null;

  constructor(options: PodmanBoxRuntimeOptions) {
    if (!options.config.directory || !options.config.images) throw new AppError("box_not_configured", 503);
    this.#config = options.config;
    this.#directory = options.config.directory;
    this.#run = options.run ?? podmanCommandRunner();
    this.#registryProxy = options.registryProxy;
    this.#uid = options.uid ?? process.getuid?.();
  }

  async ensure(projectId: string, mode: BoxMode, options: BoxEnsureOptions = {}): Promise<BoxHandle> {
    requireBoxMode(mode);
    const name = boxName(projectId), profile = options.profile === true;
    const image = profile ? this.#config.images!.browser : this.#config.images!.base;
    if (!image) throw new AppError("box_image_missing", 503);
    const dirs = this.#prepare(projectId, profile);
    const expected = expectedBoxMounts(dirs.workspace, profile ? dirs.profile : null);
    // The proxy of this process comes first: a box left by an earlier process points at that process's proxy port.
    const env = boxEnvironment(mode, mode === "workspace" ? await this.#proxy() : null);
    let info = await this.#inspect(name);
    // A box created for another level, profile, image or environment is replaced; the workspace persists on the host.
    const labels = info?.Config?.Labels ?? {};
    if (info && (labels["jit.box.mode"] !== mode || labels["jit.box.profile"] !== (profile ? "1" : "0") || labels["jit.box.env"] !== environmentDigest(env) || info.ImageName !== image)) {
      await this.#remove(name); info = null;
    }
    if (!info) {
      await this.#podman(createArgs({ name, projectId, mode, profile, image, mounts: expected, env, config: this.#config }));
      info = await this.#inspect(name);
    }
    await this.#verify(name, info, mode, expected);
    if (!info!.State?.Running) {
      await this.#podman(["start", name]);
      await this.#verify(name, await this.#inspect(name), mode, expected);
    }
    return Object.freeze({ projectId, name, mode, profile, workspaceRoot: boxWorkspaceRoot, temporaryDirectory: boxTemporaryDirectory });
  }

  async exec(handle: BoxHandle, request: BoxExecRequest): Promise<BoxExecResult> {
    return this.#run(["exec", "-i", "--workdir", "/", boxName(handle.projectId), boxRunnerPath], {
      stdin: request.input, timeoutMs: request.timeoutMs, ...(request.signal ? { signal: request.signal } : {}),
    });
  }

  async stop(ref: BoxRef): Promise<void> {
    const name = boxName(ref.projectId);
    if (await this.#inspect(name)) await this.#podman(["stop", "--time", "2", name]);
  }

  async reset(ref: BoxRef, options: { wipeWorkspace: boolean }): Promise<void> {
    const name = boxName(ref.projectId);
    if (await this.#inspect(name)) await this.#remove(name);
    if (options.wipeWorkspace) {
      const dirs = boxDirectories(this.#directory, ref.projectId);
      for (const path of [dirs.workspace, dirs.profile]) { this.#refuseLink(path); rmSync(path, { recursive: true, force: true }); }
    }
  }

  async status(projectId: string): Promise<BoxStatus> {
    const name = boxName(projectId), info = await this.#inspect(name);
    if (!info) return { projectId, name, state: "absent", mode: null, profile: null };
    const labels = info.Config?.Labels ?? {};
    return { projectId, name, state: info.State?.Running ? "running" : "stopped",
      mode: labels["jit.box.mode"] === "full" ? "full" : "workspace", profile: labels["jit.box.profile"] === "1" };
  }

  async list(): Promise<BoxStatus[]> {
    const listed = await this.#podman(["ps", "--all", "--filter", "label=jit.box=1", "--format", "json"]);
    const rows = parseJson(listed) as { Labels?: Record<string, string>; State?: string }[];
    if (!Array.isArray(rows)) throw new AppError("box_runtime_unavailable", 503);
    return rows.flatMap(row => {
      const projectId = row.Labels?.["jit.box.project"];
      if (!projectId || !/^[a-f0-9-]{36}$/.test(projectId)) return [];
      return [{ projectId, name: `jit-box-${projectId}`, state: row.State === "running" ? "running" as const : "stopped" as const,
        mode: row.Labels?.["jit.box.mode"] === "full" ? "full" as const : "workspace" as const, profile: row.Labels?.["jit.box.profile"] === "1" }];
    });
  }

  /** Creates the project, workspace (and profile) directories as owner-only, refusing symlinks and foreign owners. */
  #prepare(projectId: string, profile: boolean): { workspace: string; profile: string } {
    const dirs = boxDirectories(this.#directory, projectId);
    const owned = (path: string) => {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || !stats.isDirectory() || (this.#uid !== undefined && stats.uid !== this.#uid)) throw new AppError("box_directory_unsafe", 503);
    };
    owned(this.#directory); owned(dirs.project); owned(dirs.workspace);
    if (profile) owned(dirs.profile);
    return { workspace: realpathSync(dirs.workspace), profile: profile ? realpathSync(dirs.profile) : dirs.profile };
  }

  #refuseLink(path: string): void {
    try { if (lstatSync(path).isSymbolicLink()) throw new AppError("box_directory_unsafe", 503); }
    catch (error) { if (error instanceof AppError) throw error; }
  }

  /** Refuses (and removes) a box whose inspected configuration is not exactly what Jit creates. */
  async #verify(name: string, info: Inspected | null, mode: BoxMode, expected: BoxMount[]): Promise<void> {
    if (!info) throw new AppError("box_runtime_unavailable", 503);
    const mounts = (info.Mounts ?? []).map(mount => ({ type: mount.Type, source: mount.Source ?? "", destination: mount.Destination ?? "" }));
    if (mounts.some(mount => mount.type !== "bind") || !sameMounts(mounts, expected)) {
      await this.#remove(name);
      throw new AppError("box_mount_mismatch", 503);
    }
    const host = info.HostConfig ?? {};
    const network = host.NetworkMode ?? "";
    if (host.Privileged !== false || host.ReadonlyRootfs !== true || (host.CapAdd ?? []).length > 0 ||
        (mode === "workspace" ? network !== boxInternalNetwork : network === boxInternalNetwork || network === "host")) {
      await this.#remove(name);
      throw new AppError("box_hardening_mismatch", 503);
    }
  }

  async #inspect(name: string): Promise<Inspected | null> {
    const exists = await this.#run(["container", "exists", name], { timeoutMs: commandMs });
    if (exists.exitCode === 1) return null;
    if (exists.exitCode !== 0) throw new AppError("box_runtime_unavailable", 503);
    const parsed = parseJson(await this.#podman(["container", "inspect", name])) as Inspected[];
    return Array.isArray(parsed) && parsed[0] ? parsed[0] : null;
  }

  async #remove(name: string): Promise<void> { await this.#podman(["rm", "--force", "--time", "2", name]); }

  /** The internal network (created once, `--internal`: no default route) and the proxy bound to its gateway. */
  #proxy(): Promise<string> {
    return this.#proxyUrl ??= (async () => {
      const exists = await this.#run(["network", "exists", boxInternalNetwork], { timeoutMs: commandMs });
      if (exists.exitCode !== 0) await this.#podman(["network", "create", "--internal", "--label", "jit.box=1", boxInternalNetwork]);
      const networks = parseJson(await this.#podman(["network", "inspect", boxInternalNetwork])) as { internal?: boolean; subnets?: { gateway?: string }[] }[];
      const network = Array.isArray(networks) ? networks[0] : undefined;
      const gateway = network?.subnets?.[0]?.gateway;
      if (network?.internal !== true || !gateway || !/^[0-9a-f.:]+$/.test(gateway)) throw new AppError("box_network_unavailable", 503);
      if (!this.#registryProxy) throw new AppError("box_proxy_unavailable", 503);
      return this.#registryProxy(gateway);
    })().catch(error => { this.#proxyUrl = null; throw error; });
  }

  async #podman(argv: string[]): Promise<Uint8Array> {
    const result = await this.#run(argv, { timeoutMs: commandMs });
    if (result.exitCode !== 0) throw new AppError("box_runtime_unavailable", 503);
    return result.stdout;
  }
}

/** A digest of the box environment (it names the proxy URL), stored as a label so a stale box is recreated. */
export function environmentDigest(env: Record<string, string>): string {
  return createHash("sha256").update(JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)))).digest("hex").slice(0, 32);
}

function parseJson(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AppError("box_runtime_unavailable", 503); }
}

/** The exact `podman create` arguments of one box (exported for the hardening-flag tests). */
export function createArgs(input: {
  name: string; projectId: string; mode: BoxMode; profile: boolean; image: string; mounts: BoxMount[]; env: Record<string, string>;
  config: Pick<ExecutionConfig, "memoryMb" | "cpus" | "pidsLimit">;
}): string[] {
  const args = ["create", "--name", input.name, "--pull=never",
    "--label", "jit.box=1", "--label", `jit.box.project=${input.projectId}`, "--label", `jit.box.mode=${input.mode}`, "--label", `jit.box.profile=${input.profile ? "1" : "0"}`,
    "--label", `jit.box.env=${environmentDigest(input.env)}`,
    "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only", ...tmpfs.flatMap(spec => ["--tmpfs", spec]),
    `--pids-limit=${input.config.pidsLimit}`, `--memory=${input.config.memoryMb}m`, `--cpus=${input.config.cpus}`, "--userns=keep-id",
    "--log-driver=none", "--stop-timeout=2", "--workdir", boxWorkspaceRoot];
  if (input.mode === "workspace") args.push(`--network=${boxInternalNetwork}`);
  for (const [name, value] of Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b))) args.push("--env", `${name}=${value}`);
  for (const mount of input.mounts) {
    if (/[,=]/.test(mount.source)) throw new AppError("box_directory_unsafe", 503);
    args.push("--mount", `type=bind,source=${mount.source},destination=${mount.destination},rw=true`);
  }
  args.push(input.image, "sleep", "infinity");
  return args;
}
