import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import { JobQueue } from "../src/jobs/queue";
import type { EnqueueJobCommand, JobLimits } from "../src/jobs/types";
import {
  FakeGitHubFixture,
  TrustedGitHubConnector,
  captureSnapshot,
  ensurePrSchema,
  fixturePull,
  mutateMonitor,
  pollMonitorCatchUp,
  prReviewWork,
  prSnapshotWork,
  readCandidates,
  readReport,
  admitReportAlerts,
  alertKey,
  buildAlertPayload,
  evaluateReport,
  ALERT_POLICY_VERSION,
  DEFAULT_ALERT_POLICY,
  readAlertDecisions,
  readAlertLinks,
  readAlertPolicy,
  type EnableMonitorCommand,
  type PrMonitor,
} from "../src/pr";
import { ScriptedRunPort, fixtureOutcome } from "../src/team/scripted-port";
import { ScriptedTelegramSender, DeliveryWorker, commitDeliveryIntent, readDeliveryIntent } from "../src/delivery";
import { TelegramChannel } from "../src/telegram";
import { createWebHandler } from "../src/web";

const password = "fixture-pr-alerts-owner-password";
const epoch = 1_800_000_000_000;
const sha = (n: number) => n.toString(16).padStart(40, "0");
const roots: string[] = [];
const stores: TransactionStore[] = [];
const queues: JobQueue[] = [];
const workers: DeliveryWorker[] = [];

