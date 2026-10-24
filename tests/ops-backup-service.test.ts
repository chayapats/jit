import { afterEach, expect, test } from "bun:test";
import { fixtureLedgerGate } from "./fixtures/ledger-gate";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "schway/host";
import { readConfig } from "../src/config";
import { startFullApp, stopDrain } from "../src/ops/lifecycle";
import { schwayBackupEngine } from "../src/ops/schway-backup";
import { SchwayRunPort } from "../src/team/schway-port";
import type { ApplicationRunRequest } from "../src/team/types";
import type { ServiceConfig } from "../ops/package/service-config";

/**
 * OPS01 production wiring: both boot paths (`startFullApp` and `main.ts
 * serve`) select the concrete native port only under JIT_RUN_PORT=schway,
 * write managed backups into the trusted backup destination, and fail closed
 * when the pinned bridge gate does not hold. Scripted model transport only.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const rid = () => crypto.randomUUID();
const password = "service-backup-owner-pw";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function setup(runPort: "schway" | "scripted") {
  const root = mkdtempSync(join(tmpdir(), "jit-ops-backup-service-")); roots.push(root);
  const release = join(root, "release"), work = join(root, "work"), state = join(root, "state"), backup = join(root, "configured-backup");
  for (const dir of [release, work, state, backup]) mkdirSync(dir, { mode: 0o700 });
  const ledger = join(state, "ledger.json");
  writeFileSync(ledger, JSON.stringify({ ledger: "jit.deletion.ledger/v1", revision: 1 }) + "\n", { mode: 0o600 });
  const credential = join(root, "bot.token");
  writeFileSync(credential, "fixture-credential-value", { mode: 0o600 });
  const service: ServiceConfig = { serviceUser: "jit-service", executablePath: release, workingDirectory: work, stateDirectory: state,
    ledgerPath: ledger, backupDirectory: backup, routes: [],
    secretRefs: [{ name: "bot-token", store: "credential-file", key: credential }],
    network: { bindHost: "127.0.0.1", port: 3443, vpnInterface: null },
    resources: { memoryMaxBytes: 536870912, maxRestarts: 3, restartWindowSeconds: 300, logBytes: 1048576, retentionDays: 30 } };
  const config = readConfig({ JIT_DATABASE: join(state, "app.sqlite"), JIT_RUN_PORT: runPort });
  return { root, state, backup, service, config };
}

const scriptedModel: Model = {
  provider: "scripted", id: "service-backup-fixture",
  async *stream() { yield { type: "message_complete", message: { type: "assistant", id: rid(), content: [{ type: "text", text: "หลักฐาน" }] } }; },
};

function runRequest(config: ReturnType<typeof readConfig>): ApplicationRunRequest {
  const projectId = rid();
  return { runId: rid(), projectId, topicId: rid(), roleId: rid(), purpose: "service backup run",
    route: { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" },
    configuration: { ownerRevision: 1, projectRevision: 1, roleRevision: 1 },
    context: { id: rid(), generation: 1 }, fence: { jobId: rid(), generation: 1, ownerGeneration: 1 },
    instructions: { operator: ["fixture"], responsibility: "ทดสอบ" },
    manifest: { sources: [{ projectId, reference: { sourceId: rid(), revision: 1, generation: 1 }, text: "ต้นทาง" }], claims: [] },
    tools: [], policy: { genericExecution: false, arbitraryFetch: false, hostedLookup: false, repositoryDiscovery: false },
    limits: structuredClone(config.jobs.maximum) };
}

test("startFullApp in schway mode backs up real native sessions into the configured backup directory", async () => {
  const { service, config, backup, state } = setup("schway");
  const started = await startFullApp({ config, service, ledgerGate: fixtureLedgerGate });
  if (!started.ok) throw new Error(JSON.stringify(started.gates));
  const { app, store } = started.handle;
  try {
    await app.setupOwner(password);
    const actor = app.authenticate(await app.login(password)).actor;
    app.execute(actor, { kind: "project.create", requestId: rid(), projectId: null, expectedRevision: app.workspace(actor).revision, payload: { name: "service" } });
    const run = runRequest(config);
    store.transaction(tx => { tx.run("INSERT INTO team_contexts VALUES (?, 1, 'active')", run.context.id); });
    const port = new SchwayRunPort(store, config.team, config.jobs.outputBytes, { model: scriptedModel });
    expect(await port.invoke(run, new AbortController().signal, () => {})).toMatchObject({ state: "complete" });
    const receipt = await app.execute(actor, { kind: "backup.create", requestId: rid(), projectId: null,
      expectedRevision: app.workspace(actor).revision, payload: { note: "service backup" } });
    expect(receipt.manifest.native).toMatchObject({ state: "valid", engine: schwayBackupEngine, refs: [{ id: run.runId, generation: 1 }] });
    // Every managed artifact stays under the validated service destination.
    expect(receipt.manifest.artifact.path.startsWith(backup + "/")).toBe(true);
    for (const artifact of receipt.manifest.native.artifacts) {
      expect(artifact.path.startsWith(backup + "/")).toBe(true);
      expect(sha(readFileSync(artifact.path))).toBe(artifact.hash);
    }
    expect(readdirSync(backup)).toHaveLength(2);
    expect(readdirSync(state).some(name => name.endsWith(".backups"))).toBe(false);
  } finally {
    await stopDrain(started.handle, { timeoutMs: 5000 });
    store.close();
  }
});

test("startFullApp in scripted mode has no native port and stays explicitly incomplete", async () => {
  const { service, config, backup } = setup("scripted");
  const started = await startFullApp({ config, service, ledgerGate: fixtureLedgerGate });
  if (!started.ok) throw new Error(JSON.stringify(started.gates));
  const { app, store } = started.handle;
  try {
    await app.setupOwner(password);
    const actor = app.authenticate(await app.login(password)).actor;
    const receipt = await app.execute(actor, { kind: "backup.create", requestId: rid(), projectId: null,
      expectedRevision: app.workspace(actor).revision, payload: { note: "scripted" } });
    expect(receipt.manifest.native).toMatchObject({ state: "unavailable", reason: "native_snapshot_unavailable" });
    expect(receipt.manifest.state).toBe("incomplete");
    expect(receipt.manifest.artifact.path.startsWith(backup + "/")).toBe(true);
  } finally {
    await stopDrain(started.handle, { timeoutMs: 5000 });
    store.close();
  }
});

test("startFullApp in schway mode fails closed when the bridge gate does not hold", async () => {
  const { service, config, state } = setup("schway");
  writeFileSync(join(state, ".jit-host"), "blocker");
  // The shared start path verifies the pinned bridge before composing anything and reports the blocked engine gate.
  const refused = await startFullApp({ config, service, ledgerGate: fixtureLedgerGate });
  expect(refused.ok).toBe(false);
  if (refused.ok) throw new Error("unreachable");
  expect(refused.gates).toMatchObject([{ gate: "engine", state: "blocked" }]);
  expect(refused.gates[0]!.detail).toContain("unsafe_host_directory");
});

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

test("serve selects the concrete native port in schway mode and refuses to start when the gate fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-ops-backup-serve-")); roots.push(root);
  const main = join(import.meta.dir, "../src/main.ts");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = { JIT_DATABASE: join(root, "app.sqlite"), JIT_RUN_PORT: "schway", JIT_PORT: String(port), JIT_HOST: "127.0.0.1", JIT_ORIGIN: origin, PATH: process.env.PATH ?? "" };
  const setupChild = Bun.spawn([process.execPath, main, "setup", "--password-stdin"], { cwd: root, env, stdin: new TextEncoder().encode(password + "\n"), stdout: "pipe", stderr: "pipe" });
  expect(await setupChild.exited).toBe(0);
  const server = Bun.spawn([process.execPath, main, "serve"], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  try {
    const reader = server.stdout.getReader();
    let out = "";
    while (!out.includes("Jit workspace started")) {
      const { done, value } = await reader.read();
      if (done) throw new Error(`serve exited early: ${out}`);
      out += new TextDecoder().decode(value);
    }
    reader.releaseLock();
    expect(out).toContain("Schway bridge ready");
    const login = await fetch(`${origin}/login`, { method: "POST", redirect: "manual",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ password }) });
    const token = /jit_session=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
    expect(token).toBeString();
    const cookie = `jit_session=${token}`;
    const csrf = createHash("sha256").update(`jit.csrf.v1:${token}`).digest("hex");
    const workspace = await (await fetch(`${origin}/api/projects`, { headers: { cookie } })).json() as { revision: number };
    const created = await fetch(`${origin}/api/backups`, { method: "POST",
      headers: { cookie, origin, "content-type": "application/json", "x-csrf-token": csrf },
      body: JSON.stringify({ requestId: rid(), expectedRevision: workspace.revision, note: "serve backup" }) });
    expect(created.status).toBe(200);
    const receipt = await created.json() as { manifest: { native: { state: string; engine: string }; artifact: { path: string } } };
    expect(receipt.manifest.native).toMatchObject({ state: "valid", engine: schwayBackupEngine });
    expect(receipt.manifest.artifact.path.startsWith(join(root, "app.sqlite.backups") + "/")).toBe(true);
  } finally {
    server.kill("SIGTERM");
    await server.exited;
  }
  // Fail-closed startup: a blocked service directory stops serve before any listener exists.
  const blocked = mkdtempSync(join(tmpdir(), "jit-ops-backup-serve-blocked-")); roots.push(blocked);
  writeFileSync(join(blocked, ".jit-host"), "blocker");
  const refused = Bun.spawn([process.execPath, main, "serve"], { cwd: blocked,
    env: { ...env, JIT_DATABASE: join(blocked, "app.sqlite") }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(refused.stdout).text(), new Response(refused.stderr).text(), refused.exited]);
  expect(exit).toBe(1);
  expect(stderr).toContain("Schway bridge unavailable");
  expect(stdout).not.toContain("Jit workspace started");
});
