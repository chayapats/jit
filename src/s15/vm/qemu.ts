import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppError } from "../../errors";
import { registerSecretFingerprint } from "../../security/secret-fingerprints";
import { vmHostCommand } from "./host";
import { detectLocalVmHost, ensureLocalVmImage, localVmDownload, localVmHostProbe, localVmImages, localVmTools, type LocalVmDownload, type LocalVmHostProbe, type LocalVmImage, type LocalVmResources } from "./local";
import type { VmProxyLease } from "./proxy";
import { qmpExchange, type QmpCommand, type QmpExchange } from "./qmp";
import { vmScreenCommands, vmScreenFrame, vmScreenHeight, vmScreenWidth, type VmScreenDevice, type VmScreenInput } from "./screen";
import { VmSshTransport } from "./transport";
import type { VmEndpoint, VmHostCommand, VmMachineState, VmManagement } from "./types";
import { vmFail, vmInteger } from "./validation";
import { validateVmm, vmmCommand, vmmLayout, type QemuVmmOptions } from "./vmm";

const GiB = 1_073_741_824;
const snapshotTag = /^jit-[a-f0-9]{32}$/;
const safePath = (path: string, max = 512) => path.length <= max && path.startsWith("/") && resolve(path) === path && /^\/[A-Za-z0-9._/-]+$/.test(path);

/** Longest protected local-VM state directory, so its QMP and proxy Unix socket paths fit `sun_path`. */
export const qemuStateDirectoryMax = 64;
/** Fixed guest network. The existing direct-egress probe targets (`192.168.5.2`, metadata, public) stay valid. */
export const qemuGuestNetwork = Object.freeze({ net: "192.168.5.0/24", host: "192.168.5.2", proxy: "192.168.5.100", proxyPort: 3128 });

/** Exact inputs to the restricted QEMU command line; every value is controller-chosen protected configuration. */
export interface QemuMachineSpec {
  name: string; architecture: "x86_64" | "aarch64"; machineDirectory: string;
  cpus: number; memoryMiB: number; mac: string; sshPort: number; proxySocket: string;
  /**
   * DESK16-01 desktop profile: one virtio display at the fixed screen size plus a virtio tablet and keyboard.
   * Frames and input travel only through the controller's QMP socket; `-display none` keeps every display
   * server (VNC, SPICE, GTK) absent. Omitted, the argv is byte-for-byte the headless profile.
   */
  desktop?: boolean;
}
/**
 * The complete QEMU argv for a working VM: KVM, one virtio disk (per-VM qcow2 overlay), one read-only
 * NoCloud seed, exactly one NIC on restricted user networking with IPv6 off, one loopback SSH host-forward
 * and one guest-forward to the protected registry proxy socket. No monitor, shared directory, 9p/virtiofs,
 * extra NIC, SMB/TFTP, vsock or guest agent channel exists. QMP is a controller-only Unix socket.
 */
export function qemuArgv(spec: QemuMachineSpec): string[] {
  const d = spec.machineDirectory;
  const machine = spec.architecture === "x86_64" ? ["-machine", "q35,accel=kvm"] : ["-machine", "virt,accel=kvm,gic-version=host", "-bios", localVmTools.aarch64Firmware];
  return [localVmTools[spec.architecture], "-name", spec.name, ...machine, "-cpu", "host", "-smp", String(spec.cpus), "-m", `${spec.memoryMiB}M`,
    "-nodefaults", "-no-user-config", "-display", "none", "-monitor", "none",
    // Seccomp for QEMU itself. `elevateprivileges=deny` is omitted: it kills the guest-forward helper (`nc`) on the live host.
    "-sandbox", "on,obsolete=deny,resourcecontrol=deny",
    "-chardev", "ringbuf,id=console,size=1048576", "-serial", "chardev:console",
    "-qmp", `unix:${d}/qmp.sock,server=on,wait=off`,
    "-drive", `if=none,id=disk0,file=${d}/disk.qcow2,format=qcow2,cache=none,discard=unmap`, "-device", "virtio-blk-pci,drive=disk0,bootindex=0",
    "-drive", `if=none,id=seed,file=${d}/seed.img,format=raw,readonly=on`, "-device", "virtio-blk-pci,drive=seed",
    "-netdev", `user,id=net0,restrict=on,ipv6=off,net=${qemuGuestNetwork.net},host=${qemuGuestNetwork.host},hostfwd=tcp:127.0.0.1:${spec.sshPort}-:22,guestfwd=tcp:${qemuGuestNetwork.proxy}:${qemuGuestNetwork.proxyPort}-cmd:${localVmTools.nc} -U ${spec.proxySocket}`,
    "-device", `virtio-net-pci,netdev=net0,mac=${spec.mac}`,
    ...(spec.desktop ? ["-device", `${spec.architecture === "x86_64" ? "virtio-vga" : "virtio-gpu-pci"},xres=${vmScreenWidth},yres=${vmScreenHeight}`, "-device", "virtio-tablet-pci", "-device", "virtio-keyboard-pci"] : [])];
}
/** Hypervisor facts read from an actual argv. `exact` is true only when it is byte-for-byte the restricted profile. */
export interface QemuArgvFacts { cpus?: number; memoryMiB?: number; mac?: string; sshPort?: number; exact: boolean;
  /** True only when `exact` holds for the desktop profile; a headless VM keeps working and shows no screen. */
  desktop?: boolean }
/** Parses a running QEMU argv (from `/proc/<pid>/cmdline`) against the expected protected identity. */
export function qemuArgvFacts(argv: readonly string[], expected: Pick<QemuMachineSpec, "name" | "architecture" | "machineDirectory" | "proxySocket">): QemuArgvFacts {
  const value = (flag: string) => argv.filter(a => a === flag).length === 1 ? argv[argv.indexOf(flag) + 1] : undefined;
  const cpus = /^[0-9]{1,3}$/.test(value("-smp") ?? "") ? Number(value("-smp")) : undefined;
  const memory = /^([0-9]{1,7})M$/.exec(value("-m") ?? "")?.[1];
  const macs = argv.join("\n").match(/(?:^|[,\s])mac=((?:[0-9a-f]{2}:){5}[0-9a-f]{2})(?=[,\s]|$)/gim) ?? [];
  const mac = macs.length === 1 ? /mac=(\S{17})/.exec(macs[0]!)?.[1]?.toLowerCase() : undefined;
  const netdev = value("-netdev") ?? "", forwards = netdev.match(/hostfwd=/g)?.length ?? 0;
  const port = forwards === 1 ? /(?:^|,)hostfwd=tcp:127\.0\.0\.1:([0-9]{1,5})-:22(?:,|$)/.exec(netdev)?.[1] : undefined;
  const facts: QemuArgvFacts = { exact: false, ...(cpus ? { cpus } : {}), ...(memory ? { memoryMiB: Number(memory) } : {}), ...(mac ? { mac } : {}), ...(port ? { sshPort: Number(port) } : {}) };
  if (facts.cpus && facts.memoryMiB && facts.mac && facts.sshPort) {
    // Either fixed profile is exact: a VM started before the desktop profile was enabled stays verifiable.
    for (const desktop of [false, true]) {
      const rebuilt = qemuArgv({ ...expected, cpus: facts.cpus, memoryMiB: facts.memoryMiB, mac: facts.mac, sshPort: facts.sshPort, desktop });
      if (rebuilt.length === argv.length && rebuilt.every((a, i) => a === argv[i])) { facts.exact = true; if (desktop) facts.desktop = true; }
    }
  }
  return facts;
}

/**
 * Controller-side process observation seam; the default reads `/proc` of the protected host. `uid` (the real
 * and effective uid, which must agree) is required only when QEMU runs as a separate identity.
 */