afterEach(async () => {
  for (const w of workers.splice(0)) { try { w.close(); } catch { /* already closed */ } }
  for (const queue of queues.splice(0)) { queue.close(); await queue.idle(); }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

class Clock {
  now = epoch;
  #id = 0;
  #timers = new Map<number, { at: number; callback: () => void }>();
  timers = {
    set: (callback: () => void, ms: number) => {
      const id = ++this.#id;
      this.#timers.set(id, { at: this.now + ms, callback });
      return id;
    },
    clear: (id: unknown) => { this.#timers.delete(id as number); },
  };
}

const limits: JobLimits = {
  roles: 4, calls: 16, rounds: 16, hops: 16, contextTokens: 64000, outputTokens: 16000, retries: 2, wallMs: 60_000,
};

function goodFindingsJson(): string {
  return JSON.stringify({
    findings: [
      {
        id: "finding-1", title: "null deref in a.ts", category: "correctness", severity: "high",
        location: { path: "a.ts", line: 10 }, condition: "when input empty", impact: "crash",
        reasoning: "unchecked access on line 10", evidenceType: "diff", evidenceRef: "a.ts",
      },
      {
        id: "finding-2", title: "style nit", category: "style", severity: "low",
        location: { path: "a.ts", line: 1 }, condition: "c", impact: "i", reasoning: "r",
        evidenceType: "diff", evidenceRef: "a.ts",
      },
      {
        id: "finding-3", title: "maybe uncertain", category: "uncertain", severity: "medium",
        location: { path: "a.ts", line: 2 }, condition: "c", impact: "i", reasoning: "r",
        evidenceType: "none", evidenceRef: null,
      },
    ],
    analyzedRoles: ["correctness", "security"], skippedScope: [], disagreements: [],
  });
}

async function fixture(script?: (request: any, signal: AbortSignal, observe: (e: any) => void) => unknown) {
  const root = mkdtempSync(join(tmpdir(), "jit-pr-alerts-"));
  roots.push(root);
  const path = join(root, "app.sqlite");
  const config = readConfig({ JIT_DATABASE: path, JIT_TELEGRAM_BOT_TOKEN_PATH: join(root, "missing-bot.token") });
  const store = new TransactionStore(path);
  stores.push(store);
  const clock = new Clock();
  const github = new FakeGitHubFixture();
  const fixtures = new Map<string, FakeGitHubFixture>();
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, script ?? (() => ({
    ...fixtureOutcome("complete", goodFindingsJson()),
    usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 10, outputTokens: 100, retries: 0, wallMs: 10, tokensUnknown: false },
    session: null,
  })));
  const review = prReviewWork({ store, port, now: () => clock.now });
  const snapshot = prSnapshotWork({ store, cacheRoot: join(root, "cache"), fixtureFor: (m) => fixtures.get(m.id) ?? github });
  const queue = new JobQueue(store, config.jobs, [snapshot, review], { now: () => clock.now, timers: clock.timers });
  queues.push(queue);
  const app = new Application(store, config, { jobs: queue, now: () => clock.now });
  await app.setupOwner(password);
  const token = await app.login(password);
  const auth = app.authenticate(token);
  const project = app.execute(auth.actor, {
    kind: "project.create", requestId: crypto.randomUUID(), projectId: null,
    expectedRevision: 0, payload: { name: "โครงการ alerts" },
  }).project;
  const sender = new ScriptedTelegramSender();
  return { root, path, store, clock, queue, app, project, token, auth, github, fixtures, port, config, sender };
}

type F = Awaited<ReturnType<typeof fixture>>;

function enable(f: F): PrMonitor {
  const command: EnableMonitorCommand = {
    kind: "pr.monitor.enable",
    requestId: crypto.randomUUID(),
    projectId: f.project.id,
    expectedRevision: f.store.read(tx => tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", f.project.id)!.revision),
    payload: {
      repository: { host: "github.com", owner: "acme", name: "widgets" },
      apiBase: "https://api.github.com",
      allowed: { issues: true, specs: true, ci: true },
      acceptPolicyVersion: 1 as 1,
    },
  };
  return f.store.transaction(tx => {
    ensurePrSchema(tx);
    return mutateMonitor(tx, command, f.clock.now).monitor;
  });
}

function connector(f: F, monitor: PrMonitor) {
  const port = f.fixtures.get(monitor.id) ?? f.github;
  f.fixtures.set(monitor.id, port);
  return new TrustedGitHubConnector(port, monitor, join(f.root, "cache"));
}

function prepareReport(f: F, monitor?: PrMonitor) {
  const mon = monitor ?? enable(f);
  const base = sha(1), head = sha(2);
  f.github.pulls = [fixturePull({ number: 1, base: { sha: base, ref: "main" }, head: { sha: head, ref: "feat" } })];
  f.github.files.set(f.github.key(1, base, head), [{ filename: "a.ts", status: "modified", patch: "@@\n+a" }]);
  f.github.checks.set(head, []);
  const conn = connector(f, mon);
  f.store.transaction(tx => pollMonitorCatchUp(tx, f.project.id, mon.id, conn, f.clock.now));
  const candidate = f.store.read(tx => readCandidates(tx, f.project.id, mon.id)[0]!);
  f.store.transaction(tx => captureSnapshot(tx, f.project.id, candidate.id, conn, f.clock.now));
  const revision = f.store.read(tx => tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", f.project.id)!.revision);
  const cmd: EnqueueJobCommand = {
    kind: "job.enqueue", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: revision,
    payload: { type: "pr.review", configurationRevision: 1, policyRevision: 1, purpose: "review", inputRevision: revision, input: { monitorId: mon.id, candidateId: candidate.id }, priority: "background", limits: structuredClone(limits) },
  };
  const job = f.app.execute(f.auth.actor, cmd).job;
  f.queue.pump();
  return (async () => {
    await f.queue.idle();
    const report = f.store.read(tx => readReport(tx, f.project.id, tx.all<{ record_json: string }>("SELECT record_json FROM pr_reports").map(r => (JSON.parse(r.record_json) as any).id)[0]!));
    return { monitor: mon, candidate, report, job, conn, base, head };
  })();
}

function bindTelegram(f: F, userId = 42, chatId = 77) {
  const channel = new TelegramChannel(f.store, f.config, { now: () => f.clock.now });
  const authed = channel.authenticate(f.token);
  const current = channel.status(authed).binding;
  const pending = channel.execute(authed, {
    kind: "telegram.bind", requestId: crypto.randomUUID(), expectedRevision: current.revision,
    payload: { telegramUserId: userId, telegramChatId: chatId },
  });
  channel.execute(authed, {
    kind: "telegram.confirm", requestId: crypto.randomUUID(), expectedRevision: pending.binding.revision,
    payload: { telegramUserId: userId, telegramChatId: chatId, challengeNonce: pending.binding.challengeNonce! },
  });
}

test("policy gating: evidence required, style/uncertain held", async () => {
  const f = await fixture();
  const { report } = await prepareReport(f);
  expect(report.status).toBe("complete_findings");
  const evaluation = evaluateReport(report, DEFAULT_ALERT_POLICY);
  expect(evaluation.qualifying.map(q => q.id)).toEqual(["finding-1"]);
  expect(evaluation.held.map(h => h.finding.id).sort()).toEqual(["finding-2", "finding-3"]);
  expect(ALERT_POLICY_VERSION).toBe(1);
  expect(DEFAULT_ALERT_POLICY.allowedCategories).toEqual(["correctness", "security", "behavior"]);
});

test("logical alert keys: replay dedupes to one intent", async () => {
  const f = await fixture();
  const { report } = await prepareReport(f);
  const first = f.store.transaction(tx => admitReportAlerts(tx, { projectId: f.project.id, reportId: report.id }, f.clock.now));
  expect(first.admitted).toHaveLength(1);
  expect(first.held.map(h => h.findingId).sort()).toEqual(["finding-2", "finding-3"]);
  expect(first.suppressed).toHaveLength(0);
  const key = alertKey(report, report.findings.find(q => q.id === "finding-1")!);
  expect(first.admitted[0]!.intent.dedupeKey).toBe(key);
  const second = f.store.transaction(tx => admitReportAlerts(tx, { projectId: f.project.id, reportId: report.id }, f.clock.now));
  expect(second.admitted).toHaveLength(1);
  expect(second.admitted[0]!.created).toBe(false);
  expect(second.admitted[0]!.intent.id).toBe(first.admitted[0]!.intent.id);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents")!.n)).toBe(1);
});

test("recheck-before-send: close/revoke/revision/owner-rotation suppress", async () => {
  // close
  {
    const f = await fixture();
    const { report, conn, monitor } = await prepareReport(f);
    f.github.pulls = [fixturePull({ number: 1, state: "closed", base: { sha: sha(1), ref: "main" }, head: { sha: sha(2), ref: "feat" } })];
    f.store.transaction(tx => {
      tx.run("UPDATE pr_poll_checkpoints SET record_json = ? WHERE monitor_id = ?",
        JSON.stringify({ monitorId: monitor.id, updatedAt: f.clock.now, complete: false, nextPage: 1, etag: null, lastSeenUpdatedAt: null, reason: null }), monitor.id);
      pollMonitorCatchUp(tx, f.project.id, monitor.id, conn, f.clock.now);
    });
    const result = f.store.transaction(tx => admitReportAlerts(tx, { projectId: f.project.id, reportId: report.id }, f.clock.now));
    expect(result.admitted).toHaveLength(0);
    expect(result.suppressed.length).toBeGreaterThan(0);
    expect(result.suppressed[0]!.reason).toBe("pr_closed");
  }
  // revoke
  {
    const f = await fixture();
    const { report, monitor } = await prepareReport(f);
    const rev = f.store.read(tx => tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", f.project.id)!.revision);
    f.store.transaction(tx => mutateMonitor(tx, {
      kind: "pr.monitor.revoke", requestId: crypto.randomUUID(), projectId: f.project.id,
      expectedRevision: rev, payload: { monitorId: monitor.id },
    }, f.clock.now));
    const result = f.store.transaction(tx => admitReportAlerts(tx, { projectId: f.project.id, reportId: report.id }, f.clock.now));
    expect(result.admitted).toHaveLength(0);
    expect(result.suppressed[0]!.reason).toBe("monitoring_revoked");
  }
  // new revision
  {
    const f = await fixture();
    const { report, conn, monitor } = await prepareReport(f);
    f.github.pulls = [fixturePull({ number: 1, base: { sha: sha(1), ref: "main" }, head: { sha: sha(99), ref: "feat" } })];
    f.store.transaction(tx => {
      tx.run("UPDATE pr_poll_checkpoints SET record_json = ? WHERE monitor_id = ?",
        JSON.stringify({ monitorId: monitor.id, updatedAt: f.clock.now, complete: false, nextPage: 1, etag: null, lastSeenUpdatedAt: null, reason: null }), monitor.id);
      pollMonitorCatchUp(tx, f.project.id, monitor.id, conn, f.clock.now);
    });
    const result = f.store.transaction(tx => admitReportAlerts(tx, { projectId: f.project.id, reportId: report.id }, f.clock.now));
    expect(result.admitted).toHaveLength(0);
    expect(["revision_changed", "candidate_superseded"].includes(result.suppressed[0]!.reason)).toBe(true);
  }
  // owner rotation
  {
    const f = await fixture();
    const { report } = await prepareReport(f);
    f.store.transaction(tx => { tx.run("UPDATE owner SET generation = generation + 1 WHERE id = 'owner'"); });
    const result = f.store.transaction(tx => admitReportAlerts(tx, { projectId: f.project.id, reportId: report.id }, f.clock.now));
    expect(result.admitted).toHaveLength(0);
    expect(result.suppressed[0]!.reason).toBe("authorization_changed");
  }
});

test("payload hygiene: no secrets or PR destinations", async () => {
  const evil = JSON.stringify({
    findings: [{
      id: "finding-1", title: "leak bot token", category: "correctness", severity: "high",
      location: { path: "a.ts", line: 1 }, condition: "token 12345:AA-SECRET-VALUE here", impact: "i",
      reasoning: "r", evidenceType: "diff", evidenceRef: "a.ts",
    }],
    analyzedRoles: ["correctness", "security"], skippedScope: [], disagreements: [],
  });
  const f = await fixture(() => ({
    ...fixtureOutcome("complete", evil),
    usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 10, outputTokens: 100, retries: 0, wallMs: 10, tokensUnknown: false }, session: null,
  }));
  const { report } = await prepareReport(f);
  // validateFinding flags secret-like content as suspected, so evaluation holds it
  expect(report.findings[0]!.status).toBe("suspected");
  const result = f.store.transaction(tx => admitReportAlerts(tx, { projectId: f.project.id, reportId: report.id }, f.clock.now));
  expect(result.admitted).toHaveLength(0);
  expect(result.held.length + result.suppressed.length).toBeGreaterThan(0);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents")!.n)).toBe(0);

  // Direct payload builder never emits secrets: even a crafted finding throws instead of leaking.
  const clean = await (async () => {
    const g = await fixture();
    const { report: r } = await prepareReport(g);
    const payload = buildAlertPayload({
      repository: r.repository, pullNumber: r.pullNumber, baseSha: r.baseSha, headSha: r.headSha,
      policyVersion: r.policyVersion, reportId: r.id, finding: r.findings.find(q => q.id === "finding-1")!,
      coverageOverall: r.coverageOverall, enumerationComplete: r.enumerationComplete,
    });
    expect(payload).toContain("a.ts");
    expect(payload).not.toMatch(/bot[_ -]?token|[0-9]{5,}:[A-Za-z0-9_-]{8,}/i);
    expect(payload).not.toContain("t.me");
    return payload;
  })();
  void clean;
});

test("read-model states: unknown delivery never delivered on outage", async () => {
  const f = await fixture();
  bindTelegram(f);
  const { report } = await prepareReport(f);
  const admitted = f.store.transaction(tx => admitReportAlerts(tx, { projectId: f.project.id, reportId: report.id }, f.clock.now));
  expect(admitted.admitted).toHaveLength(1);
  const intentId = admitted.admitted[0]!.intent.id;
  f.sender.scripts = ["timeout_after_accept"];
  const worker = new DeliveryWorker(f.store, { sender: f.sender, now: () => f.clock.now });
  workers.push(worker);
  const pumped = worker.pump();
  expect(pumped[0]).toMatchObject({ status: "unknown", remote: "uncertain" });
  // Read model keeps report available and delivery unknown, never delivered.
  const detail = f.app.delivery(f.auth.actor, f.project.id, intentId);
  expect(detail.intent.status).toBe("unknown");
  expect(detail.intent.remote).toBe("uncertain");
  expect(detail.sourceAvailable).toBe(true);
  expect(JSON.stringify(detail).toLowerCase()).not.toContain("delivered");
  const prView = f.app.prReport(f.auth.actor, f.project.id, report.id);
  expect(prView.report.id).toBe(report.id);
  expect(prView.alerts).toHaveLength(1);
  expect(prView.alerts[0]!.status).toBe("unknown");
  // Web JSON + HTML both distinguish unknown.
  const web = createWebHandler(f.app);
  const req = (path: string): Request => new Request(`http://localhost:3000${path}`, { headers: { cookie: `jit_session=${f.token}` } });
  const json = await (await web(req(`/api/projects/${f.project.id}/pr/reports/${report.id}`))).json() as any;
  expect(json.alerts[0].status).toBe("unknown");
  const html = await (await web(req(`/projects/${f.project.id}/pr/reports/${report.id}`))).text();
  expect(html).toContain("unknown");
  expect(f.sender.calls).toBe(1);
  worker.close(); workers.pop();
  // Reopen keeps correct status after restart.
  const reopened = new TransactionStore(f.path); stores.push(reopened);
  const app2 = new Application(reopened, f.config, { now: () => f.clock.now });
  const actor2 = app2.authenticate(f.token).actor;
  expect(app2.prReport(actor2, f.project.id, report.id).alerts[0]!.status).toBe("unknown");
});

test("partial report still alerts with warning; web shows partial scope", async () => {
  const partialJson = JSON.stringify({
    findings: [{
      id: "finding-1", title: "truncated still actionable", category: "correctness", severity: "high",
      location: { path: "only.ts", line: 1 }, condition: "when truncated", impact: "risk",
      reasoning: "partial evidence but actionable", evidenceType: "diff", evidenceRef: "only.ts",
    }],
    analyzedRoles: ["correctness", "security"], skippedScope: [], disagreements: [],
  });
  const f = await fixture(() => ({
    ...fixtureOutcome("complete", partialJson),
    usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 10, outputTokens: 100, retries: 0, wallMs: 10, tokensUnknown: false }, session: null,
  }));
  bindTelegram(f);
  const monitor = enable(f);
  const base = sha(1), head = sha(2);
  f.github.pulls = [fixturePull({ number: 5, base: { sha: base, ref: "main" }, head: { sha: head, ref: "x" } })];
  f.github.files.set(f.github.key(5, base, head), [{ filename: "only.ts", status: "modified", patch: "@@\n+ok", truncated: true }]);
  f.github.checks.set(head, []);
  const conn = connector(f, monitor);
  f.store.transaction(tx => pollMonitorCatchUp(tx, f.project.id, monitor.id, conn, f.clock.now));
  const candidate = f.store.read(tx => readCandidates(tx, f.project.id, monitor.id)[0]!);
  f.store.transaction(tx => captureSnapshot(tx, f.project.id, candidate.id, conn, f.clock.now));
  const revision = f.store.read(tx => tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", f.project.id)!.revision);
  f.app.execute(f.auth.actor, {
    kind: "job.enqueue", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: revision,
    payload: { type: "pr.review", configurationRevision: 1, policyRevision: 1, purpose: "review", inputRevision: revision, input: { monitorId: monitor.id, candidateId: candidate.id }, priority: "background", limits: structuredClone(limits) },
  });
  f.queue.pump(); await f.queue.idle();
  const report = f.store.read(tx => readReport(tx, f.project.id, tx.all<{ record_json: string }>("SELECT record_json FROM pr_reports").map(r => (JSON.parse(r.record_json) as any).id)[0]!));
  expect(report.status).toBe("partial");
  const result = f.store.transaction(tx => admitReportAlerts(tx, { projectId: f.project.id, reportId: report.id }, f.clock.now));
  expect(result.admitted).toHaveLength(1);
  expect(result.admitted[0]!.intent.payload.text).toContain("คำเตือน");
  const web = createWebHandler(f.app);
  const html = await (await web(new Request(`http://localhost:3000/projects/${f.project.id}/pr/reports/${report.id}`, { headers: { cookie: `jit_session=${f.token}` } }))).text();
  expect(html).toContain("partial");
});

test("revisioned dismissal never rewrites history", async () => {
  const f = await fixture();
  const { report } = await prepareReport(f);
  const before = f.app.prReport(f.auth.actor, f.project.id, report.id);
  expect(before.annotations).toHaveLength(0);
  const findingsBefore = JSON.stringify(before.report.findings);
  const receipt = f.app.execute(f.auth.actor, {
    kind: "pr.report.dismiss", requestId: crypto.randomUUID(), projectId: f.project.id,
    expectedRevision: report.revision, payload: { reportId: report.id, reason: "แจ้งพอแล้ว ไม่ต้องส่งซ้ำ" },
  });
  expect(receipt.report.revision).toBe(report.revision + 1);
  expect(receipt.annotation.revision).toBe(report.revision + 1);
  const after = f.app.prReport(f.auth.actor, f.project.id, report.id);
  expect(JSON.stringify(after.report.findings)).toBe(findingsBefore);
  expect(after.annotations).toHaveLength(1);
  expect(after.annotations[0]!.text).toContain("แจ้งพอแล้ว");
  // stale replay rejected
  expect(() => f.app.execute(f.auth.actor, {
    kind: "pr.report.dismiss", requestId: crypto.randomUUID(), projectId: f.project.id,
    expectedRevision: report.revision, payload: { reportId: report.id, reason: "retry" },
  })).toThrow("stale_revision");
  // same requestId replays the same receipt
  const replayId = crypto.randomUUID();
  const first = f.app.execute(f.auth.actor, {
    kind: "pr.report.dismiss", requestId: replayId, projectId: f.project.id,
    expectedRevision: report.revision + 1, payload: { reportId: report.id, reason: "เหตุผลเดิม" },
  });
  const second = f.app.execute(f.auth.actor, {
    kind: "pr.report.dismiss", requestId: replayId, projectId: f.project.id,
    expectedRevision: report.revision + 1, payload: { reportId: report.id, reason: "เหตุผลเดิม" },
  });
  expect(second.annotation.id).toBe(first.annotation.id);
  // Web shows the annotation without rewriting findings.
  const web = createWebHandler(f.app);
  const html = await (await web(new Request(`http://localhost:3000/projects/${f.project.id}/pr/reports/${report.id}`, { headers: { cookie: `jit_session=${f.token}` } }))).text();
  expect(html).toContain("แจ้งพอแล้ว");
  expect(html).not.toContain("postComment");
});

const projectRevision = (f: F) => f.store.read(tx => tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", f.project.id)!.revision);
const intentsOf = (f: F) => f.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence").map(r => JSON.parse(r.record_json) as ReturnType<typeof readDeliveryIntent>));
const resetCheckpoint = (f: F, monitorId: string) => f.store.transaction(tx => tx.run("UPDATE pr_poll_checkpoints SET record_json = ? WHERE monitor_id = ?",
  JSON.stringify({ monitorId, updatedAt: f.clock.now, complete: false, nextPage: 1, etag: null, lastSeenUpdatedAt: null, reason: null }), monitorId));
function worker(f: F) {
  const w = new DeliveryWorker(f.store, { sender: f.sender, now: () => f.clock.now });
  workers.push(w);
  return w;
}
function setPolicy(f: F, expectedRevision: number, payload: { allowedCategories: ("correctness" | "security" | "behavior")[]; minimumSeverity: "info" | "low" | "medium" | "high" | "critical"; notifyPartial: boolean }, requestId: string = crypto.randomUUID()) {
  return f.app.execute(f.auth.actor, { kind: "pr.alert_policy.set", requestId, projectId: f.project.id, expectedRevision, payload });
}
function enqueueReview(f: F, monitorId: string, candidateId: string) {
  const revision = projectRevision(f);
  return f.app.execute(f.auth.actor, {
    kind: "job.enqueue", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: revision,
    payload: { type: "pr.review", configurationRevision: 1, policyRevision: 1, purpose: "review", inputRevision: revision, input: { monitorId, candidateId }, priority: "background", limits: structuredClone(limits) },
  }).job;
}

test("report commit admits alerts transactionally with a stored decision; duplicate processing stays one intent", async () => {
  const f = await fixture();
  const { report, monitor, candidate } = await prepareReport(f);
  // No manual admit call: the pr.review commit produced the intent, link, persisted policy and decision.
  const intents = intentsOf(f);
  expect(intents).toHaveLength(1);
  expect(intents[0]).toMatchObject({ status: "waiting", nextAction: "wait_for_channel_binding", guard: "pr-alert", stale: false });
  expect(intents[0]!.dedupeKey).toBe(alertKey(report, { id: "finding-1" }, 1));
  const policy = f.store.read(tx => readAlertPolicy(tx, f.project.id));
  expect(policy).toMatchObject({ version: 1, persisted: true, requireEvidence: true, requireActionable: true, minimumSeverity: "info", notifyPartial: true });
  const links = f.store.read(tx => readAlertLinks(tx, report.id));
  expect(links).toHaveLength(1);
  expect(links[0]).toMatchObject({ intentId: intents[0]!.id, findingId: "finding-1", headSha: report.headSha, policyVersion: 1 });
  const decisions = f.store.read(tx => readAlertDecisions(tx, report.id));
  expect(decisions).toHaveLength(1);
  expect(decisions[0]!.trigger).toBe("report_commit");
  expect(decisions[0]!.suppressedReason).toBeNull();
  const byId = Object.fromEntries(decisions[0]!.findings.map(d => [d.findingId, d]));
  expect(byId["finding-1"]).toMatchObject({ decision: "notified", intentId: intents[0]!.id });
  expect(byId["finding-2"]).toMatchObject({ decision: "held" });
  expect(byId["finding-3"]).toMatchObject({ decision: "held" });
  expect(links[0]!.decisionId).toBe(decisions[0]!.id);

  // Duplicate processing: owner re-admission and a second review job both dedupe.
  const replay = f.app.admitPrAlerts(f.auth.actor, f.project.id, report.id);
  expect(replay.admitted[0]!.created).toBe(false);
  expect(replay.decision.id).toBe(decisions[0]!.id);
  enqueueReview(f, monitor.id, candidate.id);
  f.queue.pump(); await f.queue.idle();
  expect(intentsOf(f)).toHaveLength(1);
  expect(f.store.read(tx => readAlertDecisions(tx, report.id))).toHaveLength(1);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM pr_reports")!.n)).toBe(1);

  // Owner can inspect why each finding was notified or held.
  const view = f.app.prReport(f.auth.actor, f.project.id, report.id);
  expect(view.decision!.id).toBe(decisions[0]!.id);
  expect(view.policy.version).toBe(1);
  expect(view.alerts[0]!.findingId).toBe("finding-1");
  const web = createWebHandler(f.app);
  const html = await (await web(new Request(`http://localhost:3000/projects/${f.project.id}/pr/reports/${report.id}`, { headers: { cookie: `jit_session=${f.token}` } }))).text();
  expect(html).toContain('data-finding-decision="notified"');
  expect(html).toContain('data-finding-decision="held"');
  expect(html).toContain("category_not_actionable");
  expect(html).toContain('data-delivery="waiting"');
});

test("admission failure never loses the committed report or faults the queue", async () => {
  const f = await fixture();
  const monitor = enable(f);
  const base = sha(1), head = sha(2);
  f.github.pulls = [fixturePull({ number: 1, base: { sha: base, ref: "main" }, head: { sha: head, ref: "feat" } })];
  f.github.files.set(f.github.key(1, base, head), [{ filename: "a.ts", status: "modified", patch: "@@\n+a" }]);
  f.github.checks.set(head, []);
  const conn = connector(f, monitor);
  f.store.transaction(tx => pollMonitorCatchUp(tx, f.project.id, monitor.id, conn, f.clock.now));
  const candidate = f.store.read(tx => readCandidates(tx, f.project.id, monitor.id)[0]!);
  f.store.transaction(tx => captureSnapshot(tx, f.project.id, candidate.id, conn, f.clock.now));
  // A second queue whose review work uses a payload ceiling the outbox rejects.
  f.queue.close(); await f.queue.idle(); queues.pop();
  const review = prReviewWork({ store: f.store, port: f.port, now: () => f.clock.now, alertBytes: 10 });
  const queue = new JobQueue(f.store, f.config.jobs, [review], { now: () => f.clock.now, timers: f.clock.timers });
  queues.push(queue);
  const app = new Application(f.store, f.config, { jobs: queue, now: () => f.clock.now });
  const actor = app.authenticate(f.token).actor;
  const revision = projectRevision(f);
  const job = app.execute(actor, {
    kind: "job.enqueue", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: revision,
    payload: { type: "pr.review", configurationRevision: 1, policyRevision: 1, purpose: "review", inputRevision: revision, input: { monitorId: monitor.id, candidateId: candidate.id }, priority: "background", limits: structuredClone(limits) },
  }).job;
  queue.pump(); await queue.idle();
  expect(app.job(actor, f.project.id, job.id).state).toBe("succeeded");
  const reportId = f.store.read(tx => tx.get<{ id: string }>("SELECT id FROM pr_reports")!.id);
  expect(intentsOf(f)).toHaveLength(0);
  const decision = f.store.read(tx => readAlertDecisions(tx, reportId)).at(-1)!;
  expect(decision.findings.find(d => d.findingId === "finding-1")).toMatchObject({ decision: "held", reason: "admission_failed" });
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_reports")!.n)).toBe(0);
});

test("send-time recheck: admission then drift then send attempt never sends a stale alert", async () => {
  // Hook-free drift (closed directly in storage) is caught by the outbox guard immediately before send.
  {
    const f = await fixture();
    bindTelegram(f);
    const { candidate } = await prepareReport(f);
    expect(intentsOf(f)[0]!.status).toBe("queued");
    f.store.transaction(tx => {
      const row = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM pr_candidates WHERE id = ?", candidate.id)!.record_json);
      row.status = "closed"; row.state = "closed";
      tx.run("UPDATE pr_candidates SET status = 'closed', record_json = ? WHERE id = ?", JSON.stringify(row), candidate.id);
    });
    const results = worker(f).pump();
    expect(results).toHaveLength(0);
    expect(f.sender.calls).toBe(0);
    expect(intentsOf(f)[0]).toMatchObject({ status: "cancelled", stale: true, staleReason: "pr_closed", remote: "none" });
  }
  // New revision via poll: supersede hook retires the pending intent; send is never attempted.
  {
    const f = await fixture();
    bindTelegram(f);
    const { report, monitor, conn } = await prepareReport(f);
    f.github.pulls = [fixturePull({ number: 1, base: { sha: sha(1), ref: "main" }, head: { sha: sha(99), ref: "feat" } })];
    resetCheckpoint(f, monitor.id);
    f.store.transaction(tx => pollMonitorCatchUp(tx, f.project.id, monitor.id, conn, f.clock.now));
    expect(intentsOf(f)[0]).toMatchObject({ status: "cancelled", stale: true, staleReason: "candidate_superseded" });
    worker(f).pump();
    expect(f.sender.calls).toBe(0);
    const view = f.app.prReport(f.auth.actor, f.project.id, report.id);
    expect(view.report.stale).toBe(true);
    const web = createWebHandler(f.app);
    const html = await (await web(new Request(`http://localhost:3000/projects/${f.project.id}/pr/reports/${report.id}`, { headers: { cookie: `jit_session=${f.token}` } }))).text();
    expect(html).toContain('data-state="stale"');
    expect(html).toContain("ไม่ใช่ผลล่าสุด");
  }
  // Revoked monitoring retires; paused monitoring holds until resume, then sends once.
  {
    const f = await fixture();
    bindTelegram(f);
    const { monitor } = await prepareReport(f);
    f.store.transaction(tx => mutateMonitor(tx, { kind: "pr.monitor.pause", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: projectRevision(f), payload: { monitorId: monitor.id } }, f.clock.now));
    const w = worker(f);
    expect(w.pump()).toHaveLength(0);
    expect(f.sender.calls).toBe(0);
    expect(intentsOf(f)[0]).toMatchObject({ status: "waiting", nextAction: "wait_for_current_source", stale: false });
    f.store.transaction(tx => mutateMonitor(tx, { kind: "pr.monitor.resume", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: projectRevision(f), payload: { monitorId: monitor.id } }, f.clock.now));
    f.clock.now += 120_000; // the paused claim's lease expires before the next claim
    const sent = w.pump();
    expect(sent.map(i => i.status)).toEqual(["sent"]);
    expect(f.sender.calls).toBe(1);
    // Revoke after send keeps the sent outcome but marks it visibly stale.
    f.store.transaction(tx => mutateMonitor(tx, { kind: "pr.monitor.revoke", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: projectRevision(f), payload: { monitorId: monitor.id } }, f.clock.now));
    expect(intentsOf(f)[0]).toMatchObject({ status: "sent", remote: "accepted", stale: true, staleReason: "monitoring_revoked" });
  }
  // Revoke before send retires the pending intent.
  {
    const f = await fixture();
    bindTelegram(f);
    const { monitor } = await prepareReport(f);
    f.store.transaction(tx => mutateMonitor(tx, { kind: "pr.monitor.revoke", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: projectRevision(f), payload: { monitorId: monitor.id } }, f.clock.now));
    expect(intentsOf(f)[0]).toMatchObject({ status: "cancelled", stale: true, staleReason: "monitoring_revoked" });
    worker(f).pump();
    expect(f.sender.calls).toBe(0);
  }
  // Waiting for a channel, then drift, then binding: the late-bound channel never receives the old alert.
  {
    const f = await fixture();
    const { candidate } = await prepareReport(f);
    expect(intentsOf(f)[0]!.status).toBe("waiting");
    f.store.transaction(tx => {
      const row = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM pr_candidates WHERE id = ?", candidate.id)!.record_json);
      row.status = "superseded";
      tx.run("UPDATE pr_candidates SET status = 'superseded', record_json = ? WHERE id = ?", JSON.stringify(row), candidate.id);
    });
    bindTelegram(f);
    worker(f).pump();
    expect(f.sender.calls).toBe(0);
    expect(intentsOf(f)[0]).toMatchObject({ status: "cancelled", stale: true, staleReason: "candidate_superseded" });
  }
  // New revision lands while the send is in flight: the accepted result stays recorded but is stale.
  {
    const f = await fixture();
    bindTelegram(f);
    const { monitor, conn } = await prepareReport(f);
    let fired = false;
    f.sender.hook = () => {
      if (fired) return;
      fired = true;
      f.github.pulls = [fixturePull({ number: 1, base: { sha: sha(1), ref: "main" }, head: { sha: sha(77), ref: "feat" } })];
      resetCheckpoint(f, monitor.id);
      f.store.transaction(tx => pollMonitorCatchUp(tx, f.project.id, monitor.id, conn, f.clock.now));
    };
    const [result] = worker(f).pump();
    expect(result).toMatchObject({ status: "sent", remote: "accepted", stale: true, staleReason: "candidate_superseded" });
    expect(f.sender.calls).toBe(1);
  }
});

test("restart keeps unknown delivery and the reopened worker still rechecks before send", async () => {
  const f = await fixture();
  bindTelegram(f);
  const { report } = await prepareReport(f);
  f.sender.scripts = ["timeout_after_accept"];
  const w = worker(f);
  expect(w.pump()[0]).toMatchObject({ status: "unknown", remote: "uncertain" });
  w.close(); workers.pop();
  const reopened = new TransactionStore(f.path); stores.push(reopened);
  const app2 = new Application(reopened, f.config, { now: () => f.clock.now });
  const actor2 = app2.authenticate(f.token).actor;
  expect(app2.prReport(actor2, f.project.id, report.id).alerts[0]).toMatchObject({ status: "unknown", remote: "uncertain" });
  expect(JSON.stringify(app2.prReport(actor2, f.project.id, report.id).alerts).toLowerCase()).not.toContain("delivered");
  // Unknown is never resent automatically after restart.
  const w2 = new DeliveryWorker(reopened, { sender: f.sender, now: () => f.clock.now }); workers.push(w2);
  expect(w2.pump()).toHaveLength(0);
  expect(f.sender.calls).toBe(1);
  w2.close(); workers.pop();

  // A queued alert that drifts while the service is down is retired by the reopened worker, never sent.
  const g = await fixture();
  bindTelegram(g);
  const { candidate } = await prepareReport(g);
  expect(intentsOf(g)[0]!.status).toBe("queued");
  g.store.transaction(tx => {
    const row = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM pr_candidates WHERE id = ?", candidate.id)!.record_json);
    row.status = "closed"; row.state = "closed";
    tx.run("UPDATE pr_candidates SET status = 'closed', record_json = ? WHERE id = ?", JSON.stringify(row), candidate.id);
  });
  g.queue.close(); await g.queue.idle(); queues.splice(queues.indexOf(g.queue), 1);
  g.store.close(); stores.splice(stores.indexOf(g.store), 1);
  const back = new TransactionStore(g.path); stores.push(back);
  const w3 = new DeliveryWorker(back, { sender: g.sender, now: () => g.clock.now }); workers.push(w3);
  expect(w3.pump()).toHaveLength(0);
  expect(g.sender.calls).toBe(0);
  expect(back.read(tx => JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents")!.record_json))).toMatchObject({ status: "cancelled", stale: true, staleReason: "pr_closed" });
});

test("unregistered delivery guard fails closed: the intent waits instead of sending", async () => {
  const f = await fixture();
  bindTelegram(f);
  f.store.transaction(tx => commitDeliveryIntent(tx, { projectId: f.project.id, kind: "report", text: "guarded fixture", dedupeKey: "guarded/fixture-0001", maxBytes: 4000, guard: "unregistered-x" }, f.clock.now));
  expect(worker(f).pump()).toHaveLength(0);
  expect(f.sender.calls).toBe(0);
  expect(intentsOf(f)[0]).toMatchObject({ status: "waiting", nextAction: "wait_for_current_source" });
});

test("versioned owner-adjustable policy: persisted revisions, retire, re-evaluate, no duplicate notification", async () => {
  const f = await fixture();
  bindTelegram(f);
  const { report } = await prepareReport(f);
  const first = intentsOf(f)[0]!;
  expect(first.status).toBe("queued");
  // Evidence/actionability cannot be disabled and non-notifiable categories are rejected.
  expect(() => setPolicy(f, 1, { allowedCategories: ["style" as "security"], minimumSeverity: "info", notifyPartial: true })).toThrow("invalid_alert_policy");
  expect(() => f.app.execute(f.auth.actor, { kind: "pr.alert_policy.set", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: 1,
    payload: { allowedCategories: ["security"], minimumSeverity: "info", notifyPartial: true, requireEvidence: false } as any })).toThrow("invalid_alert_policy");
  // v2: security only -> the pending correctness alert is retired and the stored decision explains why.
  const requestId = crypto.randomUUID();
  const v2 = setPolicy(f, 1, { allowedCategories: ["security"], minimumSeverity: "info", notifyPartial: true }, requestId);
  expect(v2.policy.version).toBe(2);
  expect(v2.previousVersion).toBe(1);
  expect(v2.retiredIntentIds).toEqual([first.id]);
  expect(intentsOf(f)[0]).toMatchObject({ status: "cancelled", staleReason: "alert_policy_changed" });
  expect(v2.decisions[0]!.findings.find(d => d.findingId === "finding-1")).toMatchObject({ decision: "held", reason: "category_not_notifiable" });
  expect(v2.decisions[0]!.trigger).toBe("policy_change");
  // Replay returns the same receipt; a stale revision is rejected.
  expect(setPolicy(f, 1, { allowedCategories: ["security"], minimumSeverity: "info", notifyPartial: true }, requestId).policy.version).toBe(2);
  expect(() => setPolicy(f, 1, { allowedCategories: ["correctness"], minimumSeverity: "info", notifyPartial: true })).toThrow("stale_revision");
  // v3: severity floor above the finding holds it; severity alone never makes a finding notify.
  const v3 = setPolicy(f, 2, { allowedCategories: ["correctness", "security", "behavior"], minimumSeverity: "critical", notifyPartial: true });
  expect(v3.decisions[0]!.findings.find(d => d.findingId === "finding-1")).toMatchObject({ decision: "held", reason: "severity_below_minimum" });
  expect(v3.decisions[0]!.findings.find(d => d.findingId === "finding-3")!.decision).toBe("held");
  // v4: back to defaults -> one new logical intent for finding-1, sent once.
  const v4 = setPolicy(f, 3, { allowedCategories: ["correctness", "security", "behavior"], minimumSeverity: "info", notifyPartial: true });
  expect(v4.decisions[0]!.findings.find(d => d.findingId === "finding-1")!.decision).toBe("notified");
  const second = intentsOf(f)[1]!;
  expect(second.dedupeKey).toBe(alertKey(report, { id: "finding-1" }, 4));
  const w = worker(f);
  expect(w.pump().map(i => i.status)).toEqual(["sent"]);
  // v5: unchanged categories -> finding-1 is already notified; no duplicate intent.
  const v5 = setPolicy(f, 4, { allowedCategories: ["security", "correctness", "behavior"], minimumSeverity: "low", notifyPartial: false });
  expect(v5.decisions[0]!.findings.find(d => d.findingId === "finding-1")).toMatchObject({ decision: "already_notified", intentId: second.id });
  expect(intentsOf(f)).toHaveLength(2);
  expect(f.store.read(tx => tx.all("SELECT version FROM pr_alert_policies WHERE project_id = ? ORDER BY version", f.project.id))).toEqual([1, 2, 3, 4, 5].map(version => ({ version })));
  // Web exposes and adjusts the policy through the owner session, Origin and CSRF.
  const web = createWebHandler(f.app);
  const state = await (await web(new Request(`http://localhost:3000/api/projects/${f.project.id}/pr/alert-policy`, { headers: { cookie: `jit_session=${f.token}` } }))).json() as any;
  expect(state.policy).toMatchObject({ version: 5, minimumSeverity: "low", notifyPartial: false });
  const csrf = f.app.authenticate(f.token).csrf;
  const posted = await web(new Request(`http://localhost:3000/projects/${f.project.id}/pr/alert-policy`, {
    method: "POST",
    headers: { cookie: `jit_session=${f.token}`, origin: f.config.origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf, requestId: crypto.randomUUID(), expectedRevision: "5", cat_security: "on", minimumSeverity: "info" }).toString(),
  }));
  expect(posted.status).toBe(303);
  expect(f.store.read(tx => readAlertPolicy(tx, f.project.id))).toMatchObject({ version: 6, allowedCategories: ["security"], notifyPartial: false });
  const list = await (await web(new Request(`http://localhost:3000/projects/${f.project.id}/pr/reports`, { headers: { cookie: `jit_session=${f.token}` } }))).text();
  expect(list).toContain("นโยบายแจ้งเตือน v6");
});

test("dismissal feeds admission and send without rewriting evidence or learning facts", async () => {
  // Whole-report dismissal retires the pending alert and later admission suppresses.
  {
    const f = await fixture();
    bindTelegram(f);
    const { report } = await prepareReport(f);
    const memoryBefore = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM memory_claims")!.n);
    const decisionId = f.store.read(tx => readAlertDecisions(tx, report.id)).at(-1)!.id;
    const receipt = f.app.execute(f.auth.actor, {
      kind: "pr.report.dismiss", requestId: crypto.randomUUID(), projectId: f.project.id,
      expectedRevision: report.revision, payload: { reportId: report.id, reason: "ไม่ต้องแจ้งรายงานนี้" },
    });
    expect(receipt.annotation).toMatchObject({ findingId: null, decisionId });
    expect(intentsOf(f)[0]).toMatchObject({ status: "cancelled", staleReason: "report_dismissed" });
    const again = f.app.admitPrAlerts(f.auth.actor, f.project.id, report.id);
    expect(again.admitted).toHaveLength(0);
    expect(again.suppressed[0]!.reason).toBe("report_dismissed");
    expect(again.decision.suppressedReason).toBe("report_dismissed");
    worker(f).pump();
    expect(f.sender.calls).toBe(0);
    const after = f.app.prReport(f.auth.actor, f.project.id, report.id);
    expect(JSON.stringify(after.report.findings)).toBe(JSON.stringify(report.findings));
    expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM memory_claims")!.n)).toBe(memoryBefore);
  }
  // Finding-level dismissal through the web form; unknown findings are rejected.
  {
    const f = await fixture();
    bindTelegram(f);
    const { report } = await prepareReport(f);
    expect(() => f.app.execute(f.auth.actor, {
      kind: "pr.report.dismiss", requestId: crypto.randomUUID(), projectId: f.project.id,
      expectedRevision: report.revision, payload: { reportId: report.id, reason: "x", findingId: "finding-404" },
    })).toThrow("pr_finding_not_found");
    const web = createWebHandler(f.app);
    const csrf = f.app.authenticate(f.token).csrf;
    const posted = await web(new Request(`http://localhost:3000/projects/${f.project.id}/pr/reports/${report.id}`, {
      method: "POST",
      headers: { cookie: `jit_session=${f.token}`, origin: f.config.origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, requestId: crypto.randomUUID(), expectedRevision: String(report.revision), reason: "รู้แล้ว", findingId: "finding-1" }).toString(),
    }));
    expect(posted.status).toBe(303);
    expect(intentsOf(f)[0]).toMatchObject({ status: "cancelled", staleReason: "finding_dismissed" });
    const again = f.app.admitPrAlerts(f.auth.actor, f.project.id, report.id);
    expect(again.held.find(h => h.findingId === "finding-1")!.reason).toBe("finding_dismissed");
    expect(f.app.prReport(f.auth.actor, f.project.id, report.id).annotations[0]).toMatchObject({ kind: "dismiss", findingId: "finding-1" });
    worker(f).pump();
    expect(f.sender.calls).toBe(0);
  }
});

test("payload carries a service-owned report link, redacts PR-supplied destinations and fits the byte budget", async () => {
  const f = await fixture();
  const { report } = await prepareReport(f);
  const finding = { ...report.findings.find(q => q.id === "finding-1")!, condition: `เมื่อ input ว่าง ดู https://evil.example/x ${"ก".repeat(3000)}`, impact: "ผลกระทบ ".repeat(500) };
  const text = buildAlertPayload({
    repository: report.repository, pullNumber: report.pullNumber, baseSha: report.baseSha, headSha: report.headSha,
    policyVersion: report.policyVersion, reportId: report.id, finding, coverageOverall: "partial", enumerationComplete: true,
    projectId: f.project.id, maxBytes: 4000,
  });
  expect(Buffer.byteLength(text)).toBeLessThanOrEqual(3500);
  expect(text).toContain(`รายงาน: /projects/${f.project.id}/pr/reports/${report.id}`);
  expect(text).toContain("คำเตือน");
  expect(text).not.toContain("evil.example");
  expect(text).toContain("acme/widgets#1");
  const stored = intentsOf(f)[0]!.payload.text;
  expect(stored).toContain(`/projects/${f.project.id}/pr/reports/${report.id}`);
  expect(stored).toContain("ผลกระทบ: crash");
});

test("web separates not-reviewed, running, no-findings and delivery queued/sent/failed", async () => {
  const clean = JSON.stringify({
    findings: [{ id: "finding-1", title: "nit", category: "style", severity: "low", location: { path: "a.ts", line: 1 }, condition: "c", impact: "i", reasoning: "r", evidenceType: "diff", evidenceRef: "a.ts" }],
    analyzedRoles: ["correctness", "security"], skippedScope: [], disagreements: [],
  });
  {
    const f = await fixture(() => ({ ...fixtureOutcome("complete", clean), usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 10, outputTokens: 100, retries: 0, wallMs: 10, tokensUnknown: false }, session: null }));
    const monitor = enable(f);
    f.github.pulls = [fixturePull({ number: 9, base: { sha: sha(1), ref: "main" }, head: { sha: sha(2), ref: "feat" } })];
    f.github.files.set(f.github.key(9, sha(1), sha(2)), [{ filename: "a.ts", status: "modified", patch: "@@\n+a" }]);
    f.github.checks.set(sha(2), []);
    const conn = connector(f, monitor);
    f.store.transaction(tx => pollMonitorCatchUp(tx, f.project.id, monitor.id, conn, f.clock.now));
    const web = createWebHandler(f.app);
    const get = async (path: string) => (await web(new Request(`http://localhost:3000${path}`, { headers: { cookie: `jit_session=${f.token}` } }))).text();
    expect(await get(`/projects/${f.project.id}/pr/reports`)).toContain('data-state="not_reviewed"');
    const candidate = f.store.read(tx => readCandidates(tx, f.project.id, monitor.id)[0]!);
    f.store.transaction(tx => captureSnapshot(tx, f.project.id, candidate.id, conn, f.clock.now));
    enqueueReview(f, monitor.id, candidate.id);
    expect(await get(`/projects/${f.project.id}/pr/reports`)).toContain('data-state="running"');
    f.queue.pump(); await f.queue.idle();
    const list = await get(`/projects/${f.project.id}/pr/reports`);
    expect(list).toContain('data-state="no_findings"');
    expect(list).not.toContain('data-state="running"');
    const reportId = f.store.read(tx => tx.get<{ id: string }>("SELECT id FROM pr_reports")!.id);
    expect(await get(`/projects/${f.project.id}/pr/reports/${reportId}`)).toContain("ยังไม่มีคำขอส่งสำหรับรายงานนี้");
  }
  {
    const f = await fixture();
    bindTelegram(f);
    const { report } = await prepareReport(f);
    const web = createWebHandler(f.app);
    const get = async () => (await web(new Request(`http://localhost:3000/projects/${f.project.id}/pr/reports/${report.id}`, { headers: { cookie: `jit_session=${f.token}` } }))).text();
    expect(await get()).toContain('data-delivery="queued"');
    f.sender.scripts = ["reject"];
    worker(f).pump();
    expect(await get()).toContain('data-delivery="failed"');
  }
  {
    const f = await fixture();
    bindTelegram(f);
    const { report } = await prepareReport(f);
    worker(f).pump();
    const html = await (await createWebHandler(f.app)(new Request(`http://localhost:3000/projects/${f.project.id}/pr/reports/${report.id}`, { headers: { cookie: `jit_session=${f.token}` } }))).text();
    expect(html).toContain('data-delivery="sent"');
    expect(html).toContain('data-state="findings"');
  }
});
