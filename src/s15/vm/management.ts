import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { vmHostCommand } from "./host";
import type { VmHostCommand, VmMachineState, VmManagement } from "./types";
import { vmFail, vmInteger } from "./validation";

/** Limits the Lima adapter to explicitly new working VMs, never jit-arm or acceptance VMs. */
export interface LimaVmOptions { instance: string; limaHome?: string; run?: VmHostCommand; env?: Readonly<Record<string, string>> }
/** Protected Lima/QEMU lifecycle. Snapshots stop the VM and remain on the host disk; authority is never restored. */
export class LimaVmManagement implements VmManagement {
  readonly #run: VmHostCommand;
  #sshPort: number | null = null;
  constructor(readonly options: LimaVmOptions) {
    if (!/^jit-work(?:-[a-z0-9-]+)?$/.test(options.instance)) vmFail("vm_management_scope_denied", 403);
    this.#run = options.run ?? vmHostCommand;
  }
  private async command(args: string[]): Promise<string> {
    const result = await this.#run(["limactl", ...args], { timeoutMs: 120000, maxBytes: 262144, ...(this.options.env ? { env: this.options.env } : {}) });
    if (result.exitCode !== 0) vmFail("vm_management_unavailable", 503);
    return Buffer.from(result.stdout).toString("utf8");
  }
  /** Checks host-side Lima config and the actual QEMU argv; never trusts a guest hostname or boot ID. */
  async inspect(): Promise<VmMachineState> {
    let rows; try { rows = (await this.command(["list", "--json", this.options.instance])).trim().split("\n").filter(Boolean).map(s => JSON.parse(s)); } catch { vmFail("vm_management_unavailable", 503); }
    const row = rows.find(r => r.name === this.options.instance);
    if (rows.length !== 1 || !row || row.vmType !== "qemu" || !["Running", "Stopped"].includes(row.status) || row.config?.plain !== true || (row.config?.mounts?.length ?? 0) !== 0 || (row.config?.networks?.length ?? 0) !== 0 || row.config?.ssh?.forwardAgent !== false || row.config?.ssh?.loadDotSSHPubKeys !== false || row.config?.hostResolver?.enabled !== false || row.config?.propagateProxyEnv !== false) vmFail("vm_boundary_unproven");
    for (const value of [row.cpus, row.memory, row.disk]) vmInteger(value);
    vmInteger(row.sshLocalPort, 65535); this.#sshPort = row.sshLocalPort;
    let boot = "stopped", network: VmMachineState["network"] = "unproven";
    if (row.status === "Running") {
      let pid: string;
      try { pid = readFileSync(join(this.options.limaHome ?? join(homedir(), ".lima"), this.options.instance, "qemu.pid"), "utf8").trim(); } catch { vmFail("vm_management_unavailable", 503); }
      if (!/^[0-9]+$/.test(pid)) vmFail("vm_management_unavailable");
      const p = await this.#run(["ps", "-ww", "-p", pid, "-o", "lstart=", "-o", "args="], { timeoutMs: 5000, maxBytes: 65536 });
      const args = Buffer.from(p.stdout).toString("utf8");
      if (p.exitCode !== 0 || !args.includes(`lima-${this.options.instance}`) || /(?:-fsdev|-virtfs|mount_tag=|-nic\s|\s-net\s)/.test(args) || (args.match(/-netdev /g)?.length ?? 0) !== 1) vmFail("vm_boundary_unproven");
      const netdev = /-netdev ([^\n]*?)(?= -[a-z]|$)/.exec(args)?.[1] ?? "";
      if (/^user,/.test(netdev) && /(?:^|,)restrict=on(?:,|$)/.test(netdev) && /(?:^|,)ipv6=off(?:,|$)/.test(netdev)) {
        const forwards = netdev.match(/guestfwd=/g)?.length ?? 0;
        const proxy = /,guestfwd=tcp:192\.168\.5\.100:3128-cmd:\/usr\/bin\/nc 127\.0\.0\.1 [0-9]{1,5}$/.test(netdev);
        if (!/(?:smb|tftp|guestfwd)\s*=/.test(netdev)) network = "isolated";
        else if (forwards === 1 && proxy && !/(?:smb|tftp)=/.test(netdev)) network = "proxy-only";
      }
      boot = `${pid}:${args.slice(0, 24).trim()}`;
    }
    return { state: row.status === "Running" ? "running" : "stopped", identity: `lima:${this.options.instance}`, boot,
      cpuCount: row.cpus, memoryBytes: row.memory, diskBytes: row.disk, network };
  }
  /** Explicit owner start of the enrolled VM only; stable SSH port and external network profile are retained. */
  async start(): Promise<void> {
    const state = await this.inspect(); if (state.state !== "stopped") vmFail("vm_fenced");
    await this.command(["start", "--tty=false", "--ssh-port", String(this.#sshPort), this.options.instance]);
    if ((await this.inspect()).state !== "running") vmFail("vm_management_unavailable");
  }
  /** Exact VM stop plus host read-back is the root-resistant settlement available on Lima. */
  async stop(): Promise<void> { await this.command(["stop", "--force", this.options.instance]); if ((await this.inspect()).state !== "stopped") vmFail("vm_stop_unconfirmed"); }
  /** Protected disk snapshot; a restart creates a new boot fence and never replays a runner operation. */
  async snapshot(name: string): Promise<void> {
    if (!/^jit-[a-f0-9]{32}$/.test(name)) vmFail("vm_invalid_setup");
    const running = (await this.inspect()).state === "running";
    if (running) { await this.command(["stop", this.options.instance]); if ((await this.inspect()).state !== "stopped") vmFail("vm_stop_unconfirmed"); }
    await this.command(["snapshot", "create", this.options.instance, "--tag", name]);
    if (running) await this.command(["start", "--tty=false", "--ssh-port", String(this.#sshPort), this.options.instance]);
  }
  /** Restores only an exact protected tag while stopped. Workers stay fenced until explicit re-enrollment/verification. */
  async restore(name: string): Promise<void> {
    if (!/^jit-[a-f0-9]{32}$/.test(name)) vmFail("vm_invalid_setup");
    await this.stop(); await this.command(["snapshot", "apply", this.options.instance, "--tag", name]);
  }
}

/** VM-scoped Proxmox token and endpoint; supplied only through protected setup, never a model payload/export. */
export interface ProxmoxVmOptions {
  baseUrl: string; node: string; vmid: number;
  token: () => string;
  proxy: { address: string; port: number };
  fetch?: typeof fetch;
  /** Optional external verifier of Datacenter/Node firewall activation, which a VM-scoped token cannot audit. */
  firewallActive?: () => Promise<boolean>;
}
/** Proxmox management adapter uses only the enrolled VM path and token-owned task status. TLS verification stays enabled. */
export class ProxmoxVmManagement implements VmManagement {
  readonly #fetch: typeof fetch;
  readonly #base: string;
  constructor(readonly options: ProxmoxVmOptions) {
    const url = new URL(options.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || !/^[a-zA-Z0-9_-]{1,64}$/.test(options.node)) vmFail("vm_invalid_setup");
    vmInteger(options.vmid, 999999999); vmInteger(options.proxy.port, 65535);
    this.#base = `${url.origin}/api2/json`; this.#fetch = options.fetch ?? fetch;
  }
  private get path() { return `/nodes/${this.options.node}/qemu/${this.options.vmid}`; }
  private async api(path: string, method = "GET", params?: Record<string, string>): Promise<any> {
    let response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, { method, redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { Authorization: `PVEAPIToken=${this.options.token()}`, ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
        ...(params ? { body: new URLSearchParams(params).toString() } : {}) });
      if (!response.ok) vmFail("vm_management_unavailable", 503);
      const reader = response.body?.getReader(); if (!reader) vmFail("vm_management_unavailable");
      const chunks: Uint8Array[] = []; let total = 0;
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.length; if (total > 262144) vmFail("vm_output_limit"); chunks.push(value); } }
      finally { await reader.cancel(); }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")).data;
    } catch { vmFail("vm_management_unavailable", 503); }
  }
  private async mutate(suffix: string, params?: Record<string, string>): Promise<void> {
    const task = await this.api(`${this.path}/${suffix}`, "POST", params);
    if (typeof task !== "string" || !task.startsWith(`UPID:${this.options.node}:`) || task.length > 1024) vmFail("vm_management_unavailable");
    // Bounded infrastructure task observation, never mutation replay.
    const deadline = performance.now() + 105000;
    for (let i = 0; i < 120 && performance.now() < deadline; i++) {
      const status = await this.api(`/nodes/${this.options.node}/tasks/${encodeURIComponent(task)}/status`);
      if (status?.status === "stopped") { if (status.exitstatus !== "OK") vmFail("vm_management_unavailable"); return; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    vmFail("vm_management_unavailable");
  }
  /** Read-only Sys.Audit checks at both protected firewall activation levels; no mutation or guest claim. */
  async firewallActive(): Promise<boolean> {
    try {
      const [cluster, node] = await Promise.all([this.api("/cluster/firewall/options"), this.api(`/nodes/${this.options.node}/firewall/options`)]);
      return cluster?.enable === 1 && node?.enable === 1;
    } catch { return false; }
  }
  /** VM firewall read-back plus independent global-activation verifier; guest probes alone never advertise isolation. */
  async inspect(): Promise<VmMachineState> {
    const [status, config, firewall, rules] = await Promise.all([this.api(`${this.path}/status/current`), this.api(`${this.path}/config`), this.api(`${this.path}/firewall/options`), this.api(`${this.path}/firewall/rules`)]);
    if (!["running", "stopped"].includes(status?.status) || config?.hostpci0 || Object.keys(config ?? {}).some(k => /^(?:hostpci|usb|virtiofs|args)/.test(k))) vmFail("vm_boundary_unproven");
    const nics = Object.keys(config).filter(k => /^net\d+$/.test(k));
    const filtered = nics.length === 1 && /(?:^|,)firewall=1(?:,|$)/.test(config[nics[0]!]);
    const outbound = Array.isArray(rules) ? rules.filter(r => r.enable === 1 && r.type === "out" && r.action === "ACCEPT") : [];
    const proxyOnly = outbound.length === 1 && outbound[0].dest === this.options.proxy.address && String(outbound[0].dport) === String(this.options.proxy.port) && outbound[0].proto === "tcp" && !outbound[0].macro;
    let active = false;
    try { active = this.options.firewallActive ? await this.options.firewallActive() : await this.firewallActive(); } catch { /* Missing read-only audit permission keeps isolation unproven. */ }
    const cpuCount = Number(config.cores ?? 1) * Number(config.sockets ?? 1), memoryBytes = Number(config.memory) * 1048576, diskBytes = Number(status.maxdisk);
    for (const n of [cpuCount, memoryBytes, diskBytes]) vmInteger(n);
    return { state: status.status, identity: `proxmox:${this.options.node}:${this.options.vmid}`, boot: `${status.pid ?? 0}`,
      cpuCount, memoryBytes, diskBytes, network: filtered && firewall.enable === 1 && firewall.policy_out === "DROP" && proxyOnly && active ? "proxy-only" : "unproven" };
  }
  /** Explicit VM-scoped start, with no guest command or authority replay. */
  async start(): Promise<void> { if ((await this.inspect()).state !== "stopped") vmFail("vm_fenced"); await this.mutate("status/start"); if ((await this.inspect()).state !== "running") vmFail("vm_management_unavailable"); }
  /** Stops this exact VM only, then independently reads its hypervisor state. */
  async stop(): Promise<void> { if ((await this.inspect()).state === "stopped") return; await this.mutate("status/stop"); if ((await this.inspect()).state !== "stopped") vmFail("vm_stop_unconfirmed"); }
  /** VM-scoped API snapshot, no RAM/authority/credentials included. */
  async snapshot(name: string): Promise<void> { if (!/^jit-[a-f0-9]{32}$/.test(name)) vmFail("vm_invalid_setup"); await this.mutate("snapshot", { snapname: name, vmstate: "0" }); }
  /** Exact rollback while fenced; does not automatically start the restored VM. */
  async restore(name: string): Promise<void> { if (!/^jit-[a-f0-9]{32}$/.test(name)) vmFail("vm_invalid_setup"); await this.stop(); await this.mutate(`snapshot/${name}/rollback`); }
}

/** QEMU wrapper source for a NEW Lima VM; restrict is enforced in the protected host's network backend. */
export function limaRestrictedQemu(qemu: string, proxyPort: number): string {
  if (!qemu.startsWith("/") || /[\n\r\0]/.test(qemu)) vmFail("vm_invalid_setup"); vmInteger(proxyPort, 65535);
  return `#!/usr/bin/python3\nimport os,sys\na=sys.argv[1:]\nif '-netdev' in a and a[a.index('-netdev')+1]!='help':\n i=a.index('-netdev')+1\n if not a[i].startswith('user,') or any(x in a[i] for x in ('guestfwd=','smb=','tftp=','restrict=','ipv6=')) or a.count('-netdev')!=1 or any(x in a for x in ('-fsdev','-virtfs','-nic','-net')): sys.exit(126)\n a[i]+=',restrict=on,ipv6=off,guestfwd=tcp:192.168.5.100:3128-cmd:/usr/bin/nc 127.0.0.1 ${proxyPort}'\nos.execv(${JSON.stringify(qemu)},[${JSON.stringify(qemu)}]+a)\n`;
}
