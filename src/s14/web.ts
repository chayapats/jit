import { AppError } from "../errors";
import type { S14Application, S14Command } from "./application";
import type { Home } from "./types";
import type { Work } from "./authority-types";

/** Product rendering seam for the Opus UI agent; baseline forms are a no-style contract exerciser. */
export interface S14Page { state: Home; work: Work[]; csrf: string; locale: "th" | "en" }
/** Opus-authored Web code can replace this renderer while retaining the authenticated command handler. */
export type S14Renderer = (page: S14Page) => string;
const escape = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const baseline: S14Renderer = p => `<html lang="${p.locale}"><meta charset="utf-8"><title>S14</title><body><pre>${escape(JSON.stringify({ state: p.state, work: p.work }, null, 2))}</pre><form method="post" action="/s14/commands"><input type="hidden" name="csrf" value="${p.csrf}"><label>Command<textarea name="command" required></textarea></label><button>Submit</button></form></body></html>`;

/** Shared HTTP/no-script seam with strict Host/Origin/session/CSRF checks and credential-free errors. */
export function createS14Handler(app: S14Application, origin: string, render: S14Renderer = baseline): (request: Request) => Promise<Response> {
  const configured = new URL(origin), secure = configured.protocol === "https:", cookieName = secure ? "__Host-jit_s14" : "jit_s14";
  const respond = (body: string, status = 200, type = "application/json", extra: Record<string, string> = {}) => new Response(body, { status, headers: {
    "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", ...extra } });
  const json = (v: unknown, status = 200) => respond(JSON.stringify(v), status);
  const body = async (request: Request): Promise<Record<string, unknown>> => {
    const reader = request.body?.getReader(); if (!reader) throw new AppError("invalid_body");
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 131072) { await reader.cancel(); throw new AppError("body_too_large", 413); } chunks.push(r.value); } }
    finally { reader.releaseLock(); }
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    const type = request.headers.get("content-type")?.split(";")[0];
    if (type === "application/json") { const v: unknown = JSON.parse(raw); if (!v || typeof v !== "object" || Array.isArray(v)) throw new AppError("invalid_body"); return v as Record<string, unknown>; }
    if (type === "application/x-www-form-urlencoded") { const form = new URLSearchParams(raw); if (new Set(form.keys()).size !== [...form.keys()].length) throw new AppError("invalid_body"); return Object.fromEntries(form); }
    throw new AppError("unsupported_content_type", 415);
  };
  return async request => {
    try {
      const url = new URL(request.url);
      if (url.origin !== configured.origin || (request.headers.get("host") && request.headers.get("host") !== configured.host)) throw new AppError("host_rejected", 403);
      if (request.method !== "GET" && request.method !== "POST") throw new AppError("method_rejected", 405);
      if (request.method === "POST" && request.headers.get("origin") !== configured.origin) throw new AppError("origin_rejected", 403);
      if (url.pathname === "/s14/login") {
        if (request.method === "GET") return respond('<html lang="th"><meta charset="utf-8"><form method="post"><label>Password<input type="password" name="password" required autocomplete="current-password"></label><button>Sign in</button></form></html>', 200, "text/html");
        const p = await body(request); if (Object.keys(p).join() !== "password" || typeof p.password !== "string") throw new AppError("invalid_body");
        const token = await app.login(p.password);
        return respond("", 303, "text/html", { Location: "/", "Set-Cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure ? "; Secure" : ""}` });
      }
      const matches = (request.headers.get("cookie") ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(`${cookieName}=`));
      if (matches.length !== 1) throw new AppError("authentication_required", 401);
      const auth = app.authenticate(matches[0]!.slice(cookieName.length + 1));
      if (request.method === "POST" && ["/api/s14/commands", "/s14/commands"].includes(url.pathname)) {
        const p = await body(request); let command: unknown;
        if (url.pathname === "/s14/commands") { if (Object.keys(p).sort().join() !== "command,csrf") throw new AppError("invalid_body"); app.verifyCsrf(auth.csrf, p.csrf); if (typeof p.command !== "string") throw new AppError("invalid_body"); command = JSON.parse(p.command); }
        else { app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token")); command = p; }
        const receipt = app.execute(auth.actor, command as S14Command);
        if (url.pathname === "/s14/commands") return respond("", 303, "text/html", { Location: `/s14/receipts/${receipt.requestId}` });
        return json(receipt);
      }
      if (request.method !== "GET") throw new AppError("not_found", 404);
      if (url.pathname === "/api/s14/home") return json({ state: app.home(auth.actor), csrf: auth.csrf });
      if (url.pathname === "/api/s14/work") return json({ items: app.authority.list(auth.actor) });
      const work = /^\/api\/s14\/work\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (work) return json(app.authority.view(auth.actor, work[1]!));
      const effect = /^\/api\/s14\/effects\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (effect) return json(app.authority.effect(auth.actor, effect[1]!));
      const proposal = /^\/api\/s14\/bot-proposals\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (proposal) return json(app.proposal(auth.actor, proposal[1]!));
      const conversation = /^\/api\/s14\/conversations\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (conversation) return json(app.conversation(auth.actor, conversation[1]!));
      const receipt = /^\/(?:api\/)?s14\/receipts\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (receipt) return app.store.read(tx => { app.requireOwner(tx, auth.actor); const r = tx.get<{ result_json: string }>("SELECT result_json FROM command_receipts WHERE owner_id='owner' AND request_id=?", receipt[1]!); if (!r) throw new AppError("not_found", 404); return json(JSON.parse(r.result_json)); });
      if (url.pathname === "/") { const state = app.home(auth.actor); return respond(render({ state, work: app.authority.list(auth.actor), csrf: auth.csrf, locale: state.owner?.language ?? (request.headers.get("accept-language")?.startsWith("en") ? "en" : "th") }), 200, "text/html"); }
      throw new AppError("not_found", 404);
    } catch (error) { return error instanceof AppError ? json({ error: error.code }, error.status) : json({ error: "invalid_request" }, 400); }
  };
}
