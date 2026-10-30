import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHost, hostCapabilities, SNAPSHOT_NATIVE_FORMAT_VERSION, type HostSessionSnapshot } from "schway/host";
import { domainFixture, retryId, routineCommand, secondBot, workCommand, type DomainFixture } from "./fixtures/s14-domain";
import { reconcileOnlineBackups } from "../src/s14/backups";
import { FakeComputerRuntime, barrier } from "./fixtures/s14-computer";
import { createS14Handler } from "../src/s14/web";
import { S14Maintenance, type OpsFault } from "../src/s14/ops";
import { opsHash, opsLedger, credentialFreeImage, opsMainTables, opsLedgerTables, assertOpsTableClassification } from "../src/s14/ops-image";
import { opsRoot } from "../src/s14/ops-state";
import { inspectS14Store, S14Store } from "../src/s14/store";
import { S14Application } from "../src/s14/application";
import type { ManagedBackupManifest, OpsCommand, OpsNativePort } from "../src/s14/ops-types";
import type { NativeIntent } from "../src/s14/recovery-types";
import { nativeIntentPaths } from "../src/s14/native-recovery";
import { schwayOpsNative } from "../src/s14/ops-native";
import { canonical } from "../src/s14/validation";
import { record, save } from "../src/s14/application";
import type { Bot } from "../src/s14/types";

const fixtures: DomainFixture[] = [], maintenance: S14Maintenance[] = [];
afterEach(() => { for (const m of maintenance.splice(0)) m.close(); for (const f of fixtures.splice(0)) f.dispose(); });
async function fixture(options: Parameters<typeof domainFixture>[0] = {}) { const f = await domainFixture(options); fixtures.push(f); return f; }
function fakeNative() {
  const snapshots = new Map<string, HostSessionSnapshot>();
  const stores = new Map<string, Map<string, HostSessionSnapshot>>();
  const controls = { supported: true, partial: false, opens: 0, imports: 0, deletes: 0, retires: 0 };
  const port: OpsNativePort = { supported: () => controls.supported, async open(intent, directory) {
    controls.opens++;
    const map = directory ? stores.get(directory) ?? new Map<string, HostSessionSnapshot>() : snapshots;
    if (directory) stores.set(directory, map);
    return {
      async snapshotSessions() { const snapshot = map.get(intent.id); if (!snapshot) throw Error("missing native"); return structuredClone(snapshot); },
      validateSessionSnapshot(snapshot) {
        const value = snapshot as HostSessionSnapshot;
        return value?.snapshotContract === "schway.host.session-snapshot/v1" && value.nativeFormatVersion === SNAPSHOT_NATIVE_FORMAT_VERSION
          ? { status: "valid", sessions: value.sessions.map(s => ({ id: s.id, branchId: s.branchId })), nextAction: "none" }
          : { status: "quarantined", reason: "corrupt", nextAction: "none" };
      },
      async restoreSessionSnapshot(snapshot) {
        controls.imports++;
        if (controls.partial) return { status: "partial", restored: [], remaining: [], nextAction: "retry" };
        const value = snapshot as HostSessionSnapshot;
        map.set(intent.id, structuredClone(value));
        return { status: "restored", sessions: value.sessions.map(s => ({ id: s.id, branchId: s.branchId })), nextAction: "none" };
      },
      async listSessions() { return { sessions: map.get(intent.id)?.sessions.map(s => ({ reference: { id: s.id, branchId: s.branchId }, state: "retired" as const })) ?? [] }; },
      async retireSession() { controls.retires++; },
      async deleteSession(reference) { controls.deletes++; map.delete(intent.id); return { status: "deleted", session: reference, removed: ["conversation"], nextAction: "none" }; },
      async close() {},
    };
  } };
  return { port, controls, snapshots, stores };
}
function open(f: DomainFixture, port = fakeNative().port, fault?: (point: OpsFault) => void) {
  f.store.close();
  const m = new S14Maintenance(f.path, f.options, port, fault); maintenance.push(m);
  return { m, actor: m.app.authenticate(f.token).actor };
}
function command(m: S14Maintenance, kind: OpsCommand["kind"], payload: object = {}): OpsCommand {
  return { kind, requestId: retryId(), expectedRevision: m.control.revision, payload } as OpsCommand;
}
async function backup(m: S14Maintenance, actor: ReturnType<S14Application["authenticate"]>["actor"]) {
  const receipt = await m.execute(actor, command(m, "backup.create"));
  expect(receipt.state).toBe("complete"); return receipt.backupId!;
}
function archive(f: DomainFixture, id: string) { return join(opsRoot(f.path), "backups", id); }
function seedNative(f: DomainFixture, n: ReturnType<typeof fakeNative>) {
  const packet = f.store.transaction(tx => f.app.memory.assemble(tx, { botId: "jit", conversationId: f.conversationId, purpose: "fixture", sources: [] }));
  const intent = f.app.recovery.intent(null, packet.id, f.options.policy.routes[0]!);
  const reference = { id: crypto.randomUUID(), branchId: "main" };
  f.app.recovery.correlate(intent.id, reference); f.app.recovery.retired(intent.id);
  const bytes = Buffer.from("opaque native fixture without credentials");
  n.snapshots.set(intent.id, { snapshotContract: "schway.host.session-snapshot/v1", nativeFormatVersion: SNAPSHOT_NATIVE_FORMAT_VERSION,
    createdAt: "2026-10-31T00:00:00.000Z", sessions: [{ ...reference, workspaceRoot: "/fixture", headerCreatedAt: "2026-10-31T00:00:00.000Z", nativeFormatVersion: SNAPSHOT_NATIVE_FORMAT_VERSION, retired: true,
      artifacts: [{ kind: "conversation", size: bytes.length, sha256: opsHash(bytes), dataBase64: bytes.toString("base64") }] }] });
  return { intent, packet };
}

test("credential-free backup commits a consistent bounded manifest, state and opaque native snapshot; exact requests dedupe", async () => {
  const f = await fixture(), n = fakeNative(); seedNative(f, n);
  const { m, actor } = open(f, n.port), c = command(m, "backup.create");
  const result = await m.execute(actor, c);
  expect(await m.execute(actor, c)).toEqual(result);
  await expect(m.execute(actor, { ...c, payload: { forbidden: true } } as never)).rejects.toThrow("invalid_shape");
  const directory = archive(f, result.backupId!);
  const manifest = JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")) as ManagedBackupManifest;
  expect(manifest).toMatchObject({ contract: "app.managed-backup/v1", state: "complete", schema: 14, credentials: "excluded_reconnect_required" });
  expect(manifest.native).toHaveLength(1);
  const db = Database.deserialize(readFileSync(join(directory, "application.sqlite")));
  expect(db.query("SELECT password_hash FROM owner").get()).toEqual({ password_hash: "[reconnect]" });
  expect(db.query("SELECT count(*) n FROM sessions").get()).toEqual({ n: 0 });
  expect(db.query("SELECT name FROM sqlite_master WHERE name='withdrawals'").get()).toBeNull();
  db.close();
  expect(n.controls.imports).toBe(0);
  expect(existsSync(join(opsRoot(f.path), "fence.json"))).toBe(false);
});

