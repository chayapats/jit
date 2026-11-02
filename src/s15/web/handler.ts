import { AppError } from "../../errors";
import { negotiateLocale, tr, withLocale, type Locale } from "../../i18n";
import { s14ContentSecurityPolicy } from "../../s14/web";
import { conversationList, conversationOwnerView, conversationPendingNeeds, type ConversationApplication, type ConversationOwnerRow, type ConversationOwnerView } from "../conversation";
import { PolicyError } from "../policy";
import type { VmStatus } from "../vm";
import { lookupS15Asset } from "./assets";
import { composer, liveRow, openQuestion, threadHtml, type S15ChatPage, type S15RowExtras } from "./chat";
import { memoryBody, memoryFilter, modelsBody, needsBody, type S15MemoryPage, type S15NeedItem } from "./manage";
import { codeText, e, refusal, shell, standalonePage, type S15Nav } from "./render";
import { accountRows, computerCard, rulesCard, setupBody, toMinor, type S15ComputerProgress } from "./setup";
import type { S15BudgetEntry, S15ForgetImpact, S15MemoryClaim, S15ModelBudgetView, S15WebConversation, S15WebPorts } from "./types";

/** Adapts the real CHAT15-01 application to the Web consumer seam; reading starts no model, tool or queue. */
export function s15ConversationPort<Actor, Work>(app: ConversationApplication<Actor, Work>): S15WebConversation<Actor> {
  return { view: (actor, id) => conversationOwnerView(app, actor, id), list: actor => conversationList(app, actor), submit: (actor, command) => app.submit(actor, command),
    stop: (actor, id) => app.stop(actor, id), events: (actor, id, after) => app.events(actor, id, after), needs: actor => conversationPendingNeeds(app, actor), drain: () => app.drain() };
}

/** Explicit opt-in mount options. S14 never mounts this handler; only S15 composition does. */
export interface S15WebOptions { origin: string; cookieName: string; loginPath: string; now?: () => number }
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const codeOf = (error: unknown) => error instanceof AppError || error instanceof PolicyError ? error.code : "conversation_unavailable";
const statusOf = (error: unknown) => error instanceof AppError ? error.status : error instanceof PolicyError ? 409 : 503;

/**
 * Server-rendered S15 owner Web UI (UX15-01) with no-script forms and same-origin enhancement. Every post
 * passes exact Host/Origin/session/CSRF checks; every page re-reads current protected state. Nothing here
 * installs policy, registers machines or starts work except the owner's own authenticated form posts.
 */
