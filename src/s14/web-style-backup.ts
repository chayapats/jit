/**
 * Backup and restore styles, appended to the S14 stylesheet. Same `s-` prefix and the same ui.token_lint/v1 rule as
 * web-style.ts: literal colours, sizes, radii and durations stay in src/web-design.ts.
 */
export function s14BackupStyleSheet(): string {
  return `
.s-backup-health { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.s-backup-progress li { font-size: var(--size-sm); }
.s-backup-sides { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; min-width: 0; }
.s-backup-sides h3 { margin-bottom: 6px; font-size: var(--size-sm); font-weight: 600; }
.s-backup-list { display: flex; flex-direction: column; gap: 4px; margin: 0; padding-left: 18px; color: var(--fg-2); list-style: disc; overflow-wrap: anywhere; }
.s-backup-plan { display: flex; flex-direction: column; gap: 6px; margin: 0; padding-left: 20px; list-style: decimal; }
.s-backup-run { display: flex; flex-direction: column; gap: 16px; margin: 0; padding: 0; list-style: none; counter-reset: s-backup-run; }
.s-backup-run > li { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 4px 10px; counter-increment: s-backup-run; }
.s-backup-run > li::before { content: counter(s-backup-run); display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; background: var(--surface-3); border-radius: var(--radius-pill); font-size: var(--size-xs); font-weight: 600; }
.s-backup-step { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.s-backup-step h3 { font-size: var(--size-ui); font-weight: 600; line-height: 24px; }
.s-backup-block { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; min-width: 0; }
.s-backup-block .s-exact { width: 100%; overflow-wrap: anywhere; }
@media (max-width: 679px) {
  .s-backup-sides { grid-template-columns: minmax(0, 1fr); }
  .s-backup-health { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .s-backup-health > div:nth-child(2) { order: 1; grid-column: 1 / -1; }
}
`;
}
