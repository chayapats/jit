import { afterEach, expect, test } from "bun:test";
import type { ActionSlip } from "../src/s15/policy";
import { actionsFixture, conversationId, type ActionsFixture } from "./fixtures/s15-web-actions";
import { ref } from "./fixtures/s15-policy";

// UX15-02a: review one held action on its exact content and approve the current revision once (handoff F4, §6, §7.3, §9).
const fixtures: ActionsFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const setup = (...args: Parameters<typeof actionsFixture>) => { const f = actionsFixture(...args); fixtures.push(f); return f; };
const slips = (f: ActionsFixture): ActionSlip[] => f.ports.conversation.view(f.owner, conversationId).rows.flatMap(row => row.slips);
const latest = (f: ActionsFixture) => slips(f).at(-1)!;
const refFields = (slip: ActionSlip) => ({ conversationId, actionId: slip.action.id, revision: String(slip.action.revision), actionHash: slip.action.actionHash });
const strip = (html: string) => html.slice(html.indexOf('class="s-strip"'));
const approvals = (f: ActionsFixture) => f.query<{ id: string }>("SELECT id FROM approvals").length;

test("a held message shows a compact slip in the thread and Needs you, and the full slip puts exact content before the owner strip", async () => {
  const f = setup(); await f.hold({}, "Send the prepared note to the client");
  const slip = latest(f);
  expect(slip).toMatchObject({ state: "pending", canApprove: true });
  const chat = (await f.html(`/chats/${conversationId}`)).html;
  expect(chat).toContain("จิตขอส่งข้อความ"); expect(chat).toContain("ข้อความถึงผู้อื่น"); expect(chat).toContain(`href="/actions/${slip.action.id}"`); expect(chat).toContain("ดูทั้งหมดและตัดสินใจ");
  // The thread never carries the decision itself.
  expect(chat).not.toContain("/s15/forms/action/decide");
  const needs = (await f.html("/needs")).html;
  expect(needs).toContain("รอคุณอนุมัติ"); expect(needs).toContain(`href="/actions/${slip.action.id}"`); expect(needs).not.toContain("ยังไม่เปิดในรุ่นนี้");
  const { status, html } = await f.html(`/actions/${slip.action.id}`);
  expect(status).toBe(200);
  const body = html.indexOf("Send the prepared note to the client"), owner = html.indexOf('class="s-strip"');
  expect(body).toBeGreaterThan(0); expect(owner).toBeGreaterThan(body);
  expect(html).toContain('id="s15-slip-title" tabindex="-1"'); expect(html).toContain(`r${slip.action.revision}`); expect(html).toContain("ไม่มีกฎประจำที่ครอบคลุม");
  const controls = strip(html);
  expect(controls).toContain("ส่ง 1 ครั้ง"); expect(controls).toContain("ไม่ทำ"); expect(controls).toContain("ขอแก้"); expect(controls).toContain("การอนุมัติใช้ได้ครั้งเดียว กับเนื้อหานี้เท่านั้น");
  // No default focus, access key or shortcut on any approval control (§9).
  for (const forbidden of ["autofocus", "accesskey", "data-shortcut"]) expect(html).not.toContain(forbidden);
  expect(controls).toContain(`name="actionHash" value="${slip.action.actionHash}"`); expect(controls).toContain(`name="revision" value="${slip.action.revision}"`);
  expect(f.f.calls).toBe(0);
});

