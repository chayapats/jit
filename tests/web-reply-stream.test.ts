import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TransactionStore } from "../src/store";
import { ReplyStreams, replyStallMs, replyStreamBounds } from "../src/team/reply-stream";
import type { JitReplyView } from "../src/team/jit-reply";
import { replyEventStream } from "../src/web-reply-stream";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const identity = () => ({ id: crypto.randomUUID(), projectId: "project", topicId: "topic", attemptId: crypto.randomUUID() });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-str01-stream-"));
  const store = new TransactionStore(join(root, "state.sqlite"));
  cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const streams = new ReplyStreams(store), abort = new AbortController();
  cleanup.push(() => abort.abort());
  let now = 0, next = 0;
  const pending = new Map<number, { at: number; callback(): void }>();
  const timers = { set(callback: () => void, ms: number) { const id = ++next; pending.set(id, { at: now + ms, callback }); return id; },
    clear(id: unknown) { pending.delete(id as number); } };
  const open = (changes: (cursor: number, limit: 1) => JitReplyView[] = () => [], cursor = 0) => replyEventStream({
    cursor, projectId: "project", topicId: "topic", signal: abort.signal, streams, changes,
    options: { intervalMs: 1000, polls: 120, timers }, durable: view => view, provisional: preview => preview,
  })!;
  return { store, streams, abort, open, pending, now: () => now,
    advance(ms: number) { now += ms; for (const [id, timer] of [...pending]) if (timer.at <= now) { pending.delete(id); timer.callback(); } } };
}
const frame = async (reader: ReadableStreamDefaultReader<Uint8Array>) => new TextDecoder().decode((await reader.read()).value);
const data = (frame: string) => JSON.parse(frame.split("\ndata: ")[1]!.trim());

test("push delivers a delta within 100 ms on a fake clock, independently of the one-second watchdog timer", async () => {
  const f = fixture(), id = identity();
  const active = f.streams.begin(id, 4096, f.now, () => true)!;
  const reader = f.open().getReader();
  expect(await frame(reader)).toContain("retry:");
  expect(data(await frame(reader))).toMatchObject({ sequence: 0, text: "" });
  const received = frame(reader).then(value => ({ value, at: f.now() }));
  const emitted = f.now(); active.delta("สวัสดี 🧪");
  const delivered = await received;
  expect(delivered.at - emitted).toBeLessThanOrEqual(100);
  expect(data(delivered.value)).toMatchObject({ text: "สวัสดี 🧪", sequence: 1, stalled: false });
  expect(delivered.value).not.toContain("id:");
  expect(f.pending.size).toBe(1); // The timer has not fired.
  await reader.cancel(); expect(f.pending.size).toBe(0);
});

test("watchdog, recovery and retry reset use fake time and never manufacture a durable event", async () => {
  const f = fixture(), id = identity();
  const active = f.streams.begin(id, 4096, f.now, () => true)!;
  active.delta("ร่าง");
  const reader = f.open().getReader(); await frame(reader); await frame(reader);
  const before = frame(reader); f.advance(replyStallMs - 1);
  expect(await before).toContain(": keep-alive");
  const stalled = frame(reader); f.advance(1); f.streams.wake();
  expect(data(await stalled)).toMatchObject({ text: "ร่าง", stalled: true });
  const resumed = frame(reader); active.delta("ต่อ");
  expect(data(await resumed)).toMatchObject({ text: "ร่างต่อ", stalled: false });
  const reset = frame(reader); active.reset();
  expect(data(await reset)).toMatchObject({ text: "", stalled: false, sequence: 3 });
  const newer = frame(reader); active.delta("คำตอบใหม่");
  expect(data(await newer).text).toBe("คำตอบใหม่");
  await reader.cancel();
});

test("a slow reader coalesces bursts, reconnect replaces the snapshot, and stale attempts disappear", async () => {
  const f = fixture(), id = identity(); let current = true;
  const active = f.streams.begin(id, 4096, f.now, () => current)!;
  active.delta("a");
  const reader = f.open().getReader(); await frame(reader); await drain();
  for (let i = 0; i < 1000; i++) active.delta("b");
  await drain();
  expect(data(await frame(reader)).text).toBe("a"); // The single already-queued frame.
  expect(data(await frame(reader))).toMatchObject({ text: "a" + "b".repeat(1000), sequence: 1001 });
  await reader.cancel();
  const reconnected = f.open().getReader(); await frame(reconnected);
  expect(data(await frame(reconnected)).text).toBe("a" + "b".repeat(1000));
  current = false; active.delta("STALE");
  expect(f.streams.previews("project", "topic")).toEqual([]);
  await reconnected.cancel();
  expect(f.streams.previews("other-project", "topic")).toEqual([]);
});

