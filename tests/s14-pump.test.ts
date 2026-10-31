import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S14Application } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import { createS14Pump } from "../src/s14/pump";
const rid = () => crypto.randomUUID().replaceAll("-", "");
const turns = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

test("a real in-flight authority attempt cannot starve service lanes or escape shutdown settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-pump-"));
  const store = new S14Store(join(root, "state.sqlite"));
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const app = new S14Application(store, { now: () => 1800000000000,
    policy: { routes: [{ id: "route", provider: "codex", model: "fixture" }], tools: [], resources: [] },
    chat: { async reply() { return { text: "chat" }; } },
    authority: { executor: { async run() { entered.resolve(); await release.promise; return { state: "ready", text: "late" }; } } },
  });
  await app.provisionOwner("fixture-pump-password");
  const actor = app.authenticate(await app.login("fixture-pump-password")).actor;
  const setup = app.execute(actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Owner", language: "en", routeId: "route", capabilities: { tools: [], resources: [] } } });
  const started = app.execute(actor, { kind: "work.start", requestId: rid(), expectedRevision: 1, payload: {
    conversationId: setup.conversation!.id, task: null, title: "Held attempt", purpose: "Held", completionRule: "Done",
    bots: [{ id: "jit", revision: 1 }], tools: [], scopes: [], expiresAt: 1800001800000,
    limits: { attempts: 1, steps: 1, calls: 4, reads: 1, concurrency: 1, wallMs: 1800000, outputBytes: 65536 },
  } });
  const seen: string[] = [];
  const lane = (name: string) => async () => { seen.push(name); };
  const pump = createS14Pump({ busy: () => false, tick() {}, replies: () => app.drainReplies(), work: () => app.authority.drain(), repliesQueued: () => false,
    git: lane("git"), attention: lane("attention"), personal: lane("personal"), personalEffects: lane("effects"), botLifecycle: lane("lifecycle") });
  const draining = pump.drain();
  try {
    await entered.promise; await turns();
    expect(seen.sort()).toEqual(["attention", "effects", "git", "lifecycle", "personal"]);
    pump.stop(); let settled = false;
    const shutting = app.authority.shutdown().then(() => pump.idle()).then(() => { settled = true; });
    await turns(); expect(settled).toBe(false);
    release.resolve(); await shutting;
    expect(app.authority.view(actor, started.work!.id).results).toEqual([]);
  } finally {
    pump.stop(); release.resolve(); await app.authority.shutdown(); await draining; await pump.idle(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});

test("each lane is single flight; slow/failing lanes do not gate peers, and shutdown seals admissions", async () => {
  const hold = Promise.withResolvers<void>(), chat = Promise.withResolvers<void>();
  const calls = { replies: 0, work: 0, git: 0, attention: 0, personal: 0, effects: 0, lifecycle: 0 };
  let busy = true;
  const pump = createS14Pump({ busy: () => busy, tick() {},
    replies: async () => { calls.replies++; await chat.promise; },
    work: async () => { calls.work++; }, repliesQueued: () => false,
    git: async () => { calls.git++; await hold.promise; throw new Error("git unavailable"); },
    attention: async () => { calls.attention++; }, personal: async () => { calls.personal++; },
    personalEffects: async () => { calls.effects++; }, botLifecycle: async () => { calls.lifecycle++; },
  });
  await pump.drain(); expect(calls.replies).toBe(0);
  busy = false;
  const first = pump.drain(), second = pump.drain();
  // Observe rejection now, even if an assertion fails before releasing the barrier.
  const firstResult = first.catch(e => e.message), secondResult = second.catch(e => e.message);
  try {
    await turns();
    expect(calls).toEqual({ replies: 1, work: 0, git: 1, attention: 1, personal: 1, effects: 1, lifecycle: 1 });
    const thirdResult = pump.drain().catch(e => e.message); await turns();
    expect(calls.git).toBe(1); expect(calls.replies).toBe(1); expect(calls.attention).toBe(2);
    pump.stop(); let idle = false;
    const closing = pump.idle().catch(e => e.message).then(() => { idle = true; });
    chat.resolve(); await turns(); expect(calls.work).toBe(0); expect(idle).toBe(false);
    hold.resolve(); await closing;
    expect(await firstResult).toBe("git unavailable"); expect(await secondResult).toBe("git unavailable"); expect(await thirdResult).toBe("git unavailable");
    const before = { ...calls }; await pump.drain(); expect(calls).toEqual(before);
  } finally { pump.stop(); chat.resolve(); hold.resolve(); await firstResult; await secondResult; await pump.idle().catch(() => {}); }
});
