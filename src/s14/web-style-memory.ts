/**
 * Memory, research evidence and web settings styles, appended to the S14 stylesheet. Same `s-` prefix and the same
 * ui.token_lint/v1 rule as web-style.ts: literal colours, sizes, radii and durations stay in src/web-design.ts.
 */
export function s14MemoryStyleSheet(): string {
  return `
.s-memtabs { padding: 0; overflow-x: auto; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
.s-memtabs a { flex: none; white-space: nowrap; }
.s-mem, .s-read { display: flex; flex-direction: column; gap: 10px; padding: 16px 0; background: transparent; border-bottom: 1px solid var(--line); border-radius: 0; min-width: 0; }
.s-mem-hd { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-width: 0; }
.s-mem-acts { display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: center; }
.s-mem-acts a { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; min-height: 32px; }
.s-memsearch { display: flex; gap: 8px; align-items: stretch; }
.s-memsearch .s-field { flex: 1; }
.s-memsearch .s-btn { flex: none; }
.s-reach { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.s-reach-list { display: flex; flex-direction: column; gap: 6px; margin: 0; padding-left: 18px; list-style: disc; line-height: 1.55; }
.s-source { display: flex; gap: 10px; padding-top: 10px; border-top: 1px solid var(--line); min-width: 0; scroll-margin-top: 72px; }
.s-source > .s-stack { flex: 1; }
.s-source-n { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border: 1px solid var(--line-strong); border-radius: var(--radius-pill); color: var(--fg-2); font-size: var(--size-xs); }
.s-source:target { border-top-color: var(--fg); }
.s-untrusted details { margin-top: 6px; }
.s-untrusted details[open] > div { padding-top: 6px; }
.s-pane .s-mem, .s-pane .s-read { background: var(--bg); }
@media (max-width: 679px) {
  .s-reach { grid-template-columns: minmax(0, 1fr); }
  .s-mem-acts a { min-height: 44px; }
}
`;
}
