import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, ModelRequest } from "schway/host";
import packageManifest from "../package.json";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import {
  backupImageTables, backupRetention, captureNativeSnapshot, jitAppVersion, normalizeNativeSnapshot, planRetention, resolveNativeSnapshot, scanBackupSecrets,
  type BackupNativePort,
} from "../src/ops/backup";
import { SchwayBackupNativePort, createSchwayBackupNativePort, schwayBackupEngine } from "../src/ops/schway-backup";
import { currentSupportedSchema, prepareUpgrade } from "../src/ops/upgrade";
import { SchwayRunPort, schwayHostDirs, type SchwayPortOptions } from "../src/team/schway-port";
import type { ApplicationRunRequest } from "../src/team/types";
import { TelegramChannel } from "../src/telegram";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";

const roots: string[] = [], stores: TransactionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* Already closed. */ } }
  for (const r of roots.splice(0)) { try { chmodSync(r, 0o700); } catch { /* Gone. */ } rmSync(r, { recursive: true, force: true }); }
});

const rid = () => crypto.randomUUID(), password = "ops-backup-owner-password-1";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const artifactOf = (text: string, name = "fixture-0") => {
  const bytes = new TextEncoder().encode(text);
  return { name, bytes, sha256: sha(bytes) };
};
/** Explicit fixture snapshot contract: non-empty native captures must declare one. */
const fixtureContract = { contract: "jit.fixture.native-snapshot/v1", formatVersion: 1 } as const;
const scriptedNative = (refs = [{ id: crypto.randomUUID(), generation: 1 }]): BackupNativePort => ({
  ...fixtureContract,
  available: () => true,
  snapshot: () => ({ refs, bytes: 2048, engine: "scripted-fixture-v1", ...fixtureContract, artifacts: [artifactOf(`native:${refs.map(r => r.id).join(",")}`)] }),
});
const unavailableNative: BackupNativePort = {
  available: () => false,
  snapshot: () => { throw new Error("never"); },
};

