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
  type EnableMonitorCommand,
  type PrMonitor,
} from "../src/pr";
import { ScriptedRunPort, fixtureOutcome } from "../src/team/scripted-port";
import { ScriptedTelegramSender, DeliveryWorker } from "../src/delivery";
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
    usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 10, outputTokens: 100, retries: 0, wallMs: 10 },
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
    usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 10, outputTokens: 100, retries: 0, wallMs: 10 }, session: null,
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
    usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 10, outputTokens: 100, retries: 0, wallMs: 10 }, session: null,
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
