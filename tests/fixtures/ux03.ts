import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../../src/application";
import { readConfig } from "../../src/config";
import { JobQueue } from "../../src/jobs/queue";
import { projectStateWork } from "../../src/jobs/project-state";
import { memoryExtractionMarker, memoryExtractionWork, scriptedMemoryResult } from "../../src/memory/extract";
import { setupCheckWork, type SetupCommand } from "../../src/setup";
import { TransactionStore } from "../../src/store";
import { coordinatorSynthesisMarker, coordinatorSynthesisWork } from "../../src/team/decisions";
import { discussionPlanWork, specialistAnalysisWork } from "../../src/team/dispatch";
import { jitReplyMarker, jitReplyWork, teamReplyMarker } from "../../src/team/jit-reply";
import { ScriptedRunPort, fixtureOutcome } from "../../src/team/scripted-port";
import type { ApplicationRunOutcome, ApplicationRunRequest, RoleRoute } from "../../src/team/types";
import { createWebHandler } from "../../src/web";

/**
 * UX03 review installation: a scripted host and a fixed clock, set up through the public setup commands, with content on
 * every main page so accessibility and layout checks see the real components. Thai owner content, a General topic with
 * a promotion card, a project topic with a role proposal and a team dispatch card, a long unbroken word, and a task.
 * No paid inference and no network. Also used to serve the same installation for opt-in browser checks.
 */
export const fixturePassword = "fixture-ux03-owner-password";
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
const rid = () => crypto.randomUUID();
const answer = (request: ApplicationRunRequest, output: string): ApplicationRunOutcome => ({
  ...fixtureOutcome("complete", output), usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0, tokensUnknown: false },
  session: { adapter: "scripted", id: request.runId, context: request.context },
});
const long = "ข้อความยาวมากที่ไม่มีช่องว่างเลย".repeat(6);

