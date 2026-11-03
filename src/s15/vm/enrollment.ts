import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { VmHostCommand, VmManagement, VmStatus, VmCapability, VmMachineFacts } from "./types";
import { vmHostCommand, vmQuote } from "./host";
import { vmEndpoint, vmFail, vmId, vmInteger, vmRecord } from "./validation";
import { defaultVmRegistryHosts } from "./proxy";
import { VmSshTransport } from "./transport";
import { VmStore, type VmRegistration } from "./store";
import { probeVmDirectEgress } from "./network";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import { registerSecretFingerprint } from "../../security/secret-fingerprints";
import { vmIdentityMatches } from "./binding";
import { isVmLocalManagement, type QemuProvisionStep } from "./qemu";
import type { VmEndpoint } from "./types";
import type { VmProxyLease } from "./proxy";

/** One setup form; all transport settings persist atomically with the registered VM, without later config editing. */
export interface VmEnrollmentInput {
  id: string; setupId: string; host: string; port: number; user: string; hostPublicKey: string;
  managerId?: string; maxSessions?: number;
}
/** Authenticated server/API service. Only trusted composition installs management adapters and owner verification. */
export class VmEnrollment {
  readonly #setups = new Set<string>();
  readonly #checks = new Map<string, { input: Omit<VmEnrollmentInput, "id">; fingerprint: string; expiresAt: number }>();
  readonly #local = new Set<string>();
  constructor(readonly options: { store: VmStore; keyDirectory: string; requireOwner: (actor: object) => void;
    managers: ReadonlyMap<string, VmManagement>; updateRegistryHosts?: (hosts: readonly string[]) => void; run?: VmHostCommand; now?: () => number;
    /** Bounded provisioning proxy lease for a Jit-created local VM (Docker install); never an account credential. */
    proxyLease?: (sessionId: string, expiresAt: number) => VmProxyLease }) {
    if (!options.keyDirectory.startsWith("/") || resolve(options.keyDirectory) !== options.keyDirectory) vmFail("vm_invalid_setup");
    mkdirSync(options.keyDirectory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(options.keyDirectory); if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) vmFail("vm_key_directory_unsafe");
    options.store.db.exec("CREATE TABLE IF NOT EXISTS vm_settings (id TEXT PRIMARY KEY,data TEXT NOT NULL)");
  }
  private async inventory(endpoint: Parameters<typeof vmEndpoint>[0]): Promise<VmMachineFacts> {
    const source = `import os,platform,json,subprocess
f={}
for line in open('/etc/os-release'):
 if '=' in line:
  k,v=line.strip().split('=',1);f[k]=v.strip(chr(34))
m=int(next(line.split()[1] for line in open('/proc/meminfo') if line.startswith('MemTotal:')))*1024
d=os.statvfs('/');docker=False
try:
 p=subprocess.run(['/usr/bin/docker','version','--format','{{.Server.Version}}'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=3,env={'PATH':'/usr/bin:/bin','HOME':'/nonexistent'});docker=p.returncode==0
except (OSError,subprocess.SubprocessError):pass
print(json.dumps({'architecture':platform.machine(),'os':f.get('ID','linux')+':'+f.get('VERSION_ID','unknown'),'cpuCount':os.cpu_count(),'memoryBytes':m,'diskBytes':d.f_blocks*d.f_frsize,'sudo':os.getuid()==0,'docker':docker,'basis':'guest_reported'},separators=(',',':')))
`;
    let value: unknown;
    try { value = JSON.parse(await new VmSshTransport(endpoint, this.options.run ?? vmHostCommand).control(["sudo", "-n", "python3", "-I", "-c", source], { timeoutMs: 10000, maxBytes: 4096 })); }
    catch { vmFail("vm_prerequisite_missing", 503); }
    const r = vmRecord(value, ["architecture", "os", "cpuCount", "memoryBytes", "diskBytes", "sudo", "docker", "basis"]);
    if (typeof r.architecture !== "string" || !/^[a-zA-Z0-9_-]{1,32}$/.test(r.architecture) || typeof r.os !== "string" || !/^[a-z0-9._:-]{1,80}$/.test(r.os) || r.sudo !== true || typeof r.docker !== "boolean" || r.basis !== "guest_reported") vmFail("vm_protocol_invalid");
    for (const field of [r.cpuCount, r.memoryBytes, r.diskBytes]) vmInteger(field);
    return { architecture: r.architecture, os: r.os, cpuCount: Number(r.cpuCount), memoryBytes: Number(r.memoryBytes), diskBytes: Number(r.diskBytes), sudo: true, docker: r.docker, basis: "guest_reported" };
  }
  private capabilities(row: VmRegistration): readonly VmCapability[] {
    const manager = !!row.bindingMac && row.managerId !== null && this.options.managers.has(row.managerId);
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
  async checkMachine(actor: object, input: { setupId: string; host: string; port?: number; user?: string; managerId?: string }): Promise<{
    checkId: string; address: string; fingerprint: string; transportProfile: "ssh-sudo-systemd/v1"; facts: VmMachineFacts;
  }> {
    this.options.requireOwner(actor); vmId(input.setupId);
    const target = { ...input, port: input.port ?? 22, user: input.user ?? "jit" };
    if (!this.#setups.has(input.setupId)) vmFail("vm_setup_expired", 400);
    vmEndpoint({ host: input.host, port: target.port, user: target.user, identityFile: "/unused", knownHostsFile: "/unused" });
    const result = await (this.options.run ?? vmHostCommand)(["ssh-keyscan", "-T", "5", "-t", "ed25519", "-p", String(target.port), input.host], { timeoutMs: 10000, maxBytes: 8192 });
    this.options.requireOwner(actor);
    const keys = [...new Set(Buffer.from(result.stdout).toString("utf8").split("\n").filter(line => !line.startsWith("#") && line.trim()).map(line => line.trim().split(/\s+/).slice(1, 3).join(" ")))];
    const hostPublicKey = keys[0];
    if (result.exitCode !== 0 || keys.length !== 1 || !hostPublicKey || !/^ssh-ed25519 [A-Za-z0-9+/]{68}$/.test(hostPublicKey)) vmFail("vm_host_key_invalid", 400);
    const fingerprint = `SHA256:${createHash("sha256").update(Buffer.from(hostPublicKey.split(" ")[1]!, "base64")).digest("base64").replace(/=+$/, "")}`;
    const checkId = crypto.randomUUID().replaceAll("-", "");
    const knownHostsFile = join(this.options.keyDirectory, `${input.setupId}.${checkId}.known_hosts`), host = target.port === 22 ? input.host : `[${input.host}]:${target.port}`;
    writeFileSync(knownHostsFile, `${host} ${hostPublicKey}\n`, { mode: 0o600, flag: "wx" });
    const facts = await this.inventory(vmEndpoint({ host: input.host, port: target.port, user: target.user, identityFile: join(this.options.keyDirectory, input.setupId), knownHostsFile }));
    this.options.requireOwner(actor);
    this.#checks.set(checkId, { input: { ...target, hostPublicKey }, fingerprint, expiresAt: (this.options.now ?? Date.now)() + 600000 });
    return { checkId, address: `${target.user}@${input.host}:${target.port}`, fingerprint, transportProfile: "ssh-sudo-systemd/v1", facts };
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
    return this.verifyAndSave(() => this.options.requireOwner(actor), { id: input.id, endpoint, managerId: input.managerId ?? null, maxSessions: input.maxSessions ?? 2 }, () => this.#setups.delete(input.setupId));
  }
  /**
   * Protected local enrollment entry point for a Jit-created nested KVM working VM. It needs no pasted
   * bootstrap line: the manager provisions the guest from the verified image with its generated client key
   * and pinned host key, then the same inventory, readiness, `vmIdentityMatches` (controller-chosen MAC and
   * loopback SSH forward) and direct-egress probes produce the ordinary `VmStatus` and capability rows.
   * Snapshot/stop rows stay `unproven` until an observed protected restore/stop.
   */
  async enrollLocal(actor: object, input: { id: string; managerId: string; maxSessions?: number; signal?: AbortSignal; progress?: (step: QemuProvisionStep | "checks") => void }): Promise<VmStatus> {
    this.options.requireOwner(actor);
    return this.local(input, () => this.options.requireOwner(actor));
  }
  /**
   * Protected setup-job entry point (SETUP15-01) for the installation's default Jit-created working VM. It
   * runs the same provisioning and verification as {@link enrollLocal} under trusted composition authority
   * (the owner's own `setup --s15` or the protected boot pass), never for a model, guest or conversation.
   * `progress` reports each step as it begins, ending with `checks` (inventory, binding and egress probes).
   */
  provisionLocal(input: { id: string; managerId: string; maxSessions?: number; signal?: AbortSignal; progress?: (step: QemuProvisionStep | "checks") => void }): Promise<VmStatus> {
    return this.local(input, () => {});
  }
  private async local(input: { id: string; managerId: string; maxSessions?: number; signal?: AbortSignal; progress?: (step: QemuProvisionStep | "checks") => void }, check: () => void): Promise<VmStatus> {
    vmId(input.id); vmId(input.managerId); vmInteger(input.maxSessions ?? 2, 16);
    const manager = this.options.managers.get(input.managerId);
    if (!isVmLocalManagement(manager)) vmFail("vm_management_unavailable");
    const enrolled = this.options.store.db.query<{ id: string; data: string }, []>("SELECT id,data FROM vm_registry").all();
    if (enrolled.some(r => r.id === input.id || JSON.parse(r.data).managerId === input.managerId)) vmFail("vm_already_enrolled");
    if (this.#local.has(input.managerId)) vmFail("vm_capacity"); this.#local.add(input.managerId);
    try {
      const lease = this.options.proxyLease;
      await manager.provision({ ...(lease ? { lease: (sessionId: string, expiresAt: number) => lease(sessionId, expiresAt) } : {}), ...(input.signal ? { signal: input.signal } : {}), ...(input.progress ? { progress: input.progress } : {}) });
      check(); input.progress?.("checks");
      return await this.verifyAndSave(check, { id: input.id, endpoint: vmEndpoint(manager.endpoint()), managerId: input.managerId, maxSessions: input.maxSessions ?? 2 });
    } finally { this.#local.delete(input.managerId); }
  }
  /** Shared enrollment verification: inventory, sudo/systemd readiness, hypervisor binding and direct-egress refusal. */
  private async verifyAndSave(check: () => void, input: { id: string; endpoint: VmEndpoint; managerId: string | null; maxSessions: number }, saved?: () => void): Promise<VmStatus> {
    const endpoint = input.endpoint;
    const transport = new VmSshTransport(endpoint, this.options.run ?? vmHostCommand);
    const facts = await this.inventory(endpoint);
    const ready = await transport.control(["sudo", "-n", "python3", "-I", "-c", "import os,subprocess;assert os.getuid()==0;subprocess.run(['systemctl','--version'],check=True,stdout=subprocess.DEVNULL);print('jit-vm-ready-v1')"]);
    if (ready.trim() !== "jit-vm-ready-v1") vmFail("vm_prerequisite_missing", 503);
    const manager = input.managerId ? this.options.managers.get(input.managerId)! : null;
    const machine = manager ? await manager.inspect() : null;
    const bound = !!machine && await vmIdentityMatches(transport, machine, endpoint);
    const directDenied = await probeVmDirectEgress(transport);
    check();
    return this.options.store.transaction(() => {
      check();
      if (this.options.store.db.query("SELECT id FROM vm_registry WHERE id=?").get(input.id)) vmFail("vm_already_enrolled");
      const networkIsolated = bound && directDenied && !!machine && machine.network !== "unproven";
      const row: VmRegistration = { id: input.id, generation: 1, endpoint, managerId: bound ? input.managerId : null,
        state: networkIsolated ? "ready" : "unproven", networkCheckedAt: (this.options.now ?? Date.now)(), networkIsolated, facts,
        ...(bound ? { bindingMac: machine!.nicMac } : {}),
        maxSessions: input.maxSessions, reason: networkIsolated ? null : machine && !bound ? "vm_identity_unproven" : "vm_network_unproven", machineIdentity: bound ? machine!.identity : null, boot: bound ? machine!.boot : null };
      this.options.store.save(row); saved?.();
      return { id: row.id, generation: row.generation, state: row.state, networkIsolated, recoveryAvailable: bound, activeSessions: 0, maxSessions: row.maxSessions, reason: row.reason, capabilities: this.capabilities(row), facts: row.facts ?? null };
    });
  }
  /** Owner-only status; this query starts no VM/session, returns no credentials or raw endpoints. */
  status(actor: object, id: string): VmStatus {
    this.options.requireOwner(actor); vmId(id); const row = this.options.store.registration(id);
    const count = this.options.store.db.query<{ n: number }, [string]>("SELECT count(*) n FROM vm_sessions WHERE vm_id=? AND state<>'closed'").get(id)!.n;
    return { id, generation: row.generation, state: row.state, networkIsolated: row.networkIsolated && row.state === "ready",
      recoveryAvailable: !!row.bindingMac && row.managerId !== null && this.options.managers.has(row.managerId), activeSessions: count, maxSessions: row.maxSessions, reason: row.reason, capabilities: this.capabilities(row), facts: row.facts ?? null };
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
