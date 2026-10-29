import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { accessConfirmToken } from "../src/exec/access";
import { mcpProposalInstruction } from "../src/exec/mcp";
import { JobQueue } from "../src/jobs/queue";
import { memoryExtractionMarker, memoryExtractionWork, scriptedMemoryResult } from "../src/memory/extract";
import { promotionInstruction } from "../src/promotion";
import { setupCheckWork, type SetupCommand } from "../src/setup";
import { TransactionStore } from "../src/store";
import { communicationPolicyLine, teamCommunicationPolicy } from "../src/team/communication-policy";
import { jitReplyMarker, jitReplyWork, taskSuggestionInstruction } from "../src/team/jit-reply";
import { ScriptedRunPort, fixtureOutcome } from "../src/team/scripted-port";
import type { ApplicationRunOutcome, ApplicationRunRequest, RoleRoute } from "../src/team/types";
import { createWebHandler } from "../src/web";
import { measureVoice, voiceLimits, voiceProblems } from "./fixtures/chat-voice";

/**
 * Scripted voice eval for app.communication_policy/v2 (S12-D05, COMM01). A scripted model stands in for a provider that
 * follows its instructions: it answers in the short chat voice only when the voice rules and the task entry reach the
 * operator lines of the request Jit actually admitted, and otherwise answers like an unguided chatbot. The shared check
 * (tests/fixtures/chat-voice.ts) then measures the committed replies. Deterministic: scripted host, fake clock, no network.
 */