test("old image reconciles latest deletion, forget, share, Bot and native tombstones before activation; routines and grants never replay", async () => {
  const f = await fixture(), n = fakeNative(), b = await secondBot(f);
  const remember = (text: string) => f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: retryId(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision, payload: { conversationId: f.conversationId, text } }).claim!;
  const deleted = remember("Delete this old private payload"), forgotten = remember("Forget this old preference");
  const shared = f.app.execute(f.auth.actor, { kind: "memory.publish", requestId: retryId(), expectedRevision: 1, payload: { claim: forgotten } }).access!;
  const native = seedNative(f, n);
  const work = f.app.execute(f.auth.actor, workCommand(f));
  const routine = f.app.execute(f.auth.actor, routineCommand(f)).routine;
  let first = open(f, n.port), id = await backup(first.m, first.actor);
  first.m.close();
  f.store = new S14Store(f.path); f.app = new S14Application(f.store, f.options); f.auth = f.app.authenticate(f.token);
  f.app.execute(f.auth.actor, { kind: "memory.delete", requestId: retryId(), expectedRevision: deleted.revision, payload: { claim: deleted } });
  f.app.execute(f.auth.actor, { kind: "memory.forget", requestId: retryId(), expectedRevision: forgotten.revision, payload: { claim: forgotten } });
  const preview = f.app.botLifecycle.preview(f.auth.actor, b.id, "retire");
  f.app.execute(f.auth.actor, { kind: "bot.retire", requestId: retryId(), expectedRevision: preview.bot.revision, payload: { botId: b.id, previewHash: preview.hash, retain: { history: true, evidence: true } } });
  f.store.transaction(tx => tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('native_context',?,'deleted')", native.packet.id));
  first = open(f, n.port);
  const staged = await first.m.execute(first.actor, command(first.m, "restore.prepare", { backupId: id }));
  expect(staged).toMatchObject({ state: "validated", workers: "fenced" });
  expect(() => new S14Store(f.path)).toThrow("s14_ops_reconciliation_required");
  await expect(first.m.execute(first.actor, command(first.m, "restore.activate", { stageId: staged.stage!.id, actionHash: "wrong" }))).rejects.toThrow("s14_ops_stale_cutover");
  const activated = await first.m.execute(first.actor, command(first.m, "restore.activate", { stageId: staged.stage!.id, actionHash: staged.stage!.actionHash }));
  expect(activated.state).toBe("complete");
  const token = await first.m.app.login("domain-fixture-owner-password"), actor = first.m.app.authenticate(token).actor;
  expect(first.m.app.home(actor).bots.find(bot => bot.id === b.id)!.enabled).toBe(false);
  expect(first.m.app.routines.view(actor, routine.id).routine.state).toBe("blocked");
  expect(first.m.app.authority.view(actor, work.work!.id).authority!.revoked).toBe(true);
  const data = first.m.app.memory.inspect(actor, "jit");
  expect(data.claims.filter(c => c.state === "available").some(c => c.state === "available" && (c.claim.id === deleted.id || c.claim.id === forgotten.id))).toBe(false);
  expect(first.m.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE id=?", deleted.id)!.record_json)).not.toContain("Delete this old private payload");
  expect(n.controls.deletes).toBeGreaterThan(0);
  expect(first.m.store.read(opsLedger)).not.toBeNull();
  expect(shared).toBeDefined();
});

test.each(["corruption", "schema", "manifest_version", "traversal", "symlink", "oversize", "missing_native"])("%s refuses before any candidate or active write", async kind => {
  const f = await fixture(), n = fakeNative(); seedNative(f, n);
  const { m, actor } = open(f, n.port), id = await backup(m, actor), directory = archive(f, id);
  const path = join(directory, "manifest.json"), value = JSON.parse(readFileSync(path, "utf8"));
  if (kind === "manifest_version") value.contract = "ops.backup_manifest/v1";
  if (kind === "schema") value.schema = 11;
  if (kind === "traversal") value.image.name = "../../application.sqlite";
  if (kind === "oversize") value.image.size = 64 * 1024 * 1024 + 1;
  if (kind === "corruption") writeFileSync(join(directory, "application.sqlite"), Buffer.alloc(100));
  if (kind === "symlink") { rmSync(join(directory, "application.sqlite")); symlinkSync(f.path, join(directory, "application.sqlite")); }
  if (kind === "missing_native") n.controls.supported = false;
  writeFileSync(path, JSON.stringify(value));
  const before = readFileSync(f.path);
  await expect(m.execute(actor, command(m, "restore.prepare", { backupId: id }))).rejects.toThrow();
  expect(readFileSync(f.path)).toEqual(before);
  expect(existsSync(join(opsRoot(f.path), "stages"))).toBe(false);
  expect(existsSync(join(opsRoot(f.path), "fence.json"))).toBe(false);
});

test.each(["application", "native"])("credential sentinel in %s blocks capture without a complete manifest", async kind => {
  const f = await fixture(), n = fakeNative();
  const sentinel = "sk-proj-OPS14CredentialSentinel1234567890";
  if (kind === "application") f.store.transaction(tx => tx.run("UPDATE installation SET profile_json=?", JSON.stringify({ name: sentinel, language: "en" })));
  else { seedNative(f, n); const snapshot = [...n.snapshots.values()][0]!; const artifact = snapshot.sessions[0]!.artifacts[0]!; Object.assign(artifact, { dataBase64: Buffer.from(sentinel).toString("base64"), size: sentinel.length, sha256: opsHash(sentinel) }); }
  const { m, actor } = open(f, n.port);
  await expect(m.execute(actor, command(m, "backup.create"))).rejects.toThrow("s14_ops_credential_excluded");
  expect(m.control.backups).toEqual([]);
  expect(existsSync(join(opsRoot(f.path), "fence.json"))).toBe(false);
});

test("missing independent ledger cannot be replaced by image metadata", async () => {
  const f = await fixture(), { m, actor } = open(f);
  await backup(m, actor); m.close();
  rmSync(`${f.path}.lifecycle.sqlite`);
  expect(() => new S14Maintenance(f.path, f.options, fakeNative().port)).toThrow("s14_lifecycle_ledger_unavailable");
  expect(existsSync(`${f.path}.lifecycle.sqlite`)).toBe(false);
});

test("partial native import keeps workers fenced and a deterministic retry validates from the original image", async () => {
  const f = await fixture(), n = fakeNative(); seedNative(f, n);
  const { m, actor } = open(f, n.port), id = await backup(m, actor);
  n.controls.partial = true;
  const result = await m.execute(actor, command(m, "restore.prepare", { backupId: id }));
  expect(result).toMatchObject({ state: "partial", workers: "fenced" });
  n.controls.partial = false;
  const retry = await m.execute(actor, command(m, "restore.validate", { stageId: result.stage!.id }));
  expect(retry.state).toBe("validated");
});

test.each(["activation_intent", "application_renamed", "native_pointer_written"] as const)("crash at %s resolves exactly one active image and retains the fence until explicit retry", async point => {
  const f = await fixture(), n = fakeNative();
  let armed = false;
  let { m, actor } = open(f, n.port, at => { if (armed && at === point) throw Error("simulated process crash"); });
  const id = await backup(m, actor);
  const staged = await m.execute(actor, command(m, "restore.prepare", { backupId: id }));
  expect(staged.state).toBe("validated");
  const exact = command(m, "restore.activate", { stageId: staged.stage!.id, actionHash: staged.stage!.actionHash });
  armed = true;
  await expect(m.execute(actor, exact)).rejects.toThrow("simulated process crash");
  m.close();
  expect(() => new S14Store(f.path)).toThrow("s14_ops_reconciliation_required");
  m = new S14Maintenance(f.path, f.options, n.port); maintenance.push(m);
  const token = await m.app.login("domain-fixture-owner-password"); actor = m.app.authenticate(token).actor;
  const resumed = await m.execute(actor, exact);
  expect(resumed.state).toBe("complete");
  expect(inspectS14Store(f.path)).toBe("s14");
  expect(existsSync(join(opsRoot(f.path), "fence.json"))).toBe(false);
  expect(existsSync(join(opsRoot(f.path), "stages", staged.stage!.id, "prior.sqlite"))).toBe(true);
});

test("supported current-schema upgrade has a recovery point and rollback discards only the candidate", async () => {
  const f = await fixture(), { m, actor } = open(f), before = readFileSync(f.path);
  await expect(m.execute(actor, command(m, "upgrade.prepare", { targetSchema: 15 }))).rejects.toThrow("s14_ops_version_unsupported");
  expect(readFileSync(f.path)).toEqual(before);
  const staged = await m.execute(actor, command(m, "upgrade.prepare", { targetSchema: 14 }));
  expect(staged.state).toBe("validated");
  expect(m.control.backups).toContain(staged.stage!.recoveryBackupId);
  const discard = await m.execute(actor, command(m, "upgrade.rollback", { stageId: staged.stage!.id }));
  expect(discard.state).toBe("discarded");
  expect(readFileSync(f.path)).toEqual(before);
});

test("pinned public host captures and restores an opaque retired native session without models or credentials", async () => {
  const f = await fixture(), directory = join(dirname(f.path), "native");
  const intent: NativeIntent = { id: retryId(), attemptId: null, workId: null, grantId: null, botId: "jit", computer: false, contextId: null, route: f.options.policy.routes[0]!, reference: null, state: "retired", discovered: [], mode: "retire", reason: null };
  const paths = nativeIntentPaths(directory, intent);
  const host = await createHost({ ...paths, context: { policy: "strict", systemPrompt: "Snapshot fixture", sections: [] }, tools: { policy: "exact", hostedLookup: "off", definitions: [] }, limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 32768, maxInputChars: 1024, deadlineMs: 1000 } });
  const session = await host.createSession(); intent.reference = session.reference;
  await session.retire(); await session.close();
  const snapshot = await host.snapshotSessions([intent.reference]);
  expect(snapshot.nativeFormatVersion).toBe(SNAPSHOT_NATIVE_FORMAT_VERSION);
  const restoreDirectory = join(f.root, "restored-native");
  const imported = await createHost({ ...paths, sessionDirectory: restoreDirectory, context: { policy: "strict", systemPrompt: "Snapshot fixture", sections: [] }, tools: { policy: "exact", hostedLookup: "off", definitions: [] }, limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 32768, maxInputChars: 1024, deadlineMs: 1000 } });
  expect((await imported.restoreSessionSnapshot(snapshot)).status).toBe("restored");
  expect((await imported.listSessions()).sessions[0]!.state).toBe("retired");
  expect(hostCapabilities().snapshotContract).toBe("schway.host.session-snapshot/v1");
  await imported.close(); await host.close();
  expect(schwayOpsNative(directory).supported()).toBe(true);
});

