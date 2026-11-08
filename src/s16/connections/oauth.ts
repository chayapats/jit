import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../../errors";
import type { SourceNetwork } from "./net";

/**
 * MCP16-01 OAuth for MCP servers (MCP authorization, spec revision 2025-06-18): RFC 9728 protected-resource metadata,
 * RFC 8414 / OpenID authorization-server metadata, RFC 7591 dynamic client registration and an authorization-code grant
 * with PKCE S256, a single-use random `state` and the RFC 8707 `resource` indicator. Every metadata, registration and
 * token request goes through the protected source network (public addresses only, no redirects). Only the owner's own
 * browser visits the authorization page. Codes, verifiers and tokens never enter a record, a prompt or a log.
 */
export interface OAuthServer { issuer: string; authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string | null; resource: string; scope: string | null }
export interface OAuthClient { clientId: string; clientSecret: string | null }
export interface OAuthTokens { accessToken: string; refreshToken: string | null; expiresAt: number | null; scope: string | null }

const random = () => randomBytes(32).toString("base64url");
/** Fresh 43-character state and PKCE verifier. */
export const oauthSecrets = (): { state: string; verifier: string } => ({ state: random(), verifier: random() });
export const pkceChallenge = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");

async function json(network: SourceNetwork, url: string, init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string }): Promise<{ status: number; value: unknown }> {
  const response = await network.request(url, { method: init.method, headers: { Accept: "application/json", ...(init.headers ?? {}) }, ...(init.body !== undefined ? { body: init.body } : {}), timeoutMs: 20_000, maxBytes: 262_144 });
  let value: unknown = null; try { value = JSON.parse(response.text); } catch { value = null; }
  return { status: response.status, value };
}
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const trim = (value: string) => value.replace(/\/+$/, "");

/** Discover the authorization server of an MCP endpoint. `metadataUrl` is the 401 challenge's `resource_metadata`. */
export async function discoverOAuth(network: SourceNetwork, endpoint: string, metadataUrl: string | null): Promise<OAuthServer> {
  const target = new URL(network.validate(endpoint));
  const candidates = metadataUrl ? [network.validate(metadataUrl)] : [...(target.pathname !== "/" ? [`${target.origin}/.well-known/oauth-protected-resource${trim(target.pathname)}`] : []), `${target.origin}/.well-known/oauth-protected-resource`];
  let resource = target.origin + trim(target.pathname), issuer: string | null = null, scope: string | null = null;
  for (const url of candidates) {
    let found: { status: number; value: unknown };
    try { found = await json(network, url, { method: "GET" }); } catch (error) { if (error instanceof AppError && error.code === "source_address_not_public") throw error; continue; }
    const value = record(found.value);
    if (found.status !== 200 || !value) continue;
    const servers = Array.isArray(value.authorization_servers) ? value.authorization_servers.filter((s): s is string => typeof s === "string") : [];
    if (typeof value.resource !== "string" || !servers.length) throw new AppError("source_oauth_metadata_invalid", 502);
    // The metadata must describe this endpoint's own origin, so another resource's tokens are never requested here.
    let declared: URL; try { declared = new URL(value.resource); } catch { throw new AppError("source_oauth_metadata_invalid", 502); }
    if (declared.origin !== target.origin) throw new AppError("source_oauth_metadata_invalid", 502);
    resource = trim(declared.href); issuer = network.validate(servers[0]!);
    if (Array.isArray(value.scopes_supported)) { const scopes = value.scopes_supported.filter((s): s is string => typeof s === "string" && /^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(s)).slice(0, 32); scope = scopes.length ? scopes.join(" ") : null; }
    break;
  }
  // Servers of the earlier revision publish authorization metadata at the endpoint's own origin.
  const base = new URL(issuer ?? target.origin);
  const path = trim(base.pathname);
  const metadata = path ? [`${base.origin}/.well-known/oauth-authorization-server${path}`, `${base.origin}/.well-known/openid-configuration${path}`, `${base.origin}${path}/.well-known/openid-configuration`] : [`${base.origin}/.well-known/oauth-authorization-server`, `${base.origin}/.well-known/openid-configuration`];
  for (const url of metadata) {
    let found: { status: number; value: unknown };
    try { found = await json(network, url, { method: "GET" }); } catch (error) { if (error instanceof AppError && error.code === "source_address_not_public") throw error; continue; }
    const value = record(found.value); if (found.status !== 200 || !value) continue;
    if (typeof value.issuer !== "string" || trim(value.issuer) !== trim(base.href)) throw new AppError("source_oauth_metadata_invalid", 502);
    if (typeof value.authorization_endpoint !== "string" || typeof value.token_endpoint !== "string") throw new AppError("source_oauth_metadata_invalid", 502);
    const methods = Array.isArray(value.code_challenge_methods_supported) ? value.code_challenge_methods_supported : [];
    if (!methods.includes("S256")) throw new AppError("source_oauth_pkce_unsupported", 502);
    return { issuer: trim(base.href), authorizationEndpoint: network.validate(value.authorization_endpoint), tokenEndpoint: network.validate(value.token_endpoint),
      registrationEndpoint: typeof value.registration_endpoint === "string" ? network.validate(value.registration_endpoint) : null, resource, scope };
  }
  throw new AppError("source_oauth_unavailable", 502);
}

