import { AppError } from "../../errors";
import { negotiateLocale, tr, withLocale, type Locale } from "../../i18n";
import { s14ContentSecurityPolicy } from "../../s14/web";
import { conversationAction, conversationList, conversationOwnerView, conversationPendingNeeds, type ConversationApplication, type ConversationOwnerRow, type ConversationOwnerView } from "../conversation";
import { BrowserError } from "../browser";
import { PolicyError } from "../policy";
import type { VmStatus } from "../vm";
import { lookupS15Asset } from "./assets";
import { composer, displayState, liveRow, openQuestion, threadHtml, type S15ChatPage, type S15RowExtras } from "./chat";
import { memoryBody, memoryFilter, modelsBody, type S15MemoryPage } from "./manage";
import { fullSlip, slipKind, slipPayload, type S15SlipDecision } from "./actions";
import { browserNeedsYou, takeoverView, type S15BrowserInfo, type S15BrowserProgress } from "./browser";
import { dutyCard, dutyNeedsYou, workBody, type S15WorkRow } from "./duties";
import { accountsBody, needsBody, recoveryBody, restoreSection, teamPendingCard, type S15NeedItem } from "./resources";
import { websitesBody, type S15WebsitesSaved } from "./websites";
import { recurringProposalBody, rulesBody } from "./rules";
import { telegramBody, telegramSaved } from "./telegram";
import { parsePaymentAmount } from "../payments";
import type { ActionSlip } from "../policy";
import type { ResponsibilityProjection } from "../work";
import { codeText, e, fill, refusal, shell, standalonePage, type S15Nav } from "./render";
import { accountRows, computerCard, enrollmentFlow, ruleLists, rulesCard, setupBody, toMinor, type S15ComputerLocal, type S15ComputerProgress } from "./setup";
import { policyReviewCard } from "./policy-review";
import { githubConnectionBody } from "./github-connection";
import { addComputer, memberName, poolList } from "./computers";
import type { S15BudgetEntry, S15ForgetImpact, S15GithubCapture, S15MemoryClaim, S15ModelBudgetView, S15WebConversation, S15WebPorts } from "./types";

/** Adapts the real CHAT15-01 application to the Web consumer seam; reading starts no model, tool or queue. */
export function s15ConversationPort<Actor, Work>(app: ConversationApplication<Actor, Work>): S15WebConversation<Actor> {
  return { view: (actor, id) => conversationOwnerView(app, actor, id), list: actor => conversationList(app, actor), submit: (actor, command) => app.submit(actor, command),
    stop: (actor, id) => app.stop(actor, id), events: (actor, id, after) => app.events(actor, id, after), needs: actor => conversationPendingNeeds(app, actor), action: (actor, id) => conversationAction(app, actor, id), decide: (actor, command) => app.decide(actor, command), drain: () => app.drain() };
}