test("committed application/artifact/native round trip preserves evidence bytes while every old grant remains unusable", async () => {
  const f = await fixture();
  const started = f.app.execute(f.auth.actor, workCommand(f));
  const attempt = f.app.authority.admit(started.work!.id, retryId(), { botId: "jit", tools: [], scopes: [], input: "Evidence fixture", calls: 2, outputBytes: 16384 });
  f.app.authority.commit(attempt.id, { state: "ready", text: "Retained evidence", report: { title: "Retained report", claims: [{ id: "claim", text: "Unverified inference", kind: "inference", citations: [], covers: [], conflicts: [] }], missing: [], limitations: ["Scripted evidence"], artifactIds: [] } });
  const report = f.app.reports.list(f.auth.actor, started.work!.id)[0]!;
  expect(report.state).toBe("available");
  if (report.state !== "available") throw Error("fixture report unavailable");
  const files = report.artifacts.map(artifact => ({ id: artifact.id, bytes: f.app.artifacts.download(f.auth.actor, artifact.id).bytes }));
  const packet = f.store.transaction(tx => f.app.memory.assemble(tx, { botId: "jit", conversationId: f.conversationId, purpose: "Retained native", sources: [] }));
  const intent = f.app.recovery.intent(null, packet.id, f.options.policy.routes[0]!);
  const nativeRoot = join(dirname(f.path), "native");
  const host = await createHost({ ...nativeIntentPaths(nativeRoot, intent), context: { policy: "strict", systemPrompt: "Local fixture only", sections: [] }, tools: { policy: "exact", hostedLookup: "off", definitions: [] }, limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 32768, maxInputChars: 1024, deadlineMs: 1000 } });
  const session = await host.createSession();
  f.app.recovery.correlate(intent.id, session.reference);
  await session.retire(); await session.close(); await host.close(); f.app.recovery.retired(intent.id);
  const { m, actor } = open(f, schwayOpsNative(nativeRoot));
  const id = await backup(m, actor);
  const staged = await m.execute(actor, command(m, "restore.prepare", { backupId: id }));
  expect(staged).toMatchObject({ state: "validated", reason: null });
  await m.execute(actor, command(m, "restore.activate", { stageId: staged.stage!.id, actionHash: staged.stage!.actionHash }));
  const token = await m.app.login("domain-fixture-owner-password"), newActor = m.app.authenticate(token).actor;
  for (const file of files) expect(m.app.artifacts.download(newActor, file.id).bytes).toEqual(file.bytes);
  expect(m.app.authority.view(newActor, started.work!.id).authority!.revoked).toBe(true);
  await expect(Promise.resolve().then(() => m.app.authority.admit(started.work!.id, retryId(), { botId: "jit", tools: [], scopes: [], input: "No replay", calls: 1, outputBytes: 1024 }))).rejects.toThrow("grant_revoked");
  expect(m.app.recovery.view(newActor).native.find(i => i.id === intent.id)!.state).toBe("retired");
});

test.each(["candidate_imported", "candidate_reconciled"] as const)("crash at %s leaves active untouched and validates the immutable image again", async point => {
  const f = await fixture(); let armed = false;
  const { m, actor } = open(f, fakeNative().port, at => { if (armed && point === at) throw Error("injected crash"); });
  const id = await backup(m, actor), before = readFileSync(f.path);
  armed = true;
  try { await m.execute(actor, command(m, "restore.prepare", { backupId: id })); } catch { /* Import can stop before a receipt exists. */ }
  expect(readFileSync(f.path)).toEqual(before);
  expect(existsSync(join(opsRoot(f.path), "fence.json"))).toBe(true);
  armed = false;
  const result = await m.execute(actor, command(m, "restore.validate", { stageId: m.control.stage!.id }));
  expect(result.state).toBe("validated");
});

