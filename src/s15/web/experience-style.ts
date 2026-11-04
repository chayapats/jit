import { scaleTokens } from "../../web-design";

/** Owner-approved premium S15 presentation; scoped to the opt-in shell and shared design tokens. */
export function s15ExperienceStyle(): string {
  return `
.s15-app { --radius-card: ${scaleTokens.radius.card}px; --s15-ease: cubic-bezier(.22,1,.36,1); }
.s15-app .s-nav { padding: 28px 12px 20px; border-right-color: transparent; }
.s15-app .s-lockup { padding-bottom: 28px; }
.s15-app .s-new-chat { border: 0; background: transparent; margin-bottom: 4px; }
.s15-app .s-link { min-height: 44px; font-size: var(--size-ui); }
.s15-app .s-link[aria-current=page] { background: var(--surface-2); font-weight: 400; }
.s15-app .s-nav-sec { padding-top: 24px; }
.s15-app .s-nav .s-chat-list { flex: none; max-height: 28dvh; min-height: 0; }
.s15-nav-group summary { list-style: none; min-height: 44px; display: flex; align-items: center; gap: 10px; padding: 8px 12px; cursor: pointer; color: var(--fg-2); }
.s15-nav-group summary::-webkit-details-marker { display: none; }
.s15-nav-group summary svg { width: 18px; height: 18px; }
.s15-nav-group ul { padding-left: 12px; }
.s15-nav-foot { margin-top: auto; padding: 20px 12px 0; color: var(--fg-3); font-size: var(--size-xs); border-top: 1px solid var(--line); }
.s15-app .s-hdr { min-height: 76px; padding-inline: 32px; }
.s15-app .s-needs { border: 1px solid var(--line); min-height: 36px; }
.s15-hdr-search { display: grid; place-items: center; min-width: 44px; min-height: 44px; color: var(--fg-2); }
.s15-hdr-search svg { width: 18px; height: 18px; }
.s15-app .s-col { gap: 24px; padding: 36px; }
.s15-app .s15-thread { gap: 36px; }
.s15-app .s15-row { gap: 12px; min-width: 0; }
.s15-app .s-owner-msg { align-self: flex-end; max-width: 88%; padding: 12px 16px; border: 0; background: var(--surface-2); border-radius: var(--radius-card) var(--radius-card) var(--radius-tail) var(--radius-card); font-size: var(--size-ui); line-height: 1.8; }
.s15-app .s15-receipt { text-align: right; padding-left: 0; margin-top: -4px; margin-bottom: 16px; }
.s15-author { display: flex; align-items: center; gap: 10px; margin-top: 4px; font-size: var(--size-ui); font-weight: 500; }
.s15-author svg { width: 26px; height: 26px; flex: none; }
.s15-app .s15-intent { color: var(--fg-2); font-size: var(--size-xs); }
.s15-app .s15-work { border: 0; padding: 0; }
.s15-app .s-workcard-hd { padding-block: 4px 12px; gap: 16px; }
.s15-app .s15-work .s-workcard-hd h3 { font-size: var(--size-lg); font-weight: 500; }
.s15-app .s15-scope { font-size: var(--size-xs); color: var(--fg-3); }
.s15-app .s15-scope > p { margin-bottom: 4px; }
.s15-app .s15-result { gap: 16px; padding-block: 16px; line-height: 1.8; }
.s15-app .s15-result > .s-untrusted, .s15-app .s-bot-msg .s-untrusted { padding: 0; border: 0; background: transparent; border-radius: 0; }
.s15-app .s-untrusted-tag { font-size: var(--size-xs); color: var(--fg-3); }
.s15-app .s15-result .s15-text { font-size: var(--size-chat); line-height: 1.85; }
.s15-app .s15-progress { border-left: 1px solid var(--line); margin-top: 12px; padding: 4px 0 4px 14px; }
.s15-app .s15-gaps { margin-top: 8px; font-size: var(--size-sm); }
.s15-app .s15-footer { flex-direction: row; flex-wrap: wrap; gap: 8px 20px; margin-top: 8px; }
.s15-app .s15-footer > details { min-width: 0; }
.s15-app .s15-footer > details[open] { flex-basis: 100%; }
.s15-app .s15-footer summary { font-size: var(--size-xs); min-height: 44px; }
.s15-app .s15-readiness { margin-top: 8px; }
.s15-app .s15-readiness h4 { font-size: var(--size-lg); color: var(--fg); font-weight: 500; margin-bottom: 16px; }
.s15-app .s15-table { table-layout: fixed; }
.s15-app .s15-table th, .s15-app .s15-table td { padding-block: 18px; overflow-wrap: anywhere; }
.s15-app .s15-table thead th:first-child { width: 52px; }
.s15-app .s15-table thead th:nth-child(3), .s15-app .s15-table thead th:nth-child(4) { width: 112px; }
.s15-app .s15-facts { margin-top: 8px; color: var(--fg-3); font-size: var(--size-xs); }
.s15-app .s15-slip-compact, .s15-app .s15-duty, .s15-app .s15-computer, .s15-app .s15-login { padding: 20px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface-1); }
.s15-app .s15-duty .s-slip-body { padding: 8px 0 0; }
.s15-app .s15-work > .s-slip[data-state=closed] { border: 0; margin-top: 8px; }
.s15-app .s15-work > .s-slip .s-strip { padding: 12px 0; background: transparent; }
.s15-app .s-dock { padding: 16px 32px max(18px, env(safe-area-inset-bottom)); }
.s15-app .s-composer { padding: 12px 14px 10px; background: var(--surface-2); border-color: var(--line); box-shadow: none; }
.s15-app .s-composer:focus-within { border-color: var(--fg-3); box-shadow: none; }
.s15-app .s-composer textarea { min-height: 60px; max-height: min(240px, 30dvh); field-sizing: content; overflow-y: auto; font-size: var(--size-ui); line-height: 1.8; }
.s15-app .s-composer .s-chip { border-color: transparent; padding-inline: 4px; font-size: var(--size-xs); }
.s15-app .s-composer .s15-answer { border-color: var(--line-strong); padding-inline: 8px; }
.s15-app .s-send { display: inline-grid; place-items: center; width: 40px; height: 40px; }
.s15-composer-note { text-align: center; margin-top: 10px; font-size: var(--size-xs); color: var(--fg-3); }
.s15-attachment-limit summary { display: grid; place-items: center; width: 36px; height: 44px; list-style: none; cursor: pointer; color: var(--fg-2); }
.s15-attachment-limit summary::-webkit-details-marker { display: none; }
.s15-attachment-limit svg { width: 18px; height: 18px; }
.s15-attachment-limit[open] { flex-basis: 100%; order: 5; }
.s15-attachment-limit p { max-width: 64ch; padding: 8px 0; }
.s15-app .s-empty-thread { padding-block: 72px; }
.s15-app .s-empty-thread > svg { margin-bottom: 24px; }
.s15-app .s-empty-thread h2 { font-size: var(--size-xl); font-weight: 500; }
.s15-library-item { display: flex; gap: 14px; align-items: center; padding: 20px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface-1); }
.s15-library-item > svg { width: 24px; height: 24px; flex: none; }
.s15-library-item > span { flex: 1; min-width: 0; }
.s15-library-item small { display: block; margin-top: 6px; color: var(--fg-3); font-size: var(--size-xs); }
.s15-library-detail { display: flex; flex-direction: column; gap: 24px; }
.s15-dialog { max-width: 620px; width: calc(100% - 32px); max-height: calc(100dvh - 32px); margin: auto; padding: 0; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface-1); color: var(--fg); overscroll-behavior: contain; }
.s15-dialog::backdrop { background: var(--scrim-drawer); }
.s15-dialog-head { display: flex; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 2; background: var(--surface-1); }
.s15-dialog-head h2 { flex: 1; min-width: 0; font-size: var(--size-ui); }
.s15-dialog-head button { border: 0; padding: 8px; min-width: 44px; min-height: 44px; background: transparent; color: var(--fg-2); border-radius: var(--radius-control); }
.s15-dialog-head svg { width: 18px; height: 18px; }
.s15-dialog-body { padding: 24px; }
.s15-dialog .s-col { max-width: none; padding: 0; }
.s15-dialog .s-slip { border: 0; background: transparent; }
.s15-dialog .s-slip-hd, .s15-dialog .s-slip-body { padding-inline: 0; }
.s15-dialog .s-strip { background: transparent; padding: 20px 0; }
.s15-dialog .s-exact { white-space: pre-wrap; overflow-wrap: anywhere; }
.s15-search-field { width: 100%; padding: 12px; margin-bottom: 16px; min-height: 44px; background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--radius-control); color: var(--fg); font-size: var(--size-ui); }
.s15-search-form { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-bottom: 16px; }
.s15-search-form .s15-search-field { min-width: 0; margin-bottom: 0; }
.s15-search-results { display: flex; flex-direction: column; gap: 4px; }
.s15-dialog [hidden] { display: none !important; }
.s15-app .s-pill { white-space: normal; }
html[data-s15-enhanced] { view-transition-name: none; }
::view-transition { pointer-events: none; }
::view-transition-group(*) { animation-duration: var(--motion-panel); animation-timing-function: cubic-bezier(.22,1,.36,1); }
::view-transition-old(s15-reading) { animation: s15-leave var(--motion-ui) ease-out both; }
::view-transition-new(s15-reading) { animation: s15-enter var(--motion-panel) cubic-bezier(.22,1,.36,1) both; }
@keyframes s15-leave { to { opacity: 0; transform: translateY(-5px); } }
@keyframes s15-enter { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
.s15-app .s-link, .s15-app .s-btn, .s15-app .s-send { transition: background var(--motion-ui) ease-out, color var(--motion-ui) ease-out, transform var(--motion-ui) ease-out; }
.s15-app .s-strip button, .s15-app .s-strip button:active { transform: none; }
@media (prefers-reduced-motion: reduce) {
 .s15-app *, .s15-app *::before, .s15-app *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important; }
 ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation: none !important; }
}
@media (min-width: 1100px) { .s15-detail:not([data-s15-presentation=approval]) { margin-right: 24px; } }
@media (max-width: 1023px) { .s15-app .s-nav { display: none; } .s15-app .s-mobile-nav { display: block; } }
@media (max-width: 650px) {
 .s15-app .s-hdr { padding: 12px; gap: 8px; }
 .s15-app .s-hdr small { font-size: var(--size-xs); }
 .s15-app .s-col { padding: 24px 20px; }
 .s15-app .s-owner-msg { max-width: 94%; }
 .s15-app .s-dock { padding: 12px 12px max(12px, env(safe-area-inset-bottom)); }
 .s15-app .s-composer textarea { font-size: var(--size-input-mobile); }
 .s15-app .s-send { width: 44px; height: 44px; }
 .s15-app .s-btn, .s15-app .s-chip, .s15-app .s-more summary { min-height: 44px; }
 .s15-app .s15-table-wrap { overflow: visible; }
 .s15-app .s15-table thead { display: none; }
 .s15-app .s15-table tbody { display: flex; flex-direction: column; }
 .s15-app .s15-table tr { display: grid; grid-template-columns: 1fr auto; gap: 8px; padding: 16px 0; border-top: 1px solid var(--line); }
 .s15-app .s15-table th, .s15-app .s15-table td { border: 0; padding: 0; }
 .s15-app .s15-table td:nth-child(2) { grid-column: 1 / -1; grid-row: 2; }
 .s15-app .s15-table td:last-child { grid-column: 1 / -1; justify-self: end; }
 .s15-dialog { width: calc(100% - 16px); max-height: calc(100dvh - 16px); margin: auto; }
 .s15-dialog-body { padding: 20px; }
 .s15-dialog .s-strip-acts { flex-direction: column; align-items: stretch; }
 .s15-dialog .s-strip-acts form, .s15-dialog .s-strip-acts .s-btn { width: 100%; }
 .s15-hdr-search { display: none; }
 .s15-composer-note { display: none; }
}
@media (hover: hover) and (pointer: fine) { .s15-app .s15-library-item:hover, .s15-dialog .s-link:hover { background: var(--surface-2); } }
`;
}
