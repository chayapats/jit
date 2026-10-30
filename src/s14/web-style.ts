import { scaleTokens } from "../web-design";

/**
 * S14 product stylesheet, layered on the shared base (`app.css`) so tokens, fonts, buttons and the focus ring stay one
 * system. Every class is `s-` prefixed. Literal colours, sizes, radii and durations stay in src/web-design.ts (ui.token_lint/v1).
 */
export function s14StyleSheet(): string {
  return `
:root {
  --nav-w: ${scaleTokens.layout.nav}px;
  --rail-w: ${scaleTokens.layout.rail}px;
  --pane-w: ${scaleTokens.layout.pane}px;
  --radius-tile: ${scaleTokens.layout.tileRadius};
  --hatch: repeating-linear-gradient(135deg, var(--fg-3) 0 2px, transparent 2px 5px);
}
html, body { height: 100%; }
.s-app { display: flex; height: 100dvh; overflow: hidden; background: var(--bg); }
.s-nav { width: var(--nav-w); flex: none; display: flex; flex-direction: column; gap: 2px; padding: 16px 12px 12px; background: var(--surface-1); border-right: 1px solid var(--line); overflow-y: auto; }
.s-lockup { display: flex; align-items: center; min-height: 44px; padding: 0 8px 12px; color: var(--fg); }
.s-lockup .jit-lockup { height: 36px; width: auto; }
.s-lockup .s-rail-mark { display: none; }
.s-link { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 36px; padding: 6px 10px; border-radius: var(--radius-control); color: var(--fg-2); }
.s-link svg { width: 16px; height: 16px; }
.s-link[aria-current=page] { background: var(--surface-3); color: var(--fg); font-weight: 500; }
@media (hover: hover) and (pointer: fine) { .s-link:hover { background: var(--surface-3); color: var(--fg); } }
.s-link .s-count { margin-left: auto; }
.s-link .s-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s-nav-sec { padding: 14px 10px 4px; color: var(--fg-3); font-size: var(--size-xs); }
.s-nav-foot { margin-top: auto; padding-top: 8px; border-top: 1px solid var(--line); }
.s-main { flex: 1; min-width: 0; display: flex; min-height: 0; }
.s-chatcol { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.s-hdr { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 8px 24px; border-bottom: 1px solid var(--line); flex: none; }
.s-hdr-t { min-width: 0; flex: 1; }
.s-hdr h1 { font-size: var(--size-ui); font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s-hdr small { display: block; color: var(--fg-3); font-size: var(--size-xs); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.s-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
.s-col { max-width: var(--chat-width); margin: 0 auto; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
.s-col-wide { max-width: 960px; }
.s-dock { flex: none; padding: 8px 24px max(16px, env(safe-area-inset-bottom)); background: var(--bg); }
.s-dock > * { max-width: var(--chat-width); margin-inline: auto; }
.s-tabs, .s-hdr .s-back { display: none; }

/* Work pane: a server-rendered column, opened by a plain link. Below 1040 px it replaces the conversation. */
.s-pane { width: var(--pane-w); flex: none; display: flex; flex-direction: column; min-height: 0; background: var(--surface-1); border-left: 1px solid var(--line); }
.s-pane-hdr { display: flex; align-items: flex-start; gap: 10px; padding: 14px 16px 10px; flex: none; }
.s-pane-hdr > div { flex: 1; min-width: 0; }
.s-pane-hdr h2 { font-size: var(--size-chat); font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; }
.s-pane-body { flex: 1; min-height: 0; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
.s-pane .s-card, .s-pane .s-slip, .s-pane .s-workcard { background: var(--bg); }
.s-worktabs { display: flex; gap: 2px; padding: 0 12px; border-bottom: 1px solid var(--line); flex: none; }
.s-worktabs a { position: relative; display: inline-flex; align-items: center; min-height: 40px; padding: 8px 10px; color: var(--fg-2); }
.s-worktabs a[aria-current=page] { color: var(--fg); font-weight: 500; box-shadow: inset 0 -2px 0 var(--fg); }

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
.s-card { background: var(--surface-1); border: 1px solid var(--line); border-radius: var(--radius-card); padding: 16px; }
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
.s-thread { display: flex; flex-direction: column; gap: 20px; }
.s-owner-msg { align-self: flex-end; max-width: 85%; padding: 10px 14px; background: var(--surface-2); border-radius: var(--radius-card) var(--radius-card) var(--radius-tail) var(--radius-card); font-size: var(--size-chat); line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.s-bot-msg { display: flex; gap: 12px; align-items: flex-start; }
.s-bot-msg > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
.s-bot-text { font-size: var(--size-chat); line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.s-who { font-size: var(--size-xs); color: var(--fg-3); line-height: 1.4; }
.s-composer { background: var(--surface-1); border: 1px solid var(--line-strong); border-radius: var(--radius-composer); padding: 12px 12px 10px 16px; }
.s-composer:focus-within { border-color: var(--fg); }
.s-composer textarea { display: block; width: 100%; min-height: 52px; max-height: 240px; resize: none; field-sizing: content; background: none; border: 0; color: var(--fg); font-size: var(--size-input-mobile); line-height: 1.6; }
.s-composer textarea:focus-visible { outline: none; }
.s-composer textarea::placeholder { color: var(--fg-3); }
.s-composer.big textarea { min-height: 88px; }
.s-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; }
.s-grow { flex: 1; }
.s-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 4px 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-pill); font-size: var(--size-sm); white-space: nowrap; color: var(--fg-2); }
.s-mode { cursor: pointer; color: var(--fg); }
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
.s-limits { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; border: 0; margin: 0; padding: 0; min-width: 0; }
.s-limits legend { padding: 0; margin-bottom: 4px; font-weight: 500; color: var(--fg-2); }
.s-limit { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-2); font-size: var(--size-sm); }
.s-limit input { width: 64px; min-height: 32px; padding: 2px 8px; text-align: right; background: var(--surface-2); color: var(--fg); border: 1px solid var(--line-strong); border-radius: var(--radius-control); font-size: var(--size-input-mobile); }
.s-note { color: var(--fg-3); font-size: var(--size-xs); line-height: 1.5; }
.s-more summary { cursor: pointer; color: var(--fg-2); font-size: var(--size-sm); min-height: 32px; display: flex; align-items: center; }
.s-more summary::before { content: "▸"; margin-right: 6px; }
.s-more[open] summary::before { content: "▾"; }
.s-more[open] > div { display: flex; flex-direction: column; gap: 10px; padding-top: 6px; }

/* Home */
.s-home { display: flex; flex-direction: column; align-items: center; min-height: 100%; padding: 12vh 24px 32px; gap: 16px; }
.s-home > * { width: 100%; max-width: var(--chat-width); }
.s-hello { display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center; }
.s-hello h2 { font-size: var(--size-xxl); }
.s-starters a { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 10px 4px; border-bottom: 1px solid var(--line); color: var(--fg-2); }
@media (hover: hover) and (pointer: fine) { .s-starters a:hover { color: var(--fg); } }
.s-team-now { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.s-bot-mini { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-control); min-width: 0; }
@media (hover: hover) and (pointer: fine) { .s-bot-mini:hover { background: var(--surface-1); } }
.s-bot-mini > span:last-child { min-width: 0; }
.s-bot-mini b { display: block; font-weight: 500; overflow-wrap: anywhere; }
.s-bot-mini small { display: block; color: var(--fg-3); font-size: var(--size-xs); }
.s-attention a { display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; justify-content: space-between; min-height: 44px; padding: 10px 12px; border: 1px solid var(--warn-line); border-radius: var(--radius-control); margin-bottom: 8px; overflow-wrap: anywhere; }
@media (hover: hover) and (pointer: fine) { .s-attention a:hover { background: var(--surface-1); } }

/* Work card */
.s-workcard { border: 1px solid var(--line-strong); border-radius: var(--radius-card); overflow: hidden; background: var(--surface-1); }
.s-workcard-hd { display: flex; align-items: flex-start; gap: 8px; padding: 12px 14px 8px; }
.s-workcard-hd > div { flex: 1; min-width: 0; }
.s-workcard-hd h3 { font-size: var(--size-ui); font-weight: 600; overflow-wrap: anywhere; }
.s-receipt { display: flex; flex-wrap: wrap; gap: 2px 8px; padding: 0 14px 8px; color: var(--fg-3); font-size: var(--size-xs); }
.s-lane-mini { display: flex; align-items: center; gap: 8px; padding: 6px 14px; font-size: var(--size-sm); }
.s-lane-mini .s-grow { min-width: 0; color: var(--fg-2); overflow-wrap: anywhere; }
.s-workcard-ft { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line); margin-top: 6px; }
.s-lane { display: flex; gap: 12px; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--bg); }
.s-lane > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.s-work-row { display: flex; gap: 12px; align-items: flex-start; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--surface-1); margin-bottom: 8px; }
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

/* Setup, sign-in and notice pages */
.s-page:has(.auth-card) { justify-content: center; }
.s-page { min-height: 100dvh; display: flex; flex-direction: column; align-items: center; padding: 32px 20px max(32px, env(safe-area-inset-bottom)); background: var(--bg); }
.s-steps { display: flex; gap: 4px; width: 100%; max-width: 560px; margin: 8px 0 24px; padding: 0; list-style: none; }
.s-steps li { flex: 1; min-width: 0; padding-top: 8px; border-top: 2px solid var(--line-strong); color: var(--fg-3); font-size: var(--size-xs); }
.s-steps li[data-step=current] { border-top-color: var(--fg); color: var(--fg); font-weight: 500; }
.s-steps li[data-step=done] { border-top-color: var(--fg-3); color: var(--fg-2); }
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

/* Rail: the same links, labels kept for assistive technology. */
@media (max-width: 1359px) { .s-main[data-pane=open] { min-width: 0; } .s-app:has(.s-main[data-pane=open]) .s-nav { width: var(--rail-w); padding-inline: 8px; }
  .s-app:has(.s-main[data-pane=open]) .s-nav .s-label, .s-app:has(.s-main[data-pane=open]) .s-nav .s-nav-sec { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .s-app:has(.s-main[data-pane=open]) .s-lockup .jit-lockup { display: none; }
  .s-app:has(.s-main[data-pane=open]) .s-lockup .s-rail-mark { display: inline-flex; }
  .s-app:has(.s-main[data-pane=open]) .s-link { justify-content: center; padding-inline: 4px; }
  .s-app:has(.s-main[data-pane=open]) .s-count { display: none; }
}
@media (max-width: 1039px) {
  .s-nav { width: var(--rail-w); padding-inline: 8px; }
  .s-nav .s-label, .s-nav .s-nav-sec { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .s-lockup .jit-lockup { display: none; }
  .s-lockup .s-rail-mark { display: inline-flex; }
  .s-link { justify-content: center; padding-inline: 4px; }
  .s-count { display: none; }
  .s-main[data-pane=open] .s-chatcol { display: none; }
  .s-main[data-pane=open] .s-pane { width: 100%; border-left: 0; }
}
@media (max-width: 679px) {
  .s-app { flex-direction: column; }
  .s-nav { display: none; }
  .s-main { min-height: 0; }
  .s-hdr { padding: 8px 16px; }
  .s-hdr .s-back { display: inline-flex; padding: 6px 10px; }
  .s-col { padding: 16px; }
  .s-home { padding: 8vh 16px 24px; }
  .s-hello h2 { font-size: var(--size-xl); }
  .s-dock { padding: 8px 12px max(12px, env(safe-area-inset-bottom)); }
  .s-tabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); flex: none; min-height: 56px; padding-bottom: env(safe-area-inset-bottom); background: var(--surface-1); border-top: 1px solid var(--line); }
  .s-tabs a { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-height: 56px; color: var(--fg-2); font-size: var(--size-xs); }
  .s-tabs svg { width: 18px; height: 18px; }
  .s-tabs a[aria-current=page] { color: var(--fg); font-weight: 500; }
  .s-tabs .s-pill { position: absolute; top: 4px; left: calc(50% + 6px); }
  .s-app:has([data-in-chat]) .s-tabs { display: none; }
  .s-btn, .s-link, .s-worktabs a { min-height: 44px; }
  .s-send { width: 44px; height: 44px; }
  .s-chip { min-height: 40px; }
  .s-kv { grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .s-kv dd { margin-bottom: 8px; }
  .s-strip-acts form:not(.s-strip-grant), .s-strip-acts .s-btn { width: 100%; }
}
`;
}
