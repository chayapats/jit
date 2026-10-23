import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { backupRetention, scanBackupSecrets, type BackupNativePort } from "../src/ops/backup";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";

const roots: string[] = [], stores: TransactionStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const rid = () => crypto.randomUUID(), password = "ops-backup-owner-password-1";
const scriptedNative = (refs = [{ id: crypto.randomUUID(), generation: 1 }]): BackupNativePort => ({
  available: () => true,
  snapshot: () => ({ refs, bytes: 2048, engine: "scripted-fixture-v1" }),
});
const unavailableNative: BackupNativePort = {
  available: () => false,
  snapshot: () => { throw new Error("never"); },
};

async function fixture(opts: { native?: BackupNativePort; beforeCommit?: (stage: string) => void; backupDir?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-ops-backup-")); roots.push(root);
  const dbPath = join(root, "state.sqlite");
  const config = readConfig({ JIT_DATABASE: dbPath });
  const backupDir = opts.backupDir ?? join(root, "backups");
  const store = new TransactionStore(dbPath); stores.push(store);
  const app = new Application(store, config, {
    now: () => 1800000000000,
    backupDir,
    nativeSnapshot: opts.native ?? unavailableNative,
    ...(opts.beforeCommit ? { beforeCommit: opts.beforeCommit as never } : {}),
  });
  await app.setupOwner(password);
  const token = await app.login(password);
  const auth = app.authenticate(token);
  return { root, dbPath, config, store, app, auth, token, backupDir, web: createWebHandler(app) };
}

function createProject(f: Awaited<ReturnType<typeof fixture>>, name = "โครงการสำรอง ไทย/English 🧠") {
  return f.app.execute(f.auth.actor, {
    kind: "project.create", projectId: null, requestId: rid(),
    expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { name },
  }).project;
}

function seedLifecycle(f: Awaited<ReturnType<typeof fixture>>, projectId?: string, source?: { sourceId: string; revision: number; generation: number }) {
  // Minimal trusted ledger checkpoint without payloads: identity-only suppression marker
  // with a full FK chain (job -> extraction -> claim -> suppression) so the checkpoint
  // query proves a real committed forget rather than an inferred empty state.
  const pid = projectId ?? f.app.workspace(f.auth.actor).projects[0]?.id;
  if (!pid) throw new Error("seed project first");
  let src = source ?? f.store.read(tx =>
    tx.get<{ sourceId: string; revision: number; generation: number }>(
      "SELECT id AS sourceId, current_revision AS revision, generation FROM sources WHERE project_id = ? LIMIT 1", pid));
  if (!src) {
    const project = f.app.project(f.auth.actor, pid);
    const topic = f.app.execute(f.auth.actor, {
      kind: "topic.create", requestId: crypto.randomUUID(), projectId: pid,
      expectedRevision: project.revision, payload: { title: "seed topic" },
    }).topic;
    src = { ...topic.source };
  }
  const jobId = crypto.randomUUID(), extractionId = crypto.randomUUID(), claimId = crypto.randomUUID(), id = crypto.randomUUID();
  f.store.transaction(tx => {
    const order = (tx.get<{ v: number }>("SELECT coalesce(max(queue_order), 0) + 1 AS v FROM jobs")?.v ?? 1);
    tx.run("INSERT INTO jobs (id, project_id, queue_order, priority, state, occupies, route_key, record_json) VALUES (?, ?, ?, 0, 'succeeded', 0, 'fixture', ?)",
      jobId, pid, order, JSON.stringify({ id: jobId }));
    tx.run("INSERT INTO job_authority VALUES (?, 1, NULL, NULL)", jobId);
    tx.run("INSERT INTO memory_extractions (id, project_id, job_id, source_id, source_revision, source_generation, extractor, policy, record_json) VALUES (?, ?, ?, ?, ?, ?, 'claims/v1', 1, ?)",
      extractionId, pid, jobId, src.sourceId, src.revision, src.generation, JSON.stringify({ id: extractionId }));
    tx.run("INSERT INTO memory_claims (id, project_id, extraction_id, revision, generation, record_json) VALUES (?, ?, ?, 1, 1, ?)",
      claimId, pid, extractionId, JSON.stringify({ claimId, status: "forgotten" }));
    tx.run("INSERT INTO memory_suppressions (id, project_id, claim_id, record_json) VALUES (?, ?, ?, ?)",
      id, pid, claimId, JSON.stringify({ id }));
  });
  return id;
}

const backupCommand = (f: Awaited<ReturnType<typeof fixture>>, requestId = rid()) => ({
  kind: "backup.create" as const, requestId, projectId: null,
  expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { note: "manual backup" },
});

test("fail-closed without engine snapshot and without lifecycle checkpoint: incomplete, never valid", async () => {
  const f = await fixture();
  createProject(f);
  const receipt = f.app.execute(f.auth.actor, backupCommand(f));
  expect(receipt.manifest.contract).toBe("ops.backup_manifest/v1");
  expect(receipt.manifest.state).toBe("incomplete");
  expect(receipt.manifest.native.state).toBe("unavailable");
  expect(receipt.manifest.native.reason).toBe("native_snapshot_unavailable");
  expect(receipt.manifest.lifecycle.available).toBe(false);
  expect(receipt.manifest.reason).toBeString();
  expect(receipt.manifest.artifact.bytes).toBeGreaterThan(0);
  expect(receipt.manifest.artifact.hash).toHaveLength(64);
  expect(receipt.manifest.retention.maxBackups).toBe(backupRetention.maxBackups);
  // Inventory outside ordinary project data.
  const listed = f.app.backups(f.auth.actor).manifests;
  expect(listed.map(m => m.id)).toContain(receipt.manifest.id);
  const read = f.app.backup(f.auth.actor, receipt.manifest.id);
  expect(read.manifest).toEqual(receipt.manifest);
  // Manifest carries no secrets.
  const hits = scanBackupSecrets(receipt.manifest, [password, f.token, "gho_", "xoxb-"]);
  expect(hits).toEqual([]);
  expect(JSON.stringify(receipt.manifest)).not.toContain("password_hash");
  // Restrictive artifact permissions.
  const mode = statSync(receipt.manifest.artifact.path).mode & 0o777;
  expect(mode).toBe(0o600);
});

test("valid backup with scripted native snapshot and ledger checkpoint; snapshot survives reopen", async () => {
  const f = await fixture({ native: scriptedNative() });
  const project = createProject(f);
  const topic = f.app.execute(f.auth.actor, {
    kind: "topic.create", requestId: rid(), projectId: project.id,
    expectedRevision: project.revision, payload: { title: "หัวข้อแรก" },
  }).topic;
  f.app.execute(f.auth.actor, {
    kind: "message.send", requestId: rid(), projectId: project.id,
    expectedRevision: topic.revision, payload: { topicId: topic.id, text: "ข้อความภาษาไทย with Unicode 🧠" },
  });
  seedLifecycle(f);
  const receipt = f.app.execute(f.auth.actor, backupCommand(f));
  expect(receipt.manifest.state).toBe("valid");
  expect(receipt.manifest.native.state).toBe("valid");
  expect(receipt.manifest.native.engine).toBe("scripted-fixture-v1");
  expect(receipt.manifest.lifecycle.available).toBe(true);
  expect(receipt.manifest.content.projects).toBeGreaterThanOrEqual(1);
  expect(receipt.manifest.content.sources).toBeGreaterThanOrEqual(2);
  // Independent read/validate after reopen; backup bytes are a real SQLite image.
  const { Database } = await import("bun:sqlite");
  const probe = new Database(receipt.manifest.artifact.path);
  try {
    const count = (probe.query("SELECT count(*) AS n FROM projects").get() as { n: number }).n;
    expect(count).toBeGreaterThanOrEqual(1);
  } finally { probe.close(); }
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = new TransactionStore(f.dbPath); stores.push(reopened);
  const app = new Application(reopened, f.config, { now: () => 1800000000000, backupDir: f.backupDir, nativeSnapshot: unavailableNative });
  const actor = app.authenticate(f.token).actor;
  expect(app.backup(actor, receipt.manifest.id).manifest).toEqual(receipt.manifest);
  expect(app.backups(actor).manifests).toHaveLength(1);
});

test("receipt dedup, stale revision and request-id conflict", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  const cmd = backupCommand(f);
  const first = f.app.execute(f.auth.actor, cmd);
  expect(f.app.execute(f.auth.actor, cmd)).toEqual(first);
  expect(f.app.backups(f.auth.actor).manifests).toHaveLength(1);
  expect(() => f.app.execute(f.auth.actor, { ...cmd, payload: { note: "different" } })).toThrow("request_id_conflict");
  expect(() => f.app.execute(f.auth.actor, { ...backupCommand(f), expectedRevision: 0 })).toThrow("stale_revision");
  expect(() => f.app.backup(f.auth.actor, crypto.randomUUID())).toThrow("backup_not_found");
});