async function fixture(opts: { native?: BackupNativePort; beforeCommit?: (stage: string) => void; backupDir?: string; jitVersion?: string } = {}) {
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
    ...(opts.jitVersion ? { jitVersion: opts.jitVersion } : {}),
  });
  await app.setupOwner(password);
  const token = await app.login(password);
  const auth = app.authenticate(token);
  return { root, dbPath, config, store, app, auth, token, backupDir, web: createWebHandler(app) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

function createProject(f: Pick<Fixture, "app" | "auth">, name = "โครงการสำรอง ไทย/English 🧠") {
  return f.app.execute(f.auth.actor, {
    kind: "project.create", projectId: null, requestId: rid(),
    expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { name },
  }).project;
}

function seedLifecycle(f: Pick<Fixture, "app" | "auth" | "store">, projectId?: string, source?: { sourceId: string; revision: number; generation: number }) {
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

const backupCommand = (f: { app: Application; auth: { actor: Fixture["auth"]["actor"] } }, requestId = rid()) => ({
  kind: "backup.create" as const, requestId, projectId: null,
  expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { note: "manual backup" },
});
const managedFiles = (dir: string) => { try { return readdirSync(dir).sort(); } catch { return []; } };
const restorePrepare = (f: { app: Application; auth: { actor: Fixture["auth"]["actor"] } }, backupId: string) => f.app.execute(f.auth.actor, {
  kind: "restore.prepare" as const, requestId: rid(), projectId: null, expectedRevision: f.app.workspace(f.auth.actor).revision,
  payload: { backupId, note: "restore gate" } });

test("fail-closed without engine snapshot: incomplete, never valid", async () => {
  const f = await fixture();
  createProject(f);
  const receipt = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(receipt.manifest.contract).toBe("ops.backup_manifest/v1");
  expect(receipt.manifest.state).toBe("incomplete");
  expect(receipt.manifest.native.state).toBe("unavailable");
  expect(receipt.manifest.native.reason).toBe("native_snapshot_unavailable");
  expect(receipt.manifest.native.artifacts).toEqual([]);
  // An empty but readable ledger is an explicit position-zero checkpoint, not an inference.
  expect(receipt.manifest.lifecycle).toMatchObject({ available: true, position: { deletions: 0, suppressions: 0 } });
  expect(receipt.manifest.lifecycle.checkpoint).toStartWith("ledger:");
  expect(receipt.manifest.reason).toBe("native_snapshot_unavailable");
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

test("valid backup with scripted native artifact and ledger checkpoint; snapshot survives reopen and validates independently", async () => {
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
  const receipt = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(receipt.manifest.state).toBe("valid");
  expect(receipt.manifest.native.state).toBe("valid");
  expect(receipt.manifest.native.engine).toBe("scripted-fixture-v1");
  expect(receipt.manifest.native.artifacts).toHaveLength(1);
  expect(receipt.manifest.lifecycle.available).toBe(true);
  expect(receipt.manifest.inventory.complete).toBe(true);
  expect(receipt.manifest.content.projects).toBeGreaterThanOrEqual(1);
  expect(receipt.manifest.content.sources).toBeGreaterThanOrEqual(2);
  // Independent read/validate after reopen; backup bytes are a real SQLite image.
  const image = readFileSync(receipt.manifest.artifact.path);
  expect(sha(image)).toBe(receipt.manifest.artifact.hash);
  const nativeFile = receipt.manifest.native.artifacts[0]!;
  expect(sha(readFileSync(nativeFile.path))).toBe(nativeFile.hash);
  expect(statSync(nativeFile.path).mode & 0o777).toBe(0o600);
  expect(receipt.manifest.native.bytes).toBe(nativeFile.bytes);
  const probe = new Database(receipt.manifest.artifact.path, { readonly: true });
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
  const first = await f.app.execute(f.auth.actor, cmd);
  expect(await f.app.execute(f.auth.actor, cmd)).toEqual(first);
  expect(f.app.backups(f.auth.actor).manifests).toHaveLength(1);
  await expect(f.app.execute(f.auth.actor, { ...cmd, payload: { note: "different" } })).rejects.toThrow("request_id_conflict");
  await expect(f.app.execute(f.auth.actor, { ...backupCommand(f), expectedRevision: 0 })).rejects.toThrow("stale_revision");
  expect(() => f.app.backup(f.auth.actor, crypto.randomUUID())).toThrow("backup_not_found");
  // Concurrent duplicates commit exactly one manifest and leave no staged files behind.
  const again = backupCommand(f);
  const [a, b] = await Promise.all([f.app.execute(f.auth.actor, again), f.app.execute(f.auth.actor, again)]);
  expect(a.manifest.id).toBe(b.manifest.id);
  expect(f.app.backups(f.auth.actor).manifests).toHaveLength(2);
  expect(managedFiles(f.backupDir).filter(n => n.endsWith(".sqlite"))).toHaveLength(2);
});

test("interrupted creation leaves no inventory entry and no staged files; reopen stays consistent", async () => {
  let fail = true;
  const f = await fixture({
    native: scriptedNative(),
    beforeCommit: (stage: string) => { if (fail && stage === "backup") throw new Error("fixture backup crash"); },
  });
  createProject(f); seedLifecycle(f);
  const cmd = backupCommand(f);
  await expect(f.app.execute(f.auth.actor, cmd)).rejects.toThrow("fixture backup crash");
  expect(f.app.backups(f.auth.actor).manifests).toHaveLength(0);
  expect(managedFiles(f.backupDir)).toEqual([]);
  fail = false;
  const receipt = await f.app.execute(f.auth.actor, { ...cmd, requestId: rid() });
  expect(receipt.manifest.state).toBe("valid");
  expect(f.app.backups(f.auth.actor).manifests).toHaveLength(1);
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = new TransactionStore(f.dbPath); stores.push(reopened);
  const app = new Application(reopened, f.config, { now: () => 1800000000000, backupDir: f.backupDir });
  expect(app.backups(app.authenticate(f.token).actor).manifests).toHaveLength(1);
});

test("native snapshot failure, hash mismatch and missing artifacts stay fail-closed without leaking engine text", async () => {
  const failing: BackupNativePort = { available: () => true, snapshot: () => { throw new Error("engine exploded"); } };
  const f = await fixture({ native: failing });
  createProject(f); seedLifecycle(f);
  const receipt = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(receipt.manifest.native.state).toBe("incomplete");
  expect(receipt.manifest.state).toBe("incomplete");
  expect(JSON.stringify(receipt.manifest)).not.toContain("engine exploded");
  const ref = { id: rid(), generation: 1 };
  const tampered: BackupNativePort = { available: () => true,
    snapshot: async () => ({ refs: [ref], bytes: 1, engine: "fixture", artifacts: [{ ...artifactOf("bytes"), sha256: "0".repeat(64) }] }) };
  const g = await fixture({ native: tampered });
  createProject(g); seedLifecycle(g);
  const bad = await g.app.execute(g.auth.actor, backupCommand(g));
  expect(bad.manifest.native).toMatchObject({ state: "incomplete", reason: "native_artifact_hash_mismatch", artifacts: [] });
  expect(managedFiles(g.backupDir).filter(n => n.includes(".native-"))).toEqual([]);
  // Refs without any opaque artifact (the old directory-walk shape) never validate.
  const h = await fixture({ native: { available: () => true, snapshot: () => ({ refs: [ref], bytes: 4096, engine: "fixture" }) } });
  createProject(h); seedLifecycle(h);
  expect((await h.app.execute(h.auth.actor, backupCommand(h))).manifest.native).toMatchObject({ state: "incomplete", reason: "native_artifacts_missing" });
});

test("retention bounds prune oldest first, record pruned ids and delete files only after commit", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  const ids: string[] = [];
  for (let i = 0; i < backupRetention.maxBackups + 2; i++) {
    const r = await f.app.execute(f.auth.actor, backupCommand(f));
    ids.push(r.manifest.id);
  }
  const listed = f.app.backups(f.auth.actor).manifests;
  expect(listed).toHaveLength(backupRetention.maxBackups);
  expect(listed.map(m => m.id)).toEqual(ids.slice(2));
  expect(listed.some(m => m.retention.pruned.length > 0)).toBe(true);
  // Pruned backups lose image and native files; retained ones keep both.
  for (const id of ids.slice(0, 2)) expect(managedFiles(f.backupDir).some(n => n.startsWith(id))).toBe(false);
  expect(managedFiles(f.backupDir)).toHaveLength(backupRetention.maxBackups * 2);
  // Explicit prune keeps the newest `keep` and removes files after commit.
  const pruned = f.app.execute(f.auth.actor, { kind: "backup.prune", requestId: rid(), projectId: null,
    expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { keep: 3 } });
  expect(pruned.manifest.retention.pruned).toHaveLength(backupRetention.maxBackups - 3);
  expect(pruned.manifest.jitVersion).toBe(jitAppVersion);
  expect(managedFiles(f.backupDir)).toHaveLength(6);
});

test("a failure after victims are chosen keeps every committed backup file and removes only the new attempt", async () => {
  let fail = false;
  const f = await fixture({ native: scriptedNative(), beforeCommit: stage => { if (fail && stage === "backup") throw new Error("injected post-prune failure"); } });
  createProject(f); seedLifecycle(f);
  for (let i = 0; i < backupRetention.maxBackups; i++) await f.app.execute(f.auth.actor, backupCommand(f));
  const before = f.app.backups(f.auth.actor).manifests;
  const filesBefore = managedFiles(f.backupDir);
  fail = true;
  await expect(f.app.execute(f.auth.actor, backupCommand(f))).rejects.toThrow("injected post-prune failure");
  const after = f.app.backups(f.auth.actor).manifests;
  expect(after.map(m => m.id)).toEqual(before.map(m => m.id));
  expect(existsSync(before[0]!.artifact.path)).toBe(true);
  expect(existsSync(before[0]!.native.artifacts[0]!.path)).toBe(true);
  expect(managedFiles(f.backupDir)).toEqual(filesBefore);
  // Same guarantee for an explicit prune whose transaction fails.
  await expect(Promise.resolve().then(() => f.app.execute(f.auth.actor, { kind: "backup.prune", requestId: rid(), projectId: null,
    expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { keep: 1 } }))).rejects.toThrow("injected post-prune failure");
  expect(managedFiles(f.backupDir)).toEqual(filesBefore);
});

test("retention plan rejects an oversize incoming backup and prunes the minimal cumulative oldest set", () => {
  const MiB = 1024 * 1024;
  const existing = [{ id: "a", bytes: 30 * MiB }, { id: "b", bytes: 30 * MiB }, { id: "c", bytes: 30 * MiB }];
  // 10 + 90 = 100 MiB: dropping a (70) is not enough, dropping b too (40) fits; c stays.
  expect(planRetention(existing, 10 * MiB, 10)).toEqual(["a", "b"]);
  expect(planRetention(existing, 4 * MiB, 10)).toEqual(["a"]);
  expect(planRetention(existing, 5 * MiB, 10)).toEqual(["a", "b"]);
  expect(planRetention([{ id: "a", bytes: 10 }, { id: "b", bytes: 10 }], 10, 10)).toEqual([]);
  expect(planRetention([{ id: "a", bytes: 1 }, { id: "b", bytes: 1 }, { id: "c", bytes: 1 }], 1, 2)).toEqual(["a", "b"]);
  expect(planRetention([{ id: "a", bytes: 1 }, { id: "b", bytes: 1 }], null, 1)).toEqual(["a"]);
  expect(() => planRetention(existing, backupRetention.maxBytes + 1, 10)).toThrow("backup_too_large");
});

test("an incoming backup above the byte ceiling is rejected before anything is pruned or written", async () => {
  let huge = false;
  const port: BackupNativePort = {
    ...fixtureContract,
    available: () => true,
    snapshot: () => {
      const refs = [{ id: "00000000-0000-4000-8000-000000000001", generation: 1 }];
      if (!huge) return { refs, bytes: 1, engine: "fixture", ...fixtureContract, artifacts: [artifactOf("small")] };
      const bytes = new Uint8Array(backupRetention.maxBytes + 1).fill(7);
      return { refs, bytes: bytes.length, engine: "fixture", ...fixtureContract, artifacts: [{ name: "big", bytes, sha256: sha(bytes) }] };
    },
  };
  const f = await fixture({ native: port });
  createProject(f); seedLifecycle(f);
  await f.app.execute(f.auth.actor, backupCommand(f));
  await f.app.execute(f.auth.actor, backupCommand(f));
  const files = managedFiles(f.backupDir);
  huge = true;
  await expect(f.app.execute(f.auth.actor, backupCommand(f))).rejects.toThrow("backup_too_large");
  expect(f.app.backups(f.auth.actor).manifests).toHaveLength(2);
  expect(managedFiles(f.backupDir)).toEqual(files);
});

test("disk-full staging fails explicitly with no inventory entry", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  await f.app.execute(f.auth.actor, backupCommand(f));
  const files = managedFiles(f.backupDir);
  chmodSync(f.backupDir, 0o500);
  try {
    await expect(f.app.execute(f.auth.actor, backupCommand(f))).rejects.toThrow("backup_storage_unavailable");
  } finally { chmodSync(f.backupDir, 0o700); }
  expect(f.app.backups(f.auth.actor).manifests).toHaveLength(1);
  expect(managedFiles(f.backupDir)).toEqual(files);
});

test("orphan reconciliation removes stale uncommitted managed files only", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  const kept = await f.app.execute(f.auth.actor, backupCommand(f));
  const stale = rid(), fresh = rid();
  writeFileSync(join(f.backupDir, `${stale}.sqlite`), "crashed image");
  writeFileSync(join(f.backupDir, `${stale}.native-0.json`), "crashed native");
  writeFileSync(join(f.backupDir, `${fresh}.sqlite`), "being staged elsewhere");
  writeFileSync(join(f.backupDir, "operator-notes.txt"), "not managed");
  const old = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(join(f.backupDir, `${stale}.sqlite`), old, old);
  utimesSync(join(f.backupDir, `${stale}.native-0.json`), old, old);
  utimesSync(kept.manifest.artifact.path, old, old);
  await f.app.execute(f.auth.actor, backupCommand(f));
  const names = managedFiles(f.backupDir);
  expect(names).not.toContain(`${stale}.sqlite`);
  expect(names).not.toContain(`${stale}.native-0.json`);
  expect(names).toContain(`${fresh}.sqlite`);
  expect(names).toContain("operator-notes.txt");
  expect(existsSync(kept.manifest.artifact.path)).toBe(true);
});

test("concurrent project write after snapshot does not corrupt manifest revision", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f, "โครงการ A"); seedLifecycle(f);
  const before = f.app.workspace(f.auth.actor).revision;
  const pending = f.app.execute(f.auth.actor, backupCommand(f));
  // The app image and inventory were captured synchronously before this write.
  createProject(f, "โครงการ B");
  const receipt = await pending;
  expect(receipt.manifest.appRevision).toBe(before);
  expect(receipt.manifest.projects).toHaveLength(1);
  expect(f.app.backup(f.auth.actor, receipt.manifest.id).manifest.appRevision).toBe(before);
  expect(f.app.workspace(f.auth.actor).projects).toHaveLength(2);
});

