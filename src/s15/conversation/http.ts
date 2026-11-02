import { AppError } from "../../errors";
import type { ConversationApplication } from "./application";
import { exact, parseCommandJson } from "./validation";
import { conversationOwnerView } from "./owner-view";

/** Protected existing owner-session adapter; credential verification/CSRF stay outside models and tools. */
export interface ConversationHttpAuthentication<OwnerActor> {
  authenticate(token: string): { actor: OwnerActor; csrf: string };
  verifyCsrf(expected: string, supplied: unknown): void;
}
/**
 * Opt-in API only, mounted explicitly by protected composition. There is no S15 UI or implicit policy
 * installation. Exact Host/Origin/session/CSRF checks precede admission; disconnect/reconnect never
 * cancels or resubmits a task. The supplied cookie belongs to the installation's existing owner login.
 */
export function createConversationHandler<OwnerActor, WorkContext>(app: ConversationApplication<OwnerActor, WorkContext>, options: {
  resources?: (actor: OwnerActor) => unknown;
  memory?: { view(actor: OwnerActor): unknown; command(actor: OwnerActor, input: unknown): unknown };
  origin: string; authentication: ConversationHttpAuthentication<OwnerActor>; cookieName: string;
}): (request: Request) => Promise<Response> {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || !/^[A-Za-z0-9_-]+$/.test(options.cookieName)) throw new AppError("invalid_configuration");
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer" } });
  const body = async (request: Request): Promise<unknown> => {
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new AppError("unsupported_content_type", 415);
    const reader = request.body?.getReader(); if (!reader) throw new AppError("invalid_body");
    const chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.length; if (bytes > 32768) { await reader.cancel(); throw new AppError("body_too_large", 413); } chunks.push(chunk.value); } }
    finally { reader.releaseLock(); }
    try { return parseCommandJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch (error) { if (error instanceof AppError) throw error; throw new AppError("invalid_body"); }
  };
  return async request => {
    try {
      const url = new URL(request.url);
      if (url.origin !== origin.origin || request.headers.get("host") !== null && request.headers.get("host") !== origin.host) throw new AppError("host_rejected", 403);
      if (!["GET", "POST"].includes(request.method)) throw new AppError("method_rejected", 405);
      if (request.method === "POST" && request.headers.get("origin") !== origin.origin) throw new AppError("origin_rejected", 403);
      const cookies = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${options.cookieName}=`));
      if (cookies.length !== 1) throw new AppError("authentication_required", 401);
      const authenticated = options.authentication.authenticate(cookies[0]!.slice(options.cookieName.length + 1));
      if (request.method === "POST") options.authentication.verifyCsrf(authenticated.csrf, request.headers.get("x-csrf-token"));
      if (url.pathname === "/api/s15/resources" && request.method === "GET" && options.resources) return json(options.resources(authenticated.actor));
      if (url.pathname === "/api/s15/memory" && request.method === "GET" && options.memory) return json(options.memory.view(authenticated.actor));
      if (url.pathname === "/api/s15/memory/commands" && request.method === "POST" && options.memory) return json(options.memory.command(authenticated.actor, await body(request)));
      const ownerView = /^\/api\/s15\/conversations\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (ownerView && request.method === "GET") return json(conversationOwnerView(app, authenticated.actor, ownerView[1]!));
      const conversation = /^\/api\/s15\/conversations\/([A-Za-z0-9_-]+)\/(messages|events)$/.exec(url.pathname);
      if (conversation?.[2] === "messages" && request.method === "POST") {
        const input = await body(request);
        if (!input || typeof input !== "object" || !("conversationId" in input) || input.conversationId !== conversation[1]) throw new AppError("outside_scope", 403);
        const receipt = app.submit(authenticated.actor, input);
        // Commit is complete. A transport retry returns this receipt and cannot create another intent.
        void app.drain().catch(() => {});
        return json(receipt, 202);
      }
      if (conversation?.[2] === "events" && request.method === "GET") {
        if ([...url.searchParams.keys()].some(key => key !== "after") || url.searchParams.getAll("after").length > 1 || !/^(?:0|[1-9]\d{0,15})$/.test(url.searchParams.get("after") ?? "0")) throw new AppError("cursor_invalid", 409);
        return json(app.events(authenticated.actor, conversation[1]!, Number(url.searchParams.get("after") ?? 0)));
      }
      const work = /^\/api\/s15\/requests\/([A-Za-z0-9_-]+)(\/stop)?$/.exec(url.pathname);
      if (work && request.method === "GET" && !work[2]) return json(app.view(authenticated.actor, work[1]!));
      if (work?.[2] && request.method === "POST") { const input = await body(request); exact(input, []); app.stop(authenticated.actor, work[1]!); return json({ state: "stop_requested" }); }
      throw new AppError("not_found", 404);
    } catch (error) { return json({ error: error instanceof AppError ? error.code : "conversation_unavailable" }, error instanceof AppError ? error.status : 503); }
  };
}