test.each(["image_captured", "native_captured", "manifest_committed"] as const)("interrupted capture at %s never registers a usable partial backup", async point => {
  const f = await fixture(), { m, actor } = open(f, fakeNative().port, at => { if (point === at) throw Error("injected capture crash"); });
  await expect(m.execute(actor, command(m, "backup.create"))).rejects.toThrow("injected capture crash");
  expect(m.control.backups).toEqual([]);
  expect(existsSync(join(opsRoot(f.path), "fence.json"))).toBe(false);
});

test.each(["source", "artifact"] as const)("revoked %s snapshot shares and deleted Bots stay unavailable after restoring their older image", async kind => {
  const f = await fixture(), receiver = await secondBot(f);
  const source = f.store.transaction(tx => f.app.memory.source(tx, { id: retryId(), botId: "jit", conversationId: f.conversationId, attribution: "owner", text: "Share only this immutable evidence", derived: [] }));
  let target: { kind: "source" | "artifact"; id: string; revision: number; generation: number } = { kind: "source", id: source.id, revision: 1, generation: 1 };
  if (kind === "artifact") {
    const work = f.app.execute(f.auth.actor, workCommand(f)).work!;
    const attempt = f.app.authority.admit(work.id, retryId(), { botId: "jit", tools: [], scopes: [], input: "Artifact fixture", calls: 2, outputBytes: 16384 });
    f.app.authority.commit(attempt.id, { state: "ready", text: "Delivered artifact", report: { title: "Share artifact", claims: [{ id: "inference", text: "Fixture evidence", kind: "inference", citations: [], covers: [], conflicts: [] }], missing: [], limitations: ["Fixture"], artifactIds: [] } });
    const report = f.app.reports.list(f.auth.actor, work.id)[0]!;
    if (report.state !== "available") throw Error("missing report");
    target = { kind: "artifact", id: report.artifacts[0]!.id, revision: 1, generation: 1 };
  }
  const share = f.app.execute(f.auth.actor, { kind: "snapshot.share", requestId: retryId(), expectedRevision: receiver.revision, payload: { scopeId: "share1", target, receiverBotId: receiver.id, workId: null, expiresAt: f.clock.now + 60000 } }).share;
  let { m, actor } = open(f), id = await backup(m, actor); m.close();
  f.store = new S14Store(f.path); f.app = new S14Application(f.store, f.options); f.auth = f.app.authenticate(f.token);
  f.app.execute(f.auth.actor, { kind: "snapshot.revoke", requestId: retryId(), expectedRevision: share.revision, payload: { shareId: share.id } });
  const preview = f.app.botLifecycle.preview(f.auth.actor, receiver.id, "delete");
  f.app.execute(f.auth.actor, { kind: "bot.delete", requestId: retryId(), expectedRevision: receiver.revision, payload: { botId: receiver.id, previewHash: preview.hash } });
  ({ m, actor } = open(f));
  const staged = await m.execute(actor, command(m, "restore.prepare", { backupId: id }));
  expect(staged).toMatchObject({ state: "validated", reason: null });
  await m.execute(actor, command(m, "restore.activate", { stageId: staged.stage!.id, actionHash: staged.stage!.actionHash }));
  actor = m.app.authenticate(await m.app.login("domain-fixture-owner-password")).actor;
  expect(m.app.sharing.list(actor)[0]!.state).toBe("revoked");
  expect(m.app.botLifecycle.view(actor, receiver.id).lifecycle.state).toBe("deleted");
  expect(m.store.read(tx => tx.get<{ content: Uint8Array | null }>("SELECT content FROM snapshot_shares WHERE id=?", share.id)!.content)).toBeNull();
});

test("owner authentication, exclusive runtime lock, unknown versions and active transports fail before capture", async () => {
  const f = await fixture(), { m, actor } = open(f);
  expect(() => new S14Maintenance(f.path, f.options, fakeNative().port)).toThrow("s14_runtime_already_open");
  await expect(m.execute({ ownerId: "owner" }, command(m, "backup.create"))).rejects.toThrow("authentication_required");
  const posted = m.app.execute(actor, { kind: "message.post", requestId: retryId(), expectedRevision: m.app.conversation(actor, f.conversationId).conversation.revision, payload: { conversationId: f.conversationId, text: "Queued fixture" } });
  m.store.transaction(tx => tx.run("INSERT INTO reply_transports VALUES (?,NULL,1)", posted.reply!.id));
  await expect(m.execute(actor, command(m, "backup.create"))).rejects.toThrow("s14_ops_quiesce_required");
  expect(m.control.backups).toEqual([]);
  expect(existsSync(join(opsRoot(f.path), "fence.json"))).toBe(false);
});

test("HTTP exposes authenticated metadata only and never starts maintenance on a query", async () => {
  const f = await fixture();
  const { createS14Handler } = await import("../src/s14/web");
  const handler = createS14Handler(f.app, "http://localhost:3001");
  expect((await handler(new Request("http://localhost:3001/api/s14/ops"))).status).toBe(401);
  const response = await handler(new Request("http://localhost:3001/api/s14/ops", { headers: { cookie: `jit_s14=${f.token}` } }));
  expect(await response.json()).toEqual({ revision: 0, backups: [], stage: null, maintenance: "offline_required", workers: "running", backup: { revision: 0, latest: null, retention: { limit: 9, count: 0, automatic: "oldest_online_only", protected: [] } } });
  expect(existsSync(opsRoot(f.path))).toBe(false);
});


test("unknown effect claims and independent reservation high-water marks survive a stale image without any send", async () => {
  const f = await fixture();
  f.options.policy.tools.push("effect_send"); f.app.policy.tools.push("effect_send");
  f.store.transaction(tx => { const bot = record<Bot>(tx, "bots", "jit"); bot.capabilities.tools.push("effect_send"); save(tx, "bots", bot); });
  const started = f.app.execute(f.auth.actor, workCommand(f, { tools: ["effect_send"] }));
  const attempt = f.app.authority.admit(started.work!.id, retryId(), { botId: "jit", tools: ["effect_send"], scopes: [], input: "Exact held fixture", calls: 2, outputBytes: 4096 });
  const effect = f.app.authority.proposeEffect(attempt.id, retryId(), { kind: "send", destination: "fixture", content: "Held only" }, f.clock.now + 30000);
  f.app.authority.settle(attempt.id);
  const { m, actor } = open(f), id = await backup(m, actor);
  m.store.transaction(tx => {
    tx.run("INSERT INTO lifecycle.withdrawals VALUES ('effect_claim',?,'revision_1')", effect.id);
    tx.run("UPDATE lifecycle.grant_usage SET calls=calls+2,reads=reads+3 WHERE grant_id=?", started.grant!.id);
  });
  const staged = await m.execute(actor, command(m, "restore.prepare", { backupId: id }));
  expect(staged.state).toBe("validated");
  await m.execute(actor, command(m, "restore.activate", { stageId: staged.stage!.id, actionHash: staged.stage!.actionHash }));
  const fresh = m.app.authenticate(await m.app.login("domain-fixture-owner-password")).actor;
  expect(m.app.authority.effect(fresh, effect.id).effect.state).toBe("unknown");
  const usage = m.app.authority.view(fresh, started.work!.id).reservations!;
  expect(usage.calls).toBeGreaterThanOrEqual(3); expect(usage.reads).toBeGreaterThanOrEqual(3);
  await m.app.authority.drain();
  expect(m.app.authority.effect(fresh, effect.id).effect.state).toBe("unknown");
});

