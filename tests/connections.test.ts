import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, type OwnerActor } from "../src/application";
import { readConfig } from "../src/config";
import { commitDeliveryIntent } from "../src/delivery/outbox";
import { AppError } from "../src/errors";
import { createBoxBackend } from "../src/exec/box-backend";
import { ConnectionVault, releaseConnection, type ConnectionCommand, type ConnectionReceipt } from "../src/exec/connections";
import { FakeBoxRuntime } from "../src/exec/fake-box-runtime";
import { dictionaries } from "../src/i18n";
import { backupImageTables } from "../src/ops/backup";
import { containsCredential, redactCredentials } from "../src/security/credentials";
import { logLine } from "../src/security/log";
import { containsRegisteredSecret, redactRegisteredSecrets } from "../src/security/secret-fingerprints";
import { TransactionStore, schemaVersion } from "../src/store";
import { describeEffectiveRun } from "../src/team/schway-port";
import type { ApplicationRunRequest } from "../src/team/types";
import { createWebHandler } from "../src/web";

const roots: string[] = [], stores: TransactionStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch { /* Closed. */ } }
  for (const root of roots.splice(0)) { try { chmodSync(join(root, "secrets"), 0o700); } catch { /* Gone. */ } rmSync(root, { recursive: true, force: true }); }
});
const rid = () => crypto.randomUUID(), password = "fixture-exe08-owner-password", epoch = 1_800_000_000_000, origin = "http://localhost:3000";
/** A fresh, unguessable fixture value per test: the fingerprint registry is process-wide. */
const secretValue = (label: string) => `fixture-${label}-${crypto.randomUUID()}-${crypto.randomUUID()}`;
function rejects(action: () => unknown, code: string, status?: number): AppError {
  try { action(); } catch (error) {
    expect(error).toBeInstanceOf(AppError); expect((error as AppError).code).toBe(code);
    if (status !== undefined) expect((error as AppError).status).toBe(status);
    return error as AppError;
  }
  throw new Error(`expected ${code}`);
}
/** Every file under `dir` (recursively) that contains `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (path: string) => {
    if (!existsSync(path)) return;
    const stats = statSync(path);
    if (stats.isDirectory()) { for (const name of readdirSync(path)) walk(join(path, name)); return; }
    if (readFileSync(path).includes(Buffer.from(needle))) hits.push(path);
  };
  walk(dir); return hits;
}

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-exe08-"))); roots.push(root);
  const state = join(root, "state"), backups = join(root, "backups"), execution = join(root, "execution"), secrets = join(root, "secrets");
  mkdirSync(state); mkdirSync(execution);
  const config = readConfig({ JIT_DATABASE: join(state, "jit.sqlite"), JIT_EXECUTION_DIR: execution, JIT_EXECUTION_SECRETS_DIR: secrets });
  const store = new TransactionStore(config.databasePath); stores.push(store);
  const vault = new ConnectionVault(secrets, { forbidden: [state, backups, execution] });
  const app = new Application(store, config, { now: () => epoch, backupDir: backups, connections: vault });
  const web = createWebHandler(app);
  await app.setupOwner(password); const token = await app.login(password), auth = app.authenticate(token);
  const telegramActor = app.issueAdapterActor(token, "telegram");
  const project = app.execute(auth.actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: app.workspace(auth.actor).revision, payload: { name: "โครงการ connection" } }).project;
  return { root, state, backups, execution, secrets, config, store, vault, app, web, token, auth, telegramActor, project };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const run = (f: Fixture, command: ConnectionCommand, actor: OwnerActor = f.auth.actor): ConnectionReceipt => f.app.execute(actor, command);
const create = (f: Fixture, scope: string[] | null = null, actor?: OwnerActor) =>
  run(f, { kind: "connection.create", requestId: rid(), projectId: null, expectedRevision: 0, payload: { kind: "github_token", label: "GitHub ของเจ้าของ", projectScope: scope } }, actor);
const withSecret = (f: Fixture, kind: "connection.set_secret" | "connection.rotate", connectionId: string, secret: string, expectedRevision: number, actor?: OwnerActor) =>
  run(f, { kind, requestId: rid(), projectId: null, expectedRevision, payload: { connectionId, secret } }, actor);
const plain = (f: Fixture, kind: "connection.remove" | "connection.test", connectionId: string, expectedRevision: number, actor?: OwnerActor) =>
  run(f, { kind, requestId: rid(), projectId: null, expectedRevision, payload: { connectionId } }, actor);
const audit = (f: Fixture, id: string) => f.store.read(tx => tx.all<{ action: string; purpose: string | null; channel: string }>(
  "SELECT action, purpose, channel FROM connection_audit WHERE connection_id = ? ORDER BY sequence", id));

test("lifecycle: create, set, rotate, test and remove keep the value in a 0600 file and never render it back", async () => {
  const f = await fixture();
  const created = create(f, [f.project.id]).connection;
  expect(created).toMatchObject({ kind: "github_token", label: "GitHub ของเจ้าของ", projectScope: [f.project.id], revision: 1, secret: "empty", rotatedAt: null, removedAt: null });
  const first = secretValue("first"), second = secretValue("second");
  const set = withSecret(f, "connection.set_secret", created.id, `  ${first}\n`, 1);
  expect(set.connection).toMatchObject({ revision: 2, secret: "set" });
  expect(JSON.stringify(set)).not.toContain(first);
  const file = join(f.secrets, created.id);
  expect(readFileSync(file, "utf8")).toBe(first);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(f.secrets).mode & 0o777).toBe(0o700);
  expect(readdirSync(f.secrets)).toEqual([created.id]);
  rejects(() => withSecret(f, "connection.set_secret", created.id, second, 2), "connection_secret_exists", 409);
  rejects(() => withSecret(f, "connection.rotate", created.id, second, 1), "stale_revision", 409);
  const rotated = withSecret(f, "connection.rotate", created.id, second, 2);
  expect(rotated.connection).toMatchObject({ revision: 3, secret: "set", rotatedAt: epoch });
  expect(readFileSync(file, "utf8")).toBe(second);
  expect(plain(f, "connection.test", created.id, 3).test).toEqual({ state: "present" });
  const removed = plain(f, "connection.remove", created.id, 3);
  expect(removed.connection).toMatchObject({ revision: 4, secret: "empty", removedAt: epoch });
  expect(existsSync(file)).toBe(false);
  rejects(() => withSecret(f, "connection.rotate", created.id, second, 4), "connection_removed", 409);
  // A file that cannot be deleted aborts the remove instead of reporting success.
  const stuck = create(f).connection;
  withSecret(f, "connection.set_secret", stuck.id, secretValue("stuck"), 1);
  chmodSync(f.secrets, 0o500);
  try { expect(() => plain(f, "connection.remove", stuck.id, 2)).toThrow(); } finally { chmodSync(f.secrets, 0o700); }
  expect(f.app.connections(f.auth.actor).find(item => item.id === stuck.id)).toMatchObject({ removedAt: null, secret: "set", revision: 2 });
  expect(existsSync(join(f.secrets, stuck.id))).toBe(true);
  expect(audit(f, created.id).map(row => row.action)).toEqual(["created", "secret_set", "rotated", "tested", "removed"]);
  expect(readdirSync(f.secrets).filter(name => name !== stuck.id)).toEqual([]);
  // No read model, receipt, audit or database page carries a value.
  const everything = JSON.stringify([f.app.connections(f.auth.actor), f.store.read(tx => tx.all("SELECT * FROM command_receipts")), f.store.read(tx => tx.all("SELECT * FROM audit"))]);
  for (const value of [first, second]) {
    expect(everything).not.toContain(value);
    expect(filesContaining(f.state, value)).toEqual([]);
    expect(filesContaining(f.execution, value)).toEqual([]);
  }
  // Values are validated; a replayed request id returns its first receipt without writing again.
  const short = create(f).connection;
  rejects(() => withSecret(f, "connection.set_secret", short.id, "short", 1), "invalid_connection_secret");
  const again = create(f).connection;
  const command: ConnectionCommand = { kind: "connection.set_secret", requestId: rid(), projectId: null, expectedRevision: 1, payload: { connectionId: again.id, secret: secretValue("replay") } };
  const receipt = run(f, command);
  expect(run(f, { ...command, payload: { connectionId: again.id, secret: secretValue("other") } })).toEqual(receipt);
  rejects(() => run(f, { kind: "connection.create", requestId: rid(), projectId: null, expectedRevision: 0, payload: { kind: "github_token", label: `token ghp_${"a".repeat(30)}`, projectScope: null } }), "invalid_connection_command");
  rejects(() => run(f, { kind: "connection.create", requestId: rid(), projectId: null, expectedRevision: 0, payload: { kind: "payment", label: "x", projectScope: null } } as never), "invalid_connection_command");
  rejects(() => create(f, [rid()]), "project_not_found", 404);
});

test("every command and the list are Web only: Telegram and the local API get connection_requires_web", async () => {
  const f = await fixture();
  const id = create(f).connection.id;
  f.app.execute(f.auth.actor, { kind: "local_api.set", requestId: rid(), projectId: null, expectedRevision: f.app.localApi(f.auth.actor).revision, payload: { enabled: true } });
  const local = f.app.issueLocalApiActor()!.actor;
  for (const actor of [f.telegramActor, local]) {
    rejects(() => create(f, null, actor), "connection_requires_web", 403);
    rejects(() => withSecret(f, "connection.set_secret", id, secretValue("tg"), 1, actor), "connection_requires_web", 403);
    rejects(() => withSecret(f, "connection.rotate", id, secretValue("tg"), 1, actor), "connection_requires_web", 403);
    rejects(() => plain(f, "connection.test", id, 1, actor), "connection_requires_web", 403);
    rejects(() => plain(f, "connection.remove", id, 1, actor), "connection_requires_web", 403);
    rejects(() => f.app.connections(actor), "connection_requires_web", 403);
  }
  expect(existsSync(f.secrets) ? readdirSync(f.secrets) : []).toEqual([]);
  expect(audit(f, id).map(row => row.action)).toEqual(["created"]);
  // The Web form path: session, Origin and CSRF.
  const post = (path: string, body: unknown, csrf: string | null = f.auth.csrf) => f.web(new Request(`${origin}${path}`, { method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", origin, cookie: `jit_session=${f.token}`, ...(csrf ? { "x-csrf-token": csrf } : {}) } }));
  const value = secretValue("web");
  expect((await post(`/api/connections/${id}/secret`, { requestId: rid(), expectedRevision: 1, secret: value }, null)).status).toBe(403);
  const response = await post(`/api/connections/${id}/secret`, { requestId: rid(), expectedRevision: 1, secret: value });
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(text).not.toContain(value);
  expect(JSON.parse(text).connection).toMatchObject({ id, secret: "set", revision: 2 });
  const listed = await (await f.web(new Request(`${origin}/api/connections`, { headers: { cookie: `jit_session=${f.token}` } }))).text();
  expect(listed).not.toContain(value);
  expect(JSON.parse(listed).connections).toHaveLength(1);
  expect((await post("/api/connections", { requestId: rid(), kind: "mcp_env", label: "MCP", projectScope: null })).status).toBe(200);
  expect((await post(`/api/connections/${id}/test`, { requestId: rid(), expectedRevision: 2, secret: "x" })).status).toBe(400);
});

test("releaseConnection refuses unknown purposes and records an audit row for every release", async () => {
  const f = await fixture();
  const id = create(f, [f.project.id]).connection.id, value = secretValue("release");
  rejects(() => f.store.transaction(tx => releaseConnection(tx, id, "effect:" + rid(), f.vault)), "connection_unavailable", 409);
  withSecret(f, "connection.set_secret", id, value, 1);
  for (const purpose of ["", "prompt", "effect:", "effect:not-a-card", "mcp:", "mcp:../x", "effect:" + rid() + "\n", "tool:" + rid(), "export"]) {
    rejects(() => f.store.transaction(tx => releaseConnection(tx, id, purpose, f.vault)), "connection_purpose_invalid", 400);
  }
  expect(audit(f, id).filter(row => row.action === "released")).toEqual([]);
  const card = rid();
  const released = f.store.transaction(tx => releaseConnection(tx, id, `effect:${card}`, f.vault, { projectId: f.project.id, now: epoch }));
  expect(released).toEqual({ connectionId: id, kind: "github_token", secret: value });
  f.store.transaction(tx => releaseConnection(tx, id, "mcp:github-server", f.vault));
  expect(audit(f, id).filter(row => row.action === "released")).toEqual([
    { action: "released", purpose: `effect:${card}`, channel: "internal" }, { action: "released", purpose: "mcp:github-server", channel: "internal" }]);
  // A release that rolls back leaves no audit row, and the audit never holds the value.
  try { f.store.transaction(tx => { releaseConnection(tx, id, `effect:${rid()}`, f.vault); throw new Error("rollback"); }); } catch { /* Rolled back. */ }
  expect(audit(f, id).filter(row => row.action === "released")).toHaveLength(2);
  expect(JSON.stringify(audit(f, id))).not.toContain(value);
  rejects(() => f.store.transaction(tx => releaseConnection(tx, id, `effect:${rid()}`, f.vault, { projectId: rid() })), "connection_out_of_scope", 403);
  plain(f, "connection.remove", id, 2);
  rejects(() => f.store.transaction(tx => releaseConnection(tx, id, `effect:${rid()}`, f.vault)), "connection_unavailable", 409);
});

