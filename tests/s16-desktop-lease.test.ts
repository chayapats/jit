import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:net";
import { AppError } from "../src/errors";
import { ConnectionVault } from "../src/exec/connections";
import { websiteSensitiveOnly } from "../src/s15/browser/sites";
import { VmEnrollment } from "../src/s15/vm/enrollment";
import { startLocalVmControl } from "../src/s15/vm/local-control";
import { VmManagers } from "../src/s15/vm/managers";
import { startVmRegistryProxy, type VmProxyLease, type VmProxyLog } from "../src/s15/vm/proxy";
import { QemuVmManagement, qemuDesktopBrowser, qemuDesktopLeaseWriter, qemuDesktopProvisioning, type QemuHostOptions } from "../src/s15/vm/qemu";
import { WorkingVmService } from "../src/s15/vm/service";
import { VmStore } from "../src/s15/vm/store";
import { VmSshTransport } from "../src/s15/vm/transport";
import type { VmPolicyPort } from "../src/s15/vm/types";
import { FakeQemuHost } from "./fixtures/s15-qemu";

// DESK16-01 slice 2 (ADR 0091 decisions 2, 3, 5): the desktop browser's standing lease and its sensitive-host filter.
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
async function exchange(port: number | string, input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = typeof port === "string" ? connect(port) : connect(port, "127.0.0.1"), chunks: Buffer[] = []; socket.setTimeout(2000, () => socket.destroy(new Error("test timeout")));
    socket.on("connect", () => socket.write(input)); socket.on("data", b => chunks.push(typeof b === "string" ? Buffer.from(b) : b)); socket.on("end", () => { socket.destroy(); resolve(Buffer.concat(chunks).toString()); }); socket.on("error", reject);
  });
}
const auth = (lease: VmProxyLease) => { const u = new URL(lease.environment.HTTPS_PROXY!); return `Basic ${Buffer.from(`${u.username}:${u.password}`).toString("base64")}`; };
const request = (target: string, authorization: string) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${authorization}\r\n\r\n`;
const sensitive = (host: string) => websiteSensitiveOnly(`https://${host}`);

/** A public-web proxy whose DNS and upstream are scripted; `upstream` answers every admitted CONNECT. */
async function proxyFixture(resolveTo = "93.184.216.34", limits: { bytesPerSession?: number; reply?: number } = {}) {
  const upstream = createServer(socket => socket.end(Buffer.alloc(limits.reply ?? 0)));
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve)); cleanups.push(() => new Promise<void>(resolve => upstream.close(() => resolve())));
  const upstreamPort = (upstream.address() as { port: number }).port, lookups: string[] = [], logs: VmProxyLog[] = [];
  const proxy = await startVmRegistryProxy({ hostname: "127.0.0.1", guestHostname: "127.0.0.1", port: 0, hosts: ["registry.test"], publicWeb: true, log: e => logs.push(e), ...(limits.bytesPerSession ? { bytesPerSession: limits.bytesPerSession } : {}),
    resolve: async host => { lookups.push(host); return [{ address: resolveTo, family: 4 }]; }, connect: () => connect(upstreamPort, "127.0.0.1") });
  cleanups.unshift(proxy.close);
  return { proxy, lookups, logs };
}

