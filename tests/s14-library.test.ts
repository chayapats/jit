import { libraryView } from "../src/s14/web-library";
import { afterEach, expect, spyOn, test } from "bun:test";
import { dictionaries } from "../src/i18n";
import type { OwnerActor } from "../src/s14/types";
import { accessibilityProblems } from "./fixtures/a11y";
import { claim, report, rid, teamFixture, type TeamFixture } from "./fixtures/s14-team";
const open: TeamFixture[] = [];
afterEach(() => { for (const f of open.splice(0)) f.close(); });
const fixture = async (language: "th" | "en" = "en") => { const f = await teamFixture({ language }); open.push(f); return f; };
async function produce(f: TeamFixture, title: string) {
  f.scripts.lanes.jit = async attempt => ({ state: "ready", text: "Retained result", report: report([claim(attempt, await f.read(attempt))], { title }) });
  f.clock.now += 1000;
  const work = f.start({ title: `Work ${title}`, bots: [{ id: "jit", revision: 1 }] }); await f.app.authority.drain();
  const view = f.app.reports.list(f.auth.actor, work.id).at(-1)!;
  if (view.state !== "available") throw Error("fixture report unavailable");
  return { work, view };
}

test.each(["en", "th"] as const)("%s Library lists cross-work revisions and files through existing no-script gateways", async language => {
  const f = await fixture(language), first = await produce(f, "First retained report"), second = await produce(f, "Second retained report");
  const review = f.app.reports.review(f.auth.actor, first.work.id);
  f.app.execute(f.auth.actor, { kind: "report.review.accept", requestId: rid(), expectedRevision: review.revision, payload: { reportId: first.view.report.id, reportRevision: first.view.report.revision } });
  const html = await f.page("/library"), files = await f.page("/library?tab=artifacts"), words = dictionaries[language];
  expect(html).toContain(words["s14.report.review.accepted"]); expect(files).toContain(words["s14.report.review.accepted"]);
  expect(html).not.toContain("s14.report.completion.owner_accepted");
  for (const { work, view } of [first, second]) {
    expect(html).toContain(view.report.title); expect(html).toContain(`work=${work.id}&amp;tab=report&amp;report=${view.report.id}`);
    expect(files).toContain(work.title);
    for (const artifact of view.artifacts) { expect(files).toContain(artifact.sha256); expect(files).toContain(`/s14/artifacts/${artifact.id}/download`); expect((await f.get(`/s14/artifacts/${artifact.id}/download`)).status).toBe(200); }
  }
  expect(html).toContain(words["s14.report.coverage.partial"]); expect(html).toContain(words["s14.report.completion.owner_review_required"]);
  expect(await f.page("/more")).toContain('href="/library"'); expect(html).toContain('href="/memory"'); expect(html).toContain('href="/shares"');
  expect(accessibilityProblems(html, language)).toEqual([]); expect(accessibilityProblems(files, language)).toEqual([]);
});

test("catalog pagination is exclusive and stable when a newer report arrives; latest queries retain exact review facts", async () => {
  const f = await fixture(), first = await produce(f, "Older"), second = await produce(f, "Newer");
  const page = f.app.reports.catalog(f.auth.actor, { limit: 1 }); expect(page.items).toHaveLength(1); expect(page.nextBefore).not.toBeNull();
  expect(page.items[0]).toMatchObject({ state: "available", report: { id: second.view.report.id } });
  await produce(f, "Newest inserted after pagination");
  const next = f.app.reports.catalog(f.auth.actor, { before: page.nextBefore, limit: 1 });
  expect(next.items[0]).toMatchObject({ state: "available", report: { id: first.view.report.id } }); expect(next.nextBefore).toBeNull();
  const review = f.app.reports.review(f.auth.actor, first.work.id);
  f.app.execute(f.auth.actor, { kind: "report.review.accept", requestId: rid(), expectedRevision: review.revision, payload: { reportId: first.view.report.id, reportRevision: first.view.report.revision } });
  expect(f.app.reports.latest(f.auth.actor, [first.work.id])[first.work.id]).toMatchObject({ state: "available", completion: "owner_accepted" });
  const html = await f.page("/library?limit=1"); expect(html).toContain("before=");
});