test("ordinary backup image excludes every credential and secret-bearing value", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  const telegram = new TelegramChannel(f.store, f.config, { now: () => 1800000000000 });
  const channel = telegram.authenticate(f.token);
  const pending = telegram.execute(channel, { kind: "telegram.bind", requestId: rid(), expectedRevision: telegram.status(channel).binding.revision,
    payload: { telegramUserId: 42, telegramChatId: 77 } });
  const nonce = pending.binding.challengeNonce!;
  const passwordHash = f.store.read(tx => tx.get<{ password_hash: string }>("SELECT password_hash FROM owner")!.password_hash);
  const tokenHash = createHash("sha256").update(f.token).digest("hex");
  const receipt = await f.app.execute(f.auth.actor, backupCommand(f));
  const raw = readFileSync(receipt.manifest.artifact.path);
  for (const secret of [passwordHash, "$argon2id", tokenHash, f.token, password, nonce]) {
    expect(raw.includes(Buffer.from(secret))).toBe(false);
  }
  const image = new Database(receipt.manifest.artifact.path, { readonly: true });
  try {
    for (const table of ["owner", "sessions", "login_throttle", "job_scheduler", "delivery_worker"]) {
      expect((image.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
    expect(image.query("SELECT challenge_nonce FROM telegram_binding").get()).toEqual({ challenge_nonce: null });
    expect((image.query("SELECT count(*) AS n FROM projects").get() as { n: number }).n).toBe(1);
  } finally { image.close(); }
  expect(receipt.manifest.credentials).toEqual({ included: false, excludedTables: ["delivery_worker", "job_scheduler", "login_throttle", "ops_backups", "owner", "sessions"],
    scrubbed: ["telegram_binding.challenge_nonce", "command_receipts.result_json"], restore: "owner_credential_setup_required" });
  expect(scanBackupSecrets(receipt.manifest, [passwordHash, tokenHash, f.token, nonce])).toEqual([]);
  // The live installation still holds its credentials.
  expect(f.app.authenticate(f.token).actor.ownerId).toBe("owner");
});

test("every schema table is classified and an unclassified table fails creation closed", async () => {
  const f = await fixture({ native: scriptedNative() });
  const tables = f.store.read(tx => tx.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")).map(r => r.name);
  expect(tables.filter(name => !(name in backupImageTables))).toEqual([]);
  f.store.transaction(tx => tx.run("CREATE TABLE unreviewed_secret_store (value TEXT)"));
  await expect(f.app.execute(f.auth.actor, backupCommand(f))).rejects.toThrow("backup_schema_unclassified");
  expect(f.app.backups(f.auth.actor).manifests).toHaveLength(0);
  expect(managedFiles(f.backupDir)).toEqual([]);
});

test("restoring a credential-free image keeps live credentials; a fresh installation requires owner setup", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  const receipt = await f.app.execute(f.auth.actor, backupCommand(f));
  createProject(f, "after backup");
  f.store.swapFrom(receipt.manifest.artifact.path);
  // In-place activation: the backup's (empty) credential state never replaces the live owner.
  expect(f.app.workspace(f.app.authenticate(f.token).actor).projects).toHaveLength(1);
  expect(await f.app.login(password)).toBeString();
  // Fresh installation activated from the same image has no owner until setup runs.
  const root = mkdtempSync(join(tmpdir(), "jit-ops-backup-fresh-")); roots.push(root);
  const fresh = new TransactionStore(join(root, "state.sqlite")); stores.push(fresh);
  fresh.swapFrom(receipt.manifest.artifact.path);
  const app = new Application(fresh, readConfig({ JIT_DATABASE: join(root, "state.sqlite") }), { backupDir: join(root, "b") });
  await expect(app.login(password)).rejects.toThrow("owner_setup_required");
  expect(() => app.authenticate(f.token)).toThrow("authentication_required");
  await app.setupOwner("fresh-owner-password-1");
  expect(app.workspace(app.authenticate(await app.login("fresh-owner-password-1")).actor).projects).toHaveLength(1);
});

test("manifests record the shipped jitVersion and reject fixture or malformed versions on read", async () => {
  expect(jitAppVersion).toBe(`jit/${packageManifest.version}`);
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  const receipt = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(receipt.manifest.jitVersion).toBe(jitAppVersion);
  const injected = await fixture({ native: scriptedNative(), jitVersion: "jit/0.1.0+build.7" });
  createProject(injected);
  expect((await injected.app.execute(injected.auth.actor, backupCommand(injected))).manifest.jitVersion).toBe("jit/0.1.0+build.7");
  expect(() => new Application(f.store, f.config, { jitVersion: "jit-mvp-fixture" })).toThrow("invalid_jit_version");
  f.store.transaction(tx => tx.run("UPDATE ops_backups SET record_json = json_set(record_json, '$.jitVersion', 'jit-mvp-fixture') WHERE id = ?", receipt.manifest.id));
  expect(() => f.app.backup(f.auth.actor, receipt.manifest.id)).toThrow("backup_corrupt");
});

test("reference inventory overflow is counted and marks the manifest incomplete", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  f.store.transaction(tx => {
    for (let i = 0; i < 1000; i++) tx.run("INSERT INTO projects VALUES (?, ?, 1, ?)", rid(), `bulk ${i}`, 1800000000000 + i);
  });
  const receipt = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(receipt.manifest.inventory).toEqual({ complete: false, projects: { total: 1001, recorded: 1000 }, sources: expect.objectContaining({ recorded: expect.any(Number) }) as never });
  expect(receipt.manifest.projects).toHaveLength(1000);
  expect(receipt.manifest.state).toBe("incomplete");
  expect(receipt.manifest.reason).toBe("inventory_truncated");
});

test("web inventory, detail and API creation render without secrets or worker activation", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  const receipt = await f.app.execute(f.auth.actor, backupCommand(f));
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
  const created = await f.web(new Request("http://localhost:3000/api/backups", { method: "POST",
    headers: { cookie: `jit_session=${f.token}`, origin: "http://localhost:3000", "content-type": "application/json", "x-csrf-token": f.auth.csrf },
    body: JSON.stringify({ requestId: rid(), expectedRevision: f.app.workspace(f.auth.actor).revision, note: "web backup" }) }));
  expect(created.status).toBe(200);
  expect((await created.json() as { manifest: { state: string } }).manifest.state).toBe("valid");
});