export async function ux03Installation(options: { root?: string; origin?: string; setupLanguage?: "th" | "en" } = {}) {
  const language = options.setupLanguage ?? "th";
  const root = options.root ?? mkdtempSync(join(tmpdir(), "jit-ux03-"));
  const path = join(root, "state.sqlite");
  const config = readConfig({ JIT_DATABASE: path, JIT_JOB_CONCURRENCY: "4", JIT_JOB_ROUTE_CONCURRENCY: "4", ...options.origin ? { JIT_ORIGIN: options.origin } : {} });
  const store = new TransactionStore(path);
  const now = () => Date.UTC(2027, 0, 15, 8);
  const outputs: string[] = [];
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, request => {
    const operator = request.instructions.operator;
    if (operator.includes(memoryExtractionMarker)) return scriptedMemoryResult(request, true);
    if (operator.some(line => line.startsWith("Jit setup connection check"))) return answer(request, "OK");
    if (operator[0] === jitReplyMarker) return answer(request, outputs.shift() ?? JSON.stringify({ reply: "รับทราบครับ" }));
    if (operator[0] === teamReplyMarker) return answer(request, JSON.stringify({ reply: "สรุปจากทีม: เริ่มแบบเรียบง่ายก่อน" }));
    if (operator[0] === coordinatorSynthesisMarker) return answer(request, JSON.stringify({ question: "เลือกแนวทางไหน", options: [] }));
    return answer(request, "ความเห็นของผู้เชี่ยวชาญ");
  });
  let queueRef: JobQueue | undefined;
  const queue = new JobQueue(store, config.jobs, [
    setupCheckWork(store, config, port, now), jitReplyWork(store, config, port, now, () => queueRef), memoryExtractionWork(store, config, port, now),
    discussionPlanWork(), specialistAnalysisWork(store, config, port, now, () => queueRef), coordinatorSynthesisWork(store, config, port, now), projectStateWork(store),
  ], { now });
  queueRef = queue;
  const app = new Application(store, config, { now, jobs: queue });
  const web = createWebHandler(app, { stream: { intervalMs: 1, polls: 2 } });
  const settle = async () => {
    for (let i = 0; i < 400; i++) {
      queue.pump();
      const pending = store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'admitted')")!.n);
      await queue.idle();
      if (pending === 0) return;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    throw new Error("queue did not drain");
  };
  await app.setupOwner(fixturePassword);
  const token = await app.login(fixturePassword), auth = app.authenticate(token);
  const { actor } = auth;
  /**
   * Every setup step as served while the installation walks through setup in `setupLanguage`, once with each saved
   * theme. Before the wake step the browser's language decides; after it, the language the owner chose.
   */
  const setupPages: { step: string; locale: "th" | "en"; theme: "dark" | "light"; html: string }[] = [];
  const preferences = (theme: "system" | "dark" | "light", saved: "auto" | "th" | "en") =>
    app.execute(actor, { kind: "ui.preferences.set", requestId: rid(), projectId: null, expectedRevision: app.preferences(actor).revision, payload: { theme, language: saved } });
  let chosen: "auto" | "th" | "en" = "auto";
  const capture = async (step: string) => {
    for (const theme of ["dark", "light"] as const) {
      preferences(theme, chosen);
      const response = await web(new Request(`${config.origin}/setup`, { headers: { cookie: `jit_session=${token}`, "accept-language": language } }));
      setupPages.push({ step, locale: language, theme, html: await response.text() });
    }
    preferences("system", chosen);
  };
  const setup = (kind: SetupCommand["kind"], payload: unknown) =>
    app.execute(actor, { kind, requestId: rid(), projectId: null, expectedRevision: app.setup(actor).revision, payload } as SetupCommand);
  await capture("wake");
  setup("setup.wake", { language });
  chosen = language;
  await capture("connect");
  setup("setup.connect", { route: grok });
  await settle();
  await capture("connect-checked");
  setup("setup.connect.continue", {});
  await capture("know");
  setup("setup.know", { addressAs: language === "th" ? "พี่บอส" : "Boss", selfReference: "", language, particle: language === "th" ? "khrap" : "none" });
  await capture("personality");
  setup("setup.personality.skip", {});
  await capture("ceremony");
  setup("setup.complete", {});
  app.execute(actor, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: app.team(actor).ownerRevision,
    payload: { roleId: null, name: "เทคโนโลยี", kind: "specialist", responsibility: "วิเคราะห์ฐานข้อมูลและโครงสร้างซอฟต์แวร์", enabled: true, route: grok } });

  const general = app.generalSpace(actor)!;
  outputs.push(JSON.stringify({ reply: "เรื่องนี้ควรเป็นโครงการของตัวเองแล้วครับ", proposals: [{ kind: "promotion", name: "แอปจดรายจ่าย" }] }));
  const chat = app.execute(actor, { kind: "chat.start", requestId: rid(), projectId: general.projectId, expectedRevision: app.workspace(actor).revision, payload: { text: `อยากทำแอปจดรายจ่าย ${long}` } });
  await settle();

  const project = app.execute(actor, { kind: "project.create", projectId: null, requestId: rid(), expectedRevision: app.workspace(actor).revision, payload: { name: "โครงการทีม" } }).project;
  const topic = app.execute(actor, { kind: "topic.create", projectId: project.id, requestId: rid(), expectedRevision: app.project(actor, project.id).revision, payload: { title: "เลือกสถาปัตยกรรม" } }).topic;
  const say = async (text: string) => {
    const current = app.conversation(actor, project.id, topic.id).topic;
    app.execute(actor, { kind: "message.send", projectId: project.id, requestId: rid(), expectedRevision: current.revision, payload: { topicId: topic.id, text } });
    await settle();
  };
  outputs.push(JSON.stringify({ reply: "จิตเสนอผู้เชี่ยวชาญด้านความปลอดภัยครับ", proposals: [{ kind: "role", name: "ความปลอดภัย", responsibility: "ตรวจความเสี่ยงด้านความปลอดภัยของแอปบน Pi", route: grok }] }));
  await say("ช่วยหาคนดูเรื่องความปลอดภัย");
  outputs.push(JSON.stringify({ reply: "ขอถามทีมก่อนนะครับ", proposals: [{ kind: "dispatch", roles: ["เทคโนโลยี"] }] }));
  await say("ควรใช้ฐานข้อมูลแบบไหน");
  const fresh = app.conversation(actor, project.id, topic.id).topic;
  const task = app.execute(actor, { kind: "task.propose", requestId: rid(), projectId: project.id, expectedRevision: fresh.revision,
    payload: { topicId: topic.id, title: "ร่างโครงสร้างฐานข้อมูล", summary: "สรุปตารางหลักและความสัมพันธ์" } }).task;

  const p = `/projects/${project.id}`, t = `${p}/topics/${topic.id}`, g = `/projects/${general.projectId}/topics/${chat.topic.id}`;
  /** Main signed-in pages, each with real content. */
  const routes = [
    "/", `${g}`, `/projects/${general.projectId}`, p, t, `${t}/panel`, ...["memory", "tasks", "jobs", "pr", "team"].map(tab => `${t}/panel?tab=${tab}`),
    `${p}/tasks`, `${p}/tasks/${task.id}`, `${p}/jobs`, `${p}/memory`, `${p}/team`, `${p}/pr/reports`, `${p}/schedules`, `${p}/delivery`, `${p}/exports`,
    "/search", "/search?q=โครงการ", "/settings", "/settings/team", "/settings/dispatch", "/settings/telegram", "/settings/backups", "/settings/upgrades",
    "/settings/restores", "/settings/data",
  ];
  const close = async () => { queue.close(); await queue.idle(); store.close(); if (!options.root) rmSync(root, { recursive: true, force: true }); };
  return { app, store, web, token, auth, config, routes, setupPages, project, topic, general, generalTopic: chat.topic, close };
}
