import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, type OwnerActor } from "../application";
import { readConfig } from "../config";
import type { AppConfig } from "../config";
import { DeliveryWorker } from "../delivery/outbox";
import type { DeliverySendInput, DeliverySendResult, DeliverySender, SenderScript } from "../delivery/sender";
import { TelegramChannel } from "../telegram";
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
import { deriveDrillVerdict, drillLegStates, safeInstallationLabel, validateDrillConfig, exhaustedLimitKinds, safeNote, safeOpsAlias, type DrillAction, type ExhaustedLimit, type DrillLeg, type DrillLegState, type DrillMeasurements,
  type LoadDrillConfig, type LoadDrillRecord } from "./contracts";
import { testedRevisions } from "./revisions";
import { upgradeEngineContract, upgradeNativeFormatVersion } from "./upgrade";
import { terminalRestoreStates, type RestoreCommand, type RestoreEvidence } from "./restore";
import { AppError } from "../errors";

/** What a quarantine/restore leg receives: the drilled Application, its owner actor and the verified backup. */
export interface DrillRestoreContext {
  app: Application;
  actor: OwnerActor;
  /** Verified managed backup created by the `backup` leg. */
  backupId: string;
  now: () => number;
  /** Aborts on owner cancellation or when the drill deadline is reached during the leg. */
  signal: AbortSignal;
}

/** Bounded leg result. `detail` must be fixed-vocabulary text; it passes `safeNote`. */
export interface DrillLegResult { state: DrillLegState; detail: string }

/**
 * Seam for the quarantined-restore leg (`ops.quarantined_restore/v1`, OPS02 #33).
 * The default is {@link quarantineRestorePort}; tests inject failure ports.
 */
export type DrillRestorePort = (context: DrillRestoreContext) => Promise<DrillLegResult>;

const restoreSteps = ["restore.migrate", "restore.apply_ledger", "restore.validate"] as const;

/**
 * Exercises the accepted OPS02 restore flow against the drill's verified backup
 * through the Application boundary: prepare → migrate → apply_ledger (latest
 * trusted installation lifecycle ledger) → validate, then always discard. It
 * never activates: activation would replace the drill's own state. The leg is
 * `passed` only when validation passed every check, the quarantine was
 * discarded and the shared fence and read gate are released afterwards; a
 * blocked or failed journal is `blocked` with its fixed reason (and is still
 * discarded when it can be).
 */
export const quarantineRestorePort: DrillRestorePort = async ({ app, actor, backupId, signal }) => {
  const revision = (): number => app.restoreConsole(actor).revision;
  // A refused step still writes its journal (blocked/failed, fence held while blocked) and then throws;
  // the drill reads that journal back by request id instead of treating the refusal as a crash.
  const run = async (command: RestoreCommand): Promise<RestoreEvidence | null> => {
    try { return (await app.execute(actor, command)).quarantine; }
    catch (error) {
      if (!(error instanceof AppError)) throw error;
      return app.restores(actor).quarantines.find(j => j.requests.some(r => r.requestId === command.requestId)) ?? null;
    }
  };
  const step = (kind: (typeof restoreSteps)[number] | "restore.discard", quarantineId: string) =>
    run({ kind, requestId: crypto.randomUUID(), projectId: null, expectedRevision: revision(), payload: { quarantineId } });
  let journal = await run({ kind: "restore.prepare", requestId: crypto.randomUUID(), projectId: null,
    expectedRevision: revision(), payload: { backupId, note: "drill quarantine probe" } });
  if (!journal) return { state: "blocked", detail: "restore prepare refused before writing a journal" };
  const states: string[] = [journal.state];
  for (const kind of restoreSteps) {
    // Stop advancing on cancellation/deadline; the discard below still ends the quarantine.
    if (journal.state === "blocked" || journal.state === "failed" || signal.aborted) break;
    const next: RestoreEvidence | null = await step(kind, journal.id);
    journal = next ?? app.restore(actor, journal.id).quarantine;
    states.push(journal.state);
  }
  const validated = journal.state === "validated";
  const failedChecks = journal.validation?.checks.filter(c => !c.pass).length ?? 0;
  const checks = journal.validation?.checks.length ?? 0;
  const reason = reasonCode(journal.reason ?? "none");
  let discarded = journal.state === "discarded";
  if (!terminalRestoreStates.includes(journal.state)) discarded = (await step("restore.discard", journal.id))?.state === "discarded";
  const released = app.restoreConsole(actor).gatedBy === null && !app.upgradeStatus(actor).fenced;
  const detail = `states=${states.join(">")} checks=${checks} failedChecks=${failedChecks} discarded=${discarded} fenceReleased=${released}`;
  if (validated && failedChecks === 0 && discarded && released) return { state: "passed", detail };
  // A quarantine the drill could not end leaves the installation fenced: that is a drill failure, not a gate.
  if (!released) return { state: "failed", detail: `${detail} reason=${reason}` };
  return { state: "blocked", detail: `${detail} reason=${reason}` };
};

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
  /** Quarantined-restore leg; defaults to {@link quarantineRestorePort}. */
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

