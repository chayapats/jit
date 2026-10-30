// Opt-in live evidence for Jit's short chat voice (app.communication_policy/v2, S12-D05, COMM01). Skipped unless
// JIT_LIVE_VOICE=1, and never run in CI:
//
//   JIT_LIVE_VOICE=1 JIT_LIVE_VOICE_ROUTE='{"provider":"grok","model":"<model>","authRoute":"<route>"}' bun test tests/chat-voice.live.test.ts
//
// The route must already be signed in for the user running the test (the pinned Schway host's credential store). The
// test spends real inference on two short messages in a throwaway installation and measures the committed replies with
// the same check as the scripted eval (tests/chat-voice.test.ts). Model output varies; a failure is evidence to read.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { JobQueue } from "../src/jobs/queue";
import { TransactionStore } from "../src/store";
import { jitReplyWork, type JitReplyView } from "../src/team/jit-reply";
import { SchwayRunPort, assertSchwayGate } from "../src/team/schway-port";
import type { RoleRoute } from "../src/team/types";
import { measureVoice, voiceLimits } from "./fixtures/chat-voice";

const live = process.env.JIT_LIVE_VOICE === "1";
const root = live ? mkdtempSync(join(tmpdir(), "jit-live-voice-")) : "";
let store: TransactionStore | null = null, queue: JobQueue | null = null;

afterAll(async () => {
  if (!live) return;
  queue?.close(); await queue?.idle();
  store?.close();
  rmSync(root, { recursive: true, force: true });
});

async function installation() {
  const route = JSON.parse(process.env.JIT_LIVE_VOICE_ROUTE ?? "null") as RoleRoute | null;
  // Bun's toMatchObject writes its asymmetric matchers into the object it checks, so it checks a copy.
  expect({ ...route }).toMatchObject({ provider: expect.any(String), model: expect.any(String), authRoute: expect.any(String) });
  const path = join(root, "state.sqlite");
  const config = readConfig({ JIT_DATABASE: path, JIT_RUN_PORT: "schway", JIT_JOB_ROUTE_CONCURRENCY: "1" });
  store = new TransactionStore(path);
  assertSchwayGate(path);
  const port = new SchwayRunPort(store, config.team, config.jobs.outputBytes);
  queue = new JobQueue(store, config.jobs, [jitReplyWork(store, config, port)]);
  const app = new Application(store, config, { jobs: queue });
  await app.setupOwner("live-voice-owner-password");
  const auth = app.authenticate(await app.login("live-voice-owner-password"));
  const project = app.execute(auth.actor, { kind: "project.create", projectId: null, requestId: crypto.randomUUID(), expectedRevision: 0, payload: { name: "เสียงของจิต" } }).project;
  const topic = app.execute(auth.actor, { kind: "topic.create", projectId: project.id, requestId: crypto.randomUUID(), expectedRevision: project.revision, payload: { title: "ทดสอบเสียง" } }).topic;
  app.execute(auth.actor, { kind: "role.save", projectId: null, requestId: crypto.randomUUID(), expectedRevision: app.team(auth.actor).ownerRevision,
    payload: { roleId: null, name: "จิต", kind: "coordinator", responsibility: "ตอบเจ้าของและประสานทีม", enabled: true, route: route! } });
  /** Sends one owner message and waits for Jit's committed reply. */
  const ask = async (text: string): Promise<{ reply: JitReplyView; text: string }> => {
    const revision = app.conversation(auth.actor, project.id, topic.id).topic.revision;
    const sent = app.execute(auth.actor, { kind: "message.send", projectId: project.id, requestId: crypto.randomUUID(), expectedRevision: revision, payload: { topicId: topic.id, text } });
    for (let i = 0; i < 240; i++) {
      queue!.pump(); await queue!.idle();
      const reply = app.replies(auth.actor, project.id, topic.id, [sent.message.id]).get(sent.message.id)!;
      if (reply.state === "answered") return { reply, text: app.conversation(auth.actor, project.id, topic.id).items.find(item => item.id === reply.replyMessageId)!.text ?? "" };
      if (reply.state !== "thinking") throw new Error(`reply ${reply.state}: ${reply.reason}`);
      await Bun.sleep(500);
    }
    throw new Error("no reply within two minutes");
  };
  return { ask };
}

test.skipIf(!live)("live route: a greeting gets a short reply, and long multi-step work becomes a task suggestion with a one-line reply", async () => {
  const { ask } = await installation();
  const greeting = await ask("สวัสดี");
  expect(measureVoice(greeting.text).words).toBeLessThanOrEqual(voiceLimits.words);
  const plan = await ask("ช่วยวางแผนย้ายระบบทั้งหมดไป Postgres แบบละเอียด");
  expect(plan.reply.taskSuggestion).not.toBeNull();
  expect(measureVoice(plan.text).lines).toBeLessThanOrEqual(voiceLimits.taskReplyLines);
}, 300_000);
