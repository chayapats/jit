import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Server } from "bun";
import type { Application, OwnerActor } from "../application";
import { AppError } from "../errors";
import { FixedWindowRate, browserRequest, constantTimeEqual, readCappedBody } from "../security/inbound";

/**
 * app.local_api/v1 — the owner's loopback API (REL06, ADR 0035, FR-32).
 *
 * While the owner keeps `local_api.set { enabled: true }`, the service binds `127.0.0.1` on a free port and writes
 * `url`, `token` and `headers` to `<data>/local-api/` (folder 0700, files 0600). Every start rotates the token;
 * turning the API off or stopping the service removes the files. Each request passes, in this order:
 *
 * 1. a browser check: any `Origin` or `Sec-Fetch-Site` header, or a `Host` that is not this loopback listener → 403;
 * 2. a body cap → 413;
 * 3. a rate cap over a fixed window → 429;
 * 4. a constant-time bearer token compare → 401;
 * 5. one route of {@link localApiRoutes}, each of which is an existing owner command or query.
 *
 * The API acts as the owner's Web session and nothing more: no route changes roles, routes, access or
 * configuration, and nothing runs a command on the host.
 */

/** Finite operator limits of the listener. */
export interface LocalApiLimits {
  /** Largest request body in bytes. */
  bodyBytes: number;
  /** Requests admitted per rate window, counted after the browser and body checks. */
  requests: number;
  windowMs: number;
  /** Longest server-side wait of one `GET /v1/replies/:id?wait=` call. */
  waitMs: number;
  /** How long a client retry key replays its receipt. */
  retryKeyMs: number;
}
export const localApiLimits: LocalApiLimits = Object.freeze({ bodyBytes: 16384, requests: 30, windowMs: 60_000, waitMs: 25_000, retryKeyMs: 24 * 60 * 60 * 1000 });

/** One route and the existing owner command or Application read it maps onto. */
export interface LocalApiRoute { method: "GET" | "POST"; path: string; maps: string; write: boolean }

/**
 * The complete route table. Write routes answer `202` with the receipt id. Proposals are dispatch proposals only:
 * accepting one starts read-only specialist analysis the owner chose; role and promotion proposals stay in Web.
 */
export const localApiRoutes: readonly LocalApiRoute[] = Object.freeze([
  { method: "POST", path: "/v1/topics/:topic/messages", maps: "message.send", write: true },
  { method: "GET", path: "/v1/replies/:receipt", maps: "Application.replies", write: false },
  { method: "GET", path: "/v1/pending", maps: "Application.pendingActions", write: false },
  { method: "POST", path: "/v1/proposals/:proposal/accept", maps: "dispatch.proposal.accept", write: true },
  { method: "POST", path: "/v1/proposals/:proposal/dismiss", maps: "dispatch.proposal.dismiss", write: true },
] as const);

/** The token comparison, an object so tests can observe whether it ran. */
export const tokenCheck = {
  /** Constant-time compare of the supplied bearer value against the listener token. */
  verify(expected: string, supplied: string | null): boolean {
    if (supplied === null) return false;
    return constantTimeEqual(expected, supplied);
  },
};

/** Where the listener's files live for a database: `<data>/local-api/`, `<data>` being the database folder. */
export const localApiDirectory = (databasePath: string) => join(dirname(databasePath), "local-api");
export const localApiFiles = Object.freeze(["url", "token", "headers"] as const);

/** Request id of a write route: derived from the client retry key, so a retry replays the same receipt. */
export function localApiRequestId(clientRequestId: string | null): string {
  if (clientRequestId === null) return `lapi_${randomBytes(24).toString("hex")}`;
  return `lapi_${createHash("sha256").update(`jit.local_api.v1:${clientRequestId}`).digest("hex").slice(0, 48)}`;
}
const clientKey = /^[A-Za-z0-9._:-]{1,128}$/;
const uuid = "[a-f0-9-]{36}";

/** What the CLI and scripts read: `done`, `running`, `waiting_on_owner` or `failed`. */
export type ReplyOutcome = "done" | "running" | "waiting_on_owner" | "failed";

