import { afterEach, expect, test } from "bun:test";
import { AppError } from "../src/errors";
import type { LoginState } from "../src/s15/browser";
import type { VmStatus } from "../src/s15/vm";
import type { ResponsibilityProjection } from "../src/s15/work";
import type { S15GithubCapture, S15WebBrowser } from "../src/s15/web";
import { newId, webFixture, type WebActor, type WebFixture } from "./fixtures/s15-web";

// UX15-02b/02c, UX15-03 and UX15-06 surfaces over fake owner ports (handoff F5, F6, F9, F11, F12).
const fixtures: WebFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const setup = (...args: Parameters<typeof webFixture>) => { const f = webFixture(...args); fixtures.push(f); return f; };
const page = async (f: WebFixture, path: string) => { const response = await f.get(path); return { status: response.status, html: await response.text() }; };
const unknownUsage = { attempts: null, steps: null, calls: null, reads: null, outputBytes: null, activeMs: null, spendMinor: null };

function duty(overrides: Partial<ResponsibilityProjection> = {}): ResponsibilityProjection {
  return { contract: "s15-responsibility/v1", id: "duty1", sourceRequestId: "src1", conversationId: "conv1", originalText: "คอยดูแล PR #352 จนผ่าน", ownerGeneration: 1, workId: "work1", purpose: { id: "p", revision: 1, generation: 1 }, resources: [], subject: "issue:352", completion: "CI and review pass on the current head", triggers: ["ci", "review"],
    stallPolicy: { noProgressApproaches: 3, reserveCalls: 1, maxAttempts: 6 }, state: "working", wait: null, attempts: [], report: null, proposals: [], readyEventId: null, stallCheckpoint: 0, stopRequested: false, resumedAfterRestart: false, createdAt: 1, updatedAt: 1,
    budget: { charged: { ...unknownUsage, calls: 4 }, measured: unknownUsage, unknown: ["spendMinor"] }, stopImpact: { responsibilityIds: ["duty1"], heldAttempts: [], otherResponsibilities: 2 }, ...overrides };
}
const paused = (): ResponsibilityProjection => duty({ state: "paused", report: { code: "no_progress", at: 1800000000000, attempts: [{ id: "a1", approach: "Re-run flaky test", evidenceRefs: ["ev1"], progress: "none" }, { id: "a2", approach: "Pin dependency", evidenceRefs: [], progress: "none" }, { id: "a3", approach: "Bisect <b>commit</b>", evidenceRefs: ["ev3"], progress: "none" }], recommendation: "Ask the reviewer about the failing check", otherAuthorizedWorkContinues: true } });

test("durable CI and review waits are calm and never in Needs you; a paused responsibility is, with its report and three replies", async () => {
  let list = [duty({ id: "wait", state: "waiting", wait: { kind: "ci", key: "ci", since: 1800000000000, evidenceRefs: [] }, resumedAfterRestart: true }), paused()];
  const stops: string[] = [];
  const f = setup(() => ({ duties: { list: () => list, project: (_actor, id) => { const found = list.find(item => item.id === id); if (!found) throw new AppError("not_found", 404); return found; }, stop: (_actor, id) => { stops.push(id); list = list.map(item => item.id === id ? { ...item, state: "stopping", stopRequested: true } : item); } } }));
  const work = (await page(f, "/work")).html;
  expect(work).toContain("รอ CI อยู่ จิตจะกลับมาดูเองเมื่อเสร็จ ไม่ต้องทำอะไร"); expect(work).toContain("ยังดูแลอยู่หลังรีสตาร์ต"); expect(work).toContain("รอ CI");
  const needs = (await page(f, "/needs")).html;
  expect(needs).not.toContain("รอ CI อยู่"); expect(needs).toContain("หยุดพักไว้: ลอง 3 วิธีแล้วยังไม่คืบ");
  expect(needs).toContain("Bisect &lt;b&gt;commit&lt;/b&gt;"); expect(needs).toContain("Ask the reviewer about the failing check"); expect(needs).toContain("จิตแนะนำ");
  expect(needs).toContain("ลองตามที่แนะนำ"); expect(needs).toContain("บอกวิธีอื่น"); expect(needs).toContain("หยุดงานนี้"); expect(needs).toContain("หยุดเฉพาะ ‘คอยดูแล PR #352 จนผ่าน’ · งานอื่น 2 งานยังทำต่อ");
  expect(needs).toContain("งานอื่นที่อนุญาตไว้ยังทำต่อ"); expect(needs).toContain("บางส่วนไม่ทราบ");
  expect((await page(f, "/chats/new")).status).toBe(303);
  // "Try the recommendation" only prefills the composer; nothing resumes until the owner sends.
  const prefill = (await page(f, "/chats/conv1?duty=duty1&reply=recommended")).html;
  expect(prefill).toContain(">ลองตามที่แนะนำ: Ask the reviewer about the failing check</textarea>");
  const stop = await f.post("/s15/forms/duty/stop", { duty: "duty1" });
  expect(stop.status).toBe(303); expect(stops).toEqual(["duty1"]);
  expect((await page(f, "/duties/duty1")).html).toContain("สั่งหยุดแล้ว · กำลังรอให้สิ่งที่ค้างจบจริง");
});

