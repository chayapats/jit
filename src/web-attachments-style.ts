/**
 * web.attachments/v1 styles (app.attachments/v1, ATT03): the composer's attach control, its upload chips and the
 * attachment chips under a message. Tokens only (ui.token_lint/v1 scans this file). Status always carries text;
 * colour only repeats it. The shared `prefers-reduced-motion` rule at the end of the stylesheet stops every
 * transition here.
 */
export const attachmentStyles = `
/* Attach control: without script the browser's own file input shows; with script the paperclip opens it. */
.composer-tools { display: flex; align-items: center; gap: 6px; min-width: 0; }
.composer-attach { display: inline-flex; align-items: center; min-width: 0; }
.attach-input { max-width: 220px; min-width: 0; color: var(--muted); font-size: var(--size-xs); }
.attach-button { display: none; }
[data-attach-ready] .attach-input { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; opacity: 0; }
[data-attach-ready] .attach-button { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: 50%; color: var(--fg-2); cursor: pointer; transition: background-color var(--motion-ui) ease, color var(--motion-ui) ease; }
@media (hover: hover) and (pointer: fine) { [data-attach-ready] .attach-button:hover { background: var(--surface-2); color: var(--fg); } }
[data-attach-ready] .attach-input:focus-visible + .attach-button { outline: 2px solid var(--fg); outline-offset: 2px; }
.attach-note { color: var(--muted); }
/* Drop target: the whole composer frame answers a drag of files, with the hint in words. */
.composer[data-attach-drag="true"] { border-color: var(--accent); border-style: dashed; }
.composer[data-attach-drag="true"]::after { content: attr(data-drop-label); display: block; margin-top: 8px; color: var(--fg); font-size: var(--size-sm); text-align: center; }
/* Upload chips inside the composer. */
.attach-chips { display: flex; flex-wrap: wrap; gap: 8px; margin: 10px 0 2px; }
.attach-chip { position: relative; display: grid; grid-template-columns: 40px minmax(0, 1fr) 28px; align-items: center; gap: 0 10px; width: min(100%, 260px); padding: 6px; border: 1px solid var(--line-strong); border-radius: var(--radius-control); background: var(--surface-2); }
.attach-chip[data-state="failed"], .attach-chip[data-state="rejected"] { border-color: var(--danger-line); }
.attach-thumb { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: var(--radius-control); background: var(--surface-3); color: var(--fg-2); overflow: hidden; }
.attach-thumb img { width: 40px; height: 40px; object-fit: cover; display: block; }
.attach-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.4; }
.attach-name { font-size: var(--size-sm); color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attach-meta { font-size: var(--size-xs); color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attach-chip[data-state="failed"] .attach-meta, .attach-chip[data-state="rejected"] .attach-meta { color: var(--danger); white-space: normal; }
.attach-chip[data-state="ready"] .attach-meta { color: var(--fg-2); }
.attach-remove { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; min-height: 0; padding: 0; border: 0; border-radius: 50%; background: transparent; color: var(--fg-2); }
@media (hover: hover) and (pointer: fine) { .attach-remove:hover { background: var(--surface-3); color: var(--fg); } }
.attach-remove svg { width: 16px; height: 16px; }
.attach-progress { position: absolute; left: 6px; right: 6px; bottom: 2px; width: auto; height: 3px; border: 0; border-radius: var(--radius-pill); accent-color: var(--fg); appearance: none; background: var(--surface-3); overflow: hidden; }
.attach-progress::-webkit-progress-bar { background: var(--surface-3); }
.attach-progress::-webkit-progress-value { background: var(--fg); transition: width var(--motion-ui) linear; }
.attach-progress::-moz-progress-bar { background: var(--fg); }
.attach-notice { margin: 4px 0 0; color: var(--muted); font-size: var(--size-xs); }
.attach-status { margin: 4px 0 0; color: var(--danger); font-size: var(--size-xs); }
.attach-status:empty { display: none; }
/* Attachment chips under a message: never the file's content, only its name, kind, size, state and links. */
.attachment-list { display: flex; flex-wrap: wrap; gap: 8px; max-width: min(100%, 68ch); }
.message--owner .attachment-list { justify-content: flex-end; }
.attachment-chip { display: grid; grid-template-columns: 48px minmax(0, 1fr) auto; align-items: center; gap: 0 10px; width: min(100%, 280px); padding: 6px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--surface-1); }
.attachment-chip[data-state="rejected"] { border-color: var(--danger-line); }
.attachment-chip[data-state="deleted"] { color: var(--muted); }
.attachment-thumb, .attachment-icon { display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: var(--radius-control); background: var(--surface-2); color: var(--fg-2); overflow: hidden; }
.attachment-thumb img { width: 48px; height: 48px; object-fit: cover; display: block; }
.attachment-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.4; }
.attachment-name { font-size: var(--size-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attachment-meta { font-size: var(--size-xs); color: var(--muted); }
.attachment-chip[data-state="rejected"] .attachment-status { color: var(--danger); }
.attachment-chip[data-state="pending"] .attachment-status { color: var(--warn); }
.attachment-download { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: 50%; color: var(--fg-2); }
@media (hover: hover) and (pointer: fine) { .attachment-download:hover { background: var(--surface-2); color: var(--fg); } }
.attachment-download svg { width: 18px; height: 18px; }
@media (max-width: 680px) {
  .attach-chips { flex-wrap: nowrap; overflow-x: auto; padding-bottom: 4px; scroll-snap-type: x proximity; }
  .attach-chip { flex: 0 0 min(80%, 240px); scroll-snap-align: start; }
  .attach-input { max-width: 160px; }
  .attachment-chip { width: 100%; }
}
`;