describe("desktop lease host filter in the proxy", () => {
  test("sensitive-only hosts are refused before DNS and logged as denied; a public host is admitted", async () => {
    const { proxy, lookups, logs } = await proxyFixture();
    const desktop = proxy.lease("desktop_vm_1", Date.now() + 10_000, undefined, { deny: sensitive }), a = auth(desktop);
    for (const host of ["accounts.google.com", "login.microsoftonline.com", "login.example.com", "mybank.co.th", "sso.example.org"]) {
      expect(await exchange(proxy.port, request(`${host}:443`, a))).toContain("403");
      expect(logs.at(-1)).toEqual({ sessionId: "desktop_vm_1", host, sentBytes: 0, receivedBytes: 0, state: "denied" });
    }
    expect(lookups).toEqual([]);
    expect(await exchange(proxy.port, request("news.example.co.th:443", a))).toContain("200 Connection Established");
    expect(lookups).toEqual(["news.example.co.th"]);
  });
  test("a work-session lease on the same proxy keeps today's rules", async () => {
    const { proxy, lookups } = await proxyFixture();
    proxy.lease("desktop_vm_1", Date.now() + 10_000, undefined, { deny: sensitive });
    const work = proxy.lease("work_session_1", Date.now() + 10_000);
    expect(await exchange(proxy.port, request("login.example.com:443", auth(work)))).toContain("200 Connection Established");
    expect(lookups).toEqual(["login.example.com"]);
  });
  test("the filter also covers registry hosts, private answers stay refused, and a failing filter refuses", async () => {
    const { proxy } = await proxyFixture("10.0.0.5");
    const desktop = proxy.lease("desktop_vm_1", Date.now() + 10_000, undefined, { deny: host => host === "registry.test" });
    expect(await exchange(proxy.port, request("registry.test:443", auth(desktop)))).toContain("403");
    expect(await exchange(proxy.port, request("public.example.co.th:443", auth(desktop)))).toContain("403");
    const broken = proxy.lease("desktop_vm_2", Date.now() + 10_000, undefined, { deny: () => { throw new Error("filter failed"); } });
    expect(await exchange(proxy.port, request("public.example.co.th:443", auth(broken)))).toContain("403");
    expect(() => proxy.lease("desktop_vm_3", Date.now() + 10_000, undefined, { deny: "nope" as unknown as () => boolean })).toThrow(expect.objectContaining({ code: "vm_invalid_setup" }));
  });
  test("renew moves the expiry of an open lease; a closed lease stays closed", async () => {
    const { proxy } = await proxyFixture();
    const lease = proxy.lease("desktop_vm_1", Date.now() + 40, undefined, { deny: sensitive });
    lease.renew!(Date.now() + 10_000); await Bun.sleep(80);
    expect(await exchange(proxy.port, request("news.example.co.th:443", auth(lease)))).toContain("200 Connection Established");
    expect(() => lease.renew!(Date.now() - 1)).toThrow(expect.objectContaining({ code: "vm_proxy_unavailable" }));
    lease.close(); lease.renew!(Date.now() + 10_000);
    expect(await exchange(proxy.port, request("news.example.co.th:443", auth(lease)))).toContain("407");
  });
  test("renew starts a fresh byte allowance; an unrenewed (work-session) lease stays spent", async () => {
    const { proxy } = await proxyFixture("93.184.216.34", { bytesPerSession: 64, reply: 200 });
    const desktop = proxy.lease("desktop_vm_1", Date.now() + 10_000, undefined, { deny: sensitive }), work = proxy.lease("work_session_1", Date.now() + 10_000);
    for (const lease of [desktop, work]) {
      expect(await exchange(proxy.port, request("news.example.co.th:443", auth(lease)))).toContain("200 Connection Established");
      await Bun.sleep(20);
      expect(await exchange(proxy.port, request("news.example.co.th:443", auth(lease)))).not.toContain("200 Connection Established");
    }
    desktop.renew!(Date.now() + 10_000);
    expect(await exchange(proxy.port, request("news.example.co.th:443", auth(desktop)))).toContain("200 Connection Established");
    expect(await exchange(proxy.port, request("news.example.co.th:443", auth(work)))).not.toContain("200 Connection Established");
  });
});

