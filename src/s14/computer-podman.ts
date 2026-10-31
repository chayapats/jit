import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { hostname } from "node:os";
import type { ExecutionSpawnRequest, ExecutionSpawnResult } from "schway/host";
import { createBoxBackend } from "../exec/box-backend";
import { ContainerRegistryProxy } from "../exec/container-registry-proxy";
import { codingQuote, codingRegistry } from "./coding-protocol";
import { AppError } from "../errors";
import { CdpClient, cdpRelayPath } from "../exec/cdp-stream";
import { dropsAllCapabilities } from "../exec/container-checks";
import { pinnedImagePattern } from "../exec/box-runtime";
import { podmanCommandRunner, podmanStreamRunner, type CommandRunner, type StreamRunner } from "../exec/podman-runtime";
import type { AgentInput, BotComputer, ComputerHandle, ComputerRuntime, OwnerInput } from "./computer-types";
import { botComputerUserNamespace } from "./computer-types";
import { readComputerDiskPool } from "./computer-disks";
import type { PodmanClient } from "../exec/podman-client";

/** Non-secret operator configuration; each Bot needs two independently bounded ext4 mountpoints beneath dataRoot. */
export interface BotPodmanOptions {
  dataRoot: string;
  protectedPaths: string[];
  workspaceImage: string;
  browserImage: string;
  run?: CommandRunner;
  streams?: StreamRunner;
}

function fail(code: string): never { throw new AppError(code, 503); }
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const beneath = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
};
function canonicalHostPath(path: string): string {
  let current = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync(current), ...missing); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(current) === current) fail("computer_protected_path_unverified");
      missing.unshift(basename(current));
      current = dirname(current);
    }
  }
}
const keyMap: Record<string, { key: string; code: string; windowsVirtualKeyCode: number }> = {
  Enter: { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 },
  Tab: { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 },
  Escape: { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 },
  Backspace: { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 },
  ArrowUp: { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38 },
  ArrowDown: { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37 },
  ArrowRight: { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 },
};

/** Validates the only public owner/agent input variants before any protected-channel operation. */
export function validateComputerInput(input: OwnerInput | AgentInput): void {
  if (!input || typeof input !== "object") throw new AppError("invalid_computer_input");
  const keys = Object.keys(input).sort().join();
  if (input.kind === "click" && keys === "kind,x,y" && Number.isSafeInteger(input.x) && Number.isSafeInteger(input.y) && input.x >= 0 && input.x < 1280 && input.y >= 0 && input.y < 800) return;
  if (input.kind === "text" && keys === "kind,text" && typeof input.text === "string" && input.text.length > 0 && input.text.length <= 2000 && input.text.isWellFormed() && !input.text.includes("\0")) return;
  if (input.kind === "key" && keys === "key,kind" && Object.hasOwn(keyMap, input.key)) return;
  if (input.kind === "scroll" && keys === "deltaY,kind" && Number.isSafeInteger(input.deltaY) && Math.abs(input.deltaY) <= 800 && input.deltaY !== 0) return;
  throw new AppError("unsupported_browser_action", 403);
}

/** Reads rootless/nested-container prerequisites without starting a container or returning raw host diagnostics. */
export async function probeBotPodman(run: CommandRunner): Promise<{ state: "ready" | "unavailable"; reason: string | null }> {
  try {
    const version = await run(["--version"], { timeoutMs: 5000 });
    if (version.exitCode !== 0) return { state: "unavailable", reason: "podman_missing" };
    const info = await run(["info", "--format", "json"], { timeoutMs: 5000 });
    if (info.exitCode !== 0) return { state: "unavailable", reason: podmanFailure(info.stderr) };
    const host = JSON.parse(decode(info.stdout)).host;
    if (host?.os !== "linux") return { state: "unavailable", reason: "linux_required" };
    if (host.security?.rootless !== true) return { state: "unavailable", reason: "rootless_required" };
    const mappings = host.idMappings;
    if (![mappings?.uidmap, mappings?.gidmap].every(map => Array.isArray(map) && map.some(m => Number(m.size) >= 65536))) return { state: "unavailable", reason: "subuid_subgid_range_required" };
    if (host.cgroupVersion !== "v2" || !["cpu", "memory", "pids"].every(c => host.cgroupControllers?.includes(c))) return { state: "unavailable", reason: "cgroup_delegation_required" };
    return { state: "ready", reason: null };
  } catch { return { state: "unavailable", reason: "podman_probe_unavailable" }; }
}

