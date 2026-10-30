/**
 * Snapshot sharing, restart recovery and owner statement styles, appended to the S14 stylesheet. Same `s-` prefix and the
 * same ui.token_lint/v1 rule as web-style.ts: literal colours, sizes, radii and durations stay in src/web-design.ts.
 */
export function s14SharingStyleSheet(): string {
  return `
.s-share-name { overflow-wrap: anywhere; }
.s-choices { display: flex; flex-direction: column; gap: 6px; }
.s-choice { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 12px; background: var(--surface-1); border: 1px solid var(--line-strong); border-radius: var(--radius-control); font-weight: 400; min-width: 0; overflow-wrap: anywhere; cursor: pointer; }
.s-field .s-choice { font-weight: 400; }
.s-choice:has(input:checked) { border-color: var(--fg); }
.s-choice input { flex: none; width: 18px; height: 18px; margin: 0; accent-color: var(--fg); }
.s-strip-acts > .s-strip-form { flex: 1 1 100%; min-width: 0; }
.s-strip-form legend { margin-bottom: 6px; }
.s-group-hd .s-section-t { margin-bottom: 2px; }
.s-statement-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.s-statement textarea { min-height: 72px; }
.s-recovery-counts { grid-template-columns: repeat(4, minmax(0, 1fr)); }
.s-recovery-counts b { font-size: var(--size-lg); font-weight: 600; }
.s-recovery-t { font-weight: 600; min-width: 0; overflow-wrap: anywhere; }
.s-recovery-work { color: var(--fg-2); overflow-wrap: anywhere; }
.s-hatch-word { padding: 1px 6px; background: var(--hatch); border-radius: var(--radius-control); color: var(--fg); }
.s-file > .s-note { margin: 0; }
@media (max-width: 679px) {
  .s-recovery-counts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .s-recovery .s-mem-acts .s-btn, .s-statement .s-btn, .s-slip form .s-btn { width: 100%; }
}
`;
}