test("file safety: wider modes, symlinks, foreign directories and colliding locations are refused", async () => {
  const f = await fixture();
  const id = create(f).connection.id, value = secretValue("mode");
  withSecret(f, "connection.set_secret", id, value, 1);
  const file = join(f.secrets, id);
  chmodSync(file, 0o644);
  expect(plain(f, "connection.test", id, 2).test).toEqual({ state: "unsafe" });
  rejects(() => f.store.transaction(tx => releaseConnection(tx, id, `effect:${rid()}`, f.vault)), "connection_vault_unsafe", 503);
  chmodSync(file, 0o600);
  // A symlink in place of the value file is never followed.
  const elsewhere = join(f.root, "elsewhere"); writeFileSync(elsewhere, "planted-value-from-elsewhere", { mode: 0o600 });
  rmSync(file); symlinkSync(elsewhere, file);
  expect(plain(f, "connection.test", id, 2).test).toEqual({ state: "unsafe" });
  rejects(() => f.store.transaction(tx => releaseConnection(tx, id, `effect:${rid()}`, f.vault)), "connection_vault_unsafe", 503);
  // Rotating replaces the link itself by rename and leaves its target untouched.
  withSecret(f, "connection.rotate", id, value, 2);
  expect(readFileSync(elsewhere, "utf8")).toBe("planted-value-from-elsewhere");
  expect(readFileSync(file, "utf8")).toBe(value);
  // The directory must stay 0700.
  chmodSync(f.secrets, 0o755);
  rejects(() => withSecret(f, "connection.rotate", id, secretValue("dir"), 3), "connection_vault_unsafe", 503);
  chmodSync(f.secrets, 0o700);
  // The vault refuses to live inside (or around) the state, backup or execution directories.
  for (const directory of [join(f.state, "secrets"), join(f.execution, "secrets"), join(f.backups, "s"), f.root]) {
    rejects(() => new ConnectionVault(directory, { forbidden: [f.state, f.backups, f.execution] }), "connection_vault_unsafe", 503);
  }
  rejects(() => new ConnectionVault("relative/secrets", { forbidden: [] }), "connection_vault_unsafe", 503);
  // A symlinked parent that aliases into the execution directory is refused by real location, and so is a vault
  // reached through any symlinked component.
  symlinkSync(f.execution, join(f.root, "alias"));
  rejects(() => new ConnectionVault(join(f.root, "alias", "keys"), { forbidden: [f.state, f.backups, f.execution] }), "connection_vault_unsafe", 503);
  const elsewhereDir = join(f.root, "real-keys"); mkdirSync(elsewhereDir, { mode: 0o700 });
  symlinkSync(elsewhereDir, join(f.root, "keys-link"));
  const linked = new ConnectionVault(join(f.root, "keys-link", "v"), { forbidden: [f.state, f.backups, f.execution] });
  rejects(() => linked.write(rid(), secretValue("linked")), "connection_vault_unsafe", 503);
  expect(readdirSync(elsewhereDir)).toEqual([]);
});