function podmanFailure(stderr: Uint8Array): string {
  const diagnostic = decode(stderr).toLowerCase();
  if (/subuid|subgid|newuidmap|newgidmap|uid.map|gid.map/.test(diagnostic)) return "subuid_subgid_range_required";
  if (/fuse/.test(diagnostic)) return "fuse_device_or_storage_driver_unavailable";
  if (/\/dev\/net\/tun|pasta|slirp/.test(diagnostic)) return "nested_network_device_unavailable";
  if (/cgroup/.test(diagnostic)) return "cgroup_delegation_required";
  if (/clone|namespace|operation not permitted/.test(diagnostic)) return "nested_user_namespace_unavailable";
  return "podman_runtime_or_nested_namespace_unavailable";
}

interface MountRow { target: string; source: string; fstype: string; options: string; "maj:min": string; fsroot: string; children?: MountRow[] }
interface Live { computer: BotComputer; names: string[]; client: CdpClient | null; sessionId: string | null }

function dedicatedDiskMount(rows: MountRow[], path: string): MountRow | null {
  const layers = rows.filter(row => row.target === path), first = layers[0];
  if (!first || first.fstype !== "ext4" || first.fsroot !== "/" || !first.source.startsWith("/dev/") || !first["maj:min"]) return null;
  // ProtectSystem/ReadWritePaths adds an identical mount at the SAME target, not another accessible alias.
  if (layers.some(row => row["maj:min"] !== first["maj:min"] || row.source !== first.source || row.fstype !== "ext4" || row.fsroot !== "/" ||
      !["nodev", "nosuid"].every(flag => row.options?.split(",").includes(flag)))) return null;
  if (rows.some(row => beneath(path, row.target) || row["maj:min"] === first["maj:min"] && row.target !== path)) return null;
  return first;
}

/** Proves the selected API is the current service uid's direct local Unix socket; SSH/TCP/foreign sockets refuse. */
export function localComputerPodman(client: PodmanClient | undefined, uid = process.getuid?.(), stat = lstatSync): boolean {
  if (!client?.remote) return true;
  if (!uid || client.argv.length !== 3 || client.argv[0] !== "--remote" || client.argv[1] !== "--url" ||
      client.argv[2] !== `unix:///run/user/${uid}/podman/podman.sock`) return false;
  try {
    for (const path of ["/run", "/run/user", `/run/user/${uid}`, `/run/user/${uid}/podman`, `/run/user/${uid}/podman/podman.sock`]) {
      const s = stat(path);
      // ProtectHome=tmpfs synthesizes /run/user as root-owned 1777. Sticky ownership protects its exact child.
      const stickyParent = path === "/run/user" && s.uid === 0 && (s.mode & 0o1000) !== 0;
      if (s.isSymbolicLink() || (s.uid !== 0 && s.uid !== uid) || ((s.mode & 0o002) && !stickyParent) ||
          (path.endsWith(".sock") ? !s.isSocket() || s.uid !== uid : !s.isDirectory() || ((s.mode & 0o020) && !stickyParent))) return false;
    }
    return true;
  } catch { return false; }
}