test.each(["legacy", "newer"])("%s application refuses before a lock, control root or database write", async kind => {
  const f = await fixture(); f.store.close();
  const bytes = readFileSync(f.path);
  if (kind === "legacy") bytes.writeUInt32BE(0, 68); else bytes.writeUInt32BE(999, 60);
  writeFileSync(f.path, bytes);
  const before = readdirSync(f.root).sort();
  expect(() => new S14Maintenance(f.path, f.options, fakeNative().port)).toThrow("s14_fresh_state_required");
  expect(readFileSync(f.path)).toEqual(bytes); expect(readdirSync(f.root).sort()).toEqual(before);
});

test("post-activation rollback uses quarantine and applies deletions committed after the first cutover", async () => {
  const f = await fixture();
  const claim = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: retryId(), expectedRevision: 1, payload: { conversationId: f.conversationId, text: "Must remain deleted through rollback" } }).claim!;
  const { m, actor } = open(f), id = await backup(m, actor);
  const first = await m.execute(actor, command(m, "restore.prepare", { backupId: id }));
  await m.execute(actor, command(m, "restore.activate", { stageId: first.stage!.id, actionHash: first.stage!.actionHash }));
  const fresh = m.app.authenticate(await m.app.login("domain-fixture-owner-password")).actor;
  m.app.execute(fresh, { kind: "memory.delete", requestId: retryId(), expectedRevision: claim.revision, payload: { claim } });
  const rollback = await m.execute(fresh, command(m, "restore.prepare", { backupId: first.stage!.recoveryBackupId }));
  expect(rollback.state).toBe("validated");
  await m.execute(fresh, command(m, "restore.activate", { stageId: rollback.stage!.id, actionHash: rollback.stage!.actionHash }));
  expect(m.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE id=?", claim.id)!.record_json)).not.toContain("Must remain deleted through rollback");
});

test("a real killed capture leaves no committed manifest receipt and an owner can discard only its orphan", async () => {
  const f = await fixture(); f.store.close();
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/s14-ops-crash.ts")], {
    stdin: new Blob([JSON.stringify({ path: f.path, token: f.token, point: "manifest_committed", command: { kind: "backup.create", requestId: retryId(), expectedRevision: 0, payload: {} }, options: { policy: f.options.policy }, now: f.clock.now })]), stdout: "pipe", stderr: "pipe",
  });
  expect(await child.exited).not.toBe(0);
  const { m, actor } = open(f);
  expect(m.control.backups).toEqual([]);
  const pending = m.status(actor).pendingBackupId!;
  expect(pending).toMatch(/^[a-f0-9]{32}$/);
  expect(() => new S14Store(f.path)).toThrow("s14_ops_reconciliation_required");
  expect((await m.execute(actor, command(m, "restore.discard", { stageId: pending }))).state).toBe("discarded");
  expect(existsSync(archive(f, pending))).toBe(false);
});

test("a real killed cutover resumes the target generation after owner reauthentication", async () => {
  const f = await fixture(); let { m, actor } = open(f);
  const id = await backup(m, actor), stage = await m.execute(actor, command(m, "restore.prepare", { backupId: id }));
  const activate = command(m, "restore.activate", { stageId: stage.stage!.id, actionHash: stage.stage!.actionHash });
  m.close();
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/s14-ops-crash.ts")], {
    stdin: new Blob([JSON.stringify({ path: f.path, token: f.token, point: "application_renamed", command: activate, options: { policy: f.options.policy }, now: f.clock.now })]), stdout: "pipe", stderr: "pipe",
  });
  expect(await child.exited).not.toBe(0);
  expect(() => new S14Store(f.path)).toThrow("s14_ops_reconciliation_required");
  m = new S14Maintenance(f.path, f.options, fakeNative().port); maintenance.push(m);
  actor = m.app.authenticate(await m.app.login("domain-fixture-owner-password")).actor;
  expect((await m.execute(actor, activate)).state).toBe("complete");
});

test("native corruption after validation refuses the exact cutover and leaves the active image intact", async () => {
  const f = await fixture(), n = fakeNative(); seedNative(f, n);
  const { m, actor } = open(f, n.port), id = await backup(m, actor);
  const staged = await m.execute(actor, command(m, "restore.prepare", { backupId: id })), before = readFileSync(f.path);
  const snapshot = [...n.stores.get(m.control.stage!.nativeDirectory)!.values()][0]!;
  Object.assign(snapshot.sessions[0]!.artifacts[0]!, { dataBase64: Buffer.from("changed native bytes").toString("base64") });
  await expect(m.execute(actor, command(m, "restore.activate", { stageId: staged.stage!.id, actionHash: staged.stage!.actionHash }))).rejects.toThrow("s14_ops_native_integrity_changed");
  expect(readFileSync(f.path)).toEqual(before);
  expect(existsSync(join(opsRoot(f.path), "fence.json"))).toBe(true);
});

test("the receipt bound reserves a terminal slot so retry exhaustion cannot strand a quarantined installation", async () => {
  const f = await fixture(), { m, actor } = open(f), id = await backup(m, actor);
  const stage = await m.execute(actor, command(m, "restore.prepare", { backupId: id }));
  while (m.control.receipts.length < 99) {
    const receipt = m.control.receipts[0]!;
    m.control.receipts.push({ ...structuredClone(receipt), requestId: retryId() });
  }
  await expect(m.execute(actor, command(m, "restore.validate", { stageId: stage.stage!.id }))).rejects.toThrow("s14_ops_receipt_bound");
  expect((await m.execute(actor, command(m, "restore.discard", { stageId: stage.stage!.id }))).state).toBe("discarded");
  expect(existsSync(join(opsRoot(f.path), "fence.json"))).toBe(false);
});

test("every actual application and independent ledger table has exactly one backup classification", async () => {
  const f = await fixture();
  const classified = [...opsMainTables.retained, ...opsMainTables.excluded, ...opsMainTables.redacted];
  expect(new Set(classified).size).toBe(classified.length);
  expect(f.store.read(tx => tx.all<{ name: string }>("SELECT name FROM main.sqlite_master WHERE type='table' ORDER BY name").map(row => row.name))).toEqual(classified.sort());
  expect(f.store.read(tx => tx.all<{ name: string }>("SELECT name FROM lifecycle.sqlite_master WHERE type='table' ORDER BY name").map(row => row.name))).toEqual([...opsLedgerTables].sort());
  expect(() => f.store.read(assertOpsTableClassification)).not.toThrow();
});

