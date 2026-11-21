import { expect, test } from "bun:test";
import { MobileWork, type MobileWorkItem } from "../src/s16/mobile/work";
import { mobileFixture } from "./fixtures/s16-mobile";

type Fixture = Awaited<ReturnType<typeof mobileFixture>>;
async function seed(f: Fixture, count: number) {
  f.f.interpretation = { intent: "answer", purposeId: "purpose", resourceIds: ["computer"], access: "read", subject: null }; f.f.script = [];
  for (let index = 0; index < count; index++) {
    f.f.advance(1); f.f.service.conversation.submit(f.f.owner, { contract: "s15-conversation/v1", requestId: `work_${index}`, conversationId: `short_${index}`, text: `What about controlled task ${index}?`, continuation: null });
  }
  await f.f.service.conversation.drain(); await f.session.restore();
}
function observe(f: Fixture) {
  const publications: (readonly MobileWorkItem[] | null)[] = [], errors: string[] = [];
  const work = new MobileWork(f.session, { publish(items) { publications.push(items); }, failure(error) { errors.push(error.code); } });
  return { work, publications, errors };
}

test("64 short Work snapshots finish across repeated unchanged poll objects instead of starving or multiplying reads", async () => {
  const f = await mobileFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let hold = true, reads = 0;
  try {
    await seed(f, 64); const observed = observe(f), modelCalls = f.f.modelPrompts.length;
    f.intercept = async request => {
      if (/\/conversations\/short_\d+$/.test(new URL(request.url).pathname)) {
        reads++; const response = await f.f.service.fetch(request); if (hold) { hold = false; entered.resolve(); await release.promise; } return response;
      }
      return null;
    };
    const loading = observed.work.refresh(f.session.projection.bootstrap!); await entered.promise;
    for (let poll = 0; poll < 3; poll++) {
      const before = f.session.projection.bootstrap; await f.session.poll(); expect(f.session.projection.bootstrap).not.toBe(before);
      expect(observed.work.refresh(f.session.projection.bootstrap!)).toBe(loading);
    }
    expect(reads).toBe(1); expect(observed.publications).toEqual([]);
    release.resolve(); await loading;
    const items = observed.publications.at(-1)!; expect(items).not.toBeNull(); expect(items!.length).toBe(64); expect(new Set(items!.map(item => item.row.requestId)).size).toBe(64); expect(reads).toBe(64); expect(observed.errors).toEqual([]); expect(f.f.modelPrompts.length).toBe(modelCalls);
    observed.work.close();
  } finally { release.resolve(); await f.close(); }
});

test("leaving Work aborts the actual snapshot and late completion cannot revive cards or fence the current session", async () => {
  const f = await mobileFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), signals: AbortSignal[] = [];
  try {
    await seed(f, 1); const observed = observe(f), read = f.session.readSnapshot.bind(f.session);
    f.session.readSnapshot = (id, signal) => { signals.push(signal!); return read(id, signal); };
    f.intercept = async request => { if (new URL(request.url).pathname.endsWith("/conversations/short_0")) { const response = await f.f.service.fetch(request); entered.resolve(); await release.promise; return response; } return null; };
    const loading = observed.work.refresh(f.session.projection.bootstrap!); await entered.promise;
    observed.work.close(); expect(signals[0]!.aborted).toBe(true); expect(observed.publications).toEqual([null]);
    await loading; expect(f.session.projection.phase).toBe("ready"); release.resolve(); await Promise.resolve(); expect(observed.publications).toEqual([null]); expect(observed.errors).toEqual([]);
  } finally { release.resolve(); await f.close(); }
});

test("background synchronously clears Work cards and an old load cannot publish after a foreground generation", async () => {
  const f = await mobileFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let hold = false;
  try {
    await seed(f, 1); const observed = observe(f); await observed.work.refresh(f.session.projection.bootstrap!); expect(observed.publications.at(-1)!.length).toBe(1);
    hold = true; f.intercept = async request => { if (hold && new URL(request.url).pathname.endsWith("/conversations/short_0")) { const response = await f.f.service.fetch(request); entered.resolve(); await release.promise; return response; } return null; };
    const loading = observed.work.refresh(f.session.projection.bootstrap!); await entered.promise; f.session.background(); expect(observed.publications.at(-1)).toBeNull();
    hold = false; release.resolve(); await loading; await f.session.restore(); expect(f.session.projection.phase).toBe("ready");
    await observed.work.refresh(f.session.projection.bootstrap!); expect(observed.publications.at(-1)).toBeNull(); expect(observed.errors).toEqual([]);
  } finally { release.resolve(); await f.close(); }
});

test("a changed navigation list queues one latest read and withholds removed identities from the first publication", async () => {
  const f = await mobileFixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let hold = true;
  try {
    await seed(f, 2); const observed = observe(f), first = f.session.projection.bootstrap!; let reads = 0;
    f.intercept = async request => { if (/\/conversations\/short_\d+$/.test(new URL(request.url).pathname)) { reads++; const response = await f.f.service.fetch(request); if (hold) { hold = false; entered.resolve(); await release.promise; } return response; } return null; };
    const loading = observed.work.refresh(first); await entered.promise;
    const latest = { ...first, conversations: first.conversations.filter(row => row.conversationId === "short_0") };
    expect(observed.work.refresh(latest)).toBe(loading); release.resolve(); await loading;
    expect(observed.publications.filter(Boolean).every(items => items!.every(item => item.conversationId === "short_0"))).toBe(true);
    expect(observed.publications.at(-1)!.map(item => item.row.requestId)).toEqual(["work_0"]); expect(reads).toBe(3); expect(observed.errors).toEqual([]); observed.work.close();
  } finally { release.resolve(); await f.close(); }
});

test("cancelable Work reads preserve authentication failures rather than treating them as local navigation cancellation", async () => {
  const f = await mobileFixture();
  try {
    await seed(f, 1); const observed = observe(f);
    f.intercept = request => new URL(request.url).pathname.endsWith("/conversations/short_0") ? Response.json({ error: "authentication_required" }, { status: 401 }) : null;
    await observed.work.refresh(f.session.projection.bootstrap!);
    expect(f.session.projection.phase).toBe("locked"); expect(f.transport.authenticated).toBe(false); expect(observed.publications.at(-1)).toBeNull(); expect(observed.publications.filter(Boolean)).toEqual([]);
  } finally { await f.close(); }
});
