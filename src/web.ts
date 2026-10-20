import { Application, type CreateProjectCommand } from "./application";
import { AppError } from "./errors";
import type { CreateTopicCommand, SendMessageCommand } from "./conversation";
import { workspacePage, projectPage, conversationPage, sourcePage, jobsPage, teamPage, previewPage, discussionPage, deliveryPage, deliveryDetailPage, loginPage, errorPage } from "./web-layout";
import type { CommitDeliveryCommand, ResendDeliveryCommand } from "./delivery";
import type { EnqueueJobCommand, ResumeJobCommand, StopJobCommand } from "./jobs/types";
import type { TeamCommand } from "./team/types";
import { styleSheet } from "./web-style";

const messages: Record<string, string> = {
  authentication_required: "กรุณาเข้าสู่ระบบ", login_failed: "เข้าสู่ระบบไม่สำเร็จ กรุณาตรวจรหัสผ่าน",
  login_limited_try_later: "ลองเข้าสู่ระบบหลายครั้งแล้ว กรุณารอแล้วลองใหม่",
  owner_setup_required: "ต้องตั้ง owner จากเครื่องที่ติดตั้งก่อนเปิดใช้งาน",
  stale_revision: "ข้อมูลโครงการเปลี่ยนแล้ว เปิดหน้าโครงการใหม่ก่อนลองอีกครั้ง",
  request_id_conflict: "คำสั่งนี้เคยส่งด้วยข้อมูลอื่นแล้ว กรุณาเปิดหน้าโครงการใหม่",
  csrf_rejected: "ยืนยันคำสั่งไม่สำเร็จ กรุณาเปิดหน้าโครงการใหม่",
  origin_rejected: "ไม่อนุญาตคำสั่งจากที่อยู่นี้", request_too_large: "คำสั่งมีขนาดใหญ่เกินกำหนด",
  storage_unavailable: "ยังบันทึกข้อมูลไม่สำเร็จ กรุณาลองใหม่ภายหลัง",
  topic_not_found: "ไม่พบหัวข้อในโครงการที่เลือก", project_not_found: "ไม่พบโครงการที่เลือก",
  text_too_large_or_invalid: "ข้อความยาวเกินกำหนดหรือมีอักขระที่ไม่รองรับ", empty_text: "กรุณาใส่ข้อความก่อนบันทึก",
  scheduler_unavailable: "คิวยังไม่พร้อมรับงานใหม่ ดูงานเดิมได้แล้วลองใหม่ภายหลัง",
  job_queue_full: "คิวงานเต็มแล้ว รอให้งานเดิมเสร็จก่อนเริ่มงานใหม่",
  job_not_found: "ไม่พบงานในโครงการที่เลือก", invalid_job_input: "ข้อมูลสำหรับงานนี้เปลี่ยนแล้ว เปิดหน้าโครงการใหม่ก่อนลองอีกครั้ง",
  job_configuration_changed: "การตั้งค่างานเปลี่ยนแล้ว กรุณาตรวจแล้วเริ่มงานใหม่", job_budget_exhausted: "งบหรือเวลาของงานครบแล้ว กรุณาตรวจแล้วเริ่มงานใหม่",
  role_not_found: "ไม่พบบทบาทที่เลือก", role_preview_blocked: "เปิดใช้บทบาทและกำหนด route ก่อนเริ่มตัวอย่างจำลอง",
  invalid_role_route: "ตรวจ model ID และชื่ออ้างอิงการเชื่อมต่อ อย่าใส่ข้อมูลลับ", role_limit: "จำนวนบทบาทครบขีดจำกัดของบริการแล้ว",
  preview_source_unavailable: "แหล่งข้อมูลเปลี่ยนหรือไม่พร้อมใช้งาน กรุณาเลือกใหม่", preview_not_found: "ไม่พบตัวอย่างในโครงการนี้",
  discussion_not_found: "ไม่พบการหารือในโครงการนี้", unknown_role: "ไม่พบบทบาทที่ระบุ", role_dispatch_blocked: "เปิดใช้บทบาท specialist และกำหนด route ก่อนเรียกทีม",
  dispatch_source_unavailable: "แหล่งข้อมูลเปลี่ยนหรือไม่พร้อมใช้งาน กรุณาเลือกใหม่", invalid_router_output: "ผลเลือกทีมไม่ถูกต้อง จึงยังไม่เริ่มวิเคราะห์",
  role_already_participating: "บทบาทนี้อยู่ในการหารือแล้ว", role_budget_exhausted: "จำนวนบทบาทครบขีดจำกัดของการหารือนี้แล้ว",
  participation_not_found: "ไม่พบบทบาทนี้ในการหารือ", run_not_found: "ไม่พบผลการวิเคราะห์ที่เลือก",
  delivery_not_found: "ไม่พบรายการแจ้งเตือนในโครงการที่เลือก",
  delivery_dedupe_conflict: "รายการนี้เคยบันทึกด้วยข้อความอื่นแล้ว",
  delivery_not_resendable: "สถานะนี้ยังส่งซ้ำไม่ได้",
  delivery_report_not_found: "ไม่พบรายงานของการแจ้งเตือนนี้",
  delivery_report_not_current: "รายงานนี้ถูกแทนที่หรือลบแล้ว",
  invalid_delivery_payload: "ข้อความมีข้อมูลที่ไม่ควรส่ง",
  delivery_worker_unavailable: "ตัวส่งยังไม่พร้อม",
  authorization_changed: "สิทธิ์ที่ใช้บันทึกคำขอเปลี่ยนแล้ว",
};