export interface LocalApiHandlerOptions {
  app: Application;
  /** The actor issued for this listener start. */
  actor: OwnerActor;
  token: string;
  port: number;
  limits?: LocalApiLimits;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

/** Builds the request pipeline of one listener start. */
export function createLocalApiHandler(options: LocalApiHandlerOptions): (request: Request) => Promise<Response> {
  const { app, actor, token, port } = options;
  const limits = options.limits ?? localApiLimits, now = options.now ?? Date.now, sleep = options.sleep ?? Bun.sleep;
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const rate = new FixedWindowRate(limits, now);
  const routes = localApiRoutes.map(route => ({ ...route, pattern: new RegExp(`^${route.path.replace(/:[a-z]+/g, "([A-Za-z0-9_-]{1,128})")}$`) }));

  return async request => {
    // 1. Browser and DNS-rebinding check, before anything reads the body or the token.
    const host = request.headers.get("host");
    if (browserRequest(request) || host === null || !hosts.has(host)) {
      return json({ error: "origin_rejected" }, 403);
    }
    // 2. Body cap (shared inbound guard). Only POST bodies are read; any declared oversize body is refused.
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > limits.bodyBytes)) return json({ error: "request_too_large" }, 413);
    const raw = request.method === "POST" ? await readCappedBody(request, limits.bodyBytes) : new Uint8Array();
    if (raw === null) return json({ error: "request_too_large" }, 413);
    // 3. Rate cap over a fixed window.
    const admitted = rate.admit();
    if (!admitted.ok) return json({ error: "rate_limited" }, 429, { "Retry-After": String(admitted.retryAfterSeconds) });
    // 4. Token.
    const authorization = request.headers.get("authorization");
    const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
    if (!tokenCheck.verify(token, supplied)) return json({ error: "authentication_required" }, 401);
    // 5. Route.
    const url = new URL(request.url);
    const match = routes.map(route => ({ route, found: route.method === request.method ? route.pattern.exec(url.pathname) : null })).find(item => item.found);
    if (!match) {
      const known = routes.some(route => route.pattern.test(url.pathname));
      return json({ error: known ? "method_not_allowed" : "not_found" }, known ? 405 : 404);
    }
    try {
      let body: Record<string, unknown> = {};
      if (match.route.write) {
        try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
        catch { throw new AppError("invalid_body"); }
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("invalid_body");
      } else if (request.method === "POST") throw new AppError("invalid_body");
      const id = match.found![1] ?? "";
      switch (match.route.maps) {
        case "message.send": return send(id, body);
        case "Application.replies": return await replyStatus(id, url.searchParams);
        case "Application.pendingActions": {
          if ([...url.searchParams.keys()].length) throw new AppError("invalid_query");
          return json(app.pendingActions(actor, 50));
        }
        default: return proposal(match.route.maps as "dispatch.proposal.accept" | "dispatch.proposal.dismiss", id, body);
      }
    } catch (error) {
      if (error instanceof AppError) return json({ error: error.code }, error.status);
      return json({ error: "request_failed" }, 500);
    }
  };

  function retryKey(body: Record<string, unknown>): string | null {
    const value = body.clientRequestId;
    if (value === undefined) return null;
    if (typeof value !== "string" || !clientKey.test(value)) throw new AppError("invalid_client_request_id");
    return value;
  }

  /** `POST /v1/topics/:topic/messages` → `message.send`. The retry key replays the same receipt for 24 hours. */
  function send(target: string, body: Record<string, unknown>): Response {
    if (Object.keys(body).some(key => key !== "text" && key !== "clientRequestId")) throw new AppError("invalid_body");
    if (typeof body.text !== "string") throw new AppError("invalid_message");
    const text = body.text, requestId = localApiRequestId(retryKey(body));
    const scope = () => {
      if (target === "general") {
        const general = app.generalSpace(actor);
        if (!general) throw new AppError("setup_incomplete", 409);
        return app.topicScope(actor, general.topicId);
      }
      if (!new RegExp(`^${uuid}$`).test(target)) throw new AppError("topic_not_found", 404);
      return app.topicScope(actor, target);
    };
    let last: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const { project, topic } = scope();
      const replay = app.messageReceipt(actor, requestId);
      if (replay) {
        if (replay.committedAt + limits.retryKeyMs <= now()) throw new AppError("retry_key_expired", 409);
        const message = replay.receipt.message;
        if (message.topicId !== topic.id || (message.text !== null && message.text !== text)) throw new AppError("request_id_conflict", 409);
        return json({ receiptId: requestId, replayed: true, projectId: message.projectId, topicId: message.topicId, messageId: message.id }, 202);
      }
      try {
        const receipt = app.execute(actor, { kind: "message.send", requestId, projectId: project.id, expectedRevision: topic.revision,
          payload: { topicId: topic.id, text } });
        return json({ receiptId: requestId, replayed: false, projectId: project.id, topicId: topic.id, messageId: receipt.message.id }, 202);
      } catch (error) {
        // A concurrent retry with the same key, or another owner message, moved the topic: read again.
        if (error instanceof AppError && (error.code === "stale_revision" || error.code === "request_id_conflict")) { last = error; continue; }
        throw error;
      }
    }
    throw last;
  }

  /** `GET /v1/replies/:receipt[?wait=seconds]`: Jit's reply to the message a receipt committed. */
  async function replyStatus(receiptId: string, query: URLSearchParams): Promise<Response> {
    if ([...query.keys()].some(key => key !== "wait") || query.getAll("wait").length > 1) throw new AppError("invalid_query");
    const rawWait = query.get("wait") ?? "0";
    if (!/^\d{1,3}$/.test(rawWait)) throw new AppError("invalid_query");
    const deadline = now() + Math.min(Number(rawWait) * 1000, limits.waitMs);
    const found = app.messageReceipt(actor, receiptId);
    if (!found) throw new AppError("receipt_not_found", 404);
    const { message } = found.receipt;
    for (;;) {
      const view = replyView(receiptId, message.projectId, message.topicId, message.id);
      if (view.outcome !== "running" || now() >= deadline) return json(view);
      await sleep(Math.min(250, Math.max(1, deadline - now())));
    }
  }

  function replyView(receiptId: string, projectId: string, topicId: string, messageId: string) {
    const reply = app.replies(actor, projectId, topicId, [messageId]).get(messageId) ?? null;
    let answer: string | null = null;
    const pending: { kind: "dispatch" | "role" | "promotion"; id: string; revision: number }[] = [];
    if (reply?.state === "answered" && reply.replyMessageId && reply.replySequence !== null) {
      answer = app.conversation(actor, projectId, topicId, reply.replySequence - 1).items.find(item => item.id === reply.replyMessageId)?.text ?? null;
      const card = app.dispatchCards(actor, projectId, topicId, [reply.replyMessageId]).get(reply.replyMessageId);
      if (card?.state === "proposed") pending.push({ kind: "dispatch", id: card.id, revision: card.revision });
      for (const item of reply.roleProposals) if (item.state === "proposed") pending.push({ kind: "role", id: item.id, revision: item.revision });
      for (const item of reply.promotionProposals) if (item.state === "proposed") pending.push({ kind: "promotion", id: item.id, revision: item.revision });
    }
    const outcome: ReplyOutcome = !reply ? "failed" : (reply.state === "thinking" || reply.state === "queued") ? "running"
      : reply.state === "blocked" || (reply.state === "answered" && pending.length) ? "waiting_on_owner"
        : reply.state === "answered" ? "done" : "failed";
    return { receiptId, projectId, topicId, messageId, outcome, answer, pending,
      reply: reply ? { id: reply.id, state: reply.state, reason: reply.reason, nextAction: reply.nextAction, revision: reply.revision, replyMessageId: reply.replyMessageId } : null };
  }

  /** `POST /v1/proposals/:proposal/(accept|dismiss)` → the dispatch proposal command at the exact revision. */
  function proposal(kind: "dispatch.proposal.accept" | "dispatch.proposal.dismiss", proposalId: string, body: Record<string, unknown>): Response {
    const allowed = kind === "dispatch.proposal.accept" ? ["revision", "roleIds", "clientRequestId"] : ["revision", "clientRequestId"];
    if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError("invalid_body");
    if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1) throw new AppError("invalid_revision");
    if (!new RegExp(`^${uuid}$`).test(proposalId)) throw new AppError("dispatch_proposal_not_found", 404);
    const requestId = localApiRequestId(retryKey(body)), projectId = app.dispatchProposalProject(actor, proposalId);
    const expectedRevision = body.revision as number;
    const receipt = kind === "dispatch.proposal.dismiss"
      ? app.execute(actor, { kind, requestId, projectId, expectedRevision, payload: { proposalId } })
      : app.execute(actor, { kind, requestId, projectId, expectedRevision, payload: { proposalId,
        roleIds: body.roleIds === undefined ? app.dispatchCard(actor, projectId, proposalId).roles.map(role => role.roleId) : body.roleIds as string[] } });
    return json({ receiptId: requestId, proposal: { id: receipt.proposal.id, state: receipt.proposal.state, revision: receipt.proposal.revision } }, 202);
  }
}

