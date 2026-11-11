import { lstatSync, mkdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";
import { startVmRegistryProxy, type VmProxyLease, type VmProxyLog } from "./proxy";
import { qemuGuestNetwork, qemuStateDirectoryMax, type QemuHostOptions } from "./qemu";
import type { VmStore } from "./store";
import { vmFail } from "./validation";
import { validateVmm, vmmHostProbe, vmmLayout, type QemuVmmOptions } from "./vmm";

/**
 * Verifies the installer-made shared hypervisor layout (VM15-03) before anything is created in it: the root is
 * a real directory nobody but its owner can write; `control/` and `control/images/` belong to this controller,
 * are setgid and group-readable but not group- or world-writable; `machines/` (the QEMU identity's) is a real directory that is not world-writable. The controller
 * never writes below `machines/`; it only connects to QMP and stats files there. Anything else is refused, never
 * repaired, because a writable or replaced parent would let another identity redirect controller writes.
 */
export function assertVmmLayout(vmm: QemuVmmOptions): void {
  validateVmm(vmm);
  const layout = vmmLayout(vmm.directory), uid = process.getuid?.();
  const check = (path: string, test: (stat: Stats) => boolean) => {
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink() || !test(stat)) vmFail("vm_key_directory_unsafe");
  };
  check(vmm.directory, stat => !(stat.mode & 0o022));
  // setgid 2750: new images and the path-bound proxy socket inherit the shared group (the unit cannot set it).
  check(layout.control, stat => stat.uid === uid && (stat.mode & 0o2777) === 0o2750);
  check(layout.images, stat => stat.uid === uid && (stat.mode & 0o2777) === 0o2750);
  check(layout.machines, stat => !(stat.mode & 0o002));
}

/** Trusted composition input for Jit-managed local VMs; seams exist for deterministic tests only. */
export interface LocalVmControlOptions extends Omit<QemuHostOptions, "proxySocket"> {
  /** Destination-only proxy metadata sink (session, host, byte counts). */
  proxyLog?: (entry: VmProxyLog) => void;
  /** AUTH16-01: let the guest reach public DNS names through the proxy (default true; ADR 0084 residual). */
  publicWeb?: boolean;
  resolve?: (host: string) => Promise<readonly { address: string; family: number }[]>;
  connect?: (address: string, port: number) => Socket;
  /** Listening socket for the shared layout's proxy path, inherited from the installer's socket unit (VM15-03). */
  proxySocketFd?: number;
  /**
   * DESK16-01 (ADR 0091 decision 5): hosts the desktop browser lease refuses before DNS (composition passes the
   * sensitive-only site rule). Required when `desktop` is on, so a desktop lease never exists without its filter.
   */
  desktopDeny?: (host: string) => boolean;
}
/** Composed protected local-VM control: manager host options, the registry proxy's leases and its host settings. */
export interface LocalVmControl {
  host: QemuHostOptions;
  lease(sessionId: string, expiresAt: number, authorize?: (host: string) => void): VmProxyLease;
  setHosts(hosts: readonly string[]): void;
  close(): Promise<void>;
}
/**
 * Starts the protected registry proxy on a controller-only Unix socket inside the local-VM directory (at most
 * `qemuStateDirectoryMax` characters, so socket paths fit the Unix limit). The
 * guest reaches it only through the QEMU guest-forward to `192.168.5.100:3128`; the socket path is stable
 * across controller restarts so a surviving VM's forward keeps working. The owner's persisted registry
 * list (if any) is applied; leases are per-session and inject no upstream credential.
 */
export async function startLocalVmControl(store: VmStore, options: LocalVmControlOptions): Promise<LocalVmControl> {
  if (!options.directory.startsWith("/") || options.directory.length > qemuStateDirectoryMax) vmFail("vm_state_path_too_long");
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(options.directory); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) vmFail("vm_key_directory_unsafe");
  store.db.exec("CREATE TABLE IF NOT EXISTS vm_settings (id TEXT PRIMARY KEY,data TEXT NOT NULL)");
  const saved = store.db.query<{ data: string }, []>("SELECT data FROM vm_settings WHERE id='registry-hosts'").get();
  // VM15-03: the guest-forward helper runs as the separate QEMU identity, so the socket lives in the shared
  // controller-owned `control/` directory, group-connectable (0660) by that identity only.
  if (options.vmm) assertVmmLayout(options.vmm);
  const proxySocket = options.vmm ? vmmLayout(options.vmm.directory).proxySocket : join(options.directory, "proxy.sock");
  // AUTH16-01 (ADR 0084, S16-D09): the working VM browser reaches the public web by default (recorded residual).
  const { proxyLog, resolve, connect, proxySocketFd, publicWeb, desktopDeny, ...host } = options;
  if (proxySocketFd !== undefined && !options.vmm) vmFail("vm_invalid_setup");
  if (host.desktop && typeof desktopDeny !== "function") vmFail("vm_invalid_setup");
  const proxy = await startVmRegistryProxy({ hostname: "127.0.0.1", port: 0, socketPath: proxySocket, socketMode: options.vmm ? 0o660 : 0o600, ...(proxySocketFd !== undefined ? { socketFd: proxySocketFd } : {}), guestHostname: qemuGuestNetwork.proxy, guestPort: qemuGuestNetwork.proxyPort,
    ...(saved ? { hosts: JSON.parse(saved.data) as string[] } : {}), publicWeb: publicWeb ?? true, log: proxyLog ?? (() => {}), ...(resolve ? { resolve } : {}), ...(connect ? { connect } : {}) });
  // `/dev/kvm` readiness is the QEMU identity's access, probed through its launcher, never the controller's.
  const probe = host.probe ?? (options.vmm ? vmmHostProbe(options.vmm) : undefined);
  // DESK16-01: the desktop browser's standing lease always carries the sensitive-host filter (ADR 0091 decisions 2, 5).
  const desktopLease = host.desktop && desktopDeny ? (sessionId: string, expiresAt: number) => proxy.lease(sessionId, expiresAt, undefined, { deny: desktopDeny }) : undefined;
  // A desktop VM enrolled before `desktop` was on gets its session installed from the beat through a bounded
  // provisioning lease, the same unfiltered kind as the Docker install (ADR 0091 decisions 1, 6).
  const provisionLease = desktopLease ? (sessionId: string, expiresAt: number) => proxy.lease(sessionId, expiresAt) : undefined;
  return { host: { ...host, proxySocket, ...(probe ? { probe } : {}), ...(desktopLease ? { desktopLease } : {}), ...(provisionLease ? { provisionLease } : {}) }, lease: (sessionId, expiresAt, authorize) => proxy.lease(sessionId, expiresAt, authorize), setHosts: hosts => proxy.setHosts(hosts), close: () => proxy.close() };
}
