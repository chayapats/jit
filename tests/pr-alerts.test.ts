import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Application } from "../src/application";
import { MIN_MESSAGE_BYTES, readConfig } from "../src/config";
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
  normalizeReviewOutput,
  persistReport,
  readCandidates,
  readReport,
  admitReportAlerts,
  alertKey,
  buildAlertPayload,
  findingFingerprint,
  ALERT_FIELD_RESERVE_BYTES,
  evaluateReport,
  ALERT_POLICY_VERSION,
  DEFAULT_ALERT_POLICY,
  quarantineLegacyPrAlerts,
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
import { containsCredential, redactCredentials } from "../src/security/credentials";
import { neutralizeDestinations } from "../src/security/destinations";
import { prepareServiceState } from "../src/bootstrap";
import { captureBackupImage } from "../src/ops/backup";
import { retirePrSnapshot } from "../src/pr/fence";
import { readFileSync } from "node:fs";

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
  f.github.files.set(f.github.key(1, base, head), [{ filename: "a.ts", status: "modified", patch: "@@ -1,1 +1,40 @@\n+a" }]);
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
    // PR-supplied file names are defanged so a client cannot autolink them as hosts.
    expect(payload).toContain("ที่: a[.]ts:10");
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
  f.github.files.set(f.github.key(5, base, head), [{ filename: "only.ts", status: "modified", patch: "@@ -1,1 +1,40 @@\n+ok", truncated: true }]);
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
  // A second review attempt commits a newer report (#19): the older report's pending alert is retired
  // and only the current report's alert stays live.
  enqueueReview(f, monitor.id, candidate.id);
  f.queue.pump(); await f.queue.idle();
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM pr_reports")!.n)).toBe(2);
  const all = intentsOf(f);
  expect(all).toHaveLength(2);
  expect(all[0]).toMatchObject({ id: intents[0]!.id, status: "cancelled", stale: true, staleReason: "superseded_by_newer_review" });
  expect(all.filter(i => i.status !== "cancelled")).toHaveLength(1);
  expect(f.store.read(tx => readAlertDecisions(tx, report.id))).toHaveLength(1);
  expect(f.app.admitPrAlerts(f.auth.actor, f.project.id, report.id).suppressed[0]!.reason).toBe("superseded_by_newer_review");
});

