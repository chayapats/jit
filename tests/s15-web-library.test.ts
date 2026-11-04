import { afterEach, expect, test } from "bun:test";
import { newId, webFixture, type WebFixture } from "./fixtures/s15-web";
import { th } from "../src/i18n/th";

const fixtures: WebFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });
const setup = (...args: Parameters<typeof webFixture>) => { const fixture = webFixture(...args); fixtures.push(fixture); return fixture; };
const html = async (fixture: WebFixture, path: string) => { const response = await fixture.get(path); return { status: response.status, body: await response.text(), headers: response.headers }; };

test("the library reads committed conversation evidence and never accepts, executes or invents an artifact", async () => {
  const fixture = setup(), conversation = newId();
  const empty = await html(fixture, "/library");
  expect(empty.status).toBe(200); expect(empty.body).toContain(th["s15.library.empty"]);
  expect(fixture.counts().calls).toBe(0);
  await fixture.send(conversation, "Create hello.txt containing hello."); await fixture.app.drain();
  const row = fixture.ports.conversation.view(fixture.actor, conversation).rows[0]!;
  const before = fixture.counts();
  const list = await html(fixture, "/library"), result = await html(fixture, `/library?conversation=${conversation}&request=${row.requestId}`);
  expect(list.body).toContain(`request=${row.requestId}`); expect(result.status).toBe(200);
  expect(result.body).toContain("Finished; see the recorded tool evidence."); expect(result.body).toContain("wrote hello.txt (6 bytes)");
  expect(result.body).toContain(th["s15.vm.reported"]); expect(result.body).toContain(`href="/chats/${conversation}#s15-row-${row.requestId}"`);
  expect(result.headers.get("cache-control")).toContain("no-store");
  expect(result.body).not.toContain('action="/s15/forms/accept'); expect(result.body).not.toContain('name="artifactId"');
  expect(fixture.counts()).toEqual(before);
});

test("a selected result requires both current conversation access and the exact request", async () => {
  let readable = true;
  const fixture = setup(ports => ({ conversation: { ...ports.conversation, view(actor, conversation) { const view = ports.conversation.view(actor, conversation); return readable ? view : { ...view, rows: [] }; } } }));
  const conversation = newId(); await fixture.send(conversation, "Create hello.txt containing hello."); await fixture.app.drain();
  const row = fixture.ports.conversation.view(fixture.actor, conversation).rows[0]!;
  expect((await html(fixture, `/library?request=${row.requestId}`)).status).toBe(404);
  expect((await html(fixture, `/library?conversation=${newId()}&request=${row.requestId}`)).status).toBe(404);
  readable = false;
  const withdrawn = await html(fixture, `/library?conversation=${conversation}&request=${row.requestId}`);
  expect(withdrawn.status).toBe(404); expect(withdrawn.body).not.toContain("Finished; see the recorded tool evidence.");
});

test("no-script quote links prefill only a readable answer as quoted data without running work", async () => {
  const fixture = setup(), conversation = newId();
  await fixture.send(conversation, "Create hello.txt containing hello."); await fixture.app.drain();
  const row = fixture.ports.conversation.view(fixture.actor, conversation).rows[0]!, before = fixture.counts();
  const quoted = await html(fixture, `/chats/${conversation}?quote=${row.requestId}`);
  expect(quoted.body).toContain("&gt; Finished; see the recorded tool evidence.");
  const other = await html(fixture, `/chats/${newId()}?quote=${row.requestId}`);
  expect(other.body).not.toContain("&gt; Finished; see the recorded tool evidence.");
  expect(quoted.body).not.toContain('type="file"'); expect(fixture.counts()).toEqual(before);
});

test("no-script search filters current conversation titles without treating a query as a command", async () => {
  const fixture = setup(), first = newId(), second = newId();
  await fixture.send(first, "Create hello.txt containing hello."); await fixture.app.drain();
  await fixture.send(second, "Create other.txt containing hello."); await fixture.app.drain();
  const before = fixture.counts(), found = await html(fixture, "/search?q=hello.txt");
  const main = found.body.slice(found.body.indexOf('id="main-content"'), found.body.indexOf('<dialog'));
  expect(main).toContain(`href="/chats/${first}"`); expect(main).not.toContain(`href="/chats/${second}"`);
  expect(main).toContain('method="get" action="/search"'); expect(main).toContain('value="hello.txt"');
  const input = await html(fixture, "/search?q=%3Cscript%3E");
  expect(input.body).toContain('value="&lt;script&gt;"'); expect(input.body).not.toContain("<script>");
  expect(fixture.counts()).toEqual(before);
});

test("enhanced new-chat and composer responses return current HTML without changing admission or native redirects", async () => {
  const fixture = setup(), requestId = newId();
  const opened = await fixture.get("/chats/new", { "x-jit-enhanced": "1" }), destination = opened.headers.get("content-location")!;
  expect(opened.status).toBe(200); expect(destination).toMatch(/^\/chats\/[a-f0-9]{32}$/);
  const conversation = destination.split("/").at(-1)!;
  expect(await opened.text()).toContain(`data-conversation="${conversation}"`);
  expect(fixture.ports.conversation.list(fixture.actor)).toHaveLength(0); expect(fixture.counts().calls).toBe(0);
  const fields = { conversationId: conversation, requestId, text: "Create hello.txt containing hello." };
  const sent = await fixture.post("/s15/forms/message", fields, { "x-jit-enhanced": "1" });
  expect(sent.status).toBe(200); expect(sent.headers.get("content-location")).toBe(`${destination}#latest`);
  await fixture.app.drain();
  const duplicate = await fixture.post("/s15/forms/message", fields, { "x-jit-enhanced": "1" });
  expect(duplicate.status).toBe(200); expect(await duplicate.text()).toContain(th["s15.receipt.duplicate"].replace("{time}", "08:00 UTC"));
  expect(fixture.ports.conversation.view(fixture.actor, conversation).rows).toHaveLength(1); expect(fixture.counts().calls).toBe(1);
  expect((await fixture.post("/s15/forms/message", { ...fields, csrf: "wrong" }, { "x-jit-enhanced": "1" })).status).toBe(403);
  expect((await fixture.get("/chats/new")).status).toBe(303);
});