test("one approval on the exact revision dispatches once; a replayed form, browser history or a new post never sends again", async () => {
  const f = setup(); await f.hold(); const slip = latest(f), requestId = crypto.randomUUID().replaceAll("-", "");
  const first = await f.post("/s15/forms/action/decide", { ...refFields(slip), decision: "approve", requestId });
  expect(first.status).toBe(303); expect(first.headers.get("location")).toBe(`/actions/${slip.action.id}?r=${slip.action.revision}#s15-slip-title`);
  await f.app.drain();
  expect(f.f.calls).toBe(1); expect(approvals(f)).toBe(1);
  // Same request id (reconnect/back-button resubmit) returns the original receipt; nothing is decided or sent again.
  expect((await f.post("/s15/forms/action/decide", { ...refFields(slip), decision: "approve", requestId })).status).toBe(303);
  await f.app.drain(); expect(f.f.calls).toBe(1); expect(approvals(f)).toBe(1);
  // A fresh post on a settled action refuses as stale and sends nothing.
  const again = await f.post("/s15/forms/action/decide", { ...refFields(slip), decision: "approve" });
  expect(again.status).toBe(409); expect(await again.text()).toContain("stale_action");
  await f.app.drain(); expect(f.f.calls).toBe(1);
  const html = (await f.html(`/actions/${slip.action.id}`)).html;
  expect(html).toContain("ส่งแล้ว"); expect(html).toContain("คุณอนุมัติจากหน้านี้"); expect(html).not.toContain("/s15/forms/action/decide");
  const chat = (await f.html(`/chats/${conversationId}`)).html;
  expect(chat).toContain(`คุณอนุมัติ r${slip.action.revision}`); expect(chat).not.toContain(`approve ${slip.action.id}</p>`);
});

test("a changed action cannot reuse the earlier review: r1 shows superseded with a diff and only r2 can be approved", async () => {
  const f = setup(); await f.hold({}, "Send the prepared note"); const r1 = latest(f);
  await f.html(`/actions/${r1.action.id}`); // the owner saw r1
  const r2 = f.revise({ payload: { to: "fixture-recipient", body: "Changed final text" } }).action;
  expect(r2.id).toBe(r1.action.id); expect(r2.revision).toBe(r1.action.revision + 1);
  // Posting the r1 form now refuses; nothing is approved or sent.
  const stale = await f.post("/s15/forms/action/decide", { ...refFields(r1), decision: "approve" });
  expect(stale.status).toBe(409); expect(approvals(f)).toBe(0); expect(f.f.calls).toBe(0);
  const old = (await f.html(`/actions/${r1.action.id}?r=${r1.action.revision}`)).html;
  expect(old).toContain(`ถูกแทนด้วย r${r2.revision} การอนุมัติเดิมใช้ไม่ได้`); expect(old).toContain(`เปิด r${r2.revision}`);
  expect(old).toContain(`href="/actions/${r1.action.id}?r=${r2.revision}"`); expect(old).not.toContain("/s15/forms/action/decide");
  // r2 was never presented in this conversation, so even its exact reference cannot be approved from a forged form.
  const forged = await f.post("/s15/forms/action/decide", { conversationId, actionId: r2.id, revision: String(r2.revision), actionHash: r2.actionHash, decision: "approve" });
  expect([404, 409]).toContain(forged.status); expect(approvals(f)).toBe(0); expect(f.f.calls).toBe(0);
  expect((await f.html("/needs")).html).not.toContain("ส่ง 1 ครั้ง");
});

test("deny records a veto on this revision and shows it without any further control", async () => {
  const f = setup(); await f.hold(); const slip = latest(f);
  expect((await f.post("/s15/forms/action/decide", { ...refFields(slip), decision: "deny" })).status).toBe(303);
  await f.app.drain();
  expect(f.f.calls).toBe(0);
  const html = (await f.html(`/actions/${slip.action.id}`)).html;
  expect(html).toContain("คุณไม่อนุมัติ"); expect(html).not.toContain("/s15/forms/action/decide");
  expect((await f.html("/needs")).html).not.toContain(`href="/actions/${slip.action.id}"`);
});