test("durable replay honours demand and per-event cursors; abort and expiry release every reader", async () => {
  const f = fixture();
  const views = [1, 2, 3].map(cursor => ({ id: String(cursor), cursor, state: "answered" }) as JitReplyView);
  let reads = 0;
  const changes = (cursor: number, limit: 1) => { reads++; return views.filter(view => view.cursor > cursor).slice(0, limit); };
  const first = f.open(changes).getReader();
  await drain(); expect(reads).toBe(0); // Retry is queued: no demand for persisted data yet.
  await frame(first);
  expect(await frame(first)).toContain("id: 1\nevent: reply");
  await first.cancel();
  const resumed = f.open(changes, 1).getReader(); await frame(resumed);
  expect(await frame(resumed)).toContain("id: 2\nevent: reply");
  expect(await frame(resumed)).toContain("id: 3\nevent: reply");
  f.abort.abort(); expect(f.pending.size).toBe(0);
  const life = fixture(), idle = life.open().getReader(); await frame(idle);
  for (let i = 0; i < 120; i++) life.advance(1000);
  // At most one keep-alive is queued even when the connection expires without demand.
  await frame(idle); expect((await idle.read()).done).toBe(true);
  expect(life.pending.size).toBe(0);
});

test("topic readers never check unrelated draft authority, but recheck every matching draft", () => {
  const f = fixture(), checks = [0, 0, 0];
  let current = true;
  const matching = identity();
  f.streams.begin(matching, 4096, f.now, () => { checks[0]!++; return current; });
  f.streams.begin({ ...identity(), projectId: "other-project" }, 4096, f.now, () => { checks[1]!++; return true; });
  f.streams.begin({ ...identity(), topicId: "other-topic" }, 4096, f.now, () => { checks[2]!++; return true; });
  checks.fill(0);
  for (let reader = 0; reader < 5; reader++) {
    expect(f.streams.previews("project", "topic").map(p => p.id)).toEqual([matching.id]);
  }
  expect(checks).toEqual([5, 0, 0]);
  current = false;
  expect(f.streams.previews("project", "topic")).toEqual([]);
  expect(checks).toEqual([6, 0, 0]);
  expect(f.streams.previews("other-project", "topic")).toHaveLength(1);
  expect(checks).toEqual([6, 1, 0]);
});

test("durable replay projects each row once and holds at most one frame without reader demand", async () => {
  const f = fixture();
  const views = Array.from({ length: 25 }, (_, i) => ({ id: String(i + 1), cursor: i + 1, state: "answered" }) as JitReplyView);
  let projected = 0;
  const limits: number[] = [];
  const changes = (cursor: number, limit: 1) => {
    limits.push(limit);
    const page = views.filter(view => view.cursor > cursor).slice(0, limit);
    projected += page.length; return page;
  };
  const reader = f.open(changes).getReader();
  await drain(); expect(projected).toBe(0);
  await frame(reader); await drain();
  expect(projected).toBe(1);
  f.streams.wake(); f.advance(1000); await drain();
  expect(projected).toBe(1); // A slow reader has one queued frame and no cached page.
  for (const view of views) expect(data(await frame(reader)).cursor).toBe(view.cursor);
  await drain();
  expect(projected).toBe(25);
  expect(limits.every(limit => limit === 1)).toBe(true);
  await reader.cancel();
  projected = 0;
  const resumed = f.open(changes, 17).getReader(); await frame(resumed);
  for (const view of views.slice(17)) expect(data(await frame(resumed)).cursor).toBe(view.cursor);
  expect(projected).toBe(8);
  await resumed.cancel();
});

test("an oversized durable frame closes the stream without queuing the body", async () => {
  const f = fixture();
  const reader = f.open(() => [{ cursor: 1, reason: "x".repeat(262_144) } as JitReplyView]).getReader();
  expect(await frame(reader)).toContain("retry:");
  expect((await reader.read()).done).toBe(true);
  expect(f.pending.size).toBe(0);
});

test("preview and reader bounds cannot grow with unbounded work or connections", async () => {
  const f = fixture(), handles = [];
  for (let i = 0; i < replyStreamBounds.replies; i++) handles.push(f.streams.begin(identity(), 100_000, f.now, () => true)!);
  expect(f.streams.begin(identity(), 4096, f.now, () => true)).toBeNull();
  handles[0]!.delta("x".repeat(replyStreamBounds.bytes));
  handles[0]!.delta("overflow");
  expect(f.streams.previews("project", "topic")[0]!.text).toBe("");
  handles[0]!.end(); expect(f.streams.begin(identity(), 4096, f.now, () => true)).not.toBeNull();
  const unsub = Array.from({ length: replyStreamBounds.readers }, () => f.streams.subscribe(() => {})!);
  expect(f.streams.subscribe(() => {})).toBeNull();
  unsub[0]!(); expect(f.streams.subscribe(() => {})).not.toBeNull();
  await drain();
});

test("commit notifications never escape a rollback or a failed outer transaction", async () => {
  const f = fixture(); let commits = 0;
  f.store.onCommit(() => { commits++; });
  expect(() => f.store.transaction(() => { f.store.transaction(() => {}); throw new Error("rollback"); })).toThrow("rollback");
  expect(commits).toBe(0);
  f.store.transaction(() => { f.store.transaction(() => {}); });
  expect(commits).toBe(1);
  f.store.onCommit(() => { throw new Error("observer failure"); });
  expect(() => f.store.transaction(() => {})).not.toThrow();
});