/** Daemon metadata must match this Linux host and service uid before local findmnt/stat can prove its bind sources. */
export function computerPodmanHostLocal(host: unknown, name = hostname(), uid = process.getuid?.()): boolean {
  const h = host as { os?: string; hostname?: string; security?: { rootless?: boolean }; idMappings?: { uidmap?: { container_id: number; host_id: number }[] } } | null;
  return h?.os === "linux" && h.security?.rootless === true && h.hostname === name &&
    Array.isArray(h.idMappings?.uidmap) && h.idMappings.uidmap.some(m => m.container_id === 0 && m.host_id === uid);
}

/** Rootless, mount-separated, network-free Linux runtime; unsupported finite limits never degrade to a host shell. */
export class BotPodmanRuntime implements ComputerRuntime {
  readonly #run: CommandRunner;
  readonly #streams: StreamRunner;
  readonly #root: string;
  readonly #live = new WeakMap<ComputerHandle, Live>();
  readonly #byId = new Map<string, Live>();
  readonly #registry = new Map<string, { cancel(): void; settled: Promise<void> }>();
  #planning = Promise.resolve();
  #readiness: Promise<{ state: "ready" | "unavailable"; reason: string | null; host: unknown }> | null = null;
  constructor(readonly options: BotPodmanOptions) {
    if (![options.workspaceImage, options.browserImage].every(image => pinnedImagePattern.test(image))) fail("computer_image_digest_required");
    this.#root = resolve(options.dataRoot);
    const canonicalRoot = canonicalHostPath(this.#root);
    for (const path of options.protectedPaths) {
      const protectedPath = canonicalHostPath(path);
      if (canonicalRoot === protectedPath || beneath(canonicalRoot, protectedPath) || beneath(protectedPath, canonicalRoot)) fail("computer_data_state_collision");
    }
    this.#run = options.run ?? podmanCommandRunner();
    this.#streams = options.streams ?? podmanStreamRunner();
  }
  private names(c: BotComputer): string[] { return ["workspace", "browser"].map(role => `jit-s14-${c.id}-${role}`); }
  /** Installer inventory is immutable to the service; claiming it is the application's transactional responsibility. */
  diskSlots(): readonly string[] { return readComputerDiskPool(this.#root).slots; }
  private path(c: BotComputer, role: "workspace" | "profile"): string {
    if (!/^[a-f0-9]{32}$/.test(c.id) || !/^[a-zA-Z0-9_-]{1,128}$/.test(c.botId)) fail("computer_identity_invalid");
    if (!c.diskSlot || c.diskSlot.generation !== c.generation || !/^slot-\d{4}$/.test(c.diskSlot.id) || !this.diskSlots().includes(c.diskSlot.id)) fail("computer_disk_binding_invalid");
    const path = join(this.#root, "slots", c.diskSlot.id, role);
    // The operator owns parents; the execution user cannot replace a mountpoint or introduce parent links.
    let current = "/";
    for (const part of path.split("/").filter(Boolean)) {
      current = join(current, part);
      const stat = lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) fail("computer_data_path_unsafe");
    }
    if (realpathSync(path) !== path) fail("computer_data_path_unsafe");
    return path;
  }
  private async command(argv: string[], timeoutMs = 5000, allowed = () => {}): Promise<Uint8Array> {
    return this.plan(argv, async () => {
      allowed();
      let result;
      try { result = await this.#run(argv, { timeoutMs }); }
      catch { return fail("podman_runtime_unavailable"); }
      allowed();
      if (result.exitCode !== 0) fail(podmanFailure(result.stderr));
      return result.stdout;
    });
  }
  private async plan<T>(argv: readonly string[], run: () => Promise<T>): Promise<T> {
    if (!["info", "create", "run"].includes(argv[0]!)) return run();
    // The local API's keep-id planner reads process-global libsubid state. Concurrent
    // planning produced duplicate UID ranges on Podman 5.7; keep the exact prepared map.
    const previous = this.#planning, gate = Promise.withResolvers<void>();
    this.#planning = gate.promise;
    await previous;
    try { return await run(); }
    finally { gate.resolve(); }
  }
  private async disks(c: BotComputer, allowed: () => void, probedHost?: unknown): Promise<string[]> {
    let paths: string[];
    try { paths = [this.path(c, "workspace"), this.path(c, "profile")]; }
    catch (e) { if (e instanceof AppError) throw e; return fail("persistent_disk_mounts_required"); }
    // Local API transport is accepted only with the service's real Unix socket and matching daemon host/uid.
    if (!localComputerPodman(this.#run.client)) fail("computer_local_podman_required");
    if (this.#run.client?.remote) {
      const info = probedHost ?? JSON.parse(decode(await this.command(["info", "--format", "json"], 5000, allowed))).host;
      if (!computerPodmanHostLocal(info)) fail("computer_local_podman_required");
    }
    const mounts = await this.hostProbe(["findmnt", "--json", "--output", "TARGET,SOURCE,FSTYPE,MAJ:MIN,FSROOT,OPTIONS"], allowed);
    let rows: MountRow[];
    try {
      const flatten = (items: MountRow[]): MountRow[] => items.flatMap(row => [row, ...flatten(row.children ?? [])]);
      rows = flatten(JSON.parse(mounts).filesystems);
    } catch { return fail("persistent_disk_probe_unavailable"); }
    const devices: string[] = [];
    for (const path of paths) {
      const row = dedicatedDiskMount(rows, path);
      if (!row || devices.includes(row["maj:min"])) fail("dedicated_ext4_disk_boundary_required");
      devices.push(row["maj:min"]);
      const values = (await this.hostProbe(["stat", "-f", "-c", "%S %b", path], allowed)).trim().split(/\s+/).map(Number);
      const bytes = values[0]! * values[1]!;
      if (values.length !== 2 || !Number.isSafeInteger(bytes) || bytes <= 0 || bytes > c.limits.diskBytes) fail("persistent_disk_limit_unenforced");
    }
    return paths;
  }
  private readiness(startupMs: number) {
    if (!this.#readiness) {
      let host: unknown;
      const pending = probeBotPodman((argv, request) => this.plan(argv, async () => {
        const result = await this.#run(argv, { ...request, timeoutMs: argv[0] === "info" ? startupMs : request.timeoutMs });
        if (argv[0] === "info" && result.exitCode === 0) host = JSON.parse(decode(result.stdout)).host;
        return result;
      })).then(result => ({ ...result, host })).finally(() => { if (this.#readiness === pending) this.#readiness = null; });
      this.#readiness = pending;
    }
    return this.#readiness;
  }
  /** Fixed credential-free host probes; injected tests use the same argument seam without spawning Linux tools. */
  protected async hostProbe(argv: string[], allowed: () => void): Promise<string> {
    allowed();
    const proc = Bun.spawn(argv, { env: { PATH: "/usr/sbin:/usr/bin:/sbin:/bin", LANG: "C" }, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => proc.kill(), 5000);
    try {
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      allowed();
      if (code !== 0 || out.length > 1048576) fail("persistent_disk_probe_unavailable");
      return out;
    } finally { clearTimeout(timer); }
  }
  /** Starts and verifies the two isolated components before issuing one opaque generation-bound handle. */
  async start(c: BotComputer, allowed: () => void): Promise<ComputerHandle> {
    allowed();
    // Share only an in-flight fresh probe, never cache host authority across later starts.
    // A cold API info request can exceed five seconds; the caller's original startup guard still applies.
    const readiness = await this.readiness(c.limits.startupMs);
    allowed();
    if (readiness.state !== "ready") fail(readiness.reason!);
    const paths = await this.disks(c, allowed, readiness.host), names = this.names(c);
    await this.stop(c);
    // A verified stop killed the previous browser. Chromium's hostname/PID links survive SIGKILL on persistent
    // profiles; unlink only these known symlinks, never their targets or website data, before creating processes.
    for (const entry of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      allowed();
      const path = join(paths[1]!, entry), stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat && !stat.isSymbolicLink()) fail("protected_browser_lock_unverified");
      if (stat) rmSync(path);
    }
    const deadline = Date.now() + c.limits.startupMs;
    try {
      for (let index = 0; index < names.length; index++) {
        allowed();
        const destination = index === 0 ? "/workspace" : "/profile";
        const args = this.containerArgs(c, names[index]!, paths[index]!, destination);
        if (Date.now() >= deadline) fail("computer_startup_timeout");
        await this.command(args, Math.max(1, deadline - Date.now()), allowed);
        await this.verify(c, names[index]!, paths[index]!, destination, allowed);
      }
      allowed();
      const handle = Object.freeze({ computerId: c.id, generation: c.generation });
      const live: Live = { computer: structuredClone(c), names, client: null, sessionId: null };
      this.#live.set(handle, live);
      this.#byId.set(c.id, live);
      return handle;
    } catch (error) {
      await this.stop(c).catch(() => {});
      throw error;
    }
  }
  private containerArgs(c: BotComputer, name: string, source: string, destination: string, network = "none"): string[] {
    return ["run", "--detach", "--pull=never", "--http-proxy=false", "--unsetenv-all", `--network=${network}`, "--pid=private", "--ipc=private", "--uts=private", "--cgroupns=private",
      "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only", `--userns=${botComputerUserNamespace}`, "--user=1000:1000",
      "--cpus", String(c.limits.cpuMillis / 1000), "--memory", String(c.limits.memoryBytes), "--memory-swap", String(c.limits.memoryBytes),
      "--pids-limit", String(c.limits.pids), "--log-driver=none", "--no-healthcheck", "--shm-size=64m",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=67108864,mode=1777", "--tmpfs", "/run:rw,nosuid,nodev,noexec,size=134217728,mode=1777",
      "--mount", `type=bind,src=${source},dst=${destination},rw`, "--env", `HOME=${destination}`, "--env", "PATH=/usr/local/bin:/usr/bin:/bin", "--env", "LANG=C.UTF-8", "--env", "TZ=UTC",
      "--label", `jit.s14.computer=${c.id}`, "--label", `jit.s14.role=${destination === "/workspace" ? "workspace" : "browser"}`, "--name", name, "--hostname", name, "--entrypoint", "/usr/bin/sleep",
      destination === "/workspace" ? this.options.workspaceImage : this.options.browserImage, "infinity"];
  }
  private async verify(c: BotComputer, name: string, source: string, destination: string, allowed: () => void, network = "none"): Promise<void> {
    const raw = await this.command(["inspect", name], 5000, allowed);
    let info;
    try { info = JSON.parse(decode(raw))[0]; } catch { return fail("computer_inspect_unverified"); }
    const host = info?.HostConfig, mounts = info?.Mounts;
    const binds = Array.isArray(mounts) ? mounts.filter((m: { Type: string }) => m.Type === "bind") : [];
    const image = destination === "/workspace" ? this.options.workspaceImage : this.options.browserImage;
    if (!info?.State?.Running || host?.Privileged !== false || host.ReadonlyRootfs !== true || (host.NetworkMode !== network && !(network !== "none" && host.NetworkMode === "bridge")) ||
        info.ImageName !== image || host.PidMode !== "private" || host.IpcMode !== "private" || host.UTSMode !== "private" ||
        (host.CgroupnsMode ?? host.CgroupMode) !== "private" || [host.CgroupnsMode, host.CgroupMode].some(mode => mode !== undefined && mode !== "private") ||
        info.Config?.User !== "1000:1000" || info.Config?.Hostname !== name || info.Config?.Labels?.["jit.s14.computer"] !== c.id ||
        !Array.isArray(mounts) || binds.length !== 1 || binds[0].Source !== source || binds[0].Destination !== destination ||
        mounts.some((m: { Type: string; Destination: string }) => m.Type !== "bind" && !(m.Type === "tmpfs" && ["/tmp", "/run"].includes(m.Destination))) ||
        Object.keys(host.Tmpfs ?? {}).sort().join() !== "/run,/tmp" ||
        !Object.entries({ "/tmp": 67108864, "/run": 134217728 }).every(([path, size]) => {
          const opts = (host.Tmpfs[path] as string).split(",");
          return ["nosuid", "nodev", "noexec", `size=${size}`].every(opt => opts.includes(opt));
        }) ||
        !host.SecurityOpt?.some((s: string) => s === "no-new-privileges" || s === "no-new-privileges=true") ||
        !await dropsAllCapabilities(this.#run, name, info)) fail("computer_isolation_unverified");
    if (network !== "none") {
      const attached = Object.keys(info.NetworkSettings?.Networks ?? {});
      if (attached.length !== 1 || attached[0] !== network || Object.keys(host.PortBindings ?? {}).length) fail("coding_registry_boundary_unverified");
      // Read routes inside the rootless namespace, never assume the host gateway is bindable (#163).
      const routes = decode(await this.command(["exec", name, "cat", "/proc/net/route", "/proc/net/ipv6_route"], 5000, allowed));
      const rows = routes.trim().split("\n").filter(line => !line.startsWith("Iface"));
      if (!rows.length || rows.some(line => {
        const fields = line.trim().split(/\s+/);
        if (fields.length === 11) return fields[1] === "00000000";
        if (fields.length === 10) return fields[0] === "0".repeat(32) && fields[1] === "00" && (parseInt(fields[8]!, 16) & 0x200) === 0;
        return true;
      })) fail("coding_registry_boundary_unverified");
    }
    const kernel = decode(await this.command(["exec", name, "cat", "/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/pids.max", "/sys/fs/cgroup/memory.swap.max"], 5000, allowed)).trim().split(/\s+/);
    const [quota, period, memory, pids, swap] = kernel.map(Number);
    if (kernel.length !== 5 || ![quota, period, memory, pids].every(value => Number.isSafeInteger(value) && value! > 0) ||
        quota! / period! > c.limits.cpuMillis / 1000 || memory! > c.limits.memoryBytes || pids! > c.limits.pids || swap !== 0) fail("computer_cgroup_limits_unenforced");
  }
  /** Removes only the named computer's processes, preserving its two persistent filesystem roots. */
  async stop(c: BotComputer): Promise<void> {
    const registry = this.#registry.get(c.id);
    registry?.cancel();
    await registry?.settled;
    await this.removeRegistry(c);
    const live = this.#byId.get(c.id);
    live?.client?.close();
    this.#byId.delete(c.id);
    for (const name of this.names(c)) await this.command(["rm", "--force", "--time", "0", "--ignore", name]);
  }
  private async removeRegistry(c: BotComputer, proxy?: ContainerRegistryProxy): Promise<void> {
    const prefix = `jit-s14-${c.id}-registry`, network = `${prefix}-net`;
    // PID 1 may ignore SIGTERM; do not spend Podman's default stop grace past the cleanup deadline.
    // Both removals mutate the same Podman storage/network namespace. Avoid
    // spending the check's finite deadline waiting behind the proxy's teardown
    // on slow storage. Still attempt both cleanups when either one fails.
    let unconfirmed = false;
    for (const remove of [
      () => this.command(["rm", "--force", "--time", "0", "--ignore", prefix]),
      () => proxy ? proxy.close() : this.command(["rm", "--force", "--time", "0", "--ignore", `${prefix}-proxy`]),
    ]) {
      try { await remove(); } catch { unconfirmed = true; }
    }
    if (unconfirmed) fail("coding_registry_cleanup_unconfirmed");
    const exists = await this.#run(["network", "exists", network], { timeoutMs: 5000 });
    if (exists.exitCode === 0) await this.command(["network", "rm", network]);
    else if (exists.exitCode !== 1) fail("coding_registry_cleanup_unconfirmed");
  }
  /** Wipes only the exact Bot's bounded data after stopping processes and rechecking owner scope at each barrier. */
  async destroy(c: BotComputer, allowed: () => void): Promise<void> {
    allowed();
    await this.stop(c);
    allowed();
    const paths = await this.disks(c, allowed);
    for (const path of paths) for (const entry of readdirSync(path)) {
      allowed();
      // rm never follows a symlink; the independently bounded filesystem root itself remains mounted.
      rmSync(join(path, entry), { recursive: true, force: false });
    }
  }
  private current(handle: ComputerHandle): Live {
    const live = this.#live.get(handle);
    if (!live || this.#byId.get(handle.computerId) !== live) fail("computer_handle_fenced");
    return live;
  }
  /** Sends one bounded runner request to the workspace component only, with current authority on both sides. */
  async exec(handle: ComputerHandle, request: Parameters<ComputerRuntime["exec"]>[1], allowed: () => void) {
    const live = this.current(handle);
    // Browser/profile containers have no runner gateway at all.
    allowed();
    const result = await this.#run(["exec", "-i", live.names[0]!, "/opt/jit/runner"], { stdin: request.input, timeoutMs: request.timeoutMs, ...(request.signal ? { signal: request.signal } : {}) });
    allowed();
    return result;
  }
  /** Runs one owner-scoped registry command on an internal-only bridge through the existing CONNECT proxy. */
  async registrySpawn(handle: ComputerHandle, request: ExecutionSpawnRequest, hosts: readonly string[], allowed: () => void): Promise<ExecutionSpawnResult> {
    codingRegistry({ hosts: [...hosts] });
    const live = this.current(handle), c = live.computer;
    if (this.#registry.has(c.id)) fail("coding_registry_busy");
    const prefix = `jit-s14-${c.id}-registry`, network = `${prefix}-net`;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    let settle!: () => void;
    const settled = new Promise<void>(resolve => { settle = resolve; });
    this.#registry.set(c.id, { cancel, settled });
    request.signal?.addEventListener("abort", cancel, { once: true });
    if (request.signal?.aborted) cancel();
    const guard = () => { this.current(handle); allowed(); if (controller.signal.aborted) fail("coding_registry_cancelled"); };
    const monitor = setInterval(() => { try { guard(); } catch { cancel(); } }, 50);
    // Proxy creation uses the same keep-id planner as computer starts. Passing
    // the raw runner here would bypass the private queue under concurrent load.
    const proxyRun: CommandRunner = (argv, request) => this.plan(argv, () => {
      // Recheck after queueing, but keep exact-name removal available after cancellation.
      if (argv[0] !== "rm") guard();
      return this.#run(argv, request);
    });
    const proxyStreams: StreamRunner = (argv, request) => {
      // Bundle preparation can yield after container inspection and before exec.
      guard();
      return this.#streams(argv, request);
    };
    const proxy = new ContainerRegistryProxy(this.options.workspaceImage, hosts, proxyRun, proxyStreams, undefined,
      { internalNetwork: network, name: `${prefix}-proxy` });
    try {
      guard();
      await this.command(["network", "create", "--internal", "--disable-dns", "--label", `jit.s14.computer=${c.id}`, network], 15000, guard);
      const [info] = JSON.parse(decode(await this.command(["network", "inspect", network], 5000, guard)));
      if (info?.internal !== true || info?.driver !== "bridge" || info?.dns_enabled !== false) fail("coding_registry_boundary_unverified");
      const url = await proxy.url();
      guard();
      const source = this.path(c, "workspace");
      await this.command(this.containerArgs(c, prefix, source, "/workspace", network), c.limits.startupMs, guard);
      await this.verify(c, prefix, source, "/workspace", guard, network);
      const backend = createBoxBackend({ exec: async (_handle, input) => {
        guard();
        const result = await this.#run(["exec", "-i", prefix, "/opt/jit/runner"], { stdin: input.input, timeoutMs: input.timeoutMs, ...(input.signal ? { signal: input.signal } : {}) });
        guard();
        return result;
      } }, { projectId: c.id, name: prefix, mode: "workspace", profile: false, workspaceRoot: "/workspace", temporaryDirectory: "/tmp" });
      // Explicit variables survive the command's env -i; no ambient proxy/service environment is inherited.
      const environment = ["env", "-i", "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/tmp", "LANG=C.UTF-8", "TZ=UTC",
        ...["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"].map(key => `${key}=${url}`), "NO_PROXY=", "no_proxy="];
      const result = await backend.spawn({ ...request, command: `${environment.map(codingQuote).join(" ")} ${request.command}`, signal: controller.signal });
      guard();
      return result;
    } catch (error) {
      if (error instanceof AppError) throw error;
      return fail("coding_registry_proxy_unavailable");
    } finally {
      clearInterval(monitor);
      cancel();
      request.signal?.removeEventListener("abort", cancel);
      try {
        // Removal kills descendants that daemonized beyond the runner's process group.
        await this.removeRegistry(c, proxy);
      } catch (error) { this.#byId.delete(c.id); throw error; } finally { this.#registry.delete(c.id); settle(); }
    }
  }
  private async browser(handle: ComputerHandle, allowed: () => void): Promise<{ client: CdpClient; sessionId: string }> {
    const live = this.current(handle);
    if (!live.client) {
      allowed();
      const client = new CdpClient(this.#streams(["exec", "-i", live.names[1]!, cdpRelayPath], {}));
      try {
        const targets = await client.send("Target.getTargets");
        allowed();
        const target = (targets.targetInfos as { type: string; targetId: string }[])?.find(t => t.type === "page");
        if (!target) fail("protected_browser_unavailable");
        const attached = await client.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
        allowed();
        if (typeof attached.sessionId !== "string" || !attached.sessionId) fail("protected_browser_unavailable");
        live.client = client;
        live.sessionId = attached.sessionId;
      } catch (error) { client.close(); throw error; }
    }
    if (!live.sessionId) fail("protected_browser_unavailable");
    return { client: live.client, sessionId: live.sessionId };
  }
  /** Sends one validated input over the protected browser pipe without a shell, MCP or raw-CDP public surface. */
  async input(handle: ComputerHandle, input: OwnerInput | AgentInput, allowed: () => void): Promise<void> {
    validateComputerInput(input);
    const { client, sessionId } = await this.browser(handle, allowed);
    allowed();
    // No await intervenes between the final guard and all messages of a single physical input.
    if (input.kind === "text") await client.send("Input.insertText", { text: input.text }, { sessionId });
    else if (input.kind === "click") await Promise.all(["mousePressed", "mouseReleased"].map(type => client.send("Input.dispatchMouseEvent", { type, x: input.x, y: input.y, button: "left", clickCount: 1 }, { sessionId })));
    else if (input.kind === "key") await Promise.all(["keyDown", "keyUp"].map(type => client.send("Input.dispatchKeyEvent", { type, ...keyMap[input.key] }, { sessionId })));
    else await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: input.deltaY }, { sessionId });
    allowed();
  }
  /** Reads target metadata through the protected pipe; the application withholds arbitrary website titles and URLs. */
  async pageInfo(handle: ComputerHandle, allowed: () => void): Promise<{ url?: string; title?: string }> {
    const { client, sessionId } = await this.browser(handle, allowed);
    allowed();
    const result = await client.send("Target.getTargetInfo", {}, { sessionId });
    allowed();
    const info = result.targetInfo as { url?: unknown } | undefined;
    return info?.url === "about:blank" ? { url: "about:blank" } : {};
  }
  /** Captures one bounded in-memory PNG through the protected pipe, retaining no website data in the service. */
  async screenshot(handle: ComputerHandle, allowed: () => void): Promise<Uint8Array> {
    const { client, sessionId } = await this.browser(handle, allowed);
    allowed();
    const result = await client.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, { sessionId });
    allowed();
    if (typeof result.data !== "string" || result.data.length > 2796204) fail("computer_image_too_large");
    return Buffer.from(result.data, "base64");
  }
}
