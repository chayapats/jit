/** Platform SecureStore adapter. Implementations must refuse plaintext fallback and exclude device credentials from backup. */
export interface MobileSecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
/** Streaming native Fetch response, including clone/blob support; the legacy RN global Response is insufficient. */
export type MobileFetchResponse = Response;
/** Actual Expo/native fetch injection. Tests supply protocol or owning-service fixtures explicitly. */
export type MobileFetch = (url: string, init: RequestInit) => Promise<MobileFetchResponse>;
/** Safe diagnostics never contain a password, cookie, private response, native path or underlying error message. */
export class MobileClientError extends Error {
  constructor(readonly code: "mobile_origin_invalid" | "mobile_inactive" | "mobile_session_missing" | "mobile_session_invalid" | "mobile_storage_unavailable" | "mobile_response_invalid" | "mobile_response_limit" | "mobile_request_failed" | "mobile_login_failed" | "mobile_response_stale") { super(code); this.name = "MobileClientError"; }
}
/** Native transport bounds; the complete response includes the body, not just its headers. */
export const mobileTransportLimits = Object.freeze({ responseBytes: 128 * 1024 * 1024, responseMs: 15 * 60 * 1000, loginBytes: 64 * 1024, loginMs: 30000, sessionMs: 86400000 });
const fail = (code: MobileClientError["code"]): never => { throw new MobileClientError(code); };
const token = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{16,4096}$/.test(value);
const storageOperations = new Map<string, Promise<void>>();
async function serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const next = (storageOperations.get(key) ?? Promise.resolve()).catch(() => {}).then(operation), settled = next.then(() => {}, () => {});
  storageOperations.set(key, settled);
  try { return await next; } finally { if (storageOperations.get(key) === settled) storageOperations.delete(key); }
}

/** Canonical complete origin only. HTTP is limited to literal loopback; no service selection can carry authority. */
export function mobileOrigin(value: string): string {
  try {
    if (!value || value.length > 2048 || value.trim() !== value) return fail("mobile_origin_invalid");
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) return fail("mobile_origin_invalid");
    if (value !== url.origin && value !== url.origin + "/") return fail("mobile_origin_invalid");
    return url.origin;
  } catch { return fail("mobile_origin_invalid"); }
}
/** Non-credential service identity used for SecureStore keys and already-configured notice targets. */
export async function mobileServiceId(origin: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(mobileOrigin(origin)));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Cookie-only native session over the existing protected service. Only this adapter sees the credential;
 * JitClient retains ephemeral CSRF. Every request has exact-origin, zero-follow/retry, complete-body and generation guards.
 */