test("a resumed responsibility shows the same report with its next state; stopped and completed show no stop control", async () => {
  const resumed = { ...paused(), state: "ready" as const };
  const f = setup(() => ({ duties: { list: () => [resumed, duty({ id: "done", state: "completed" })], project: (_a, id) => id === "done" ? duty({ id: "done", state: "completed" }) : resumed, stop: () => {} } }));
  const html = (await page(f, "/duties/duty1")).html;
  expect(html).toContain("ทำต่อแล้ว · หน้าที่เดิม"); expect(html).not.toContain("ลองตามที่แนะนำ</a>");
  expect((await page(f, "/duties/done")).html).not.toContain("/s15/forms/duty/stop");
  expect((await page(webFixtureOnce(), "/work")).html).toContain("การดูแลหน้าที่ยังไม่เปิดในเครื่องนี้");
});
const webFixtureOnce = () => setup();

function browserPort(log: { inputs: unknown[]; frames: number[] }, session: LoginState | Promise<LoginState> = "signed_in"): S15WebBrowser<WebActor> {
  let generation = 10;
  return { id: "shop", site: "shop.example", twoFactor: false, fields: [{ name: "username", kind: "type", secret: false, label: "อีเมล" }, { name: "password", kind: "type", secret: true, label: "รหัสผ่าน" }, { name: "login", kind: "click", secret: false, label: "เข้าสู่ระบบ" }],
    owner: {
      async takeover() { generation++; return { generation }; },
      async frame(_a, g) { log.frames.push(g); if (g !== generation) throw new AppError("stale_input", 409); return new Uint8Array([137, 80, 78, 71]); },
      async input(_a, g, input) { if (g !== generation) throw new AppError("stale_input", 409); log.inputs.push(input); },
      handBack(_a, g, cancel) { if (g !== generation) throw new AppError("stale_input", 409); generation++; return { generation, login: cancel ? "cancelled" : "checking" }; },
      async checkSession() { return session; },
    } };
}

