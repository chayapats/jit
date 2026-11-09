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
   * A stopped VM keeps no screen frame (DESK16-01), including after an idle stop.
   */
  async stop(): Promise<void> {
    await this.halt();
    await this.discardFrame();
  }
  private async halt(): Promise<void> {
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
    return { docker };
  }
}

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
