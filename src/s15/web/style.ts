import { s15ExperienceStyle } from "./experience-style";

/**
 * S15 conversational additions (UX15-01), layered after the S14 Plain stylesheet. No new token: every value is an
 * existing S14/shared token or a structural length (ui.token_lint/v1, handoff §8). Classes are `s15-` prefixed.
 */
export function s15StyleSheet(): string {
  return `
.s15-app .s-scroll { position: relative; }
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
.s15-provision-steps, .s15-pool { list-style: none; display: flex; flex-direction: column; gap: 6px; }
.s15-provision-steps li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-height: 40px; padding: 6px 0; border-top: 1px solid var(--line); }
.s15-provision-steps li[data-state="todo"] { color: var(--fg-3); }
.s15-provision-steps li[aria-current="step"] { font-weight: 600; }
.s15-pool { gap: 12px; }
.s15-computer { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--line); border-radius: var(--radius-control); }
.s15-computer h3 { margin: 0; font-size: var(--size-ui); }
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
.s15-held-list { display: flex; flex-direction: column; gap: 8px; }
.s15-slip-compact { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--warn-line); border-radius: var(--radius-control); }
.s15-slip-compact[data-state=unknown] { border-color: var(--danger-line); }
.s15-slip-compact:not([data-state=pending]):not([data-state=unknown]) { border-color: var(--line-strong); }
.s15-slip .s-slip-hd h2 { font-size: var(--size-chat); }
.s15-state-line { font-size: var(--size-sm); }
.s15-exact-kv dd { overflow-wrap: anywhere; }
.s15-badge { align-self: flex-start; margin-top: 6px; }
.s15-checklist, .s15-decision, .s15-stall, .s15-proposals { display: flex; flex-direction: column; gap: 8px; }
.s15-options { list-style: none; display: flex; flex-direction: column; gap: 10px; }
.s15-option { border-top: 1px solid var(--line); padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.s15-secondary { margin-top: 10px; font-size: var(--size-sm); }
.s15-statement { margin-top: 10px; border: 0; padding: 0; }
.s15-statement legend { font-size: var(--size-sm); margin-bottom: 6px; }
.s15-decision-line { display: flex; gap: 8px; align-items: flex-start; font-size: var(--size-sm); padding-left: 18px; }
.s15-decision-line svg, .s15-takeover-bar svg { width: 14px; height: 14px; flex: none; margin-top: 3px; }
.s15-attempts { padding-left: 20px; display: flex; flex-direction: column; gap: 6px; }
.s15-wait { font-size: var(--size-sm); color: var(--fg-2); }
.s15-duty .s-slip-body { padding-top: 8px; }
.s15-login, .s15-limit { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--line-strong); border-radius: var(--radius-card); }
.s15-limit { border-style: dashed; }
.s15-need { display: flex; flex-direction: column; gap: 6px; padding-block: 6px; }
.s15-need-link { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; }
.s15-frame { margin: 0; padding: 12px; }
.s15-frame img { display: block; width: 100%; height: auto; border: 1px solid var(--line); border-radius: var(--radius-control); }
.s15-takeover-bar:focus { outline: 2px solid var(--fg); outline-offset: -2px; }
.s15-list { padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: var(--size-sm); }
.s15-tg-code { font-size: var(--size-xl); padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-control); overflow-wrap: anywhere; user-select: all; }
.s15-rule-list { list-style: none; display: flex; flex-direction: column; gap: 10px; }
.s15-diff .s-diff-old, .s15-diff .s-diff-new { display: block; }
.s15-strip-form { margin: 0; }
.s15-policy-rows dd ul { margin: 0; }
.s15-policy-budget { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--radius-control); }
.s15-ghc-perms { margin-top: 6px; font-size: var(--size-sm); }
.s15-ghc-replace summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
.s-strip-acts .s-btn, .s15-chips .s-btn { min-height: 44px; }
@media (max-width: 399px) { .s-strip-acts { flex-direction: column; align-items: stretch; } }
${s15ExperienceStyle()}`;
}