test("browser sign-in: takeover bar first, the owner's typed value is never echoed, and hand-back moves through checking to an observed state", async () => {
  const log = { inputs: [] as unknown[], frames: [] as number[] };
  const f = setup(() => ({ browsers: [browserPort(log, "not_signed_in")] }));
  const accounts = (await page(f, "/resources/accounts")).html;
  expect(accounts).toContain("เว็บ shop.example ต้องให้คุณเข้าสู่ระบบ"); expect(accounts).toContain("เปิดหน้าจอเข้าสู่ระบบ");
  const taken = await f.post("/s15/forms/browser/takeover", { site: "shop" });
  expect(taken.status).toBe(303); expect(taken.headers.get("location")).toBe("/browser/shop#s15-takeover-bar");
  const view = (await page(f, "/browser/shop")).html;
  const bar = view.indexOf('id="s15-takeover-bar"'), back = view.indexOf("เสร็จแล้ว คืนให้จิต"), img = view.indexOf("<img");
  expect(bar).toBeGreaterThan(0); expect(back).toBeGreaterThan(bar); expect(img).toBeGreaterThan(back);
  expect(view).toContain("คุณคุมอยู่ · จิตส่งคำสั่งไม่ได้จนกว่าคุณจะคืน"); expect(view).toContain('alt="ภาพหน้าจอล่าสุดของ shop.example ที่คุณคุมอยู่"'); expect(view).toContain('type="password"');
  const frame = await f.get("/browser/shop/frame?g=11"); expect(frame.status).toBe(200); expect(frame.headers.get("content-type")).toBe("image/png"); expect(frame.headers.get("cache-control")).toContain("no-store");
  expect((await f.get("/browser/shop/frame?g=10")).status).toBe(409);
  const typed = await f.post("/s15/forms/browser/input", { site: "shop", generation: "11", field: "password", value: "hunter2-secret" });
  expect(typed.status).toBe(303); expect(typed.headers.get("location")).not.toContain("hunter2");
  expect(log.inputs).toEqual([{ kind: "type", field: "password", value: "hunter2-secret" }]);
  expect((await page(f, "/browser/shop")).html).not.toContain("hunter2"); expect((await page(f, "/needs")).html).not.toContain("hunter2");
  // A field outside the trusted registration is refused, never forwarded.
  await f.post("/s15/forms/browser/input", { site: "shop", generation: "11", field: "card", value: "x" }); expect(log.inputs).toHaveLength(1);
  const handed = await f.post("/s15/forms/browser/handback", { site: "shop", generation: "11" });
  expect(handed.status).toBe(303);
  const needs = (await page(f, "/needs")).html;
  expect(needs).toContain("ยังไม่ได้เข้าสู่ระบบ หน้าเว็บยังขอให้เข้าสู่ระบบอยู่"); expect(needs).toContain("ลองอีกครั้ง"); expect(needs).not.toContain("เข้าสู่ระบบแล้ว การเข้าสู่ระบบไม่ได้อนุญาต");
  // An old takeover generation cannot hand back or type again.
  expect((await f.post("/s15/forms/browser/input", { site: "shop", generation: "11", field: "username", value: "a" })).status).toBe(409);
});

test("sign-in observations: signed in grants nothing, unknown is never signed in, cancel continues without the site", async () => {
  for (const [observed, expected, absent] of [["signed_in", "เข้าสู่ระบบแล้ว การเข้าสู่ระบบไม่ได้อนุญาตให้ส่งหรือจ่ายอะไร", "ลองอีกครั้ง"], ["unknown", "ตรวจไม่ได้ว่าเข้าสู่ระบบแล้วหรือยัง", "เข้าสู่ระบบแล้ว การ"]] as const) {
    const f = setup(() => ({ browsers: [browserPort({ inputs: [], frames: [] }, observed)] }));
    await f.post("/s15/forms/browser/takeover", { site: "shop" }); await f.post("/s15/forms/browser/handback", { site: "shop", generation: "11" });
    const html = (await page(f, "/resources/accounts")).html; expect(html).toContain(expected); expect(html.slice(html.indexOf("s15-res-sites"))).not.toContain(absent);
  }
  const f = setup(() => ({ browsers: [browserPort({ inputs: [], frames: [] })] }));
  await f.post("/s15/forms/browser/takeover", { site: "shop" }); await f.post("/s15/forms/browser/cancel", { site: "shop", generation: "11" });
  expect((await page(f, "/resources/accounts")).html).toContain("คุณยกเลิกการเข้าสู่ระบบ จิตจะทำต่อโดยไม่ใช้เว็บนี้");
  // While checking, the card says so and offers no action.
  let release!: (state: LoginState) => void;
  const slow = setup(() => ({ browsers: [browserPort({ inputs: [], frames: [] }, new Promise<LoginState>(resolve => { release = resolve; }))] }));
  await slow.post("/s15/forms/browser/takeover", { site: "shop" });
  const pending = slow.post("/s15/forms/browser/handback", { site: "shop", generation: "11" });
  await Bun.sleep(5);
  const checking = (await page(slow, "/needs")).html;
  expect(checking).toContain("กำลังตรวจว่าเข้าสู่ระบบสำเร็จหรือยัง"); expect(checking.slice(checking.indexOf("s15-login"))).not.toContain("/s15/forms/browser/takeover");
  release("signed_in"); expect((await pending).status).toBe(303);
});