/** RFC 7591 public-client registration for this installation's exact redirect URI. */
export async function registerOAuthClient(network: SourceNetwork, server: OAuthServer, redirectUri: string): Promise<OAuthClient> {
  if (!server.registrationEndpoint) throw new AppError("source_oauth_registration_unavailable", 502);
  const found = await json(network, server.registrationEndpoint, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_name: "Jit", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", ...(server.scope ? { scope: server.scope } : {}) }) });
  const value = record(found.value);
  if (found.status < 200 || found.status >= 300 || !value || typeof value.client_id !== "string" || !/^[\x21-\x7e]{1,512}$/.test(value.client_id)) throw new AppError("source_oauth_registration_failed", 502);
  const secret = typeof value.client_secret === "string" && /^[\x21-\x7e]{1,2048}$/.test(value.client_secret) ? value.client_secret : null;
  return { clientId: value.client_id, clientSecret: secret };
}

/** The exact authorization URL the owner's browser opens. */
export function authorizationUrl(server: OAuthServer, client: OAuthClient, redirectUri: string, state: string, verifier: string): string {
  const url = new URL(server.authorizationEndpoint);
  for (const [key, value] of Object.entries({ response_type: "code", client_id: client.clientId, redirect_uri: redirectUri, state, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256", resource: server.resource, ...(server.scope ? { scope: server.scope } : {}) })) url.searchParams.set(key, value);
  return url.href;
}

function tokens(found: { status: number; value: unknown }, now: number, previousRefresh: string | null): OAuthTokens {
  const value = record(found.value);
  if (found.status === 400 || found.status === 401) throw new AppError("source_login_required", 401);
  if (found.status !== 200 || !value || typeof value.access_token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(value.access_token)) throw new AppError("source_oauth_token_invalid", 502);
  if (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer") throw new AppError("source_oauth_token_invalid", 502);
  const refresh = typeof value.refresh_token === "string" && /^[\x21-\x7e]{1,8192}$/.test(value.refresh_token) ? value.refresh_token : previousRefresh;
  const expires = typeof value.expires_in === "number" && Number.isFinite(value.expires_in) && value.expires_in > 0 ? now + Math.min(value.expires_in, 31_536_000) * 1000 : null;
  return { accessToken: value.access_token, refreshToken: refresh, expiresAt: expires, scope: typeof value.scope === "string" ? value.scope.slice(0, 1024) : null };
}
const form = (values: Record<string, string>) => new URLSearchParams(values).toString();

/** Exchange the one received code (authorization-code grant with the PKCE verifier and resource indicator). */
export async function exchangeOAuthCode(network: SourceNetwork, server: OAuthServer, client: OAuthClient, input: { code: string; verifier: string; redirectUri: string; now: number }): Promise<OAuthTokens> {
  if (!/^[\x21-\x7e]{1,2048}$/.test(input.code)) throw new AppError("source_oauth_stale", 409);
  return tokens(await json(network, server.tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "authorization_code", code: input.code, redirect_uri: input.redirectUri, client_id: client.clientId, code_verifier: input.verifier, resource: server.resource, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}) }) }), input.now, null);
}

/** Refresh an expiring access token; a refused refresh means the owner signs in again. */
export async function refreshOAuthTokens(network: SourceNetwork, server: OAuthServer, client: OAuthClient, refreshToken: string, now: number): Promise<OAuthTokens> {
  return tokens(await json(network, server.tokenEndpoint, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.clientId, resource: server.resource, ...(client.clientSecret ? { client_secret: client.clientSecret } : {}) }) }), now, refreshToken);
}

