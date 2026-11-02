import { afterEach, expect, test } from "bun:test";
import { AppError } from "../src/errors";
import type { S15MemoryClaim, S15ModelBudgetView, S15WebMemory, S15WebModels } from "../src/s15/web";
import { newId, webFixture, type WebActor, type WebFixture } from "./fixtures/s15-web";

// UX15-04 (F8 memory) and UX15-05 (F10 models and budget) against the MEM15/MODEL15 owner contracts,
// feature-detected: an absent port renders an honest "not available yet" state.
const fixtures: WebFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const setup = (...args: Parameters<typeof webFixture>) => { const f = webFixture(...args); fixtures.push(f); return f; };
const html = async (f: WebFixture, path: string, headers: Record<string, string> = {}) => (await f.get(path, headers)).text();

const claim = (id: string, over: Partial<S15MemoryClaim> = {}): S15MemoryClaim => ({ id, revision: 1, kind: "fact", category: "fact", text: `Statement ${id}`,
  provenance: { origin: { kind: "owner_message", id: "m1", conversationId: "c1", at: 1800000000000 }, scope: { kind: "team" } }, createdAt: 1800000000000, lifecycle: "active", confirmation: "owner_stated", supersedes: null, correction: null, sourceState: "current", ...over });
/** Structural MEM15-01 owner API double that enforces exact revisions like the real service. */
function memoryPort() {
  const claims = [claim("a"), claim("b", { kind: "inference", category: "preference", confirmation: "unconfirmed", text: "Prefers Thai replies" }), claim("c", { provenance: { origin: { kind: "historical", id: "h", conversationId: null, at: 1 }, scope: { kind: "bot", botId: "writer", origin: "s14" } } }), claim("d", { lifecycle: "forgotten", text: "" })];
  const commands: unknown[] = [];
  const port: S15WebMemory<WebActor> = {
    view: () => ({ contract: "s15-memory-view/v1", claims: structuredClone(claims) }),
    command(_actor, input) {
      const value = input as { kind: string; claim: { id: string; revision: number }; text?: string; requestId: string };
      const target = claims.find(item => item.id === value.claim.id);
      if (!target || target.revision !== value.claim.revision) throw new AppError("stale_revision", 409);
      if (value.kind === "memory.impact") return { contract: "s15-memory-impact/v1", claim: value.claim, impact: { claims: 1, sources: 1, summaries: 1, artifacts: 0, contexts: 2, nativeSessions: 1, workItems: 3 } };
      commands.push(structuredClone(value));
      target.revision++; target.lifecycle = value.kind === "memory.correct" ? "superseded" : "forgotten"; target.text = "";
      if (value.kind === "memory.correct") claims.push(claim(`${target.id}2`, { text: value.text!, supersedes: target.id }));
      return { contract: "s15-memory-receipt/v1" };
    },
  };
  return { port, commands, claims };
}
const budgetView = (over: Partial<S15ModelBudgetView> = {}): S15ModelBudgetView => ({ contract: "s15-model-budget/v1", currency: "USD",
  ceilings: [{ dimension: "spendMinor", ceiling: "2000", charged: "500", measured: null, unknown: true }, { dimension: "calls", ceiling: 100, charged: 12, measured: 10, unknown: false }],
  routes: [{ provider: "codex", model: "gpt-scripted", charge: "subscription", availability: "available", holdCode: null, selection: { route: { id: "route", revision: 1 }, model: { id: "model", revision: 1 }, effort: "high" } },
    { provider: "grok", model: "grok-scripted", charge: "metered", availability: "quota", holdCode: "route_unavailable", selection: { route: { id: "route2", revision: 1 }, model: { id: "model2", revision: 1 }, effort: "low" } }],
  pins: [], selections: [{ id: "s1", workId: "authority1", reason: "difficult", state: "completed", route: { provider: "codex", modelId: "gpt-scripted" }, effort: { requested: "high", evidence: "requested_only", providerConfirmed: false } }], unsettled: 1, ...over });

