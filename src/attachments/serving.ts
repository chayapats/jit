import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { AppError } from "../errors";

/** The CSP of every served attachment byte (S13-D05): nothing loads, and a document is a sandboxed opaque origin. */
export const attachmentContentSecurityPolicy = "default-src 'none'; sandbox";

/** D05 headers shared by preview and download: never cached, never sniffed, never embeddable from another origin. */
export const attachmentSecurityHeaders: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": attachmentContentSecurityPolicy,
});

/** Media types a preview may carry: only container re-encodes (contract: PNG stays PNG, JPEG stays JPEG, WebP becomes PNG). */
const previewTypes: Readonly<Record<string, { magic: string; extension: string }>> = Object.freeze({
  "image/png": { magic: "89504e470d0a1a0a", extension: "png" },
  "image/jpeg": { magic: "ffd8ff", extension: "jpg" },
});
const extensions: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"], "image/webp": ["webp"],
});

/** One blob chosen for serving: an open descriptor, its exact size and the attachment's sanitized name. */
export interface ServedAttachment { fd: number; bytes: number; mediaType: string; name: string }

/** The extension follows the served file: a WebP served as its PNG re-encode is named `.png`. Never a path. */
export function servedFileName(displayName: string, servedMediaType: string): string {
  const known = extensions[servedMediaType];
  if (!known) return displayName;
  const dot = displayName.lastIndexOf("."), ext = dot > 0 ? displayName.slice(dot + 1).toLowerCase() : "";
  if (known.includes(ext)) return displayName;
  return `${dot > 0 ? displayName.slice(0, dot) : displayName}.${known[0]}`;
}

/**
 * `Content-Disposition: attachment` with an ASCII `filename` fallback and the exact sanitized name in an RFC 5987
 * `filename*`. Quotes, backslashes, controls, separators and every non-ASCII character are replaced in the fallback,
 * and `filename*` percent-encodes everything outside RFC 5987 `attr-char`, so no name can end the header value.
 */
export function attachmentDisposition(name: string): string {
  const dot = name.lastIndexOf("."), ext = dot > 0 ? name.slice(dot) : "", stem = dot > 0 ? name.slice(0, dot) : name;
  const ascii = (value: string) => value.replace(/[^A-Za-z0-9._ ()-]+/g, "_").replace(/_+/g, "_");
  const safeExt = /^\.[A-Za-z0-9]{1,16}$/.test(ext) ? ext : "";
  let fallback = ascii(safeExt ? stem : name).replace(/^[\s._-]+|[\s._-]+$/g, "");
  if (!/[A-Za-z0-9]/.test(fallback)) fallback = "file";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}${safeExt}"; filename*=UTF-8''${encoded}`;
}

/**
 * Opens a stored blob for serving without following a symlink. The descriptor must be a private regular file of exactly
 * `bytes`; for a preview its first bytes must also match the PNG or JPEG signature of `previewMediaType`. A missing
 * file is 410 `attachment_unavailable`; any other mismatch is never served (404 `attachment_preview_unavailable` for a
 * preview, 503 `storage_unavailable` for a download). The caller owns the descriptor.
 */
export function openServedBlob(path: string, bytes: number, previewMediaType: string | null): number {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AppError("attachment_unavailable", 410);
    throw new AppError("storage_unavailable", 503);
  }
  try {
    const stat = fstatSync(fd);
    const refuse = () => previewMediaType ? new AppError("attachment_preview_unavailable", 404) : new AppError("storage_unavailable", 503);
    if (!stat.isFile() || stat.size !== bytes || (stat.mode & 0o077) !== 0) throw refuse();
    if (previewMediaType) {
      const type = previewTypes[previewMediaType];
      if (!type) throw refuse();
      const head = Buffer.alloc(type.magic.length / 2);
      if (readSync(fd, head, 0, head.length, 0) !== head.length || head.toString("hex") !== type.magic) throw refuse();
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

/** True when `mediaType` may be served as a preview (`image/png` or `image/jpeg`). */
export function previewable(mediaType: string | null): boolean { return mediaType !== null && Object.hasOwn(previewTypes, mediaType); }

/** Streams exactly `bytes` from an open descriptor in 64 KiB reads, closing it at the end, on error or on cancel. */
export function blobStream(fd: number, bytes: number): ReadableStream<Uint8Array> {
  let position = 0, open = true;
  const close = () => { if (open) { open = false; closeSync(fd); } };
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        if (position >= bytes) { close(); controller.close(); return; }
        const chunk = Buffer.alloc(Math.min(65536, bytes - position));
        const n = readSync(fd, chunk, 0, chunk.length, position);
        if (!n) throw new Error("attachment_blob_truncated");
        position += n; controller.enqueue(chunk.subarray(0, n));
        if (position >= bytes) { close(); controller.close(); }
      } catch (error) { close(); controller.error(error); }
    },
    cancel() { close(); },
  }, { highWaterMark: 0 });
}
