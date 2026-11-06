import { afterEach, expect, test } from "bun:test";
import { dictionaries } from "../src/i18n";
import { PolicyError } from "../src/s15/policy";
import type { S15WebRecipients } from "../src/s15/web";
import { webFixture, type WebActor, type WebFixture } from "./fixtures/s15-web";

// AUTH16-01 Resources → Recipients (`/resources/recipients`): named people and remembered private-data recipients.
const fixtures: WebFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const T = (key: string, locale: "th" | "en" = "th") => (dictionaries[locale] as Record<string, string>)[key]!;
const at = 1_800_000_000_000;

function setup(calls: string[]) {
  let people = [{ address: "alice@example.test", label: "Alice", addedAt: at }];
  let remembered = [{ recipientId: "vendor", label: "vendor", purposeId: "owner_requested_work", dataClasses: ["private"], rememberedAt: at, revision: 2 }];
  const port: S15WebRecipients<WebActor> = {
    list: () => ({ people, remembered }),
    forget(_a, _id, recipientId, revision) { calls.push(`forget:${recipientId}:${revision}`); if (revision !== 2) throw new PolicyError("recipient_changed"); remembered = remembered.filter(r => r.recipientId !== recipientId); },
    forgetPerson(_a, _id, address) { calls.push(`person:${address}`); people = people.filter(p => p.address !== address); },
  };
  const f = webFixture(() => ({ recipients: port })); fixtures.push(f); return f;
}

test("both lists render in Thai and English, and forgetting needs the exact revision", async () => {
  const calls: string[] = [], f = setup(calls);
  const th = await (await f.get("/resources/recipients", { "accept-language": "th" })).text(), en = await (await f.get("/resources/recipients", { "accept-language": "en" })).text();
  expect(th).toContain(T("s15.recipients.people_title")); expect(th).toContain("alice@example.test"); expect(th).toContain(T("s15.recipients.remembered_title"));
  expect(en).toContain(T("s15.recipients.remembered_note", "en")); expect(en).toContain('href="/resources/recipients"');
  const stale = await f.post("/s15/forms/recipients/forget", { recipientId: "vendor", revision: "1" }, { "accept-language": "en" });
  expect(stale.status).toBe(409); expect(await stale.text()).toContain(T("s15.code.recipient_changed", "en").replaceAll("&", "&amp;"));
  const forgot = await f.post("/s15/forms/recipients/forget", { recipientId: "vendor", revision: "2" });
  expect(forgot.status).toBe(303); expect(forgot.headers.get("location")).toBe("/resources/recipients?forgot=1");
  expect((await f.post("/s15/forms/recipients/forget-person", { address: "alice@example.test" })).status).toBe(303);
  expect(calls).toEqual(["forget:vendor:1", "forget:vendor:2", "person:alice@example.test"]);
  const after = await (await f.get("/resources/recipients?forgot=1", { "accept-language": "en" })).text();
  expect(after).toContain(T("s15.recipients.saved", "en")); expect(after).toContain(T("s15.recipients.people_none", "en"));
  expect((await f.post("/s15/forms/recipients/forget", { recipientId: "vendor", revision: "x" })).status).toBe(400);
});
