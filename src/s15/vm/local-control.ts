import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Socket } from "node:net";
import { startVmRegistryProxy, type VmProxyLease, type VmProxyLog } from "./proxy";
import { qemuGuestNetwork, qemuStateDirectoryMax, type QemuHostOptions } from "./qemu";
import type { VmStore } from "./store";
import { vmFail } from "./validation";

/** Trusted composition input for Jit-managed local VMs; seams exist for deterministic tests only. */
export interface LocalVmControlOptions extends Omit<QemuHostOptions, "proxySocket"> {
  /** Destination-only proxy metadata sink (session, host, byte counts). */
  proxyLog?: (entry: VmProxyLog) => void;
  resolve?: (host: string) => Promise<readonly { address: string; family: number }[]>;
  connect?: (address: string, port: number) => Socket;
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
  const proxySocket = join(options.directory, "proxy.sock");
  const { proxyLog, resolve, connect, ...host } = options;
  const proxy = await startVmRegistryProxy({ hostname: "127.0.0.1", port: 0, socketPath: proxySocket, guestHostname: qemuGuestNetwork.proxy, guestPort: qemuGuestNetwork.proxyPort,
    ...(saved ? { hosts: JSON.parse(saved.data) as string[] } : {}), log: proxyLog ?? (() => {}), ...(resolve ? { resolve } : {}), ...(connect ? { connect } : {}) });
  return { host: { ...host, proxySocket }, lease: (sessionId, expiresAt, authorize) => proxy.lease(sessionId, expiresAt, authorize), setHosts: hosts => proxy.setHosts(hosts), close: () => proxy.close() };
}
