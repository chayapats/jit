/** Shared responsive owner UI. Local stylesheet only: no remote fonts, scripts, assets, or telemetry. */
export const styleSheet = `
:root {
  color-scheme: dark;
  --canvas: #0e1218;
  --sidebar: #0c1016;
  --surface: #171c27;
  --surface-2: #212838;
  --line: #2c3548;
  --line-strong: #3d4b66;
  --text: #f4f6fb;
  --muted: #a8b0c2;
  --faint: #8b95a8;
  --accent: #8ea0ff;
  --accent-press: #3f51d8;
  --accent-hover: #5466ea;
  --link: #c5d0ff;
  --danger: #ffb8bc;
  --danger-bg: #3a1d24;
  --danger-line: #7a3944;
  --ok: #9be7c4;
  --ok-bg: #123226;
  --ok-line: #1f6b48;
  --warn: #f3d48a;
  --warn-bg: #3a2e12;
  --warn-line: #7a6230;
  --info-bg: #1a2344;
  --info-line: #3d4d86;
  --shadow: 0 18px 50px rgba(0, 0, 0, .38);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  background: var(--canvas);
  color: var(--text);
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--canvas); color: var(--text); -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
button, input, textarea, select, summary { font: inherit; color: inherit; }
button, a, summary, input, textarea { -webkit-tap-highlight-color: transparent; }
button, summary { cursor: pointer; }
svg { width: 20px; height: 20px; flex-shrink: 0; vertical-align: middle; }
a, button, summary { touch-action: manipulation; }
a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
h1, h2, h3, p { margin: 0; }
h1, h2, h3 { font-weight: 620; letter-spacing: -.02em; line-height: 1.3; }
p { line-height: 1.65; }
ul { list-style: none; padding: 0; margin: 0; }
strong { font-weight: 650; }
::selection { background: #31408f; color: white; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.skip { position: fixed; z-index: 30; top: -80px; left: 12px; background: var(--text); color: var(--canvas); padding: 10px 12px; border-radius: 8px; font-weight: 650; }
.skip:focus { top: 12px; }

button, .header-action {
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  min-height: 36px;
  padding: 8px 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.2;
  white-space: nowrap;
}
button:hover, .header-action:hover { background: var(--surface-2); border-color: var(--line-strong); }
.primary {
  background: var(--accent-press);
  color: white;
  border-color: transparent;
}
.primary:hover { background: var(--accent-hover); color: white; }
button.danger {
  background: transparent;
  color: var(--danger);
  border-color: var(--danger-line);
}
button.danger:hover { background: var(--danger-bg); color: var(--danger); }
button:active, .primary:active { transform: translateY(1px); }
.icon-button, .send-button {
  border: 0;
  padding: 0;
  min-height: 0;
  background: transparent;
  color: var(--muted);
}
.icon-button { width: 36px; height: 36px; border-radius: 8px; }
.icon-button:hover { background: var(--surface-2); color: var(--text); }
.send-button {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--accent-press);
  color: white;
}
.send-button:hover { background: var(--accent-hover); color: white; }
.send-button svg { width: 18px; height: 18px; }

.app { display: grid; grid-template-columns: 248px minmax(0, 1fr); height: 100dvh; overflow: hidden; }
.sidebar {
  background: var(--sidebar);
  border-right: 1px solid var(--line);
  display: flex;
  flex-direction: column;
  padding: 16px 12px 12px;
  min-height: 0;
}
.brand { display: flex; align-items: center; gap: 10px; padding: 4px 8px 18px; font-size: 16px; font-weight: 680; letter-spacing: -.03em; }
.brand svg { width: 28px; height: 28px; padding: 5px; box-sizing: border-box; border-radius: 8px; background: var(--accent-press); color: white; }
.nav-main, .nav-link {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 7px 10px;
  border-radius: 8px;
  color: var(--muted);
  font-size: 13.5px;
  font-weight: 550;
}
.nav-main svg, .nav-link svg { width: 16px; height: 16px; }
.nav-main:hover, .nav-link:hover { background: var(--surface); color: var(--text); }
.nav-main[aria-current=page], .nav-link[aria-current=page] {
  background: var(--surface-2);
  color: var(--text);
  box-shadow: inset 2px 0 0 var(--accent);
}
.nav-link span, .nav-main span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-heading {
  padding: 18px 10px 6px;
  font-size: 12px;
  font-weight: 650;
  color: var(--muted);
}
.nav-scroll { overflow: auto; min-height: 0; flex: 1; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
.nav-subtle { display: block; padding: 8px 10px; font-size: 12px; font-weight: 600; color: var(--muted); }
.nav-subtle:hover { color: var(--text); }
.nav-project { font-size: 13px; font-weight: 600; color: var(--text); padding: 0 10px 8px; overflow-wrap: anywhere; }
.owner-menu { border-top: 1px solid var(--line); margin-top: 12px; padding: 12px 6px 0; display: flex; align-items: center; gap: 10px; }
.avatar {
  width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center;
  background: var(--info-bg); color: var(--link); border: 1px solid var(--info-line); flex-shrink: 0;
}
.avatar svg { width: 16px; height: 16px; }
.owner-name { font-size: 13px; font-weight: 600; flex: 1; min-width: 0; }
.owner-name small { display: block; color: var(--muted); font-size: 11px; font-weight: 500; margin-top: 2px; }
.owner-menu form { margin: 0; }

.main-pane { display: flex; flex-direction: column; height: 100dvh; min-width: 0; min-height: 0; background: var(--canvas); }
.app-header {
  min-height: 56px;
  padding: 10px 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--line);
  background: var(--canvas);
}
.header-title { min-width: 0; }
.header-title h1 { font-size: 14px; font-weight: 620; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 62vw; }
.breadcrumb { color: var(--muted); font-size: 12px; font-weight: 550; display: block; margin-bottom: 2px; max-width: 62vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.breadcrumb:hover { color: var(--text); }
.header-action svg { width: 15px; height: 15px; }
.scroll-region { flex: 1; overflow: auto; min-height: 0; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
.content { width: min(100%, 960px); margin: 0; padding: 28px 32px 64px; }
.hero { text-align: left; padding: 4px 0 20px; max-width: 42rem; }
.hero h1, .hero h2 { font-size: 24px; line-height: 1.25; font-weight: 650; letter-spacing: -.025em; }
.hero p { color: var(--muted); font-size: 14px; margin-top: 8px; max-width: 40rem; }
.eyebrow { color: var(--muted); font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.section-heading {
  font-size: 13px;
  font-weight: 650;
  color: var(--text);
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 28px 0 10px;
}
.create-form {
  border: 1px solid var(--line-strong);
  background: var(--surface);
  border-radius: 12px;
  padding: 6px 6px 6px 14px;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 0 0 28px;
  scroll-margin-top: 16px;
}
.create-form input {
  background: transparent;
  border: 0;
  min-width: 0;
  flex: 1;
  width: 100%;
  padding: 10px 0;
  color: var(--text);
  font-size: 14px;
}
.create-form input:focus-visible, .composer textarea:focus-visible { outline: none; }
.create-form:focus-within, .composer:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent); }
.create-form input::placeholder, .composer textarea::placeholder, .team-form input::placeholder, .team-form textarea::placeholder { color: var(--faint); }
.create-form .primary { border-radius: 8px; }
.create-form:has(select) {
  display: grid;
  align-items: stretch;
  gap: 12px;
  padding: 16px;
}
.create-form:has(select) label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 650; }
.create-form:has(select) input:not([type=hidden]), .create-form:has(select) select {
  width: 100%;
  min-width: 0;
  color: var(--text);
  background: var(--canvas);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  min-height: 40px;
  padding: 8px 12px;
}
.create-form:has(select) .primary { justify-self: start; }
.project-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.project-card {
  display: block;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 12px;
  min-width: 0;
  background: var(--surface);
  color: inherit;
  text-decoration: none;
}
.project-card:hover { background: var(--surface-2); border-color: var(--line-strong); }
.project-card svg {
  width: 16px; height: 16px; padding: 8px; box-sizing: content-box; border-radius: 8px;
  background: var(--info-bg); color: var(--link); margin-bottom: 14px;
}
.project-card h2 { font-size: 15px; font-weight: 620; overflow-wrap: anywhere; line-height: 1.45; }
.project-card p { color: var(--muted); font-size: 13px; margin-top: 4px; }
.topic-row { display: flex; align-items: center; gap: 12px; min-width: 0; border-bottom: 1px solid var(--line); padding: 14px 8px; border-radius: 8px; }
.topic-row:hover { background: var(--surface); }
.topic-row > svg { color: var(--faint); width: 16px; height: 16px; }
.topic-row-main { min-width: 0; flex: 1; }
.topic-row-main h3 { font-size: 14px; font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
.topic-row-main h3 a:hover, .job-card h3 a:hover, .team-card h3 a:hover { text-decoration: underline; text-underline-offset: 3px; }
.topic-row time, .topic-row-main p { font-size: 12px; color: var(--muted); display: block; margin-top: 4px; }
.source-link { font-size: 12px; font-weight: 600; color: var(--muted); white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; text-decoration: none; }
.source-link svg { width: 14px; height: 14px; }
.source-link:hover { color: var(--text); }
.content p a, .team-card li a {
  color: var(--link);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: color-mix(in srgb, var(--link) 45%, transparent);
}
.content p a:hover, .team-card li a:hover { text-decoration-color: var(--link); }
.empty-list {
  border: 1px dashed var(--line-strong);
  background: color-mix(in srgb, var(--surface) 72%, transparent);
  border-radius: 12px;
  padding: 28px 16px;
  color: var(--muted);
  text-align: center;
  font-size: 13px;
}
.pagination { display: flex; justify-content: flex-start; gap: 8px; padding: 20px 0 0; font-size: 13px; }
.pagination a {
  display: inline-flex; align-items: center; min-height: 32px; padding: 0 12px;
  border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface); color: var(--text); font-weight: 600; text-decoration: none;
}
.pagination a:hover { background: var(--surface-2); }

.empty-chat { min-height: 280px; display: flex; align-items: center; justify-content: center; text-align: center; }
.empty-chat svg { width: 28px; height: 28px; color: var(--link); margin-bottom: 14px; padding: 10px; box-sizing: content-box; border-radius: 12px; background: var(--info-bg); }
.empty-chat h2 { font-size: 20px; letter-spacing: -.02em; font-weight: 650; }
.empty-chat p { color: var(--muted); font-size: 13px; margin-top: 8px; }
.chat-content { padding-top: 24px; padding-bottom: 24px; }
.chat-content > .team-card { margin-bottom: 12px; }
.message { display: flex; flex-direction: column; align-items: flex-start; margin: 0 0 22px; gap: 6px; min-width: 0; }
.message--owner { align-items: flex-end; }
.message-body { max-width: min(100%, 68ch); min-width: 0; font-size: 14px; line-height: 1.7; }
.message--owner .message-body { background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px 12px 4px 12px; padding: 10px 14px; }
.literal { white-space: pre-wrap; overflow-wrap: anywhere; color: inherit; }
.literal + .literal { margin-top: 10px; }
pre { margin: 10px 0; background: var(--canvas); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow-x: auto; max-width: 100%; line-height: 1.6; tab-size: 2; }
code { font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; overflow-wrap: normal; }
pre:first-child { margin-top: 0; }
pre:last-child { margin-bottom: 0; }
.message-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; color: var(--muted); font-size: 12px; max-width: min(100%, 68ch); }
.message-meta .source-link { font-size: 11px; }
.message-meta details[open] { flex-basis: 100%; text-align: right; }
.message-meta details[open] summary { justify-content: flex-end; }
.message-meta summary { list-style: none; display: flex; align-items: center; gap: 4px; min-height: 24px; padding: 2px 4px; color: var(--muted); }
.message-meta summary::-webkit-details-marker { display: none; }
.message-meta summary svg { width: 14px; height: 14px; }
.message-detail { display: inline-block; max-width: 100%; margin-top: 6px; padding: 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--muted); line-height: 1.7; text-align: left; }
.message-detail .source-link { margin-top: 8px; }
.committed { color: var(--ok); display: inline-flex; align-items: center; gap: 4px; }
.committed svg { width: 12px; height: 12px; }
.composer-wrap { flex-shrink: 0; width: 100%; padding: 12px 32px max(16px, env(safe-area-inset-bottom)); background: var(--canvas); border-top: 1px solid var(--line); }
.composer { width: min(100%, 896px); margin: 0; padding: 12px 12px 10px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface); }
.composer textarea { display: block; width: 100%; resize: none; field-sizing: content; min-height: 52px; max-height: 180px; color: var(--text); border: 0; background: transparent; line-height: 1.6; font-size: 14px; padding: 0; }
.composer-bottom { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 8px; }
.composer-topic { font-size: 12px; color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
.composer-topic svg { width: 14px; height: 14px; }
.composer-note { text-align: left; color: var(--muted); font-size: 12px; margin: 8px 0 0; width: min(100%, 896px); }
.mobile-menu { display: none; }

.auth { min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; background: var(--canvas); }
.auth-card { width: min(100%, 400px); background: var(--surface); border: 1px solid var(--line); border-radius: 16px; padding: 28px 24px 20px; box-shadow: var(--shadow); }
.auth-card .brand { justify-content: flex-start; padding: 0 0 20px; }
.auth-card h1 { text-align: left; font-size: 22px; }
.auth-card > p { text-align: left; font-size: 14px; color: var(--muted); margin: 8px 0 20px; }
.auth-card label { display: block; color: var(--muted); font-size: 12px; font-weight: 650; margin: 0 0 8px; }
.auth-card input { width: 100%; background: var(--canvas); color: var(--text); border: 1px solid var(--line-strong); border-radius: 8px; min-height: 42px; padding: 10px 12px; }
.auth-card .primary { width: 100%; margin-top: 16px; min-height: 42px; }
.auth-footer { margin-top: 18px; text-align: left; font-size: 12px; color: var(--faint); }
.error { border: 1px solid var(--danger-line); background: var(--danger-bg); color: var(--danger); border-radius: 10px; padding: 12px 14px; margin: 12px 0; }
.error-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.error-actions a {
  display: inline-flex; align-items: center; min-height: 36px; padding: 0 12px; border-radius: 8px;
  border: 1px solid var(--line-strong); background: var(--canvas); color: var(--text); font-size: 13px; font-weight: 600; text-decoration: none;
}
.error-actions a:hover { background: var(--surface-2); }
.source-content h1 { font-size: 24px; margin-bottom: 8px; }
.source-content > .source-byline { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
.source-content .literal { font-size: 15px; line-height: 1.7; }
.source-details { border: 1px solid var(--line); border-radius: 12px; background: var(--surface); margin-top: 28px; padding: 14px 16px; }
.source-details summary { color: var(--text); font-size: 13px; font-weight: 650; }
.source-details dl { font-size: 13px; line-height: 1.6; }
.source-details dt { color: var(--muted); margin-top: 12px; font-weight: 600; }
.source-details dd { margin: 2px 0 0; overflow-wrap: anywhere; color: var(--text); }

.jobs-heading { margin: 4px 0 20px; max-width: 42rem; }
.jobs-heading h2 { font-size: 24px; font-weight: 650; overflow-wrap: anywhere; }
.jobs-heading p { font-size: 14px; color: var(--muted); margin-top: 8px; }
.job-create, .job-card, .team-card {
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 16px;
  margin: 0 0 12px;
  background: var(--surface);
  overflow-wrap: anywhere;
}
.job-create { display: grid; gap: 12px; }
.job-create label, .team-form label, .job-card form label { display: grid; gap: 6px; color: var(--muted); font-size: 12px; font-weight: 650; }
.job-create input:not([type=hidden]), .job-create select, .team-form input:not([type=hidden]), .team-form select, .team-form textarea, .team-content > form input:not([type=hidden]), .team-content > form select, .team-content > form textarea, .job-card form input:not([type=hidden]), .job-card form select, .job-card form textarea {
  width: 100%;
  min-width: 0;
  color: var(--text);
  background: var(--canvas);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  min-height: 40px;
  padding: 8px 12px;
}
.team-form textarea { resize: vertical; min-height: 96px; line-height: 1.55; }
.job-create input[type=hidden], .team-form input[type=hidden] { display: none; }
.job-create p, .job-card p, .team-card p { font-size: 14px; color: var(--muted); margin-block: 8px; }
.job-card > p:first-of-type, .team-card > p:first-of-type { color: var(--text); }
.job-create-actions { display: flex; gap: 10px; align-items: center; }
.job-create-actions select { flex: 1; }
.job-create-actions button { flex-shrink: 0; }
.job-card header, .team-card > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.job-card h3, .team-card h3 { font-size: 15px; font-weight: 640; }
.job-card h3 a, .team-card h3 a { color: inherit; text-decoration: none; }
.job-status {
  display: inline-flex; align-items: center; flex-shrink: 0; max-width: 100%;
  font-size: 12px; font-weight: 650; line-height: 1.3; border: 1px solid var(--line-strong); border-radius: 999px;
  padding: 3px 8px; color: var(--muted); background: var(--surface-2); white-space: nowrap;
}
.job-status[data-state="succeeded"], .job-status[data-state="accepted"], .job-status[data-state="completed"] { color: var(--ok); background: var(--ok-bg); border-color: var(--ok-line); }
.job-status[data-state="failed"], .job-status[data-state="dismissed"], .job-status[data-state="cancelled"], .job-status[data-state="stopped"] { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-line); }
.job-status[data-state="blocked"], .job-status[data-state="partial"], .job-status[data-state="waiting"] { color: var(--warn); background: var(--warn-bg); border-color: var(--warn-line); }
.job-status[data-state="admitted"], .job-status[data-state="running"], .job-status[data-state="proposed"], .job-status[data-state="queued"], .job-status[data-state="specialist"], .job-status[data-state="coordinator"] { color: var(--link); background: var(--info-bg); border-color: var(--info-line); }
.job-status[data-state="disabled"], .job-status[data-state="skipped"], .job-status[data-state="excluded"] { color: var(--faint); background: transparent; }
.job-route { margin-top: 4px; color: var(--muted); }
.job-card form { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
.job-card form label { flex: 1 1 200px; }
.job-evidence { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 14px; font-size: 14px; color: var(--text); }
.job-card details, .job-create details, .team-card details { font-size: 13px; color: var(--muted); margin-top: 12px; }
.job-card summary, .job-create summary, .team-card summary, .source-details summary { cursor: pointer; }
.job-limits { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px 16px; margin-top: 12px; }
.job-limits dt, .job-limits dd { margin: 0; overflow-wrap: anywhere; }
.job-limits dt { color: var(--faint); font-size: 12px; }
.job-limits dd { color: var(--text); font-size: 13px; }

.team-content { max-width: none; }
.team-notice {
  border: 1px solid var(--info-line);
  border-left: 3px solid var(--accent);
  background: var(--info-bg);
  border-radius: 10px;
  padding: 12px 14px;
  margin: 0 0 16px;
  color: var(--text);
  font-size: 13px;
  line-height: 1.6;
}
.team-card > header h3 { font-size: 16px; }
.team-card .literal { color: var(--text); }
.team-card ul { display: grid; gap: 8px; margin: 8px 0; }
.team-card li { padding-left: 10px; border-left: 2px solid var(--line-strong); font-size: 14px; line-height: 1.6; color: var(--text); }
.team-form { display: grid; gap: 14px; }
.team-card .team-form, .job-card .team-form { padding-top: 4px; }
.team-form small, .team-form p, .create-form small { color: var(--muted); font-size: 12px; font-weight: 500; line-height: 1.6; }
.team-form > .primary, .team-form > button { justify-self: start; }
.team-content > form, .team-content > details {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 12px;
  padding: 14px 16px;
  margin: 0 0 12px;
}
.team-content > form:not(.team-form) { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
.team-content > form:not(.team-form) label { display: grid; gap: 6px; flex: 1 1 280px; color: var(--muted); font-size: 12px; font-weight: 650; }
.team-content > form:not(.team-form) small { flex-basis: 100%; }
div.team-form { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 8px; }
div.team-form form { margin: 0; }
details.team-card > summary, .team-content > details > summary {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-weight: 650;
  font-size: 14px;
  color: var(--text);
  min-height: 28px;
}
details.team-card > summary::-webkit-details-marker, .team-content > details > summary::-webkit-details-marker { display: none; }
details.team-card > summary::after, .team-content > details > summary::after {
  content: "";
  width: 7px; height: 7px; flex-shrink: 0;
  border-right: 1.5px solid var(--muted);
  border-bottom: 1.5px solid var(--muted);
  transform: translateY(-2px) rotate(45deg);
}
details.team-card[open] > summary::after, .team-content > details[open] > summary::after { transform: translateY(2px) rotate(-135deg); }
details.team-card > summary { margin-bottom: 0; }
details.team-card[open] > summary { margin-bottom: 8px; }
.team-route {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 180px), 1fr));
  gap: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 12px;
  min-width: 0;
  margin: 0;
}
.team-route legend { padding: 0 6px; color: var(--text); font-size: 12px; font-weight: 650; }
.team-preview { border-top: 1px solid var(--line); margin-top: 16px; padding-top: 4px; }
.team-effective { font-size: 13px; color: var(--text); background: var(--canvas); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.team-effective small { color: var(--muted); }
.team-card pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.team-content > p { margin: 4px 0 12px; }

@media (min-width: 1500px) {
  .app { grid-template-columns: 264px minmax(0, 1fr); }
}
@media (max-width: 900px) {
  .app { grid-template-columns: 220px minmax(0, 1fr); }
  .sidebar { padding-inline: 10px; }
  .content, .app-header, .composer-wrap { padding-inline: 20px; }
  .composer, .composer-note { width: min(100%, 920px); }
  .hero h1, .hero h2, .jobs-heading h2, .source-content h1 { font-size: 22px; }
  .message-body, .message-meta { max-width: 100%; }
}
@media (max-width: 680px) {
  .app { display: block; }
  .sidebar { display: none; }
  .main-pane { height: 100dvh; }
  .app-header { min-height: 56px; padding: 10px 12px; gap: 10px; }
  .header-title { flex: 1; }
  .header-title h1, .breadcrumb { max-width: 58vw; }
  .header-action { padding: 8px; font-size: 0; gap: 0; }
  .header-action svg { width: 18px; height: 18px; }
  .mobile-menu { display: block; flex-shrink: 0; }
  .mobile-menu > summary { list-style: none; display: grid; place-items: center; width: 36px; height: 36px; color: var(--text); border-radius: 8px; }
  .mobile-menu > summary::-webkit-details-marker { display: none; }
  .mobile-menu[open] > summary { background: var(--surface-2); }
  .mobile-menu-content {
    position: absolute; z-index: 20; top: 60px; left: 10px; right: 10px; max-height: min(78dvh, 680px); overflow: auto;
    padding: 12px; background: var(--surface); border: 1px solid var(--line-strong); border-radius: 12px; box-shadow: var(--shadow);
  }
  .mobile-menu-content .nav-heading { padding-top: 14px; }
  .content { padding: 20px 16px 40px; }
  .hero { padding-bottom: 16px; }
  .hero h1, .hero h2, .jobs-heading h2 { font-size: 22px; }
  .create-form:not(:has(select)) { padding-left: 12px; gap: 8px; }
  .create-form:not(:has(select)) .primary { font-size: 0; width: 40px; min-width: 40px; height: 40px; padding: 0; gap: 0; }
  .create-form:not(:has(select)) .primary svg { width: 18px; height: 18px; }
  .project-grid { grid-template-columns: 1fr; }
  .chat-content { padding-top: 16px; }
  .message-body { font-size: 14px; }
  .composer-wrap { padding: 10px 12px max(12px, env(safe-area-inset-bottom)); }
  .composer textarea, .team-form input, .team-form textarea, .team-form select, .job-create input, .job-create select, .auth-card input, .create-form input, .create-form select { font-size: 16px; }
  .empty-chat { min-height: 200px; }
  .source-link { white-space: normal; }
  .topic-row { gap: 10px; align-items: flex-start; }
  .team-card, .job-card, .job-create { padding: 14px; }
  .team-card > header, .job-card header { align-items: flex-start; }
  .team-route, .job-limits { grid-template-columns: 1fr; }
  .job-status { white-space: normal; }
}
@media (max-height: 480px) {
  .main-pane { overflow: auto; }
  .app-header { min-height: 48px; padding-block: 6px; }
  .scroll-region { min-height: 64px; }
  .composer-wrap { padding-block: 8px; }
  .composer { padding: 8px 10px; }
  .composer textarea { min-height: 28px; max-height: clamp(28px, 20dvh, 96px); }
  .composer-note { display: none; }
}
.memory-content { overflow-wrap: anywhere; }
.memory-content section { margin-block: 24px; }
.memory-content .team-card { margin-block: 14px; }
.memory-content .team-card h2 { font-size: 16px; }
.memory-content .team-form { margin-block: 16px; }
.memory-content .team-form label, .memory-content .team-form select { min-width: 0; max-width: 100%; }
.memory-content blockquote { margin: 12px 0; border-left: 2px solid var(--line-strong); padding-left: 14px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; }
  button:active, .primary:active { transform: none; }
}
`;
