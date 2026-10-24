import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpsCommand } from "../src/ops-cli";
import { parseDrillConfig } from "../src/ops/config";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { JobQueue } from "../src/jobs/queue";
import { unavailableNativePort } from "../src/ops/backup";
import { gatherDiagnostics, inspectDiagnostics } from "../src/ops/diagnostics";
import { contentHash, gitRevision } from "../src/ops/revisions";
import { opsBounds, opsEvidenceRetention } from "../src/ops/limits";
import { writeUpgradeFence } from "../src/ops/upgrade-fence";
import { quarantineRestorePort, runLoadDrill } from "../src/ops/drill";
import { exportOpsSummary, readOpsRecord, validateOpsRecord, writeOpsRecord } from "../src/ops/records";
import { composeProfile, composeReleaseChecklist, deriveDeterministicRows } from "../src/ops/report";
import { safeNote, validateDrillRecord } from "../src/ops/contracts";
import { TransactionStore, schemaVersion } from "../src/store";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const id = "ee781630-4d14-4d8b-a0eb-21b276ed5632";
const drillConfig = { groups: 2, prSnapshots: 3, memoryQueries: 4, deliveries: 4, schedules: 1, diskWatermarkBytes: 16777216, deadlineMs: 60000 };
function setup() {
  const root = mkdtempSync(join(tmpdir(), "jit-ops-drill-fixture-"));
  roots.push(root);
  mkdirSync(join(root, ".local"), { mode: 0o700 });
  return root;
}

