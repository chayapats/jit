import { expect, test } from "bun:test";
import { VmSshDialGate } from "../src/s15/vm/dial";

function fixture() {
  let now = 0;
  const waits: { ms: number; release: () => void }[] = [];
  const gate = new VmSshDialGate(() => now, ms => new Promise<void>(resolve => waits.push({ ms, release: resolve })));
  return { gate, waits, advance: (time: number) => { now = time; } };
}
test("SSH starts are spaced while three guest commands can remain concurrent", async () => {
  const f = fixture(), finish = Promise.withResolvers<void>(), started: number[] = [], remaining: number[] = [];
  const send = (id: number) => f.gate.start("vm", 1000, undefined, async bound => { started.push(id); remaining.push(bound); await finish.promise; });
  const a = send(1), b = send(2), c = send(3);
  expect(started).toEqual([1]); expect(f.waits.map(w => w.ms)).toEqual([100, 200]);
  f.advance(100); f.waits[0]!.release(); await Promise.resolve(); expect(started).toEqual([1, 2]);
  f.advance(200); f.waits[1]!.release(); await Promise.resolve(); expect(started).toEqual([1, 2, 3]);
  expect(remaining).toEqual([1000, 900, 800]); finish.resolve(); await Promise.all([a, b, c]);
});
test("a cancelled queued connection never reaches its pre-dispatch send", async () => {
  const f = fixture(), controller = new AbortController(); let sends = 0;
  await f.gate.start("vm", 1000, undefined, async () => {});
  const queued = f.gate.start("vm", 1000, controller.signal, async () => { sends++; });
  controller.abort(); f.advance(100); f.waits[0]!.release();
  await expect(queued).rejects.toHaveProperty("name", "AbortError"); expect(sends).toBe(0);
});
test("queue delay cannot extend a command deadline or replay it", async () => {
  const f = fixture(); let sends = 0;
  await f.gate.start("vm", 1000, undefined, async () => {});
  await expect(f.gate.start("vm", 100, undefined, async () => { sends++; })).rejects.toMatchObject({ code: "vm_transport_timeout" });
  const queued = f.gate.start("vm", 200, undefined, async () => { sends++; });
  f.advance(201); f.waits[0]!.release(); await expect(queued).rejects.toMatchObject({ code: "vm_transport_timeout" }); expect(sends).toBe(0);
});
test("the protected dial queue has a finite per-endpoint capacity", async () => {
  const f = fixture(), finish = Promise.withResolvers<void>();
  const pending = Array.from({ length: 32 }, () => f.gate.start("vm", 10_000, undefined, async () => finish.promise));
  await expect(f.gate.start("vm", 10_000, undefined, async () => {})).rejects.toMatchObject({ code: "vm_limit_exhausted" });
  f.advance(3100); for (const waiting of f.waits) waiting.release(); finish.resolve(); await Promise.all(pending);
});
