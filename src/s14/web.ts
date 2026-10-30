import { AppError } from "../errors";
import { negotiateLocale } from "../i18n";
import type { S14Application, S14Command } from "./application";
import type { Home, Policy } from "./types";
import type { Work } from "./authority-types";
import type { OwnerInputCommand } from "./computer-types";
import type { S14Overview, S14Product, S14View } from "./web-product";

/** Product rendering seam; `view`, `overview`, `policy` and `now` are query data and prove nothing about authority. */
export interface S14Page { state: Home; work: Work[]; csrf: string; locale: "th" | "en"; view: S14View; overview: S14Overview; policy: Policy; now: number }
/** Opus-authored Web code can replace this renderer while retaining the authenticated command handler. */
export type S14Renderer = (page: S14Page) => string;
const escape = (v: string) => v.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
/** ADR 0028 policy for S14 pages, assets and API: same origin only, no inline script or style. */
export const s14ContentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const baseline: S14Renderer = p => `<html lang="${p.locale}"><meta charset="utf-8"><title>S14</title><body><pre>${escape(JSON.stringify({ state: p.state, work: p.work }, null, 2))}</pre><form method="post" action="/s14/commands"><input type="hidden" name="csrf" value="${p.csrf}"><label>Command<textarea name="command" required></textarea></label><button>Submit</button></form></body></html>`;

