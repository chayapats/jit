import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { JobQueue } from "../src/jobs/queue";
import { TransactionStore, schemaVersion } from "../src/store";
import { artifactPiStatus, buildPackage, readManifest, validateArtifact } from "../ops/package/bun-build";
import { assertNoSecretValues, parseServiceConfig, planServiceConfig, renderServiceUnit } from "../ops/package/service-config";
import type { ServiceConfig } from "../ops/package/service-config";
import { preflightService, readQuarantine, startFullApp, stopDrain } from "../src/ops/lifecycle";
import { backupDirectoryProblem } from "../src/ops/backup";
import { gatherServiceStatus, serviceStatus } from "../src/ops/status";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const repoRoot = join(import.meta.dir, "..");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "jit-ops-service-fixture-"));
  roots.push(root);
  const release = join(root, "release"), work = join(root, "work"), state = join(root, "state"), backup = join(root, "backup");
  for (const dir of [release, work, state, backup]) mkdirSync(dir, { mode: 0o700 });
  const ledger = join(state, "ledger.json");
  writeFileSync(ledger, JSON.stringify({ ledger: "jit.deletion.ledger/v1", revision: 1 }) + "\n", { mode: 0o600 });
  const credential = join(root, "bot.token");
  writeFileSync(credential, "fixture-credential-value", { mode: 0o600 });
  const service: ServiceConfig = { serviceUser: "jit-service", executablePath: release, workingDirectory: work, stateDirectory: state,
    ledgerPath: ledger, backupDirectory: backup,
    routes: [{ route: "codex-subscription", model: null, configured: false }],
    secretRefs: [{ name: "bot-token", store: "credential-file", key: credential }],
    network: { bindHost: "127.0.0.1", port: 3443, vpnInterface: null },
    resources: { memoryMaxBytes: 536870912, maxRestarts: 3, restartWindowSeconds: 300, logBytes: 1048576, retentionDays: 30 } };
  const config = readConfig({ JIT_DATABASE: join(state, "app.sqlite") });
  return { root, release, work, state, backup, ledger, credential, service, config };
}

test("versioned artifact pins runtime, lock, schema and engine without dev-cwd dependence", () => {
  const { root, config } = setup();
  void config;
  const first = join(root, "artifact-a"), second = join(root, "artifact-b");
  const built = buildPackage({ srcDir: repoRoot, outDir: first, engineContract: "jit.schway.bridge/v1", engineRevision: null });
  expect(built.appVersion).toBe(JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version);
  expect(built.bunVersion).toBe(Bun.version);
  expect(built.schemaVersion).toBe(schemaVersion);
  expect(built.engineContract).toBe("jit.schway.bridge/v1");
  expect(built.engineRevision).toBe("unverified");
  expect(built.arch).toBe(process.arch);
  expect(built.piValidation.status).toBe("pending");
  expect(validateArtifact(first).ok).toBe(true);
  expect(readManifest(first)).toEqual(built);
  const cwd = process.cwd();
  process.chdir(tmpdir());
  try { buildPackage({ srcDir: repoRoot, outDir: second, engineContract: "jit.schway.bridge/v1", engineRevision: null }); }
  finally { process.chdir(cwd); }
  const again = readManifest(second);
  // Identity and build time differ per build, and the content pin binds them, so it differs too.
  expect({ ...again, artifactId: "", builtAt: "", contentHash: "" }).toEqual({ ...built, artifactId: "", builtAt: "", contentHash: "" });
  expect(again.contentHash).not.toBe(built.contentHash);
  expect(artifactPiStatus({ arch: "x64", piValidation: { status: "pending", detail: "x" } })).toBe("not-run");
  expect(artifactPiStatus({ arch: "arm64", piValidation: { status: "pending", detail: "x" } })).toBe("pending");
  expect(artifactPiStatus(built)).toBe(process.arch === "arm64" ? "pending" : "not-run");
});