describe("local VM control composes the desktop lease only with its filter", () => {
  const directory = () => { const dir = mkdtempSync(join(tmpdir(), "jit-desk-")); cleanups.push(() => rmSync(dir, { recursive: true, force: true })); return join(dir, "vm"); };
  test("desktop without a filter is refused; with one the lease refuses sensitive hosts; headless has no desktop lease", async () => {
    const store = new VmStore(":memory:"); cleanups.push(() => store.close());
    await expect(startLocalVmControl(store, { directory: directory(), desktop: true })).rejects.toMatchObject({ code: "vm_invalid_setup" });
    const lookups: string[] = [];
    const control = await startLocalVmControl(store, { directory: directory(), desktop: true, desktopDeny: sensitive, resolve: async host => { lookups.push(host); return [{ address: "10.0.0.1", family: 4 }]; } });
    cleanups.unshift(control.close);
    const lease = control.host.desktopLease!("desktop_vm_1", Date.now() + 10_000);
    expect(lease.environment.HTTPS_PROXY).toContain("@192.168.5.100:3128");
    expect(await exchange(control.host.proxySocket, request("accounts.google.com:443", auth(lease)))).toContain("403");
    expect(lookups).toEqual([]);
    // A public name reaches DNS (and is then refused here only because the scripted answer is private).
    expect(await exchange(control.host.proxySocket, request("news.example.co.th:443", auth(lease)))).toContain("403");
    expect(lookups).toEqual(["news.example.co.th"]);
    lease.close();
    // The beat's install lease is the unfiltered provisioning kind, like the Docker install.
    const install = control.host.provisionLease!(`provision_${"1".repeat(32)}`, Date.now() + 10_000);
    expect(await exchange(control.host.proxySocket, request("accounts.google.com:443", auth(install)))).toContain("403");
    expect(lookups).toEqual(["news.example.co.th", "accounts.google.com"]);
    install.close();
    const other = new VmStore(":memory:"); cleanups.push(() => other.close());
    const headless = await startLocalVmControl(other, { directory: directory() }); cleanups.unshift(headless.close);
    expect(headless.host.desktopLease).toBeUndefined(); expect(headless.host.provisionLease).toBeUndefined();
  });
});

