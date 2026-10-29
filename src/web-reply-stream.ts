import type { JitReplyView } from "./team/jit-reply";
import type { ReplyPreview, ReplyStreams } from "./team/reply-stream";

/** Heartbeat/watchdog cadence and bounded connection lifetime; neither timer admits or polls work. */
export interface ReplyStreamOptions {
  intervalMs: number; polls: number;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}

/**
 * web.reply_stream/v2 push transport. Only durable events carry replay IDs. Provisional events replace a
 * snapshot; reconnect sends the current one. One queued frame (at most 256 KiB), no per-token subscriber queue.
 * Demand resumes from SQLite's cursor and the latest memory snapshot. Abort, cancel and expiry unsubscribe.
 */
export function replyEventStream(input: {
  cursor: number; projectId: string; topicId: string; signal: AbortSignal; streams: ReplyStreams;
  options: ReplyStreamOptions; changes(cursor: number): JitReplyView[];
  durable(view: JitReplyView): unknown; provisional(preview: ReplyPreview): unknown;
}): ReadableStream<Uint8Array> | null {
  const { options } = input;
  const timers = options.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const encoder = new TextEncoder(), seen = new Map<string, string>();
  let cursor = input.cursor, controller: ReadableStreamDefaultController<Uint8Array>;
  let closed = false, dirty = true, heartbeat = false, ticks = 0, handle: unknown = null, flushing = false;
  let unsubscribe: (() => void) | null = null;
  const finish = () => {
    if (closed) return;
    closed = true; if (handle !== null) timers.clear(handle);
    unsubscribe?.(); input.signal.removeEventListener("abort", finish);
    try { controller.close(); } catch { /* Cancelled by the reader. */ }
  };
  const send = (frame: string) => {
    const bytes = encoder.encode(frame);
    if (bytes.byteLength > 262_144) { finish(); return false; }
    controller.enqueue(bytes); return true;
  };
  const flush = () => {
    if (closed || flushing || controller.desiredSize === null || controller.desiredSize <= 0) return;
    flushing = true;
    try {
      if (dirty) {
        const view = input.changes(cursor)[0];
        if (view) {
          const frame = `id: ${view.cursor}\nevent: reply\ndata: ${JSON.stringify(input.durable(view))}\n\n`;
          cursor = view.cursor; send(frame);
          return;
        }
        dirty = false;
      }
      const previews = input.streams.previews(input.projectId, input.topicId);
      const active = new Set(previews.map(p => p.id));
      for (const id of seen.keys()) if (!active.has(id)) seen.delete(id);
      for (const preview of previews) {
        const version = `${preview.attemptId}:${preview.sequence}:${preview.stalled}`;
        if (seen.get(preview.id) === version) continue;
        const frame = `event: reply-preview\ndata: ${JSON.stringify(input.provisional(preview))}\n\n`;
        seen.set(preview.id, version); send(frame);
        return;
      }
      if (heartbeat) { heartbeat = false; send(": keep-alive\n\n"); }
    } catch { finish(); }
    finally { flushing = false; }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      unsubscribe = input.streams.subscribe(() => { dirty = true; flush(); });
      if (!unsubscribe) { finish(); return; }
      input.signal.addEventListener("abort", finish, { once: true });
      if (input.signal.aborted) { finish(); return; }
      send("retry: 1000\n\n");
      const tick = () => {
        if (closed) return;
        ticks++; heartbeat = true; flush();
        if (ticks >= options.polls) finish();
        else handle = timers.set(tick, options.intervalMs);
      };
      handle = timers.set(tick, options.intervalMs);
    },
    pull: flush,
    cancel: finish,
  }, { highWaterMark: 1 });
  return unsubscribe ? stream : null;
}