// ---------------------------------------------------------------------------
// Concrete Schway port: real native sessions through the pinned public host
// (scripted model transport, no network, no credentials).
// ---------------------------------------------------------------------------

function scriptedModel(text: string): Model {
  return {
    provider: "scripted", id: "backup-fixture",
    async *stream(_request: ModelRequest) {
      yield { type: "message_complete", message: { type: "assistant", id: rid(), content: [{ type: "text", text }] } };
    },
  };
}

function runRequest(config: ReturnType<typeof readConfig>): ApplicationRunRequest {
  const projectId = rid();
  return { runId: rid(), projectId, topicId: rid(), roleId: rid(), purpose: "สำรองเซสชันจริง",
    route: { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" },
    configuration: { ownerRevision: 1, projectRevision: 1, roleRevision: 1 },
    context: { id: rid(), generation: 1 }, fence: { jobId: rid(), generation: 1, ownerGeneration: 1 },
    instructions: { operator: ["backup fixture"], responsibility: "ทดสอบ" },
    manifest: { sources: [{ projectId, reference: { sourceId: rid(), revision: 1, generation: 1 }, text: "ต้นทาง" }], claims: [] },
    tools: [], policy: { genericExecution: false, arbitraryFetch: false, hostedLookup: false, repositoryDiscovery: false },
    limits: structuredClone(config.jobs.maximum) };
}

/** Creates one real finished native session for an active context. */
async function nativeRun(store: TransactionStore, config: ReturnType<typeof readConfig>, hooks?: SchwayPortOptions["testHooks"]) {
  const run = runRequest(config);
  store.transaction(tx => { tx.run("INSERT OR REPLACE INTO team_contexts VALUES (?, ?, 'active')", run.context.id, run.context.generation); });
  const port = new SchwayRunPort(store, config.team, config.jobs.outputBytes, { model: scriptedModel("หลักฐาน"), ...(hooks ? { testHooks: hooks } : {}) });
  const outcome = port.invoke(run, new AbortController().signal, () => {});
  return { run, port, outcome };
}

async function concreteFixture(options: ConstructorParameters<typeof SchwayBackupNativePort>[1] = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-ops-backup-concrete-")); roots.push(root);
  const dbPath = join(root, "state.sqlite");
  const config = readConfig({ JIT_DATABASE: dbPath });
  const backupDir = join(root, "backups");
  const store = new TransactionStore(dbPath); stores.push(store);
  const port = new SchwayBackupNativePort(store, options);
  // Gate holds on a fresh installation directory: no credentials, no network.
  expect(port.available()).toBe(true);
  const app = new Application(store, config, { now: () => 1800000000000, backupDir, nativeSnapshot: port });
  await app.setupOwner(password);
  const token = await app.login(password);
  const auth = app.authenticate(token);
  createProject({ app, auth });
  seedLifecycle({ app, auth, store });
  return { root, dbPath, config, store, app, auth, token, backupDir, port };
}

async function validateNativeFile(store: TransactionStore, path: string) {
  const host = await new SchwayRunPort(store, { roleLimit: 24, responsibilityBytes: 2048, sourceLimit: 8, contextBytes: 32768 }, 4096).openLifecycleHost();
  try { return host.validateSessionSnapshot(JSON.parse(readFileSync(path, "utf8"))); }
  finally { await host.close(); }
}

test("concrete port stays unavailable when the service gate fails and never yields a valid backup", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-ops-backup-gate-")); roots.push(root);
  const dbPath = join(root, "state.sqlite");
  const config = readConfig({ JIT_DATABASE: dbPath });
  const store = new TransactionStore(dbPath); stores.push(store);
  // A file where the service-owned base must be blocks the pinned gate.
  writeFileSync(join(root, ".jit-host"), "blocker");
  const port = createSchwayBackupNativePort(store);
  expect(port.available()).toBe(false);
  expect(resolveNativeSnapshot(port).state).toBe("unavailable");
  const app = new Application(store, config, { now: () => 1800000000000, backupDir: join(root, "backups"), nativeSnapshot: port });
  await app.setupOwner(password);
  const auth = app.authenticate(await app.login(password));
  createProject({ app, auth });
  const receipt = await app.execute(auth.actor, backupCommand({ app, auth }));
  expect(receipt.manifest.native.state).toBe("unavailable");
  expect(receipt.manifest.state).toBe("incomplete");
});