test.each(["main", "lifecycle"])("an unclassified new %s table fails closed even when empty", async schema => {
  const f = await fixture();
  f.store.transaction(tx => tx.run(`CREATE TABLE ${schema}.future_state (id TEXT PRIMARY KEY)`));
  expect(() => credentialFreeImage(f.store)).toThrow("s14_ops_unclassified_table");
});

test("online owner backup has readable bounded progress, excludes concurrent writers and never starts queued work", async () => {
  const n = fakeNative(), entered = barrier();
  const original = n.port.open;
  n.port.open = async (...args) => { await entered.wait(); return original(...args); };
  let runs = 0;
  const f = await fixture({ backups: n.port, authority: { executor: { async run() { runs++; return { state: "ready", text: "New work" }; } } } });
  seedNative(f, n);
  const alreadyOpen = new S14Store(f.path);
  const work = f.app.execute(f.auth.actor, workCommand(f));
  const c = { kind: "backup.create" as const, requestId: retryId(), expectedRevision: 0, payload: {} };
  const result = f.app.backups.execute(f.auth.actor, c);
  expect(result).toMatchObject({ state: "capturing", workers: "paused", progress: { completed: 0 } });
  await entered.reached;
  expect(f.app.backups.execute(f.auth.actor, c).backupId).toBe(result.backupId);
  expect(f.app.backups.status(f.auth.actor).latest!.progress).toMatchObject({ phase: "native", total: 1, completed: 0 });
  expect(f.app.home(f.auth.actor).owner!.name).toBe("Owner");
  expect(() => f.app.backups.execute(f.auth.actor, { ...c, expectedRevision: 1 })).toThrow("request_id_conflict");
  expect(() => f.app.backups.execute(f.auth.actor, { ...c, requestId: retryId() })).toThrow("s14_backup_in_progress");
  expect(() => f.app.execute(f.auth.actor, workCommand(f))).toThrow("s14_backup_in_progress");
  expect(() => new S14Store(f.path)).toThrow("s14_backup_in_progress");
  expect(() => alreadyOpen.transaction(tx => tx.run("UPDATE installation SET revision=revision+1"))).toThrow("s14_backup_in_progress");
  alreadyOpen.close();
  await f.app.authority.drain(); await f.app.drainReplies(); f.app.routines.tick(); await f.app.attention.drain();
  expect(runs).toBe(0);
  expect(f.app.authority.view(f.auth.actor, work.work!.id).attempts).toEqual([]);
  entered.release(); await f.app.backups.settle();
  const completed = f.app.backups.receipt(f.auth.actor, c.requestId);
  expect(completed).toMatchObject({ state: "complete", reason: null, workers: "running", progress: { phase: "complete", completed: 1, total: 1 } });
  expect(f.app.backups.execute(f.auth.actor, c)).toEqual(completed);
  expect(n.controls.opens).toBe(1);
  expect(() => f.store.transaction(() => {})).not.toThrow();
  expect(JSON.stringify(completed)).not.toContain(f.root);
});

test("production workers stay behind the initial boot barrier and native close, before any routine admission", async () => {
  let runs = 0;
  const n = fakeNative(), closing = barrier(), original = n.port.open;
  const f = await fixture({ requireBootReconciliation: true, backups: n.port, authority: { executor: { async run() { runs++; return { state: "ready", text: "Post-reconciliation evidence" }; } } } });
  seedNative(f, n);
  f.app.execute(f.auth.actor, routineCommand(f)); f.clock.now += 60000;
  const drains = async () => { f.app.routines.tick(); await f.app.authority.drain(); await f.app.drainReplies(); await f.app.attention.drain(); await f.app.computers.drain(); };
  await drains();
  expect(f.app.authority.list(f.auth.actor)).toEqual([]);
  n.port.open = async (...args) => { const host = await original(...args); return { ...host, async close() { await closing.wait(); } }; };
  const boot = f.app.recovery.boot(n.port); await closing.reached;
  await drains(); expect(runs).toBe(0); expect(f.app.authority.list(f.auth.actor)).toEqual([]);
  closing.release(); await boot; await drains();
  expect(runs).toBeGreaterThan(0);
});

test("JSON and no-script backup ingress enforce owner, Host/Origin/CSRF and exact payload; restore stays offline", async () => {
  const n = fakeNative(), f = await fixture({ backups: n.port }), handler = createS14Handler(f.app, "http://localhost:3001");
  const c = { kind: "backup.create", requestId: retryId(), expectedRevision: 0, payload: {} };
  const post = (command: object, extra: Record<string, string> = {}, path = "/api/s14/commands") => handler(new Request(`http://localhost:3001${path}`, { method: "POST", headers: {
    cookie: `jit_s14=${f.token}`, origin: "http://localhost:3001", "content-type": "application/json", "x-csrf-token": f.auth.csrf, ...extra }, body: JSON.stringify(command) }));
  expect((await post(c, { cookie: "" })).status).toBe(401);
  expect((await post(c, { origin: "https://other.test" })).status).toBe(403);
  expect((await post(c, { host: "other.test" })).status).toBe(403);
  expect((await post(c, { "x-csrf-token": "wrong" })).status).toBe(403);
  expect((await post({ ...c, payload: { path: f.path } })).status).toBe(400);
  expect((await post({ ...c, kind: "restore.prepare", payload: { backupId: retryId() } })).status).toBe(409);
  expect(() => f.app.backups.execute({ ownerId: "owner" }, c as never)).toThrow("authentication_required");
  const response = await post(c);
  expect(response.status).toBe(202);
  expect(response.headers.get("cache-control")).toContain("no-store");
  await f.app.backups.settle();
  const retry = await handler(new Request("http://localhost:3001/s14/commands", { method: "POST", headers: { cookie: `jit_s14=${f.token}`, origin: "http://localhost:3001", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: f.auth.csrf, command: JSON.stringify(c) }) }));
  expect(retry.status).toBe(202);
  expect((await retry.json()).state).toBe("complete");
  const receipt = await handler(new Request(`http://localhost:3001/api/s14/backup-receipts/${c.requestId}`, { headers: { cookie: `jit_s14=${f.token}` } }));
  expect((await receipt.json()).state).toBe("complete");
  expect(f.app.backups.status(f.auth.actor).retention.count).toBe(1);
});

test("online capture timeout waits for actual native settlement and then leaves no usable partial image", async () => {
  const n = fakeNative(), entered = barrier(), original = n.port.open;
  n.port.open = async (...args) => { await entered.wait(); return original(...args); };
  const f = await fixture({ backups: n.port }); seedNative(f, n);
  const c = { kind: "backup.create" as const, requestId: retryId(), expectedRevision: 0, payload: {} };
  f.app.backups.execute(f.auth.actor, c); await entered.reached;
  f.clock.now += 60001;
  expect(f.app.backups.busy).toBe(true);
  expect(() => f.store.transaction(() => {})).toThrow("s14_backup_in_progress");
  entered.release(); await f.app.backups.settle();
  expect(f.app.backups.receipt(f.auth.actor, c.requestId)).toMatchObject({ state: "blocked", reason: "s14_backup_deadline_exceeded" });
  expect(f.app.backups.status(f.auth.actor).retention.count).toBe(0);
  expect(existsSync(join(opsRoot(f.path), "capture.json"))).toBe(false);
});

