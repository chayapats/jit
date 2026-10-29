import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, type ApplicationOptions } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import { ScriptedRunPort } from "../src/team/scripted-port";
import { reconcileDeletions, type DeletionPreview, type DeletionReceipt, type DeletionConfirmReceipt } from "../src/memory/delete";
import { attachmentProjectContributor, reconcileForgottenAttachments, replayAttachmentLifecycle, redactOutboundRelease } from "../src/attachments/lifecycle";
import { AttachmentStorage } from "../src/attachments/storage";
import { collectAttachmentBlobs, readAttachmentIndex } from "../src/attachments/backup";
import { assertRestorableBackup, planRetention, type BackupNativePort } from "../src/ops/backup";
import { upgradeEngineContract, upgradeNativeFormatVersion } from "../src/ops/upgrade";
import { createWebHandler } from "../src/web";
import { attachmentBackupNotice } from "../src/web-attachments";
import { withLocale } from "../src/i18n";

const dirs: string[] = [], stores: TransactionStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) { try { s.close(); } catch {} } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const rid = () => crypto.randomUUID(), sha = (v: string) => createHash("sha256").update(v).digest("hex");
const now = 1_800_000_000_000;
const native: BackupNativePort = { engine: "fixture-engine/1", contract: upgradeEngineContract, formatVersion: upgradeNativeFormatVersion,
  available: () => true, snapshot: () => ({ refs: [], bytes: 0, engine: "fixture-engine/1", contract: upgradeEngineContract, formatVersion: upgradeNativeFormatVersion, artifacts: [] }) };
async function fixture(options: ApplicationOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), "jit-att06-")); dirs.push(dir);
  const config = readConfig({ JIT_DATABASE: join(dir, "jit.sqlite") }); config.attachments.enabled = true; config.attachments.diskReserveBytes = 1;
  const store = new TransactionStore(config.databasePath); stores.push(store);
  const backupDir = join(dir, "backups");
  const app = new Application(store, config, { now: () => now, backupDir, nativeSnapshot: native, ...options });
  await app.setupOwner("attachment-lifecycle-password"); const token = await app.login("attachment-lifecycle-password"), auth = app.authenticate(token);
  const p = app.execute(auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: app.workspace(auth.actor).revision, payload: { name: "files" } }).project;
  const t = app.execute(auth.actor, { kind: "topic.create", projectId: p.id, requestId: rid(), expectedRevision: p.revision, payload: { title: "files" } }).topic;
  const storage = new AttachmentStorage(store, config.attachments, { now: () => now });
  const env = { contributors: [attachmentProjectContributor(storage), { key: "execution_box", preview: () => ({ count: 0, bytes: 0, digest: sha("box"), identities: [] }), confirm: () => {}, reconcile: async () => {} }], attachmentCleanup: { reconcile: async () => storage.purgeDeleted() } };
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes);
  async function upload(text = "original content", name = "a.txt") { return app.uploadAttachment(auth.actor, p.id, t.id, { body: new Blob([text]).stream(), encodedName: name }); }
  function send(ids: string[], text = "sent") {
    return app.execute(auth.actor, { kind: "message.send", projectId: p.id, requestId: rid(), expectedRevision: app.topic(auth.actor, p.id, t.id).topic.revision, payload: { topicId: t.id, text, attachmentIds: ids } }).message;
  }
  function preview(source = t.source): DeletionPreview { return (app.execute(auth.actor, { kind: "memory.delete.preview", projectId: p.id, requestId: rid(), expectedRevision: app.project(auth.actor, p.id).revision, payload: { scope: { kind: "source", projectId: p.id, source } } }) as DeletionReceipt).preview; }
  function confirm(v: DeletionPreview) { return (app.execute(auth.actor, { kind: "memory.delete.confirm", projectId: p.id, requestId: rid(), expectedRevision: app.project(auth.actor, p.id).revision, payload: { previewId: v.id, acknowledged: true, acknowledgedWholeSession: true } }) as DeletionConfirmReceipt).operation; }
  const backup = () => app.execute(auth.actor, { kind: "backup.create", projectId: null, requestId: rid(), expectedRevision: app.workspace(auth.actor).revision, payload: { note: "files" } });
  const path = (text: string) => storage.blobPath(p.id, sha(text));
  function derivative(id: string, column: "clean" | "model" | "text", text: string) {
    const hash = sha(text), dir = join(storage.root, p.id, hash.slice(0, 2)); mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(join(dir, hash), text, { mode: 0o600 });
    store.transaction(tx => tx.run(`UPDATE attachments SET ${column}_sha256 = ?, ${column}_bytes = ?, revision = revision + 1 WHERE id = ?`, hash, Buffer.byteLength(text), id));
  }
  return { dir, config, store, app, auth, token, p, t, storage, port, env, upload, send, preview, confirm, backup, path, derivative, backupDir };
}

