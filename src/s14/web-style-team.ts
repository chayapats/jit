/**
 * Team progress, report and work settings styles, appended to the S14 stylesheet. Same `s-` prefix and the same
 * ui.token_lint/v1 rule as web-style.ts: literal colours, sizes, radii and durations stay in src/web-design.ts.
 */
export function s14TeamStyleSheet(): string {
  return `
.s-headline { font-size: var(--size-chat); font-weight: 500; line-height: 1.5; }
.s-lane-row { display: flex; gap: 12px; padding: 12px 14px; min-width: 0; }
.s-lane-row > .s-stack { flex: 1; gap: 4px; }
.s-lane-row b { font-weight: 600; overflow-wrap: anywhere; }
.s-lane-more { padding: 2px 14px 6px; }
.s-row-pills { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 4px; flex: none; max-width: 60%; }

/* Timeline: one SVG per lane, because geometry attributes pass a CSP with no inline style. Bars are recorded intervals only. */
.s-tl { display: grid; grid-template-columns: minmax(84px, 30%) minmax(0, 1fr); gap: 8px 10px; align-items: center; min-width: 0; }
.s-tl-name { display: flex; flex-direction: column; min-width: 0; color: var(--fg-2); font-size: var(--size-xs); line-height: 1.35; overflow-wrap: anywhere; }
.s-tl-name small { color: var(--fg-3); font-size: var(--size-xs); }
.s-tl-name small.danger { color: var(--danger); }
.s-tl-track { display: block; width: 100%; height: 12px; overflow: visible; }
.s-tl-track line, .s-tl-track rect { vector-effect: non-scaling-stroke; }
.s-tl-base { stroke: var(--line); stroke-width: 1; }
.s-tl-now { stroke: var(--fg-2); stroke-width: 1; }
.s-bar-run { fill: var(--fg); }
.s-bar-done { fill: var(--fg-3); }
.s-bar-stopped { fill: none; stroke: var(--fg-3); stroke-width: 1; }
.s-bar-cap { stroke: var(--fg-2); stroke-width: 2; }
.s-bar-queued { fill: var(--bg); stroke: var(--fg-3); stroke-width: 1; }
.s-bar-waiting { stroke: var(--fg-3); stroke-width: 6; stroke-dasharray: 2 3; }
.s-bar-open { stroke: var(--fg-3); stroke-width: 1; }
.s-bar-stopping { stroke: var(--fg-2); stroke-width: 10; stroke-dasharray: 2 3; }
.s-bar-mark { stroke: var(--danger); stroke-width: 3; }
.s-tl-axis { display: flex; justify-content: space-between; gap: 8px; color: var(--fg-3); font-size: var(--size-xs); }
.s-tl-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--fg-2); font-size: var(--size-xs); }
.s-tl-legend span { display: inline-flex; align-items: center; gap: 6px; }
.s-key { display: inline-block; flex: none; width: 18px; height: 8px; }
.s-key.run { background: var(--fg); }
.s-key.done { background: var(--fg-3); }
.s-key.stopping { background: var(--hatch); }
.s-key.stopped { border: 1px solid var(--fg-3); border-right-width: 3px; }
.s-key.queued { height: 6px; border: 1px solid var(--fg-3); }
.s-key.waiting { height: 6px; background: var(--hatch); }
.s-key.failed { background: var(--fg-3); border-right: 3px solid var(--danger); }
.s-table { overflow-x: auto; overscroll-behavior-x: contain; max-width: 100%; }
.s-table table { width: 100%; min-width: 760px; border-collapse: collapse; font-size: var(--size-sm); }
.s-table th, .s-table td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: start; font-weight: 400; vertical-align: top; }
.s-table thead th { color: var(--fg-3); font-size: var(--size-xs); }
.s-table tbody th { font-weight: 500; overflow-wrap: break-word; }
.s-table time { white-space: nowrap; }

/* Report: four separate facts first, then the gaps, then the claims. The title never leaves its untrusted frame. */
.s-report-t { font-size: var(--size-ui); font-weight: 600; }
.s-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1px; margin: 0; background: var(--line); border: 1px solid var(--line); border-radius: var(--radius-control); overflow: hidden; }
.s-facts > div { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 10px 12px; background: var(--surface-1); min-width: 0; }
.s-pane .s-facts > div { background: var(--bg); }
.s-facts dt { color: var(--fg-3); font-size: var(--size-xs); }
.s-facts dd { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; margin: 0; min-width: 0; }
.s-facts .s-pill { white-space: normal; }
.s-revs { margin: 0; padding: 0; list-style: none; }
.s-revs a { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 10px; min-height: 44px; padding: 8px 12px; border: 1px solid var(--line); border-radius: var(--radius-control); margin-bottom: 8px; }
.s-revs a[aria-current=page] { border-color: var(--fg); }
.s-revs small { color: var(--fg-3); font-size: var(--size-xs); }
.s-rev-meta { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; color: var(--fg-3); font-size: var(--size-xs); }
@media (hover: hover) and (pointer: fine) { .s-revs a:hover { background: var(--surface-2); } }
.s-claim { display: flex; flex-direction: column; gap: 10px; padding: 16px 0; background: transparent; border-bottom: 1px solid var(--line); border-radius: 0; min-width: 0; scroll-margin-top: 72px; }
.s-claim:target { border-color: var(--fg); }
.s-pane .s-claim { background: var(--bg); }
.s-cites { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.s-cites > li { display: flex; gap: 10px; min-width: 0; }
.s-cites > li > .s-stack { flex: 1; gap: 4px; }
.s-cite { flex: none; display: inline-flex; align-items: center; justify-content: center; min-width: 24px; height: 24px; padding: 0 4px; border: 1px solid var(--line-strong); border-radius: var(--radius-control); color: var(--fg); font-size: var(--size-xs); }
@media (hover: hover) and (pointer: fine) { .s-cite:hover { background: var(--fg); color: var(--on-fg); border-color: var(--fg); } }
.s-files { display: flex; flex-direction: column; gap: 8px; }
.s-file { display: flex; flex-direction: column; gap: 10px; padding: 16px 0; background: transparent; border-bottom: 1px solid var(--line); border-radius: 0; min-width: 0; }
.s-pane .s-file { background: var(--bg); }
.s-file .s-btn { align-self: flex-start; }
.s-review { scroll-margin-top: 72px; }
.s-review .s-stack { gap: 8px; }
.s-review .s-pill { white-space: normal; }
@media (forced-colors: active) {
  .s-bar-run, .s-bar-done { fill: CanvasText; }
  .s-bar-stopped, .s-bar-stopping, .s-bar-mark, .s-bar-cap, .s-bar-queued, .s-bar-waiting, .s-bar-open, .s-tl-now { stroke: CanvasText; }
  .s-bar-queued { fill: Canvas; }
  .s-key { forced-color-adjust: none; }
  .s-key.run, .s-key.done, .s-key.failed { background: CanvasText; }
  .s-key.stopped, .s-key.queued { border-color: CanvasText; }
  .s-key.waiting, .s-key.stopping { background: repeating-linear-gradient(135deg, CanvasText 0 2px, transparent 2px 5px); }
}
@media (max-width: 679px) {
  .s-tl { grid-template-columns: minmax(72px, 34%) minmax(0, 1fr); }
  .s-cite { min-width: 44px; height: 44px; }
  .s-file .s-btn { align-self: stretch; }
  .s-more summary { min-height: 44px; }
}
`;
}
