import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { ConnectionVault } from "../../exec/connections";
import { registerSecretFingerprint } from "../../security/secret-fingerprints";
import { defaultLocalVmResources, detectLocalVmHost, localVmHostProbe, validateLocalVmResources, type LocalVmHostFacts, type LocalVmResources } from "./local";
import { LimaVmManagement, ProxmoxVmManagement } from "./management";
import { QemuVmManagement, type QemuHostOptions, type QemuVmIdentity } from "./qemu";
import type { VmStore } from "./store";
import type { VmManagement } from "./types";
import { vmFail, vmId, vmRecord } from "./validation";

/**
 * Write-only protected management setup. Proxmox tokens are stored only in the mode/ownership-safe vault.
 * `qemu` creates the Jit-managed nested KVM working VM on this controller; it carries no input and no secret.
 */
export type VmManagerInput = { kind: "lima"; instance: string } | {
  kind: "proxmox"; baseUrl: string; node: string; vmid: number; token: string; proxy: { address: string; port: number };
} | { kind: "qemu" };
type StoredManager = Exclude<VmManagerInput, { kind: "proxmox" | "qemu" }> | Omit<Extract<VmManagerInput, { kind: "proxmox" }>, "token"> | ({ kind: "qemu" } & QemuVmIdentity);
/** Owner-visible local VM sizing: current values (applied at next start), host defaults and controller-side host facts. */
export interface LocalVmResourceView {
  managerId: string; resources: LocalVmResources; defaults: LocalVmResources | null; appliesAt: "next_start";
  host: { cpus: number; memoryMiB: number; diskFreeGiB: number };
}
/** Picks a free loopback port outside the Linux ephemeral range, so later outgoing sockets rarely collide. */
function pickLoopbackPort(): number {
  for (let attempt = 0; attempt < 64; attempt++) {
    const port = 20000 + randomBytes(2).readUInt16BE(0) % 12000;
    try { const listener = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } }); listener.stop(true); return port; } catch { /* In use; try another. */ }
  }
  vmFail("vm_port_unavailable", 503);
}
/** Persistent adapter registry. VM/model APIs receive opaque IDs, never a token, endpoint or management object. */
export class VmManagers extends Map<string, VmManagement> {
  constructor(readonly options: { store: VmStore; vault: ConnectionVault; requireOwner: (actor: object) => void;
    limaEnvironment?: Readonly<Record<string, string>>; fetch?: typeof fetch;
    /** Trusted local-VM host configuration; absent means this controller does not create local VMs. */
    local?: QemuHostOptions & { port?: () => number } }) {
    super();
    options.store.db.exec("CREATE TABLE IF NOT EXISTS vm_managers (id TEXT PRIMARY KEY,data TEXT NOT NULL)");
    for (const row of options.store.db.query<{ id: string; data: string }, []>("SELECT id,data FROM vm_managers").all()) this.load(row.id, JSON.parse(row.data));
  }
  private load(id: string, input: StoredManager): VmManagement | null {
    if (input.kind === "qemu") {
      // A persisted local VM needs this controller's protected host configuration; without it no adapter is installed.
      if (!this.options.local) return null;
      const { kind: _kind, ...identity } = input, manager = new QemuVmManagement(identity, this.options.local);
      this.set(id, manager); return manager;
    }
    const manager = input.kind === "lima" ? new LimaVmManagement({ instance: input.instance, ...(this.options.limaEnvironment ? { env: this.options.limaEnvironment } : {}) }) :
      new ProxmoxVmManagement({ ...input, token: () => { const value = this.options.vault.read(id); registerSecretFingerprint(value); return value; }, ...(this.options.fetch ? { fetch: this.options.fetch } : {}) });
    this.set(id, manager); return manager;
  }
  private localHost(): LocalVmHostFacts {
    const local = this.options.local; if (!local) vmFail("vm_management_unavailable", 503);
    mkdirSync(local.directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(local.directory); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) vmFail("vm_key_directory_unsafe");
    return detectLocalVmHost(local.directory, local.probe ?? localVmHostProbe);
  }
  private local(managerId: string): QemuVmManagement {
    vmId(managerId); const manager = this.get(managerId);
    if (!(manager instanceof QemuVmManagement)) vmFail("vm_management_unavailable");
    return manager;
  }
  /** Owner-only read of the local VM's resource settings and the host defaults; no hypervisor I/O. */
  resources(actor: object, managerId: string): LocalVmResourceView {
    this.options.requireOwner(actor); const manager = this.local(managerId), host = this.localHost();
    let defaults: LocalVmResources | null = null; try { defaults = defaultLocalVmResources(host); } catch { /* The host is now too small for automatic defaults. */ }
    return { managerId, resources: manager.resources, defaults, appliesAt: "next_start",
      host: { cpus: host.cpus, memoryMiB: Math.floor(host.memoryBytes / 1_048_576), diskFreeGiB: Math.floor(host.diskFreeBytes / 1_073_741_824) } };
  }
  /** Owner edit of CPU/RAM/disk for the next protected start. Disks only grow; a running guest is unchanged. */
  setResources(actor: object, managerId: string, value: unknown): LocalVmResourceView {
    this.options.requireOwner(actor); const manager = this.local(managerId);
    const resources = validateLocalVmResources(this.localHost(), value, manager.resources, manager.appliedDiskGiB);
    this.options.store.transaction(() => {
      this.options.requireOwner(actor);
      const row = this.options.store.db.query<{ data: string }, [string]>("SELECT data FROM vm_managers WHERE id=?").get(managerId);
      if (!row) vmFail("vm_management_unavailable");
      this.options.store.db.query("UPDATE vm_managers SET data=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(row.data), resources }), managerId);
    });
    manager.resources = resources;
    return this.resources(actor, managerId);
  }
  /** Single owner form installs a VM-scoped adapter. No later config file edits or guest credentials are needed. */
  register(actor: object, input: VmManagerInput): { managerId: string } {
    this.options.requireOwner(actor);
    if (!input || typeof input !== "object") vmFail("vm_invalid_setup", 400);
    if (this.size >= 64) vmFail("vm_setup_capacity");
    const id = crypto.randomUUID();
    if (input.kind === "lima") {
      vmRecord(input, ["kind", "instance"]); const data = { kind: "lima" as const, instance: input.instance };
      this.load(id, data); this.options.store.db.query("INSERT INTO vm_managers VALUES (?,?)").run(id, JSON.stringify(data));
    } else if (input.kind === "proxmox") {
      vmRecord(input, ["kind", "baseUrl", "node", "vmid", "token", "proxy"]); vmRecord(input.proxy, ["address", "port"]);
      if (typeof input.token !== "string" || input.token.length < 16 || input.token.length > 4096 || /[\x00-\x20\x7f]/.test(input.token)) vmFail("vm_invalid_setup");
      const { token, ...data } = input;
      // Validate all public arguments before retaining the secret, then write metadata without the secret.
      new ProxmoxVmManagement({ ...data, token: () => token });
      this.options.vault.write(id, token); registerSecretFingerprint(token);
      try { this.options.store.db.query("INSERT INTO vm_managers VALUES (?,?)").run(id, JSON.stringify(data)); this.load(id, data); }
      catch (error) { this.options.vault.remove(id); throw error; }
    } else if (input.kind === "qemu") {
      vmRecord(input, ["kind"]);
      if (!this.options.local) vmFail("vm_management_unavailable", 503);
      // One Jit-created working VM per controller until pooled placement exists.
      if ([...this.values()].some(m => m instanceof QemuVmManagement)) vmFail("vm_already_enrolled");
      const host = this.localHost();
      if (!host.kvm || !host.qemu || !host.architecture) vmFail("vm_host_unsupported", 422);
      const resources = defaultLocalVmResources(host), mac = `52:54:00:${[...randomBytes(3)].map(b => b.toString(16).padStart(2, "0")).join(":")}`;
      const data = { kind: "qemu" as const, name: `jit-work-${randomBytes(6).toString("hex")}`, architecture: host.architecture, mac, sshPort: this.options.local.port?.() ?? pickLoopbackPort(), resources };
      this.load(id, data); this.options.store.db.query("INSERT INTO vm_managers VALUES (?,?)").run(id, JSON.stringify(data));
    } else vmFail("vm_invalid_setup");
    return { managerId: id };
  }
}