export interface QemuProc { cmdline(pid: number): string[] | null; startTicks(pid: number): string | null; uid?(pid: number): number | null }
export const qemuProc: QemuProc = {
  uid(pid) { try { const line = /^Uid:\s+([0-9]+)\s+([0-9]+)/m.exec(readFileSync(`/proc/${pid}/status`, "utf8")); return line && line[1] === line[2] ? Number(line[1]) : null; } catch { return null; } },
  cmdline(pid) { try { const raw = readFileSync(`/proc/${pid}/cmdline`); if (!raw.length) return null; return raw.toString("utf8").replace(/\0$/, "").split("\0"); } catch { return null; } },
  startTicks(pid) { try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"), fields = stat.slice(stat.lastIndexOf(")") + 2).split(" "); return /^[0-9]+$/.test(fields[19] ?? "") ? fields[19]! : null; } catch { return null; } },
};
/** Protected local-VM host configuration from trusted composition. None of it is persisted with the manager or given to the guest. */
export interface QemuHostOptions {
  /** Protected directory holding verified images and per-VM state (overlay, keys, seed, QMP socket). */
  directory: string;
  /** Controller-only Unix socket of the registry proxy, reached by the guest-forward. */
  proxySocket: string;
  run?: VmHostCommand; qmp?: QmpExchange; proc?: QemuProc; download?: LocalVmDownload; probe?: LocalVmHostProbe;
  images?: Readonly<Record<"x86_64" | "aarch64", LocalVmImage>>;
  now?: () => number; sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  /** Service user's id for its lingering user manager (`XDG_RUNTIME_DIR`). */
  uid?: number;
  /**
   * VM15-03: run QEMU, its guest-forward helper and `qemu-img` as this separate unprivileged identity through
   * its fixed launcher. `proxySocket` must then be the shared layout's proxy socket and images are verified
   * into the shared, controller-owned image directory. Absent, QEMU runs as the controller identity.
   */
  vmm?: QemuVmmOptions;
  /**
   * DESK16-01: start this controller's VMs with the desktop profile (explicit S16 opt-in). A VM already running
   * headless keeps running and reports `vm_desktop_restart_required` until its next start.
   */
  desktop?: boolean;
  /**
   * DESK16-01 (ADR 0091 decision 2): issues the standing public-web lease of a desktop VM's guest browser. The
   * composed source (`startLocalVmControl`) refuses sensitive-only hosts on it. Absent, no desktop lease exists.
   */
  desktopLease?: (sessionId: string, expiresAt: number) => VmProxyLease;
  /**
   * DESK16-01 (ADR 0091 decisions 1, 6): bounded provisioning lease (no host filter, like the Docker install) the
   * desktop beat uses to install the desktop session on a VM enrolled before `desktop` was on. Absent, only
   * provisioning installs it.
   */
  provisionLease?: (sessionId: string, expiresAt: number) => VmProxyLease;
  /** Repeating timer seam for the desktop beat (default: an unreferenced `setInterval`); returns its cancel. */
  every?: (beat: () => void, milliseconds: number) => () => void;
}
/** Credential-free persisted identity of one Jit-created VM; owner resource edits change only `resources`. */
export interface QemuVmIdentity { name: string; architecture: "x86_64" | "aarch64"; mac: string; sshPort: number; resources: LocalVmResources }
/** Options for protected guest provisioning. The lease is a bounded proxy credential, never an account secret. */
export interface QemuProvisionOptions { lease?: (sessionId: string, expiresAt: number) => VmProxyLease; signal?: AbortSignal;
  /** Protected progress sink for the durable setup job: called as each provisioning step begins. Never guest output. */
  progress?: (step: QemuProvisionStep) => void;
  /** Ownership check of the calling setup job; throws once another runner holds the job. Called before every
   * host side effect (image write, disk/key/seed creation, start, stop, removal by exact path, guest setup). */
  guard?: () => void }
/** Provisioning steps a local manager reports, in order. Cached-image re-verification reports only `checksum`. */
export type QemuProvisionStep = "download" | "checksum" | "disk" | "boot" | "connect";
/** Optional local management surface used by the protected local enrollment entry point. */
export interface VmLocalManagement extends VmManagement {
  provision(options?: QemuProvisionOptions): Promise<{ docker: boolean }>;
  endpoint(): VmEndpoint;
}
/** Structural guard: only a protected local manager can create and enroll its own guest. */
export function isVmLocalManagement(manager: VmManagement | undefined): manager is VmLocalManagement {
  return !!manager && typeof (manager as Partial<VmLocalManagement>).provision === "function" && typeof (manager as Partial<VmLocalManagement>).endpoint === "function";
}
interface QemuState { provisioned: boolean; desired: "running" | "stopped"; pid: number | null; startTicks: string | null; appliedDiskGiB: number | null }
const wait = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((done, fail) => {
  const timer = setTimeout(done, milliseconds);
  signal?.addEventListener("abort", () => { clearTimeout(timer); fail(new DOMException("Aborted", "AbortError")); }, { once: true });
});

/**
 * Jit-managed nested KVM working VM on the controller host (direct QEMU, Ubuntu packages only).
 * QEMU runs as the non-root service user in a transient unit of its lingering user manager, outside the
 * controller cgroup, so it survives controller restarts; QMP and `/proc/<pid>/cmdline` re-attach and
 * re-verify it. All facts are controller-side observations; guest output is never isolation evidence.
 * Stop is proven by unit inactivity, PID absence and a released image lock. Snapshots are qcow2 internal
 * snapshots with exact protected tags (live through QMP, so siblings keep running); restore leaves the
 * VM stopped. Protected Jit state is outside the guest and is never part of a snapshot.
 */