export class MobileTransport {
  readonly origin: string;
  readonly service: Promise<string>;
  readonly #key: Promise<string>;
  readonly #store: MobileSecureStore;
  readonly #fetch: MobileFetch;
  readonly #now: () => number;
  #credential: { token: string; expiresAt: number } | null = null;
  #active = true;
  #generation = 0;
  #stop = new AbortController();
  constructor(options: { origin: string; store: MobileSecureStore; fetch: MobileFetch; now?: () => number }) {
    this.origin = mobileOrigin(options.origin); this.service = mobileServiceId(this.origin); this.#key = this.service.then(id => "jit.mobile.session.v1." + id);
    this.#store = options.store; this.#fetch = options.fetch; this.#now = options.now ?? Date.now;
  }
  /** Availability only; the actual service must still authenticate every restored session. */
  get authenticated(): boolean { return !!this.#credential && this.#credential.expiresAt > this.#now(); }
  #advance(): number { this.#stop.abort(); this.#stop = new AbortController(); return ++this.#generation; }
  #current(generation: number): void { if (generation !== this.#generation) fail("mobile_response_stale"); if (!this.#active) fail("mobile_inactive"); }
  /** Abort the complete native response/capture boundary before private renderer state is discarded. */
  pause(): void { this.#active = false; this.#advance(); }
  /** Open a new request generation; this alone never restores a private view or authenticates a session. */
  resume(): void { this.#advance(); this.#active = true; }
  async #storage<T>(operation: (key: string) => Promise<T>): Promise<T> {
    const key = await this.#key;
    try { return await serialize(key, () => operation(key)); } catch (error) { if (error instanceof MobileClientError) throw error; return fail("mobile_storage_unavailable"); }
  }
  /** Restore only the bounded device credential. The caller must bootstrap before rendering private data. */
  async restore(): Promise<boolean> {
    const generation = this.#generation; this.#current(generation); this.#credential = null;
    return this.#storage(async key => {
      this.#current(generation); const text = await this.#store.get(key); this.#current(generation);
      if (text === null) { this.#credential = null; return false; }
      let record: unknown;
      try { if (text.length > 8192) return fail("mobile_session_invalid"); record = JSON.parse(text); } catch { return fail("mobile_session_invalid"); }
      if (!record || typeof record !== "object" || Array.isArray(record)) return fail("mobile_session_invalid");
      const data = record as Record<string, unknown>;
      if (Object.keys(data).length !== 4 || data.contract !== "s16-mobile-session/v1" || data.service !== await this.service || !token(data.token) || !Number.isSafeInteger(data.expiresAt) || Number(data.expiresAt) > this.#now() + mobileTransportLimits.sessionMs) return fail("mobile_session_invalid");
      this.#current(generation);
      if (Number(data.expiresAt) <= this.#now()) { await this.#store.delete(key); this.#current(generation); this.#credential = null; return false; }
      this.#credential = { token: data.token, expiresAt: Number(data.expiresAt) }; return true;
    });
  }
  /** Local sign-out only: delete this origin's device credential and abort old responses; no server/account change. */
  async forget(): Promise<void> {
    const generation = this.#advance(); this.#credential = null;
    await this.#storage(async key => { if (generation === this.#generation) await this.#store.delete(key); });
  }
  #cookieName(): string { return this.origin.startsWith("https:") ? "__Host-jit_s14" : "jit_s14"; }
  /** One explicit password login through the existing owning ingress; no redirect, stored password or automatic retry. */
  async signIn(password: string): Promise<void> {
    this.#current(this.#generation);
    if (!password || password.length > 1024) return fail("mobile_login_failed");
    const generation = this.#advance(), url = this.origin + "/s14/login";
    const response = await this.#network(url, { method: "POST", headers: { "Content-Type": "application/json", Origin: this.origin, "Cache-Control": "no-store", Pragma: "no-cache" }, body: JSON.stringify({ password }), redirect: "manual" }, generation, mobileTransportLimits.loginMs, mobileTransportLimits.loginBytes);
    this.#current(generation);
    if (response.status !== 303 || response.headers.get("location") !== "/") return fail("mobile_login_failed");
    const parts = (response.headers.get("set-cookie") ?? "").split(";").map(part => part.trim()), first = parts.shift() ?? "", prefix = this.#cookieName() + "=", value = first.startsWith(prefix) ? first.slice(prefix.length) : "";
    const attrs = new Map<string, string>();
    for (const part of parts) { const at = part.indexOf("="), name = (at < 0 ? part : part.slice(0, at)).toLowerCase(), content = at < 0 ? "" : part.slice(at + 1); if (attrs.has(name)) return fail("mobile_login_failed"); attrs.set(name, content); }
    const secure = this.origin.startsWith("https:"), allowed = secure ? ["httponly", "samesite", "path", "max-age", "secure"] : ["httponly", "samesite", "path", "max-age"];
    const age = attrs.get("max-age") ?? "";
    if (!token(value) || attrs.size !== allowed.length || allowed.some(name => !attrs.has(name)) || attrs.get("httponly") !== "" || attrs.get("secure") !== (secure ? "" : undefined) || attrs.get("samesite")?.toLowerCase() !== "strict" || attrs.get("path") !== "/" || !/^[1-9][0-9]{0,4}$/.test(age) || Number(age) > 86400) return fail("mobile_login_failed");
    const credential = { token: value, expiresAt: this.#now() + Number(age) * 1000 };
    await this.#storage(async key => {
      this.#current(generation); const previous = await this.#store.get(key); this.#current(generation);
      await this.#store.set(key, JSON.stringify({ contract: "s16-mobile-session/v1", service: await this.service, ...credential }));
      if (generation !== this.#generation || !this.#active) { if (previous === null) await this.#store.delete(key); else await this.#store.set(key, previous); this.#current(generation); }
      this.#credential = credential;
    });
  }
  /** JitClient fetch injection. Renderer/file/deep-link input cannot broaden the authenticated destination. */
  async fetch(request: Request): Promise<Response> {
    return this.#authenticatedFetch(request);
  }
  /** Same boundary for immutable binary uploads without RN's incompatible Request/Blob ArrayBuffer constructor. */
  async fetchBytes(request: Request, bytes: Uint8Array<ArrayBuffer>): Promise<Response> {
    if (request.method !== "POST" || bytes.byteLength > mobileTransportLimits.responseBytes) return fail("mobile_response_limit");
    return this.#authenticatedFetch(request, new Uint8Array(bytes));
  }
  async #authenticatedFetch(request: Request, nativeBytes?: Uint8Array<ArrayBuffer>): Promise<Response> {
    const generation = this.#generation; this.#current(generation);
    const url = new URL(request.url);
    if (url.origin !== this.origin || url.username || url.password || url.hash || !(url.pathname === "/api/s16/client" || url.pathname.startsWith("/api/s16/client/")) || !["GET", "POST"].includes(request.method)) return fail("mobile_origin_invalid");
    if (!this.authenticated) { this.#credential = null; return fail("mobile_session_missing"); }
    const headers = new Headers(request.headers); headers.delete("authorization"); headers.set("Cookie", this.#cookieName() + "=" + this.#credential!.token); headers.set("Origin", this.origin); headers.set("Cache-Control", "no-store"); headers.set("Pragma", "no-cache");
    const body = request.method === "POST" ? nativeBytes?.buffer ?? await request.arrayBuffer() : undefined; this.#current(generation);
    const response = await this.#network(url.href, { method: request.method, headers, ...(body !== undefined ? { body } : {}), signal: request.signal, redirect: "error" }, generation, mobileTransportLimits.responseMs, mobileTransportLimits.responseBytes);
    if (response.status === 401 || response.status === 403) {
      await this.#storage(async key => { this.#current(generation); await this.#store.delete(key); this.#current(generation); this.#credential = null; });
    }
    return response;
  }
  async #network(url: string, init: RequestInit, generation: number, timeoutMs: number, maxBytes: number): Promise<Response> {
    this.#current(generation); const stop = new AbortController(), nativeStop = this.#stop.signal;
    let rejectInterrupted!: (error: MobileClientError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupted = reject; });
    const abort = () => { stop.abort(); rejectInterrupted(new MobileClientError("mobile_request_failed")); };
    if (init.signal?.aborted || nativeStop.aborted) return fail("mobile_request_failed");
    init.signal?.addEventListener("abort", abort, { once: true }); nativeStop.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeoutMs); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, rawResponse: MobileFetchResponse | undefined, finished = false, complete = false;
    try {
      const pending = this.#fetch(url, { ...init, credentials: "omit", signal: stop.signal });
      // A broken native transport may resolve after cancellation. Dispose it without allowing a late private read.
      void pending.then(response => { if (finished) void response.body?.cancel().catch(() => {}); }, () => {});
      const response = rawResponse = await Promise.race([pending, interrupted]); this.#current(generation);
      if (stop.signal.aborted) return fail("mobile_request_failed");
      if (response.redirected || response.url !== url || response.status < 200 || response.status > 599 || init.redirect !== "manual" && response.status >= 300 && response.status < 400) return fail("mobile_response_invalid");
      const length = response.headers.get("content-length");
      if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > maxBytes)) return fail("mobile_response_limit");
      // Expo Fetch supplies the stream-aware Response. RN's global Response constructor has no streaming body
      // and its Blob constructor rejects ArrayBuffer input. Validate a clone, then retain the real native response.
      reader = response.clone().body?.getReader(); let bytes = 0;
      while (reader) {
        const part = await Promise.race([reader.read(), interrupted]); this.#current(generation); if (stop.signal.aborted) return fail("mobile_request_failed"); if (part.done) break;
        bytes += part.value.byteLength; if (bytes > maxBytes) return fail("mobile_response_limit");
      }
      complete = true; return response;
    } catch (error) { if (error instanceof MobileClientError) throw error; this.#current(generation); return fail("mobile_request_failed"); }
    finally { finished = true; clearTimeout(timer); init.signal?.removeEventListener("abort", abort); nativeStop.removeEventListener("abort", abort); if (!complete) { stop.abort(); void rawResponse?.body?.cancel().catch(() => {}); } void reader?.cancel().catch(() => {}); }
  }
}