test("admission failure never loses the committed report or faults the queue", async () => {
  const f = await fixture();
  const monitor = enable(f);
  const base = sha(1), head = sha(2);
  f.github.pulls = [fixturePull({ number: 1, base: { sha: base, ref: "main" }, head: { sha: head, ref: "feat" } })];
  f.github.files.set(f.github.key(1, base, head), [{ filename: "a.ts", status: "modified", patch: "@@ -1,1 +1,40 @@\n+a" }]);
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
    f.github.files.set(f.github.key(9, sha(1), sha(2)), [{ filename: "a.ts", status: "modified", patch: "@@ -1,1 +1,40 @@\n+a" }]);
    f.github.checks.set(sha(2), []);
    const conn = connector(f, monitor);
    f.store.transaction(tx => pollMonitorCatchUp(tx, f.project.id, monitor.id, conn, f.clock.now));
    const web = createWebHandler(f.app);
    const get = async (path: string) => (await web(new Request(`http://localhost:3000${path}`, { headers: { cookie: `jit_session=${f.token}` } }))).text();
    expect(await get(`/projects/${f.project.id}/pr/reports`)).toContain('data-review-state="not_reviewed"');
    const candidate = f.store.read(tx => readCandidates(tx, f.project.id, monitor.id)[0]!);
    f.store.transaction(tx => captureSnapshot(tx, f.project.id, candidate.id, conn, f.clock.now));
    enqueueReview(f, monitor.id, candidate.id);
    expect(await get(`/projects/${f.project.id}/pr/reports`)).toContain('data-review-state="running"');
    f.queue.pump(); await f.queue.idle();
    const list = await get(`/projects/${f.project.id}/pr/reports`);
    expect(list).toContain('data-state="no_findings"');
    expect(list).not.toContain('data-review-state="running"');
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

const scripted = (json: string) => () => ({
  ...fixtureOutcome("complete", json),
  usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 10, outputTokens: 100, retries: 0, wallMs: 10, tokensUnknown: false }, session: null,
});
const oneFinding = (overrides: Record<string, unknown>) => JSON.stringify({
  findings: [{
    id: "finding-1", title: "null deref", category: "correctness", severity: "high", location: { path: "a.ts", line: 10 },
    condition: "when input empty", impact: "crash", reasoning: "unchecked access", evidenceType: "diff", evidenceRef: "a.ts", ...overrides,
  }],
  analyzedRoles: ["correctness", "security"], skippedScope: [], disagreements: [],
});

test("shared credential detector: provider tokens never reach findings, outbox, delivery reports or payloads", async () => {
  const fixtures = [
    "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv", "xai-AbCdEfGhIjKlMnOpQrStUvWx",
    "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "github_pat_11ABCDEFG0123456789_abcdefghijklmnop", "glpat-AbCdEfGhIjKlMnOpQrSt",
    "xoxb-1234567890-abcdefghij", "sk_live_AbCdEfGhIjKlMnOpQrSt", "AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456",
    "ya29.AbCdEfGhIjKlMnOpQrStUvWx", "AKIAABCDEFGHIJKLMNOP", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", "Authorization: Bearer abc.def", "https://user:hunter2@example.com/x",
    "api_key = 'AbCdEfGh12345678'", "123456789:AA-SECRET-VALUE-xyz",
  ];
  for (const value of fixtures) {
    expect(containsCredential(`context ${value} tail`)).toBe(true);
    expect(redactCredentials(`context ${value} tail`)).not.toContain(value.slice(0, 24));
  }
  expect(containsCredential("returns the token count for the session")).toBe(false);
  const token = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789";
  const f = await fixture(scripted(oneFinding({ condition: `config sets ${token} in a.ts` })));
  bindTelegram(f);
  const { report } = await prepareReport(f);
  expect(report.findings[0]).toMatchObject({ status: "suspected" });
  expect(report.findings[0]!.validationErrors).toContain("payload_hygiene_secret");
  expect(intentsOf(f)).toHaveLength(0);
  const outbound = f.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM delivery_reports").map(r => r.record_json).join("\n"));
  expect(outbound).not.toContain("sk-proj");
  expect(() => buildAlertPayload({
    repository: report.repository, pullNumber: 1, baseSha: report.baseSha, headSha: report.headSha, policyVersion: 1, reportId: report.id,
    finding: { ...report.findings[0]!, condition: "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789" }, coverageOverall: "complete", enumerationComplete: true,
  })).toThrow("invalid_delivery_payload");
  expect(() => f.store.transaction(tx => commitDeliveryIntent(tx, { projectId: f.project.id, kind: "report", text: `note xai-AbCdEfGhIjKlMnOpQrStUvWx`, dedupeKey: "owner/credential-0001", maxBytes: 4000 }, f.clock.now))).toThrow("invalid_delivery_payload");
});

test("every PR-supplied destination form is removed or defanged; only the service report path remains", async () => {
  const f = await fixture();
  const { report } = await prepareReport(f);
  const finding = {
    ...report.findings.find(q => q.id === "finding-1")!,
    title: "[click me](https://x.io/a) now",
    condition: "see evil.com/phish and //attacker.com/x plus <https://y.org> mailto:a@b.co ftp://files.example tg://resolve?domain=x",
    impact: "visit www.z.net or bad.example:8443 or plain evil.org or 10.0.0.1 or t.me/joinchat/abc or user@mail.io",
    evidenceRef: "a.ts",
  };
  const text = buildAlertPayload({
    repository: report.repository, pullNumber: report.pullNumber, baseSha: report.baseSha, headSha: report.headSha,
    policyVersion: 1, reportId: report.id, finding, coverageOverall: "complete", enumerationComplete: true, projectId: f.project.id,
  });
  for (const leak of ["x.io", "evil.com", "attacker.com", "y.org", "a@b.co", "files.example", "tg://", "z.net", "bad.example", "evil.org", "10.0.0.1", "t.me", "mail.io", "https://"]) {
    expect(text).not.toContain(leak);
  }
  expect(text).toContain("click me");
  expect(text.split("\n").filter(line => line.includes("/projects/"))).toEqual([`รายงาน: /projects/${f.project.id}/pr/reports/${report.id}`]);
  expect(neutralizeDestinations("// comment and src/pr/alerts.ts")).toBe("// comment and src/pr/alerts[.]ts");
});

test("repeated finding IDs are canonicalized before persistence and never cancel the valid alert", async () => {
  const dup = JSON.stringify({
    findings: [
      { id: "dup-1", title: "first", category: "correctness", severity: "critical", location: { path: "a.ts", line: 1 }, condition: "c1", impact: "i1", reasoning: "r1", evidenceType: "diff", evidenceRef: "a.ts" },
      { id: "dup-1", title: "second", category: "correctness", severity: "low", location: { path: "a.ts", line: 2 }, condition: "c2", impact: "i2", reasoning: "r2", evidenceType: "diff", evidenceRef: "a.ts" },
      { id: "dup-1", title: "third", category: "style", severity: "info", location: { path: "a.ts", line: 3 }, condition: "c3", impact: "i3", reasoning: "r3", evidenceType: "diff", evidenceRef: "a.ts" },
    ],
    analyzedRoles: ["correctness", "security"], skippedScope: [], disagreements: [],
  });
  const f = await fixture(scripted(dup));
  bindTelegram(f);
  const { report } = await prepareReport(f);
  expect(report.findings.map(x => x.id)).toEqual(["dup-1", "dup-1-dup2", "dup-1-dup3"]);
  // Each copy keeps its own validated status; the group identity is persisted.
  expect(report.findings.map(x => x.status)).toEqual(["actionable", "actionable", "suspected"]);
  expect(report.findings.every(x => x.duplicateGroup === "dup-1")).toBe(true);
  const decision = f.store.read(tx => readAlertDecisions(tx, report.id)).at(-1)!;
  expect(new Set(decision.findings.map(d => d.findingId)).size).toBe(decision.findings.length);
  expect(decision.findings.find(d => d.findingId === "dup-1")!.decision).toBe("notified");
  expect(decision.findings.find(d => d.findingId === "dup-1-dup2")).toMatchObject({ decision: "held", reason: "duplicate_finding_id" });
  // Raising the floor above the duplicate's severity does not affect the canonical alert.
  setPolicy(f, 1, { allowedCategories: ["correctness", "security", "behavior"], minimumSeverity: "medium", notifyPartial: true });
  expect(intentsOf(f)).toHaveLength(1);
  expect(worker(f).pump().map(i => i.status)).toEqual(["sent"]);
  expect(f.sender.calls).toBe(1);

  // A legacy stored report that still repeats an ID holds every copy and never sends.
  const g = await fixture();
  bindTelegram(g);
  const { report: legacy } = await prepareReport(g);
  g.store.transaction(tx => {
    const row = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM pr_reports WHERE id = ?", legacy.id)!.record_json);
    row.findings = [{ ...row.findings[0], severity: "low", status: "suspected", validationErrors: ["category_not_actionable"] }, row.findings[0]];
    tx.run("UPDATE pr_reports SET record_json = ? WHERE id = ?", JSON.stringify(row), legacy.id);
  });
  worker(g).pump();
  expect(g.sender.calls).toBe(0);
  expect(intentsOf(g)[0]).toMatchObject({ status: "cancelled", staleReason: "duplicate_finding_id" });
  const again = g.app.admitPrAlerts(g.auth.actor, g.project.id, legacy.id);
  expect(again.held.filter(h => h.reason === "duplicate_finding_id")).toHaveLength(2);
});

test("policy update re-evaluates every current report without a silent cap", async () => {
  const f = await fixture();
  const monitor = enable(f);
  const count = 55;
  const base = sha(1), head = sha(2);
  f.github.pulls = Array.from({ length: count }, (_, i) => fixturePull({ number: i + 1, base: { sha: base, ref: "main" }, head: { sha: head, ref: `f${i}` } }));
  for (let i = 1; i <= count; i++) f.github.files.set(f.github.key(i, base, head), [{ filename: "a.ts", status: "modified", patch: "@@ -1,1 +1,40 @@\n+a" }]);
  f.github.checks.set(head, []);
  const conn = connector(f, monitor);
  const polled = f.store.transaction(tx => pollMonitorCatchUp(tx, f.project.id, monitor.id, conn, f.clock.now));
  expect(polled.created).toHaveLength(count);
  const candidates = f.store.read(tx => readCandidates(tx, f.project.id, monitor.id));
  expect(candidates).toHaveLength(count);
  for (const candidate of candidates) {
    const snapshot = f.store.transaction(tx => captureSnapshot(tx, f.project.id, candidate.id, conn, f.clock.now))!;
    f.store.transaction(tx => persistReport(tx, {
      projectId: f.project.id, monitorId: monitor.id, candidateId: candidate.id, snapshot,
      normalized: normalizeReviewOutput(goodFindingsJson(), snapshot), requiredRoles: ["correctness", "security"],
      specialistRuns: [{ role: "correctness", state: "complete", reason: null }, { role: "security", state: "complete", reason: null }],
      synthesis: { state: "complete", reason: null }, jobId: null, attemptId: null, now: f.clock.now,
    }));
  }
  // Direct persistence has no transmitted manifest (#19 marks it incomplete); model the job-committed
  // complete result so every report is a current, alertable one.
  f.store.transaction(tx => {
    for (const row of tx.all<{ id: string; record_json: string }>("SELECT id, record_json FROM pr_reports")) {
      const record = JSON.parse(row.record_json);
      record.status = "complete_findings";
      tx.run("UPDATE pr_reports SET status = 'complete_findings', record_json = ? WHERE id = ?", JSON.stringify(record), row.id);
    }
  });
  expect(intentsOf(f)).toHaveLength(0);
  const receipt = setPolicy(f, 1, { allowedCategories: ["correctness"], minimumSeverity: "info", notifyPartial: true });
  expect(receipt.decisions).toHaveLength(count);
  expect(intentsOf(f)).toHaveLength(count);
  const oldest = f.store.read(tx => tx.get<{ id: string }>("SELECT id FROM pr_reports ORDER BY rowid LIMIT 1")!.id);
  expect(f.store.read(tx => readAlertDecisions(tx, oldest))).toHaveLength(1);
});

test("legacy guardless pr-alert intents fail closed: verifiable ones are backfilled, others cancelled visibly", async () => {
  const legacyize = (f: F, intentId: string, text?: string) => f.store.transaction(tx => {
    tx.run("DELETE FROM pr_alerts WHERE intent_id = ?", intentId);
    const row = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE id = ?", intentId)!.record_json);
    delete row.guard;
    if (text !== undefined) { row.payload.text = text; }
    tx.run("UPDATE delivery_intents SET record_json = ? WHERE id = ?", JSON.stringify(row), intentId);
  });
  const legacyText = (r: Awaited<ReturnType<typeof prepareReport>>["report"]) => buildAlertPayload({
    repository: r.repository, pullNumber: r.pullNumber, baseSha: r.baseSha, headSha: r.headSha, policyVersion: r.policyVersion, reportId: r.id,
    finding: r.findings.find(x => x.id === "finding-1")!, coverageOverall: r.coverageOverall, enumerationComplete: r.enumerationComplete,
  });
  // Unverifiable text (not what the sanitized builder produces) is cancelled, never sent.
  {
    const f = await fixture();
    bindTelegram(f);
    await prepareReport(f);
    const intent = intentsOf(f)[0]!;
    legacyize(f, intent.id, `${intent.payload.text}\nดู evil.com/phish`);
    expect(intentsOf(f)[0]!.guard).toBeUndefined();
    worker(f).pump();
    expect(f.sender.calls).toBe(0);
    expect(intentsOf(f)[0]).toMatchObject({ status: "cancelled", stale: true, staleReason: "legacy_alert_unverifiable", guard: "pr-alert" });
  }
  // Verifiable but stale: the reviewer's repro now cancels instead of sending.
  {
    const f = await fixture();
    bindTelegram(f);
    const { report, candidate } = await prepareReport(f);
    const intent = intentsOf(f)[0]!;
    legacyize(f, intent.id, legacyText(report));
    f.store.transaction(tx => {
      const row = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM pr_candidates WHERE id = ?", candidate.id)!.record_json);
      row.status = "superseded";
      tx.run("UPDATE pr_candidates SET status = 'superseded', record_json = ? WHERE id = ?", JSON.stringify(row), candidate.id);
    });
    worker(f).pump();
    expect(f.sender.calls).toBe(0);
    expect(intentsOf(f)[0]).toMatchObject({ status: "cancelled", stale: true, staleReason: "candidate_superseded" });
  }
  // Verifiable and current: backfilled with a link and guard, then sent once.
  {
    const f = await fixture();
    bindTelegram(f);
    const { report } = await prepareReport(f);
    const intent = intentsOf(f)[0]!;
    legacyize(f, intent.id, legacyText(report));
    expect(worker(f).pump().map(i => i.status)).toEqual(["sent"]);
    expect(intentsOf(f)[0]!.guard).toBe("pr-alert");
    expect(f.store.read(tx => readAlertLinks(tx, report.id))[0]).toMatchObject({ intentId: intent.id, findingId: "finding-1", decisionId: "legacy-backfill" });
  }
  // New guardless pr-alert intents cannot be committed at all.
  {
    const f = await fixture();
    expect(() => f.store.transaction(tx => commitDeliveryIntent(tx, { projectId: f.project.id, kind: "report", text: "x", dedupeKey: `pr-alert/${crypto.randomUUID()}/finding-1/v1/000000000002/1`, maxBytes: 4000 }, f.clock.now))).toThrow("invalid_delivery_command");
  }
});

test("retirement keeps a terminal failed delivery recorded and only marks it stale", async () => {
  const f = await fixture();
  bindTelegram(f);
  const { report, monitor, conn } = await prepareReport(f);
  f.sender.scripts = ["reject"];
  worker(f).pump();
  const before = intentsOf(f)[0]!;
  expect(before).toMatchObject({ status: "failed", remote: "rejected", failureReason: "telegram_rejected" });
  // Dismissal stops pending sends only; a settled failure is unchanged.
  f.app.execute(f.auth.actor, { kind: "pr.report.dismiss", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: report.revision, payload: { reportId: report.id, reason: "พอแล้ว" } });
  expect(intentsOf(f)[0]).toMatchObject({ status: "failed", remote: "rejected", failureReason: "telegram_rejected", stale: false });
  f.github.pulls = [fixturePull({ number: 1, base: { sha: sha(1), ref: "main" }, head: { sha: sha(55), ref: "feat" } })];
  resetCheckpoint(f, monitor.id);
  f.store.transaction(tx => pollMonitorCatchUp(tx, f.project.id, monitor.id, conn, f.clock.now));
  expect(intentsOf(f)[0]).toMatchObject({ status: "failed", remote: "rejected", failureReason: "telegram_rejected", stale: true, staleReason: "candidate_superseded" });
});

test("cross-attempt dedupe uses the canonical fingerprint: a reused generic ID for a different defect still alerts", async () => {
  let json = oneFinding({ location: { path: "a.ts", line: 10 }, condition: "when input empty" });
  const f = await fixture(() => scripted(json)());
  bindTelegram(f);
  const { report, monitor, candidate } = await prepareReport(f);
  const first = intentsOf(f)[0]!;
  expect(f.store.read(tx => readAlertLinks(tx, report.id))[0]!.fingerprint).toBe(findingFingerprint(report.findings[0]!));
  const w = worker(f);
  expect(w.pump().map(i => i.status)).toEqual(["sent"]);
  // Second attempt on the same revision: same raw ID "finding-1", different location and condition.
  json = oneFinding({ title: "off-by-one", location: { path: "a.ts", line: 20 }, condition: "when the list has one item" });
  enqueueReview(f, monitor.id, candidate.id);
  f.queue.pump(); await f.queue.idle();
  const reports = f.store.read(tx => tx.all<{ id: string }>("SELECT id FROM pr_reports ORDER BY rowid")).map(r => r.id);
  expect(reports).toHaveLength(2);
  const decision = f.store.read(tx => readAlertDecisions(tx, reports[1]!)).at(-1)!;
  expect(decision.findings.find(d => d.findingId === "finding-1")!.decision).toBe("notified");
  const second = intentsOf(f).filter(i => i.id !== first.id);
  expect(second).toHaveLength(1);
  expect(w.pump().map(i => i.status)).toEqual(["sent"]);
  expect(f.sender.calls).toBe(2);
  expect(f.sender.external[1]!.text).toContain("off-by-one");
  // Third attempt: the same defect as the second under a fresh model ID stays already notified.
  json = oneFinding({ id: "renamed-7", title: "off-by-one again", location: { path: "a.ts", line: 20 }, condition: "When  the list has one item" });
  enqueueReview(f, monitor.id, candidate.id);
  f.queue.pump(); await f.queue.idle();
  const third = f.store.read(tx => tx.all<{ id: string }>("SELECT id FROM pr_reports ORDER BY rowid")).map(r => r.id)[2]!;
  expect(f.store.read(tx => readAlertDecisions(tx, third)).at(-1)!.findings.find(d => d.findingId === "renamed-7"))
    .toMatchObject({ decision: "already_notified", intentId: second[0]!.id });
  expect(intentsOf(f)).toHaveLength(2);
});

test("a definitive failed delivery is not notified: the next review attempt alerts exactly once", async () => {
  const f = await fixture();
  bindTelegram(f);
  const { monitor, candidate } = await prepareReport(f);
  f.sender.scripts = ["reject", "accept"];
  const w = worker(f);
  w.pump();
  const failed = intentsOf(f)[0]!;
  expect(failed).toMatchObject({ status: "failed", failureReason: "telegram_rejected" });
  enqueueReview(f, monitor.id, candidate.id);
  f.queue.pump(); await f.queue.idle();
  const retry = f.store.read(tx => tx.all<{ id: string }>("SELECT id FROM pr_reports ORDER BY rowid")).map(r => r.id)[1]!;
  const decision = f.store.read(tx => readAlertDecisions(tx, retry)).at(-1)!;
  expect(decision.findings.find(d => d.findingId === "finding-1")!.decision).toBe("notified");
  const fresh = intentsOf(f).filter(i => i.id !== failed.id);
  expect(fresh).toHaveLength(1);
  expect(w.pump().map(i => i.status)).toEqual(["sent"]);
  // Re-admitting the current report replays the same intent; nothing is sent twice.
  expect(f.app.admitPrAlerts(f.auth.actor, f.project.id, retry).admitted[0]!.created).toBe(false);
  w.pump();
  expect(intentsOf(f)).toHaveLength(2);
  expect(f.sender.external.filter(m => m.text.includes("finding finding-1"))).toHaveLength(1);
  expect(intentsOf(f)[0]).toMatchObject({ id: failed.id, status: "failed", failureReason: "telegram_rejected" });
});

test("maxFiles at a page boundary: the review is not complete, no clean/unwarned alert, Web shows the non-complete state", async () => {
  const f = await fixture();
  bindTelegram(f);
  const monitor = f.store.transaction(tx => {
    ensurePrSchema(tx);
    return mutateMonitor(tx, {
      kind: "pr.monitor.enable", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: projectRevision(f),
      payload: { repository: { host: "github.com", owner: "acme", name: "widgets" }, apiBase: "https://api.github.com",
        allowed: { issues: true, specs: true, ci: true }, acceptPolicyVersion: 1 as 1, limits: { pageSize: 1, maxFiles: 1 } },
    }, f.clock.now).monitor;
  });
  f.github.pageSize = 1;
  const base = sha(1), head = sha(2);
  f.github.pulls = [fixturePull({ number: 1, base: { sha: base, ref: "main" }, head: { sha: head, ref: "feat" } })];
  f.github.files.set(f.github.key(1, base, head), [
    { filename: "a.ts", status: "modified", patch: "@@ -1,1 +1,40 @@\n+a" },
    { filename: "b.ts", status: "modified", patch: "@@ -1,1 +1,40 @@\n+b" },
  ]);
  f.github.checks.set(head, []);
  const conn = connector(f, monitor);
  f.store.transaction(tx => pollMonitorCatchUp(tx, f.project.id, monitor.id, conn, f.clock.now));
  const candidate = f.store.read(tx => readCandidates(tx, f.project.id, monitor.id)[0]!);
  const snapshot = f.store.transaction(tx => captureSnapshot(tx, f.project.id, candidate.id, conn, f.clock.now))!;
  expect(snapshot.coverage).toMatchObject({ enumerationComplete: false, overall: "incomplete" });
  enqueueReview(f, monitor.id, candidate.id);
  f.queue.pump(); await f.queue.idle();
  const reportId = f.store.read(tx => tx.get<{ id: string }>("SELECT id FROM pr_reports")!.id);
  const report = f.store.read(tx => readReport(tx, f.project.id, reportId));
  expect(report).toMatchObject({ status: "incomplete", enumerationComplete: false });
  // An incomplete review never notifies; any payload built for it carries the partial-scope warning.
  expect(f.store.read(tx => readAlertDecisions(tx, report.id)).at(-1)!.suppressedReason).toBe("report_incomplete");
  expect(intentsOf(f)).toHaveLength(0);
  const text = buildAlertPayload({ repository: report.repository, pullNumber: report.pullNumber, baseSha: report.baseSha, headSha: report.headSha,
    policyVersion: report.policyVersion, reportId: report.id, finding: report.findings.find(x => x.id === "finding-1")!,
    coverageOverall: report.coverageOverall, enumerationComplete: report.enumerationComplete, projectId: f.project.id });
  expect(text).toContain("คำเตือน: ตรวจไม่ครบ");
  const web = createWebHandler(f.app);
  const html = await (await web(new Request(`http://localhost:3000/projects/${f.project.id}/pr/reports`, { headers: { cookie: `jit_session=${f.token}` } }))).text();
  expect(html).toContain('data-review-state="incomplete"');
  expect(html).not.toContain('data-review-state="complete_clean"');
  expect(html).not.toContain('data-review-state="complete_findings"');
});

test("alert payload keeps every mandatory field at the minimum message ceiling; smaller ceilings are rejected", () => {
  const worst = {
    repository: { host: "github.com", owner: "o".repeat(39), name: "n".repeat(100) }, pullNumber: Number.MAX_SAFE_INTEGER,
    baseSha: "a".repeat(40), headSha: "b".repeat(40), policyVersion: 999_999_999,
    reportId: "11111111-2222-3333-4444-555555555555", projectId: "66666666-7777-8888-9999-000000000000",
    coverageOverall: "partial" as const, enumerationComplete: false,
  };
  const finding = (text: (n: number) => string) => ({
    id: `f${"x".repeat(63)}`, title: text(500), category: "correctness" as const, severity: "critical" as const,
    location: { path: `src/${"ก".repeat(80)}.ts`, line: 1_000_000 }, condition: text(2000), impact: text(2000), reasoning: "r",
    evidenceType: "diff" as const, evidenceRef: `src/${"ข".repeat(80)}.ts`, status: "actionable" as const, validationErrors: [],
  });
  // The worst-case skeleton plus the per-field reserve fits the configured minimum.
  const skeleton = buildAlertPayload({ ...worst, finding: { ...finding(() => ""), location: { path: "", line: 1_000_000 }, evidenceRef: "x" }, maxBytes: MIN_MESSAGE_BYTES });
  expect(Buffer.byteLength(skeleton) - 1 + 5 * ALERT_FIELD_RESERVE_BYTES).toBeLessThanOrEqual(MIN_MESSAGE_BYTES);
  for (const maxBytes of [MIN_MESSAGE_BYTES, 2048, 3500]) {
    const text = buildAlertPayload({ ...worst, finding: finding(n => "เงื่อนไขยาว".repeat(n)), maxBytes });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(maxBytes);
    expect(text.isWellFormed()).toBe(true);
    const lines = text.split("\n");
    expect(lines[0]).toBe(`PR ${"o".repeat(39)}/${"n".repeat(100)}#${Number.MAX_SAFE_INTEGER}`);
    expect(lines[1]).toBe(`revision ${"a".repeat(12)}...${"b".repeat(12)} policy v999999999`);
    expect(lines[2]).toStartWith(`finding f${"x".repeat(63)} [correctness/critical] เงื่อนไข`);
    expect(lines[3]).toMatch(/^ที่: src\/ก+.*:1000000$/);
    expect(lines[4]).toMatch(/^เงื่อนไข: (เงื่อนไขยาว){1}/);
    expect(lines[5]).toMatch(/^ผลกระทบ: (เงื่อนไขยาว){1}/);
    expect(lines[6]).toMatch(/^หลักฐาน: diff src\/ข+/);
    expect(lines[7]).toBe(`รายงาน: /projects/${worst.projectId}/pr/reports/${worst.reportId}`);
    expect(lines[8]).toBe("คำเตือน: ตรวจไม่ครบทุกไฟล์/หลักฐาน รายงานนี้เป็น partial/incomplete");
    expect(lines).toHaveLength(9);
  }
  // The reviewer's 512-byte ceiling (and anything below the minimum) is rejected, never silently cut.
  for (const maxBytes of [512, MIN_MESSAGE_BYTES - 1]) {
    expect(() => buildAlertPayload({ ...worst, finding: finding(() => "c"), maxBytes })).toThrow("invalid_delivery_payload");
  }
  expect(() => readConfig({ JIT_MESSAGE_BYTES: "512" })).toThrow("Invalid JIT_MESSAGE_BYTES");
  expect(readConfig({ JIT_MESSAGE_BYTES: String(MIN_MESSAGE_BYTES) }).messageBytes).toBe(MIN_MESSAGE_BYTES);
});

test("duplicate-ID repair picks the evidence-backed representative in either order and sends it", async () => {
  const suspected = { id: "dup-1", title: "maybe", category: "uncertain", severity: "high", location: { path: "a.ts", line: 1 }, condition: "c0", impact: "i0", reasoning: "r0", evidenceType: "none", evidenceRef: null };
  const actionable = { id: "dup-1", title: "real bug", category: "correctness", severity: "high", location: { path: "a.ts", line: 2 }, condition: "c1", impact: "i1", reasoning: "r1", evidenceType: "diff", evidenceRef: "a.ts" };
  for (const order of [[suspected, actionable], [actionable, suspected]]) {
    const f = await fixture(scripted(JSON.stringify({ findings: order, analyzedRoles: ["correctness", "security"], skippedScope: [], disagreements: [] })));
    bindTelegram(f);
    const { report } = await prepareReport(f);
    const real = report.findings.find(x => x.title === "real bug")!;
    const maybe = report.findings.find(x => x.title === "maybe")!;
    expect(real).toMatchObject({ status: "actionable", duplicateGroup: "dup-1" });
    expect(maybe).toMatchObject({ status: "suspected", duplicateGroup: "dup-1" });
    expect(new Set(report.findings.map(x => x.id)).size).toBe(2);
    expect(report.findings.map(x => x.title)).toEqual(order.map(x => x.title));
    const decision = f.store.read(tx => readAlertDecisions(tx, report.id)).at(-1)!;
    expect(decision.findings.find(d => d.findingId === real.id)!.decision).toBe("notified");
    expect(decision.findings.find(d => d.findingId === maybe.id)!.decision).toBe("held");
    expect(worker(f).pump().map(i => i.status)).toEqual(["sent"]);
    expect(f.sender.external[0]!.text).toContain("real bug");
  }
});

test("quarantined legacy credential-bearing intent no longer stores the credential in outbox, report or source", async () => {
  const token = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789";
  const plant = (f: F, intentId: string) => f.store.transaction(tx => {
    tx.run("DELETE FROM pr_alerts WHERE intent_id = ?", intentId);
    const row = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE id = ?", intentId)!.record_json);
    delete row.guard;
    row.payload.text = `${row.payload.text}\nkey ${token}`;
    tx.run("UPDATE delivery_intents SET record_json = ? WHERE id = ?", JSON.stringify(row), intentId);
    const report = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM delivery_reports WHERE id = ?", row.provenance.reportId)!.record_json);
    report.text = row.payload.text;
    tx.run("UPDATE delivery_reports SET record_json = ? WHERE id = ?", JSON.stringify(report), report.id);
    tx.run("UPDATE source_versions SET content_text = ? WHERE source_id = ?", row.payload.text, report.sourceId);
  });
  const leaks = (f: F) => f.store.read(tx => [
    ...tx.all<{ v: string }>("SELECT record_json AS v FROM delivery_intents"),
    ...tx.all<{ v: string }>("SELECT record_json AS v FROM delivery_reports"),
    ...tx.all<{ v: string }>("SELECT record_json AS v FROM delivery_attempts"),
    ...tx.all<{ v: string }>("SELECT coalesce(content_text, '') AS v FROM source_versions"),
  ].filter(r => r.v.includes(token)).length);
  // Pending: the send guard quarantines it at claim time.
  {
    const f = await fixture();
    bindTelegram(f);
    await prepareReport(f);
    plant(f, intentsOf(f)[0]!.id);
    expect(leaks(f)).toBe(3);
    worker(f).pump();
    expect(f.sender.calls).toBe(0);
    expect(intentsOf(f)[0]).toMatchObject({ status: "cancelled", stale: true, staleReason: "legacy_alert_unverifiable" });
    expect(leaks(f)).toBe(0);
    expect(intentsOf(f)[0]!.payload.text).toContain("[credential-redacted]");
  }
  // Settled (failed): the boot sweep redacts and marks stale while keeping the honest outcome.
  {
    const f = await fixture();
    bindTelegram(f);
    await prepareReport(f);
    f.sender.scripts = ["reject"];
    worker(f).pump();
    const id = intentsOf(f)[0]!.id;
    plant(f, id);
    const quarantined = f.store.transaction(tx => quarantineLegacyPrAlerts(tx, f.clock.now));
    expect(quarantined).toEqual([id]);
    expect(intentsOf(f)[0]).toMatchObject({ status: "failed", remote: "rejected", failureReason: "telegram_rejected", stale: true, staleReason: "legacy_alert_unverifiable" });
    expect(leaks(f)).toBe(0);
  }
});

test("duplicate group picks its representative under the current policy and never alerts twice", async () => {
  const copy = (title: string, severity: string, category = "correctness") => ({ id: "dup-1", title, category, severity, location: { path: "a.ts", line: 1 }, condition: `c ${title}`, impact: `i ${title}`, reasoning: "r", evidenceType: "diff", evidenceRef: "a.ts" });
  const cases = [
    { name: "low-first/critical-second", findings: [copy("low copy", "low"), copy("critical copy", "critical")], policy: { allowedCategories: ["correctness", "security", "behavior"] as ("correctness" | "security" | "behavior")[], minimumSeverity: "high" as const, notifyPartial: true }, winner: "critical copy" },
    { name: "disallowed-first/allowed-second", findings: [copy("behavior copy", "high", "behavior"), copy("security copy", "high", "security")], policy: { allowedCategories: ["security"] as ("correctness" | "security" | "behavior")[], minimumSeverity: "info" as const, notifyPartial: true }, winner: "security copy" },
  ];
  for (const c of cases) {
    const f = await fixture(scripted(JSON.stringify({ findings: c.findings, analyzedRoles: ["correctness", "security"], skippedScope: [], disagreements: [] })));
    bindTelegram(f);
    setPolicy(f, 1, c.policy);
    const { report } = await prepareReport(f);
    expect(report.findings.map(x => x.status)).toEqual(["actionable", "actionable"]);
    expect(intentsOf(f)).toHaveLength(1);
    const winner = report.findings.find(x => x.title === c.winner)!;
    const loser = report.findings.find(x => x.title !== c.winner)!;
    let decision = f.store.read(tx => readAlertDecisions(tx, report.id)).at(-1)!;
    expect(decision.findings.find(d => d.findingId === winner.id)!.decision).toBe("notified");
    expect(decision.findings.find(d => d.findingId === loser.id)!.decision).toBe("held");
    const w = worker(f);
    expect(w.pump().map(i => i.status)).toEqual(["sent"]);
    expect(f.sender.external[0]!.text).toContain(c.winner);
    // Policy change to defaults makes both copies pass: the live copy stays the representative, no second alert.
    const receipt = setPolicy(f, 2, { allowedCategories: ["correctness", "security", "behavior"], minimumSeverity: "info", notifyPartial: true });
    decision = receipt.decisions[0]!;
    expect(decision.findings.find(d => d.findingId === winner.id)).toMatchObject({ decision: "already_notified", intentId: intentsOf(f)[0]!.id });
    expect(decision.findings.find(d => d.findingId === loser.id)).toMatchObject({ decision: "held", reason: "duplicate_finding_id" });
    expect(receipt.retiredIntentIds).toEqual([]);
    expect(intentsOf(f)).toHaveLength(1);
    w.pump();
    expect(f.sender.calls).toBe(1);
  }
  // Pending (unsent) representative also survives a policy change without churn or a second intent.
  const f = await fixture(scripted(JSON.stringify({ findings: [copy("low copy", "low"), copy("critical copy", "critical")], analyzedRoles: ["correctness", "security"], skippedScope: [], disagreements: [] })));
  setPolicy(f, 1, cases[0]!.policy);
  await prepareReport(f);
  const pending = intentsOf(f)[0]!;
  const receipt = setPolicy(f, 2, { allowedCategories: ["correctness", "security", "behavior"], minimumSeverity: "info", notifyPartial: true });
  expect(receipt.retiredIntentIds).toEqual([]);
  expect(intentsOf(f).map(i => [i.id, i.status])).toEqual([[pending.id, "waiting"]]);
});

test("service bootstrap quarantines legacy alerts before the queue or server is constructed", async () => {
  const f = await fixture();
  bindTelegram(f);
  await prepareReport(f);
  f.sender.scripts = ["reject"];
  worker(f).pump();
  const id = intentsOf(f)[0]!.id;
  f.store.transaction(tx => {
    tx.run("DELETE FROM pr_alerts WHERE intent_id = ?", id);
    const row = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE id = ?", id)!.record_json);
    delete row.guard;
    row.payload.text = `${row.payload.text}\nkey sk-proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789`;
    tx.run("UPDATE delivery_intents SET record_json = ? WHERE id = ?", JSON.stringify(row), id);
  });
  expect(prepareServiceState(f.store, f.clock.now).quarantinedLegacyAlerts).toEqual([id]);
  expect(intentsOf(f)[0]).toMatchObject({ status: "failed", stale: true, staleReason: "legacy_alert_unverifiable" });
  expect(intentsOf(f)[0]!.payload.text).not.toContain("sk-proj");
  expect(prepareServiceState(f.store, f.clock.now).quarantinedLegacyAlerts).toEqual([]);
  // main.ts composition: serve prepares state first, before the job queue, delivery or HTTP server exist.
  const main = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");
  const serveStart = main.indexOf('if (command === "serve") {');
  const prepared = main.indexOf("prepareServiceState(store, Date.now());");
  expect(serveStart).toBeGreaterThan(-1);
  expect(prepared).toBeGreaterThan(serveStart);
  for (const later of ["composeJobQueue(store", "Bun.serve(", "setInterval("]) expect(main.indexOf(later)).toBeGreaterThan(prepared);
});

test("snapshot retirement retires alerts; backup images classify the alert tables", async () => {
  const f = await fixture();
  bindTelegram(f);
  const { candidate } = await prepareReport(f);
  // Every lazily created PR/alert table is classified, so a backup image can be captured.
  const image = f.store.read(tx => captureBackupImage(tx, f.store));
  expect(image).toBeTruthy();
  f.store.transaction(tx => retirePrSnapshot(tx, f.project.id, candidate.id, f.clock.now));
  expect(intentsOf(f)[0]).toMatchObject({ status: "cancelled", stale: true, staleReason: "source_retired" });
  worker(f).pump();
  expect(f.sender.calls).toBe(0);
});
