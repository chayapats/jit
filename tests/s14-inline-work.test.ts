import { afterEach, expect, test } from "bun:test";
import { dictionaries } from "../src/i18n";
import { createS14Handler } from "../src/s14/web";
import { createS14Product } from "../src/s14/web-product";
import { renderS14 } from "../src/s14/web-pages";
import { accessibilityProblems } from "./fixtures/a11y";
import { domainFixture, workCommand } from "./fixtures/s14-domain";
import { claim, report, rid, teamFixture, type TeamFixture } from "./fixtures/s14-team";
const open: TeamFixture[] = [], domains: Awaited<ReturnType<typeof domainFixture>>[] = [];
afterEach(() => { for (const f of open.splice(0)) f.close(); for (const f of domains.splice(0)) f.dispose(); });
const thread = (html: string) => html.slice(html.indexOf('id="s14-live"'), html.indexOf('<span id="latest"'));
const fixture = async (language: "th" | "en" = "en") => { const f = await teamFixture({ language }); open.push(f); return f; };

test.each(["en", "th"] as const)("%s retained results, report facts, sources and files are readable inline without a pane", async language => {
  const f = await fixture(language);
  f.scripts.lanes.jit = async a => ({ state: "ready", text: "Inline result before details", report: report([claim(a, await f.read(a))], { title: "Inline report", limitations: ["Known fixture limitation"] }) });
  const work = f.start({ bots: [{ id: "jit", revision: 1 }] }); await f.app.authority.drain();
  const reportView = f.app.reports.list(f.auth.actor, work.id).at(-1)!; if (reportView.state !== "available") throw Error("unavailable");
  const html = await f.page(`/chats/${f.conversationId}`), inline = thread(html);
  expect(inline).toContain("Inline result before details"); expect(inline).toContain("Inline report"); expect(inline).toContain("Known fixture limitation");
  expect(inline).toContain(dictionaries[language]["s14.report.coverage.partial"]); expect(inline).toContain(dictionaries[language]["s14.report.completion.owner_review_required"]);
  expect(inline).toContain("https://example.com/article"); expect(inline).toContain("tab=evidence"); expect(inline).toContain(reportView.artifacts[0]!.sha256);
  expect(html).not.toContain('class="s-pane"'); expect(accessibilityProblems(html, language)).toEqual([]);
  const review = f.app.reports.review(f.auth.actor, work.id);
  f.app.execute(f.auth.actor, { kind: "report.review.accept", requestId: rid(), expectedRevision: review.revision, payload: { reportId: reportView.report.id, reportRevision: reportView.report.revision } });
  expect(thread(await f.page(`/chats/${f.conversationId}`))).toContain(dictionaries[language]["s14.report.review.accepted"]);
  const pane = await f.page(`/chats/${f.conversationId}?work=${work.id}&tab=report`);
  const ids = [...pane.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]); expect(new Set(ids).size).toBe(ids.length);
  expect(accessibilityProblems(pane, language)).toEqual([]);
});

test("inline report content and download links disappear after actual source withdrawal", async () => {
  const f = await fixture();
  const memory = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision, payload: { conversationId: f.conversationId, text: "Withdrawn input" } }).claim!;
  f.scripts.lanes.jit = async a => ({ state: "ready", text: "Withdrawn result payload", report: report([claim(a, await f.read(a))], { title: "Withdrawn report payload" }) });
  const work = f.start({ bots: [{ id: "jit", revision: 1 }] }); await f.app.authority.drain();
  expect(thread(await f.page(`/chats/${f.conversationId}`))).toContain("Withdrawn report payload");
  f.app.execute(f.auth.actor, { kind: "memory.forget", requestId: rid(), expectedRevision: memory.revision, payload: { claim: memory } });
  const html = thread(await f.page(`/chats/${f.conversationId}`)); expect(html).not.toContain("Withdrawn report payload"); expect(html).not.toContain("Withdrawn result payload"); expect(html).not.toContain("/download");
  expect(html).toContain(dictionaries.en["s14.report.withdrawn"]);
});

test.each(["pending", "unknown"] as const)("a %s exact effect keeps its current commands and outcome semantics inline", async state => {
  const f = await domainFixture({ policy: { routes: [{ id: "selected", provider: "codex", model: "fixture" }], tools: ["effect_send"], resources: [] }, authority: { scheduler: { global: 4, route: 4, bot: 4, computer: 2 }, effects: { send: async () => "unknown" } } }); domains.push(f);
  const work = f.app.execute(f.auth.actor, workCommand(f, { tools: ["effect_send"] })).work!;
  const attempt = f.app.authority.admit(work.id, rid(), { botId: "jit", tools: ["effect_send"], scopes: [], input: "Fixture", calls: 4, outputBytes: 4096 });
  const effect = f.app.authority.proposeEffect(attempt.id, rid(), { kind: "send", destination: "recipient@example.invalid", content: "Exact inline fixture action" }, f.clock.now + 60000);
  if (state === "unknown") { f.app.execute(f.auth.actor, { kind: "approval.decide", requestId: rid(), expectedRevision: effect.revision, payload: { effectId: effect.id, actionHash: effect.actionHash, decision: "approve" } }); await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash); }
  const handler = createS14Handler(f.app, "http://localhost:3001", renderS14, createS14Product(f.app));
  const get = async (path: string) => { const response = await handler(new Request(`http://localhost:3001${path}`, { headers: { cookie: `jit_s14=${f.token}` } })); expect(response.status).toBe(200); return response.text(); };
  const html = await get(`/chats/${f.conversationId}`), inline = thread(html);
  expect(inline).toContain("Exact inline fixture action"); expect(inline).toContain("recipient@example.invalid"); expect(inline).toContain(effect.actionHash);
  expect(inline.includes("approval.decide")).toBe(state === "pending");
  if (state === "unknown") expect(inline).toContain(`/effects/${effect.id}#slip`);
  const pane = await get(`/chats/${f.conversationId}?work=${work.id}`);
  expect((pane.match(/Exact inline fixture action/g) ?? []).length).toBe(1);
  expect(accessibilityProblems(html, "en")).toEqual([]); expect(accessibilityProblems(pane, "en")).toEqual([]);
});

test("two work cards remain readable with one report pane and have unique live/label identities", async () => {
  const f = await fixture();
  let index = 0;
  f.scripts.lanes.jit = async a => ({ state: "ready", text: `Retained output ${++index}`, report: report([claim(a, await f.read(a))], { title: `Retained report ${index}` }) });
  const first = f.start({ bots: [{ id: "jit", revision: 1 }] }); await f.app.authority.drain();
  f.clock.now += 1000; const second = f.start({ bots: [{ id: "jit", revision: 1 }] }); await f.app.authority.drain();
  const html = await f.page(`/chats/${f.conversationId}?work=${second.id}&tab=report`), inline = thread(html);
  expect(inline).toContain("Retained output 1"); expect(inline).toContain("Retained output 2");
  expect(inline).toContain(`id="s14-inline-${first.id}"`); expect(inline).toContain(`id="s14-inline-${second.id}"`);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]); expect(new Set(ids).size).toBe(ids.length); expect(accessibilityProblems(html, "en")).toEqual([]);
});