export class QemuVmManagement implements VmLocalManagement {
  readonly #run: VmHostCommand;
  readonly #qmp: QmpExchange;
  readonly #proc: QemuProc;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  #resources: LocalVmResources;
  #desktopLease: VmProxyLease | null = null;
  /** Bumped by every revoke, so a delivery still in flight when the VM stops never installs its lease. */
  #desktopEpoch = 0;
  /** Cancels this boot's desktop beat; null while no beat runs. */
  #desktopBeatCancel: (() => void) | null = null;
  /** Aborted by every stop, so an in-flight delivery or install ends with it. */
  #desktopAbort = new AbortController();
  /** Desktop lease work in flight (delivery or install); a beat skips while it runs. */
  #desktopWork: Promise<void> | null = null;
  /** Whether this boot already tried to install a missing desktop session. */
  #desktopInstallTried = false;
  constructor(readonly identity: Readonly<QemuVmIdentity>, readonly host: QemuHostOptions) {
    if (!/^jit-work-[a-f0-9]{12}$/.test(identity.name) || !["x86_64", "aarch64"].includes(identity.architecture)) vmFail("vm_management_scope_denied", 403);
    if (!/^52:54:00(?::[a-f0-9]{2}){3}$/.test(identity.mac)) vmFail("vm_invalid_setup");
    vmInteger(identity.sshPort, 65535, 1024);
    if (!safePath(host.directory) || !safePath(host.proxySocket)) vmFail("vm_invalid_setup");
    // Unix socket paths (QMP, proxy) are limited to 108 bytes; the per-VM QMP path adds 39 bytes.
    if (host.directory.length > qemuStateDirectoryMax || host.proxySocket.length > 100) vmFail("vm_state_path_too_long");
    if (host.vmm && (validateVmm(host.vmm), host.proxySocket !== vmmLayout(host.vmm.directory).proxySocket)) vmFail("vm_invalid_setup");
    for (const value of [identity.resources.cpus, identity.resources.memoryMiB, identity.resources.diskGiB]) vmInteger(value, 4_194_304);
    this.#resources = { ...identity.resources };
    this.#run = host.run ?? vmHostCommand; this.#qmp = host.qmp ?? qmpExchange; this.#proc = host.proc ?? qemuProc;
    this.#now = host.now ?? Date.now; this.#sleep = host.sleep ?? wait;
  }
  /**
   * Protected per-VM controller directory (state, SSH client key, known_hosts, pinned host key); never mounted
   * into the guest. Without a separate QEMU identity it also holds the overlay, seed and QMP socket.
   */
  get machineDirectory(): string { return join(this.host.directory, "machines", this.identity.name); }
  /** Directory of the overlay, seed and QMP socket: the QEMU identity's own machine directory under VM15-03. */
  get hypervisorDirectory(): string { return this.host.vmm ? join(vmmLayout(this.host.vmm.directory).machines, this.identity.name) : this.machineDirectory; }
  private get unit() { return `${this.identity.name}.service`; }
  private get disk() { return join(this.hypervisorDirectory, "disk.qcow2"); }
  private get stateFile() { return join(this.machineDirectory, "state.json"); }
  private get image(): LocalVmImage { return (this.host.images ?? localVmImages)[this.identity.architecture]; }
  private spec(resources: LocalVmResources = this.#resources): QemuMachineSpec {
    return { name: this.identity.name, architecture: this.identity.architecture, machineDirectory: this.hypervisorDirectory, cpus: resources.cpus, memoryMiB: resources.memoryMiB, mac: this.identity.mac, sshPort: this.identity.sshPort, proxySocket: this.host.proxySocket, ...(this.host.desktop ? { desktop: true } : {}) };
  }
  /** Resource values for the next start. Editing them never changes a running guest. */
  get resources(): LocalVmResources { return { ...this.#resources }; }
  /** Disk size (GiB) the image actually has after the last protected create/resize; 0 before provisioning. */
  get appliedDiskGiB(): number { return this.state().appliedDiskGiB ?? 0; }
  set resources(value: LocalVmResources) { for (const v of [value.cpus, value.memoryMiB, value.diskGiB]) vmInteger(v, 4_194_304); this.#resources = { ...value }; }
  /** Pinned SSH endpoint: the loopback host-forward, generated client key and pre-generated guest host key. */
  endpoint(): VmEndpoint {
    return { host: "127.0.0.1", port: this.identity.sshPort, user: "jit", identityFile: join(this.machineDirectory, "client"), knownHostsFile: join(this.machineDirectory, "known_hosts") };
  }
  private state(): QemuState {
    try { const value = JSON.parse(readFileSync(this.stateFile, "utf8")); if (value && typeof value === "object") return { provisioned: value.provisioned === true, desired: value.desired === "running" ? "running" : "stopped", pid: Number.isSafeInteger(value.pid) ? value.pid : null, startTicks: typeof value.startTicks === "string" ? value.startTicks : null, appliedDiskGiB: Number.isSafeInteger(value.appliedDiskGiB) && value.appliedDiskGiB > 0 ? value.appliedDiskGiB : null }; }
    catch { /* No state means a never-provisioned, stopped VM. */ }
    return { provisioned: false, desired: "stopped", pid: null, startTicks: null, appliedDiskGiB: null };
  }
  private saveState(update: Partial<QemuState>): void {
    const next = { ...this.state(), ...update }, temporary = `${this.stateFile}.${randomBytes(6).toString("hex")}`;
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" }); renameSync(temporary, this.stateFile);
  }
  private async command(argv: readonly string[], timeoutMs = 120_000, maxBytes = 262_144): Promise<string> {
    const env = { XDG_RUNTIME_DIR: `/run/user/${this.host.uid ?? process.getuid?.() ?? 0}` };
    const result = await this.#run(argv, { timeoutMs, maxBytes, env });
    if (result.exitCode !== 0) vmFail("vm_management_unavailable", 503);
    return Buffer.from(result.stdout).toString("utf8");
  }
  /**
   * The exact argv of one hypervisor-side operation. Without a separate QEMU identity it is the original direct
   * command in the controller's own user manager; with one it is the fixed `sudo -n -u <vmm> -- <launcher>`
   * operation, which rebuilds the same command (and the same QEMU argv) as that identity.
   */
  private hypervisor(operation: ["show" | "stop" | "kill" | "discard-frame"] | ["info", boolean] | ["resize", number] | ["create", string, number] | ["snapshot", "create" | "apply" | "delete", string] | ["start", LocalVmResources]): string[] {
    const vmm = this.host.vmm, name = this.identity.name, [op] = operation;
    if (vmm) {
      if (op === "info") return vmmCommand(vmm, ["info", name, operation[1] ? "shared" : "exclusive"]);
      if (op === "resize") return vmmCommand(vmm, ["resize", name, String(operation[1])]);
      if (op === "create") { const sha = /\/([a-f0-9]{64})\.qcow2$/.exec(operation[1])?.[1]; if (!sha || operation[1] !== join(vmmLayout(vmm.directory).images, `${sha}.qcow2`)) vmFail("vm_image_unverified"); return vmmCommand(vmm, ["create", name, sha, String(operation[2])]); }
      if (op === "snapshot") return vmmCommand(vmm, ["snapshot", name, operation[1], operation[2]]);
      if (op === "start") { const r = operation[1]; return vmmCommand(vmm, ["start", name, this.identity.architecture, String(r.cpus), String(r.memoryMiB), this.identity.mac, String(this.identity.sshPort), ...(this.host.desktop ? ["desktop"] : [])]); }
      return vmmCommand(vmm, [op, name]);
    }
    if (op === "show") return ["systemctl", "--user", "show", this.unit, "--property=LoadState", "--property=ActiveState", "--property=MainPID"];
    if (op === "stop") return ["systemctl", "--user", "stop", this.unit];
    if (op === "kill") return ["systemctl", "--user", "kill", "--signal=SIGKILL", this.unit];
    if (op === "info") return [localVmTools.img, "info", ...(operation[1] ? ["--force-share"] : []), "--output=json", this.disk];
    if (op === "resize") return [localVmTools.img, "resize", this.disk, `${operation[1]}G`];
    if (op === "create") return [localVmTools.img, "create", "-q", "-f", "qcow2", "-F", "qcow2", "-b", operation[1], this.disk, `${operation[2]}G`];
    if (op === "snapshot") return [localVmTools.img, "snapshot", operation[1] === "create" ? "-c" : operation[1] === "apply" ? "-a" : "-d", operation[2], this.disk];
    return ["systemd-run", "--user", "--quiet", "--collect", `--unit=${this.unit}`, "--property=Type=exec", "--property=TimeoutStopSec=15", "--", ...qemuArgv(this.spec(operation[1]))];
  }
  private qmp(commands: readonly QmpCommand[], timeoutMs = 30_000): Promise<unknown[]> { return this.#qmp(join(this.hypervisorDirectory, "qmp.sock"), commands, { timeoutMs }); }
  /** Unit state from the QEMU identity's own systemd user manager (the controller's, without VM15-03). */
  private async unitState(): Promise<{ active: boolean; pid: number }> {
    const out = await this.command(this.hypervisor(["show"]), 15_000, 4096);
    const lines = new Map(out.trim().split("\n").map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)] as const));
    const active = lines.get("ActiveState"), pid = Number(lines.get("MainPID") ?? "0");
    if (!active || !Number.isSafeInteger(pid) || pid < 0) vmFail("vm_management_unavailable");
    return { active: !["inactive", "failed"].includes(active), pid };
  }
  /** A PID counts as this VM's QEMU only if its start time matches and its argv names this exact VM. */
  private ours(pid: number, startTicks?: string | null): string[] | null {
    if (!pid) return null;
    const argv = this.#proc.cmdline(pid), ticks = this.#proc.startTicks(pid);
    if (!argv || !ticks || startTicks && ticks !== startTicks) return null;
    // Under VM15-03 a QEMU running as any other identity (the controller included) is never this VM.
    if (this.host.vmm && (this.#proc.uid?.(pid) ?? null) !== this.host.vmm.uid) return null;
    return argv[0] === localVmTools[this.identity.architecture] && argv.includes(this.identity.name) && argv.some(a => a.includes(`file=${this.disk},`)) ? argv : null;
  }
  private async imageInfo(share = true): Promise<{ virtualSize: number; snapshots: string[]; backing: string | null; format: string }> {
    const info = JSON.parse(await this.command(this.hypervisor(["info", share]), 60_000, 1_048_576));
    if (!info || typeof info !== "object" || !Number.isSafeInteger(info["virtual-size"])) vmFail("vm_management_unavailable");
    return { virtualSize: info["virtual-size"], format: String(info.format), backing: typeof info["backing-filename"] === "string" ? info["backing-filename"] : null,
      snapshots: Array.isArray(info.snapshots) ? info.snapshots.map((s: { name?: unknown }) => String(s?.name)) : [] };
  }
  /** Reads state, identity, MAC, SSH forward, network profile and CPU/RAM/disk from the controller only. */
  async inspect(): Promise<VmMachineState> {
    const unit = await this.unitState(), recorded = this.state();
    const unitArgv = unit.active ? this.ours(unit.pid) : null;
    if (unit.active && !unitArgv) vmFail("vm_boundary_unproven");
    // An inactive unit with a still-live recorded QEMU is reported running (never proven), so stop read-back fails closed.
    const strayArgv = !unitArgv && recorded.pid ? this.ours(recorded.pid, recorded.startTicks) : null;
    const argv = unitArgv ?? strayArgv, pid = unitArgv ? unit.pid : strayArgv ? recorded.pid! : 0;
    const diskBytes = existsSync(this.disk) ? (await this.imageInfo()).virtualSize : this.#resources.diskGiB * GiB;
    const identity = `qemu:${this.identity.name}`;
    if (!argv) return { state: "stopped", identity, boot: "stopped", cpuCount: this.#resources.cpus, memoryBytes: this.#resources.memoryMiB * 1_048_576, diskBytes, network: "unproven", nicMac: this.identity.mac, sshEndpoint: { host: "127.0.0.1", port: this.identity.sshPort } };
    const facts = qemuArgvFacts(argv, this.spec());
    const [status, name] = await this.qmp([{ execute: "query-status" }, { execute: "query-name" }]) as [{ status?: unknown }, { name?: unknown }];
    if (name?.name !== this.identity.name || typeof status?.status !== "string") vmFail("vm_boundary_unproven");
    const exact = facts.exact && unit.active && pid === unit.pid && facts.mac === this.identity.mac && facts.sshPort === this.identity.sshPort;
    return { state: "running", identity, boot: `${pid}:${this.#proc.startTicks(pid)}`, cpuCount: facts.cpus ?? 0, memoryBytes: (facts.memoryMiB ?? 0) * 1_048_576, diskBytes,
      network: exact ? "proxy-only" : "unproven", ...(facts.mac ? { nicMac: facts.mac } : {}), ...(facts.sshPort ? { sshEndpoint: { host: "127.0.0.1", port: facts.sshPort } } : {}) };
  }
  /**
   * DESK16-01 host-side screen of this exact VM: QMP `screendump` (PNG) and `input-send-event` on the
   * controller-only socket. Only a running QEMU whose argv is exactly the desktop profile has a screen; frames
   * are written into this VM's hypervisor directory, read once and always removed before the capture settles
   * (`discardFrame`, also under VM15-03). A frame that cannot be removed fails the capture, so no frame outlives
   * it. One capture runs at a time.
   */
  screen(): VmScreenDevice {
    const self = this; let capturing: Promise<unknown> = Promise.resolve();
    const running = async (): Promise<string | null> => {
      if (!this.host.desktop) return "vm_desktop_unavailable";
      const unit = await this.unitState(), argv = unit.active ? this.ours(unit.pid) : null;
      if (!argv) return "vm_not_running";
      return qemuArgvFacts(argv, this.spec()).desktop ? null : "vm_desktop_restart_required";
    };
    return {
      unavailable: running,
      async capture() {
        const turn = capturing.then(async () => {
          const code = await running(); if (code) vmFail(code, 409);
          const file = join(self.hypervisorDirectory, "screen.png");
          try {
            await self.qmp([{ execute: "screendump", arguments: { filename: file, format: "png" } }], 10_000);
            try { return vmScreenFrame(new Uint8Array(readFileSync(file))); }
            catch (error) { if (error instanceof AppError) throw error; return vmFail("vm_screen_invalid", 502); }
          } finally { await self.discardFrame(); }
        });
        capturing = turn.catch(() => {});
        return turn;
      },
      async send(input: VmScreenInput) {
        const code = await running(); if (code) vmFail(code, 409);
        await self.qmp(vmScreenCommands(input), 10_000);
      },
    };
  }
  private async until(test: () => Promise<boolean>, milliseconds: number, interval: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = this.#now() + milliseconds;
    for (;;) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (await test()) return true;
      if (this.#now() >= deadline) return false;
      await this.#sleep(interval, signal);
    }
  }
  /** Explicit protected start of this exact VM with the current resource settings; no command is replayed. */
  async start(signal?: AbortSignal): Promise<void> {
    if ((await this.inspect()).state !== "stopped") vmFail("vm_fenced");
    const recorded = this.state(); if (!recorded.provisioned && !existsSync(join(this.hypervisorDirectory, "seed.img"))) vmFail("vm_management_unavailable");
    await this.launch(signal);
  }
  private async launch(signal?: AbortSignal): Promise<void> {
    const resources = this.#resources, info = await this.imageInfo(false);
    if (info.virtualSize < resources.diskGiB * GiB) await this.command(this.hypervisor(["resize", resources.diskGiB]), 120_000);
    // The separate QEMU identity's launcher removes its own stale QMP socket before starting.
    if (!this.host.vmm) rmSync(join(this.machineDirectory, "qmp.sock"), { force: true });
    this.saveState({ desired: "running", pid: null, startTicks: null, appliedDiskGiB: Math.max(resources.diskGiB, Math.floor(info.virtualSize / GiB)) });
    await this.command(this.hypervisor(["start", resources]), 30_000, 65_536);
    let pid = 0;
    const running = await this.until(async () => {
      const unit = await this.unitState(); if (!unit.active) vmFail("vm_management_unavailable");
      if (!this.ours(unit.pid)) return false;
      try { await this.qmp([{ execute: "query-status" }], 5000); pid = unit.pid; return true; } catch { return false; }
    }, 30_000, 500, signal);
    if (!running) vmFail("vm_management_unavailable");
    this.saveState({ pid, startTicks: this.#proc.startTicks(pid) });
    await this.waitForSsh(signal);
    this.#desktopInstallTried = false;
    // The boot's lease and beat: a lease that cannot be issued or delivered now is retried by the beat.
    await this.desktopTurn(() => this.openDesktopLease(signal));
    this.armDesktop();
  }
  /** Whether this manager currently holds a delivered desktop browser lease (DESK16-01). */
  get desktopLeaseHeld(): boolean { return this.#desktopLease !== null; }
  /**
   * DESK16-01 (ADR 0091 decisions 2-3): the guest desktop browser's standing public-web lease, separate from every
   * work-session lease. A fresh lease is issued after each boot, again once provisioning has finished cloud-init and
   * installed the desktop session, and when a controller re-attaches a VM that survived its restart (the restarted
   * proxy holds no lease). It is written over SSH to `/etc/jit-desktop/proxy.env` (`0640 root:jit-desktop`) only when
   * the guest has the desktop session's group; otherwise, or when delivery fails, it is revoked at once. A proxy that
   * cannot issue one (e.g. its lease pool is full) leaves the VM running without a lease. Neither ever fails the start:
   * the 10-minute desktop beat (`desktopBeat`) renews a held lease and issues a new one while none is held. Every stop
   * (owner stop, idle stop, restore) revokes the lease and ends the beat first.
   *
   * With `install`, a guest without the desktop session first gets it installed (`qemuDesktopProvisioning`) through
   * a separate bounded provisioning lease, then the desktop lease is issued.
   */
  private async openDesktopLease(signal?: AbortSignal, install?: (sessionId: string, expiresAt: number) => VmProxyLease): Promise<void> {
    if (!this.host.desktopLease || !this.host.desktop) return;
    this.revokeDesktopLease(); const epoch = this.#desktopEpoch, abort = this.#desktopAbort.signal;
    // Only a VM whose restricted profile is proven now gets standing web access.
    try { if (!this.isolated(await this.inspect())) return; } catch { return; }
    if (epoch !== this.#desktopEpoch) return;
    const stop = signal ? AbortSignal.any([signal, abort]) : abort;
    const result = await this.deliverDesktopLease(epoch, stop);
    if (result === "absent" && install && !this.#desktopInstallTried && epoch === this.#desktopEpoch) {
      // One install attempt per boot: a failed download is not retried every beat.
      this.#desktopInstallTried = true;
      if (await this.installDesktop(install, stop) && epoch === this.#desktopEpoch) await this.deliverDesktopLease(epoch, stop);
    }
  }
  /** Issues one desktop lease and writes it into the guest; keeps it only if this epoch is still current. */
  private async deliverDesktopLease(epoch: number, signal: AbortSignal): Promise<"held" | "absent" | "failed"> {
    // Expiry is judged by the proxy's own wall clock, like work-session and provisioning leases.
    let lease: VmProxyLease;
    try { lease = this.host.desktopLease!(`desktop_${this.identity.name}_${randomBytes(12).toString("hex")}`, Date.now() + desktopLeaseMs); } catch { return "failed"; }
    let out = "";
    try {
      out = (await new VmSshTransport(this.endpoint(), this.#run).control(["sudo", "-n", "python3", "-I", "-c", qemuDesktopLeaseWriter],
        { timeoutMs: 60_000, maxBytes: 4096, input: Buffer.from(JSON.stringify({ proxy: lease.environment.HTTPS_PROXY ?? "", version: qemuDesktopBrowser.version })), signal })).trim();
    } catch { out = ""; }
    if (out !== "jit-desktop-lease-v1" || epoch !== this.#desktopEpoch) { lease.close(); return out === "jit-desktop-absent-v1" ? "absent" : "failed"; }
    this.#desktopLease = lease;
    return "held";
  }
  /**
   * Installs the pinned desktop session in the guest (ADR 0091 decisions 1, 6) through one bounded provisioning
   * lease, which is always closed afterwards. True only when the guest reports the session ready.
   */
  private async installDesktop(issue: (sessionId: string, expiresAt: number) => VmProxyLease, signal: AbortSignal): Promise<boolean> {
    let lease: VmProxyLease;
    try { lease = issue(`provision_${randomBytes(16).toString("hex")}`, Date.now() + 1_800_000); } catch { return false; }
    try {
      const pin = qemuDesktopBrowser[this.identity.architecture];
      const input = Buffer.from(JSON.stringify({ proxy: lease.environment.HTTPS_PROXY ?? "", url: pin.url, sha256: pin.sha256, version: qemuDesktopBrowser.version }));
      const out = await this.guest(new VmSshTransport(this.endpoint(), this.#run), ["sudo", "-n", "python3", "-I", "-c", qemuDesktopProvisioning], { timeoutMs: 1_800_000, input, signal });
      return out.trim() === "jit-desktop-ready-v1";
    } catch { return false; } finally { lease.close(); }
  }
  /**
   * The desktop beat (#454): one timer per boot of a desktop VM, every 10 minutes.
   * - running, lease held: renew it (a renewal that fails revokes it; the next beat issues a new one);
   * - running, no lease (full pool, failed delivery, a guest still without the session): issue one, installing the
   *   session first if a provisioning lease source exists and this boot has not tried yet;
   * - `inspect()` failed transiently (QMP busy with a live snapshot, a management timeout): skip this beat and keep
   *   the lease; its 30-minute expiry outlives one missed renewal;
   * - the VM is proven not running, its boundary is unproven (`vm_boundary_unproven`) or its network profile is not
   *   proven (`network` other than `proxy-only`): revoke and issue nothing, failing closed.
   *   A VM that is no longer running also ends the beat; its next protected start begins a new one.
   * A beat that finds earlier desktop work still in flight does nothing.
   */
  private async desktopBeat(): Promise<void> {
    if (this.#desktopWork) return;
    const epoch = this.#desktopEpoch;
    let machine: VmMachineState;
    try { machine = await this.inspect(); }
    catch (error) {
      if (error instanceof AppError && error.code === "vm_boundary_unproven" && epoch === this.#desktopEpoch) this.revokeDesktopLease();
      return;
    }
    if (epoch !== this.#desktopEpoch || this.#desktopWork) return;
    if (machine.state !== "running") { this.endDesktop(); return; }
    // A running VM whose restricted network profile is not proven (e.g. an extra device) keeps no lease and gets none.
    if (!this.isolated(machine)) { this.revokeDesktopLease(); return; }
    const held = this.#desktopLease;
    if (held) { try { held.renew?.(Date.now() + desktopLeaseMs); } catch { this.revokeDesktopLease(); } return; }
    await this.desktopTurn(() => this.openDesktopLease(undefined, this.host.provisionLease));
  }
  /** Whether an inspected VM is running with its restricted, proxy-only network profile proven. */
  private isolated(machine: VmMachineState): boolean { return machine.state === "running" && machine.network === "proxy-only"; }
  /** Runs one piece of desktop lease work at a time; a caller that must act waits for the earlier one to settle. */
  private async desktopTurn(work: () => Promise<void>): Promise<void> {
    while (this.#desktopWork) await this.#desktopWork;
    const running = work(), settled: Promise<void> = running.then(() => {}, () => {}).finally(() => { if (this.#desktopWork === settled) this.#desktopWork = null; });
    this.#desktopWork = settled;
    await running;
  }
  /** Starts the desktop beat of this boot (idempotent). Only a desktop controller with a lease source has one. */
  private armDesktop(): void {
    if (!this.host.desktop || !this.host.desktopLease || this.#desktopBeatCancel) return;
    this.#desktopBeatCancel = (this.host.every ?? repeat)(() => this.desktopBeat(), desktopLeaseRenewMs);
  }
  /** Revokes the held lease (if any) and invalidates every delivery still in flight. The beat keeps running. */
  private revokeDesktopLease(): void {
    const held = this.#desktopLease; this.#desktopLease = null; this.#desktopEpoch++;
    held?.close();
  }
  /** Ends this boot's desktop state: aborts in-flight delivery or install, revokes the lease and stops the beat. */
  private endDesktop(): void {
    this.#desktopAbort.abort(); this.#desktopAbort = new AbortController();
    this.revokeDesktopLease();
    const cancel = this.#desktopBeatCancel; this.#desktopBeatCancel = null; cancel?.();
  }
  /**
   * Controller-boot re-attachment of a VM that survived the restart, after the caller re-verified it: the restarted
   * proxy holds no lease, so a desktop VM gets a fresh desktop lease and a new beat (DESK16-01). Headless VMs are unchanged.
   * The beat is armed before anything can fail: a transient `inspect()` failure here (QMP held by a live snapshot)
   * only means no lease yet, and the next beat issues one (#454 (a)); a VM found not running ends the beat there.
   */
  async reattached(signal?: AbortSignal): Promise<void> {
    this.armDesktop();
    if (!this.#desktopLease) await this.desktopTurn(() => this.openDesktopLease(signal));
  }
  /**
   * Waits for the guest SSH service, compares its host key to the pinned key (a different key fails closed),
   * then waits until a pinned-key login is admitted (`pam_nologin` refuses logins until boot completes).
   */
  private async waitForSsh(signal?: AbortSignal): Promise<void> {
    const pinned = readFileSync(join(this.machineDirectory, "hostkey.pub"), "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
    const ready = await this.until(async () => {
      if (!(await this.unitState()).active) vmFail("vm_management_unavailable");
      const result = await this.#run(["ssh-keyscan", "-T", "5", "-t", "ed25519", "-p", String(this.identity.sshPort), "127.0.0.1"], { timeoutMs: 15_000, maxBytes: 8192 });
      const keys = Buffer.from(result.stdout).toString("utf8").split("\n").filter(l => l.trim() && !l.startsWith("#")).map(l => l.trim().split(/\s+/).slice(1, 3).join(" "));
      if (!keys.length) return false;
      if (keys.some(key => key !== pinned)) vmFail("vm_host_key_changed");
      return true;
    }, 600_000, 2000, signal);
    if (!ready) vmFail("vm_management_unavailable");
    const transport = new VmSshTransport(this.endpoint(), this.#run);
    if ((await this.guest(transport, ["true"], { timeoutMs: 30_000, ...(signal ? { signal } : {}) })) !== "") vmFail("vm_protocol_invalid");
  }
  /**
   * DESK16-01: removes this VM's last screen frame. Under VM15-03 the file belongs to the QEMU identity in a
   * directory the controller cannot write, so that identity's launcher removes exactly `<vm>/screen.png`.
   */
  private async discardFrame(): Promise<void> {
    if (this.host.vmm) await this.command(this.hypervisor(["discard-frame"]), 15_000, 4096);
    else rmSync(join(this.hypervisorDirectory, "screen.png"), { force: true });
  }
  /**
   * Hard stop of this exact VM, then independent read-back: unit inactive, QEMU PID gone, image lock released.
   * A stopped VM keeps no screen frame (DESK16-01), including after an idle stop. Only a desktop controller can
   * capture frames, so a headless one never needs the `discard-frame` launcher op (an older launcher keeps working).
   */
  async stop(): Promise<void> {
    await this.halt();
    if (this.host.desktop) await this.discardFrame();
  }
  private async halt(): Promise<void> {
    // The desktop lease and beat go first: a stopping or stopped VM keeps no standing web access (DESK16-01).
    this.endDesktop();
    const before = await this.unitState(), recorded = this.state();
    this.saveState({ desired: "stopped" });
    const pids = [before.pid, recorded.pid ?? 0].filter(pid => pid > 0);
    const gone = async () => !(await this.unitState()).active && pids.every(pid => !this.ours(pid, pid === recorded.pid ? recorded.startTicks : null));
    if (await gone() && await this.unlocked()) return;
    try { await this.qmp([{ execute: "quit" }], 10_000); } catch { /* Fall through to the unit stop. */ }
    if (!await this.until(gone, 10_000, 250)) {
      try { await this.command(this.hypervisor(["stop"]), 60_000, 4096); } catch { /* Read-back decides. */ }
      if (!await this.until(gone, 5000, 250)) {
        try { await this.command(this.hypervisor(["kill"]), 15_000, 4096); } catch { /* Read-back decides. */ }
        await this.until(gone, 5000, 250);
      }
    }
    if (!await gone() || !await this.unlocked()) vmFail("vm_stop_unconfirmed");
    this.saveState({ pid: null, startTicks: null });
  }
  /** A writer lock probe without `--force-share` succeeds only when no QEMU still holds this disk open. */
  private async unlocked(): Promise<boolean> {
    if (!existsSync(this.disk)) return true;
    try { await this.imageInfo(false); return true; } catch { return false; }
  }
  /** Protected tags on the overlay, read from the image itself. */
  async snapshots(): Promise<string[]> { return existsSync(this.disk) ? (await this.imageInfo()).snapshots : []; }
  /**
   * Exact-tag internal disk snapshot; live and crash-consistent through QMP when running, so sessions keep
   * running. A best-effort guest `sync` first flushes the page cache so recent writes are captured; it is a
   * cooperative courtesy (guest root may ignore it), never part of the snapshot's protected guarantee.
   */
  async snapshot(name: string): Promise<void> {
    if (!snapshotTag.test(name)) vmFail("vm_invalid_setup");
    if ((await this.inspect()).state === "running") {
      try { await new VmSshTransport(this.endpoint(), this.#run).control(["sudo", "-n", "sync"], { timeoutMs: 60_000 }); } catch { /* Crash-consistent without it. */ }
      await this.qmp([{ execute: "blockdev-snapshot-internal-sync", arguments: { device: "disk0", name } }], 300_000);
    }
    else await this.command(this.hypervisor(["snapshot", "create", name]), 300_000);
    if (!(await this.snapshots()).includes(name)) vmFail("vm_management_unavailable");
  }
  /** Restores only an exact existing tag after a proven stop. The VM stays stopped until the owner starts it. */
  async restore(name: string): Promise<void> {
    if (!snapshotTag.test(name)) vmFail("vm_invalid_setup");
    if (!(await this.snapshots()).includes(name)) vmFail("vm_snapshot_unknown");
    await this.stop();
    await this.command(this.hypervisor(["snapshot", "apply", name]), 300_000);
  }
  /** Deletes only the service-selected exact tag. */
  async retireSnapshot(name: string): Promise<void> {
    if (!snapshotTag.test(name)) vmFail("vm_invalid_setup");
    if ((await this.inspect()).state === "running") await this.qmp([{ execute: "blockdev-snapshot-delete-internal-sync", arguments: { device: "disk0", name } }], 120_000);
    else await this.command(this.hypervisor(["snapshot", "delete", name]), 120_000);
    if ((await this.snapshots()).includes(name)) vmFail("vm_management_unavailable");
  }
  /**
   * Controller-boot re-attachment. A surviving VM is left running (the caller re-verifies identity); a VM
   * that was running before a host restart is started again; a VM stopped by the owner or by restore stays
   * stopped. Returns whether a new boot was started.
   */
  async resume(signal?: AbortSignal): Promise<boolean> {
    if ((await this.inspect()).state === "running") return false;
    const recorded = this.state(); if (!recorded.provisioned || recorded.desired !== "running") return false;
    await this.launch(signal); return true;
  }
  private secureDirectory(path: string): void {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) vmFail("vm_key_directory_unsafe");
  }
  private async keygen(file: string, comment: string): Promise<string> {
    const result = await this.#run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", file], { timeoutMs: 10_000, maxBytes: 1024 });
    if (result.exitCode !== 0) vmFail("vm_key_generation_failed", 503);
    chmodSync(file, 0o600); registerSecretFingerprint(readFileSync(file, "utf8"));
    const publicKey = readFileSync(`${file}.pub`, "utf8").trim();
    if (!new RegExp(`^ssh-ed25519 [A-Za-z0-9+/]{68} ${comment}$`).test(publicKey)) vmFail("vm_key_generation_failed");
    return publicKey;
  }
  /** NoCloud seed: one key-only user with sudo, pinned host key, no password/root login, proxy-friendly tools. */
  private async seed(clientKey: string, hostPublic: string, hostPrivate: string): Promise<void> {
    const directory = join(this.machineDirectory, "seed"); this.secureDirectory(directory);
    const proxyEnv = "http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY";
    const userData = { hostname: this.identity.name, manage_etc_hosts: true, disable_root: true, ssh_pwauth: false,
      users: [{ name: "jit", gecos: "Jit working VM", shell: "/bin/bash", sudo: "ALL=(ALL) NOPASSWD:ALL", lock_passwd: true, ssh_authorized_keys: [`restrict ${clientKey}`] }],
      ssh_deletekeys: true, ssh_genkeytypes: [], ssh_keys: { ed25519_private: hostPrivate, ed25519_public: hostPublic },
      package_update: false, package_upgrade: false, package_reboot_if_required: false,
      write_files: [
        { path: "/etc/ssh/sshd_config.d/10-jit-working-vm.conf", permissions: "0644", content: "PermitRootLogin no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nAllowAgentForwarding no\nAllowTcpForwarding no\nX11Forwarding no\nPermitTunnel no\nAllowUsers jit\n" },
        { path: "/etc/sudoers.d/90-jit-proxy-env", permissions: "0440", content: `Defaults env_keep += "${proxyEnv}"\n` },
        { path: "/etc/apt/apt.conf.d/90jit-proxy", permissions: "0644", content: "Acquire::http::Pipeline-Depth \"0\";\nAcquire::Languages \"none\";\n" },
      ] };
    // Restricted slirp offers no default route or DNS; `optional` keeps boot from waiting two minutes for "online".
    const network = { version: 2, ethernets: { nic0: { match: { macaddress: this.identity.mac }, dhcp4: true, dhcp6: false, "accept-ra": false, optional: true, "dhcp4-overrides": { "use-dns": false, "use-ntp": false } } } };
    writeFileSync(join(directory, "user-data"), `#cloud-config\n${JSON.stringify(userData)}\n`, { mode: 0o600 });
    writeFileSync(join(directory, "meta-data"), `instance-id: ${this.identity.name}\nlocal-hostname: ${this.identity.name}\n`, { mode: 0o600 });
    writeFileSync(join(directory, "network-config"), `${JSON.stringify(network)}\n`, { mode: 0o600 });
    const seed = join(this.machineDirectory, "seed.img");
    try {
      await this.command([localVmTools.seed, `--network-config=${join(directory, "network-config")}`, seed, join(directory, "user-data"), join(directory, "meta-data")], 60_000, 65_536);
      chmodSync(seed, 0o600);
      if (this.host.vmm) {
        // Hand the seed to the QEMU identity through its launcher's stdin; the controller keeps no copy.
        const result = await this.#run(vmmCommand(this.host.vmm, ["seed", this.identity.name]), { timeoutMs: 60_000, maxBytes: 4096, input: readFileSync(seed) });
        if (result.exitCode !== 0) vmFail("vm_management_unavailable", 503);
      }
    } finally { rmSync(directory, { recursive: true, force: true }); if (this.host.vmm) rmSync(seed, { force: true }); }
  }
  /** Runs one fixed protected readiness program in the guest, tolerating only connection failures until the deadline. */
  private async guest(transport: VmSshTransport, argv: readonly string[], options: { timeoutMs: number; input?: Uint8Array; signal?: AbortSignal }): Promise<string> {
    let output = "";
    const done = await this.until(async () => {
      try { output = await transport.control(argv, { timeoutMs: options.timeoutMs, maxBytes: 16_384, ...(options.input ? { input: options.input } : {}), ...(options.signal ? { signal: options.signal } : {}) }); return true; }
      catch (error) { if (error instanceof AppError && error.code === "vm_connection_failed") return false; throw error; }
    }, 300_000, 3000, options.signal);
    if (!done) vmFail("vm_prerequisite_missing", 503);
    return output;
  }
  /**
   * Creates (or completes) this VM: verified pinned image, read-only base plus per-VM overlay, generated
   * client and guest host keys, NoCloud seed, start, pinned-key SSH readiness and cloud-init completion.
   * Docker is installed through the protected proxy under one bounded provisioning lease when a lease
   * source is supplied on first creation; otherwise, or on failure, Docker is reported as missing and the
   * agent may install it later. An unfinished earlier attempt is discarded first; it never held user data.
   */
  async provision(options: QemuProvisionOptions = {}): Promise<{ docker: boolean }> {
    const host = detectLocalVmHost(this.host.directory, this.host.probe ?? localVmHostProbe);
    if (!host.kvm || !host.qemu || host.architecture !== this.identity.architecture) vmFail("vm_host_unsupported", 422);
    this.secureDirectory(this.host.directory);
    const guard = options.guard ?? (() => {});
    guard();
    const vmm = this.host.vmm;
    const base = await ensureLocalVmImage(vmm ? vmmLayout(vmm.directory).control : this.host.directory, this.image, this.host.download ?? localVmDownload, options.signal, options.progress, guard, vmm ? "group" : "private");
    const fresh = !this.state().provisioned;
    if (fresh) {
      options.progress?.("disk");
      if (existsSync(this.machineDirectory) || vmm && existsSync(this.hypervisorDirectory)) {
        guard(); await this.stop(); guard(); rmSync(this.machineDirectory, { recursive: true, force: true });
        if (vmm) await this.command(vmmCommand(vmm, ["remove", this.identity.name]), 60_000, 4096);
      }
      guard(); this.secureDirectory(this.machineDirectory);
      await this.command(this.hypervisor(["create", base, this.#resources.diskGiB]), 120_000);
      const info = await this.imageInfo(false);
      if (info.format !== "qcow2" || info.backing !== base || info.virtualSize !== this.#resources.diskGiB * GiB) vmFail("vm_image_unverified");
      guard(); this.saveState({ appliedDiskGiB: this.#resources.diskGiB });
      const client = await this.keygen(join(this.machineDirectory, "client"), "jit-working-vm");
      const hostFile = join(this.machineDirectory, "hostkey"), hostPublic = await this.keygen(hostFile, "jit-working-vm-host");
      writeFileSync(join(this.machineDirectory, "known_hosts"), `[127.0.0.1]:${this.identity.sshPort} ${hostPublic.split(" ").slice(0, 2).join(" ")}\n`, { mode: 0o600, flag: "wx" });
      guard(); try { await this.seed(client, hostPublic, readFileSync(hostFile, "utf8")); } finally { rmSync(hostFile, { force: true }); }
    }
    // A guest this attempt started is stopped again if provisioning fails (host-key refusal, readiness,
    // cancellation), so a failed setup never leaves an unregistered VM consuming the host.
    guard(); const startedHere = (await this.inspect()).state === "stopped";
    const transport = new VmSshTransport(this.endpoint(), this.#run);
    try {
      if (startedHere) { options.progress?.("boot"); guard(); await this.launch(options.signal); }
      options.progress?.("connect"); guard();
      const status = await this.guest(transport, ["sudo", "-n", "python3", "-I", "-c", "import subprocess;r=subprocess.run(['cloud-init','status','--wait'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode;print('jit-cloud-init:%d'%r)"], { timeoutMs: 900_000, ...(options.signal ? { signal: options.signal } : {}) });
      if (!["jit-cloud-init:0", "jit-cloud-init:2"].includes(status.trim())) vmFail("vm_prerequisite_missing", 503);
      guard(); this.saveState({ provisioned: true });
    } catch (error) {
      // A runner that lost the job never stops the guest: it now belongs to the runner holding the job. A
      // cancelled runner that still holds it stops the guest it started.
      let owned = true; try { guard(); } catch (failure) { owned = !(failure instanceof AppError && failure.code === "vm_provisioning_superseded"); }
      if (startedHere && owned) { try { await this.stop(); } catch { vmFail("vm_stop_unconfirmed"); } }
      throw error;
    }
    let docker = false;
    if (fresh && options.lease) {
      guard();
      // Lease expiry is judged by the proxy's own wall clock, like work-session leases.
      const lease = options.lease(`provision_${randomBytes(16).toString("hex")}`, Date.now() + 1_800_000);
      try {
        const proxy = lease.environment.HTTPS_PROXY ?? "";
        const out = await this.guest(transport, ["sudo", "-n", "python3", "-I", "-c", dockerProvisioning], { timeoutMs: 1_800_000, input: Buffer.from(JSON.stringify({ proxy })), ...(options.signal ? { signal: options.signal } : {}) });
        docker = out.trim() === "jit-docker-ready-v1";
      } catch { docker = false; } finally { lease.close(); }
    }
    // DESK16-01 (#454): after cloud-init the desktop session is installed (if missing) and the lease is issued again,
    // since the boot's first delivery can run before the guest has the session's group.
    if (this.host.desktop && this.host.desktopLease && !this.#desktopLease) {
      guard();
      this.#desktopInstallTried = false;
      await this.desktopTurn(() => this.openDesktopLease(options.signal, options.lease ?? this.host.provisionLease));
    }
    return { docker };
  }
}

/** Lifetime of the desktop lease between renewals, and the renewal period (DESK16-01). */
const desktopLeaseMs = 1_800_000, desktopLeaseRenewMs = 600_000;
const repeat = (beat: () => void, milliseconds: number) => { const timer = setInterval(beat, milliseconds); timer.unref?.(); return () => clearInterval(timer); };
/**
 * Fixed guest program (DESK16-01): writes the desktop lease read from stdin to `/etc/jit-desktop/proxy.env`, mode
 * 0640, owner root, group `jit-desktop` (the desktop session's unprivileged user), replacing it atomically. A guest
 * whose desktop session is not completely installed at the pinned version (no `/opt/jit-desktop/ready-v1` naming
 * it, which the installer writes last) or has no such group gets nothing written and reports it absent, so a
 * partial or outdated install is installed again. The file is an environment file for the desktop session's unit.
 */
export const qemuDesktopLeaseWriter = `import grp,json,os,stat,sys
a=json.loads(sys.stdin.read(4096));p,v=a['proxy'],a['version']
if not p.startswith('http://') or any(c in p for c in '\\n\\r\\0 "$\\'\\\\'):print('jit-desktop-lease-invalid-v1');sys.exit(0)
try:r=open('/opt/jit-desktop/ready-v1').read().strip()==v
except OSError:r=False
if not r:print('jit-desktop-absent-v1');sys.exit(0)
try:g=grp.getgrnam('jit-desktop').gr_gid
except KeyError:print('jit-desktop-absent-v1');sys.exit(0)
d='/etc/jit-desktop'
os.makedirs(d,mode=0o755,exist_ok=True)
s=os.lstat(d)
if not stat.S_ISDIR(s.st_mode) or s.st_uid!=0 or s.st_mode&0o022:print('jit-desktop-unsafe-v1');sys.exit(0)
t=d+'/.proxy.env.new'
try:os.unlink(t)
except FileNotFoundError:pass
f=os.open(t,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
os.fchown(f,0,g);os.fchmod(f,0o640)
os.write(f,''.join(k+'='+p+'\\n' for k in ('HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy')).encode())
os.fsync(f);os.close(f);os.rename(t,d+'/proxy.env')
print('jit-desktop-lease-v1')
`;
/**
 * DESK16-01 (ADR 0091 decision 6): the pinned desktop browser, Chrome for Testing (Google's version-pinned Chromium
 * build, no auto-update) for both guest architectures. The SHA-256 of each archive was recorded from the published
 * file; the guest refuses any other bytes. Changing the pin is a one-line reviewed change.
 */
export const qemuDesktopBrowser = Object.freeze({
  version: "157.0.8103.50",
  x86_64: Object.freeze({ url: "https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.50/linux64/chrome-linux64.zip",
    sha256: "d17167bc092eb495a3b768c7467f27e35f625aa03834233a1663af67dcb668c9" }),
  aarch64: Object.freeze({ url: "https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.50/linux-arm64/chrome-linux-arm64.zip",
    sha256: "9539c1612121eb09c4b787f4f9d0c732357772eb22583620ffed64d50dd6c4cc" }),
});
/**
 * Fixed guest program (DESK16-01, ADR 0091 decisions 1, 6), idempotent. Reads `{proxy, url, sha256, version}` from
 * stdin (a bounded provisioning lease and the pin above) and, as root:
 * - creates the unprivileged system user and group `jit-desktop` (no sudo, home `/var/lib/jit-desktop`);
 * - unless this pinned version is already installed: downloads the archive through the lease, refuses it unless its
 *   SHA-256 matches, unpacks it to `/opt/jit-desktop/chrome-<version>`, then installs its `deb.deps` and Xorg (the
 *   modesetting driver), libinput, xinit, fluxbox and fonts from Ubuntu's archive; older pinned versions are removed;
 * - writes the Xorg screen (1280×800), an AppArmor profile that lets only that browser use user namespaces (its
 *   sandbox stays on), the loopback proxy forwarder and the session script;
 * - enables `jit-desktop-proxy.service` (127.0.0.1:3129 → the guest-forwarded proxy, adding `Proxy-Authorization`
 *   from `/etc/jit-desktop/proxy.env` read per connection, since Chromium takes no credentials in a proxy URL) and
 *   `jit-desktop.service` (Xorg + fluxbox + the browser on vt7 as `jit-desktop`; the browser restarts if it exits).
 * Prints `jit-desktop-ready-v1` and writes `/opt/jit-desktop/ready-v1` (the version; removed when an install starts)
 * only when every step succeeded and both units and the pinned browser have stayed up for three checks in a row.
 */
export const qemuDesktopProvisioning = String.raw`import hashlib,json,os,pwd,re,shutil,subprocess,sys,time,zipfile
a=json.loads(sys.stdin.read(8192))
p,u,h,v=a['proxy'],a['url'],a['sha256'],a['version']
if not p.startswith('http://') or not u.startswith('https://') or len(h)!=64 or not all(c in '0123456789abcdef' for c in h) or not all(c.isdigit() or c=='.' for c in v):print('jit-desktop-invalid-v1');sys.exit(0)
env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','DEBIAN_FRONTEND':'noninteractive','http_proxy':p,'https_proxy':p,'HTTP_PROXY':p,'HTTPS_PROXY':p}
q={'stdout':subprocess.DEVNULL,'stderr':subprocess.DEVNULL,'env':env,'check':True}
R='/opt/jit-desktop';B=R+'/chrome-'+v;L='/usr/local/lib/jit-desktop'
def put(f,s,m=0o644):
 os.makedirs(os.path.dirname(f),mode=0o755,exist_ok=True)
 t=f+'.jit-new'
 with open(t,'w') as o:o.write(s)
 os.chmod(t,m);os.rename(t,f)
FORWARD=r'''import base64,os,socket,threading,urllib.parse
E='/etc/jit-desktop/proxy.env';U=('192.168.5.100',3128);S=threading.BoundedSemaphore(64)
def auth():
 try:
  for l in open(E):
   if l.startswith('HTTPS_PROXY='):
    u=urllib.parse.urlsplit(l.strip()[12:])
    if u.scheme=='http' and u.hostname==U[0] and u.port==U[1] and u.username and u.password:return b'Basic '+base64.b64encode((urllib.parse.unquote(u.username)+':'+urllib.parse.unquote(u.password)).encode())
 except (OSError,ValueError):pass
def pipe(a,b):
 try:
  while True:
   d=a.recv(65536)
   if not d:break
   b.sendall(d)
 except OSError:pass
 for s in (a,b):
  try:s.shutdown(socket.SHUT_RDWR)
  except OSError:pass
def serve(c):
 r=None
 try:
  c.settimeout(30);h=b''
  while b'\r\n\r\n' not in h:
   d=c.recv(8192)
   if not d or len(h)>16384:return
   h+=d
  head,rest=h.split(b'\r\n\r\n',1);lines=head.split(b'\r\n');k=auth()
  if not k:c.sendall(b'HTTP/1.1 503 No desktop lease\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return
  lines=[lines[0]]+[l for l in lines[1:] if not l.lower().startswith((b'proxy-authorization:',b'proxy-connection:'))]+[b'Proxy-Authorization: '+k]
  r=socket.create_connection(U,timeout=30);r.sendall(b'\r\n'.join(lines)+b'\r\n\r\n'+rest);c.settimeout(None);r.settimeout(None)
  t=threading.Thread(target=pipe,args=(r,c),daemon=True);t.start();pipe(c,r);t.join()
 except OSError:pass
 finally:
  c.close()
  if r:r.close()
  S.release()
l=socket.socket();l.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);l.bind(('127.0.0.1',3129));l.listen(128)
while True:
 c,_=l.accept();S.acquire();threading.Thread(target=serve,args=(c,),daemon=True).start()
'''
SESSION=r'''#!/bin/sh
xset s off -dpms
fluxbox &
while :; do
 @B@/chrome --user-data-dir=/var/lib/jit-desktop/profile --proxy-server=http://127.0.0.1:3129 --no-first-run --no-default-browser-check --password-store=basic --disable-background-networking --window-position=0,0 --window-size=1280,800 --start-maximized
 sleep 2
done
'''
DESKTOP='''[Unit]
Description=Jit desktop session (DESK16-01)
After=systemd-user-sessions.service jit-desktop-proxy.service
Wants=jit-desktop-proxy.service
Conflicts=getty@tty7.service
[Service]
User=jit-desktop
PAMName=login
TTYPath=/dev/tty7
StandardInput=tty
StandardOutput=journal
StandardError=journal
UtmpIdentifier=tty7
UtmpMode=user
WorkingDirectory=/var/lib/jit-desktop
ExecStartPre=+/usr/bin/chvt 7
ExecStart=/usr/bin/xinit /usr/local/lib/jit-desktop/session -- /usr/bin/Xorg :0 vt7 -keeptty -novtswitch -nolisten tcp
Restart=always
RestartSec=2
[Install]
WantedBy=multi-user.target
'''
PROXY='''[Unit]
Description=Jit desktop browser proxy forwarder (DESK16-01)
[Service]
User=jit-desktop
ExecStart=/usr/bin/python3 -I /usr/local/lib/jit-desktop/proxy-forward.py
Restart=always
RestartSec=2
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
[Install]
WantedBy=multi-user.target
'''
XORG='''Section "Device"
 Identifier "jit-virtio"
 Driver "modesetting"
EndSection
Section "Screen"
 Identifier "jit-screen"
 Device "jit-virtio"
 SubSection "Display"
  Modes "1280x800"
 EndSubSection
EndSection
'''
ARMOR='''abi <abi/4.0>,
include <tunables/global>
profile jit-desktop-chrome /opt/jit-desktop/chrome-*/chrome flags=(unconfined) {
 userns,
}
'''
try:
 # The completion marker goes first and is written last, so a partial install never counts as installed.
 try:os.unlink(R+'/ready-v1')
 except FileNotFoundError:pass
 subprocess.run(['groupadd','--system','-f','jit-desktop'],**q)
 try:pwd.getpwnam('jit-desktop')
 except KeyError:subprocess.run(['useradd','--system','--gid','jit-desktop','--groups','video,input,render','--home-dir','/var/lib/jit-desktop','--create-home','--shell','/usr/sbin/nologin','jit-desktop'],**q)
 if not os.path.isfile(B+'/chrome'):
  os.makedirs(R,mode=0o755,exist_ok=True);z=R+'/chrome.zip';n=B+'.new'
  subprocess.run(['curl','-fsSL','--proto','=https','--max-filesize','314572800','--max-time','1500','-o',z,u],**q)
  d=hashlib.sha256()
  with open(z,'rb') as f:
   for c in iter(lambda:f.read(1048576),b''):d.update(c)
  if d.hexdigest()!=h:os.unlink(z);print('jit-desktop-unverified-v1');sys.exit(0)
  shutil.rmtree(n,ignore_errors=True);os.makedirs(n,mode=0o755)
  with zipfile.ZipFile(z) as f:
   for i in f.infolist():
    r=i.filename.split('/',1)[1] if '/' in i.filename else ''
    if not r or r.endswith('/'):continue
    if r.startswith('/') or '..' in r.split('/'):print('jit-desktop-unverified-v1');sys.exit(0)
    t=os.path.join(n,r);os.makedirs(os.path.dirname(t),mode=0o755,exist_ok=True)
    with f.open(i) as s,open(t,'wb') as o:shutil.copyfileobj(s,o)
    os.chmod(t,0o755 if (i.external_attr>>16)&0o111 else 0o644)
  deps=[l.strip() for l in open(n+'/deb.deps') if l.strip()]
  subprocess.run(['apt-get','-q','update'],timeout=900,**q)
  subprocess.run(['apt-get','-q','-y','--no-install-recommends','satisfy',', '.join(deps)],timeout=1200,**q)
  subprocess.run(['apt-get','-q','-y','--no-install-recommends','install','xserver-xorg-core','xserver-xorg-input-libinput','xinit','x11-xserver-utils','fluxbox','fonts-dejavu-core','fonts-thai-tlwg','apparmor'],timeout=1200,**q)
  os.rename(n,B);os.unlink(z)
 for o in os.listdir(R):
  if o.startswith('chrome-') and R+'/'+o!=B:shutil.rmtree(R+'/'+o,ignore_errors=True)
 put(L+'/proxy-forward.py',FORWARD);put(L+'/session',SESSION.replace('@B@',B),0o755)
 put('/etc/X11/xorg.conf.d/10-jit-desktop.conf',XORG);put('/etc/apparmor.d/jit-desktop-chrome',ARMOR)
 put('/etc/systemd/system/jit-desktop.service',DESKTOP);put('/etc/systemd/system/jit-desktop-proxy.service',PROXY)
 subprocess.run(['apparmor_parser','-r','/etc/apparmor.d/jit-desktop-chrome'],timeout=120,**{**q,'check':False})
 subprocess.run(['systemctl','daemon-reload'],timeout=120,**q)
 subprocess.run(['systemctl','enable','--now','jit-desktop-proxy.service','jit-desktop.service'],timeout=120,**q)
 # Installed means running: both units active and the pinned browser up as jit-desktop on three checks in a row.
 k=0
 for _ in range(60):
  up=subprocess.run(['systemctl','is-active','--quiet','jit-desktop-proxy.service','jit-desktop.service'],timeout=30,**{**q,'check':False}).returncode==0 and subprocess.run(['pgrep','-u','jit-desktop','-f','^'+re.escape(B+'/chrome')+'( |$)'],timeout=30,**{**q,'check':False}).returncode==0
  k=k+1 if up else 0
  if k>=3:break
  time.sleep(2)
 if k<3:print('jit-desktop-missing-v1');sys.exit(0)
 os.makedirs(R,mode=0o755,exist_ok=True);put(R+'/ready-v1',v+'\n')
 print('jit-desktop-ready-v1')
except (OSError,ValueError,KeyError,zipfile.BadZipFile,subprocess.SubprocessError):print('jit-desktop-missing-v1')
`;
/** Fixed guest program: installs Ubuntu's `docker.io` through the bounded provisioning proxy lease read from stdin. */
const dockerProvisioning = `import json,subprocess,sys
p=json.loads(sys.stdin.read(4096))['proxy']
env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','DEBIAN_FRONTEND':'noninteractive','http_proxy':p,'https_proxy':p,'HTTP_PROXY':p,'HTTPS_PROXY':p}
q={'stdout':subprocess.DEVNULL,'stderr':subprocess.DEVNULL,'env':env,'check':True}
try:
 subprocess.run(['apt-get','-q','update'],timeout=900,**q)
 subprocess.run(['apt-get','-q','-y','--no-install-recommends','install','docker.io'],timeout=1200,**q)
 subprocess.run(['systemctl','enable','--now','docker.service'],timeout=120,**q)
 subprocess.run(['/usr/bin/docker','version','--format','{{.Server.Version}}'],timeout=60,**q)
 print('jit-docker-ready-v1')
except (OSError,subprocess.SubprocessError):print('jit-docker-missing-v1')
`;
