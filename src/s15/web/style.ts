/**
 * S15 conversational additions (UX15-01), layered after the S14 Plain stylesheet. No new token: every value is an
 * existing S14/shared token or a structural length (ui.token_lint/v1, handoff §8). Classes are `s15-` prefixed.
 */
export function s15StyleSheet(): string {
  return `
.s15-thread { display: flex; flex-direction: column; gap: 22px; }
.s15-row { display: flex; flex-direction: column; gap: 8px; }
.s15-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.s15-receipt { color: var(--fg-3); font-size: var(--size-xs); padding-left: 18px; }
.s15-intent { display: flex; align-items: flex-start; gap: 8px; font-size: var(--size-sm); color: var(--fg); }
.s15-intent svg { width: 16px; height: 16px; flex: none; margin-top: 3px; }
.s15-scope { font-size: var(--size-sm); color: var(--fg-2); }
.s15-progress { display: flex; flex-direction: column; gap: 6px; padding-block: 8px; }
.s15-phase-line { display: flex; align-items: center; gap: 8px; font-size: var(--size-sm); color: var(--fg-2); }
.s15-dot { width: 8px; height: 8px; border-radius: var(--radius-pill); background: var(--fg-2); flex: none; }
.s15-progress-list, .s15-claims, .s15-facts, .s15-accounts, .s15-caps { list-style: none; display: flex; flex-direction: column; gap: 6px; }
.s15-evidence { border-top: 1px solid var(--line); padding-top: 6px; }
.s15-saved { color: var(--fg); font-size: var(--size-xs); }
.s15-result { display: flex; flex-direction: column; gap: 10px; padding-block: 8px; }
.s15-gaps { border-left: 1px solid var(--warn-line); padding-left: 12px; }
.s15-held { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--warn-line); border-radius: var(--radius-control); }
.s15-question { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--warn-line); border-radius: var(--radius-card); }
.s15-chips { display: flex; flex-wrap: wrap; gap: 8px; }
.s15-footer { display: flex; flex-direction: column; gap: 4px; font-size: var(--size-xs); color: var(--fg-3); }
.s15-table-wrap { overflow-x: auto; }
.s15-table { width: 100%; border-collapse: collapse; font-size: var(--size-sm); }
.s15-table th, .s15-table td { text-align: left; vertical-align: top; padding: 8px 6px; border-top: 1px solid var(--line); }
.s15-table thead th { color: var(--fg-3); font-weight: 500; font-size: var(--size-xs); border-top: 0; }
.s15-composer .s15-answer input { margin-right: 6px; }
.s15-unknown { color: var(--fg); font-size: var(--size-sm); padding: 6px 2px; }
.s15-sending { color: var(--fg-3); font-size: var(--size-xs); }
.s15-option-b { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-control); font-size: var(--size-sm); }
.s15-option-b svg { width: 16px; height: 16px; flex: none; margin-top: 3px; }
.s15-steps { display: flex; flex-direction: column; gap: 14px; padding-left: 20px; }
.s15-caps li, .s15-accounts li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 44px; padding: 8px 0; border-top: 1px solid var(--line); }
.s15-caps small { display: block; color: var(--fg-3); font-size: var(--size-xs); }
.s15-break { overflow-wrap: anywhere; }
.s15-setup { display: flex; flex-direction: column; gap: 16px; }
.s15-setup-section { display: flex; flex-direction: column; gap: 12px; }
.s15-setup-steps li { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.s15-rule-lists { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
.s15-rule-lists ul { padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: var(--size-sm); }
.s15-claim { padding: 10px 0; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 4px; }
.s15-forget { margin-top: 8px; }
.s15-needs-count { margin-left: auto; }
@media (max-width: 399px) { .s-strip-acts { flex-direction: column; align-items: stretch; } }
`;
}
