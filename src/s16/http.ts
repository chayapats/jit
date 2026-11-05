import { AppError } from "../errors";
import type { ConversationApplication, ConversationHttpAuthentication } from "../s15/conversation";
import { conversationList, conversationOwnerView, conversationPendingNeeds, conversationRequestView } from "../s15/conversation/owner-view";
import { exact, parseCommandJson } from "../s15/conversation/validation";
import { clientResponseBytes, type ClientBootstrap, type ClientCapabilities } from "./client/contracts";
import { binaryLimits } from "./files/parser";
import type { FileStore } from "./files/store";
import type { FileUploadCommand } from "./files/types";

/** Protected shared client adapter. It adds no engine, database, approval authority or automatic retry. */
export function createS16ClientHandler<Actor, Work>(app: ConversationApplication<Actor, Work>, options: { origin: string; cookieName: string; authentication: ConversationHttpAuthentication<Actor>; files?: FileStore<Actor>; imageAvailable?: () => boolean }): (request: Request) => Promise<Response> {
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
  const capabilities = async (): Promise<ClientCapabilities> => {
    const files = options.files, binary = !!files?.parser && await files.parser.available(), images = binary && options.imageAvailable?.() === true;
    const textBytes = files ? Math.min(files.limits.fileBytes, files.parser ? binaryLimits.textBytes : files.limits.fileBytes) : 0;
    const formats = [ ...["txt", "md", "markdown", "csv", "tsv"].map(extension => ({ extension, mime: "text/plain", bytes: textBytes })),
      ...(binary ? [{ extension: "pdf", mime: "application/pdf", bytes: files!.limits.fileBytes }] : []),
      ...(images ? ["png", "jpg", "jpeg"].map(extension => ({ extension, mime: extension === "png" ? "image/png" : "image/jpeg", bytes: files!.limits.fileBytes })) : []) ];
    return { contract: "s16-client-capabilities/v1", revision: 1, textMessages: true, progress: "control_events", exactDecisions: !!(app.options.policy.actionSlips && app.options.policy.decideAction && app.options.policy.decidePending && app.options.policy.dispatchAction), liveSteering: false,
      uploads: files && app.options.files ? { available: true, limits: { ...files.limits }, extensions: formats.map(format => format.extension), formats, textBytes, memory: false,
        ...(files.parser && !images ? { unavailableBinary: binary ? "images_unsupported" as const : "sanitizer_unavailable" as const } : {}),
        ...(binary ? { binary: { limits: { ...binaryLimits, originalBytes: Math.min(binaryLimits.originalBytes, files.limits.fileBytes) }, images } } : {}) } : { available: false, code: "upload_unavailable" },
      artifacts: files && app.options.files ? { available: true, preview: "escaped_text" } : { available: false, code: "artifact_unavailable" } };
  };
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
      const currentOwner = () => {
        const current = options.authentication.authenticate(cookies[0]!.slice(options.cookieName.length + 1));
        app.options.policy.requireOwner(current.actor);
        if (request.method === "POST") options.authentication.verifyCsrf(current.csrf, request.headers.get("x-csrf-token"));
        return current.actor;
      };
      const uploadCreate = /^\/api\/s16\/client\/conversations\/([A-Za-z0-9_-]{1,128})\/uploads$/.exec(url.pathname);
      if (uploadCreate && request.method === "POST") {
        if (!options.files || !app.options.files) throw new AppError("upload_unavailable", 503);
        if (url.search) throw new AppError("invalid_body");
        const input = await body(request);
        if (!input || typeof input !== "object" || !("conversationId" in input) || input.conversationId !== uploadCreate[1]) throw new AppError("outside_scope", 403);
        if ("name" in input && typeof input.name === "string" && /\.(pdf|png|jpe?g)$/i.test(input.name)) {
          if (!options.files.parser || !await options.files.parser.available()) throw new AppError("sanitizer_unavailable", 503);
          if (/\.(png|jpe?g)$/i.test(input.name) && options.imageAvailable?.() !== true) throw new AppError("images_unsupported", 409);
        }
        return json(options.files.create(currentOwner(), input as FileUploadCommand), 201);
      }
      const upload = /^\/api\/s16\/client\/uploads\/([A-Za-z0-9_-]{1,128})(?:\/(bytes|withdraw))?$/.exec(url.pathname);
      if (upload) {
        if (!options.files || !app.options.files) throw new AppError("upload_unavailable", 503);
        if (url.search) throw new AppError("invalid_body");
        if (request.method === "GET" && !upload[2]) return json(options.files.status(currentOwner(), upload[1]!));
        if (request.method === "POST" && upload[2] === "withdraw") { exact(await body(request), []); return json(options.files.withdraw(currentOwner(), upload[1]!)); }
        if (request.method === "POST" && upload[2] === "bytes") {
          if (request.headers.get("content-type") !== "application/octet-stream" || !request.body) throw new AppError("unsupported_content_type", 415);
          const reader = request.body.getReader();
          const bytes = new ReadableStream<Uint8Array>({ async pull(controller) {
            try { const value = await reader.read(); currentOwner(); if (value.done) controller.close(); else controller.enqueue(value.value); }
            catch (error) { controller.error(error); await reader.cancel().catch(() => {}); }
          }, async cancel() { await reader.cancel().catch(() => {}); } });
          try { return json(await options.files.write(currentOwner(), upload[1]!, bytes, request.signal)); }
          finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        }
      }
      const artifact = /^\/api\/s16\/client\/requests\/([A-Za-z0-9_-]{1,128})\/artifacts\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
      if (artifact && request.method === "GET") {
        if (!options.files || !app.options.files) throw new AppError("artifact_unavailable", 503);
        if (url.search) throw new AppError("invalid_body");
        const owner = currentOwner(), row = app.view(owner, artifact[1]!);
        const committed = row.result !== null && row.state === "completed" ? row.artifacts?.find(item => item.id === artifact[2]) : null;
        if (!committed) throw new AppError("artifact_unavailable", 409);
        const output = options.files.artifact(owner, committed.id);
        if (output.artifact.sha256 !== committed.sha256 || output.artifact.workId !== row.authority?.id || output.artifact.requestId !== row.receipt.rootRequestId) throw new AppError("artifact_unavailable", 409);
        const name = encodeURIComponent(committed.name).replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase());
        return new Response(new Uint8Array(output.bytes).buffer, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(committed.bytes), "Content-Disposition": `attachment; filename="artifact.txt"; filename*=UTF-8''${name}`, "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Content-Security-Policy": "default-src 'none'; sandbox", "Referrer-Policy": "no-referrer", "X-Content-SHA256": committed.sha256, Vary: "Cookie" } });
      }
      if (url.pathname === "/api/s16/client/session" && request.method === "GET") { if (url.search) throw new AppError("invalid_body"); return json({ authenticated: true }); }
      if (url.pathname === "/api/s16/client/bootstrap" && request.method === "GET") {
        if (url.search) throw new AppError("invalid_body");
        const caps = await capabilities(), current = options.authentication.authenticate(cookies[0]!.slice(options.cookieName.length + 1)); app.options.policy.requireOwner(current.actor);
        return json({ contract: "s16-client-bootstrap/v1", csrf: current.csrf, capabilities: caps, conversations: conversationList(app, current.actor, 64), needsYou: conversationPendingNeeds(app, current.actor) } satisfies ClientBootstrap);
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
        const receipt = app.receipt(authenticated.actor, work[1]!);
        const row = conversationRequestView(app, authenticated.actor, receipt.rootRequestId);
        return json({ contract: "s16-client-request/v1", conversationId: receipt.conversationId, receipt, row });
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