export function createS15WebHandler<Actor extends object>(ports: S15WebPorts<Actor>, options: S15WebOptions): (request: Request) => Promise<Response> {
  const origin = new URL(options.origin);
  if (origin.origin !== options.origin || !/^[A-Za-z0-9_-]+$/.test(options.cookieName) || !/^\/(?!\/)/.test(options.loginPath)) throw new AppError("invalid_configuration");
  const progress: S15ComputerProgress = { setup: null, check: null };
  let reviewed: { entry: { amount: string; currency: string; periodId: string }; budget: S15BudgetEntry } | null = null;
  const headers = (type: string, extra: Record<string, string> = {}) => ({ "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": type === "text/html" ? "same-origin" : "no-referrer", "Content-Security-Policy": s14ContentSecurityPolicy, ...extra });
  const html = (body: string, status = 200, locale: Locale = "th") => new Response(body, { status, headers: headers("text/html", { "Content-Language": locale, Vary: "Accept-Language, Cookie" }) });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: headers("application/json") });
  const redirect = (location: string) => new Response("", { status: 303, headers: headers("text/html", { Location: location }) });
  const readForm = async (request: Request): Promise<Record<string, string>> => {
    if (request.headers.get("content-type")?.split(";")[0] !== "application/x-www-form-urlencoded") throw new AppError("unsupported_content_type", 415);
    const reader = request.body?.getReader(); if (!reader) throw new AppError("invalid_body");
    const chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 65536) { await reader.cancel(); throw new AppError("body_too_large", 413); } chunks.push(r.value); } }
    finally { reader.releaseLock(); }
    const fields = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    if (new Set(fields.keys()).size !== [...fields.keys()].length) throw new AppError("invalid_body");
    // A textarea posts every line break as CRLF; owner text is stored with LF.
    return Object.fromEntries([...fields].map(([name, value]) => [name, value.replaceAll("\r\n", "\n")]));
  };
  const only = (fields: Record<string, string>, required: string[], optional: string[] = []) => {
    if (required.some(name => !Object.hasOwn(fields, name)) || Object.keys(fields).some(name => !required.includes(name) && !optional.includes(name))) throw new AppError("invalid_body");
  };

  return async request => {
    const url = new URL(request.url);
    let locale: Locale = negotiateLocale(request.headers.get("accept-language"));
    try {
      if (url.origin !== origin.origin || (request.headers.get("host") && request.headers.get("host") !== origin.host)) throw new AppError("host_rejected", 403);
      if (request.method !== "GET" && request.method !== "POST") throw new AppError("method_rejected", 405);
      if (request.method === "POST" && request.headers.get("origin") !== origin.origin) throw new AppError("origin_rejected", 403);
      if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
        const asset = lookupS15Asset(url.pathname); if (!asset) throw new AppError("not_found", 404);
        return new Response(asset.body, { headers: { "Content-Type": asset.contentType, "Cache-Control": "public, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": s14ContentSecurityPolicy } });
      }
      const cookies = (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${options.cookieName}=`));
      if (cookies.length !== 1) {
        if (request.method === "GET" && !url.pathname.endsWith("/events")) return redirect(options.loginPath);
        throw new AppError("authentication_required", 401);
      }
      const { actor, csrf } = ports.authentication.authenticate(cookies[0]!.slice(options.cookieName.length + 1));
      locale = ports.locale?.(actor) ?? locale;
      const fields = request.method === "POST" ? await readForm(request) : {};
      if (request.method === "POST") { ports.authentication.verifyCsrf(csrf, fields.csrf); if (!idPattern.test(fields.requestId ?? "")) throw new AppError("invalid_body"); }
      const render = (body: () => string, status = 200) => html(withLocale(locale, body), status, locale);

      // Navigation reads: recent conversations and every item that truly waits on the owner.
      const needs = (): S15NeedItem[] => ports.conversation.needs(actor);
      const nav = (current: string): S15Nav => ({ conversations: ports.conversation.list(actor), needs: needs().length, current });
      const computerStatus = (): VmStatus | null => { if (!ports.computer) return null; try { return ports.computer.status(actor, ports.computer.vmId); } catch (error) { if (codeOf(error) === "vm_not_enrolled") return null; throw error; } };
      const accounts = () => ports.accounts?.list(actor) ?? null;
      const memoryClaims = (): S15MemoryClaim[] | null => ports.memory ? ports.memory.view(actor).claims : null;
      const models = (workId?: string): S15ModelBudgetView | null => ports.models ? ports.models.project(actor, workId) : null;

      const chatPage = (conversationId: string, extra: Partial<S15ChatPage> = {}, status = 200) => {
        let view: ConversationOwnerView | null = null;
        try { view = ports.conversation.view(actor, conversationId); } catch (error) { if (codeOf(error) !== "authentication_required") view = null; else throw error; }
        if (view && !view.rows.length) view = null;
        const claims = view?.rows.some(row => (row as { memory?: unknown }).memory) ? memoryClaims() : null;
        const extras: Record<string, S15RowExtras> = {};
        for (const row of view?.rows ?? []) {
          const retained = ((row as { memory?: { retained?: { id: string }[] } | null }).memory?.retained ?? []).map(item => item.id);
          let selection: S15RowExtras["selection"] = null, pinned = false;
          if (row.scopeLine && ports.models) { try { const projection = ports.models.project(actor, row.scopeLine.authorityId); selection = projection.selections.filter(item => item.workId === row.scopeLine!.authorityId).at(-1) ?? null; pinned = projection.pins.some(item => item.workId === row.scopeLine!.authorityId && item.pins.model !== null); } catch { selection = null; } }
          let readiness: S15RowExtras["readiness"] = null;
          if (ports.readiness && row.intentLine === "report_only" && row.result) { try { readiness = ports.readiness(actor, row.requestId); } catch { readiness = null; } }
          extras[row.requestId] = { readiness, selection, pinned, memory: claims?.filter(claim => retained.includes(claim.id)) ?? [] };
        }
        const prefill = (() => {
          if (extra.draft) return extra.draft;
          const start = url.searchParams.get("start"), answer = url.searchParams.get("answer"), pick = url.searchParams.get("pick");
          if (start && /^\d{1,9}$/.test(start)) {
            const ready = Object.values(extras).some(item => item.readiness?.rows.some(entry => entry.issue === Number(start) && entry.state === "ready"));
            if (ready) return { text: withLocale(locale, () => tr("s15.readiness.start_text")).replace("{issue}", start), requestId: null, answer: null };
          }
          const question = openQuestion(view);
          if (answer && question && question.requestId === answer && pick && /^\d$/.test(pick)) {
            const choice = question.question!.candidates[Number(pick)];
            if (choice) return { text: withLocale(locale, () => tr("s15.question.reply_text")).replace("{choice}", choice), requestId: null, answer: { requestId: question.requestId, revision: question.revision } };
          }
          return null;
        })();
        const dupId = url.searchParams.get("dup"), duplicate = dupId ? view?.rows.find(row => row.requestId === dupId) ?? null : null;
        const page: S15ChatPage = { csrf, conversationId, view, extras, draft: prefill, refused: null, duplicate, memoryAvailable: !!ports.memory, ...extra };
        const live = !!view?.rows.some(liveRow), cursor = view?.cursor ?? 0;
        return render(() => shell(nav(`/chats/${conversationId}`), tr("s15.chat.title"), threadHtml(page), { dock: `<div class="s-dock">${composer(page)}</div>`, live, conversationId, cursor }), status);
      };

      const setupPage = (notices: { computer?: string | null; rules?: string | null; installed?: boolean } = {}, status = 200) => {
        const status_ = computerStatus(), current = ports.rules?.current(actor) ?? null, rows = accounts();
        let proposal = null;
        if (ports.rules && !current) proposal = ports.rules.propose(actor, reviewed?.budget ?? null);
        return render(() => shell(nav("/setup"), tr("s15.setup.title"), setupBody({
          computer: computerCard({ csrf, unavailable: !ports.computer, status: status_, progress, hypervisor: ports.computer?.hypervisor ?? null, refused: notices.computer ?? null, address: progress.check?.host ?? "", return: "setup" }),
          computerDone: status_ !== null,
          models: accountRows(rows, "model"), modelsDone: !!rows?.some(row => row.kind === "model" && row.state !== "not_connected"),
          accounts: accountRows(rows, "service"),
          rules: rulesCard({ csrf, unavailable: !ports.rules, current, proposal, options: ports.rules?.budgetOptions(actor) ?? { currencies: [], periods: [] }, entry: reviewed?.entry ?? null, budget: reviewed?.budget ?? null, refused: notices.rules ?? null, installed: !!notices.installed }),
          rulesDone: current !== null,
        })), status);
      };
      const computerPage = (refused: string | null = null, status = 200) => {
        const status_ = computerStatus();
        return render(() => shell(nav("/resources/computer"), tr("s15.vm.title"), `<div class="s-col"><section class="s-card" aria-labelledby="s15-computer-title"><h2 id="s15-computer-title">${tr("s15.vm.title")}</h2>${computerCard({ csrf, unavailable: !ports.computer, status: status_, progress, hypervisor: ports.computer?.hypervisor ?? null, refused, address: progress.check?.host ?? "", return: "computer" })}</section></div>`), status);
      };
      const memoryPage = (state: Partial<S15MemoryPage> = {}, status = 200) => {
        const claims = memoryClaims(), filter = memoryFilter(url.searchParams.get("filter") ?? state.filter ?? null);
        let forgetting: S15MemoryPage["forgetting"] = null, refused = state.refused ?? null;
        const forgetId = url.searchParams.get("forget");
        if (claims && forgetId && ports.memory) {
          const claim = claims.find(item => item.id === forgetId && item.lifecycle === "active");
          if (claim) try {
            const result = ports.memory.command(actor, { contract: "s15-memory-command/v1", requestId: crypto.randomUUID().replaceAll("-", ""), kind: "memory.impact", claim: { id: claim.id, revision: claim.revision } }) as { impact: S15ForgetImpact };
            forgetting = { claim, impact: result.impact };
          } catch (error) { refused = codeOf(error); }
        }
        const saved = url.searchParams.get("saved");
        return render(() => shell(nav("/memory"), tr("s15.memory.title"), memoryBody({ csrf, claims, filter, correcting: url.searchParams.get("claim"), forgetting, refused, saved: saved === "corrected" || saved === "forgotten" ? saved : null, ...state })), status);
      };

      if (request.method === "GET") {
        if (url.pathname === "/") return redirect(ports.rules && ports.rules.current(actor) ? "/chats/new" : "/setup");
        if (url.pathname === "/chats/new") return redirect(`/chats/${crypto.randomUUID().replaceAll("-", "")}`);
        const chat = /^\/chats\/([A-Za-z0-9_-]{1,128})(\/events)?$/.exec(url.pathname);
        if (chat?.[2]) {
          const after = url.searchParams.get("after") ?? "0";
          if (!/^(?:0|[1-9]\d{0,15})$/.test(after)) throw new AppError("cursor_invalid", 409);
          return json({ ...ports.conversation.events(actor, chat[1]!, Number(after)), needs: needs().length });
        }
        if (chat) return chatPage(chat[1]!);
        if (url.pathname === "/needs") return render(() => shell(nav("/needs"), tr("s15.needs.title"), needsBody(needs())));
        if (url.pathname === "/setup") return setupPage();
        if (url.pathname === "/resources/computer") return computerPage();
        if (url.pathname === "/memory") return memoryPage();
        if (url.pathname === "/models") return render(() => shell(nav("/models"), tr("s15.models.title"), modelsBody(models(), accounts()?.find(row => row.kind === "model" && row.signInHref)?.signInHref ?? null)));
        throw new AppError("not_found", 404);
      }

      // Authenticated no-script commands. Each one names exactly what the owner pressed.
      if (url.pathname === "/s15/forms/message") {
        only(fields, ["csrf", "requestId", "conversationId", "text"], ["answer", "answerRevision"]);
        const conversationId = fields.conversationId!, text = fields.text!;
        if (!idPattern.test(conversationId)) throw new AppError("invalid_body");
        const answer = fields.answer ? { requestId: fields.answer, revision: Number(fields.answerRevision) } : null;
        if (answer && (!idPattern.test(answer.requestId) || !Number.isSafeInteger(answer.revision))) throw new AppError("invalid_body");
        let before: ConversationOwnerRow | undefined;
        try { before = ports.conversation.view(actor, conversationId).rows.find(row => row.requestId === fields.requestId); } catch { before = undefined; }
        try {
          if (!text.trim()) throw new AppError("message_empty");
          ports.conversation.submit(actor, { contract: "s15-conversation/v1", requestId: fields.requestId!, conversationId, text, continuation: answer });
        } catch (error) {
          const code = codeOf(error);
          if (code === "authentication_required") throw error;
          // Credential-shaped text is never echoed back into a page; everything else stays in the composer.
          const kept = code === "credential_content_refused" ? "" : text;
          return chatPage(conversationId, { refused: code, draft: { text: kept, requestId: code === "request_id_conflict" ? null : fields.requestId!, answer } }, statusOf(error) >= 500 ? 503 : 409);
        }
        void ports.conversation.drain().catch(() => {});
        return redirect(`/chats/${conversationId}${before ? `?dup=${fields.requestId}` : ""}#latest`);
      }
      if (url.pathname === "/s15/forms/stop") {
        only(fields, ["csrf", "requestId", "target"]);
        if (!idPattern.test(fields.target!)) throw new AppError("invalid_body");
        const target = ports.conversation.list(actor).find(item => ports.conversation.view(actor, item.conversationId).rows.some(row => row.requestId === fields.target));
        ports.conversation.stop(actor, fields.target!);
        return redirect(target ? `/chats/${target.conversationId}#s15-row-${fields.target}` : "/needs");
      }
      if (url.pathname.startsWith("/s15/forms/computer/")) {
        const computer = ports.computer; if (!computer) throw new AppError("not_found", 404);
        const back = (refused: string | null = null, status = 200) => fields.return === "computer" ? computerPage(refused, status) : setupPage({ computer: refused }, status);
        const done = () => redirect(fields.return === "computer" ? "/resources/computer" : "/setup#s15-setup-computer");
        try {
          if (url.pathname === "/s15/forms/computer/begin") { only(fields, ["csrf", "requestId", "return"]); const setup = await computer.begin(actor); progress.setup = { setupId: setup.setupId, command: setup.command }; progress.check = null; return done(); }
          if (url.pathname === "/s15/forms/computer/check") {
            only(fields, ["csrf", "requestId", "return", "setupId", "host"], ["port", "user"]);
            const port = fields.port ? Number(fields.port) : undefined;
            if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new AppError("vm_invalid_setup");
            const host = fields.host!.trim();
            const check = await computer.checkMachine(actor, { setupId: fields.setupId!, host, ...(port ? { port } : {}), ...(fields.user ? { user: fields.user.trim() } : {}), ...(computer.managerId ? { managerId: computer.managerId } : {}) });
            progress.check = { ...check, host }; return done();
          }
          if (url.pathname === "/s15/forms/computer/use") {
            only(fields, ["csrf", "requestId", "return", "checkId", "fingerprint"]);
            if (!progress.check || progress.check.checkId !== fields.checkId || progress.check.fingerprint !== fields.fingerprint) throw new AppError("vm_setup_expired");
            await computer.useMachine(actor, { id: computer.vmId, checkId: fields.checkId!, fingerprint: fields.fingerprint!, transportProfile: progress.check.transportProfile });
            progress.setup = null; progress.check = null; return done();
          }
          if (url.pathname === "/s15/forms/computer/forget-check") { only(fields, ["csrf", "requestId", "return"]); progress.check = null; return done(); }
        } catch (error) { if (codeOf(error) === "authentication_required") throw error; if (codeOf(error) === "vm_setup_expired") { progress.setup = null; progress.check = null; } return back(codeOf(error), 409); }
        throw new AppError("not_found", 404);
      }
      if (url.pathname.startsWith("/s15/forms/rules/")) {
        const rules = ports.rules; if (!rules) throw new AppError("not_found", 404);
        if (url.pathname === "/s15/forms/rules/review") {
          only(fields, ["csrf", "requestId", "amount"], ["currency", "periodId"]);
          const choices = rules.budgetOptions(actor), entry = { amount: fields.amount!.trim(), currency: fields.currency ?? "", periodId: fields.periodId ?? "" };
          const minor = choices.currencies.includes(entry.currency) ? toMinor(entry.amount, entry.currency) : null;
          if (!minor || !choices.periods.some(period => period.id === entry.periodId)) { reviewed = null; return setupPage({ rules: "finite_budget_required" }, 409); }
          reviewed = { entry, budget: { currency: entry.currency, spendMinor: minor, periodId: entry.periodId } };
          return redirect("/setup#s15-setup-rules");
        }
        if (url.pathname === "/s15/forms/rules/install") {
          only(fields, ["csrf", "requestId", "proposalHash"]);
          try { rules.install(actor, fields.requestId!, fields.proposalHash!); }
          catch (error) { if (codeOf(error) === "authentication_required") throw error; return setupPage({ rules: codeOf(error) }, 409); }
          reviewed = null; return setupPage({ installed: true });
        }
        throw new AppError("not_found", 404);
      }
      if (url.pathname === "/s15/forms/memory/correct" || url.pathname === "/s15/forms/memory/forget") {
        const memory = ports.memory; if (!memory) throw new AppError("not_found", 404);
        const correct = url.pathname.endsWith("/correct");
        only(fields, correct ? ["csrf", "requestId", "claimId", "claimRevision", "text", "filter"] : ["csrf", "requestId", "claimId", "claimRevision", "filter"]);
        const revision = Number(fields.claimRevision), filter = memoryFilter(fields.filter ?? null);
        if (!idPattern.test(fields.claimId!) || !Number.isSafeInteger(revision) || revision < 1) throw new AppError("invalid_body");
        try { memory.command(actor, { contract: "s15-memory-command/v1", requestId: fields.requestId!, kind: correct ? "memory.correct" : "memory.forget", claim: { id: fields.claimId!, revision }, ...(correct ? { text: fields.text! } : {}) }); }
        catch (error) { if (codeOf(error) === "authentication_required") throw error; return memoryPage({ refused: codeOf(error), filter }, 409); }
        return redirect(`/memory?filter=${filter}&saved=${correct ? "corrected" : "forgotten"}`);
      }
      throw new AppError("not_found", 404);
    } catch (error) {
      const code = codeOf(error), status = statusOf(error);
      if (url.pathname.endsWith("/events") || request.headers.get("accept")?.startsWith("application/json")) return json({ error: code }, status);
      if (code === "authentication_required") return request.method === "GET" ? redirect(options.loginPath) : html(withLocale(locale, () => standalonePage(tr("s15.error.title"), `<div class="s-notice-card" role="alert"><h1>${codeText(code)}</h1><p><a class="s-btn primary" data-sign-in href="${e(options.loginPath)}">${tr("s14.login.submit")}</a></p></div>`)), 401, locale);
      return html(withLocale(locale, () => standalonePage(tr("s15.error.title"), `<div class="s-notice-card">${refusal(code, tr("s15.error.title"))}<p><a class="s-btn primary" href="/">${tr("s15.error.home")}</a></p></div>`)), status, locale);
    }
  };
}