test("online native close failure keeps workers fenced and excludes transport text until exclusive boot", async () => {
  const n = fakeNative(), original = n.port.open;
  n.port.open = async (...args) => { const host = await original(...args); return { ...host, async close() { throw Error("private-close-error-text"); } }; };
  const f = await fixture({ backups: n.port }); seedNative(f, n);
  const c = { kind: "backup.create" as const, requestId: retryId(), expectedRevision: 0, payload: {} };
  f.app.backups.execute(f.auth.actor, c); await f.app.backups.settle();
  expect(f.app.backups.receipt(f.auth.actor, c.requestId)).toMatchObject({ state: "blocked", reason: "s14_ops_native_close_unresolved", workers: "paused" });
  expect(f.app.backups.busy).toBe(true);
  expect(() => f.store.transaction(() => {})).toThrow("s14_backup_in_progress");
  expect(readFileSync(join(opsRoot(f.path), "online-backups.json"), "utf8")).not.toContain("private-close-error-text");
  f.store.close(); reconcileOnlineBackups(f.path); n.port.open = original;
  f.store = new S14Store(f.path); f.app = new S14Application(f.store, f.options); f.auth = f.app.authenticate(f.token);
  await f.app.recovery.boot(n.port);
  expect(f.app.backups.busy).toBe(false);
  expect(f.app.backups.receipt(f.auth.actor, c.requestId).workers).toBe("running");
  f.store.close();
});

test("online retention rotates its oldest image after commit and preserves offline recovery points", async () => {
  const n = fakeNative(), f = await fixture({ backups: n.port });
  const { m, actor } = open(f, n.port), protectedId = await backup(m, actor); m.close();
  f.store = new S14Store(f.path); f.app = new S14Application(f.store, f.options); f.auth = f.app.authenticate(f.token);
  const ids: string[] = [];
  for (let revision = 0; revision < 11; revision++) {
    const result = f.app.backups.execute(f.auth.actor, { kind: "backup.create", requestId: retryId(), expectedRevision: revision, payload: {} });
    ids.push(result.backupId); await f.app.backups.settle();
  }
  expect(f.app.backups.status(f.auth.actor).retention).toMatchObject({ count: 9, protected: [protectedId] });
  expect(existsSync(archive(f, protectedId))).toBe(true);
  expect(existsSync(archive(f, ids[0]!))).toBe(false);
  expect(existsSync(archive(f, ids[1]!))).toBe(false);
  expect(existsSync(archive(f, ids.at(-1)!))).toBe(true);
  expect(readdirSync(join(opsRoot(f.path), "backups"))).toHaveLength(9);
});

test("boot resolves interrupted online capture before opening the store or starting workers", async () => {
  const n = fakeNative(), f = await fixture({ backups: n.port });
  const c = { kind: "backup.create" as const, requestId: retryId(), expectedRevision: 0, payload: {} };
  const result = f.app.backups.execute(f.auth.actor, c); await f.app.backups.settle();
  const path = join(opsRoot(f.path), "online-backups.json"), control = JSON.parse(readFileSync(path, "utf8"));
  control.requests[0].result.state = "capturing";
  writeFileSync(path, JSON.stringify(control));
  writeFileSync(join(opsRoot(f.path), "capture.json"), JSON.stringify({ contract: "app.managed-backup/v1", requestId: c.requestId, backupId: result.backupId }));
  f.store.close();
  expect(() => new S14Store(f.path)).toThrow("s14_backup_in_progress");
  reconcileOnlineBackups(f.path);
  f.store = new S14Store(f.path); f.app = new S14Application(f.store, f.options); f.auth = f.app.authenticate(f.token);
  expect(f.app.backups.receipt(f.auth.actor, c.requestId).state).toBe("complete");
  // The registry, not a manifest-shaped orphan, is the commit point.
  control.requests[0].result.state = "capturing";
  const registryPath = join(opsRoot(f.path), "control.json"), registry = JSON.parse(readFileSync(registryPath, "utf8"));
  registry.backups = []; writeFileSync(registryPath, JSON.stringify(registry)); writeFileSync(path, JSON.stringify(control));
  f.store.close(); reconcileOnlineBackups(f.path);
  f.store = new S14Store(f.path); f.app = new S14Application(f.store, f.options); f.auth = f.app.authenticate(f.token);
  expect(f.app.backups.receipt(f.auth.actor, c.requestId)).toMatchObject({ state: "blocked", reason: "s14_backup_interrupted_no_auto_retry" });
  expect(existsSync(archive(f, result.backupId))).toBe(false);
});

test.each(["retained", "forgotten", "access_revoked"] as const)("restore keeps retired report evidence and original access/producer lineage; %s remains effective", async mode => {
  const f = await fixture(), b = await secondBot(f);
  const conversationId = f.app.home(f.auth.actor).conversations.find(c => c.botId === b.id)!.id;
  const claim = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: retryId(), expectedRevision: f.app.conversation(f.auth.actor, conversationId).conversation.revision,
    payload: { conversationId, text: "Original private retained evidence" } }).claim!;
  const access = f.app.execute(f.auth.actor, { kind: "memory.publish", requestId: retryId(), expectedRevision: 1, payload: { claim } }).access!;
  const start = workCommand(f, { conversationId, bots: [{ id: b.id, revision: b.revision }] });
  start.expectedRevision = f.app.conversation(f.auth.actor, conversationId).conversation.revision;
  const work = f.app.execute(f.auth.actor, start).work!;
  const attempt = f.app.authority.admit(work.id, retryId(), { botId: b.id, tools: [], scopes: [], input: "Retained evidence", calls: 2, outputBytes: 16384 });
  f.app.authority.commit(attempt.id, { state: "ready", text: "Derived retained evidence", report: { title: "Retained report", claims: [{ id: "inference", text: "Owner review", kind: "inference", citations: [], covers: [], conflicts: [] }], missing: [], limitations: ["Fixture"], artifactIds: [] } });
  const report = f.app.reports.list(f.auth.actor, work.id)[0]!;
  if (report.state !== "available") throw Error("missing report");
  f.app.execute(f.auth.actor, { kind: "report.review.accept", requestId: retryId(), expectedRevision: f.app.reports.review(f.auth.actor, work.id).revision,
    payload: { reportId: report.report.id, reportRevision: report.report.revision } });
  let { m, actor } = open(f), id = await backup(m, actor); m.close();
  f.store = new S14Store(f.path); f.app = new S14Application(f.store, f.options); f.auth = f.app.authenticate(f.token);
  const preview = f.app.botLifecycle.preview(f.auth.actor, b.id, "retire");
  f.app.execute(f.auth.actor, { kind: "bot.retire", requestId: retryId(), expectedRevision: preview.bot.revision, payload: { botId: b.id, previewHash: preview.hash, retain: { history: true, evidence: true } } });
  if (mode === "forgotten") f.app.execute(f.auth.actor, { kind: "memory.forget", requestId: retryId(), expectedRevision: claim.revision, payload: { claim } });
  if (mode === "access_revoked") f.app.execute(f.auth.actor, { kind: "memory.revoke", requestId: retryId(), expectedRevision: access.revision, payload: { claim } });
  ({ m, actor } = open(f));
  const staged = await m.execute(actor, command(m, "restore.prepare", { backupId: id }));
  expect(staged).toMatchObject({ state: "validated", reason: null });
  await m.execute(actor, command(m, "restore.activate", { stageId: staged.stage!.id, actionHash: staged.stage!.actionHash }));
  actor = m.app.authenticate(await m.app.login("domain-fixture-owner-password")).actor;
  expect(m.app.botLifecycle.view(actor, b.id).lifecycle.state).toBe("retired");
  expect(m.store.read(tx => tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='retained_evidence' AND id=?", attempt.id))).not.toBeNull();
  expect(m.app.reports.list(actor, work.id)[0]!.state).toBe(mode === "retained" ? "available" : "unavailable");
  expect(m.app.reports.review(actor, work.id).completion).toBe(mode === "retained" ? "owner_accepted" : "owner_review_required");
  expect(m.app.authority.view(actor, work.id).authority!.revoked).toBe(true);
});