describe("desktop lease lifecycle of a local QEMU VM", () => {
  const identity = { name: "jit-work-0123456789ab", architecture: "x86_64" as const, mac: "52:54:00:12:34:56", sshPort: 22022, resources: { cpus: 5, memoryMiB: 9216, diskGiB: 60 } };
  /** Records every desktop lease issued, renewed and revoked, and captures the renewal timer. */
  function leases() {
    const issued: { id: string; expiresAt: number; renewals: number[]; closed: boolean }[] = [], beats: { beat: () => Promise<void>; ms: number; cancelled: boolean }[] = [];
    const desktopLease = (id: string, expiresAt: number): VmProxyLease => {
      const record = { id, expiresAt, renewals: [] as number[], closed: false }; issued.push(record);
      return { environment: Object.freeze({ HTTPS_PROXY: `http://${id}:secret@192.168.5.100:3128` }), close() { record.closed = true; }, renew(at) { record.renewals.push(at); } };
    };
    const every = (beat: () => void, ms: number) => { const entry = { beat: () => beat() as unknown as Promise<void>, ms, cancelled: false }; beats.push(entry); return () => { entry.cancelled = true; }; };
    return { issued, beats, options: { desktop: true, desktopLease, every } satisfies Partial<QemuHostOptions> };
  }
  function host(group = true) { const h = new FakeQemuHost(); h.guestDesktopGroup = group; cleanups.push(() => h.cleanup()); return h; }
  const flush = () => new Promise(resolve => setTimeout(resolve, 20));

  test("each boot issues one lease delivered to the guest; renewal keeps it; stop and restore revoke it", async () => {
    const h = host(), l = leases(), m = new QemuVmManagement(identity, { ...h.options(), ...l.options });
    await m.provision();
    expect(l.issued).toHaveLength(1); expect(l.issued[0]!.id).toMatch(/^desktop_jit-work-0123456789ab_[0-9a-f]{24}$/);
    expect(h.desktopLeases).toEqual([`http://${l.issued[0]!.id}:secret@192.168.5.100:3128`]);
    expect(m.desktopLeaseHeld).toBe(true); expect(l.beats[0]!.ms).toBe(600_000);
    l.beats[0]!.beat(); await flush();
    expect(l.issued[0]!.renewals).toHaveLength(1); expect(l.issued[0]!.renewals[0]!).toBeGreaterThan(Date.now() + 1_700_000);
    await m.stop();
    expect(l.issued[0]!.closed).toBe(true); expect(l.beats[0]!.cancelled).toBe(true); expect(m.desktopLeaseHeld).toBe(false);
    await m.start();
    expect(l.issued).toHaveLength(2); expect(l.issued[1]!.id).not.toBe(l.issued[0]!.id); expect(l.issued[1]!.closed).toBe(false);
    const tag = `jit-${"a".repeat(32)}`; await m.snapshot(tag); await m.restore(tag);
    expect(l.issued[1]!.closed).toBe(true); expect(m.desktopLeaseHeld).toBe(false);
  });
  test("a VM that stopped without a protected stop loses its lease at the next renewal", async () => {
    const h = host(), l = leases(), m = new QemuVmManagement(identity, { ...h.options(), ...l.options });
    await m.provision();
    h.units.clear(); h.processes.clear(); for (const disk of h.disks.values()) disk.locked = false;
    l.beats[0]!.beat(); await flush();
    expect(l.issued[0]!.closed).toBe(true); expect(l.issued[0]!.renewals).toEqual([]); expect(m.desktopLeaseHeld).toBe(false);
  });
  test("#454 (b): a full lease pool at boot leaves the VM running; a later beat obtains the lease", async () => {
    const h = host(), l = leases(); let full = true;
    const m = new QemuVmManagement(identity, { ...h.options(), ...l.options, desktopLease: (id, at) => { if (full) throw new AppError("vm_proxy_unavailable", 503); return l.options.desktopLease(id, at); } });
    await m.provision();
    expect((await m.inspect()).state).toBe("running"); expect(m.desktopLeaseHeld).toBe(false); expect(h.desktopLeases).toEqual([]);
    expect(l.beats).toHaveLength(1); expect(l.beats[0]!.cancelled).toBe(false);
    await l.beats[0]!.beat();
    expect(m.desktopLeaseHeld).toBe(false);
    full = false; await l.beats[0]!.beat();
    expect(m.desktopLeaseHeld).toBe(true); expect(l.issued).toHaveLength(1); expect(h.desktopLeases).toEqual([`http://${l.issued[0]!.id}:secret@192.168.5.100:3128`]);
    await l.beats[0]!.beat();
    expect(l.issued).toHaveLength(1); expect(l.issued[0]!.renewals).toHaveLength(1);
  });
  test("#454 (a): a live snapshot holding QMP past the 30s inspect timeout skips the beat and keeps the lease", async () => {
    const h = host(), l = leases(); let release = () => {}; let holding = false;
    const qmp: QemuHostOptions["qmp"] = async (socket, commands, options) => {
      if (holding) throw new AppError("vm_management_unavailable", 503); // What qmpExchange reports after its 30s timeout.
      if (commands.some(c => c.execute === "blockdev-snapshot-internal-sync")) { holding = true; await new Promise<void>(done => { release = done; }); holding = false; }
      return h.qmp(socket, commands, options);
    };
    const m = new QemuVmManagement(identity, { ...h.options(), ...l.options, qmp });
    await m.provision();
    const snapshot = m.snapshot(`jit-${"b".repeat(32)}`);
    for (let i = 0; i < 200 && !holding; i++) await Bun.sleep(10);
    expect(holding).toBe(true);
    await l.beats[0]!.beat();
    expect(m.desktopLeaseHeld).toBe(true); expect(l.issued[0]!.closed).toBe(false); expect(l.issued[0]!.renewals).toEqual([]); expect(l.beats[0]!.cancelled).toBe(false);
    release(); await snapshot;
    await l.beats[0]!.beat();
    expect(l.issued[0]!.renewals).toHaveLength(1); expect(l.issued).toHaveLength(1);
  });
  test("an unproven boundary revokes the lease (fail closed); the beat issues a new one once the VM is proven again", async () => {
    const h = host(), l = leases(), m = new QemuVmManagement(identity, { ...h.options(), ...l.options });
    await m.provision();
    const [unit] = [...h.units.values()], process = h.processes.get(unit!.pid)!, argv = process.argv;
    process.argv = ["/usr/bin/qemu-system-x86_64", "-name", "someone-else"];
    await l.beats[0]!.beat();
    expect(l.issued[0]!.closed).toBe(true); expect(m.desktopLeaseHeld).toBe(false); expect(l.beats[0]!.cancelled).toBe(false);
    process.argv = argv;
    await l.beats[0]!.beat();
    expect(l.issued).toHaveLength(2); expect(m.desktopLeaseHeld).toBe(true);
  });
  test("a running VM whose network profile is not proven gets no lease and loses a held one (Greptile #455)", async () => {
    const h = host(), l = leases(), m = new QemuVmManagement(identity, { ...h.options(), ...l.options });
    await m.provision();
    const [unit] = [...h.units.values()], process = h.processes.get(unit!.pid)!, argv = process.argv;
    process.argv = [...argv, "-device", "e1000,netdev=extra"];
    expect(await m.inspect()).toMatchObject({ state: "running", network: "unproven" });
    await l.beats[0]!.beat();
    expect(l.issued[0]!.closed).toBe(true); expect(l.issued[0]!.renewals).toEqual([]); expect(m.desktopLeaseHeld).toBe(false);
    await l.beats[0]!.beat(); await m.reattached();
    expect(l.issued).toHaveLength(1); expect(m.desktopLeaseHeld).toBe(false);
    process.argv = argv;
    await l.beats[0]!.beat();
    expect(l.issued).toHaveLength(2); expect(m.desktopLeaseHeld).toBe(true);
  });
  test("a guest without the desktop session and no install source gets no lease; the beat keeps trying; headless issues none", async () => {
    const h = host(false), l = leases(), m = new QemuVmManagement(identity, { ...h.options(), ...l.options });
    await m.provision();
    // Once at boot, once again after cloud-init; both revoked because the guest has no `jit-desktop` group.
    expect(l.issued).toHaveLength(2); expect(l.issued.every(x => x.closed)).toBe(true); expect(m.desktopLeaseHeld).toBe(false);
    expect(l.beats).toHaveLength(1);
    h.guestDesktopGroup = true; await l.beats[0]!.beat();
    expect(l.issued).toHaveLength(3); expect(m.desktopLeaseHeld).toBe(true);
    const h2 = host(), l2 = leases(), headless = new QemuVmManagement(identity, { ...h2.options(), desktopLease: l2.options.desktopLease, every: l2.options.every });
    await headless.provision();
    expect(l2.issued).toEqual([]); expect(h2.desktopLeases).toEqual([]); expect(l2.beats).toEqual([]); expect(h2.desktopInstalls).toEqual([]);
  });
  test("#454: provisioning installs the pinned session after cloud-init, then issues the lease; its own lease is always closed", async () => {
    const h = host(false), l = leases(), provisioning: { id: string; closed: boolean }[] = [];
    const lease = (id: string): VmProxyLease => { const r = { id, closed: false }; provisioning.push(r); return { environment: { HTTPS_PROXY: `http://${id}:p@192.168.5.100:3128` }, close() { r.closed = true; } }; };
    const m = new QemuVmManagement(identity, { ...h.options(), ...l.options });
    await m.provision({ lease });
    expect(h.desktopInstalls).toHaveLength(1);
    expect(h.desktopInstalls[0]).toEqual({ proxy: expect.stringContaining("@192.168.5.100:3128"), url: qemuDesktopBrowser.x86_64.url, sha256: qemuDesktopBrowser.x86_64.sha256, version: qemuDesktopBrowser.version });
    // Docker's lease and the desktop install's lease are separate and both closed.
    expect(provisioning).toHaveLength(2); expect(provisioning.every(p => p.closed && /^provision_[0-9a-f]{32}$/.test(p.id))).toBe(true);
    expect(m.desktopLeaseHeld).toBe(true); expect(l.issued.filter(x => !x.closed)).toHaveLength(1);
    expect(h.desktopLeases.at(-1)).toContain(l.issued.at(-1)!.id);
  });
  test("a failed install is tried once per boot; on a later boot the beat installs it through the provisioning lease source", async () => {
    const h = host(false), l = leases(), installs: string[] = [];
    const provisionLease = (id: string): VmProxyLease => { installs.push(id); return { environment: { HTTPS_PROXY: `http://${id}:p@192.168.5.100:3128` }, close() {} }; };
    const m = new QemuVmManagement(identity, { ...h.options(), ...l.options, provisionLease });
    h.desktopInstallFails = true;
    await m.provision();
    expect(h.desktopInstalls).toHaveLength(1); expect(m.desktopLeaseHeld).toBe(false);
    await l.beats[0]!.beat();
    expect(h.desktopInstalls).toHaveLength(1);
    await m.stop(); expect(l.beats[0]!.cancelled).toBe(true);
    h.desktopInstallFails = false; await m.start();
    expect(h.desktopInstalls).toHaveLength(1); expect(l.beats).toHaveLength(2);
    await l.beats[1]!.beat();
    expect(h.desktopInstalls).toHaveLength(2); expect(m.desktopLeaseHeld).toBe(true); expect(installs).toHaveLength(2);
  });
  test("#455: a transient inspect failure while re-attaching still arms the beat; the next beat issues the lease", async () => {
    const h = host(), first = leases();
    await new QemuVmManagement(identity, { ...h.options(), ...first.options }).provision();
    let busy = true;
    const qmp: QemuHostOptions["qmp"] = async (socket, commands, options) => {
      if (busy) throw new AppError("vm_management_unavailable", 503); // A live snapshot holding QMP past the 30s timeout.
      return h.qmp(socket, commands, options);
    };
    const l = leases(), m = new QemuVmManagement(identity, { ...h.options(), ...l.options, qmp });
    await m.reattached();
    expect(l.beats).toHaveLength(1); expect(l.beats[0]!.cancelled).toBe(false); expect(l.issued).toEqual([]); expect(m.desktopLeaseHeld).toBe(false);
    busy = false; await l.beats[0]!.beat();
    expect(m.desktopLeaseHeld).toBe(true); expect(l.issued).toHaveLength(1); expect(l.issued[0]!.closed).toBe(false);
  });
  test("a restarted controller re-attaching a surviving desktop VM issues a fresh lease once", async () => {
    const owner = {}, requireOwner = (a: object) => { if (a !== owner) throw new Error("owner"); };
    const allow: VmPolicyPort = { assertCurrent() {}, async claim() { return { async dispatch(start) { return start(); }, publish(consume) { return consume(); }, observe() {} }; } };
    const h = host(), store = new VmStore(":memory:"); cleanups.push(() => store.close());
    const stack = (l: ReturnType<typeof leases>) => {
      const managers = new VmManagers({ store, vault: new ConnectionVault(join(h.root, "vault"), { forbidden: [h.directory] }), requireOwner, local: { ...h.options(), port: () => 22022, ...l.options } });
      const enrollment = new VmEnrollment({ store, keyDirectory: join(h.root, "keys"), requireOwner, managers, run: h.run, now: () => 1 });
      const service = new WorkingVmService({ store, policy: allow, managers, requireOwner, transport: row => new VmSshTransport(row.endpoint, h.run) });
      return { managers, enrollment, service };
    };
    const first = leases(), s = stack(first), { managerId } = s.managers.register(owner, { kind: "qemu" });
    await s.enrollment.enrollLocal(owner, { id: "local", managerId });
    expect(first.issued.filter(l => !l.closed)).toHaveLength(1);
    const second = leases(), next = stack(second), launches = h.launches.length;
    await next.service.reattach();
    expect(h.launches).toHaveLength(launches); expect(store.registration("local").state).toBe("ready");
    expect(second.issued).toHaveLength(1); expect(second.issued[0]!.closed).toBe(false); expect(h.desktopLeases.at(-1)).toContain(second.issued[0]!.id);
    await (next.managers.get(managerId) as QemuVmManagement).reattached();
    expect(second.issued).toHaveLength(1);
  });
});

