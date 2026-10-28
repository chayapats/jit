import type { AppConfig } from "./config";
import { JobQueue, type SchedulerOptions } from "./jobs/queue";
import { projectStateWork } from "./jobs/project-state";
import { scheduleReminderWork, scheduleSummaryWork } from "./jobs/schedules";
import { memoryExtractionWork, scriptedMemoryResult } from "./memory/extract";
import { FakeGitHubFixture } from "./pr/github";
import { prReviewWork } from "./pr/review";
import { prSnapshotWork } from "./pr/work";
import { lookupSource } from "./sources";
import type { TransactionStore } from "./store";
import { coordinatorSynthesisWork } from "./team/decisions";
import { discussionPlanWork, specialistAnalysisWork } from "./team/dispatch";
import { jitReplyWork } from "./team/jit-reply";
import { setupCheckWork } from "./setup";
import { scriptedPreviewWork } from "./team/preview";
import type { ApplicationRunPort } from "./team/run-port";
import { ScriptedRunPort } from "./team/scripted-port";
import { SchwayRunPort, assertSchwayGate, type SchwayPortOptions } from "./team/schway-port";

export interface ComposeOptions {
  now?: () => number;
  /** Process-owned PR snapshot cache directory (default `.local/pr-cache`). */
  prCacheRoot?: string;
  /** Deterministic test transport for the concrete port; production never sets it. */
  schwayOptions?: SchwayPortOptions;
  /** Deterministic queue timers for tests. */
  timers?: SchedulerOptions["timers"];
  /** exec.box_runtime/v1 capacity for execution-capable work (EXE03); absent when execution is not configured. */
  boxes?: SchedulerOptions["boxes"];
}

/** The composed queue plus the team port the caller reconciles against. */
export interface ComposedQueue {
  queue: JobQueue;
  /** Port specialist, coordinator and PR review runs use (`JIT_RUN_PORT`). */
  teamPort: ApplicationRunPort;
}

/**
 * The one import-safe queue/worker composition shared by `serve` (src/main.ts)
 * and `startFullApp` (src/ops/lifecycle.ts). It asserts the synchronous Schway
 * gate before claiming admission, then registers every worker with one port
 * policy: specialist, coordinator, Jit reply, setup route check and PR review runs use the team port
 * (scripted by default, concrete with `JIT_RUN_PORT=schway`); fixture-authorized
 * work (role preview, schedule summaries, memory extraction) stays scripted.
 * PR review routes come from owner/project configuration captured at admission;
 * the concrete port never falls back to a scripted route. Callers reconcile with
 * `await queue.reconcile(teamPort)` before serving.
 */
export function composeJobQueue(store: TransactionStore, config: AppConfig, options: ComposeOptions = {}): ComposedQueue {
  if (config.runPort === "schway") assertSchwayGate(store.path);
  const teamPort: ApplicationRunPort = config.runPort === "schway"
    ? new SchwayRunPort(store, config.team, config.jobs.outputBytes, options.schwayOptions)
    : new ScriptedRunPort(store, config.team, config.jobs.outputBytes);
  const fixturePort: ApplicationRunPort = config.runPort === "schway"
    ? new ScriptedRunPort(store, config.team, config.jobs.outputBytes)
    : teamPort;
  const memoryPort = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, request => {
    const source = store.read(tx => lookupSource(tx, request.projectId, request.manifest.sources[0]!.reference));
    return scriptedMemoryResult(request, source.state === "available" && source.attribution.kind === "owner", config.jobs.outputBytes);
  });
  // Jit replies and specialist results may admit follow-up work (app.dispatch_allowance/v1) through this same queue.
  let composed: JobQueue | undefined;
  const current = () => composed, now = options.now ?? Date.now;
  const queue = new JobQueue(store, config.jobs, [
    projectStateWork(store), scriptedPreviewWork(store, config, fixturePort), discussionPlanWork(),
    specialistAnalysisWork(store, config, teamPort, now, current), coordinatorSynthesisWork(store, config, teamPort), jitReplyWork(store, config, teamPort, now, current),
    setupCheckWork(store, config, teamPort),
    memoryExtractionWork(store, config, memoryPort), scheduleReminderWork(store, config), scheduleSummaryWork(store, config, fixturePort),
    prSnapshotWork({ store, cacheRoot: options.prCacheRoot ?? ".local/pr-cache", fixtureFor: () => new FakeGitHubFixture() }),
    prReviewWork({
      store, port: teamPort, ...(options.now ? { now: options.now } : {}),
      sourceLimit: config.team.sourceLimit, contextBytes: config.team.contextBytes, outputBytes: config.jobs.outputBytes,
      alertBytes: config.messageBytes,
    }),
  ], { ...(options.now ? { now: options.now } : {}), ...(options.timers ? { timers: options.timers } : {}), ...(options.boxes ? { boxes: options.boxes } : {}) });
  composed = queue;
  return { queue, teamPort };
}