test("setup capability files, native credentials, website profiles and sign-in receipts never become backup authority", async () => {
  const n = fakeNative(), f = await fixture({ backups: n.port });
  const secret = "sk-proj-BackupExcludedSentinel1234567890";
  for (const directory of [join(f.root, "native", "home"), join(f.root, "browser-profile")]) {
    mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, "secret"), secret);
  }
  const setupToken = "a".repeat(64);
  writeFileSync(`${f.path}.owner-setup.json`, JSON.stringify({ hash: opsHash(setupToken), expiresAt: f.clock.now + 60000 }), { mode: 0o600 });
  f.store.transaction(tx => tx.run("INSERT INTO command_receipts VALUES ('owner',?,?,?,?)", retryId(), opsHash("sign-in"), JSON.stringify({ kind: "setup.sign_in", approval: secret }), f.clock.now));
  const receipt = f.app.backups.execute(f.auth.actor, { kind: "backup.create", requestId: retryId(), expectedRevision: 0, payload: {} });
  await f.app.backups.settle();
  const directory = archive(f, receipt.backupId);
  expect(readdirSync(directory).sort()).toEqual(["application.sqlite", "manifest.json"]);
  for (const file of readdirSync(directory)) {
    const bytes = readFileSync(join(directory, file)).toString();
    expect(bytes).not.toContain(secret); expect(bytes).not.toContain(setupToken); expect(bytes).not.toContain(opsHash(setupToken));
  }
  const { m, actor } = open(f, n.port);
  const stage = await m.execute(actor, command(m, "restore.prepare", { backupId: receipt.backupId }));
  expect(stage.state).toBe("validated");
  await m.execute(actor, command(m, "restore.activate", { stageId: stage.stage!.id, actionHash: stage.stage!.actionHash }));
  expect(() => m.app.checkOwnerSetup(setupToken)).toThrow("owner_setup_link_invalid");
  expect(m.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM command_receipts")!.n)).toBe(0);
});

test("restore consumes current routine high-water marks and attention send claims without dispatching either again", async () => {
  let sends = 0;
  const f = await fixture({ attention: { async send() { sends++; return "sent"; } } });
  const routine = f.app.execute(f.auth.actor, routineCommand(f)).routine;
  f.store.transaction(tx => f.app.attention.commit(tx, { groupId: retryId(), class: "needs_owner", reason: "owner_decision", workId: null, proposalIds: [] }));
  let { m, actor } = open(f), id = await backup(m, actor); m.close();
  f.store = new S14Store(f.path); f.app = new S14Application(f.store, f.options); f.auth = f.app.authenticate(f.token);
  f.clock.now += 60000; f.app.routines.tick(); await f.app.attention.drain(); expect(sends).toBe(1);
  ({ m, actor } = open(f));
  const stage = await m.execute(actor, command(m, "restore.prepare", { backupId: id }));
  expect(stage.state).toBe("validated");
  await m.execute(actor, command(m, "restore.activate", { stageId: stage.stage!.id, actionHash: stage.stage!.actionHash }));
  actor = m.app.authenticate(await m.app.login("domain-fixture-owner-password")).actor;
  expect(m.app.routines.view(actor, routine.id).routine).toMatchObject({ state: "blocked", occurrencesRemaining: 2 });
  expect(m.app.attention.view(actor).items[0]).toMatchObject({ state: "unknown", retriesRemaining: 0 });
  m.app.routines.tick(); await m.app.attention.drain(); expect(sends).toBe(1);
  expect(m.app.routines.view(actor, routine.id).history).toEqual([]);
});

test.each(["reset", "delete"] as const)("restore preserves current computer %s identities and old activity without starting old volumes", async mode => {
  const runtime = new FakeComputerRuntime(), f = await fixture({ computers: { runtime } });
  const work = f.app.execute(f.auth.actor, workCommand(f, { tools: ["computer"] })).work!;
  f.app.execute(f.auth.actor, { kind: "computer.open", requestId: retryId(), expectedRevision: 0, payload: { botId: "jit", workId: work.id } });
  await f.app.computers.drain(); await f.app.computers.screenshot(f.auth.actor, "jit");
  const lifecycle = (kind: "computer.stop" | "computer.reset" | "computer.delete") => {
    const computer = f.app.computers.view(f.auth.actor, "jit").computer!;
    f.app.execute(f.auth.actor, { kind, requestId: retryId(), expectedRevision: computer.revision, payload: { botId: "jit", computerId: computer.id, generation: computer.generation } });
  };
  lifecycle("computer.stop"); await f.app.computers.drain();
  const old = f.app.computers.view(f.auth.actor, "jit").computer!;
  let { m, actor } = open(f), id = await backup(m, actor); m.close();
  f.store = new S14Store(f.path); f.app = new S14Application(f.store, f.options); f.auth = f.app.authenticate(f.token);
  lifecycle(mode === "reset" ? "computer.reset" : "computer.delete"); await f.app.computers.drain();
  const current = f.app.computers.view(f.auth.actor, "jit").computer!;
  ({ m, actor } = open(f));
  const stage = await m.execute(actor, command(m, "restore.prepare", { backupId: id }));
  expect(stage).toMatchObject({ state: "validated", reason: null });
  await m.execute(actor, command(m, "restore.activate", { stageId: stage.stage!.id, actionHash: stage.stage!.actionHash }));
  actor = m.app.authenticate(await m.app.login("domain-fixture-owner-password")).actor;
  const restored = m.app.computers.view(actor, "jit").computer!;
  expect(restored.generation).toBeGreaterThan(old.generation);
  expect(restored).toMatchObject({ state: mode === "delete" ? "deleted" : "stopped", workspaceId: current.workspaceId, profileId: current.profileId });
  expect(m.app.computers.activity(actor, "jit").some(entry => entry.kind === "screenshot")).toBe(true);
  expect(runtime.starts).toHaveLength(1);
});
