import { PersonalEffects } from "./personal-effects";
import { randomBytes } from "node:crypto";
import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import type { AppTransaction } from "../store";
import type { Attempt, ScopePolicy, ScopeRef } from "./authority-types";
import type { Bot, OwnerActor } from "./types";
import { canonical, digest, exact, identity, integer, text } from "./validation";
import { record, type S14Application } from "./application";
import { GoogleFailure, GooglePersonal, googleObject, googleScope, type GoogleTransport, type PersonalTimer } from "./personal-protocol";
import { PersonalVault } from "./personal-vault";
import { PersonalReads } from "./personal-reads";
import type { PersonalClient, PersonalClientSecret, PersonalCommand, PersonalConnection, PersonalFlow, PersonalGrant, PersonalReceipt, PersonalScope, PersonalTokens } from "./personal-types";

const clientKey = "00000000-0000-4000-8000-000000000260";
const allScopes: PersonalScope[] = ["gmail.readonly", "calendar.readonly", "gmail.send", "calendar.events"];
type Table = "personal_clients" | "personal_connections" | "personal_flows" | "personal_grants";
/** Loads broker metadata only from a service-selected table; callers enforce owner or attempt authority. */
export function personalRecord<T>(tx: AppTransaction, table: Table, id: string): T {
  const row = tx.get<{ record_json: string }>(`SELECT record_json FROM ${table} WHERE id=?`, id);
  if (!row) throw new AppError("personal_not_found", 404);
  return JSON.parse(row.record_json) as T;
}
/** Persists one credential-free broker metadata record inside the caller's transaction. */
export function personalSave(tx: AppTransaction, table: Table, value: { id: string }): void {
  tx.run(`UPDATE ${table} SET record_json=? WHERE id=?`, canonical(value), value.id);
}
/** Broker dependencies cannot be selected by model text, HTTP payloads or a source. */
export interface PersonalOptions { vault?: PersonalVault; transport?: GoogleTransport; timer?: PersonalTimer; evidenceGuard?: boolean }

/** Owns installation-local Google consent, refresh, revocation and per-Bot account resource barriers. */
export class S14Personal {
  readonly google: GooglePersonal;
  readonly reads: PersonalReads;
  readonly effects: PersonalEffects;
  #refreshing = new Map<string, Promise<PersonalTokens>>();
  #revoking = new Set<string>();
  constructor(readonly app: S14Application, readonly options: PersonalOptions = {}) {
    this.google = new GooglePersonal(options.transport, options.timer);
    this.reads = new PersonalReads(this);
    this.effects = new PersonalEffects(this);
    // Fingerprints activate before any model context can be assembled after restart.
    this.app.store.read(tx => {
      if (!options.vault) return;
      for (const id of [clientKey, ...tx.all<{ id: string }>("SELECT id FROM personal_connections").map(c => c.id)]) {
        try { options.vault.read(id); } catch { /* Missing secrets never imply live readiness. */ }
      }
    });
  }

  /** Requires the protected broker vault; no plaintext or execution-box fallback is available. */
  vault(): PersonalVault {
    if (!this.options.vault) throw new AppError("personal_vault_unavailable", 503);
    return this.options.vault;
  }

