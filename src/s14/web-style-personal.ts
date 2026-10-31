/**
 * Google account, brief and exact-action styles, appended to the S14 stylesheet. Same `s-` prefix and the same
 * ui.token_lint/v1 rule as web-style.ts: literal colours, sizes, radii and durations stay in src/web-design.ts.
 */
export function s14PersonalStyleSheet(): string {
  return `
.s-guide-steps { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 4px; margin: 0; padding: 0; list-style: none; }
.s-guide-steps a { display: flex; flex-direction: column; gap: 2px; min-height: 44px; padding: 6px 2px 0; border-top: 2px solid var(--line-strong); color: var(--fg-3); font-size: var(--size-xs); }
.s-guide-steps [data-step=past] a { border-top-color: var(--fg-3); color: var(--fg-2); }
.s-guide-steps [data-step=current] a { border-top-color: var(--fg); color: var(--fg); font-weight: 500; }
.s-guide-n { font-family: var(--font-mono); }
.s-guide-name { min-width: 0; overflow-wrap: anywhere; }
.s-guide h2 { font-size: var(--size-lg); font-weight: 600; }
.s-guide h2:focus { outline: none; }
.s-guide h3 { font-size: var(--size-ui); font-weight: 600; }
.s-guide-do { display: flex; flex-direction: column; gap: 8px; margin: 0; padding-left: 22px; line-height: 1.6; }
.s-copy { display: flex; flex-direction: column; min-width: 0; }
.s-copy-row { display: flex; align-items: stretch; gap: 8px; min-width: 0; }
.s-copy-row code { display: block; flex: 1; min-width: 0; user-select: all; }
.s-copy-row .s-btn { flex: none; align-self: center; }
.s-google-warning { display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--surface-2); border: 1px solid var(--warn-line); border-radius: var(--radius-control); min-width: 0; }
.s-google-warning h3 { font-size: var(--size-ui); font-weight: 600; }
.s-google-scopes { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.s-google-scopes li { display: flex; flex-direction: column; min-width: 0; }
.s-google-scopes .s-google-no { color: var(--fg-2); font-size: var(--size-sm); }
.s-google-consent span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.s-google-consent b { font-weight: 500; }
.s-google-consent small { color: var(--fg-2); font-size: var(--size-xs); line-height: 1.5; }
.s-google-consent small.s-mono { color: var(--fg-3); }
.s-google-bot { align-items: center; }
.s-google-bot h3 { overflow-wrap: anywhere; }
.s-google-people { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.s-untrusted .s-exact { background: var(--bg); }
.s-untrusted .s-exact + .s-exact-label { margin-top: 8px; }
.s-brief-t { margin: 0; font-size: var(--size-ui); font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.s-source-row { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line); min-width: 0; scroll-margin-top: 16px; }
.s-worktabs { overflow-x: auto; scrollbar-width: none; }
.s-worktabs a { flex: none; }
.s-source-row:target { box-shadow: -8px 0 0 var(--bg), -10px 0 0 var(--fg); }
@media (max-width: 679px) {
  .s-guide-steps .s-guide-name { display: none; }
  .s-copy-row { flex-direction: column; }
  .s-copy-row .s-btn { align-self: flex-start; }
  .s-col > .s-between:has(> a.s-btn) { flex-wrap: wrap; }
}
`;
}