test("message and topic previews include attachment sources/count/derivative bytes; deletion respects project refcounts and durable retry", async () => {
  const f = await fixture({ attachmentCopies: { reconcile: async () => { throw new Error("box failure"); } } });
  const a = await f.upload(), b = await f.upload(); f.derivative(a.id, "clean", "clean"); f.derivative(a.id, "model", "model"); f.derivative(a.id, "text", "text");
  const m = f.send([a.id]), other = f.send([b.id]);
  const v = f.preview(m.source);
  expect(v.affected.attachments).toEqual({ count: 1, bytes: "original contentcleanmodeltext".length });
  expect(v.affected.sources).toContainEqual({ projectId: f.p.id, source: { sourceId: a.id, revision: 1, generation: 1 }, relation: "attachment" });
  const op = f.confirm(v); expect(op.state).toBe("pending");
  // Crash/reopen before the failed hook can remove files. Independent reconcile uses only trusted roots and identities.
  await reconcileDeletions(f.store, f.port, now, undefined, f.env);
  expect(f.app.deletionOperation(f.auth.actor, f.p.id, op.id).operation?.state).toBe("complete");
  expect(existsSync(f.path("original content"))).toBe(true);
  for (const content of ["clean", "model", "text"]) expect(existsSync(f.path(content))).toBe(false);
  expect(f.app.deletionLedger(f.auth.actor).tombstones.some(t => t.sourceId === a.id)).toBe(true);
  const topic = f.preview(); expect(topic.affected.attachments).toEqual({ count: 1, bytes: "original content".length });
  f.confirm(topic); await reconcileDeletions(f.store, f.port, now, undefined, f.env);
  expect(existsSync(f.path("original content"))).toBe(false);
  expect(f.app.source(f.auth.actor, f.p.id, other.source).state).toBe("available");
});

test("derivative drift stales a preview; attachment source itself is a deletion scope; an untrusted directory never completes", async () => {
  const f = await fixture(); const a = await f.upload(); f.send([a.id]);
  const source = { sourceId: a.id, revision: 1, generation: 1 }, stale = f.preview(source);
  f.derivative(a.id, "model", "later"); expect(() => f.confirm(stale)).toThrow("memory_delete_stale_preview");
  const target = f.path("later"), parent = join(f.storage.root, f.p.id, sha("later").slice(0, 2)), outside = join(f.dir, "outside");
  mkdirSync(outside); writeFileSync(join(outside, "untouched"), "private"); rmSync(parent, { recursive: true }); symlinkSync(outside, parent);
  const op = f.confirm(f.preview(source)); await reconcileDeletions(f.store, f.port, now, undefined, f.env);
  expect(f.app.deletionOperation(f.auth.actor, f.p.id, op.id).operation?.state).toBe("pending");
  expect(readFileSync(join(outside, "untouched"), "utf8")).toBe("private");
  rmSync(parent); mkdirSync(parent, { mode: 0o700 }); writeFileSync(target, "later", { mode: 0o600 });
  const reopened = new TransactionStore(f.config.databasePath); stores.push(reopened);
  const storage = new AttachmentStorage(reopened, f.config.attachments);
  await reconcileDeletions(reopened, new ScriptedRunPort(reopened, f.config.team, f.config.jobs.outputBytes), now, undefined, { attachmentCleanup: { reconcile: async () => storage.purgeDeleted() } });
  expect(reopened.read(tx => tx.get<{ state: string }>("SELECT state FROM deletion_operations WHERE id = ?", op.id)?.state)).toBe("complete");
  expect(existsSync(target)).toBe(false);
});

