import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
import { writeUpgradeFence } from "../src/ops/upgrade-fence";
import { runLoadDrill } from "../src/ops/drill";
import { exportOpsSummary, readOpsRecord, writeOpsRecord } from "../src/ops/records";
import { composeProfile, composeReleaseChecklist, deriveDeterministicRows } from "../src/ops/report";
import { validateDrillRecord } from "../src/ops/contracts";
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
  return { now: 1800000000000,
    queue: { available: true, queued: 0, admitted: 0, waiting: 0 },
    routes: [], budgets: { exhausted: 0, deadlineFailed: 0 },
    waits: { quota: 0, needsLogin: 0, routeUnavailable: 0, authorizationChanged: 0 },
    disk: { stateBytes: 100, watermarkBytes: 1000 },
    telegram: { configured: true, binding: "bound", pendingIntents: 0, unknownDeliveries: 0 },
    engine: { mode: "scripted", available: true },
    providers: { configuredRoutes: 1, observedRoutes: 0 },
    schema: { current: schemaVersion, supported: schemaVersion },
    upgrade: { fence: "none", activeState: null },
    restore: { open: 0, blocked: 0 },
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
  expect(() => inspectDiagnostics(healthy({ restore: { open: 0, blocked: 1 } }))).toThrow();
  expect(inspectDiagnostics(healthy())).toMatchObject({ nextAction: "none", nextActions: [] });
});

