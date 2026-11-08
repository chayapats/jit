import { createHash } from "node:crypto";
import { AppError } from "../../errors";
import type { ConnectionVault } from "../../exec/connections";
import { s15CredentialKey } from "../../s15/credentials";
import { canonical, content, exact, identity, integer } from "../../s15/conversation/validation";
import { digest } from "../../s15/policy/validation";
import type { Ref } from "../../s15/policy";
import { ProtectedDataStore } from "../../s15/team/store";
import { registerSecretFingerprint } from "../../security/secret-fingerprints";
import { containsCredential } from "../../security/credentials";
import { buildCatalog, mcpCandidates, reviewDecisions } from "./catalog";
import { importGraphql } from "./graphql";
import { McpHttpSession, SourceAuthRequired } from "./mcp";
import type { SourceNetwork } from "./net";
import { authorizationUrl, discoverOAuth, exchangeOAuthCode, oauthSecrets, refreshOAuthTokens, registerOAuthClient, type OAuthClient, type OAuthServer } from "./oauth";
import { importOpenApi } from "./openapi";
import { connectionLimits, toolClasses, type ConnectionCommand, type ConnectionReceipt, type ConnectionRequestView, type ConnectionsView, type GithubAppView, type SourceAuthInput, type SourceCatalog, type SourceRecord, type SourceView } from "./types";

/** CONNECTIONS schema v1: sources, OAuth flows, chat connection requests and command identities. */
const CONNECTIONS_SCHEMA_V1 = `
CREATE TABLE sources (id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
CREATE TABLE flows (id TEXT PRIMARY KEY, state_hash TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL);
CREATE TABLE requests (id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
CREATE TABLE commands (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL);
`;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const forbiddenHeaders = new Set(["host", "content-length", "content-type", "accept", "connection", "transfer-encoding", "cookie", "mcp-session-id", "mcp-protocol-version", "upgrade", "te", "trailer", "proxy-authorization", "idempotency-key"]);

interface FlowRecord { id: string; sourceId: string; sourceRevision: number; ownerGeneration: number; state: "pending" | "received" | "exchanging" | "complete" | "failed"; server: OAuthServer; clientId: string; expiresAt: number; createdAt: number }
interface FlowSecret { state: string; verifier: string; clientSecret: string | null; code?: string }
interface StoredToken { accessToken: string; refreshToken: string | null; expiresAt: number | null; clientId: string; clientSecret: string | null }

/** GitHub app port (GIT15-04 connection), adapted by composition. */
export interface GithubAppPort {
  view(): Omit<GithubAppView, "policy">;
  /** Resource IDs of the selected repositories. */
  resources(): string[];
  connect(requestId: string, token: string): Promise<void>;
  select(requestId: string, expectedRevision: number, names: string[]): void;
  remove(requestId: string, expectedRevision: number): void;
}
/** Protected composition. Every port is trusted host code; none is reachable from a model. */
export interface ConnectionDirectoryOptions<Owner> {
  path: string; installationId: string; create: boolean; now: () => number;
  vault: ConnectionVault; network: SourceNetwork;
  /** Exact OAuth redirect URI of this installation (`<origin>/s16/connections/oauth/callback`). */
  redirectUri: string;
  ownerGeneration(): number;
  /** Re-verify the owner (POLICY) before and after every awaited step. */
  requireOwner(owner: Owner): void;
  /**
   * Bring the standing rules and TEAM registration in line with the reviewed connections (ADR 0089). Returns
   * `installed` when a new revision was installed, `unchanged` when nothing differed and `review_required` when the
   * owner's rules differ from the product default in more than connection membership (the /rules page then decides).
   */
  membership(owner: Owner, requestId: string): "installed" | "unchanged" | "review_required";
  /** Whether the standing rules currently include a resource (for the `policy` field of views). */
  inPolicy(owner: Owner, resourceId: string): boolean;
  /** Bots and whether each may use a resource (team resource minus the Bot's exclusions). */
  bots(owner: Owner, resourceId: string): { id: string; name: string; allowed: boolean }[];
  github?: GithubAppPort;
  /** Ends every open MCP session of a source (revocation, reconnect). */
  closeSessions?(sourceId: string): Promise<void>;
}

/**
 * CONN16-01/MCP16-01/OPEN16-01 protected connection directory (`s16-connections/v1`, ADR 0089). It owns tool-source
 * records, their write-only credentials (vault), OAuth flows and the owner's reviews. A source joins the standing rules
 * and TEAM only through the owner's review of one exact catalog; a changed catalog keeps the source connected but makes
 * every tool unavailable until a new review. Removal makes the source's identities inactive at once.
 */