test("project deletion includes drafts and derivatives; replay retires every file before project purge", async () => {
  const f = await fixture(); const a = await f.upload(), staged = await f.upload("draft"); f.send([a.id]); f.derivative(a.id, "text", "derived");
  const backup = (await f.backup()).manifest;
  const preview = (f.app.execute(f.auth.actor, { kind: "project.delete.preview", projectId: f.p.id, requestId: rid(), expectedRevision: f.app.project(f.auth.actor, f.p.id).revision, payload: { scope: { kind: "project", projectId: f.p.id } } }) as DeletionReceipt).preview;
  expect(preview.affected.project?.collateral.find(c => c.key === "attachments")).toMatchObject({ count: 2, bytes: "original contentdraftderived".length });
  const confirmed = (f.app.execute(f.auth.actor, { kind: "project.delete.confirm", projectId: f.p.id, requestId: rid(), expectedRevision: f.app.project(f.auth.actor, f.p.id).revision,
    payload: { previewId: preview.id, inventoryDigest: preview.inventoryDigest, projectName: "files", acknowledged: true, acknowledgedWholeSession: true } }) as DeletionConfirmReceipt);
  await reconcileDeletions(f.store, f.port, now, undefined, f.env);
  expect(existsSync(join(f.storage.root, f.p.id))).toBe(false);
  expect(f.app.deletionOperation(f.auth.actor, f.p.id, confirmed.operation.id).operation?.state).toBe("complete");
  expect(f.store.read(tx => tx.get<{ state: string }>("SELECT state FROM attachments WHERE id = ?", staged.id)?.state)).toBe("deleted");
  const prepared = (await f.app.execute(f.auth.actor, { kind: "restore.prepare", requestId: rid(), projectId: null, expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { backupId: backup.id, note: "deleted project" } })).quarantine;
  for (const kind of ["restore.migrate", "restore.apply_ledger", "restore.validate", "restore.activate"] as const) await f.app.execute(f.auth.actor, { kind, requestId: rid(), projectId: null,
    expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { quarantineId: prepared.id } });
  expect(existsSync(join(f.storage.root, f.p.id))).toBe(false);
  expect(f.store.read(tx => tx.all<{ state: string }>("SELECT state FROM attachments WHERE project_id = ?", f.p.id).every(a => a.state === "deleted"))).toBe(true);
});

test("bounded backups share originals and all derivatives; over-bound creation writes nothing and upgrade names the reason", async () => {
  const f = await fixture(); const a = await f.upload(); f.send([a.id]);
  for (const column of ["clean", "model", "text"] as const) f.derivative(a.id, column, column);
  const one = (await f.backup()).manifest, two = (await f.backup()).manifest;
  expect(one.attachments).toMatchObject({ state: "valid", count: 1, bytes: "original contentcleanmodeltext".length });
  const index = readAttachmentIndex(one.attachments, f.backupDir, one.id); expect(index).toHaveLength(4);
  expect(readAttachmentIndex(two.attachments, f.backupDir, two.id)).toEqual(index);
  for (const b of index) expect(readFileSync(join(f.backupDir, "attachments", b.projectId, b.sha256.slice(0, 2), b.sha256)).length).toBe(b.bytes);
  f.config.attachments.backupBytes = 1; const before = readdirSync(f.backupDir).sort();
  await expect(f.backup()).rejects.toMatchObject({ code: "backup_attachments_too_large", detail: { bytes: one.attachments!.bytes, bound: 1 } });
  expect(readdirSync(f.backupDir).sort()).toEqual(before);
  await expect(f.app.execute(f.auth.actor, { kind: "upgrade.prepare", projectId: null, requestId: rid(), expectedRevision: f.app.workspace(f.auth.actor).revision,
    payload: { targetSchema: f.store.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version), note: "upgrade" } })).rejects.toMatchObject({ code: "backup_attachments_too_large" });
});

