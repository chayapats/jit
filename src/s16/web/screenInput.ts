import type { ScreenView } from "../computers/screen";
import type { VmScreenInput } from "../../s15/vm/screen";

/** The owner control one screen input belongs to: the takeover in force when the owner made it. */
export interface ScreenPin { generation: number; takeoverId: string }

/** The control the owner holds in `view`, or null when the owner is not driving. */
export function screenPin(view: ScreenView | null): ScreenPin | null {
  return view?.state === "owner" && view.takeoverId ? { generation: view.generation, takeoverId: view.takeoverId } : null;
}

/** Whether `view` still shows the owner holding the control `pin` was made under. */
export function holds(view: ScreenView | null, pin: ScreenPin): boolean {
  return view?.state === "owner" && view.generation === pin.generation && view.takeoverId === pin.takeoverId;
}

/** An ordered queue of the owner's screen input; see `screenInputQueue`. */
export interface ScreenInputQueue {
  /** Queues one input after everything queued before it, under the control it was made in (null: not driving, dropped). */
  push(input: VmScreenInput, pin: ScreenPin | null): void;
  /** Drops everything still waiting (the panel closed). */
  close(): void;
}

/**
 * Sends screen input one at a time, in the order the owner made it. Each input carries the generation and
 * takeover id it was made under, never the ones current when it leaves the queue, and an input still waiting
 * when control changes (hand-back, a new takeover, fencing) or the panel closes is dropped instead of sent.
 * So keys typed under one takeover can never act under a later one.
 */
export function screenInputQueue(send: (input: VmScreenInput, pin: ScreenPin) => Promise<unknown>, current: () => ScreenView | null): ScreenInputQueue {
  let tail: Promise<unknown> = Promise.resolve(), closed = false;
  return {
    push(input, pin) {
      if (!pin || closed) return;
      tail = tail.then(() => closed || !holds(current(), pin) ? undefined : send(input, pin)).catch(() => undefined);
    },
    close() { closed = true; },
  };
}
