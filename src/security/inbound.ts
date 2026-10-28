import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Inbound guard shared by the owner's script surfaces (ADR 0035): the loopback API (`app.local_api/v1`, REL06) and
 * signed webhooks (`app.webhook_triggers/v1`, REL07). Each surface runs these checks before it reads a credential
 * or touches state:
 *
 * 1. {@link browserRequest}: a request carrying `Origin` or `Sec-Fetch-Site` came from a browser page → 403;
 * 2. {@link readCappedBody}: a declared or actual body over the cap → 413;
 * 3. {@link FixedWindowRate}: a request over the fixed-window rate → 429 with `Retry-After`;
 * 4. {@link constantTimeEqual}: credentials are compared in constant time.
 *
 * Every check is pure or in-memory: a rejected request changes no stored state.
 */

/** Finite operator limits of one inbound surface. */
export interface InboundLimits {
  /** Largest request body in bytes. */
  bodyBytes: number;
  /** Requests admitted per rate window and key. */
  requests: number;
  windowMs: number;
}

/** True when a browser sent the request: scripts and webhook senders send neither header. */
export function browserRequest(request: Request): boolean {
  return request.headers.has("origin") || request.headers.has("sec-fetch-site");
}

/**
 * Reads the body up to `bodyBytes`, or returns null when the declared length or the streamed body is larger.
 * A malformed `Content-Length` counts as too large. Reading stops at the first byte over the cap.
 */
export async function readCappedBody(request: Request, bodyBytes: number): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > bodyBytes)) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > bodyBytes) { await reader.cancel().catch(() => {}); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/** Outcome of one {@link FixedWindowRate.admit} call. */
export type RateDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Fixed-window request counter, one window per key (the loopback API uses one key; webhooks use the route id).
 * In-memory only: a restart starts new windows, and a refusal writes nothing.
 */
export class FixedWindowRate {
  #limits: Pick<InboundLimits, "requests" | "windowMs">;
  #now: () => number;
  #windows = new Map<string, { start: number; admitted: number }>();

  constructor(limits: Pick<InboundLimits, "requests" | "windowMs">, now: () => number = Date.now) {
    this.#limits = limits; this.#now = now;
  }

  /** Counts one request for `key`, or refuses it with the seconds until the window ends. */
  admit(key = ""): RateDecision {
    const at = this.#now();
    let window = this.#windows.get(key);
    if (!window || at - window.start >= this.#limits.windowMs) {
      // Bound memory: drop windows that already ended before opening a new one.
      if (this.#windows.size >= 1024) for (const [k, w] of this.#windows) if (at - w.start >= this.#limits.windowMs) this.#windows.delete(k);
      window = { start: at, admitted: 0 };
      this.#windows.set(key, window);
    }
    if (window.admitted >= this.#limits.requests) {
      return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((window.start + this.#limits.windowMs - at) / 1000)) };
    }
    window.admitted++;
    return { ok: true };
  }
}

/** Constant-time comparison of two values of any length: both sides are hashed to equal-length digests first. */
export function constantTimeEqual(expected: string | Uint8Array, supplied: string | Uint8Array): boolean {
  const a = createHash("sha256").update(expected).digest(), b = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(a, b);
}
