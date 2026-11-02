import { ConnectionVault } from "../../exec/connections";
import { registerSecretFingerprint } from "../../security/secret-fingerprints";
import { LimaVmManagement, ProxmoxVmManagement } from "./management";
import type { VmStore } from "./store";
import type { VmManagement } from "./types";
import { vmFail, vmId, vmRecord } from "./validation";

/** Write-only protected management setup. Proxmox tokens are stored only in the mode/ownership-safe vault. */
export type VmManagerInput = { kind: "lima"; instance: string } | {
  kind: "proxmox"; baseUrl: string; node: string; vmid: number; token: string; proxy: { address: string; port: number };
};
/** Persistent adapter registry. VM/model APIs receive opaque IDs, never a token, endpoint or management object. */
export class VmManagers extends Map<string, VmManagement> {
  constructor(readonly options: { store: VmStore; vault: ConnectionVault; requireOwner: (actor: object) => void;
    limaEnvironment?: Readonly<Record<string, string>>; fetch?: typeof fetch }) {
    super();
    options.store.db.exec("CREATE TABLE IF NOT EXISTS vm_managers (id TEXT PRIMARY KEY,data TEXT NOT NULL)");
    for (const row of options.store.db.query<{ id: string; data: string }, []>("SELECT id,data FROM vm_managers").all()) this.load(row.id, JSON.parse(row.data));
  }
  private load(id: string, input: Exclude<VmManagerInput, { kind: "proxmox" }> | Omit<Extract<VmManagerInput, { kind: "proxmox" }>, "token">): VmManagement {
    const manager = input.kind === "lima" ? new LimaVmManagement({ instance: input.instance, ...(this.options.limaEnvironment ? { env: this.options.limaEnvironment } : {}) }) :
      new ProxmoxVmManagement({ ...input, token: () => { const value = this.options.vault.read(id); registerSecretFingerprint(value); return value; }, ...(this.options.fetch ? { fetch: this.options.fetch } : {}) });
    this.set(id, manager); return manager;
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
    } else vmFail("vm_invalid_setup");
    return { managerId: id };
  }
}
