import { effectTokens, scaleTokens, themeDeclarations } from "./web-design";

/**
 * The shared owner stylesheet, generated from ui.design_tokens/v1 (src/web-design.ts).
 * Dark is the default; light applies under `prefers-color-scheme: light` unless the owner chose dark,
 * or whenever the owner chose light (`<html data-theme>`). Fonts are self-hosted through the hashed asset
 * table, so the stylesheet takes their URLs. No remote fonts, scripts, assets or telemetry.
 */
export function styleSheet(fonts: { inter: string; thai: string; mono: string }): string {
  return `
@font-face { font-family: "Inter"; src: url("${fonts.inter}") format("woff2"); font-weight: 100 900; font-style: normal; font-display: swap; }
@font-face { font-family: "Noto Sans Thai"; src: url("${fonts.thai}") format("woff2"); font-weight: 400 700; font-style: normal; font-display: swap; unicode-range: U+0E01-0E5B, U+200C-200D, U+25CC; }
@font-face { font-family: "JetBrains Mono"; src: url("${fonts.mono}") format("woff2"); font-weight: 100 800; font-style: normal; font-display: swap; }
:root {
  color-scheme: dark;
  ${themeDeclarations("dark")}
  --font-sans: ${scaleTokens.font.sans};
  --font-mono: ${scaleTokens.font.mono};
  --radius-control: ${scaleTokens.radius.control}px;
  --radius-card: ${scaleTokens.radius.card}px;
  --radius-composer: ${scaleTokens.radius.composer}px;
  --size-xs:${scaleTokens.size.xs}px;
  --size-sm:${scaleTokens.size.sm}px;
  --size-ui:${scaleTokens.size.ui}px;
  --size-chat:${scaleTokens.size.chat}px;
  --size-input-mobile:${scaleTokens.size.input}px;
  --size-lg:${scaleTokens.size.lg}px;
  --size-xl:${scaleTokens.size.xl}px;
  --size-xxl:${scaleTokens.size.xxl}px;
  --radius-pill:${scaleTokens.radius.pill}px;
  --radius-tail:${scaleTokens.radius.tail}px;
  --press-scale:${scaleTokens.press};
  --scrim-palette:${effectTokens.scrim.palette};
  --scrim-drawer:${effectTokens.scrim.drawer};
  --motion-ui: ${scaleTokens.motion.ui}ms;
  --motion-panel: ${scaleTokens.motion.panel}ms;
  --motion-breath: ${scaleTokens.motion.breath}ms;
  --motion-ceremony: ${scaleTokens.motion.ceremony}ms;
  --chat-width: ${scaleTokens.chatWidth}px;
  /* Derived, non-text tones and the component aliases kept from the first web slice. */
  --line-strong: color-mix(in srgb, var(--fg) 20%, var(--bg));
  --canvas: var(--bg);
  --sidebar: var(--surface-1);
  --surface: var(--surface-1);
  --text: var(--fg);
  --muted: var(--fg-2);
  --faint: var(--fg-3);
  --link: var(--fg);
  --accent: var(--fg);
  --accent-press: var(--fg);
  --accent-hover: color-mix(in srgb, var(--fg) 86%, var(--bg));
  --ok-bg: transparent;
  --ok-line: color-mix(in srgb, var(--ok) 38%, var(--bg));
  --warn-bg: transparent;
  --warn-line: color-mix(in srgb, var(--warn) 38%, var(--bg));
  --danger-bg: transparent;
  --danger-line: color-mix(in srgb, var(--danger) 38%, var(--bg));
  --info-bg: var(--surface-2);
  --info-line: var(--line);
  --shadow: ${effectTokens.shadow.dark};
  font-family: var(--font-sans);
  font-size: var(--size-ui);
  background: var(--bg);
  color: var(--fg);
  font-synthesis: none;
  text-rendering: optimizeLegibility;
}
@media (prefers-color-scheme: light) {
  :root:not([data-theme="dark"]) { color-scheme: light; ${themeDeclarations("light")} --shadow: ${effectTokens.shadow.light}; }
}
:root[data-theme="light"] { color-scheme: light; ${themeDeclarations("light")} --shadow: ${effectTokens.shadow.light}; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
button, input, textarea, select, summary { font: inherit; color: inherit; }
button, a, summary, input, textarea { -webkit-tap-highlight-color: transparent; }
button, summary { cursor: pointer; }
svg { width: 20px; height: 20px; flex-shrink: 0; vertical-align: middle; }
a, button, summary { touch-action: manipulation; }
a:focus-visible, button:focus-visible, summary:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible {
  outline: 2px solid var(--fg);
  outline-offset: 2px;
}
h1, h2, h3, p { margin: 0; }
h1, h2, h3 { font-weight: 600; line-height: 1.4; }
p { line-height: 1.7; }
ul { list-style: none; padding: 0; margin: 0; }
strong { font-weight: 600; }
::selection { background: var(--fg); color: var(--on-fg); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
.skip { position: fixed; z-index: 40; top: -80px; left: 12px; background: var(--fg); color: var(--on-fg); padding: 10px 12px; border-radius: var(--radius-control); font-weight: 600; }
.skip:focus { top: 12px; }

button, .header-action {
  background: var(--surface-1);
  color: var(--fg);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  min-height: 36px;
  padding: 8px 14px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: var(--size-sm);
  font-weight: 500;
  line-height: 1.2;
  white-space: nowrap;
  transition: background-color var(--motion-ui) ease-out, border-color var(--motion-ui) ease-out, color var(--motion-ui) ease-out, transform var(--motion-ui) ease-out;
}
@media (hover: hover) and (pointer: fine) { button:hover, .header-action:hover { background: var(--surface-3); border-color: var(--line-strong); } }
button:active, .header-action:active { transform: scale(var(--press-scale)); }
.primary { background: var(--fg); color: var(--on-fg); border-color: transparent; }
@media (hover: hover) and (pointer: fine) { .primary:hover { background: var(--accent-hover); color: var(--on-fg); } }
button.danger { background: transparent; color: var(--danger); border-color: var(--danger-line); }
@media (hover: hover) and (pointer: fine) { button.danger:hover { background: var(--danger-bg); color: var(--danger); } }
.icon-button, .send-button { border: 0; padding: 0; min-height: 0; background: transparent; color: var(--fg-2); }
.icon-button { width: 36px; height: 36px; border-radius: var(--radius-control); }
@media (hover: hover) and (pointer: fine) { .icon-button:hover { background: var(--surface-3); color: var(--fg); } }
.send-button { width: 36px; height: 36px; border-radius: 50%; background: var(--fg); color: var(--on-fg); }
@media (hover: hover) and (pointer: fine) { .send-button:hover { background: var(--accent-hover); color: var(--on-fg); } }
.send-button svg { width: 18px; height: 18px; }

/* Shell: sidebar (projects → topics, settings at the bottom), main pane, mobile drawer. */
.app { display: grid; grid-template-columns: 264px minmax(0, 1fr); height: 100dvh; overflow: hidden; }
.sidebar { background: var(--surface-1); border-right: 1px solid var(--line); display: flex; flex-direction: column; padding: 14px 10px 10px; min-height: 0; }
.sidebar-top { display: flex; align-items: center; justify-content: space-between; padding: 2px 6px 14px; }
.brand { display: inline-flex; align-items: center; color: var(--fg); border-radius: var(--radius-control); }
.brand .jit-lockup { width: auto; height: 36px; }
.auth-card .brand .jit-lockup { height: 44px; }
.drawer-close { display: none; }
.new-chat { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 8px 12px; margin: 0 2px 6px; border: 1px solid var(--line); border-radius: var(--radius-pill); color: var(--fg); font-weight: 500; }
@media (hover: hover) and (pointer: fine) { .new-chat:hover { background: var(--surface-3); } }
.new-chat svg { width: 16px; height: 16px; }
.nav-scroll { overflow: auto; min-height: 0; flex: 1; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; padding-bottom: 8px; }
.nav-heading { padding: 16px 10px 6px; font-size: var(--size-xs); font-weight: 500; color: var(--fg-3); }
.nav-main, .nav-link {
  display: flex; align-items: center; gap: 10px; min-height: 34px; padding: 6px 10px; border-radius: var(--radius-control);
  color: var(--fg-2); font-size: var(--size-ui); font-weight: 400; line-height: 1.4;
  transition: background-color var(--motion-ui) ease-out, color var(--motion-ui) ease-out;
}
.nav-main svg, .nav-link svg { width: 16px; height: 16px; }
@media (hover: hover) and (pointer: fine) { .nav-main:hover, .nav-link:hover { background: var(--surface-3); color: var(--fg); } }
.nav-main[aria-current=page], .nav-link[aria-current=page] { background: var(--surface-2); color: var(--fg); font-weight: 500; }
.nav-link span, .nav-main span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nav-project[data-selected] > .nav-link { color: var(--fg); }
.nav-topics { margin: 2px 0 6px 18px; padding-left: 8px; border-left: 1px solid var(--line); }
.nav-topics .nav-link { min-height: 30px; font-size: var(--size-sm); }
.nav-search { margin: 0 2px 4px; }
.nav-search kbd { margin-left: auto; }
/* Waiting-on-owner badge: words plus a number, never colour alone (NFR-11). */
.nav-badge { margin-left: auto; flex-shrink: 0; font-size: var(--size-xs); font-weight: 500; line-height: 1.5; color: var(--fg); border: 1px solid var(--line-strong); border-radius: var(--radius-pill); padding: 0 8px; }
kbd { font: 500 var(--size-xs)/1.6 var(--font-sans); color: var(--fg-2); border: 1px solid var(--line-strong); border-radius: var(--radius-control); padding: 0 5px; }
.nav-subtle { display: block; padding: 6px 10px; font-size: var(--size-xs); font-weight: 500; color: var(--fg-3); }
@media (hover: hover) and (pointer: fine) { .nav-subtle:hover { color: var(--fg); } }
.sidebar-foot { border-top: 1px solid var(--line); margin-top: 8px; padding-top: 8px; display: grid; gap: 2px; }
.owner-menu { display: flex; align-items: center; gap: 10px; padding: 4px 4px 0 10px; }
.owner-name { font-size: var(--size-sm); font-weight: 500; flex: 1; min-width: 0; color: var(--fg-2); }
.owner-menu form { margin: 0; }
.drawer-scrim { display: none; }

.main-pane { display: flex; flex-direction: column; height: 100dvh; min-width: 0; min-height: 0; background: var(--bg); }
.app-header { min-height: 56px; padding: 10px 32px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-shrink: 0; border-bottom: 1px solid var(--line); background: var(--bg); }
.menu-button { display: none; }
.header-title { min-width: 0; flex: 1; }
.header-title h1 { font-size: var(--size-ui); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 62vw; }
.breadcrumb { color: var(--fg-2); font-size: var(--size-xs); font-weight: 400; display: block; margin-bottom: 2px; max-width: 62vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (hover: hover) and (pointer: fine) { .breadcrumb:hover { color: var(--fg); } }
.header-action svg { width: 15px; height: 15px; }
.scroll-region { flex: 1; overflow: auto; min-height: 0; scrollbar-gutter: stable; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }

/* Logo: the floating dot breathes only while Jit is thinking. */
.jit-mark, .jit-lockup { color: var(--fg); }
[data-state="thinking"] .jit-dot { animation: jit-breath var(--motion-breath) ease-in-out infinite; transform-box: fill-box; transform-origin: center; }
@keyframes jit-breath { 0%, 100% { opacity: 1; transform: translateY(0); } 50% { opacity: .55; transform: translateY(-.6px); } }

/* Settings */
.settings-content { max-width: var(--chat-width); }
.settings-section { border: 1px solid var(--line); background: var(--surface-1); border-radius: var(--radius-card); padding: 18px; margin-bottom: 16px; }
.settings-section h2 { font-size: var(--size-chat); margin-bottom: 4px; }
.settings-section > p { color: var(--fg-2); font-size: var(--size-sm); margin-bottom: 12px; }
.choice-group { border: 0; margin: 0 0 14px; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.choice-group legend { font-size: var(--size-sm); font-weight: 500; color: var(--fg); margin-bottom: 8px; padding: 0; }
.choice { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 6px 14px; border: 1px solid var(--line-strong); border-radius: var(--radius-pill); font-size: var(--size-sm); cursor: pointer; }
.choice:has(input:checked) { background: var(--fg); color: var(--on-fg); border-color: var(--fg); }
.choice:has(input:focus-visible) { outline: 2px solid var(--fg); outline-offset: 2px; }
.choice input { accent-color: currentColor; margin: 0; }
.settings-links { display: grid; gap: 2px; }
.settings-links a { display: flex; align-items: center; gap: 10px; min-height: 40px; padding: 8px 10px; border-radius: var(--radius-control); color: var(--fg); }
@media (hover: hover) and (pointer: fine) { .settings-links a:hover { background: var(--surface-3); } }
.settings-links small { color: var(--fg-3); margin-left: auto; font-size: var(--size-xs); }
.settings-facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 16px; margin: 0; font-size: var(--size-sm); }
.settings-facts dt { color: var(--fg-2); }
.settings-facts dd { margin: 0; }
.data-projects { list-style: none; margin: 0; padding: 0; display: grid; gap: 12px; }
.data-projects li { border-top: 1px solid var(--line); padding-top: 12px; }
.data-projects h3 { font-size: var(--size-ui); }
.data-projects p { font-size: var(--size-xs); color: var(--fg-3); }

/* Section pills: settings sub-navigation, project tools and topic panel tabs (web.settings_ia/v1). */
.settings-nav, .project-tools { padding: 16px 32px 0; }
.settings-nav ul, .project-tools ul, .panel-tabs ul { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 0; padding: 0; }
.settings-nav a, .project-tools a, .panel-tabs a {
  display: inline-flex; align-items: center; min-height: 32px; padding: 6px 12px; border: 1px solid var(--line); border-radius: var(--radius-pill);
  color: var(--fg-2); font-size: var(--size-sm); white-space: nowrap; transition: background-color var(--motion-ui) ease-out, color var(--motion-ui) ease-out;
}
@media (hover: hover) and (pointer: fine) { .settings-nav a:hover, .project-tools a:hover, .panel-tabs a:hover { background: var(--surface-3); color: var(--fg); } }
.settings-nav a[aria-current=page], .project-tools a[aria-current=page], .panel-tabs a[aria-current=page] { background: var(--fg); color: var(--on-fg); border-color: var(--fg); }

/* Topic right panel: closed by default; a third column on wide screens and an overlay below 900 px. */
.topic-panel[hidden] { display: none; }
.topic-panel { background: var(--surface-1); border-left: 1px solid var(--line); height: 100dvh; overflow: auto; min-width: 0; scrollbar-width: thin; }
.topic-panel[aria-busy=true] { opacity: .7; }
.app:has(> .topic-panel:not([hidden])) { grid-template-columns: 264px minmax(0, 1fr) min(380px, 34vw); }
.panel-toggle[aria-expanded=true] { background: var(--surface-3); }
.panel-body { padding: 14px 16px 24px; }
.panel-page .panel-body { padding: 0; max-width: var(--chat-width); }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
.panel-head h2 { font-size: var(--size-chat); }
.panel-tabs { margin-bottom: 14px; }
.panel-heading { font-size: var(--size-sm); font-weight: 600; margin: 4px 0 8px; }
.panel-count { color: var(--fg-2); font-weight: 500; }
.panel-list { list-style: none; margin: 0 0 12px; padding: 0; display: grid; gap: 6px; }
.panel-list li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--radius-control); font-size: var(--size-sm); overflow-wrap: anywhere; }
.panel-list small { color: var(--fg-3); font-size: var(--size-xs); }
.panel-more { font-size: var(--size-sm); margin: 4px 0; }

/* ⌘K palette and the no-script search page. */
.palette { width: min(640px, calc(100vw - 32px)); max-height: min(70dvh, 560px); margin: 12dvh auto auto; padding: 0; border: 1px solid var(--line-strong); border-radius: var(--radius-card); background: var(--surface-1); color: var(--fg); box-shadow: var(--shadow); overflow: hidden; }
.palette[open] { display: flex; flex-direction: column; }
.palette::backdrop { background: var(--scrim-palette); }
.palette-form { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.palette-form:focus-within { box-shadow: inset 0 -2px 0 var(--fg); }
.palette-form svg { width: 18px; height: 18px; color: var(--fg-3); flex-shrink: 0; }
.palette-form input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--fg); font: inherit; font-size: var(--size-chat); padding: 6px 0; outline: none; }
.palette-results { list-style: none; margin: 0; padding: 6px; overflow: auto; flex: 1; }
.palette-results [role=option] { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--radius-control); cursor: pointer; font-size: var(--size-ui); }
.palette-results [aria-selected=true] { background: var(--surface-3); outline: 2px solid var(--fg); outline-offset: -2px; }
.palette-kind, .search-kind { font-size: var(--size-xs); color: var(--fg-3); min-width: 64px; }
.palette-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.palette-detail, .search-detail { font-size: var(--size-xs); color: var(--fg-2); max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.palette-status { padding: 0 16px 8px; font-size: var(--size-sm); color: var(--fg-2); }
.palette-status:empty { display: none; }
.palette-hint { padding: 8px 16px; border-top: 1px solid var(--line); font-size: var(--size-xs); color: var(--fg-3); }
.search-note { font-size: var(--size-sm); color: var(--fg-3); margin: 8px 0 20px; }
.search-results { list-style: none; margin: 0 0 20px; padding: 0; display: grid; gap: 4px; }
.search-results a { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--radius-control); color: var(--fg); }
@media (hover: hover) and (pointer: fine) { .search-results a:hover { background: var(--surface-3); } }
.search-label { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.licenses { font-size: var(--size-xs); color: var(--fg-3); }
.licenses a { text-decoration: underline; text-underline-offset: 3px; }

.content { width: min(100%, 960px); margin: 0; padding: 28px 32px 64px; }
.hero { text-align: left; padding: 4px 0 20px; max-width: 42rem; }
.hero h1, .hero h2 { font-size: var(--size-xl); line-height: 1.25; font-weight: 600; letter-spacing: -.015em; }
.hero p { color: var(--muted); font-size: var(--size-ui); margin-top: 8px; max-width: 40rem; }
.eyebrow { color: var(--muted); font-size: var(--size-sm); font-weight: 600; margin-bottom: 8px; }
.section-heading {
  font-size: var(--size-sm);
  font-weight: 600;
  color: var(--text);
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 28px 0 10px;
}
.create-form {
  border: 1px solid var(--line-strong);
  background: var(--surface);
  border-radius: var(--radius-card);
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
  font-size: var(--size-ui);
}
.create-form input:focus-visible, .composer textarea:focus-visible { outline: none; }
.create-form:focus-within, .composer:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent); }
.create-form input::placeholder, .composer textarea::placeholder, .team-form input::placeholder, .team-form textarea::placeholder { color: var(--faint); }
.create-form .primary { border-radius: var(--radius-control); }
.create-form:has(select) {
  display: grid;
  align-items: stretch;
  gap: 12px;
  padding: 16px;
}
.create-form:has(select) label { display: grid; gap: 6px; color: var(--muted); font-size: var(--size-xs); font-weight: 600; }
.create-form:has(select) input:not([type=hidden]), .create-form:has(select) select {
  width: 100%;
  min-width: 0;
  color: var(--text);
  background: var(--canvas);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  min-height: 40px;
  padding: 8px 12px;
}
.create-form:has(select) .primary { justify-self: start; }
.project-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.project-card {
  display: block;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  min-width: 0;
  background: var(--surface);
  color: inherit;
  text-decoration: none;
}
@media (hover: hover) and (pointer: fine) { .project-card:hover { background: var(--surface-2); border-color: var(--line-strong); } }
.project-card svg {
  width: 16px; height: 16px; padding: 8px; box-sizing: content-box; border-radius: var(--radius-control);
  background: var(--info-bg); color: var(--link); margin-bottom: 14px;
}
.project-card h2 { font-size: var(--size-chat); font-weight: 600; overflow-wrap: anywhere; line-height: 1.45; }
.project-card p { color: var(--muted); font-size: var(--size-sm); margin-top: 4px; }
.topic-row { display: flex; align-items: center; gap: 12px; min-width: 0; border-bottom: 1px solid var(--line); padding: 14px 8px; border-radius: var(--radius-control); }
@media (hover: hover) and (pointer: fine) { .topic-row:hover { background: var(--surface); } }
.topic-row > svg { color: var(--faint); width: 16px; height: 16px; }
.topic-row-main { min-width: 0; flex: 1; }
.topic-row-main h3 { font-size: var(--size-ui); font-weight: 600; line-height: 1.45; overflow-wrap: anywhere; }
@media (hover: hover) and (pointer: fine) { .topic-row-main h3 a:hover, .job-card h3 a:hover, .team-card h3 a:hover { text-decoration: underline; text-underline-offset: 3px; } }
.topic-row time, .topic-row-main p { font-size: var(--size-xs); color: var(--muted); display: block; margin-top: 4px; }
.source-link { font-size: var(--size-xs); font-weight: 600; color: var(--muted); white-space: nowrap; display: inline-flex; align-items: center; gap: 5px; text-decoration: none; }
.source-link svg { width: 14px; height: 14px; }
@media (hover: hover) and (pointer: fine) { .source-link:hover { color: var(--text); } }
.content p a, .team-card li a {
  color: var(--link);
  text-decoration: underline;
  text-underline-offset: 3px;
  text-decoration-color: color-mix(in srgb, var(--link) 45%, transparent);
}
@media (hover: hover) and (pointer: fine) { .content p a:hover, .team-card li a:hover { text-decoration-color: var(--link); } }
.empty-list {
  border: 1px dashed var(--line-strong);
  background: color-mix(in srgb, var(--surface) 72%, transparent);
  border-radius: var(--radius-card);
  padding: 28px 16px;
  color: var(--muted);
  text-align: center;
  font-size: var(--size-sm);
}
.pagination { display: flex; justify-content: flex-start; gap: 8px; padding: 20px 0 0; font-size: var(--size-sm); }
.pagination a {
  display: inline-flex; align-items: center; min-height: 32px; padding: 0 12px;
  border: 1px solid var(--line-strong); border-radius: var(--radius-control); background: var(--surface); color: var(--text); font-weight: 600; text-decoration: none;
}
@media (hover: hover) and (pointer: fine) { .pagination a:hover { background: var(--surface-2); } }

.empty-chat { min-height: 280px; display: flex; align-items: center; justify-content: center; text-align: center; }
.empty-chat svg { width: 28px; height: 28px; color: var(--link); margin-bottom: 14px; padding: 10px; box-sizing: content-box; border-radius: var(--radius-card); background: var(--info-bg); }
.empty-chat h2 { font-size: var(--size-lg); font-weight: 600; }
.empty-chat p { color: var(--muted); font-size: var(--size-sm); margin-top: 8px; }
.chat-content { width: min(100%, calc(var(--chat-width) + 64px)); margin-inline: auto; padding-top: 24px; padding-bottom: 24px; }
.chat-content > .team-card { margin-bottom: 12px; }
.message { display: flex; flex-direction: column; align-items: flex-start; margin: 0 0 22px; gap: 6px; min-width: 0; }
.message--owner { align-items: flex-end; }
.message-body { max-width: min(100%, 68ch); min-width: 0; font-size: var(--size-chat); line-height: 1.7; }
.message--owner .message-body { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-card) var(--radius-card) var(--radius-tail) var(--radius-card); padding: 10px 14px; }
/* Jit replies (BOT01): plain text on the page, a small mark, and a status card until the reply commits. */
.reply-head { display: flex; align-items: center; gap: 8px; font-size: var(--size-sm); font-weight: 600; color: var(--muted); }
.jit-avatar { display: inline-flex; color: var(--fg); }
.reply-status .message-body { color: var(--muted); }
.reply-progress { font-size: var(--size-ui); }
.reply-provisional, .reply-next { font-size: var(--size-xs); color: var(--faint); margin-top: 4px; }
.reply-next { color: var(--muted); }
.reply-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: var(--size-xs); }
.reply-actions form { display: inline; }
.reply-actions button { min-height: 32px; padding: 4px 14px; border: 1px solid var(--line-strong); border-radius: var(--radius-pill); background: transparent; color: var(--fg); font: inherit; cursor: pointer; }
@media (hover: hover) and (pointer: fine) { .reply-actions button:hover { background: var(--surface-3); } }
.reply-actions a { color: var(--muted); }
/* Proposal card (BOT03 role; shared by later proposal kinds): a team card under the Jit reply that carries it. */
.proposal-card { margin: -8px 0 22px; max-width: min(100%, 68ch); }
.proposal-card > header .eyebrow { margin-bottom: 2px; font-size: var(--size-xs); }
.team-card .proposal-meta { font-size: var(--size-xs); color: var(--faint); margin-block: 0 8px; }
.proposal-fields { display: grid; grid-template-columns: max-content 1fr; gap: 6px 14px; margin: 0; font-size: var(--size-ui); }
.proposal-fields dt { color: var(--muted); font-size: var(--size-xs); font-weight: 600; line-height: 1.9; }
.proposal-fields dd { margin: 0; min-width: 0; color: var(--text); overflow-wrap: anywhere; }
.proposal-dropped { margin-top: 12px; padding-left: 10px; border-left: 2px solid var(--warn-line); font-size: var(--size-sm); }
.team-card .proposal-dropped p { color: var(--warn); font-size: var(--size-xs); font-weight: 600; margin-block: 0 4px; }
.team-card .proposal-dropped ul { margin: 0; gap: 2px; }
.team-card .proposal-dropped li { border: 0; padding: 0; font-size: var(--size-sm); color: var(--muted); }
.team-card .proposal-note, .team-card .proposal-outcome { font-size: var(--size-xs); color: var(--muted); }
.proposal-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
.proposal-actions form { display: inline; }
.proposal-actions button { border-radius: var(--radius-pill); }
@media (max-width: 560px) { .proposal-fields { grid-template-columns: 1fr; gap: 2px; } .proposal-fields dd { margin-bottom: 6px; } }
/* Collapsible team card (BOT04, S09-D08); dispatch proposals use the shared proposal card above. */
.chat-content .team-run { margin: -8px 0 22px; max-width: min(100%, 68ch); padding: 12px 16px; }
.team-run > summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; cursor: pointer; font-size: var(--size-sm); font-weight: 600; list-style: none; }
.team-run > summary::-webkit-details-marker { display: none; }
.team-run > summary::before { content: "▸"; color: var(--muted); }
.team-run[open] > summary::before { content: "▾"; }
.team-run-title { flex: 1; }
.team-run .team-run-origin, .team-role-note { font-size: var(--size-xs); color: var(--muted); }
/* app.routing_selection/v1: the rule name, or Jit's reasoning labelled as such (REL03). */
.team-selection { font-size: var(--size-xs); color: var(--muted); }
.team-selection-label { font-weight: 600; }
.team-selection-why { overflow-wrap: anywhere; }
.team-roles { list-style: none; margin: 8px 0; padding: 0; display: grid; gap: 8px; }
.team-role { border-top: 1px solid var(--line); padding-top: 8px; }
.team-role-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--size-sm); }
.team-role-name { font-weight: 600; }
.team-role-head form { display: inline; margin-left: auto; }
.team-role-head button { min-height: 28px; padding: 2px 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-pill); background: transparent; color: var(--fg); font: inherit; font-size: var(--size-xs); cursor: pointer; }
.team-opinion { margin-top: 6px; font-size: var(--size-sm); }
.team-opinion > summary { cursor: pointer; color: var(--muted); }
.team-opinion .message-body { font-size: var(--size-ui); margin-top: 6px; }
.team-reply-meta { font-size: var(--size-xs); color: var(--muted); display: grid; gap: 4px; }
.team-reply-meta .source-link { margin-right: 8px; }
.team-reply-meta small { display: block; color: var(--faint); }
.allowance-form .choice { display: inline-flex; gap: 8px; align-items: center; }
.proposal-card .choice-group { margin: 8px 0 0; }
[hidden] { display: none !important; }
.composer-keys { display: none; }
[data-enhanced] .composer-keys { display: inline; }
.literal { white-space: pre-wrap; overflow-wrap: anywhere; color: inherit; }
.literal + .literal { margin-top: 10px; }
pre { margin: 10px 0; background: var(--canvas); border: 1px solid var(--line); border-radius: var(--radius-control); padding: 12px 14px; overflow-x: auto; max-width: 100%; line-height: 1.6; tab-size: 2; }
code { font: var(--size-xs)/1.6 var(--font-mono); white-space: pre; overflow-wrap: normal; }
pre:first-child { margin-top: 0; }
pre:last-child { margin-bottom: 0; }
.message-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; color: var(--muted); font-size: var(--size-xs); max-width: min(100%, 68ch); }
.message-meta .source-link { font-size: var(--size-xs); }
.message-meta details[open] { flex-basis: 100%; text-align: right; }
.message-meta details[open] summary { justify-content: flex-end; }
.message-meta summary { list-style: none; display: flex; align-items: center; gap: 4px; min-height: 24px; padding: 2px 4px; color: var(--muted); }
.message-meta summary::-webkit-details-marker { display: none; }
.message-meta summary svg { width: 14px; height: 14px; }
.message-detail { display: inline-block; max-width: 100%; margin-top: 6px; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--surface); color: var(--muted); line-height: 1.7; text-align: left; }
.message-detail .source-link { margin-top: 8px; }
.committed { color: var(--ok); display: inline-flex; align-items: center; gap: 4px; }
.committed svg { width: 12px; height: 12px; }
.composer-wrap { flex-shrink: 0; width: 100%; padding: 12px 32px max(16px, env(safe-area-inset-bottom)); background: var(--canvas); border-top: 1px solid var(--line); }
.composer { width: min(100%, var(--chat-width)); margin: 0 auto; padding: 12px 14px 10px; border: 1px solid var(--line-strong); border-radius: var(--radius-composer); background: var(--surface); }
.composer textarea { display: block; width: 100%; resize: none; field-sizing: content; min-height: 52px; max-height: 180px; color: var(--text); border: 0; background: transparent; line-height: 1.6; font-size: var(--size-ui); padding: 0; }
.composer-bottom { display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 8px; }
.composer-topic { font-size: var(--size-xs); color: var(--muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
.composer-topic svg { width: 14px; height: 14px; }
.composer-note { text-align: left; color: var(--muted); font-size: var(--size-xs); margin: 8px auto 0; width: min(100%, var(--chat-width)); }
/* Chat-first home (BOT05): greeting, a large composer with the project chip, and a quiet waiting strip. */
.content.home { width: min(100%, calc(var(--chat-width) + 64px)); margin-inline: auto; padding-top: 12vh; }
.home-hero { display: grid; justify-items: center; gap: 10px; text-align: center; margin-bottom: 24px; }
.home-mark { display: inline-flex; color: var(--fg); }
.home-greeting { font-size: var(--size-xxl); line-height: 1.2; font-weight: 600; letter-spacing: -.015em; }
.home-hero p { color: var(--fg-2); font-size: var(--size-chat); }
.home-composer { width: 100%; padding: 14px 16px 12px; }
.home-composer textarea { min-height: 84px; font-size: var(--size-chat); }
.home-note { width: 100%; }
.project-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; max-width: 70%; padding: 0 4px 0 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-pill); color: var(--fg-2); font-size: var(--size-sm); }
.project-chip svg { width: 14px; height: 14px; flex-shrink: 0; }
.project-chip select { min-width: 0; max-width: 100%; border: 0; background: transparent; color: var(--fg); font: inherit; font-weight: 500; padding: 4px 8px 4px 0; text-overflow: ellipsis; }
.project-chip:focus-within { border-color: var(--fg); }
.waiting-strip { margin-top: 28px; padding-top: 14px; border-top: 1px solid var(--line); font-size: var(--size-sm); color: var(--fg-2); }
.waiting-title { font-size: var(--size-xs); font-weight: 600; color: var(--fg-3); margin-bottom: 8px; }
.waiting-strip ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.waiting-strip a { display: inline-flex; align-items: center; gap: 8px; min-height: 36px; padding: 4px 6px 4px 12px; border: 1px solid var(--line); border-radius: var(--radius-pill); color: var(--fg); text-decoration: none; }
@media (hover: hover) and (pointer: fine) { .waiting-strip a:hover { background: var(--surface-3); } }
.waiting-strip a svg { width: 14px; height: 14px; color: var(--fg-2); }
/* Topic promotion (BOT05): the read-only origin and the "continued from" block of its continuation. */
.promotion-banner { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 16px; margin-bottom: 20px; padding: 12px 16px; border: 1px solid var(--line-strong); border-radius: var(--radius-card); background: var(--surface); font-size: var(--size-ui); }
.promotion-banner p { margin: 0; color: var(--fg-2); }
.promotion-banner strong { color: var(--fg); font-weight: 600; }
.promotion-link { display: inline-flex; align-items: center; min-height: 32px; padding: 4px 14px; border-radius: var(--radius-pill); background: var(--fg); color: var(--on-fg); font-size: var(--size-sm); font-weight: 600; text-decoration: none; }
@media (hover: hover) and (pointer: fine) { .promotion-link:hover { background: var(--accent-hover); } }
.composer--closed { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; color: var(--fg-2); font-size: var(--size-sm); }
.composer--closed p { margin: 0; }
.continued-from { margin: 0 0 24px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface); }
.continued-from > details > summary { cursor: pointer; padding: 12px 16px; font-size: var(--size-sm); font-weight: 600; color: var(--fg); }
.continued-from > details > :not(summary) { margin-inline: 16px; }
.continued-from > details > a { display: inline-block; margin-bottom: 14px; font-size: var(--size-sm); color: var(--fg-2); }
.continued-meta { font-size: var(--size-xs); color: var(--fg-3); margin-bottom: 10px; }
.continued-messages { list-style: none; padding: 0 0 4px; display: grid; gap: 10px; border-left: 2px solid var(--line-strong); padding-left: 12px; }
.continued-message { display: grid; gap: 2px; }
.continued-speaker { font-size: var(--size-xs); font-weight: 600; color: var(--fg-3); }
.continued-message .message-body { font-size: var(--size-ui); color: var(--fg-2); }

.auth { min-height: 100dvh; display: grid; place-items: center; padding: 24px 16px; background: var(--canvas); }
.auth-card { width: min(100%, 400px); background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius-card); padding: 28px 24px 20px; box-shadow: var(--shadow); }
.auth-card .brand { justify-content: flex-start; padding: 0 0 20px; }
.auth-card h1 { text-align: left; font-size: var(--size-xl); }
.auth-card > p { text-align: left; font-size: var(--size-ui); color: var(--muted); margin: 8px 0 20px; }
.auth-card label { display: block; color: var(--muted); font-size: var(--size-xs); font-weight: 600; margin: 0 0 8px; }
.auth-card input { width: 100%; background: var(--canvas); color: var(--text); border: 1px solid var(--line-strong); border-radius: var(--radius-control); min-height: 42px; padding: 10px 12px; }
.auth-card .primary { width: 100%; margin-top: 16px; min-height: 42px; }
/* Setup ("ตั้งจิต", app.setup/v1): one calm card per step, outside the workspace shell. */
.setup { min-height: 100dvh; display: grid; place-items: start center; padding: 40px 16px; background: var(--canvas); }
.setup-card { width: min(100%, 560px); display: grid; gap: 20px; }
.setup-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.setup-eyebrow { font-size: var(--size-xs); color: var(--fg-3); }
.setup-top .jit-lockup { height: 28px; width: auto; }
.setup-hero .jit-mark { width: 72px; height: 72px; }
.setup-steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; }
.setup-steps li { border-top: 2px solid var(--line); padding-top: 8px; display: grid; gap: 2px; min-width: 0; }
.setup-steps li[data-state="done"], .setup-steps li[data-state="current"] { border-top-color: var(--fg); }
.setup-step-name { font-size: var(--size-sm); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.setup-step-state { font-size: var(--size-xs); color: var(--fg-3); display: inline-flex; align-items: center; gap: 4px; }
.setup-step-state svg { width: 12px; height: 12px; }
.setup-steps li[aria-current="step"] .setup-step-name { font-weight: 600; }
.setup-hero { display: grid; justify-items: center; text-align: center; gap: 12px; padding: 12px 0; }
.setup-hero h1, .setup-head h1 { font-size: var(--size-xl); letter-spacing: -0.015em; }
.setup-hero p, .setup-head p { color: var(--fg-2); font-size: var(--size-chat); line-height: 1.7; max-width: 46ch; }
.setup-head { display: grid; gap: 8px; }
.setup-card > form:not(.setup-form) .primary, .setup-continue .primary { min-height: 42px; padding-inline: 22px; }
.setup-card > form:not(.setup-form) { display: flex; justify-content: center; }
.setup-language { display: flex; justify-content: center; gap: 8px; }
.setup-language a { min-height: 36px; padding: 6px 16px; border: 1px solid var(--line-strong); border-radius: var(--radius-pill); font-size: var(--size-sm); display: inline-flex; align-items: center; }
.setup-language a[aria-current="true"] { background: var(--fg); color: var(--on-fg); border-color: transparent; }
.setup-form { background: var(--surface-1); border: 1px solid var(--line); border-radius: var(--radius-card); padding: 18px; display: grid; gap: 14px; }
.setup-form small { font-weight: 400; color: var(--fg-3); }
.setup-connection { border: 1px solid var(--line); border-radius: var(--radius-card); padding: 16px 18px; display: grid; gap: 8px; }
.setup-connection h2 { font-size: var(--size-sm); color: var(--fg-2); font-weight: 500; }
.setup-connection-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.setup-route { font-family: var(--font-mono); font-size: var(--size-sm); overflow-wrap: anywhere; }
.setup-note, .setup-next { font-size: var(--size-ui); line-height: 1.7; }
.setup-next { color: var(--fg-2); }
.setup-meta { font-size: var(--size-xs); color: var(--fg-3); line-height: 1.6; }
.setup-actions, .setup-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; }
.setup-foot { justify-content: space-between; }
.setup-continue { display: grid; justify-items: end; gap: 6px; margin-left: auto; }
.setup-actions button, .setup-foot button:not(.primary) { min-height: 32px; padding: 4px 14px; border: 1px solid var(--line-strong); border-radius: var(--radius-pill); background: transparent; color: var(--fg); font: inherit; cursor: pointer; }
.setup-back, .setup-refresh { color: var(--fg-2); font-size: var(--size-sm); }
@media (hover: hover) and (pointer: fine) { .setup-back:hover, .setup-refresh:hover { color: var(--fg); } }
.setup-summary { margin: 0; border: 1px solid var(--line); border-radius: var(--radius-card); padding: 6px 18px; }
.setup-summary div { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); }
.setup-summary div:last-child { border-bottom: 0; }
.setup-summary dt { color: var(--fg-2); font-size: var(--size-sm); }
.setup-summary dd { margin: 0; font-size: var(--size-ui); display: flex; flex-wrap: wrap; gap: 8px; align-items: center; overflow-wrap: anywhere; }
/* The ceremony: one ${scaleTokens.motion.ceremony} ms sequence, played by the script before the final form posts. The halo
   draws in, then the dot rises and settles. Reduced motion turns it off (see the media query below). */
.ceremony .jit-mark { width: 120px; height: 120px; }
.ceremony .jit-halo { stroke-dasharray: 62; stroke-dashoffset: 0; }
.ceremony .jit-dot { transform-box: fill-box; transform-origin: center; }
.ceremony[data-ceremony="playing"] .jit-halo { animation: ceremony-halo calc(var(--motion-ceremony) / 2) ease-out both; }
.ceremony[data-ceremony="playing"] .jit-dot { animation: ceremony-dot calc(var(--motion-ceremony) / 2) ease-out calc(var(--motion-ceremony) / 2) both; }
@keyframes ceremony-halo { from { stroke-dashoffset: 62; opacity: .2; } to { stroke-dashoffset: 0; opacity: 1; } }
@keyframes ceremony-dot { 0% { opacity: 0; transform: translateY(3px); } 70% { opacity: 1; transform: translateY(-.5px); } 100% { opacity: 1; transform: translateY(0); } }
@media (max-width: 520px) {
  .setup { padding-top: 24px; }
  /* Phones: step names wrap between words instead of being cut, and a long word widens its own column. */
  .setup-steps { grid-template-columns: repeat(5, minmax(min-content, 1fr)); overflow-x: auto; }
  .setup-steps li { min-width: auto; }
  .setup-step-name { font-size: var(--size-xs); line-height: 1.3; white-space: normal; overflow: visible; }
  .setup-summary div { grid-template-columns: 1fr; gap: 2px; }
}
.auth-footer { margin-top: 18px; text-align: left; font-size: var(--size-xs); color: var(--faint); }
.error { border: 1px solid var(--danger-line); background: var(--danger-bg); color: var(--danger); border-radius: var(--radius-control); padding: 12px 14px; margin: 12px 0; }
.error-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.error-actions a {
  display: inline-flex; align-items: center; min-height: 36px; padding: 0 12px; border-radius: var(--radius-control);
  border: 1px solid var(--line-strong); background: var(--canvas); color: var(--text); font-size: var(--size-sm); font-weight: 600; text-decoration: none;
}
@media (hover: hover) and (pointer: fine) { .error-actions a:hover { background: var(--surface-2); } }
.source-content h1 { font-size: var(--size-xl); margin-bottom: 8px; }
.source-content > .source-byline { color: var(--muted); font-size: var(--size-sm); margin-bottom: 24px; }
.source-content .literal { font-size: var(--size-chat); line-height: 1.7; }
.source-details { border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface); margin-top: 28px; padding: 14px 16px; }
.source-details summary { color: var(--text); font-size: var(--size-sm); font-weight: 600; }
.source-details dl { font-size: var(--size-sm); line-height: 1.6; }
.source-details dt { color: var(--muted); margin-top: 12px; font-weight: 600; }
.source-details dd { margin: 2px 0 0; overflow-wrap: anywhere; color: var(--text); }

.jobs-heading { margin: 4px 0 20px; max-width: 42rem; }
.jobs-heading h2 { font-size: var(--size-xl); font-weight: 600; overflow-wrap: anywhere; }
.jobs-heading p { font-size: var(--size-ui); color: var(--muted); margin-top: 8px; }
.job-create, .job-card, .team-card {
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  padding: 16px;
  margin: 0 0 12px;
  background: var(--surface);
  overflow-wrap: anywhere;
}
.job-create { display: grid; gap: 12px; }
.job-create label, .team-form label, .job-card form label { display: grid; gap: 6px; color: var(--muted); font-size: var(--size-xs); font-weight: 600; }
.job-create input:not([type=hidden]), .job-create select, .team-form input:not([type=hidden]), .team-form select, .team-form textarea, .team-content > form input:not([type=hidden]), .team-content > form select, .team-content > form textarea, .job-card form input:not([type=hidden]), .job-card form select, .job-card form textarea {
  width: 100%;
  min-width: 0;
  color: var(--text);
  background: var(--canvas);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  min-height: 40px;
  padding: 8px 12px;
}
.team-form textarea { resize: vertical; min-height: 96px; line-height: 1.55; }
/* Choice pills (persona form) keep their own look inside a team form. */
.team-form .choice { display: inline-flex; color: var(--fg); font-size: var(--size-sm); font-weight: 400; }
.team-form .choice:has(input:checked) { color: var(--on-fg); }
.team-form .choice input { width: auto; min-height: 0; padding: 0; border: 0; border-radius: 0; background: none; color: inherit; }
.persona-form .choice-group { margin: 0; }
.job-create input[type=hidden], .team-form input[type=hidden] { display: none; }
.job-create p, .job-card p, .team-card p { font-size: var(--size-ui); color: var(--muted); margin-block: 8px; }
.job-card > p:first-of-type, .team-card > p:first-of-type { color: var(--text); }
.job-create-actions { display: flex; gap: 10px; align-items: center; }
.job-create-actions select { flex: 1; }
.job-create-actions button { flex-shrink: 0; }
.job-card header, .team-card > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.job-card h3, .team-card h3 { font-size: var(--size-chat); font-weight: 600; }
.job-card h3 a, .team-card h3 a { color: inherit; text-decoration: none; }
.job-status {
  display: inline-flex; align-items: center; flex-shrink: 0; max-width: 100%;
  font-size: var(--size-xs); font-weight: 600; line-height: 1.3; border: 1px solid var(--line-strong); border-radius: var(--radius-pill);
  padding: 3px 8px; color: var(--muted); background: var(--surface-2); white-space: nowrap;
}
.job-status[data-state="succeeded"], .job-status[data-state="accepted"], .job-status[data-state="completed"] { color: var(--ok); background: var(--ok-bg); border-color: var(--ok-line); }
.job-status[data-state="failed"], .job-status[data-state="dismissed"], .job-status[data-state="cancelled"], .job-status[data-state="stopped"] { color: var(--danger); background: var(--danger-bg); border-color: var(--danger-line); }
.job-status[data-state="blocked"], .job-status[data-state="partial"], .job-status[data-state="waiting"] { color: var(--warn); background: var(--warn-bg); border-color: var(--warn-line); }
.job-status[data-state="admitted"], .job-status[data-state="running"], .job-status[data-state="proposed"], .job-status[data-state="queued"], .job-status[data-state="specialist"], .job-status[data-state="coordinator"] { color: var(--link); background: var(--info-bg); border-color: var(--info-line); }
.job-status[data-state="disabled"], .job-status[data-state="skipped"], .job-status[data-state="excluded"] { color: var(--faint); background: transparent; }
/* web.access_settings/v1 (S11-D02): the execution level badge. Text always names the level; colour never does alone. */
.access-badge { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; max-width: 100%; font-size: var(--size-xs); font-weight: 600; line-height: 1.3; border: 1px solid var(--line); border-radius: var(--radius-pill); padding: 3px 8px; color: var(--fg-3); background: transparent; white-space: nowrap; }
.access-badge[data-level="workspace"] { color: var(--warn); border-color: var(--warn-line); background: var(--warn-bg); }
.access-badge[data-level="full"] { color: var(--danger); border-color: var(--danger-line); background: var(--danger-bg); }
.access-strike { font-weight: 400; }
.job-route { margin-top: 4px; color: var(--muted); }
.job-card form { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
.job-card form label { flex: 1 1 200px; }
.job-evidence { border-top: 1px solid var(--line); padding-top: 12px; margin-top: 14px; font-size: var(--size-ui); color: var(--text); }
.job-card details, .job-create details, .team-card details { font-size: var(--size-sm); color: var(--muted); margin-top: 12px; }
.job-card summary, .job-create summary, .team-card summary, .source-details summary { cursor: pointer; }
.job-limits { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 6px 16px; margin-top: 12px; }
.job-limits dt, .job-limits dd { margin: 0; overflow-wrap: anywhere; }
.job-limits dt { color: var(--faint); font-size: var(--size-xs); }
.job-limits dd { color: var(--text); font-size: var(--size-sm); }

.team-content { max-width: none; }
.team-notice {
  border: 1px solid var(--info-line);
  border-left: 3px solid var(--accent);
  background: var(--info-bg);
  border-radius: var(--radius-control);
  padding: 12px 14px;
  margin: 0 0 16px;
  color: var(--text);
  font-size: var(--size-sm);
  line-height: 1.6;
}
.team-card > header h3 { font-size: var(--size-chat); }
.team-card .literal { color: var(--text); }
.team-card ul { display: grid; gap: 8px; margin: 8px 0; }
.team-card li { padding-left: 10px; border-left: 2px solid var(--line-strong); font-size: var(--size-ui); line-height: 1.6; color: var(--text); }
.team-form { display: grid; gap: 14px; }
.team-card .team-form, .job-card .team-form { padding-top: 4px; }
.team-form small, .team-form p, .create-form small { color: var(--muted); font-size: var(--size-xs); font-weight: 500; line-height: 1.6; }
.team-form > .primary, .team-form > button { justify-self: start; }
.team-content > form, .team-content > details {
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  padding: 14px 16px;
  margin: 0 0 12px;
}
.team-content > form:not(.team-form) { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
.team-content > form:not(.team-form) label { display: grid; gap: 6px; flex: 1 1 280px; color: var(--muted); font-size: var(--size-xs); font-weight: 600; }
.team-content > form:not(.team-form) small { flex-basis: 100%; }
div.team-form { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 8px; }
div.team-form form { margin: 0; }
details.team-card > summary, .team-content > details > summary {
  list-style: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-weight: 600;
  font-size: var(--size-ui);
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
  border-radius: var(--radius-control);
  padding: 12px;
  min-width: 0;
  margin: 0;
}
.team-route legend { padding: 0 6px; color: var(--text); font-size: var(--size-xs); font-weight: 600; }
.team-preview { border-top: 1px solid var(--line); margin-top: 16px; padding-top: 4px; }
.team-effective { font-size: var(--size-sm); color: var(--text); background: var(--canvas); border: 1px solid var(--line); border-radius: var(--radius-control); padding: 10px 12px; }
.team-effective small { color: var(--muted); }
.team-card pre { white-space: pre-wrap; overflow-wrap: anywhere; }
.team-content > p { margin: 4px 0 12px; }

.memory-content { overflow-wrap: anywhere; }
.memory-content section { margin-block: 24px; }
.memory-content .team-card { margin-block: 14px; }
.memory-content .team-card h2 { font-size: var(--size-chat); }
.memory-content .team-form { margin-block: 16px; }
.memory-content .team-form label, .memory-content .team-form select { min-width: 0; max-width: 100%; }
.memory-content blockquote { margin: 12px 0; border-left: 2px solid var(--line-strong); padding-left: 14px; }
@media (min-width: 1500px) {
  .app { grid-template-columns: 280px minmax(0, 1fr); }
}
@media (max-width: 900px) {
  .app { grid-template-columns: 232px minmax(0, 1fr); }
  .content, .app-header, .composer-wrap { padding-inline: 20px; }
  .composer, .composer-note { width: min(100%, 920px); }
  .message-body, .message-meta { max-width: 100%; }
  .settings-nav, .project-tools { padding-inline: 20px; }
  .app:has(> .topic-panel:not([hidden])) { grid-template-columns: 232px minmax(0, 1fr); }
  .topic-panel { position: fixed; z-index: 28; inset: 0 0 0 auto; width: min(92vw, 400px); box-shadow: var(--shadow); }
}
@media (max-width: 680px) {
  .app { display: block; }
  .sidebar {
    position: fixed; z-index: 30; inset: 0 auto 0 0; width: min(86vw, 320px); box-shadow: var(--shadow);
    transform: translateX(-102%); visibility: hidden;
    transition: transform var(--motion-panel) ease-out, visibility 0s linear var(--motion-panel);
  }
  .sidebar:target, .app[data-drawer="open"] .sidebar { transform: none; visibility: visible; transition: transform var(--motion-panel) ease-out; }
  .drawer-scrim { position: fixed; z-index: 25; inset: 0; background: var(--scrim-drawer); }
  .sidebar:target ~ .drawer-scrim, .app[data-drawer="open"] .drawer-scrim { display: block; }
  .app[data-drawer="closed"] .sidebar:target { transform: translateX(-102%); visibility: hidden; }
  .app[data-drawer="closed"] .sidebar:target ~ .drawer-scrim { display: none; }
  .drawer-close { display: grid; place-items: center; width: 36px; height: 36px; border-radius: var(--radius-control); color: var(--fg-2); }
  @media (hover: hover) and (pointer: fine) { .drawer-close:hover { background: var(--surface-3); color: var(--fg); } }
  .menu-button { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; color: var(--fg); border-radius: var(--radius-control); }
  @media (hover: hover) and (pointer: fine) { .menu-button:hover { background: var(--surface-3); } }
  .main-pane { height: 100dvh; }
  .app-header { min-height: 56px; padding: 10px 12px; gap: 10px; }
  .header-title h1, .breadcrumb { max-width: 58vw; }
  .header-action { padding: 8px; font-size: 0; gap: 0; }
  .header-action svg { width: 18px; height: 18px; }
  .content { padding: 20px 16px 40px; }
  .hero { padding-bottom: 16px; }
  .create-form:not(:has(select)) { padding-left: 12px; gap: 8px; }
  .create-form:not(:has(select)) .primary { font-size: 0; width: 40px; min-width: 40px; height: 40px; padding: 0; gap: 0; }
  .create-form:not(:has(select)) .primary svg { width: 18px; height: 18px; }
  .project-grid { grid-template-columns: 1fr; }
  .chat-content { padding-top: 16px; }
  .composer-wrap { padding: 10px 12px max(12px, env(safe-area-inset-bottom)); }
  .composer textarea, .team-form input, .team-form textarea, .team-form select, .job-create input, .job-create select, .auth-card input, .create-form input, .create-form select { font-size: var(--size-input-mobile); }
  .empty-chat { min-height: 200px; }
  .source-link { white-space: normal; }
  .topic-row { gap: 10px; align-items: flex-start; }
  .team-card, .job-card, .job-create { padding: 14px; }
  .team-card > header, .job-card header { align-items: flex-start; }
  .team-route, .job-limits { grid-template-columns: 1fr; }
  .job-status { white-space: normal; }
  .settings-nav, .project-tools { padding: 12px 16px 0; }
  .settings-nav ul, .project-tools ul { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; }
  .palette { margin-top: 8dvh; }
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
/* Safe areas (web.pwa/v1). Pages use viewport-fit=cover, so the installed app draws under the status bar, notch and
   home indicator; every edge that touches the screen keeps its own spacing or the device inset, whichever is larger.
   Without insets env() is 0 and nothing moves. These come last so the breakpoints above cannot undo them. */
.sidebar { padding-top: max(14px, env(safe-area-inset-top)); padding-bottom: max(10px, env(safe-area-inset-bottom)); padding-left: max(10px, env(safe-area-inset-left)); }
.app-header { padding-top: max(10px, env(safe-area-inset-top)); }
.main-pane { padding-right: env(safe-area-inset-right); }
.topic-panel { padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); padding-right: env(safe-area-inset-right); }
.skip:focus { top: max(12px, env(safe-area-inset-top)); }
.auth { padding: max(24px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(24px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); }
.setup { padding: max(40px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(40px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left)); }
.scroll-region:last-child { padding-bottom: env(safe-area-inset-bottom); }
@media (max-width: 680px) { .main-pane { padding-left: env(safe-area-inset-left); } }
@media (max-width: 520px) { .setup { padding-top: max(24px, env(safe-area-inset-top)); } }
@media (max-height: 480px) {
  .app-header { padding-top: max(6px, env(safe-area-inset-top)); }
  .composer-wrap { padding-bottom: max(8px, env(safe-area-inset-bottom)); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation: none !important; transition: none !important; }
  button:active, .header-action:active, .primary:active { transform: none; }
}
`;
}
