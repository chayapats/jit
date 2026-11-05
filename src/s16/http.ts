import { AppError } from "../errors";
import type { ConversationApplication, ConversationHttpAuthentication } from "../s15/conversation";
import { conversationList, conversationOwnerView, conversationPendingNeeds, conversationRequestView } from "../s15/conversation/owner-view";
import { exact, parseCommandJson } from "../s15/conversation/validation";
import { clientResponseBytes, type ClientBootstrap, type ClientCapabilities } from "./client/contracts";

/** Protected shared client adapter. It adds no engine, database, approval authority or automatic retry. */
export function createS16ClientHandler<Actor, Work>(app: ConversationApplication<Actor, Work>, options: { origin: string; cookieName: string; authentication: ConversationHttpAuthentication<Actor> }): (request: Request) => Promise<Response> {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || !/^[A-Za-z0-9_-]+$/.test(options.cookieName)) throw new AppError("invalid_configuration");
  const json = (value: unknown, status = 200): Response => {
    let text = JSON.stringify(value);
    if (Buffer.byteLength(text) > clientResponseBytes) { status = 413; text = JSON.stringify({ error: "client_response_limit" }); }
    return new Response(text, { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer", Vary: "Cookie" } });
  };
  const body = async (request: Request): Promise<unknown> => {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new AppError("unsupported_content_type", 415);
    const reader = request.body?.getReader(); if (!reader) throw new AppError("invalid_body");
    try {
      const chunks: Uint8Array[] = []; let length = 0;
      for (;;) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.length; if (length > 32768) { await reader.cancel(); throw new AppError("body_too_large", 413); } chunks.push(chunk.value); }
      try { return parseCommandJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
      catch { throw new AppError("invalid_body"); }
    } finally { reader.releaseLock(); }
  };
  const capabilities = (): ClientCapabilities => ({ contract: "s16-client-capabilities/v1", revision: 1, textMessages: true, progress: "control_events", exactDecisions: !!(app.options.policy.actionSlips && app.options.policy.decideAction && app.options.policy.dispatchAction), liveSteering: false, uploads: { available: false, code: "upload_unavailable" }, artifacts: { available: false, code: "artifact_unavailable" } });
  return async request => {
    try {
      const url = new URL(request.url);
      if (url.origin !== origin.origin || request.headers.get("host") !== null && request.headers.get("host") !== origin.host) throw new AppError("host_rejected", 403);
      if (!["GET", "POST"].includes(request.method)) throw new AppError("method_rejected", 405);
      if (request.headers.get("sec-fetch-site") === "cross-site") throw new AppError("origin_rejected", 403);
      if (request.method === "POST" && request.headers.get("origin") !== origin.origin) throw new AppError("origin_rejected", 403);
      const cookies = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${options.cookieName}=`));
      if (cookies.length !== 1) throw new AppError("authentication_required", 401);
      const authenticated = options.authentication.authenticate(cookies[0]!.slice(options.cookieName.length + 1));
      app.options.policy.requireOwner(authenticated.actor);
      if (request.method === "POST") options.authentication.verifyCsrf(authenticated.csrf, request.headers.get("x-csrf-token"));
      if (url.pathname === "/api/s16/client/bootstrap" && request.method === "GET") {
        if (url.search) throw new AppError("invalid_body");
        return json({ contract: "s16-client-bootstrap/v1", csrf: authenticated.csrf, capabilities: capabilities(), conversations: conversationList(app, authenticated.actor, 64), needsYou: conversationPendingNeeds(app, authenticated.actor) } satisfies ClientBootstrap);
      }
      const conversation = /^\/api\/s16\/client\/conversations\/([A-Za-z0-9_-]{1,128})(?:\/(messages|events|decisions))?$/.exec(url.pathname);
      if (conversation) {
        const conversationId = conversation[1]!;
        if (request.method === "GET" && !conversation[2]) {
          if (url.search) throw new AppError("invalid_body");
          return json({ contract: "s16-client-snapshot/v1", conversation: conversationOwnerView(app, authenticated.actor, conversationId) });
        }
        if (request.method === "GET" && conversation[2] === "events") {
          if ([...url.searchParams.keys()].some(key => key !== "after") || url.searchParams.getAll("after").length > 1 || !/^(?:0|[1-9]\d{0,15})$/.test(url.searchParams.get("after") ?? "0")) throw new AppError("cursor_invalid", 409);
          return json({ contract: "s16-client-events/v1", conversationId, ...app.events(authenticated.actor, conversationId, Number(url.searchParams.get("after") ?? "0")) });
        }
        if (request.method === "POST" && (conversation[2] === "messages" || conversation[2] === "decisions")) {
          if (url.search) throw new AppError("invalid_body");
          const input = await body(request);
          // Body streaming is an async boundary: owner/session and CSRF must still be current now.
          const current = options.authentication.authenticate(cookies[0]!.slice(options.cookieName.length + 1));
          app.options.policy.requireOwner(current.actor); options.authentication.verifyCsrf(current.csrf, request.headers.get("x-csrf-token"));
          if (!input || typeof input !== "object" || !("conversationId" in input) || input.conversationId !== conversationId) throw new AppError("outside_scope", 403);
          const receipt = conversation[2] === "decisions" ? app.decide(current.actor, input) : app.submit(current.actor, input);
          void app.drain().catch(() => {});
          return json(receipt, 202);
        }
      }
      const work = /^\/api\/s16\/client\/requests\/([A-Za-z0-9_-]{1,128})(\/stop)?$/.exec(url.pathname);
      if (work && request.method === "GET" && !work[2]) {
        if (url.search) throw new AppError("invalid_body");
        const row = conversationRequestView(app, authenticated.actor, work[1]!);
        return json({ contract: "s16-client-request/v1", conversationId: row.receipt.conversationId, row });
      }
      if (work?.[2] && request.method === "POST") {
        if (url.search) throw new AppError("invalid_body");
        exact(await body(request), []);
        const current = options.authentication.authenticate(cookies[0]!.slice(options.cookieName.length + 1));
        options.authentication.verifyCsrf(current.csrf, request.headers.get("x-csrf-token"));
        app.stop(current.actor, work[1]!); return json({ state: "stop_requested" });
      }
      throw new AppError("not_found", 404);
    } catch (error) { return json({ error: error instanceof AppError ? error.code : "client_unavailable" }, error instanceof AppError ? error.status : 503); }
  };
}