describe("guest lease writer", () => {
  const run = (proxy: string, program = qemuDesktopLeaseWriter) => spawnSync("python3", ["-I", "-c", program], { input: JSON.stringify({ proxy, version: qemuDesktopBrowser.version }), encoding: "utf8" });
  test("refuses a lease URL that could break the environment file, and writes nothing without the desktop group", () => {
    const python = spawnSync("python3", ["-c", "import grp;grp.getgrnam('jit-desktop')"]);
    if (python.error) return; // No python3 on this runner; the fixed program is exercised in live evidence.
    for (const bad of ["https://a:b@192.168.5.100:3128", "http://a:b@192.168.5.100:3128\nLD_PRELOAD=/x", "http://a b@h:1", "http://a:'b@h:1", "http://a:b$HOME@h:1"]) expect(run(bad).stdout.trim()).toBe("jit-desktop-lease-invalid-v1");
    if (python.status !== 0) expect(run("http://desktop_x:abc@192.168.5.100:3128").stdout.trim()).toBe("jit-desktop-absent-v1");
  });
  test("a partial or outdated install (no completion marker for the pinned version) counts as absent even with the group (Greptile #455)", () => {
    const group = spawnSync("python3", ["-c", "import grp,os;print(grp.getgrgid(os.getgid()).gr_name)"], { encoding: "utf8" });
    if (group.error || group.status !== 0) return;
    const dir = mkdtempSync(join(tmpdir(), "jit-marker-")), marker = join(dir, "ready-v1"); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    // The runner's own group stands in for `jit-desktop`; the marker path is the only other change.
    const program = qemuDesktopLeaseWriter.replace("'/opt/jit-desktop/ready-v1'", `'${marker}'`).replace("grp.getgrnam('jit-desktop')", `grp.getgrnam('${group.stdout.trim()}')`).replace("d='/etc/jit-desktop'", `d='${join(dir, "etc")}'`);
    const lease = "http://desktop_x:abc@192.168.5.100:3128";
    expect(run(lease, program).stdout.trim()).toBe("jit-desktop-absent-v1");
    writeFileSync(marker, "1.0.0.0\n");
    expect(run(lease, program).stdout.trim()).toBe("jit-desktop-absent-v1");
    writeFileSync(marker, `${qemuDesktopBrowser.version}\n`);
    // Past the marker and group checks the writer reaches its directory checks (not root-owned here), never "absent".
    expect(run(lease, program).stdout.trim()).not.toBe("jit-desktop-absent-v1");
  });
});

