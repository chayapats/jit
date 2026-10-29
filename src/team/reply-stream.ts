import type { TransactionStore } from "../store";
import { ReplyProseBuffer } from "./reply-format";

/** web.reply_stream/v2 memory limits: 64 active previews, 32 KiB each, 128 connected readers per store. */
export const replyStreamBounds = Object.freeze({ replies: 64, bytes: 32_768, readers: 128 });
/** Active attempts with no text delta for this many milliseconds show the localised still-working state. */
export const replyStallMs = 10_000;
/** A replacement snapshot, never a persisted event, source, message, or replay cursor. */
export interface ReplyPreview {
  id: string; projectId: string; topicId: string; attemptId: string; sequence: number;
  text: string; stalled: boolean;
}
interface Active {
  id: string; projectId: string; topicId: string; attemptId: string;
  sequence: number; text: string; lastDelta: number; parser: ReplyProseBuffer;
  current(): boolean; now(): number;
}

/**
 * Attempt-scoped, bounded in-process preview mailbox. Slow readers coalesce to the latest snapshot;
 * they never queue deltas or back-pressure model execution. A stale attempt is discarded on every read/write.
 */
export class ReplyStreams {
  #active = new Map<string, Active>();
  #listeners = new Set<() => void>();
  #queued = false;
  constructor(store: TransactionStore) { store.onCommit(() => this.wake()); }
  /** Coalesces notifications into one microtask; subscribers must honour their transport's demand. */
  wake(): void {
    if (this.#queued) return;
    this.#queued = true;
    queueMicrotask(() => {
      this.#queued = false;
      for (const listener of this.#listeners) {
        try { listener(); } catch { /* A detached or failed reader never affects another reader or the run. */ }
      }
    });
  }
  /** Attaches one reader without retaining event bodies; returns null at the connection limit. */
  subscribe(listener: () => void): (() => void) | null {
    if (this.#listeners.size >= replyStreamBounds.readers) return null;
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }
  /** Begins a fresh attempt with its own bounded parser; returning null disables only the optional preview. */
  begin(identity: Pick<ReplyPreview, "id" | "projectId" | "topicId" | "attemptId">,
    bytes: number, now: () => number, current: () => boolean): { delta(text: string): void; reset(): void; end(): void } | null {
    this.previews(identity.projectId, identity.topicId);
    if (this.#active.size >= replyStreamBounds.replies && !this.#active.has(identity.id)) return null;
    const bound = Math.min(bytes, replyStreamBounds.bytes);
    const entry: Active = { ...identity, sequence: 0, text: "", lastDelta: now(), parser: new ReplyProseBuffer(bound), now, current };
    this.#active.set(entry.id, entry); this.wake();
    const valid = () => this.#active.get(entry.id) === entry && this.#current(entry);
    return {
      delta: text => {
        if (!valid()) return;
        entry.lastDelta = now(); entry.sequence++; entry.text = entry.parser.append(text); this.wake();
      },
      reset: () => {
        if (!valid()) return;
        entry.parser = new ReplyProseBuffer(bound); entry.text = ""; entry.sequence++; entry.lastDelta = now(); this.wake();
      },
      end: () => { if (this.#active.get(entry.id) === entry) { this.#active.delete(entry.id); this.wake(); } },
    };
  }
  #current(entry: Active): boolean {
    try { if (entry.current()) return true; } catch { /* Deleted or closed store. */ }
    if (this.#active.get(entry.id) === entry) this.#active.delete(entry.id);
    return false;
  }
  /** Reads only current previews in the authenticated topic; watchdog status derives from the attempt's clock. */
  previews(projectId: string, topicId: string): ReplyPreview[] {
    const result: ReplyPreview[] = [];
    for (const entry of this.#active.values()) {
      if (entry.projectId !== projectId || entry.topicId !== topicId || !this.#current(entry)) continue;
      const { id, attemptId, sequence, text } = entry;
      result.push({ id, projectId, topicId, attemptId, sequence, text, stalled: entry.now() - entry.lastDelta >= replyStallMs });
    }
    return result;
  }
}

const streams = new WeakMap<TransactionStore, ReplyStreams>();
/** Returns the store-local mailbox; reopening a store starts with no provisional text. */
export function replyStreams(store: TransactionStore): ReplyStreams {
  let stream = streams.get(store);
  if (!stream) { stream = new ReplyStreams(store); streams.set(store, stream); }
  return stream;
}
