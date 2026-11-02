/**
 * First-run, provider, sign-in, preference and recovery styles, appended to the S14 stylesheet. Same `s-` prefix and the
 * same ui.token_lint/v1 rule as web-style.ts: literal colours, sizes, radii and durations stay in src/web-design.ts.
 */
export function s14FirstRunStyleSheet(): string {
  return `
.s-setup-card .s-sub { line-height: 1.6; }
.s-setup-card form { margin: 0; }
.s-providers { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.s-provider { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; padding: 16px 0; background: transparent; border-bottom: 1px solid var(--line); border-radius: 0; min-width: 0; }
.s-provider[data-ready] { border-color: var(--ok-line); }
.s-provider > div:first-child { flex: 1 1 200px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.s-provider b { font-weight: 600; font-size: var(--size-chat); }
.s-provider form { margin: 0; }
.s-provider-state { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 4px; }
.s-signin-steps { display: flex; flex-direction: column; gap: 16px; margin: 0; padding: 0; list-style: none; counter-reset: signin; }
.s-signin-steps > li { position: relative; display: flex; flex-direction: column; gap: 8px; padding-left: 36px; min-width: 0; counter-increment: signin; }
.s-signin-steps > li::before { content: counter(signin); position: absolute; left: 0; top: 0; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border: 1px solid var(--line-strong); border-radius: var(--radius-pill); color: var(--fg-2); font-size: var(--size-xs); }
.s-signin-steps > li > p:first-child { font-weight: 500; line-height: 1.6; }
.s-signin-uri { color: var(--fg-3); font-family: var(--font-mono); font-size: var(--size-xs); overflow-wrap: anywhere; }
.s-signin-code { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
.s-code { padding: 8px 14px; background: var(--surface-2); border: 1px solid var(--line-strong); border-radius: var(--radius-control); font-family: var(--font-mono); font-size: var(--size-xl); font-weight: 600; letter-spacing: .08em; overflow-wrap: anywhere; user-select: all; }
.s-signin-wait { display: flex; gap: 10px; align-items: flex-start; }
.s-signin-wait > span { flex: none; width: 8px; height: 8px; margin-top: 7px; border-radius: 50%; background: var(--fg); animation: jit-breath var(--motion-breath) ease-in-out infinite; }
.s-signin-acts { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.s-signin-acts form { margin: 0; }
.s-js { display: none; }
[data-enhanced] .s-js { display: revert; }
[data-enhanced] .s-nojs { display: none; }
.s-hdr .s-hdr-act { flex: none; margin: 0; }
.s-nav-new { margin: 2px 0 0; }
.s-nav-new button { background: none; border: 0; }
@media (min-width: 1040px) { .s-nav-new .s-link { justify-content: flex-start; } }
.s-home-chats { display: none; }
.s-home-chats ul { margin: 0; padding: 0; list-style: none; }
.s-home-chats a { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 4px; border-bottom: 1px solid var(--line); color: var(--fg-2); overflow-wrap: anywhere; }
.s-home-chats form { margin-top: 10px; }
.s-prefs { border: 0; margin: 0; padding: 0; min-width: 0; }
.s-prefs-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.s-recovery-rows dt { font-size: var(--size-sm); }
.s-page-id { padding: 8px 12px; border-top: 1px solid var(--line); }
.s-page-id .s-untrusted { padding: 6px 10px; }
.s-chat-list form { margin: 0; }
@media (prefers-reduced-motion: reduce) {
  .s-signin-wait > span { animation: none; }
}
@media (max-width: 679px) {
  .s-home-chats { display: block; }
  .s-prefs-grid { grid-template-columns: minmax(0, 1fr); }
  .s-provider form, .s-provider .s-btn, .s-signin-acts form, .s-signin-acts .s-btn, .s-setup-card form > div:last-child .s-btn.primary, .s-signin-steps .s-btn { width: 100%; }
  .s-hdr .s-hdr-act .s-btn { padding-inline: 10px; }
}
`;
}