test("missing and same-size corrupt blobs cannot restore; listing checks sizes while restore hashes every blob", async () => {
  const f = await fixture(); const a = await f.upload(); f.send([a.id]); const one = (await f.backup()).manifest;
  const b = readAttachmentIndex(one.attachments, f.backupDir, one.id)[0]!, path = join(f.backupDir, "attachments", b.projectId, b.sha256.slice(0, 2), b.sha256);
  writeFileSync(path, "x".repeat(b.bytes));
  expect(f.app.backup(f.auth.actor, one.id).manifest.state).toBe("valid");
  expect(() => assertRestorableBackup(one, f.backupDir)).toThrow("backup_integrity_failed");
  rmSync(f.path("original content")); const broken = (await f.backup()).manifest;
  expect(broken).toMatchObject({ state: "incomplete", attachments: { state: "incomplete", reason: "attachment_blob_missing" } });
  rmSync(path); expect(f.app.backup(f.auth.actor, one.id).manifest).toMatchObject({ state: "incomplete", reason: "attachment_blob_missing" });
});

test("retention fits the union, deduplicates shared hashes, and prunes old shared blobs after commit", async () => {
  const f = await fixture(); const a = await f.upload("aaaa"); f.send([a.id]); f.config.attachments.backupBytes = 4;
  const old = (await f.backup()).manifest; f.confirm(f.preview({ sourceId: a.id, revision: 1, generation: 1 }));
  await reconcileDeletions(f.store, f.port, now, undefined, f.env);
  const b = await f.upload("bbbb"); f.send([b.id]); const next = (await f.backup()).manifest;
  expect(next.retention.pruned).toContain(old.id);
  expect(existsSync(join(f.backupDir, "attachments", f.p.id, sha("aaaa").slice(0, 2), sha("aaaa")))).toBe(false);
  const blob = { projectId: f.p.id, sha256: sha("same"), bytes: 4 };
  expect(planRetention([{ id: "a", bytes: 1 }, { id: "b", bytes: 1 }], 1, 10, 100, { existing: { a: [blob], b: [blob] }, incoming: [blob], bound: 4 })).toEqual([]);
});

test("exports contain metadata only and names only with history; outbound action copies are redacted", async () => {
  const f = await fixture(); const a = await f.upload("SECRET FILE BYTES", "secret-name.txt"); f.send([a.id]);
  for (const includeHistory of [false, true]) {
    const receipt = await f.app.execute(f.auth.actor, { kind: "export.create", projectId: f.p.id, requestId: rid(), expectedRevision: f.app.project(f.auth.actor, f.p.id).revision, payload: { includeHistory, note: "metadata" } });
    const body = Buffer.from(f.app.exportArtifact(f.auth.actor, f.p.id, receipt.manifest.id).body).toString();
    const data = JSON.parse(body); expect(body).not.toContain("SECRET FILE BYTES"); expect(body).not.toContain(sha("SECRET FILE BYTES"));
    expect(data.data.attachments[0]).toMatchObject({ id: a.id, name: includeHistory ? "secret-name.txt" : null });
    expect(receipt.manifest).toMatchObject({ counts: { attachments: 1 }, disclosure: { attachments: "metadata_only" } });
  }
  expect(JSON.stringify(redactOutboundRelease({ card: { kind: "outbound_release", action: { arguments: "SECRET FILE BYTES" }, receipt: "SECRET FILE BYTES" } }))).not.toContain("SECRET FILE BYTES");
});