test("failure fixtures produce inspectable next actions; observed route readiness needs live evidence", () => {
  const cases: [Partial<DiagnosticsInput>, string][] = [
    [{ telegram: { configured: false, binding: "unbound", pendingIntents: 0, unknownDeliveries: 0 } }, "configure-telegram"],
    [{ telegram: { configured: true, binding: "pending", pendingIntents: 0, unknownDeliveries: 0 } }, "bind-telegram"],
    [{ engine: { mode: "schway", available: true }, providers: { configuredRoutes: 0, observedRoutes: 0 } }, "configure-provider-route"],
    [{ telegram: { configured: true, binding: "bound", pendingIntents: 1, unknownDeliveries: 1 } }, "resolve-unknown-delivery"],
    [{ engine: { mode: "schway", available: false } }, "restore-engine"],
    [{ waits: { quota: 0, needsLogin: 1, routeUnavailable: 0, authorizationChanged: 0 }, queue: { available: true, queued: 0, admitted: 0, waiting: 1 } }, "reconnect-provider-login"],
    [{ waits: { quota: 0, needsLogin: 0, routeUnavailable: 0, authorizationChanged: 2 } }, "reauthorize-owner-work"],
    [{ waits: { quota: 1, needsLogin: 0, routeUnavailable: 0, authorizationChanged: 0 }, queue: { available: true, queued: 0, admitted: 0, waiting: 1 } }, "wait-for-quota-then-resume"],
    [{ restore: { open: 1, blocked: 0 } }, "resolve-restore-quarantine"],
    [{ restore: { open: 2, blocked: 1 } }, "resolve-restore-quarantine"],
    [{ upgrade: { fence: "restore", activeState: null } }, "resolve-restore-quarantine"],
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
  const combined = inspectDiagnostics(healthy({ engine: { mode: "schway", available: false }, providers: { configuredRoutes: 0, observedRoutes: 0 },
    restore: { open: 1, blocked: 1 }, telegram: { configured: false, binding: "unbound", pendingIntents: 0, unknownDeliveries: 3 } }));
  expect(combined.nextActions).toEqual(["resolve-restore-quarantine", "restore-engine", "configure-provider-route", "resolve-unknown-delivery", "configure-telegram"]);
  expect(combined).toMatchObject({ engine: { state: "unavailable", observed: "not-observed" }, restore: { state: "quarantine-blocked" },
    providers: { readiness: "not-configured" } });
  expect(inspectDiagnostics(healthy()).providers).toEqual({ configuredRoutes: 1, observedRoutes: 0, readiness: "configured-unverified" });
  expect(inspectDiagnostics(healthy({ providers: { configuredRoutes: 1, observedRoutes: 1 } })).providers.readiness).toBe("observed-ready");
  expect(() => inspectDiagnostics(healthy({ providers: { configuredRoutes: 0, observedRoutes: 1 } }))).toThrow();
  expect(inspectDiagnostics(healthy({ engine: { mode: "scripted", available: false } })).engine.state).toBe("scripted");
});

test("gathered diagnostics read restore, upgrade, engine, route and authority state without probing or writing", async () => {
  const root = setup();
  const database = join(root, "state.sqlite");
  const store = new TransactionStore(database);
  try {
    store.transaction(tx => {
      tx.run("INSERT INTO restore_quarantines VALUES (?, ?, ?, ?)", crypto.randomUUID(), 1, "validated", "{}");
      tx.run("INSERT INTO restore_quarantines VALUES (?, ?, ?, ?)", crypto.randomUUID(), 2, "discarded", "{}");
      tx.run("UPDATE team_state SET route_json = ? WHERE id = 1", JSON.stringify({ provider: "grok", model: "fixture-grok", authRoute: "owner-grok" }));
    });
  } finally { store.close(); }
  writeUpgradeFence(database, crypto.randomUUID(), 1);
  // An unsafe (group-readable) host directory makes the declared engine unusable.
  mkdirSync(join(root, ".jit-host"), { mode: 0o755 });
  chmodSync(join(root, ".jit-host"), 0o755);
  const config = readConfig({ JIT_DATABASE: database, JIT_RUN_PORT: "schway", JIT_JOB_ROUTE_CONCURRENCY: "1",
    JIT_TELEGRAM_BOT_TOKEN_PATH: join(root, "missing.token") });
  const before = readdirSync(root).sort();
  const snapshot = inspectDiagnostics(gatherDiagnostics(root, config, 1800000000000));
  expect(readdirSync(root).sort()).toEqual(before);
  expect(snapshot).toMatchObject({ upgrade: { fence: "upgrade" }, restore: { open: 1, blocked: 0, state: "quarantine-open" },
    engine: { mode: "schway", state: "unavailable", observed: "not-observed" },
    providers: { configuredRoutes: 1, observedRoutes: 0, readiness: "configured-unverified" },
    schemaVersion: { current: schemaVersion, supported: schemaVersion, state: "current" } });
  expect(snapshot.nextActions.slice(0, 3)).toEqual(["finish-or-rollback-upgrade", "resolve-restore-quarantine", "restore-engine"]);
  expect(JSON.stringify(snapshot)).not.toMatch(/grok|owner-grok|\.jit-host|state\.sqlite/);

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

test("drill configuration is finite and explicit; missing or unbounded limits fail preflight", () => {
  const fallback = { diskWatermarkBytes: 104857600, drillDeadlineMs: 120000 };
  expect(parseDrillConfig({ ...drillConfig }, fallback)).toEqual(drillConfig);
  expect(parseDrillConfig({ groups: 1, prSnapshots: 1, memoryQueries: 1, deliveries: 1, schedules: 0 }, fallback))
    .toMatchObject({ diskWatermarkBytes: 104857600, deadlineMs: 120000 });
  const bad = [{}, { ...drillConfig, groups: 0 }, { ...drillConfig, groups: -1 }, { ...drillConfig, groups: 9 },
    { ...drillConfig, prSnapshots: 65 }, { ...drillConfig, memoryQueries: Infinity }, { ...drillConfig, deliveries: 0 },
    { ...drillConfig, schedules: 17 }, { ...drillConfig, diskWatermarkBytes: 1 }, { ...drillConfig, deadlineMs: 999 },
    { ...drillConfig, deadlineMs: Infinity }, { ...drillConfig, unknown: 1 }, { ...drillConfig, groups: "2" },
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
    // Engine-dependent legs ran against the fixture engine and say so; the restore leg is an honest gate.
    expect(stateOf(record, "backup")).toBe("scripted");
    expect(stateOf(record, "upgrade-preflight")).toBe("scripted");
    // (Asymmetric matchers inside toMatchObject can write into the subject under Bun; compare plain fields.)
    expect(stateOf(record, "quarantine")).toBe("blocked");
    expect(record.legs.find(l => l.leg === "quarantine")!.detail).toMatch(/^pending OPS02 \(#33\)/);
    expect(record.measurements).toMatchObject({ fetchCalls: 0, sentDeliveries: 1, unknownDeliveries: 1, failedDeliveries: 2,
      succeededJobs: 6, prReports: 3, alertIntents: 3, waitingJobs: 1, cancelledJobs: 1 });
    expect(record.measurements.exportBytes).toBeGreaterThan(0);
    expect(record.measurements.backupBytes).toBeGreaterThan(0);
    expect(record.measurements.commands).toBeGreaterThan(10);
    expect(record.measurements.stopAckMs).not.toBeNull();
    expect(record.measurements.peakRssBytes).toBeGreaterThan(0);
    expect(record.fixtureHonesty.join("\n")).toMatch(/OPS02 \(#33\)/);
    expect(record.fixtureHonesty.join("\n")).toMatch(/not a latency SLO and not Pi capacity/);
    expect(record.outcome).toBe("blocked");
    expect(record.nextAction).toBe("integrate-pending-contract");
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
  expect(stateOf(partial.record, "quarantine")).toBe("passed");
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
  // A blocked leg (restore pending OPS02) blocks its row regardless of coverage.
  expect(row("crash").state).toBe("blocked");
  expect(row("crash").note).toContain("quarantine=blocked");
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
    exhaustedLimits: ["quarantine"], sampleLimitations: [...record.fixtureHonesty], nextAction: record.nextAction });
  expect(profile).toMatchObject({ schema: "jit.ops.profile/v1", drillId: record.id, piReadiness: "not-claimed" });
  expect(profile.versions).toEqual(record.versions);
  expect(profile.versions.schema).toBe(schemaVersion);
  expect(profile.config).toEqual(record.config);
  expect(() => composeProfile({ installationLabel: "drill-fixture", drill: { ...record, schema: "jit.host.evidence/v1" } as never,
    exhaustedLimits: [], sampleLimitations: [], nextAction: "none" })).toThrow();
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
  expect(summary.legs.find(l => l.leg === "quarantine")).toMatchObject({ state: "blocked" });
  expect(drilled.stdout).not.toMatch(/TOKEN_SENTINEL|Authorization|Bearer/);
  const exported = await readOpsRecord(root, summary.recordId);
  expect({ ...exportOpsSummary(exported), stored: true }).toEqual(summary);
  writeFileSync(join(root, ".local/checklist.json"), JSON.stringify({ human: {} }));
  const reported = await run(["report", "--id", summary.recordId, "--checklist", ".local/checklist.json"]);
  expect(reported.exit).toBe(0);
  const printed = JSON.parse(reported.stdout) as { revisions: unknown; checklist: { outcome: string; rows: { id: string; state: string; evidenceId: string | null }[] } };
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
  expect(JSON.parse(diagnosed.stdout)).toMatchObject({ schema: "jit.ops.diagnostics/v1", nextAction: "configure-telegram",
    engine: { mode: "scripted", state: "scripted", observed: "not-observed" }, providers: { observedRoutes: 0 },
    upgrade: { fence: "none", activeState: null }, restore: { state: "none" } });
});

test("main diagnose path inspects without claiming scheduler ownership or starting work", async () => {
  const root = setup();
  const main = join(import.meta.dir, "../src/main.ts");
  const child = Bun.spawn([process.execPath, main, "diagnose"], { cwd: root, env: { JIT_DATABASE: join(root, "diag.sqlite") }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  expect(exit).toBe(0);
  expect(JSON.parse(stdout).schema).toBe("jit.ops.diagnostics/v1");
  const { TransactionStore } = await import("../src/store");
  const store = new TransactionStore(join(root, "diag.sqlite"));
  try {
    expect(store.read(tx => tx.get("SELECT * FROM job_scheduler"))).toBeNull();
  } finally { store.close(); }
  expect(readFileSync(join(root, "diag.sqlite")).length).toBeGreaterThan(0);
});
