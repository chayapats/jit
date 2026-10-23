import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../application";
import { readConfig } from "../config";
import type { AppConfig } from "../config";
import { ScriptedTelegramSender } from "../delivery/sender";
import { JobQueue } from "../jobs/queue";
import { scheduleReminderWork, tickSchedules } from "../jobs/schedules";
import type { JobLimits, WorkDefinition } from "../jobs/types";
import { TransactionStore } from "../store";
import manifest from "../../package.json";
import { safeOpsAlias, type DrillAction, type DrillLeg, type DrillMeasurements, type LoadDrillConfig, type LoadDrillRecord } from "./contracts";

/** Injectable seams for deterministic tests. Production runs use real time and disposable state. */
export interface DrillPorts {
  /** Fake application clock. Real wall time still measures durations and deadlines. */
  now?: () => number;
  /** Existing empty directory to use instead of creating disposable state. */
  root?: string;
  installationLabel?: string;
  /** Keep disposable state for inspection instead of removing it. */
  keepRoot?: boolean;
}

export interface DrillResult {
  record: LoadDrillRecord;
  /** Disposable state directory; removed unless keepRoot was set. */
  root: string;
}

const jobLimits: JobLimits = { roles: 4, calls: 8, rounds: 8, hops: 8, contextTokens: 4000, outputTokens: 4000, retries: 2, wallMs: 60000 };

function fixtureWork(id: string, title: string, evidence: string): WorkDefinition {
  return { id, title, revision: 1, replay: "read",
    route: { provider: "fixture", model: "scripted", authRoute: "internal" },
    cost: { roles: 1, calls: 1, rounds: 1, hops: 1 },
    validate: () => true,
    run: () => ({ state: "succeeded", evidence }) };
}

