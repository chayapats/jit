import type { AttachmentView } from "./attachments/records";
import { tr, trMaybe, type MessageKey } from "./i18n";
import { assetUrl } from "./web-assets";
import { escape } from "./web-layout";
import { fillText } from "./web-proposal-card";

/**
 * web.attachments/v1 presentation for app.attachments/v1 (ATT03, ADR 0040): the composer's attach control and the
 * attachment chips under a message. Everything here is escaped server HTML. The composer works without script as a
 * multipart form posting to `?send=1`; `attachments.js` adds drag and drop, paste, per-file upload chips and a JSON send.
 * Nothing here renders a file's content: previews are same-origin images of container re-encodes only, PDFs are never
 * rendered or embedded, and every other file is a download link.
 */

/** What the topic composer offers while `JIT_ATTACHMENTS` is on. */
export interface AttachmentComposerView { messageFiles: number; fileBytes: number; sanitizer: boolean; backupUsage?: { bytes: number; bound: number; notice: boolean }; pageSize: number }

const paths = {
  clip: '<path d="m20.5 11.5-8.2 8.2a5 5 0 0 1-7-7l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9"/>',
  image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.8"/><path d="m20.5 16-5-5-9.5 8.5"/>',
  file: '<path d="M14 3.5H7a1.5 1.5 0 0 0-1.5 1.5v14A1.5 1.5 0 0 0 7 20.5h10a1.5 1.5 0 0 0 1.5-1.5V8Z"/><path d="M14 3.5V8h4.5M9 13h6m-6 3.5h4"/>',
  download: '<path d="M12 4v11m-5-5 5 5 5-5M5 20h14"/>',
  close: '<path d="M7 7l10 10M17 7 7 17"/>',
};
/** Decorative stroke icon in the shell's icon style. */
const glyph = (name: keyof typeof paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;

/** Locale-neutral size: bytes, then KB and MB with one decimal (1 KB = 1024 bytes). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1).replace(/\.0$/, "") : Math.round(mb)} MB`;
}

/** The owner-facing sentence for a refusal or rejection reason code; unknown codes fall back to "not accepted". */
export function attachmentReasonText(reason: string | null): string {
  return (reason && /^[a-z_]{1,80}$/.test(reason) ? trMaybe(`attachments.reason_${reason}`) : null) ?? tr("attachments.state_rejected");
}

/**
 * The opening-tag attributes of the topic composer while the gate is on: the no-script multipart post to
 * `<topic>/attachments?send=1`, plus the data the enhancement script reads (upload and send API paths, limits).
 */
export function attachmentFormAttributes(base: string, view: AttachmentComposerView): string {
  return ` action="${base}/attachments?send=1" enctype="multipart/form-data" data-attach-form data-upload="/api${base}/attachments" data-send="/api${base}/messages"`
    + ` data-topic="${base}" data-page-size="${view.pageSize}" data-max-files="${view.messageFiles}" data-file-bytes="${view.fileBytes}"`;
}

/** The (initially empty) chip row the script fills, with the provider notice it reveals once a file is attached. */
export function attachmentComposerChips(): string {
  return `<ul class="attach-chips" data-attach-chips aria-label="${tr("attachments.list")}" hidden></ul>`
    + `<p class="attach-notice" data-attach-notice hidden>${tr("attachments.provider_notice")}</p>`
    + `<p class="attach-status" data-attach-status role="status" aria-live="polite"></p>`;
}

/**
 * The file control. Without script it is the browser's own `<input type="file" multiple>` (the multipart form carries
 * the files); with script the input is visually hidden and the paperclip label opens it. The input stays focusable,
 * so keyboard users reach the picker either way. It must follow the text field: the multipart parts are ordered.
 */
export function attachmentComposerControl(view: AttachmentComposerView): string {
  return `<span class="composer-attach"><input class="attach-input" id="composer-files" type="file" name="file" multiple aria-describedby="attach-limits">`
    + `<label class="attach-button" for="composer-files" title="${tr("attachments.attach")}">${glyph("clip")}<span class="sr-only">${tr("attachments.attach")}</span></label></span>`
    + `<span class="sr-only" id="attach-limits">${escape(fillText(tr("attachments.limits"), { count: String(view.messageFiles), size: formatBytes(view.fileBytes) }))}</span>`;
}

/** The composer note's attachment sentences: the provider notice always, and why PDF and WebP are off without a sanitizer. */
export function attachmentComposerNote(view: AttachmentComposerView): string {
  return `<span class="attach-note"> · ${tr("attachments.provider_notice")}${view.sanitizer ? "" : ` · ${tr("attachments.pdf_needs_sanitizer")}`}${attachmentBackupNotice(view.backupUsage)}</span>`;
}

/** Client strings and icons for `attachments.js`, then its module tag. Hidden, static, server-localised text only. */
export function attachmentComposerScript(): string {
  const keys: MessageKey[] = ["attachments.remove", "attachments.state_uploading", "attachments.state_pending", "attachments.state_ready",
    "attachments.state_rejected", "attachments.state_failed", "attachments.no_preview_fallback", "attachments.uploaded", "attachments.wait_uploads", "attachments.wait_send",
    "attachments.too_many", "attachments.too_large", "attachments.upload_failed", "attachments.send_failed", "attachments.drop_here",
    "attachments.open_preview", "error.attachments_disabled", "error.invalid_attachment_upload", "error.attachment_too_large",
    "error.attachment_quota_exceeded", "error.attachment_quota_exceeded_files", "error.attachment_disk_reserve", "error.attachment_type_unsupported",
    "error.attachment_needs_sanitizer", "error.attachment_not_found", "error.attachment_stale", "error.stale_revision", "error.request_too_large",
    "error.text_too_large_or_invalid", "error.empty_text", "error.csrf_rejected", "error.default"];
  const reasons = ["svg", "html", "archive", "office", "executable", "heic", "extension_missing", "extension_unsupported", "extension_mismatch",
    "double_extension", "text_not_utf8", "text_nul", "empty_file", "sanitize_timeout", "sanitize_out_of_memory", "image_too_many_pixels",
    "image_decode_failed", "pdf_extract_failed", "sanitize_output_invalid", "sanitizer_unavailable"];
  const items = [...keys.map(key => [key, tr(key)] as const), ...reasons.map(reason => [`reason.${reason}`, attachmentReasonText(reason)] as const)];
  return `<ul class="attach-text" data-attach-text hidden>${items.map(([key, text]) => `<li data-key="${escape(key)}">${escape(text)}</li>`).join("")}</ul>`
    + `<span class="attach-icons" data-attach-icons hidden>${(["image", "file", "close"] as const).map(name => `<span data-icon="${name}">${glyph(name)}</span>`).join("")}</span>`
    + `<script type="module" src="${assetUrl("attachments.js")}"></script>`;
}

/**
 * The chips under one message: a thumbnail for a container re-encoded image (its same-origin preview, opened in a new
 * tab), otherwise a kind icon; the sanitized name, kind and size; the state in words (waiting for the safety check,
 * not accepted with its reason, no preview on this host for a fallback image, or file deleted); and a download link
 * whenever the download route would serve the file.
 */
export function messageAttachmentList(base: string, views: readonly AttachmentView[]): string {
  if (!views.length) return "";
  return `<ul class="attachment-list" aria-label="${tr("attachments.list")}">${views.map(view => attachmentChip(base, view)).join("")}</ul>`;
}

function attachmentChip(base: string, view: AttachmentView): string {
  const url = `${base}/attachments/${view.id}`, kind = tr(`attachments.kind_${view.kind}`);
  const icon = `<span class="attachment-icon">${glyph(view.kind === "image" ? "image" : "file")}</span>`;
  if (view.state === "deleted" || view.name === null) {
    return `<li class="attachment-chip" data-state="deleted" data-kind="${escape(view.kind)}">${icon}<span class="attachment-text"><span class="attachment-name">${tr("attachments.state_deleted")}</span><span class="attachment-meta">${kind}</span></span></li>`;
  }
  const name = escape(view.name);
  const status = view.state === "pending" ? tr("attachments.state_pending")
    : view.state === "rejected" ? `${tr("attachments.state_rejected")}: ${attachmentReasonText(view.reason)}`
    : view.kind === "image" && view.sanitizedBy === "fallback" ? `${tr("attachments.no_preview_fallback")} · ${tr("attachments.route_cannot_see_images")}` : view.kind === "image" ? tr("attachments.route_cannot_see_images") : "";
  const thumb = view.preview
    ? `<a class="attachment-thumb" href="${url}/preview" target="_blank" rel="noopener noreferrer"><img src="${url}/preview" alt="${escape(fillText(tr("attachments.open_preview"), { name: view.name }))}" width="48" height="48" loading="lazy" decoding="async"></a>`
    : icon;
  // The download route serves an image only once sanitized, and the original of a PDF or text file.
  const downloadable = view.state === "ready" || (view.state === "pending" && view.kind !== "image");
  return `<li class="attachment-chip" data-state="${escape(view.state)}" data-kind="${escape(view.kind)}">${thumb}<span class="attachment-text"><span class="attachment-name" title="${name}">${name}</span>`
    + `<span class="attachment-meta">${kind} · ${formatBytes(view.bytes)}${status ? ` · <span class="attachment-status">${escape(status)}</span>` : ""}</span></span>`
    + (downloadable ? `<a class="attachment-download" href="${url}/download" download aria-label="${escape(fillText(tr("attachments.download_named"), { name: view.name }))}" title="${tr("attachments.download")}">${glyph("download")}</a>` : "")
    + `</li>`;
}

/** Localized 80% early notice; the usage includes every live original and sanitized derivative. */
export function attachmentBackupNotice(usage?: { bytes: number; bound: number; notice: boolean }): string {
  return usage?.notice ? `<span class="attach-note"> · ${escape(fillText(tr("attachments.backup_bound_notice"), { bytes: formatBytes(usage.bytes), bound: formatBytes(usage.bound) }))}</span>` : "";
}
