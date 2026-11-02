import { afterEach, expect, test } from "bun:test";
import { s15MemoryPort, s15TeamPort } from "../src/s15/web";
import { teamMemoryFixture } from "./fixtures/s15-team-memory";
import { webFixture, type WebFixture } from "./fixtures/s15-web";

// UX15-06 team resources and UX15-04 memory over the real TEAM15/MEM15 services (#360), through the S15 Web handler.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
function setup() {
  const tm = teamMemoryFixture(); cleanups.push(() => tm.cleanup());
  const owner = () => tm.f.owner;
  const web: WebFixture = webFixture(() => ({ team: s15TeamPort(tm.team, owner), memory: s15MemoryPort(tm.memory, owner) })); cleanups.push(() => web.cleanup());
  return { tm, web };
}
const html = async (web: WebFixture, path: string) => (await web.get(path)).text();

test("team resources come from TeamService: team scope, S14-private label and restrictions in words, never a share-all control", async () => {
  const { web } = setup();
  const page = await html(web, "/resources/accounts");
  expect(page).not.toContain("การแชร์และจำกัดทรัพยากรของทีมยังไม่เปิดในเครื่องนี้");
  expect(page).toContain("ใช้ได้ทั้งทีม"); expect(page).toContain("ส่วนตัวของ bot จาก S14 · ยังไม่แชร์ให้ทีม");
  expect(page).toContain("ใช้เฉพาะงานเพื่อ purpose"); expect(page).toContain("รหัสผ่านอยู่นอกงานเสมอ");
  expect(page).not.toContain("mediated_credentials"); expect(page).not.toContain("แชร์ทั้งหมด</button>");
});

test("memory page reads MemoryService claims and corrects and forgets the exact revision through the real command API", async () => {
  const { tm, web } = setup();
  const [preference] = tm.memory.retain(tm.context(), tm.source("I prefer long replies.\nIt seems that tests are slow."));
  let page = await html(web, "/memory");
  expect(page).toContain("I prefer long replies."); expect(page).toContain("ข้อเท็จจริง"); expect(page).toContain("ข้อสันนิษฐาน");
  const corrected = await web.post("/s15/forms/memory/correct", { claimId: preference!.id, claimRevision: String(preference!.revision), text: "I prefer concise replies.", filter: "all" });
  expect(corrected.status).toBe(303);
  const claims = tm.memory.view(tm.f.owner).claims;
  expect(claims.find(claim => claim.id === preference!.id)?.lifecycle).toBe("superseded");
  expect(claims.some(claim => claim.text === "I prefer concise replies." && claim.lifecycle === "active")).toBe(true);
  // A stale revision is refused by the real service and nothing changes.
  expect((await web.post("/s15/forms/memory/correct", { claimId: preference!.id, claimRevision: String(preference!.revision), text: "again", filter: "all" })).status).toBe(409);
  const current = tm.memory.view(tm.f.owner).claims.find(claim => claim.text === "I prefer concise replies.")!;
  page = await html(web, `/memory?forget=${current.id}`);
  expect(page).toContain("สิ่งที่โมเดลเคยเห็นไปแล้วเรียกคืนไม่ได้");
  expect((await web.post("/s15/forms/memory/forget", { claimId: current.id, claimRevision: String(current.revision), filter: "all" })).status).toBe(303);
  expect(tm.memory.view(tm.f.owner).claims.find(claim => claim.id === current.id)?.lifecycle).toBe("forgotten");
});