const vmStatus = (state: VmStatus["state"] = "ready"): VmStatus => ({ id: "vm", generation: 3, state, networkIsolated: true, recoveryAvailable: true, activeSessions: 0, maxSessions: 2, reason: state === "uncertain" ? "vm_recovery_in_progress" : null, capabilities: [], facts: null });

test("VM restore: a slip with the impact in words waits for the owner and posts only the exact snapshot and generation", async () => {
  const restores: unknown[] = [];
  const f = setup(() => ({ computer: { vmId: "vm", managerId: "lima", hypervisor: "Lima", begin: async () => ({ setupId: "s", publicKey: "k", command: "c" }), checkMachine: async () => { throw new Error("unused"); }, useMachine: async () => vmStatus(), status: () => vmStatus("uncertain"),
    snapshots: () => [{ id: "jit-" + "a".repeat(32), generation: 3 }, { id: "jit-" + "b".repeat(32), generation: 2 }], restore: async (_actor, input) => { restores.push(input); } } }));
  const list = (await page(f, "/resources/computer")).html;
  expect(list).toContain("เครื่องทำงานเสีย"); expect(list).toContain("ย้อนไปที่ snapshot นี้"); expect(list).toContain("การย้อนเครื่องรอคุณเสมอ จิตไม่ย้อนเครื่องเอง"); expect(list).not.toContain("/s15/forms/computer/restore");
  const slip = (await page(f, `/resources/computer?restore=jit-${"b".repeat(32)}`)).html;
  expect(slip).toContain("ย้อนเครื่องทำงานไปที่ snapshot"); expect(slip).toContain("ไฟล์งานที่สร้างหลัง snapshot"); expect(slip).toContain("ข้อมูลของคุณนอกเครื่อง อีเมลที่ส่งแล้ว PR และการจ่ายเงิน ไม่ถูกย้อน");
  expect(slip).toContain("งานที่ใช้เครื่องนี้จะหยุดก่อน"); expect(slip).toContain("ย้อนเครื่อง 1 ครั้ง");
  expect((await f.post("/s15/forms/computer/restore", { snapshotId: `jit-${"b".repeat(32)}`, generation: "2" })).status).toBe(409); expect(restores).toHaveLength(0);
  const done = await f.post("/s15/forms/computer/restore", { snapshotId: `jit-${"b".repeat(32)}`, generation: "3" });
  expect(done.status).toBe(303); expect(restores).toEqual([{ vmId: "vm", snapshotId: `jit-${"b".repeat(32)}` }]);
});

test("personal GitHub profile: capture shows protection facts, install needs explicit choices, revoke stops it; production always asks", async () => {
  const calls: unknown[] = [];
  const capture: S15GithubCapture = { contract: "s15-github-personal-capture/v1", captureId: "cap1", expectedPolicyRevision: 4, repositories: [{ repository: { resource: { id: "repo", revision: 1, generation: 1 }, name: "owner/sandbox", target: "main" }, protection: { known: false, requiredChecks: [], requiredApprovals: 0, requireCodeOwners: false }, production: { consequence: "none" }, autoMergeAvailable: false, reason: "github_branch_protection" }], publication: "off", merge: "off", ruleIds: [], revoke: { expectedPolicyRevision: 4, ruleIds: [] } };
  const f = setup(() => ({ github: { capture: async () => capture, install: async (_a, input) => { calls.push(["install", input]); return { revision: 5, ruleIds: ["r"] }; }, revoke: (_a, input) => { calls.push(["revoke", input]); } } }));
  expect((await page(f, "/rules")).html).toContain("การตั้งกฎประจำยังไม่เปิดในเครื่องนี้");
  const g = setup(() => ({ rules: { current: () => null, propose: () => { throw new Error("unused"); }, install: () => { throw new Error("unused"); }, budgetOptions: () => ({ currencies: [], periods: [] }) }, github: { capture: async () => capture, install: async (_a, input) => { calls.push(["install", input]); return { revision: 5, ruleIds: ["r"] }; }, revoke: (_a, input) => { calls.push(["revoke", input]); } } }));
  let html = (await page(g, "/rules")).html;
  expect(html).toContain("ตั้งโปรไฟล์ GitHub ส่วนตัว"); expect(html).toContain("ยังถามก่อน deploy เสมอ"); expect(html).toContain("ไม่ใช่สิทธิ์ส่งข้อความทั่วไป");
  expect((await g.post("/s15/forms/github/capture", {})).status).toBe(303);
  html = (await page(g, "/rules")).html;
  expect(html).toContain("owner/sandbox"); expect(html).toContain("ไม่มีการตั้งใน GitHub — จิตจะถือว่าต้องมี CI ผ่านทั้งหมด"); expect(html).toContain("เปิดใช้โปรไฟล์นี้"); expect(html).not.toContain("checked");
  expect((await g.post("/s15/forms/github/install", { captureId: "cap1" })).status).toBe(409); expect(calls).toHaveLength(0);
  expect((await g.post("/s15/forms/github/install", { captureId: "cap1", repo_repo: "1", publication: "1" })).status).toBe(303);
  expect(calls).toEqual([["install", expect.objectContaining({ captureId: "cap1", repositoryIds: ["repo"], publication: true, merge: false })]]);
  const without = setup(); expect((await page(without, "/rules")).html).toContain("การตั้งกฎประจำยังไม่เปิดในเครื่องนี้");
});