export class ConnectionDirectory<Owner> {
  readonly store: ProtectedDataStore;
  #queue: Promise<unknown> = Promise.resolve();
  constructor(readonly options: ConnectionDirectoryOptions<Owner>) {
    this.store = new ProtectedDataStore(options.path, options.installationId, options.create, 0x4a494337, CONNECTIONS_SCHEMA_V1);
    // A discovery interrupted by a stop leaves its source unavailable, never half-reviewed.
    for (const record of this.records()) {
      if (record.state === "removed") { try { options.vault.remove(this.#key(record.id)); } catch { /* Retried at the next boot. */ } continue; }
      if (record.code === "discovering") this.#save({ ...record, revision: record.revision + 1, state: "unavailable", code: "discovery_interrupted", updatedAt: options.now() });
      try { const secret = options.vault.read(this.#key(record.id)); registerSecretFingerprint(secret); if (record.auth.kind === "oauth") { const t = JSON.parse(secret) as StoredToken; registerSecretFingerprint(t.accessToken); if (t.refreshToken) registerSecretFingerprint(t.refreshToken); } } catch { /* No stored credential. */ }
    }
  }
  close(): void { this.store.close(); }

  records(): SourceRecord[] { return this.store.db.query<{ record_json: string }, []>("SELECT record_json FROM sources ORDER BY rowid").all().map(row => JSON.parse(row.record_json) as SourceRecord); }
  record(id: string): SourceRecord | null { const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM sources WHERE id=?").get(id); return row ? JSON.parse(row.record_json) as SourceRecord : null; }
  /** The source owning a resource, recipient, DATA15 source or catalog-fence identity. */
  byRef(id: string): SourceRecord | null { const m = /^src[rsc]?_([a-f0-9]{24})$/.exec(id); return m ? this.record(`src_${m[1]}`) : null; }
  #save(record: SourceRecord): void { this.store.db.query("INSERT INTO sources VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json").run(record.id, canonical(record)); }
  #key(sourceId: string) { return s15CredentialKey(this.options.installationId, `source_${sourceId}`); }
  #flowKey(flowId: string) { return s15CredentialKey(this.options.installationId, `source_flow_${flowId}`); }

  /** Sources in the standing rules: reviewed once and not removed. */
  reviewed(): SourceRecord[] { return this.records().filter(r => r.review !== null && r.state !== "removed"); }
  /** POLICY/TEAM/DATA15 catalog row for a source identity. Removed sources stay resolvable and inactive. */
  catalog(id: string): { ref: Ref; active: boolean } | null {
    const record = this.byRef(id); if (!record) return null;
    const live = record.state !== "removed" && record.review !== null;
    if (id === record.resource.id) return { ref: structuredClone(record.resource), active: live };
    if (id === record.recipient.id) return { ref: structuredClone(record.recipient), active: live };
    if (id === record.source.id) return { ref: structuredClone(record.source), active: true };
    if (id === `srcc_${record.id.slice(4)}`) return { ref: this.fence(record), active: live && record.state === "active" && record.review!.catalogHash === record.catalog?.hash };
    return null;
  }
  /** Catalog fence of the current review: an action prepared under it stops matching once the review or catalog changes. */
  fence(record: SourceRecord): Ref { return { id: `srcc_${record.id.slice(4)}`, revision: record.review?.revision ?? 0, generation: 1 }; }

  /**
   * Host-only auth headers for one request. Bearer/header secrets must match the fingerprint the record was verified
   * with; OAuth access tokens are refreshed shortly before expiry. Never for display.
   */
  async auth(record: SourceRecord): Promise<Record<string, string>> {
    if (record.auth.kind === "none") return {};
    let secret: string; try { secret = this.options.vault.read(this.#key(record.id)); } catch { throw new AppError("source_credential_unavailable", 409); }
    if (record.auth.kind !== "oauth") {
      registerSecretFingerprint(secret);
      if (sha256(secret) !== record.auth.fingerprint) throw new AppError("source_credential_unavailable", 409);
      return record.auth.kind === "bearer" ? { Authorization: `Bearer ${secret}` } : { [record.auth.header!]: secret };
    }
    let token = JSON.parse(secret) as StoredToken;
    if (token.expiresAt !== null && token.expiresAt - 60_000 <= this.options.now()) {
      if (!token.refreshToken || !record.auth.oauth) throw new AppError("source_login_required", 401);
      const server: OAuthServer = { issuer: record.auth.oauth.issuer, authorizationEndpoint: record.auth.oauth.authorizationEndpoint, tokenEndpoint: record.auth.oauth.tokenEndpoint, registrationEndpoint: null, resource: record.auth.oauth.resource, scope: record.auth.oauth.scope };
      const next = await refreshOAuthTokens(this.options.network, server, { clientId: token.clientId, clientSecret: token.clientSecret }, token.refreshToken, this.options.now());
      registerSecretFingerprint(next.accessToken); if (next.refreshToken) registerSecretFingerprint(next.refreshToken);
      token = { ...token, accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt };
      this.options.vault.write(this.#key(record.id), JSON.stringify(token));
    }
    registerSecretFingerprint(token.accessToken);
    return { Authorization: `Bearer ${token.accessToken}` };
  }

  /** Owner projection. */
  view(owner: Owner): ConnectionsView {
    this.options.requireOwner(owner);
    return { contract: "s16-client-connections/v1", github: this.options.github ? this.#github(owner) : null, sources: this.records().filter(r => r.state !== "removed").map(r => this.sourceView(owner, r)),
      requests: this.#requests().filter(r => r.state === "open").slice(-32), limits: connectionLimits, oauthRedirect: this.options.redirectUri };
  }
  #github(owner: Owner): GithubAppView {
    const port = this.options.github!, view = port.view(), resources = port.resources();
    return { ...view, policy: !resources.length ? "not_needed" : resources.every(id => this.options.inPolicy(owner, id)) ? "installed" : "review_required" };
  }
  sourceView(owner: Owner, record: SourceRecord): SourceView {
    const catalog = record.catalog, review = record.review, current = !!catalog && !!review && review.catalogHash === catalog.hash;
    return { id: record.id, revision: record.revision, kind: record.kind, label: record.label, endpoint: record.endpoint,
      auth: { kind: record.auth.kind, header: record.auth.header, issuer: record.auth.oauth?.issuer ?? null, expiresAt: record.auth.oauth?.expiresAt ?? null },
      state: record.state, code: record.code, catalogHash: catalog?.hash ?? null, reviewedHash: review?.catalogHash ?? null, changed: !!review && !!catalog && !current,
      tools: (catalog?.tools ?? []).map(t => ({ name: t.name, title: t.title, description: t.description, hint: t.hint, suggested: t.suggested, allowed: [...t.allowed], decision: current ? review!.decisions[t.name] ?? null : null,
        request: t.binding.kind === "openapi" ? `${t.binding.method} ${t.binding.path}` : t.binding.kind === "graphql" ? `${t.binding.operation} ${t.binding.operationName}` : null })),
      skipped: catalog?.skipped ?? [], truncated: catalog?.truncated ?? false, server: catalog?.server ?? null,
      bots: review ? this.options.bots(owner, record.resource.id) : [],
      policy: !review ? "not_needed" : this.options.inPolicy(owner, record.resource.id) ? "installed" : "review_required",
      verifiedAt: record.verifiedAt, createdAt: record.createdAt, updatedAt: record.updatedAt };
  }

  #requests(): ConnectionRequestView[] { return this.store.db.query<{ record_json: string }, []>("SELECT record_json FROM requests ORDER BY rowid").all().map(row => JSON.parse(row.record_json) as ConnectionRequestView); }
  /**
   * A Bot's suggestion from chat (`propose_connection`). It is inert data the owner sees as a card: it carries no secret,
   * creates nothing and pressing it only opens the owner's protected form, prefilled with the suggested endpoint.
   */
  proposeFromChat(input: { conversationId: string; requestId: string; kind: unknown; endpoint: unknown; label: unknown }): ConnectionRequestView {
    identity(input.conversationId); identity(input.requestId);
    if (typeof input.kind !== "string" || !["github", "mcp", "openapi", "graphql"].includes(input.kind)) throw new AppError("invalid_connection_request");
    let endpoint: string | null = null;
    if (input.endpoint !== null && input.endpoint !== undefined && input.endpoint !== "") {
      if (typeof input.endpoint !== "string" || containsCredential(input.endpoint)) throw new AppError("credential_content_refused", 403);
      const url = new URL(this.options.network.validate(input.endpoint));
      // A suggested URL never carries a query: tokens and keys do not travel through a chat card.
      if (url.search) throw new AppError("source_endpoint_invalid");
      endpoint = url.href;
    }
    if (input.kind === "github" && endpoint) throw new AppError("invalid_connection_request");
    let label: string | null = null;
    if (typeof input.label === "string" && input.label.trim()) { content(input.label, 240); label = [...input.label.trim()].slice(0, 60).join(""); }
    const id = `cr_${digest("s16.connection.request.v1", { requestId: input.requestId, kind: input.kind, endpoint }).slice(0, 24)}`;
    const existing = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM requests WHERE id=?").get(id);
    if (existing) return JSON.parse(existing.record_json) as ConnectionRequestView;
    if (this.#requests().filter(r => r.state === "open").length >= 64) throw new AppError("connection_request_capacity", 409);
    const view: ConnectionRequestView = { id, conversationId: input.conversationId, requestId: input.requestId, kind: input.kind as ConnectionRequestView["kind"], endpoint, label, createdAt: this.options.now(), state: "open", sourceId: null };
    this.store.db.query("INSERT INTO requests VALUES (?,?)").run(id, canonical(view));
    return view;
  }
  /** Chat cards of one request, for the conversation view. */
  requestsFor(requestId: string): ConnectionRequestView[] { return this.#requests().filter(r => r.requestId === requestId); }

  /** One exact owner command. Network commands are serialized; a retry with the same request ID returns its receipt. */
  command(owner: Owner, input: unknown): Promise<ConnectionReceipt> {
    const run = this.#queue.then(() => this.#command(owner, input), () => this.#command(owner, input));
    this.#queue = run.catch(() => undefined); return run;
  }

  #parse(input: unknown): { command: ConnectionCommand; hash: string } {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError("invalid_connection_command");
    const value = input as Record<string, unknown>;
    if (value.contract !== "s16-connection-command/v1") throw new AppError("invalid_connection_command");
    identity(value.requestId);
    const common = ["contract", "requestId", "kind"];
    // Secrets never enter the receipt identity in clear: the hash binds their fingerprint.
    const scrub = (auth: unknown) => { const a = auth as Record<string, unknown> | null; return a && typeof a.secret === "string" ? { ...a, secret: sha256(a.secret) } : a; };
    switch (value.kind) {
      case "source.add": exact(value, [...common, "sourceKind", "label", "endpoint", "auth", "document", "origin"]); return { command: value as unknown as ConnectionCommand, hash: digest("s16.connection.command.v1", { ...value, auth: scrub(value.auth), document: typeof value.document === "string" ? sha256(value.document) : value.document }) };
      case "source.review": exact(value, [...common, "sourceId", "expectedRevision", "catalogHash", "decisions"]); break;
      case "source.refresh": case "source.remove": case "source.oauth_begin": case "source.oauth_complete": exact(value, [...common, "sourceId", "expectedRevision"]); break;
      case "source.reconnect": exact(value, [...common, "sourceId", "expectedRevision", "auth"]); return { command: value as unknown as ConnectionCommand, hash: digest("s16.connection.command.v1", { ...value, auth: scrub(value.auth) }) };
      case "source.document": exact(value, [...common, "sourceId", "expectedRevision", "document"]); return { command: value as unknown as ConnectionCommand, hash: digest("s16.connection.command.v1", { ...value, document: typeof value.document === "string" ? sha256(value.document) : null }) };
      case "github.connect": exact(value, [...common, "token"]); return { command: value as unknown as ConnectionCommand, hash: digest("s16.connection.command.v1", { ...value, token: typeof value.token === "string" ? sha256(value.token.trim()) : null }) };
      case "github.select": exact(value, [...common, "expectedRevision", "names"]); break;
      case "github.remove": exact(value, [...common, "expectedRevision"]); break;
      case "request.dismiss": exact(value, [...common, "connectionRequestId"]); break;
      default: throw new AppError("invalid_connection_command");
    }
    return { command: value as unknown as ConnectionCommand, hash: digest("s16.connection.command.v1", value) };
  }
  #prior(requestId: string, hash: string): ConnectionReceipt | null {
    const row = this.store.db.query<{ payload_hash: string; result_json: string }, [string]>("SELECT payload_hash, result_json FROM commands WHERE id=?").get(requestId);
    if (!row) return null; if (row.payload_hash !== hash) throw new AppError("request_id_conflict", 409);
    return JSON.parse(row.result_json) as ConnectionReceipt;
  }
  #done(owner: Owner, command: ConnectionCommand, hash: string, source: SourceRecord | null, extra: Partial<Pick<ConnectionReceipt, "authorize" | "policy">> = {}): ConnectionReceipt {
    const receipt: ConnectionReceipt = { contract: "s16-connection-receipt/v1", requestId: command.requestId, kind: command.kind, source: source && source.state !== "removed" ? this.sourceView(owner, source) : null, github: this.options.github && command.kind.startsWith("github.") ? this.#github(owner) : null, authorize: extra.authorize ?? null, policy: extra.policy ?? null };
    // The OAuth URL carries a single-use state: a replayed command gets the same receipt but never a reusable sign-in link.
    this.store.db.query("INSERT INTO commands VALUES (?,?,?)").run(command.requestId, hash, canonical({ ...receipt, authorize: null }));
    return receipt;
  }
  #current(id: unknown, expectedRevision: unknown): SourceRecord {
    identity(id); integer(expectedRevision, 1);
    const record = this.record(id as string); if (!record || record.state === "removed") throw new AppError("not_found", 404);
    if (record.revision !== expectedRevision) throw new AppError("stale_revision", 409);
    return record;
  }
  #auth(input: unknown): SourceAuthInput {
    const auth = input as Record<string, unknown> | null;
    if (!auth || typeof auth !== "object") throw new AppError("invalid_connection_command");
    if (auth.kind === "none" || auth.kind === "oauth") { exact(auth, ["kind"]); return { kind: auth.kind }; }
    if (auth.kind === "bearer") { exact(auth, ["kind", "secret"]); if (typeof auth.secret !== "string" || !/^[\x21-\x7e]{8,8192}$/.test(auth.secret.trim())) throw new AppError("source_secret_invalid"); return { kind: "bearer", secret: auth.secret.trim() }; }
    if (auth.kind === "header") {
      exact(auth, ["kind", "name", "secret"]);
      if (typeof auth.name !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(auth.name) || forbiddenHeaders.has(auth.name.toLowerCase())) throw new AppError("source_header_invalid");
      if (typeof auth.secret !== "string" || !/^[\x20-\x7e]{8,8192}$/.test(auth.secret.trim())) throw new AppError("source_secret_invalid");
      return { kind: "header", name: auth.name, secret: auth.secret.trim() };
    }
    throw new AppError("invalid_connection_command");
  }
  /** Store a bearer/header secret write-only; the record keeps only its fingerprint. */
  #storeSecret(sourceId: string, auth: SourceAuthInput): SourceRecord["auth"] {
    if (auth.kind === "none" || auth.kind === "oauth") { if (auth.kind === "none") try { this.options.vault.remove(this.#key(sourceId)); } catch { /* Nothing stored. */ } return { kind: auth.kind, header: null, fingerprint: null, oauth: null }; }
    registerSecretFingerprint(auth.secret);
    this.options.vault.write(this.#key(sourceId), auth.secret);
    return { kind: auth.kind, header: auth.kind === "header" ? auth.name : null, fingerprint: sha256(auth.secret), oauth: null };
  }

  async #command(owner: Owner, input: unknown): Promise<ConnectionReceipt> {
    this.options.requireOwner(owner);
    const { command, hash } = this.#parse(input);
    const prior = this.#prior(command.requestId, hash); if (prior) return prior;
    const now = () => this.options.now();
    switch (command.kind) {
      case "source.add": {
        if (!["mcp", "openapi", "graphql"].includes(command.sourceKind)) throw new AppError("invalid_connection_command");
        content(command.label, 240); const label = [...command.label.trim()].slice(0, 60).join("");
        if (this.records().filter(r => r.state !== "removed").length >= connectionLimits.sources) throw new AppError("source_capacity", 409);
        const auth = this.#auth(command.auth);
        if (auth.kind === "oauth" && command.sourceKind !== "mcp") throw new AppError("source_oauth_mcp_only");
        let document: SourceRecord["document"] = null, base: string | null = null;
        if (command.sourceKind !== "mcp") {
          if (typeof command.document !== "string") throw new AppError("source_document_required");
          if (containsCredential(command.document)) throw new AppError("credential_content_refused", 403);
          base = command.sourceKind === "openapi" ? importOpenApi(command.document).base : null;
          document = { text: command.document, sha256: sha256(command.document) };
        } else if (command.document !== null) throw new AppError("invalid_connection_command");
        const endpoint = this.options.network.validate(command.endpoint === "" && base ? base : command.endpoint);
        let origin: SourceRecord["origin"] = { kind: "owner" };
        if (command.origin !== null) { exact(command.origin, ["conversationId", "requestId"]); identity(command.origin.conversationId); identity(command.origin.requestId); origin = { kind: "chat", conversationId: command.origin.conversationId, requestId: command.origin.requestId }; }
        const key = digest("s16.source.id.v1", { installation: this.options.installationId, requestId: command.requestId }).slice(0, 24);
        const id = `src_${key}`; if (this.record(id)) throw new AppError("request_id_conflict", 409);
        const stored = this.#storeSecret(id, auth);
        let record: SourceRecord = { contract: "s16-source/v1", id, revision: 1, kind: command.sourceKind, label, endpoint, auth: stored, state: "unavailable", code: "discovering",
          resource: { id, revision: 1, generation: 1 }, recipient: { id: `srcr_${key}`, revision: 1, generation: 1 }, source: { id: `srcs_${key}`, revision: 1, generation: 1 },
          catalog: null, review: null, document, origin, createdAt: now(), updatedAt: now(), verifiedAt: null };
        this.store.transaction(() => { this.store.capacity(); this.#save(record); });
        if (origin.kind === "chat") this.#closeRequests(origin.requestId, command.sourceKind, id);
        if (auth.kind === "oauth") {
          const begun = await this.#begin(owner, record);
          return this.#done(owner, command, hash, begun.record, { authorize: begun.url });
        }
        record = await this.#discover(owner, record);
        return this.#done(owner, command, hash, record);
      }
      case "source.review": {
        const record = this.#current(command.sourceId, command.expectedRevision);
        if (!record.catalog || command.catalogHash !== record.catalog.hash) throw new AppError("stale_catalog", 409);
        if (!["needs_review", "active"].includes(record.state)) throw new AppError("source_not_ready", 409);
        const decisions = reviewDecisions(record.catalog, command.decisions);
        if (Object.values(decisions).some(d => !toolClasses.includes(d))) throw new AppError("invalid_connection_command");
        const next: SourceRecord = { ...record, revision: record.revision + 1, state: "active", code: null, review: { revision: (record.review?.revision ?? 0) + 1, catalogHash: record.catalog.hash, decisions, reviewedAt: now() }, updatedAt: now() };
        this.store.transaction(() => this.#save(next));
        return this.#done(owner, command, hash, next, { policy: this.#membership(owner, command.requestId) });
      }
      case "source.refresh": {
        const record = this.#current(command.sourceId, command.expectedRevision);
        if (record.auth.kind === "oauth" && record.state === "authorizing") throw new AppError("source_login_required", 409);
        return this.#done(owner, command, hash, await this.#discover(owner, { ...record, revision: record.revision + 1, updatedAt: now() }));
      }
      case "source.reconnect": {
        const record = this.#current(command.sourceId, command.expectedRevision);
        const auth = this.#auth(command.auth);
        if (auth.kind === "oauth" && record.kind !== "mcp") throw new AppError("source_oauth_mcp_only");
        await this.options.closeSessions?.(record.id);
        const next: SourceRecord = { ...record, revision: record.revision + 1, auth: this.#storeSecret(record.id, auth), state: "unavailable", code: "discovering", updatedAt: now() };
        this.store.transaction(() => this.#save(next));
        if (auth.kind === "oauth") { const begun = await this.#begin(owner, next); return this.#done(owner, command, hash, begun.record, { authorize: begun.url }); }
        return this.#done(owner, command, hash, await this.#discover(owner, next));
      }
      case "source.document": {
        const record = this.#current(command.sourceId, command.expectedRevision);
        if (record.kind === "mcp" || typeof command.document !== "string") throw new AppError("invalid_connection_command");
        if (containsCredential(command.document)) throw new AppError("credential_content_refused", 403);
        // Parse before anything changes: an unusable document leaves the reviewed one in place.
        if (record.kind === "openapi") importOpenApi(command.document); else importGraphql(command.document);
        return this.#done(owner, command, hash, await this.#discover(owner, { ...record, revision: record.revision + 1, document: { text: command.document, sha256: sha256(command.document) }, updatedAt: now() }));
      }
      case "source.oauth_begin": {
        const record = this.#current(command.sourceId, command.expectedRevision);
        if (record.auth.kind !== "oauth") throw new AppError("source_oauth_mcp_only");
        const begun = await this.#begin(owner, record);
        return this.#done(owner, command, hash, begun.record, { authorize: begun.url });
      }
      case "source.oauth_complete": return this.#done(owner, command, hash, await this.#complete(owner, this.#current(command.sourceId, command.expectedRevision)));
      case "source.remove": {
        const record = this.#current(command.sourceId, command.expectedRevision);
        // Commit first: once removed, every identity is inactive and the credential is refused; then the vault value goes.
        const next: SourceRecord = { ...record, revision: record.revision + 1, state: "removed", code: null, auth: { ...record.auth, fingerprint: null }, updatedAt: now() };
        this.store.transaction(() => this.#save(next));
        try { this.options.vault.remove(this.#key(record.id)); } catch { /* Retried at the next boot. */ }
        await this.options.closeSessions?.(record.id);
        return this.#done(owner, command, hash, next, { policy: record.review ? this.#membership(owner, command.requestId) : "unchanged" });
      }
      case "github.connect": {
        if (!this.options.github) throw new AppError("github_unavailable", 503);
        if (typeof command.token !== "string") throw new AppError("github_token_required", 409);
        await this.options.github.connect(command.requestId, command.token);
        this.options.requireOwner(owner);
        // A new token keeps the repositories it can still reach; the rules follow the kept selection.
        const policy = this.options.github.resources().length ? this.#membership(owner, command.requestId) : null;
        this.#closeRequests(null, "github", null);
        return this.#done(owner, command, hash, null, { policy });
      }
      case "github.select": {
        if (!this.options.github) throw new AppError("github_unavailable", 503);
        integer(command.expectedRevision, 1);
        this.options.github.select(command.requestId, command.expectedRevision, command.names);
        return this.#done(owner, command, hash, null, { policy: this.#membership(owner, command.requestId) });
      }
      case "github.remove": {
        if (!this.options.github) throw new AppError("github_unavailable", 503);
        integer(command.expectedRevision, 1);
        this.options.github.remove(command.requestId, command.expectedRevision);
        return this.#done(owner, command, hash, null, { policy: this.#membership(owner, command.requestId) });
      }
      case "request.dismiss": {
        identity(command.connectionRequestId);
        const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM requests WHERE id=?").get(command.connectionRequestId);
        if (!row) throw new AppError("not_found", 404);
        const view = JSON.parse(row.record_json) as ConnectionRequestView;
        if (view.state === "open") this.store.db.query("UPDATE requests SET record_json=? WHERE id=?").run(canonical({ ...view, state: "dismissed" }), view.id);
        return this.#done(owner, command, hash, null);
      }
    }
  }
  /** The committed connection change stands even if the rules cannot follow now; the rules page then shows the update. */
  #membership(owner: Owner, requestId: string): "installed" | "unchanged" | "review_required" {
    try { return this.options.membership(owner, requestId); }
    catch (error) { if (error instanceof AppError && ["authentication_required", "authorization_required"].includes(error.code)) throw error; return "review_required"; }
  }
  #closeRequests(requestId: string | null, kind: string, sourceId: string | null): void {
    for (const view of this.#requests()) if (view.state === "open" && view.kind === kind && (requestId === null || view.requestId === requestId)) this.store.db.query("UPDATE requests SET record_json=? WHERE id=?").run(canonical({ ...view, state: "done", sourceId }), view.id);
  }

  /** Discover the catalog with the stored credential. The record is committed whatever the outcome. */
  async #discover(owner: Owner, record: SourceRecord): Promise<SourceRecord> {
    const working: SourceRecord = { ...record, code: "discovering" };
    this.store.transaction(() => this.#save(working));
    const commit = (patch: Partial<SourceRecord>): SourceRecord => {
      this.options.requireOwner(owner);
      const latest = this.record(record.id);
      if (!latest || latest.state === "removed" || latest.revision !== working.revision) throw new AppError("stale_revision", 409);
      const next: SourceRecord = { ...working, ...patch, updatedAt: this.options.now() };
      this.store.transaction(() => this.#save(next)); return next;
    };
    let catalog: SourceCatalog;
    try { catalog = await this.#catalog(record); }
    catch (error) {
      if (error instanceof SourceAuthRequired || error instanceof AppError && error.code === "source_login_required") return commit(record.auth.kind === "oauth" ? { state: "authorizing", code: "source_login_required" } : { state: "reconnect_required", code: "source_login_required" });
      if (error instanceof AppError && ["source_forbidden", "source_credential_unavailable"].includes(error.code)) return commit({ state: "reconnect_required", code: error.code });
      return commit({ state: "unavailable", code: error instanceof AppError ? error.code : "source_unavailable" });
    }
    // Same catalog as the owner reviewed: still active. Anything else waits for a new review.
    const same = record.review !== null && record.review.catalogHash === catalog.hash;
    return commit({ catalog, state: same ? "active" : "needs_review", code: null, verifiedAt: this.options.now() });
  }
  async #catalog(record: SourceRecord): Promise<SourceCatalog> {
    const now = this.options.now();
    if (record.kind === "openapi") return buildCatalog("openapi", record.endpoint, importOpenApi(record.document!.text), now);
    if (record.kind === "graphql") return buildCatalog("graphql", record.endpoint, importGraphql(record.document!.text), now);
    const session = await McpHttpSession.open(this.options.network, record.endpoint, () => this.auth(record));
    try { const listed = await session.listTools(); return buildCatalog("mcp", record.endpoint, mcpCandidates(listed.tools, listed.truncated, session.server), now); }
    finally { await session.close(); }
  }

  /** Start one OAuth sign-in: discover the server, register this installation as a public client and create a flow. */
  async #begin(owner: Owner, record: SourceRecord): Promise<{ record: SourceRecord; url: string }> {
    let metadata: string | null = null;
    try { const session = await McpHttpSession.open(this.options.network, record.endpoint, async () => ({})); await session.close(); }
    catch (error) { if (error instanceof SourceAuthRequired) metadata = error.resourceMetadata; else if (error instanceof AppError && ["source_address_not_public", "source_endpoint_invalid", "source_redirect_refused"].includes(error.code)) { const next = { ...record, state: "unavailable" as const, code: error.code }; this.store.transaction(() => this.#save(next)); throw error; } }
    let server: OAuthServer, client: OAuthClient;
    try { server = await discoverOAuth(this.options.network, record.endpoint, metadata); client = await registerOAuthClient(this.options.network, server, this.options.redirectUri); }
    catch (error) { const next = { ...record, state: "unavailable" as const, code: error instanceof AppError ? error.code : "source_oauth_unavailable", updatedAt: this.options.now() }; this.store.transaction(() => this.#save(next)); throw error; }
    this.options.requireOwner(owner);
    const { state, verifier } = oauthSecrets(), now = this.options.now();
    const flow: FlowRecord = { id: `flow_${digest("s16.source.flow.v1", { state }).slice(0, 24)}`, sourceId: record.id, sourceRevision: record.revision, ownerGeneration: this.options.ownerGeneration(), state: "pending", server, clientId: client.clientId, expiresAt: now + connectionLimits.oauthFlowMs, createdAt: now };
    this.options.vault.write(this.#flowKey(flow.id), JSON.stringify({ state, verifier, clientSecret: client.clientSecret } satisfies FlowSecret));
    const next: SourceRecord = { ...record, state: "authorizing", code: null, updatedAt: now };
    this.store.transaction(() => {
      // Only the newest sign-in of a source can complete; earlier pending flows fail.
      for (const row of this.store.db.query<{ id: string; record_json: string }, []>("SELECT id, record_json FROM flows").all()) { const f = JSON.parse(row.record_json) as FlowRecord; if (f.sourceId === record.id && (f.state === "pending" || f.state === "received")) this.store.db.query("UPDATE flows SET record_json=? WHERE id=?").run(canonical({ ...f, state: "failed" }), f.id); }
      this.store.db.query("INSERT INTO flows VALUES (?,?,?)").run(flow.id, sha256(state), canonical(flow)); this.#save(next);
    });
    return { record: next, url: authorizationUrl(server, client, this.options.redirectUri, state, verifier) };
  }

  /**
   * OAuth redirect (no session: the owner's SameSite=Strict cookie is not sent on a cross-site redirect). The random
   * single-use state is the only key: an unknown, reused, expired or superseded state refuses (`source_oauth_stale`) and
   * nothing is stored. The code is kept write-only until the owner's authenticated `source.oauth_complete` exchanges it.
   */
  callback(state: unknown, code: unknown, error: unknown): string {
    if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state)) throw new AppError("source_oauth_stale", 409);
    if (code !== null && (typeof code !== "string" || !/^[\x21-\x7e]{1,2048}$/.test(code))) throw new AppError("source_oauth_stale", 409);
    return this.store.transaction(() => {
      const row = this.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM flows WHERE state_hash=?").get(sha256(state));
      if (!row) throw new AppError("source_oauth_stale", 409);
      const flow = JSON.parse(row.record_json) as FlowRecord, record = this.record(flow.sourceId);
      if (flow.state !== "pending" || flow.expiresAt <= this.options.now() || flow.ownerGeneration !== this.options.ownerGeneration() || !record || record.state !== "authorizing" || record.revision !== flow.sourceRevision) throw new AppError("source_oauth_stale", 409);
      const secret = JSON.parse(this.options.vault.read(this.#flowKey(flow.id))) as FlowSecret;
      if (secret.state !== state) throw new AppError("source_oauth_stale", 409);
      if (code && !error) { this.options.vault.write(this.#flowKey(flow.id), JSON.stringify({ ...secret, code })); flow.state = "received"; }
      else { flow.state = "failed"; try { this.options.vault.remove(this.#flowKey(flow.id)); } catch { /* Nothing stored. */ } this.#save({ ...record, revision: record.revision + 1, state: "reconnect_required", code: "source_login_declined", updatedAt: this.options.now() }); }
      this.store.db.query("UPDATE flows SET record_json=? WHERE id=?").run(canonical(flow), flow.id);
      return record.id;
    });
  }

  /** Exchange the one received code (once: an interrupted exchange needs a fresh sign-in), then discover. */
  async #complete(owner: Owner, record: SourceRecord): Promise<SourceRecord> {
    const flow = this.store.transaction(() => {
      const rows = this.store.db.query<{ record_json: string }, []>("SELECT record_json FROM flows ORDER BY rowid DESC").all().map(r => JSON.parse(r.record_json) as FlowRecord);
      const found = rows.find(f => f.sourceId === record.id && f.state === "received");
      if (!found || found.expiresAt <= this.options.now() || found.ownerGeneration !== this.options.ownerGeneration() || found.sourceRevision !== record.revision) throw new AppError("source_oauth_stale", 409);
      found.state = "exchanging"; this.store.db.query("UPDATE flows SET record_json=? WHERE id=?").run(canonical(found), found.id);
      return found;
    });
    const secret = JSON.parse(this.options.vault.read(this.#flowKey(flow.id))) as FlowSecret;
    try { this.options.vault.remove(this.#flowKey(flow.id)); } catch { /* The flow is already single-use. */ }
    const settle = (state: FlowRecord["state"]) => this.store.db.query("UPDATE flows SET record_json=? WHERE id=?").run(canonical({ ...flow, state }), flow.id);
    let tokens: Awaited<ReturnType<typeof exchangeOAuthCode>>;
    try { tokens = await exchangeOAuthCode(this.options.network, flow.server, { clientId: flow.clientId, clientSecret: secret.clientSecret }, { code: secret.code!, verifier: secret.verifier, redirectUri: this.options.redirectUri, now: this.options.now() }); }
    catch (error) { settle("failed"); const next = { ...record, revision: record.revision + 1, state: "reconnect_required" as const, code: error instanceof AppError ? error.code : "source_oauth_token_invalid", updatedAt: this.options.now() }; this.store.transaction(() => this.#save(next)); return next; }
    this.options.requireOwner(owner);
    registerSecretFingerprint(tokens.accessToken); if (tokens.refreshToken) registerSecretFingerprint(tokens.refreshToken);
    this.options.vault.write(this.#key(record.id), JSON.stringify({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, clientId: flow.clientId, clientSecret: secret.clientSecret } satisfies StoredToken));
    settle("complete");
    const next: SourceRecord = { ...record, revision: record.revision + 1, auth: { kind: "oauth", header: null, fingerprint: null, oauth: { issuer: flow.server.issuer, authorizationEndpoint: flow.server.authorizationEndpoint, tokenEndpoint: flow.server.tokenEndpoint, clientId: flow.clientId, resource: flow.server.resource, scope: tokens.scope ?? flow.server.scope, expiresAt: tokens.expiresAt } }, updatedAt: this.options.now() };
    this.store.transaction(() => this.#save(next));
    return this.#discover(owner, next);
  }
}