/** Sums managed-state bytes without following symlinks or reading file contents. */
function dirBytes(path: string): number {
  let total = 0, entries = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++entries > 100000) throw new Error("drill_state_too_large");
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  try { walk(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return total;
}

function rss(): number {
  return process.memoryUsage().rss;
}

/**
 * Runs the bounded fixture load drill. All workload adapters are scripted:
 * no fetch, no sockets, no live inference and no paid APIs. The global fetch
 * is replaced with a throwing stub for the duration so any network escape fails
 * loudly instead of silently leaving the fixture boundary.
 */
export async function runLoadDrill(config: LoadDrillConfig, ports: DrillPorts = {}): Promise<DrillResult> {
  const startMs = Date.now();
  let fakeNow = 1800000000000;
  const now = ports.now ?? (() => fakeNow);
  const advance = (ms: number): void => { fakeNow += ms; };
  const label = safeOpsAlias(ports.installationLabel ?? "drill-fixture");
  const created = !ports.root;
  const root = ports.root ?? mkdtempSync(join(tmpdir(), "jit-ops-drill-"));
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => { fetchCalls++; throw new Error("network_not_authorized"); }) as unknown as typeof fetch;

  const legs: DrillLeg[] = [];
  let peakRss = rss();
  const sample = (): void => { peakRss = Math.max(peakRss, rss()); };
  const deadlineExceeded = (): boolean => Date.now() - startMs > config.deadlineMs;
  const timed = async <T>(leg: string, sampleLimit: string, run: () => Promise<{ state: DrillLeg["state"]; detail: string }>): Promise<void> => {
    if (deadlineExceeded()) {
      legs.push({ leg, state: "not-run", elapsedMs: 0, detail: "skipped: drill deadline exceeded", sampleLimit });
      return;
    }
    const t0 = Date.now();
    try {
      const result = await run();
      legs.push({ leg, state: result.state, elapsedMs: Date.now() - t0, detail: result.detail, sampleLimit });
    } catch (error) {
      legs.push({ leg, state: "failed", elapsedMs: Date.now() - t0, detail: "leg raised instead of returning bounded evidence", sampleLimit });
    }
    sample();
  };

  let queue: JobQueue | undefined;
  let store: TransactionStore | undefined;
  const stateDir = join(root, "state");
  const stateBytesBefore = dirBytes(root);
  let queueWaitMs = 0, stopAckMs: number | null = null;
  let sent = 0, unknown = 0, failed = 0, succeededJobs = 0, waitingJobs = 0, cancelledJobs = 0;

  try {
    const appConfig: AppConfig = readConfig({ JIT_DATABASE: join(stateDir, "app.sqlite") });
    store = new TransactionStore(appConfig.databasePath);
    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    let gatedStarted = false;
    queue = new JobQueue(store, appConfig.jobs, [
      fixtureWork("drill.pr-snapshot", "PR snapshot fixture", "pr-snapshot fixture evidence"),
      { ...fixtureWork("drill.quota-probe", "Quota probe fixture", "quota probe fixture evidence"),
        run: () => ({ state: "waiting", reason: "quota" as const }) },
      { ...fixtureWork("drill.gated", "Gated stop fixture", "gated fixture evidence"),
        run: async () => { gatedStarted = true; await gate; return { state: "succeeded", evidence: "gated fixture evidence" }; } },
      scheduleReminderWork(store, appConfig, now),
    ], { now });
    const app = new Application(store, appConfig, { jobs: queue, now });
    await app.setupOwner("drill-fixture-owner-password");
    const actor = app.authenticate(await app.login("drill-fixture-owner-password")).actor;
    const revisionOf = (projectId: string): number => app.jobs(actor, projectId).project.revision;

    const projectIds: string[] = [];
    const topicIds: string[] = [];
    await timed("groups", "Topics stand in for groups; one project carries one stable group.", async () => {
      for (let n = 0; n < config.groups; n++) {
        const project = app.execute(actor, { kind: "project.create", requestId: crypto.randomUUID(),
          projectId: null, expectedRevision: app.workspace(actor).revision, payload: { name: `Drill group ${n + 1}` } }).project;
        projectIds.push(project.id);
        const topic = app.execute(actor, { kind: "topic.create", requestId: crypto.randomUUID(),
          projectId: project.id, expectedRevision: revisionOf(project.id), payload: { title: `Drill topic ${n + 1}` } }).topic;
        topicIds.push(topic.id);
        advance(1000);
      }
      return { state: "passed", detail: `groups=${projectIds.length} topics=${topicIds.length}` };
    });

    await timed("pr-snapshots", "Static snapshot path unavailable until #24; scripted jobs only.", async () => {
      const t0 = Date.now();
      const ids: { projectId: string; id: string }[] = [];
      for (let n = 0; n < config.prSnapshots; n++) {
        const projectId = projectIds[n % projectIds.length]!;
        const receipt = app.execute(actor, { kind: "job.enqueue", requestId: crypto.randomUUID(), projectId,
          expectedRevision: revisionOf(projectId), payload: { type: "drill.pr-snapshot", configurationRevision: 1,
            policyRevision: appConfig.jobs.revision, purpose: `PR snapshot fixture ${n + 1}`, inputRevision: revisionOf(projectId),
            input: {}, priority: "background", limits: structuredClone(jobLimits) } });
        ids.push({ projectId, id: receipt.job.id });
      }
      queue!.pump();
      for (let n = 0; n < 8; n++) { queue!.pump(); await queue!.idle(); }
      queueWaitMs = Date.now() - t0;
      advance(1000);
      succeededJobs = ids.filter(({ projectId, id }) => app.job(actor, projectId, id).state === "succeeded").length;
      const quota = app.execute(actor, { kind: "job.enqueue", requestId: crypto.randomUUID(), projectId: projectIds[0]!,
        expectedRevision: revisionOf(projectIds[0]!), payload: { type: "drill.quota-probe", configurationRevision: 1,
          policyRevision: appConfig.jobs.revision, purpose: "Quota wait fixture", inputRevision: revisionOf(projectIds[0]!),
          input: {}, priority: "background", limits: structuredClone(jobLimits) } });
      queue!.pump();
      await queue!.idle();
      if (app.job(actor, projectIds[0]!, quota.job.id).state === "waiting") waitingJobs = 1;
      return succeededJobs === config.prSnapshots && waitingJobs === 1
        ? { state: "scripted", detail: `succeeded=${succeededJobs} waiting=${waitingJobs}` }
        : { state: "failed", detail: `succeeded=${succeededJobs} waiting=${waitingJobs}` };
    });

    await timed("memory-queries", "Reads committed claims only; empty stores answer without inference.", async () => {
      let claims = 0;
      for (let n = 0; n < config.memoryQueries; n++) {
        const found = app.memory(actor, projectIds[n % projectIds.length]!, 0, 0, 0, "");
        claims += (found as { claims?: unknown[] }).claims?.length ?? 0;
        advance(10);
      }
      return { state: "passed", detail: `queries=${config.memoryQueries} claims=${claims}` };
    });

    await timed("deliveries", "Fixture send classifications; no Bot API traffic and no exactly-once claim.", async () => {
      const modes = ["accept", "timeout_after_accept", "safe_failure", "reject"] as const;
      const sender = new ScriptedTelegramSender();
      sender.scripts = Array.from({ length: Math.max(config.deliveries, 1) }, (_, n) => modes[n % modes.length]!);
      for (let n = 0; n < config.deliveries; n++) {
        const projectId = projectIds[n % projectIds.length]!;
        const key = `drill/delivery-${String(n + 1).padStart(4, "0")}`;
        app.execute(actor, { kind: "delivery.commit", requestId: crypto.randomUUID(), projectId,
          expectedRevision: revisionOf(projectId), payload: { kind: "report", text: `Drill delivery ${n + 1}`, dedupeKey: key } });
        const result = sender.send({ chatId: 1, text: `Drill delivery ${n + 1}`, dedupeKey: key });
        if (result.outcome === "sent") sent++;
        else if (result.outcome === "unknown") unknown++;
        else failed++;
        advance(100);
      }
      return { state: "passed", detail: `sent=${sent} unknown=${unknown} failed=${failed}` };
    });

    await timed("schedules", "Reminder occurrences ticked with an explicit clock, not host time.", async () => {
      const at = now() + 60000;
      for (let n = 0; n < config.schedules; n++) {
        app.execute(actor, { kind: "schedule.create", requestId: crypto.randomUUID(), projectId: projectIds[0]!,
          expectedRevision: revisionOf(projectIds[0]!), payload: { topicId: topicIds[0]!, kind: "reminder", purpose: `Drill reminder ${n + 1}`,
            timezone: "UTC", recurrence: { kind: "once", at }, enabled: true, route: null,
            limits: structuredClone(jobLimits), occurrenceBudget: 2, misfire: "coalesce", text: `Drill reminder ${n + 1}` } });
      }
      const ticked = tickSchedules(store!, queue!, appConfig, at + 1000);
      for (let n = 0; n < 4; n++) { queue!.pump(); await queue!.idle(); }
      advance(60000);
      const enqueued = ticked.filter(t => t.action === "enqueued").length;
      return enqueued === config.schedules
        ? { state: "passed", detail: `schedules=${config.schedules} enqueued=${enqueued}` }
        : { state: "failed", detail: `schedules=${config.schedules} enqueued=${enqueued}` };
    });

    await timed("cancel", "Bounded cooperative stop; late results cannot publish after the fence.", async () => {
      const projectId = projectIds[0]!;
      const receipt = app.execute(actor, { kind: "job.enqueue", requestId: crypto.randomUUID(), projectId,
        expectedRevision: revisionOf(projectId), payload: { type: "drill.gated", configurationRevision: 1,
          policyRevision: appConfig.jobs.revision, purpose: "Gated stop fixture", inputRevision: revisionOf(projectId),
          input: {}, priority: "interactive", limits: structuredClone(jobLimits) } });
      queue!.pump();
      for (let n = 0; n < 100 && !gatedStarted; n++) await Bun.sleep(1);
      const t0 = Date.now();
      const current = app.job(actor, projectId, receipt.job.id);
      const stop = app.execute(actor, { kind: "job.stop", requestId: crypto.randomUUID(), projectId,
        expectedRevision: current.revision, payload: { jobId: receipt.job.id } });
      stopAckMs = Date.now() - t0;
      releaseGate();
      await queue!.idle();
      const settled = app.job(actor, projectId, receipt.job.id);
      if (settled.state === "blocked" && settled.reason === "cancelled" && stop.stop) cancelledJobs = 1;
      return cancelledJobs === 1
        ? { state: "passed", detail: `cancelled=${cancelledJobs} stopAckMs=${stopAckMs}` }
        : { state: "failed", detail: `state=${settled.state} reason=${settled.reason}` };
    });

    await timed("disk-watermark", "Managed-state growth only; host disks outside state are out of scope.", async () => {
      const after = dirBytes(stateDir);
      const growth = Math.max(0, after - stateBytesBefore);
      const pressure = growth > config.diskWatermarkBytes;
      return { state: pressure ? "blocked" : "passed",
        detail: `growthBytes=${growth} watermarkBytes=${config.diskWatermarkBytes}` };
    });

    legs.push({ leg: "quarantine", state: "blocked", elapsedMs: 0,
      detail: "restore stays quarantined; ops.quarantined_restore/v1 unavailable until #33",
      sampleLimit: "No restore executed; quarantine path is a recorded gate, not an observation." });
    legs.push({ leg: "export", state: "not-run", elapsedMs: 0,
      detail: "project export not exercised; ops.project_export/v1 unavailable until #31",
      sampleLimit: "No export artifact produced; pilot handoff cannot rely on this drill." });

    const stateBytesAfter = dirBytes(stateDir);
    const stateGrowthBytes = Math.max(0, stateBytesAfter - stateBytesBefore);
    const diskPressure = stateGrowthBytes > config.diskWatermarkBytes;
    const failedLegs = legs.filter(l => l.state === "failed").length;
    const blockedLegs = legs.filter(l => l.state === "blocked").length;
    const outcome = failedLegs > 0 ? "failed" : blockedLegs > 0 ? "blocked" : "passed";
    const nextAction: DrillAction = diskPressure ? "relieve-disk-pressure"
      : failedLegs > 0 ? "inspect-sanitized-drill"
      : blockedLegs > 0 ? "resolve-blocked-work" : "none";
    const measurements: DrillMeasurements = { peakRssBytes: peakRss, stateBytesBefore,
      stateBytesAfter, stateGrowthBytes, diskPressure, queueWaitMs, stopAckMs, fetchCalls,
      sentDeliveries: sent, unknownDeliveries: unknown, failedDeliveries: failed,
      succeededJobs, waitingJobs, cancelledJobs };
    const record: LoadDrillRecord = { schema: "jit.ops.drill/v1", id: crypto.randomUUID(),
      observedAt: new Date(Date.now()).toISOString(), installationLabel: label,
      versions: { app: manifest.version, bun: typeof Bun !== "undefined" ? Bun.version : null,
        schema: store!.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!).user_version },
      config: { ...config }, legs, measurements,
      fixtureHonesty: [
        "PR snapshot jobs are scripted fixtures; the static review path lands in #24.",
        "Delivery outcomes classify a scripted sender; no Bot API evidence is claimed.",
        "Quarantine and export legs record gates for #33 and #31; nothing was restored or published.",
        "Desktop fixture timing is not a latency SLO and not Pi capacity evidence.",
      ],
      outcome, nextAction };
    return { record, root };
  } finally {
    globalThis.fetch = realFetch;
    try { await queue?.idle(); } catch { /* Disposable teardown; the record already carries leg states. */ }
    try { queue?.close(); } catch { /* See above. */ }
    try { store?.close(); } catch { /* See above. */ }
    if (created && !ports.keepRoot) rmSync(root, { recursive: true, force: true });
  }
}