test("team resources, S14-private labels and adoption status render only from their ports and say so honestly when absent", async () => {
  const bare = setup();
  expect((await page(bare, "/resources/accounts")).html).toContain("การแชร์และจำกัดทรัพยากรของทีมยังไม่เปิดในเครื่องนี้");
  expect((await page(bare, "/recovery")).html).toContain("สถานะการย้ายรุ่นยังไม่เปิดในเครื่องนี้");
  const f = setup(() => ({
    team: { view: () => ({ contract: "s15-team-resources-view/v1", resources: [
      { id: "gmail", revision: 2, label: "Gmail ของคุณ", kind: "account", scope: { kind: "team" }, operations: ["read"], active: true, whoCanUse: "enabled_team", restrictions: [] },
      { id: "notes", revision: 1, label: "โน้ตเก่า", kind: "data", scope: { kind: "bot", botId: "writer", origin: "s14" }, operations: ["read"], active: true, whoCanUse: ["writer"], restrictions: [] }] }) },
    adoption: () => ({ contract: "s15-adoption-status/v1", state: "validated", selectedRuntime: "s14", reason: null, report: { sourceRuntime: "s14", targetBuild: { commit: "abc1234", sha256: "f".repeat(64) }, historyRows: 120, privateItems: 3, pendingRequests: 0, unknownEffects: 1 }, historyPreserved: true, privateScopePreserved: true }),
  }));
  const accounts = (await page(f, "/resources/accounts")).html;
  expect(accounts).toContain("ใช้ได้ทั้งทีม"); expect(accounts).toContain("ส่วนตัวของ writer จาก S14 · ยังไม่แชร์ให้ทีม"); expect(accounts).not.toContain("แชร์ทั้งหมด</button>");
  const recovery = (await page(f, "/recovery")).html;
  expect(recovery).toContain("ตรวจแล้ว ยังไม่เปิดใช้"); expect(recovery).toContain("เก็บประวัติ S14 ไว้ทั้งหมด 120 รายการ"); expect(recovery).toContain("abc1234"); expect(recovery).toContain("คำสั่งย้ายรุ่นไม่อยู่ในหน้านี้");
});

test("an unsupported step renders a LimitNotice with take over and skip, never an approve-looking slip", async () => {
  const { limitNotice } = await import("../src/s15/web/browser");
  const { withLocale } = await import("../src/i18n");
  const html = withLocale("th", () => limitNotice("upload_unsupported", "conv", "req1", { id: "shop", site: "shop.example", twoFactor: false, fields: [] }, "csrf"));
  expect(html).toContain("จิตทำขั้นนี้ไม่ได้: เวอร์ชันนี้ยังอัปโหลดไฟล์บนเว็บไม่ได้"); expect(html).toContain("คุมเองแล้วทำขั้นนี้ด้วยตัวเอง"); expect(html).toContain("ข้ามขั้นนี้");
  expect(html).not.toContain("s-slip"); expect(html).not.toContain("primary"); expect(html).not.toContain("1 ครั้ง");
  void newId;
});