test("managed backup images and exports never contain a value", async () => {
  const f = await fixture();
  const id = create(f, [f.project.id]).connection.id, value = secretValue("backup");
  withSecret(f, "connection.set_secret", id, value, 1);
  const backup = await f.app.execute(f.auth.actor, { kind: "backup.create", requestId: rid(), projectId: null, expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { note: "connections" } });
  expect(readFileSync(backup.manifest.artifact.path).includes(Buffer.from(value))).toBe(false);
  const image = new Database(backup.manifest.artifact.path, { readonly: true });
  try { expect(image.query("SELECT id, secret_state AS secret FROM connections").all()).toEqual([{ id, secret: "set" }]); } finally { image.close(); }
  expect(filesContaining(f.backups, value)).toEqual([]);
  expect(JSON.stringify(backup)).not.toContain(value);
  const project = f.app.project(f.auth.actor, f.project.id);
  const exported = f.app.execute(f.auth.actor, { kind: "export.create", requestId: rid(), projectId: f.project.id, expectedRevision: project.revision, payload: { includeHistory: true, note: "connections" } });
  const body = new TextDecoder().decode(f.app.exportArtifact(f.auth.actor, f.project.id, exported.manifest.id).body);
  expect(body).not.toContain(value);
  // Only the secrets directory holds the value.
  expect(filesContaining(f.root, value)).toEqual([join(f.secrets, id)]);
  expect(backupImageTables.connections).toBe("include");
  expect(backupImageTables.connection_audit).toBe("include");
});