/** Shared HTTP/no-script seam with strict Host/Origin/session/CSRF checks and credential-free errors. */
export function createS14Handler(app: S14Application, origin: string, render: S14Renderer = baseline, product?: S14Product): (request: Request) => Promise<Response> {
  const configured = new URL(origin), secure = configured.protocol === "https:", cookieName = secure ? "__Host-jit_s14" : "jit_s14";
  const respond = (body: string, status = 200, type = "application/json", extra: Record<string, string> = {}) => new Response(body, { status, headers: {
    "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    // no-referrer would make a browser send `Origin: null` on the page's own form posts, which the exact Origin check refuses.
    "Referrer-Policy": type === "text/html" ? "same-origin" : "no-referrer", "Content-Security-Policy": s14ContentSecurityPolicy, ...extra } });
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
  const html = (body: string, status = 200, locale?: string) => respond(body, status, "text/html", { ...(locale ? { "Content-Language": locale } : {}), Vary: "Accept-Language, Cookie" });
  const redirect = (location: string, extra: Record<string, string> = {}) => respond("", 303, "text/html", { Location: location, ...extra });
  return async request => {
    let page = false, next = "/", ownerLocale: "th" | "en" | null = null;
    const browserLocale = () => negotiateLocale(request.headers.get("accept-language"));
    try {
      const url = new URL(request.url);
      page = !!product && !url.pathname.startsWith("/api/");
      if (url.origin !== configured.origin || (request.headers.get("host") && request.headers.get("host") !== configured.host)) throw new AppError("host_rejected", 403);
      if (request.method !== "GET" && request.method !== "POST") throw new AppError("method_rejected", 405);
      if (request.method === "POST" && request.headers.get("origin") !== configured.origin) throw new AppError("origin_rejected", 403);
      if (product && request.method === "GET" && url.pathname.startsWith("/assets/")) {
        const asset = product.asset(url.pathname); if (!asset) throw new AppError("not_found", 404);
        return new Response(asset.body, { headers: { "Content-Type": asset.contentType, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": s14ContentSecurityPolicy } });
      }
      if (url.pathname === "/s14/login") {
        if (product && request.method === "GET") return html(product.login(browserLocale(), null));
        if (request.method === "GET") return respond('<html lang="th"><meta charset="utf-8"><form method="post"><label>Password<input type="password" name="password" required autocomplete="current-password"></label><button>Sign in</button></form></html>', 200, "text/html");
        const p = await body(request); if (Object.keys(p).join() !== "password" || typeof p.password !== "string") throw new AppError("invalid_body");
        const token = await app.login(p.password);
        return respond("", 303, "text/html", { Location: "/", "Set-Cookie": `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${secure ? "; Secure" : ""}` });
      }
      const matches = (request.headers.get("cookie") ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith(`${cookieName}=`));
      if (matches.length !== 1) throw new AppError("authentication_required", 401);
      const auth = app.authenticate(matches[0]!.slice(cookieName.length + 1));
      const signedInLocale = (state = app.home(auth.actor)) => state.owner?.language ?? browserLocale();
      if (product) ownerLocale = signedInLocale();
      const view = (state: Home, selected: S14View, status = 200) => { const work = app.authority.list(auth.actor), locale = signedInLocale(state); return html(render({ state, work, csrf: auth.csrf, locale, view: selected, overview: product!.overview(auth.actor, state, work), policy: app.policy, now: app.now() }), status, locale); };
      if (product && request.method === "POST" && url.pathname === "/s14/logout") {
        const p = await body(request); if (Object.keys(p).join() !== "csrf") throw new AppError("invalid_body"); app.verifyCsrf(auth.csrf, p.csrf); app.logout(auth.actor);
        return redirect("/s14/login", { "Set-Cookie": `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? "; Secure" : ""}` });
      }
      const input = /^\/(api\/)?s14\/bots\/([a-zA-Z0-9_-]+)\/computer\/input$/.exec(url.pathname);
      if (request.method === "POST" && input) {
        const isForm = !input[1];
        if (isForm && product) next = product.next(null, { payload: { botId: input[2] } });
        const p = await body(request);
        app.verifyCsrf(auth.csrf, isForm ? p.csrf : request.headers.get("x-csrf-token"));
        let command: OwnerInputCommand;
        if (isForm) {
          const base = ["csrf", "requestId", "expectedRevision", "computerId", "generation", "leaseRevision", "kind"];
          const fields = p.kind === "click" ? ["point.x", "point.y"] : p.kind === "text" ? ["text"] : p.kind === "key" ? ["key"] : [];
          if (!fields.length || Object.keys(p).sort().join() !== [...base, ...fields].sort().join()) throw new AppError("invalid_shape");
          const number = (value: unknown) => { if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(value)) throw new AppError("invalid_number"); return Number(value); };
          const action = p.kind === "click" ? { kind: "click" as const, x: number(p["point.x"]), y: number(p["point.y"]) }
            : p.kind === "text" ? { kind: "text" as const, text: p.text as string } : { kind: "key" as const, key: p.key as string };
          command = { kind: "takeover.input", requestId: p.requestId as string, expectedRevision: number(p.expectedRevision),
            payload: { botId: input[2]!, computerId: p.computerId as string, generation: number(p.generation), leaseRevision: number(p.leaseRevision), input: action } };
        } else command = p as unknown as OwnerInputCommand;
        if (command.payload?.botId !== input[2]) throw new AppError("computer_scope_changed", 403);
        const result = await app.computers.ownerInput(auth.actor, command);
        return isForm ? respond("", 303, "text/html", { Location: product ? product.inputSurface(input[2]!, result.requestId) : `/api/s14/computer-inputs/${result.requestId}` }) : json(result);
      }
      const form = product && request.method === "POST" ? /^\/s14\/forms\/([a-z-]+)$/.exec(url.pathname)?.[1] : undefined;
      if (form) {
        const p = await body(request), state = app.home(auth.actor); app.verifyCsrf(auth.csrf, p.csrf); next = product!.next(form, p);
        try { return redirect(product!.surface(app.execute(auth.actor, product!.command(form, p, auth.actor, state, signedInLocale(state))), p)); }
        catch (error) {
          const recovered = error instanceof AppError ? product!.recover(form, p, error.code, auth.actor, app.home(auth.actor)) : null;
          if (recovered) return view(app.home(auth.actor), recovered, (error as AppError).status);
          throw error;
        }
      }
      if (request.method === "POST" && ["/api/s14/commands", "/s14/commands"].includes(url.pathname)) {
        const p = await body(request); let command: unknown;
        if (url.pathname === "/s14/commands") { if (Object.keys(p).sort().join() !== "command,csrf") throw new AppError("invalid_body"); app.verifyCsrf(auth.csrf, p.csrf); if (typeof p.command !== "string") throw new AppError("invalid_body"); command = JSON.parse(p.command); if (product) next = product.next(null, command); }
        else { app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token")); command = p; }
        const receipt = app.execute(auth.actor, command as S14Command);
        if (url.pathname === "/s14/commands") return respond("", 303, "text/html", { Location: `/s14/receipts/${receipt.requestId}` });
        return json(receipt);
      }
      if (request.method !== "GET") throw new AppError("not_found", 404);
      if (url.pathname === "/api/s14/work-defaults") return json(app.graph.defaults(auth.actor));
      const graph = /^\/api\/s14\/work\/([a-zA-Z0-9_-]+)\/graph$/.exec(url.pathname);
      if (graph) return json(app.graph.view(auth.actor, graph[1]!));
      if (url.pathname === "/api/s14/home") return json({ state: app.home(auth.actor), csrf: auth.csrf });
      const inputReceipt = /^\/api\/s14\/computer-inputs\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (inputReceipt) return json(app.computers.inputReceipt(auth.actor, inputReceipt[1]!));
      const computer = /^\/api\/s14\/bots\/([a-zA-Z0-9_-]+)\/computer(?:\/(image|events))?$/.exec(url.pathname);
      if (computer) {
        if (computer[2] === "image") {
          const bytes = await app.computers.screenshot(auth.actor, computer[1]!);
          const headers = new Headers(respond("").headers);
          headers.set("Content-Type", "image/png");
          return new Response(new Uint8Array(bytes), { headers });
        }
        const state = app.computers.view(auth.actor, computer[1]!);
        if (computer[2] === "events") return respond(`event: state\ndata: ${JSON.stringify(state)}\n\n`, 200, "text/event-stream", { "X-Accel-Buffering": "no" });
        return json(state);
      }
      if (url.pathname === "/api/s14/work") return json({ items: app.authority.list(auth.actor) });
      const memory = /^\/api\/s14\/memory\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (memory) return json(app.memory.inspect(auth.actor, memory[1]!, url.searchParams.get("q") ?? ""));
      const memoryClaim = /^\/api\/s14\/memory\/([a-zA-Z0-9_-]+)\/claims\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (memoryClaim) return json(app.memory.claim(auth.actor, memoryClaim[1]!, { id: memoryClaim[2]!, revision: Number(url.searchParams.get("revision")), generation: Number(url.searchParams.get("generation")) }));
      const impact = /^\/api\/s14\/memory-impact\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (impact) return json(app.memory.preview(auth.actor, { id: impact[1]!, revision: Number(url.searchParams.get("revision")), generation: Number(url.searchParams.get("generation")) }));
      const context = /^\/api\/s14\/memory-contexts\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (context) return json(app.memory.context(auth.actor, context[1]!));
      if (url.pathname === "/api/s14/parallel") return json(app.parallel.settings(auth.actor));
      const evidence = /^\/api\/s14\/work\/([a-zA-Z0-9_-]+)\/evidence$/.exec(url.pathname);
      if (evidence) return json(app.parallel.inspect(auth.actor, evidence[1]!));
      const work = /^\/api\/s14\/work\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (work) return json(app.authority.view(auth.actor, work[1]!));
      const effect = /^\/api\/s14\/effects\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (effect) return json(app.authority.effect(auth.actor, effect[1]!));
      const proposal = /^\/api\/s14\/bot-proposals\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (proposal) return json(app.proposal(auth.actor, proposal[1]!));
      const conversation = /^\/api\/s14\/conversations\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (conversation) return json(app.conversation(auth.actor, conversation[1]!));
      const receipt = /^\/(?:api\/)?s14\/receipts\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (receipt) return app.store.read(tx => { app.requireOwner(tx, auth.actor); const r = tx.get<{ result_json: string }>("SELECT result_json FROM command_receipts WHERE owner_id='owner' AND request_id=?", receipt[1]!); if (!r) throw new AppError("not_found", 404); return page ? redirect(product!.surface(JSON.parse(r.result_json))) : json(JSON.parse(r.result_json)); });
      if (page) { const state = app.home(auth.actor); return view(state, product!.view(url, auth.actor, state, signedInLocale(state))); }
      if (url.pathname === "/") { const state = app.home(auth.actor); return respond(render({ state, work: app.authority.list(auth.actor), csrf: auth.csrf, locale: state.owner?.language ?? (request.headers.get("accept-language")?.startsWith("en") ? "en" : "th"), view: { kind: "more" }, overview: { views: [], effects: [], botStates: {}, computers: {} }, policy: app.policy, now: app.now() }), 200, "text/html"); }
      throw new AppError("not_found", 404);
    } catch (error) {
      const code = error instanceof AppError ? error.code : "invalid_request", status = error instanceof AppError ? error.status : 400;
      if (!page) return json({ error: code }, status);
      if (code === "authentication_required" && request.method === "GET") return redirect("/s14/login");
      if (new URL(request.url).pathname === "/s14/login") return html(product!.login(browserLocale(), code), status);
      return html(product!.failure(ownerLocale ?? browserLocale(), code, code === "authentication_required" ? "/s14/login" : next), status);
    }
  };
}
