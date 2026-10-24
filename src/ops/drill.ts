import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, type OwnerActor } from "../application";
import { readConfig } from "../config";
import type { AppConfig } from "../config";
import { ScriptedTelegramSender } from "../delivery/sender";
import { JobQueue } from "../jobs/queue";
import { scheduleReminderWork, tickSchedules } from "../jobs/schedules";
import type { JobLimits, WorkDefinition } from "../jobs/types";
import { FakeGitHubFixture, TrustedGitHubConnector, fixturePull } from "../pr/github";
import { ensurePrSchema } from "../pr/schema";
import { mutateMonitor } from "../pr/authority";
import { pollMonitorCatchUp, readCandidates } from "../pr/poll";
import { prReviewWork } from "../pr/review";
import { prSnapshotWork } from "../pr/work";
import type { EnableMonitorCommand, PrMonitor } from "../pr/types";
import { containsCredential } from "../security/credentials";
import { TransactionStore } from "../store";
import { ScriptedRunPort, fixtureOutcome } from "../team/scripted-port";
import type { BackupNativePort } from "./backup";
import { safeNote, safeOpsAlias, type DrillAction, type DrillLeg, type DrillLegState, type DrillMeasurements,
  type LoadDrillConfig, type LoadDrillRecord } from "./contracts";
import { testedRevisions } from "./revisions";
import { upgradeEngineContract, upgradeNativeFormatVersion } from "./upgrade";

/** What a quarantine/restore leg receives: the drilled Application, its owner actor and the verified backup. */
export interface DrillRestoreContext {
  app: Application;
  actor: OwnerActor;
  /** Verified managed backup created by the `backup` leg. */
  backupId: string;
  now: () => number;
}

/** Bounded leg result. `detail` must be fixed-vocabulary text; it passes `safeNote`. */
export interface DrillLegResult { state: DrillLegState; detail: string }

/**
 * Seam for the quarantined-restore leg (`ops.quarantined_restore/v1`, OPS02 #33).
 * The integration base does not yet carry the accepted restore flow, so the
 * default drill records the leg as `blocked: pending OPS02 (#33)` after proving a
 * verified backup exists. Integrating OPS02 means supplying this port: prepare →
 * migrate → apply_ledger → validate in quarantine, then discard (the drill never
 * activates a restore over its own state).
 */
export type DrillRestorePort = (context: DrillRestoreContext) => Promise<DrillLegResult>;

/** Injectable seams for deterministic tests. Production runs use real time and disposable state. */
export interface DrillPorts {
  /** Fake application clock. Real wall time still measures durations and deadlines. */
  now?: () => number;
  /** Existing empty directory to use instead of creating disposable state. */
  root?: string;
  installationLabel?: string;
  /** Keep disposable state for inspection instead of removing it. */
  keepRoot?: boolean;
  /**
   * Native snapshot port for the backup and upgrade-preflight legs. Default: a
   * scripted fixture declaring the supported snapshot contract with an empty
   * native set (the scripted run port creates no native sessions). Inject
   * `unavailableNativePort` to drill the engine-unavailable path.
   */
  nativeSnapshot?: BackupNativePort;
  /** Quarantined-restore leg; absent means pending OPS02 (#33). */
  restore?: DrillRestorePort;
  /** Owner cancellation: legs not yet started are recorded `not-run`, never skipped silently. */
  signal?: AbortSignal;
}

export interface DrillResult {
  record: LoadDrillRecord;
  /** Disposable state directory; removed unless keepRoot was set. */
  root: string;
}

const jobLimits: JobLimits = { roles: 4, calls: 8, rounds: 8, hops: 8, contextTokens: 4000, outputTokens: 4000, retries: 2, wallMs: 60000 };
const reviewLimits: JobLimits = { roles: 4, calls: 16, rounds: 16, hops: 16, contextTokens: 64000, outputTokens: 16000, retries: 2, wallMs: 60000 };
/** Admission wave size; stays under the default queue limit so the drill never relies on raised ceilings. */
const wave = 8;
/** Bounded drain: pump/idle rounds per wave. */
const drainRounds = 16;