test("memory and models show an honest not-available state when their slices are not composed", async () => {
  const f = setup();
  expect(await html(f, "/memory")).toContain("ความจำแบบ S15 ยังไม่เปิดในเครื่องนี้");
  expect(await html(f, "/models")).toContain("หน้าโมเดลและงบแบบ S15 ยังไม่เปิดในเครื่องนี้");
  expect((await f.post("/s15/forms/memory/forget", { claimId: "a", claimRevision: "1", filter: "all" })).status).toBe(404);
});

test("memory lists claims with kind, source, scope and lifecycle, and filters them", async () => {
  const memory = memoryPort(), f = setup(() => ({ memory: memory.port }));
  const all = await html(f, "/memory");
  expect(all).toContain("Statement a"); expect(all).toContain("ข้อเท็จจริง"); expect(all).toContain("จากข้อความของคุณ"); expect(all).toContain("ใช้ได้ทั้งทีม"); expect(all).toContain("คุณบอกเอง");
  expect(all).toContain('aria-current="page">ทั้งหมด'); expect(all).not.toContain("ลบข้อความแล้ว");
  const inferences = await html(f, "/memory?filter=inferences");
  expect(inferences).toContain("Prefers Thai replies"); expect(inferences).toContain("ข้อสันนิษฐาน"); expect(inferences).not.toContain("Statement a");
  expect(await html(f, "/memory?filter=s14")).toContain("ส่วนตัวของ writer จาก S14 · ยังไม่แชร์ให้ทีม");
  const forgotten = await html(f, "/memory?filter=forgotten");
  expect(forgotten).toContain("ลบข้อความแล้ว เหลือไว้เฉพาะประวัติ"); expect(forgotten).not.toContain("?filter=forgotten&amp;forget=d");
  expect(await html(f, "/memory", { "accept-language": "en" })).toContain("From your message");
});

test("correct records an exact-revision owner correction that then takes precedence", async () => {
  const memory = memoryPort(), f = setup(() => ({ memory: memory.port }));
  const form = await html(f, "/memory?claim=a");
  expect(form).toContain('<textarea name="text" rows="3" maxlength="2048" required>Statement a</textarea>'); expect(form).toContain("บันทึกการแก้");
  const saved = await f.post("/s15/forms/memory/correct", { claimId: "a", claimRevision: "1", text: "Corrected statement", filter: "all" });
  expect(saved.headers.get("location")).toBe("/memory?filter=all&saved=corrected");
  expect(memory.commands).toEqual([expect.objectContaining({ contract: "s15-memory-command/v1", kind: "memory.correct", claim: { id: "a", revision: 1 }, text: "Corrected statement" })]);
  const after = await html(f, "/memory?filter=corrected&saved=corrected");
  expect(after).toContain("บันทึกการแก้แล้ว"); expect(after).toContain("ถูกแก้โดยคุณ"); expect(after).toContain("Corrected statement");
  // A stale revision is refused with its reason; nothing else is written.
  const stale = await f.post("/s15/forms/memory/correct", { claimId: "a", claimRevision: "1", text: "Again", filter: "all" });
  expect(stale.status).toBe(409); expect(await stale.text()).toContain("stale_revision"); expect(memory.commands).toHaveLength(1);
});

test("forget shows its impact first and the danger button posts the exact revision", async () => {
  const memory = memoryPort(), f = setup(() => ({ memory: memory.port }));
  const sheet = await html(f, "/memory?forget=b");
  expect(sheet).toContain("จะไม่ถูกค้นหาหรือใช้ในงานต่อไป · สิ่งที่โมเดลเคยเห็นไปแล้วเรียกคืนไม่ได้");
  expect(sheet).toContain("งานที่ใช้ไปแล้ว 3 งานจะถูกทำเครื่องหมาย"); expect(sheet).toContain('class="s-btn danger">ลืม</button>');
  expect(memory.commands).toEqual([]);
  const done = await f.post("/s15/forms/memory/forget", { claimId: "b", claimRevision: "1", filter: "all" });
  expect(done.headers.get("location")).toBe("/memory?filter=all&saved=forgotten");
  expect(memory.commands).toEqual([expect.objectContaining({ kind: "memory.forget", claim: { id: "b", revision: 1 } })]);
});