test("concrete port snapshots real native sessions through snapshotSessions and stores validated opaque artifacts", async () => {
  const f = await concreteFixture();
  const first = await nativeRun(f.store, f.config);
  expect(await first.outcome).toMatchObject({ state: "complete" });
  const second = await nativeRun(f.store, f.config);
  await second.outcome;
  // Unrelated files in the session directory never make anything valid or invalid.
  writeFileSync(join(schwayHostDirs(f.dbPath).sessionDirectory, "unrelated.bin"), "not a Schway snapshot");
  const receipt = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(receipt.manifest.state).toBe("valid");
  expect(receipt.manifest.native).toMatchObject({ state: "valid", engine: schwayBackupEngine, contract: "schway.host.session-snapshot/v1", reason: null });
  expect(receipt.manifest.native.refs).toEqual([{ id: first.run.runId, generation: 1 }, { id: second.run.runId, generation: 1 }]);
  // Default single-session calls: one validated opaque artifact per session.
  expect(receipt.manifest.native.artifacts).toHaveLength(2);
  for (const artifact of receipt.manifest.native.artifacts) {
    expect(artifact.path.startsWith(f.backupDir + "/")).toBe(true);
    expect(sha(readFileSync(artifact.path))).toBe(artifact.hash);
    const verdict = await validateNativeFile(f.store, artifact.path);
    expect(verdict.status).toBe("valid");
    if (verdict.status === "valid") expect(verdict.sessions).toHaveLength(1);
  }
  expect(receipt.manifest.native.bytes).toBe(receipt.manifest.native.artifacts.reduce((sum, a) => sum + a.bytes, 0));
  expect(f.app.backup(f.auth.actor, receipt.manifest.id).integrity).toEqual({ state: "verified", reason: null });
  // Opaque native session/branch ids never leave the store in the manifest.
  const sessionIds = f.store.read(tx => tx.all<{ session_id: string; branch_id: string }>("SELECT session_id, branch_id FROM schway_native_refs"));
  for (const row of sessionIds) {
    expect(JSON.stringify(receipt.manifest)).not.toContain(row.session_id);
  }
  expect(scanBackupSecrets(receipt.manifest, [password, f.token])).toEqual([]);
  // Larger chunks: one artifact per supported snapshot call, same coverage.
  const chunked = new SchwayBackupNativePort(f.store, { chunkSize: 64 });
  const snap = await chunked.snapshot();
  expect(snap.artifacts).toHaveLength(1);
});

test("nonexistent or natively deleted sessions fail closed instead of presenting a valid backup", async () => {
  const f = await concreteFixture();
  // The reviewer repro: a durable ref to a session that does not exist plus an unrelated file.
  const contextId = rid(), runId = rid();
  f.store.transaction(tx => {
    tx.run("INSERT INTO team_contexts VALUES (?, 1, 'active')", contextId);
    tx.run("INSERT INTO schway_native_refs (run_id, context_id, generation, session_id, branch_id, state, created_at, updated_at) VALUES (?, ?, 1, ?, ?, 'finished', 1, 1)",
      runId, contextId, rid(), "main");
  });
  writeFileSync(join(schwayHostDirs(f.dbPath).sessionDirectory, "unrelated.bin"), "not a Schway snapshot");
  const missing = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(missing.manifest.native.state).toBe("incomplete");
  expect(missing.manifest.native.reason).toBe("native_artifact_missing");
  expect(missing.manifest.state).toBe("incomplete");
  expect(missing.manifest.native.artifacts).toEqual([]);
  // A real session deleted natively while the app context is still active.
  f.store.transaction(tx => tx.run("DELETE FROM schway_native_refs WHERE run_id = ?", runId));
  const real = await nativeRun(f.store, f.config);
  await real.outcome;
  const ref = f.store.read(tx => tx.get<{ session_id: string; branch_id: string }>("SELECT session_id, branch_id FROM schway_native_refs WHERE run_id = ?", real.run.runId))!;
  const host = await real.port.openLifecycleHost();
  try { await host.deleteSession({ id: ref.session_id, branchId: ref.branch_id }); } finally { await host.close(); }
  const deleted = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(deleted.manifest.native).toMatchObject({ state: "incomplete", reason: "native_artifact_missing" });
  // Once the app itself records the deletion, the context leaves the native set.
  f.store.transaction(tx => tx.run("UPDATE team_contexts SET state = 'deleted' WHERE id = ?", real.run.context.id));
  const after = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(after.manifest.native).toMatchObject({ state: "valid", refs: [] });
  // Reserved creation intents without a native id are unresolved, never skipped.
  f.store.transaction(tx => tx.run("INSERT INTO schway_native_refs (run_id, context_id, generation, session_id, branch_id, state, created_at, updated_at) VALUES (?, ?, 1, '', '', 'running', 1, 1)", rid(), contextId));
  const intent = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(intent.manifest.native).toMatchObject({ state: "incomplete", reason: "native_ref_unresolved" });
});