/** Creates a server-rendered owner workspace; all mutations use the shared application boundary. */
export function createWebHandler(app: Application): (request: Request) => Promise<Response> {
  const { config } = app;
  const expectedHost = new URL(config.origin).host;
  const secure = config.origin.startsWith("https:");
  const cookieName = secure ? "__Host-jit_session" : "jit_session";
  const cookie = (value: string, maxAge: number) => `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
  const headers = {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
    try {
      if (url.host !== expectedHost || (request.headers.has("host") && request.headers.get("host") !== expectedHost)) {
        throw new AppError("origin_rejected", 403);
      }
      if (Buffer.byteLength(url.pathname + url.search) > config.queryBytes) throw new AppError("request_too_large", 414);
      if (request.method !== "GET" && request.method !== "POST") throw new AppError("method_not_allowed", 405);
      if (request.method === "POST" && (request.headers.get("origin") !== config.origin ||
          request.headers.get("sec-fetch-site") === "cross-site")) throw new AppError("origin_rejected", 403);
      if (request.method === "GET" && url.pathname === "/assets/app.css") return respond(styleSheet, 200, { "Content-Type": "text/css" });
      if (request.method === "GET" && url.pathname === "/login") {
        return respond(loginPage());
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
      const projectRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})$/.exec(url.pathname);
      const topicCollection = /^\/(api\/)?projects\/([a-f0-9-]{36})\/topics$/.exec(url.pathname);
      const topicRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/topics\/([a-f0-9-]{36})$/.exec(url.pathname);
      const messageRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/topics\/([a-f0-9-]{36})\/messages$/.exec(url.pathname);
      const sourceRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/sources\/([a-f0-9-]{36})$/.exec(url.pathname);
      const deliveryRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/delivery$/.exec(url.pathname);
      const deliveryIntentRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/delivery\/([a-f0-9-]{36})$/.exec(url.pathname);
      const deliveryResendRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/delivery\/([a-f0-9-]{36})\/resend$/.exec(url.pathname);
      const jobsRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/jobs$/.exec(url.pathname);
      const jobRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/jobs\/([a-f0-9-]{36})$/.exec(url.pathname);
      const resumeRoute = /^\/(api\/)?projects\/([a-f0-9-]{36})\/jobs\/([a-f0-9-]{36})\/(resume|stop)$/.exec(url.pathname);
      const teamRoute = /^\/(?:api\/)?(?:projects\/([a-f0-9-]{36})\/)?team$/.exec(url.pathname);
      const teamAction = /^\/(?:api\/)?(?:projects\/([a-f0-9-]{36})\/)?team\/(roles|routes|previews|discussions)$/.exec(url.pathname);
      const previewRoute = /^\/(?:api\/)?projects\/([a-f0-9-]{36})\/team\/previews\/([a-f0-9-]{36})$/.exec(url.pathname);
      const discussionRoute = /^\/(?:api\/)?projects\/([a-f0-9-]{36})\/team\/discussions\/([a-f0-9-]{36})$/.exec(url.pathname);
      const discussionControl = /^\/(?:api\/)?projects\/([a-f0-9-]{36})\/team\/discussions\/([a-f0-9-]{36})\/controls$/.exec(url.pathname);
      const after = () => {
        const raw = url.searchParams.get("after") ?? "0";
        if (!/^\d{1,16}$/.test(raw)) throw new AppError("invalid_cursor");
        return Number(raw);
      };
      if (request.method === "GET" && teamRoute) {
        const state = app.team(auth.actor, teamRoute[1] ?? null);
        return api ? json(state) : respond(teamPage(state, app.workspace(auth.actor), auth.csrf, config.jobs.maximum, url.searchParams.get("preset") ?? undefined));
      }
      if (request.method === "GET" && previewRoute) {
        const state = app.preview(auth.actor, previewRoute[1]!, previewRoute[2]!);
        return api ? json(state) : respond(previewPage(state, app.workspace(auth.actor), auth.csrf));
      }
      if (request.method === "GET" && discussionRoute) {
        const state = app.discussion(auth.actor, discussionRoute[1]!, discussionRoute[2]!);
        return api ? json(state) : respond(discussionPage(state, app.workspace(auth.actor), auth.csrf));
      }
      if (request.method === "POST" && discussionControl) {
        const body = await payload(request); app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        const allowed = ["csrf", "requestId", "expectedRevision", "action", "roleId"];
        if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError("invalid_body");
        const number = (value: unknown) => typeof value === "string" && /^\d{1,15}$/.test(value) ? Number(value) : value;
        const command = { kind: "team.control", requestId: body.requestId, projectId: discussionControl[1], expectedRevision: number(body.expectedRevision),
          payload: { discussionId: discussionControl[2], action: body.action, roleId: body.roleId } } as TeamCommand;
        const receipt = app.execute(auth.actor, command);
        return api ? json(receipt) : respond(null, 303, { Location: `/projects/${discussionControl[1]}/team/discussions/${discussionControl[2]}` });
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
          : receipt.preview ? `/projects/${projectId}/team/previews/${receipt.preview.id}` : projectId ? `/projects/${projectId}/team` : "/team";
        return api ? json(receipt) : respond(null, 303, { Location: location });
      }
      if (request.method === "GET" && deliveryRoute) {
        const state = app.deliveries(auth.actor, deliveryRoute[2]!, after());
        return api ? json(state) : respond(deliveryPage(state, app.workspace(auth.actor), auth.csrf, after()));
      }
      if (request.method === "GET" && deliveryIntentRoute) {
        const state = app.delivery(auth.actor, deliveryIntentRoute[2]!, deliveryIntentRoute[3]!);
        return api ? json(state) : respond(deliveryDetailPage(state, app.workspace(auth.actor), auth.csrf));
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
        return api ? json(state) : respond(jobsPage(state, app.workspace(auth.actor), auth.csrf, after(), config.jobs));
      }
      if (request.method === "GET" && jobRoute) {
        const job = app.job(auth.actor, jobRoute[2]!, jobRoute[3]!);
        return api ? json(job) : respond(jobsPage({ ...app.jobs(auth.actor, job.projectId), items: [job], hasMore: false, nextAfter: 0 }, app.workspace(auth.actor), auth.csrf, 0, config.jobs, false));
      }
      if (request.method === "GET" && sourceRoute) {
        const positive = (key: string) => {
          const values = url.searchParams.getAll(key);
          if (values.length !== 1 || !/^[1-9]\d{0,15}$/.test(values[0]!)) throw new AppError("invalid_source_reference");
          return Number(values[0]);
        };
        const source = app.source(auth.actor, sourceRoute[2]!, { sourceId: sourceRoute[3]!, revision: positive("revision"), generation: positive("generation") });
        return api ? json(source) : respond(sourcePage(source, app.project(auth.actor, source.projectId), app.workspace(auth.actor), auth.csrf));
      }
      if (request.method === "GET" && topicRoute) {
        const state = app.conversation(auth.actor, topicRoute[2]!, topicRoute[3]!, after());
        if (api) return json(state);
        const team = app.team(auth.actor, state.project.id);
        const discussions = app.discussions(auth.actor, state.project.id, state.topic.id);
        return respond(conversationPage(state, app.workspace(auth.actor), app.topics(auth.actor, state.project.id).items, auth.csrf, after(), config.messageBytes, {
          team, discussions, limits: config.jobs.maximum, dispatchAvailable: team.previewAvailable,
        }));
      }
      if (request.method === "GET" && topicCollection) {
        const state = app.topics(auth.actor, topicCollection[2]!, after());
        return api ? json(state) : respond(projectPage(state, app.workspace(auth.actor), auth.csrf, after()));
      }
      if (request.method === "GET" && projectRoute) {
        const project = app.project(auth.actor, projectRoute[2]!);
        return api ? json(project) : respond(projectPage(app.topics(auth.actor, project.id, after()), app.workspace(auth.actor), auth.csrf, after()));
      }
      if (request.method === "GET" && ["/", "/api/projects"].includes(url.pathname)) {
        const raw = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,7}$/.test(raw)) throw new AppError("invalid_offset");
        const offset = Number(raw);
        const state = app.workspace(auth.actor, offset);
        return api ? json(state) : respond(workspacePage(state, auth.csrf, offset, config.pageSize));
      }
      if (request.method === "POST" && (["/projects", "/api/projects", "/logout"].includes(url.pathname) || topicCollection || messageRoute || jobsRoute || resumeRoute)) {
        const body = await payload(request);
        app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
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
          const allowed = ["csrf", "requestId", "expectedRevision", topicCollection ? "title" : "text"];
          if (Object.keys(body).some(key => !allowed.includes(key))) throw new AppError("invalid_body");
          const revision = typeof body.expectedRevision === "string" && /^\d{1,15}$/.test(body.expectedRevision)
            ? Number(body.expectedRevision) : body.expectedRevision;
          if (topicCollection) {
            const command: CreateTopicCommand = { kind: "topic.create", projectId: topicCollection[2]!, requestId: body.requestId as string,
              expectedRevision: revision as number, payload: { title: body.title as string } };
            const receipt = app.execute(auth.actor, command);
            return api ? json(receipt) : respond(null, 303, { "Location": `/projects/${receipt.topic.projectId}/topics/${receipt.topic.id}` });
          }
          const command: SendMessageCommand = { kind: "message.send", projectId: messageRoute![2]!, requestId: body.requestId as string,
            expectedRevision: revision as number, payload: { topicId: messageRoute![3]!, text: body.text as string } };
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
      const text = messages[rejection.code] ?? "คำสั่งไม่ถูกต้อง กรุณาลองใหม่";
      return api ? json({ error: rejection.code }, rejection.status) : respond(errorPage(text), rejection.status);
    }
  };
}