test("artifact negatives reject missing pins, occupied output and unapproved engine claims", () => {
  const { root } = setup();
  expect(() => buildPackage({ srcDir: root, outDir: join(root, "out"), engineContract: "jit.schway.bridge/v1", engineRevision: null })).toThrow();
  mkdirSync(join(root, "out"));
  expect(() => buildPackage({ srcDir: repoRoot, outDir: join(root, "out"), engineContract: "jit.schway.bridge/v1", engineRevision: null })).toThrow();
  expect(() => buildPackage({ srcDir: repoRoot, outDir: join(root, "fresh"), engineContract: "evil route!", engineRevision: null })).toThrow();
  expect(() => buildPackage({ srcDir: repoRoot, outDir: join(root, "fresh"), engineContract: "jit.schway.bridge/v1", engineRevision: "not-a-version!!" })).toThrow();
  const built = buildPackage({ srcDir: repoRoot, outDir: join(root, "good"), engineContract: "jit.schway.bridge/v1", engineRevision: null });
  writeFileSync(join(root, "good/manifest.json"), JSON.stringify({ ...built, schemaVersion: 999 }));
  // A manifest from another build reads, but the executing build refuses its schema pin.
  expect(validateArtifact(join(root, "good")).checks).toContainEqual({ check: "schema-pin", ok: false });
  writeFileSync(join(root, "good/manifest.json"), JSON.stringify({ ...built, schemaVersion: "22" }));
  expect(() => readManifest(join(root, "good"))).toThrow();
});

test("service configuration validates the trusted shape and rejects wildcards, root and secret values", () => {
  const { service } = setup();
  expect(parseServiceConfig(service)).toEqual(service);
  const bad = [
    { ...service, serviceUser: "root" }, { ...service, serviceUser: "JIT Service" },
    { ...service, network: { ...service.network, bindHost: "0.0.0.0" } },
    { ...service, network: { ...service.network, bindHost: "::" } },
    { ...service, network: { ...service.network, bindHost: "vpn.example.test" } },
    { ...service, stateDirectory: "relative/path" },
    { ...service, stateDirectory: service.executablePath },
    { ...service, stateDirectory: `${service.executablePath}/state` },
    { ...service, routes: [...service.routes, ...service.routes] },
    { ...service, secretRefs: [{ name: "bot-token", store: "credential-file", key: "k", value: "TOKEN_SENTINEL" }] },
    { ...service, secretRefs: [{ name: "bot-token!", store: "credential-file", key: "k" }] },
    { ...service, extra: 1 },
    { ...service, resources: { ...service.resources, maxRestarts: 21 } },
  ];
  for (const raw of bad) expect(() => parseServiceConfig(raw)).toThrow("invalid_service_config");
  expect(() => parseServiceConfig({ ...service, resources: { ...service.resources, maxRestarts: Infinity } })).toThrow();
});

test("plan mode diffs only allowlisted non-secret fields with opaque secret references", () => {
  const { service } = setup();
  const next = { ...service, network: { ...service.network, port: 3444 },
    secretRefs: [...service.secretRefs, { name: "second-token", store: "service-keyring" as const, key: "jit/secondary" }] };
  const changes = planServiceConfig(service, next);
  expect(changes.map(c => c.field).sort()).toEqual(["network", "secretRefs"]);
  const secrets = changes.find(c => c.field === "secretRefs");
  expect(secrets?.after).toEqual({ count: 2, names: ["bot-token", "second-token"] });
  expect(JSON.stringify(changes)).not.toMatch(/TOKEN_SENTINEL|fixture-credential-value|Authorization/);
  expect(planServiceConfig(service, service)).toEqual([]);
  expect(() => planServiceConfig(service, { ...next, network: { ...next.network, bindHost: "0.0.0.0" } })).toThrow();
});

test("rendered unit pins the service identity with bounded restart, memory cap and no secrets", async () => {
  const { service } = setup();
  const unit = await renderServiceUnit(parseServiceConfig(service), { bunPath: process.execPath, appDir: "/opt/jit/release" });
  expect(unit).toMatch(/User=jit-service/);
  expect(unit).toMatch(/NoNewPrivileges=true/);
  expect(unit).toMatch(/MemoryMax=512M/);
  expect(unit).toMatch(/Restart=on-failure/);
  expect(unit).toMatch(/StartLimitBurst=3/);
  expect(unit).toMatch(/Environment=JIT_HOST=127\.0\.0\.1/);
  expect(unit).not.toMatch(/0\.0\.0\.0|TOKEN_SENTINEL|fixture-credential-value/);
  assertNoSecretValues(unit);
  assertNoSecretValues(JSON.stringify(parseServiceConfig(service)));
  expect(() => assertNoSecretValues("bot_token = 123456:ABCDEF-sentinel-value")).toThrow("invalid_service_rendering");
  expect(() => assertNoSecretValues("Authorization: Bearer TOKEN_SENTINEL")).toThrow("invalid_service_rendering");
  await expect(renderServiceUnit({ ...parseServiceConfig(service), network: { bindHost: "0.0.0.0", port: 3443, vpnInterface: null } } as never,
    { bunPath: process.execPath, appDir: "/opt/jit/release" })).rejects.toThrow();
});

