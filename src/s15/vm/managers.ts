import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { ConnectionVault } from "../../exec/connections";
import { registerSecretFingerprint } from "../../security/secret-fingerprints";
import { defaultLocalVmResources, privateLocalVmResources, detectLocalVmHost, localVmHostProbe, validateLocalVmResources, type LocalVmHostFacts, type LocalVmResources } from "./local";
import { LimaVmManagement, ProxmoxVmManagement } from "./management";
import { QemuVmManagement, type QemuHostOptions, type QemuVmIdentity } from "./qemu";
import type { VmStore } from "./store";
import type { VmManagement } from "./types";
import { vmFail, vmId, vmRecord } from "./validation";
import { FirecrackerVmManagement, type FirecrackerClientOptions } from "./firecracker/client";

/**
 * Write-only protected management setup. Proxmox tokens are stored only in the mode/ownership-safe vault.
 * `qemu` creates the Jit-managed nested KVM working VM on this controller; it carries no input and no secret.
 */
export type VmManagerInput = { kind: "lima"; instance: string } | {
  kind: "proxmox"; baseUrl: string; node: string; vmid: number; token: string; proxy: { address: string; port: number };
} | { kind: "qemu" } | { kind: "firecracker"; origin: string; computerId: string; selectionSha256: string; token: string };
type FirecrackerManager = Omit<Extract<VmManagerInput, { kind: "firecracker" }>, "token">;
type StoredManager = Exclude<VmManagerInput, { kind: "proxmox" | "qemu" | "firecracker" }> | Omit<Extract<VmManagerInput, { kind: "proxmox" }>, "token"> | FirecrackerManager | ({ kind: "qemu"; /** TEAM16-01: the private member this local VM was created for; absent for the default. */ forVm?: string } & QemuVmIdentity);
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
  /** Local managers created for a TEAM16-01 private member, by manager id. */
  readonly #privateLocal = new Map<string, string>();
  constructor(readonly options: { store: VmStore; vault: ConnectionVault; requireOwner: (actor: object) => void;
    limaEnvironment?: Readonly<Record<string, string>>; fetch?: typeof fetch;
    /** Protected controller metadata location; no directory/journal is created until explicit registration. */
    firecracker?: { directory: string; installationId: string; fixture?: FirecrackerClientOptions['fixture'] };
    /** Trusted local-VM host configuration; absent means this controller does not create local VMs. */
    local?: QemuHostOptions & { port?: () => number } }) {
    super();
    options.store.db.exec("CREATE TABLE IF NOT EXISTS vm_managers (id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS vm_settings (id TEXT PRIMARY KEY,data TEXT NOT NULL)");
    try { for (const row of options.store.db.query<{ id: string; data: string }, []>("SELECT id,data FROM vm_managers").all()) this.load(row.id, JSON.parse(row.data)); }
    catch (error) { this.close(); throw error; }
  }
  private load(id: string, input: StoredManager): VmManagement | null {
    if (input.kind === "firecracker") { const manager = this.firecracker(id, input, false); this.set(id, manager); return manager; }
    if (input.kind === "qemu") {
      // A persisted local VM needs this controller's protected host configuration; without it no adapter is installed.
      if (!this.options.local) return null;
      const { kind: _kind, forVm, ...identity } = input, manager = new QemuVmManagement(identity, this.options.local);
      if (forVm) this.#privateLocal.set(id, forVm);
      this.set(id, manager); return manager;
    }
    const manager = input.kind === "lima" ? new LimaVmManagement({ instance: input.instance, ...(this.options.limaEnvironment ? { env: this.options.limaEnvironment } : {}) }) :
      new ProxmoxVmManagement({ ...input, token: () => { const value = this.options.vault.read(id); registerSecretFingerprint(value); return value; }, ...(this.options.fetch ? { fetch: this.options.fetch } : {}) });
    this.set(id, manager); return manager;
  }
  private firecracker(id: string, input: FirecrackerManager, create: boolean): FirecrackerVmManagement {
    const config = this.options.firecracker; if (!config || !isAbsolute(config.directory) || normalize(config.directory) !== config.directory) vmFail("vm_management_unavailable", 503); vmId(id);
    if (create) mkdirSync(config.directory, { recursive: true, mode: 0o700 });
    const directory = lstatSync(config.directory); if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077 || process.getuid && directory.uid !== process.getuid()) vmFail("vm_management_unavailable", 503);
    return new FirecrackerVmManagement({ path: join(config.directory, `${id}.sqlite`), create, installationId: config.installationId, origin: input.origin, computerId: input.computerId, selectionSha256: input.selectionSha256,
      credential: () => this.options.vault.read(id), ...(this.options.fetch ? { fetch: this.options.fetch } : {}), ...(config.fixture ? { fixture: config.fixture } : {}) });
  }
  private registerFirecracker(actor: object, input: Extract<VmManagerInput, { kind: "firecracker" }>): { managerId: string } {
    vmRecord(input, ["kind", "origin", "computerId", "selectionSha256", "token"]);
    if (typeof input.token !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(input.token)) vmFail("vm_invalid_setup");
    const { token, ...data } = input;
    for (const row of this.options.store.db.query<{ id: string; data: string }, []>("SELECT id,data FROM vm_managers").all()) {
      const existing = JSON.parse(row.data) as StoredManager;
      if (existing.kind === "firecracker" && existing.computerId === input.computerId) {
        if (existing.origin !== data.origin || existing.selectionSha256 !== data.selectionSha256) vmFail("vm_management_scope_denied");
        // The authenticated owner's exact same binding can update its write-only credential, never
        // create a second enrollment alias or retarget pending original client intents.
        this.options.requireOwner(actor); this.options.vault.write(row.id, token); registerSecretFingerprint(token); return { managerId: row.id };
      }
    }
    if (this.size >= 64) vmFail("vm_setup_capacity"); const id = crypto.randomUUID(), manager = this.firecracker(id, data, true);
    try {
      this.options.requireOwner(actor); this.options.vault.write(id, token); registerSecretFingerprint(token);
      this.options.store.transaction(() => { this.options.requireOwner(actor); this.options.store.db.query("INSERT INTO vm_managers VALUES (?,?)").run(id, JSON.stringify(data)); });
      this.set(id, manager); return { managerId: id };
    } catch (error) { manager.close(); this.options.vault.remove(id); throw error; }
  }
  /** Starts only an explicitly prepared, not-yet-enrolled microVM for its ordinary SSH/key checks. */
  async startPrepared(actor: object, managerId: string): Promise<void> {
    this.options.requireOwner(actor); vmId(managerId); const manager = this.get(managerId);
    if (!(manager instanceof FirecrackerVmManagement)) vmFail("vm_management_unavailable");
    if (this.options.store.db.query<{ data: string }, []>("SELECT data FROM vm_registry").all().some(row => JSON.parse(row.data).managerId === managerId)) vmFail("vm_already_enrolled");
    await manager.start(); this.options.requireOwner(actor); if ((await manager.inspect()).state !== "running") vmFail("vm_management_unavailable"); this.options.requireOwner(actor);
  }
  /** Profile capability, not an isolation certificate or automatic root installation. */
  isPreparedFirecracker(managerId: string): boolean { return this.get(managerId) instanceof FirecrackerVmManagement; }
  /** Whether the prepared adapter must check an original client intent before any new action. */
  pendingFirecracker(managerId: string): boolean { const manager = this.get(managerId); return manager instanceof FirecrackerVmManagement && manager.pending(); }
  /** Owner's last registered binding, used only while it remains unbound; never changes existing work affinity. */
  unbound(predicate: (managerId: string) => boolean): string | null {
    const selected = this.options.store.db.query<{ data: string }, []>("SELECT data FROM vm_settings WHERE id='manager-selection'").get();
    if (selected) { const id: unknown = JSON.parse(selected.data); if (typeof id === 'string' && this.has(id) && predicate(id)) return id; }
    for (const [id] of this) if (predicate(id)) return id; return null;
  }
  private select(actor: object, managerId: string): void {
    this.options.store.transaction(() => { this.options.requireOwner(actor); this.options.store.db.query("INSERT INTO vm_settings VALUES ('manager-selection',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(managerId)); });
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
    if (input.kind === "firecracker") { const result = this.registerFirecracker(actor, input); this.select(actor, result.managerId); return result; }
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
      // One Jit-created working VM per controller: the pool's default member. Extra compute is owner-supplied.
      if (this.localManagerId()) vmFail("vm_already_enrolled");
      return { managerId: this.createLocal() };
    } else vmFail("vm_invalid_setup");
    this.select(actor, id); return { managerId: id };
  }
  /** Id of this controller's Jit-created local VM manager, if one is registered. */
  localManagerId(): string | null {
    for (const [id, manager] of this) if (manager instanceof QemuVmManagement && !this.#privateLocal.has(id)) return id;
    return null;
  }
  /** Whether this controller can create local VMs at all. */
  get canCreateLocal(): boolean { return !!this.options.local; }
  /**
   * TEAM16-01 protected setup-job entry point for one private member: returns the local VM manager created
   * for exactly `vmId`, registering it (smaller private sizing, its own name/MAC/port/disk) only when absent,
   * so a resumed job never creates a second machine. Trusted composition calls it; it is not an owner API.
   */
  ensureLocalFor(forVmId: string): string {
    vmId(forVmId);
    for (const [id, forVm] of this.#privateLocal) if (forVm === forVmId) return id;
    return this.createLocal(forVmId);
  }
  /**
   * Protected setup-job entry point (SETUP15-01): returns this controller's single local VM manager,
   * registering it with the default sizing rule only when none exists, so a resumed job never creates a
   * second one. Trusted composition calls it; it is not an owner API and takes no input.
   */
  ensureLocal(): string {
    return this.localManagerId() ?? this.createLocal();
  }
  private createLocal(forVm?: string): string {
    if (!this.options.local) vmFail("vm_management_unavailable", 503);
    if (this.size >= 64) vmFail("vm_setup_capacity");
    const host = this.localHost();
    if (!host.kvm || !host.qemu || !host.architecture) vmFail("vm_host_unsupported", 422);
    const id = crypto.randomUUID(), resources = forVm ? privateLocalVmResources(host) : defaultLocalVmResources(host), mac = `52:54:00:${[...randomBytes(3)].map(b => b.toString(16).padStart(2, "0")).join(":")}`;
    const data = { kind: "qemu" as const, name: `jit-work-${randomBytes(6).toString("hex")}`, architecture: host.architecture, mac, sshPort: this.options.local.port?.() ?? pickLoopbackPort(), resources, ...(forVm ? { forVm } : {}) };
    this.load(id, data); this.options.store.db.query("INSERT INTO vm_managers VALUES (?,?)").run(id, JSON.stringify(data));
    return id;
  }
  /** Closes private controller journals only; root helpers and original unknown native effects remain. */
  close(): void { for (const manager of this.values()) if (manager instanceof FirecrackerVmManagement) manager.close(); }
}
