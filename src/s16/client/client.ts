import { clientResponseBytes, type ClientArtifactDetail, type ClientArtifactInputCommand, type ClientArtifactItem, type ClientArtifactList, type ClientArtifactQuery, type ClientMemoryCommand, type ClientMemoryDetail, type ClientMemoryList, type ClientMemoryQuery, type ClientMemoryResult, type ClientBootstrap, type ClientDecision, type ClientEvents, type ClientMessage, type ClientReceipt, type ClientRequest, type ClientSnapshot } from "./contracts";
import type { FileArtifact, FileReference, FileUpload, FileUploadCommand } from "../files/types";

/** Safe transport failure. An unknown mutation outcome is recovered by its original request identity. */
export class JitClientError extends Error {
  constructor(readonly code: string, readonly status: number | null, readonly outcome: "not_sent" | "unknown" | "response", readonly requestId: string | null = null) { super(code); this.name = "JitClientError"; }
}
/** Fetch injection supports native session adapters and deterministic tests. Native adapters add the
 * authenticated cookie and exact configured Origin on POST; browsers supply Origin themselves. */
export interface JitClientOptions { origin: string; fetch?: (request: Request) => Promise<Response> }
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const safeCode = (value: unknown) => typeof value === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : "client_unavailable";
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
const sha256 = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const invalid = (): never => { throw new JitClientError("client_protocol_invalid", null, "response"); };
const id = (value: string) => { if (!identifier(value)) throw new JitClientError("invalid_identity", null, "not_sent"); return value; };

/**
 * Shared Web/native client over the protected Jit service. Sends never auto-retry, redirects are refused,
 * and snapshot/event reads never submit work. CSRF/session material is not part of returned UI state.
 */
