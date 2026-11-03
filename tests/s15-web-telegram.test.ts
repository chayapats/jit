import { afterEach, expect, test } from "bun:test";
import { AppError } from "../src/errors";
import type { S15TelegramStatus, S15WebTelegram } from "../src/s15/web";
import { webFixture, type WebActor, type WebFixture } from "./fixtures/s15-web";

// CHAN15-01 Telegram settings page (`/resources/telegram`), th and en, over a fake owner port.
const fixtures: WebFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const at = 1800000000000;
const base: S15TelegramStatus = { contract: "s15-telegram-status/v1", token: "missing", bot: null, binding: { state: "unbound" }, poll: { state: "off", lastPollAt: null, code: null, gap: null }, counts: { refused: 0, unknown: 0, queued: 0 } };
function setup(status: () => S15TelegramStatus | null, calls: string[] = [], refuse: string | null = null) {
  const port: S15WebTelegram<WebActor> = {
    status: () => status()!,
    async setToken(_a, _id, token) { calls.push(`token:${token.length}`); if (refuse) throw new AppError(refuse, 409); },
    removeToken: () => { calls.push("remove"); }, startBinding: () => { calls.push("bind"); }, cancelBinding: () => { calls.push("cancel"); }, revoke: () => { calls.push("revoke"); }, acknowledgeGap: () => { calls.push("gap"); },
  };
  const f = webFixture(() => status() === null ? {} : { telegram: port }); fixtures.push(f); return f;
}
const page = async (f: WebFixture, locale: "th" | "en" = "th", path = "/resources/telegram") => (await f.get(path, { "accept-language": locale })).text();

test("not composed and no-bot states explain themselves in Thai and English", async () => {
  const absent = setup(() => null);
  expect(await page(absent)).toContain("Telegram ยังไม่เปิดในเครื่องนี้");
  expect((await absent.post("/s15/forms/telegram/bind", {})).status).toBe(404);
  const f = setup(() => base);
  const th = await page(f), en = await page(f, "en");
  expect(th).toContain("เปิด @BotFather ใน Telegram"); expect(th).toContain('name="token" type="password"'); expect(th).toContain('autocomplete="off"');
  expect(th).toContain("การอนุมัติทำในหน้าเว็บนี้เท่านั้น"); expect(th).toContain("ใส่ token ของบอทก่อน แล้วค่อยผูกบัญชี"); expect(th).toContain("ยังไม่รับข้อความ เพราะยังไม่มีบอท");
  expect(en).toContain("Open @BotFather in Telegram"); expect(en).toContain("Approvals happen only on this Web page"); expect(en).toContain("Add the bot token first, then bind your account.");
  // The page offers no approve control and links Telegram from the Manage navigation.
  expect(th).not.toMatch(/name="decision"/); expect(th).toContain('href="/resources/telegram" aria-current="page"');
});

test("token posts are write-only: a refused token is never rendered back", async () => {
  const calls: string[] = [];
  const f = setup(() => base, calls, "telegram_token_rejected");
  const secret = "123456:" + "S".repeat(40);
  const refused = await f.post("/s15/forms/telegram/token", { token: secret });
  expect(refused.status).toBe(409);
  const html = await refused.text();
  expect(html).toContain("Telegram ไม่รับ token นี้"); expect(html).not.toContain(secret); expect(html).not.toContain("SSSSSSSS");
  expect(calls).toEqual(["token:47"]);
  expect((await f.post("/s15/forms/telegram/token", { token: secret, extra: "x" })).status).toBe(400);
});

test("bot, pending code, expired code, bound and stale binding states", async () => {
  let status: S15TelegramStatus = { ...base, token: "present", bot: { id: 1, username: "jit_home_bot" }, poll: { state: "starting", lastPollAt: null, code: null, gap: null } };
  const calls: string[] = [];
  const f = setup(() => status, calls);
  let html = await page(f);
  expect(html).toContain("@jit_home_bot"); expect(html).toContain("สร้างรหัสผูกบัญชี"); expect(html).toContain("เลิกใช้บอทนี้"); expect(html).toContain("กำลังเริ่มรับข้อความ");
  expect((await f.post("/s15/forms/telegram/bind", {})).headers.get("location")).toBe("/resources/telegram#s15-tg-binding");
  status = { ...status, binding: { state: "pending", code: "ABCDEFGHJKMN", expiresAt: at + 600000, expired: false } };
  html = await page(f);
  expect(html).toContain("ABCD-EFGH-JKMN"); expect(html).toContain('href="https://t.me/jit_home_bot?start=ABCDEFGHJKMN"'); expect(html).toContain("ใช้ได้ครั้งเดียว อย่าส่งต่อให้ใคร");
  expect(await page(f, "en")).toContain("Send this code to @jit_home_bot in a private chat");
  status = { ...status, binding: { state: "pending", code: "ABCDEFGHJKMN", expiresAt: at, expired: true } };
  html = await page(f);
  expect(html).toContain("รหัสหมดอายุแล้ว"); expect(html).not.toContain("ABCD-EFGH-JKMN");
  status = { ...status, binding: { state: "bound", userId: 777001, username: "owner_tg", boundAt: at, current: true }, poll: { state: "receiving", lastPollAt: at, code: null, gap: null } };
  html = await page(f);
  expect(html).toContain("ผูกกับบัญชี Telegram ของคุณแล้ว"); expect(html).toContain("@owner_tg"); expect(html).toContain("777001"); expect(html).toContain("จิตยืนยันตัวตนจาก Telegram ID"); expect(html).toContain("รับข้อความอยู่");
  expect(await page(f, "en")).toContain("Bound to your Telegram account");
  status = { ...status, binding: { state: "bound", userId: 777001, username: null, boundAt: at, current: false } };
  html = await page(f);
  expect(html).toContain("ต้องผูกบัญชีใหม่"); expect(html).toContain("ไม่มีชื่อผู้ใช้");
  for (const path of ["revoke", "cancel", "remove", "gap"]) expect((await f.post(`/s15/forms/telegram/${path}`, {})).status).toBe(303);
  expect(calls).toEqual(["bind", "revoke", "cancel", "remove", "gap"]);
  expect(await page(f, "th", "/resources/telegram?saved=revoked")).toContain("เลิกผูกบัญชีแล้ว");
});

test("trouble, visible retention gap and delivery counts", async () => {
  const f = setup(() => ({ ...base, token: "present", bot: { id: 1, username: "jit_home_bot" }, binding: { state: "bound", userId: 7, username: "o", boundAt: at, current: true },
    poll: { state: "trouble", lastPollAt: at, code: "telegram_unreachable", gap: { since: at - 90000000, noticedAt: at } }, counts: { refused: 3, unknown: 2, queued: 1 } }));
  const th = await page(f), en = await page(f, "en");
  expect(th).toContain("ติดต่อ Telegram ไม่ได้ จิตจะลองใหม่เอง"); expect(th).toContain("telegram_unreachable"); expect(th).toContain("อาจมีข้อความหายไป"); expect(th).toContain("จิตจะไม่เดาว่ามีอะไร");
  expect(th).toContain("ปฏิเสธข้อความที่ไม่ได้มาจากคุณ 3 รายการ"); expect(th).toContain("2 ข้อความ ไม่ทราบว่าส่งถึงหรือไม่"); expect(th).toContain("รอส่ง 1 ข้อความ");
  expect(en).toContain("Some messages may be missing"); expect(en).toContain("Refused 3 messages that didn’t come from you"); expect(en).toContain("Jit won’t resend them on its own");
});