test("restore writes only ledger survivors and drops unsent drafts, then sweeps old live blobs after activation", async () => {
  const f = await fixture(); const a = await f.upload("delete me"), b = await f.upload("survivor"), draft = await f.upload("draft"); f.send([a.id]); f.send([b.id]);
  f.derivative(a.id, "model", "deleted model"); const backup = (await f.backup()).manifest;
  f.confirm(f.preview({ sourceId: a.id, revision: 1, generation: 1 })); await reconcileDeletions(f.store, f.port, now, undefined, f.env);
  const late = await f.upload("after backup"); f.send([late.id]);
  rmSync(f.path("survivor"));
  const prepared = (await f.app.execute(f.auth.actor, { kind: "restore.prepare", requestId: rid(), projectId: null, expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { backupId: backup.id, note: "test" } })).quarantine;
  const step = (kind: "restore.migrate" | "restore.apply_ledger" | "restore.validate" | "restore.activate") => f.app.execute(f.auth.actor, { kind, requestId: rid(), projectId: null, expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { quarantineId: prepared.id } });
  await step("restore.migrate"); await step("restore.apply_ledger"); expect((await step("restore.validate")).quarantine.state).toBe("validated");
  await step("restore.activate");
  expect(readFileSync(f.path("survivor"), "utf8")).toBe("survivor");
  for (const text of ["delete me", "deleted model", "draft", "after backup"]) expect(existsSync(f.path(text))).toBe(false);
  expect(f.store.read(tx => tx.get<{ state: string }>("SELECT state FROM attachments WHERE id = ?", draft.id)?.state)).toBe("deleted");
});

test("staged GC stays outside ledger; replay deletes suppressed attachments and 80% notice renders in both locales", async () => {
  const f = await fixture(); const a = await f.upload("forgotten"); f.send([a.id]);
  f.store.transaction(tx => tx.run(`INSERT INTO lifecycle_ledger (kind, entry_key, subject, project_id, record_json, recorded_at) VALUES ('suppressed_source', ?, ?, ?, ?, ?)`, rid(), `source:${a.id}:1:1`, f.p.id, JSON.stringify({ suppressionId: rid(), projectId: f.p.id, sourceId: a.id, revision: 1, generation: 1 }), now));
  f.store.transaction(tx => replayAttachmentLifecycle(tx, now)); f.storage.purgeDeleted();
  expect(existsSync(f.path("forgotten"))).toBe(false);
  const unsent = await f.upload("expired"); f.store.transaction(tx => tx.run("UPDATE attachments SET created_at = ? WHERE id = ?", now - 25 * 3600_000, unsent.id));
  const before = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM lifecycle_ledger")!.n); f.storage.sweep();
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM lifecycle_ledger")!.n)).toBe(before);
  f.config.attachments.backupBytes = 10; await f.upload("12345678");
  expect(f.app.attachmentComposer().backupUsage.notice).toBe(true);
  for (const locale of ["th", "en"] as const) expect(withLocale(locale, () => attachmentBackupNotice(f.app.attachmentBackupUsage()))).toContain("8 B");
  const web = createWebHandler(f.app), html = await (await web(new Request(f.config.origin + "/settings/backups", { headers: { cookie: `jit_session=${f.token}` } }))).text();
  expect(html).toContain("8 B");
});