/** Process high-water RSS in bytes: getrusage `maxrss` (KiB in Node and Bun), never below the current RSS. */
function peakRss(): number {
  let high = 0;
  try { high = process.resourceUsage().maxRSS * 1024; } catch { high = 0; }
  return Math.max(high, process.memoryUsage().rss);
}

/** Nearest-rank percentile of non-negative samples; 0 when there are none. */
function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

/** Process-wide single-flight: the fetch guard is process-global, so two drills never overlap. */
let drillInFlight = false;
/** Bounded wait for an aborted leg to settle before teardown. */
const abortGraceMs = 1000;

/** Fixture Telegram transport selected by dedupe key, so other intents (PR alerts) never consume a drill script. */
class DrillSender implements DeliverySender {
  readonly modes = new Map<string, SenderScript>();
  calls = 0;
  #messageId = 0;
  send(input: DeliverySendInput): DeliverySendResult {
    this.calls++;
    const mode = this.modes.get(input.dedupeKey) ?? "accept";
    if (mode === "reject") return { outcome: "failed", reason: "telegram_rejected", retryable: false };
    if (mode === "safe_failure") return { outcome: "failed", reason: "telegram_unavailable", retryable: true };
    if (mode === "timeout_after_accept") return { outcome: "unknown" };
    return { outcome: "sent", messageId: ++this.#messageId };
  }
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
  // The public boundary validates the exact config (shared bounds, schedules >= 1) before any global state or files.
  try { validateDrillConfig(config); } catch { throw new Error("invalid_drill_config"); }
  config = { ...config };
  if (drillInFlight) throw new Error("drill_in_progress");
  drillInFlight = true;
  try { return await drillOnce(config, ports); } finally { drillInFlight = false; }
}

async function drillOnce(config: LoadDrillConfig, ports: DrillPorts): Promise<DrillResult> {
  // Monotonic absolute deadline for the whole drill; every leg receives the remaining budget as an abort signal.
  const deadlineAt = performance.now() + config.deadlineMs;
  let fakeNow = 1800000000000;
  const now = ports.now ?? (() => fakeNow);
  const advance = (ms: number): void => { fakeNow += ms; };
  const label = safeInstallationLabel(ports.installationLabel ?? "drill-fixture");
  const created = !ports.root;
  const root = ports.root ?? mkdtempSync(join(tmpdir(), "jit-ops-drill-"));
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  const fetchGuard = (() => { fetchCalls++; throw new Error("network_not_authorized"); }) as unknown as typeof fetch;
  globalThis.fetch = fetchGuard;

  const legs: DrillLeg[] = [];
  const limits = new Set<ExhaustedLimit>();
  let halted: "cancelled" | "deadline" | null = null;
  const timed = async (leg: string, sampleLimit: string, run: (signal: AbortSignal) => Promise<DrillLegResult>): Promise<void> => {
    if (ports.signal?.aborted) halted ??= "cancelled";
    if (!halted && performance.now() >= deadlineAt) { halted = "deadline"; limits.add("drill-deadline"); }
    if (halted) {
      legs.push({ leg, state: "not-run", elapsedMs: 0, detail: halted === "cancelled" ? "skipped: drill cancelled by owner" : "skipped: drill deadline exceeded", sampleLimit });
      return;
    }
    const t0 = performance.now();
    const controller = new AbortController();
    const onOwner = (): void => controller.abort("cancelled");
    ports.signal?.addEventListener("abort", onOwner, { once: true });
    const timer = setTimeout(() => controller.abort("deadline"), Math.max(0, deadlineAt - performance.now()));
    const stopped = new Promise<"stopped">(resolve => controller.signal.addEventListener("abort", () => resolve("stopped"), { once: true }));
    const running = run(controller.signal).then(value => ({ value }), () => ({ error: true as const }));
    let result: DrillLegResult;
    try {
      const winner = await Promise.race([running, stopped]);
      if (winner === "stopped") {
        // Fail closed: the leg is recorded as stopped and every later leg is skipped; the leg gets a bounded grace to settle.
        halted = controller.signal.reason === "cancelled" ? "cancelled" : "deadline";
        if (halted === "deadline") limits.add("drill-deadline");
        await Promise.race([running, Bun.sleep(abortGraceMs)]);
        result = { state: "blocked", detail: halted === "deadline" ? "stopped: drill deadline reached during leg" : "stopped: drill cancelled by owner during leg" };
      } else if ("error" in winner) {
        result = { state: "failed", detail: "leg raised instead of returning bounded evidence" };
      } else {
        const value = winner.value;
        if (!value || !drillLegStates.includes(value.state)) throw new Error("invalid_leg_state");
        result = { state: value.state, detail: safeNote(value.detail) };
      }
    } catch {
      result = { state: "failed", detail: "leg raised instead of returning bounded evidence" };
    } finally {
      clearTimeout(timer);
      ports.signal?.removeEventListener("abort", onOwner);
    }
    // A leg that blocked the event loop past the deadline cannot be preempted by the timer; its late result never counts.
    if (!halted && performance.now() > deadlineAt) {
      halted = "deadline";
      limits.add("drill-deadline");
      result = { state: "blocked", detail: "stopped: drill deadline reached during leg" };
    }
    legs.push({ leg, state: result.state, elapsedMs: Math.min(Math.round(performance.now() - t0), 3600000), detail: result.detail, sampleLimit });
  };

  let queue: JobQueue | undefined;
  let store: TransactionStore | undefined;
  const stateDir = join(root, "state");
  const stateBytesBefore = dirBytes(root);
  let stopAckMs: number | null = null;
  const enqueuedAt = new Map<string, number>(), admittedAt = new Map<string, number>();
  let deliveryAttempts = 0;
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
    /** Admission observation: the first invocation of a job's work, on the monotonic clock. */
    const observed = (definition: WorkDefinition): WorkDefinition => ({ ...definition,
      run: context => { if (!admittedAt.has(context.job.id)) admittedAt.set(context.job.id, performance.now()); return definition.run(context); } });
    queue = new JobQueue(store, appConfig.jobs, [
      observed(prSnapshotWork({ store, cacheRoot, fixtureFor })),
      observed(prReviewWork({ store, port: reviewPort, now, sourceLimit: appConfig.team.sourceLimit, contextBytes: appConfig.team.contextBytes,
        outputBytes: appConfig.jobs.outputBytes, alertBytes: appConfig.messageBytes })),
      observed({ ...fixtureWork("drill.quota-probe", "Quota probe fixture", "quota probe fixture evidence"),
        run: () => ({ state: "waiting", reason: "quota" as const }) }),
      observed({ ...fixtureWork("drill.gated", "Gated stop fixture", "gated fixture evidence"),
        run: async () => { gatedStarted = true; await gate; return { state: "succeeded", evidence: "gated fixture evidence" }; } }),
      scheduleReminderWork(store, appConfig, now),
    ], { now });
    const jobs = queue;
    const app = new Application(store, appConfig, { jobs, now, nativeSnapshot: native,
      backupDir: join(stateDir, "backups") });
    await app.setupOwner("drill-fixture-owner-password");
    const ownerToken = await app.login("drill-fixture-owner-password");
    const actor = app.authenticate(ownerToken).actor;
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
    /** Owner enqueue; the timestamp is taken before the command so an in-command admission still counts as wait >= 0. */
    const enqueue = (projectId: string, type: string, purpose: string, input: Record<string, string>, jobLimitsFor: JobLimits,
      priority: "background" | "interactive" = "background") => {
      const at = performance.now();
      try {
        const receipt = command(() => app.execute(actor, {
          kind: "job.enqueue", requestId: crypto.randomUUID(), projectId, expectedRevision: revisionOf(projectId),
          payload: { type, configurationRevision: 1, policyRevision: appConfig.jobs.revision, purpose, inputRevision: revisionOf(projectId),
            input, priority, limits: structuredClone(jobLimitsFor) } }));
        enqueuedAt.set(receipt.job.id, at);
        return receipt;
      } catch (error) {
        if (error instanceof AppError && error.code === "job_queue_full") limits.add("queue-limit");
        throw error;
      }
    };

    const projectIds: string[] = [];
    const topicIds: string[] = [];
    await timed("groups", "Topics stand in for groups; one project carries one stable group.", async signal => {
      for (let n = 0; n < config.groups; n++) {
        signal.throwIfAborted();
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
    await timed("pr-snapshots", "In-memory GitHub fixture; immutable snapshot capture only, no GitHub writes.", async signal => {
      if (projectIds.length === 0) return { state: "not-run", detail: "no groups to monitor" };
      for (let g = 0; g < projectIds.length; g++) {
        signal.throwIfAborted();
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
        signal.throwIfAborted();
        const ids = candidates.slice(start, start + wave).map(c => ({ projectId: c.projectId,
          id: enqueue(c.projectId, "pr.snapshot", "Drill PR snapshot", { monitorId: c.monitorId, candidateId: c.candidateId }, jobLimits).job.id }));
        await drain();
        snapshots += ids.filter(({ projectId, id }) => request(() => app.job(actor, projectId, id)).state === "succeeded").length;
      }
      succeededJobs += snapshots;
      advance(1000);
      return snapshots === config.prSnapshots && candidates.length === config.prSnapshots
        ? { state: "passed", detail: `candidates=${candidates.length} snapshots=${snapshots}` }
        : { state: "failed", detail: `candidates=${candidates.length} snapshots=${snapshots} expected=${config.prSnapshots}` };
    });

    await timed("pr-alerts", "Scripted specialist/synthesis runs; alert intents are admitted before any Telegram binding exists.", async signal => {
      if (candidates.length === 0) return { state: "not-run", detail: "no captured PR snapshots to review" };
      let reviews = 0;
      for (let start = 0; start < candidates.length; start += wave) {
        signal.throwIfAborted();
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

    await timed("memory-queries", "Reads committed claims only; empty stores answer without inference.", async signal => {
      if (projectIds.length === 0) return { state: "not-run", detail: "no groups to query" };
      let claims = 0;
      for (let n = 0; n < config.memoryQueries; n++) {
        signal.throwIfAborted();
        const found = request(() => app.memory(actor, projectIds[n % projectIds.length]!, 0, 0, 0, ""));
        claims += (found as { claims?: unknown[] }).claims?.length ?? 0;
        advance(10);
      }
      return { state: "passed", detail: `queries=${config.memoryQueries} claims=${claims}` };
    });

    await timed("deliveries", "Fixture Telegram binding and transport; the DeliveryWorker claims, sends and records every committed intent. No Bot API traffic.", async signal => {
      if (projectIds.length === 0) return { state: "not-run", detail: "no groups to deliver to" };
      // Owner binding through the Telegram channel's own bind/confirm commands (fixture identities, no Bot API).
      const channel = new TelegramChannel(liveStore, appConfig, { now });
      const owner = channel.authenticate(ownerToken);
      const pending = command(() => channel.execute(owner, { kind: "telegram.bind", requestId: crypto.randomUUID(),
        expectedRevision: channel.status(owner).binding.revision, payload: { telegramUserId: 4242, telegramChatId: 7777 } }));
      command(() => channel.execute(owner, { kind: "telegram.confirm", requestId: crypto.randomUUID(), expectedRevision: pending.binding.revision,
        payload: { telegramUserId: 4242, telegramChatId: 7777, challengeNonce: pending.binding.challengeNonce! } }));
      const modes = ["accept", "timeout_after_accept", "safe_failure", "reject"] as const;
      const sender = new DrillSender();
      const intentIds: string[] = [];
      for (let n = 0; n < config.deliveries; n++) {
        signal.throwIfAborted();
        const projectId = projectIds[n % projectIds.length]!;
        const key = `drill/delivery-${String(n + 1).padStart(4, "0")}`;
        sender.modes.set(key, modes[n % modes.length]!);
        intentIds.push(command(() => app.execute(actor, { kind: "delivery.commit", requestId: crypto.randomUUID(), projectId,
          expectedRevision: revisionOf(projectId), payload: { kind: "report", text: `Drill delivery ${n + 1}`, dedupeKey: key } })).intent.id);
        advance(100);
      }
      const worker = new DeliveryWorker(liveStore, { sender, now });
      try {
        // Bounded: each pump handles at most 32 claims; safe retries are bounded by the intent's own retry budget.
        for (let round = 0; round < 16; round++) {
          signal.throwIfAborted();
          if (worker.pump().length === 0) break;
          advance(1000);
        }
      } finally { worker.close(); }
      const persisted = liveStore.read(tx => intentIds.map(id => ({
        intent: JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE id = ?", id)!.record_json) as { status: string; nextAction: string },
        attempts: tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_attempts WHERE intent_id = ?", id)!.n })));
      sent = persisted.filter(p => p.intent.status === "sent").length;
      unknown = persisted.filter(p => p.intent.status === "unknown").length;
      failed = persisted.filter(p => p.intent.status === "failed").length;
      deliveryAttempts = persisted.reduce((sum, p) => sum + p.attempts, 0);
      if (persisted.some(p => p.intent.nextAction === "safe_retry_limit_reached")) limits.add("delivery-retry");
      const settled = sent + unknown + failed;
      return { state: settled === config.deliveries ? "passed" : "failed",
        detail: `sent=${sent} unknown=${unknown} failed=${failed} attempts=${deliveryAttempts} unsettled=${config.deliveries - settled}` };
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

    await timed("quarantine", "Quarantine is exercised and discarded; the drill never activates a restore over its own state.", async signal => {
      if (!verifiedBackupId) return { state: "not-run", detail: "no verified backup to restore into quarantine" };
      return (ports.restore ?? quarantineRestorePort)({ app, actor, backupId: verifiedBackupId, now, signal });
    });

    await timed("network", "Global fetch is a throwing stub for the whole drill; any call or replaced guard is an escape.", async () =>
      globalThis.fetch !== fetchGuard ? { state: "failed", detail: `fetch guard replaced during drill fetchCalls=${fetchCalls}` }
        : fetchCalls === 0 ? { state: "passed", detail: "fetchCalls=0" } : { state: "failed", detail: `fetchCalls=${fetchCalls}` });

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
    if (diskPressure) limits.add("disk-watermark");
    const jobLimitEvents = liveStore.read(tx => ({
      budget: tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state = 'blocked' AND json_extract(record_json, '$.reason') = 'budget_exhausted'")!.n,
      deadline: tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state = 'failed' AND json_extract(record_json, '$.reason') = 'deadline'")!.n,
    }));
    if (jobLimitEvents.budget > 0) limits.add("job-budget");
    if (jobLimitEvents.deadline > 0) limits.add("job-deadline");
    const waits = [...enqueuedAt].flatMap(([id, at]) => admittedAt.has(id) ? [Math.max(0, Math.round(admittedAt.get(id)! - at))] : []);
    // The same derivation the record validator recomputes.
    const { outcome, nextAction } = deriveDrillVerdict(legs, diskPressure);
    const measurements: DrillMeasurements = { peakRssBytes: peakRss(), stateBytesBefore,
      stateBytesAfter, stateGrowthBytes, diskPressure,
      queueWaitMaxMs: waits.length ? Math.max(...waits) : 0, queueWaitP95Ms: percentile(waits, 0.95), queueWaitSamples: waits.length,
      stopAckMs, fetchCalls, sentDeliveries: sent, unknownDeliveries: unknown, failedDeliveries: failed, deliveryAttempts,
      succeededJobs, waitingJobs, cancelledJobs, prReports, alertIntents, exportBytes, backupBytes,
      commandAckMaxMs, requestMaxMs, commands };
    const fixtureHonesty = [
      "PR reads come from an in-memory GitHub fixture and reviews from the scripted run port; no model judged any code.",
      "Deliveries ran through the DeliveryWorker over a fixture binding and scripted transport; no Bot API evidence is claimed.",
      "peakRssBytes is the process high-water RSS (getrusage maxrss), so it includes memory in use before the drill started.",
      "Queue wait covers owner-enqueued drill jobs only (enqueue receipt to first work invocation); schedule-produced jobs are not sampled.",
      fixtureEngine
        ? "Backup and upgrade preflight used a fixture engine declaring the snapshot contract; no Schway engine was exercised."
        : "Backup and upgrade preflight used an injected native port; its engine identity is the caller's claim.",
      ports.restore
        ? "Quarantine used an injected restore port inside disposable state; nothing was activated."
        : "Quarantined restore ran prepare, migrate, ledger replay and validate on the drill backup, then discarded; activation is never drilled.",
      "Desktop fixture timing is not a latency SLO and not Pi capacity evidence.",
    ];
    const record: LoadDrillRecord = { schema: "jit.ops.drill/v1", id: crypto.randomUUID(),
      observedAt: new Date(Date.now()).toISOString(), installationLabel: label,
      versions: testedRevisions(store.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!).user_version),
      config: { ...config }, legs, measurements,
      exhaustedLimits: exhaustedLimitKinds.filter(kind => limits.has(kind)), fixtureHonesty, outcome, nextAction };
    return { record, root };
  } finally {
    // Compare-and-restore: never clobber a fetch someone else installed after the guard.
    if (globalThis.fetch === fetchGuard) globalThis.fetch = realFetch;
    try { await queue?.idle(); } catch { /* Disposable teardown; the record already carries leg states. */ }
    try { queue?.close(); } catch { /* See above. */ }
    try { store?.close(); } catch { /* See above. */ }
    if (created && !ports.keepRoot) rmSync(root, { recursive: true, force: true });
  }
}
