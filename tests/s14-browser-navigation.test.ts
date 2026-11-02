import { afterEach, expect, test } from "bun:test";
import { createS14Handler } from "../src/s14/web";
import { createS14Product } from "../src/s14/web-product";
import { renderS14 } from "../src/s14/web-pages";
import { teamFixture, rid, type TeamFixture } from "./fixtures/s14-team";
import { s14Colors } from "../src/s14/web-design";
import { contrastPairs, contrastRatio } from "../src/web-design";

const opened: TeamFixture[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.close(); });
const fixture = async () => { const f = await teamFixture(); opened.push(f); return f; };
const request = (f: TeamFixture, path: string, preference = "") => f.handler(new Request(`http://localhost:3001${path}`, { headers: { cookie: `jit_s14=${f.token}${preference ? `; ${preference}` : ""}` } }));
const composerConversation = (html: string) => /<form class="s-composer[\s\S]*?name="conversationId" value="([^"]+)"/.exec(html)?.[1];

test("each browser returns to its own Jit conversation; deep links and new conversations stay explicit", async () => {
  const f = await fixture(), original = f.conversationId;
  const newer = f.app.execute(f.auth.actor, { kind: "conversation.create", requestId: rid(), expectedRevision: 1, payload: { botId: "jit" } }).conversation!.id;
  const first = await request(f, `/chats/${original}`), second = await request(f, `/chats/${newer}`);
  const cookieA = first.headers.get("set-cookie")!.split(";")[0]!, cookieB = second.headers.get("set-cookie")!.split(";")[0]!;
  expect(cookieA).toBe(`jit_s14_chat=${original}`); expect(cookieB).toBe(`jit_s14_chat=${newer}`);
  expect(first.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000");
  expect(composerConversation(await (await request(f, "/", cookieA)).text())).toBe(original);
  expect(composerConversation(await (await request(f, "/", cookieB)).text())).toBe(newer);
  expect(composerConversation(await (await request(f, `/chats/${original}`, cookieB)).text())).toBe(original);
  expect(f.app.home(f.auth.actor).conversations.filter(c => c.botId === "jit")).toHaveLength(2);
  expect(f.app.authority.list(f.auth.actor)).toHaveLength(0); expect(f.app.conversation(f.auth.actor, original).messages).toHaveLength(0);
});

test("untrusted navigation cookies cannot select another Bot, malformed identity or missing conversation", async () => {
  const f = await fixture();
  for (const cookie of ["jit_s14_chat=scoutchat", "jit_s14_chat=missing", "jit_s14_chat=../../other", "jit_s14_chat=scoutchat; jit_s14_chat=missing"]) {
    const response = await request(f, "/", cookie); expect(response.status).toBe(200);
    expect(composerConversation(await response.text())).toBe(f.conversationId);
  }
  // The Home projection is bounded; an older bookmarked Jit conversation must remain reachable outside that window.
  const old = f.conversationId;
  f.store.transaction(tx => { for (let i = 0; i < 105; i++) tx.run("INSERT INTO conversations VALUES (?,?,1)", `recent_${i}`, "scout"); });
  expect(f.app.home(f.auth.actor).conversations.some(c => c.id === old)).toBe(false);
  expect(composerConversation(await (await request(f, "/", `jit_s14_chat=${old}`)).text())).toBe(old);
});

test("HTTPS navigation cookies retain the Host prefix and Secure independently of authentication", async () => {
  const f = await fixture(), handler = createS14Handler(f.app, "https://jit.invalid", renderS14, createS14Product(f.app));
  const response = await handler(new Request("https://jit.invalid/", { headers: { cookie: `__Host-jit_s14=${f.token}` } }));
  expect(response.status).toBe(200); expect(response.headers.get("set-cookie")).toContain(`__Host-jit_s14_chat=${f.conversationId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000; Secure`);
  const anonymous = await handler(new Request("https://jit.invalid/", { headers: { cookie: `__Host-jit_s14_chat=${f.conversationId}` } }));
  expect(anonymous.status).toBe(303); expect(anonymous.headers.get("location")).toBe("/s14/login");
});

test("only a committed message/start receipt for this conversation can acknowledge its submitted draft", async () => {
  const f = await fixture(), requestId = rid();
  f.app.execute(f.auth.actor, { kind: "message.post", requestId, expectedRevision: 1, payload: { conversationId: f.conversationId, text: "Hello" } });
  const exact = await (await request(f, `/chats/${f.conversationId}?receipt=${requestId}`)).text();
  expect(exact).toContain(`data-committed="${requestId}"`);
  for (const path of [`/chats/scoutchat?receipt=${requestId}`, `/chats/${f.conversationId}?receipt=not_committed`]) {
    expect(await (await request(f, path)).text()).toContain('data-committed=""');
  }
  expect(f.app.authority.list(f.auth.actor)).toHaveLength(0);
});

test("the Plain palette preserves readable text and semantic state contrast in both themes", () => {
  for (const theme of ["light", "dark"] as const) for (const [fg, bg] of contrastPairs) {
    expect(contrastRatio(s14Colors[theme][fg], s14Colors[theme][bg]), `${theme}: ${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
  }
});