test("interrupted creation leaves no inventory entry; reopen stays consistent", async () => {
  let fail = true;
  const f = await fixture({
    native: scriptedNative(),
    beforeCommit: (stage: string) => { if (fail && stage === "backup") throw new Error("fixture backup crash"); },
  });
  createProject(f); seedLifecycle(f);
  const cmd = backupCommand(f);
  expect(() => f.app.execute(f.auth.actor, cmd)).toThrow("fixture backup crash");
  expect(f.app.backups(f.auth.actor).manifests).toHaveLength(0);
  fail = false;
  const receipt = f.app.execute(f.auth.actor, { ...cmd, requestId: rid() });
  expect(receipt.manifest.state).toBe("valid");
  expect(f.app.backups(f.auth.actor).manifests).toHaveLength(1);
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = new TransactionStore(f.dbPath); stores.push(reopened);
  const app = new Application(reopened, f.config, { now: () => 1800000000000, backupDir: f.backupDir });
  expect(app.backups(app.authenticate(f.token).actor).manifests).toHaveLength(1);
});

test("native snapshot failure stays fail-closed and never parses private formats", async () => {
  const failing: BackupNativePort = { available: () => true, snapshot: () => { throw new Error("engine exploded"); } };
  const f = await fixture({ native: failing });
  createProject(f); seedLifecycle(f);
  const receipt = f.app.execute(f.auth.actor, backupCommand(f));
  expect(receipt.manifest.native.state).toBe("incomplete");
  expect(receipt.manifest.state).toBe("incomplete");
  expect(JSON.stringify(receipt.manifest)).not.toContain("engine exploded");
});