test("owner forget of a message claim suppresses its attachment lineage, waits for failed file cleanup, and survives reopen", async () => {
  const f = await fixture({ attachmentCopies: { reconcile: async () => { throw new Error("copy remains"); } } });
  const a = await f.upload("forget file"), m = f.send([a.id], "remember this message"), claimId = rid(), extractionId = rid(), jobId = rid();
  const claim = { claimId, projectId: f.p.id, extractionId, revision: 1, generation: 1, kind: "explicit_fact", text: "remember this message", quote: "remember this message", source: m.source,
    dependencies: [], conflicts: [], status: "active", createdAt: now, decision: null };
  f.store.transaction(tx => {
    tx.run("INSERT INTO jobs (id, project_id, queue_order, priority, state, occupies, route_key, record_json) VALUES (?, ?, 1, 0, 'succeeded', 0, 'fixture', ?)", jobId, f.p.id, JSON.stringify({ id: jobId }));
    tx.run("INSERT INTO memory_extractions (id, project_id, job_id, source_id, source_revision, source_generation, extractor, policy, record_json) VALUES (?, ?, ?, ?, 1, 1, 'claims/v1', 1, ?)", extractionId, f.p.id, jobId, m.source.sourceId, JSON.stringify({ id: extractionId, source: m.source, dependencies: [], request: { manifest: { sources: [], claims: [] } } }));
    tx.run("INSERT INTO memory_claims (id, project_id, extraction_id, revision, generation, record_json) VALUES (?, ?, ?, 1, 1, ?)", claimId, f.p.id, extractionId, JSON.stringify(claim));
  });
  const reference = { claimId, revision: 1, generation: 1 };
  expect(f.app.suppressionImpact(f.auth.actor, f.p.id, reference).attachments).toEqual({ count: 1, bytes: "forget file".length });
  f.app.execute(f.auth.actor, { kind: "memory.forget", requestId: rid(), projectId: f.p.id, expectedRevision: f.app.project(f.auth.actor, f.p.id).revision,
    payload: { claim: reference, reason: "forget", acknowledged: true } });
  expect(f.app.suppressionLedger(f.auth.actor, f.p.id, claimId)?.retire.state).toBe("incomplete");
  expect(f.app.source(f.auth.actor, f.p.id, m.source).state).toBe("available");
  expect(f.store.read(tx => tx.get("SELECT 1 FROM lifecycle_ledger WHERE kind = 'suppressed_source' AND subject = ?", `source:${a.id}:1:1`))).not.toBeNull();
  const reopened = new TransactionStore(f.config.databasePath); stores.push(reopened); const storage = new AttachmentStorage(reopened, f.config.attachments);
  await reconcileForgottenAttachments(reopened, { reconcile: async () => storage.purgeDeleted() });
  expect(f.app.suppressionLedger(f.auth.actor, f.p.id, claimId)?.retire.state).toBe("complete");
  expect(existsSync(f.path("forget file"))).toBe(false);
});

test("deletion aborts an active sanitizer and removes its private work before operation completion", async () => {
  let began!: () => void, aborted = false;
  const started = new Promise<void>(resolve => { began = resolve; });
  const f = await fixture({ attachmentSanitizer: { available: async () => true, reset: async () => {}, run: async (_job, signal) => {
    began(); await new Promise<void>(resolve => { signal?.addEventListener("abort", () => { aborted = true; resolve(); }, { once: true }); });
  } } });
  const content = readFileSync(join(import.meta.dir, "fixtures/attachments/metadata-polyglot.png"));
  const a = await f.app.uploadAttachment(f.auth.actor, f.p.id, f.t.id, { body: new Blob([content]).stream(), encodedName: "a.png" }); f.send([a.id]);
  const pump = f.app.processAttachments().catch(() => 0); await started;
  const op = f.confirm(f.preview({ sourceId: a.id, revision: 1, generation: 1 }));
  await pump;
  // Wait for the serialized post-commit cleanup already started by Application, then its regular queue pass.
  await reconcileDeletions(f.store, f.port, now, undefined, f.env);
  expect(aborted).toBe(true); expect(readdirSync(join(f.storage.root, ".work"))).toEqual([]);
  expect(f.app.deletionOperation(f.auth.actor, f.p.id, op.id).operation?.state).toBe("complete");
});

test("project cleanup removes active upload staging and the late upload cannot publish after its project tombstone", async () => {
  const f = await fixture(); let resume!: () => void, pulled!: () => void;
  const admitted = new Promise<void>(resolve => { pulled = resolve; }), wait = new Promise<void>(resolve => { resume = resolve; }); let n = 0;
  const upload = f.app.uploadAttachment(f.auth.actor, f.p.id, f.t.id, { encodedName: "pending.txt", body: new ReadableStream({ async pull(c) {
    if (n++ === 0) { c.enqueue(Buffer.from("partial")); return; } pulled(); await wait; c.enqueue(Buffer.from("late")); c.close();
  } }, { highWaterMark: 0 }) }).then(() => "published", e => (e as { code: string }).code);
  await admitted; expect(readdirSync(join(f.storage.root, ".staging"))).toHaveLength(1);
  const v = (f.app.execute(f.auth.actor, { kind: "project.delete.preview", projectId: f.p.id, requestId: rid(), expectedRevision: f.app.project(f.auth.actor, f.p.id).revision, payload: { scope: { kind: "project", projectId: f.p.id } } }) as DeletionReceipt).preview;
  f.app.execute(f.auth.actor, { kind: "project.delete.confirm", projectId: f.p.id, requestId: rid(), expectedRevision: f.app.project(f.auth.actor, f.p.id).revision,
    payload: { previewId: v.id, inventoryDigest: v.inventoryDigest, projectName: "files", acknowledged: true, acknowledgedWholeSession: true } });
  await reconcileDeletions(f.store, f.port, now, undefined, f.env);
  expect(readdirSync(join(f.storage.root, ".staging"))).toEqual([]); resume(); expect(await upload).toBe("project_deleted");
});