/** Explicit opt-in mount options. S14 never mounts this handler; only S15 composition does. */
export interface S15WebOptions { origin: string; cookieName: string; loginPath: string; now?: () => number }
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const codeOf = (error: unknown) => error instanceof AppError || error instanceof PolicyError || error instanceof BrowserError ? error.code : "conversation_unavailable";
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
  // Last protected browser observation per site. Owner-typed values are never kept here or anywhere in this handler.
  const browserState = new Map<string, S15BrowserProgress>();
  let githubCapture: S15GithubCapture | null = null;
  /** WORK15-02: durable settlement of owner stall replies whose own CHAT request finished. Holds no state here. */
  const settleResumes = () => { try { ports.resumes?.settle(); } catch { /* The protected drain retries; a page still renders. */ } };
  const now = options.now ?? Date.now;
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
      // A decision message and its source request both reference the same exact action; list it once.
      const needs = (): S15NeedItem[] => [...new Map(ports.conversation.needs(actor).map(item => [item.entry.id, item] as const)).values()];
      const dutyList = (): ResponsibilityProjection[] | null => { if (!ports.duties) return null; try { return ports.duties.list(actor); } catch (error) { if (codeOf(error) === "authentication_required") throw error; return null; } };
      const browsers = () => (ports.browsers ?? []).map(browser => ({ browser: { id: browser.id, site: browser.site, twoFactor: browser.twoFactor, fields: browser.fields } as S15BrowserInfo, state: browserState.get(browser.id) }));
      const needsCount = () => needs().length + (dutyList()?.filter(dutyNeedsYou).length ?? 0) + browsers().filter(item => browserNeedsYou(item.state)).length;
      const nav = (current: string): S15Nav => ({ conversations: ports.conversation.list(actor), needs: needsCount(), current });
      // Every bounded conversation view the owner can read; decisions and slips are found only through them.
      let viewCache: ConversationOwnerView[] | null = null;
      const views = (): ConversationOwnerView[] => viewCache ??= ports.conversation.list(actor).flatMap(item => { try { return [ports.conversation.view(actor, item.conversationId)]; } catch (error) { if (codeOf(error) === "authentication_required") throw error; return []; } });
      const decisions = (conversationId?: string): S15SlipDecision[] => views().filter(view => !conversationId || view.conversationId === conversationId).flatMap(view => view.rows.filter(row => row.decision).map(row => ({ row, conversationId: view.conversationId })));
      const findSlip = (actionId: string, revision: number | null): { slip: ActionSlip; conversationId: string; latest: ActionSlip } | null => {
        if (ports.conversation.action) {
          const found = ports.conversation.action(actor, actionId); if (!found?.slips.length) return null;
          const latest = found.slips.reduce((a, b) => b.action.revision > a.action.revision ? b : a);
          const slip = revision === null ? latest : found.slips.find(item => item.action.revision === revision);
          return slip ? { slip, conversationId: found.conversationId, latest } : null;
        }
        for (const view of views()) for (const row of view.rows) {
          const matches = row.slips.filter(slip => slip.action.id === actionId); if (!matches.length) continue;
          const latest = matches.reduce((a, b) => b.action.revision > a.action.revision ? b : a);
          const slip = revision === null ? latest : matches.find(item => item.action.revision === revision); if (slip) return { slip, conversationId: view.conversationId, latest };
        }
        return null;
      };
      const computerStatus = (): VmStatus | null => { if (!ports.computer) return null; try { return ports.computer.status(actor, ports.computer.vmId); } catch (error) { if (codeOf(error) === "vm_not_enrolled") return null; throw error; } };
      const localView = (): S15ComputerLocal | undefined => ports.computer?.local ? { host: ports.computer.local.host(actor), job: ports.computer.local.job(actor), now: now() } : undefined;
      const poolMembers = () => ports.computer?.pool?.members(actor) ?? null;
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
          const plain = (name: Parameters<typeof tr>[0], values: Record<string, string> = {}) => ({ text: withLocale(locale, () => tr(name)).replace(/\{([a-z_]+)\}/g, (all, slot: string) => values[slot] ?? all), requestId: null, answer: null });
          const revise = url.searchParams.get("revise"), again = url.searchParams.get("again");
          const ownSlip = (id: string | null) => id ? view?.rows.flatMap(row => row.slips).find(slip => slip.action.id === id) ?? null : null;
          const revised = ownSlip(revise);
          if (revised) return plain(slipKind(revised) === "email" ? "s15.prefill.revise_email" : "s15.prefill.revise");
          if (ownSlip(again)) return plain(url.searchParams.get("mode") === "investigate" ? "s15.prefill.investigate" : "s15.prefill.again");
          const dutyId = url.searchParams.get("duty");
          if (dutyId && ports.duties && idPattern.test(dutyId)) {
            let duty: ResponsibilityProjection | null = null; try { duty = ports.duties.project(actor, dutyId); } catch { duty = null; }
            if (duty && duty.conversationId === conversationId) {
              const reply = url.searchParams.get("reply"), accept = url.searchParams.get("accept");
              const subject = duty.subject?.startsWith("issue:") ? `#${duty.subject.slice(6)} · ` : "";
              if (reply === "recommended" && duty.report && duty.state === "paused") return { text: `${subject}${withLocale(locale, () => tr("s15.prefill.try_recommended"))}${duty.report.recommendation}`, requestId: null, answer: null, duty: duty.id };
              if (reply === "other" && duty.report && duty.state === "paused") return { text: `${subject}${withLocale(locale, () => tr("s15.prefill.other_way"))}`, requestId: null, answer: null, duty: duty.id };
              const proposal = accept ? duty.proposals.find(item => item.eventId === accept) : null;
              if (proposal) return plain("s15.prefill.accept_outside", { ref: proposal.evidenceRefs[0] ?? proposal.eventId });
            }
          }
          const skip = url.searchParams.get("skip"), site = skip ? ports.browsers?.find(item => item.id === skip) : null;
          if (site) return plain("s15.prefill.skip_site", { site: site.site });
          if (url.searchParams.get("skip_step") && view?.rows.some(row => row.requestId === url.searchParams.get("skip_step"))) return plain("s15.prefill.skip_step");
          const question = openQuestion(view);
          if (answer && question && question.requestId === answer && pick && /^\d$/.test(pick)) {
            const choice = question.question!.candidates[Number(pick)];
            if (choice) return { text: withLocale(locale, () => tr("s15.question.reply_text")).replace("{choice}", choice), requestId: null, answer: { requestId: question.requestId, revision: question.revision } };
          }
          return null;
        })();
        const dupId = url.searchParams.get("dup"), duplicate = dupId ? view?.rows.find(row => row.requestId === dupId) ?? null : null;
        const duties = view ? dutyList() ?? [] : [];
        const sites = browsers();
        const page: S15ChatPage = { csrf, conversationId, view, extras, draft: prefill, refused: null, duplicate, memoryAvailable: !!ports.memory,
          decisions: view ? view.rows.filter(row => row.decision).map(row => ({ row, conversationId })) : [], duties: duties.filter(duty => duty.conversationId === conversationId),
          browser: sites.length === 1 ? sites[0]! : null, canDecide: !!ports.conversation.decide, ...extra };
        const live = !!view?.rows.some(liveRow), cursor = view?.cursor ?? 0;
        return render(() => shell(nav(`/chats/${conversationId}`), tr("s15.chat.title"), threadHtml(page), { dock: `<div class="s-dock">${composer(page)}</div>`, live, conversationId, cursor }), status);
      };

      // Resources the rules/computer refer to that TEAM has not registered; null when TEAM is not composed.
      const teamPending = () => ports.team?.pending ? ports.team.pending(actor) : null;
      // POLICY15-02: the protected default proposal (new, update or renewal), rendered as one exact review card.
      const policyReview = (back: "setup" | "rules", refused: string | null) => {
        const review = ports.rules?.review?.(actor, reviewed?.budget ?? null) ?? null; if (!review) return null;
        const current = ports.rules!.current(actor);
        const options = ports.rules!.budgetOptions(actor);
        // Rendered later inside the owner's locale.
        return { review, html: () => policyReviewCard({ csrf, review, back, options, entry: reviewed?.entry ?? null, budget: reviewed?.budget ?? null, refused, currentExpiresAt: current?.expiresAt ?? null, now: now() }) };
      };
      const setupPage = (notices: { computer?: string | null; rules?: string | null; installed?: boolean; team?: string | null; teamRegistered?: boolean } = {}, status = 200) => {
        const status_ = computerStatus(), current = ports.rules?.current(actor) ?? null, rows = accounts(), pending = teamPending(), local = status_ ? undefined : localView();
        const review = policyReview("setup", notices.rules ?? null);
        let proposal = null;
        if (ports.rules && !current && !review) proposal = ports.rules.propose(actor, reviewed?.budget ?? null);
        const options = ports.rules?.budgetOptions(actor) ?? { currencies: [], periods: [] };
        const rulesHtml = () => review ? `${current ? rulesCard({ csrf, unavailable: false, current, proposal: null, options: { currencies: [], periods: [] }, entry: null, budget: null, refused: null, installed: !!notices.installed }) : ruleLists(false)}${review.review.change === "current" && current ? "" : review.html()}`
          : rulesCard({ csrf, unavailable: !ports.rules, current, proposal, options, entry: reviewed?.entry ?? null, budget: reviewed?.budget ?? null, refused: notices.rules ?? null, installed: !!notices.installed });
        // The review's own install press registers the same TEAM list, so its separate card would ask twice.
        const teamCard = review?.review.team && !current ? "" : null;
        return render(() => shell(nav("/setup"), tr("s15.setup.title"), setupBody({
          computer: computerCard({ csrf, unavailable: !ports.computer, status: status_, progress, hypervisor: ports.computer?.hypervisor ?? null, refused: notices.computer ?? null, address: progress.check?.host ?? "", return: "setup", ...(local ? { local } : {}) }),
          // Done only from a registered computer; a running or failed job, or a host fact, is never "done".
          computerDone: status_ !== null || !!poolMembers()?.length,
          models: accountRows(rows, "model"), modelsDone: !!rows?.some(row => row.kind === "model" && row.state !== "not_connected"),
          accounts: accountRows(rows, "service"),
          rules: rulesHtml()
            + (teamCard ?? teamPendingCard({ pending, csrf, back: "setup", registered: !!notices.teamRegistered, refused: notices.team ?? null })),
          // Work cannot use a resource TEAM has not registered, so setup is unfinished until the owner confirms them.
          rulesDone: current !== null && current.expiresAt > now() && !pending?.items.length,
        })), status);
      };
      const accountsPage = (state: { registered?: boolean; refused?: string | null } = {}, status = 200) => {
        let team = null; try { team = ports.team ? ports.team.view(actor).resources : null; } catch (error) { if (codeOf(error) === "authentication_required") throw error; team = null; }
        let pending = null; try { pending = team ? teamPending() : null; } catch (error) { if (codeOf(error) === "authentication_required") throw error; pending = null; }
        return render(() => shell(nav("/resources/accounts"), tr("s15.resources.title"), accountsBody({ team, accounts: accounts(), browsers: browsers(), csrf, teamPending: teamPendingCard({ pending, csrf, back: "resources", registered: !!state.registered, refused: state.refused ?? null }) })), status);
      };
      // BROW15-02: a saved notice is shown only when the current list agrees with it.
      const websitesPage = (state: { refused?: { code: string; at: "add" | "list" }; entry?: string } = {}, status = 200) => {
        const websites = ports.websites, sites = websites ? websites.list(actor) : null, engine = websites ? websites.status(actor) : null;
        const added = url.searchParams.get("added"), removed = url.searchParams.get("removed");
        const saved: S15WebsitesSaved = state.refused ? null : added && sites?.some(site => site.origin === added) ? { kind: "added", origin: added } : removed && sites && !sites.some(site => site.origin === removed) && /^https:\/\/[a-z0-9.:-]{1,300}$/.test(removed) ? { kind: "removed", origin: removed } : url.searchParams.get("retried") === "1" ? { kind: "retried" } : null;
        return render(() => shell(nav("/resources/websites"), tr("s15.websites.title"), websitesBody({ engine, sites, browsers: browsers(), csrf, saved, refused: state.refused ?? null, entry: state.entry ?? "" })), status);
      };
      const computerPage = (refused: string | null = null, status = 200, restore: { restore: string | null; restored: boolean; refused?: string | null; vm?: string | null } = { restore: null, restored: false }, notice: { saved?: "drained" | "undrained" | null; vmId?: string | null; refused?: string | null; managerRefused?: string | null; managerSaved?: boolean } = {}) => {
        const status_ = computerStatus(), computer = ports.computer, members = poolMembers();
        const snapshotsOf = (id: string) => status_ !== null || members?.length ? computer?.snapshots && computer.restore ? (() => { try { return computer.snapshots!(actor, id); } catch (error) { if (codeOf(error) === "authentication_required") throw error; return null; } })() : null : null;
        const card = { csrf, unavailable: !ports.computer, status: status_, progress, hypervisor: ports.computer?.hypervisor ?? null, refused, address: progress.check?.host ?? "", return: "computer" as const };
        if (members?.length) {
          // POOL15-01: every enrolled computer, a not-yet-created default (job or fallback), and "add another".
          const pending = status_ ? "" : (() => { const local = localView(); return local?.job && local.job.state !== "enrolled" ? `<section class="s-card" aria-labelledby="s15-computer-main-title"><h2 id="s15-computer-main-title">${tr("s15.pool.main")}</h2>${computerCard({ ...card, refused: null, local })}</section>` : ""; })();
          const restores = members.map((member, index) => restoreSection({ csrf, status: member.status, snapshots: snapshotsOf(member.id), selected: (restore.vm ?? computer!.vmId) === member.id ? restore.restore : null, hypervisor: computer?.hypervisor ?? null,
            refused: (restore.vm ?? computer!.vmId) === member.id ? restore.refused ?? null : null, restored: restore.restored && (restore.vm ?? computer!.vmId) === member.id, ...(member.id === computer!.vmId ? {} : { member: { id: member.id, name: memberName(member, index) } }) })).join("");
          return render(() => shell(nav("/resources/computer"), tr("s15.vm.title"), `<div class="s-col"><section class="s-card" aria-labelledby="s15-computer-title"><h2 id="s15-computer-title">${tr("s15.vm.title")}</h2>${poolList({ members, csrf, hypervisor: computer?.hypervisor ?? null, saved: notice.saved ?? null, savedId: notice.vmId ?? null, refused: notice.refused ?? null, refusedId: notice.vmId ?? null })}</section>
          ${pending}${addComputer({ flow: enrollmentFlow(card), managed: !!computer!.managerId, canRegister: !!computer!.pool?.registerManager, csrf, refused: notice.managerRefused ?? (computer!.managerId ? null : refused), saved: !!notice.managerSaved })}${restores}</div>`), status);
        }
        const snapshots = snapshotsOf(computer?.vmId ?? "");
        return render(() => shell(nav("/resources/computer"), tr("s15.vm.title"), `<div class="s-col"><section class="s-card" aria-labelledby="s15-computer-title"><h2 id="s15-computer-title">${tr("s15.vm.title")}</h2>${computerCard({ ...card, ...(status_ ? {} : (() => { const local = localView(); return local ? { local } : {}; })()) })}</section>
          ${restoreSection({ csrf, status: status_, snapshots, selected: restore.restore, hypervisor: computer?.hypervisor ?? null, refused: restore.refused ?? null, restored: restore.restored })}</div>`), status);
      };
      const actionPage = (actionId: string, revision: number | null, state: { checked?: boolean; refused?: string | null } = {}, status = 200) => {
        const found = findSlip(actionId, revision); if (!found) throw new AppError("not_found", 404);
        const { slip, conversationId, latest } = found;
        let card = null; if (ports.decisions && slip.action.classes.includes("major_change")) { try { card = ports.decisions(actor, { id: slip.action.id, revision: slip.action.revision, actionHash: slip.action.actionHash }); } catch (error) { if (codeOf(error) === "authentication_required") throw error; card = null; } }
        const policy = ports.rules?.current(actor) ?? null;
        return render(() => shell(nav(`/actions/${actionId}`), tr("s15.slip.page_title"), `<div class="s-col"><p><a class="s-link-text" href="/chats/${e(conversationId)}#latest">${tr("s15.slip.back")}</a></p>${fullSlip({ csrf, conversationId, slip, decisions: decisions(conversationId).filter(item => item.row.decision?.action.id === actionId), policy, replacement: slip.state === "changed" && latest !== slip ? latest : null, card, canDecide: !!ports.conversation.decide, canCheck: !!ports.actions, recurring: !!ports.recurring, refused: state.refused ?? null, checked: !!state.checked })}</div>`, { subtitle: `r${slip.action.revision}` }), status);
      };
      const attachment = (actionId: string, revision: number | null, index: number) => {
        const found = findSlip(actionId, revision); if (!found) throw new AppError("not_found", 404);
        const payload = slipPayload(found.slip) as { contract?: unknown; kind?: unknown; attachments?: { name?: unknown; dataBase64?: unknown }[] } | null;
        const file = payload?.contract === "s15-google-effect/v1" && payload.kind === "mail" && Array.isArray(payload.attachments) ? payload.attachments[index] : undefined;
        if (!file || typeof file.dataBase64 !== "string" || typeof file.name !== "string") throw new AppError("not_found", 404);
        // Exact attachment bytes from the prepared payload, always as a download and never rendered by this origin.
        return new Response(Buffer.from(file.dataBase64, "base64"), { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; sandbox" } });
      };
      const rulesPage = (state: { refused?: string | null; saved?: string | null; review?: string | null } = {}, status = 200) => {
        const policy = ports.rules?.current(actor) ?? null, review = policyReview("rules", state.review ?? null);
        const payments = ports.recurring ? views().flatMap(view => view.rows.flatMap(row => row.slips)).filter(slip => slip.action.transaction && slip.state === "succeeded" && slip.action.classes.every(c => c === "financial")) : [];
        const unique = [...new Map(payments.map(slip => [`${slip.action.transaction!.payee.id}:${slip.action.transaction!.account.id}:${slip.action.transaction!.currency}`, slip])).values()].slice(0, 16);
        return render(() => shell(nav("/rules"), tr("s15.rules.title"), rulesBody({ csrf, policy, rulesAvailable: !!ports.rules, recurring: ports.recurring ? { frequencies: ports.recurring.frequencies(), payments: unique.map(slip => ({ slip })) } : null, github: ports.github ? { capture: githubCapture } : null, refused: state.refused ?? null, saved: state.saved ?? url.searchParams.get("saved"), review: review ? review.html() : "" })), status);
      };
      const githubPage = (refused: string | null = null, status = 200) => {
        const saved = url.searchParams.get("saved");
        return render(() => shell(nav("/resources/github"), tr("s15.ghc.title"), githubConnectionBody({ csrf, view: ports.githubConnection ? ports.githubConnection.view(actor) : null, refused, saved: saved === "connected" || saved === "selected" || saved === "removed" ? saved : null, now: now() })), status);
      };
      const recurringPage = (from: string | null, r: string | null, state: { proposal?: import("../policy").RecurringRuleProposal | null; ceiling?: string; frequencyId?: string; refused?: string | null } = {}, status = 200) => {
        if (!ports.recurring || !from || !idPattern.test(from)) throw new AppError("not_found", 404);
        const found = findSlip(from, r && /^[1-9]\d{0,8}$/.test(r) ? Number(r) : null); if (!found?.slip.action.transaction) throw new AppError("not_found", 404);
        const t = found.slip.action.transaction, ceiling = state.ceiling ?? (() => { const d = t.amountMinor.padStart(t.minorUnit + 1, "0"); return t.minorUnit ? `${d.slice(0, -t.minorUnit)}.${d.slice(-t.minorUnit)}` : d; })();
        return render(() => shell(nav("/rules"), tr("s15.rules.recurring_title"), recurringProposalBody({ csrf, slip: found.slip, frequencies: ports.recurring!.frequencies(), proposal: state.proposal ?? null, ceiling, frequencyId: state.frequencyId ?? "", refused: state.refused ?? null, fromJit: false })), status);
      };
      const telegramPage = (refused: string | null = null, status = 200) => render(() => shell(nav("/resources/telegram"), tr("s15.telegram.title"),
        telegramBody({ status: ports.telegram ? ports.telegram.status(actor) : null, csrf, refused, saved: refused ? null : telegramSaved(url.searchParams.get("saved")), now: now() })), status);
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
        settleResumes();
        if (url.pathname === "/") return redirect(ports.rules && ports.rules.current(actor) ? "/chats/new" : "/setup");
        if (url.pathname === "/chats/new") return redirect(`/chats/${crypto.randomUUID().replaceAll("-", "")}`);
        const chat = /^\/chats\/([A-Za-z0-9_-]{1,128})(\/events)?$/.exec(url.pathname);
        if (chat?.[2]) {
          const after = url.searchParams.get("after") ?? "0";
          if (!/^(?:0|[1-9]\d{0,15})$/.test(after)) throw new AppError("cursor_invalid", 409);
          return json({ ...ports.conversation.events(actor, chat[1]!, Number(after)), needs: needs().length });
        }
        if (chat) return chatPage(chat[1]!);
        if (url.pathname === "/needs") return render(() => shell(nav("/needs"), tr("s15.needs.title"), needsBody({ items: needs(), decisions: decisions(), duties: dutyList() ?? [], browsers: browsers(), csrf })));
        const action = /^\/actions\/([A-Za-z0-9_-]{1,128})(?:\/attachments\/(\d{1,2}))?$/.exec(url.pathname);
        if (action) {
          const r = url.searchParams.get("r"), revision = r && /^[1-9]\d{0,8}$/.test(r) ? Number(r) : null;
          if (action[2] !== undefined) return attachment(action[1]!, revision, Number(action[2]));
          return actionPage(action[1]!, revision, { checked: url.searchParams.get("checked") === "1" });
        }
        if (url.pathname === "/work") {
          const rows = views().flatMap(view => view.rows.filter(row => !row.decision).map(row => ({ conversationId: view.conversationId, requestId: row.requestId, ownerMessage: row.ownerMessage, state: displayState(row), at: row.receipt.receivedAt })));
          const pick = (states: string[]) => rows.filter(row => states.includes(row.state)).sort((a, b) => b.at - a.at).slice(0, 20) as S15WorkRow[];
          const login = views().flatMap(view => view.rows.filter(row => row.needsYou?.code === "login_required").map(row => ({ conversationId: view.conversationId, requestId: row.requestId, ownerMessage: row.ownerMessage, state: "waiting_login" as const, at: row.receipt.receivedAt })));
          return render(() => shell(nav("/work"), tr("s15.work.page_title"), workBody({ needs: needsCount(), duties: dutyList(), working: pick(["received", "understanding", "inspecting", "working"]), waiting: login, done: pick(["done", "partial", "stopped"]), csrf })));
        }
        const duty = /^\/duties\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
        if (duty) {
          if (!ports.duties) throw new AppError("not_found", 404);
          const projection = ports.duties.project(actor, duty[1]!);
          const refused = ports.resumes?.refusal(actor, projection.id) ?? null;
          return render(() => shell(nav("/work"), tr("s15.duty.title"), `<div class="s-col">${refused && projection.state === "paused" ? refusal(refused, tr("s15.duty.resume_refused")) : ""}${dutyCard(projection, csrf, true)}<p><a class="s-link-text" href="/chats/${e(projection.conversationId)}#s15-row-${e(projection.sourceRequestId)}">${tr("s15.duty.open_conversation")}</a></p></div>`));
        }
        if (url.pathname === "/rules") return rulesPage();
        if (url.pathname === "/rules/recurring") return recurringPage(url.searchParams.get("from"), url.searchParams.get("r"));
        if (url.pathname === "/resources/accounts") return accountsPage({ registered: url.searchParams.get("team") === "registered" });
        if (url.pathname === "/resources/telegram") return telegramPage();
        if (url.pathname === "/resources/websites") return websitesPage();
        if (url.pathname === "/resources/github") return githubPage();
        if (url.pathname === "/recovery") {
          const all = needs(), adoption = ports.adoption ? (() => { try { return ports.adoption!(actor); } catch (error) { if (codeOf(error) === "authentication_required") throw error; return null; } })() : null;
          const pending = (dutyList()?.filter(item => item.state === "reconcile_only").length ?? 0) + views().reduce((n, view) => n + view.rows.filter(row => row.state === "unknown" && !row.slips.length).length, 0);
          return render(() => shell(nav("/recovery"), tr("s15.recovery.title"), recoveryBody({ unknown: all.filter(item => item.entry.kind === "reconciliation" && item.entry.slip), decisions: decisions(), pending, adoption, adoptionAvailable: !!ports.adoption })));
        }
        const site = /^\/browser\/([A-Za-z0-9_-]{1,128})(\/frame)?$/.exec(url.pathname);
        if (site) {
          const browser = ports.browsers?.find(item => item.id === site[1]); if (!browser) throw new AppError("not_found", 404);
          const state = browserState.get(browser.id);
          if (site[2]) {
            const g = url.searchParams.get("g");
            if (!state || state.login !== "owner_control" || state.generation === null || g !== String(state.generation)) throw new AppError("stale_input", 409);
            const bytes = await browser.owner.frame(actor, state.generation);
            return new Response(new Blob([new Uint8Array(bytes)]), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": s14ContentSecurityPolicy } });
          }
          if (!state || state.login !== "owner_control" || state.generation === null) return redirect("/needs#s15-needs-login");
          return render(() => shell(nav("/needs"), fill("s15.browser.view_title", { site: browser.site }), takeoverView(browsers().find(item => item.browser.id === browser.id)!.browser, state, csrf, url.searchParams.get("refused"))));
        }
        if (url.pathname === "/setup") return setupPage({ teamRegistered: url.searchParams.get("team") === "registered" });
        if (url.pathname === "/resources/computer") {
          const saved = url.searchParams.get("saved"), vm = url.searchParams.get("vm");
          return computerPage(null, 200, { restore: url.searchParams.get("restore"), restored: url.searchParams.get("restored") === "1", vm: vm && idPattern.test(vm) ? vm : null },
            { saved: saved === "drained" || saved === "undrained" ? saved : null, vmId: vm && idPattern.test(vm) ? vm : null, managerSaved: saved === "manager" });
        }
        if (url.pathname === "/memory") return memoryPage();
        if (url.pathname === "/models") return render(() => shell(nav("/models"), tr("s15.models.title"), modelsBody(models(), accounts()?.find(row => row.kind === "model" && row.signInHref)?.signInHref ?? null)));
        throw new AppError("not_found", 404);
      }

      // Authenticated no-script commands. Each one names exactly what the owner pressed.
      if (url.pathname === "/s15/forms/message") {
        only(fields, ["csrf", "requestId", "conversationId", "text"], ["answer", "answerRevision", "duty"]);
        const conversationId = fields.conversationId!, text = fields.text!;
        if (!idPattern.test(conversationId)) throw new AppError("invalid_body");
        // A stall reply names its paused responsibility; only one of this conversation can be named.
        const dutyId = fields.duty ?? null;
        if (dutyId !== null) {
          if (!ports.duties || !ports.resumes || !idPattern.test(dutyId) || fields.answer !== undefined) throw new AppError("invalid_body");
          const named = ports.duties.project(actor, dutyId);
          if (named.conversationId !== conversationId || named.state !== "paused") throw new AppError("stale_revision", 409);
        }
        const answer = fields.answer ? { requestId: fields.answer, revision: Number(fields.answerRevision) } : null;
        if (answer && (!idPattern.test(answer.requestId) || !Number.isSafeInteger(answer.revision))) throw new AppError("invalid_body");
        let before: ConversationOwnerRow | undefined;
        try { before = ports.conversation.view(actor, conversationId).rows.find(row => row.requestId === fields.requestId); } catch { before = undefined; }
        try {
          if (!text.trim()) throw new AppError("message_empty");
          const command = { contract: "s15-conversation/v1" as const, requestId: fields.requestId!, conversationId, text, continuation: answer };
          // A stall reply and its durable resume binding commit together; WORK decides only after CHAT completes it.
          if (dutyId) ports.resumes!.submit(actor, command, dutyId); else ports.conversation.submit(actor, command);
        } catch (error) {
          const code = codeOf(error);
          if (code === "authentication_required") throw error;
          // Credential-shaped text is never echoed back into a page; everything else stays in the composer.
          const kept = code === "credential_content_refused" ? "" : text;
          return chatPage(conversationId, { refused: code, draft: { text: kept, requestId: code === "request_id_conflict" ? null : fields.requestId!, answer, ...(dutyId ? { duty: dutyId } : {}) } }, statusOf(error) >= 500 ? 503 : 409);
        }
        void ports.conversation.drain().then(settleResumes).catch(() => {});
        return redirect(`/chats/${conversationId}${before ? `?dup=${fields.requestId}` : ""}#latest`);
      }
      if (url.pathname === "/s15/forms/stop") {
        only(fields, ["csrf", "requestId", "target"]);
        if (!idPattern.test(fields.target!)) throw new AppError("invalid_body");
        const target = ports.conversation.list(actor).find(item => ports.conversation.view(actor, item.conversationId).rows.some(row => row.requestId === fields.target));
        ports.conversation.stop(actor, fields.target!);
        return redirect(target ? `/chats/${target.conversationId}#s15-row-${fields.target}` : "/needs");
      }
      if (url.pathname.startsWith("/s15/forms/action/")) {
        only(fields, ["csrf", "requestId", "conversationId", "actionId", "revision", "actionHash"], ["decision", "outcome"]);
        const revision = Number(fields.revision), ref = { id: fields.actionId!, revision, actionHash: fields.actionHash! };
        if (!idPattern.test(fields.conversationId!) || !idPattern.test(ref.id) || !Number.isSafeInteger(revision) || revision < 1 || !/^[a-f0-9]{64}$/.test(ref.actionHash)) throw new AppError("invalid_body");
        const back = (code: string) => actionPage(ref.id, revision, { refused: code }, 409);
        try {
          if (url.pathname === "/s15/forms/action/decide") {
            if (!ports.conversation.decide || (fields.decision !== "approve" && fields.decision !== "deny") || fields.outcome !== undefined) throw new AppError("not_found", 404);
            ports.conversation.decide(actor, { contract: "s15-conversation-decision/v1", requestId: fields.requestId!, conversationId: fields.conversationId!, action: ref, decision: fields.decision });
            void ports.conversation.drain().catch(() => {});
            return redirect(`/actions/${ref.id}?r=${revision}#s15-slip-title`);
          }
          if (!ports.actions || fields.decision !== undefined) throw new AppError("not_found", 404);
          if (url.pathname === "/s15/forms/action/check") { if (fields.outcome !== undefined) throw new AppError("invalid_body"); await ports.actions.reconcile(actor, ref, fields.requestId!); return redirect(`/actions/${ref.id}?r=${revision}&checked=1#s15-slip-title`); }
          if (url.pathname === "/s15/forms/action/statement") {
            if (fields.outcome !== "occurred" && fields.outcome !== "did_not_occur") throw new AppError("invalid_body");
            ports.actions.statement(actor, ref, fields.requestId!, fields.outcome); return redirect(`/actions/${ref.id}?r=${revision}#s15-slip-title`);
          }
        } catch (error) { const code = codeOf(error); if (code === "authentication_required" || code === "not_found" || code === "invalid_body") throw error; return back(code); }
        throw new AppError("not_found", 404);
      }
      if (url.pathname === "/s15/forms/duty/stop") {
        only(fields, ["csrf", "requestId", "duty"]);
        if (!ports.duties || !idPattern.test(fields.duty!)) throw new AppError("not_found", 404);
        ports.duties.stop(actor, fields.duty!, fields.requestId!);
        return redirect(`/duties/${fields.duty}`);
      }
      if (url.pathname.startsWith("/s15/forms/browser/")) {
        only(fields, ["csrf", "requestId", "site"], ["generation", "field", "value"]);
        const browser = ports.browsers?.find(item => item.id === fields.site); if (!browser) throw new AppError("not_found", 404);
        const state = browserState.get(browser.id), generation = fields.generation === undefined ? null : Number(fields.generation);
        const set = (login: S15BrowserProgress["login"], g: number | null, handBack?: number) => browserState.set(browser.id, { login, generation: g, at: now(), ...(handBack === undefined ? {} : { handBack }) });
        const current = () => { if (!state || state.login !== "owner_control" || generation === null || state.generation !== generation) throw new AppError("stale_input", 409); return generation; };
        try {
          if (url.pathname === "/s15/forms/browser/takeover") { const taken = await browser.owner.takeover(actor); set("owner_control", taken.generation); return redirect(`/browser/${browser.id}#s15-takeover-bar`); }
          if (url.pathname === "/s15/forms/browser/input") {
            const g = current(), field = browser.fields.find(item => item.name === fields.field); if (!field) throw new AppError("invalid_body");
            if (field.kind === "type" ? typeof fields.value !== "string" || !fields.value : fields.value !== undefined) throw new AppError("invalid_body");
            // The owner's value goes straight to the protected browser; it is never rendered, logged or kept.
            await browser.owner.input(actor, g, field.kind === "type" ? { kind: "type", field: field.name, value: fields.value! } : { kind: "click", field: field.name });
            return redirect(`/browser/${browser.id}#s15-takeover-bar`);
          }
          if (url.pathname === "/s15/forms/browser/handback" || url.pathname === "/s15/forms/browser/cancel") {
            const cancel = url.pathname.endsWith("/cancel"), handed = browser.owner.handBack(actor, current(), cancel);
            set(handed.login, null, handed.generation);
            if (handed.login === "checking") {
              // One bounded protected session observation; the hand-back press itself says nothing about the session.
              const observed = await Promise.race([browser.owner.checkSession(actor), new Promise<"unknown">(resolve => setTimeout(() => resolve("unknown"), 15000))]).catch(() => "unknown" as const);
              // A newer takeover or hand-back (for example from another tab) owns the state now; this late result is dropped.
              if (browserState.get(browser.id)?.handBack === handed.generation) set(observed === "checking" ? "unknown" : observed, null, handed.generation);
            }
            return redirect("/needs#s15-needs-login");
          }
        } catch (error) {
          const code = codeOf(error); if (code === "authentication_required") throw error;
          if (url.pathname === "/s15/forms/browser/input" && state?.login === "owner_control") return redirect(`/browser/${browser.id}?refused=${encodeURIComponent(code)}#s15-takeover-bar`);
          return render(() => shell(nav("/needs"), tr("s15.needs.title"), `<div class="s-col">${refusal(code)}</div>${needsBody({ items: needs(), decisions: decisions(), duties: dutyList() ?? [], browsers: browsers(), csrf })}`), 409);
        }
        throw new AppError("not_found", 404);
      }
      if (url.pathname.startsWith("/s15/forms/recurring/")) {
        const recurring = ports.recurring; if (!recurring) throw new AppError("not_found", 404);
        if (url.pathname === "/s15/forms/recurring/propose") {
          only(fields, ["csrf", "requestId", "actionId", "revision", "actionHash", "ceiling"], ["frequencyId"]);
          const found = findSlip(fields.actionId!, Number(fields.revision)), t = found?.slip.action.transaction;
          if (!found || !t || found.slip.action.actionHash !== fields.actionHash) throw new AppError("not_found", 404);
          const retry = (code: string) => recurringPage(fields.actionId!, fields.revision!, { ceiling: fields.ceiling!, frequencyId: fields.frequencyId ?? "", refused: code }, 409);
          let ceiling: string; try { ceiling = parsePaymentAmount(fields.ceiling!.trim(), t.minorUnit); } catch { return retry("invalid_amount"); }
          try { const proposal = recurring.propose(actor, { action: { id: found.slip.action.id, revision: found.slip.action.revision, actionHash: found.slip.action.actionHash }, amountCeilingMinor: ceiling, frequencyId: fields.frequencyId ?? "" }); return recurringPage(fields.actionId!, fields.revision!, { proposal }); }
          catch (error) { if (codeOf(error) === "authentication_required") throw error; return retry(codeOf(error)); }
        }
        if (url.pathname === "/s15/forms/recurring/install") {
          only(fields, ["csrf", "requestId", "proposalHash"]);
          try { recurring.install(actor, fields.requestId!, fields.proposalHash!); } catch (error) { if (codeOf(error) === "authentication_required") throw error; return rulesPage({ refused: codeOf(error) }, 409); }
          return redirect("/rules?saved=recurring_installed#s15-rules-recurring");
        }
        if (url.pathname === "/s15/forms/recurring/revoke") {
          only(fields, ["csrf", "requestId", "ruleId"]); if (!idPattern.test(fields.ruleId!)) throw new AppError("invalid_body");
          try { recurring.revoke(actor, fields.requestId!, fields.ruleId!); } catch (error) { if (codeOf(error) === "authentication_required") throw error; return rulesPage({ refused: codeOf(error) }, 409); }
          return redirect("/rules?saved=recurring_revoked#s15-rules-recurring");
        }
        throw new AppError("not_found", 404);
      }
      if (url.pathname.startsWith("/s15/forms/github/")) {
        const github = ports.github; if (!github) throw new AppError("not_found", 404);
        try {
          if (url.pathname === "/s15/forms/github/capture") { only(fields, ["csrf", "requestId"]); githubCapture = await github.capture(actor); return redirect("/rules#s15-rules-github"); }
          if (url.pathname === "/s15/forms/github/install") {
            const capture = githubCapture; if (!capture || fields.captureId !== capture.captureId) throw new AppError("github_capture_required", 409);
            const repoFields = Object.keys(fields).filter(name => name.startsWith("repo_"));
            only(fields, ["csrf", "requestId", "captureId"], ["publication", "merge", ...capture.repositories.map(entry => `repo_${entry.repository.resource.id}`)]);
            const repositoryIds = repoFields.map(name => name.slice(5));
            if (!repositoryIds.length || (!fields.publication && !fields.merge)) throw new AppError("github_selection_required", 409);
            await github.install(actor, { requestId: fields.requestId!, captureId: capture.captureId, repositoryIds, publication: fields.publication === "1", merge: fields.merge === "1" });
            githubCapture = null; return redirect("/rules?saved=github_installed#s15-rules-github");
          }
          if (url.pathname === "/s15/forms/github/revoke") {
            only(fields, ["csrf", "requestId", "captureId"]);
            const capture = githubCapture; if (!capture || fields.captureId !== capture.captureId) throw new AppError("github_capture_required", 409);
            github.revoke(actor, { requestId: fields.requestId!, expectedPolicyRevision: capture.revoke.expectedPolicyRevision, ruleIds: capture.revoke.ruleIds });
            githubCapture = null; return redirect("/rules?saved=github_revoked#s15-rules-github");
          }
        } catch (error) { if (codeOf(error) === "authentication_required") throw error; return rulesPage({ refused: codeOf(error) }, 409); }
        throw new AppError("not_found", 404);
      }
      if (url.pathname === "/s15/forms/computer/restore") {
        only(fields, ["csrf", "requestId", "snapshotId", "generation"], ["vmId"]);
        const computer = ports.computer; if (!computer?.restore || !idPattern.test(fields.snapshotId!)) throw new AppError("not_found", 404);
        // A pool member is named only by a protected id from the rendered list; the default computer needs none.
        const member = fields.vmId === undefined ? null : computer.pool?.members(actor).find(item => item.id === fields.vmId) ?? null;
        if (fields.vmId !== undefined && !member) throw new AppError("not_found", 404);
        const target = member?.id ?? computer.vmId, vm = member && member.id !== computer.vmId ? member.id : null;
        try {
          if ((member ? member.status : computerStatus())?.generation !== Number(fields.generation)) throw new AppError("stale_revision", 409);
          await computer.restore(actor, { vmId: target, snapshotId: fields.snapshotId! });
        } catch (error) { if (codeOf(error) === "authentication_required") throw error; return computerPage(null, 409, { restore: fields.snapshotId!, restored: false, refused: codeOf(error), vm: target }); }
        return redirect(vm ? `/resources/computer?restored=1&vm=${vm}#s15-restore-title-${vm}` : "/resources/computer?restored=1#s15-restore-title");
      }
      if (url.pathname === "/s15/forms/computer/manager") {
        // Write-only adapter registration for an added computer. The token is passed through once and never kept,
        // logged or rendered here; a refusal re-renders the empty form with only the stable code.
        const pool = ports.computer?.pool; if (!pool?.registerManager) throw new AppError("not_found", 404);
        const refuse = (code: string) => computerPage(null, 409, undefined, { managerRefused: code });
        let input: import("./types").S15ManagerInput;
        if (fields.kind === "lima") { only(fields, ["csrf", "requestId", "kind", "instance"]); input = { kind: "lima", instance: fields.instance!.trim() }; }
        else if (fields.kind === "proxmox") {
          only(fields, ["csrf", "requestId", "kind", "baseUrl", "node", "vmid", "token", "proxyAddress", "proxyPort"]);
          const vmid = Number(fields.vmid), port = Number(fields.proxyPort);
          if (!/^[0-9]{1,9}$/.test(fields.vmid!) || !/^[0-9]{1,5}$/.test(fields.proxyPort!)) return refuse("vm_invalid_setup");
          input = { kind: "proxmox", baseUrl: fields.baseUrl!.trim(), node: fields.node!.trim(), vmid, token: fields.token!, proxy: { address: fields.proxyAddress!.trim(), port } };
        } else throw new AppError("invalid_body");
        try { pool.registerManager(actor, input); }
        catch (error) { if (codeOf(error) === "authentication_required") throw error; return refuse(codeOf(error)); }
        return redirect("/resources/computer?saved=manager#s15-computer-add");
      }
      if (url.pathname === "/s15/forms/computer/drain") {
        only(fields, ["csrf", "requestId", "vmId", "drained"]);
        const pool = ports.computer?.pool; if (!pool || !idPattern.test(fields.vmId!) || !["0", "1"].includes(fields.drained!)) throw new AppError("not_found", 404);
        try { pool.drain(actor, fields.vmId!, fields.drained === "1"); }
        catch (error) { if (codeOf(error) === "authentication_required") throw error; return computerPage(null, 409, undefined, { vmId: fields.vmId!, refused: codeOf(error) }); }
        return redirect(`/resources/computer?saved=${fields.drained === "1" ? "drained" : "undrained"}&vm=${fields.vmId}#s15-computer-${fields.vmId}-card`);
      }
      if (url.pathname.startsWith("/s15/forms/computer/")) {
        const computer = ports.computer; if (!computer) throw new AppError("not_found", 404);
        const back = (refused: string | null = null, status = 200) => fields.return === "computer" ? computerPage(refused, status) : setupPage({ computer: refused }, status);
        const done = () => redirect(fields.return === "computer" ? "/resources/computer" : "/setup#s15-setup-computer");
        // POOL15-01: an added computer must be bound to an unused management adapter before enrollment starts.
        const adding = !!computer.pool && computer.pool.nextId(actor) !== computer.vmId;
        try {
          if (adding && !computer.managerId && ["/s15/forms/computer/begin", "/s15/forms/computer/check", "/s15/forms/computer/use"].includes(url.pathname)) throw new AppError("vm_management_required", 409);
          if (url.pathname === "/s15/forms/computer/provision") {
            // Owner "Create now", "Continue now" or "Try again" for the one default-computer job; it never asks for a value.
            only(fields, ["csrf", "requestId", "return"]); if (!computer.local) throw new AppError("not_found", 404);
            computer.local.start(actor); return done();
          }
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
            await computer.useMachine(actor, { id: computer.pool?.nextId(actor) ?? computer.vmId, checkId: fields.checkId!, fingerprint: fields.fingerprint!, transportProfile: progress.check.transportProfile });
            progress.setup = null; progress.check = null; return done();
          }
          if (url.pathname === "/s15/forms/computer/forget-check") { only(fields, ["csrf", "requestId", "return"]); progress.check = null; return done(); }
        } catch (error) { if (codeOf(error) === "authentication_required") throw error; if (codeOf(error) === "vm_setup_expired") { progress.setup = null; progress.check = null; } return back(codeOf(error), 409); }
        throw new AppError("not_found", 404);
      }
      if (url.pathname.startsWith("/s15/forms/telegram/")) {
        // CHAN15-01 owner commands. The token is write-only: never echoed, kept or logged here.
        const telegram = ports.telegram; if (!telegram) throw new AppError("not_found", 404);
        const commands: Record<string, [string, () => void | Promise<void>, string]> = {
          "/s15/forms/telegram/token": ["token", () => telegram.setToken(actor, fields.requestId!, fields.token ?? ""), "token#s15-tg-bot"],
          "/s15/forms/telegram/remove": ["", () => telegram.removeToken(actor, fields.requestId!), "removed#s15-tg-bot"],
          "/s15/forms/telegram/bind": ["", () => telegram.startBinding(actor, fields.requestId!), "#s15-tg-binding"],
          "/s15/forms/telegram/cancel": ["", () => telegram.cancelBinding(actor, fields.requestId!), "cancelled#s15-tg-binding"],
          "/s15/forms/telegram/revoke": ["", () => telegram.revoke(actor, fields.requestId!), "revoked#s15-tg-binding"],
          "/s15/forms/telegram/gap": ["", () => telegram.acknowledgeGap(actor, fields.requestId!), "gap#s15-tg-flow"],
        };
        const command = commands[url.pathname]; if (!command) throw new AppError("not_found", 404);
        only(fields, command[0] ? ["csrf", "requestId", command[0]] : ["csrf", "requestId"]);
        try { await command[1](); } catch (error) { if (codeOf(error) === "authentication_required") throw error; return telegramPage(codeOf(error), 409); }
        return redirect(`/resources/telegram${command[2].startsWith("#") ? command[2] : `?saved=${command[2]}`}`);
      }
      if (url.pathname.startsWith("/s15/forms/websites/")) {
        // BROW15-02 owner commands over the protected approved-website list and the pinned Chromium.
        const websites = ports.websites; if (!websites) throw new AppError("not_found", 404);
        if (url.pathname === "/s15/forms/websites/add") {
          only(fields, ["csrf", "requestId", "website"]);
          let added: { origin: string };
          try { added = websites.add(actor, fields.requestId!, fields.website!); }
          catch (error) { if (codeOf(error) === "authentication_required") throw error; return websitesPage({ refused: { code: codeOf(error), at: "add" }, entry: fields.website!.slice(0, 2048) }, 409); }
          return redirect(`/resources/websites?added=${encodeURIComponent(added.origin)}#s15-web-list`);
        }
        if (url.pathname === "/s15/forms/websites/remove") {
          only(fields, ["csrf", "requestId", "origin", "revision"]);
          const revision = Number(fields.revision);
          if (!/^[1-9]\d{0,8}$/.test(fields.revision!)) throw new AppError("invalid_body");
          try { websites.remove(actor, fields.requestId!, fields.origin!, revision); }
          catch (error) { if (codeOf(error) === "authentication_required") throw error; return websitesPage({ refused: { code: codeOf(error), at: "list" } }, 409); }
          return redirect(`/resources/websites?removed=${encodeURIComponent(fields.origin!)}#s15-web-list`);
        }
        if (url.pathname === "/s15/forms/websites/retry") {
          only(fields, ["csrf", "requestId"]);
          try { websites.retry(actor); }
          catch (error) { if (codeOf(error) === "authentication_required") throw error; return websitesPage({ refused: { code: codeOf(error), at: "list" } }, 409); }
          return redirect("/resources/websites?retried=1#s15-web-engine");
        }
        throw new AppError("not_found", 404);
      }
      if (url.pathname.startsWith("/s15/forms/github-connection/")) {
        // GIT15-04 owner commands. The token is write-only: never echoed, kept or logged here; a refusal re-renders
        // the page with only the stable code and an empty token field.
        const connection = ports.githubConnection; if (!connection) throw new AppError("not_found", 404);
        try {
          if (url.pathname === "/s15/forms/github-connection/connect") { only(fields, ["csrf", "requestId", "token"]); await connection.connect(actor, fields.requestId!, fields.token!); return redirect("/resources/github?saved=connected#s15-ghc-repos"); }
          const revision = Number(fields.revision);
          if (!/^[1-9]\d{0,8}$/.test(fields.revision ?? "")) throw new AppError("invalid_body");
          if (url.pathname === "/s15/forms/github-connection/select") {
            const names = Object.keys(fields).filter(name => /^repo_\d{1,3}$/.test(name));
            only(fields, ["csrf", "requestId", "revision"], names);
            connection.select(actor, fields.requestId!, revision, names.map(name => fields[name]!)); return redirect("/resources/github?saved=selected#s15-ghc-repos");
          }
          if (url.pathname === "/s15/forms/github-connection/remove") { only(fields, ["csrf", "requestId", "revision"]); connection.remove(actor, fields.requestId!, revision); return redirect("/resources/github?saved=removed#s15-ghc"); }
        } catch (error) { const code = codeOf(error); if (code === "authentication_required" || code === "invalid_body") throw error; return githubPage(code, 409); }
        throw new AppError("not_found", 404);
      }
      if (url.pathname === "/s15/forms/team/register") {
        // The owner's one confirmation of the exact list shown; TEAM refuses if that list changed meanwhile.
        only(fields, ["csrf", "requestId", "listHash", "return"]);
        const team = ports.team; if (!team?.register || !["setup", "resources"].includes(fields.return!)) throw new AppError("not_found", 404);
        if (!/^[a-f0-9]{64}$/.test(fields.listHash!)) throw new AppError("invalid_body");
        try { team.register(actor, fields.requestId!, fields.listHash!); }
        catch (error) { if (codeOf(error) === "authentication_required") throw error; return fields.return === "setup" ? setupPage({ team: codeOf(error) }, 409) : accountsPage({ refused: codeOf(error) }, 409); }
        return redirect(fields.return === "setup" ? "/setup?team=registered#s15-setup-rules" : "/resources/accounts?team=registered#s15-res-team");
      }
      if (url.pathname.startsWith("/s15/forms/rules/")) {
        const rules = ports.rules; if (!rules) throw new AppError("not_found", 404);
        const toRules = fields.return === "rules";
        if (fields.return !== undefined && fields.return !== "rules" && fields.return !== "setup") throw new AppError("invalid_body");
        if (url.pathname === "/s15/forms/rules/review") {
          only(fields, ["csrf", "requestId", "amount"], ["currency", "periodId", "return"]);
          const choices = rules.budgetOptions(actor), entry = { amount: fields.amount!.trim(), currency: fields.currency ?? "", periodId: fields.periodId ?? "" };
          const minor = choices.currencies.includes(entry.currency) ? toMinor(entry.amount, entry.currency) : null;
          if (!minor || !choices.periods.some(period => period.id === entry.periodId)) { reviewed = null; return toRules ? rulesPage({ review: "finite_budget_required" }, 409) : setupPage({ rules: "finite_budget_required" }, 409); }
          reviewed = { entry, budget: { currency: entry.currency, spendMinor: minor, periodId: entry.periodId } };
          return redirect(toRules ? "/rules#s15-policy-review" : "/setup#s15-setup-rules");
        }
        if (url.pathname === "/s15/forms/rules/install") {
          only(fields, ["csrf", "requestId", "proposalHash"], ["listHash", "return"]);
          if (fields.listHash !== undefined && !/^[a-f0-9]{64}$/.test(fields.listHash)) throw new AppError("invalid_body");
          if (!/^[a-f0-9]{64}$/.test(fields.proposalHash!)) throw new AppError("invalid_body");
          try { rules.install(actor, fields.requestId!, fields.proposalHash!); }
          catch (error) { if (codeOf(error) === "authentication_required") throw error; return toRules ? rulesPage({ review: codeOf(error) }, 409) : setupPage({ rules: codeOf(error) }, 409); }
          reviewed = null;
          // The same press registers the exact TEAM list shown with the proposal; TEAM refuses if that list changed.
          if (fields.listHash && ports.team?.register) {
            try { ports.team.register(actor, `${fields.requestId!.slice(0, 120)}_team`, fields.listHash); }
            catch (error) { if (codeOf(error) === "authentication_required") throw error; return toRules ? rulesPage({ saved: "policy_installed", refused: codeOf(error) }, 409) : setupPage({ installed: true, team: codeOf(error) }, 409); }
          }
          return toRules ? redirect("/rules?saved=policy_installed#s15-rules-summary") : setupPage({ installed: true, teamRegistered: !!fields.listHash });
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