test("withdrawn catalog/inline projections keep identities while withholding report claims and files", async () => {
  const f = await fixture();
  const memory = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision, payload: { conversationId: f.conversationId, text: "Source lineage to withdraw" } }).claim!;
  const { work, view } = await produce(f, "Private title must disappear");
  f.app.execute(f.auth.actor, { kind: "memory.forget", requestId: rid(), expectedRevision: memory.revision, payload: { claim: memory } });
  const catalog = f.app.reports.catalog(f.auth.actor); expect(catalog.items[0]).toMatchObject({ state: "unavailable", id: view.report.id });
  expect(f.app.reports.latest(f.auth.actor, [work.id])[work.id]).toMatchObject({ state: "unavailable", id: view.report.id });
  const html = await f.page("/library?tab=artifacts");
  expect(html).not.toContain(view.report.title); expect(html).not.toContain(view.artifacts[0]!.sha256); expect(html).not.toContain(`/s14/artifacts/${view.artifacts[0]!.id}/download`);
  expect(html).toContain(dictionaries.en["s14.report.withdrawn"]); const refused = await f.get(`/s14/artifacts/${view.artifacts[0]!.id}/download`); expect(refused.status).toBeGreaterThanOrEqual(400); expect(refused.status).toBeLessThan(500);
});

test("catalog bounds, cursor shape and owner authentication are enforced without creating work", async () => {
  const f = await fixture(); expect(await f.page("/library")).toContain(dictionaries.en["s14.library.empty"]);
  for (const limit of [0, 51, -1, NaN, Infinity]) expect(() => f.app.reports.catalog(f.auth.actor, { limit })).toThrow();
  for (const before of [0, -1, Number.MAX_SAFE_INTEGER + 1]) expect(() => f.app.reports.catalog(f.auth.actor, { before })).toThrow();
  expect(() => f.app.reports.catalog({} as OwnerActor)).toThrow(); expect(() => f.app.reports.latest({} as OwnerActor, [])).toThrow();
  expect(() => f.app.reports.latest(f.auth.actor, Array(25).fill("work"))).toThrow();
  for (const path of ["/library?before=x", "/library?before=1&before=2", "/library?limit=51", "/library?before=9007199254740992"]) expect((await f.get(path)).status).toBe(400);
  const anonymous = await f.handler(new Request("http://localhost:3001/library")); expect(anonymous.status).toBe(303); expect(anonymous.headers.get("location")).toBe("/s14/login");
  expect(f.app.authority.list(f.auth.actor)).toHaveLength(0);
});

test("Library preserves producing Bot and exact revisions across separate Bot conversations", async () => {
  const f = await fixture(), first = await produce(f, "Jit report");
  const conversation = f.app.execute(f.auth.actor, { kind: "conversation.create", requestId: rid(), expectedRevision: 1, payload: { botId: "scout" } }).conversation!;
  f.scripts.lanes.scout = async a => ({ state: "ready", text: "Scout result", report: report([claim(a, await f.read(a))], { title: "Scout report" }) });
  const payload = f.app.authority.view(f.auth.actor, first.work.id).grant!.command.payload;
  const work = f.app.execute(f.auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: conversation.revision, payload: { ...payload, conversationId: conversation.id, bots: [{ id: "scout", revision: 1 }], title: "Scout work" } }).work!;
  await f.app.authority.drain();
  const html = await f.page("/library"); expect(html).toContain("Jit report"); expect(html).toContain("Scout report"); expect(html).toContain("Scout"); expect(html).toContain(`work=${work.id}`);
  expect(f.app.reports.latest(f.auth.actor, [first.work.id, work.id])[work.id]).toMatchObject({ state: "available", report: { botIds: ["scout"] } });
});


test("Library provenance reads only owner-checked work metadata, without loading work histories", async () => {
  const f = await fixture(), { work } = await produce(f, "Metadata only");
  const history = spyOn(f.app.authority, "view").mockImplementation(() => { throw Error("full work history must not be loaded"); });
  try {
    const view = libraryView(f.app, f.auth.actor, new URL("http://localhost:3001/library"));
    expect(view.works[work.id]).toEqual({ id: work.id, title: work.title, conversationId: work.conversationId });
    expect(history).not.toHaveBeenCalled();
    expect(() => libraryView(f.app, {} as OwnerActor, new URL("http://localhost:3001/library"))).toThrow();
  } finally { history.mockRestore(); }
});