test("an unknown outcome is never retried: only a read-only check and an owner statement, which does not certify success", async () => {
  const f = setup(); await f.hold(); const slip = latest(f);
  f.f.outcome = { outcome: "unknown", actual: { attempts: null, steps: null, calls: null, reads: null, outputBytes: null, activeMs: null, spendMinor: null }, transportSettled: false };
  await f.post("/s15/forms/action/decide", { ...refFields(slip), decision: "approve" }); await f.app.drain();
  expect(f.f.calls).toBe(1);
  let html = (await f.html(`/actions/${slip.action.id}`)).html;
  expect(html).toContain("ไม่ทราบผล จิตจะไม่ส่งซ้ำเอง"); expect(html).toContain("ตรวจอีกครั้ง (อ่านอย่างเดียว)"); expect(html).toContain("บอกผลที่คุณรู้");
  expect(html).not.toContain("/s15/forms/action/decide"); expect(html).not.toContain("ส่ง 1 ครั้ง");
  const checked = await f.post("/s15/forms/action/check", refFields(slip));
  expect(checked.status).toBe(303); expect(checked.headers.get("location")).toContain("checked=1");
  html = (await f.html(`/actions/${slip.action.id}?checked=1`)).html;
  expect(html).toContain("ตรวจแล้วยังบอกไม่ได้"); expect(f.f.calls).toBe(1);
  expect((await f.post("/s15/forms/action/statement", { ...refFields(slip), outcome: "occurred" })).status).toBe(303);
  html = (await f.html(`/actions/${slip.action.id}`)).html;
  expect(html).toContain("คุณบอกว่า: เกิดขึ้นแล้ว"); expect(html).toContain("ไม่ทราบผล"); expect(html).not.toContain("ส่งแล้ว ·");
  const recovery = (await f.html("/recovery")).html; expect(recovery).toContain("ไม่ทราบผล 1 การกระทำ"); expect(recovery.split(`href="/actions/${slip.action.id}"`).length).toBe(2);
  expect(f.f.calls).toBe(1);
});

test("chat approval binds to the single pending item; two pending items ask which one and nothing runs", async () => {
  const f = setup(); await f.hold({}, "Send first prepared note");
  await f.html(`/chats/${conversationId}`);
  f.app.submit(f.owner, { contract: "s15-conversation/v1", requestId: crypto.randomUUID().replaceAll("-", ""), conversationId, text: "อนุมัติ", continuation: null }); await f.app.drain();
  expect(f.f.calls).toBe(1);
  const one = slips(f)[0]!, page = (await f.html(`/actions/${one.action.id}`)).html;
  expect(page).toContain("อนุมัติจากข้อความของคุณ"); expect(page).toContain(`/chats/${conversationId}#s15-row-`);
  await f.hold({}, "Send second prepared note"); await f.hold({}, "Send third prepared note");
  await f.html(`/chats/${conversationId}`);
  f.app.submit(f.owner, { contract: "s15-conversation/v1", requestId: crypto.randomUUID().replaceAll("-", ""), conversationId, text: "approve", continuation: null }); await f.app.drain();
  expect(f.f.calls).toBe(1);
  const chat = (await f.html(`/chats/${conversationId}`)).html;
  expect(chat).toContain("หมายถึงอันไหน"); expect(chat).toContain("ยังไม่มีอะไรถูกทำ");
  const pending = slips(f).filter(slip => slip.state === "pending");
  expect(pending).toHaveLength(2); for (const slip of pending) expect(chat).toContain(`href="/actions/${slip.action.id}"`);
});