describe("guest desktop session program", () => {
  test("pins one archive per architecture by SHA-256 and parses as Python", () => {
    expect(qemuDesktopBrowser.version).toMatch(/^[0-9]+(?:\.[0-9]+){3}$/);
    for (const pin of [qemuDesktopBrowser.x86_64, qemuDesktopBrowser.aarch64]) {
      expect(pin.url.startsWith(`https://storage.googleapis.com/chrome-for-testing-public/${qemuDesktopBrowser.version}/`)).toBe(true);
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(qemuDesktopBrowser.x86_64.sha256).not.toBe(qemuDesktopBrowser.aarch64.sha256);
    const parsed = spawnSync("python3", ["-I", "-c", "import ast,sys;ast.parse(sys.stdin.read());print('ok')"], { input: qemuDesktopProvisioning, encoding: "utf8" });
    if (parsed.error) return;
    expect(parsed.stdout.trim()).toBe("ok");
    // The browser keeps its sandbox and reaches the web only through the loopback forwarder; the session user has no sudo.
    expect(qemuDesktopProvisioning).not.toContain("--no-sandbox");
    expect(qemuDesktopProvisioning).toContain("--proxy-server=http://127.0.0.1:3129");
    expect(qemuDesktopProvisioning).not.toMatch(/sudoers|NOPASSWD/);
    // The completion marker is removed before anything else and written only after the running session is verified.
    const at = (text: string) => qemuDesktopProvisioning.indexOf(text);
    expect(at("os.unlink(R+'/ready-v1')")).toBeGreaterThan(-1); expect(at("os.unlink(R+'/ready-v1')")).toBeLessThan(at("'groupadd'"));
    expect(at("'is-active'")).toBeGreaterThan(at("'enable','--now'")); expect(at("put(R+'/ready-v1'")).toBeGreaterThan(at("if k<3:"));
  });
  test("the loopback forwarder adds the lease's Proxy-Authorization, replacing any the client sent, and refuses without a lease", async () => {
    if (spawnSync("python3", ["-c", "1"]).error) return;
    const forward = /FORWARD=r'''([\s\S]*?)'''/.exec(qemuDesktopProvisioning)![1]!;
    const heads: string[] = [];
    const upstream = createServer(socket => { let head = ""; socket.on("data", b => { head += b.toString("latin1"); if (head.includes("\r\n\r\n")) { heads.push(head); socket.end("HTTP/1.1 200 Connection Established\r\n\r\nok"); } }); });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve)); cleanups.push(() => new Promise<void>(resolve => upstream.close(() => resolve())));
    const free = createServer(); await new Promise<void>(resolve => free.listen(0, "127.0.0.1", resolve));
    const port = (free.address() as { port: number }).port; await new Promise<void>(resolve => free.close(() => resolve()));
    const dir = mkdtempSync(join(tmpdir(), "jit-fwd-")), env = join(dir, "proxy.env"); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(env, "HTTPS_PROXY=http://desktop_x:pw@192.168.5.100:3128\n");
    const code = forward.replace("E='/etc/jit-desktop/proxy.env'", `E='${env}'`).replace("U=('192.168.5.100',3128)", `U=('127.0.0.1',${(upstream.address() as { port: number }).port})`)
      .replace("u.hostname==U[0] and u.port==U[1]", "u.hostname=='192.168.5.100' and u.port==3128").replace("l.bind(('127.0.0.1',3129))", `l.bind(('127.0.0.1',${port}))`);
    const child = spawn("python3", ["-I", "-c", code], { stdio: "ignore" }); cleanups.push(() => { child.kill(); });
    let answer = "";
    for (let i = 0; i < 50 && !answer; i++) { try { answer = await exchange(port, "CONNECT news.example.co.th:443 HTTP/1.1\r\nHost: news.example.co.th:443\r\nProxy-Authorization: Basic Zm9vOmJhcg==\r\n\r\n"); } catch { await Bun.sleep(50); } }
    expect(answer).toContain("200 Connection Established");
    expect(heads).toHaveLength(1); expect(heads[0]!.match(/Proxy-Authorization/g)).toHaveLength(1);
    expect(heads[0]).toContain(`Proxy-Authorization: Basic ${Buffer.from("desktop_x:pw").toString("base64")}\r\n`);
    rmSync(env);
    expect(await exchange(port, "CONNECT news.example.co.th:443 HTTP/1.1\r\n\r\n")).toContain("503");
    expect(heads).toHaveLength(1);
  });
});
