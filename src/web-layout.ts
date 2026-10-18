import type { Application, Project, Workspace } from "./application";
import type { Topic } from "./conversation";
import type { Attribution, SourceLookup, SourceReference } from "./sources";

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
    <a class="nav-main" href="${selected ? `/projects/${selected.id}#new-topic` : "/#new-project"}">${icon("plus")}<span>${selected ? "หัวข้อใหม่" : "โครงการใหม่"}</span></a>
    ${selected ? `<p class="nav-heading">หัวข้อในโครงการ</p><p class="nav-project">${escape(selected.name)}</p>
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
  return shell(title, { workspace, csrf, project, topics, topic }, `<div class="content chat-content"><section aria-label="ประวัติข้อความ">${state.items.length ? state.items.map(m => `<article class="message${m.attribution.kind === "owner" ? " message--owner" : ""}" data-message-id="${m.id}"><div class="message-body">${m.text === null ? '<p class="literal">ต้นฉบับไม่พร้อมใช้งาน</p>' : literalContent(m.text)}</div>
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
/** Renders local owner sign-in without scripts, external assets or credentials in markup. */
export function loginPage(): string {
  return documentPage("เข้าสู่ระบบ", `<main class="auth" id="main-content"><div class="auth-card">${brand()}<h1>กลับมาทำงานต่อ</h1><p>พื้นที่สำหรับโครงการและไอเดียของคุณ</p><form method="post" action="/login"><label for="password">รหัสผ่าน owner</label><input id="password" name="password" type="password" maxlength="256" required autocomplete="current-password"><button class="primary">เข้าสู่ระบบ</button></form><footer class="auth-footer">Jit · พื้นที่โครงการส่วนตัว</footer></div></main>`);
}
/** Renders a safe fixed rejection message with accessible recovery navigation. */
export function errorPage(message: string): string {
  return documentPage("ตรวจสอบคำสั่ง", `<main class="auth" id="main-content"><div class="auth-card">${brand()}<h1>ตรวจสอบคำสั่ง</h1><p class="error" role="alert">${escape(message)}</p><div class="error-actions"><a href="/">เปิดหน้าโครงการ</a><a href="/login">เข้าสู่ระบบ</a></div></div></main>`);
}