const roots: string[] = [], stores: TransactionStore[] = [], queues: JobQueue[] = [];
afterEach(async () => {
  for (const q of queues.splice(0)) { q.close(); await q.idle(); }
  for (const s of stores.splice(0)) s.close();
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});
const password = "fixture-comm01-owner-password", epoch = 1_800_000_000_000;
const grok: RoleRoute = { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" };
const rid = () => crypto.randomUUID();
const answer = (request: ApplicationRunRequest, output: string): ApplicationRunOutcome => ({
  ...fixtureOutcome("complete", output), usage: { calls: 1, rounds: 1, hops: 1, contextTokens: 0, outputTokens: 0, retries: 0, wallMs: 0, tokensUnknown: false },
  session: { adapter: "scripted", id: request.runId, context: request.context },
});
const trailer = (proposals: unknown[]) => `\n\`\`\`jit-proposals\n${JSON.stringify({ version: 2, proposals })}\n\`\`\``;

/** One owner message and the two ways a model might answer it. */
interface VoiceCase { owner: string; guided: string; unguided: string; task?: { title: string; summary: string }; detail?: boolean }
const migration = { title: "ย้ายระบบไป Postgres", summary: "1. สำรองข้อมูลและจดเวอร์ชัน\n2. แปลง schema และทดสอบบนสำเนา\n3. ย้ายข้อมูลช่วงคนใช้น้อย\n4. ตรวจผลและเตรียมทางย้อนกลับ" };
const cases: VoiceCase[] = [
  { owner: "สวัสดี", guided: "สวัสดีครับพี่บอส วันนี้อยากให้จิตช่วยเรื่องไหนครับ",
    unguided: "สวัสดีครับ! ยินดีช่วยเหลือพี่บอสเสมอนะครับ จิตเป็นผู้ช่วยที่พร้อมตอบทุกคำถาม ไม่ว่าจะเป็นเรื่องงาน เรื่องโค้ด หรือเรื่องทั่วไป\n\nหากมีคำถามเพิ่มเติม บอกจิตได้เลยนะครับ" },
  { owner: "SQLite กับ Postgres ต่างกันยังไง",
    guided: "SQLite เป็นไฟล์เดียวที่ฝังอยู่ในแอป เหมาะกับเครื่องเดียวและคนเขียนพร้อมกันไม่มาก Postgres เป็นเซิร์ฟเวอร์แยก รองรับหลายคนเขียนพร้อมกันและงานที่โตขึ้น แอปส่วนตัวบนเครื่องเดียวใช้ SQLite ก็พอครับ",
    unguided: "คำถามที่ดีมากครับ!\n## SQLite\nSQLite เป็นฐานข้อมูลแบบฝังตัว เก็บทุกอย่างในไฟล์เดียว ติดตั้งง่าย ไม่ต้องมีเซิร์ฟเวอร์\n## Postgres\nPostgres เป็นฐานข้อมูลแบบเซิร์ฟเวอร์ที่มีความสามารถสูง รองรับผู้ใช้หลายคน มี extension มากมาย\n## สรุป\nเลือกตามขนาดงานครับ หวังว่าจะช่วยได้ หากมีคำถามเพิ่มเติมถามได้เลยครับ" },
  { owner: "ช่วยวางแผนย้ายระบบทั้งหมดไป Postgres แบบละเอียด", task: migration,
    guided: `งานนี้มีหลายขั้น จิตร่างเป็นงานไว้ด้านล่างแล้ว ครอบคลุมสำรองข้อมูล ย้าย schema ย้ายข้อมูล และตรวจผลครับ${trailer([{ kind: "task", ...migration }])}`,
    unguided: `แน่นอนครับ! นี่คือแผนการย้ายระบบแบบละเอียด\n## ขั้นที่ 1: เตรียมตัว\n${"สำรองข้อมูลทั้งหมด ตรวจสอบเวอร์ชัน และเตรียมเครื่องทดสอบ ".repeat(4)}\n## ขั้นที่ 2: ย้าย schema\n${"แปลงชนิดข้อมูลให้ตรงกับ Postgres ทดสอบ query ทุกตัว ".repeat(4)}\n## ขั้นที่ 3: ย้ายข้อมูล\n${"ย้ายข้อมูลช่วงที่คนใช้น้อยและตรวจจำนวนแถว ".repeat(4)}\nหากต้องการรายละเอียดเพิ่มเติม บอกได้เลยครับ` },
  // The owner asked for detail, so a longer answer is allowed; it still starts with the answer and has no headings.
  { owner: "อธิบาย WAL ของ SQLite แบบละเอียดหน่อย", detail: true,
    guided: `WAL คือโหมดที่ SQLite เขียนการเปลี่ยนแปลงต่อท้ายไฟล์ -wal ก่อน แทนการแก้ไฟล์ฐานข้อมูลตรงๆ ผู้อ่านจึงอ่านข้อมูลชุดเดิมได้ระหว่างที่มีคนเขียน\n${"เมื่อไฟล์ -wal โตถึงเกณฑ์ SQLite จะทำ checkpoint คัดหน้าที่เปลี่ยนกลับเข้าไฟล์หลัก ถ้ามีผู้อ่านค้างอยู่ checkpoint จะรอ ไฟล์ -wal จึงโตได้ ".repeat(2)}\nข้อควรระวังคือใช้บน network filesystem ไม่ได้ และต้องย้ายไฟล์ -wal กับ -shm ไปพร้อมไฟล์หลักเสมอครับ`,
    unguided: `ได้เลยครับ! คำถามที่ดีมาก\n## WAL คืออะไร\n${"WAL ย่อมาจาก write-ahead log เป็นวิธีเขียนข้อมูลแบบหนึ่ง ".repeat(3)}\n## สรุป\nหวังว่าจะช่วยได้ครับ มีอะไรให้ช่วยอีกไหมครับ` },
];
const englishCase: VoiceCase = { owner: "hi", guided: "Hi Boss. What are we working on today?",
  unguided: "Great question! I'd be happy to help you with anything you need today. I can assist with code, planning, research and more.\n\nLet me know if there is anything else I can do for you!" };

/** A scripted model that follows the voice only when the rules and the task entry reach its operator lines. */
function voiceModel(request: ApplicationRunRequest, drop: boolean): ApplicationRunOutcome {
  const operator = drop ? request.instructions.operator.map(line => line.split(communicationPolicyLine).join("").split(taskSuggestionInstruction).join("")) : request.instructions.operator;
  const instructions = operator.join("\n");
  const guided = teamCommunicationPolicy.lines.slice(5).every(rule => instructions.includes(rule)) && instructions.includes(taskSuggestionInstruction);
  const owner = request.manifest.sources.at(-1)!.text;
  const item = [...cases, englishCase].find(entry => entry.owner === owner);
  return answer(request, item ? (guided ? item.guided : item.unguided) : "รับทราบครับ");
}

async function fixture(options: { drop?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-comm01-")); roots.push(root);
  const path = join(root, "state.sqlite"), config = readConfig({ JIT_DATABASE: path }), store = new TransactionStore(path); stores.push(store);
  let now = epoch;
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, request => {
    if (request.instructions.operator.includes(memoryExtractionMarker)) return scriptedMemoryResult(request, true);
    if (request.instructions.operator.some(line => line.startsWith("Jit setup connection check"))) return answer(request, "OK");
    return voiceModel(request, options.drop ?? false);
  });
  const queue = new JobQueue(store, config.jobs, [setupCheckWork(store, config, port, () => now), jitReplyWork(store, config, port, () => now),
    memoryExtractionWork(store, config, port, () => now)], { now: () => now });
  queues.push(queue);
  const app = new Application(store, config, { now: () => now, jobs: queue });
  const web = createWebHandler(app, { stream: { intervalMs: 1, polls: 2 } });
  await app.setupOwner(password);
  const token = await app.login(password), auth = app.authenticate(token);
  const f = { config, store, app, queue, port, token, auth, web, advance: (ms: number) => { now += ms; } };
  const setup = (kind: SetupCommand["kind"], payload: unknown) =>
    app.execute(auth.actor, { kind, requestId: rid(), projectId: null, expectedRevision: app.setup(auth.actor).revision, payload } as SetupCommand);
  setup("setup.wake", { language: "th" });
  setup("setup.connect", { route: grok });
  await settle(f);
  setup("setup.connect.continue", {});
  setup("setup.know", { addressAs: "พี่บอส", selfReference: "", language: "th", particle: "khrap" });
  setup("setup.personality.skip", {});
  setup("setup.complete", {});
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function settle(f: Pick<Fixture, "queue" | "store">) {
  for (let i = 0; i < 400; i++) {
    f.queue.pump();
    const pending = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'admitted')")!.n);
    await f.queue.idle();
    if (pending === 0) return;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error("queue did not drain");
}
const general = (f: Fixture) => f.app.generalSpace(f.auth.actor)!.projectId;
/** Opens a General topic from the home composer, as the owner does, and lets Jit answer. */
async function chat(f: Fixture, text: string) {
  const receipt = f.app.execute(f.auth.actor, { kind: "chat.start", requestId: rid(), projectId: general(f), expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { text } });
  await settle(f);
  const reply = f.app.replies(f.auth.actor, general(f), receipt.topic.id, [receipt.message.id]).get(receipt.message.id)!;
  const text_ = reply.state === "answered" ? f.app.conversation(f.auth.actor, general(f), receipt.topic.id).items.find(item => item.id === reply.replyMessageId)!.text : null;
  return { topic: receipt.topic, reply, text: text_ };
}
const jitRequests = (f: Fixture) => f.port.requests.filter(request => request.instructions.operator[0] === jitReplyMarker);

test("the voice check measures Thai and English replies by dictionary words, lines, headings, preambles and closing offers", () => {
  expect(measureVoice("สวัสดีครับ จิตพร้อมช่วยเสมอ")).toEqual({ words: 6, lines: 1, headings: 0, preamble: false, closingOffer: false });
  expect(measureVoice("Hello there, how are you today?").words).toBe(6);
  expect(voiceProblems("ใช้ SQLite ก็พอครับ")).toEqual([]);
  expect(voiceProblems("word ".repeat(81))).toEqual(["words:81>80"]);
  expect(voiceProblems("word ".repeat(81), { words: null })).toEqual([]);
  expect(voiceProblems("บรรทัดแรก\nบรรทัดสอง\nบรรทัดสาม", { lines: voiceLimits.taskReplyLines })).toEqual(["lines:3>2"]);
  expect(voiceProblems("## หัวข้อ\nเนื้อหา\n**สรุป**")).toEqual(["headings:2"]);
  expect(voiceProblems("คำถามที่ดีครับ ใช้ SQLite")).toEqual(["preamble"]);
  expect(voiceProblems("Great question! Use SQLite.")).toEqual(["preamble"]);
  expect(voiceProblems("ใช้ SQLite ครับ\nหากมีคำถามเพิ่มเติม บอกได้เลย")).toEqual(["closing_offer"]);
  expect(voiceProblems("Use SQLite. Let me know if you need more.")).toEqual(["closing_offer"]);
  // Every unguided answer in the eval breaks the voice, so the eval can fail.
  for (const item of [...cases, englishCase]) expect(voiceProblems(item.unguided, item.task ? { lines: voiceLimits.taskReplyLines } : {})).not.toEqual([]);
});

test("scripted voice eval: with policy v2 in its instructions, Jit answers short and moves long work into a task suggestion", async () => {
  const f = await fixture();
  for (const item of cases) {
    const { reply, text, topic } = await chat(f, item.owner);
    expect(reply.state).toBe("answered");
    // A long-work reply is one line (two at most), and its plan becomes the pre-filled task form, not chat.
    expect(voiceProblems(text!, item.detail ? { words: null } : item.task ? { lines: voiceLimits.taskReplyLines } : {})).toEqual([]);
    expect(reply.taskSuggestion).toEqual(item.task ?? null);
    const html = await (await f.web(new Request(`http://localhost:3000/projects/${general(f)}/topics/${topic.id}`, { headers: { cookie: `jit_session=${f.token}` } }))).text();
    expect(html.includes('class="team-card task-suggestion"')).toBe(!!item.task);
    if (item.task) expect(html).toContain(`value="${item.task.title}"`);
  }
  // Suggesting a task created none: only the owner's form post does.
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM tasks")!.n)).toBe(0);
  // Every reply recorded policy v2 and carried both voice rules once.
  for (const request of jitRequests(f)) {
    expect(request.instructions.operator.filter(line => line.includes(communicationPolicyLine))).toHaveLength(1);
    expect(request.instructions.operator.filter(line => line.includes(taskSuggestionInstruction))).toHaveLength(1);
  }
  const versions = f.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM team_runs").map(row => JSON.parse(row.record_json)))
    .filter(record => record.kind === "jit_reply").map(record => record.policyVersion);
  expect(versions).toEqual(cases.map(() => 2));
  // English persona: the same voice.
  f.app.execute(f.auth.actor, { kind: "persona.set", requestId: rid(), projectId: null, expectedRevision: f.app.persona(f.auth.actor).revision,
    payload: { addressAs: "Boss", language: "en", selfReference: "", particle: "none", personality: "friendly", aboutMe: "" } });
  const english = await chat(f, englishCase.owner);
  expect(voiceProblems(english.text!)).toEqual([]);
});

test("scripted voice eval control: a model that never receives the voice rules fails the same check", async () => {
  const f = await fixture({ drop: true });
  for (const item of cases) {
    const { reply, text } = await chat(f, item.owner);
    expect(reply.state).toBe("answered");
    expect(voiceProblems(text!, item.detail ? { words: null } : item.task ? { lines: voiceLimits.taskReplyLines } : {})).not.toEqual([]);
    expect(reply.taskSuggestion).toBeNull();
  }
});

test("worst case (General space topic, access workspace, about-me, a long roster and several routes): every operator line fits", async () => {
  const f = await fixture();
  f.app.execute(f.auth.actor, { kind: "persona.set", requestId: rid(), projectId: null, expectedRevision: f.app.persona(f.auth.actor).revision,
    payload: { addressAs: "พี่บอส", language: "th", selfReference: "จิต", particle: "khrap", personality: "calm", aboutMe: "ทำแอปส่วนตัวบนเครื่องที่บ้าน ".repeat(12).trim() } });
  for (let index = 0; index < 12; index++) {
    f.app.execute(f.auth.actor, { kind: "role.save", projectId: null, requestId: rid(), expectedRevision: f.app.team(f.auth.actor).ownerRevision,
      payload: { roleId: null, name: `ผู้เชี่ยวชาญด้านสถาปัตยกรรมซอฟต์แวร์ลำดับที่ ${index}`, kind: "specialist", responsibility: "วิเคราะห์", enabled: true,
        route: { ...grok, model: `fixture-grok-variant-${index}` } } });
  }
  const projectId = general(f), access = f.app.projectAccess(f.auth.actor, projectId);
  f.app.execute(f.auth.actor, { kind: "access.level.set", requestId: rid(), projectId, expectedRevision: access.revision,
    payload: { level: "workspace", confirmToken: accessConfirmToken(projectId, access.level, "workspace", access.revision) } });
  const { reply } = await chat(f, "สวัสดี");
  expect(reply.state).toBe("answered");
  const operator = jitRequests(f).at(-1)!.instructions.operator;
  expect(operator.length).toBeLessThanOrEqual(8);
  for (const line of operator) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(2048);
  // Every optional entry is offered once, together on the proposal-kinds line; the policy line ends with the policy.
  expect(operator[1]!.endsWith(communicationPolicyLine)).toBe(true);
  for (const instruction of [promotionInstruction, mcpProposalInstruction, taskSuggestionInstruction]) {
    expect(operator.filter(line => line.includes(instruction))).toEqual([operator[2]!]);
  }
  expect(operator.some(line => /\(\+\d+ more\)/.test(line))).toBe(true);
});