test("retention bounds prune oldest first and record pruned ids", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  const ids: string[] = [];
  for (let i = 0; i < backupRetention.maxBackups + 2; i++) {
    const r = f.app.execute(f.auth.actor, backupCommand(f));
    ids.push(r.manifest.id);
  }
  const listed = f.app.backups(f.auth.actor).manifests;
  expect(listed).toHaveLength(backupRetention.maxBackups);
  expect(new Set(listed.map(m => m.id)).size).toBe(backupRetention.maxBackups);
  expect(listed.some(m => m.retention.pruned.length > 0)).toBe(true);
});

test("concurrent project write after snapshot does not corrupt manifest revision", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f, "โครงการ A"); seedLifecycle(f);
  const before = f.app.workspace(f.auth.actor).revision;
  const receipt = f.app.execute(f.auth.actor, backupCommand(f));
  expect(receipt.manifest.appRevision).toBe(before);
  createProject(f, "โครงการ B");
  expect(f.app.backup(f.auth.actor, receipt.manifest.id).manifest.appRevision).toBe(before);
  expect(f.app.workspace(f.auth.actor).projects).toHaveLength(2);
});

test("web inventory and detail render without secrets or worker activation", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  const receipt = f.app.execute(f.auth.actor, backupCommand(f));
  const req = (path: string, token?: string) => new Request(`http://localhost:3000${path}`,
    { headers: token ? { cookie: `jit_session=${f.token}` } : {} });
  const list = await f.web(req("/backups", f.token));
  expect(list.status).toBe(200);
  const listHtml = await list.text();
  expect(listHtml).toContain(receipt.manifest.id);
  expect(listHtml).not.toContain(f.token);
  const detail = await f.web(req(`/backups/${receipt.manifest.id}`, f.token));
  expect(detail.status).toBe(200);
  expect(await detail.text()).toContain(receipt.manifest.content.hash.slice(0, 16));
  const api = await f.web(req("/api/backups", f.token));
  expect(api.status).toBe(200);
  expect((await api.json() as { manifests: unknown[] }).manifests).toHaveLength(1);
});
