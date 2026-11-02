import { AppError } from "../../errors";
import type { OwnerActor, WorkActor } from "../policy";
import type { ConversationHttpAuthentication } from "../conversation";
import { parseCommandJson } from "../conversation/validation";
import { GithubService } from "./service";
import { exact, fail } from "./validation";

/** Explicit owner JSON API only; protected composition resolves each work ID through authenticated CHAT. */
export function createGithubHandler<Attempt>(service: GithubService<Attempt>, options: {
  origin: string; cookieName: string; authentication: ConversationHttpAuthentication<OwnerActor>;
  resolveWork(owner: OwnerActor, workId: string): WorkActor;
}): (request: Request) => Promise<Response> {
  const origin = new URL(options.origin); if (origin.origin !== options.origin || !/^[A-Za-z0-9_-]+$/.test(options.cookieName)) fail("invalid_configuration");
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Referrer-Policy": "no-referrer" } });
  return async request => {
    try {
      const url = new URL(request.url);
      if (url.origin !== origin.origin || request.headers.get("host") !== null && request.headers.get("host") !== origin.host) throw new AppError("host_rejected", 403);
      if (!["POST", "GET"].includes(request.method)) throw new AppError("method_rejected", 405);
      if (request.method === "POST" && request.headers.get("origin") !== origin.origin) throw new AppError("origin_rejected", 403);
      const cookies = (request.headers.get("cookie") ?? "").split(";").map(c => c.trim()).filter(c => c.startsWith(`${options.cookieName}=`)); if (cookies.length !== 1) throw new AppError("authentication_required", 401);
      const auth = options.authentication.authenticate(cookies[0]!.slice(options.cookieName.length + 1));
      if (request.method === "POST") options.authentication.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token"));
      const match = /^\/s15\/github\/work\/([A-Za-z0-9_-]+)\/(discover|select|implement|prepare|dispatch|capture|install-personal|revoke-personal|babysit|responsibilities)(?:\/([A-Za-z0-9_-]+))?$/.exec(url.pathname);
      if (!match || url.search) throw new AppError("not_found", 404);
      const actor = options.resolveWork(auth.actor, match[1]!);
      if (request.method === "GET") {
        if (match[2] === "capture" && !match[3]) return json(await service.personalCapture(auth.actor, actor));
        if (match[2] === "responsibilities" && match[3]) return json(await service.project(auth.actor, actor, match[3]));
        throw new AppError("not_found", 404);
      }
      if (match[3]) throw new AppError("not_found", 404);
      if (request.headers.get("content-type")?.split(";")[0] !== "application/json") throw new AppError("unsupported_content_type", 415);
      const reader = request.body?.getReader(); if (!reader) fail("invalid_body"); const chunks: Uint8Array[] = []; let bytes = 0;
      try { for (;;) { const c = await reader.read(); if (c.done) break; bytes += c.value.length; if (bytes > 32768) { await reader.cancel(); throw new AppError("body_too_large", 413); } chunks.push(c.value); } } finally { reader.releaseLock(); }
      const body = parseCommandJson(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      switch (match[2]) {
        case "discover": exact(body, ["repositoryId"]); return json(await service.discover(actor, body.repositoryId as string));
        case "select": return json(await service.select(actor, body as Parameters<typeof service.select>[1]));
        case "implement": exact(body, ["selectionId"]); return json(await service.implement(actor, body.selectionId as string));
        case "prepare": exact(body, ["selectionId", "operation"]); return json(await service.prepare(actor, body.selectionId as string, body.operation as Parameters<typeof service.prepare>[2]));
        case "dispatch": exact(body, ["action"]); return json(await service.dispatch(actor, body.action as Parameters<typeof service.dispatch>[1]));
        case "install-personal": return json(await service.installPersonal(auth.actor, actor, body as Parameters<typeof service.installPersonal>[2]));
        case "revoke-personal": exact(body, ["requestId", "expectedPolicyRevision", "ruleIds"]); service.revokePersonal(auth.actor, body as Parameters<typeof service.revokePersonal>[1]); return json({ state: "revoked" });
        case "babysit": exact(body, ["requestId", "sourceRequestId", "selectionId", "pull", "reserveCalls"]); return json(await service.babysit(auth.actor, actor, body as Parameters<typeof service.babysit>[2]));
        default: throw new AppError("not_found", 404);
      }
    } catch (e) { return json({ error: e instanceof AppError ? e.code : "github_unavailable" }, e instanceof AppError ? e.status : 503); }
  };
}
