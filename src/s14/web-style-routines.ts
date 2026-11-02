/**
 * Routine, grouped attention and Bot lifecycle styles, appended to the S14 stylesheet. Same `s-` prefix and the same
 * ui.token_lint/v1 rule as web-style.ts: literal colours, sizes, radii and durations stay in src/web-design.ts.
 */
export function s14RoutineStyleSheet(): string {
  return `
.s-attention-groups { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.s-attention-group { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.s-attention-group h3 { color: var(--fg-2); font-size: var(--size-xs); font-weight: 500; }
.s-attention a > span:first-child { display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }
.s-attention small { color: var(--fg-3); font-size: var(--size-xs); }
.s-attention-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin-bottom: 8px; min-width: 0; }
.s-attention-row > a { flex: 1 1 200px; margin-bottom: 0; min-width: 0; }
.s-attention-row > form { flex: none; margin: 0; }
.s-sched-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; min-height: 44px; }
.s-sched-row .s-check { min-width: 112px; padding: 0; align-items: center; }
.s-sched-row:not(:has(input:checked)) .s-sched-input, .s-sched-row:not(:has(input:checked)) .s-limit { opacity: .6; }
.s-field .s-sched-input input, .s-field .s-sched-input select { width: auto; max-width: 100%; }
.s-sched-row:not(:has(input:checked)) .s-sched-word { opacity: .6; }
.s-sched-pair { display: inline-flex; align-items: center; gap: 8px; }
.s-sched-word { color: var(--fg-2); font-size: var(--size-sm); font-weight: 400; }
.s-sched-note { flex: 1 1 100%; }
.s-sched-row:not(:has(input:checked)) .s-sched-note { display: none; }
.s-run-list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.s-run { display: flex; flex-direction: column; gap: 4px; padding: 16px 0; background: transparent; border-bottom: 1px solid var(--line); border-radius: 0; min-width: 0; overflow-wrap: anywhere; }
.s-run.quiet { padding-block: 4px; background: transparent; border-color: transparent; color: var(--fg-3); }
.s-run-hd { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-size: var(--size-sm); }
.s-steps { display: flex; flex-direction: column; gap: 4px; margin: 0; padding: 0; list-style: none; }
.s-steps li { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 2px 12px; padding: 6px 0 6px 12px; border-left: 2px solid var(--line); min-width: 0; }
.s-steps li[data-step=done] { border-left-color: var(--fg-3); color: var(--fg-2); }
.s-steps li[data-step=now] { border-left-color: var(--fg); font-weight: 500; }
.s-steps li[data-step=later] { color: var(--fg-3); }
.s-steps small { color: var(--fg-3); font-size: var(--size-xs); font-weight: 400; }
.s-cap-sides { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; min-width: 0; }
.s-cap-diff { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.s-cap-diff li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 10px; padding: 6px 10px; background: var(--surface-2); border-radius: var(--radius-control); min-width: 0; overflow-wrap: anywhere; text-decoration: none; }
.s-cap-diff span:first-child { flex: none; color: var(--fg-2); font-size: var(--size-xs); }
.s-cap-diff .s-mono { color: var(--fg); }
.s-cap-diff small { flex: 1 1 100%; color: var(--fg-2); font-size: var(--size-xs); }
.s-strip > .s-btn { align-self: flex-start; }
.s-slot-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; list-style: none; }
.s-slot-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px 12px; min-height: 44px; padding: 16px 0; background: transparent; border-bottom: 1px solid var(--line); border-radius: 0; min-width: 0; overflow-wrap: anywhere; }
.s-slot-row small { display: block; }
@media (max-width: 679px) {
  .s-cap-sides { grid-template-columns: minmax(0, 1fr); }
  .s-strip-form .s-btn, .s-slot-row .s-btn { width: 100%; }
  .s-card .s-limit input { min-height: 40px; }
}
`;
}