test("busy native sessions are rejected by the app state and by the host quiesce lease", async () => {
  const f = await concreteFixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let created!: () => void;
  const opened = new Promise<void>(resolve => { created = resolve; });
  const live = await nativeRun(f.store, f.config, { afterCreateSession: async () => { created(); await gate; } });
  await opened;
  const running = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(running.manifest.native).toMatchObject({ state: "incomplete", reason: "native_sessions_busy" });
  // Even if the durable row claims finished, Schway's own lease rejects the open writer.
  f.store.transaction(tx => tx.run("UPDATE schway_native_refs SET state = 'finished' WHERE run_id = ?", live.run.runId));
  const leased = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(leased.manifest.native).toMatchObject({ state: "incomplete", reason: "native_sessions_busy" });
  release();
  await live.outcome;
  const settled = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(settled.manifest.native.state).toBe("valid");
  expect(managedFiles(f.backupDir).filter(n => n.includes(".native-"))).toHaveLength(1);
});

test("native set changes during capture and over-limit sets never commit as valid", async () => {
  const f = await concreteFixture();
  const run = await nativeRun(f.store, f.config);
  await run.outcome;
  const concrete = new SchwayBackupNativePort(f.store);
  const racing: BackupNativePort = {
    engine: concrete.engine, staged: true, contract: concrete.contract, formatVersion: concrete.formatVersion,
    available: () => concrete.available(),
    resolve: tx => concrete.resolve(tx),
    snapshot: async plan => {
      const snap = await concrete.snapshot(plan);
      await run.port.retire(run.run.context);
      return snap;
    },
  };
  const app = new Application(f.store, f.config, { now: () => 1800000000000, backupDir: f.backupDir, nativeSnapshot: racing });
  const actor = app.authenticate(f.token).actor;
  const raced = await app.execute(actor, backupCommand({ app, auth: { actor } }));
  expect(raced.manifest.native).toMatchObject({ state: "incomplete", reason: "native_changed_during_backup", artifacts: [] });
  expect(raced.manifest.state).toBe("incomplete");
  expect(managedFiles(f.backupDir).filter(n => n.includes(".native-"))).toEqual([]);
  // Retired sessions remain capturable (recorded retired by the engine).
  expect((await f.app.execute(f.auth.actor, backupCommand(f))).manifest.native.state).toBe("valid");
  const second = await nativeRun(f.store, f.config);
  await second.outcome;
  const limited = new Application(f.store, f.config, { now: () => 1800000000000, backupDir: f.backupDir,
    nativeSnapshot: new SchwayBackupNativePort(f.store, { maxSessions: 1 }) });
  const limitedActor = limited.authenticate(f.token).actor;
  const over = await limited.execute(limitedActor, backupCommand({ app: limited, auth: { actor: limitedActor } }));
  expect(over.manifest.native).toMatchObject({ state: "incomplete", reason: "native_snapshot_over_limit" });
});