  /** Returns setup/connection/resource metadata only; configured clients do not claim working consent. */
  settings(actor: OwnerActor): { client: PersonalClient | null; connections: PersonalConnection[]; grants: PersonalGrant[]; flows: PersonalFlow[] } {
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      const client = tx.get<{ record_json: string }>("SELECT record_json FROM personal_clients WHERE id='google'");
      const rows = <T>(table: Table) => tx.all<{ record_json: string }>(`SELECT record_json FROM ${table} ORDER BY rowid`).map(r => JSON.parse(r.record_json) as T);
      return { client: client ? JSON.parse(client.record_json) : null, connections: rows<PersonalConnection>("personal_connections"), grants: rows<PersonalGrant>("personal_grants"), flows: rows<PersonalFlow>("personal_flows") };
    });
  }

  /** Applies exact authenticated owner metadata/consent commands without retaining credential values or their digests. */
  apply(tx: AppTransaction, command: PersonalCommand): PersonalReceipt {
    const receipt: PersonalReceipt = { kind: command.kind, requestId: command.requestId };
    if (command.kind === "personal.client.set") {
      const p = command.payload;
      exact(p, ["clientId", "clientSecret", "redirectUri"]);
      const previous = tx.get<{ record_json: string }>("SELECT record_json FROM personal_clients WHERE id='google'");
      const revision = previous ? (JSON.parse(previous.record_json) as PersonalClient).revision : 0;
      if (command.expectedRevision !== revision) throw new AppError("stale_revision", 409);
      if (tx.get("SELECT 1 FROM personal_connections WHERE json_extract(record_json,'$.state')<>'revoked'")) throw new AppError("personal_revoke_connections_before_client_change", 409);
      if (!/^[a-zA-Z0-9._-]{8,200}\.apps\.googleusercontent\.com$/.test(p.clientId) || typeof p.clientSecret !== "string" || p.clientSecret.length < 8 || p.clientSecret.length > 1024 || /[\s\u0000-\u001f]/.test(p.clientSecret)) throw new AppError("personal_invalid_client");
      const redirect = new URL(p.redirectUri);
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname);
      if (!(redirect.protocol === "https:" || loopback && redirect.protocol === "http:") || redirect.username || redirect.password || redirect.search || redirect.hash || redirect.pathname !== "/s14/personal/oauth/callback") throw new AppError("personal_invalid_redirect");
      const client: PersonalClient = { id: "google", revision: revision + 1, clientId: p.clientId, redirectUri: redirect.href, readiness: "configured_unverified" };
      this.vault().write(clientKey, { clientId: p.clientId, clientSecret: p.clientSecret, redirectUri: redirect.href });
      tx.run("INSERT OR REPLACE INTO personal_clients VALUES ('google',?)", canonical(client));
      return { ...receipt, client };
    }
    if (command.kind === "personal.connection.create") {
      const p = command.payload;
      exact(p, ["label", "service", "scopes", "account", "calendarId"]);
      if (command.expectedRevision !== 0) throw new AppError("stale_revision", 409);
      const client = personalRecord<PersonalClient>(tx, "personal_clients", "google");
      if (!["gmail", "calendar"].includes(p.service) || !Array.isArray(p.scopes) || !p.scopes.length || p.scopes.length > 2 || new Set(p.scopes).size !== p.scopes.length || p.scopes.some(s => !allScopes.includes(s) || !s.startsWith(`${p.service}.`))) throw new AppError("personal_invalid_consent");
      if (p.service === "calendar" ? typeof p.calendarId !== "string" || !p.calendarId || p.calendarId.length > 256 || /[\u0000-\u0020]/.test(p.calendarId) : p.calendarId !== null) throw new AppError("personal_invalid_calendar");
      if (typeof p.account !== "string" || !/^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(p.account) || p.account.length > 254 || containsCredential(p.account)) throw new AppError("personal_invalid_account");
      if (containsCredential(p.label) || containsCredential(p.calendarId ?? "")) throw new AppError("credential_content_refused", 403);
      if (tx.get<{ n: number }>("SELECT count(*) n FROM personal_connections")!.n >= 64) throw new AppError("personal_connection_limit");
      const connection: PersonalConnection = { id: crypto.randomUUID(), revision: 1, clientRevision: client.revision, label: text(p.label, 80), service: p.service, scopes: [...p.scopes].sort(), account: p.account, accountVerification: "owner_label", calendarId: p.calendarId, state: "configured", revocation: "none", verifiedAt: null };
      tx.run("INSERT INTO personal_connections VALUES (?,?)", connection.id, canonical(connection));
      return { ...receipt, connection };
    }
    if (command.kind === "personal.grant.set") {
      const p = command.payload;
      exact(p, ["scopeId", "connectionId", "botId", "active"]);
      identity(p.scopeId);
      identity(p.connectionId);
      identity(p.botId);
      const bot = record<Bot>(tx, "bots", p.botId);
      if (!bot.enabled || !bot.capabilities.resources.includes(p.scopeId) || !this.app.policy.resources.includes(p.scopeId) || typeof p.active !== "boolean") throw new AppError("personal_bot_scope_refused", 403);
      if (tx.get("SELECT id FROM snapshot_shares WHERE id=? UNION SELECT id FROM memory_shares WHERE id=? UNION SELECT id FROM lifecycle.withdrawals WHERE id=? AND kind IN ('snapshot_share','share')", p.scopeId, p.scopeId, p.scopeId)) throw new AppError("personal_scope_exists", 409);
      this.connection(tx, p.connectionId);
      const existing = tx.get<{ record_json: string }>("SELECT record_json FROM personal_grants WHERE id=?", p.scopeId);
      const previous = existing ? JSON.parse(existing.record_json) as PersonalGrant : null;
      if ((previous?.revision ?? 0) !== command.expectedRevision) throw new AppError("stale_revision", 409);
      if (previous) tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('personal_grant',?,?)", previous.id, `revision_${previous.revision}`);
      const grant: PersonalGrant = { id: p.scopeId, revision: command.expectedRevision + 1, connectionId: p.connectionId, botId: p.botId, botGeneration: bot.generation, active: p.active };
      tx.run("INSERT OR REPLACE INTO personal_grants VALUES (?,?)", grant.id, canonical(grant));
      return { ...receipt, grant };
    }
    const p = command.payload;
    exact(p, ["connectionId"]);
    identity(p.connectionId);
    const connection = personalRecord<PersonalConnection>(tx, "personal_connections", p.connectionId);
    if (connection.revision !== command.expectedRevision || connection.state === "revoked") throw new AppError("stale_revision", 409);
    if (command.kind === "personal.connection.revoke") {
      connection.state = "revoked";
      connection.revocation = "pending";
      connection.revision++;
      tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('personal_connection',?,'revoked')", connection.id);
      personalSave(tx, "personal_connections", connection);
      return { ...receipt, connection };
    }
    if (command.kind !== "personal.oauth.begin") throw new AppError("unknown_command");
    if (!["configured", "reauth_required", "authorizing"].includes(connection.state)) throw new AppError("personal_oauth_state", 409);
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM personal_flows WHERE json_extract(record_json,'$.connectionId')=?", connection.id)) {
      const old = JSON.parse(row.record_json) as PersonalFlow;
      if (["pending", "received", "exchanging"].includes(old.state)) {
        old.state = "failed";
        personalSave(tx, "personal_flows", old);
        this.vault().remove(old.id);
      }
    }
    tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('personal_consent',?,?)", connection.id, `revision_${connection.revision}`);
    connection.state = "authorizing";
    connection.revision++;
    personalSave(tx, "personal_connections", connection);
    const state = randomBytes(32).toString("base64url");
    const flow: PersonalFlow = { id: crypto.randomUUID(), connectionId: connection.id, connectionRevision: connection.revision,
      ownerGeneration: tx.get<{ generation: number }>("SELECT generation FROM owner")!.generation, expiresAt: this.app.now() + 600000, state: "pending" };
    this.vault().write(flow.id, { state, verifier: randomBytes(32).toString("base64url"), code: null });
    tx.run("INSERT INTO personal_flows VALUES (?,?,?)", flow.id, digest(state), canonical(flow));
    return { ...receipt, connection, flow };
  }

  /** Returns an owner-only authorization URL, requesting precisely this connection's scopes with no incremental union. */
  authorization(actor: OwnerActor, flowId: string): { url: string; expiresAt: number } {
    return this.app.store.read(tx => {
      this.app.requireOwner(tx, actor);
      const flow = this.flow(tx, flowId, "pending");
      const connection = personalRecord<PersonalConnection>(tx, "personal_connections", flow.connectionId);
      const client = personalRecord<PersonalClient>(tx, "personal_clients", "google");
      const secret = this.vault().read<{ state: string; verifier: string }>(flow.id);
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: client.redirectUri, response_type: "code", access_type: "offline", prompt: "consent", include_granted_scopes: "false",
        scope: connection.scopes.map(googleScope).join(" "), state: secret.state, login_hint: connection.account,
        code_challenge: Buffer.from(digest(secret.verifier), "hex").toString("base64url"), code_challenge_method: "S256" }).toString();
      return { url: url.href, expiresAt: flow.expiresAt };
    });
  }

  private flow(tx: AppTransaction, flowId: string, state: PersonalFlow["state"]): PersonalFlow {
    identity(flowId);
    const flow = personalRecord<PersonalFlow>(tx, "personal_flows", flowId);
    const connection = personalRecord<PersonalConnection>(tx, "personal_connections", flow.connectionId);
    if (flow.state !== state || flow.expiresAt <= this.app.now() || connection.state !== "authorizing" || connection.revision !== flow.connectionRevision || flow.ownerGeneration !== tx.get<{ generation: number }>("SELECT generation FROM owner")?.generation) throw new AppError("personal_oauth_stale", 409);
    return flow;
  }

  /** Captures a one-time callback code by random state without requiring a cross-site SameSite=Strict cookie. */
  callback(state: string, code: string | null): void {
    if (typeof state !== "string" || !/^[a-zA-Z0-9_-]{43}$/.test(state) || code !== null && (typeof code !== "string" || !code || code.length > 2048 || /[\u0000-\u0020]/.test(code))) throw new AppError("personal_oauth_stale", 409);
    this.app.store.transaction(tx => {
      const row = tx.get<{ id: string }>("SELECT id FROM personal_flows WHERE state_hash=?", digest(state));
      if (!row) throw new AppError("personal_oauth_stale", 409);
      const flow = this.flow(tx, row.id, "pending");
      if (code) {
        const secret = this.vault().read<Record<string, unknown>>(flow.id);
        this.vault().write(flow.id, { ...secret, code });
        flow.state = "received";
      } else {
        flow.state = "failed";
        this.vault().remove(flow.id);
        const connection = personalRecord<PersonalConnection>(tx, "personal_connections", flow.connectionId);
        connection.state = "reauth_required";
        connection.revision++;
        personalSave(tx, "personal_connections", connection);
      }
      personalSave(tx, "personal_flows", flow);
    });
  }

  /** Completes owner-authenticated consent once; interrupted exchanges require fresh consent and never replay a code. */
  async complete(actor: OwnerActor, flowId: string): Promise<PersonalConnection> {
    const flow = this.app.store.transaction(tx => {
      this.app.requireOwner(tx, actor);
      const flow = personalRecord<PersonalFlow>(tx, "personal_flows", flowId);
      if (flow.state === "complete") return flow;
      this.flow(tx, flowId, "received");
      flow.state = "exchanging";
      personalSave(tx, "personal_flows", flow);
      return flow;
    });
    if (flow.state === "complete") return this.app.store.read(tx => personalRecord<PersonalConnection>(tx, "personal_connections", flow.connectionId));
    const allowed = () => this.app.store.read(tx => { this.app.requireOwner(tx, actor); this.flow(tx, flowId, "exchanging"); });
    try {
      const secret = this.vault().read<{ code: string; verifier: string }>(flow.id);
      const connection = this.app.store.read(tx => personalRecord<PersonalConnection>(tx, "personal_connections", flow.connectionId));
      const client = this.vault().read<PersonalClientSecret>(clientKey);
      const tokens = await this.google.tokens(client, connection.scopes, { code: secret.code, code_verifier: secret.verifier, redirect_uri: client.redirectUri, grant_type: "authorization_code" }, this.app.now(), allowed);
      if (connection.scopes.includes("gmail.readonly")) {
        const profile = googleObject(await this.google.request("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { Authorization: `Bearer ${tokens.accessToken}` } }, allowed));
        if (typeof profile.emailAddress !== "string" || profile.emailAddress.toLowerCase() !== connection.account.toLowerCase()) throw new AppError("personal_account_mismatch", 403);
        connection.accountVerification = "gmail_profile";
      }
      return this.app.store.transaction(tx => {
        allowed();
        this.vault().write(connection.id, tokens);
        connection.state = "connected";
        connection.verifiedAt = this.app.now();
        connection.revision++;
        personalSave(tx, "personal_connections", connection);
        flow.state = "complete";
        personalSave(tx, "personal_flows", flow);
        this.vault().remove(flow.id);
        return connection;
      });
    } catch {
      this.app.store.transaction(tx => {
        const connection = personalRecord<PersonalConnection>(tx, "personal_connections", flow.connectionId);
        if (connection.state === "authorizing" && connection.revision === flow.connectionRevision) { connection.state = "reauth_required"; connection.revision++; personalSave(tx, "personal_connections", connection); }
        flow.state = "failed";
        personalSave(tx, "personal_flows", flow);
        this.vault().remove(flow.id);
      });
      throw new AppError("personal_oauth_failed_reauthorize", 409);
    }
  }

  /** Resolves only active, untombstoned consent; refreshes never change account identity or resource revision. */
  connection(tx: AppTransaction, id: string, revision?: number): PersonalConnection {
    const connection = personalRecord<PersonalConnection>(tx, "personal_connections", id);
    const client = personalRecord<PersonalClient>(tx, "personal_clients", "google");
    if (connection.state !== "connected" || revision !== undefined && connection.revision !== revision || client.revision !== connection.clientRevision || tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='personal_connection' AND id=?", id) || tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='personal_consent' AND id=? AND mode=?", id, `revision_${connection.revision}`)) throw new AppError("personal_connection_unavailable", 403);
    return connection;
  }

  /** Reserves a personal resource identity even when revoked, preventing fallback to an unrelated scope provider. */
  owns(tx: AppTransaction, ref: ScopeRef): boolean {
    return !!tx.get("SELECT 1 FROM personal_grants WHERE id=? UNION SELECT 1 FROM lifecycle.withdrawals WHERE kind='personal_grant' AND id=?", ref.id, ref.id);
  }

  /** Supplies exact per-Bot account resource policy to ordinary work/routine admission and live barriers. */
  scope(tx: AppTransaction, ref: ScopeRef): ScopePolicy | null {
    return this.accountScope(tx, ref);
  }

  /** Inspects retained account evidence under an exact independent owner-retention fact; never used for execution admission. */
  retainedScope(tx: AppTransaction, ref: ScopeRef, attemptId: string): ScopePolicy | null {
    if (!tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='retained_evidence' AND id=? AND mode='owner_retained'", attemptId)) return null;
    const attempt = record<Attempt>(tx, "work_attempts", attemptId);
    return this.accountScope(tx, ref, attempt.snapshot.bot);
  }

  private accountScope(tx: AppTransaction, ref: ScopeRef, retainedBot?: Bot): ScopePolicy | null {
    if (ref.kind !== "resource") return null;
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM personal_grants WHERE id=?", ref.id);
    if (!row) return null;
    const grant = JSON.parse(row.record_json) as PersonalGrant;
    if (!grant.active || grant.revision !== ref.revision || tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='personal_grant' AND id=? AND mode=?", grant.id, `revision_${grant.revision}`)) return null;
    try {
      const connection = this.connection(tx, grant.connectionId);
      const bot = retainedBot ?? record<Bot>(tx, "bots", grant.botId);
      if (bot.id !== grant.botId || tx.get("SELECT 1 FROM lifecycle.withdrawals WHERE kind='bot' AND id=? AND mode='deleted'", grant.botId)) return null;
      if (!bot.enabled || bot.generation !== grant.botGeneration || !bot.capabilities.resources.includes(ref.id)) return null;
      return { ref, active: true, ownerBotId: grant.botId, receiverBotId: null, workId: null, tools: [...this.app.policy.tools], snapshot: { id: connection.id, revision: connection.revision, hash: digest(canonical({ grant, connection })) } };
    } catch { return null; }
  }

  /** Rechecks the exact attempt, Bot resource and provider consent before every broker request or publication. */
  guard(tx: AppTransaction, attemptId: string, scope: ScopeRef, tool: string, consent: PersonalScope): { attempt: Attempt; connection: PersonalConnection } {
    const attempt = this.app.authority.guard(tx, attemptId, tool);
    const current = this.scope(tx, scope);
    if (!current || current.ownerBotId !== attempt.snapshot.bot.id || !attempt.snapshot.scopes.some(s => canonical(s) === canonical(current))) throw new AppError("personal_account_outside_grant", 403);
    const connection = this.connection(tx, current.snapshot.id, current.snapshot.revision);
    if (!connection.scopes.includes(consent)) throw new AppError("personal_consent_required", 403);
    return { attempt, connection };
  }

  /** Coalesces overlapping refreshes for one connection; revoked or stale refresh results never reach the vault. */
  async token(connection: PersonalConnection, allowed: () => void): Promise<string> {
    allowed();
    let tokens = this.vault().read<PersonalTokens>(connection.id);
    if (tokens.expiresAt <= this.app.now() + 30000) {
      let refreshing = this.#refreshing.get(connection.id);
      if (!refreshing) {
        refreshing = (async () => {
          const current = () => { this.app.store.read(tx => this.connection(tx, connection.id, connection.revision)); };
          const client = this.vault().read<PersonalClientSecret>(clientKey);
          try {
            const renewed = await this.google.tokens(client, connection.scopes, { refresh_token: tokens.refreshToken, grant_type: "refresh_token" }, this.app.now(), current, tokens);
            current();
            this.vault().write(connection.id, renewed);
            return renewed;
          } catch (error) {
            if (error instanceof GoogleFailure && ([400, 401].includes(error.providerStatus) || error.code === "google_consent_mismatch")) this.invalidate(connection.id);
            throw error;
          }
        })();
        this.#refreshing.set(connection.id, refreshing);
      }
      try { tokens = await refreshing; }
      finally { if (this.#refreshing.get(connection.id) === refreshing) this.#refreshing.delete(connection.id); }
    }
    allowed();
    return tokens.accessToken;
  }

  /** Fences rejected consent immediately; provider error bodies never enter state or logs. */
  invalidate(connectionId: string): void {
    this.app.store.transaction(tx => {
      const connection = personalRecord<PersonalConnection>(tx, "personal_connections", connectionId);
      if (connection.state !== "connected") return;
      tx.run("INSERT OR IGNORE INTO lifecycle.withdrawals VALUES ('personal_consent',?,?)", connection.id, `revision_${connection.revision}`);
      connection.state = "reauth_required";
      connection.revision++;
      personalSave(tx, "personal_connections", connection);
      this.app.memory.reconcile(tx);
    });
    this.app.authority.cancelFenced();
  }

  /** Checks every personal source ancestor against its captured consent and, when supplied, the receiving Bot's account grant. */
  sourceAllowed(tx: AppTransaction, sourceId: string, botId?: string): boolean {
    const pending = [sourceId], seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const source = tx.get<{ record_json: string }>("SELECT record_json FROM memory_sources WHERE id=?", id);
      const item = source ? JSON.parse(source.record_json) as { producerAttemptId?: string; derived: { id: string }[] } : null;
      const pin = tx.get<{ scope_json: string; connection_id: string; connection_revision: number }>("SELECT * FROM personal_sources WHERE source_id=?", id);
      if (pin) {
        const scope = this.scope(tx, JSON.parse(pin.scope_json)) ?? (!botId && item?.producerAttemptId ? this.retainedScope(tx, JSON.parse(pin.scope_json), item.producerAttemptId) : null);
        if (!scope || scope.snapshot.id !== pin.connection_id || scope.snapshot.revision !== pin.connection_revision || botId && scope.ownerBotId !== botId) return false;
      }
      if (item) pending.push(...item.derived.map(r => r.id));
    }
    return true;
  }

  /** Reconciles restored revocations and interrupted OAuth/read state before any worker starts. */
  recover(tx: AppTransaction): void {
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM personal_flows")) {
      const flow = JSON.parse(row.record_json) as PersonalFlow;
      if (flow.state === "exchanging" || ["pending", "received"].includes(flow.state) && flow.expiresAt <= this.app.now()) {
        flow.state = "failed";
        personalSave(tx, "personal_flows", flow);
        const connection = personalRecord<PersonalConnection>(tx, "personal_connections", flow.connectionId);
        if (connection.state === "authorizing" && connection.revision === flow.connectionRevision) { connection.state = "reauth_required"; connection.revision++; personalSave(tx, "personal_connections", connection); }
        try { this.vault().remove(flow.id); } catch { /* Missing vault remains unavailable. */ }
      }
    }
    for (const row of tx.all<{ id: string }>("SELECT id FROM lifecycle.withdrawals WHERE kind='personal_connection'")) {
      if (!tx.get("SELECT 1 FROM personal_connections WHERE id=?", row.id)) continue;
      const connection = personalRecord<PersonalConnection>(tx, "personal_connections", row.id);
      if (connection.state !== "revoked") { connection.state = "revoked"; connection.revision++; personalSave(tx, "personal_connections", connection); }
    }
    tx.run("UPDATE personal_reads SET record_json=json_set(record_json,'$.outcome','failed','$.finishedAt',?,'$.missing',json('[\"interrupted_read\"]')) WHERE json_extract(record_json,'$.outcome')='running'", this.app.now());
    this.reconcile(tx);
  }

  /** Supplies account-private source text to the existing outbound guard even though its attribution is external. */
  privateCorpus(tx: AppTransaction, botId: string): { text: string }[] {
    return tx.all<{ record_json: string }>(`SELECT s.record_json FROM memory_sources s
      JOIN personal_sources p ON p.source_id=s.id WHERE s.bot_id=?`, botId)
      .map(row => JSON.parse(row.record_json) as { text: string | null })
      .filter((source): source is { text: string } => source.text !== null);
  }

  /** Enumerates only identity/hash metadata for exact Bot lifecycle previews, never connection credentials or source bodies. */
  impact(tx: AppTransaction, botId: string): { reads: string[]; drafts: { id: string; revision: number; hash: string }[] } {
    const reads = tx.all<{ id: string }>("SELECT id FROM personal_reads WHERE json_extract(record_json,'$.botId')=? ORDER BY id", botId).map(row => row.id);
    const drafts = tx.all<{ id: string; revision: number; hash: string }>("SELECT id,json_extract(record_json,'$.revision') AS revision,json_extract(record_json,'$.hash') AS hash FROM personal_drafts WHERE json_extract(record_json,'$.botId')=? ORDER BY id", botId);
    return { reads, drafts };
  }

  /** Withdraws personal payload caches after account/source/Bot fencing without claiming to erase prior disclosure. */
  reconcile(tx: AppTransaction): void {
    this.reads.reconcile(tx);
    this.effects.scrub(tx);
  }

  /** Attempts remote revocation once after the local fence; unknown results stay visible with no automatic retry. */
  async drain(): Promise<void> {
    const pending = this.app.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM personal_connections WHERE json_extract(record_json,'$.revocation')='pending'").map(r => JSON.parse(r.record_json) as PersonalConnection));
    for (const connection of pending) {
      if (this.#revoking.has(connection.id)) continue;
      this.#revoking.add(connection.id);
      this.app.store.transaction(tx => { connection.revocation = "unknown"; personalSave(tx, "personal_connections", connection); });
      let confirmed = false;
      try {
        const tokens = this.vault().read<PersonalTokens>(connection.id);
        await this.google.request("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: tokens.refreshToken }).toString() }, () => {});
        confirmed = true;
      } catch { /* Remote revocation is uncertain; local denial is unconditional. */ }
      finally {
        try { this.vault().remove(connection.id); } catch { /* Local tombstones still deny release. */ }
        this.app.store.transaction(tx => { connection.revocation = confirmed ? "confirmed" : "unknown"; personalSave(tx, "personal_connections", connection); });
        this.#revoking.delete(connection.id);
      }
    }
  }
}
