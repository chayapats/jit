/**
 * Coding and Git styles, appended to the S14 stylesheet. Same `s-` prefix and the same ui.token_lint/v1 rule as web-style.ts:
 * literal colours, sizes, radii and durations stay in src/web-design.ts. A diff line keeps its literal `+` or `-`, so colour only repeats it.
 */
export function s14CodingStyleSheet(): string {
  return `
.s-worktabs { overflow-x: auto; }
.s-worktabs a { flex: none; white-space: nowrap; }
.s-coding-others { display: flex; flex-direction: column; gap: 8px; margin: 8px 0 0; padding: 0; list-style: none; }
.s-coding-others li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; font-weight: 400; min-width: 0; }
.s-coding-others small { color: var(--fg-3); font-size: var(--size-xs); flex: 1 1 60%; min-width: 0; }
.s-coding-checks { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.s-coding-check { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; background: var(--surface-1); border: 1px solid var(--line); border-radius: var(--radius-card); min-width: 0; }
.s-pane .s-coding-check { background: var(--bg); }
.s-coding-check .s-pill { white-space: normal; }
.s-output { margin: 0; font-family: var(--font-mono); font-size: var(--size-xs); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.s-code { margin: 0; padding: 6px 0; overflow-x: auto; font-family: var(--font-mono); font-size: var(--size-xs); line-height: 1.5; white-space: pre; }
.s-code-line { display: block; min-width: max-content; padding: 0 8px; }
.s-code-line.add { background: var(--surface-3); box-shadow: inset 2px 0 0 var(--ok); }
.s-code-line.del { color: var(--fg-2); box-shadow: inset 2px 0 0 var(--danger); }
.s-code-line.hunk, .s-code-line.meta { color: var(--fg-3); }
.s-git-form .s-git-pr { padding-left: 12px; border-left: 2px solid var(--line-strong); }
.s-git-form:not(:has(input[name=pr]:checked)) .s-git-pr { display: none; }
@media (max-width: 679px) {
  .s-coding-check .s-between { flex-wrap: wrap; }
  .s-slip .s-limit input { min-height: 40px; }
  .s-git-form .s-btn { width: 100%; }
  .s-coding-others .s-link-text { min-height: 44px; display: inline-flex; align-items: center; }
}
`;
}
