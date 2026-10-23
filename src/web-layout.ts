import type { Application, Project, Workspace } from "./application";
import type { Topic } from "./conversation";
import type { Attribution, SourceLookup, SourceReference } from "./sources";
import type { Job, JobLimits, JobPolicy } from "./jobs/types";
import type { DecisionReadModel, Discussion, RoleRoute } from "./team/types";

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
interface Navigation { workspace: Workspace; csrf: string; project?: Project; topics?: Topic[]; topic?: Topic; section?: "home" | "project" | "topic" | "team" | "tasks" | "jobs" | "delivery" | "memory" }
function navigation(n: Navigation): string {
  const selected = n.project, topics = n.topic ? [n.topic, ...(n.topics ?? []).filter(t => t.id !== n.topic!.id)] : n.topics ?? [];
  const here = (section: NonNullable<Navigation["section"]>) => n.section === section ? ' aria-current="page"' : "";
  return `<nav aria-label="โครงการและหัวข้อ"><a class="nav-main" href="/"${here("home")}>${icon("folder")}<span>โครงการทั้งหมด</span></a>
    <a class="nav-main" href="${selected ? `/projects/${selected.id}/team` : "/team"}"${here("team")}>${icon("user")}<span>ทีมและโมเดล</span></a>
    <a class="nav-main" href="${selected ? `/projects/${selected.id}#new-topic` : "/#new-project"}">${icon("plus")}<span>${selected ? "หัวข้อใหม่" : "โครงการใหม่"}</span></a>
    ${selected ? `<a class="nav-main" href="/projects/${selected.id}/memory"${here("memory")}>${icon("info")}<span>Memory</span></a><a class="nav-main" href="/projects/${selected.id}/tasks"${here("tasks")}>${icon("check")}<span>ข้อผูกพัน</span></a><a class="nav-main" href="/projects/${selected.id}/jobs"${here("jobs")}>${icon("clock")}<span>งานของโครงการ</span></a><a class="nav-main" href="/projects/${selected.id}/delivery"${here("delivery")}>${icon("info")}<span>การแจ้งเตือน</span></a><p class="nav-heading">หัวข้อในโครงการ</p><p class="nav-project">${escape(selected.name)}</p>
      <ul>${topics.slice(0, 12).map(t => `<li><a class="nav-link" href="/projects/${selected.id}/topics/${t.id}"${t.id === n.topic?.id && n.section === "topic" ? ' aria-current="page"' : ""}>${icon("chat")}<span>${escape(t.title ?? "หัวข้อไม่พร้อมใช้งาน")}</span></a></li>`).join("")}</ul>
      <a class="nav-subtle" href="/projects/${selected.id}">ดูหัวข้อทั้งหมด</a>` : ""}
    <p class="nav-heading">โครงการของคุณ</p><ul>${n.workspace.projects.slice(0, 8).map(p => `<li><a class="nav-link" href="/projects/${p.id}"${p.id === selected?.id && n.section === "project" ? ' aria-current="page"' : ""}>${icon("folder")}<span>${escape(p.name)}</span></a></li>`).join("")}</ul>
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
  return shell("โครงการของคุณ", { workspace: state, csrf, section: "home" }, `<div class="content"><section class="hero"><p class="eyebrow">พื้นที่สำหรับไอเดียและงานของคุณ</p><h2>วันนี้อยากต่อยอดโครงการไหน?</h2><p>เปิดเรื่องเดิม หรือเริ่มพื้นที่สำหรับสิ่งที่คุณกำลังทำ</p></section>
    <form class="create-form" id="new-project" method="post" action="/projects">${hiddenCommand(csrf, state.revision)}<label class="sr-only" for="name">ชื่อโครงการ</label><input id="name" name="name" maxlength="200" placeholder="ตั้งชื่อโครงการใหม่…" required autocomplete="off"><button class="primary" aria-label="สร้างโครงการ">สร้างโครงการ${icon("plus")}</button></form>
    <h2 class="section-heading">โครงการของคุณ</h2>${state.projects.length ? `<div class="project-grid">${state.projects.map(p => `<a class="project-card" href="/projects/${p.id}">${icon("folder")}<h2>${escape(p.name)}</h2><p>เปิดหัวข้อและบทสนทนา</p></a>`).join("")}</div>` : '<p class="empty-list">เริ่มจากโครงการแรกของคุณได้เลย</p>'}
    <nav class="pagination" aria-label="หน้าโครงการ">${offset > 0 ? `<a href="/?offset=${Math.max(0, offset - pageSize)}">ก่อนหน้า</a>` : ""}${state.hasMore ? `<a href="/?offset=${offset + pageSize}">ถัดไป</a>` : ""}</nav></div>`);
}
/** Renders the selected project's bounded topics and revision-bound topic creation form. */
export function projectPage(state: ReturnType<Application["topics"]>, workspace: Workspace, csrf: string, after: number): string {
  const p = state.project;
  return shell(p.name, { workspace, csrf, project: p, topics: state.items, section: "project" }, `<div class="content" data-group-id="${p.groupId}"><section class="hero"><p class="eyebrow">กลุ่มโครงการ</p><h2>${escape(p.name)}</h2><p>แยกประเด็น แล้วกลับมาคุยต่อได้ทุกเมื่อ</p></section>
    <form class="create-form" id="new-topic" method="post" action="/projects/${p.id}/topics">${hiddenCommand(csrf, p.revision)}<label class="sr-only" for="title">ชื่อหัวข้อ</label><input id="title" name="title" maxlength="200" placeholder="อยากคุยเรื่องอะไรในโครงการนี้…" required><button class="primary" aria-label="สร้างหัวข้อ">สร้างหัวข้อ${icon("plus")}</button></form>
    <h2 class="section-heading">หัวข้อในกลุ่มโครงการ</h2>${state.items.length ? `<ul>${state.items.map(t => `<li class="topic-row">${icon("chat")}<div class="topic-row-main"><h3><a href="/projects/${p.id}/topics/${t.id}">${escape(t.title ?? "หัวข้อไม่พร้อมใช้งาน")}</a></h3>${time(t.createdAt)}</div>${sourceLink(p.id, t.source, "ที่มาของหัวข้อ")}</li>`).join("")}</ul>` : '<p class="empty-list">ยังไม่มีหัวข้อ เริ่มเรื่องแรกได้ที่ด้านบน</p>'}
    <nav class="pagination" aria-label="หน้าหัวข้อ">${after > 0 ? `<a href="/projects/${p.id}">หน้าแรก</a>` : ""}${state.hasMore ? `<a href="/projects/${p.id}?after=${state.nextAfter}">หัวข้อถัดไป</a>` : ""}</nav></div>`, { breadcrumb: { title: "โครงการทั้งหมด", href: "/" } });
}
/** Presents committed attributed messages separately from a persistent, revision-bound composer. */
export function conversationPage(state: ReturnType<Application["conversation"]>, workspace: Workspace, topics: Topic[], csrf: string, after: number, messageBytes: number, dispatch?: {
  team: ReturnType<Application["team"]>; discussions: Discussion[]; limits: JobPolicy["maximum"]; dispatchAvailable: boolean; decision?: DecisionReadModel;
}): string {
  const { project, topic } = state, title = topic.title ?? "หัวข้อไม่พร้อมใช้งาน", base = `/projects/${project.id}/topics/${topic.id}`;
  const roles = dispatch?.team.roles.filter(role => role.kind === "specialist" && role.enabled && role.effective.route) ?? [];
  const dispatchPanel = dispatch ? `<details class="team-card" id="team-dispatch"><summary>เรียกทีมวิเคราะห์ในหัวข้อนี้</summary>
    ${dispatch.dispatchAvailable && roles.length ? `<form class="team-form" method="post" action="/projects/${project.id}/team/discussions">${hiddenCommand(csrf, project.revision)}
      <input type="hidden" name="topicId" value="${topic.id}"><input type="hidden" name="sources" value="${escape(JSON.stringify(topic.availability === "available" ? [topic.source] : []))}">
      <input type="hidden" name="include" value="[]"><input type="hidden" name="exclude" value="[]"><input type="hidden" name="limits" value="${escape(JSON.stringify(dispatch.limits))}">
      <label>สิ่งที่อยากให้ทีมวิเคราะห์<input name="purpose" required maxlength="300" value="${escape(title)}"></label>
      <p>Router จะเลือกเฉพาะ specialist ที่เปิดใช้และมี route · ไม่สรุปแทนคุณ</p><button class="primary">เริ่มวิเคราะห์แยก</button></form>` : '<p>ตั้งค่า specialist ที่เปิดใช้และมี route ก่อน หรือรอให้คิวพร้อม</p>'}
    ${dispatch.discussions.length ? `<ul>${dispatch.discussions.map(item => `<li><a href="/projects/${project.id}/team/discussions/${item.id}">${escape(item.purpose)}</a> · ${item.participations.filter(p => p.state === "completed").length}/${item.participations.length} เสร็จ · ช่องว่าง ${item.coverageGap.length}</li>`).join("")}</ul>` : ""}</details>` : "";
  const decision = dispatch?.decision ? decisionPanel({ projectId: project.id, topicId: topic.id, topicRevision: topic.revision, csrf, model: dispatch.decision }) : "";
  const proposeTask = `<details class="team-card" id="task-proposal"><summary>เสนอเป็นข้อผูกพัน</summary><form class="team-form" method="post" action="/projects/${project.id}/tasks">${hiddenCommand(csrf, topic.revision)}<input type="hidden" name="topicId" value="${topic.id}"><label>ชื่องาน<input name="title" required maxlength="200"></label><label>สรุป<textarea name="summary" required maxlength="${messageBytes}"></textarea></label><button class="primary">บันทึกเป็นข้อเสนอ</button><small>ข้อความในบทสนทนายังไม่ใช่งานที่รับรอง การรับรองไม่เริ่มแก้โค้ด</small></form><p><a href="/projects/${project.id}/tasks?topic=${topic.id}">ดูข้อผูกพันของโครงการ</a></p></details>`;
  return shell(title, { workspace, csrf, project, topics, topic, section: "topic" }, `<div class="content chat-content">${dispatchPanel}${decision}${proposeTask}<section aria-label="ประวัติข้อความ">${state.items.length ? state.items.map(m => `<article id="message-${m.id}" class="message${m.attribution.kind === "owner" ? " message--owner" : ""}" data-message-id="${m.id}"><div class="message-body">${m.text === null ? '<p class="literal">ต้นฉบับไม่พร้อมใช้งาน</p>' : literalContent(m.text)}</div>
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
  const reasons: Record<Job["reason"], string> = {
    cancelled: "ยกเลิกแล้ว · ปิดสิทธิ์บันทึกผล", revoked: "เพิกถอนสิทธิ์แล้ว", superseded: "ถูกแทนที่แล้ว", source_retired: "เลิกใช้ต้นทางแล้ว", context_retired: "เลิกใช้บริบทแล้ว", lease_expired: "สิทธิ์ worker หมดอายุ", queued: "รอพื้นที่ว่างในคิว", running: "กำลังทำงานที่อนุญาต", complete: "มีหลักฐานบันทึกแล้ว", yielded: "พักที่จุดปลอดภัยแล้วกลับเข้าคิว",
    quota: "route ที่เลือกยังติด quota", needs_login: "route ที่เลือกต้องเข้าสู่ระบบ", route_unavailable: "route ที่เลือกยังไม่พร้อม", budget_exhausted: "ใช้งบของงานครบแล้ว", deadline: "ครบเวลาของงานแล้ว",
    worker_failed: "ยังยืนยันผลสำเร็จไม่ได้", interrupted: "งานถูกขัดจังหวะ ต้องตรวจหลักฐานก่อนทำต่อ", configuration_changed: "การตั้งค่างานเปลี่ยนแล้ว", authorization_changed: "สิทธิ์ที่ใช้อ้างอิงเปลี่ยนแล้ว", input_changed: "ข้อมูลต้นทางเปลี่ยนแล้ว" };
  const route = (job: { route: Job["route"] }) => job.route.provider === "jit-service" && job.route.model === null && job.route.authRoute === "internal" ? "บริการภายใน Jit · ไม่เรียกโมเดล"
    : `${job.route.provider} / ${job.route.model ?? "ไม่มีโมเดล"} · ${job.route.authRoute}`;
  const inspection = (job: Job) => {
    const detail = job as Job & Partial<Pick<ReturnType<Application["job"]>, "attempts" | "stop" | "reconciliations">>;
    const transport = { not_dispatched: "ยังไม่ได้ส่งงานออกไป", cancellation_requested: "ขอให้ระบบหยุดแล้ว ยังไม่ยืนยันการหยุด", observed_stopped: "ระบบยืนยันการหยุดแล้ว", unknown: "หลังเปิดบริการใหม่ ยังยืนยันการหยุดไม่ได้" };
    return `${detail.stop ? `<p role="status">ปิดสิทธิ์บันทึกผลแล้ว · ${transport[detail.stop.transport]}</p>` : ""}${detail.attempts?.length ? `<details><summary>ประวัติการทำงาน ${detail.attempts.length} ครั้ง</summary>${detail.attempts.map((attempt, index) => `<p>ครั้งที่ ${index + 1} · ${attempt.state === "committed" ? "บันทึกผลการทำงานแล้ว" : attempt.state === "interrupted" || attempt.state === "rejected" ? "ถูกขัดจังหวะ · ไม่มีสิทธิ์บันทึกผล" : "รอผลการทำงาน"}</p>`).join("")}</details>` : ""}${detail.reconciliations?.filter(r => ["pending", "retire_failed", "delete_failed"].includes(r.lifecycle)).map(r => `<p class="error">${r.lifecycle === "delete_failed" ? "ลบบริบทเดิมไม่สำเร็จ ต้องลองลบอีกครั้ง" : r.lifecycle === "retire_failed" ? "ระบบยังไม่ยืนยันการเลิกใช้บริบทเดิม ต้องลองอีกครั้ง" : "กำลังตรวจสอบบริบทเดิม"} · ยังใช้บริบททดแทนไม่ได้</p>`).join("") ?? ""}`;
  };
  const limits = (value: Job["limits"]) => `<dl class="job-limits"><dt>บทบาท / calls / rounds / hops</dt><dd>${value.roles} / ${value.calls} / ${value.rounds} / ${value.hops}</dd><dt>Context / output tokens</dt><dd>${value.contextTokens} / ${value.outputTokens}</dd><dt>Retries / เวลา</dt><dd>${value.retries} / ${Math.ceil(value.wallMs / 1000)} วินาที</dd></dl>`;
  return shell("งานของโครงการ", { project, workspace, csrf, section: "jobs" }, `<div class="content jobs-content"><section class="jobs-heading"><h2>งานของ ${escape(project.name)}</h2><p>ดูคิว ข้อจำกัด และหลักฐานของงานที่คุณสั่งให้เริ่ม</p></section>
    ${!state.admission.available ? '<p class="error" role="status">คิวหยุดรับงานใหม่ ตรวจว่ามีบริการซ้ำหรือปัญหาการบันทึก แล้วเปิดบริการใหม่ งานเดิมยังดูได้</p>' : ""}
    <section id="new-job" aria-label="เริ่มงาน"${showStart ? "" : " hidden"}>${state.admission.available && state.choices.length ? state.choices.map(choice => `<form class="job-create" method="post" action="${base}">${hiddenCommand(csrf, project.revision)}
      <input type="hidden" name="type" value="${escape(choice.id)}"><input type="hidden" name="configurationRevision" value="${choice.revision}"><input type="hidden" name="policyRevision" value="${choice.policyRevision}"><input type="hidden" name="inputRevision" value="${project.revision}"><input type="hidden" name="input" value="{}"><input type="hidden" name="limits" value="${escape(JSON.stringify(policy.maximum))}">
      <label for="purpose-${escape(choice.id)}">${escape(choice.title)}</label><input id="purpose-${escape(choice.id)}" name="purpose" maxlength="300" required value="${escape(choice.title)}"><p>${escape(route(choice))}</p>
      <div class="job-create-actions"><select name="priority" aria-label="ลำดับความสำคัญ"><option value="interactive">งานตรงหน้า</option><option value="background">เบื้องหลัง</option></select><button class="primary">เริ่ม${escape(choice.title)}</button></div><details><summary>ขอบเขตที่อนุญาตให้งานใช้</summary>${limits(policy.maximum)}</details></form>`).join("") : '<p class="empty-list">ดูงานที่บันทึกไว้ได้ ขณะนี้คิวยังไม่พร้อมรับงานใหม่</p>'}</section>
    <section aria-label="คิวงาน">${state.items.length ? state.items.map(job => `<article class="job-card" id="job-${job.id}"><header><h3><a href="${base}/${job.id}">${escape(job.purpose)}</a></h3><span class="job-status" data-state="${job.state}">${labels[job.state]}</span></header><p>${reasons[job.reason]}</p><p class="job-route">${escape(route(job))}</p>
      ${job.occupiesAdmission && job.state !== "admitted" ? '<p>ร้องขอให้หยุดแล้ว ยังรอระบบยืนยันการหยุดและคืนที่ในคิว</p>' : job.state === "waiting" ? `<p>ตรวจเหตุผลและผลที่อาจเกิดขึ้นแล้ว จึงอนุญาตให้ทำต่อด้วย route เดิม</p><form method="post" action="${base}/${job.id}/resume">${hiddenCommand(csrf, job.revision)}<button class="primary">อนุญาตให้ทำต่อ</button></form>` : job.state === "blocked" || job.state === "failed" || job.state === "partial" ? '<p>ตรวจหลักฐานและข้อจำกัดก่อนเริ่มงานใหม่</p>' : ""}
      ${["queued", "admitted", "waiting"].includes(job.state) ? `<form method="post" action="${base}/${job.id}/stop">${hiddenCommand(csrf, job.revision)}<button class="danger">หยุดงานและปิดสิทธิ์บันทึกผล</button></form>` : ""}
      ${inspection(job)}
      ${job.evidence ? `<div class="job-evidence">${literalContent(job.evidence)}</div>` : ""}<details><summary>รายละเอียดและงบที่เหลือ</summary>${limits(job.remaining)}<dl class="job-limits"><dt>Job ID</dt><dd>${escape(job.id)}</dd><dt>Input / configuration revision</dt><dd>${job.inputRevision} / ${job.configuration.revision}</dd><dt>อัปเดต</dt><dd>${time(job.updatedAt)}</dd></dl></details></article>`).join("") : '<p class="empty-list">ยังไม่มีงานในโครงการนี้</p>'}</section>
    <nav class="pagination" aria-label="หน้าคิวงาน">${after ? `<a href="${base}">หน้าแรก</a>` : ""}${state.hasMore ? `<a href="${base}?after=${state.nextAfter}">งานถัดไป</a>` : ""}</nav></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}
const deliveryLabels: Record<string, string> = {
  waiting: "รอช่องทางที่ผูกไว้", queued: "บันทึกคำขอแล้ว ยังไม่ได้ส่ง", claimed: "กำลังส่ง ยังไม่ทราบผล",
  sent: "Telegram ตอบรับแล้ว", failed: "ส่งไม่สำเร็จ", unknown: "ไม่ทราบว่าถึงหรือยัง", cancelled: "ยกเลิกก่อนส่ง",
};
const deliveryNext: Record<string, string> = {
  wait_for_channel_binding: "รอจนกว่าจะผูกช่องทางส่วนตัว", wait_for_delivery: "รอให้ระบบส่งคำขอที่บันทึกไว้",
  inspect_sent_message: "ตรวจเลขอ้างอิงข้อความที่ Telegram ตอบรับ", inspect_failure: "ตรวจสาเหตุที่ส่งไม่สำเร็จ",
  inspect_unknown_then_explicit_resend: "ตรวจสถานะที่ไม่ทราบผล แล้วค่อยสั่งส่งใหม่หากต้องการ",
  safe_retry_limit_reached: "ลองซ้ำอัตโนมัติครบจำนวนที่อนุญาตแล้ว", inspect_cancelled_intent: "คำขอนี้ถูกยกเลิกก่อนส่ง",
  authorization_changed: "สิทธิ์เจ้าของเปลี่ยนแล้ว", binding_revoked: "การผูกช่องทางถูกถอน", source_superseded: "รายงานถูกแทนที่",
  source_deleted: "ต้นทางถูกลบ", telegram_rejected: "ปลายทางปฏิเสธถาวร", telegram_unavailable: "ปลายทางไม่พร้อมชั่วคราว",
  unknown_transport: "ไม่ทราบผลหลังเริ่มส่ง", not_bound: "ยังไม่ได้ผูกช่องทาง",
};

/** Lists logical notification intents. Rendering this page does not send. */
export function deliveryPage(state: ReturnType<Application["deliveries"]>, workspace: Workspace, csrf: string, after: number): string {
  const { project } = state;
  const base = `/projects/${project.id}/delivery`;
  return shell("การแจ้งเตือน", { project, workspace, csrf, section: "delivery" }, `<div class="content"><section class="hero"><p class="eyebrow">คำขอส่งส่วนตัว</p><h2>สถานะการส่งของ ${escape(project.name)}</h2><p>การบันทึกคำขอหรือการเริ่มส่งไม่ถือว่ารายงานถูกส่งแล้ว ระบบไม่รับประกันว่าปลายทางจะได้รับครั้งเดียว</p></section>
    <form class="create-form" method="post" action="${base}">${hiddenCommand(csrf, project.revision)}<label>ประเภท<select name="kind"><option value="report">รายงาน</option><option value="reminder">เตือนความจำ</option></select></label><label>ข้อความ<input name="text" required maxlength="4096"></label><label>รหัสไม่ซ้ำ<input name="dedupeKey" required minlength="8" maxlength="160" placeholder="report:example:1"></label><button class="primary">บันทึกคำขอส่ง</button></form>
    ${state.items.length ? `<ul>${state.items.map(item => `<li class="topic-row"><div class="topic-row-main"><h3><a href="${base}/${item.id}">${escape(deliveryLabels[item.status] ?? item.status)}</a></h3><p>${escape(item.payload.kind === "reminder" ? "เตือนความจำ" : "รายงาน")} · ${escape(deliveryNext[item.nextAction] ?? item.nextAction)}</p><p class="literal">${escape(item.payload.text)}</p></div></li>`).join("")}</ul>` : '<p class="empty-list">ยังไม่มีคำขอส่ง</p>'}
    <nav class="pagination" aria-label="หน้าการแจ้งเตือน">${after ? `<a href="${base}">หน้าแรก</a>` : ""}${state.hasMore ? `<a href="${base}?after=${state.nextAfter}">ถัดไป</a>` : ""}</nav></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** Shows provenance, outcome and the next action for one intent. A resend warns that duplicates are possible. */
export function deliveryDetailPage(state: ReturnType<Application["delivery"]>, workspace: Workspace, csrf: string): string {
  const { project, intent, report } = state;
  const source = `/projects/${project.id}/sources/${report.sourceId}?revision=${report.sourceRevision}&generation=${report.sourceGeneration}`;
  const uncertain = intent.status === "failed" || intent.status === "unknown";
  return shell("รายละเอียดการส่ง", { project, workspace, csrf, section: "delivery" }, `<div class="content"><section class="hero"><p class="eyebrow">local dedupe เท่านั้น</p><h2>${escape(deliveryLabels[intent.status] ?? intent.status)}</h2><p>${escape(deliveryNext[intent.nextAction] ?? intent.nextAction)}</p><p>การบันทึกคำขอหรือการเริ่มส่งไม่ถือว่ารายงานถูกส่งแล้ว ระบบไม่รับประกันว่าปลายทางจะได้รับครั้งเดียว</p></section>
    <article class="team-card"><p class="literal">${escape(intent.payload.text)}</p><p>สถานะคำขอ: ${escape(intent.status)} · ผลจากปลายทาง: ${escape(intent.remote)} · การรับประกัน: ${escape(intent.guarantee)}</p>
    ${intent.failureReason ? `<p>สาเหตุ: ${escape(deliveryNext[intent.failureReason] ?? intent.failureReason)}</p>` : ""}
    ${intent.stale ? `<p>ผลนี้เกิดระหว่างรายงานหรือช่องทางเปลี่ยนไป (${escape(intent.staleReason ?? "")}) ระบบไม่ได้กันข้อความที่ปลายทางรับไว้แล้ว</p>` : ""}
    ${intent.messageRef ? `<p>อ้างอิงข้อความ ${intent.messageRef.chatId} / ${intent.messageRef.messageId}</p>` : ""}
    ${uncertain ? "<p>รายงานต้นทางยังเปิดอ่านได้ แม้การส่งจะไม่สำเร็จหรือยังไม่ทราบผล</p>" : ""}
    <p><a href="${source}">เปิดรายงานที่บันทึกไว้</a></p>
    ${["failed", "unknown", "sent"].includes(intent.status) ? `<form method="post" action="/projects/${project.id}/delivery/${intent.id}/resend">${hiddenCommand(csrf, intent.revision)}<p>การส่งอีกครั้งอาจทำให้ข้อความซ้ำ</p><button class="primary">ส่งอีกครั้ง</button></form>` : ""}
    </article><details class="team-card"><summary>ที่มาของข้อความ</summary><dl><dt>รายงาน</dt><dd>${escape(report.id)} · รุ่น ${report.revision}/${report.generation} · ${escape(report.availability)}</dd><dt>สิทธิ์ / รุ่นข้อมูล</dt><dd>${intent.provenance.authorityGeneration} / ${intent.provenance.inputGeneration}</dd><dt>รหัสไม่ซ้ำ</dt><dd>${escape(intent.dedupeKey)}</dd><dt>ความพยายาม</dt><dd>${state.attempts.length}</dd></dl></details></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}/delivery` } });
}

/** Renders bounded owner configuration and explicitly authorized fixture previews. */
export function teamPage(state: ReturnType<Application["team"]>, workspace: Workspace, csrf: string, limits: JobPolicy["maximum"], preset?: string): string {
  const project = state.project ?? undefined, base = project ? `/projects/${project.id}/team` : "/team";
  const routeFields = (route: RoleRoute | null, label: string) => `<fieldset class="team-route"><legend>${escape(label)}</legend><label>Provider<select name="provider"><option value="">ใช้ค่าจากลำดับถัดไป</option>${["grok", "codex"].map(provider => `<option value="${provider}"${provider === route?.provider ? " selected" : ""}>${provider === "grok" ? "Grok" : "Codex"}</option>`).join("")}</select></label><label>Model ID<input name="model" maxlength="120" value="${escape(route?.model ?? "")}" placeholder="ระบุ model ID ที่เลือก"></label><label>ชื่ออ้างอิงการเชื่อมต่อ<input name="authRoute" maxlength="64" value="${escape(route?.authRoute ?? "")}" placeholder="เช่น owner-grok"><small>ใช้ชื่ออ้างอิงเท่านั้น อย่าใส่รหัสผ่านหรือ token</small></label></fieldset>`;
  const names = { project_role: "override ของบทบาทในโครงการ", project_default: "ค่าเริ่มต้นของโครงการ", owner_role: "ค่าประจำบทบาท", owner_default: "ค่าเริ่มต้นของ owner", missing: "ยังไม่ได้กำหนด" };
  const presets: Record<string, { name: string; responsibility: string }> = { tech: { name: "เทคโนโลยี", responsibility: "ช่วยวิเคราะห์โครงสร้างซอฟต์แวร์ ความถูกต้อง และข้อแลกเปลี่ยนทางเทคนิค" }, design: { name: "ออกแบบ", responsibility: "ช่วยวิเคราะห์ประสบการณ์ใช้งานและการออกแบบให้เหมาะกับผู้ใช้" }, marketing: { name: "การตลาด", responsibility: "ช่วยวิเคราะห์กลุ่มผู้ใช้ คุณค่าของผลิตภัณฑ์ และแนวทางสื่อสาร" } };
  const example = preset ? presets[preset] : undefined;
  const roleForm = (role?: (typeof state.roles)[number]) => `<form class="team-form" method="post" action="/team/roles">${hiddenCommand(csrf, state.ownerRevision)}<input type="hidden" name="roleId" value="${role?.id ?? ""}"><label>ชื่อบทบาท<input name="name" required maxlength="200" value="${escape(role?.name ?? example?.name ?? "")}"></label><label>ประเภท<select name="kind"><option value="specialist">Specialist</option><option value="coordinator"${role?.kind === "coordinator" ? " selected" : ""}>Coordinator</option></select></label><label>ความรับผิดชอบ<textarea name="responsibility" required rows="3">${escape(role?.responsibility ?? example?.responsibility ?? "")}</textarea></label><label>สถานะ<select name="enabled"><option value="true">เปิดใช้</option><option value="false"${role?.enabled === false ? " selected" : ""}>ปิดใช้</option></select></label>${routeFields(role?.route ?? null, "Route ประจำบทบาท")}<button class="primary">${role ? "บันทึกบทบาท" : "สร้างบทบาท"}</button><small>การบันทึกไม่เริ่มงานและไม่เพิ่มสิทธิ์ให้บทบาท</small></form>`;
  return shell(project ? `ทีมของ ${project.name}` : "ทีมและโมเดล", { workspace, csrf, section: "team", ...(project ? { project } : {}) }, `<div class="content team-content"><section class="hero"><p class="eyebrow">บทบาทและความรับผิดชอบ</p><h2>${project ? "เลือกทีมให้โครงการนี้" : "ทีมในแบบที่คุณต้องการ"}</h2><p>กำหนดหน้าที่และโมเดลอย่างชัดเจน เริ่มตัวอย่างทีละบทบาทเมื่อคุณสั่ง</p></section><p class="team-notice">การเชื่อมต่อจริงยังไม่ผ่านการตรวจสอบ ต้องเชื่อมและตรวจ public host adapter ก่อนใช้จริง ตัวอย่างด้านล่างเป็น fixture และไม่ใช้ quota</p>
    <details class="team-card"><summary>${project ? "ค่าเริ่มต้นของโครงการ" : "ค่าเริ่มต้นของ owner"}</summary><form class="team-form" method="post" action="${base}/routes">${hiddenCommand(csrf, project ? state.projectRevision : state.ownerRevision)}<input type="hidden" name="roleId" value="">${routeFields(project ? state.projectDefault : state.ownerDefault, "ค่าเริ่มต้น")}<button class="primary">บันทึกค่าเริ่มต้น</button></form></details>
    ${!project ? `<details class="team-card" id="new-role"${example || !state.roles.length ? " open" : ""}><summary>เพิ่มบทบาท</summary><p>สร้างเอง หรือเริ่มจาก <a href="/team?preset=tech#new-role">เทคโนโลยี</a> · <a href="/team?preset=design#new-role">ออกแบบ</a> · <a href="/team?preset=marketing#new-role">การตลาด</a> แต่ละบทบาทเป็นทางเลือก</p>${roleForm()}</details>` : '<p><a href="/team">จัดการบทบาททั้งหมดและค่าประจำบทบาท</a></p>'}
    <section aria-label="บทบาท">${state.roles.length ? state.roles.map(role => `<article class="team-card" id="role-${role.id}"><header><h3>${escape(role.name)}</h3><span class="job-status" data-state="${role.enabled ? role.kind : "disabled"}">${role.enabled ? role.kind === "coordinator" ? "Coordinator" : "Specialist" : "ปิดใช้"}</span></header><p class="literal">${escape(role.responsibility)}</p><p class="team-effective">${role.effective.route ? escape(`${role.effective.route.provider} / ${role.effective.route.model} · ${role.effective.route.authRoute}`) : "ยังไม่มี route"}<br><small>ที่มา: ${names[role.effective.layer]} · ${role.effective.status === "unverified" ? "กำหนดแล้ว · ยังไม่ตรวจสอบการเชื่อมต่อจริง" : "ยังเริ่มไม่ได้"}</small></p>
      ${project ? `<details><summary>ปรับ route เฉพาะบทบาทนี้</summary><form class="team-form" method="post" action="${base}/routes">${hiddenCommand(csrf, state.projectRevision)}<input type="hidden" name="roleId" value="${role.id}">${routeFields(state.overrides[role.id] ?? null, "Project override")}<button class="primary">บันทึก override</button></form></details>
      ${role.enabled && role.effective.route && state.topics.length && state.previewAvailable ? `<form class="team-form team-preview" method="post" action="${base}/previews">${hiddenCommand(csrf, project.revision)}<input type="hidden" name="roleId" value="${role.id}"><input type="hidden" name="limits" value="${escape(JSON.stringify(limits))}"><label>ส่งตัวอย่างไปยังหัวข้อ<select name="topicId">${state.topics.map(topic => `<option value="${topic.id}">${escape(topic.title ?? "หัวข้อไม่พร้อมใช้งาน")}</option>`).join("")}</select></label><label>สิ่งที่อยากทดลอง<input name="purpose" required maxlength="300" value="ทดลองความรับผิดชอบของ ${escape(role.name)}"></label><label>ข้อมูลประกอบ<select name="sources"><option value="[]">ไม่แนบข้อมูลต้นทาง</option>${state.topics.filter(topic => topic.availability === "available").map(topic => `<option value="${escape(JSON.stringify([topic.source]))}">ชื่อหัวข้อ: ${escape(topic.title)}</option>`).join("")}</select></label><details><summary>งบของตัวอย่างนี้</summary><p>${limits.calls} calls · ${limits.rounds} rounds · ${limits.hops} hops · context ${limits.contextTokens} / output ${limits.outputTokens} tokens · ${Math.ceil(limits.wallMs / 1000)} วินาที</p><p>เครื่องมือ: ไม่มี · ไม่เปิด shell, file/network fetch หรือการค้นหาเพิ่มเติม</p></details><button class="primary">เริ่มตัวอย่างจำลอง</button></form>` : `<p>${!role.enabled ? "เปิดใช้บทบาทก่อนทดลอง" : !role.effective.route ? "กำหนด route ที่แน่นอนก่อนทดลอง" : !state.topics.length ? "สร้างหัวข้อในโครงการก่อนทดลอง" : "คิวยังไม่พร้อมรับตัวอย่างใหม่"}</p>`}` : `<details><summary>แก้ไขบทบาท</summary>${roleForm(role)}</details>`}</article>`).join("") : '<p class="empty-list">ยังไม่มีบทบาท เริ่มจากบทบาทที่คุณต้องการ</p>'}</section><details class="team-card"><summary>ลำดับการเลือก route</summary><p>Override ของบทบาทในโครงการ → ค่าเริ่มต้นของโครงการ → ค่าประจำบทบาท → ค่าเริ่มต้นของ owner แต่ละลำดับใช้ provider/model/ชื่ออ้างอิงทั้งชุด ไม่มีการเปลี่ยน route อัตโนมัติ</p></details></div>`, project ? { breadcrumb: { title: project.name, href: `/projects/${project.id}` } } : {});
}

function decisionPanel(input: { projectId: string; topicId: string; topicRevision?: number; csrf: string; model: DecisionReadModel; discussion?: { id: string; revision: number; limits: JobLimits; canSynthesize: boolean } }): string {
  const { model, projectId, topicId, csrf } = input;
  const proposal = model.proposal;
  const running = model.synthesis?.state === "queued" || model.synthesis?.state === "running";
  const failed = model.synthesis && ["failed", "incomplete", "cancelled"].includes(model.synthesis.state)
    ? model.synthesis : null;
  const evidence = (items: DecisionReadModel["proposalEvidence"]) => items.map(item => item.state === "available"
    ? `<p>${escape(item.roleName ?? "แหล่งข้อมูล")}${item.route ? ` · ${escape(`${item.route.provider} / ${item.route.model} · ${item.route.authRoute}`)}` : ""} ${sourceLink(projectId, item.reference, "หลักฐาน")}</p>`
    : `<p class="error">ต้นฉบับไม่พร้อมใช้งาน${item.roleName ? ` · ${escape(item.roleName)}` : ""} (${escape(item.reason ?? "unavailable")})</p>`).join("");
  const history = model.decisions.map(entry => `<li>${entry.decision.supersededBy ? "ถูกแทนที่แล้ว" : "ปัจจุบัน"} · ${escape(entry.decision.conclusion)} · ${escape(entry.decision.rationale)} · proposal r${entry.decision.proposalRevision} · ${time(entry.decision.createdAt)}</li>`).join("");
  const choose = proposal && !running ? `<form class="team-form" method="post" action="/projects/${projectId}/topics/${topicId}/decisions">${hiddenCommand(csrf, proposal.revision)}
      <input type="hidden" name="proposalId" value="${proposal.id}"><input type="hidden" name="mode" value="${model.currentDecision ? "supersede" : "accept"}">
      ${model.currentDecision ? `<input type="hidden" name="decisionId" value="${model.currentDecision.decision.id}">` : ""}
      <label>ทางเลือก<select name="optionId">${proposal.artifact.options.map(option => `<option value="${escape(option.id)}">${escape(option.label)}</option>`).join("")}<option value="own">เขียนข้อสรุปเอง</option></select></label>
      <label>ข้อสรุปของคุณ<textarea name="conclusion" required maxlength="2000"></textarea></label>
      <label>เหตุผล<textarea name="rationale" required maxlength="2000"></textarea></label>
      <button class="primary">${model.currentDecision ? "แทนที่การตัดสินเดิม" : "บันทึกการตัดสิน"}</button>
      <small>การบันทึกนี้เป็นการตัดสินของคุณ คนละรายการกับข้อเสนอของผู้ประสานงาน</small></form>` : "";
  const synthesize = input.discussion && !running ? `<form method="post" action="/projects/${projectId}/team/discussions/${input.discussion.id}/synthesis">${hiddenCommand(csrf, input.discussion.revision)}
      <input type="hidden" name="limits" value="${escape(JSON.stringify(input.discussion.limits))}"><button>${proposal ? "ให้ผู้ประสานงานสรุปใหม่" : "ให้ผู้ประสานงานสรุป"}</button></form>` : "";
  if (!proposal && !model.synthesis && !model.decisions.length && !input.discussion) return "";
  return `<section class="team-card" id="owner-decision"><h2>สรุปสำหรับคุณตัดสิน</h2>
    ${running ? "<p role=\"status\">ผู้ประสานงานกำลังสรุปจากผลที่บันทึกแล้ว ยังไม่มีการตัดสิน</p>" : ""}
    ${failed ? `<p class="error">สรุปยังไม่เป็นการตัดสิน (${escape(failed.reason ?? failed.state)})</p>` : ""}
    ${proposal ? `<p>${proposal.artifact.disagreement || proposal.artifact.missing.length ? "ยังไม่มีความเห็นตรงกัน" : "ผู้ประสานงานเห็นว่าตัวเลือกสอดคล้องกัน แต่ยังไม่ใช่การตัดสินของคุณ"}</p>
      <p>คำถาม: ${escape(proposal.artifact.question)}</p>
      ${proposal.artifact.missing.length ? `<ul>${proposal.artifact.missing.map(gap => `<li>ข้อมูลที่ขาด: ${escape(gap.roleName)} (${escape(gap.reason)})</li>`).join("")}</ul>` : ""}
      <ul>${proposal.artifact.options.map(option => `<li><strong>${escape(option.label)}</strong> — ${escape(option.rationale)} ${option.citations.map(citation => sourceLink(projectId, citation.reference, citation.roleName)).join(" ")}</li>`).join("")}</ul>
      ${evidence(model.proposalEvidence)}<p>proposal r${proposal.revision}</p>` : "<p>ยังไม่มีข้อเสนอที่ตรวจการอ้างอิงแล้ว</p>"}
    ${model.currentDecision ? `<p>คุณบันทึกการตัดสินแล้ว: ${escape(model.currentDecision.decision.conclusion)}</p><p>${escape(model.currentDecision.decision.rationale)}</p>${evidence(model.currentDecision.evidence)}` : "<p>ยังไม่มีการตัดสินของคุณ</p>"}
    ${history ? `<details><summary>ประวัติการตัดสิน</summary><ul>${history}</ul></details>` : ""}
    ${choose}${proposal && input.topicRevision ? `<form class="team-form" method="post" action="/projects/${projectId}/tasks">${hiddenCommand(csrf, input.topicRevision)}<input type="hidden" name="topicId" value="${topicId}"><input type="hidden" name="source" value="${escape(JSON.stringify(proposal.source))}"><label>ชื่องานจากผลที่ตรวจแล้ว<input name="title" required maxlength="200" value="${escape(proposal.artifact.question.slice(0, 200))}"></label><label>สรุป<textarea name="summary" required maxlength="2000">${escape(proposal.artifact.question)}</textarea></label><button>เสนอเป็นงานจากผลที่ตรวจแล้ว</button><small>นี่คือข้อเสนอจากผลที่อ้างอิงได้ ยังไม่ใช่งานที่รับรอง และไม่เริ่มแก้โค้ด</small></form>` : ""}${input.discussion?.canSynthesize ? synthesize : ""}</section>`;
}

const taskLabels: Record<string, string> = {
  proposed: "ข้อเสนอ", accepted: "รับรองแล้ว · รอยืนยันผล", ready_for_review: "พร้อมให้ตรวจปิดงาน",
  completed: "ปิดเรียบร้อยแล้ว", dismissed: "ยกเลิกข้อเสนอ", cancelled: "ยกเลิกหลังรับรอง", superseded: "ถูกแทนที่แล้ว",
};
const policyLabels: Record<string, string> = {
  owner_confirmed: "คุณยืนยันผลเอง (ค่าเริ่มต้น)",
  evidence_satisfied: "ปิดได้เมื่อมีหลักฐานครบตามนโยบาย",
};
function taskStatusText(task: { state: string; pendingReason?: { detail: string } | null; completionPolicy: { kind: string } }): string {
  const base = taskLabels[task.state] ?? task.state;
  const policy = `นโยบาย: ${policyLabels[task.completionPolicy.kind] ?? task.completionPolicy.kind}`;
  const pending = task.pendingReason ? ` · ค้าง: ${task.pendingReason.detail}` : "";
  return `${base} · ${policy}${pending}`;
}

/** Renders proposals, accepted obligations, and closed tasks as separate lists. */
export function tasksPage(state: ReturnType<Application["tasks"]>, workspace: Workspace, csrf: string, topicId: string | null): string {
  const { project } = state;
  const selected = state.topics.find(topic => topic.id === topicId) ?? state.topics[0];
  const card = (task: (typeof state.proposed)[number]) => `<article class="team-card" id="task-${task.id}"><header><h3><a href="/projects/${project.id}/tasks/${task.id}">${escape(task.title)}</a></h3><span class="job-status" data-state="${task.state}">${escape(taskStatusText(task))}</span></header><p>${escape(task.summary)}</p><p>proposal r${task.proposalRevision} · ${task.origin === "owner" ? "คุณเสนอ" : "อ้างผลที่ตรวจแล้ว"}</p>${sourceLink(project.id, task.source, "ที่มา")}</article>`;
  const group = (title: string, items: typeof state.proposed, empty: string) => `<section><h2 class="section-heading">${title}</h2>${items.length ? items.map(card).join("") : `<p class="empty-list">${empty}</p>`}</section>`;
  const form = selected ? `<form class="team-form" method="post" action="/projects/${project.id}/tasks">${hiddenCommand(csrf, selected.revision)}<input type="hidden" name="topicId" value="${selected.id}"><label>หัวข้อ<p>${escape(selected.title ?? "หัวข้อไม่พร้อมใช้งาน")}</p></label><label>ชื่องาน<input name="title" required maxlength="200"></label><label>สรุป<textarea name="summary" required></textarea></label><button class="primary">บันทึกเป็นข้อเสนอ</button></form>` : "<p>สร้างหัวข้อก่อนเสนองาน</p>";
  return shell("ข้อผูกพัน", { workspace, csrf, project, topics: state.topics, section: "tasks" }, `<div class="content team-content"><section class="hero"><p class="eyebrow">ข้อเสนอแยกจากงานที่รับรอง</p><h2>ข้อผูกพันของ ${escape(project.name)}</h2><p>การรับรองเป็นข้อผูกพันของคุณ การรับรองยังไม่เริ่มแก้โค้ดหรือรันคำสั่ง</p></section>
    <details class="team-card" id="new-task"${state.proposed.length ? "" : " open"}><summary>เสนองานจากหัวข้อ</summary>${form}</details>
    ${group("ข้อเสนอที่ยังไม่รับรอง", state.proposed, "ยังไม่มีข้อเสนอ")}
    ${group("ข้อผูกพันที่รับรองแล้ว", state.accepted, "ยังไม่มีงานที่รับรอง")}
    ${group("พร้อมให้ตรวจปิดงาน", state.readyForReview, "ยังไม่มีงานที่รอตรวจปิด")}
    ${group("ปิดเรียบร้อยแล้ว", state.completed, "ยังไม่มีงานที่ปิดแล้ว")}
    ${group("รายการที่ไม่ active", state.inactive, "ยังไม่มีรายการที่ยกเลิกหรือถูกแทนที่")}
    ${Object.values(state.hasMore).some(Boolean) ? '<p role="status">แสดงรายการตามขอบเขตหน้าปัจจุบัน ยังมีงานเพิ่มเติมในโครงการ</p>' : ""}</div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** Renders one task, its proposal history, and owner actions that do not start execution. */
export function taskPage(state: ReturnType<Application["task"]>, workspace: Workspace, csrf: string, messageBytes: number): string {
  const { project, task, topic } = state;
  const base = `/projects/${project.id}/tasks/${task.id}`;
  const unavailable = state.source.state === "unavailable" ? `<p class="error">ต้นฉบับไม่พร้อมใช้งาน (${escape(state.source.reason)})</p>` : sourceLink(project.id, task.source, "ที่มาของข้อเสนอนี้");
  const history = state.proposals.map(proposal => `<li>r${proposal.revision} · ${escape(proposal.title)} · ${escape(proposal.summary)} · ${proposal.origin === "owner" ? "คุณ" : "ผลที่ตรวจแล้ว"} · ${time(proposal.createdAt)}</li>`).join("");
  const events = state.events.map(event => `<li>${escape(taskLabels[event.kind] ?? event.kind)} · ${event.channel} · ${event.actorId} · ${event.reason ? escape(event.reason) : ""} · ${time(event.createdAt)}</li>`).join("");
  const revise = task.state === "proposed" ? `<form class="team-form" method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="edit"><label>ชื่องาน<input name="title" required maxlength="200" value="${escape(task.title)}"></label><label>สรุป<textarea name="summary" required maxlength="${messageBytes}">${escape(task.summary)}</textarea></label><button>แก้ข้อเสนอเป็น revision ใหม่</button></form>
    <form method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="dismiss"><input type="hidden" name="proposalId" value="${state.proposals.at(-1)?.id ?? ""}"><label>เหตุผลที่ยกเลิกข้อเสนอ<input name="reason" required maxlength="500"></label><button class="danger">ยกเลิกข้อเสนอ</button></form>
    <form method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="accept"><input type="hidden" name="proposalId" value="${state.proposals.at(-1)?.id ?? ""}"><button class="primary">รับรอง revision นี้</button><small>ผู้รับรองคือคุณ การรับรองไม่เริ่มแก้โค้ด</small></form>` : "";
  const cancel = task.state === "accepted" || task.state === "ready_for_review" ? `<form method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="cancel"><label>เหตุผลที่ยกเลิก<input name="reason" required maxlength="500"></label><button class="danger">ยกเลิกงานที่รับรองแล้ว</button></form>` : "";
  const complete = task.state === "accepted" || task.state === "ready_for_review" ? `<form method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="complete"><label>บันทึกการปิดงาน (ไม่ใช่ข้อความ done ของโมเดล)<input name="note" maxlength="500" placeholder="สรุปผลที่คุณยืนยัน"></label><button class="primary">ยืนยันปิดงาน</button><small>${escape(taskStatusText(task))}</small></form>` : "";
  const reopen = task.state === "completed" ? `<form method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="reopen"><label>เหตุผลที่เปิดใหม่<input name="reason" required maxlength="500"></label><button>เปิดงานใหม่หลังตรวจ</button></form>` : "";
  const policyForm = task.state === "accepted" || task.state === "ready_for_review" ? `<form method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="set_policy"><label>นโยบายปิดงาน<select name="policyKind"><option value="owner_confirmed"${task.completionPolicy.kind === "owner_confirmed" ? " selected" : ""}>คุณยืนยันผลเอง</option><option value="evidence_satisfied"${task.completionPolicy.kind === "evidence_satisfied" ? " selected" : ""}>ต้องมีหลักฐานครบ</option></select></label><button>บันทึกนโยบาย</button></form>` : "";
  const evidence = state.evidenceArtifacts.length ? `<ul>${state.evidenceArtifacts.map(item => `<li>r${item.revision} · ${escape(item.workType)} · ${escape(item.outcome)}${item.deliveryState ? ` · ${escape(item.deliveryState)}` : ""} · ${sourceLink(project.id, item.source, "หลักฐาน")}</li>`).join("")}</ul>` : "<p>ยังไม่มีหลักฐานจากงานวิเคราะห์/ตรวจ/แจ้งเตือน</p>";
  return shell(task.title, { workspace, csrf, project, topic, section: "tasks" }, `<div class="content team-content"><section class="hero"><p class="eyebrow">${escape(taskStatusText(task))} · proposal r${task.proposalRevision}</p><h2>${escape(task.title)}</h2><p>${escape(task.summary)}</p></section>
    <article class="team-card"><p>หัวข้อ: <a href="/projects/${project.id}/topics/${topic.id}">${escape(topic.title ?? "หัวข้อไม่พร้อมใช้งาน")}</a></p>${unavailable}
    ${task.acceptance ? `<p>รับรองโดย owner ผ่าน ${escape(task.acceptance.channel)} · proposal r${task.acceptance.proposalRevision} · ${time(task.acceptance.acceptedAt)}</p>` : "<p>ยังไม่มีการรับรอง</p>"}
    ${task.completion ? `<p>ปิดโดย owner · ${time(task.completion.completedAt)} · ${task.completion.note ? escape(task.completion.note) : "ไม่มีบันทึกเพิ่ม"}</p>` : ""}
    ${task.closedReason ? `<p>เหตุผลที่ปิด: ${escape(task.closedReason)}</p>` : ""}
    <p>การรับรองไม่เปิด shell, การแก้ไฟล์, การทดสอบ หรือการ build · ข้อความ done ของโมเดลไม่ปิดงาน</p></article>
    ${policyForm}<details open><summary>หลักฐานที่อ้างได้</summary>${evidence}</details>
    ${revise}${complete}${cancel}${reopen}
    <form method="post" action="${base}">${hiddenCommand(csrf, task.revision)}<input type="hidden" name="mode" value="start"><button>เริ่มแก้โค้ด</button></form>
    <details><summary>ประวัติข้อเสนอ</summary><ul>${history}</ul></details>
    <details><summary>ประวัติคำสั่ง</summary><ul>${events}</ul></details>
    <p><a href="/projects/${project.id}/tasks">กลับไปรายการข้อผูกพัน</a></p></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** Renders one logical discussion with owner role controls, coordinator synthesis and the owner decision form. */
export function discussionPage(state: ReturnType<Application["discussion"]>, workspace: Workspace, csrf: string, limits: JobLimits): string {
  const { project, discussion: d } = state;
  const labels: Record<string, string> = { queued: "รอคิว", running: "กำลังวิเคราะห์", completed: "บันทึกแล้ว", blocked: "ติดข้อจำกัด", stopped: "หยุดแล้ว", skipped: "ข้าม", excluded: "ตัดออก" };
  const controls = (roleId: string, revision: number) => ["include", "exclude", "skip", "stop"].map(action =>
    `<form method="post" action="/projects/${project.id}/team/discussions/${d.id}/controls">${hiddenCommand(csrf, revision)}<input type="hidden" name="roleId" value="${roleId}"><input type="hidden" name="action" value="${action}"><button${action === "stop" ? ' class="danger"' : ""}>${action}</button></form>`).join("");
  return shell("การหารือของทีม", { workspace, csrf, project, section: "team" }, `<div class="content team-content"><section class="hero"><p class="eyebrow">FIXTURE · วิเคราะห์แยก · ยังไม่สรุปแทนคุณ</p><h2>${escape(d.purpose)}</h2><p>${escape(d.router.evidence)} · ช่องว่าง ${d.coverageGap.length}</p></section>
    ${d.participations.map(item => `<article class="team-card" id="role-${item.roleId}"><header><h3>${escape(item.roleName)}</h3><span class="job-status" data-state="${escape(item.state)}">${labels[item.state] ?? item.state}</span></header>
      <p>${item.route ? escape(`${item.route.provider} / ${item.route.model} · ${item.route.authRoute}`) : "ไม่มี route"} · ${escape(item.reason ?? "")}</p>
      ${item.progress ? `<p role="status">ความคืบหน้าชั่วคราว: ${escape(item.progress.text)}</p>` : ""}
      ${item.output ? sourceLink(project.id, item.output, "ผลที่บันทึกแล้ว") : "<p>ยังไม่มีผลที่ยืนยันแล้ว</p>"}
      <p><a href="/projects/${project.id}/jobs/${item.jobId}">ดูงาน</a></p><div class="team-form">${controls(item.roleId, d.revision)}</div></article>`).join("")}
    ${state.context ? contextPanel(state.context, "บริบทที่ทีมใช้") : ""}${state.synthesisContext ? contextPanel(state.synthesisContext, "บริบทของผู้ประสานงาน") : ""}
    ${decisionPanel({ projectId: project.id, topicId: d.topicId, csrf, model: state.decision, discussion: { id: d.id, revision: d.revision, limits, canSynthesize: d.participations.some(item => item.state === "completed") } })}
    <p><a href="/projects/${project.id}/topics/${d.topicId}">กลับหัวข้อ</a></p></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** Renders retained fixture evidence and its captured configuration without implying successful live inference. */
export function previewPage(state: ReturnType<Application["preview"]>, workspace: Workspace, csrf: string): string {
  const { project, run, job } = state, r = run.request;
  const reasons = { complete: "บันทึกผลตัวอย่างแล้ว", unknown_model: "ตัวอย่าง: ไม่รู้จัก model ID ที่เลือก", route_unavailable: "ตัวอย่าง: การเชื่อมต่อที่เลือกไม่พร้อม", quota: "ตัวอย่าง: route ที่เลือกติด quota", needs_login: "ตัวอย่าง: route ที่เลือกต้องเข้าสู่ระบบ", cancelled: "ตัวอย่างถูกยกเลิก", max_rounds: "ตัวอย่างครบจำนวนรอบที่อนุญาต", budget_exhausted: "ตัวอย่างใช้งบครบแล้ว", invalid_result: "ยังยืนยันผลตัวอย่างไม่ได้", context_retired: "บริบทของตัวอย่างถูกเลิกใช้แล้ว" };
  const jobs = { queued: "ตัวอย่างกำลังรอคิว", admitted: "กำลังทำตัวอย่างจำลอง", waiting: "ตัวอย่างรอการตรวจสอบก่อนทำต่อ", succeeded: "บันทึกผลการทำตัวอย่างแล้ว", blocked: "ตัวอย่างติดข้อจำกัด", partial: "ตัวอย่างเสร็จบางส่วน", failed: "ตัวอย่างยังไม่สำเร็จ" };
  return shell("ผลตัวอย่างจำลอง", { workspace, csrf, project, section: "team" }, `<div class="content team-content"><section class="hero"><p class="eyebrow">FIXTURE · ไม่เรียกบริการจริง</p><h2>${escape(run.roleName)}</h2><p>${escape(r.purpose)}</p></section><article class="team-card"><p role="status">${run.outcome ? reasons[run.outcome.reason] : jobs[job.state]}</p>${run.outcome?.output ? literalContent(run.outcome.output) : '<p>ยังไม่มีผลสำเร็จที่ยืนยันแล้ว ตรวจเหตุผลของงานก่อนเริ่มตัวอย่างใหม่</p>'}<p>ผลนี้เป็นตัวอย่างจำลอง การเชื่อมต่อ Grok/Codex จริงยังไม่ผ่านการตรวจสอบ</p>${run.source ? sourceLink(project.id, run.source, "ต้นฉบับที่บันทึกพร้อมที่มา") : ""}<p><a href="/projects/${project.id}/topics/${run.topicId}">เปิดประวัติในหัวข้อ</a> · <a href="/projects/${project.id}/jobs/${run.jobId}">ดูคิวและงบที่เหลือ</a> · <a href="/projects/${project.id}/team">กลับไปทีม</a></p></article><details class="team-card"><summary>การตั้งค่าที่ใช้กับตัวอย่างนี้</summary><p>Requested route: ${escape(`${r.route.provider} / ${r.route.model} · ${r.route.authRoute}`)}</p><p>Execution: scripted fixture · ไม่มี billing route จริง</p><p>Owner / project / role revision: ${r.configuration.ownerRevision} / ${r.configuration.projectRevision} / ${r.configuration.roleRevision}</p><p class="literal">ความรับผิดชอบ: ${escape(r.instructions.responsibility)}</p><p>Managed context: ${escape(r.context.id)} / ${r.context.generation}</p><p>แหล่งข้อมูล: ${r.manifest.sources.length} · เครื่องมือ: ไม่มี</p><p>การแก้ตั้งค่าปัจจุบันไม่เปลี่ยน snapshot ของตัวอย่างนี้</p></details></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** Renders local owner sign-in without scripts, external assets or credentials in markup. */
export function loginPage(): string {
  return documentPage("เข้าสู่ระบบ", `<main class="auth" id="main-content"><div class="auth-card">${brand()}<h1>กลับมาทำงานต่อ</h1><p>พื้นที่สำหรับโครงการและไอเดียของคุณ</p><form method="post" action="/login"><label for="password">รหัสผ่าน owner</label><input id="password" name="password" type="password" maxlength="256" required autocomplete="current-password"><button class="primary">เข้าสู่ระบบ</button></form><footer class="auth-footer">Jit · พื้นที่โครงการส่วนตัว</footer></div></main>`);
}
/** Renders a safe fixed rejection message with accessible recovery navigation. */
export function errorPage(message: string, recovery?: { href: string; label: string }): string {
  const next = recovery ? `<a href="${escape(recovery.href)}">${escape(recovery.label)}</a>` : "";
  return documentPage("ตรวจสอบคำสั่ง", `<main class="auth" id="main-content"><div class="auth-card">${brand()}<h1>ตรวจสอบคำสั่ง</h1><p class="error" role="alert">${escape(message)}</p><div class="error-actions">${next}<a href="/">เปิดหน้าโครงการ</a><a href="/login">เข้าสู่ระบบ</a></div></div></main>`);
}

const claimUrl = (projectId: string, ref: import("./memory/types").ClaimReference) => `/projects/${projectId}/memory/claims/${ref.claimId}?revision=${ref.revision}&generation=${ref.generation}`;
function memoryClaimContent(item: import("./memory/types").ClaimLookup, projectId: string): string {
  const dependencies = (label: string, refs: import("./memory/types").ClaimReference[]) => refs.length ? `<p>${label}</p><ul>${refs.map(ref => `<li><a href="${claimUrl(projectId, ref)}">${escape(ref.claimId)} · revision ${ref.revision}</a></li>`).join("")}</ul>` : "";
  const decision = (ref: import("./memory/types").MemoryDecisionReference | null) => ref ? `<p><a href="/projects/${projectId}/topics/${ref.topicId}#owner-decision">เปิดมติ owner · revision ${ref.revision}</a> · ${escape(ref.id)}</p>` : "";
  if (item.state !== "available") {
    const p = item.provenance;
    return `<article class="team-card"><h2>Memory ไม่พร้อมใช้งาน</h2><p>${escape(item.reason)}</p><p>Claim ${escape(item.reference.claimId)} · revision ${item.reference.revision} · generation ${item.reference.generation}</p>${p ? `<p>${sourceLink(projectId, p.source, `ตรวจต้นฉบับ revision ${p.source.revision} · generation ${p.source.generation}`)}</p>${dependencies("ตรวจที่มาจาก memory", p.dependencies)}${dependencies("ตรวจข้อขัดแย้ง", p.conflicts)}${decision(p.decision)}` : ""}</article>`;
  }
  const c = item.claim;
  return `<article class="team-card" id="claim-${c.claimId}"><h2>${c.kind === "explicit_fact" ? "Fact: owner กล่าวข้อความนี้" : "Inference: ข้ออนุมาน"}</h2><p>สถานะ: active · โครงการต้นทาง: ${escape(projectId)}</p>${literalContent(c.text)}
    <p>${sourceLink(projectId, c.source, `เปิดต้นฉบับ revision ${c.source.revision} · generation ${c.source.generation}`)} · ${item.source.state === "available" ? escape(attributionLabel(item.source.attribution)) : "ต้นฉบับไม่พร้อมใช้งาน"}</p>
    <details><summary>ข้อความหลักฐานและที่มา</summary><blockquote>${literalContent(c.quote)}</blockquote><p><a href="${claimUrl(projectId, c)}">Claim ${c.claimId}</a> · revision ${c.revision} · generation ${c.generation} · ${time(c.createdAt)}</p>${dependencies("ได้มาจาก memory", c.dependencies)}${dependencies("ขัดแย้งกับ memory (ยังคงทั้งสองข้อไว้)", c.conflicts)}${decision(c.decision)}</details></article>`;
}

/** Renders exact claim lineage without any model calls or inferred owner authority. */
export function memoryClaimPage(state: import("./memory/types").ClaimLookup, project: Project, workspace: Workspace, csrf: string): string {
  return shell("ที่มาของ memory", { workspace, csrf, project, section: "memory" }, `<div class="content memory-content"><p><a href="/projects/${project.id}/memory">กลับไป memory ของโครงการ</a></p>${memoryClaimContent(state, project.id)}</div>`);
}

const contextLayers: Record<import("./memory/types").ContextProvenanceEntry["layer"], string> = {
  project_constraint: "ข้อผูกพันและมติปัจจุบัน (สถานะโครงการ ไม่ใช่ memory)", explicit_preference: "สิ่งที่คุณระบุไว้ในโครงการนี้",
  source_evidence: "ต้นฉบับที่เลือกให้ run นี้", inference: "ข้ออนุมาน (ไม่ใช่ข้อกำหนด)",
};
function contextEntry(entry: import("./memory/types").MemoryContextView["entries"][number]): string {
  const p = entry.projectId, version = `revision ${entry.revision}${entry.generation === null ? "" : ` · generation ${entry.generation}`}`;
  const href = entry.kind === "task" ? `/projects/${p}/tasks/${entry.id}`
    : entry.kind === "decision" ? `/projects/${p}/topics/${entry.topicId}#owner-decision`
    : entry.kind === "claim" ? claimUrl(p, { claimId: entry.id, revision: entry.revision, generation: entry.generation! })
    : `/projects/${p}/sources/${entry.id}?revision=${entry.revision}&generation=${entry.generation}`;
  const label = entry.kind === "task" ? `งาน ${entry.status}` : entry.kind === "decision" ? "มติของคุณ"
    : entry.kind === "claim" ? (entry.claimKind === "explicit_fact" ? "Fact: owner กล่าวไว้" : "Inference") : "ต้นฉบับ";
  return `<li data-context-entry="${escape(entry.kind)}" data-current="${entry.current}"><a href="${escape(href)}">${escape(label)} · ${escape(entry.id)}</a> · ${version}${entry.scope === "cross_project" ? ` · จากโครงการอื่น ${escape(p)} (ไม่ใช่ความชอบของโครงการนี้)` : ""}
    ${entry.current ? "" : ` · <strong>ไม่เป็นปัจจุบันแล้ว: ${escape(entry.reason ?? "unavailable")}</strong>`}${entry.text ? `<p class="literal">${escape(entry.text)}</p>` : ""}
    ${entry.source && entry.kind !== "source" ? sourceLink(p, entry.source, `หลักฐาน revision ${entry.source.revision} · generation ${entry.source.generation}`) : ""}</li>`;
}
function contextPanel(state: import("./memory/types").MemoryContextView, title: string): string {
  const r = state.record, o = r.omitted;
  const groups = (Object.keys(contextLayers) as (keyof typeof contextLayers)[]).map(layer => {
    const items = state.entries.filter(entry => entry.layer === layer);
    return items.length ? `<h4>${contextLayers[layer]}</h4><ul>${items.map(contextEntry).join("")}</ul>` : "";
  }).join("");
  const notes = [
    o.constraints || o.claims || o.budget ? `บริบทไม่ครบ: ละงาน/มติ ${o.constraints} และ memory ${o.claims} รายการตามงบ` : "",
    o.loopGuard ? "ไม่ดึง memory เพิ่ม เพราะอินพุตมาจากคำตอบที่ใช้ memory แล้ว (loop guard)" : "",
    o.unavailable ? `memory ที่ถูกถอนหรือไม่พร้อมใช้ ${o.unavailable} รายการไม่ถูกนำมาใช้` : "",
    state.entries.some(entry => entry.layer !== "source_evidence") ? "" : "ไม่มีสถานะโครงการหรือ memory ที่อ้างอิงได้สำหรับ run นี้",
  ].filter(Boolean).map(text => `<p role="note">${escape(text)}</p>`).join("");
  const conflicts = r.conflicts.length ? `<h4>ข้อขัดแย้งที่ต้องให้คุณตัดสิน</h4><ul>${r.conflicts.map(item => `<li><a href="${claimUrl(item.claim.projectId, item.claim)}">${escape(item.claim.claimId)}</a> ↔ <a href="${claimUrl(item.claim.projectId, item.with)}">${escape(item.with.claimId)}</a>${item.included ? "" : " · อีกฝั่งไม่อยู่ในบริบทนี้"}</li>`).join("")}</ul>` : "";
  return `<section class="team-card" id="context-${r.id}" aria-label="${escape(title)}"><h3>${escape(title)}</h3>
    <p>app.memory_context/v1 · policy ${r.policy.version} · ${state.current ? "ทุกรายการยังเป็นปัจจุบัน" : "<strong>บางรายการเปลี่ยนแล้ว ผลที่ใช้บริบทนี้ไม่ถูกนับเป็นปัจจุบัน</strong>"} · ${r.complete ? "ครบตามงบ" : "ไม่ครบ"}</p>
    ${notes}${groups}${conflicts}<p><a href="/projects/${r.projectId}/memory/contexts/${r.id}">ดู context ที่ run ใช้</a> · ${time(r.snapshot.assembledAt)}</p></section>`;
}

/** app.context_provenance/v1: what one run was allowed to use, with current lifecycle status and clickable evidence. */
export function memoryContextPage(state: ReturnType<Application["memoryContext"]>, workspace: Workspace, csrf: string): string {
  const { project, ...view } = state;
  return shell("บริบทที่ run ใช้", { workspace, csrf, project, section: "memory" }, `<div class="content memory-content">${contextPanel(view, view.record.owner.kind === "synthesis" ? "บริบทของผู้ประสานงาน" : "บริบทของการหารือ")}
    <p><a href="/projects/${project.id}/memory">กลับไป memory ของโครงการ</a></p></div>`, { breadcrumb: { title: project.name, href: `/projects/${project.id}` } });
}

/** Renders bounded source selection, fixture extraction status and active-generation claim inspection. */
export function memoryPage(state: ReturnType<Application["memory"]>, workspace: Workspace, csrf: string, limits: JobLimits, cursor: { after: number; sourceAfter: number; extractionAfter: number }): string {
  const p = state.project, roles = state.team.roles.filter(role => role.enabled && role.effective.route);
  const href = (patch: Partial<typeof cursor>) => `/projects/${p.id}/memory?${new URLSearchParams({ q: state.query, ...Object.fromEntries(Object.entries({ ...cursor, ...patch }).map(([k, v]) => [k, String(v)])) })}`;
  const available = state.extractionAvailable && roles.length && state.topics.length && state.sources.some(item => item.source.state === "available");
  return shell("Memory ของโครงการ", { workspace, csrf, project: p, topics: state.topics, section: "memory" }, `<div class="content memory-content"><section class="hero"><h2>ความจำที่ตรวจที่มาได้</h2><p>Fact ยืนยันเพียงว่า owner กล่าวข้อความนั้น ข้ออนุมานยังไม่ใช่ preference หรือ decision ที่รับรองแล้ว ข้อความที่ขัดกันคงอยู่พร้อมกัน งานและมติปัจจุบันดูได้ที่ <a href="/projects/${p.id}/tasks">ข้อผูกพัน</a> และหัวข้อของโครงการ</p><p>การสกัดในรุ่นนี้เป็นตัวอย่างจำลอง (fixture) ยังไม่ได้เรียก provider จริง</p></section>
    <form class="team-form" method="get"><label>ค้นหา memory <input name="q" value="${escape(state.query)}" maxlength="200" placeholder="คำภาษาไทยหรือ English"></label><button>ค้นหา</button></form>
    <section><h2>Memory ที่บันทึกแล้ว</h2>${state.items.length ? state.items.map(item => memoryClaimContent(item, p.id)).join("") : '<p class="empty-list">ยังไม่มี memory ที่ตรงกับคำค้นในหน้านี้</p>'}
    <nav class="pagination">${cursor.after ? `<a href="${escape(href({ after: 0 }))}">Memory หน้าแรก</a>` : ""}${state.nextAfter !== null ? `<a href="${escape(href({ after: state.nextAfter }))}">Memory ถัดไป</a>` : ""}</nav></section>
    <section><h2>สกัดจากต้นฉบับที่บันทึกแล้ว</h2><p>หนึ่งคำขอต่อต้นฉบับ revision/generation เดียวกัน การ refresh ไม่เริ่มงานใหม่ ผลการสกัดไม่สร้างต้นฉบับใหม่ จึงไม่สกัดวนซ้ำเอง</p>
    ${available ? `<form class="team-form" method="post" action="/projects/${p.id}/memory">${hiddenCommand(csrf, p.revision)}<input type="hidden" name="limits" value="${escape(JSON.stringify(limits))}">
      <label>บทบาท <select name="roleId">${roles.map(role => `<option value="${role.id}">${escape(role.name)} · ${escape(role.effective.route!.model)}</option>`).join("")}</select></label>
      <label>หัวข้อที่เกี่ยวข้อง <select name="topicId">${state.topics.map(topic => `<option value="${topic.id}">${escape(topic.title)}</option>`).join("")}</select></label>
      <label>ต้นฉบับ <select name="source">${state.sources.map(({ source, decision }) => source.state === "available" ? `<option value="${escape(JSON.stringify(source.reference))}">${escape(decision ? "มติ owner" : source.descriptor.kind)} · ${escape(Array.from(source.text).slice(0, 80).join(""))}</option>` : "").join("")}</select></label>
      <label>อ้างอิง memory เดิม <select name="dependencies"><option value="[]">ไม่อ้างอิง</option>${state.items.map(item => item.state === "available" ? `<option value="${escape(JSON.stringify([{ claimId: item.claim.claimId, revision: item.claim.revision, generation: item.claim.generation }]))}">${escape(Array.from(item.claim.text).slice(0, 80).join(""))}</option>` : "").join("")}</select></label><button class="primary">สกัดตัวอย่างจำลอง</button></form>` : '<p>เปิดใช้บทบาทที่มี route สร้างหัวข้อ และตรวจว่าคิวพร้อมก่อนเริ่มสกัด</p>'}
      <nav class="pagination">${cursor.sourceAfter ? `<a href="${escape(href({ sourceAfter: 0 }))}">ต้นฉบับหน้าแรก</a>` : ""}${state.sourcesNextAfter !== null ? `<a href="${escape(href({ sourceAfter: state.sourcesNextAfter }))}">ต้นฉบับถัดไป</a>` : ""}</nav></section>
    <section><h2>ผลการสกัดและสิ่งที่ยังไม่ครบ</h2>${state.extractions.map(e => `<article class="team-card" id="extraction-${e.id}"><p>${escape(e.state)} · ${escape(e.reason)} · fixture · ${escape(e.extractor)} · policy ${e.policy}</p><p>คิว: ${escape(e.job.state)} · ${escape(e.job.reason)} · ${escape(e.job.nextAction)} · <a href="/projects/${p.id}/jobs/${e.jobId}">ตรวจและหยุดงาน</a></p><p>${e.claimIds.length} claims · ปฏิเสธ ${e.rejected} ข้อ</p><p>Route ที่ตั้งไว้: ${escape(e.route.provider)} / ${escape(e.route.model)} (ยังไม่ยืนยัน live access)</p><p>${sourceLink(p.id, e.source.reference, `ต้นฉบับ ${e.source.state}`)}</p></article>`).join("") || '<p>ยังไม่มีคำขอสกัด</p>'}
    <nav class="pagination">${cursor.extractionAfter ? `<a href="${escape(href({ extractionAfter: 0 }))}">ผลสกัดหน้าแรก</a>` : ""}${state.extractionsNextAfter !== null ? `<a href="${escape(href({ extractionAfter: state.extractionsNextAfter }))}">ผลสกัดถัดไป</a>` : ""}</nav></section></div>`);
}
