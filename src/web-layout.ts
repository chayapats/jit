import type { Application, Project, Workspace } from "./application";
import type { Topic } from "./conversation";
import type { Attribution, SourceLookup, SourceReference } from "./sources";
import type { Job, JobPolicy } from "./jobs/types";
import type { RoleRoute } from "./team/types";

/** Escapes literal untrusted content before it enters HTML text or attributes. */
export const escape = (value: unknown) => String(value).replace(/[&<>"']/g, char =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const paths = {
  brand: '<path d="M7 4h10M12 4v11a5 5 0 0 1-5 5H4"/><path d="M17 9v6a5 5 0 0 1-5 5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10H3Z"/>',
  chat: '<path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2 1.5-5A8 8 0 1 1 20 11.5Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  link: '<path d="m10 13 4-4m-7 6-1 1a3 3 0 0 0 4 4l4-4m-4-8 4-4a3 3 0 0 1 4 4l-1 1"/>',
  logout: '<path d="M9 4H4v16h5m5-12 4 4-4 4m-6-4h10"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>', check: '<path d="m5 12 4 4L19 6"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  user: '<circle cx="12" cy="8" r="3"/><path d="M5 21v-2a7 7 0 0 1 14 0v2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
const icon = (name: keyof typeof paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
const brand = () => `<a class="brand" href="/" aria-label="Jit · โครงการทั้งหมด">${icon("brand")}<span>Jit</span></a>`;
const sourceUrl = (projectId: string, ref: SourceReference) => `/projects/${projectId}/sources/${ref.sourceId}?revision=${ref.revision}&generation=${ref.generation}`;
const sourceLink = (projectId: string, ref: SourceReference, label: string) => `<a class="source-link" href="${sourceUrl(projectId, ref)}">${icon("link")}${escape(label)}</a>`;
const attributionLabel = (attribution: Attribution) => attribution.kind === "owner" ? "คุณ" : attribution.kind === "participant"
  ? `ผู้ร่วมทีม ${attribution.participantId} · run ${attribution.runId}` : "บริการทะเบียนแหล่งข้อมูล";
function time(value: number): string {
  const date = new Date(value); if (!Number.isFinite(date.valueOf())) return "ไม่ทราบเวลา";
  return `<time datetime="${date.toISOString()}" title="${date.toISOString()}">${escape(new Intl.DateTimeFormat("th-TH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(date))} UTC</time>`;
}
function documentPage(title: string, content: string): string {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="dark"><title>${escape(title)} · Jit</title><link rel="stylesheet" href="/assets/app.css"></head><body>
    <a class="skip" href="#main-content">ข้ามไปเนื้อหาหลัก</a>${content}</body></html>`;
}
interface Navigation { workspace: Workspace; csrf: string; project?: Project; topics?: Topic[]; topic?: Topic }
function navigation(n: Navigation): string {
  const selected = n.project, topics = n.topic ? [n.topic, ...(n.topics ?? []).filter(t => t.id !== n.topic!.id)] : n.topics ?? [];
  return `<nav aria-label="โครงการและหัวข้อ"><a class="nav-main" href="/">${icon("folder")}<span>โครงการทั้งหมด</span></a>
    <a class="nav-main" href="${selected ? `/projects/${selected.id}/team` : "/team"}">${icon("user")}<span>ทีมและโมเดล</span></a>
    <a class="nav-main" href="${selected ? `/projects/${selected.id}#new-topic` : "/#new-project"}">${icon("plus")}<span>${selected ? "หัวข้อใหม่" : "โครงการใหม่"}</span></a>
    ${selected ? `<a class="nav-main" href="/projects/${selected.id}/jobs">${icon("clock")}<span>งานของโครงการ</span></a><p class="nav-heading">หัวข้อในโครงการ</p><p class="nav-project">${escape(selected.name)}</p>
      <ul>${topics.slice(0, 12).map(t => `<li><a class="nav-link" href="/projects/${selected.id}/topics/${t.id}"${t.id === n.topic?.id ? ' aria-current="page"' : ""}>${icon("chat")}<span>${escape(t.title ?? "หัวข้อไม่พร้อมใช้งาน")}</span></a></li>`).join("")}</ul>
      <a class="nav-subtle" href="/projects/${selected.id}">ดูหัวข้อทั้งหมด</a>` : ""}
    <p class="nav-heading">โครงการของคุณ</p><ul>${n.workspace.projects.slice(0, 8).map(p => `<li><a class="nav-link" href="/projects/${p.id}"${p.id === selected?.id && !n.topic ? ' aria-current="page"' : ""}>${icon("folder")}<span>${escape(p.name)}</span></a></li>`).join("")}</ul>
    ${n.workspace.hasMore || n.workspace.projects.length > 8 ? '<a class="nav-subtle" href="/">ดูโครงการทั้งหมด</a>' : ""}</nav>`;
}
function ownerMenu(csrf: string): string {
  return `<div class="owner-menu"><span class="avatar" aria-hidden="true">${icon("user")}</span><div class="owner-name">พื้นที่ของคุณ<small>โครงการส่วนตัว</small></div>
    <form method="post" action="/logout"><input type="hidden" name="csrf" value="${csrf}"><button class="icon-button" aria-label="ออกจากระบบ" title="ออกจากระบบ">${icon("logout")}</button></form></div>`;
}
function shell(title: string, n: Navigation, content: string, options: { breadcrumb?: { title: string; href: string }; action?: string; composer?: string } = {}): string {
  const nav = navigation(n);
  return documentPage(title, `<div class="app"><aside class="sidebar">${brand()}<div class="nav-scroll">${nav}</div>${ownerMenu(n.csrf)}</aside>
    <main class="main-pane" id="main-content"><header class="app-header"><details class="mobile-menu"><summary aria-label="เปิดเมนูโครงการ">${icon("menu")}</summary><div class="mobile-menu-content">${nav}${ownerMenu(n.csrf)}</div></details>
    <div class="header-title">${options.breadcrumb ? `<a class="breadcrumb" href="${options.breadcrumb.href}">${escape(options.breadcrumb.title)}</a>` : ""}<h1>${escape(title)}</h1></div>${options.action ?? ""}</header>
    <div class="scroll-region">${content}</div>${options.composer ?? ""}</main></div>`);
}
function literalContent(text: string): string {
  const blocks: string[] = [], buffer: string[] = []; let code = false;
  const flush = () => { if (buffer.length) blocks.push(code ? `<pre><code>${escape(buffer.join("\n"))}</code></pre>` : `<p class="literal">${escape(buffer.join("\n"))}</p>`); buffer.length = 0; };
  for (const line of text.split("\n")) {
    if ((!code && /^\x60{3}[a-zA-Z0-9_+-]{0,24}\s*$/.test(line)) || (code && /^\x60{3}\s*$/.test(line))) { flush(); code = !code; }
    else buffer.push(line);
  }
  flush(); return blocks.join("");
}
const hiddenCommand = (csrf: string, revision: number) => `<input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="requestId" value="${crypto.randomUUID()}"><input type="hidden" name="expectedRevision" value="${revision}">`;

/** Renders a bounded project workspace using only supported owner actions. */
export function workspacePage(state: Workspace, csrf: string, offset: number, pageSize: number): string {
  return shell("โครงการของคุณ", { workspace: state, csrf }, `<div class="content"><section class="hero"><p class="eyebrow">พื้นที่สำหรับไอเดียและงานของคุณ</p><h2>วันนี้อยากต่อยอดโครงการไหน?</h2><p>เปิดเรื่องเดิม หรือเริ่มพื้นที่สำหรับสิ่งที่คุณกำลังทำ</p></section>
    <form class="create-form" id="new-project" method="post" action="/projects">${hiddenCommand(csrf, state.revision)}<label class="sr-only" for="name">ชื่อโครงการ</label><input id="name" name="name" maxlength="200" placeholder="ตั้งชื่อโครงการใหม่…" required autocomplete="off"><button class="primary" aria-label="สร้างโครงการ">สร้างโครงการ${icon("plus")}</button></form>
    <h2 class="section-heading">โครงการของคุณ</h2>${state.projects.length ? `<div class="project-grid">${state.projects.map(p => `<a class="project-card" href="/projects/${p.id}">${icon("folder")}<h2>${escape(p.name)}</h2><p>เปิดหัวข้อและบทสนทนา</p></a>`).join("")}</div>` : '<p class="empty-list">เริ่มจากโครงการแรกของคุณได้เลย</p>'}
    <nav class="pagination" aria-label="หน้าโครงการ">${offset > 0 ? `<a href="/?offset=${Math.max(0, offset - pageSize)}">ก่อนหน้า</a>` : ""}${state.hasMore ? `<a href="/?offset=${offset + pageSize}">ถัดไป</a>` : ""}</nav></div>`);
}
/** Renders the selected project's bounded topics and revision-bound topic creation form. */
export function projectPage(state: ReturnType<Application["topics"]>, workspace: Workspace, csrf: string, after: number): string {
  const p = state.project;
  return shell(p.name, { workspace, csrf, project: p, topics: state.items }, `<div class="content" data-group-id="${p.groupId}"><section class="hero"><p class="eyebrow">กลุ่มโครงการ</p><h2>${escape(p.name)}</h2><p>แยกประเด็น แล้วกลับมาคุยต่อได้ทุกเมื่อ</p></section>
    <form class="create-form" id="new-topic" method="post" action="/projects/${p.id}/topics">${hiddenCommand(csrf, p.revision)}<label class="sr-only" for="title">ชื่อหัวข้อ</label><input id="title" name="title" maxlength="200" placeholder="อยากคุยเรื่องอะไรในโครงการนี้…" required><button class="primary" aria-label="สร้างหัวข้อ">สร้างหัวข้อ${icon("plus")}</button></form>
    <h2 class="section-heading">หัวข้อในกลุ่มโครงการ</h2>${state.items.length ? `<ul>${state.items.map(t => `<li class="topic-row">${icon("chat")}<div class="topic-row-main"><h3><a href="/projects/${p.id}/topics/${t.id}">${escape(t.title ?? "หัวข้อไม่พร้อมใช้งาน")}</a></h3>${time(t.createdAt)}</div>${sourceLink(p.id, t.source, "ที่มาของหัวข้อ")}</li>`).join("")}</ul>` : '<p class="empty-list">ยังไม่มีหัวข้อ เริ่มเรื่องแรกได้ที่ด้านบน</p>'}
    <nav class="pagination" aria-label="หน้าหัวข้อ">${after > 0 ? `<a href="/projects/${p.id}">หน้าแรก</a>` : ""}${state.hasMore ? `<a href="/projects/${p.id}?after=${state.nextAfter}">หัวข้อถัดไป</a>` : ""}</nav></div>`, { breadcrumb: { title: "โครงการทั้งหมด", href: "/" } });
}
/** Presents committed attributed messages separately from a persistent, revision-bound composer. */
export function conversationPage(state: ReturnType<Application["conversation"]>, workspace: Workspace, topics: Topic[], csrf: string, after: number, messageBytes: number): string {
  const { project, topic } = state, title = topic.title ?? "หัวข้อไม่พร้อมใช้งาน", base = `/projects/${project.id}/topics/${topic.id}`;
  return shell(title, { workspace, csrf, project, topics, topic }, `<div class="content chat-content"><section aria-label="ประวัติข้อความ">${state.items.length ? state.items.map(m => `<article id="message-${m.id}" class="message${m.attribution.kind === "owner" ? " message--owner" : ""}" data-message-id="${m.id}"><div class="message-body">${m.text === null ? '<p class="literal">ต้นฉบับไม่พร้อมใช้งาน</p>' : literalContent(m.text)}</div>
      <div class="message-meta"><span>${escape(attributionLabel(m.attribution))}</span><span class="committed">${icon("check")}บันทึกแล้ว</span><details><summary aria-label="รายละเอียดและที่มาของข้อความ">${icon("info")}รายละเอียด</summary><div class="message-detail">${time(m.committedAt)}<br>${sourceLink(project.id, m.source, "ที่มาของข้อความ")}</div></details></div></article>`).join("") : `<div class="empty-chat"><div>${icon("chat")}<h2>เริ่มบทสนทนานี้</h2><p>เก็บไอเดีย คำถาม และเรื่องที่อยากกลับมาต่อยอด</p></div></div>`}</section>
      <nav class="pagination" aria-label="หน้าประวัติข้อความ">${after > 0 ? `<a href="${base}">หน้าแรก</a>` : ""}${state.hasMore ? `<a href="${base}?after=${state.nextAfter}">ข้อความถัดไป</a>` : ""}</nav></div>`, {
    breadcrumb: { title: project.name, href: `/projects/${project.id}` }, action: `<a class="header-action" href="/projects/${project.id}#new-topic" aria-label="หัวข้อใหม่">${icon("plus")}หัวข้อใหม่</a>`,
    composer: `<div class="composer-wrap"><form class="composer" method="post" action="${base}/messages">${hiddenCommand(csrf, topic.revision)}<label class="sr-only" for="text">ข้อความของคุณ</label><textarea id="text" name="text" rows="2" maxlength="${messageBytes}" placeholder="เขียนข้อความในหัวข้อนี้…" required aria-describedby="composer-note"></textarea><div class="composer-bottom"><span class="composer-topic">${icon("chat")} ${escape(title)}</span><button class="send-button" aria-label="บันทึกข้อความ" title="บันทึกข้อความ">${icon("arrow")}</button></div></form><p class="composer-note" id="composer-note">บันทึกข้อความไว้ในหัวข้อนี้ เพื่อกลับมาคุยต่อภายหลัง</p></div>`,
  });
}
/** Shows exact committed source content with scope/version metadata available for inspection. */
export function sourcePage(source: SourceLookup, project: Project, workspace: Workspace, csrf: string): string {
  return shell("ที่มาข้อมูล", { workspace, csrf, project }, `<div class="content source-content"><h1>ต้นฉบับที่อ้างอิง</h1>${source.state === "available" ? `<p class="source-byline">${escape(attributionLabel(source.attribution))} · ${time(source.committedAt)} · บันทึกแล้ว</p>${literalContent(source.text)}` : `<p class="error">ต้นฉบับไม่พร้อมใช้งาน (${escape(source.reason)})</p>${source.descriptor ? `<pre>${escape(JSON.stringify(source.descriptor, null, 2))}</pre>` : ""}`}
    <details class="source-details"><summary>รายละเอียดแหล่งข้อมูล</summary><dl><dt>โครงการ</dt><dd>${escape(project.name)} · ${escape(source.projectId)}</dd><dt>Source ID</dt><dd>${escape(source.reference.sourceId)}</dd><dt>Revision / generation</dt><dd>${source.reference.revision} / ${source.reference.generation}</dd></dl></details></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}
/** Presents explicit job starts, committed states, unchanged routes and finite remaining budgets. */
export function jobsPage(state: ReturnType<Application["jobs"]>, workspace: Workspace, csrf: string, after: number, policy: JobPolicy, showStart = true): string {
  const { project } = state, base = `/projects/${project.id}/jobs`;
  const labels: Record<Job["state"], string> = { queued: "รอคิว", admitted: "กำลังทำ", waiting: "รอให้ทำต่อ", succeeded: "เสร็จแล้ว", blocked: "ติดข้อจำกัด", partial: "เสร็จบางส่วน", failed: "ยังไม่สำเร็จ" };
  const reasons: Record<Job["reason"], string> = { queued: "รอพื้นที่ว่างในคิว", running: "กำลังทำงานที่อนุญาต", complete: "มีหลักฐานบันทึกแล้ว", yielded: "พักที่จุดปลอดภัยแล้วกลับเข้าคิว",
    quota: "route ที่เลือกยังติด quota", needs_login: "route ที่เลือกต้องเข้าสู่ระบบ", route_unavailable: "route ที่เลือกยังไม่พร้อม", budget_exhausted: "ใช้งบของงานครบแล้ว", deadline: "ครบเวลาของงานแล้ว",
    worker_failed: "ยังยืนยันผลสำเร็จไม่ได้", interrupted: "งานถูกขัดจังหวะ ต้องตรวจหลักฐานก่อนทำต่อ", configuration_changed: "การตั้งค่างานเปลี่ยนแล้ว", authorization_changed: "สิทธิ์ที่ใช้อ้างอิงเปลี่ยนแล้ว", input_changed: "ข้อมูลต้นทางเปลี่ยนแล้ว" };
  const route = (job: { route: Job["route"] }) => job.route.provider === "jit-service" && job.route.model === null && job.route.authRoute === "internal" ? "บริการภายใน Jit · ไม่เรียกโมเดล"
    : `${job.route.provider} / ${job.route.model ?? "ไม่มีโมเดล"} · ${job.route.authRoute}`;
  const limits = (value: Job["limits"]) => `<dl class="job-limits"><dt>บทบาท / calls / rounds / hops</dt><dd>${value.roles} / ${value.calls} / ${value.rounds} / ${value.hops}</dd><dt>Context / output tokens</dt><dd>${value.contextTokens} / ${value.outputTokens}</dd><dt>Retries / เวลา</dt><dd>${value.retries} / ${Math.ceil(value.wallMs / 1000)} วินาที</dd></dl>`;
  return shell("งานของโครงการ", { project, workspace, csrf }, `<div class="content jobs-content"><section class="jobs-heading"><h2>งานของ ${escape(project.name)}</h2><p>ดูคิว ข้อจำกัด และหลักฐานของงานที่คุณสั่งให้เริ่ม</p></section>
    ${!state.admission.available ? '<p class="error" role="status">คิวหยุดรับงานใหม่ ตรวจว่ามีบริการซ้ำหรือปัญหาการบันทึก แล้วเปิดบริการใหม่ งานเดิมยังดูได้</p>' : ""}
    <section id="new-job" aria-label="เริ่มงาน"${showStart ? "" : " hidden"}>${state.admission.available && state.choices.length ? state.choices.map(choice => `<form class="job-create" method="post" action="${base}">${hiddenCommand(csrf, project.revision)}
      <input type="hidden" name="type" value="${escape(choice.id)}"><input type="hidden" name="configurationRevision" value="${choice.revision}"><input type="hidden" name="policyRevision" value="${choice.policyRevision}"><input type="hidden" name="inputRevision" value="${project.revision}"><input type="hidden" name="input" value="{}"><input type="hidden" name="limits" value="${escape(JSON.stringify(policy.maximum))}">
      <label for="purpose-${escape(choice.id)}">${escape(choice.title)}</label><input id="purpose-${escape(choice.id)}" name="purpose" maxlength="300" required value="${escape(choice.title)}"><p>${escape(route(choice))}</p>
      <div class="job-create-actions"><select name="priority" aria-label="ลำดับความสำคัญ"><option value="interactive">งานตรงหน้า</option><option value="background">เบื้องหลัง</option></select><button class="primary">เริ่ม${escape(choice.title)}</button></div><details><summary>ขอบเขตที่อนุญาตให้งานใช้</summary>${limits(policy.maximum)}</details></form>`).join("") : '<p class="empty-list">ดูงานที่บันทึกไว้ได้ ขณะนี้คิวยังไม่พร้อมรับงานใหม่</p>'}</section>
    <section aria-label="คิวงาน">${state.items.length ? state.items.map(job => `<article class="job-card" id="job-${job.id}"><header><h3><a href="${base}/${job.id}">${escape(job.purpose)}</a></h3><span class="job-status">${labels[job.state]}</span></header><p>${reasons[job.reason]}</p><p class="job-route">${escape(route(job))}</p>
      ${job.occupiesAdmission && job.state !== "admitted" ? '<p>ร้องขอให้หยุดแล้ว ยังรอระบบยืนยันการหยุดและคืนที่ในคิว</p>' : job.state === "waiting" ? `<p>ตรวจเหตุผลและผลที่อาจเกิดขึ้นแล้ว จึงอนุญาตให้ทำต่อด้วย route เดิม</p><form method="post" action="${base}/${job.id}/resume">${hiddenCommand(csrf, job.revision)}<button class="primary">อนุญาตให้ทำต่อ</button></form>` : job.state === "blocked" || job.state === "failed" || job.state === "partial" ? '<p>ตรวจหลักฐานและข้อจำกัดก่อนเริ่มงานใหม่</p>' : ""}
      ${job.evidence ? `<div class="job-evidence">${literalContent(job.evidence)}</div>` : ""}<details><summary>รายละเอียดและงบที่เหลือ</summary>${limits(job.remaining)}<dl class="job-limits"><dt>Job ID</dt><dd>${escape(job.id)}</dd><dt>Input / configuration revision</dt><dd>${job.inputRevision} / ${job.configuration.revision}</dd><dt>อัปเดต</dt><dd>${time(job.updatedAt)}</dd></dl></details></article>`).join("") : '<p class="empty-list">ยังไม่มีงานในโครงการนี้</p>'}</section>
    <nav class="pagination" aria-label="หน้าคิวงาน">${after ? `<a href="${base}">หน้าแรก</a>` : ""}${state.hasMore ? `<a href="${base}?after=${state.nextAfter}">งานถัดไป</a>` : ""}</nav></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}
/** Renders bounded owner configuration and explicitly authorized fixture previews. */
export function teamPage(state: ReturnType<Application["team"]>, workspace: Workspace, csrf: string, limits: JobPolicy["maximum"], preset?: string): string {
  const project = state.project ?? undefined, base = project ? `/projects/${project.id}/team` : "/team";
  const routeFields = (route: RoleRoute | null, label: string) => `<fieldset class="team-route"><legend>${escape(label)}</legend><label>Provider<select name="provider"><option value="">ใช้ค่าจากลำดับถัดไป</option>${["grok", "codex"].map(provider => `<option value="${provider}"${provider === route?.provider ? " selected" : ""}>${provider === "grok" ? "Grok" : "Codex"}</option>`).join("")}</select></label><label>Model ID<input name="model" maxlength="120" value="${escape(route?.model ?? "")}" placeholder="ระบุ model ID ที่เลือก"></label><label>ชื่ออ้างอิงการเชื่อมต่อ<input name="authRoute" maxlength="64" value="${escape(route?.authRoute ?? "")}" placeholder="เช่น owner-grok"><small>ใช้ชื่ออ้างอิงเท่านั้น อย่าใส่รหัสผ่านหรือ token</small></label></fieldset>`;
  const names = { project_role: "override ของบทบาทในโครงการ", project_default: "ค่าเริ่มต้นของโครงการ", owner_role: "ค่าประจำบทบาท", owner_default: "ค่าเริ่มต้นของ owner", missing: "ยังไม่ได้กำหนด" };
  const presets: Record<string, { name: string; responsibility: string }> = { tech: { name: "เทคโนโลยี", responsibility: "ช่วยวิเคราะห์โครงสร้างซอฟต์แวร์ ความถูกต้อง และข้อแลกเปลี่ยนทางเทคนิค" }, design: { name: "ออกแบบ", responsibility: "ช่วยวิเคราะห์ประสบการณ์ใช้งานและการออกแบบให้เหมาะกับผู้ใช้" }, marketing: { name: "การตลาด", responsibility: "ช่วยวิเคราะห์กลุ่มผู้ใช้ คุณค่าของผลิตภัณฑ์ และแนวทางสื่อสาร" } };
  const example = preset ? presets[preset] : undefined;
  const roleForm = (role?: (typeof state.roles)[number]) => `<form class="team-form" method="post" action="/team/roles">${hiddenCommand(csrf, state.ownerRevision)}<input type="hidden" name="roleId" value="${role?.id ?? ""}"><label>ชื่อบทบาท<input name="name" required maxlength="200" value="${escape(role?.name ?? example?.name ?? "")}"></label><label>ประเภท<select name="kind"><option value="specialist">Specialist</option><option value="coordinator"${role?.kind === "coordinator" ? " selected" : ""}>Coordinator</option></select></label><label>ความรับผิดชอบ<textarea name="responsibility" required rows="3">${escape(role?.responsibility ?? example?.responsibility ?? "")}</textarea></label><label>สถานะ<select name="enabled"><option value="true">เปิดใช้</option><option value="false"${role?.enabled === false ? " selected" : ""}>ปิดใช้</option></select></label>${routeFields(role?.route ?? null, "Route ประจำบทบาท")}<button class="primary">${role ? "บันทึกบทบาท" : "สร้างบทบาท"}</button><small>การบันทึกไม่เริ่มงานและไม่เพิ่มสิทธิ์ให้บทบาท</small></form>`;
  return shell(project ? `ทีมของ ${project.name}` : "ทีมและโมเดล", { workspace, csrf, ...(project ? { project } : {}) }, `<div class="content team-content"><section class="hero"><p class="eyebrow">บทบาทและความรับผิดชอบ</p><h2>${project ? "เลือกทีมให้โครงการนี้" : "ทีมในแบบที่คุณต้องการ"}</h2><p>กำหนดหน้าที่และโมเดลอย่างชัดเจน เริ่มตัวอย่างทีละบทบาทเมื่อคุณสั่ง</p></section><p class="team-notice">การเชื่อมต่อจริงยังไม่ผ่านการตรวจสอบ ต้องเชื่อมและตรวจ public host adapter ก่อนใช้จริง ตัวอย่างด้านล่างเป็น fixture และไม่ใช้ quota</p>
    <details class="team-card"><summary>${project ? "ค่าเริ่มต้นของโครงการ" : "ค่าเริ่มต้นของ owner"}</summary><form class="team-form" method="post" action="${base}/routes">${hiddenCommand(csrf, project ? state.projectRevision : state.ownerRevision)}<input type="hidden" name="roleId" value="">${routeFields(project ? state.projectDefault : state.ownerDefault, "ค่าเริ่มต้น")}<button class="primary">บันทึกค่าเริ่มต้น</button></form></details>
    ${!project ? `<details class="team-card" id="new-role"${example || !state.roles.length ? " open" : ""}><summary>เพิ่มบทบาท</summary><p>สร้างเอง หรือเริ่มจาก <a href="/team?preset=tech#new-role">เทคโนโลยี</a> · <a href="/team?preset=design#new-role">ออกแบบ</a> · <a href="/team?preset=marketing#new-role">การตลาด</a> แต่ละบทบาทเป็นทางเลือก</p>${roleForm()}</details>` : '<p><a href="/team">จัดการบทบาททั้งหมดและค่าประจำบทบาท</a></p>'}
    <section aria-label="บทบาท">${state.roles.length ? state.roles.map(role => `<article class="team-card" id="role-${role.id}"><header><h3>${escape(role.name)}</h3><span class="job-status">${role.enabled ? role.kind === "coordinator" ? "Coordinator" : "Specialist" : "ปิดใช้"}</span></header><p class="literal">${escape(role.responsibility)}</p><p class="team-effective">${role.effective.route ? escape(`${role.effective.route.provider} / ${role.effective.route.model} · ${role.effective.route.authRoute}`) : "ยังไม่มี route"}<br><small>ที่มา: ${names[role.effective.layer]} · ${role.effective.status === "unverified" ? "กำหนดแล้ว · ยังไม่ตรวจสอบการเชื่อมต่อจริง" : "ยังเริ่มไม่ได้"}</small></p>
      ${project ? `<details><summary>ปรับ route เฉพาะบทบาทนี้</summary><form class="team-form" method="post" action="${base}/routes">${hiddenCommand(csrf, state.projectRevision)}<input type="hidden" name="roleId" value="${role.id}">${routeFields(state.overrides[role.id] ?? null, "Project override")}<button class="primary">บันทึก override</button></form></details>
      ${role.enabled && role.effective.route && state.topics.length && state.previewAvailable ? `<form class="team-form team-preview" method="post" action="${base}/previews">${hiddenCommand(csrf, project.revision)}<input type="hidden" name="roleId" value="${role.id}"><input type="hidden" name="limits" value="${escape(JSON.stringify(limits))}"><label>ส่งตัวอย่างไปยังหัวข้อ<select name="topicId">${state.topics.map(topic => `<option value="${topic.id}">${escape(topic.title ?? "หัวข้อไม่พร้อมใช้งาน")}</option>`).join("")}</select></label><label>สิ่งที่อยากทดลอง<input name="purpose" required maxlength="300" value="ทดลองความรับผิดชอบของ ${escape(role.name)}"></label><label>ข้อมูลประกอบ<select name="sources"><option value="[]">ไม่แนบข้อมูลต้นทาง</option>${state.topics.filter(topic => topic.availability === "available").map(topic => `<option value="${escape(JSON.stringify([topic.source]))}">ชื่อหัวข้อ: ${escape(topic.title)}</option>`).join("")}</select></label><details><summary>งบของตัวอย่างนี้</summary><p>${limits.calls} calls · ${limits.rounds} rounds · ${limits.hops} hops · context ${limits.contextTokens} / output ${limits.outputTokens} tokens · ${Math.ceil(limits.wallMs / 1000)} วินาที</p><p>เครื่องมือ: ไม่มี · ไม่เปิด shell, file/network fetch หรือการค้นหาเพิ่มเติม</p></details><button class="primary">เริ่มตัวอย่างจำลอง</button></form>` : `<p>${!role.enabled ? "เปิดใช้บทบาทก่อนทดลอง" : !role.effective.route ? "กำหนด route ที่แน่นอนก่อนทดลอง" : !state.topics.length ? "สร้างหัวข้อในโครงการก่อนทดลอง" : "คิวยังไม่พร้อมรับตัวอย่างใหม่"}</p>`}` : `<details><summary>แก้ไขบทบาท</summary>${roleForm(role)}</details>`}</article>`).join("") : '<p class="empty-list">ยังไม่มีบทบาท เริ่มจากบทบาทที่คุณต้องการ</p>'}</section><details class="team-card"><summary>ลำดับการเลือก route</summary><p>Override ของบทบาทในโครงการ → ค่าเริ่มต้นของโครงการ → ค่าประจำบทบาท → ค่าเริ่มต้นของ owner แต่ละลำดับใช้ provider/model/ชื่ออ้างอิงทั้งชุด ไม่มีการเปลี่ยน route อัตโนมัติ</p></details></div>`, project ? { breadcrumb: { title: project.name, href: `/projects/${project.id}` } } : {});
}

/** Renders retained fixture evidence and its captured configuration without implying successful live inference. */
export function previewPage(state: ReturnType<Application["preview"]>, workspace: Workspace, csrf: string): string {
  const { project, run, job } = state, r = run.request;
  const reasons = { complete: "บันทึกผลตัวอย่างแล้ว", unknown_model: "ตัวอย่าง: ไม่รู้จัก model ID ที่เลือก", route_unavailable: "ตัวอย่าง: การเชื่อมต่อที่เลือกไม่พร้อม", quota: "ตัวอย่าง: route ที่เลือกติด quota", needs_login: "ตัวอย่าง: route ที่เลือกต้องเข้าสู่ระบบ", cancelled: "ตัวอย่างถูกยกเลิก", max_rounds: "ตัวอย่างครบจำนวนรอบที่อนุญาต", budget_exhausted: "ตัวอย่างใช้งบครบแล้ว", invalid_result: "ยังยืนยันผลตัวอย่างไม่ได้", context_retired: "บริบทของตัวอย่างถูกเลิกใช้แล้ว" };
  const jobs = { queued: "ตัวอย่างกำลังรอคิว", admitted: "กำลังทำตัวอย่างจำลอง", waiting: "ตัวอย่างรอการตรวจสอบก่อนทำต่อ", succeeded: "บันทึกผลการทำตัวอย่างแล้ว", blocked: "ตัวอย่างติดข้อจำกัด", partial: "ตัวอย่างเสร็จบางส่วน", failed: "ตัวอย่างยังไม่สำเร็จ" };
  return shell("ผลตัวอย่างจำลอง", { workspace, csrf, project }, `<div class="content team-content"><section class="hero"><p class="eyebrow">FIXTURE · ไม่เรียกบริการจริง</p><h2>${escape(run.roleName)}</h2><p>${escape(r.purpose)}</p></section><article class="team-card"><p role="status">${run.outcome ? reasons[run.outcome.reason] : jobs[job.state]}</p>${run.outcome?.output ? literalContent(run.outcome.output) : '<p>ยังไม่มีผลสำเร็จที่ยืนยันแล้ว ตรวจเหตุผลของงานก่อนเริ่มตัวอย่างใหม่</p>'}<p>ผลนี้เป็นตัวอย่างจำลอง การเชื่อมต่อ Grok/Codex จริงยังไม่ผ่านการตรวจสอบ</p>${run.source ? sourceLink(project.id, run.source, "ต้นฉบับที่บันทึกพร้อมที่มา") : ""}<p><a href="/projects/${project.id}/topics/${run.topicId}">เปิดประวัติในหัวข้อ</a> · <a href="/projects/${project.id}/jobs/${run.jobId}">ดูคิวและงบที่เหลือ</a> · <a href="/projects/${project.id}/team">กลับไปทีม</a></p></article><details class="team-card"><summary>การตั้งค่าที่ใช้กับตัวอย่างนี้</summary><p>Requested route: ${escape(`${r.route.provider} / ${r.route.model} · ${r.route.authRoute}`)}</p><p>Execution: scripted fixture · ไม่มี billing route จริง</p><p>Owner / project / role revision: ${r.configuration.ownerRevision} / ${r.configuration.projectRevision} / ${r.configuration.roleRevision}</p><p class="literal">ความรับผิดชอบ: ${escape(r.instructions.responsibility)}</p><p>Managed context: ${escape(r.context.id)} / ${r.context.generation}</p><p>แหล่งข้อมูล: ${r.manifest.sources.length} · เครื่องมือ: ไม่มี</p><p>การแก้ตั้งค่าปัจจุบันไม่เปลี่ยน snapshot ของตัวอย่างนี้</p></details></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** Renders local owner sign-in without scripts, external assets or credentials in markup. */
export function loginPage(): string {
  return documentPage("เข้าสู่ระบบ", `<main class="auth" id="main-content"><div class="auth-card">${brand()}<h1>กลับมาทำงานต่อ</h1><p>พื้นที่สำหรับโครงการและไอเดียของคุณ</p><form method="post" action="/login"><label for="password">รหัสผ่าน owner</label><input id="password" name="password" type="password" maxlength="256" required autocomplete="current-password"><button class="primary">เข้าสู่ระบบ</button></form><footer class="auth-footer">Jit · พื้นที่โครงการส่วนตัว</footer></div></main>`);
}
/** Renders a safe fixed rejection message with accessible recovery navigation. */
export function errorPage(message: string): string {
  return documentPage("ตรวจสอบคำสั่ง", `<main class="auth" id="main-content"><div class="auth-card">${brand()}<h1>ตรวจสอบคำสั่ง</h1><p class="error" role="alert">${escape(message)}</p><div class="error-actions"><a href="/">เปิดหน้าโครงการ</a><a href="/login">เข้าสู่ระบบ</a></div></div></main>`);
}
