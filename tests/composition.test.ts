import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "schway/host";
import { Application } from "../src/application";
import { composeJobQueue } from "../src/composition";
import { readConfig } from "../src/config";
import type { JobQueue } from "../src/jobs/queue";
import { startFullApp, stopDrain } from "../src/ops/lifecycle";
import type { ServiceConfig } from "../ops/package/service-config";
import {
  FakeGitHubFixture, TrustedGitHubConnector, captureSnapshot, ensurePrSchema, fixturePull, listReports, mutateMonitor,
  pollMonitorCatchUp, readCandidates,
} from "../src/pr";
import { TransactionStore } from "../src/store";

const roots: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha = (n: number) => n.toString(16).padStart(40, "0");
const ROUTE = { provider: "grok" as const, model: "grok-fixture", authRoute: "owner-grok" };
const limits = { roles: 4, calls: 16, rounds: 16, hops: 16, contextTokens: 64000, outputTokens: 16000, retries: 2, wallMs: 60_000 };
const clean = JSON.stringify({ findings: [], analyzedRoles: ["correctness", "security"], skippedScope: [], disagreements: [] });

function model(text: string): Model {
  return {
    provider: "scripted", id: "composition-fixture",
    async *stream() {
      yield { type: "message_complete", message: { type: "assistant", id: crypto.randomUUID(), content: [{ type: "text", text }] } };
    },
  };
}

function own(queue: JobQueue, store: TransactionStore) {
  cleanups.push(async () => { queue.close(); await queue.idle(); store.close(); });
}

function storeFor(runPort: "scripted" | "schway") {
  const root = mkdtempSync(join(tmpdir(), "jit-composition-"));
  roots.push(root);
  const path = join(root, "app.sqlite");
  return { root, config: readConfig({ JIT_DATABASE: path, JIT_RUN_PORT: runPort }), store: new TransactionStore(path) };
}

async function reviewThroughComposition(runPort: "scripted" | "schway", route: typeof ROUTE | null) {
  const { root, config, store } = storeFor(runPort);
  const { queue, teamPort } = composeJobQueue(store, config, { prCacheRoot: join(root, "cache"), schwayOptions: { model: model(clean) } });
  own(queue, store);
  await queue.reconcile(teamPort);
  const app = new Application(store, config, { jobs: queue });
  await app.setupOwner("composition-owner-password");
  const actor = app.authenticate(await app.login("composition-owner-password")).actor;
  const project = app.execute(actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null, expectedRevision: 0, payload: { name: "Composition" } }).project;
  if (route) {
    app.execute(actor, { kind: "route.save", requestId: crypto.randomUUID(), projectId: project.id, expectedRevision: app.team(actor, project.id).projectRevision, payload: { roleId: null, route } });
  }
  const revision = () => store.read(tx => tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", project.id)!.revision);
  const monitor = store.transaction(tx => {
    ensurePrSchema(tx);
    return mutateMonitor(tx, { kind: "pr.monitor.enable", requestId: crypto.randomUUID(), projectId: project.id, expectedRevision: revision(),
      payload: { repository: { host: "github.com", owner: "acme", name: "widgets" }, apiBase: "https://api.github.com",
        allowed: { issues: true, specs: true, ci: true }, acceptPolicyVersion: 1 } }, Date.now()).monitor;
  });
  const github = new FakeGitHubFixture();
  github.pulls = [fixturePull({ number: 1, base: { sha: sha(1), ref: "main" }, head: { sha: sha(2), ref: "feat" } })];
  github.files.set(github.key(1, sha(1), sha(2)), [{ filename: "a.ts", status: "modified", patch: "@@ -1,1 +1,2 @@\n+a" }]);
  github.checks.set(sha(2), [{ name: "unit", conclusion: "success" }]);
  const conn = new TrustedGitHubConnector(github, monitor, join(root, "cache"));
  store.transaction(tx => pollMonitorCatchUp(tx, project.id, monitor.id, conn, Date.now()));
  const candidate = store.read(tx => readCandidates(tx, project.id, monitor.id)[0]!);
  store.transaction(tx => captureSnapshot(tx, project.id, candidate.id, conn, Date.now()));
  const job = app.execute(actor, { kind: "job.enqueue", requestId: crypto.randomUUID(), projectId: project.id, expectedRevision: revision(),
    payload: { type: "pr.review", configurationRevision: 1, policyRevision: config.jobs.revision, purpose: "review", inputRevision: revision(),
      input: { monitorId: monitor.id, candidateId: candidate.id }, priority: "background", limits } }).job;
  queue.pump();
  await queue.idle();
  return { teamPort, app, actor, project, job, reports: store.read(tx => listReports(tx, project.id)) };
}

