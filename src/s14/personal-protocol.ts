import { AppError } from "../errors";
import { redactCredentials } from "../security/credentials";
import type { PersonalClientSecret, PersonalScope, PersonalTokens } from "./personal-types";
import { registerSecretFingerprint } from "../security/secret-fingerprints";

/** Fixed-endpoint injectable Google transport; production refuses redirects and never logs request or response bodies. */
export type GoogleTransport = (url: string, init: RequestInit) => Promise<Response>;
/** Deadline seam for fake-clock deterministic protocol tests. */
export type PersonalTimer = (callback: () => void, ms: number) => () => void;
/** Safe protocol status, independent of provider-controlled error text. */
export class GoogleFailure extends AppError {
  constructor(readonly providerStatus: number, code = "google_request_failed") { super(code, 502); }
}
/** Maps an explicitly selected short scope to its pinned Google permission URI. */
export function googleScope(scope: PersonalScope): string { return `https://www.googleapis.com/auth/${scope}`; }
/** Validates JSON object shape without interpreting remote data as instructions or executable configuration. */
export function googleObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GoogleFailure(0, "google_schema_changed");
  return value as Record<string, unknown>;
}
/** Bounds and redacts untrusted provider strings without treating them as owner-authored commands. */
export function googleText(value: unknown, max = 8192): string {
  if (typeof value !== "string" || !value.isWellFormed()) return "";
  return redactCredentials(value.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")).slice(0, max);
}
/** Fixed Google protocol surface, pinned in protocol/google-personal.json; it performs no implicit retries. */
export class GooglePersonal {
  constructor(readonly transport: GoogleTransport = (url, init) => fetch(url, init), readonly timer: PersonalTimer = (fn, ms) => {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  }) {}

  /** Performs one bounded request, retaining transport ownership through timeout and rechecking authority before dispatch. */
  async request(url: string, init: RequestInit, allowed: () => void, signal?: AbortSignal): Promise<unknown> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["oauth2.googleapis.com", "gmail.googleapis.com", "www.googleapis.com"].includes(parsed.hostname) || parsed.username || parsed.password || parsed.hash) throw new GoogleFailure(0, "google_endpoint_refused");
    const abort = new AbortController();
    const cancel = () => abort.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) abort.abort();
    const clear = this.timer(cancel, 15000);
    try {
      allowed();
      if (abort.signal.aborted) throw new GoogleFailure(0, "google_deadline");
      const response = await this.transport(url, { ...init, redirect: "error", signal: abort.signal });
      if (abort.signal.aborted) throw new GoogleFailure(0, "google_deadline");
      if (!response.ok) {
        await response.body?.cancel();
        throw new GoogleFailure(response.status);
      }
      if (response.status === 204 || parsed.pathname === "/revoke") { await response.body?.cancel(); return {}; }
      const reader = response.body?.getReader();
      if (!reader) throw new GoogleFailure(0, "google_schema_changed");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 262144) { await reader.cancel(); throw new GoogleFailure(0, "google_oversize"); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      if (abort.signal.aborted) throw new GoogleFailure(0, "google_deadline");
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
      if (error instanceof GoogleFailure) throw error;
      throw new GoogleFailure(0, "google_transport_uncertain");
    } finally { clear(); signal?.removeEventListener("abort", cancel); }
  }

  /** Exchanges or refreshes tokens with exact requested consent and finite expiry, never widening a connection. */
  async tokens(client: PersonalClientSecret, scopes: PersonalScope[], fields: Record<string, string>, now: number, allowed: () => void, previous?: PersonalTokens): Promise<PersonalTokens> {
    const data = googleObject(await this.request("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, ...fields }).toString(),
    }, allowed));
    if (typeof data.access_token !== "string" || !data.access_token || data.token_type !== "Bearer" || !Number.isSafeInteger(data.expires_in) || (data.expires_in as number) < 1 || (data.expires_in as number) > 86400) throw new GoogleFailure(0, "google_schema_changed");
    const consent = typeof data.scope === "string" ? data.scope.split(" ") : previous?.scopes.map(googleScope);
    if (!consent || consent.length !== scopes.length || !scopes.every(s => consent.includes(googleScope(s)))) throw new GoogleFailure(0, "google_consent_mismatch");
    const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : previous?.refreshToken;
    if (!refreshToken || data.access_token.length > 2048 || refreshToken.length > 2048 || /[\s\u0000-\u001f]/.test(data.access_token + refreshToken)) throw new GoogleFailure(0, "google_schema_changed");
    registerSecretFingerprint(data.access_token);
    registerSecretFingerprint(refreshToken);
    return { accessToken: data.access_token, refreshToken, expiresAt: now + (data.expires_in as number) * 1000, scopes: [...scopes] };
  }
}
