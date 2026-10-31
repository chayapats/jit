import { expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { S14Store } from "../src/s14/store";
import { domainFixture, routineCommand, workCommand } from "./fixtures/s14-domain";
import { createS14Pump } from "../src/s14/pump";

// Observe successful IMMEDIATE boundaries through Bun's actual transaction wrapper.
// Deferred projection reads do not enter this count.
function commits(path: string) {
  const original = Database.prototype.transaction;
  let count = 0;
  const spy = spyOn(Database.prototype, "transaction").mockImplementation(function <T, A extends any[]>(this: Database, fn: (...args: A) => T) {
    const wrapped = original.call(this, fn) as { (...args: A): T; deferred: (...args: A) => T; immediate: (...args: A) => T; exclusive: (...args: A) => T };
    if (this.filename === path) {
      const immediate = wrapped.immediate;
      return Object.assign((...args: A) => wrapped(...args), { deferred: wrapped.deferred, exclusive: wrapped.exclusive,
        immediate: (...args: A) => { const result = immediate(...args); count++; return result; } });
    }
    return wrapped;
  });
  return { get count() { return count; }, reset() { count = 0; }, restore() { spy.mockRestore(); } };
}

test("idle maintenance with a settled routine performs no successful writer commits", async () => {
  const f = await domainFixture({ authority: { executor: { async run() { return { state: "ready", text: '{"outcome":"no_update"}' }; } } } });
  const pump = createS14Pump({ busy: () => false, tick: () => f.app.routines.tick(), replies: () => f.app.drainReplies(), work: () => f.app.authority.drain(), repliesQueued: () => false,
    git: () => f.app.git.drain(), attention: () => f.app.attention.drain(), personal: () => f.app.personal.drain(), personalEffects: () => f.app.personal.effects.drain(),
    botLifecycle: () => f.app.botLifecycle.drain({ async open() { throw Error("no_pending_native_cleanup"); } }) });
  let observed: ReturnType<typeof commits> | undefined;
  try {
    const routine = f.app.execute(f.auth.actor, routineCommand(f, { occurrenceBudget: 1 })).routine;
    f.clock.now += 60000;
    await pump.drain();
    expect(f.app.routines.view(f.auth.actor, routine.id).history[0]!.state).toBe("complete");
    observed = commits(f.path);
    for (let i = 0; i < 4; i++) { f.app.computers.sweep(); f.app.authority.cancelFenced(); await f.app.computers.drain(); await pump.drain(); }
    expect(observed.count).toBe(0);
    // A new due occurrence still writes and dispatches exactly once.
    f.app.execute(f.auth.actor, routineCommand(f, { occurrenceBudget: 1 }));
    f.clock.now += 60000; await pump.drain();
    expect(observed.count).toBeGreaterThan(0);
    observed.reset(); await pump.drain(); expect(observed.count).toBe(0);
  } finally { observed?.restore(); pump.stop(); await pump.idle(); f.dispose(); }
});

test("write-free rollback preserves results, nested writes, DDL and atomic attached-ledger failures", async () => {
  const f = await domainFixture();
  const observed = commits(f.path);
  try {
    expect(f.store.transaction(tx => tx.get<{ n: number }>("SELECT 17 n")!.n)).toBe(17);
    expect(f.store.transaction(() => f.store.transaction(() => undefined))).toBeUndefined();
    expect(observed.count).toBe(0);
    f.store.transaction(tx => { tx.run("CREATE TABLE idle_probe (id INTEGER PRIMARY KEY)"); tx.run("CREATE TABLE lifecycle.idle_probe (id INTEGER PRIMARY KEY)"); });
    f.store.transaction(tx => { f.store.transaction(() => tx.get("SELECT 1")); tx.run("INSERT INTO idle_probe VALUES (1)"); f.store.transaction(inner => inner.run("INSERT INTO lifecycle.idle_probe VALUES (1)")); });
    expect(() => f.store.transaction(tx => { tx.run("INSERT INTO idle_probe VALUES (2)"); tx.run("INSERT INTO lifecycle.idle_probe VALUES (2)"); throw Error("rollback_both"); })).toThrow("rollback_both");
    f.store.transaction(tx => tx.get("INSERT INTO idle_probe VALUES (3) RETURNING id"));
    f.store.transaction(tx => tx.all("INSERT INTO lifecycle.idle_probe VALUES (3) RETURNING id"));
    f.store.close();
    const reopened = new S14Store(f.path);
    try {
      for (const schema of ["main", "lifecycle"]) expect(reopened.read(tx => tx.all(`SELECT id FROM ${schema}.idle_probe ORDER BY id`))).toEqual([{ id: 1 }, { id: 3 }]);
      expect(reopened.read(tx => tx.get("PRAGMA synchronous"))).toEqual({ synchronous: 2 });
      expect(reopened.read(tx => tx.get("PRAGMA journal_mode"))).toEqual({ journal_mode: "delete" });
    } finally { reopened.close(); }
  } finally { observed.restore(); f.dispose(); }
});


test("settled review-waiting work does not advance revisions or commit again on polling", async () => {
  const f = await domainFixture({ authority: { executor: { async run() { return { state: "waiting", text: "Owner review required" }; } } } });
  let observed: ReturnType<typeof commits> | undefined;
  try {
    const work = f.app.execute(f.auth.actor, workCommand(f)).work!;
    await f.app.authority.drain();
    const before = f.app.authority.view(f.auth.actor, work.id).work;
    expect(before.state).toBe("waiting");
    observed = commits(f.path);
    for (let i = 0; i < 4; i++) await f.app.authority.drain();
    expect(f.app.authority.view(f.auth.actor, work.id).work.revision).toBe(before.revision);
    expect(observed.count).toBe(0);
  } finally { observed?.restore(); f.dispose(); }
});