test("upgrade prepare records a credential-free recovery point with the real version and fails closed on staged engine ports", async () => {
  const f = await fixture({ native: { available: () => true, snapshot: () => ({ refs: [], bytes: 0, engine: "scripted-fixture-v1" }) } });
  createProject(f); seedLifecycle(f);
  const journal = f.store.transaction(tx => prepareUpgrade(tx, f.store, {
    id: rid(), now: 1800000000000, appRevision: f.app.workspace(f.auth.actor).revision,
    targetSchema: currentSupportedSchema, note: "fixture engine", upgradeDir: join(f.root, "upgrades"), backupDir: f.backupDir,
    engine: { available: () => true, snapshot: () => ({ refs: [], bytes: 0, engine: "scripted-fixture-v1" }) },
  }));
  const manifest = f.app.backup(f.auth.actor, journal.snapshotBackupId!).manifest;
  expect(manifest.jitVersion).toBe(jitAppVersion);
  expect(manifest.credentials.included).toBe(false);
  const passwordHash = f.store.read(tx => tx.get<{ password_hash: string }>("SELECT password_hash FROM owner")!.password_hash);
  expect(readFileSync(manifest.artifact.path).includes(Buffer.from(passwordHash))).toBe(false);
  const c = await concreteFixture();
  const run = await nativeRun(c.store, c.config);
  await run.outcome;
  expect(() => c.store.transaction(tx => prepareUpgrade(tx, c.store, {
    id: rid(), now: 1800000000000, appRevision: c.app.workspace(c.auth.actor).revision,
    targetSchema: currentSupportedSchema, note: "concrete engine", upgradeDir: join(c.root, "upgrades"), backupDir: c.backupDir, engine: c.port,
  }))).toThrow("native_snapshot_unavailable");
  expect(c.app.backups(c.auth.actor).manifests).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// Review round 2 regressions
// ---------------------------------------------------------------------------

test("restore preparation rejects every non-valid backup; owner acknowledgments cannot override it", async () => {
  // Native unavailable.
  const f = await fixture();
  createProject(f);
  const noNative = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(noNative.manifest.state).toBe("incomplete");
  expect(() => restorePrepare(f, noNative.manifest.id)).toThrow("backup_incomplete");
  // Unverifiable lifecycle ledger: explicit, unavailable, never "no deletions".
  const g = await fixture({ native: scriptedNative() });
  createProject(g); seedLifecycle(g);
  g.store.transaction(tx => tx.run("UPDATE memory_suppressions SET record_json = '{\"broken\":true}'"));
  const noLedger = await g.app.execute(g.auth.actor, backupCommand(g));
  expect(noLedger.manifest.lifecycle).toEqual({ available: false, checkpoint: null, reason: "ledger_unverifiable", position: null });
  expect(noLedger.manifest).toMatchObject({ state: "incomplete", reason: "ledger_unverifiable" });
  expect(() => restorePrepare(g, noLedger.manifest.id)).toThrow("backup_incomplete");
  // Even a record forged to say valid is rejected when its lifecycle checkpoint is missing.
  g.store.transaction(tx => tx.run("UPDATE ops_backups SET record_json = json_set(record_json, '$.state', 'valid') WHERE id = ?", noLedger.manifest.id));
  expect(() => restorePrepare(g, noLedger.manifest.id)).toThrow("backup_incomplete");
  expect(g.app.restores(g.auth.actor).quarantines).toHaveLength(0);
  // A complete backup still prepares.
  g.store.transaction(tx => tx.run("UPDATE memory_suppressions SET record_json = json_object('id', id)"));
  const good = await g.app.execute(g.auth.actor, backupCommand(g));
  expect(good.manifest.state).toBe("valid");
  expect(restorePrepare(g, good.manifest.id).quarantine.state).toBe("quarantining");
});

test("inspection and restore verify every managed artifact: missing, corrupt, relocated or symlinked files are invalid", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  const make = async () => (await f.app.execute(f.auth.actor, backupCommand(f))).manifest;
  const ok = await make();
  expect(f.app.backup(f.auth.actor, ok.id)).toEqual({ manifest: ok, integrity: { state: "verified", reason: null } });
  // Deleting the only native file.
  const missing = await make();
  rmSync(missing.native.artifacts[0]!.path);
  const inspected = f.app.backup(f.auth.actor, missing.id);
  expect(inspected.integrity).toEqual({ state: "invalid", reason: "native_artifact_missing" });
  expect(inspected.manifest.state).toBe("incomplete");
  expect(() => restorePrepare(f, missing.id)).toThrow("backup_integrity_failed");
  // Corrupt native bytes of the same size.
  const corrupt = await make();
  const nativePath = corrupt.native.artifacts[0]!.path;
  writeFileSync(nativePath, Buffer.alloc(corrupt.native.artifacts[0]!.bytes, 1));
  expect(f.app.backup(f.auth.actor, corrupt.id).integrity.reason).toBe("native_artifact_hash_mismatch");
  // A manifest pointing outside the managed directory, even at identical bytes.
  const moved = await make();
  const outside = join(f.root, "elsewhere.json");
  copyFileSync(moved.native.artifacts[0]!.path, outside);
  f.store.transaction(tx => tx.run("UPDATE ops_backups SET record_json = json_set(record_json, '$.native.artifacts[0].path', ?) WHERE id = ?", outside, moved.id));
  expect(f.app.backup(f.auth.actor, moved.id).integrity.reason).toBe("native_artifact_outside_backup_dir");
  expect(() => restorePrepare(f, moved.id)).toThrow("backup_integrity_failed");
  // A symlink in place of the managed image.
  const linked = await make();
  const copy = join(f.root, "image-copy.sqlite");
  copyFileSync(linked.artifact.path, copy);
  rmSync(linked.artifact.path);
  symlinkSync(copy, linked.artifact.path);
  expect(f.app.backup(f.auth.actor, linked.id).integrity.reason).toBe("image_not_regular_file");
  // A valid native set whose artifact list was emptied.
  const stripped = await make();
  f.store.transaction(tx => tx.run("UPDATE ops_backups SET record_json = json_set(record_json, '$.native.artifacts', json('[]')) WHERE id = ?", stripped.id));
  expect(f.app.backup(f.auth.actor, stripped.id).integrity.reason).toBe("native_artifacts_missing");
  // Missing image keeps the established restore code.
  const noImage = await make();
  rmSync(noImage.artifact.path);
  expect(() => restorePrepare(f, noImage.id)).toThrow("backup_artifact_missing");
  expect(f.app.restores(f.auth.actor).quarantines).toHaveLength(0);
});

test("inventory overflow is not restorable", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  f.store.transaction(tx => {
    for (let i = 0; i < 1000; i++) tx.run("INSERT INTO projects VALUES (?, ?, 1, ?)", rid(), `bulk ${i}`, 1800000000000 + i);
  });
  const receipt = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(receipt.manifest.inventory.complete).toBe(false);
  expect(() => restorePrepare(f, receipt.manifest.id)).toThrow("backup_incomplete");
});

test("non-empty native captures must declare the port's supported contract and format version", () => {
  const ref = { id: rid(), generation: 1 };
  const artifact = artifactOf("opaque");
  const base = { refs: [ref], bytes: 6, engine: "fixture", artifacts: [artifact] };
  const port = fixtureContract;
  expect(normalizeNativeSnapshot(base, undefined, port).section).toMatchObject({ state: "incomplete", reason: "native_snapshot_incompatible" });
  expect(normalizeNativeSnapshot({ ...base, contract: fixtureContract.contract }, undefined, port).section.state).toBe("incomplete");
  expect(normalizeNativeSnapshot({ ...base, contract: "other.snapshot/v1", formatVersion: 1 }, undefined, port).section.reason).toBe("native_snapshot_incompatible");
  expect(normalizeNativeSnapshot({ ...base, ...fixtureContract, formatVersion: 2 }, undefined, port).section.reason).toBe("native_snapshot_incompatible");
  expect(normalizeNativeSnapshot({ ...base, ...fixtureContract }, undefined, {}).section.reason).toBe("native_snapshot_incompatible");
  expect(normalizeNativeSnapshot({ ...base, ...fixtureContract }, undefined, port).section).toMatchObject({ state: "valid", ...fixtureContract });
  // An empty set needs no artifacts and declares nothing.
  expect(normalizeNativeSnapshot({ refs: [], bytes: 0, engine: "fixture" }, undefined, {}).section.state).toBe("valid");
});

test("orphaned and generation-mismatched native refs fail capture instead of being dropped", async () => {
  const f = await concreteFixture();
  const run = await nativeRun(f.store, f.config);
  await run.outcome;
  expect((await f.app.execute(f.auth.actor, backupCommand(f))).manifest.native.state).toBe("valid");
  // A ref whose context row is missing (no foreign key prevents it).
  const orphanRun = rid();
  f.store.transaction(tx => tx.run("INSERT INTO schway_native_refs (run_id, context_id, generation, session_id, branch_id, state, created_at, updated_at) VALUES (?, ?, 1, ?, 'main', 'finished', 1, 1)",
    orphanRun, rid(), rid()));
  const orphan = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(orphan.manifest.native).toMatchObject({ state: "incomplete", reason: "native_ref_orphaned" });
  expect(orphan.manifest.state).toBe("incomplete");
  // A ref whose generation does not match its context row.
  f.store.transaction(tx => tx.run("UPDATE schway_native_refs SET context_id = ?, generation = 2 WHERE run_id = ?", run.run.context.id, orphanRun));
  const mismatched = await f.app.execute(f.auth.actor, backupCommand(f));
  expect(mismatched.manifest.native).toMatchObject({ state: "incomplete", reason: "native_ref_orphaned" });
  // Orphans enter the fingerprint: adding one changes the plan.
  const port = new SchwayBackupNativePort(f.store);
  const before = f.store.read(tx => port.resolve(tx)).fingerprint;
  f.store.transaction(tx => tx.run("DELETE FROM schway_native_refs WHERE run_id = ?", orphanRun));
  expect(f.store.read(tx => port.resolve(tx)).fingerprint).not.toBe(before);
  expect((await f.app.execute(f.auth.actor, backupCommand(f))).manifest.native.state).toBe("valid");
});