test("full app boots with the composed workers, persists owner state and restarts with one scheduler", async () => {
  const { service, config } = setup();
  const first = await startFullApp({ config, service });
  expect(first.ok).toBe(true);
  if (!first.ok) throw new Error("unreachable");
  const ids = first.handle.queue.choices().map(c => c.id).sort();
  expect(ids).toEqual(["project.status", "role.scripted-preview", "schedule.reminder", "schedule.summary",
    "team.discussion", "team.specialist-analysis", "team.coordinator-synthesis", "team.jit-reply", "setup.route-check", "memory.extract", "pr.snapshot", "pr.review"].sort());
  expect(ids.some(id => id.includes("probe"))).toBe(false);
  const app = first.handle.app;
  await app.setupOwner("service-owner-password");
  const actor = app.authenticate(await app.login("service-owner-password")).actor;
  const project = app.execute(actor, { kind: "project.create", requestId: "service-boot-01", projectId: null,
    expectedRevision: 0, payload: { name: "Service project" } }).project;
  const second = await startFullApp({ config, service });
  expect(second.ok).toBe(false);
  if (second.ok) throw new Error("unreachable");
  expect(second.gates.find(g => g.gate === "scheduler")?.state).toBe("blocked");
  const drained = await stopDrain(first.handle, { timeoutMs: 5000 });
  expect(drained.outcome).toBe("stopped");
  first.handle.store.close();
  const third = await startFullApp({ config, service });
  expect(third.ok).toBe(true);
  if (!third.ok) throw new Error("unreachable");
  const thirdActor = third.handle.app.authenticate(await third.handle.app.login("service-owner-password")).actor;
  expect(third.handle.app.project(thirdActor, project.id).id).toBe(project.id);
  const done = await stopDrain(third.handle, { timeoutMs: 5000 });
  expect(done.outcome).toBe("stopped");
  third.handle.store.close();
});