test("composition: scripted mode registers PR workers on the scripted team port", async () => {
  const run = await reviewThroughComposition("scripted", null);
  expect(run.teamPort.adapter).toBe("scripted");
  expect(run.app.job(run.actor, run.project.id, run.job.id).state).toBe("succeeded");
  expect(run.reports[0]!.capture).toMatchObject({ adapter: "scripted", layer: "scripted_fixture" });
  expect(run.reports[0]!.mode).toBe("fixture");
});

test("composition: schway mode runs PR review on the concrete port with the configured, captured route", async () => {
  const run = await reviewThroughComposition("schway", ROUTE);
  expect(run.teamPort.adapter).toBe("schway");
  expect(run.app.job(run.actor, run.project.id, run.job.id).state).toBe("succeeded");
  const report = run.reports[0]!;
  expect(report.mode).toBe("production");
  expect(report.capture).toMatchObject({ adapter: "schway", route: ROUTE, layer: "project_default", configuration: { projectRevision: 1 } });
  expect(report.status).toBe("complete_clean");
});

test("composition: schway mode without a configured route rejects admission before any dispatch", async () => {
  const run = await reviewThroughComposition("schway", null);
  expect(run.app.job(run.actor, run.project.id, run.job.id).state).toBe("blocked");
  expect(run.reports).toHaveLength(0);
  expect((run.teamPort as unknown as { requests: unknown[] }).requests).toHaveLength(0);
});

function service(): { service: ServiceConfig; state: string } {
  const root = mkdtempSync(join(tmpdir(), "jit-composition-service-"));
  roots.push(root);
  const release = join(root, "release"), work = join(root, "work"), state = join(root, "state"), backup = join(root, "backup");
  for (const dir of [release, work, state, backup]) mkdirSync(dir, { mode: 0o700 });
  const ledger = join(state, "ledger.json");
  writeFileSync(ledger, JSON.stringify({ ledger: "jit.deletion.ledger/v1", revision: 1 }) + "\n", { mode: 0o600 });
  const credential = join(root, "bot.token");
  writeFileSync(credential, "fixture-credential-value", { mode: 0o600 });
  return { state, service: { serviceUser: "jit-service", executablePath: release, workingDirectory: work, stateDirectory: state,
    ledgerPath: ledger, backupDirectory: backup,
    routes: [{ route: "codex-subscription", model: null, configured: false }],
    secretRefs: [{ name: "bot-token", store: "credential-file", key: credential }],
    network: { bindHost: "127.0.0.1", port: 3443, vpnInterface: null },
    resources: { memoryMaxBytes: 536870912, maxRestarts: 3, restartWindowSeconds: 300, logBytes: 1048576, retentionDays: 30 } } };
}

test("composition: startFullApp and serve share one factory with identical workers in both run-port modes", async () => {
  for (const runPort of ["scripted", "schway"] as const) {
    const { service: svc, state } = service();
    const config = readConfig({ JIT_DATABASE: join(state, "app.sqlite"), JIT_RUN_PORT: runPort });
    const started = startFullApp({ config, service: svc });
    expect(started.ok).toBe(true);
    if (!started.ok) throw new Error("unreachable");
    expect(started.handle.teamPort.adapter).toBe(runPort);
    const fromLifecycle = started.handle.queue.choices();
    expect(fromLifecycle.map(c => c.id)).toContain("pr.snapshot");
    expect(fromLifecycle.map(c => c.id)).toContain("pr.review");
    expect((await stopDrain(started.handle, { timeoutMs: 5000 })).outcome).toBe("stopped");
    started.handle.store.close();
    const direct = storeFor(runPort);
    const composed = composeJobQueue(direct.store, direct.config);
    own(composed.queue, direct.store);
    expect(composed.teamPort.adapter).toBe(runPort);
    expect(composed.queue.choices()).toEqual(fromLifecycle);
  }
  // serve builds its queue only through the shared factory, owned by the managed service lifecycle.
  const main = readFileSync(join(import.meta.dir, "..", "src", "main.ts"), "utf8");
  expect(main).toContain("ManagedService.forConfig(store, config)");
  const managed = readFileSync(join(import.meta.dir, "..", "src", "ops", "upgrade-service.ts"), "utf8");
  expect(managed).toContain("composeJobQueue(store, config, compose)");
  for (const forbidden of ["new JobQueue(", "new ScriptedRunPort(", "new SchwayRunPort(", "prReviewWork(", "prSnapshotWork("]) {
    expect(main).not.toContain(forbidden);
  }
});
