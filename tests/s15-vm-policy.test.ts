import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openPolicyService, type CatalogKind, type PolicyInput, type Ref, type WorkActor } from "../src/s15/policy";
import { VmPolicyIntegration } from "../src/s15/vm/policy";
import { WorkingVmService } from "../src/s15/vm/service";
import { VmStore } from "../src/s15/vm/store";
import { VmSshTransport } from "../src/s15/vm/transport";
import { vmCanonical, vmHash } from "../src/s15/vm/validation";
import type { VmManagement, VmPolicyOperation, VmSession } from "../src/s15/vm/types";
import { openDisclosureService, type RecipientApproval } from '../src/s15/disclosure';

const ref = (id: string): Ref => ({ id, revision: 1, generation: 1 });
const endpoint = { host: "fixture.test", port: 22, user: "jit", identityFile: "/protected/key", knownHostsFile: "/protected/known" };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function setup(privateData = false) {
  const dir = mkdtempSync(join(tmpdir(), "jit-vm-policy-")), store = new VmStore(":memory:");
  store.save({ id: "vm", generation: 1, endpoint, managerId: "manager", state: "ready", networkCheckedAt: 0,
    networkIsolated: true, maxSessions: 2, reason: null, machineIdentity: "fixture", boot: "boot", bindingMac: "52:54:00:12:34:56" });
  const attempts = new Map<string, string>(), generations = new Map<CatalogKind, number>(), proof = {}, sessions: VmSession[] = [], sends: Record<string, unknown>[] = [];
  const source = { ref: ref('private'), resource: ref('computer'), classification: 'business' as const, active: true, ownerReleasable: true }, approvals: RecipientApproval[] = [];
  const disclosure = privateData ? openDisclosureService({ runtime: 's15', path: join(dir, 'disclosure.sqlite'), create: true, installationId: 'vm_policy_fixture', now: () => 1000,
    catalogs: { source: r => r.id === 'private' ? source : null, recipient: r => r.id === 'download' ? { ref: r, active: true } : null, approvals: () => approvals },
    routes: [{ id: 'artifact', kind: 'artifact', resolve: (_w, payload) => (payload as { request: { url: string } }).request.url.startsWith('https://new-download.test/') ? [ref('download')] : null }] }) : null;
  const integration = new VmPolicyIntegration({ store, resource: () => ref("computer"), attemptCurrent: (work, attempt) => attempts.get(work.id) === attempt,
    upperBound: op => ({ attempts: 0, steps: 0, calls: 1, reads: ["setup", "read"].includes(op.kind) ? 1 : 0, outputBytes: op.outputBytes, activeMs: op.timeoutMs, spendMinor: "0" }),
    destination: () => ref("download"), ...(disclosure ? { disclosure: disclosure.acquisition('artifact') } : {}) });
  const catalogs = integration.catalogs({ current: (kind, id) => ({ ref: { id, revision: 1, generation: generations.get(kind) ?? 1 }, active: true }), allows: () => true });
  const policy = openPolicyService({ runtime: "s15", path: join(dir, "policy.sqlite"), create: true, installationId: "vm_policy_fixture", now: () => 1000,
    ownerGeneration: () => 1, verifyOwner: p => p === proof ? { id: "owner", generation: 1, expiresAt: 1_000_000 } : null,
    catalogs: disclosure ? disclosure.catalogs(catalogs) : catalogs,
    adapters: [integration.adapter], reads: integration.reads });
  const owner = policy.owner.authenticate(proof), selection = { route: ref("route"), model: ref("model"), effort: "high" };
  const input: PolicyInput = { purposes: [ref("purpose")], bots: [ref("bot")], resources: [ref("computer")], recipients: [ref("download")], selections: [selection],
    budget: { currency: "USD", startsAt: 0, expiresAt: 1_000_000, concurrency: 2, ceiling: { attempts: 10, steps: 100, calls: 200, reads: 200, outputBytes: 500_000_000, activeMs: 100_000_000, spendMinor: "0" } },
    rules: [{ id: "ordinary_vm", mode: "ordinary", purposes: [ref("purpose")], bots: [ref("bot")], resources: [ref("computer")], recipients: [ref("download")], selections: [selection],
      adapters: [integration.adapter.id], operations: ["vm_write", "vm_shell", "vm_system_admin", "vm_snapshot", "vm_acquire"],
      classes: ["guest_local_admin", "guest_system_admin", "new_egress", ...(privateData ? ['disclosure' as const] : [])], expiresAt: 1_000_000, recurrence: null }], expiresAt: 1_000_000 };
  policy.owner.install(owner, "install", 0, input);
  let serial = 0, snapshots = 0, fetched = 0;
  const port = integration.bind(policy);
  disclosure?.attach(policy);
  const manager: VmManagement = { async inspect() { return { state: "running", identity: "fixture", boot: "boot", cpuCount: 4, memoryBytes: 8388608, diskBytes: 1048576, network: "isolated", nicMac: "52:54:00:12:34:56" }; },
    async stop() {}, async snapshot() { snapshots++; }, async restore() {}, async retireSnapshot() {} };
  class Transport extends VmSshTransport {
    override async control(argv: readonly string[]) { if (argv.some(a => a.includes("nicMacs"))) return '{"nicMacs":["52:54:00:12:34:56"]}'; return '{"reachable":[false,false,false,false,false,false]}'; }
    override async openScope(_unit: string, _ms: number, guard: () => void) { guard(); }
    override async closeScope() { return true; }
    override async invoke(request: Record<string, unknown>, options: Parameters<VmSshTransport["invoke"]>[1]) {
      options.beforeStart(); sends.push(request);
      if (request.op === "read") return { data: Buffer.from("from VM").toString("base64") };
      if (request.op === "spawn" || request.op === "search") return { stdout: Buffer.from(request.op === "spawn" ? "done" : "").toString("base64"), stderr: "", exitCode: 0, timedOut: false, truncated: false, totalBytes: request.op === "spawn" ? 4 : 0 };
      return {};
    }
  }
  const service = new WorkingVmService({ store, policy: port, managers: new Map([["manager", manager]]), transport: () => new Transport(endpoint),
    artifactFetch: async (_input, _signal, options) => { options?.beforeRequest?.(); fetched++; return new Uint8Array(); } });
  const admit = (intent: "inspect" | "execute" = "execute") => {
    const receipt = policy.owner.admit(owner, { requestId: `work_${serial++}`, intent, access: intent === "inspect" ? "read" : "effect", purpose: ref("purpose"), bot: ref("bot"),
      resources: [ref("computer")], recipients: privateData ? [ref('download')] : [], selection, selectionPin: null, expiresAt: 900_000, readLimit: 100 });
    const workId = receipt.work!.id, actor = policy.control.bindWork(workId); attempts.set(workId, "attempt"); return { actor, workId };
  };
  const open = async (intent: "inspect" | "execute" = "execute", mode: "work" | "system" = "work") => {
    const work = admit(intent), session = await service.openAttempt(work.actor, { vmId: "vm", workId: work.workId, attemptId: "attempt", access: intent === "inspect" ? "inspect" : "execute", mode });
    sessions.push(session); return { ...work, session };
  };
  cleanups.push(async () => { await Promise.allSettled(sessions.map(s => s.close())); policy.control.close(); disclosure?.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { policy, owner, store, integration, port, service, sends, admit, open, generations, attempts, disclosure, source, approvals, snapshots: () => snapshots, fetched: () => fetched };
}
function operation(workId: string, kind: VmPolicyOperation["kind"], body: Record<string, unknown>): VmPolicyOperation {
  const operationId = crypto.randomUUID().replaceAll("-", ""), sessionId = "a".repeat(32), root = `/var/lib/jit-work/${workId}/attempt`;
  const payload = vmCanonical({ v: 1, id: operationId, root, tmp: `${root}/.tmp-${sessionId}`, cap: 1024, ...body });
  return { vmId: "vm", generation: 1, sessionId, workId, attemptId: "attempt", operationId, kind, payload, payloadHash: vmHash(payload), timeoutMs: 1000, outputBytes: 1024 };
}

test("real POLICY reserveRead admits inspect setup/read and fences backend mutation", async () => {
  const f = setup(), { session } = await f.open("inspect");
  const chunks = []; for await (const b of session.backend.readFile(`${session.backend.workspaceRoot}/evidence.txt`)) chunks.push(b);
  expect(Buffer.concat(chunks).toString()).toBe("from VM");
  expect(f.policy.control.usage().charged.reads).toBe(2); expect(f.policy.control.usage().unsettled).toBe(0);
  expect(session.definitions.map(t => t.name).sort()).toEqual(["find", "grep", "ls", "read"]);
  await expect(session.backend.spawn({ command: "rm file", cwd: session.backend.workspaceRoot })).rejects.toMatchObject({ code: "vm_inspect_only" });
  expect(f.sends.map(r => r.op)).toEqual(["init", "read"]);
});
test("inspect cannot relabel arbitrary shell as read, and search uses the pinned grep handler", async () => {
  const f = setup(), { actor, workId } = f.admit("inspect");
  await expect(f.port.claim(actor, operation(workId, "read", { op: "spawn", command: "rm file", env: {}, cwd: `/var/lib/jit-work/${workId}/attempt`, timeoutMs: 1000 }))).rejects.toMatchObject({ code: "vm_policy_denied" });
  const opened = await f.open("inspect"); await opened.session.backend.search({ pattern: "hello", path: opened.session.backend.workspaceRoot, cwd: opened.session.backend.workspaceRoot, limit: 10 });
  expect(f.sends.at(-1)?.op).toBe("search"); expect(f.policy.control.usage().charged.reads).toBe(2);
});
test("real POLICY holds system admin without a protected snapshot fence", async () => {
  const f = setup(), { actor, workId } = f.admit();
  const op = operation(workId, "system_admin", { op: "spawn", command: "sudo reboot", cwd: `/var/lib/jit-work/${workId}/attempt`, env: {}, timeoutMs: 1000 });
  await expect(f.port.claim(actor, op)).rejects.toMatchObject({ code: "snapshot_required", status: 423 }); expect(f.sends).toHaveLength(0);
});
test("exclusive automatic snapshot supplies the real protected lineage fence for system admin", async () => {
  const f = setup(), { session } = await f.open("execute", "system");
  expect(f.snapshots()).toBe(1); expect(f.store.registration("vm").generation).toBe(2);
  expect(await session.backend.spawn({ command: "sudo id -u", cwd: session.backend.workspaceRoot })).toMatchObject({ stdout: "done", exitCode: 0 });
  expect(f.policy.control.usage().unsettled).toBe(0);
});
test("automatic snapshot retirement uses a real local-administration claim and preserves three recovery fences", async () => {
  const f = setup();
  for (let i = 0; i < 4; i++) { const { session } = await f.open("execute", "system"); await session.close(); }
  expect(f.snapshots()).toBe(4); expect(f.store.db.query<{ n: number }, []>("SELECT count(*) n FROM vm_snapshots").get()!.n).toBe(3);
  expect(f.policy.control.usage().charged.calls).toBe(9); expect(f.policy.control.usage().unsettled).toBe(0);
});
test("new artifact destination is held by real POLICY before HTTP or guest write", async () => {
  const f = setup(), { actor, session } = await f.open(); const before = f.sends.length;
  await expect(f.service.acquire(actor, session, { url: "https://new-download.test/source.tar", sha256: "a".repeat(64), maxBytes: 1024, path: `${session.backend.workspaceRoot}/source.tar` })).rejects.toMatchObject({ code: "egress_approval_required", status: 423 });
  expect(f.fetched()).toBe(0); expect(f.sends).toHaveLength(before);
});
test.each(["vm", "bot"] as const)("stale %s generation refuses the final guard without dispatch or refund", async kind => {
  const f = setup(), { actor, workId } = f.admit("inspect"), op = operation(workId, "read", { op: "read", path: `/var/lib/jit-work/${workId}/attempt/a` });
  const claim = await f.port.claim(actor, op); let sent = 0;
  if (kind === "vm") { const row = f.store.registration("vm"); row.generation++; f.store.save(row); } else f.generations.set("bot", 2);
  await expect(claim.dispatch(async () => { sent++; return {}; })).rejects.toThrow();
  expect(sent).toBe(0); expect(f.policy.control.usage().charged.reads).toBe(1);
  claim.observe({ id: op.operationId, vmId: "vm", sessionId: op.sessionId, operationId: op.operationId, payloadHash: op.payloadHash, outcome: "not_dispatched", responseHash: null, outputBytes: null, transport: "closed", execution: "unsettled", published: false });
  expect(f.policy.control.usage().unsettled).toBe(0);
});
test("real POLICY refuses copied actors and revoked late publication", async () => {
  const f = setup(), { actor, workId } = f.admit("inspect"), op = operation(workId, "read", { op: "read", path: `/var/lib/jit-work/${workId}/attempt/a` });
  await expect(f.port.claim({} as WorkActor, op)).rejects.toThrow();
  const claim = await f.port.claim(actor, op); await claim.dispatch(async () => ({}));
  claim.observe({ id: op.operationId, vmId: "vm", sessionId: op.sessionId, operationId: op.operationId, payloadHash: op.payloadHash, outcome: "guest_reported", responseHash: "b".repeat(64), outputBytes: 2, transport: "closed", execution: "unsettled", published: false });
  const authority = f.policy.work.guard(actor), payload = { contract: "s15-working-vm-policy/v1", operationId: op.operationId, payloadHash: op.payloadHash, payloadBytes: Buffer.byteLength(op.payload), request: JSON.parse(op.payload) };
  const validate = () => f.integration.reads.find(r => r.operation === "read")!.validate(payload, { work: authority, resource: ref("computer") });
  expect(validate).not.toThrow();
  f.policy.owner.revoke(f.owner, "revoke", { kind: "work", id: workId });
  expect(() => claim.publish(() => "late")).toThrow(); expect(f.policy.control.usage().unsettled).toBe(0);
  expect(validate).toThrow("vm_reconciliation_required");
});

test("large exact guest writes bind all bytes without enlarging the POLICY command limit", async () => {
  const f = setup(), { session } = await f.open(), content = "x".repeat(150000);
  await session.backend.writeFileAtomically(`${session.backend.workspaceRoot}/large.txt`, content);
  expect(Buffer.from(f.sends.at(-1)?.data as string, "base64").toString()).toBe(content); expect(f.policy.control.usage().unsettled).toBe(0);
});
test("real read claims are single-use and retain unknown charged outcomes", async () => {
  const f = setup(), { actor, workId } = f.admit("inspect"), op = operation(workId, "read", { op: "read", path: `/var/lib/jit-work/${workId}/attempt/a` });
  const claim = await f.port.claim(actor, op); let sends = 0;
  await claim.dispatch(async () => { sends++; return {}; });
  await expect(claim.dispatch(async () => { sends++; return {}; })).rejects.toThrow("already_claimed"); expect(sends).toBe(1);
  claim.observe({ id: op.operationId, vmId: "vm", sessionId: op.sessionId, operationId: op.operationId, payloadHash: op.payloadHash, outcome: "unknown", responseHash: null, outputBytes: null, transport: "closed", execution: "unsettled", published: false });
  expect(f.policy.control.usage().charged.reads).toBe(1); expect(f.policy.control.usage().unsettled).toBe(0);
});

test('DATA15 acquisition holds actual URL/query and resumes the same exact action after one approval', async () => {
  const f = setup(true), { actor, session } = await f.open(); f.disclosure!.read(actor, ref('private'));
  const input = { url: 'https://new-download.test/source.tar?query=derived-business-data', sha256: vmHash(new Uint8Array()), maxBytes: 1024, path: `${session.backend.workspaceRoot}/source.tar` };
  let held: import('../src/errors').AppError | null = null;
  try { await f.service.acquire(actor, session, input); } catch (error) { held = error as import('../src/errors').AppError; }
  expect(held?.status).toBe(423); expect(f.fetched()).toBe(0);
  const action = { id: held!.detail!.actionId as string, revision: held!.detail!.revision as number, actionHash: held!.detail!.actionHash as string };
  const slip = f.policy.owner.actionSlip(f.owner, action);
  expect(slip.action.disclosure).toMatchObject({ recipients: [ref('download')], dataClasses: ['business'] });
  expect(slip.action.payload).toMatchObject({ request: input });
  f.policy.owner.decide(f.owner, { requestId: 'approve_acquisition', action, decision: 'approve', expiresAt: 700000 });
  await f.service.acquire(actor, session, input); expect(f.fetched()).toBe(1); expect(f.sends.filter(s => s.op === 'write')).toHaveLength(1);
});

test('DATA15 previously approved acquisition stays usable within captured data and purpose scope', async () => {
  const f = setup(true), { actor, session } = await f.open(); f.disclosure!.read(actor, ref('private'));
  f.approvals.push({ recipient: ref('download'), purpose: ref('purpose'), resources: [ref('computer')], dataClasses: ['business'], sources: [ref('private')], expiresAt: 700000 });
  await f.service.acquire(actor, session, { url: 'https://new-download.test/source.tar', sha256: vmHash(new Uint8Array()), maxBytes: 1024, path: `${session.backend.workspaceRoot}/source.tar` });
  expect(f.fetched()).toBe(1);
});
