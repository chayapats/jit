import { Application, type CreateProjectCommand, type Workspace } from "./application";
import { AppError } from "./errors";
import type { CreateTopicCommand, SendMessageCommand } from "./conversation";
import type { Attribution, SourceLookup, SourceReference } from "./sources";

const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

const css = `:root{color-scheme:light dark;font-family:system-ui,sans-serif}body{margin:0;background:#111820;color:#eef3f6}
main{max-width:860px;margin:5vh auto;padding:24px}header{display:flex;justify-content:space-between;align-items:center;gap:20px}
h1{font-size:2rem;margin:8px 0}p{color:#b4c2ce;line-height:1.6}a{color:#9bd9c7}label{display:block;margin:18px 0 8px}
input,button{font:inherit;padding:12px;border-radius:8px;border:1px solid #516576}input{width:min(90%,430px);background:#17222c;color:inherit}
button{cursor:pointer;background:#99dbc6;color:#11271f;font-weight:600}form{margin:20px 0}ul{padding:0;list-style:none}
li{border:1px solid #354b5d;border-radius:12px;padding:20px;margin:14px 0}small{color:#a6b9c9;overflow-wrap:anywhere}
.row{display:flex;gap:12px;align-items:end;flex-wrap:wrap}.row>div{flex:1;min-width:200px}.quiet{background:transparent;color:#dce9ef}
.error{border-left:3px solid #e4ad81;padding:12px}footer{margin-top:36px;font-size:.85rem;color:#a6b9c9}`;
const conversationCss = `textarea{font:inherit;width:100%;min-height:140px;box-sizing:border-box;padding:12px;border-radius:8px;background:#17222c;color:inherit;border:1px solid #516576}
article{border:1px solid #354b5d;border-radius:12px;padding:20px;margin:16px 0}pre{padding:16px;background:#091118;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:8px}
.literal{white-space:pre-wrap;overflow-wrap:anywhere;color:inherit}dt{color:#a6b9c9;margin-top:12px}dd{margin:4px 0;overflow-wrap:anywhere}`;

