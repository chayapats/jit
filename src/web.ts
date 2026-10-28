import { Application, type CreateProjectCommand } from "./application";
import { AppError } from "./errors";
import type { CreateTopicCommand, SendMessageCommand, StartChatCommand } from "./conversation";
import type { PromotionCommand } from "./promotion";
import { workspacePage, projectPage, conversationPage, sourcePage, jobsPage, teamPage, previewPage, discussionPage, deliveryPage, deliveryDetailPage, prReportsPage, prReportPage, prWebhookSecretPage, tasksPage, taskPage, memoryPage, memoryClaimPage, memoryContextPage, schedulesPage, scheduleDetailPage, backupsPage, backupDetailPage, deletionsPage, deletionDetailPage, exportsPage, exportDetailPage, upgradesPage, upgradeDetailPage, restoresPage, restoreDetailPage, loginPage, errorPage } from "./web-layout";
import type { ExtractMemoryCommand } from "./memory/types";
import type { CorrectMemoryCommand } from "./memory/types";
import type { ForgetMemoryCommand } from "./memory/types";
import type { CommitDeliveryCommand, ResendDeliveryCommand, SetAttentionCommand } from "./delivery";
import type { EnqueueJobCommand, JobLimits, ResumeJobCommand, StopJobCommand } from "./jobs/types";
import type { ScheduleCommand, ScheduleRecurrence } from "./jobs/schedules";
import type { DecisionCommand, TeamCommand, RoleRoute } from "./team/types";
import type { TaskCommand } from "./tasks";
import { negotiateLocale, tr, trMaybe, withLocale, type Locale, type MessageKey } from "./i18n";
import { lookupAsset } from "./web-assets";
import { serviceWorkerPath, serviceWorkerScript } from "./web-pwa";
import { renderWith, replyLabels, replyTone, settingsPage, type NavigationWorkspace, type ThemePreference } from "./web-layout";
import type { SetPreferencesCommand } from "./preferences";
import type { SetLocalApiCommand } from "./local-api/settings";
import type { SetPersonaCommand } from "./persona";
import type { SetupCommand } from "./setup";
import { setupPage, visibleStep } from "./web-setup";
import type { JitReplyView, StopReplyCommand } from "./team/jit-reply";
import type { RoleProposalCommand } from "./team/role-proposals";
import { defaultPanelTab, legacyRedirect, panelRows, panelTabs, searchLimits, settingsPageHandler, type PanelTab } from "./web-settings";
import { searchItems, searchPage, settingsAccessPage, accessConfirmPage, settingsApprovalsPage, settingsConnectionsPage, settingsDataPage, settingsDispatchPage, settingsFeedPage, settingsTelegramPage, topicPanelPage, type PanelData } from "./web-navigation";
import { dispatchLimits, type DispatchCommand } from "./team/jit-dispatch";
import { effectKinds } from "./exec/approval-cards";
import type { DecideCardCommand, SetAutoApproveCommand } from "./exec/approval-cards";
import { createWebhookHandler, type WebhookHandlerOptions } from "./pr/webhook-route";
import { webhookPathPrefix, type WebhookCommandKind } from "./pr/webhooks";
import type { SetDispatchAllowanceCommand } from "./team/allowance";
import { feedPathToken, renderScheduleFeed, type FeedCommand } from "./schedule-feed";
import { accessConfirmToken, accessLevels, effectiveAccess, levelRank, type AccessCommand, type AccessLevel } from "./exec/access";
import { normalizeSecret, type ConnectionCommand } from "./exec/connections";
import type { ResetBoxCommand } from "./exec/box-commands";

/** ADR 0028 Content-Security-Policy: every page, asset and API response allows only this origin, and no inline script or eval. */
export const contentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

/**
 * Topic event stream pacing (ADR 0028). The stream polls persisted reply state; it never starts work.
 * It closes after `polls` ticks so the browser reconnects with `Last-Event-ID` and the session is rechecked.
 */
export interface ReplyStreamOptions {
  intervalMs: number; polls: number;
  timers?: { set(callback: () => void, ms: number): unknown; clear(handle: unknown): void };
}
const defaultStream: ReplyStreamOptions = { intervalMs: 1000, polls: 120 };
/** web.pwa/v1 worker body, filled in once with this version's asset allowlist. */
const serviceWorker = new TextEncoder().encode(serviceWorkerScript());