test("attachment-only run references fence pending jobs/native contexts and redact only their release copies", async () => {
  const f = await fixture(); const a = await f.upload(); f.send([a.id]); const jobId = rid(), runId = rid(), contextId = rid();
  const affectedReceipt = rid(), otherReceipt = rid();
  f.store.transaction(tx => {
    const job = { id: jobId, projectId: f.p.id, revision: 1, state: "queued", updatedAt: now, deadlineAt: now + 1000, remaining: { wallMs: 1000 }, occupiesAdmission: false };
    tx.run("INSERT INTO jobs (id, project_id, queue_order, priority, state, occupies, route_key, record_json) VALUES (?, ?, 1, 0, 'queued', 0, 'fixture', ?)", jobId, f.p.id, JSON.stringify(job));
    tx.run("INSERT INTO job_authority VALUES (?, 1, NULL, NULL)", jobId);
    tx.run("INSERT INTO team_contexts VALUES (?, 1, 'active')", contextId);
    tx.run("INSERT INTO team_runs (id, project_id, job_id, context_id, record_json) VALUES (?, ?, ?, ?, ?)", runId, f.p.id, jobId, contextId, JSON.stringify({ request: { runId, attachments: [{ attachmentId: a.id, revision: 1, generation: 1 }], manifest: { sources: [], claims: [] } } }));
    for (const [id, carriedRun, text] of [[affectedReceipt, runId, "private outgoing file text"], [otherReceipt, rid(), "unrelated outgoing text"]]) {
      tx.run("INSERT INTO command_receipts VALUES ('owner', ?, 'fixture', ?, ?)", id!, JSON.stringify({ kind: "outbound_release", runId: carriedRun, action: { arguments: { text } } }), now);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', 'fixture', ?, ?, ?)", id!, f.p.id, now);
    }
  });
  const backup = (await f.backup()).manifest;
  const db = new Database(backup.artifact.path, { readonly: true });
  try { expect(JSON.stringify(db.query("SELECT result_json FROM command_receipts").all())).not.toContain("outgoing"); } finally { db.close(); }
  const preview = f.preview({ sourceId: a.id, revision: 1, generation: 1 });
  expect(preview.affected.pendingJobs.some(j => j.id === jobId)).toBe(true); expect(preview.affected.nativeSessions.some(c => c.id === contextId)).toBe(true);
  f.confirm(preview);
  expect(f.store.read(tx => tx.get<{ state: string; json: string }>("SELECT state, record_json AS json FROM jobs WHERE id = ?", jobId))).toMatchObject({ state: "blocked" });
  expect(f.store.read(tx => tx.get<{ reason: string }>("SELECT reason FROM job_authority WHERE job_id = ?", jobId)?.reason)).toBe("source_retired");
  expect(f.store.read(tx => tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ?", contextId)?.state)).toBe("retired");
  const receipt = (id: string) => f.store.read(tx => tx.get<{ json: string }>("SELECT result_json AS json FROM command_receipts WHERE request_id = ?", id)!.json);
  expect(receipt(affectedReceipt)).not.toContain("private outgoing file text"); expect(receipt(otherReceipt)).toContain("unrelated outgoing text");
  await reconcileDeletions(f.store, f.port, now, undefined, f.env);
});
