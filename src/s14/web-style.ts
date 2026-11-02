import { s14Theme, s14Scale } from "./web-design";

/**
 * S14 product stylesheet, layered on the shared base (`app.css`) so tokens, fonts, buttons and the focus ring stay one
 * system. Every class is `s-` prefixed. Visual values come from the S14 and shared web-design token modules (ui.token_lint/v1).
 */
export function s14StyleSheet(): string {
  return `
:root {
  ${s14Theme("dark")}
  --nav-w: ${s14Scale.nav}px; --pane-w: ${s14Scale.pane}px; --chat-width: ${s14Scale.chat}px;
  --radius-tile: ${s14Scale.tileRadius}; --radius-card: ${s14Scale.cardRadius}px; --radius-composer: ${s14Scale.composerRadius}px;
  --line-strong: var(--line); --warn-line: var(--fg-3); --danger-line: var(--fg-2); --ok-line: var(--line);
  --accent-hover: var(--fg-2); --hatch: repeating-linear-gradient(135deg, var(--fg-3) 0 2px, transparent 2px 5px);
}
:root[data-theme=light] { ${s14Theme("light")} }
@media (prefers-color-scheme: light) { :root:not([data-theme=dark]) { ${s14Theme("light")} } }
html, body { height: 100%; }
.s-app { display: flex; height: 100dvh; overflow: hidden; background: var(--bg); }
.s-app :is(a, button, summary, input, textarea, select, [tabindex]) { scroll-margin-block: 24px; }
.s-scroll, .s-pane-body { scroll-padding-block: 28px; }
.s-nav { width: var(--nav-w); flex: none; display: flex; flex-direction: column; padding: 26px 16px 18px; background: var(--surface-1); border-right: 1px solid var(--line); overflow-y: auto; }
.s-lockup { display: flex; align-items: center; padding: 0 12px 26px; color: var(--fg); }
.s-lockup .jit-lockup { height: 34px; width: auto; }
.s-nav nav { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.s-link { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 42px; padding: 9px 12px; border-radius: var(--radius-control); color: var(--fg-2); font-size: var(--size-sm); }
.s-link svg { width: 16px; height: 16px; flex: none; }
.s-link[aria-current=page] { background: var(--surface-3); color: var(--fg); font-weight: 500; }
@media (hover: hover) and (pointer: fine) { .s-link:hover { background: var(--surface-2); color: var(--fg); } }
.s-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s-nav-sec { padding: 25px 12px 8px; color: var(--fg-3); font-size: var(--size-xs); }
.s-nav-number { margin-left: auto; font-size: var(--size-xs); }
.s-new-chat { margin-bottom: 14px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); }
.s-nav .s-chat-list { flex: 1; min-height: 60px; }
.s-nav .s-bot-list { max-height: 32dvh; flex: none; }
.s-nav .s-chat-list, .s-nav .s-bot-list { overflow-y: auto; overflow-x: hidden; padding: 4px; margin-inline: -4px; scroll-padding-block: 8px; }
.s-chat-link { padding-left: 14px; }
.s-nav-foot { margin-top: auto; padding-top: 20px; }
.s-nav-note { padding: 8px 12px 0; color: var(--fg-3); font-size: var(--size-xs); }
.s-main { flex: 1; min-width: 0; display: flex; min-height: 0; }
.s-chatcol { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.s-hdr { display: flex; align-items: center; gap: 12px; min-height: 74px; padding: 14px 32px; border-bottom: 1px solid var(--line); flex: none; }
.s-hdr-t { min-width: 0; flex: 1; }
.s-hdr h1 { font-size: var(--size-ui); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s-hdr small { display: block; color: var(--fg-3); font-size: var(--size-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 3px; }
.s-hdr > .s-tile { display: none; }
.s-needs { display: inline-flex; align-items: center; gap: 7px; min-height: 42px; color: var(--fg-2); font-size: var(--size-xs); padding: 6px 9px; border-radius: var(--radius-control); }
.s-needs svg { width: 15px; height: 15px; flex: none; }
.s-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
.s-col { width: 100%; max-width: var(--chat-width); margin: 0 auto; padding: 36px 32px; display: flex; flex-direction: column; gap: 28px; }
.s-col-wide { max-width: 1000px; }
.s-dock { flex: none; padding: 12px 32px max(22px, env(safe-area-inset-bottom)); background: var(--bg); max-height: 65dvh; overflow-y: auto; }
.s-dock > * { max-width: calc(var(--chat-width) - 64px); margin-inline: auto; }
.s-mobile-nav { display: none; }
.s-pane { width: var(--pane-w); max-width: 48%; flex: none; display: flex; flex-direction: column; min-height: 0; background: var(--bg); border-left: 1px solid var(--line); }
.s-pane-hdr { display: flex; align-items: flex-start; gap: 10px; padding: 24px 24px 16px; flex: none; }
.s-pane-hdr > div { flex: 1; min-width: 0; }
.s-pane-hdr h2 { font-size: var(--size-chat); font-weight: 500; line-height: 1.5; overflow-wrap: anywhere; }
.s-pane-body { flex: 1; min-height: 0; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 24px; }
.s-worktabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--line); flex: none; }
.s-worktabs a { position: relative; display: inline-flex; align-items: center; min-height: 44px; padding: 10px; color: var(--fg-2); font-size: var(--size-sm); }
.s-worktabs a[aria-current=page] { color: var(--fg); font-weight: 500; box-shadow: inset 0 -2px 0 var(--fg); }
.s-management { display: flex; flex-direction: column; gap: 30px; }
.s-management h2 { color: var(--fg-3); font-size: var(--size-xs); font-weight: 500; margin-bottom: 8px; }
.s-management .s-link { padding-inline: 0; }
.s-draft-bar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 10px; font-size: var(--size-xs); color: var(--fg-3); }
.s-draft-bar[hidden] { display: none; }
.s-draft-bar button { border: 0; background: none; padding: 4px; font-size: var(--size-xs); min-height: 32px; }

/* Text and small parts */
.s-mono { font-family: var(--font-mono); font-size: var(--size-sm); overflow-wrap: anywhere; }
.s-meta { color: var(--fg-3); font-size: var(--size-xs); line-height: 1.5; }
.s-sub { color: var(--fg-2); }
.s-link-text { text-decoration: underline; text-underline-offset: 3px; color: var(--fg-2); }
@media (hover: hover) and (pointer: fine) { .s-link-text:hover { color: var(--fg); } }
.s-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.s-between { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.s-stack { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.s-section-t { color: var(--fg-3); font-size: var(--size-xs); font-weight: 500; margin-bottom: 8px; }
.s-card { background: transparent; border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 8px 0 24px; }
.s-card h2, .s-card h3 { font-size: var(--size-ui); }
.s-kv { display: grid; grid-template-columns: minmax(96px, 30%) minmax(0, 1fr); gap: 6px 12px; margin: 0; }
.s-kv dt { color: var(--fg-3); font-size: var(--size-sm); }
.s-kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.s-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; padding: 6px 14px; border: 1px solid var(--line-strong); border-radius: var(--radius-pill); background: transparent; color: var(--fg); font-size: var(--size-sm); font-weight: 500; white-space: normal; text-align: center; }
.s-btn.primary { background: var(--fg); color: var(--on-fg); border-color: var(--fg); }
.s-btn.danger { color: var(--danger); border-color: var(--danger-line); background: transparent; }
@media (hover: hover) and (pointer: fine) { .s-btn:hover { background: var(--surface-3); } .s-btn.primary:hover { background: var(--accent-hover); color: var(--on-fg); } }
.s-btn svg { width: 16px; height: 16px; }
.s-pill { display: inline-flex; align-items: center; gap: 4px; padding: 1px 8px; border: 1px solid var(--line-strong); border-radius: var(--radius-pill); font-size: var(--size-xs); line-height: 18px; white-space: nowrap; color: var(--fg-2); }
.s-pill.strong { color: var(--fg); }
.s-pill.ok { color: var(--ok); border-color: var(--ok-line); }
.s-pill.warn { color: var(--warn); border-color: var(--warn-line); }
.s-pill.danger { color: var(--danger); border-color: var(--danger-line); }
.s-banner { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-control); background: var(--surface-2); }
.s-banner svg { width: 16px; height: 16px; margin-top: 2px; }
.s-banner.warn { border-color: var(--warn-line); }
.s-banner.warn svg { color: var(--warn); }
.s-banner.danger { border-color: var(--danger-line); }
.s-banner.danger svg { color: var(--danger); }
.s-banner.ok svg { color: var(--ok); }
.s-banner > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.s-banner p { line-height: 1.55; }
.s-banner b { font-weight: 600; }
.s-field { display: flex; flex-direction: column; gap: 6px; border: 0; margin: 0; padding: 0; min-width: 0; }
.s-field label, .s-field legend { font-weight: 500; padding: 0; }
.s-field input:not([type=checkbox], [type=radio]), .s-field textarea, .s-field select { width: 100%; min-height: 40px; padding: 8px 12px; background: var(--surface-2); color: var(--fg); border: 1px solid var(--line-strong); border-radius: var(--radius-control); font-size: var(--size-input-mobile); line-height: 1.5; }
.s-field textarea { resize: vertical; min-height: 88px; }
.s-check { display: flex; gap: 10px; align-items: flex-start; padding: 6px 0; font-weight: 400; }
.s-check input { width: 18px; height: 18px; margin: 1px 0 0; accent-color: var(--fg); flex: none; }
.s-check small { display: block; color: var(--fg-3); font-size: var(--size-xs); }
.s-check-fixed { padding-inline-start: 28px; }
.auth-card [role=alert] { margin-block-end: 12px; }
.s-dock [data-draft-text] { max-height: 30vh; overflow-y: auto; white-space: pre-wrap; overflow-wrap: anywhere; }

/* Bot tile: cut from the mark's head; the floating dot is its one living part. */
.s-tile { position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none; width: 32px; height: 32px; margin-top: 6px; background: var(--surface-3); border: 1px solid var(--line-strong); border-radius: var(--radius-tile); font-size: var(--size-sm); font-weight: 600; }
.s-tile.small { width: 22px; height: 22px; margin-top: 4px; font-size: var(--size-xs); }
.s-tile.large { width: 56px; height: 56px; font-size: var(--size-xl); }
.s-tile i { position: absolute; left: 50%; top: -8px; width: 6px; height: 6px; margin-left: -3px; border-radius: 50%; }
.s-tile.small i { top: -6px; width: 4px; height: 4px; margin-left: -2px; }
.s-tile.jit { background: transparent; border: 0; }
.s-tile.jit svg { width: 100%; height: 100%; }
.s-tile.jit i { display: none; }
[data-dot=working] i { background: var(--fg); animation: jit-breath var(--motion-breath) ease-in-out infinite; }
[data-dot=hollow] i { box-shadow: inset 0 0 0 1.5px var(--fg-3); }
[data-dot=waiting] i { background: var(--warn); }
[data-dot=ready] i { background: var(--ok); }
[data-dot=failed] i { background: var(--danger); }
.s-tile.jit[data-dot=working] .jit-dot { animation: jit-breath var(--motion-breath) ease-in-out infinite; transform-box: fill-box; transform-origin: center; }

/* Conversation */
.s-thread { display: flex; flex-direction: column; gap: 32px; }
.s-owner-msg { align-self: stretch; max-width: 100%; padding: 4px 0 4px 18px; border-left: 1px solid var(--line-strong); font-size: var(--size-chat); line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.s-bot-msg { display: flex; gap: 0; align-items: flex-start; }
.s-bot-msg > .s-tile { display: none; }
.s-bot-msg > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.s-bot-text { font-size: var(--size-input-mobile); line-height: 1.9; white-space: pre-wrap; overflow-wrap: anywhere; }
.s-who { font-size: var(--size-xs); color: var(--fg-3); line-height: 1.5; margin-bottom: 4px; }
.s-composer { background: var(--bg); border: 1px solid var(--line-strong); border-radius: var(--radius-composer); padding: 12px 12px 10px 16px; }
.s-composer:focus-within { border-color: var(--fg); box-shadow: 0 0 0 1px var(--fg); }
.s-composer textarea { display: block; width: 100%; min-height: 52px; max-height: 180px; resize: none; field-sizing: content; background: none; border: 0; color: var(--fg); font-size: var(--size-input-mobile); line-height: 1.6; }
.s-composer textarea:focus-visible { outline: none; }
.s-composer textarea::placeholder { color: var(--fg-3); }
.s-composer.big textarea { min-height: 88px; }
.s-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; }
.s-grow { flex: 1; }
.s-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 4px 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-pill); font-size: var(--size-sm); white-space: nowrap; color: var(--fg-2); }
.s-mode { position: relative; cursor: pointer; color: var(--fg); }
.s-mode-work, .s-work-send-label { display: none; }
.s-composer:has(input[name=work]:checked) .s-mode-chat, .s-composer:has(input[name=work]:checked) .s-chat-send-label { display: none; }
.s-composer:has(input[name=work]:checked) .s-mode-work, .s-composer:has(input[name=work]:checked) .s-work-send-label { display: inline; }
.s-composer:has(input[name=work]:checked) .s-send { width: auto; padding-inline: 16px; border-radius: var(--radius-pill); gap: 8px; font-size: var(--size-sm); }
.s-mode input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.s-mode:has(input:checked) { background: var(--fg); color: var(--on-fg); border-color: var(--fg); font-weight: 500; }
.s-mode:has(input:focus-visible) { outline: 2px solid var(--fg); outline-offset: 2px; }
.s-send { width: 36px; height: 36px; padding: 0; min-height: 0; border: 0; border-radius: 50%; background: var(--fg); color: var(--on-fg); flex: none; }
.s-send svg { width: 18px; height: 18px; }
@media (hover: hover) and (pointer: fine) { .s-send:hover { background: var(--accent-hover); color: var(--on-fg); } }
.s-budget { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); color: var(--fg-2); font-size: var(--size-xs); }
@supports selector(:has(a)) {
  .s-composer .s-budget { display: none; }
  .s-composer:has(input[name=work]:checked) .s-budget { display: flex; }
}
.s-scope-summary { font-size: var(--size-xs); color: var(--fg-2); line-height: 1.7; overflow-wrap: anywhere; }
.s-scope-summary[hidden] { display: none; }
.s-limits { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; border: 0; margin: 0; padding: 0; min-width: 0; }
.s-limits legend { padding: 0; margin-bottom: 4px; font-weight: 500; color: var(--fg-2); }
.s-limit { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-2); font-size: var(--size-sm); }
.s-limit input { width: 64px; min-height: 32px; padding: 2px 8px; text-align: right; background: var(--surface-2); color: var(--fg); border: 1px solid var(--line-strong); border-radius: var(--radius-control); font-size: var(--size-input-mobile); }
.s-note { color: var(--fg-3); font-size: var(--size-xs); line-height: 1.5; }
.s-more summary { cursor: pointer; color: var(--fg-2); font-size: var(--size-sm); min-height: 32px; display: flex; align-items: center; }
.s-more summary::before { content: "▸"; margin-right: 6px; }
.s-more[open] summary::before { content: "▾"; }
.s-more[open] > div { display: flex; flex-direction: column; gap: 10px; padding-top: 6px; }

/* Empty conversation */
.s-empty-thread { padding-block: 9vh; }
.s-starters { margin-top: 28px; }
.s-starters a { display: block; padding: 12px 0; font-size: var(--size-sm); color: var(--fg-2); border-bottom: 1px solid var(--line); }
.s-empty-thread > .s-note { margin-top: 12px; }
.s-empty-thread h2 { font-size: var(--size-xl); font-weight: 400; line-height: 1.7; max-width: 480px; }
.s-attention a { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; justify-content: space-between; min-height: 44px; padding: 10px 12px; border: 1px solid var(--warn-line); border-radius: var(--radius-control); margin-bottom: 8px; overflow-wrap: anywhere; }
@media (hover: hover) and (pointer: fine) { .s-attention a:hover { background: var(--surface-1); } }

/* Work card */
.s-workcard { border-block: 1px solid var(--line); padding-block: 14px; }
.s-workcard-hd { display: flex; align-items: flex-start; gap: 8px; padding: 6px 0 8px; }
.s-workcard-hd > div { flex: 1; min-width: 0; }
.s-workcard-hd h3 { font-size: var(--size-ui); font-weight: 600; overflow-wrap: anywhere; }
.s-receipt { color: var(--fg-3); font-size: var(--size-xs); margin-bottom: 8px; }
.s-receipt summary { min-height: 32px; display: flex; align-items: center; cursor: pointer; gap: 6px; }
.s-receipt summary::before { content: "▸"; }
.s-receipt[open] summary::before { content: "▾"; }
.s-receipt p { padding-block: 4px; }
.s-lane-mini { display: flex; align-items: center; gap: 8px; padding: 6px 0; font-size: var(--size-sm); }
.s-lane-mini .s-grow { min-width: 0; color: var(--fg-2); overflow-wrap: anywhere; }
.s-workcard-ft { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 0 0; margin-top: 6px; }
.s-lane { display: flex; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--bg); }
.s-lane > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.s-work-row { display: flex; gap: 12px; align-items: flex-start; padding: 16px 4px; border-bottom: 1px solid var(--line); background: transparent; }
.s-work-row > span:first-child { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.s-work-row small { display: block; color: var(--fg-3); font-size: var(--size-xs); }
@media (hover: hover) and (pointer: fine) { .s-work-row:hover { background: var(--surface-2); } }

/* Meter: 6 px bar, never without its words. Unknown is hatched, never an empty bar that reads as zero. */
.s-meter { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; align-items: baseline; }
.s-meter small { color: var(--fg-2); font-size: var(--size-xs); }
.s-meter meter, .s-meter .s-unknown-bar { grid-column: 1 / -1; display: block; width: 100%; height: 6px; border: 0; border-radius: var(--radius-tail); background: var(--surface-3); appearance: none; }
.s-meter meter::-webkit-meter-bar { height: 6px; background: var(--surface-3); border: 0; border-radius: var(--radius-tail); }
.s-meter meter::-webkit-meter-optimum-value { background: var(--fg); border-radius: var(--radius-tail); }
.s-meter meter::-moz-meter-bar { background: var(--fg); border-radius: var(--radius-tail); }
.s-meter .s-unknown-bar { background: var(--hatch); opacity: .6; }

/* Authority: only owner strips carry decisions. The strip communicates separation; server commands enforce it. */
.s-strip { padding: 12px 14px; background: var(--surface-2); border-top: 1px solid var(--line-strong); }
.s-strip-label { color: var(--fg-3); font-size: var(--size-xs); margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
.s-strip-label svg { width: 14px; height: 14px; }
.s-strip-acts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.s-strip-acts form { margin: 0; }
.s-strip-grant { display: block; margin-bottom: 10px; }
.s-strip .s-note { margin-top: 8px; }
.s-strip .s-more { margin-top: 8px; }
.s-untrusted { padding: 10px 12px; border-left: 2px solid var(--line-strong); background: var(--surface-2); border-radius: 0 var(--radius-control) var(--radius-control) 0; overflow-wrap: anywhere; }
.s-untrusted-tag { color: var(--fg-3); font-size: var(--size-xs); margin-bottom: 4px; }
.s-untrusted p { white-space: pre-wrap; line-height: 1.6; }
.s-slip { border: 1px solid var(--warn-line); border-radius: var(--radius-card); overflow: hidden; background: var(--surface-1); }
.s-slip[data-state=closed] { border-color: var(--line-strong); }
.s-slip[data-state=unknown] { border-color: var(--danger-line); }
.s-slip-hd { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; }
.s-slip-hd > div { flex: 1; min-width: 0; }
.s-slip-hd h2, .s-slip-hd h3 { font-size: var(--size-ui); font-weight: 600; }
.s-slip-hd h2:focus { outline: none; }
.s-slip-hd h2 { scroll-margin-top: 72px; }
.s-slip-body { display: flex; flex-direction: column; gap: 10px; padding: 0 14px 12px; }
.s-exact { margin: 0; padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-control); font-family: var(--font-mono); font-size: var(--size-sm); line-height: 1.6; white-space: pre-wrap; overflow-wrap: anywhere; }
.s-exact-label { color: var(--fg-3); font-size: var(--size-xs); margin-bottom: 4px; }
.s-diff-old { box-shadow: inset 2px 0 0 var(--danger); color: var(--fg-2); text-decoration: line-through; }
.s-diff-new { box-shadow: inset 2px 0 0 var(--ok); }
.s-history li { border-top: 1px solid var(--line); padding: 8px 0; }

/* Bot computer: the lease bar always answers who is driving. The owner outline is the takeover signal, so it reads without colour. */
.s-lease[data-driver=owner] { border-color: var(--fg); }
.s-lease[data-driver=expired] { border-color: var(--warn-line); }
.s-lease .s-slip-hd h2 { font-size: var(--size-chat); }
.s-slip-top { padding-top: 12px; }
.s-screen { border: 1px solid var(--line-strong); border-radius: var(--radius-card); background: var(--bg); min-width: 0; scroll-margin-top: 16px; }
.s-screen[data-driver=owner] { border-color: var(--fg); outline: 2px solid var(--fg); }
.s-screen-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 12px; background: var(--surface-2); border-bottom: 1px solid var(--line); border-radius: var(--radius-card) var(--radius-card) 0 0; }
.s-screen-bar svg { width: 14px; height: 14px; color: var(--fg-3); }
.s-screen-bar h2 { flex: 1; min-width: 0; font-size: var(--size-sm); font-weight: 500; }
.s-screen-bar .s-link-text { display: inline-flex; align-items: center; min-height: 24px; font-size: var(--size-xs); }
.s-screen-view { overflow-x: auto; overscroll-behavior-x: contain; }
.s-screen-view form { margin: 0; }
.s-screen-view img { display: block; width: 100%; height: auto; }
.s-screen-view input[type=image] { display: block; max-width: none; padding: 0; border: 0; border-radius: 0; cursor: crosshair; }
[data-enhanced] .s-screen-view input[type=image] { width: 100%; height: auto; }
.s-screen-empty { display: flex; align-items: center; justify-content: center; aspect-ratio: 16 / 10; padding: 16px; background: var(--surface-1); color: var(--fg-2); text-align: center; }
.s-screen-note { padding: 8px 12px; border-top: 1px solid var(--line); }
.s-input-status:empty { display: none; }
.s-keys { display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr)); gap: 8px; }
.s-log { margin: 0; padding: 0; list-style: none; }
.s-log li { display: grid; grid-template-columns: minmax(112px, auto) minmax(0, 1fr); gap: 12px; padding: 6px 0; border-bottom: 1px solid var(--line); font-size: var(--size-sm); }
.s-log time { color: var(--fg-3); font-size: var(--size-xs); padding-top: 1px; }

/* Setup, sign-in and notice pages */
.s-page:has(.auth-card) { justify-content: center; }
.s-page { min-height: 100dvh; display: flex; flex-direction: column; align-items: center; padding: 32px 20px max(32px, env(safe-area-inset-bottom)); background: var(--bg); }
.s-setup-steps { display: flex; gap: 4px; width: 100%; max-width: 560px; margin: 8px 0 24px; padding: 0; list-style: none; }
.s-setup-steps li { flex: 1; min-width: 0; padding-top: 8px; border-top: 2px solid var(--line-strong); color: var(--fg-3); font-size: var(--size-xs); }
.s-setup-steps li[data-step=current] { border-top-color: var(--fg); color: var(--fg); font-weight: 500; }
.s-setup-steps li[data-step=done] { border-top-color: var(--fg-3); color: var(--fg-2); }
.s-setup-card { width: 100%; max-width: 560px; display: flex; flex-direction: column; gap: 16px; }
.s-setup-card h1 { font-size: var(--size-xl); }
.s-ready li { display: flex; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); align-items: flex-start; }
.s-ready li > svg { width: 16px; height: 16px; margin-top: 2px; }
.s-ready li > div { flex: 1; min-width: 0; }
.s-ready .ok { color: var(--ok); }
.s-ready .warn { color: var(--warn); }
.s-ready .danger { color: var(--danger); }
.s-ceremony { display: flex; justify-content: center; padding: 8px 0; }
.s-ceremony .jit-mark { width: 96px; height: 96px; }
.s-notice-card { width: 100%; max-width: 560px; margin-top: 10vh; display: flex; flex-direction: column; gap: 16px; }
.s-notice-card h1 { font-size: var(--size-xl); }
.s-notice-card > p { color: var(--fg-2); }

@media (prefers-reduced-motion: reduce) {
  [data-dot=working] i, .s-tile.jit[data-dot=working] .jit-dot { animation: none; }
  .s-btn:active, button:active { transform: none; }
}

@media (max-width: 1039px) {
  .s-main[data-pane=open] .s-chatcol { display: none; }
  .s-main[data-pane=open] .s-pane { width: 100%; max-width: none; border-left: 0; }
  .s-pane-hdr { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px; }
  .s-pane-hdr > div { grid-row: 2; grid-column: 1 / -1; }
  .s-pane-hdr > .s-pill { justify-self: start; }
  .s-app:has(.s-main[data-pane=open]) .s-nav { display: none; }
}
@media (max-width: 799px) {
  .s-nav { display: none; }
  .s-hdr { position: relative; padding: 10px 16px; min-height: 62px; gap: 8px; }
  .s-hdr-act .s-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .s-hdr-act .s-btn { padding-inline: 10px; }
  .s-mobile-nav { display: block; flex: none; }
  .s-mobile-nav:not([open]) .s-mobile-panel { display: none; }
  .s-mobile-nav > summary { display: flex; align-items: center; justify-content: center; width: 44px; height: 44px; cursor: pointer; border: 1px solid var(--line); border-radius: var(--radius-control); }
  .s-mobile-nav > summary::marker { content: ""; }
  .s-mobile-nav > summary::-webkit-details-marker { display: none; }
  .s-mobile-nav > summary svg { width: 18px; height: 18px; }
  .s-mobile-panel { position: absolute; z-index: 5; left: 12px; right: 12px; top: calc(100% - 4px); max-height: 70dvh; overflow-y: auto; padding: 20px 14px; background: var(--surface-1); border: 1px solid var(--line-strong); border-radius: var(--radius-card); }
  .s-col { padding: 26px 20px; gap: 24px; }
  .s-dock { padding: 10px 12px max(12px, env(safe-area-inset-bottom)); }
  .s-dock > * { max-width: 100%; }
  .s-pane-hdr, .s-pane-body { padding: 20px; }
  .s-btn, .s-link, .s-worktabs a { min-height: 44px; }
  .s-send { width: 44px; height: 44px; }
  .s-chip { min-height: 40px; }
  .s-needs { min-height: 44px; }
  .s-limit input, .s-check { min-height: 40px; }
  .s-draft-bar button, .s-col .s-link-text, .s-pane-body .s-link-text { min-height: 40px; display: inline-flex; align-items: center; }
  .s-needs svg { display: none; }
  .s-kv { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .s-kv dd { margin-bottom: 8px; }
  .s-strip-acts form:not(.s-strip-grant), .s-strip-acts .s-btn { width: 100%; }
}
/* A phone on its side: the thread keeps the height, and the composer still grows as it fills. */
@media (max-height: 480px) {
  .s-hdr { min-height: 44px; padding-block: 4px; }
  .s-hdr-t small { display: none; }
  .s-dock { padding-block: 4px max(4px, env(safe-area-inset-bottom)); }
  .s-composer { padding-block: 6px; }
  .s-composer textarea { min-height: 28px; }
  .s-bar { margin-top: 2px; }
}
/* Forced colours drop backgrounds and shadows, so the states drawn with them get a system colour or an outline. */
@media (forced-colors: active) {
  .s-mode:has(input:checked) { forced-color-adjust: none; background: Highlight; color: HighlightText; border-color: Highlight; }
  .s-composer:focus-within { outline: 2px solid CanvasText; }
  .s-link[aria-current=page], .s-tabs a[aria-current=page] { outline: 1px solid CanvasText; outline-offset: -1px; }
  .s-worktabs a[aria-current=page] { border-block-end: 2px solid CanvasText; }
}
`;
}