test("a value echoed in logs, deliveries, prompts and box output is redacted, and the guard covers stored values from boot", async () => {
  const f = await fixture();
  const id = create(f, [f.project.id]).connection.id, value = secretValue("echo");
  withSecret(f, "connection.set_secret", id, value, 1);
  expect(containsRegisteredSecret(`the token is ${value}.`)).toBe(true);
  expect(containsCredential(`x ${value} y`)).toBe(true);
  expect(redactCredentials(`a ${value} b ${value}`)).toBe("a [credential-redacted] b [credential-redacted]");
  // Logs.
  const lines: string[] = [], original = console.error;
  console.error = (line: string) => { lines.push(line); };
  try { logLine(`bridge failed with ${value} in its stderr`); } finally { console.error = original; }
  expect(lines).toEqual(["bridge failed with [credential-redacted] in its stderr"]);
  // Delivery: the outbox commits the redacted text instead of the value.
  const receipt = f.store.transaction(tx => commitDeliveryIntent(tx, { projectId: f.project.id, kind: "report", text: `ผลการ deploy: ${value}`, dedupeKey: `fixture-${rid()}`, maxBytes: 4096 }, epoch));
  expect(receipt.intent.payload.text).toBe("ผลการ deploy: [credential-redacted]");
  expect(f.store.read(tx => tx.all("SELECT record_json FROM delivery_intents")).some(row => JSON.stringify(row).includes(value))).toBe(false);
  expect(filesContaining(f.state, value)).toEqual([]);
  // Prompts: a source or purpose that echoes the value reaches the model redacted.
  const effective = describeEffectiveRun(runRequest(f, value));
  expect(JSON.stringify(effective)).not.toContain(value);
  expect(effective.sources[0]!.content).toBe("ผลลัพธ์ [credential-redacted]");
  // Tool results: box command output passes the guard.
  const runtime = new FakeBoxRuntime({ exec: async () => ({ exitCode: 0, stderr: new Uint8Array(),
    stdout: new TextEncoder().encode(JSON.stringify({ v: 1, ok: true, result: { stdout: Buffer.from(`echo ${value}\n`).toString("base64"), stderr: "", exitCode: 0, timedOut: false } })) }) });
  const backend = createBoxBackend(runtime, await runtime.ensure(f.project.id, "workspace"), { redact: redactRegisteredSecrets });
  expect((await backend.spawn({ command: "cat secret", cwd: "/workspace" })).stdout).toBe("echo [credential-redacted]\n");
  // One echoed line of a multi-line value is caught too.
  const key = Array.from({ length: 4 }, () => secretValue("line")).join("\n");
  const keyId = create(f).connection.id;
  withSecret(f, "connection.set_secret", keyId, key, 1);
  expect(redactRegisteredSecrets(`leak: ${key.split("\n")[2]}`)).toBe("leak: [credential-redacted]");
  // Boot: a value stored before this process started is fingerprinted when the application opens the vault.
  const stored = secretValue("boot"), bootId = create(f).connection.id;
  f.vault.write(bootId, stored);
  f.store.transaction(tx => tx.run("UPDATE connections SET secret_state = 'set', revision = 2 WHERE id = ?", bootId));
  expect(containsRegisteredSecret(stored)).toBe(false);
  new Application(f.store, f.config, { now: () => epoch, backupDir: f.backups, connections: f.vault });
  expect(containsRegisteredSecret(`x${stored}x`)).toBe(true);
});