test("the native byte budget is enforced after each single-session host call and stops further capture", async () => {
  const f = await concreteFixture();
  for (let i = 0; i < 3; i++) await (await nativeRun(f.store, f.config)).outcome;
  const original = SchwayRunPort.prototype.openLifecycleHost;
  let calls = 0;
  SchwayRunPort.prototype.openLifecycleHost = async function (this: SchwayRunPort) {
    const host = await original.call(this);
    // The host object is frozen; forward exactly the members the backup port uses.
    return {
      capabilities: host.capabilities,
      snapshotSessions: async (...args: Parameters<typeof host.snapshotSessions>) => { calls++; return host.snapshotSessions(...args); },
      validateSessionSnapshot: (snapshot: unknown) => host.validateSessionSnapshot(snapshot),
      close: () => host.close(),
    } as unknown as typeof host;
  };
  try {
    const port = new SchwayBackupNativePort(f.store);
    const plan = f.store.read(tx => port.resolve(tx));
    const one = (await port.snapshot(plan)).artifacts![0]!.bytes.length;
    calls = 0;
    await expect(port.snapshot(plan, { maxBytes: one + 1 })).rejects.toThrow("backup_too_large");
    expect(calls).toBe(2);
    calls = 0;
    await expect(captureNativeSnapshot(port, plan, { maxBytes: 1 })).rejects.toThrow("backup_too_large");
    expect(calls).toBe(1);
  } finally {
    SchwayRunPort.prototype.openLifecycleHost = original;
  }
  expect(managedFiles(f.backupDir)).toEqual([]);
});

// ---------------------------------------------------------------------------
// Review round 3 regressions
// ---------------------------------------------------------------------------

test("the bounded inventory list verifies every entry and never labels a broken backup valid", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  const good = (await f.app.execute(f.auth.actor, backupCommand(f))).manifest;
  const broken = (await f.app.execute(f.auth.actor, backupCommand(f))).manifest;
  rmSync(broken.native.artifacts[0]!.path);
  const listed = f.app.backups(f.auth.actor);
  expect(listed.integrity).toEqual({ [good.id]: { state: "verified", reason: null }, [broken.id]: { state: "invalid", reason: "native_artifact_missing" } });
  expect(listed.manifests.find(m => m.id === good.id)!.state).toBe("valid");
  expect(listed.manifests.find(m => m.id === broken.id)).toMatchObject({ state: "incomplete", reason: "native_artifact_missing" });
  const api = await f.web(new Request("http://localhost:3000/api/backups", { headers: { cookie: `jit_session=${f.token}` } }));
  const body = await api.json() as { manifests: { id: string; state: string }[]; integrity: Record<string, { state: string }> };
  expect(body.manifests.find(m => m.id === broken.id)!.state).toBe("incomplete");
  expect(body.integrity[broken.id]!.state).toBe("invalid");
  const html = await (await f.web(new Request("http://localhost:3000/backups", { headers: { cookie: `jit_session=${f.token}` } }))).text();
  expect(html).toContain(`id="backup-${broken.id}"><header><h3><a href="/backups/${broken.id}">${broken.id}</a></h3><span class="job-status" data-state="incomplete"`);
});

test("restore activation keeps the live backup registry: two backups survive restoring the older one", async () => {
  const f = await fixture({ native: scriptedNative() });
  createProject(f); seedLifecycle(f);
  const older = (await f.app.execute(f.auth.actor, backupCommand(f))).manifest;
  createProject(f, "after older backup");
  const newer = (await f.app.execute(f.auth.actor, backupCommand(f))).manifest;
  // The registry is installation state: it is not inside any image.
  const image = new Database(older.artifact.path, { readonly: true });
  try { expect((image.query("SELECT count(*) AS n FROM ops_backups").get() as { n: number }).n).toBe(0); } finally { image.close(); }
  const step = (kind: "restore.migrate" | "restore.validate" | "restore.activate", quarantineId: string) => f.app.execute(f.auth.actor, {
    kind, requestId: rid(), projectId: null, expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { quarantineId } });
  const prepared = restorePrepare(f, older.id).quarantine;
  step("restore.migrate", prepared.id);
  f.app.execute(f.auth.actor, { kind: "restore.apply_ledger", requestId: rid(), projectId: null, expectedRevision: f.app.workspace(f.auth.actor).revision,
    payload: { quarantineId: prepared.id, tombstones: [], source: "live-deletion-ledger", asOf: 1800000000000, acknowledgedEmpty: true } });
  expect(step("restore.validate", prepared.id).quarantine.state).toBe("validated");
  expect(step("restore.activate", prepared.id).quarantine.state).toBe("complete");
  // Restored content is the older image; the registry, files and integrity are the live ones.
  expect(f.app.workspace(f.auth.actor).projects).toHaveLength(1);
  const listed = f.app.backups(f.auth.actor);
  expect(listed.manifests.map(m => m.id)).toEqual([older.id, newer.id]);
  expect(Object.values(listed.integrity).every(v => v.state === "verified")).toBe(true);
  // Reconciliation keeps every registered file: nothing is orphaned by the activation.
  const old = new Date(Date.now() - 60 * 60 * 1000);
  for (const name of managedFiles(f.backupDir)) utimesSync(join(f.backupDir, name), old, old);
  const third = (await f.app.execute(f.auth.actor, backupCommand(f))).manifest;
  expect(f.app.backups(f.auth.actor).manifests.map(m => m.id)).toEqual([older.id, newer.id, third.id]);
  for (const id of [older.id, newer.id]) expect(f.app.backup(f.auth.actor, id).integrity.state).toBe("verified");
});