/** Scripted static-review output: one evidenced correctness finding (alertable) and one style finding (held). */
const reviewJson = JSON.stringify({
  findings: [
    { id: "finding-1", title: "unchecked access in a.ts", category: "correctness", severity: "high",
      location: { path: "a.ts", line: 10 }, condition: "when input is empty", impact: "crash",
      reasoning: "line 10 dereferences without a guard", evidenceType: "diff", evidenceRef: "a.ts" },
    { id: "finding-2", title: "style nit", category: "style", severity: "low",
      location: { path: "a.ts", line: 1 }, condition: "c", impact: "i", reasoning: "r", evidenceType: "diff", evidenceRef: "a.ts" },
  ],
  analyzedRoles: ["correctness", "security"], skippedScope: [], disagreements: [],
});

/** The default engine fixture: declares the supported snapshot contract, captures nothing. */
const fixtureNativePort: BackupNativePort = {
  engine: "drill-fixture-engine", contract: upgradeEngineContract, formatVersion: upgradeNativeFormatVersion,
  available: () => true,
  snapshot: () => ({ refs: [], bytes: 0, engine: "drill-fixture-engine", contract: upgradeEngineContract,
    formatVersion: upgradeNativeFormatVersion, artifacts: [] }),
};

const sha = (n: number): string => n.toString(16).padStart(40, "0");
const reasonCode = (value: unknown): string => typeof value === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : "unrecognized_reason";

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
 * Runs the bounded fixture load drill against disposable state. Every adapter
 * is scripted: PR reads come from an in-memory GitHub fixture, specialist and
 * synthesis runs from the scripted run port, deliveries from a scripted sender,
 * native snapshots from a fixture engine. No fetch, no sockets, no live
 * inference and no paid APIs. Global fetch is replaced with a throwing stub for
 * the duration so any network escape fails loudly. Every leg state is derived
 * from what actually executed; gates that cannot execute are recorded with the
 * blocking contract, never skipped.
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
  const timed = async (leg: string, sampleLimit: string, run: () => Promise<DrillLegResult>): Promise<void> => {
    if (ports.signal?.aborted) {
      legs.push({ leg, state: "not-run", elapsedMs: 0, detail: "skipped: drill cancelled by owner", sampleLimit });
      return;
    }
    if (deadlineExceeded()) {
      legs.push({ leg, state: "not-run", elapsedMs: 0, detail: "skipped: drill deadline exceeded", sampleLimit });
      return;
    }
    const t0 = Date.now();
    let result: DrillLegResult;
    try {
      result = await run();
      if (!["passed", "failed", "blocked", "not-run", "scripted"].includes(result.state)) throw new Error("invalid_leg_state");
      result = { state: result.state, detail: safeNote(result.detail) };
    } catch {
      result = { state: "failed", detail: "leg raised instead of returning bounded evidence" };
    }
    legs.push({ leg, state: result.state, elapsedMs: Math.min(Date.now() - t0, 3600000), detail: result.detail, sampleLimit });
    sample();
  };

  let queue: JobQueue | undefined;
  let store: TransactionStore | undefined;
  const stateDir = join(root, "state");
  const stateBytesBefore = dirBytes(root);
  let queueWaitMs = 0, stopAckMs: number | null = null;
  let sent = 0, unknown = 0, failed = 0, succeededJobs = 0, waitingJobs = 0, cancelledJobs = 0;
  let prReports = 0, alertIntents = 0, exportBytes = 0, backupBytes = 0;
  let commandAckMaxMs = 0, requestMaxMs = 0, commands = 0;
  let verifiedBackupId: string | null = null;
  const native = ports.nativeSnapshot ?? fixtureNativePort;
  const fixtureEngine = native === fixtureNativePort;

  try {
    const appConfig: AppConfig = readConfig({ JIT_DATABASE: join(stateDir, "app.sqlite"),
      JIT_TELEGRAM_BOT_TOKEN_PATH: join(stateDir, "telegram-bot.token") });
    store = new TransactionStore(appConfig.databasePath);
    const liveStore = store;
    let releaseGate!: () => void;
    const gate = new Promise<void>(resolve => { releaseGate = resolve; });
    let gatedStarted = false;
    const fixtures = new Map<string, FakeGitHubFixture>();
    const fixtureFor = (monitor: PrMonitor): FakeGitHubFixture => {
      const existing = fixtures.get(monitor.id);
      if (existing) return existing;
      const fresh = new FakeGitHubFixture();
      fixtures.set(monitor.id, fresh);
      return fresh;
    };
    const reviewPort = new ScriptedRunPort(store, appConfig.team, appConfig.jobs.outputBytes, () => ({
      ...fixtureOutcome("complete", reviewJson),
      usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 10, outputTokens: 100, retries: 0, wallMs: 10, tokensUnknown: false },
      session: null,
    }));
    const cacheRoot = join(stateDir, "pr-cache");
    queue = new JobQueue(store, appConfig.jobs, [
      prSnapshotWork({ store, cacheRoot, fixtureFor }),
      prReviewWork({ store, port: reviewPort, now, sourceLimit: appConfig.team.sourceLimit, contextBytes: appConfig.team.contextBytes,
        outputBytes: appConfig.jobs.outputBytes, alertBytes: appConfig.messageBytes }),
      { ...fixtureWork("drill.quota-probe", "Quota probe fixture", "quota probe fixture evidence"),
        run: () => ({ state: "waiting", reason: "quota" as const }) },
      { ...fixtureWork("drill.gated", "Gated stop fixture", "gated fixture evidence"),
        run: async () => { gatedStarted = true; await gate; return { state: "succeeded", evidence: "gated fixture evidence" }; } },
      scheduleReminderWork(store, appConfig, now),
    ], { now });
    const jobs = queue;
    const app = new Application(store, appConfig, { jobs, now, nativeSnapshot: native,
      backupDir: join(stateDir, "backups"), restoreDir: join(stateDir, "restores"), upgradeDir: join(stateDir, "upgrades") });
    await app.setupOwner("drill-fixture-owner-password");
    const actor = app.authenticate(await app.login("drill-fixture-owner-password")).actor;
    /** Owner command through the Application boundary; acknowledgment = receipt returned. */
    const command = <T>(run: () => T): T => {
      const t0 = Date.now();
      try { return run(); } finally { commands++; commandAckMaxMs = Math.max(commandAckMaxMs, Date.now() - t0); }
    };
    const commandAsync = async <T>(run: () => Promise<T>): Promise<T> => {
      const t0 = Date.now();
      try { return await run(); } finally { commands++; commandAckMaxMs = Math.max(commandAckMaxMs, Date.now() - t0); }
    };
    /** Read request through the Application boundary. */
    const request = <T>(run: () => T): T => {
      const t0 = Date.now();
      try { return run(); } finally { requestMaxMs = Math.max(requestMaxMs, Date.now() - t0); }
    };
    const revisionOf = (projectId: string): number => request(() => app.jobs(actor, projectId).project.revision);
    const drain = async (): Promise<void> => {
      for (let n = 0; n < drainRounds; n++) {
        jobs.pump();
        await jobs.idle();
        const pending = liveStore.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'admitted')")!.n);
        if (pending === 0) return;
      }
    };
    const enqueue = (projectId: string, type: string, purpose: string, input: Record<string, string>, limits: JobLimits,
      priority: "background" | "interactive" = "background") => command(() => app.execute(actor, {
      kind: "job.enqueue", requestId: crypto.randomUUID(), projectId, expectedRevision: revisionOf(projectId),
      payload: { type, configurationRevision: 1, policyRevision: appConfig.jobs.revision, purpose, inputRevision: revisionOf(projectId),
        input, priority, limits: structuredClone(limits) } }));

    const projectIds: string[] = [];
    const topicIds: string[] = [];
    await timed("groups", "Topics stand in for groups; one project carries one stable group.", async () => {
      for (let n = 0; n < config.groups; n++) {
        const project = command(() => app.execute(actor, { kind: "project.create", requestId: crypto.randomUUID(),
          projectId: null, expectedRevision: app.workspace(actor).revision, payload: { name: `Drill group ${n + 1}` } })).project;
        projectIds.push(project.id);
        const topic = command(() => app.execute(actor, { kind: "topic.create", requestId: crypto.randomUUID(),
          projectId: project.id, expectedRevision: revisionOf(project.id), payload: { title: `Drill topic ${n + 1}` } })).topic;
        topicIds.push(topic.id);
        advance(1000);
      }
      return { state: projectIds.length === config.groups ? "passed" : "failed", detail: `groups=${projectIds.length} topics=${topicIds.length}` };
    });

    // Static PR path: one monitor per group over an in-memory GitHub fixture, durable candidates from a poll,
    // then owner-enqueued pr.snapshot jobs. GitHub is read-only and never reached over the network.
    const candidates: { projectId: string; monitorId: string; candidateId: string }[] = [];
    await timed("pr-snapshots", "In-memory GitHub fixture; immutable snapshot capture only, no GitHub writes.", async () => {
      if (projectIds.length === 0) return { state: "not-run", detail: "no groups to monitor" };
      const t0 = Date.now();
      for (let g = 0; g < projectIds.length; g++) {
        const projectId = projectIds[g]!;
        const count = Math.floor(config.prSnapshots / projectIds.length) + (g < config.prSnapshots % projectIds.length ? 1 : 0);
        if (count === 0) continue;
        const enable: EnableMonitorCommand = { kind: "pr.monitor.enable", requestId: crypto.randomUUID(), projectId,
          expectedRevision: revisionOf(projectId),
          payload: { repository: { host: "github.com", owner: "drill-fixture", name: `widgets-${g + 1}` },
            apiBase: "https://api.github.com", allowed: { issues: true, specs: true, ci: true }, acceptPolicyVersion: 1 } };
        const monitor = command(() => liveStore.transaction(tx => { ensurePrSchema(tx); return mutateMonitor(tx, enable, now()).monitor; }));
        const github = fixtureFor(monitor);
        for (let n = 0; n < count; n++) {
          const base = sha(1000 * (g + 1) + 2 * n + 1), head = sha(1000 * (g + 1) + 2 * n + 2);
          github.pulls.push(fixturePull({ number: n + 1, base: { sha: base, ref: "main" }, head: { sha: head, ref: `feat-${n + 1}` } }));
          github.files.set(github.key(n + 1, base, head), [{ filename: "a.ts", status: "modified", patch: "@@ -1,1 +1,40 @@\n+a" }]);
          github.checks.set(head, []);
        }
        const connector = new TrustedGitHubConnector(github, monitor, cacheRoot);
        liveStore.transaction(tx => pollMonitorCatchUp(tx, projectId, monitor.id, connector, now()));
        for (const candidate of liveStore.read(tx => readCandidates(tx, projectId, monitor.id)).slice(0, count)) {
          candidates.push({ projectId, monitorId: monitor.id, candidateId: candidate.id });
        }
      }
      let snapshots = 0;
      for (let start = 0; start < candidates.length; start += wave) {
        const ids = candidates.slice(start, start + wave).map(c => ({ projectId: c.projectId,
          id: enqueue(c.projectId, "pr.snapshot", "Drill PR snapshot", { monitorId: c.monitorId, candidateId: c.candidateId }, jobLimits).job.id }));
        await drain();
        snapshots += ids.filter(({ projectId, id }) => request(() => app.job(actor, projectId, id)).state === "succeeded").length;
      }
      queueWaitMs = Date.now() - t0;
      succeededJobs += snapshots;
      advance(1000);
      return snapshots === config.prSnapshots && candidates.length === config.prSnapshots
        ? { state: "passed", detail: `candidates=${candidates.length} snapshots=${snapshots}` }
        : { state: "failed", detail: `candidates=${candidates.length} snapshots=${snapshots} expected=${config.prSnapshots}` };
    });

    await timed("pr-alerts", "Scripted specialist/synthesis runs; alert intents wait for a Telegram binding, none are sent.", async () => {
      if (candidates.length === 0) return { state: "not-run", detail: "no captured PR snapshots to review" };
      let reviews = 0;
      for (let start = 0; start < candidates.length; start += wave) {
        const ids = candidates.slice(start, start + wave).map(c => ({ projectId: c.projectId,
          id: enqueue(c.projectId, "pr.review", "Drill PR review", { monitorId: c.monitorId, candidateId: c.candidateId }, reviewLimits).job.id }));
        await drain();
        reviews += ids.filter(({ projectId, id }) => request(() => app.job(actor, projectId, id)).state === "succeeded").length;
      }
      succeededJobs += reviews;
      const counts = liveStore.read(tx => ({
        reports: tx.get<{ n: number }>("SELECT count(*) AS n FROM pr_reports")!.n,
        alerts: tx.get<{ n: number }>("SELECT count(*) AS n FROM pr_alerts")!.n,
        intents: tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents WHERE id IN (SELECT intent_id FROM pr_alerts)")!.n,
      }));
      prReports = counts.reports;
      alertIntents = counts.intents;
      advance(1000);
      // Exactly one evidenced finding per report is alertable; the style finding stays held in the report.
      return reviews === candidates.length && prReports === candidates.length && counts.alerts === candidates.length && alertIntents === candidates.length
        ? { state: "passed", detail: `reviews=${reviews} reports=${prReports} alertIntents=${alertIntents}` }
        : { state: "failed", detail: `reviews=${reviews} reports=${prReports} alerts=${counts.alerts} alertIntents=${alertIntents}` };
    });

    await timed("memory-queries", "Reads committed claims only; empty stores answer without inference.", async () => {
      if (projectIds.length === 0) return { state: "not-run", detail: "no groups to query" };
      let claims = 0;
      for (let n = 0; n < config.memoryQueries; n++) {
        const found = request(() => app.memory(actor, projectIds[n % projectIds.length]!, 0, 0, 0, ""));
        claims += (found as { claims?: unknown[] }).claims?.length ?? 0;
        advance(10);
      }
      return { state: "passed", detail: `queries=${config.memoryQueries} claims=${claims}` };
    });

    await timed("deliveries", "Fixture send classifications; no Bot API traffic and no exactly-once claim.", async () => {
      if (projectIds.length === 0) return { state: "not-run", detail: "no groups to deliver to" };
      const modes = ["accept", "timeout_after_accept", "safe_failure", "reject"] as const;
      const sender = new ScriptedTelegramSender();
      sender.scripts = Array.from({ length: config.deliveries }, (_, n) => modes[n % modes.length]!);
      for (let n = 0; n < config.deliveries; n++) {
        const projectId = projectIds[n % projectIds.length]!;
        const key = `drill/delivery-${String(n + 1).padStart(4, "0")}`;
        command(() => app.execute(actor, { kind: "delivery.commit", requestId: crypto.randomUUID(), projectId,
          expectedRevision: revisionOf(projectId), payload: { kind: "report", text: `Drill delivery ${n + 1}`, dedupeKey: key } }));
        const result = sender.send({ chatId: 1, text: `Drill delivery ${n + 1}`, dedupeKey: key });
        if (result.outcome === "sent") sent++;
        else if (result.outcome === "unknown") unknown++;
        else failed++;
        advance(100);
      }
      return { state: sent + unknown + failed === config.deliveries ? "passed" : "failed", detail: `sent=${sent} unknown=${unknown} failed=${failed}` };
    });

    await timed("schedules", "Reminder occurrences ticked with an explicit clock, not host time.", async () => {
      if (projectIds.length === 0) return { state: "not-run", detail: "no groups to schedule" };
      const at = now() + 60000;
      for (let n = 0; n < config.schedules; n++) {
        command(() => app.execute(actor, { kind: "schedule.create", requestId: crypto.randomUUID(), projectId: projectIds[0]!,
          expectedRevision: revisionOf(projectIds[0]!), payload: { topicId: topicIds[0]!, kind: "reminder", purpose: `Drill reminder ${n + 1}`,
            timezone: "UTC", recurrence: { kind: "once", at }, enabled: true, route: null,
            limits: structuredClone(jobLimits), occurrenceBudget: 2, misfire: "coalesce", text: `Drill reminder ${n + 1}` } }));
      }
      const ticked = tickSchedules(liveStore, jobs, appConfig, at + 1000);
      await drain();
      advance(60000);
      const enqueued = ticked.filter(t => t.action === "enqueued").length;
      return enqueued === config.schedules
        ? { state: "passed", detail: `schedules=${config.schedules} enqueued=${enqueued}` }
        : { state: "failed", detail: `schedules=${config.schedules} enqueued=${enqueued}` };
    });

    await timed("quota-wait", "Scripted quota condition; the job waits on its exact route with no fallback.", async () => {
      if (projectIds.length === 0) return { state: "not-run", detail: "no groups for the quota probe" };
      const quota = enqueue(projectIds[0]!, "drill.quota-probe", "Quota wait fixture", {}, jobLimits);
      await drain();
      const job = request(() => app.job(actor, projectIds[0]!, quota.job.id));
      if (job.state === "waiting" && job.reason === "quota") waitingJobs = 1;
      return waitingJobs === 1
        ? { state: "passed", detail: `waiting=${waitingJobs} reason=quota` }
        : { state: "failed", detail: `state=${job.state} reason=${reasonCode(job.reason)}` };
    });

    await timed("cancel", "Bounded cooperative stop; late results cannot publish after the fence.", async () => {
      if (projectIds.length === 0) return { state: "not-run", detail: "no groups for the stop probe" };
      const projectId = projectIds[0]!;
      const receipt = enqueue(projectId, "drill.gated", "Gated stop fixture", {}, jobLimits, "interactive");
      jobs.pump();
      for (let n = 0; n < 100 && !gatedStarted; n++) await Bun.sleep(1);
      const t0 = Date.now();
      const current = request(() => app.job(actor, projectId, receipt.job.id));
      const stop = command(() => app.execute(actor, { kind: "job.stop", requestId: crypto.randomUUID(), projectId,
        expectedRevision: current.revision, payload: { jobId: receipt.job.id } }));
      stopAckMs = Date.now() - t0;
      releaseGate();
      await jobs.idle();
      const settled = request(() => app.job(actor, projectId, receipt.job.id));
      if (settled.state === "blocked" && settled.reason === "cancelled" && stop.stop) cancelledJobs = 1;
      return cancelledJobs === 1
        ? { state: "passed", detail: `cancelled=${cancelledJobs} stopAckMs=${stopAckMs}` }
        : { state: "failed", detail: `state=${settled.state} reason=${reasonCode(settled.reason)}` };
    });

    await timed("export", "One project export with history; a credential-shaped probe message must be redacted.", async () => {
      if (projectIds.length === 0) return { state: "not-run", detail: "no project to export" };
      const projectId = projectIds[0]!, topicId = topicIds[0]!;
      const topicRevision = request(() => app.conversation(actor, projectId, topicId)).topic.revision;
      // A credential-shaped probe inside the disposable store; the artifact must never carry it.
      command(() => app.execute(actor, { kind: "message.send", requestId: crypto.randomUUID(), projectId, expectedRevision: topicRevision,
        payload: { topicId, text: "drill sanitization probe api_key=DRILLPROBE0000000000" } }));
      const receipt = command(() => app.execute(actor, { kind: "export.create", requestId: crypto.randomUUID(), projectId,
        expectedRevision: revisionOf(projectId), payload: { includeHistory: true, note: "drill export" } }));
      const { manifest, body } = request(() => app.exportArtifact(actor, projectId, receipt.manifest.id));
      const text = new TextDecoder().decode(body);
      const artifact = JSON.parse(text) as { disclosure?: { secrets?: unknown; restorableBackup?: unknown } };
      exportBytes = body.byteLength;
      const sanitized = !text.includes("DRILLPROBE") && !containsCredential(text) && text.includes("payload_hygiene_secret");
      const disclosed = artifact.disclosure?.secrets === "excluded" && artifact.disclosure?.restorableBackup === false;
      const complete = manifest.completeness.complete === true;
      return manifest.state === "valid" && sanitized && disclosed && complete
        ? { state: "passed", detail: `bytes=${exportBytes} complete=${complete} sanitized=${sanitized}` }
        : { state: "failed", detail: `state=${manifest.state} complete=${complete} sanitized=${sanitized} disclosed=${disclosed}` };
    });

    await timed("backup", "Managed backup with a fixture engine and an empty native set; integrity re-verified on read.", async () => {
      const receipt = await commandAsync(() => app.execute(actor, { kind: "backup.create", requestId: crypto.randomUUID(),
        projectId: null, expectedRevision: app.workspace(actor).revision, payload: { note: "drill backup" } }));
      const read = request(() => app.backup(actor, receipt.manifest.id));
      if (read.manifest.state === "valid" && read.integrity.state === "verified") {
        verifiedBackupId = read.manifest.id;
        backupBytes = read.manifest.artifact.bytes;
        return { state: fixtureEngine ? "scripted" : "passed", detail: `state=valid integrity=verified bytes=${backupBytes} nativeRefs=${read.manifest.native.refs.length}` };
      }
      const reason = reasonCode(read.manifest.native.state !== "valid" ? read.manifest.native.reason : read.manifest.reason ?? read.integrity.reason);
      return { state: "blocked", detail: `state=${read.manifest.state} reason=${reason}` };
    });

    await timed("upgrade-preflight", "Read-only preflight: schema plan, fence and declared engine identity; nothing is migrated.", async () => {
      const status = request(() => app.upgradeStatus(actor));
      if (!status.engine.compatible) return { state: "blocked", detail: `schema=${status.currentSchema} engine=${reasonCode(status.engine.reason)}` };
      if (status.fenced || status.active) return { state: "blocked", detail: `schema=${status.currentSchema} fenced=${status.fenced}` };
      if (!status.upgradeAvailable) return { state: "blocked", detail: `schema=${status.currentSchema} target=${status.target} plan=incompatible` };
      return { state: fixtureEngine ? "scripted" : "passed",
        detail: `schema=${status.currentSchema} target=${status.target} engine=compatible fenced=false` };
    });

    await timed("quarantine", "Quarantine is exercised and discarded; the drill never activates a restore over its own state.", async () => {
      if (!verifiedBackupId) return { state: "not-run", detail: "no verified backup to restore into quarantine" };
      if (!ports.restore) return { state: "blocked", detail: "pending OPS02 (#33): verified backup present; ops.quarantined_restore/v1 not in integration base" };
      return ports.restore({ app, actor, backupId: verifiedBackupId, now });
    });

    await timed("network", "Global fetch is a throwing stub for the whole drill; any call is an escape.", async () =>
      fetchCalls === 0 ? { state: "passed", detail: "fetchCalls=0" } : { state: "failed", detail: `fetchCalls=${fetchCalls}` });

    await timed("disk-watermark", "Managed-state growth only; host disks outside state are out of scope.", async () => {
      const after = dirBytes(stateDir);
      const growth = Math.max(0, after - stateBytesBefore);
      const pressure = growth > config.diskWatermarkBytes;
      return { state: pressure ? "blocked" : "passed",
        detail: `growthBytes=${growth} watermarkBytes=${config.diskWatermarkBytes}` };
    });

    const stateBytesAfter = dirBytes(stateDir);
    const stateGrowthBytes = Math.max(0, stateBytesAfter - stateBytesBefore);
    const diskPressure = stateGrowthBytes > config.diskWatermarkBytes;
    const failedLegs = legs.filter(l => l.state === "failed").length;
    const blocked = legs.filter(l => l.state === "blocked");
    const skipped = legs.some(l => l.state === "not-run" && l.detail.startsWith("skipped:"));
    const engineBlocked = blocked.some(l => /native_snapshot_unavailable|engine_unavailable|unsupported_engine/.test(l.detail));
    const pendingOnly = blocked.length > 0 && blocked.every(l => l.detail.startsWith("pending "));
    const outcome = failedLegs > 0 ? "failed" : blocked.length > 0 || skipped ? "blocked" : "passed";
    const nextAction: DrillAction = diskPressure ? "relieve-disk-pressure"
      : failedLegs > 0 ? "inspect-sanitized-drill"
      : engineBlocked ? "restore-engine"
      : skipped ? "retry-bounded-drill"
      : pendingOnly ? "integrate-pending-contract"
      : blocked.length > 0 ? "resolve-blocked-work" : "none";
    const measurements: DrillMeasurements = { peakRssBytes: peakRss, stateBytesBefore,
      stateBytesAfter, stateGrowthBytes, diskPressure, queueWaitMs, stopAckMs, fetchCalls,
      sentDeliveries: sent, unknownDeliveries: unknown, failedDeliveries: failed,
      succeededJobs, waitingJobs, cancelledJobs, prReports, alertIntents, exportBytes, backupBytes,
      commandAckMaxMs, requestMaxMs, commands };
    const fixtureHonesty = [
      "PR reads come from an in-memory GitHub fixture and reviews from the scripted run port; no model judged any code.",
      "Delivery outcomes classify a scripted sender and PR alert intents wait unbound; no Bot API evidence is claimed.",
      fixtureEngine
        ? "Backup and upgrade preflight used a fixture engine declaring the snapshot contract; no Schway engine was exercised."
        : "Backup and upgrade preflight used an injected native port; its engine identity is the caller's claim.",
      ports.restore
        ? "Quarantine used an injected restore port inside disposable state; nothing was activated."
        : "Quarantined restore is pending OPS02 (#33); only the verified backup precondition was observed.",
      "Desktop fixture timing is not a latency SLO and not Pi capacity evidence.",
    ];
    const record: LoadDrillRecord = { schema: "jit.ops.drill/v1", id: crypto.randomUUID(),
      observedAt: new Date(Date.now()).toISOString(), installationLabel: label,
      versions: testedRevisions(store.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!).user_version),
      config: { ...config }, legs, measurements, fixtureHonesty, outcome, nextAction };
    return { record, root };
  } finally {
    globalThis.fetch = realFetch;
    try { await queue?.idle(); } catch { /* Disposable teardown; the record already carries leg states. */ }
    try { queue?.close(); } catch { /* See above. */ }
    try { store?.close(); } catch { /* See above. */ }
    if (created && !ports.keepRoot) rmSync(root, { recursive: true, force: true });
  }
}
