import { afterEach, expect, test } from "bun:test";
import { withLocale } from "../src/i18n";
import { fullSlip } from "../src/s15/web/actions";
import { disclosureFixture } from "./fixtures/s15-disclosure";
import { actionRef, ref } from "./fixtures/s15-policy";

// UX15-02a new-recipient slip over the real DATA15 disclosure service (#362) and real POLICY slips.
const fixtures: ReturnType<typeof disclosureFixture>[] = [];
afterEach(() => { for (const x of fixtures.splice(0)) x.cleanup(); });

test("a private-data disclosure to a new recipient shows the recipient, exact sources, data classes, purpose and byte identity before one allow-once control", () => {
  const x = disclosureFixture(); fixtures.push(x);
  x.disclosure.read(x.actor, ref("private"));
  const prepared = x.prepare({ to: "new_service", text: "Quarterly margin is 12%" });
  expect(prepared.decision.state).toBe("hold");
  const slip = x.f.service.owner.actionSlip(x.f.owner, actionRef(prepared.action));
  expect(slip.action.disclosure).toBeDefined();
  const html = withLocale("th", () => fullSlip({ csrf: "csrf", conversationId: "conv", slip, decisions: [], policy: null, replacement: null, card: null, canDecide: true, canCheck: true, recurring: false, refused: null, checked: false }));
  expect(html).toContain("ข้อมูลส่วนตัวจะไปที่ผู้รับใหม่"); expect(html).toContain("new_service"); expect(html).toContain("ผู้รับนี้ยังไม่เคยได้รับข้อมูลของคุณ");
  expect(html).toContain(">private</span> · ส่วนตัว"); expect(html).toContain(`>${slip.action.disclosure!.purpose.id}</span>`);
  expect(html).toContain(`${slip.action.disclosure!.exactBytes.length} ไบต์`); expect(html).toContain("Quarterly margin is 12%");
  const strip = html.slice(html.indexOf('class="s-strip"'));
  expect(html.indexOf("Quarterly margin is 12%")).toBeLessThan(html.indexOf('class="s-strip"'));
  if (slip.canApprove) expect(strip).toContain("อนุญาตเฉพาะครั้งนี้"); else expect(strip).not.toContain("อนุญาตเฉพาะครั้งนี้");
  expect(x.sent).toHaveLength(0);
});