test("a reply that retained memory shows a collapsed note with Fact/Inference, source, Correct and Forget", async () => {
  const memory = memoryPort();
  const f = setup(base => ({ memory: memory.port, conversation: { ...base.conversation, view: (actor, id) => { const view = base.conversation.view(actor, id); for (const row of view.rows) Object.assign(row, { memory: { retained: [{ id: "a" }, { id: "b" }] } }); return view; } } }));
  const conversation = newId();
  await f.send(conversation, "Create hello.txt containing hello."); await f.app.drain();
  const page = await html(f, `/chats/${conversation}`);
  expect(page).toContain("จำไว้ 2 เรื่อง"); expect(page).toContain("Prefers Thai replies"); expect(page).toContain('href="/memory?forget=b#s15-claim-b"');
});

test("models: approved routes, quota without switching accounts, meters that never show unknown as zero", async () => {
  const models: S15WebModels<WebActor> = { project: () => budgetView() }, f = setup(() => ({ models }));
  const page = await html(f, "/models");
  expect(page).toContain("codex · gpt-scripted"); expect(page).toContain("ใช้โควตาของแพ็กเกจ"); expect(page).toContain("อนุญาตแล้ว");
  expect(page).toContain("บัญชี grok ใช้ไม่ได้ตอนนี้ (โควตาเต็ม) จิตไม่เปลี่ยนไปใช้บัญชีอื่นเอง");
  expect(page).toContain("ใช้ไป 5.00 USD · วัดได้จริง ไม่ทราบ · ไม่ทราบ: บางส่วนวัดไม่ได้ ไม่นับเป็นศูนย์");
  expect(page).toContain('<span class="s-unknown-bar" aria-hidden="true"></span>'); expect(page).toContain("เพดาน 20.00 USD");
  expect(page).toContain("ยังมี 1 รายการที่รอสรุปการใช้");
  expect(page).not.toContain("งบใช้งานหมด");
  expect(page).not.toMatch(/<form[^>]*action="\/s15\/forms\/models/);
});

test("an exhausted budget is a hold that points to this page only", async () => {
  const models: S15WebModels<WebActor> = { project: () => budgetView({ ceilings: [{ dimension: "calls", ceiling: 10, charged: 10, measured: 10, unknown: false }] }) }, f = setup(() => ({ models }));
  const page = await html(f, "/models");
  expect(page).toContain("งบใช้งานหมด งานใหม่ที่ต้องใช้โมเดลจะรอ"); expect(page).toContain("เพิ่มงบได้ที่หน้านี้เท่านั้น");
});

test("each work reply discloses the recorded model, effort and reason, never the model's own claim", async () => {
  const models: S15WebModels<WebActor> = { project: () => budgetView() }, f = setup(() => ({ models }));
  const conversation = newId();
  await f.send(conversation, "Create hello.txt containing hello."); await f.app.drain();
  const page = await html(f, `/chats/${conversation}`);
  expect(page).toContain("ตอบด้วย gpt-scripted · คิด: สูง"); expect(page).toContain("เลือกเพราะ: งานซับซ้อน (ในรายการที่คุณอนุมัติ)"); expect(page).toContain("ผู้ให้บริการไม่ยืนยันว่าใช้ระดับความคิดนี้");
  const pinned: S15WebModels<WebActor> = { project: () => budgetView({ pins: [{ workId: "authority1", pins: { route: null, model: { id: "model" }, effort: "high" } }] }) };
  const g = setup(() => ({ models: pinned })), other = newId();
  await g.send(other, "Create hello.txt containing hello."); await g.app.drain();
  expect(await html(g, `/chats/${other}`)).toContain("ตามที่คุณปักไว้");
});