export class JitClient {
  readonly origin: string;
  readonly #fetch: (request: Request) => Promise<Response>;
  #csrf: string | null = null;
  #sessionGeneration = 0;
  constructor(options: JitClientOptions) {
    const url = new URL(options.origin);
    if (!["https:", "http:"].includes(url.protocol) || url.origin !== options.origin || url.username || url.password) throw new JitClientError("client_origin_invalid", null, "not_sent");
    this.origin = url.origin; this.#fetch = options.fetch ?? (request => fetch(request));
  }
  /** Read current capabilities/navigation and establish CSRF for explicit subsequent commands. */
  async bootstrap(signal?: AbortSignal): Promise<Omit<ClientBootstrap, "csrf">> {
    this.clear(); const generation = this.#sessionGeneration;
    const data = await this.call("/bootstrap", "GET", undefined, signal);
    if (generation !== this.#sessionGeneration) throw new JitClientError("client_response_stale", null, "response");
    if (!record(data) || data.contract !== "s16-client-bootstrap/v1" || typeof data.csrf !== "string" || !data.csrf || data.csrf.length > 4096 || !record(data.capabilities) || data.capabilities.contract !== "s16-client-capabilities/v1" || !Array.isArray(data.conversations) || data.conversations.length > 64 || !Array.isArray(data.needsYou) || data.needsYou.length > 1024) return invalid();
    for (const entry of data.conversations) if (!record(entry) || !identifier(entry.conversationId) || typeof entry.firstMessage !== "string" || !Number.isSafeInteger(entry.latestAt)) return invalid();
    this.#csrf = data.csrf;
    const { csrf: _csrf, ...projection } = data as unknown as ClientBootstrap;
    return projection;
  }
  /** Creates one local immutable send identity; callers retain this command through response loss. */
  prepareMessage(conversationId: string, text: string, files: readonly FileReference[] = []): ClientMessage {
    id(conversationId);
    if (typeof text !== "string" || (!text.trim() && (!files.length || text !== "")) || new TextEncoder().encode(text).length > 16384) throw new JitClientError("invalid_text", null, "not_sent");
    if (files.length) {
      if (files.length > 8 || new Set(files.map(file => file.id)).size !== files.length || files.some(file => !identifier(file.id) || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new JitClientError("invalid_file_metadata", null, "not_sent");
      return Object.freeze({ contract: "s16-conversation/v2", requestId: crypto.randomUUID().replaceAll("-", ""), conversationId, text, continuation: null, files: Object.freeze(files.map(file => Object.freeze({ ...file }))) });
    }
    return Object.freeze({ contract: "s15-conversation/v1", requestId: crypto.randomUUID().replaceAll("-", ""), conversationId, text, continuation: null });
  }
  /** Explicitly sends the retained command once. Duplicate recovery uses this same ID and exact body. */
  async send(command: ClientMessage, signal?: AbortSignal): Promise<ClientReceipt> {
    const input = structuredClone(command); id(input.requestId); id(input.conversationId);
    return this.receipt(await this.call(`/conversations/${input.conversationId}/messages`, "POST", input, signal, input.requestId), input);
  }
  /** Fresh guarded snapshot; no queued work is started or replayed by reading. */
  async snapshot(conversationId: string, signal?: AbortSignal): Promise<ClientSnapshot> {
    const data = await this.call(`/conversations/${id(conversationId)}`, "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-snapshot/v1" || !record(data.conversation) || data.conversation.contract !== "s15.owner-view/v1" || data.conversation.conversationId !== conversationId || !Number.isSafeInteger(data.conversation.cursor) || !Array.isArray(data.conversation.rows) || data.conversation.rows.length > 32 || !Array.isArray(data.conversation.needsYou)) return invalid();
    for (const row of data.conversation.rows) if (!record(row) || !identifier(row.requestId) || !Number.isSafeInteger(row.revision) || !record(row.receipt) || row.receipt.conversationId !== conversationId) return invalid();
    return data as unknown as ClientSnapshot;
  }
  /** Recovers a retained send by ID, including outside the recent conversation window; never resends. */
  async request(requestId: string, signal?: AbortSignal): Promise<ClientRequest> {
    const data = await this.call(`/requests/${id(requestId)}`, "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-request/v1" || !identifier(data.conversationId) || !record(data.receipt) || !record(data.row) || !identifier(data.row.requestId) || data.row.requestId !== data.receipt.rootRequestId || !record(data.row.receipt) || data.row.receipt.rootRequestId !== data.row.requestId || data.row.receipt.conversationId !== data.conversationId) return invalid();
    this.receipt(data.receipt, { requestId, conversationId: data.conversationId });
    return data as unknown as ClientRequest;
  }
  /** Metadata invalidates snapshots; only a fresh snapshot can supply result/evidence/approval content. */
  async events(conversationId: string, after: number, signal?: AbortSignal): Promise<ClientEvents> {
    id(conversationId);
    if (!Number.isSafeInteger(after) || after < 0) throw new JitClientError("cursor_invalid", null, "not_sent");
    const data = await this.call(`/conversations/${conversationId}/events?after=${after}`, "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-events/v1" || data.conversationId !== conversationId || !Number.isSafeInteger(data.cursor) || (data.cursor as number) < after || !Array.isArray(data.events) || data.events.length > 64) return invalid();
    let cursor = after;
    for (const event of data.events) {
      if (!record(event) || event.conversationId !== conversationId || !identifier(event.requestId) || !Number.isSafeInteger(event.sequence) || (event.sequence as number) <= cursor) return invalid();
      cursor = event.sequence as number;
    }
    if (data.cursor !== cursor) return invalid();
    return data as unknown as ClientEvents;
  }
  /** Stops only the named work. The acknowledgement does not certify external process/effect settlement. */
  async stop(requestId: string, signal?: AbortSignal): Promise<void> {
    const data = await this.call(`/requests/${id(requestId)}/stop`, "POST", {}, signal, requestId);
    if (!record(data) || data.state !== "stop_requested") throw new JitClientError("client_protocol_invalid", null, "unknown", requestId);
  }
  /** Explicit exact-slip command; never auto-refreshes an action revision or repeats a decision. */
  async decide(command: ClientDecision, signal?: AbortSignal): Promise<ClientReceipt> {
    const input = structuredClone(command); id(input.requestId); id(input.conversationId);
    return this.receipt(await this.call(`/conversations/${input.conversationId}/decisions`, "POST", input, signal, input.requestId), input);
  }
  /** Commit metadata once. Retain input.requestId until the original upload identity is recovered. */
  async createUpload(command: FileUploadCommand, signal?: AbortSignal): Promise<FileUpload> {
    const input = structuredClone(command); id(input.requestId); id(input.conversationId);
    return this.uploadResponse(await this.call(`/conversations/${input.conversationId}/uploads`, "POST", input, signal, input.requestId), input.requestId);
  }
  /** Stream exact bytes once; an uncertain reply is recovered with uploadStatus, never automatic replay. */
  async uploadBytes(uploadId: string, bytes: Uint8Array, signal?: AbortSignal): Promise<FileUpload> {
    const input = new Uint8Array(bytes);
    return this.uploadResponse(await this.call(`/uploads/${id(uploadId)}/bytes`, "POST", undefined, signal, uploadId, input), undefined, uploadId, true);
  }
  /** Recover lifecycle without creating a new upload or starting work. */
  async uploadStatus(uploadId: string, signal?: AbortSignal): Promise<FileUpload> {
    return this.uploadResponse(await this.call(`/uploads/${id(uploadId)}`, "GET", undefined, signal), undefined, uploadId);
  }
  /** Cancel staging or withdraw a source and its future publications; never restarts a transfer. */
  async withdrawUpload(uploadId: string, signal?: AbortSignal): Promise<FileUpload> {
    return this.uploadResponse(await this.call(`/uploads/${id(uploadId)}/withdraw`, "POST", {}, signal, uploadId), undefined, uploadId, true);
  }
  /** Cookie-authenticated, freshly guarded attachment route; no bearer token or host path enters the URL. */
  artifactUrl(requestId: string, artifactId: string): string { return `${this.origin}/api/s16/client/requests/${id(requestId)}/artifacts/${id(artifactId)}`; }
  /** Reacquire publication permission and verify exact bounded immutable bytes before preview/download. */
  async artifactBytes(artifact: FileArtifact, signal?: AbortSignal): Promise<Uint8Array> {
    const generation = this.#sessionGeneration;
    if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > 1024 * 1024 || !/^[a-f0-9]{64}$/.test(artifact.sha256)) return invalid();
    let response: Response;
    try { response = await this.#fetch(new Request(this.artifactUrl(artifact.requestId, artifact.id), { credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", ...(signal ? { signal } : {}) })); }
    catch { throw new JitClientError("connection_lost", null, "not_sent"); }
    if (generation !== this.#sessionGeneration) { await response.body?.cancel().catch(() => {}); throw new JitClientError("client_response_stale", response.status, "response"); }
    if (response.status === 401 || response.status === 403) {
      this.clear(); const current = this.#sessionGeneration;
      let code = response.status === 401 ? "authentication_required" : "authorization_required";
      try { const data = await this.json(response, "GET", null); const reason = safeCode(record(data) ? data.error : null); if (reason !== "client_unavailable") code = reason; } catch { /* The status still establishes that private content must be withheld. */ }
      if (current !== this.#sessionGeneration) throw new JitClientError("client_response_stale", response.status, "response");
      throw new JitClientError(code, response.status, "response");
    }
    if (!response.ok || response.redirected || response.headers.get("content-type") !== "application/octet-stream" || response.headers.get("x-content-sha256") !== artifact.sha256) { await response.body?.cancel(); throw new JitClientError("artifact_unavailable", response.status, "response"); }
    const reader = response.body?.getReader(); if (!reader) return invalid();
    const bytes = new Uint8Array(artifact.bytes); let offset = 0;
    try { for (;;) { const value = await reader.read(); if (value.done) break; if (offset + value.value.length > bytes.length) { await reader.cancel(); return invalid(); } bytes.set(value.value, offset); offset += value.value.length; } }
    finally { reader.releaseLock(); }
    const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
    if (signal?.aborted) throw new JitClientError("aborted", null, "not_sent");
    if (generation !== this.#sessionGeneration) throw new JitClientError("client_response_stale", response.status, "response");
    if (offset !== artifact.bytes || checksum !== artifact.sha256) return invalid();
    return bytes;
  }
  /** Same-origin, script-free HTML viewer URL for an iframe; the server refuses any other request context. */
  artifactPreviewUrl(artifact: FileArtifact): string { return `${this.artifactUrl(artifact.requestId, artifact.id)}/preview`; }
  /** Current library page. Reading never changes an artifact, its sources or its publication. */
  async artifacts(query: ClientArtifactQuery, signal?: AbortSignal): Promise<ClientArtifactList> {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q); if (query.type !== "all") params.set("type", query.type);
    if (query.conversation !== null) params.set("conversation", id(query.conversation)); if (query.before !== null) params.set("before", query.before);
    const data = await this.call(`/artifacts${params.size ? "?" + params : ""}`, "GET", undefined, signal);
    const echo = record(data) ? data.query : null;
    if (!record(data) || data.contract !== "s16-client-artifacts/v1" || !record(echo) || echo.q !== query.q || echo.type !== query.type || echo.conversation !== query.conversation || echo.before !== query.before || data.limit !== 50
      || !Array.isArray(data.items) || data.items.length > 50 || data.items.some(item => !this.artifactItem(item)) || data.next !== null && (typeof data.next !== "string" || !/^\d{1,16}\.[A-Za-z0-9_-]{1,128}$/.test(data.next))) return invalid();
    return data as unknown as ClientArtifactList;
  }
  /** Fresh provenance/revision detail for one committed artifact. */
  async artifact(artifactId: string, signal?: AbortSignal): Promise<ClientArtifactDetail> {
    const data = await this.call(`/artifacts/${id(artifactId)}`, "GET", undefined, signal);
    if (!record(data) || data.contract !== "s16-client-artifact/v1" || !this.artifactItem(data.item) || (data.item as unknown as ClientArtifactItem).artifact.id !== artifactId || !["escaped_text", "sandboxed_html"].includes(data.preview as string)
      || !Array.isArray(data.inputs) || data.inputs.length > 8 || data.inputs.some(input => !record(input) || !identifier(input.id) || typeof input.name !== "string" || typeof input.mime !== "string" || !count(input.bytes) || !sha256(input.sha256) || input.origin !== null && !identifier(input.origin))
      || !Array.isArray(data.revisions) || data.revisions.length > 256 || data.revisions.some(item => !this.artifactItem(item))) return invalid();
    return data as unknown as ClientArtifactDetail;
  }
  /**
   * Explicitly copy one exact committed artifact into a ready input of its conversation. It starts no work;
   * the owner still sends a message. An unknown outcome may resend the same command: the service returns the
   * original input for the same request ID and refuses a changed payload.
   */
  async artifactInput(artifactId: string, command: ClientArtifactInputCommand, signal?: AbortSignal): Promise<FileUpload> {
    const input = structuredClone(command); id(artifactId); id(input.requestId); id(input.conversationId);
    if (!sha256(input.sha256)) throw new JitClientError("invalid_file_metadata", null, "not_sent", input.requestId);
    const upload = this.uploadResponse(await this.call(`/artifacts/${artifactId}/inputs`, "POST", input, signal, input.requestId), input.requestId);
    if (upload.conversationId !== input.conversationId || upload.state === "ready" && upload.receipt?.sha256 !== input.sha256) throw new JitClientError("client_protocol_invalid", null, "unknown", input.requestId);
    return upload;
  }
  private artifactItem(value: unknown): boolean {
    if (!record(value) || !record(value.artifact)) return false;
    const artifact = value.artifact;
    return artifact.contract === "s16-file-artifact/v1" && identifier(artifact.id) && sha256(artifact.sha256) && identifier(artifact.requestId) && identifier(artifact.workId) && identifier(artifact.conversationId) && artifact.conversationId === value.conversationId
      && typeof artifact.name === "string" && !!artifact.name && ["text/plain", "text/markdown", "text/csv", "text/html"].includes(artifact.mime as string) && Number.isSafeInteger(artifact.bytes) && (artifact.bytes as number) > 0 && count(artifact.createdAt)
      && typeof value.label === "string" && Array.from(value.label).length <= 120 && Number.isSafeInteger(value.revision) && (value.revision as number) >= 1 && (value.parent === null || identifier(value.parent)) && Number.isSafeInteger(value.inputs) && (value.inputs as number) >= 1;
  }
  /** Owner memory search; reading never changes retrieval, ranking or retention. */
  async memory(query: ClientMemoryQuery, signal?: AbortSignal): Promise<ClientMemoryList> {
    const params = new URLSearchParams();
    if (query.q) params.set("q", query.q); if (query.kind !== "all") params.set("kind", query.kind); if (query.category !== "all") params.set("category", query.category);
    if (query.state !== "active") params.set("state", query.state); if (query.bot !== null) params.set("bot", id(query.bot)); if (query.offset) params.set("offset", String(query.offset));
    const data = await this.call(`/memory${params.size ? "?" + params : ""}`, "GET", undefined, signal);
    const echo = record(data) ? data.query : null;
    if (!record(data) || data.contract !== "s16-client-memory/v1" || !record(echo) || typeof echo.q !== "string" || !["all", "fact", "inference"].includes(echo.kind as string) || !["all", "fact", "preference", "working_knowledge"].includes(echo.category as string) || !["active", "inactive", "all"].includes(echo.state as string) || echo.bot !== null && !identifier(echo.bot) || !count(echo.offset) || !count(data.total) || data.limit !== 50 || !Array.isArray(data.items) || data.items.length > 50 || !Array.isArray(data.bots) || data.bots.some(bot => !identifier(bot))) return invalid();
    for (const entry of data.items) if (!this.memoryItem(entry)) return invalid();
    return data as unknown as ClientMemoryList;
  }
  /** Fresh owner detail for one item, including file-source state and correction chain labels. */
  async memoryDetail(claimId: string, signal?: AbortSignal): Promise<ClientMemoryDetail> {
    const data = await this.call(`/memory/${id(claimId)}`, "GET", undefined, signal);
    const uses = record(data) ? data.uses : null;
    if (!record(data) || data.contract !== "s16-client-memory-detail/v1" || !this.memoryItem(data.item) || data.item.id !== claimId || typeof data.item.text !== "string" || typeof data.item.quote !== "string" || data.item.text.length > 2048 || data.item.quote.length > 2048
      || !Array.isArray(data.files) || data.files.length > 128 || data.files.some(file => !record(file) || !identifier(file.sourceId) || !sha256(file.sha256) || file.representationSha256 !== null && !sha256(file.representationSha256) || typeof file.current !== "boolean")
      || !Array.isArray(data.chain) || data.chain.length > 64 || data.chain.some(entry => !this.memoryItem(entry)) || !record(uses) || !["contexts", "summaries", "artifacts", "workItems"].every(key => count(uses[key]))) return invalid();
    return data as unknown as ClientMemoryDetail;
  }
  /**
   * Explicit exact-revision memory command. It never retries. After an unknown outcome the caller may
   * send the same retained command again: MEM returns the original receipt or refuses a changed payload.
   */
  async memoryCommand(command: ClientMemoryCommand, signal?: AbortSignal): Promise<ClientMemoryResult> {
    const input = structuredClone(command); id(input.requestId); id(input.claim.id);
    if (input.contract !== "s15-memory-command/v1" || !Number.isSafeInteger(input.claim.revision) || input.claim.revision < 1 || input.kind === "memory.correct" && (typeof input.text !== "string" || !input.text.trim() || input.text.length > 2048)) throw new JitClientError("invalid_memory_command", null, "not_sent", input.requestId);
    const data = await this.call("/memory/commands", "POST", input, signal, input.requestId);
    const unknown = () => new JitClientError("client_protocol_invalid", null, input.kind === "memory.impact" ? "response" : "unknown", input.requestId);
    const impact = record(data) ? data.impact : null;
    if (!record(data) || !record(impact) || !["claims", "sources", "summaries", "artifacts", "contexts", "nativeSessions", "workItems"].every(key => count(impact[key])) || !record(data.claim) && data.claim !== null || record(data.claim) && (!identifier(data.claim.id) || !Number.isSafeInteger(data.claim.revision) || (data.claim.revision as number) < 1)) throw unknown();
    if (input.kind === "memory.impact") { if (data.contract !== "s15-memory-impact/v1" || !record(data.claim) || data.claim.id !== input.claim.id || data.claim.revision !== input.claim.revision) throw unknown(); }
    else if (data.contract !== "s15-memory-receipt/v1" || data.requestId !== input.requestId || data.kind !== input.kind || input.kind === "memory.correct" && (!record(data.claim) || !identifier(data.claim.id))) throw unknown();
    return data as unknown as ClientMemoryResult;
  }
  /** Complete item shape check, so malformed data fails as `client_protocol_invalid` instead of rendering. */
  private memoryItem(value: unknown): value is Record<string, unknown> {
    if (!record(value) || !identifier(value.id) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1) return false;
    const scope = value.scope, source = value.source, link = (entry: unknown) => entry === null || identifier(entry);
    return ["fact", "inference"].includes(value.kind as string) && ["fact", "preference", "working_knowledge"].includes(value.category as string) && ["owner_stated", "observed", "unconfirmed"].includes(value.confirmation as string)
      && ["active", "superseded", "forgotten", "withdrawn"].includes(value.state as string) && typeof value.snippet === "string" && Array.from(value.snippet).length <= 280
      && record(scope) && (scope.kind === "team" && Object.keys(scope).length === 1 || scope.kind === "bot" && identifier(scope.botId))
      && record(source) && ["owner_message", "work", "historical"].includes(source.kind as string) && (source.conversationId === null || identifier(source.conversationId)) && count(source.at) && count(source.files)
      && link(value.supersedes) && link(value.correction) && count(value.createdAt) && (value.lastUsedAt === null || count(value.lastUsedAt)) && count(value.contexts);
  }
  /** Drop authority material when a native session signs out; callers also discard private projections. */
  clear(): void { this.#csrf = null; this.#sessionGeneration++; }
  private uploadResponse(data: unknown, requestId?: string, uploadId?: string, mutation = false): FileUpload {
    const malformed = () => new JitClientError("client_protocol_invalid", null, requestId || mutation ? "unknown" : "response", requestId ?? uploadId ?? null);
    if (!record(data) || data.contract !== "s16-file-upload/v1" || !identifier(data.id) || requestId && data.requestId !== requestId || uploadId && data.id !== uploadId || !identifier(data.conversationId) || typeof data.state !== "string" || !["created", "uploading", "validating", "ready", "rejected", "cancelled", "expired", "withdrawn"].includes(data.state)) throw malformed();
    const positive = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
    const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
    if (data.state === "ready") {
      const receipt = data.receipt;
      if (!record(receipt) || typeof receipt.contract !== "string" || !["s16-file-receipt/v1", "s16-file-receipt/v2"].includes(receipt.contract) || receipt.id !== data.id || receipt.conversationId !== data.conversationId || !sha(receipt.sha256) || receipt.sha256 !== data.expectedHash || !positive(receipt.bytes) || receipt.bytes !== data.bytes || typeof receipt.name !== "string" || !receipt.name || receipt.expiresAt !== null && !positive(receipt.expiresAt)) throw malformed();
      if (receipt.contract === "s16-file-receipt/v1") { if (receipt.mime !== "text/plain") throw malformed(); }
      else {
        const representation = receipt.representation;
        if (receipt.validation !== "s16-isolated-file/v1" || typeof receipt.parserGeneration !== "string" || !receipt.parserGeneration || receipt.parserGeneration.length > 4096 || !record(representation) || !sha(representation.sha256) || !positive(representation.bytes)) throw malformed();
        if (receipt.mime === "application/pdf") {
          if (representation.mime !== "text/plain" || !positive(representation.pages) || [representation.width, representation.height, representation.originalWidth, representation.originalHeight].some(value => value !== null)) throw malformed();
        } else if (!["image/png", "image/jpeg"].includes(receipt.mime as string) || !["image/png", "image/jpeg"].includes(representation.mime as string) || representation.pages !== null || [representation.width, representation.height, representation.originalWidth, representation.originalHeight].some(value => !positive(value))) throw malformed();
      }
    }
    return data as unknown as FileUpload;
  }
  private receipt(data: unknown, command: { requestId: string; conversationId: string }): ClientReceipt {
    if (!record(data) || data.contract !== "s15-conversation-receipt/v1" || data.requestId !== command.requestId || data.conversationId !== command.conversationId || !identifier(data.rootRequestId) || !Number.isSafeInteger(data.receivedAt)) throw new JitClientError("client_protocol_invalid", null, "unknown", command.requestId);
    return data as unknown as ClientReceipt;
  }
  private async call(path: string, method: "GET" | "POST", body: unknown, signal?: AbortSignal, requestId: string | null = null, raw?: Uint8Array): Promise<unknown> {
    const generation = this.#sessionGeneration;
    if (method === "POST" && !this.#csrf) throw new JitClientError("client_not_initialized", null, "not_sent", requestId);
    if (signal?.aborted) throw new JitClientError("aborted", null, "not_sent", requestId);
    const headers: Record<string, string> = { accept: "application/json" };
    if (method === "POST") { headers["content-type"] = raw ? "application/octet-stream" : "application/json"; headers["x-csrf-token"] = this.#csrf!; }
    const request = new Request(`${this.origin}/api/s16/client${path}`, { method, headers, credentials: "same-origin", mode: "same-origin", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", ...(signal ? { signal } : {}), ...(raw ? { body: new Uint8Array(raw).buffer } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    let response: Response;
    try { response = await this.#fetch(request); }
    catch { throw new JitClientError(signal?.aborted ? "aborted" : "connection_lost", null, method === "POST" ? "unknown" : "not_sent", requestId); }
    if (generation !== this.#sessionGeneration) { await response.body?.cancel().catch(() => {}); throw new JitClientError("client_response_stale", response.status, method === "POST" ? "unknown" : "response", requestId); }
    if (response.status === 401 || response.status === 403) this.clear();
    const responseGeneration = this.#sessionGeneration;
    const data = await this.json(response, method, requestId);
    if (responseGeneration !== this.#sessionGeneration) throw new JitClientError("client_response_stale", response.status, method === "POST" ? "unknown" : "response", requestId);
    if (!response.ok) throw new JitClientError(safeCode(record(data) ? data.error : null), response.status, "response", requestId);
    return data;
  }
  private async json(response: Response, method: "GET" | "POST", requestId: string | null): Promise<unknown> {
    if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json" || response.redirected) throw new JitClientError("client_protocol_invalid", response.status, method === "POST" ? "unknown" : "response", requestId);
    const reader = response.body?.getReader(); if (!reader) throw new JitClientError("client_protocol_invalid", response.status, method === "POST" ? "unknown" : "response", requestId);
    let data: unknown;
    try {
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > clientResponseBytes) { await reader.cancel(); throw new JitClientError("client_response_limit", response.status, method === "POST" ? "unknown" : "response", requestId); } chunks.push(chunk.value); }
      const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch (error) { if (error instanceof JitClientError) throw error; throw new JitClientError("client_protocol_invalid", response.status, method === "POST" ? "unknown" : "response", requestId); }
    finally { reader.releaseLock(); }
    return data;
  }
}