type DiagnosticsInput = Parameters<typeof inspectDiagnostics>[0];
/** A healthy, fully configured scripted installation; failure fixtures override one field each. */
function healthy(overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput {
  const queue = overrides.queue ?? { available: true, queued: 0, admitted: 0, waiting: 0 };
  return { now: 1800000000000,
    store: { state: "readable", queried: true },
    coverage: { activeJobs: queue.queued + queue.admitted + queue.waiting, omittedRouteGroups: 0, omittedActiveJobs: 0, countsCapped: false },
    queue: { available: true, queued: 0, admitted: 0, waiting: 0 },
    routes: [], budgets: { exhausted: 0, deadlineFailed: 0 },
    waits: { quota: 0, needsLogin: 0, routeUnavailable: 0, authorizationChanged: 0 },
    disk: { stateBytes: 100, watermarkBytes: 1000 },
    telegram: { configured: true, binding: "bound", pendingIntents: 0, unknownDeliveries: 0 },
    engine: { mode: "scripted", available: true },
    providers: { configuredRoutes: 1 },
    schema: { current: schemaVersion, supported: schemaVersion },
    upgrade: { fence: "none", activeState: null },
    restore: { open: 0, blocked: 0, gate: "none" },
    artifacts: [], ...overrides };
}

test("diagnostics redacts identifiers and never carries secrets, paths or raw errors", () => {
  const sentinel = "Authorization: Bearer TOKEN_SENTINEL ssh://user@192.0.2.44 /private/credential";
  const snapshot = inspectDiagnostics(healthy({
    queue: { available: true, queued: 1, admitted: 0, waiting: 0 },
    routes: [{ route: "codex-subscription", model: "gpt-6.1-sol", state: "queued", attempts: 2 }],
    telegram: { configured: false, binding: "unbound", pendingIntents: 0, unknownDeliveries: 0 },
    artifacts: [id] }));
  expect(snapshot.routes).toEqual([{ reference: "route-1", model: "redacted", state: "queued", attempts: 2 }]);
  expect(snapshot.connections.telegram).toBe("unconfigured");
  expect(JSON.stringify(snapshot)).not.toMatch(/codex-subscription|gpt-6\.1-sol|TOKEN_SENTINEL|192\.0\.2\.44|Authorization/);
  expect(() => inspectDiagnostics(healthy({ routes: [{ route: sentinel, model: null, state: "queued", attempts: 0 }] }))).toThrow();
  expect(() => inspectDiagnostics({ now: NaN } as never)).toThrow();
  // Every field is required and bounded; unknown or missing keys fail closed.
  const { restore: _restore, ...missing } = healthy();
  expect(() => inspectDiagnostics(missing as never)).toThrow("invalid_diagnostics");
  expect(() => inspectDiagnostics({ ...healthy(), token: "TOKEN_SENTINEL" } as never)).toThrow("invalid_diagnostics");
  expect(() => inspectDiagnostics(healthy({ upgrade: { fence: "none", activeState: "Authorization: Bearer x" as never } }))).toThrow();
  expect(() => inspectDiagnostics(healthy({ restore: { open: 0, blocked: 1, gate: "none" } }))).toThrow();
  expect(inspectDiagnostics(healthy())).toMatchObject({ nextAction: "none", nextActions: [] });
});

test("failure fixtures produce inspectable next actions; observed route readiness needs live evidence", () => {
  const cases: [Partial<DiagnosticsInput>, string][] = [
    [{ telegram: { configured: false, binding: "unbound", pendingIntents: 0, unknownDeliveries: 0 } }, "configure-telegram"],
    [{ telegram: { configured: true, binding: "pending", pendingIntents: 0, unknownDeliveries: 0 } }, "bind-telegram"],
    [{ engine: { mode: "schway", available: true }, providers: { configuredRoutes: 0 } }, "configure-provider-route"],
    [{ telegram: { configured: true, binding: "bound", pendingIntents: 1, unknownDeliveries: 1 } }, "resolve-unknown-delivery"],
    [{ engine: { mode: "schway", available: false } }, "restore-engine"],
    [{ waits: { quota: 0, needsLogin: 1, routeUnavailable: 0, authorizationChanged: 0 }, queue: { available: true, queued: 0, admitted: 0, waiting: 1 } }, "reconnect-provider-login"],
    [{ waits: { quota: 0, needsLogin: 0, routeUnavailable: 0, authorizationChanged: 2 } }, "reauthorize-owner-work"],
    [{ waits: { quota: 1, needsLogin: 0, routeUnavailable: 0, authorizationChanged: 0 }, queue: { available: true, queued: 0, admitted: 0, waiting: 1 } }, "wait-for-quota-then-resume"],
    [{ restore: { open: 1, blocked: 0, gate: "none" } }, "resolve-restore-quarantine"],
    [{ restore: { open: 2, blocked: 1, gate: "none" } }, "resolve-restore-quarantine"],
    [{ upgrade: { fence: "restore", activeState: null } }, "resolve-restore-quarantine"],
    [{ restore: { open: 1, blocked: 0, gate: "pending" }, upgrade: { fence: "restore", activeState: null } }, "complete-restore-activation"],
    [{ restore: { open: 0, blocked: 0, gate: "unreadable" } }, "complete-restore-activation"],
    [{ upgrade: { fence: "upgrade", activeState: "ready" } }, "finish-or-rollback-upgrade"],
    [{ upgrade: { fence: "none", activeState: "activated" } }, "finish-or-rollback-upgrade"],
    [{ upgrade: { fence: "unreadable", activeState: null } }, "finish-or-rollback-upgrade"],
    [{ schema: { current: schemaVersion - 1, supported: schemaVersion } }, "run-owner-upgrade"],
    [{ schema: { current: schemaVersion + 1, supported: schemaVersion } }, "use-compatible-app-artifact"],
    [{ disk: { stateBytes: 2000, watermarkBytes: 1000 } }, "relieve-disk-pressure"],
    [{ queue: { available: false, queued: 0, admitted: 0, waiting: 0 } }, "inspect-sanitized-diagnostics"],
    [{ budgets: { exhausted: 1, deadlineFailed: 0 } }, "resolve-blocked-work"],
  ];
  for (const [override, action] of cases) {
    const snapshot = inspectDiagnostics(healthy(override));
    expect(snapshot.nextAction).toBe(action as never);
    expect(snapshot.nextActions[0]).toBe(action as never);
  }
  // Combined failures stay inspectable: every applicable action is listed in priority order.
  const combined = inspectDiagnostics(healthy({ engine: { mode: "schway", available: false }, providers: { configuredRoutes: 0 },
    restore: { open: 1, blocked: 1, gate: "none" }, telegram: { configured: false, binding: "unbound", pendingIntents: 0, unknownDeliveries: 3 } }));
  expect(combined.nextActions).toEqual(["resolve-restore-quarantine", "restore-engine", "configure-provider-route", "resolve-unknown-delivery", "configure-telegram"]);
  expect(combined).toMatchObject({ engine: { state: "unavailable", observed: "not-observed" }, restore: { state: "quarantine-blocked" },
    providers: { readiness: "not-configured" } });
  // Observed readiness is never produced here: a caller-supplied observation count is rejected outright.
  expect(inspectDiagnostics(healthy()).providers).toEqual({ configuredRoutes: 1, readiness: "configured-unverified", observed: "not-observed" });
  expect(() => inspectDiagnostics(healthy({ providers: { configuredRoutes: 1, observedRoutes: 1 } as never }))).toThrow("invalid_diagnostics");
  // Coverage must agree with the queue counts.
  expect(() => inspectDiagnostics(healthy({ coverage: { activeJobs: 5, omittedRouteGroups: 0, omittedActiveJobs: 0, countsCapped: false } }))).toThrow();
  expect(inspectDiagnostics(healthy({ engine: { mode: "scripted", available: false } })).engine.state).toBe("scripted");
});

test("gathered diagnostics read restore, upgrade, engine, route and authority state without probing or writing", async () => {
  const root = setup();
  const database = join(root, "state.sqlite");
  const store = new TransactionStore(database);
  try {
    store.transaction(tx => {
      tx.run("UPDATE team_state SET route_json = ? WHERE id = 1", JSON.stringify({ provider: "grok", model: "fixture-grok", authRoute: "owner-grok" }));
    });
  } finally { store.close(); }
  // OPS02 control plane: one open (validated) journal and one discarded journal under <db>.restores.
  const journalFile = (state: string, createdAt: number) => {
    const journalId = crypto.randomUUID();
    mkdirSync(join(`${database}.restores`, journalId), { recursive: true, mode: 0o700 });
    writeFileSync(join(`${database}.restores`, journalId, "journal.json"),
      JSON.stringify({ id: journalId, contract: "ops.quarantined_restore/v1", state, requests: [], createdAt }));
  };
  journalFile("validated", 1);
  journalFile("discarded", 2);
  writeUpgradeFence(database, crypto.randomUUID(), 1);
  // An unsafe (group-readable) host directory makes the declared engine unusable.
  mkdirSync(join(root, ".jit-host"), { mode: 0o755 });
  chmodSync(join(root, ".jit-host"), 0o755);
  const config = readConfig({ JIT_DATABASE: database, JIT_RUN_PORT: "schway", JIT_JOB_ROUTE_CONCURRENCY: "1",
    JIT_TELEGRAM_BOT_TOKEN_PATH: join(root, "missing.token") });
  const before = readdirSync(root).sort();
  const snapshot = inspectDiagnostics(gatherDiagnostics(root, config, 1800000000000));
  expect(readdirSync(root).sort()).toEqual(before);
  expect(snapshot).toMatchObject({ upgrade: { fence: "upgrade" }, restore: { open: 1, blocked: 0, gate: "none", state: "quarantine-open" },
    engine: { mode: "schway", state: "unavailable", observed: "not-observed" },
    providers: { configuredRoutes: 1, readiness: "configured-unverified", observed: "not-observed" },
    schemaVersion: { current: schemaVersion, supported: schemaVersion, state: "current" } });
  expect(snapshot.nextActions.slice(0, 3)).toEqual(["finish-or-rollback-upgrade", "resolve-restore-quarantine", "restore-engine"]);
  expect(JSON.stringify(snapshot)).not.toMatch(/grok|owner-grok|\.jit-host|state\.sqlite/);

  // An unfinished activation leaves the read gate; it outranks every other action. A corrupt journal reads as blocked.
  writeFileSync(`${database}.restore-pending`, JSON.stringify({ contract: "ops.quarantined_restore/v1", restoreId: crypto.randomUUID() }));
  const corrupt = crypto.randomUUID();
  mkdirSync(join(`${database}.restores`, corrupt), { mode: 0o700 });
  writeFileSync(join(`${database}.restores`, corrupt, "journal.json"), "{not json");
  const gated = inspectDiagnostics(gatherDiagnostics(root, config, 1800000000000));
  expect(gated.restore).toEqual({ open: 2, blocked: 1, gate: "pending", state: "activation-pending" });
  expect(gated.nextAction).toBe("complete-restore-activation");

  // An installation still at an older schema is reported, never migrated in place.
  const oldPath = join(root, "old.sqlite"), old = new Database(oldPath);
  old.exec(readFileSync(new URL("./fixtures/foundation-v10.sql", import.meta.url), "utf8"));
  old.close();
  const older = inspectDiagnostics(gatherDiagnostics(root, readConfig({ JIT_DATABASE: oldPath, JIT_TELEGRAM_BOT_TOKEN_PATH: join(root, "missing.token") })));
  expect(older.schemaVersion).toEqual({ current: 10, supported: schemaVersion, state: "upgrade-required" });
  expect(older.nextAction).toBe("run-owner-upgrade");
  const reopened = new Database(oldPath);
  expect((reopened.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(10);
  reopened.close();
});

test("gathered diagnostics count expired authority and provider-login waits with their next actions", async () => {
  const root = setup();
  const database = join(root, "auth.sqlite");
  const config = readConfig({ JIT_DATABASE: database, JIT_TELEGRAM_BOT_TOKEN_PATH: join(root, "missing.token") });
  const store = new TransactionStore(database);
  const work = (id: string, outcome: "needs_login" | "succeeded") => ({ id, title: id, revision: 1, replay: "read" as const,
    route: { provider: "fixture", model: "scripted", authRoute: "internal" }, cost: { roles: 1, calls: 1, rounds: 1, hops: 1 },
    validate: () => true,
    run: () => outcome === "needs_login" ? { state: "waiting" as const, reason: "needs_login" as const } : { state: "succeeded" as const, evidence: "ok" } });
  const queue = new JobQueue(store, config.jobs, [work("diag.login", "needs_login"), work("diag.later", "succeeded")], { now: () => 1800000000000 });
  try {
    const app = new Application(store, config, { jobs: queue, now: () => 1800000000000 });
    await app.setupOwner("ops-drill-owner-password");
    const actor = app.authenticate(await app.login("ops-drill-owner-password")).actor;
    const project = app.execute(actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null, expectedRevision: 0, payload: { name: "Authority" } }).project;
    const limits = { roles: 1, calls: 1, rounds: 1, hops: 1, contextTokens: 100, outputTokens: 100, retries: 1, wallMs: 60000 };
    const enqueue = (type: string) => app.execute(actor, { kind: "job.enqueue", requestId: crypto.randomUUID(), projectId: project.id,
      expectedRevision: app.jobs(actor, project.id).project.revision, payload: { type, configurationRevision: 1, policyRevision: config.jobs.revision,
        purpose: type, inputRevision: app.jobs(actor, project.id).project.revision, input: {}, priority: "background", limits } });
    enqueue("diag.login");
    queue.pump(); await queue.idle();
    enqueue("diag.later");
    // Owner credential rotation expires the authority every queued job was admitted under.
    store.transaction(tx => { tx.run("UPDATE owner SET generation = generation + 1 WHERE id = 'owner'"); });
    queue.pump(); await queue.idle();
  } finally { queue.close(); await queue.idle(); }
  try {
    const snapshot = inspectDiagnostics(gatherDiagnostics(root, config, 1800000000000));
    expect(snapshot.waits).toMatchObject({ authorizationChanged: 2 });
    expect(snapshot.nextActions).toContain("reauthorize-owner-work");
    expect(JSON.stringify(snapshot)).not.toMatch(/ops-drill-owner-password|fixture"|internal/);
  } finally { store.close(); }
  // A provider-login wait on a still-authorized job maps to reconnection, never to a route fallback.
  const login = inspectDiagnostics(healthy({ waits: { quota: 0, needsLogin: 1, routeUnavailable: 0, authorizationChanged: 0 },
    queue: { available: true, queued: 0, admitted: 0, waiting: 1 } }));
  expect(login.nextActions).toEqual(["reconnect-provider-login"]);
});

test("diagnose reads user_version first through the read-only adapter: missing, newer and existing stores are never touched", async () => {
  const root = setup();
  const cfg = (name: string) => readConfig({ JIT_DATABASE: join(root, name), JIT_TELEGRAM_BOT_TOKEN_PATH: join(root, "missing.token") });
  const sidecars = (name: string) => ["-wal", "-shm", "-journal"].filter(suffix => existsSync(join(root, name) + suffix));
  // Missing store: fixed state, nothing created.
  const missing = inspectDiagnostics(gatherDiagnostics(root, cfg("absent.sqlite"), 1800000000000));
  expect(missing).toMatchObject({ store: { state: "missing", queried: false }, nextAction: "run-owner-setup",
    schemaVersion: { current: null, state: "unavailable" }, queue: { available: false, queued: 0 } });
  expect(existsSync(join(root, "absent.sqlite"))).toBe(false);
  expect(sidecars("absent.sqlite")).toEqual([]);
  // Newer schema: a bounded snapshot with no schema-specific query, and the compatible-artifact action.
  const newer = new Database(join(root, "newer.sqlite"));
  newer.exec(`CREATE TABLE jobs (id TEXT); PRAGMA user_version = ${schemaVersion + 1};`);
  newer.close();
  chmodSync(join(root, "newer.sqlite"), 0o640);
  const newerBefore = { bytes: readFileSync(join(root, "newer.sqlite")), mode: statSync(join(root, "newer.sqlite")).mode };
  const newerSnapshot = inspectDiagnostics(gatherDiagnostics(root, cfg("newer.sqlite"), 1800000000000));
  expect(newerSnapshot).toMatchObject({ store: { state: "readable", queried: false },
    schemaVersion: { current: schemaVersion + 1, supported: schemaVersion, state: "newer-unsupported" }, nextAction: "use-compatible-app-artifact" });
  expect({ bytes: readFileSync(join(root, "newer.sqlite")), mode: statSync(join(root, "newer.sqlite")).mode }).toEqual(newerBefore);
  expect(sidecars("newer.sqlite")).toEqual([]);
  // Existing current store, closed (no sidecars): bytes, mode and sidecars unchanged.
  new TransactionStore(join(root, "current.sqlite")).close();
  chmodSync(join(root, "current.sqlite"), 0o640);
  const before = { bytes: readFileSync(join(root, "current.sqlite")), mode: statSync(join(root, "current.sqlite")).mode, sidecars: sidecars("current.sqlite") };
  const current = inspectDiagnostics(gatherDiagnostics(root, cfg("current.sqlite"), 1800000000000));
  expect(current).toMatchObject({ store: { state: "readable", queried: true }, schemaVersion: { state: "current" }, queue: { available: true } });
  expect({ bytes: readFileSync(join(root, "current.sqlite")), mode: statSync(join(root, "current.sqlite")).mode, sidecars: sidecars("current.sqlite") }).toEqual(before);
  // A live (open, WAL) store is read without changing its sidecars' presence; a lone sidecar reads as unreadable.
  const live = new TransactionStore(join(root, "live.sqlite"));
  try {
    const liveSidecars = sidecars("live.sqlite");
    expect(inspectDiagnostics(gatherDiagnostics(root, cfg("live.sqlite"), 1800000000000)).store).toEqual({ state: "readable", queried: true });
    expect(sidecars("live.sqlite")).toEqual(liveSidecars);
  } finally { live.close(); }
  writeFileSync(join(root, "current.sqlite-wal"), "");
  const torn = inspectDiagnostics(gatherDiagnostics(root, cfg("current.sqlite"), 1800000000000));
  expect(torn).toMatchObject({ store: { state: "unreadable", queried: false }, nextAction: "inspect-store-access", schemaVersion: { state: "unavailable" } });
  expect(readFileSync(join(root, "current.sqlite"))).toEqual(before.bytes);
  // Store states are strict: a non-queried store cannot carry counts, and a readable one needs a version.
  expect(() => inspectDiagnostics({ ...healthy(), store: { state: "missing", queried: true } })).toThrow();
  expect(() => inspectDiagnostics({ ...healthy(), store: { state: "readable", queried: false } })).toThrow();
  expect(() => inspectDiagnostics({ ...healthy(), schema: { current: null, supported: schemaVersion } })).toThrow();
});

test("drill configuration is finite and explicit; missing or unbounded limits fail preflight", () => {
  const fallback = { diskWatermarkBytes: 104857600, drillDeadlineMs: 120000 };
  expect(parseDrillConfig({ ...drillConfig }, fallback)).toEqual(drillConfig);
  expect(parseDrillConfig({ groups: 1, prSnapshots: 1, memoryQueries: 1, deliveries: 1, schedules: 1 }, fallback))
    .toMatchObject({ diskWatermarkBytes: 104857600, deadlineMs: 120000 });
  // One bound definition: every installation-valid knob is a valid drill fallback, and readConfig rejects what the drill would.
  const knobs = readConfig({ JIT_OPS_DISK_WATERMARK_BYTES: "2147483648", JIT_OPS_DRILL_DEADLINE_MS: "600000" }).ops;
  expect(parseDrillConfig({ groups: 1, prSnapshots: 1, memoryQueries: 1, deliveries: 1, schedules: 1 },
    { diskWatermarkBytes: knobs.diskWatermarkBytes, drillDeadlineMs: knobs.drillDeadlineMs })).toMatchObject({ diskWatermarkBytes: 2147483648, deadlineMs: 600000 });
  for (const env of [{ JIT_OPS_DISK_WATERMARK_BYTES: "1024" }, { JIT_OPS_DRILL_DEADLINE_MS: "999" }, { JIT_OPS_DRILL_DEADLINE_MS: "600001" },
    { JIT_OPS_DISK_WATERMARK_BYTES: String(opsBounds.diskWatermarkBytes.max + 1) }, { JIT_OPS_RETENTION_DAYS: "0" }]) {
    expect(() => readConfig(env)).toThrow();
  }
  const bad = [{}, { ...drillConfig, groups: 0 }, { ...drillConfig, groups: -1 }, { ...drillConfig, groups: 9 },
    { ...drillConfig, prSnapshots: 65 }, { ...drillConfig, memoryQueries: Infinity }, { ...drillConfig, deliveries: 0 },
    { ...drillConfig, schedules: 17 }, { ...drillConfig, schedules: 0 }, { ...drillConfig, diskWatermarkBytes: 1 }, { ...drillConfig, deadlineMs: 999 },
    { ...drillConfig, deadlineMs: Infinity }, { ...drillConfig, deadlineMs: 600001 }, { ...drillConfig, unknown: 1 }, { ...drillConfig, groups: "2" },
    { ...drillConfig, groups: 1.5 }, { ...drillConfig, groups: Number.MAX_SAFE_INTEGER + 1 }, "config", null, [],
    { ...drillConfig, diskWatermarkBytes: "Authorization: Bearer TOKEN_SENTINEL" }];
  for (const raw of bad) expect(() => parseDrillConfig(raw, fallback)).toThrow("invalid_drill_config");
  expect(() => parseDrillConfig({ ...drillConfig }, { diskWatermarkBytes: Infinity as never, drillDeadlineMs: 1 })).toThrow();
});

const legOrder = ["groups", "pr-snapshots", "pr-alerts", "memory-queries", "deliveries", "schedules", "quota-wait", "cancel",
  "export", "backup", "upgrade-preflight", "quarantine", "network", "disk-watermark"];
const stateOf = (record: { legs: { leg: string; state: string }[] }, leg: string) => record.legs.find(l => l.leg === leg)?.state;

test("bounded fixture drill runs the static PR path, export, backup and upgrade preflight without network", async () => {
  const network = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((() => { calls++; throw new Error("must_not_call"); }) as unknown as typeof fetch);
  try {
    const { record, root } = await runLoadDrill({ ...drillConfig });
    roots.push(root);
    expect(record.schema).toBe("jit.ops.drill/v1");
    expect(record.legs.map(l => l.leg)).toEqual(legOrder);
    for (const leg of ["groups", "pr-snapshots", "pr-alerts", "memory-queries", "deliveries", "schedules", "quota-wait", "cancel", "export", "network", "disk-watermark"]) {
      expect([leg, stateOf(record, leg)]).toEqual([leg, "passed"]);
    }
    // Engine-dependent legs ran against the fixture engine and say so.
    expect(stateOf(record, "backup")).toBe("scripted");
    expect(stateOf(record, "upgrade-preflight")).toBe("scripted");
    // (Asymmetric matchers inside toMatchObject can write into the subject under Bun; compare plain fields.)
    // The real OPS02 flow ran in quarantine and was discarded, releasing the shared fence and read gate.
    expect(stateOf(record, "quarantine")).toBe("passed");
    expect(record.legs.find(l => l.leg === "quarantine")!.detail)
      .toBe("states=quarantined>migrated>ledger_applied>validated checks=16 failedChecks=0 discarded=true fenceReleased=true");
    expect(record.measurements).toMatchObject({ fetchCalls: 0, sentDeliveries: 1, unknownDeliveries: 1, failedDeliveries: 2,
      succeededJobs: 6, prReports: 3, alertIntents: 3, waitingJobs: 1, cancelledJobs: 1 });
    expect(record.measurements.exportBytes).toBeGreaterThan(0);
    expect(record.measurements.backupBytes).toBeGreaterThan(0);
    expect(record.measurements.commands).toBeGreaterThan(10);
    expect(record.measurements.stopAckMs).not.toBeNull();
    expect(record.measurements.peakRssBytes).toBeGreaterThan(0);
    expect(record.fixtureHonesty.join("\n")).toMatch(/activation is never drilled/);
    expect(record.fixtureHonesty.join("\n")).toMatch(/not a latency SLO and not Pi capacity/);
    expect(record.outcome).toBe("passed");
    expect(record.nextAction).toBe("none");
    expect(calls).toBe(0);
    validateDrillRecord(record);
    expect(JSON.stringify(record)).not.toMatch(/TOKEN_SENTINEL|Authorization|Bearer|192\.0\.2|DRILLPROBE|api_key|drill-fixture-owner-password/);
  } finally { globalThis.fetch = network; }
});

test("drill record carries tested revisions; malformed revisions are rejected", async () => {
  const { record, root } = await runLoadDrill({ ...drillConfig });
  roots.push(root);
  expect(record.versions.schema).toBe(schemaVersion);
  expect(record.versions.app).toMatch(/^\d+\.\d+\.\d+/);
  expect([record.versions.engine.release, record.versions.engine.bridge, record.versions.engine.snapshot])
    .toEqual(["schway.host.release/v1", "jit.schway.bridge/v1", "schway.host.session-snapshot/v1"]);
  expect(record.versions.git === null || /^[a-f0-9]{40}$/.test(record.versions.git)).toBe(true);
  expect(record.versions.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(contentHash()).toBe(record.versions.contentHash);
  expect(record.versions.bun).toBe(Bun.version);
  for (const versions of [{ ...record.versions, git: "main" }, { ...record.versions, contentHash: "TOKEN_SENTINEL" },
    { ...record.versions, engine: { ...record.versions.engine, release: "Authorization: Bearer x" } },
    { ...record.versions, extra: 1 }, { app: record.versions.app, bun: null, schema: 22 }]) {
    expect(() => validateDrillRecord({ ...record, versions })).toThrow("invalid_ops_record");
  }
  // Revision probes are bounded and fail soft: a non-checkout root has no git revision or content hash.
  const bare = setup();
  expect(gitRevision(bare)).toBeNull();
  expect(contentHash(bare)).toBeNull();
});

test("engine-unavailable drill blocks backup and upgrade preflight and names the engine as next action", async () => {
  const { record, root } = await runLoadDrill({ ...drillConfig }, { nativeSnapshot: unavailableNativePort });
  roots.push(root);
  const leg = (name: string) => record.legs.find(l => l.leg === name)!;
  expect([leg("backup").state, leg("upgrade-preflight").state, leg("quarantine").state]).toEqual(["blocked", "blocked", "not-run"]);
  expect(leg("backup").detail).toContain("native_snapshot_unavailable");
  expect(leg("upgrade-preflight").detail).toContain("engine_unavailable");
  expect(leg("quarantine").detail).toContain("no verified backup");
  validateDrillRecord(record);
  expect(record.measurements.backupBytes).toBe(0);
  expect(stateOf(record, "export")).toBe("passed");
  expect(record.outcome).toBe("blocked");
  expect(record.nextAction).toBe("restore-engine");
  expect(record.fixtureHonesty.join("\n")).toMatch(/injected native port/);
  // Blocked legs are not limits: only typed limit events reach exhaustedLimits (here the scripted delivery retry ceiling).
  expect(record.exhaustedLimits).toEqual(["delivery-retry"]);
  const profile = composeProfile({ installationLabel: record.installationLabel, drill: record, sampleLimitations: [], nextAction: record.nextAction });
  expect(profile.exhaustedLimits).toEqual(["delivery-retry"]);
});

test("restore seam derives the quarantine leg from the injected port's result, failing closed on bad evidence", async () => {
  const seen: string[] = [];
  const ok = await runLoadDrill({ ...drillConfig }, { restore: async ({ app, actor, backupId }) => {
    seen.push(backupId);
    expect(app.backup(actor, backupId).integrity.state).toBe("verified");
    return { state: "passed", detail: "quarantine validated=true discarded=true" };
  } });
  roots.push(ok.root);
  expect(seen).toHaveLength(1);
  expect(ok.record.legs.find(l => l.leg === "quarantine")).toMatchObject({ state: "passed", detail: "quarantine validated=true discarded=true" });
  expect(ok.record.outcome).toBe("passed");
  expect(ok.record.nextAction).toBe("none");
  expect(ok.record.fixtureHonesty.join("\n")).toMatch(/injected restore port/);
  const leaky = await runLoadDrill({ ...drillConfig }, { restore: async () => ({ state: "passed", detail: "Authorization: Bearer TOKEN_SENTINEL" }) });
  roots.push(leaky.root);
  expect(stateOf(leaky.record, "quarantine")).toBe("failed");
  expect(JSON.stringify(leaky.record)).not.toContain("TOKEN_SENTINEL");
  const raising = await runLoadDrill({ ...drillConfig }, { restore: async () => { throw new Error("restore_quiesce_incomplete /private/path"); } });
  roots.push(raising.root);
  expect(raising.record.legs.find(l => l.leg === "quarantine")).toMatchObject({ state: "failed", detail: "leg raised instead of returning bounded evidence" });
  expect(raising.record.outcome).toBe("failed");
  expect(raising.record.nextAction).toBe("inspect-sanitized-drill");
  const bogus = await runLoadDrill({ ...drillConfig }, { restore: async () => ({ state: "ready" as never, detail: "ok" }) });
  roots.push(bogus.root);
  expect(stateOf(bogus.record, "quarantine")).toBe("failed");
});

test("quarantine leg reports an untrusted lifecycle ledger as blocked, never as a pass", async () => {
  const root = setup();
  const { record } = await runLoadDrill({ ...drillConfig }, { root, keepRoot: true, restore: async context => {
    // Corrupt the installation lifecycle ledger checkpoint the restore must trust.
    writeFileSync(join(root, "state", "app.sqlite.lifecycle-ledger.json"), "{corrupt");
    return quarantineRestorePort(context);
  } });
  const leg = record.legs.find(l => l.leg === "quarantine")!;
  expect(leg.state).toBe("blocked");
  expect(leg.detail).toMatch(/reason=ledger_checkpoint_/);
  expect(leg.detail).toContain("fenceReleased=true");
  expect(record.outcome).toBe("blocked");
  expect(record.nextAction).toBe("resolve-blocked-work");
  validateDrillRecord(record);
  // Every journal the drill opened ended (discarded or failed); nothing holds the fence or the read gate.
  const restored = inspectDiagnostics(gatherDiagnostics(root, readConfig({ JIT_DATABASE: join(root, "state", "app.sqlite"),
    JIT_TELEGRAM_BOT_TOKEN_PATH: join(root, "missing.token") })));
  expect(restored.upgrade.fence).toBe("none");
  expect(restored.restore).toEqual({ open: 0, blocked: 0, gate: "none", state: "none" });
  expect(leg.detail).toContain("discarded=true");
});

test("owner cancellation records remaining legs as not-run and asks for a bounded retry", async () => {
  const before = new AbortController();
  before.abort();
  const none = await runLoadDrill({ ...drillConfig }, { signal: before.signal });
  roots.push(none.root);
  expect(none.record.legs.map(l => l.state)).toEqual(legOrder.map(() => "not-run"));
  expect(none.record.outcome).toBe("blocked");
  expect(none.record.nextAction).toBe("retry-bounded-drill");
  const midway = new AbortController();
  const partial = await runLoadDrill({ ...drillConfig }, { signal: midway.signal,
    restore: async () => { midway.abort(); return { state: "passed", detail: "quarantine validated=true discarded=true" }; } });
  roots.push(partial.root);
  // Cancellation stops the running leg itself (fail closed), not only the legs after it.
  expect(partial.record.legs.find(l => l.leg === "quarantine")).toMatchObject({ state: "blocked", detail: "stopped: drill cancelled by owner during leg" });
  expect(partial.record.legs.find(l => l.leg === "network")).toMatchObject({ state: "not-run", detail: "skipped: drill cancelled by owner" });
  expect(stateOf(partial.record, "disk-watermark")).toBe("not-run");
  expect(partial.record.outcome).toBe("blocked");
  expect(partial.record.nextAction).toBe("retry-bounded-drill");
  validateDrillRecord(partial.record);
});

test("tiny disk watermark and expired authority produce honest blocked results with safe next actions", async () => {
  const tiny = await runLoadDrill({ ...drillConfig, diskWatermarkBytes: 4096 });
  roots.push(tiny.root);
  expect(tiny.record.legs.find(l => l.leg === "disk-watermark")!.state).toBe("blocked");
  expect(tiny.record.measurements.diskPressure).toBe(true);
  expect(tiny.record.outcome).toBe("blocked");
  expect(tiny.record.nextAction).toBe("relieve-disk-pressure");
});

test("release checklist derives deterministic rows from executed legs and links human gates by evidence ID only", async () => {
  const { record, root } = await runLoadDrill({ ...drillConfig });
  roots.push(root);
  const human = { FEAS: { state: "blocked" as const, evidenceId: id, note: "service identity inventory recorded" } };
  const checklist = composeReleaseChecklist({ installationLabel: "drill-fixture", drill: record, human });
  const row = (rowId: string) => checklist.deterministic.find(i => i.id === rowId)!;
  // J03 is fully drilled: static snapshot, review and alert admission all passed.
  expect(row("J03")).toMatchObject({ state: "passed", evidenceId: record.id });
  // Partially drilled journeys never pass from the drill alone; the uncovered scope is named.
  expect(row("J01")).toMatchObject({ state: "blocked", evidenceId: record.id });
  expect(row("J01").note).toContain("partial drill coverage");
  expect(row("J05").note).toMatch(/OPS05 human evidence/);
  // crash executed every mapped leg (quarantine included) but is only partially drilled, so it stays blocked.
  expect(row("crash").state).toBe("blocked");
  expect(row("crash").note).toContain("quarantine=passed");
  expect(row("crash").note).toContain("partial drill coverage");
  // A blocked leg blocks its row regardless of coverage.
  const blockedQuarantine = { ...record, legs: record.legs.map(l => l.leg === "quarantine" ? { ...l, state: "blocked" as const } : l) };
  expect(deriveDeterministicRows(blockedQuarantine).find(i => i.id === "crash")).toMatchObject({ state: "blocked", evidenceId: record.id });
  expect(checklist.human.find(i => i.id === "FEAS")).toMatchObject({ state: "blocked", evidenceId: id });
  expect(checklist.human.find(i => i.id === "OPS")).toMatchObject({ state: "not-run", evidenceId: null });
  expect(checklist.outcome).toBe("blocked");
  // Failed and missing legs propagate; no drill means nothing ran.
  const failedExport = { ...record, legs: record.legs.map(l => l.leg === "export" ? { ...l, state: "failed" as const } : l) };
  expect(deriveDeterministicRows(failedExport).find(i => i.id === "trust")).toMatchObject({ state: "failed", evidenceId: record.id });
  const missingAlerts = { ...record, legs: record.legs.filter(l => l.leg !== "pr-alerts") };
  expect(deriveDeterministicRows(missingAlerts).find(i => i.id === "J03")).toMatchObject({ state: "not-run", evidenceId: null });
  const empty = composeReleaseChecklist({ installationLabel: "drill-fixture", drill: null, human: {} });
  expect(empty.deterministic.every(i => i.state === "not-run" && i.evidenceId === null)).toBe(true);
  expect(empty.drillId).toBeNull();
  // Callers cannot type deterministic states, and human gates never auto-pass.
  expect(() => composeReleaseChecklist({ installationLabel: "drill-fixture", drill: record, human: {},
    deterministic: { J01: { state: "passed", evidenceId: id, note: "claimed" } } } as never)).toThrow();
  expect(() => composeReleaseChecklist({ installationLabel: "drill-fixture", drill: null,
    human: { FEAS: { state: "passed", evidenceId: null, note: "claimed without evidence" } } })).toThrow();
  expect(() => composeReleaseChecklist({ installationLabel: "drill-fixture", drill: null,
    human: { OPS: { state: "passed", evidenceId: id, note: "Authorization: Bearer TOKEN_SENTINEL" } } })).toThrow();
  expect(() => composeReleaseChecklist({ installationLabel: "drill-fixture", drill: { ...record, id: "not-a-uuid" }, human: {} })).toThrow();
});

test("composed profile carries versions, limits and sample bounds but never Pi readiness", async () => {
  const { record, root } = await runLoadDrill({ ...drillConfig });
  roots.push(root);
  const profile = composeProfile({ installationLabel: record.installationLabel, drill: record,
    sampleLimitations: [...record.fixtureHonesty], nextAction: record.nextAction });
  // Exhausted limits are the drill's typed limit events (scripted safe-failure retries hit the delivery retry ceiling).
  expect(profile.exhaustedLimits).toEqual(record.exhaustedLimits);
  expect(record.exhaustedLimits).toEqual(["delivery-retry"]);
  expect(profile).toMatchObject({ schema: "jit.ops.profile/v1", drillId: record.id, piReadiness: "not-claimed" });
  expect(profile.versions).toEqual(record.versions);
  expect(profile.versions.schema).toBe(schemaVersion);
  expect(profile.config).toEqual(record.config);
  expect(() => composeProfile({ installationLabel: "drill-fixture", drill: { ...record, schema: "jit.host.evidence/v1" } as never,
    sampleLimitations: [], nextAction: "none" })).toThrow();
  expect(() => composeProfile({ installationLabel: "drill-fixture", drill: { ...record, exhaustedLimits: ["quarantine"] } as never,
    sampleLimitations: [], nextAction: "none" })).toThrow();
});

test("diagnostics count active work with whole-table aggregates, so history beyond any row bound cannot hide it", async () => {
  const root = setup();
  const database = join(root, "history.sqlite");
  const config = readConfig({ JIT_DATABASE: database, JIT_TELEGRAM_BOT_TOKEN_PATH: join(root, "missing.token") });
  const store = new TransactionStore(database);
  try {
    const app = new Application(store, config, { now: () => 1800000000000 });
    await app.setupOwner("ops-drill-owner-password");
    const actor = app.authenticate(await app.login("ops-drill-owner-password")).actor;
    const project = app.execute(actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null, expectedRevision: 0, payload: { name: "History" } }).project;
    const record = (state: string, reason: string, provider: string) => JSON.stringify({ state, reason, route: { provider, model: null, authRoute: "internal" } });
    store.transaction(tx => {
      for (let n = 1; n <= 10001; n++) {
        tx.run("INSERT INTO jobs (id, project_id, queue_order, priority, state, occupies, route_key, record_json) VALUES (?, ?, ?, 0, 'succeeded', 0, 'r', ?)",
          crypto.randomUUID(), project.id, n, record("succeeded", "complete", "historic"));
      }
      tx.run("INSERT INTO jobs (id, project_id, queue_order, priority, state, occupies, route_key, record_json) VALUES (?, ?, ?, 0, 'queued', 0, 'r', ?)",
        crypto.randomUUID(), project.id, 10002, record("queued", "queued", "fresh-route"));
      // Ten more active route groups than the sample holds, plus one unlabelled provider.
      for (let n = 0; n < 10; n++) {
        tx.run("INSERT INTO jobs (id, project_id, queue_order, priority, state, occupies, route_key, record_json) VALUES (?, ?, ?, 0, 'waiting', 0, 'r', ?)",
          crypto.randomUUID(), project.id, 10003 + n, record("waiting", "quota", `route-group-${n}`));
      }
      tx.run("INSERT INTO jobs (id, project_id, queue_order, priority, state, occupies, route_key, record_json) VALUES (?, ?, ?, 0, 'waiting', 0, 'r', ?)",
        crypto.randomUUID(), project.id, 20000, record("waiting", "quota", "Authorization: Bearer TOKEN_SENTINEL"));
    });
  } finally { store.close(); }
  const snapshot = inspectDiagnostics(gatherDiagnostics(root, config, 1800000000000));
  expect(snapshot.queue).toMatchObject({ queued: 1, admitted: 0, waiting: 11 });
  expect(snapshot.waits.quota).toBe(11);
  expect(snapshot.nextActions).toContain("drain-queue");
  expect(snapshot.routes).toHaveLength(8);
  // Oldest active work first: the fresh queued job's route is sampled even behind 10001 historic rows.
  expect(snapshot.routes[0]).toMatchObject({ reference: "route-1", state: "queued", attempts: 1 });
  expect(snapshot.coverage).toEqual({ activeJobs: 12, omittedRouteGroups: 4, omittedActiveJobs: 4, countsCapped: false });
  expect(JSON.stringify(snapshot)).not.toMatch(/TOKEN_SENTINEL|fresh-route|route-group|historic/);
});

test("ops notes reject the shared credential forms, paths and addresses", () => {
  for (const note of ["ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", "token sk-ant-api03-AAAAAAAAAAAAAAAAAAAA", "xoxb-1234567890-abcdef",
    "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop", "api_key=abcdefgh12345678",
    "evidence at /private/install/path", "see ~/secrets", "copied ../outside", "C:\\Users\\owner", "https://intranet.example",
    "ssh to pi.local:2222", "host fd00::1:2:3", "[::1] loopback", "192.0.2.44", "-----BEGIN PRIVATE KEY-----"]) {
    expect(() => safeNote(note)).toThrow("invalid_ops_note");
  }
  for (const note of ["service identity inventory recorded", "partial drill coverage (backup=scripted quarantine=passed)",
    "Scripted specialist/synthesis runs; no Bot API traffic", "states=quarantined>migrated>ledger_applied>validated"]) {
    expect(safeNote(note)).toBe(note);
  }
  expect(() => composeReleaseChecklist({ installationLabel: "drill-fixture", drill: null,
    human: { FEAS: { state: "blocked", evidenceId: id, note: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" } } })).toThrow();
});

test("profile and release records are deep-validated on compose, write, read and export", async () => {
  const root = setup();
  const { record, root: drillRoot } = await runLoadDrill({ ...drillConfig });
  roots.push(drillRoot);
  const profile = composeProfile({ installationLabel: record.installationLabel, drill: record, sampleLimitations: [...record.fixtureHonesty], nextAction: record.nextAction });
  const release = composeReleaseChecklist({ installationLabel: "drill-fixture", drill: record, human: {} });
  validateOpsRecord(profile);
  validateOpsRecord(release);
  const badProfiles = [{ ...profile, id: "not-a-uuid" }, { ...profile, observedAt: "/private/install/path" }, { ...profile, piReadiness: "claimed-ready" },
    { ...profile, measurements: { ...profile.measurements, credential: "ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" } },
    { ...profile, config: { ...profile.config, groups: 1000 } }, { ...profile, exhaustedLimits: ["backup"] },
    { ...profile, sampleLimitations: ["see /private/path"] }, { ...profile, versions: { ...profile.versions, git: "main" } }];
  const badReleases = [{ ...release, outcome: "passed" }, { ...release, nextAction: "none" },
    { ...release, deterministic: release.deterministic.slice(1) },
    { ...release, human: release.human.map(r => ({ ...r, state: "passed" })) },
    { ...release, deterministic: release.deterministic.map(r => r.id === "J03" ? { ...r, evidenceId: "not-a-uuid" } : r) },
    { ...release, drillId: null }];
  for (const bad of [...badProfiles, ...badReleases]) {
    expect(() => validateOpsRecord(bad)).toThrow("invalid_ops_record");
    expect(() => exportOpsSummary(bad)).toThrow();
    await expect(writeOpsRecord(root, bad.id === "not-a-uuid" ? bad : { ...bad, id: crypto.randomUUID() })).rejects.toThrow();
  }
  await writeOpsRecord(root, profile);
  const file = join(root, ".local/ops-evidence", `${profile.id}.json`);
  writeFileSync(file, JSON.stringify({ ...profile, piReadiness: "claimed-ready" }));
  await expect(readOpsRecord(root, profile.id)).rejects.toThrow();
  expect(readdirSync(join(root, ".local/ops-evidence"))).toHaveLength(1);
});

test("ops-evidence retention prunes by age, count and bytes whenever a record is created", async () => {
  const root = setup();
  const { record, root: drillRoot } = await runLoadDrill({ ...drillConfig });
  roots.push(drillRoot);
  const dir = join(root, ".local/ops-evidence");
  const now = 1800000000000;
  await writeOpsRecord(root, record, { retentionDays: 30, now });
  const old = join(dir, `${record.id}.json`);
  utimesSync(old, new Date(now - 31 * 86_400_000), new Date(now - 31 * 86_400_000));
  // A planted symlink and a foreign file are never pruned.
  symlinkSync(join(tmpdir()), join(dir, `${crypto.randomUUID()}.json`));
  writeFileSync(join(dir, "notes.txt"), "keep");
  const fresh = { ...record, id: crypto.randomUUID() };
  await writeOpsRecord(root, fresh, { retentionDays: 30, now });
  expect(readdirSync(dir).filter(n => n.endsWith(".json") && !lstatSync(join(dir, n)).isSymbolicLink())).toEqual([`${fresh.id}.json`]);
  expect(readdirSync(dir)).toContain("notes.txt");
  // Count ceiling: fill to the limit with valid-looking records, then one more write keeps exactly the ceiling, oldest first out.
  const body = readFileSync(join(dir, `${fresh.id}.json`));
  const filler: string[] = [];
  for (let n = 0; n < opsEvidenceRetention.maxRecords; n++) {
    const name = `${crypto.randomUUID()}.json`;
    writeFileSync(join(dir, name), body, { mode: 0o600 });
    utimesSync(join(dir, name), new Date(now - (opsEvidenceRetention.maxRecords - n) * 1000), new Date(now - (opsEvidenceRetention.maxRecords - n) * 1000));
    filler.push(name);
  }
  const last = { ...record, id: crypto.randomUUID() };
  await writeOpsRecord(root, last, { retentionDays: 30, now });
  const records = readdirSync(dir).filter(n => /^[a-f0-9-]{36}\.json$/.test(n) && !lstatSync(join(dir, n)).isSymbolicLink());
  expect(records).toHaveLength(opsEvidenceRetention.maxRecords);
  expect(records).toContain(`${last.id}.json`);
  expect(records).not.toContain(filler[0]);
  expect(records.reduce((sum, n) => sum + statSync(join(dir, n)).size, 0)).toBeLessThanOrEqual(opsEvidenceRetention.maxBytes);
  await expect(writeOpsRecord(root, { ...record, id: crypto.randomUUID() }, { retentionDays: 0, now })).rejects.toThrow("invalid_ops_retention");
});

test("deliveries go through the DeliveryWorker over a fixture binding; counts come from persisted intents and attempts", async () => {
  const root = setup();
  const { record } = await runLoadDrill({ ...drillConfig }, { root, keepRoot: true });
  expect(record.measurements).toMatchObject({ sentDeliveries: 1, unknownDeliveries: 1, failedDeliveries: 2 });
  const store = new TransactionStore(join(root, "state", "app.sqlite"));
  try {
    const intents = store.read(tx => tx.all<{ id: string; record_json: string }>("SELECT id, record_json FROM delivery_intents WHERE dedupe_key LIKE 'drill/delivery-%' ORDER BY sequence"));
    expect(intents.map(i => (JSON.parse(i.record_json) as { status: string }).status)).toEqual(["sent", "unknown", "failed", "failed"]);
    const attempts = store.read(tx => tx.all<{ record_json: string }>(
      "SELECT record_json FROM delivery_attempts WHERE intent_id IN (SELECT id FROM delivery_intents WHERE dedupe_key LIKE 'drill/delivery-%')"));
    expect(attempts).toHaveLength(record.measurements.deliveryAttempts);
    // Safe failures retried within their budget: more attempts than intents, each invoked only after its claim committed.
    expect(attempts.length).toBeGreaterThan(config4());
    expect(attempts.every(a => (JSON.parse(a.record_json) as { senderInvoked: boolean }).senderInvoked)).toBe(true);
    expect(store.read(tx => tx.get<{ state: string }>("SELECT state FROM telegram_binding WHERE id = 1"))!.state).toBe("bound");
  } finally { store.close(); }
  expect(record.legs.find(l => l.leg === "deliveries")!.detail).toMatch(/attempts=\d+ unsettled=0/);
});
const config4 = () => drillConfig.deliveries;

test("queue wait is per-job admission latency and peak RSS is the process high-water mark", async () => {
  const before = process.resourceUsage().maxRSS * 1024;
  let during = 0;
  const { record, root } = await runLoadDrill({ ...drillConfig }, { restore: async context => {
    // A transient allocation inside a leg must be reflected by the high-water mark even after it is released.
    let block: Uint8Array | null = new Uint8Array(96 * 1024 * 1024).fill(7);
    during = process.memoryUsage().rss;
    block = null; void block;
    return quarantineRestorePort(context);
  } });
  roots.push(root);
  const m = record.measurements;
  // Snapshot + review jobs per PR candidate, the quota probe and the gated stop probe; schedule jobs are not sampled.
  expect(m.queueWaitSamples).toBe(drillConfig.prSnapshots * 2 + 2);
  expect(m.queueWaitMaxMs).toBeGreaterThanOrEqual(m.queueWaitP95Ms);
  expect(m.queueWaitMaxMs).toBeLessThan(drillConfig.deadlineMs);
  expect(m.peakRssBytes).toBeGreaterThanOrEqual(before);
  expect(m.peakRssBytes).toBeGreaterThanOrEqual(during);
  expect(record.fixtureHonesty.join("\n")).toMatch(/high-water RSS/);
});

test("the drill deadline bounds a running leg, fails closed and skips the rest", async () => {
  const cooperative = await runLoadDrill({ ...drillConfig, deadlineMs: 1000 }, { restore: async ({ signal }) => {
    await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { state: "passed", detail: "should not be recorded" };
  } });
  roots.push(cooperative.root);
  expect(cooperative.record.legs.find(l => l.leg === "quarantine")).toMatchObject({ state: "blocked", detail: "stopped: drill deadline reached during leg" });
  expect(cooperative.record.legs.find(l => l.leg === "network")).toMatchObject({ state: "not-run", detail: "skipped: drill deadline exceeded" });
  expect(cooperative.record.exhaustedLimits).toContain("drill-deadline");
  expect(cooperative.record.outcome).toBe("blocked");
  expect(cooperative.record.nextAction).toBe("retry-bounded-drill");
  // A leg that ignores its signal is abandoned after a bounded grace instead of extending the drill.
  const t0 = performance.now();
  const stubborn = await runLoadDrill({ ...drillConfig, deadlineMs: 1000 }, { restore: async () => {
    await Bun.sleep(4000);
    return { state: "passed", detail: "late" };
  } });
  roots.push(stubborn.root);
  expect(performance.now() - t0).toBeLessThan(3500);
  expect(stubborn.record.legs.find(l => l.leg === "quarantine")!.state).toBe("blocked");
  validateDrillRecord(stubborn.record);
}, 15000);

test("the fetch guard is single-flight and compare-and-restore", async () => {
  const original = globalThis.fetch;
  const first = runLoadDrill({ ...drillConfig });
  await expect(runLoadDrill({ ...drillConfig })).rejects.toThrow("drill_in_progress");
  const done = await first;
  roots.push(done.root);
  expect(globalThis.fetch).toBe(original);
  // Someone replacing the guard mid-drill fails the network leg, and cleanup never clobbers their function.
  const foreign = (() => { throw new Error("foreign"); }) as unknown as typeof fetch;
  try {
    const replaced = await runLoadDrill({ ...drillConfig }, { restore: async context => { globalThis.fetch = foreign; return quarantineRestorePort(context); } });
    roots.push(replaced.root);
    expect(replaced.record.legs.find(l => l.leg === "network")).toMatchObject({ state: "failed" });
    expect(replaced.record.legs.find(l => l.leg === "network")!.detail).toContain("fetch guard replaced");
    expect(globalThis.fetch).toBe(foreign);
  } finally { globalThis.fetch = original; }
});

test("oversized records, symlinked storage and sentinel configs fail safely without partial writes", async () => {
  const root = setup();
  const { record } = await runLoadDrill({ ...drillConfig });
  await writeOpsRecord(root, record);
  await expect(writeOpsRecord(root, record)).rejects.toThrow();
  expect(await readOpsRecord(root, record.id)).toEqual(record);
  expect(readdirSync(join(root, ".local/ops-evidence"))).toHaveLength(1);
  const file = join(root, ".local/ops-evidence", `${record.id}.json`);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(file).size).toBeLessThanOrEqual(32768);
  await expect(writeOpsRecord(root, { ...record, id: crypto.randomUUID(), token: "TOKEN_SENTINEL" })).rejects.toThrow();
  await expect(writeOpsRecord(root, { ...record, id: crypto.randomUUID(), legs: Array(900).fill(record.legs[0]) })).rejects.toThrow();
  expect(readdirSync(join(root, ".local/ops-evidence"))).toHaveLength(1);
  writeFileSync(file, JSON.stringify({ ...record, token: "TOKEN_SENTINEL" }));
  writeFileSync(join(root, ".local/checklist.json"), JSON.stringify({ human: {} }));
  const exported = await runOpsCommand(["report", "--id", record.id, "--checklist", ".local/checklist.json"], root);
  expect(exported.exitCode).toBe(2);
  expect(JSON.stringify(exported)).not.toContain("TOKEN_SENTINEL");
  rmSync(join(root, ".local"), { recursive: true });
  symlinkSync(join(tmpdir()), join(root, ".local"));
  await expect(writeOpsRecord(root, { ...record, id: crypto.randomUUID() })).rejects.toThrow();
});

test("standalone CLI drills, reports and rejects invalid invocations with fixed codes", async () => {
  const root = setup();
  const cli = join(import.meta.dir, "../src/ops-cli.ts");
  const run = async (args: string[]) => {
    const child = Bun.spawn([process.execPath, cli, ...args], { cwd: root, env: { ...process.env, JIT_DATABASE: join(root, "state.sqlite") }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe("");
    return { stdout, exit };
  };
  writeFileSync(join(root, ".local/drill.json"), JSON.stringify(drillConfig));
  const drilled = await run(["drill", "--config", ".local/drill.json"]);
  expect(drilled.exit).toBe(0);
  const summary = JSON.parse(drilled.stdout) as { stored: boolean; legs: Array<{ leg: string; state: string }>; recordId: string };
  expect(summary.stored).toBe(true);
  expect(summary.legs.find(l => l.leg === "quarantine")).toMatchObject({ state: "passed" });
  expect(drilled.stdout).not.toMatch(/TOKEN_SENTINEL|Authorization|Bearer/);
  const exported = await readOpsRecord(root, summary.recordId);
  expect({ ...exportOpsSummary(exported), stored: true }).toEqual(summary);
  writeFileSync(join(root, ".local/checklist.json"), JSON.stringify({ human: {} }));
  const reported = await run(["report", "--id", summary.recordId, "--checklist", ".local/checklist.json"]);
  expect(reported.exit).toBe(0);
  const printed = JSON.parse(reported.stdout) as { revisions: unknown; profile: Record<string, unknown>; checklist: { outcome: string; rows: { id: string; state: string; evidenceId: string | null }[] } };
  // The printed profile is a reviewable artifact on its own: revisions, workload, limits, limitations and the disclaimer.
  expect(Object.keys(printed.profile).sort()).toEqual(["config", "drillId", "exhaustedLimits", "measurements", "nextAction", "observedAt",
    "piReadiness", "readinessDisclaimer", "recordId", "sampleLimitations", "schema", "versions"]);
  expect(printed.profile).toMatchObject({ piReadiness: "not-claimed", drillId: summary.recordId, config: drillConfig, exhaustedLimits: ["delivery-retry"] });
  expect(String(printed.profile.readinessDisclaimer)).toContain("not Pi or capacity readiness");
  expect(printed.checklist.outcome).toBe("blocked");
  expect(printed.revisions).toEqual((exported as { versions: unknown }).versions);
  expect(printed.checklist.rows.find(r => r.id === "J03")).toEqual({ id: "J03", state: "passed", evidenceId: summary.recordId });
  expect(printed.checklist.rows.find(r => r.id === "OPS")).toEqual({ id: "OPS", state: "not-run", evidenceId: null });
  // Deterministic rows are derived; a checklist file that tries to type them is rejected.
  writeFileSync(join(root, ".local/typed.json"), JSON.stringify({ deterministic: { J01: { state: "passed", evidenceId: summary.recordId, note: "typed" } }, human: {} }));
  expect((await run(["report", "--id", summary.recordId, "--checklist", ".local/typed.json"])).exit).toBe(2);
  for (const args of [["diagnose", "--extra"], ["drill"], ["drill", "--config", ".local/missing.json"], ["report", "--id", summary.recordId], ["inventory", "--config", "x"], ["drill", "--config", ".local/drill.json", "--label", "bad label!"]]) {
    expect((await run(args)).exit).toBe(2);
  }
  writeFileSync(join(root, ".local/drill.json"), JSON.stringify({ ...drillConfig, groups: 0 }));
  expect((await run(["drill", "--config", ".local/drill.json"])).exit).toBe(2);
  const diagnosed = await run(["diagnose"]);
  expect(diagnosed.exit).toBe(0);
  // A missing installation database is a fixed state with its own next action; diagnose never creates it.
  expect(JSON.parse(diagnosed.stdout)).toMatchObject({ schema: "jit.ops.diagnostics/v1", queue: { available: false },
    store: { state: "missing", queried: false }, nextAction: "run-owner-setup", schemaVersion: { current: null, state: "unavailable" },
    engine: { mode: "scripted", state: "scripted", observed: "not-observed" }, providers: { observed: "not-observed" },
    upgrade: { fence: "none", activeState: null }, restore: { state: "none" } });
  expect(existsSync(join(root, "state.sqlite"))).toBe(false);
});

test("main diagnose path inspects without claiming scheduler ownership or starting work", async () => {
  const root = setup();
  const main = join(import.meta.dir, "../src/main.ts");
  const child = Bun.spawn([process.execPath, main, "diagnose"], { cwd: root, env: { JIT_DATABASE: join(root, "diag.sqlite") }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  expect(JSON.parse(stdout).schema).toBe("jit.ops.diagnostics/v1");
  // Read-only: a missing database is not created; an existing one is neither modified nor journaled.
  expect(existsSync(join(root, "diag.sqlite"))).toBe(false);
  const { TransactionStore } = await import("../src/store");
  new TransactionStore(join(root, "diag.sqlite")).close();
  chmodSync(join(root, "diag.sqlite"), 0o640);
  const before = { bytes: readFileSync(join(root, "diag.sqlite")), mode: statSync(join(root, "diag.sqlite")).mode };
  const again = Bun.spawn([process.execPath, main, "diagnose"], { cwd: root, env: { JIT_DATABASE: join(root, "diag.sqlite") }, stdout: "pipe", stderr: "pipe" });
  const [againOut, , againExit] = await Promise.all([new Response(again.stdout).text(), new Response(again.stderr).text(), again.exited]);
  expect(againExit).toBe(0);
  expect(JSON.parse(againOut)).toMatchObject({ queue: { available: true } });
  expect({ bytes: readFileSync(join(root, "diag.sqlite")), mode: statSync(join(root, "diag.sqlite")).mode }).toEqual(before);
  expect(["-wal", "-shm", "-journal"].filter(suffix => existsSync(join(root, "diag.sqlite") + suffix))).toEqual([]);
});
