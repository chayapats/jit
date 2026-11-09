import { describe, expect, test } from "bun:test";
import type { ScreenView } from "../src/s16/computers/screen";
import type { VmScreenInput } from "../src/s15/vm/screen";
import { screenInputQueue, screenPin, type ScreenPin } from "../src/s16/web/screenInput";

const view = (state: ScreenView["state"], generation: number, takeoverId: string | null): ScreenView => ({
  contract: "s16-computer-screen/v1", vmId: "vm1", available: true, code: null, width: 1280, height: 800,
  state, generation, takeoverId, expiresAt: null, agentBusy: false, scope: { kind: "shared" },
});
const key = (name: string): VmScreenInput => ({ kind: "key", keys: [name] });
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

/** A send that stays open until released, so tests can change control while inputs wait. */
function harness(start: ScreenView) {
  let current: ScreenView | null = start;
  const sent: { input: VmScreenInput; pin: ScreenPin }[] = [], open: (() => void)[] = [];
  const queue = screenInputQueue((input, pin) => { sent.push({ input, pin }); return new Promise<void>(resolve => open.push(resolve)); }, () => current);
  return { queue, sent, set(next: ScreenView | null) { current = next; }, async release() { open.shift()?.(); await settle(); } };
}

describe("screen input queue (DESK16-01)", () => {
  test("screenPin is the owner's control only", () => {
    expect(screenPin(view("owner", 4, "t1"))).toEqual({ generation: 4, takeoverId: "t1" });
    for (const state of ["agent", "settling", "fenced"] as const) expect(screenPin(view(state, 4, "t1"))).toBeNull();
    expect(screenPin(null)).toBeNull();
  });

  test("inputs go out one at a time, in order, under the takeover they were made in", async () => {
    const h = harness(view("owner", 4, "t1")), pin = screenPin(view("owner", 4, "t1"));
    h.queue.push(key("a"), pin); h.queue.push(key("b"), pin); await settle();
    expect(h.sent.map(s => s.input)).toEqual([key("a")]);
    await h.release();
    expect(h.sent).toEqual([{ input: key("a"), pin: { generation: 4, takeoverId: "t1" } }, { input: key("b"), pin: { generation: 4, takeoverId: "t1" } }]);
  });

  test("waiting inputs from an earlier takeover never go out under a later one", async () => {
    const h = harness(view("owner", 4, "t1")), old = screenPin(view("owner", 4, "t1"));
    h.queue.push(key("a"), old); h.queue.push(key("b"), old); h.queue.push(key("c"), old); await settle();
    // Another tab hands back and takes control again while "a" is still on its way.
    h.set(view("owner", 5, "t2"));
    await h.release(); await h.release();
    expect(h.sent.map(s => s.input)).toEqual([key("a")]);
    // New input made under the new takeover still goes out, with the new ids.
    h.queue.push(key("d"), screenPin(view("owner", 5, "t2"))); await settle();
    expect(h.sent.at(-1)).toEqual({ input: key("d"), pin: { generation: 5, takeoverId: "t2" } });
  });

  test("input waiting through a hand-back or fencing is dropped", async () => {
    for (const after of [view("agent", 5, null), view("fenced", 4, null)]) {
      const h = harness(view("owner", 4, "t1")), pin = screenPin(view("owner", 4, "t1"));
      h.queue.push(key("a"), pin); h.queue.push(key("b"), pin); await settle();
      h.set(after); await h.release();
      expect(h.sent.map(s => s.input)).toEqual([key("a")]);
    }
  });

  test("closing the panel drops waiting input; input made while not driving is never queued", async () => {
    const h = harness(view("owner", 4, "t1")), pin = screenPin(view("owner", 4, "t1"));
    h.queue.push(key("a"), pin); h.queue.push(key("b"), pin); await settle();
    h.queue.close(); await h.release();
    h.queue.push(key("c"), pin); await settle();
    expect(h.sent.map(s => s.input)).toEqual([key("a")]);
    const idle = harness(view("agent", 4, null));
    idle.queue.push(key("a"), null); await settle();
    expect(idle.sent).toEqual([]);
  });

  test("a failed send does not stop later input", async () => {
    let calls = 0;
    const current = view("owner", 4, "t1"), pin = screenPin(current);
    const queue = screenInputQueue(async () => { calls++; if (calls === 1) throw new Error("network"); }, () => current);
    queue.push(key("a"), pin); queue.push(key("b"), pin); await settle(); await settle();
    expect(calls).toBe(2);
  });
});
