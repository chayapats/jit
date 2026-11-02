import { registerSecretFingerprint } from "../../security/secret-fingerprints";
import type { AdapterResult } from "../policy";
import type { GithubEffect, GithubEffectResult, GithubRepository, GithubSnapshot, ProtectedGithubGateway } from "./types";
import { canonical, fail, integer } from "./validation";

/**
 * Fixed protected gateway transport, never a VM tool or GitHub-token forwarding proxy. Credentials
 * authenticate only this protected service to its preconfigured gateway. No redirects/retries; bounded
 * responses and safe errors. The gateway must enforce the operation-specific protected contract,
 * including strict GitHub protection and exact merge sha. A stock GitHub REST origin is not a gateway.
 */
export class HttpProtectedGithubGateway implements ProtectedGithubGateway {
  private readonly url: string;
  constructor(private readonly options: { origin: string; credential(): string; fetch?: typeof fetch; timeoutMs: number; maxResponseBytes: number; allowLoopbackFixture?: boolean }) {
    const u = new URL(options.origin); integer(options.timeoutMs, 1); integer(options.maxResponseBytes, 1);
    if (u.origin !== options.origin || u.username || u.password || u.hostname === "api.github.com" || u.protocol !== "https:" && !(options.allowLoopbackFixture && u.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(u.hostname))) fail("github_gateway_invalid");
    this.url = u.origin;
  }
  private async request<T>(path: "snapshot" | "mutate" | "reconcile", body: unknown): Promise<T> {
    const credential = this.options.credential(); if (!credential || /[\r\n]/.test(credential)) fail("github_credential_unavailable"); registerSecretFingerprint(credential);
    try {
      const response = await (this.options.fetch ?? fetch)(`${this.url}/v1/github/${path}`, { method: "POST", redirect: "error", signal: AbortSignal.timeout(this.options.timeoutMs), headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential}` }, body: canonical(body) });
      if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "application/json") fail("github_gateway_unavailable");
      const reader = response.body?.getReader(); if (!reader) fail("github_protocol_invalid");
      const chunks: Uint8Array[] = []; let bytes = 0;
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > this.options.maxResponseBytes) { await reader.cancel(); fail("github_response_too_large"); } chunks.push(chunk.value); } }
      finally { reader.releaseLock(); }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as T;
    } catch { fail("github_gateway_unavailable"); }
  }
  /** Protected read only, charged/guarded by the caller before reaching this transport. */
  snapshot(repository: GithubRepository, pull: number | null): Promise<GithubSnapshot> { return this.request("snapshot", { repository, pull }); }
  /** One exact CAS operation. Transport exceptions are unknown to the POLICY adapter, never retryable. */
  mutate(effect: GithubEffect, dispatch: (send: () => Promise<GithubEffectResult>) => Promise<AdapterResult>): Promise<AdapterResult> { return dispatch(() => this.request("mutate", effect)); }
  /** Read-only lookup by immutable effect identity; never resends an unknown mutation. */
  reconcile(effect: GithubEffect): Promise<GithubEffectResult> { return this.request("reconcile", effect); }
}
