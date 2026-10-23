import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runOpsCommand } from "../src/ops-cli";
import { parseDrillConfig } from "../src/ops/config";
import { inspectDiagnostics } from "../src/ops/diagnostics";
import { runLoadDrill } from "../src/ops/drill";
import { exportOpsSummary, readOpsRecord, writeOpsRecord } from "../src/ops/records";
import { composeProfile, composeReleaseChecklist } from "../src/ops/report";
import { validateDrillRecord } from "../src/ops/contracts";
import { schemaVersion } from "../src/store";

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

test("diagnostics redacts identifiers and never carries secrets, paths or raw errors", () => {
  const sentinel = "Authorization: Bearer TOKEN_SENTINEL ssh://user@192.0.2.44 /private/credential";
  const snapshot = inspectDiagnostics({ now: 1800000000000,
    queue: { available: true, queued: 1, admitted: 0, waiting: 0 },
    routes: [{ route: "codex-subscription", model: "gpt-6.1-sol", state: "queued", attempts: 2 }],
    budgets: { exhausted: 0, deadlineFailed: 0 },
    disk: { stateBytes: 100, watermarkBytes: 1000 },
    telegram: { configured: false, pendingIntents: 0, unknownDeliveries: 0 },
    artifacts: [id] });
  expect(snapshot.routes).toEqual([{ reference: "route-1", model: "redacted", state: "queued", attempts: 2 }]);
  expect(snapshot.connections.telegram).toBe("unconfigured");
  expect(JSON.stringify(snapshot)).not.toMatch(/codex-subscription|gpt-6\.1-sol|TOKEN_SENTINEL|192\.0\.2\.44|Authorization/);
  expect(() => inspectDiagnostics({ now: 1800000000000,
    queue: { available: true, queued: 0, admitted: 0, waiting: 0 },
    routes: [{ route: sentinel, model: null, state: "queued", attempts: 0 }],
    budgets: { exhausted: 0, deadlineFailed: 0 }, disk: { stateBytes: 0, watermarkBytes: 1 },
    telegram: { configured: false, pendingIntents: 0, unknownDeliveries: 0 }, artifacts: [] })).toThrow();
  expect(() => inspectDiagnostics({ now: NaN } as never)).toThrow();
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

test("bounded fixture drill records scripted PR legs, unknown deliveries and contract gates without network", async () => {
  const network = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = ((() => { calls++; throw new Error("must_not_call"); }) as unknown as typeof fetch);
  try {
    const { record, root } = await runLoadDrill({ ...drillConfig });
    roots.push(root);
    expect(record.schema).toBe("jit.ops.drill/v1");
    expect(record.legs.map(l => l.leg)).toEqual(["groups", "pr-snapshots", "memory-queries", "deliveries", "schedules", "cancel", "disk-watermark", "quarantine", "export"]);
    expect(record.legs.find(l => l.leg === "pr-snapshots")!.state).toBe("scripted");
    expect(record.legs.find(l => l.leg === "quarantine")).toMatchObject({ state: "blocked" });
    expect(record.legs.find(l => l.leg === "export")!.state).toBe("not-run");
    expect(record.measurements).toMatchObject({ fetchCalls: 0, sentDeliveries: 1, unknownDeliveries: 1, failedDeliveries: 2, succeededJobs: 3, waitingJobs: 1, cancelledJobs: 1 });
    expect(record.measurements.stopAckMs).not.toBeNull();
    expect(record.measurements.peakRssBytes).toBeGreaterThan(0);
    expect(record.fixtureHonesty.join("\n")).toMatch(/#24.*#33.*#31/s);
    expect(record.outcome).toBe("blocked");
    expect(record.nextAction).toBe("resolve-blocked-work");
    expect(calls).toBe(0);
    validateDrillRecord(record);
    expect(JSON.stringify(record)).not.toMatch(/TOKEN_SENTINEL|Authorization|Bearer|192\.0\.2/);
  } finally { globalThis.fetch = network; }
});

test("tiny disk watermark and expired authority produce honest blocked results with safe next actions", async () => {
  const tiny = await runLoadDrill({ ...drillConfig, diskWatermarkBytes: 4096 });
  roots.push(tiny.root);
  expect(tiny.record.legs.find(l => l.leg === "disk-watermark")!.state).toBe("blocked");
  expect(tiny.record.measurements.diskPressure).toBe(true);
  expect(tiny.record.outcome).toBe("blocked");
  expect(tiny.record.nextAction).toBe("relieve-disk-pressure");
});

test("release checklist links human gates by evidence ID only and never auto-passes them", () => {
  const human = { FEAS: { state: "blocked" as const, evidenceId: id, note: "service identity inventory recorded" } };
  const deterministic = { J01: { state: "passed" as const, evidenceId: id, note: "job admission evidence" },
    crash: { state: "passed" as const, evidenceId: id, note: "crash recovery evidence" },
    trust: { state: "blocked" as const, evidenceId: null, note: "trust gate awaiting review" } };
  const checklist = composeReleaseChecklist({ installationLabel: "drill-fixture", drillId: id, deterministic, human });
  expect(checklist.deterministic.find(i => i.id === "J01")).toMatchObject({ state: "passed", evidenceId: id });
  expect(checklist.deterministic.find(i => i.id === "J02")).toMatchObject({ state: "not-run", evidenceId: null });
  expect(checklist.human.find(i => i.id === "FEAS")).toMatchObject({ state: "blocked", evidenceId: id });
  expect(checklist.human.find(i => i.id === "OPS")).toMatchObject({ state: "not-run", evidenceId: null });
  expect(checklist.outcome).toBe("blocked");
  expect(() => composeReleaseChecklist({ installationLabel: "drill-fixture", drillId: null,
    deterministic: {}, human: { FEAS: { state: "passed", evidenceId: null, note: "claimed without evidence" } } })).toThrow();
  expect(() => composeReleaseChecklist({ installationLabel: "drill-fixture", drillId: null,
    deterministic: {}, human: { OPS: { state: "passed", evidenceId: id, note: "Authorization: Bearer TOKEN_SENTINEL" } } })).toThrow();
  expect(() => composeReleaseChecklist({ installationLabel: "drill-fixture", drillId: "not-a-uuid",
    deterministic: {}, human: {} })).toThrow();
});

test("composed profile carries versions, limits and sample bounds but never Pi readiness", async () => {
  const { record, root } = await runLoadDrill({ ...drillConfig });
  roots.push(root);
  const profile = composeProfile({ installationLabel: record.installationLabel, drill: record,
    exhaustedLimits: ["quarantine"], sampleLimitations: [...record.fixtureHonesty], nextAction: record.nextAction });
  expect(profile).toMatchObject({ schema: "jit.ops.profile/v1", drillId: record.id, piReadiness: "not-claimed" });
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
  writeFileSync(join(root, ".local/checklist.json"), JSON.stringify({ deterministic: {}, human: {} }));
  const reported = await run(["report", "--id", summary.recordId, "--checklist", ".local/checklist.json"]);
  expect(reported.exit).toBe(0);
  expect(JSON.parse(reported.stdout).checklist.outcome).toBe("blocked");
  for (const args of [["diagnose", "--extra"], ["drill"], ["drill", "--config", ".local/missing.json"], ["report", "--id", summary.recordId], ["inventory", "--config", "x"], ["drill", "--config", ".local/drill.json", "--label", "bad label!"]]) {
    expect((await run(args)).exit).toBe(2);
  }
  writeFileSync(join(root, ".local/drill.json"), JSON.stringify({ ...drillConfig, groups: 0 }));
  expect((await run(["drill", "--config", ".local/drill.json"])).exit).toBe(2);
  const diagnosed = await run(["diagnose"]);
  expect(diagnosed.exit).toBe(0);
  expect(JSON.parse(diagnosed.stdout)).toMatchObject({ schema: "jit.ops.diagnostics/v1", nextAction: "configure-telegram" });
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