test("full app startup reconciles pending native deletions before returning an active handle", async () => {
  const { service, config } = setup();
  const first = await startFullApp({ config, service });
  if (!first.ok) throw new Error("unreachable");
  const app = first.handle.app;
  await app.setupOwner("service-owner-password");
  const actor = app.authenticate(await app.login("service-owner-password")).actor;
  const project = app.execute(actor, { kind: "project.create", requestId: "service-del-01", projectId: null, expectedRevision: 0, payload: { name: "Delete on boot" } }).project;
  const topic = app.execute(actor, { kind: "topic.create", requestId: "service-del-02", projectId: project.id, expectedRevision: project.revision, payload: { title: "Boot topic" } }).topic;
  const message = app.execute(actor, { kind: "message.send", requestId: "service-del-03", projectId: project.id, expectedRevision: topic.revision,
    payload: { topicId: topic.id, text: "boot-delete-canary-313 must go" } }).message.source;
  const role = app.execute(actor, { kind: "role.save", projectId: null, requestId: "service-del-04", expectedRevision: app.team(actor).ownerRevision,
    payload: { roleId: null, name: "Tech", kind: "specialist", responsibility: "Analyze software structure", enabled: true,
      route: { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" } } }).role!;
  const revision = () => app.project(actor, project.id).revision;
  app.execute(actor, { kind: "team.dispatch", requestId: "service-del-05", projectId: project.id, expectedRevision: revision(),
    payload: { topicId: topic.id, purpose: "Read the message", sources: [message], include: [role.id], exclude: [], limits: { ...config.jobs.maximum } } });
  // Stop first so the post-confirm pass cannot run: the operation stays pending across the restart.
  await stopDrain(first.handle, { timeoutMs: 5000 });
  const preview = app.execute(actor, { kind: "memory.delete.preview", requestId: "service-del-06", projectId: project.id, expectedRevision: revision(),
    payload: { scope: { kind: "source", projectId: project.id, source: { ...message } } } }) as import("../src/memory/delete").DeletionReceipt;
  const confirmed = app.execute(actor, { kind: "memory.delete.confirm", requestId: "service-del-07", projectId: project.id, expectedRevision: revision(),
    payload: { previewId: preview.preview.id, acknowledged: true, acknowledgedWholeSession: preview.preview.wholeSession.required } }) as import("../src/memory/delete").DeletionConfirmReceipt;
  expect(confirmed.operation.state).toBe("pending");
  expect(confirmed.operation.contexts.length).toBeGreaterThan(0);
  first.handle.store.close();
  const second = await startFullApp({ config, service });
  if (!second.ok) throw new Error("unreachable");
  // No explicit reconcile call: startup itself drove the managed delete before exposing the app.
  const secondActor = second.handle.app.authenticate(await second.handle.app.login("service-owner-password")).actor;
  const operation = second.handle.app.deletionOperation(secondActor, project.id, confirmed.operation.id).operation!;
  expect(operation.state).toBe("complete");
  expect(operation.attempts).toBe(1);
  for (const context of operation.contexts) {
    expect(second.handle.store.read(tx => tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", context.id, context.generation)?.state)).toBe("deleted");
  }
  await stopDrain(second.handle, { timeoutMs: 5000 });
  second.handle.store.close();
});

test("crash and stop-timeout fence unsettled work without claiming success", async () => {
  const { service, config } = setup();
  const store = new TransactionStore(config.databasePath);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = false;
  const queue = new JobQueue(store, config.jobs, [{
    id: "test.hang", title: "Hanging fixture", revision: 1, replay: "read",
    route: { provider: "fixture", model: "scripted", authRoute: "internal" },
    cost: { roles: 1, calls: 1, rounds: 1, hops: 1 },
    validate: () => true,
    run: async () => { entered = true; await gate; return { state: "succeeded", evidence: "must not publish" }; },
  }]);
  const app = new Application(store, config, { jobs: queue });
  await app.setupOwner("hang-owner-password");
  const actor = app.authenticate(await app.login("hang-owner-password")).actor;
  const project = app.execute(actor, { kind: "project.create", requestId: "hang-project-01", projectId: null,
    expectedRevision: 0, payload: { name: "Hang project" } }).project;
  const receipt = app.execute(actor, { kind: "job.enqueue", requestId: "hang-job-00000001", projectId: project.id,
    expectedRevision: project.revision, payload: { type: "test.hang", configurationRevision: 1, policyRevision: config.jobs.revision,
      purpose: "Hanging fixture", inputRevision: project.revision, input: {}, priority: "background",
      limits: { roles: 4, calls: 4, rounds: 4, hops: 4, contextTokens: 100, outputTokens: 100, retries: 2, wallMs: 60000 } } });
  queue.pump();
  for (let n = 0; n < 200 && !entered; n++) await Bun.sleep(1);
  expect(entered).toBe(true);
  const drained = await stopDrain({ queue, store }, { timeoutMs: 50 });
  expect(drained.outcome).toBe("unknown");
  expect(drained.nextAction).toBe("terminate-supervised-process-and-reconcile");
  release();
  await queue.idle();
  queue.close();
  store.close();
  const reopened = new TransactionStore(config.databasePath);
  const next = new JobQueue(reopened, config.jobs, []);
  const reopenedApp = new Application(reopened, config, { jobs: next });
  const actor2 = reopenedApp.authenticate(await reopenedApp.login("hang-owner-password")).actor;
  const current = reopenedApp.job(actor2, project.id, receipt.job.id);
  expect(current.evidence).toBeNull();
  expect(["waiting", "blocked"]).toContain(current.state);
  expect(JSON.stringify(current)).not.toContain("must not publish");
  next.close();
  reopened.close();
});

test("preflight rejects a permissive, symlinked or foreign-owned backup destination instead of trusting existence", async () => {
  const { root, service, config, backup } = setup();
  const store = new TransactionStore(config.databasePath);
  const configGate = (candidate: ServiceConfig) => preflightService({ store, config, service: candidate, requiredEngine: "jit.schway.bridge/v1" })
    .gates.find(g => g.gate === "config")!;
  try {
    expect(configGate(service)).toMatchObject({ state: "ready" });
    chmodSync(backup, 0o777);
    expect(configGate(service)).toMatchObject({ state: "blocked", nextAction: "restrict-backup-directory", detail: "backup directory untrusted: backup_directory_permissive" });
    chmodSync(backup, 0o750);
    expect(configGate(service).state).toBe("blocked");
    chmodSync(backup, 0o700);
    const linked = join(root, "backup-link");
    symlinkSync(backup, linked);
    expect(configGate({ ...service, backupDirectory: linked })).toMatchObject({ state: "blocked", detail: "backup directory untrusted: backup_directory_symlink" });
    expect(configGate({ ...service, backupDirectory: join(root, "absent") })).toMatchObject({ state: "blocked", nextAction: "prepare-service-directories" });
    // A different owner cannot be created without root; the check compares against the service uid.
    expect(backupDirectoryProblem(backup)).toBeNull();
    expect(backupDirectoryProblem(backup, (process.getuid?.() ?? 0) + 1)).toBe("backup_directory_foreign_owner");
  } finally { store.close(); }
  const refused = await startFullApp({ config, service: { ...service, backupDirectory: join(root, "backup-link") } });
  expect(refused.ok).toBe(false);
});

test("quarantine boot refuses activation while read-only status stays available", async () => {
  const { service, config } = setup();
  // First installed boot accepts the install seed once and establishes the real OPS02 checkpoint at ledgerPath.
  const first = await startFullApp({ config, service });
  if (!first.ok) throw new Error(JSON.stringify(first.gates));
  await stopDrain(first.handle, { timeoutMs: 5000 });
  first.handle.service.close();
  first.handle.store.close();
  const established = readFileSync(service.ledgerPath);
  expect(JSON.parse(established.toString())).toMatchObject({ ledger: "jit.deletion.ledger/v1", contract: "app.deletion_ledger/v1" });
  const blockedAt = async (candidate: ServiceConfig) => {
    const refused = await startFullApp({ config, service: candidate });
    expect(refused.ok).toBe(false);
    if (refused.ok) throw new Error("unreachable");
    return refused.gates.filter(g => g.state === "blocked").map(g => [g.gate, g.detail]);
  };
  // Missing after establishment.
  rmSync(service.ledgerPath);
  expect(readQuarantine(service).quarantined).toBe(true);
  expect(await blockedAt(service)).toEqual([["quarantine", "lifecycle ledger ledger_checkpoint_missing"]]);
  // A seed is accepted only once: it cannot re-establish authority.
  writeFileSync(service.ledgerPath, JSON.stringify({ ledger: "jit.deletion.ledger/v1", revision: 1 }), { mode: 0o600 });
  expect(await blockedAt(service)).toEqual([["quarantine", "lifecycle ledger ledger_checkpoint_unverifiable"]]);
  // Diverged / tampered checkpoint.
  writeFileSync(service.ledgerPath, JSON.stringify({ ...JSON.parse(established.toString()), digest: "0".repeat(64) }), { mode: 0o600 });
  expect(await blockedAt(service)).toEqual([["quarantine", "lifecycle ledger ledger_checkpoint_unverifiable"]]);
  // Relocated without a verified copy of the established checkpoint.
  writeFileSync(service.ledgerPath, established, { mode: 0o600 });
  const relocated = { ...service, ledgerPath: join(service.stateDirectory, "moved-ledger.json") };
  expect(await blockedAt(relocated)).toEqual([["quarantine", "lifecycle ledger ledger_checkpoint_relocation_unverified"]]);
  const store = new TransactionStore(config.databasePath);
  try {
    const preflight = preflightService({ store, config, service: relocated, requiredEngine: "jit.schway.bridge/v1" });
    expect(preflight.gates.find(g => g.gate === "quarantine")).toMatchObject({ state: "blocked",
      nextAction: "copy_the_verified_checkpoint_from_the_previous_ledger_location_then_retry" });
    expect(gatherServiceStatus(config, relocated)).toMatchObject({ service: "blocked", quarantined: true });
    // Restart keeps one ledger location: the established path is still the marker.
    expect(store.read(tx => tx.get<{ path: string }>("SELECT path FROM lifecycle_checkpoint WHERE id = 1"))?.path).toBe(service.ledgerPath);
  } finally { store.close(); }
  expect(existsSync(relocated.ledgerPath)).toBe(false);
  const restarted = await startFullApp({ config, service });
  if (!restarted.ok) throw new Error(JSON.stringify(restarted.gates));
  await stopDrain(restarted.handle, { timeoutMs: 5000 });
  restarted.handle.service.close();
  restarted.handle.store.close();
  expect(serviceStatus({ now: 1800000000000, scheduler: "owned", worker: "free", quarantined: false,
    evidenceReady: false, blockedGates: [] })).toMatchObject({ service: "running", nextAction: "none" });
  expect(serviceStatus({ now: 1800000000000, scheduler: "owned", worker: "free", quarantined: false,
    evidenceReady: true, blockedGates: [] }).service).toBe("observed-ready");
  expect(serviceStatus({ now: 1800000000000, scheduler: "owned", worker: "owned", quarantined: false,
    evidenceReady: true, blockedGates: [] })).toMatchObject({ service: "blocked" });
  expect(() => serviceStatus({ now: 1800000000000, scheduler: "owned", worker: "free", quarantined: false,
    evidenceReady: false, blockedGates: ["Authorization: Bearer x"] })).toThrow();
});

test("main preflight and status stay read-only without claiming the scheduler", async () => {
  const { root, config, service } = setup();
  void config;
  mkdirSync(join(root, ".local"), { mode: 0o700 });
  writeFileSync(join(root, ".local/service-config.json"), JSON.stringify(service));
  const main = join(import.meta.dir, "../src/main.ts");
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, main, ...args],
      { cwd: root, env: { JIT_DATABASE: join(root, "state/app.sqlite") }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exit };
  };
  const preflight = await run(["preflight"]);
  expect(preflight.exit).toBe(0);
  expect(preflight.stderr).toBe("");
  const gates = JSON.parse(preflight.stdout).gates as Array<{ gate: string; state: string; nextAction: string }>;
  expect(gates.find(g => g.gate === "scheduler")?.state).toBe("ready");
  // Read-only: a missing installation database is reported, never created.
  expect(gates.find(g => g.gate === "schema")).toMatchObject({ state: "blocked", nextAction: "start-service-to-initialize-installation" });
  // Without an installation database the OPS02 ledger cannot be read, so the installation stays quarantined.
  expect(gates.find(g => g.gate === "quarantine")).toMatchObject({ state: "blocked", nextAction: "inspect_installation_lifecycle_ledger" });
  const status = await run(["status"]);
  expect(status.exit).toBe(0);
  expect(JSON.parse(status.stdout)).toMatchObject({ schema: "jit.ops.status/v1", service: "blocked", scheduler: "free", quarantined: true });
  expect((await run(["preflight", "--bogus"])).exit).toBe(1);
  expect(existsSync(join(root, "state/app.sqlite"))).toBe(false);
  const store = new TransactionStore(join(root, "state/app.sqlite"));
  try { expect(store.read(tx => tx.get("SELECT * FROM job_scheduler"))).toBeNull(); }
  finally { store.close(); }
  const existing = await run(["preflight"]);
  const existingGates = JSON.parse(existing.stdout).gates as Array<{ gate: string; state: string }>;
  expect(existingGates.find(g => g.gate === "schema")?.state).toBe("ready");
  // The install seed is acceptable (once) to the read-only inspection; nothing is written by preflight.
  expect(existingGates.find(g => g.gate === "quarantine")?.state).toBe("ready");
  expect(JSON.parse(readFileSync(service.ledgerPath, "utf8"))).toEqual({ ledger: "jit.deletion.ledger/v1", revision: 1 });
});

test("operator config rejects wildcard binds by default", () => {
  expect(() => readConfig({ JIT_HOST: "0.0.0.0" })).toThrow("Invalid JIT_HOST");
  expect(() => readConfig({ JIT_HOST: "::" })).toThrow("Invalid JIT_HOST");
  expect(readConfig({}).hostname).toBe("127.0.0.1");
  expect(readConfig({ JIT_HOST: "10.20.30.40" }).hostname).toBe("10.20.30.40");
});