/** Writes one owner-only file atomically: a 0600 temporary file, then a rename. */
function writePrivate(directory: string, name: string, content: string): void {
  const temporary = join(directory, `.${name}.${randomBytes(6).toString("hex")}`);
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, join(directory, name));
}

/**
 * Removes the listener files (and the folder when it is empty). Missing files are fine. Only a real folder is
 * touched: through a symlink the files would belong to another folder, so nothing is removed there.
 */
export function removeLocalApiFiles(directory: string): void {
  let stat;
  try { stat = lstatSync(directory); } catch { return; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  for (const name of localApiFiles) rmSync(join(directory, name), { force: true });
  try { rmdirSync(directory); } catch { /* Not empty or already gone. */ }
}

export interface LocalApiListenerOptions {
  app: Application;
  /** `<data>/local-api/`; see {@link localApiDirectory}. */
  directory: string;
  limits?: LocalApiLimits;
  now?: () => number;
  /** How often the listener follows the owner setting. */
  intervalMs?: number;
}

/**
 * Follows the owner setting: binds `127.0.0.1` on a free port only while the API is on and writes the three
 * files; stops and removes them when it is turned off or the service stops. A new setting revision or owner
 * credential generation restarts it with a new token.
 */
export class LocalApiListener {
  #options: LocalApiListenerOptions;
  #server: Server<undefined> | null = null;
  #identity: string | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #cleaned = false;

  constructor(options: LocalApiListenerOptions) { this.#options = options; }

  /** The bound URL while running, or null. */
  get url(): string | null { return this.#server ? `http://127.0.0.1:${this.#server.port}` : null; }

  /** Reconciles once, then keeps following the setting until {@link stop}. */
  start(): void {
    this.#timer ??= setInterval(() => { try { this.reconcile(); } catch { /* Storage unavailable: the next tick retries; requests fail closed. */ } }, this.#options.intervalMs ?? 500);
    this.#timer.unref?.();
    this.reconcile();
  }

  /** One step: start, restart or stop the listener to match the current setting. */
  reconcile(): void {
    const issued = this.#options.app.issueLocalApiActor();
    const identity = issued ? `${issued.generation}:${issued.revision}` : null;
    if (identity === this.#identity && (identity === null ? this.#cleaned : this.#server)) return;
    this.#close();
    if (!issued) return;
    const directory = this.#options.directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new AppError("local_api_directory_invalid", 500);
    chmodSync(directory, 0o700);
    const token = randomBytes(32).toString("base64url");
    const limits = this.#options.limits ?? localApiLimits;
    let handler: ((request: Request) => Promise<Response>) | null = null;
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: limits.bodyBytes * 2, idleTimeout: Math.ceil(limits.waitMs / 1000) + 10,
      fetch: request => handler!(request), error: () => json({ error: "request_failed" }, 500) });
    handler = createLocalApiHandler({ app: this.#options.app, actor: issued.actor, token, port: server.port!, limits, ...(this.#options.now ? { now: this.#options.now } : {}) });
    this.#server = server;
    this.#identity = identity;
    try {
      writePrivate(directory, "token", `${token}\n`);
      writePrivate(directory, "headers", `${JSON.stringify({ Authorization: `Bearer ${token}` })}\n`);
      writePrivate(directory, "url", `http://127.0.0.1:${server.port}\n`);
    } catch (error) { this.#close(); throw error; }
  }

  /** Stops following the setting, stops the listener and removes its files. */
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const server = this.#server;
    this.#close();
    await server?.stop(true);
  }

  #close(): void {
    const server = this.#server;
    this.#server = null; this.#identity = null;
    if (server) void server.stop(true);
    removeLocalApiFiles(this.#options.directory);
    this.#cleaned = true;
  }
}