function page(title: string, body: string): string {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${escape(title)} · Jit</title><link rel="stylesheet" href="/assets/app.css"></head><body><main>${body}
    <footer>Jit · พื้นที่โครงการส่วนตัว</footer></main></body></html>`;
}

function sourceUrl(projectId: string, ref: SourceReference): string {
  return `/projects/${projectId}/sources/${ref.sourceId}?revision=${ref.revision}&generation=${ref.generation}`;
}
function attributionLabel(attribution: Attribution): string {
  return attribution.kind === "owner" ? "คุณ (owner)" : attribution.kind === "participant"
    ? `ผู้ร่วมทีม ${attribution.participantId} · run ${attribution.runId}` : "บริการทะเบียนแหล่งข้อมูล";
}
function timestamp(time: number): string {
  const date = new Date(time);
  return Number.isNaN(date.valueOf()) ? "ไม่ทราบเวลา" : date.toISOString();
}
function literalContent(text: string): string {
  // Only fenced code presentation is recognized. All text, including HTML and URLs, stays escaped data.
  const blocks: string[] = [], buffer: string[] = [];
  let code = false;
  const flush = () => { if (buffer.length) blocks.push(code ? `<pre><code>${escape(buffer.join("\n"))}</code></pre>` : `<p class="literal">${escape(buffer.join("\n"))}</p>`); buffer.length = 0; };
  for (const line of text.split("\n")) {
    if ((!code && /^```[a-zA-Z0-9_+-]{0,24}\s*$/.test(line)) || (code && /^```\s*$/.test(line))) { flush(); code = !code; }
    else buffer.push(line);
  }
  flush();
  return blocks.join("");
}
function projectPage(state: ReturnType<Application["topics"]>, csrf: string, after: number): string {
  const p = state.project;
  return page(p.name, `<a href="/">← โครงการทั้งหมด</a><h1>${escape(p.name)}</h1>
    <section data-group-id="${escape(p.groupId)}"><h2>หัวข้อในกลุ่มโครงการ</h2>
    <form method="post" action="/projects/${p.id}/topics"><input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="requestId" value="${crypto.randomUUID()}"><input type="hidden" name="expectedRevision" value="${p.revision}">
      <label for="title">ชื่อหัวข้อ</label><div class="row"><input id="title" name="title" maxlength="200" required><button>สร้างหัวข้อ</button></div></form>
    ${state.items.length ? `<ul>${state.items.map(t => `<li><h3><a href="/projects/${p.id}/topics/${t.id}">${escape(t.title ?? "หัวข้อไม่พร้อมใช้งาน")}</a></h3>
      <small>${escape(timestamp(t.createdAt))} · ${escape(attributionLabel(t.attribution))}</small> · <a href="${sourceUrl(p.id, t.source)}">ที่มาของหัวข้อ</a></li>`).join("")}</ul>` : "<p>ยังไม่มีหัวข้อในหน้านี้</p>"}
    <nav>${after > 0 ? `<a href="/projects/${p.id}">หน้าแรก</a> · ` : ""}${state.hasMore ? `<a href="/projects/${p.id}?after=${state.nextAfter}">หัวข้อถัดไป</a>` : ""}</nav></section>`);
}
function conversationPage(state: ReturnType<Application["conversation"]>, csrf: string, after: number, messageBytes: number): string {
  const { project, topic } = state;
  const base = `/projects/${project.id}/topics/${topic.id}`;
  return page(topic.title ?? "หัวข้อไม่พร้อมใช้งาน", `<a href="/projects/${project.id}">← ${escape(project.name)}</a>
    <h1>${escape(topic.title ?? "หัวข้อไม่พร้อมใช้งาน")}</h1><p>บันทึกข้อความไว้คุยต่อในหัวข้อนี้ · <a href="${sourceUrl(project.id, topic.source)}">ที่มาของหัวข้อ</a></p>
    <section aria-label="ประวัติข้อความ">${state.items.length ? state.items.map(m => `<article data-message-id="${m.id}">
      <small>${escape(attributionLabel(m.attribution))} · ${escape(timestamp(m.committedAt))} · บันทึกแล้ว</small>
      ${m.text === null ? "<p>ต้นฉบับไม่พร้อมใช้งาน</p>" : literalContent(m.text)}
      <a href="${sourceUrl(project.id, m.source)}">ที่มาของข้อความ</a></article>`).join("") : "<p>ยังไม่มีข้อความในหน้านี้</p>"}</section>
    <nav>${after > 0 ? `<a href="${base}">หน้าแรก</a> · ` : ""}${state.hasMore ? `<a href="${base}?after=${state.nextAfter}">ข้อความถัดไป</a>` : ""}</nav>
    <form method="post" action="${base}/messages"><input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="requestId" value="${crypto.randomUUID()}"><input type="hidden" name="expectedRevision" value="${topic.revision}">
      <label for="text">ข้อความของคุณ</label><textarea id="text" name="text" maxlength="${messageBytes}" required></textarea>
      <p><button>บันทึกข้อความ</button></p></form>`);
}
function sourcePage(source: SourceLookup): string {
  return page("ที่มาข้อมูล", `<a href="/projects/${source.projectId}">← กลุ่มโครงการ</a><h1>ที่มาข้อมูล</h1>
    <dl><dt>โครงการ</dt><dd>${escape(source.projectId)}</dd><dt>Source ID</dt><dd>${escape(source.reference.sourceId)}</dd>
    <dt>Revision / generation</dt><dd>${source.reference.revision} / ${source.reference.generation}</dd></dl>
    ${source.state === "available" ? `<p>บันทึกแล้ว · ${escape(attributionLabel(source.attribution))} · ${escape(timestamp(source.committedAt))}</p>
      ${literalContent(source.text)}` : `<p class="error">ต้นฉบับไม่พร้อมใช้งาน (${escape(source.reason)})</p>
      ${source.descriptor ? `<pre>${escape(JSON.stringify(source.descriptor, null, 2))}</pre>` : ""}`}`);
}

function workspacePage(state: Workspace, csrf: string, offset: number, pageSize: number): string {
  return page("โครงการ", `<header><div><small>JIT / WORKSPACE</small><h1>โครงการของคุณ</h1></div>
    <form method="post" action="/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="quiet">ออกจากระบบ</button></form></header>
    <p>เริ่มพื้นที่สนทนาสำหรับแต่ละโครงการ แล้วกลับมาดูต่อได้ภายหลัง</p>
    <form method="post" action="/projects"><input type="hidden" name="csrf" value="${csrf}">
      <input type="hidden" name="requestId" value="${crypto.randomUUID()}">
      <input type="hidden" name="expectedRevision" value="${state.revision}">
      <div class="row"><div><label for="name">ชื่อโครงการ</label><input id="name" name="name" maxlength="200" required autocomplete="off"></div>
      <button>สร้างโครงการ</button></div></form>
    ${state.projects.length ? `<ul>${state.projects.map(p => `<li><h2><a href="/projects/${escape(p.id)}">${escape(p.name)}</a></h2><p>เปิดกลุ่มโครงการ</p></li>`).join("")}</ul>` : "<p>ยังไม่มีโครงการ สร้างโครงการแรกได้ด้านบน</p>"}
    <nav>${offset > 0 ? `<a href="/?offset=${Math.max(0, offset - pageSize)}">ก่อนหน้า</a> ` : ""}
    ${state.hasMore ? `<a href="/?offset=${offset + pageSize}">ถัดไป</a>` : ""}</nav>`);
}

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
      if (request.method === "GET" && url.pathname === "/assets/app.css") return respond(css + conversationCss, 200, { "Content-Type": "text/css" });
      if (request.method === "GET" && url.pathname === "/login") {
        return respond(page("เข้าสู่ระบบ", `<small>JIT / OWNER</small><h1>กลับมาทำงานต่อ</h1><p>เข้าสู่พื้นที่โครงการของคุณ</p>
          <form method="post" action="/login"><label for="password">รหัสผ่าน owner</label>
          <input id="password" name="password" type="password" maxlength="256" required autocomplete="current-password"><p><button>เข้าสู่ระบบ</button></p></form>`));
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
      const after = () => {
        const raw = url.searchParams.get("after") ?? "0";
        if (!/^\d{1,16}$/.test(raw)) throw new AppError("invalid_cursor");
        return Number(raw);
      };
      if (request.method === "GET" && sourceRoute) {
        const positive = (key: string) => {
          const values = url.searchParams.getAll(key);
          if (values.length !== 1 || !/^[1-9]\d{0,15}$/.test(values[0]!)) throw new AppError("invalid_source_reference");
          return Number(values[0]);
        };
        const source = app.source(auth.actor, sourceRoute[2]!, { sourceId: sourceRoute[3]!, revision: positive("revision"), generation: positive("generation") });
        return api ? json(source) : respond(sourcePage(source));
      }
      if (request.method === "GET" && topicRoute) {
        const state = app.conversation(auth.actor, topicRoute[2]!, topicRoute[3]!, after());
        return api ? json(state) : respond(conversationPage(state, auth.csrf, after(), config.messageBytes));
      }
      if (request.method === "GET" && topicCollection) {
        const state = app.topics(auth.actor, topicCollection[2]!, after());
        return api ? json(state) : respond(projectPage(state, auth.csrf, after()));
      }
      if (request.method === "GET" && projectRoute) {
        const project = app.project(auth.actor, projectRoute[2]!);
        return api ? json(project) : respond(projectPage(app.topics(auth.actor, project.id, after()), auth.csrf, after()));
      }
      if (request.method === "GET" && ["/", "/api/projects"].includes(url.pathname)) {
        const raw = url.searchParams.get("offset") ?? "0";
        if (!/^\d{1,7}$/.test(raw)) throw new AppError("invalid_offset");
        const offset = Number(raw);
        const state = app.workspace(auth.actor, offset);
        return api ? json(state) : respond(workspacePage(state, auth.csrf, offset, config.pageSize));
      }
      if (request.method === "POST" && (["/projects", "/api/projects", "/logout"].includes(url.pathname) || topicCollection || messageRoute)) {
        const body = await payload(request);
        app.verifyCsrf(auth.csrf, request.headers.get("x-csrf-token") ?? body.csrf);
        if (url.pathname === "/logout") {
          app.logout(auth.actor);
          return respond(null, 303, { "Location": "/login", "Set-Cookie": cookie("", 0) });
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
          return api ? json(receipt) : respond(null, 303, { "Location": `/projects/${receipt.message.projectId}/topics/${receipt.message.topicId}?after=${Math.max(0, receipt.message.sequence - config.pageSize)}` });
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
      return api ? json({ error: rejection.code }, rejection.status) : respond(page("ตรวจสอบคำสั่ง", `<h1>ตรวจสอบคำสั่ง</h1><p class="error">${text}</p><a href="/">เปิดหน้าโครงการ</a> · <a href="/login">เข้าสู่ระบบ</a>`), rejection.status);
    }
  };
}