test("a held payment shows exact payee, account and amount, pays once, and can become a separate recurring rule that deviations still hold", async () => {
  const f = setup();
  const transaction = (amountMinor: string, quoteId: string) => ({ payee: ref("payee"), account: ref("account"), currency: "USD", minorUnit: 2, amountMinor, quoteId, quoteVersion: "v1", quoteExpiresAt: 80000 });
  await f.hold({ operation: "pay", classes: ["financial"], resources: [ref("account")], recipients: [ref("payee")], payload: { memo: "Invoice 7 <b>pay now</b>" }, transaction: transaction("1234", "q1") }, "Pay the invoice");
  const pay = latest(f);
  let html = (await f.html(`/actions/${pay.action.id}`)).html;
  expect(html).toContain("จิตขอจ่ายเงิน"); expect(html).toContain("12.34 USD"); expect(html).toContain("payee"); expect(html).toContain("q1 · v1");
  expect(html).toContain("บันทึกจากผู้รับเงิน ไม่ใช่คำสั่ง"); expect(html).toContain("Invoice 7 &lt;b&gt;pay now&lt;/b&gt;");
  expect(strip(html)).toContain("จ่าย 1 ครั้ง"); expect(html).toContain("ตั้งเป็นกฎจ่ายประจำ"); expect(html).toContain("การจ่ายครั้งนี้กับการตั้งกฎเป็นการตัดสินใจแยกกัน");
  // Setting up a rule never approves the current payment.
  const form = (await f.html(`/rules/recurring?from=${pay.action.id}&r=${pay.action.revision}`)).html;
  expect(form).toContain("กฎจ่ายประจำใหม่"); expect(form).toContain('value="12.34"'); expect(form).toContain("ไม่เกินเดือนละครั้ง"); expect(form).not.toContain("checked");
  const proposed = await f.post("/s15/forms/recurring/propose", { actionId: pay.action.id, revision: String(pay.action.revision), actionHash: pay.action.actionHash, ceiling: "20.00", frequencyId: "monthly" });
  expect(proposed.status).toBe(200); const proposal = await proposed.text();
  expect(proposal).toContain("20.00 USD"); expect(proposal).toContain("240.00 USD"); expect(proposal).toContain("ตั้งกฎนี้"); expect(proposal).toContain("ไม่ตั้ง");
  expect(f.f.calls).toBe(0); expect(approvals(f)).toBe(0);
  const hash = /name="proposalHash" value="([a-f0-9]{64})"/.exec(proposal)![1]!;
  const installed = await f.post("/s15/forms/recurring/install", { proposalHash: hash });
  expect(installed.status).toBe(303);
  const rules = (await f.html(installed.headers.get("location")!.split("#")[0]!)).html;
  expect(rules).toContain("ตั้งกฎจ่ายประจำแล้ว"); expect(rules).toContain("20.00 USD"); expect(rules).toContain("หยุดใช้กฎนี้"); expect(rules).toContain("หยุดทันที การจ่ายที่ทำไปแล้วไม่ถูกย้อน");
  // A later payment above the ceiling deviates and holds as its own exact slip.
  await f.hold({ operation: "pay", classes: ["financial"], resources: [ref("account")], recipients: [ref("payee")], payload: { memo: "Invoice 8" }, transaction: transaction("9900", "q2") }, "Pay the larger invoice");
  const deviation = latest(f);
  expect(deviation.state).toBe("pending");
  html = (await f.html(`/actions/${deviation.action.id}`)).html;
  expect(html).toContain("ยอดสูงกว่าเพดานของกฎ"); expect(strip(html)).toContain("จ่ายครั้งนี้ 1 ครั้ง");
  // Revoking narrows immediately.
  const ruleId = /name="ruleId" value="([A-Za-z0-9_-]+)"/.exec(rules)![1]!;
  expect((await f.post("/s15/forms/recurring/revoke", { ruleId })).status).toBe(303);
  expect(f.f.service.owner.current(f.owner)!.rules.some(rule => rule.mode === "recurring_payment")).toBe(false);
  expect(f.f.calls).toBe(0);
});