function runRequest(f: Fixture, value: string): ApplicationRunRequest {
  return { runId: rid(), projectId: f.project.id, topicId: rid(), roleId: rid(), purpose: `ตรวจ ${value}`,
    route: { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" },
    configuration: { ownerRevision: 1, projectRevision: 1, roleRevision: 1 },
    context: { id: rid(), generation: 1 }, fence: { jobId: rid(), generation: 1, ownerGeneration: 1 },
    instructions: { operator: [`operator ${value}`], responsibility: "วิเคราะห์" },
    manifest: { sources: [{ projectId: f.project.id, reference: { sourceId: rid(), revision: 1, generation: 1 }, text: `ผลลัพธ์ ${value}` }], claims: [] },
    tools: [], policy: { genericExecution: false, arbitraryFetch: false, hostedLookup: false, repositoryDiscovery: false },
    limits: structuredClone(f.config.jobs.maximum) };
}

test("without a vault every command is connection_vault_not_configured", async () => {
  const f = await fixture();
  const bare = new Application(f.store, f.config, { now: () => epoch, backupDir: f.backups });
  const actor = bare.authenticate(await bare.login(password)).actor;
  rejects(() => bare.execute(actor, { kind: "connection.create", requestId: rid(), projectId: null, expectedRevision: 0, payload: { kind: "deploy_secret", label: "deploy", projectScope: null } }),
    "connection_vault_not_configured", 503);
});

test("schema 32 installations migrate to the connection tables, and reopen", () => {
  const root = mkdtempSync(join(tmpdir(), "jit-exe08-migrate-")); roots.push(root);
  const path = join(root, "state.sqlite"), old = new Database(path);
  old.exec(readFileSync(new URL("./fixtures/foundation-v32.sql", import.meta.url), "utf8"));
  old.close();
  const migrated = new TransactionStore(path); stores.push(migrated);
  expect(schemaVersion).toBe(34);
  expect(migrated.read(tx => tx.get("PRAGMA user_version"))).toEqual({ user_version: 34 });
  expect(migrated.read(tx => tx.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN ('connections', 'connection_audit') ORDER BY name")).map(row => row.name))
    .toEqual(["connection_audit", "connections"]);
  expect(() => migrated.transaction(tx => tx.run("INSERT INTO connections VALUES (?, 'payment', 'x', NULL, 1, 'empty', 0, NULL, NULL)", rid()))).toThrow();
  const columns = migrated.read(tx => tx.all<{ name: string }>("PRAGMA table_info(connections)")).map(row => row.name);
  expect(columns.some(name => /secret_value|token|value/.test(name))).toBe(false);
  migrated.close(); stores.splice(stores.indexOf(migrated), 1);
  const reopened = new TransactionStore(path); stores.push(reopened);
  expect(reopened.read(tx => tx.get("PRAGMA user_version"))).toEqual({ user_version: 34 });
});

test("every owner-visible connection string exists in Thai and English", () => {
  const keys = Object.keys(dictionaries.th).filter(key => /^error\.(connection_|invalid_connection_)/.test(key));
  expect(keys.sort()).toEqual(["error.connection_not_found", "error.connection_out_of_scope", "error.connection_purpose_invalid", "error.connection_removed",
    "error.connection_requires_web", "error.connection_secret_exists", "error.connection_secret_missing", "error.connection_unavailable",
    "error.connection_vault_not_configured", "error.connection_vault_unsafe", "error.invalid_connection_command", "error.invalid_connection_secret"]);
  for (const key of keys) expect(dictionaries.en[key as keyof typeof dictionaries.en]).toBeTruthy();
});
