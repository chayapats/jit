import { AppError } from "../errors";
import type { BoxStream } from "./box-runtime";

/**
 * jit.box.cdp-stream/v1 (EXE14, ADR 0039) — the dedicated Chrome DevTools Protocol channel into a browser box.
 *
 * One long-lived `podman exec -i` per browser session runs `/opt/jit/cdp-relay` in the box; the relay bridges
 * Chromium's `--remote-debugging-pipe` descriptors to its stdin/stdout. On this pipe every message is one JSON object
 * terminated by a NUL byte, at most {@link cdpMessageBytes} in either direction. A longer message, malformed JSON or
 * a closed pipe closes the client and fails every pending command (`cdp_protocol_error`, `cdp_closed`). Every command
 * has a deadline (`cdp_timeout`). CDP never goes through the one-shot runner (`jit.box.runner/v1`) and no debugging
 * port is ever opened: closing the stream kills the relay, and with it Chromium.
 */
export const cdpStreamContract = "jit.box.cdp-stream/v1";
/** The relay inside the `browser` image (`ops/box/cdp-relay`, mode 0555). */
export const cdpRelayPath = "/opt/jit/cdp-relay";
/** Most bytes of one CDP message, without its NUL terminator. */
export const cdpMessageBytes = 1_048_576;
/** Default per-command deadline. */
export const cdpCommandMs = 15_000;

/** A CDP event (`method` and `params`), with its target session when flattened. */
export interface CdpEvent { method: string; params: Record<string, unknown>; sessionId?: string }

interface Pending { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** The CDP client over one relay stream. */
export class CdpClient {
  readonly #stream: BoxStream;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(event: CdpEvent) => void>();
  readonly #closeListeners = new Set<(reason: string) => void>();
  readonly #commandMs: number;
  #next = 1;
  #closed: string | null = null;

  constructor(stream: BoxStream, options: { commandMs?: number } = {}) {
    this.#stream = stream;
    this.#commandMs = options.commandMs ?? cdpCommandMs;
    void this.#read();
    void stream.exited.then(() => this.close("cdp_closed"));
  }

  /** The reason the client closed (`cdp_closed`, `cdp_protocol_error`, or the caller's), or null while open. */
  get closed(): string | null { return this.#closed; }

  /** Sends one command and resolves with its `result`; a protocol error rejects `cdp_error` with the CDP code. */
  send(method: string, params: Record<string, unknown> = {}, options: { sessionId?: string; timeoutMs?: number } = {}): Promise<Record<string, unknown>> {
    if (this.#closed) return Promise.reject(new AppError(this.#closed === "cdp_protocol_error" ? "cdp_protocol_error" : "cdp_closed", 502));
    const id = this.#next++;
    const bytes = new TextEncoder().encode(JSON.stringify({ id, method, params, ...(options.sessionId ? { sessionId: options.sessionId } : {}) }));
    if (bytes.length > cdpMessageBytes) return Promise.reject(new AppError("cdp_message_too_large", 413));
    return new Promise((resolve, reject) => {
      const settle = () => { clearTimeout(pending.timer); this.#pending.delete(id); };
      const pending: Pending = {
        resolve: value => { settle(); resolve(value); },
        reject: error => { settle(); reject(error); },
        timer: setTimeout(() => { settle(); reject(new AppError("cdp_timeout", 504)); }, options.timeoutMs ?? this.#commandMs),
      };
      this.#pending.set(id, pending);
      const framed = new Uint8Array(bytes.length + 1);
      framed.set(bytes);
      try { this.#stream.write(framed); } catch { pending.reject(new AppError("cdp_closed", 502)); this.close("cdp_closed"); }
    });
  }

  /** Subscribes to events; returns the unsubscribe function. */
  on(listener: (event: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Called once when the client closes, with the reason. */
  onClose(listener: (reason: string) => void): void {
    if (this.#closed) listener(this.#closed);
    else this.#closeListeners.add(listener);
  }

  /** Waits for the first event matching `filter`, or rejects `cdp_timeout`. */
  waitFor(filter: (event: CdpEvent) => boolean, timeoutMs = this.#commandMs): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new AppError("cdp_timeout", 504)); }, timeoutMs);
      const off = this.on(event => { if (filter(event)) { clearTimeout(timer); off(); resolve(event); } });
    });
  }

  /** Closes the stream (killing the relay and Chromium) and fails every pending command. Idempotent. */
  close(reason = "closed"): void {
    if (this.#closed) return;
    this.#closed = reason;
    const error = new AppError(reason === "cdp_protocol_error" ? "cdp_protocol_error" : "cdp_closed", 502);
    for (const pending of [...this.#pending.values()]) pending.reject(error);
    this.#stream.close();
    for (const listener of this.#closeListeners) { try { listener(reason); } catch { /* A listener never blocks the close. */ } }
    this.#closeListeners.clear();
    this.#listeners.clear();
  }

  async #read(): Promise<void> {
    let buffer = new Uint8Array(0);
    try {
      for await (const chunk of this.#stream.stdout) {
        if (this.#closed) return;
        const joined = new Uint8Array(buffer.length + chunk.length);
        joined.set(buffer); joined.set(chunk, buffer.length);
        buffer = joined;
        for (let end = buffer.indexOf(0); end >= 0; end = buffer.indexOf(0)) {
          const message = buffer.subarray(0, end);
          buffer = buffer.slice(end + 1);
          if (message.length > cdpMessageBytes) return this.close("cdp_protocol_error");
          this.#dispatch(new TextDecoder().decode(message));
          if (this.#closed) return;
        }
        if (buffer.length > cdpMessageBytes) return this.close("cdp_protocol_error");
      }
    } catch { /* The pipe broke. */ }
    this.close("cdp_closed");
  }

  #dispatch(text: string): void {
    let message: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown }; sessionId?: unknown };
    try { message = JSON.parse(text); } catch { return this.close("cdp_protocol_error"); }
    if (!message || typeof message !== "object") return this.close("cdp_protocol_error");
    if (typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      if (message.error) pending.reject(new AppError("cdp_error", 502, { code: typeof message.error.code === "number" ? message.error.code : 0 }));
      else pending.resolve(message.result && typeof message.result === "object" ? message.result as Record<string, unknown> : {});
      return;
    }
    if (typeof message.method === "string") {
      const event: CdpEvent = { method: message.method, params: message.params && typeof message.params === "object" ? message.params as Record<string, unknown> : {},
        ...(typeof message.sessionId === "string" ? { sessionId: message.sessionId } : {}) };
      for (const listener of [...this.#listeners]) { try { listener(event); } catch { /* Listeners are isolated. */ } }
    }
  }
}
