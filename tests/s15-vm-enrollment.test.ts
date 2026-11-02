import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VmEnrollment } from "../src/s15/vm/enrollment";
import { VmStore } from "../src/s15/vm/store";
import { vmHostCommand } from "../src/s15/vm/host";
import { createVmApi } from "../src/s15/vm/api";
import type { VmHostCommand, VmManagement } from "../src/s15/vm/types";
const close: (() => void)[] = []; afterEach(() => { for (const fn of close.splice(0)) fn(); });
async function fixture(network: "isolated" | "unproven" = "isolated") {
  const directory = mkdtempSync(join(tmpdir(), "jit-vm-enroll-")), store = new VmStore(":memory:"), owner = {}; close.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let publicKey = "", reachable = false;
  const run: VmHostCommand = async (argv, opts) => {
    if (argv[0] === "ssh-keygen") { const result = await vmHostCommand(argv, opts); publicKey = (await Bun.file(`${argv.at(-1)}.pub`).text()).trim().split(" ").slice(0, 2).join(" "); return result; }
    if (argv[0] === "ssh-keyscan") return { exitCode: 0, stdout: Buffer.from(`vm.test ${publicKey}\n`) };
    opts.beforeStart?.();
    return { exitCode: 0, stdout: Buffer.from(argv.at(-1)?.includes("reachable") ? JSON.stringify({ reachable: [reachable, false, false, false, false, false] }) : "jit-vm-ready-v1\n") };
  };
  const manager: VmManagement = { async inspect() { return { state: "running", identity: "vm", boot: "boot", cpuCount: 4, memoryBytes: 100, diskBytes: 100, network }; }, async stop() {}, async snapshot() {}, async restore() {} };
  const enrollment = new VmEnrollment({ store, keyDirectory: join(directory, "keys"), requireOwner: actor => { if (actor !== owner) throw new Error("not owner"); }, managers: new Map([["manager", manager]]), run });
  const setup = await enrollment.begin(owner);
  return { owner, enrollment, setup, setReachable: () => { reachable = true; } };
}
test("one public-key command + typed address binds observed fingerprint and profile at enrollment", async () => {
  const f = await fixture(); expect(f.setup.command).toContain("restrict ssh-ed25519"); expect(JSON.stringify(f.setup)).not.toContain("PRIVATE KEY");
  const checked = await f.enrollment.checkMachine(f.owner, { setupId: f.setup.setupId, host: "vm.test", port: 22, user: "jit", managerId: "manager" });
  expect(checked.fingerprint).toStartWith("SHA256:");
  await expect(f.enrollment.useMachine(f.owner, { id: "vm", checkId: checked.checkId, fingerprint: "other", transportProfile: checked.transportProfile })).rejects.toMatchObject({ code: "vm_setup_expired" });
  const status = await f.enrollment.useMachine(f.owner, { id: "vm", ...checked }); expect(status.state).toBe("ready"); expect(status.maxSessions).toBe(2);
  expect(status.capabilities.find(c => c.id === "snapshot-recovery")?.state).toBe("unproven");
  expect(JSON.stringify(status)).not.toContain("vm.test"); expect(JSON.stringify(status)).not.toContain("identityFile");
  expect(f.enrollment.setMaxSessions(f.owner, "vm", 3).maxSessions).toBe(3);
});
test.each(["missing firewall proof", "direct egress succeeds"])("network-isolated stays unproven when %s", async reason => {
  const f = await fixture(reason === "missing firewall proof" ? "unproven" : "isolated"); if (reason === "direct egress succeeds") f.setReachable();
  const checked = await f.enrollment.checkMachine(f.owner, { setupId: f.setup.setupId, host: "vm.test", port: 22, user: "jit", managerId: "manager" });
  const status = await f.enrollment.useMachine(f.owner, { id: "vm", ...checked }); expect(status.networkIsolated).toBe(false); expect(status.reason).toBe("vm_network_unproven");
});
test("JSON API rejects extra authority fields and requires the authenticated owner actor", async () => {
  const f = await fixture(), api = createVmApi(f.enrollment, async () => f.owner);
  const extra = await api(new Request("http://localhost/s15/vm/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ setupId: f.setup.setupId, host: "vm.test", port: 22, user: "jit", owner: true }) })); expect(extra.status).toBe(409);
  const foreign = createVmApi(f.enrollment, async () => ({})); expect((await foreign(new Request("http://localhost/s15/vm/status?id=vm"))).status).toBe(503);
});