/** Creates a server-rendered owner workspace; all mutations use the shared application boundary. */
export function createWebHandler(app: Application, options: { stream?: ReplyStreamOptions; webhook?: WebhookHandlerOptions } = {}): (request: Request) => Promise<Response> {
  // app.webhook_triggers/v1: signed senders on the VPN reach this one path without a session, Origin or CSRF.
  const webhooks = createWebhookHandler(app, options.webhook);
  const streamOptions = options.stream ?? defaultStream;
  const streamTimers = streamOptions.timers ?? { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  const { config } = app;
  const expectedHost = new URL(config.origin).host;
  const secure = config.origin.startsWith("https:");
  const cookieName = secure ? "__Host-jit_session" : "jit_session";
  const cookie = (value: string, maxAge: number) => `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const headers = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": contentSecurityPolicy,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    ...(secure ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  };
  const respond = (body: BodyInit | null, status = 200, extra: Record<string, string> = {}) =>
    new Response(body, { status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8", ...extra } });
  const json = (body: unknown, status = 200) => respond(JSON.stringify(body), status, { "Content-Type": "application/json" });

  async function payload(request: Request): Promise<Record<string, unknown>> {
    const reader = request.body?.getReader();
    if (!reader) throw new AppError("invalid_body");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > config.bodyBytes) { await reader.cancel(); throw new AppError("request_too_large", 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw new AppError("invalid_body"); }
    const contentType = request.headers.get("content-type")?.split(";")[0]?.trim();
    if (contentType === "application/json") {
      try {
        const result: unknown = JSON.parse(text);
        if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
        return result as Record<string, unknown>;
      } catch { throw new AppError("invalid_body"); }
    }
    if (contentType === "application/x-www-form-urlencoded") {
      const entries = new URLSearchParams(text);
      if (new Set(entries.keys()).size !== [...entries.keys()].length) throw new AppError("invalid_body");
      return Object.fromEntries(entries);
    }
    throw new AppError("unsupported_content_type", 415);
  }

  return async request => {
    const url = new URL(request.url);
    const api = url.pathname.startsWith("/api/");
    // Before sign-in (and if preferences cannot be read) Accept-Language and prefers-color-scheme decide.
    const negotiated = negotiateLocale(request.headers.get("accept-language"));
    let ui: { locale: Locale; theme: ThemePreference } = { locale: negotiated, theme: "system" };
    const uiFor = (actor: ReturnType<Application["authenticate"]>["actor"]) => {
      try {
        const saved = app.preferences(actor);
        return { locale: saved.language === "auto" ? negotiated : saved.language, theme: saved.theme };
      } catch { return ui; }
    };
    /**
     * app.schedule_feed/v1 (ADR 0035): `GET /feeds/schedules/<token>.ics`. The path token is the only credential:
     * no session is read and no cookie is set. A malformed, wrong or turned-off token is a bodiless 404, so the
     * answer reveals nothing; storage trouble or an incomplete restore is a bodiless 503. Nothing here logs the
     * request path, and the response keeps the shared security headers (CSP, nosniff, no-store).
     */
    const scheduleFeed = (incoming: Request, pathname: string): Response => {
      const bare = (status: number, extra: Record<string, string> = {}) => new Response(null, { status, headers: { ...headers, ...extra } });
      const token = incoming.method === "GET" ? feedPathToken(pathname) : null;
      if (token === null) return bare(404);
      try {
        const feed = app.scheduleFeed(token);
        if (!feed) return bare(404);
        const locale = feed.language === "auto" ? negotiated : feed.language;
        const body = withLocale(locale, () => renderScheduleFeed(feed.events, { includePurpose: feed.includePurpose,
          labels: { calendarName: tr("settings.feed_calendar_name"), kind: { reminder: tr("common.reminder"), summary: tr("common.summary") } } }));
        return new Response(body, { status: 200, headers: { ...headers, "Content-Type": "text/calendar; charset=utf-8", "Content-Language": locale } });
      } catch { return bare(503, { "Retry-After": "60" }); }
    };
    /** Renders an HTML page in the request's language and theme. */
    const page = (render: () => string, status = 200) =>
      respond(renderWith(ui, render), status, { "Content-Language": ui.locale, "Vary": "Accept-Language, Cookie" });
    try {
      if (url.host !== expectedHost || (request.headers.has("host") && request.headers.get("host") !== expectedHost)) {
        throw new AppError("origin_rejected", 403);
      }
      if (Buffer.byteLength(url.pathname + url.search) > config.queryBytes) throw new AppError("request_too_large", 414);
      // app.schedule_feed/v1: the feed is answered before any method, session, cookie or Origin handling; every
      // method but GET gets the same bodiless 404 as a wrong token.
      if (url.pathname.startsWith("/feeds/")) return scheduleFeed(request, url.pathname);
      if (request.method !== "GET" && request.method !== "POST") throw new AppError("method_not_allowed", 405);
      // app.webhook_triggers/v1: after the Host check, before the browser Origin rule (a sender is not a browser).
      if (url.pathname.startsWith(webhookPathPrefix)) return await webhooks(request, url.pathname.slice(webhookPathPrefix.length));
      if (request.method === "POST" && (request.headers.get("origin") !== config.origin ||
          request.headers.get("sec-fetch-site") === "cross-site")) throw new AppError("origin_rejected", 403);
      if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
        // web.static_assets/v1: exact content-hashed paths only; the body behind a path never changes.
        const asset = lookupAsset(url.pathname);
        if (!asset) throw new AppError("not_found", 404);
        return new Response(asset.body, { status: 200, headers: { ...headers, "Content-Type": asset.contentType, "Cache-Control": "public, max-age=31536000, immutable" } });
      }
      if (request.method === "GET" && url.pathname === serviceWorkerPath) {
        // web.pwa/v1: public, never stored by HTTP caches, so the browser sees a new asset version on its next check.
        return new Response(serviceWorker, { status: 200, headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" } });
      }
      // web.settings_ia/v1: moved installation pages answer GET with a permanent redirect to their settings page.
      const moved = request.method === "GET" ? legacyRedirect(url.pathname) : null;
      if (moved) return respond(null, 308, { Location: `${moved}${url.search}` });
      if (request.method === "GET" && url.pathname === "/login") {
        return page(() => loginPage());
      }
      if (request.method === "POST" && url.pathname === "/login") {
        const body = await payload(request);
        if (typeof body.password !== "string") throw new AppError("invalid_body");
        const token = await app.login(body.password);
        return respond(null, 303, { "Location": "/", "Set-Cookie": cookie(token, config.sessionSeconds) });
      }
      const matches = (request.headers.get("cookie") ?? "").split(";").map(part => part.trim()).filter(part => part.startsWith(`${cookieName}=`));
      const token = matches.length === 1 ? matches[0]!.slice(cookieName.length + 1) : "";
      const auth = app.authenticate(token);
      ui = uiFor(auth.actor);
      // New settings page paths render through the installation page handlers; commands keep their own paths.
      const pathname = (request.method === "GET" ? settingsPageHandler(url.pathname) : null) ?? url.pathname;
      const selectedProject = /^\/projects\/([a-f0-9-]{36})(?:\/|$)/.exec(pathname)?.[1];
      /** Sidebar state: the workspace page plus waiting-on-owner counts for the projects the sidebar can show. */
      const nav = (workspace = app.workspace(auth.actor)): NavigationWorkspace => {
        const ids = [...new Set([...(selectedProject ? [selectedProject] : []), ...workspace.projects.slice(0, 8).map(p => p.id)])];
        // web.access_settings/v1: every page carries the execution badges of the sidebar projects.
        const access = new Map(ids.map(id => [id, app.projectAccess(auth.actor, id)] as const));
        return { ...workspace, attention: app.attention(auth.actor, ids), access };
      };
      const projectRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})$/.exec(pathname);
      const topicCollection = /^\/(api\/)?projects\/([a-f0-9-]{36})\/topics$/.exec(pathname);
      const topicRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/topics\/([a-f0-9-]{36})$/.exec(pathname);
      const topicPanelRoute = /^\/projects\/([a-f0-9-]{36})\/topics\/([a-f0-9-]{36})\/panel$/.exec(pathname);
      const messageRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/topics\/([a-f0-9-]{36})\/messages$/.exec(pathname);
      const sourceRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/sources\/([a-f0-9-]{36})$/.exec(pathname);
      const deliveryRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/delivery$/.exec(pathname);
      const deliveryIntentRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/delivery\/([a-f0-9-]{36})$/.exec(pathname);
      const deliveryResendRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/delivery\/([a-f0-9-]{36})\/resend$/.exec(pathname);
      const prReportsRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/pr\/reports$/.exec(pathname);
      const prReportRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/pr\/reports\/([a-f0-9-]{36})$/.exec(pathname);
      const prAlertPolicyRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/pr\/alert-policy$/.exec(pathname);
      const prWebhooksRoute = /^\/api\/projects\/([a-f0-9-]{36})\/pr\/webhooks$/.exec(pathname);
      const prWebhookRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/pr\/monitors\/([a-f0-9-]{36})\/webhook\/(create|rotate|delete)$/.exec(pathname);
      const jobsRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/jobs$/.exec(pathname);
      const jobRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/jobs\/([a-f0-9-]{36})$/.exec(pathname);
      const resumeRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/jobs\/([a-f0-9-]{36})\/(resume|stop)$/.exec(pathname);
      const schedulesRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/schedules$/.exec(pathname);
      const scheduleRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/schedules\/([a-f0-9-]{36})$/.exec(pathname);
      const scheduleAction = /^\/(api\/)?projects\/([a-f0-9-]{36})\/schedules\/([a-f0-9-]{36})\/(pause|resume|revoke|edit)$/.exec(pathname);
      const teamRoute = /^\/(?:api\/)?(?:projects\/([a-f0-9-]{36})\/)?team$/.exec(pathname);
      const teamAction = /^\/(?:api\/)?(?:projects\/([a-f0-9-]{36})\/)?team\/(roles|routes|previews|discussions)$/.exec(pathname);
      const previewRoute = /^\/(?:api\/)?projects\/([a-f0-9-]{36})\/team\/previews\/([a-f0-9-]{36})$/.exec(pathname);
      const discussionRoute = /^\/(?:api\/)?projects\/([a-f0-9-]{36})\/team\/discussions\/([a-f0-9-]{36})$/.exec(pathname);
      const discussionControl = /^\/(?:api\/)?projects\/([a-f0-9-]{36})\/team\/discussions\/([a-f0-9-]{36})\/controls$/.exec(pathname);
      const synthesisRoute = /^\/(?:api\/)?projects\/([a-f0-9-]{36})\/team\/discussions\/([a-f0-9-]{36})\/synthesis$/.exec(pathname);
      const decisionRoute = /^\/(?:api\/)?projects\/([a-f0-9-]{36})\/topics\/([a-f0-9-]{36})\/decisions$/.exec(pathname);
      const tasksRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/tasks$/.exec(pathname);
      const taskRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/tasks\/([a-f0-9-]{36})$/.exec(pathname);
      const continuityRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/continuity$/.exec(pathname);
      const memoryRoute = /^\/(?:api\/)?projects\/([a-f0-9-]{36})\/memory$/.exec(pathname);
      const claimRoute = /^\/(?:api\/)?projects\/([a-f0-9-]{36})\/memory\/claims\/([a-f0-9-]{36})$/.exec(pathname);
      const contextRoute = /^\/(?:api\/)?projects\/([a-f0-9-]{36})\/memory\/contexts\/([a-f0-9-]{36})$/.exec(pathname);
      const deletionsRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/memory\/deletions$/.exec(pathname);
      const deletionRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/memory\/deletions\/([a-f0-9-]{36})$/.exec(pathname);
      const exportsRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/exports$/.exec(pathname);
      const exportRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/exports\/([a-f0-9-]{36})$/.exec(pathname);
      const exportArtifactRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/exports\/([a-f0-9-]{36})\/artifact$/.exec(pathname);
      const upgradesRoute = /^\/(api\/)?upgrades$/.exec(pathname);
      const upgradeRoute = /^\/(api\/)?upgrades\/([a-f0-9-]{36})$/.exec(pathname);
      const restoresRoute = /^\/(api\/)?restores$/.exec(pathname);
      const restoreRoute = /^\/(api\/)?restores\/([a-f0-9-]{36})$/.exec(pathname);
      const backupsRoute = /^\/(api\/)?backups$/.exec(pathname);
      const backupRoute = /^\/(api\/)?backups\/([a-f0-9-]{36})$/.exec(pathname);
      const after = () => {
        const raw = url.searchParams.get("after") ?? "0";
        if (!/^\d{1,16}$/.test(raw)) throw new AppError("invalid_cursor");
        return Number(raw);
      };
      const streamRoute = /^\/projects\/([a-f0-9-]{36})\/topics\/([a-f0-9-]{36})\/events$/.exec(pathname);
      const replyStopRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/topics\/([a-f0-9-]{36})\/replies\/([a-f0-9-]{36})\/stop$/.exec(pathname);
      const roleProposalRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/topics\/([a-f0-9-]{36})\/replies\/([a-f0-9-]{36})\/proposals\/([a-f0-9-]{36})\/(accept|reject|revise)$/.exec(pathname);
      // app.topic_promotion/v1: accept, edit or dismiss one promotion proposal revision.
      const promotionRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/topics\/([a-f0-9-]{36})\/replies\/([a-f0-9-]{36})\/promotions\/([a-f0-9-]{36})\/(accept|dismiss|revise)$/.exec(pathname);
      // app.dispatch_allowance/v1 routes.
      const dispatchActionRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/dispatch\/([a-f0-9-]{36})\/(accept|dismiss|answer)$/.exec(pathname);
      const stopAllRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/team\/discussions\/([a-f0-9-]{36})\/stop-all$/.exec(pathname);
      // web.approval_cards/v1 (EXE09): decide one card in its topic; settings approvals pages.
      const approvalDecideRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/topics\/([a-f0-9-]{36})\/approvals\/([a-f0-9-]{36})$/.exec(pathname);
      const approvalRulesRoute = /^\/settings\/approvals\/rules$/.exec(pathname);
      const approvalRuleDisableRoute = /^\/settings\/approvals\/rules\/(.+)$/.exec(pathname);
      const allowanceFormRoute = /^\/settings\/dispatch\/([a-f0-9-]{36})$/.exec(pathname);
      const allowanceApiRoute = /^\/api\/projects\/([a-f0-9-]{36})\/dispatch-allowance$/.exec(pathname);
      // app.access_level/v1 JSON API (EXE01); the Web pages are EXE04.
      const accessRoute = /^\/api\/projects\/([a-f0-9-]{36})\/(access|access\/roles|execution\/halt|execution\/resume)$/.exec(pathname);
      // exec.box_runtime/v1 JSON API (EXE03): box state and the Web-only owner reset.
      const boxRoute = /^\/api\/projects\/([a-f0-9-]{36})\/execution\/box(\/reset)?$/.exec(pathname);
      // app.connections/v1 JSON API (EXE08): metadata reads and the Web-only owner commands; the settings page is EXE11.
      const connectionRoute = /^\/api\/connections(?:\/([a-f0-9-]{36})\/(secret|rotate|remove|test))?$/.exec(pathname);
      /** The topic page that holds a dispatch card, at its anchor. */
      const cardLocation = (card: { projectId: string; topicId: string; anchorSequence: number; id: string }) =>
        `/projects/${card.projectId}/topics/${card.topicId}?after=${Math.max(0, card.anchorSequence - 1)}#dispatch-${card.id}`;
      /** One app.jit_reply/v1 event: persisted state plus localised labels, so the script holds no strings. */
      const replyEvent = (view: JitReplyView) => {
        const labels = renderWith(ui, () => replyLabels(view));
        const found = view.state === "answered" && view.source ? app.source(auth.actor, view.projectId, view.source) : null;
        return { id: view.id, messageId: view.messageId, state: view.state, reason: view.reason, revision: view.revision, progress: view.progress,
          replyMessageId: view.replyMessageId, text: found?.state === "available" ? found.text : null, tone: replyTone[view.state], label: labels.state, next: labels.next,
          proposals: view.roleProposals.length + view.promotionProposals.length };
      };
      if (request.method === "GET" && streamRoute) {
        // ADR 0028: one authenticated SSE stream per open topic, fed only from persisted reply state. Every
        // reply-affecting change (record, progress, job transition) moves the reply cursor; each event carries the
        // cursor of its own change, so a reconnect with Last-Event-ID resumes right after the last delivered one.
        const projectId = streamRoute[1]!, topicId = streamRoute[2]!;
        const raw = request.headers.get("last-event-id") ?? url.searchParams.get("cursor") ?? "0";
        if (!/^\d{1,16}$/.test(raw)) throw new AppError("invalid_cursor");
        let cursor = Number(raw);
        app.replyStream(auth.actor, projectId, topicId, cursor);
        const encoder = new TextEncoder(), seen = new Map<string, string>();
        let handle: unknown = null, closed = false, ticks = 0, quiet = 0;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const finish = () => { if (closed) return; closed = true; try { controller.close(); } catch { /* Already closed by the client. */ } };
            const tick = () => {
              if (closed) return;
              let chunk = ticks === 0 ? `retry: ${Math.max(1000, streamOptions.intervalMs * 2)}\n\n` : "";
              try {
                // A page holds at most pageSize changes; the next tick continues from the advanced cursor.
                for (const view of app.replyStream(auth.actor, projectId, topicId, cursor)) {
                  cursor = Math.max(cursor, view.cursor);
                  const data = JSON.stringify(replyEvent(view));
                  if (seen.get(view.id) === data) continue;
                  seen.set(view.id, data);
                  chunk += `id: ${cursor}\nevent: reply\ndata: ${data}\n\n`;
                }
              } catch { finish(); return; }
              quiet = chunk ? 0 : quiet + 1;
              // A comment keeps idle proxies and the server's idle timeout from closing a quiet stream.
              if (quiet >= 5) { chunk = ": keep-alive\n\n"; quiet = 0; }
              if (chunk) controller.enqueue(encoder.encode(chunk));
              ticks += 1;
              if (ticks >= streamOptions.polls) finish();
              else handle = streamTimers.set(tick, streamOptions.intervalMs);
            };
            tick();
          },
          cancel() { closed = true; if (handle !== null) streamTimers.clear(handle); },
        });
        return new Response(body, { status: 200, headers: { ...headers, "Content-Type": "text/event-stream; charset=utf-8", "X-Accel-Buffering": "no" } });
      }
      if (request.method === "POST" && replyStopRoute) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision"].includes(key))) throw new AppError("invalid_body");
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
        const command = { kind: "jit.reply.stop", requestId: body.requestId, projectId: replyStopRoute[2], expectedRevision: revision,
          payload: { replyId: replyStopRoute[4] } } as StopReplyCommand;
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: `/projects/${receipt.reply.projectId}/topics/${receipt.reply.topicId}?after=${Math.max(0, receipt.reply.messageSequence - 1)}#reply-${receipt.reply.id}` });
      }
      if (request.method === "POST" && roleProposalRoute) {
        // app.role_proposals/v1: create, edit or dismiss one proposal revision. The form path and the JSON path build
        // the same command; the service checks the revision, the state and the configured routes.
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const verb = roleProposalRoute[6] as "accept" | "reject" | "revise";
        const fields = verb === "revise" ? ["name", "responsibility", "route"] : [];
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", ...fields].includes(key))) throw new AppError("invalid_body");
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
        const target = { topicId: roleProposalRoute[3]!, replyId: roleProposalRoute[4]!, proposalId: roleProposalRoute[5]! };
        let route = body.route;
        if (!api && verb === "revise") {
          // The form's select holds "" for the default route or one configured route as JSON.
          if (typeof route !== "string") throw new AppError("invalid_body");
          try { route = route === "" ? null : JSON.parse(route); } catch { throw new AppError("invalid_role_proposal_command"); }
        }
        const command = { kind: `role.proposal.${verb}`, requestId: body.requestId, projectId: roleProposalRoute[2], expectedRevision: revision,
          // Browsers send CRLF line breaks in a textarea; proposals store LF.
          payload: verb === "revise" ? { ...target, name: body.name, responsibility: typeof body.responsibility === "string" ? body.responsibility.replace(/\r\n?/g, "\n") : body.responsibility, route } : target } as RoleProposalCommand;
        const receipt = app.execute(auth.actor, command);
        const p = receipt.proposal;
        return api ? json(receipt) : respond(null, 303, { Location: `/projects/${p.projectId}/topics/${p.topicId}?after=${Math.max(0, (p.replySequence ?? 1) - 1)}#proposal-${p.id}` });
      }
      if (request.method === "POST" && promotionRoute) {
        // app.topic_promotion/v1: the form path and the JSON path build the same command; the service checks that the
        // proposal belongs to a committed Jit reply in this General topic, its revision and its state.
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const verb = promotionRoute[6] as "accept" | "dismiss" | "revise";
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", ...(verb === "revise" ? ["name"] : [])].includes(key))) throw new AppError("invalid_body");
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
        const target = { topicId: promotionRoute[3]!, replyId: promotionRoute[4]!, proposalId: promotionRoute[5]! };
        const command = { kind: `topic.promote.${verb}`, requestId: body.requestId, projectId: promotionRoute[2], expectedRevision: revision,
          payload: verb === "revise" ? { ...target, name: body.name } : target } as PromotionCommand;
        const receipt = app.execute(auth.actor, command);
        if (api) return json(receipt);
        const p = receipt.proposal, promoted = receipt.promotion;
        return respond(null, 303, { Location: promoted ? `/projects/${promoted.target.projectId}/topics/${promoted.target.topicId}#message-${promoted.link.messageId}`
          : `/projects/${p.projectId}/topics/${p.topicId}?after=${Math.max(0, (p.replySequence ?? 1) - 1)}#proposal-${p.id}` });
      }
      if (request.method === "POST" && ["/chats", "/api/chats"].includes(url.pathname)) {
        // Chat-first home: the composer starts one topic in the chosen project (the General space by default) with the
        // owner's first message, and Jit answers it. A plain form post; the chip is an ordinary select.
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "projectId", "text"].includes(key))) throw new AppError("invalid_body");
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
        const command = { kind: "chat.start", requestId: body.requestId, projectId: body.projectId, expectedRevision: revision, payload: { text: body.text } } as StartChatCommand;
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: `/projects/${receipt.topic.projectId}/topics/${receipt.topic.id}#message-${receipt.message.id}` });
      }
      if (request.method === "POST" && dispatchActionRoute) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const [, , projectId, proposalId, action] = dispatchActionRoute;
        const form = request.headers.get("content-type")?.split(";")[0]?.trim() === "application/x-www-form-urlencoded";
        const roleKeys = Object.keys(body).filter(key => /^role-[a-f0-9-]{36}$/.test(key));
        const allowed = ["csrf", "requestId", "expectedRevision", ...(action === "accept" ? (form ? roleKeys : ["roleIds"]) : [])];
        if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError("invalid_body");
        if (form && roleKeys.some(key => body[key] !== "on")) throw new AppError("invalid_body");
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
        const base = { requestId: body.requestId, projectId, expectedRevision: revision };
        const command = (action === "accept" ? { ...base, kind: "dispatch.proposal.accept", payload: { proposalId, roleIds: form ? roleKeys.map(key => key.slice(5)) : body.roleIds } }
          : { ...base, kind: action === "dismiss" ? "dispatch.proposal.dismiss" : "dispatch.answer", payload: { proposalId } }) as DispatchCommand;
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: cardLocation(receipt.proposal) });
      }
      if (request.method === "POST" && stopAllRoute) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision"].includes(key))) throw new AppError("invalid_body");
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
        const command = { kind: "team.stop_all", requestId: body.requestId, projectId: stopAllRoute[2], expectedRevision: revision,
          payload: { discussionId: stopAllRoute[3] } } as TeamCommand;
        const receipt = app.execute(auth.actor, command);
        const origin = receipt.discussion?.origin;
        return api ? json(receipt) : respond(null, 303, { Location: origin ? cardLocation(app.dispatchCard(auth.actor, stopAllRoute[2]!, origin.proposalId))
          : `/projects/${stopAllRoute[2]}/team/discussions/${stopAllRoute[3]}` });
      }
      if (request.method === "POST" && approvalDecideRoute) {
        // web.approval_cards/v1 (EXE09): decide one card bound to its digest and revision.
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "expectedDigest", "decision", "cardId"].includes(key))) throw new AppError("invalid_body");
        const [, , projectId, topicId, urlCardId] = approvalDecideRoute;
        if (typeof body.cardId === "string" && body.cardId !== urlCardId) throw new AppError("invalid_body");
        if (body.decision !== "approve" && body.decision !== "deny") throw new AppError("invalid_body");
        if (typeof body.expectedDigest !== "string" || !/^[0-9a-f]{64}$/.test(body.expectedDigest)) throw new AppError("invalid_body");
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
        const command = { kind: "approval.decide", requestId: body.requestId, projectId, expectedRevision: revision,
          payload: { cardId: urlCardId, digest: body.expectedDigest, decision: body.decision } } as DecideCardCommand;
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: `/projects/${projectId}/topics/${topicId}#approval-${urlCardId}` });
      }
      if (url.pathname === "/settings/approvals" && request.method === "GET") {
        const raw = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,7}$/.test(raw)) throw new AppError("invalid_offset");
        const offset = Number(raw), paged = app.workspace(auth.actor, offset);
        const projects = paged.projects;
        const pending = projects.flatMap(p => {
          try { return app.approvalCards(auth.actor, p.id, { state: "pending" }).map(card => ({ card, projectName: p.name })); }
          catch { return []; }
        });
        const rules = projects.flatMap(p => {
          try { return app.effectSettings(auth.actor, p.id).rules.map(rule => ({ projectId: p.id, projectName: p.name, rule })); }
          catch { return []; }
        });
        return page(() => settingsApprovalsPage(nav(paged), pending, rules, projects.map(p => ({ id: p.id, name: p.name })), auth.csrf));
      }
      if (request.method === "POST" && (approvalRulesRoute || approvalRuleDisableRoute)) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (approvalRulesRoute) {
          if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "projectId", "effectKind", "remote", "branches", "target", "confirm"].includes(key))) throw new AppError("invalid_body");
          const confirmed = body.confirm === "on" || body.confirm === true;
          if (!confirmed) throw new AppError("invalid_body", 400);
          if (typeof body.projectId !== "string" || !/^[a-f0-9-]{36}$/.test(body.projectId)) throw new AppError("invalid_body");
          if (typeof body.effectKind !== "string" || !(effectKinds as readonly string[]).includes(body.effectKind)) throw new AppError("invalid_body");
          const kind = body.effectKind as (typeof effectKinds)[number];
          const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
          const scope = kind === "effect.git_push"
            ? { remote: text(body.remote), branches: text(body.branches).split(",").map(s => s.trim()).filter(Boolean) }
            : kind === "effect.deploy" ? { target: text(body.target) } : { remote: text(body.remote) };
          const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
          const command = { kind: "approval.rule.set", requestId: body.requestId, projectId: body.projectId, expectedRevision: revision,
            payload: { effectKind: kind, scope, enabled: true } } as SetAutoApproveCommand;
          const receipt = app.execute(auth.actor, command);
          return api ? json(receipt) : respond(null, 303, { Location: "/settings/approvals" });
        }
        // Disable: /settings/approvals/rules/<projectId:effectKind> (the `:rule` in the issue).
        const encoded = approvalRuleDisableRoute![1]!;
        let projectId: string | undefined, effectKind: string | undefined;
        const split = encoded.split(":");
        if (split.length === 2 && /^[a-f0-9-]{36}$/.test(split[0]!)) { projectId = split[0]; effectKind = decodeURIComponent(split[1]!); }
        else if (/^[a-f0-9-]{36}$/.test(encoded)) { projectId = encoded; effectKind = typeof body.effectKind === "string" ? body.effectKind : undefined; }
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "projectId", "effectKind"].includes(key))) throw new AppError("invalid_body");
        projectId ??= typeof body.projectId === "string" ? body.projectId : undefined;
        effectKind ??= typeof body.effectKind === "string" ? body.effectKind : undefined;
        if (!projectId || !/^[a-f0-9-]{36}$/.test(projectId) || !effectKind || !(effectKinds as readonly string[]).includes(effectKind)) throw new AppError("invalid_body");
        const current = app.effectSettings(auth.actor, projectId).rules.find(rule => rule.effectKind === effectKind);
        if (!current) throw new AppError("effect_target_not_found", 404);
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
        const command = { kind: "approval.rule.set", requestId: body.requestId, projectId, expectedRevision: revision,
          payload: { effectKind: effectKind as (typeof effectKinds)[number], scope: current.scope, enabled: false } } as SetAutoApproveCommand;
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: "/settings/approvals" });
      }
      if (allowanceApiRoute || (allowanceFormRoute && request.method === "POST")) {
        const projectId = (allowanceApiRoute ?? allowanceFormRoute)![1]!;
        if (request.method === "GET") return json(app.dispatchAllowance(auth.actor, projectId));
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "enabled", "maxRoles"].includes(key))) throw new AppError("invalid_body");
        const number = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
        // An unchecked checkbox is absent from a form post; JSON must say true or false.
        const enabled = allowanceFormRoute ? body.enabled === undefined ? false : body.enabled === "on" ? true : body.enabled : body.enabled;
        const command = { kind: "dispatch.allowance.set", requestId: body.requestId, projectId, expectedRevision: number(body.expectedRevision),
          payload: { enabled, maxRoles: number(body.maxRoles) } } as SetDispatchAllowanceCommand;
        const receipt = app.execute(auth.actor, command);
        return allowanceApiRoute ? json(receipt) : respond(null, 303, { Location: `/settings/dispatch?project=${projectId}#allowance-${projectId}` });
      }
      if (connectionRoute) {
        const connectionId = connectionRoute[1], action = connectionRoute[2];
        if (!action && request.method === "GET") return json({ connections: app.connections(auth.actor) });
        if (request.method !== "POST") throw new AppError("method_not_allowed", 405);
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const fields = !action ? ["kind", "label", "projectScope"] : action === "secret" || action === "rotate" ? ["secret"] : [];
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", ...fields].includes(key))) throw new AppError("invalid_body");
        const picked = Object.fromEntries(fields.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
        const kind = !action ? "connection.create" : action === "secret" ? "connection.set_secret" : `connection.${action}`;
        const command = { kind, requestId: body.requestId, projectId: null, expectedRevision: action ? body.expectedRevision : 0,
          payload: action ? { connectionId, ...picked } : picked } as ConnectionCommand;
        return json(app.execute(auth.actor, command));
      }
      if (boxRoute) {
        const projectId = boxRoute[1]!;
        if (!boxRoute[2]) {
          if (request.method !== "GET") throw new AppError("method_not_allowed", 405);
          return json({ box: app.boxStatus(auth.actor, projectId) });
        }
        if (request.method !== "POST") throw new AppError("method_not_allowed", 405);
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "wipeWorkspace"].includes(key))) throw new AppError("invalid_body");
        const command = { kind: "execution.box.reset", requestId: body.requestId, projectId, expectedRevision: body.expectedRevision,
          payload: Object.hasOwn(body, "wipeWorkspace") ? { wipeWorkspace: body.wipeWorkspace } : {} } as ResetBoxCommand;
        return json(await app.execute(auth.actor, command));
      }
      if (accessRoute) {
        const projectId = accessRoute[1]!, target = accessRoute[2]!;
        if (request.method === "GET") {
          if (target !== "access") throw new AppError("method_not_allowed", 405);
          const access = app.projectAccess(auth.actor, projectId);
          return json({ access, roles: app.roleAccess(auth.actor, projectId), effective: effectiveAccess(access, null) });
        }
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const fields = target === "access" ? ["level", "confirmToken"] : target === "access/roles" ? ["roleId", "level"] : target === "execution/halt" ? ["reason"] : [];
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", ...fields].includes(key))) throw new AppError("invalid_body");
        // Only fields the body carries enter the payload, so the command's exact-keys check sees what the owner sent.
        const picked = Object.fromEntries(fields.filter(key => Object.hasOwn(body, key)).map(key => [key, body[key]]));
        const kind = target === "access" ? "access.level.set" : target === "access/roles" ? "access.role.restrict" : target === "execution/halt" ? "execution.halt" : "execution.resume";
        const command = { kind, requestId: body.requestId, projectId, expectedRevision: body.expectedRevision, payload: picked } as AccessCommand;
        return json(app.execute(auth.actor, command));
      }
      if (url.pathname === "/settings/dispatch" && request.method === "GET") {
        const raw = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,7}$/.test(raw)) throw new AppError("invalid_offset");
        // `?project=` opens one project's allowance wherever it falls in the paged list (team card links, form redirects).
        const only = url.searchParams.getAll("project");
        if (only.length > 1 || (only.length === 1 && !/^[a-f0-9-]{36}$/.test(only[0]!))) throw new AppError("invalid_query");
        const offset = Number(raw), paged = app.workspace(auth.actor, offset);
        const list = only.length ? { projects: [app.project(auth.actor, only[0]!)], hasMore: false, single: true } : { projects: paged.projects, hasMore: paged.hasMore, single: false };
        const allowances = new Map(list.projects.map(p => [p.id, app.dispatchAllowance(auth.actor, p.id)] as const));
        return page(() => settingsDispatchPage(nav(paged), list, allowances, auth.csrf, offset, config.pageSize));
      }
      // web.access_settings/v1 (EXE04): execution levels, role limits and the kill switch. Narrowing posts
      // straight to the project; widening goes through the confirmation page; halt and resume fence execution.
      const accessPageRoute = /^\/settings\/access\/([a-f0-9-]{36})\/(confirm|roles|halt|resume)$/.exec(url.pathname);
      const accessProjectRoute = /^\/settings\/access\/([a-f0-9-]{36})$/.exec(url.pathname);
      /** Maps an EXE01 command refusal to its owner-facing Settings sentence. */
      const accessError = (error: unknown): string | null => error instanceof AppError ? ({
        access_widen_requires_web: "access.error_widen_requires_web",
        access_confirm_required: "access.error_confirm_required",
        access_full_not_allowed: "access.error_full_not_allowed",
        access_role_above_project: "access.error_role_above_project",
      } as Record<string, string>)[error.code] ?? null : null;
      if (url.pathname === "/settings/access" && request.method === "GET") {
        const raw = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,7}$/.test(raw)) throw new AppError("invalid_offset");
        // `?project=` opens one project's access wherever it falls in the paged list (form redirects).
        const only = url.searchParams.getAll("project");
        if (only.length > 1 || (only.length === 1 && !/^[a-f0-9-]{36}$/.test(only[0]!))) throw new AppError("invalid_query");
        const offset = Number(raw), paged = app.workspace(auth.actor, offset);
        const projects = only.length ? [app.project(auth.actor, only[0]!)] : paged.projects;
        const rows = projects.map(project => ({ project,
          teamRoles: app.team(auth.actor, project.id).roles.map(role => ({ id: role.id, name: role.name })) }));
        const access = new Map(rows.map(({ project }) => [project.id, app.projectAccess(auth.actor, project.id)] as const));
        const roles = new Map(rows.map(({ project }) => [project.id, app.roleAccess(auth.actor, project.id)] as const));
        const list = { projects: rows, hasMore: only.length ? false : paged.hasMore, single: only.length > 0 };
        return page(() => settingsAccessPage(nav(paged), list, access, roles, auth.csrf, offset, config.pageSize));
      }
      if (request.method === "GET" && accessPageRoute && accessPageRoute[2] === "confirm") {
        const projectId = accessPageRoute[1]!;
        const to = url.searchParams.get("to") ?? "";
        const project = app.project(auth.actor, projectId);
        const current = app.projectAccess(auth.actor, projectId);
        // Anything but a genuine widening goes back to the list; the POST enforces revision and token.
        if (!(accessLevels as readonly string[]).includes(to) || levelRank(to as AccessLevel) <= levelRank(current.level))
          return respond(null, 303, { Location: `/settings/access?project=${projectId}` });
        const level = to as AccessLevel;
        return page(() => accessConfirmPage(nav(), project, current.level, level, current.revision,
          accessConfirmToken(projectId, current.level, level, current.revision), auth.csrf));
      }
      if (request.method === "POST" && (accessProjectRoute || (accessPageRoute && accessPageRoute[2] !== "confirm"))) {
        const projectId = (accessProjectRoute ?? accessPageRoute)![1]!;
        const verb = accessProjectRoute ? "level" : accessPageRoute![2]!;
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const number = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
        const allowed = ["csrf", "requestId", "expectedRevision",
          ...(verb === "level" ? ["level", "confirmToken"] : verb === "roles" ? ["roleId", "level"] : [])];
        if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError("invalid_body");
        const kind = verb === "level" ? "access.level.set" : verb === "roles" ? "access.role.restrict"
          : verb === "halt" ? "execution.halt" : "execution.resume";
        // The role form posts `inherit` for a cleared override; only sent fields enter the command payload.
        const level = verb === "roles" && body.level === "inherit" ? null : body.level;
        const picked = Object.fromEntries(["level", "confirmToken", "roleId"]
          .filter(key => Object.hasOwn(body, key)).map(key => [key, key === "level" && verb === "roles" ? level : body[key]]));
        const command = { requestId: body.requestId, projectId, expectedRevision: number(body.expectedRevision),
          kind, payload: verb === "halt" || verb === "resume" ? {} : picked } as AccessCommand;
        try {
          app.execute(auth.actor, command);
        } catch (error) {
          const key = accessError(error);
          if (!key) throw error;
          return page(() => errorPage(tr(key as MessageKey)), error instanceof AppError ? error.status : 409);
        }
        return respond(null, 303, { Location: `/settings/access?project=${projectId}#access-${projectId}` });
      }
      // web.connections_settings/v1 (EXE11): owner credentials for approved effects. Secrets travel one way
      // only: the forms post them, the commands consume them, and no response, redirect or log ever echoes one.
      const connectionPageRoute = /^\/settings\/connections\/([a-f0-9-]{36})\/(secret|test|remove)$/.exec(url.pathname);
      /** Maps an EXE08 command refusal to its owner-facing Settings sentence. */
      const secretError = (error: unknown): string | null => error instanceof AppError && error.code === "connection_requires_web"
        ? "connection.error_requires_web" : null;
      if (url.pathname === "/settings/connections" && request.method === "GET") {
        const tested = url.searchParams.getAll("tested"), result = url.searchParams.getAll("result");
        // `?tested=<id>&result=<ok|failed>` echoes the test the owner just ran; anything else is rejected.
        if (tested.length > 1 || result.length > 1 || tested.length !== result.length ||
            (tested.length === 1 && (!/^[a-f0-9-]{36}$/.test(tested[0]!) || (result[0] !== "ok" && result[0] !== "failed"))))
          throw new AppError("invalid_query");
        // The scope picker lists every project, not just the first page.
        const projects: NavigationWorkspace["projects"] = [];
        for (let offset = 0; ; offset += config.pageSize) {
          const page = app.workspace(auth.actor, offset);
          projects.push(...page.projects);
          if (!page.hasMore) break;
        }
        return page(() => settingsConnectionsPage(nav(), app.connections(auth.actor).filter(view => view.removedAt === null),
          projects, auth.csrf, tested.length ? { id: tested[0]!, ok: result[0] === "ok" } : null));
      }
      if (request.method === "POST" && (url.pathname === "/settings/connections" || connectionPageRoute)) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const revisionNumber = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
        if (!connectionPageRoute) {
          // Create: kind, label, scope checkboxes (`scope-<id>`, none meaning every project) and one secret.
          const scopeKeys = Object.keys(body).filter(key => key.startsWith("scope-"));
          if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "kind", "label", "secret", ...scopeKeys].includes(key)) ||
              scopeKeys.some(key => !/^scope-[a-f0-9-]{36}$/.test(key) || body[key] !== "on") ||
              typeof body.kind !== "string" || typeof body.label !== "string" || typeof body.secret !== "string" ||
              typeof body.requestId !== "string")
            throw new AppError("invalid_body");
          // Fail a weak secret before the row exists, so no empty connection is left behind.
          normalizeSecret(body.secret);
          const scope = [...new Set(scopeKeys.map(key => key.slice("scope-".length)))].sort();
          // A connection holds at most 32 projects: re-render the form with the selection kept, not a dead end.
          if (scope.length > 32) {
            const projects: NavigationWorkspace["projects"] = [];
            for (let offset = 0; ; offset += config.pageSize) {
              const page = app.workspace(auth.actor, offset);
              projects.push(...page.projects);
              if (!page.hasMore) break;
            }
            return page(() => settingsConnectionsPage(nav(), app.connections(auth.actor).filter(view => view.removedAt === null),
              projects, auth.csrf, null, { scope, error: "connection.error_scope_too_many" }), 400);
          }
          try {
            const created = app.execute(auth.actor, { kind: "connection.create", requestId: body.requestId, projectId: null,
              expectedRevision: 0, payload: { kind: body.kind, label: body.label, projectScope: scope.length ? scope : null } } as ConnectionCommand);
            // The secret step derives its request id from the create step, so a repeated
            // form replays the saved receipt instead of racing the committed revision.
            const secretRequestId = `${body.requestId}-secret`;
            app.execute(auth.actor, { kind: "connection.set_secret", requestId: secretRequestId, projectId: null,
              expectedRevision: created.connection.revision,
              payload: { connectionId: created.connection.id, secret: body.secret } } as ConnectionCommand);
            return respond(null, 303, { Location: `/settings/connections#connection-${created.connection.id}` });
          } catch (error) {
            const key = secretError(error);
            if (!key) throw error;
            return page(() => errorPage(tr(key as MessageKey)), error instanceof AppError ? error.status : 403);
          }
        }
        const connectionId = connectionPageRoute[1]!, verb = connectionPageRoute[2]!;
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", ...(verb === "secret" ? ["secret"] : verb === "remove" ? ["confirm"] : [])].includes(key))) throw new AppError("invalid_body");
        // Removing needs the explicit checkbox; its absence (or any other value) refuses the removal.
        if (verb === "remove" && body.confirm !== "on") throw new AppError("invalid_body");
        if (verb === "secret" && typeof body.secret !== "string") throw new AppError("invalid_body");
        // An empty connection takes its first secret; only a filled one rotates.
        const stored = verb === "secret" ? app.connections(auth.actor).find(view => view.id === connectionId) : undefined;
        if (verb === "secret" && !stored) throw new AppError("connection_not_found", 404);
        const kind = verb === "secret"
          ? stored!.secret === "empty" ? "connection.set_secret" : "connection.rotate"
          : verb === "test" ? "connection.test" : "connection.remove";
        const command = { kind, requestId: body.requestId, projectId: null, expectedRevision: revisionNumber(body.expectedRevision),
          payload: verb === "secret" ? { connectionId, secret: body.secret } : { connectionId } } as ConnectionCommand;
        try {
          const receipt = app.execute(auth.actor, command);
          if (verb !== "test") return respond(null, 303, { Location: `/settings/connections#connection-${connectionId}` });
          const ok = receipt.test?.state === "present";
          return respond(null, 303, { Location: `/settings/connections?tested=${connectionId}&result=${ok ? "ok" : "failed"}#connection-${connectionId}` });
        } catch (error) {
          const key = secretError(error);
          if (!key) throw error;
          return page(() => errorPage(tr(key as MessageKey)), error instanceof AppError ? error.status : 403);
        }
      }
      if (request.method === "GET" && claimRoute) {
        const revision = Number(url.searchParams.get("revision")), generation = Number(url.searchParams.get("generation"));
        const state = app.memoryClaim(auth.actor, claimRoute[1]!, { claimId: claimRoute[2]!, revision, generation });
        const project = app.project(auth.actor, claimRoute[1]!);
        const correction = app.memoryCorrection(auth.actor, claimRoute[1]!, claimRoute[2]!);
        const impact = state.state === "available"
          ? app.correctionImpact(auth.actor, claimRoute[1]!, { claimId: state.claim.claimId, revision: state.claim.revision, generation: state.claim.generation })
          : null;
        const suppression = app.memorySuppression(auth.actor, claimRoute[1]!, claimRoute[2]!);
        const ledger = app.suppressionLedger(auth.actor, claimRoute[1]!, claimRoute[2]!);
        const forgetImpact = state.state === "available" && !suppression
          ? app.suppressionImpact(auth.actor, claimRoute[1]!, { claimId: state.claim.claimId, revision: state.claim.revision, generation: state.claim.generation })
          : null;
        const inspector = app.memory(auth.actor, claimRoute[1]!);
        const extra = { correction, impact, suppression, forgetImpact, ledger, revision: project.revision,
          sources: inspector.sources.flatMap(({ source }) => source.state === "available"
            ? [{ reference: source.reference, label: `${source.descriptor.kind} · ${Array.from(source.text).slice(0, 80).join("")}` }] : []) };
        return api ? json({ ...state, correction, impact, suppression, forgetImpact, ledger }) : page(() => memoryClaimPage(state, extra, project, nav(), auth.csrf));
      }
      if (request.method === "POST" && claimRoute) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "mode", "revision", "generation", "text", "quote", "source", "reason", "acknowledged"].includes(key))) throw new AppError("invalid_body");
        const form = request.headers.get("content-type")?.split(";")[0]?.trim() === "application/x-www-form-urlencoded";
        const data = (value: unknown) => { if (!form) return value; try { return JSON.parse(value as string); } catch { throw new AppError("invalid_body"); } };
        if (body.mode === "forget" || data(body.mode) === "forget") {
          const acknowledged = form ? body.acknowledged === "on" : data(body.acknowledged) === true;
          const command: ForgetMemoryCommand = { kind: "memory.forget", projectId: claimRoute[1]!, requestId: body.requestId as string,
            expectedRevision: form ? Number(body.expectedRevision) : body.expectedRevision as number,
            payload: { claim: { claimId: claimRoute[2]!, revision: form ? Number(body.revision) : body.revision as number, generation: form ? Number(body.generation) : body.generation as number },
              reason: body.reason as string, acknowledged } };
          const result = app.execute(auth.actor, command);
          const target = result.suppression;
          return api ? json(result) : respond(null, 303, { Location: `/projects/${claimRoute[1]!}/memory/claims/${target.claimId}?revision=${target.fromRevision}&generation=${target.fromGeneration}` });
        }
        const command: CorrectMemoryCommand = { kind: "memory.correct", projectId: claimRoute[1]!, requestId: body.requestId as string,
          expectedRevision: form ? Number(body.expectedRevision) : body.expectedRevision as number,
          payload: { claim: { claimId: claimRoute[2]!, revision: form ? Number(body.revision) : body.revision as number, generation: form ? Number(body.generation) : body.generation as number },
            text: body.text as string, quote: body.quote as string, source: data(body.source) as CorrectMemoryCommand["payload"]["source"], reason: body.reason as string } };
        const result = app.execute(auth.actor, command);
        return api ? json(result) : respond(null, 303, { Location: `/projects/${claimRoute[1]!}/memory/claims/${result.replacement.claimId}?revision=${result.replacement.revision}&generation=${result.replacement.generation}` });
      }
      if (request.method === "GET" && contextRoute) {
        const state = app.memoryContext(auth.actor, contextRoute[1]!, contextRoute[2]!);
        return api ? json(state) : page(() => memoryContextPage(state, nav(), auth.csrf));
      }
      if (request.method === "GET" && deletionsRoute) {
        const { project, operations } = app.deletionOperations(auth.actor, deletionsRoute[2]!);
        const inspector = app.memory(auth.actor, deletionsRoute[2]!);
        const sources = inspector.sources.flatMap(({ source }) => source.state === "available"
          ? [{ reference: source.reference, label: `${source.descriptor.kind} · ${Array.from(source.text).slice(0, 80).join("")}` }] : []);
        return api ? json({ project, operations }) : page(() => deletionsPage({ project, operations }, nav(), auth.csrf, sources));
      }
      if (request.method === "GET" && deletionRoute) {
        const { project, preview } = app.deletionPreview(auth.actor, deletionRoute[2]!, deletionRoute[3]!);
        const { operation } = app.deletionOperation(auth.actor, deletionRoute[2]!, deletionRoute[3]!);
        if (!preview && !operation) throw new AppError("deletion_not_found", 404);
        return api ? json({ project, preview, operation }) : page(() => deletionDetailPage({ project, preview, operation }, nav(), auth.csrf));
      }
      if (request.method === "GET" && exportsRoute) {
        const state = app.exports(auth.actor, exportsRoute[2]!);
        const { preview } = app.exportPreview(auth.actor, exportsRoute[2]!, url.searchParams.get("history") === "1");
        return api ? json({ ...state, preview }) : page(() => exportsPage({ ...state, preview }, nav(), auth.csrf));
      }
      if (request.method === "GET" && exportArtifactRoute) {
        // Owner-authenticated only; bytes come from the committed valid row, never a filesystem path.
        const { manifest, body } = app.exportArtifact(auth.actor, exportArtifactRoute[2]!, exportArtifactRoute[3]!);
        return respond(Buffer.from(body), 200, { "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="jit-export-${manifest.id}.json"`, "X-Content-Type-Options": "nosniff" });
      }
      if (request.method === "GET" && exportRoute) {
        const state = app.export(auth.actor, exportRoute[2]!, exportRoute[3]!);
        return api ? json(state) : page(() => exportDetailPage(state, nav(), auth.csrf));
      }
      if (request.method === "GET" && upgradesRoute) {
        const state = { ...app.upgrades(auth.actor), status: app.upgradeStatus(auth.actor) };
        const revision = app.workspace(auth.actor).revision;
        return api ? json(state) : page(() => upgradesPage(state, nav(), auth.csrf, revision));
      }
      if (request.method === "GET" && upgradeRoute) {
        const state = app.upgrade(auth.actor, upgradeRoute[2]!);
        if (api) return json(state);
        const workspace = nav();
        return page(() => upgradeDetailPage(state, workspace, auth.csrf, workspace.revision));
      }
      if (request.method === "GET" && (restoresRoute || restoreRoute)) {
        // ops.quarantined_restore/v1: restore status and remediation stay available while the read gate holds;
        // the shell then carries no project data.
        const consoleState = app.restoreConsole(auth.actor);
        const workspace: NavigationWorkspace = consoleState.gatedBy ? { revision: consoleState.revision, projects: [], hasMore: false } : nav();
        if (restoresRoute) {
          const state = app.restores(auth.actor);
          const backups = app.backups(auth.actor);
          return api ? json({ ...state, backups, gatedBy: consoleState.gatedBy })
            : page(() => restoresPage({ ...state, backups: backups.manifests }, workspace, auth.csrf, consoleState.revision));
        }
        const state = app.restore(auth.actor, restoreRoute![2]!);
        return api ? json(state) : page(() => restoreDetailPage(state, workspace, auth.csrf, consoleState.revision));
      }
      if (request.method === "GET" && backupsRoute) {
        const state = app.backups(auth.actor);
        const revision = app.workspace(auth.actor).revision;
        return api ? json(state) : page(() => backupsPage(state, nav(), auth.csrf, revision));
      }
      if (request.method === "GET" && backupRoute) {
        const state = app.backup(auth.actor, backupRoute[2]!);
        return api ? json(state) : page(() => backupDetailPage(state, nav(), auth.csrf));
      }
      if (request.method === "GET" && memoryRoute) {
        const sourceAfter = Number(url.searchParams.get("sourceAfter") ?? 0), extractionAfter = Number(url.searchParams.get("extractionAfter") ?? 0);
        const state = app.memory(auth.actor, memoryRoute[1]!, after(), sourceAfter, extractionAfter, url.searchParams.get("q") ?? "");
        return api ? json(state) : page(() => memoryPage(state, nav(), auth.csrf, config.jobs.maximum, { after: after(), sourceAfter, extractionAfter }));
      }
      if (request.method === "POST" && memoryRoute) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "topicId", "roleId", "source", "dependencies", "limits"].includes(key))) throw new AppError("invalid_body");
        const form = request.headers.get("content-type")?.split(";")[0]?.trim() === "application/x-www-form-urlencoded";
        const data = (value: unknown) => { if (!form) return value; try { return JSON.parse(value as string); } catch { throw new AppError("invalid_body"); } };
        const command: ExtractMemoryCommand = { kind: "memory.extract", projectId: memoryRoute[1]!, requestId: body.requestId as string,
          expectedRevision: form ? Number(body.expectedRevision) : body.expectedRevision as number,
          payload: { topicId: body.topicId as string, roleId: body.roleId as string, source: data(body.source) as ExtractMemoryCommand["payload"]["source"],
            dependencies: data(body.dependencies) as ExtractMemoryCommand["payload"]["dependencies"], limits: data(body.limits) as JobLimits } };
        const result = app.execute(auth.actor, command);
        return api ? json(result) : respond(null, 303, { Location: `/projects/${command.projectId}/memory#extraction-${result.extraction.id}` });
      }
      if (request.method === "POST" && deletionsRoute) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const form = request.headers.get("content-type")?.split(";")[0]?.trim() === "application/x-www-form-urlencoded";
        const data = (value: unknown) => { if (!form) return value; try { return JSON.parse(value as string); } catch { throw new AppError("invalid_body"); } };
        const projectId = deletionsRoute[2]!;
        const number = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
        if (body.mode === "preview" || data(body.mode) === "preview") {
          if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "mode", "source"].includes(key))) throw new AppError("invalid_body");
          const command = { kind: "memory.delete.preview" as const, requestId: body.requestId as string, projectId,
            expectedRevision: number(body.expectedRevision) as number,
            payload: { scope: { kind: "source" as const, projectId, source: data(body.source) as import("./sources").SourceReference } } };
          const result = app.execute(auth.actor, command) as { preview: { id: string } };
          return api ? json(result) : respond(null, 303, { Location: `/projects/${projectId}/memory/deletions/${result.preview.id}` });
        }
        if (body.mode === "confirm" || data(body.mode) === "confirm") {
          if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "mode", "previewId", "acknowledged", "acknowledgedWholeSession"].includes(key))) throw new AppError("invalid_body");
          const command = { kind: "memory.delete.confirm" as const, requestId: body.requestId as string, projectId,
            expectedRevision: number(body.expectedRevision) as number,
            payload: { previewId: body.previewId as string, acknowledged: form ? body.acknowledged === "on" : data(body.acknowledged) === true,
              acknowledgedWholeSession: form ? body.acknowledgedWholeSession === "on" : data(body.acknowledgedWholeSession) === true } };
          const result = app.execute(auth.actor, command) as { operation: { id: string } };
          return api ? json(result) : respond(null, 303, { Location: `/projects/${projectId}/memory/deletions/${result.operation.id}` });
        }
        if (body.mode === "retry" || data(body.mode) === "retry") {
          if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "mode", "operationId"].includes(key))) throw new AppError("invalid_body");
          const command = { kind: "memory.delete.retry" as const, requestId: body.requestId as string, projectId,
            expectedRevision: number(body.expectedRevision) as number, payload: { operationId: body.operationId as string } };
          const result = app.execute(auth.actor, command) as { operation: { id: string } } | { id: string };
          const id = "operation" in result ? result.operation.id : result.id;
          return api ? json(result) : respond(null, 303, { Location: `/projects/${projectId}/memory/deletions/${id}` });
        }
        throw new AppError("invalid_body");
      }
      if (request.method === "POST" && exportsRoute) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "includeHistory", "note"].includes(key))) throw new AppError("invalid_body");
        const form = request.headers.get("content-type")?.split(";")[0]?.trim() === "application/x-www-form-urlencoded";
        const data = (value: unknown) => { if (!form) return value; try { return JSON.parse(value as string); } catch { throw new AppError("invalid_body"); } };
        const projectId = exportsRoute[2]!;
        const number = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
        const command = { kind: "export.create" as const, requestId: body.requestId as string, projectId,
          expectedRevision: number(body.expectedRevision) as number,
          payload: { includeHistory: form ? body.includeHistory === "on" : data(body.includeHistory) === true, note: (body.note as string) ?? "manual export" } };
        const result = app.execute(auth.actor, command) as { manifest: { id: string } };
        return api ? json(result) : respond(null, 303, { Location: `/projects/${projectId}/exports/${result.manifest.id}` });
      }
      if (request.method === "POST" && (upgradesRoute || upgradeRoute)) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const revision = app.workspace(auth.actor).revision;
        const number = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
        if (upgradesRoute) {
          if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "targetSchema", "note"].includes(key))) throw new AppError("invalid_body");
          const command = { kind: "upgrade.prepare" as const, requestId: body.requestId as string, projectId: null,
            expectedRevision: number(body.expectedRevision) as number,
            payload: { targetSchema: number(body.targetSchema) as number, note: (body.note as string) ?? "manual upgrade" } };
          const result = await app.execute(auth.actor, command);
          return api ? json(result) : respond(null, 303, { Location: `/settings/upgrades/${result.journal.id}` });
        }
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "action"].includes(key))) throw new AppError("invalid_body");
        const action = body.action as "migrate" | "validate" | "activate" | "rollback";
        if (!["migrate", "validate", "activate", "rollback"].includes(action)) throw new AppError("invalid_body");
        const command = { kind: `upgrade.${action}` as const, requestId: body.requestId as string, projectId: null,
          expectedRevision: number(body.expectedRevision) as number, payload: { upgradeId: upgradeRoute![2]! } };
        const result = await app.execute(auth.actor, command);
        return api ? json(result) : respond(null, 303, { Location: `/settings/upgrades/${result.journal.id}` });
      }
      if (request.method === "POST" && (restoresRoute || restoreRoute)) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const number = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
        if (restoresRoute) {
          if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "backupId", "note"].includes(key))) throw new AppError("invalid_body");
          const command = { kind: "restore.prepare" as const, requestId: body.requestId as string, projectId: null,
            expectedRevision: number(body.expectedRevision) as number,
            payload: { backupId: body.backupId as string, note: (body.note as string) ?? "manual restore" } };
          const result = await app.execute(auth.actor, command);
          return api ? json(result) : respond(null, 303, { Location: `/settings/restores/${result.quarantine.id}` });
        }
        // ops.quarantined_restore/v1: steps name only the quarantine; ledger content is never accepted from a request.
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "action"].includes(key))) throw new AppError("invalid_body");
        const action = body.action as "migrate" | "apply_ledger" | "validate" | "activate" | "discard";
        if (!["migrate", "apply_ledger", "validate", "activate", "discard"].includes(action)) throw new AppError("invalid_body");
        const command = { kind: `restore.${action}` as const, requestId: body.requestId as string, projectId: null,
          expectedRevision: number(body.expectedRevision) as number, payload: { quarantineId: restoreRoute![2]! } };
        const result = await app.execute(auth.actor, command);
        // Activation revokes every session (generation fence): the browser signs in again.
        if (!api && result.quarantine.activation.sessionsRevoked) return respond(null, 303, { Location: "/login" });
        return api ? json(result) : respond(null, 303, { Location: `/settings/restores/${result.quarantine.id}` });
      }
      // app.setup/v1 ("ตั้งจิต"): one page per step and one form post per step. A finished setup is never shown again.
      const setupAction = /^\/(api\/)?setup\/(wake|connect|check|connect-continue|know|personality|personality-skip|complete)$/.exec(url.pathname);
      if (request.method === "GET" && (url.pathname === "/setup" || url.pathname === "/api/setup")) {
        const setup = app.setup(auth.actor);
        if (api) return json(setup);
        if (setup.complete) return respond(null, 303, { Location: "/" });
        const shown = visibleStep(setup, url.searchParams.get("step"));
        // The wake step previews the other language without saving anything; its form saves the choice.
        const lang = url.searchParams.get("lang");
        const locale: Locale = shown === "wake" && (lang === "th" || lang === "en") ? lang : ui.locale;
        return respond(renderWith({ ...ui, locale }, () => setupPage(setup, auth.csrf, shown)), 200, { "Content-Language": locale, "Vary": "Accept-Language, Cookie" });
      }
      if (request.method === "POST" && setupAction) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const step = setupAction[2]!, form = request.headers.get("content-type")?.split(";")[0]?.trim() === "application/x-www-form-urlencoded";
        const fields: Record<string, readonly string[]> = {
          wake: ["language"], connect: form ? ["provider", "model", "authRoute"] : ["route"], check: [], "connect-continue": [],
          know: ["addressAs", "selfReference", "language", "particle"], personality: ["personality", "aboutMe"], "personality-skip": [], complete: [],
        };
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", ...fields[step]!].includes(key))) throw new AppError("invalid_body");
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
        // Browsers send CRLF line breaks in a textarea; the persona stores LF.
        const text = (value: unknown) => typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value;
        const kind = step === "connect-continue" ? "setup.connect.continue" : step === "personality-skip" ? "setup.personality.skip" : `setup.${step}`;
        const data = step === "connect" ? { route: form ? { provider: body.provider, model: body.model, authRoute: body.authRoute } : body.route }
          : Object.fromEntries(fields[step]!.map(key => [key, text(body[key])]));
        const command = { kind, requestId: body.requestId, projectId: null, expectedRevision: revision, payload: data } as SetupCommand;
        let receipt: ReturnType<Application["setup"]>;
        try { receipt = app.execute(auth.actor, command).setup; }
        catch (error) {
          // A stale or repeated form (another tab, back button, refresh) resumes where the installation actually is.
          if (!api && error instanceof AppError && error.code === "stale_revision") return respond(null, 303, { Location: "/setup" });
          if (!api && error instanceof AppError && error.code === "setup_complete") return respond(null, 303, { Location: "/" });
          throw error;
        }
        if (api) return json({ setup: receipt });
        const general = receipt.general;
        const location = receipt.complete && general ? `/projects/${general.projectId}/topics/${general.topicId}${general.greetingMessageId ? `#message-${general.greetingMessageId}` : ""}`
          : step === "connect" || step === "check" ? "/setup?step=connect#connection" : "/setup";
        return respond(null, 303, { Location: location });
      }
      if (url.pathname === "/settings" && request.method === "GET") return page(() => settingsPage(app.preferences(auth.actor), nav(), auth.csrf, app.persona(auth.actor), app.localApi(auth.actor), app.attentionLevels(auth.actor)));
      if (url.pathname === "/settings/feed" && request.method === "GET") return page(() => settingsFeedPage(app.scheduleFeedSettings(auth.actor), nav(), auth.csrf));
      if (url.pathname === "/api/settings/feed" && request.method === "GET") return json(app.scheduleFeedSettings(auth.actor));
      // app.schedule_feed/v1 owner commands. New URL answers with the page (or JSON) that shows the minted URL once.
      const feedAction = request.method === "POST" ? /^\/(api\/)?settings\/feed\/(create|rotate|disable|purpose)$/.exec(url.pathname) : null;
      if (feedAction) {
        const body = await payload(request);
        app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const action = feedAction[2] as "create" | "rotate" | "disable" | "purpose";
        const allowed = ["csrf", "requestId", "expectedRevision", ...(action === "purpose" ? ["includePurpose"] : [])];
        if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError("invalid_body");
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
        const base = { requestId: body.requestId as string, projectId: null, expectedRevision: revision as number };
        const command: FeedCommand = action === "purpose"
          ? { ...base, kind: "feed.set_include_purpose", payload: { includePurpose: (api ? body.includePurpose : body.includePurpose === "on") as boolean } }
          : { ...base, kind: action === "create" ? "feed.create" : action === "rotate" ? "feed.rotate" : "feed.disable", payload: {} };
        const receipt = app.execute(auth.actor, command);
        if (api) return json(receipt);
        return action === "create" || action === "rotate" ? page(() => settingsFeedPage(receipt.feed, nav(), auth.csrf, receipt.url))
          : respond(null, 303, { Location: "/settings/feed" });
      }
      if (url.pathname === "/settings/telegram" && request.method === "GET") return page(() => settingsTelegramPage(app.telegramStatus(auth.actor), nav(), auth.csrf));
      if (url.pathname === "/settings/data" && request.method === "GET") {
        const raw = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,7}$/.test(raw)) throw new AppError("invalid_offset");
        const offset = Number(raw);
        return page(() => settingsDataPage(nav(app.workspace(auth.actor, offset)), auth.csrf, offset, config.pageSize));
      }
      if (["/search", "/api/search"].includes(url.pathname) && request.method === "GET") {
        // web.settings_ia/v1 ⌘K: one bounded, read-only query; the browser never receives a preloaded index.
        const values = url.searchParams.getAll("q");
        if (values.length > 1) throw new AppError("invalid_query");
        const results = app.search(auth.actor, values[0] ?? "", searchLimits);
        const response = withLocale(ui.locale, () => searchItems(results));
        return api ? json(response) : page(() => searchPage(response, nav(), auth.csrf));
      }
      if (["/settings/persona", "/api/settings/persona"].includes(url.pathname)) {
        if (request.method === "GET") return api ? json(app.persona(auth.actor)) : respond(null, 303, { Location: "/settings#persona" });
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const fields = ["addressAs", "language", "selfReference", "particle", "personality", "aboutMe"];
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", ...fields].includes(key))) throw new AppError("invalid_body");
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
        // Browsers send CRLF line breaks in a textarea; the persona stores LF.
        const text = (value: unknown) => typeof value === "string" ? value.replace(/\r\n?/g, "\n") : value;
        const command = { kind: "persona.set", requestId: body.requestId, projectId: null, expectedRevision: revision,
          payload: Object.fromEntries(fields.map(key => [key, text(body[key])])) } as unknown as SetPersonaCommand;
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: "/settings#persona" });
      }
      if (["/settings/local-api", "/api/settings/local-api"].includes(url.pathname)) {
        // app.local_api/v1: the owner's only switch for the loopback API (ADR 0035).
        if (request.method === "GET") return api ? json(app.localApi(auth.actor)) : respond(null, 303, { Location: "/settings#local-api" });
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "enabled"].includes(key))) throw new AppError("invalid_body");
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
        // An unchecked checkbox is absent from a form post; JSON must say true or false.
        const enabled = api ? body.enabled : body.enabled === undefined ? false : body.enabled === "on" ? true : body.enabled;
        const command = { kind: "local_api.set", requestId: body.requestId, projectId: null, expectedRevision: revision, payload: { enabled } } as SetLocalApiCommand;
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: "/settings#local-api" });
      }
      if (["/settings/attention", "/api/settings/attention"].includes(url.pathname)) {
        // delivery.attention_levels/v1: one form per channel; each posts the revision of that channel's row.
        if (request.method === "GET") return api ? json(app.attentionLevels(auth.actor)) : respond(null, 303, { Location: "/settings#attention" });
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "channel", "level"].includes(key))) throw new AppError("invalid_body");
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
        const command = { kind: "attention.set", requestId: body.requestId, projectId: null, expectedRevision: revision,
          payload: { channel: body.channel, level: body.level } } as SetAttentionCommand;
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: "/settings#attention" });
      }
      if (["/settings/preferences", "/api/settings/preferences"].includes(url.pathname)) {
        if (request.method === "GET") return api ? json(app.preferences(auth.actor)) : respond(null, 303, { Location: "/settings#appearance" });
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "theme", "language"].includes(key))) throw new AppError("invalid_body");
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
        const command = { kind: "ui.preferences.set", requestId: body.requestId, projectId: null, expectedRevision: revision,
          payload: { theme: body.theme, language: body.language } } as SetPreferencesCommand;
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: "/settings#appearance" });
      }
      if (request.method === "GET" && teamRoute) {
        const state = app.team(auth.actor, teamRoute[1] ?? null);
        return api ? json(state) : page(() => teamPage(state, nav(), auth.csrf, config.jobs.maximum, url.searchParams.get("preset") ?? undefined));
      }
      if (request.method === "GET" && previewRoute) {
        const state = app.preview(auth.actor, previewRoute[1]!, previewRoute[2]!);
        return api ? json(state) : page(() => previewPage(state, nav(), auth.csrf));
      }
      if (request.method === "GET" && discussionRoute) {
        const state = app.discussion(auth.actor, discussionRoute[1]!, discussionRoute[2]!);
        return api ? json(state) : page(() => discussionPage(state, nav(), auth.csrf, config.jobs.maximum));
      }
      if (request.method === "GET" && continuityRoute) {
        const state = app.continuity(auth.actor, continuityRoute[2]!);
        return json(state);
      }
      if (request.method === "GET" && tasksRoute) {
        const state = app.tasks(auth.actor, tasksRoute[2]!);
        return api ? json(state) : page(() => tasksPage(state, nav(), auth.csrf, url.searchParams.get("topic")));
      }
      if (request.method === "GET" && taskRoute) {
        const state = app.task(auth.actor, taskRoute[2]!, taskRoute[3]!);
        return api ? json(state) : page(() => taskPage(state, nav(), auth.csrf, config.messageBytes));
      }
      if (request.method === "POST" && (tasksRoute || taskRoute)) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const number = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
        const cited = () => {
          if (body.source === undefined || body.source === "") return undefined;
          const value = typeof body.source === "string" ? (() => { try { return JSON.parse(body.source) as unknown; } catch { throw new AppError("invalid_body"); } })() : body.source;
          if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_body");
          return value as { sourceId: string; revision: number; generation: number };
        };
        const projectId = (tasksRoute ?? taskRoute)![2]!;
        let command: TaskCommand;
        if (tasksRoute) {
          const allowed = ["csrf", "requestId", "expectedRevision", "topicId", "title", "summary", "source"];
          if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError("invalid_body");
          const source = cited();
          command = { kind: "task.propose", requestId: body.requestId as string, projectId, expectedRevision: number(body.expectedRevision) as number,
            payload: { topicId: body.topicId as string, title: body.title as string, summary: body.summary as string, ...(source ? { source } : {}) } };
        } else {
          const allowed = ["csrf", "requestId", "expectedRevision", "mode", "proposalId", "title", "summary", "source", "reason", "note", "policyKind", "successorTaskId"];
          if (Object.keys(body).some(key => !allowed.includes(key)) || typeof body.mode !== "string") throw new AppError("invalid_body");
          const taskId = taskRoute![3]!, expectedRevision = number(body.expectedRevision) as number, requestId = body.requestId as string;
          const base = { requestId, projectId, expectedRevision };
          if (body.mode === "edit") {
            const source = cited();
            command = { ...base, kind: "task.edit", payload: { taskId, title: body.title as string, summary: body.summary as string, ...(source ? { source } : {}) } };
          } else if (body.mode === "dismiss") command = { ...base, kind: "task.dismiss", payload: { taskId, proposalId: body.proposalId as string, reason: body.reason as string } };
          else if (body.mode === "accept") command = { ...base, kind: "task.accept", payload: { taskId, proposalId: body.proposalId as string } };
          else if (body.mode === "cancel") command = { ...base, kind: "task.cancel", payload: { taskId, reason: body.reason as string } };
          else if (body.mode === "complete") command = { ...base, kind: "task.complete", payload: { taskId, ...(body.note ? { note: body.note as string } : {}), ...(body.source ? { evidence: [cited()!] } : {}) } };
          else if (body.mode === "reopen") command = { ...base, kind: "task.reopen", payload: { taskId, reason: body.reason as string } };
          else if (body.mode === "set_policy") command = { ...base, kind: "task.set_policy", payload: { taskId, policyKind: body.policyKind as "owner_confirmed" | "evidence_satisfied" } };
          else if (body.mode === "supersede") command = { ...base, kind: "task.supersede", payload: { taskId, reason: body.reason as string, ...(body.successorTaskId ? { successorTaskId: body.successorTaskId as string } : {}) } };
          else if (body.mode === "start") command = { ...base, kind: "task.start", payload: { taskId } };
          else throw new AppError("invalid_body");
        }
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: `/projects/${projectId}/tasks/${receipt.task.id}` });
      }
      if (request.method === "GET" && decisionRoute) {
        const state = app.decision(auth.actor, decisionRoute[1]!, decisionRoute[2]!);
        return api ? json(state) : respond(null, 303, { Location: `/projects/${decisionRoute[1]}/topics/${decisionRoute[2]}#owner-decision` });
      }
      if (request.method === "POST" && discussionControl) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const allowed = ["csrf", "requestId", "expectedRevision", "action", "roleId", "back"];
        if (Object.keys(body).some(key => !allowed.includes(key)) || (body.back !== undefined && body.back !== "topic")) throw new AppError("invalid_body");
        const number = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
        const command = { kind: "team.control", requestId: body.requestId, projectId: discussionControl[1], expectedRevision: number(body.expectedRevision),
          payload: { discussionId: discussionControl[2], action: body.action, roleId: body.roleId } } as TeamCommand;
        const receipt = app.execute(auth.actor, command);
        // A team card control returns to the card on its topic page (app.dispatch_allowance/v1).
        const origin = body.back === "topic" ? receipt.discussion?.origin : undefined;
        return api ? json(receipt) : respond(null, 303, { Location: origin ? cardLocation(app.dispatchCard(auth.actor, discussionControl[1]!, origin.proposalId))
          : `/projects/${discussionControl[1]}/team/discussions/${discussionControl[2]}` });
      }
      if (request.method === "POST" && (synthesisRoute || decisionRoute)) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const number = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
        const form = request.headers.get("content-type")?.split(";")[0]?.trim() === "application/x-www-form-urlencoded";
        const data = (value: unknown) => { if (!form) return value; try { return JSON.parse(value as string); } catch { throw new AppError("invalid_body"); } };
        if (synthesisRoute) {
          const allowed = ["csrf", "requestId", "expectedRevision", "limits"];
          if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError("invalid_body");
          const command: DecisionCommand = { kind: "decision.synthesize", requestId: body.requestId as string, projectId: synthesisRoute[1]!,
            expectedRevision: number(body.expectedRevision) as number, payload: { discussionId: synthesisRoute[2]!, limits: data(body.limits) as JobLimits } };
          const receipt = app.execute(auth.actor, command);
          return api ? json(receipt) : respond(null, 303, { Location: `/projects/${synthesisRoute[1]}/team/discussions/${synthesisRoute[2]}#owner-decision` });
        }
        const allowed = ["csrf", "requestId", "expectedRevision", "proposalId", "mode", "optionId", "conclusion", "rationale", ...(body.mode === "supersede" ? ["decisionId"] : [])];
        if (Object.keys(body).some(key => !allowed.includes(key)) || (body.mode !== "accept" && body.mode !== "supersede") || !("optionId" in body)) throw new AppError("invalid_body");
        const optionId = body.optionId === "" || body.optionId === "own" || body.optionId === null ? null : body.optionId;
        const command: DecisionCommand = body.mode === "supersede"
          ? { kind: "decision.supersede", requestId: body.requestId as string, projectId: decisionRoute![1]!, expectedRevision: number(body.expectedRevision) as number,
            payload: { decisionId: body.decisionId as string, proposalId: body.proposalId as string, optionId: optionId as string | null, conclusion: body.conclusion as string, rationale: body.rationale as string } }
          : { kind: "decision.accept", requestId: body.requestId as string, projectId: decisionRoute![1]!, expectedRevision: number(body.expectedRevision) as number,
            payload: { proposalId: body.proposalId as string, optionId: optionId as string | null, conclusion: body.conclusion as string, rationale: body.rationale as string } };
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: `/projects/${decisionRoute![1]}/topics/${decisionRoute![2]}#owner-decision` });
      }
      if (request.method === "POST" && teamAction) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const projectId = teamAction[1] ?? null, action = teamAction[2]!, form = request.headers.get("content-type")?.split(";")[0]?.trim() === "application/x-www-form-urlencoded";
        if ((action === "roles" && projectId !== null) || ((action === "previews" || action === "discussions") && projectId === null)) throw new AppError("not_found", 404);
        const number = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
        const data = (value: unknown) => { if (!form) return value; try { return JSON.parse(value as string); } catch { throw new AppError("invalid_body"); } };
        const allowed = action === "discussions" ? ["csrf", "requestId", "expectedRevision", "topicId", "purpose", "sources", "include", "exclude", "limits"]
          : ["csrf", "requestId", "expectedRevision", "roleId", ...(action === "previews" ? ["topicId", "purpose", "sources", "limits"] : [...(form ? ["provider", "model", "authRoute"] : ["route"]), ...(action === "roles" ? ["name", "kind", "responsibility", "enabled"] : [])])];
        if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError("invalid_body");
        const roleId = form && body.roleId === "" ? null : body.roleId;
        const route = form ? body.provider === "" ? null : { provider: body.provider, model: body.model, authRoute: body.authRoute } : body.route;
        const enabled = form ? body.enabled === "true" ? true : body.enabled === "false" ? false : undefined : body.enabled;
        const command = { kind: action === "roles" ? "role.save" : action === "routes" ? "route.save" : action === "discussions" ? "team.dispatch" : "role.preview",
          requestId: body.requestId, expectedRevision: number(body.expectedRevision), projectId,
          payload: action === "discussions" ? { topicId: body.topicId, purpose: body.purpose, sources: data(body.sources), include: data(body.include ?? (form ? "[]" : [])), exclude: data(body.exclude ?? (form ? "[]" : [])), limits: data(body.limits) }
            : action === "previews" ? { roleId, topicId: body.topicId, purpose: body.purpose, sources: data(body.sources), limits: data(body.limits) }
            : action === "roles" ? { roleId, name: body.name, kind: body.kind, responsibility: body.responsibility, enabled, route } : { roleId, route } } as TeamCommand;
        const receipt = app.execute(auth.actor, command);
        const location = receipt.discussion ? `/projects/${projectId}/team/discussions/${receipt.discussion.id}`
          : receipt.preview ? `/projects/${projectId}/team/previews/${receipt.preview.id}` : projectId ? `/projects/${projectId}/team` : "/settings/team";
        return api ? json(receipt) : respond(null, 303, { Location: location });
      }
      if (request.method === "GET" && deliveryRoute) {
        const state = app.deliveries(auth.actor, deliveryRoute[2]!, after());
        return api ? json(state) : page(() => deliveryPage(state, nav(), auth.csrf, after()));
      }
      if (request.method === "GET" && deliveryIntentRoute) {
        const state = app.delivery(auth.actor, deliveryIntentRoute[2]!, deliveryIntentRoute[3]!);
        return api ? json(state) : page(() => deliveryDetailPage(state, nav(), auth.csrf));
      }
      if (request.method === "GET" && prReportsRoute) {
        const state = app.prReports(auth.actor, prReportsRoute[2]!);
        return api ? json(state) : page(() => prReportsPage(state, nav(), auth.csrf, app.prWebhooks(auth.actor, prReportsRoute[2]!)));
      }
      if (request.method === "GET" && prWebhooksRoute) return json(app.prWebhooks(auth.actor, prWebhooksRoute[1]!));
      if (request.method === "POST" && prWebhookRoute) {
        const body = await payload(request);
        app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision"].includes(key))) throw new AppError("invalid_body");
        const projectId = prWebhookRoute[2]!, monitorId = prWebhookRoute[3]!;
        const receipt = app.execute(auth.actor, { kind: `pr.webhook.${prWebhookRoute[4]}` as WebhookCommandKind, requestId: body.requestId as string, projectId,
          expectedRevision: Number(body.expectedRevision), payload: { monitorId } });
        if (api) return json(receipt);
        // The secret is shown once, in this response only; a delete (or a replayed form) goes back to the list.
        return receipt.secret ? page(() => prWebhookSecretPage({ project: app.prWebhooks(auth.actor, projectId).project, receipt, origin: config.origin }, nav(), auth.csrf))
          : respond(null, 303, { Location: `/projects/${projectId}/pr/reports#webhooks` });
      }
      if (request.method === "GET" && prReportRoute) {
        const state = app.prReport(auth.actor, prReportRoute[2]!, prReportRoute[3]!);
        return api ? json(state) : page(() => prReportPage(state, nav(), auth.csrf));
      }
      if (request.method === "POST" && prReportRoute) {
        const body = await payload(request);
        app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "reason", "findingId"].includes(key))) throw new AppError("invalid_body");
        const findingId = typeof body.findingId === "string" && body.findingId !== "" ? body.findingId : undefined;
        const command = { kind: "pr.report.dismiss" as const, requestId: body.requestId as string, projectId: prReportRoute[2]!, expectedRevision: Number(body.expectedRevision),
          payload: findingId === undefined ? { reportId: prReportRoute[3]!, reason: body.reason as string } : { reportId: prReportRoute[3]!, reason: body.reason as string, findingId } };
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: `/projects/${prReportRoute[2]}/pr/reports/${prReportRoute[3]}` });
      }
      if (request.method === "GET" && prAlertPolicyRoute) {
        const state = app.prAlertPolicy(auth.actor, prAlertPolicyRoute[2]!);
        return api ? json(state) : respond(null, 303, { Location: `/projects/${prAlertPolicyRoute[2]}/pr/reports` });
      }
      if (request.method === "POST" && prAlertPolicyRoute) {
        const body = await payload(request);
        app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const categories = ["correctness", "security", "behavior"];
        const formKeys = ["csrf", "requestId", "expectedRevision", "minimumSeverity", "notifyPartial", ...categories.map(c => `cat_${c}`)];
        const jsonKeys = ["csrf", "requestId", "expectedRevision", "minimumSeverity", "notifyPartial", "allowedCategories"];
        const isJson = Object.hasOwn(body, "allowedCategories");
        if (Object.keys(body).some(key => !(isJson ? jsonKeys : formKeys).includes(key))) throw new AppError("invalid_body");
        const allowedCategories = isJson ? body.allowedCategories : categories.filter(c => body[`cat_${c}`] === "on");
        const notifyPartial = isJson ? body.notifyPartial : body.notifyPartial === "on";
        const command = { kind: "pr.alert_policy.set" as const, requestId: body.requestId as string, projectId: prAlertPolicyRoute[2]!, expectedRevision: Number(body.expectedRevision),
          payload: { allowedCategories: allowedCategories as ("correctness" | "security" | "behavior")[], minimumSeverity: body.minimumSeverity as "info", notifyPartial: notifyPartial as boolean } };
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: `/projects/${prAlertPolicyRoute[2]}/pr/reports` });
      }
      if (request.method === "GET" && schedulesRoute) {
        const state = app.schedules(auth.actor, schedulesRoute[2]!);
        return api ? json(state) : page(() => schedulesPage(state, nav(), auth.csrf,
          app.topics(auth.actor, state.project.id).items, config.jobs.maximum));
      }
      if (request.method === "GET" && scheduleRoute) {
        const state = app.schedule(auth.actor, scheduleRoute[2]!, scheduleRoute[3]!);
        return api ? json(state) : page(() => scheduleDetailPage(state, nav(), auth.csrf));
      }
      if (request.method === "POST" && (deliveryRoute || deliveryResendRoute)) {
        const body = await payload(request);
        app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const number = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
        if (deliveryResendRoute) {
          if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision"].includes(key))) throw new AppError("invalid_body");
          const command: ResendDeliveryCommand = { kind: "delivery.resend", requestId: body.requestId as string, projectId: deliveryResendRoute[2]!, expectedRevision: number(body.expectedRevision) as number, payload: { intentId: deliveryResendRoute[3]! } };
          const receipt = app.execute(auth.actor, command);
          return api ? json(receipt) : respond(null, 303, { Location: `/projects/${deliveryResendRoute[2]}/delivery/${deliveryResendRoute[3]}` });
        }
        if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "kind", "text", "dedupeKey"].includes(key))) throw new AppError("invalid_body");
        const command: CommitDeliveryCommand = { kind: "delivery.commit", requestId: body.requestId as string, projectId: deliveryRoute![2]!, expectedRevision: number(body.expectedRevision) as number, payload: { kind: body.kind as "report", text: body.text as string, dedupeKey: body.dedupeKey as string } };
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: `/projects/${receipt.intent.projectId}/delivery/${receipt.intent.id}` });
      }
      if (request.method === "GET" && jobsRoute) {
        const state = app.jobs(auth.actor, jobsRoute[2]!, after());
        return api ? json(state) : page(() => jobsPage(state, nav(), auth.csrf, after(), config.jobs));
      }
      if (request.method === "GET" && jobRoute) {
        const job = app.job(auth.actor, jobRoute[2]!, jobRoute[3]!);
        return api ? json(job) : page(() => jobsPage({ ...app.jobs(auth.actor, job.projectId), items: [job], hasMore: false, nextAfter: 0 }, nav(), auth.csrf, 0, config.jobs, false));
      }
      if (request.method === "GET" && sourceRoute) {
        const positive = (key: string) => {
          const values = url.searchParams.getAll(key);
          if (values.length !== 1 || !/^[1-9]\d{0,15}$/.test(values[0]!)) throw new AppError("invalid_source_reference");
          return Number(values[0]);
        };
        const source = app.source(auth.actor, sourceRoute[2]!, { sourceId: sourceRoute[3]!, revision: positive("revision"), generation: positive("generation") });
        const suppressed = app.sourceSuppressed(auth.actor, sourceRoute[2]!, { sourceId: sourceRoute[3]!, revision: positive("revision"), generation: positive("generation") });
        return api ? json({ ...source, suppressed }) : page(() => sourcePage(source, suppressed, app.project(auth.actor, source.projectId), nav(), auth.csrf));
      }
      if (request.method === "GET" && topicPanelRoute) {
        // web.settings_ia/v1 right panel: one tab is read per request; the page doubles as the no-script panel.
        const [, projectId, topicId] = topicPanelRoute;
        const tabs = url.searchParams.getAll("tab");
        const tab = (tabs.length === 0 ? defaultPanelTab : tabs.length === 1 && (panelTabs as readonly string[]).includes(tabs[0]!) ? tabs[0] : null) as PanelTab | null;
        if (!tab) throw new AppError("invalid_panel_tab");
        const { project, topic } = app.topic(auth.actor, projectId!, topicId!);
        const data: PanelData = tab === "memory" ? { tab, state: app.memory(auth.actor, project.id) } : tab === "tasks" ? { tab, state: app.topicTasks(auth.actor, project.id, topic.id, panelRows * 3) }
          : tab === "jobs" ? { tab, state: app.recentJobs(auth.actor, project.id, panelRows) } : tab === "pr" ? { tab, state: app.prReports(auth.actor, project.id) } : { tab, state: app.team(auth.actor, project.id) };
        return page(() => topicPanelPage(project, topic, app.topics(auth.actor, project.id).items, data, nav(), auth.csrf));
      }
      if (request.method === "GET" && topicRoute) {
        const state = app.conversation(auth.actor, topicRoute[2]!, topicRoute[3]!, after());
        const replies = app.replies(auth.actor, state.project.id, state.topic.id, state.items.map(item => item.id));
        const promotion = app.promotion(auth.actor, state.project.id, state.topic.id);
        if (api) return json({ ...state, replies: [...replies.values()], promotion });
        const team = app.team(auth.actor, state.project.id);
        const discussions = app.discussions(auth.actor, state.project.id, state.topic.id);
        const cards = app.dispatchCards(auth.actor, state.project.id, state.topic.id, state.items.map(item => item.id));
        const approvals = app.approvalCards(auth.actor, state.project.id).filter(card => card.topicId === state.topic.id);
        return page(() => conversationPage(state, nav(), app.topics(auth.actor, state.project.id).items, auth.csrf, after(), config.messageBytes, {
          team, discussions, limits: config.jobs.maximum, dispatchAvailable: team.previewAvailable, replies, cards,
          synthesisLimits: dispatchLimits(config, 1), promotion,
          decision: app.decision(auth.actor, state.project.id, state.topic.id),
          approvals,
        }));
      }
      if (request.method === "GET" && topicCollection) {
        const state = app.topics(auth.actor, topicCollection[2]!, after());
        return api ? json(state) : page(() => projectPage(state, nav(), auth.csrf, after()));
      }
      if (request.method === "GET" && projectRoute) {
        const project = app.project(auth.actor, projectRoute[2]!);
        return api ? json(project) : page(() => projectPage(app.topics(auth.actor, project.id, after()), nav(), auth.csrf, after()));
      }
      if (request.method === "GET" && ["/", "/api/projects"].includes(url.pathname)) {
        // FR-23: an installation that has not finished setup starts at setup, not at the workspace. The JSON list is unchanged.
        if (!api && !app.setup(auth.actor).complete) return respond(null, 303, { Location: "/setup" });
        const raw = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,7}$/.test(raw)) throw new AppError("invalid_offset");
        const offset = Number(raw);
        const state = app.workspace(auth.actor, offset);
        if (api) return json(state);
        // Chat-first home: the chip defaults to the General space; `?project=<id>` preselects another project.
        const general = app.generalSpace(auth.actor), selected = url.searchParams.get("project");
        const generalProject = general ? app.project(auth.actor, general.projectId) : null;
        const ids = [...new Set([...generalProject ? [generalProject.id] : [], ...state.projects.map(p => p.id)])].slice(0, 50);
        const attention = app.attention(auth.actor, ids);
        const known = new Map([...generalProject ? [generalProject] : [], ...state.projects].map(p => [p.id, p]));
        const waiting = ids.map(id => ({ project: known.get(id)!, attention: attention[id]! }))
          .filter(item => item.attention.proposals + item.attention.reviews + item.attention.resumes > 0);
        return page(() => workspacePage(nav(state), auth.csrf, offset, config.pageSize, {
          addressAs: app.persona(auth.actor).addressAs, general: generalProject ? { id: generalProject.id, name: generalProject.name } : null,
          selected: selected && /^[a-f0-9-]{36}$/.test(selected) ? selected : null, messageBytes: config.messageBytes, waiting,
        }));
      }
      if (request.method === "POST" && (["/projects", "/api/projects", "/logout"].includes(url.pathname) || backupsRoute || upgradesRoute || upgradeRoute || restoresRoute || restoreRoute || topicCollection || messageRoute || jobsRoute || resumeRoute || schedulesRoute || scheduleAction)) {
        const body = await payload(request);
        app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (backupsRoute) {
          if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision", "note"].includes(key))) throw new AppError("invalid_body");
          const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision) ? Number(body.expectedRevision) : body.expectedRevision;
          const command = { kind: "backup.create" as const, requestId: body.requestId as string, projectId: null,
            expectedRevision: revision as number, payload: { note: (body.note as string) ?? "manual backup" } };
          const receipt = await app.execute(auth.actor, command);
          return api ? json(receipt) : respond(null, 303, { Location: `/settings/backups/${receipt.manifest.id}` });
        }
        if (schedulesRoute || scheduleAction) {
          const number = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
          const form = request.headers.get("content-type")?.split(";")[0]?.trim() === "application/x-www-form-urlencoded";
          const data = (value: unknown) => { if (!form) return value; try { return JSON.parse(value as string); } catch { throw new AppError("invalid_body"); } };
          const projectId = (schedulesRoute ?? scheduleAction)![2]!;
          const enabled = (value: unknown) => value === "true" ? true : value === "false" ? false : value;
          let command: ScheduleCommand;
          if (schedulesRoute) {
            const allowed = ["csrf", "requestId", "expectedRevision", "topicId", "kind", "purpose", "timezone", "recurrence", "enabled", "route", "limits", "occurrenceBudget", "misfire", "text"];
            if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError("invalid_body");
            command = { kind: "schedule.create", requestId: body.requestId as string, projectId, expectedRevision: number(body.expectedRevision) as number,
              payload: { topicId: body.topicId as string, kind: body.kind as "reminder" | "summary", purpose: body.purpose as string,
                timezone: body.timezone as string, recurrence: data(body.recurrence) as ScheduleRecurrence,
                enabled: enabled(body.enabled) as boolean, route: data(body.route) as RoleRoute | null, limits: data(body.limits) as JobLimits,
                occurrenceBudget: number(body.occurrenceBudget) as number, misfire: body.misfire as "coalesce", text: body.text as string } } as ScheduleCommand;
          } else {
            const action = scheduleAction![4]!, scheduleId = scheduleAction![3]!;
            const expectedRevision = number(body.expectedRevision) as number, requestId = body.requestId as string;
            if (action === "pause" || action === "resume" || action === "revoke") {
              if (Object.keys(body).some(key => !["csrf", "requestId", "expectedRevision"].includes(key))) throw new AppError("invalid_body");
              command = { kind: `schedule.${action}`, requestId, projectId, expectedRevision, payload: { scheduleId } } as ScheduleCommand;
            } else {
              const allowed = ["csrf", "requestId", "expectedRevision", "purpose", "timezone", "recurrence", "enabled", "route", "limits", "occurrenceBudget", "text"];
              if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError("invalid_body");
              command = { kind: "schedule.edit", requestId, projectId, expectedRevision,
                payload: { scheduleId, purpose: body.purpose as string, timezone: body.timezone as string,
                  recurrence: data(body.recurrence) as ScheduleRecurrence, enabled: enabled(body.enabled) as boolean,
                  route: data(body.route) as RoleRoute | null, limits: data(body.limits) as JobLimits,
                  occurrenceBudget: number(body.occurrenceBudget) as number, text: body.text as string } } as ScheduleCommand;
            }
          }
          const receipt = app.execute(auth.actor, command);
          return api ? json(receipt) : respond(null, 303, { Location: `/projects/${projectId}/schedules/${receipt.schedule.id}` });
        }
        if (url.pathname === "/logout") {
          app.logout(auth.actor);
          return respond(null, 303, { "Location": "/login", "Set-Cookie": cookie("", 0) });
        }
        if (jobsRoute || resumeRoute) {
          const keys = resumeRoute ? ["csrf", "requestId", "expectedRevision"] : ["csrf", "requestId", "expectedRevision", "type", "configurationRevision", "policyRevision", "purpose", "inputRevision", "input", "priority", "limits"];
          if (Object.keys(body).some(key => !keys.includes(key))) throw new AppError("invalid_body");
          const number = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
          const form = request.headers.get("content-type")?.split(";")[0]?.trim() === "application/x-www-form-urlencoded";
          const data = (value: unknown) => { if (!form) return value; try { return JSON.parse(value as string); } catch { throw new AppError("invalid_body"); } };
          const command = resumeRoute ? { kind: resumeRoute[4] === "stop" ? "job.stop" : "job.resume", requestId: body.requestId, projectId: resumeRoute[2], expectedRevision: number(body.expectedRevision), payload: { jobId: resumeRoute[3] } } as ResumeJobCommand | StopJobCommand
            : { kind: "job.enqueue", requestId: body.requestId, projectId: jobsRoute![2], expectedRevision: number(body.expectedRevision), payload: {
              type: body.type, configurationRevision: number(body.configurationRevision), policyRevision: number(body.policyRevision), purpose: body.purpose, inputRevision: number(body.inputRevision), input: data(body.input), priority: body.priority, limits: data(body.limits),
            } } as EnqueueJobCommand;
          const receipt = app.execute(auth.actor, command);
          return api ? json(receipt) : respond(null, 303, { Location: `/projects/${receipt.job.projectId}/jobs/${receipt.job.id}#job-${receipt.job.id}` });
        }
        if (topicCollection || messageRoute) {
          // app.routing_selection/v1: a reply to one specialist's opinion names its participation (both fields or neither).
          const allowed = ["csrf", "requestId", "expectedRevision", ...topicCollection ? ["title"] : ["text", "replyDiscussion", "replyRole"]];
          if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError("invalid_body");
          const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision)
            ? Number(body.expectedRevision) : body.expectedRevision;
          if (topicCollection) {
            const command: CreateTopicCommand = { kind: "topic.create", projectId: topicCollection[2]!, requestId: body.requestId as string,
              expectedRevision: revision as number, payload: { title: body.title as string } };
            const receipt = app.execute(auth.actor, command);
            return api ? json(receipt) : respond(null, 303, { "Location": `/projects/${receipt.topic.projectId}/topics/${receipt.topic.id}` });
          }
          if ((body.replyDiscussion === undefined) !== (body.replyRole === undefined)) throw new AppError("invalid_body");
          const command: SendMessageCommand = { kind: "message.send", projectId: messageRoute![2]!, requestId: body.requestId as string,
            expectedRevision: revision as number, payload: { topicId: messageRoute![3]!, text: body.text as string,
              ...body.replyDiscussion !== undefined ? { replyTo: { discussionId: body.replyDiscussion as string, roleId: body.replyRole as string } } : {} } };
          const receipt = app.execute(auth.actor, command);
          return api ? json(receipt) : respond(null, 303, { "Location": `/projects/${receipt.message.projectId}/topics/${receipt.message.topicId}?after=${Math.max(0, receipt.message.sequence - config.pageSize)}#message-${receipt.message.id}` });
        }
        if (Object.keys(body).some(key => !["csrf", "requestId", "name", "expectedRevision"].includes(key))) throw new AppError("invalid_body");
        const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision)
          ? Number(body.expectedRevision) : body.expectedRevision;
        const command: CreateProjectCommand = { kind: "project.create", projectId: null,
          requestId: body.requestId as string, expectedRevision: revision as number, payload: { name: body.name as string } };
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { "Location": "/" });
      }
      throw new AppError("not_found", 404);
    } catch (error) {
      const rejection = error instanceof AppError ? error : new AppError("storage_unavailable", 503);
      if (!api && rejection.code === "authentication_required") return respond(null, 303, { "Location": "/login" });
      // Until an activated restore completes, every ordinary page leads to the restore console.
      if (!api && rejection.code === "restore_incomplete" && request.method === "GET") return respond(null, 303, { "Location": "/settings/restores" });
      const detail = rejection.detail;
      const recovery = detail && typeof detail.projectId === "string" && /^[a-f0-9-]{36}$/.test(detail.projectId) && typeof detail.path === "string" && detail.path.startsWith(`/projects/${detail.projectId}/`)
        ? { href: detail.path, proposal: typeof detail.taskId === "string", topic: rejection.code === "topic_promoted" } : undefined;
      // Error text comes only from the dictionaries, keyed by the fixed error code; unknown codes get the generic message.
      return api ? json({ error: rejection.code, ...(detail ? { detail } : {}) }, rejection.status) : page(() => errorPage(trMaybe(`error.${rejection.code}`) ?? tr("error.default"),
        recovery && { href: recovery.href, label: tr(recovery.proposal ? "error.recovery_open_proposal" : recovery.topic ? "error.recovery_open_topic" : "error.recovery_open_list") }), rejection.status);
    }
  };
}
