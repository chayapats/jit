import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { VmHostCommand, VmManagement, VmStatus, VmCapability } from "./types";
import { vmHostCommand, vmQuote } from "./host";
import { vmEndpoint, vmFail, vmId, vmInteger } from "./validation";
import { defaultVmRegistryHosts } from "./proxy";
import { VmSshTransport } from "./transport";
import { VmStore, type VmRegistration } from "./store";
import { probeVmDirectEgress } from "./network";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { registerSecretFingerprint } from "../../security/secret-fingerprints";

/** One setup form; all transport settings persist atomically with the registered VM, without later config editing. */
export interface VmEnrollmentInput {
  id: string; setupId: string; host: string; port: number; user: string; hostPublicKey: string;
  managerId?: string; maxSessions?: number;
}
/** Authenticated server/API service. Only trusted composition installs management adapters and owner verification. */
export class VmEnrollment {
  readonly #setups = new Set<string>();
  readonly #checks = new Map<string, { input: Omit<VmEnrollmentInput, "id">; fingerprint: string; expiresAt: number }>();
  constructor(readonly options: { store: VmStore; keyDirectory: string; requireOwner: (actor: object) => void;
    managers: ReadonlyMap<string, VmManagement>; updateRegistryHosts?: (hosts: readonly string[]) => void; run?: VmHostCommand; now?: () => number }) {
    if (!options.keyDirectory.startsWith("/") || resolve(options.keyDirectory) !== options.keyDirectory) vmFail("vm_invalid_setup");
    mkdirSync(options.keyDirectory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(options.keyDirectory); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) vmFail("vm_key_directory_unsafe");
    options.store.db.exec("CREATE TABLE IF NOT EXISTS vm_settings (id TEXT PRIMARY KEY,data TEXT NOT NULL)");
  }
  private capabilities(row: VmRegistration): readonly VmCapability[] {
    const manager = row.managerId !== null && this.options.managers.has(row.managerId);
    const observed = (kind: string) => !!this.options.store.db.query("SELECT sequence FROM vm_events WHERE vm_id=? AND kind=? LIMIT 1").get(row.id, kind);
    return [{ id: "network-isolated", state: row.networkIsolated && row.state === "ready" ? "proven" : "unproven", reason: row.networkIsolated ? null : "vm_network_unproven" },
      { id: "snapshot-recovery", state: manager ? observed("restore") ? "proven" : "unproven" : "unavailable", reason: manager ? null : "vm_recovery_unavailable" },
      { id: "hypervisor-stop", state: manager ? observed("stop") ? "proven" : "unproven" : "unavailable", reason: manager ? null : "vm_recovery_unavailable" }];
  }
  /** Generates a VM-only management key and one console command. The private half is never returned. */
  async begin(actor: object): Promise<{ setupId: string; publicKey: string; command: string }> {
    this.options.requireOwner(actor);
    if (this.#setups.size >= 64) vmFail("vm_setup_capacity");
    const setupId = crypto.randomUUID().replaceAll("-", ""), file = join(this.options.keyDirectory, setupId);
    const result = await (this.options.run ?? vmHostCommand)(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "jit-working-vm", "-f", file], { timeoutMs: 10000, maxBytes: 1024 });
    this.options.requireOwner(actor);
    if (result.exitCode !== 0) vmFail("vm_key_generation_failed", 503);
    chmodSync(file, 0o600); const publicKey = readFileSync(`${file}.pub`, "utf8").trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+ jit-working-vm$/.test(publicKey)) vmFail("vm_key_generation_failed");
    registerSecretFingerprint(readFileSync(file, "utf8")); this.#setups.add(setupId);
    // The command is intentionally public-key-only; no Jit token, socket or service credential enters the VM.
    const command = `install -d -m 700 ~/.ssh && printf '%s\\n' ${vmQuote(`restrict ${publicKey}`)} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && if test -d /etc/cloud/cloud.cfg.d; then printf '%s\\n' 'ssh_deletekeys: false' | sudo -n tee /etc/cloud/cloud.cfg.d/99-jit-working-vm.cfg >/dev/null; fi && sudo -n sync`;
    return { setupId, publicKey, command };
  }
  /** Observes a typed target's public SSH host key. The owner confirms this exact fingerprint at useMachine. */
  async checkMachine(actor: object, input: { setupId: string; host: string; port: number; user: string; managerId?: string }): Promise<{
    checkId: string; address: string; fingerprint: string; transportProfile: "ssh-sudo-systemd/v1";
  }> {
    this.options.requireOwner(actor); vmId(input.setupId);
    if (!this.#setups.has(input.setupId)) vmFail("vm_setup_expired", 400);
    vmEndpoint({ host: input.host, port: input.port, user: input.user, identityFile: "/unused", knownHostsFile: "/unused" });
    const result = await (this.options.run ?? vmHostCommand)(["ssh-keyscan", "-T", "5", "-t", "ed25519", "-p", String(input.port), input.host], { timeoutMs: 10000, maxBytes: 8192 });
    this.options.requireOwner(actor);
    const keys = [...new Set(Buffer.from(result.stdout).toString("utf8").split("\n").filter(line => !line.startsWith("#") && line.trim()).map(line => line.trim().split(/\s+/).slice(1, 3).join(" ")))];
    const hostPublicKey = keys[0];
    if (result.exitCode !== 0 || keys.length !== 1 || !hostPublicKey || !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(hostPublicKey)) vmFail("vm_host_key_invalid", 400);
    const fingerprint = `SHA256:${createHash("sha256").update(Buffer.from(hostPublicKey.split(" ")[1]!, "base64")).digest("base64").replace(/=+$/, "")}`;
    const checkId = crypto.randomUUID().replaceAll("-", "");
    this.#checks.set(checkId, { input: { ...input, hostPublicKey }, fingerprint, expiresAt: (this.options.now ?? Date.now)() + 600000 });
    return { checkId, address: `${input.user}@${input.host}:${input.port}`, fingerprint, transportProfile: "ssh-sudo-systemd/v1" };
  }
  /** Explicit enrollment command binds the typed address, observed fingerprint and supported transport profile. */
  async useMachine(actor: object, input: { id: string; checkId: string; fingerprint: string; transportProfile: "ssh-sudo-systemd/v1"; maxSessions?: number }): Promise<VmStatus> {
    this.options.requireOwner(actor); vmId(input.checkId); const checked = this.#checks.get(input.checkId);
    if (!checked || checked.expiresAt <= (this.options.now ?? Date.now)() || checked.fingerprint !== input.fingerprint || input.transportProfile !== "ssh-sudo-systemd/v1") vmFail("vm_setup_expired", 400);
    const status = await this.complete(actor, { ...checked.input, id: input.id, ...(input.maxSessions === undefined ? {} : { maxSessions: input.maxSessions }) });
    this.#checks.delete(input.checkId); return status;
  }
  /** Verifies SSH/sudo/runtime and external network custody before advertising an execution capability. */
  async complete(actor: object, input: VmEnrollmentInput): Promise<VmStatus> {
    this.options.requireOwner(actor); vmId(input.id); vmId(input.setupId); vmInteger(input.maxSessions ?? 2, 16);
    if (!this.#setups.has(input.setupId)) vmFail("vm_setup_expired", 400);
    if (!/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(input.hostPublicKey)) vmFail("vm_host_key_invalid", 400);
    const identityFile = join(this.options.keyDirectory, input.setupId), knownHostsFile = `${identityFile}.known_hosts`;
    const endpoint = vmEndpoint({ host: input.host, port: input.port, user: input.user, identityFile, knownHostsFile });
    if (input.managerId && !this.options.managers.has(input.managerId)) vmFail("vm_management_unavailable");
    const host = input.port === 22 ? input.host : `[${input.host}]:${input.port}`;
    const knownLine = `${host} ${input.hostPublicKey}\n`;
    const existingKnown = lstatSync(knownHostsFile, { throwIfNoEntry: false });
    if (existingKnown) { if (!existingKnown.isFile() || existingKnown.isSymbolicLink() || readFileSync(knownHostsFile, "utf8") !== knownLine) vmFail("vm_host_key_changed"); }
    else writeFileSync(knownHostsFile, knownLine, { mode: 0o600, flag: "wx" });
    const transport = new VmSshTransport(endpoint, this.options.run ?? vmHostCommand);
    const ready = await transport.control(["sudo", "-n", "python3", "-I", "-c", "import os,subprocess;assert os.getuid()==0;subprocess.run(['systemctl','--version'],check=True,stdout=subprocess.DEVNULL);print('jit-vm-ready-v1')"]);
    if (ready.trim() !== "jit-vm-ready-v1") vmFail("vm_prerequisite_missing", 503);
    const manager = input.managerId ? this.options.managers.get(input.managerId)! : null;
    const machine = manager ? await manager.inspect() : null;
    const directDenied = await probeVmDirectEgress(transport);
    this.options.requireOwner(actor);
    return this.options.store.transaction(() => {
      this.options.requireOwner(actor);
      if (this.options.store.db.query("SELECT id FROM vm_registry WHERE id=?").get(input.id)) vmFail("vm_already_enrolled");
      const networkIsolated = directDenied && !!machine && machine.state === "running" && machine.network !== "unproven";
      const row: VmRegistration = { id: input.id, generation: 1, endpoint, managerId: input.managerId ?? null,
        state: networkIsolated ? "ready" : "unproven", networkCheckedAt: (this.options.now ?? Date.now)(), networkIsolated,
        maxSessions: input.maxSessions ?? 2, reason: networkIsolated ? null : "vm_network_unproven", machineIdentity: machine?.identity ?? null, boot: machine?.boot ?? null };
      this.options.store.save(row); this.#setups.delete(input.setupId);
      return { id: row.id, generation: row.generation, state: row.state, networkIsolated, recoveryAvailable: manager !== null, activeSessions: 0, maxSessions: row.maxSessions, reason: row.reason, capabilities: this.capabilities(row) };
    });
  }
  /** Owner-only status; this query starts no VM/session, returns no credentials or raw endpoints. */
  status(actor: object, id: string): VmStatus {
    this.options.requireOwner(actor); vmId(id); const row = this.options.store.registration(id);
    const count = this.options.store.db.query<{ n: number }, [string]>("SELECT count(*) n FROM vm_sessions WHERE vm_id=? AND state<>'closed'").get(id)!.n;
    return { id, generation: row.generation, state: row.state, networkIsolated: row.networkIsolated,
      recoveryAvailable: row.managerId !== null && this.options.managers.has(row.managerId), activeSessions: count, maxSessions: row.maxSessions, reason: row.reason, capabilities: this.capabilities(row) };
  }
  /** Owner-only exact approved registry settings, persisted outside the guest and ordinary VM recovery. */
  registryHosts(actor: object): readonly string[] {
    this.options.requireOwner(actor); const row = this.options.store.db.query<{ data: string }, []>("SELECT data FROM vm_settings WHERE id='registry-hosts'").get();
    return row ? JSON.parse(row.data) : [...defaultVmRegistryHosts];
  }
  /** An authenticated owner edit changes the destination ceiling, closes old tunnels, and grants no account/effect authority. */
  setRegistryHosts(actor: object, hosts: readonly string[]): readonly string[] {
    this.options.requireOwner(actor);
    if (!Array.isArray(hosts) || !hosts.length || hosts.length > 128 || hosts.some(h => typeof h !== "string" || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(h) || isIP(h)) || new Set(hosts).size !== hosts.length) vmFail("vm_invalid_setup", 400);
    if (!this.options.updateRegistryHosts) vmFail("vm_proxy_unavailable", 503);
    this.options.store.transaction(() => { this.options.requireOwner(actor); this.options.store.db.query("INSERT INTO vm_settings VALUES ('registry-hosts',?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(JSON.stringify(hosts)); this.options.updateRegistryHosts!([...hosts]); });
    return [...hosts];
  }
  /** Edits only the concurrent-session ceiling. Reducing it never evicts or silently settles current work. */
  setMaxSessions(actor: object, id: string, maximum: number): VmStatus {
    this.options.requireOwner(actor); vmId(id); vmInteger(maximum, 16);
    this.options.store.transaction(() => { this.options.requireOwner(actor); const row = this.options.store.registration(id); row.maxSessions = maximum; this.options.store.save(row); });
    return this.status(actor, id);
  }
}