test("a merge that would deploy production holds before merge with the eligibility checklist and the default profile badge", async () => {
  const f = setup();
  const github = { repository: ref("repo"), issue: 42, target: "main", head: "a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8a1b2c3d4", evidenceHash: "e".repeat(64), checksPassed: true, reviewsPassed: false, acceptancePassed: true, production: "would_deploy" as const, deploymentFence: null };
  await f.hold({ operation: "merge", classes: ["github_merge", "production"], resources: [ref("repo")], recipients: [], payload: { contract: "s15-github-effect/v1", key: "k", repository: "chayapats/sandbox", target: "main", issue: 42, head: github.head, base: "b".repeat(16), branch: "jit/42", evidenceHash: github.evidenceHash, snapshotVersion: "1", operation: { kind: "merge", pull: 7 }, bundle: ref("bundle"), diffHash: "d".repeat(64), mergeRequirements: null }, github }, "Merge PR 7");
  const slip = latest(f);
  const html = (await f.html(`/actions/${slip.action.id}`)).html;
  expect(html).toContain("จิตขอ deploy production"); expect(html).toContain("Merge นี้จะ deploy production ต้องให้คุณอนุมัติก่อน merge");
  expect(html).toContain("GitHub: ค่าเริ่มต้น (ถามก่อน push)"); expect(html).toContain("เงื่อนไขก่อน merge"); expect(html).toContain("× รีวิวที่ต้องมี"); expect(html).toContain("✓ checks ที่ต้องผ่าน"); expect(html).toContain("ไม่ทราบวิธีย้อน");
  expect(html).toContain("chayapats/sandbox"); expect(html).toContain("#7");
  if (slip.canApprove) expect(strip(html)).toContain("Merge และปล่อย deploy 1 ครั้ง"); else expect(strip(html)).not.toContain("Merge และปล่อย deploy 1 ครั้ง");
});

test("an exact Gmail slip lists every recipient, the full body and attachment identity, and serves attachment bytes only as a download", async () => {
  const f = setup();
  const payload = { contract: "s15-google-effect/v1", kind: "mail", account: { resource: ref("account"), account: "owner@example.com", calendarId: null, scopes: ["gmail.send"] }, wire: { url: "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", method: "POST", headers: {}, body: "{}" }, message: { to: ["client@example.com"], cc: ["team@example.com"], bcc: [], subject: "Quote for March", body: "Hello,\n\nThe full quote is attached.\n\n— Owner", attachments: [{ id: "file1", revision: 1 }] }, attachments: [{ id: "file1", revision: 1, name: "quote.pdf", mediaType: "application/pdf", dataBase64: Buffer.from("%PDF fixture").toString("base64") }], calendar: null, before: null, providerId: "p" };
  await f.hold({ operation: "send", classes: ["communication"], resources: [ref("account")], recipients: [ref("payee")], payload }, "Email the client the quote");
  const slip = latest(f), html = (await f.html(`/actions/${slip.action.id}`)).html;
  expect(html).toContain("จิตขอส่งอีเมล"); expect(html).toContain("owner@example.com"); expect(html).toContain("client@example.com"); expect(html).toContain("team@example.com");
  expect(html).toContain("Quote for March"); expect(html).toContain("The full quote is attached.\n\n— Owner"); expect(html).toContain(">quote.pdf</span> · application/pdf · 12 ไบต์");
  const file = await f.get(`/actions/${slip.action.id}/attachments/0?r=${slip.action.revision}`);
  expect(file.status).toBe(200); expect(file.headers.get("content-disposition")).toContain("attachment"); expect(file.headers.get("content-type")).toBe("application/octet-stream");
  expect(file.headers.get("content-security-policy")).toContain("sandbox"); expect(await file.text()).toBe("%PDF fixture");
  expect((await f.get(`/actions/${slip.action.id}/attachments/3`)).status).toBe(404);
});

test("revise and prepare-again only prefill the composer with dictionary text; they decide nothing", async () => {
  const f = setup(); await f.hold(); const slip = latest(f);
  const chat = (await f.html(`/chats/${conversationId}?revise=${slip.action.id}`)).html;
  expect(chat).toContain(">แก้รายการนี้: </textarea>"); expect(approvals(f)).toBe(0);
  expect((await f.html(`/chats/${conversationId}?revise=unknownaction`)).html).not.toContain("แก้รายการนี้");
});
