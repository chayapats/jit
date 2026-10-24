/** Result of bounding one string by its UTF-8 encoding. */
export interface Utf8Prefix {
  /** Longest prefix whose UTF-8 encoding fits; never splits a code point. */
  text: string;
  /** UTF-8 bytes of `text`. */
  bytes: number;
  /** True when `text` is shorter than the input. */
  truncated: boolean;
}

/** UTF-8 byte length of `text` (lone surrogates count as the 3-byte replacement character). */
export const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * Truncates `text` to at most `maxBytes` UTF-8 bytes on a code-point boundary. Byte ceilings
 * are byte ceilings: UTF-16 code-unit counts (`String.prototype.slice`) are never used as bytes,
 * so multibyte text such as Thai (3 bytes per character) or emoji (4 bytes) cannot exceed them.
 */
export function truncateUtf8(text: string, maxBytes: number): Utf8Prefix {
  const limit = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : Number.MAX_SAFE_INTEGER;
  const bytes = utf8Bytes(text);
  if (bytes <= limit) return { text, bytes, truncated: false };
  const encoded = Buffer.from(text, "utf8");
  let end = limit;
  // Back off UTF-8 continuation bytes (10xxxxxx) so the cut lands before a lead byte.
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end -= 1;
  return { text: encoded.subarray(0, end).toString("utf8"), bytes: end, truncated: true };
}

/**
 * One cumulative UTF-8 byte budget shared by every read it bounds. `take` keeps the longest
 * code-point-safe prefix within both the remaining budget and an optional per-item `cap`, and
 * reports which bound cut it; `fits` checks an all-or-nothing value (an identity that must
 * never be stored truncated) and charges it only when it fits.
 */
export class Utf8Budget {
  #remaining: number;

  constructor(limit: number) {
    this.#remaining = Math.max(0, Math.floor(limit));
  }

  get remaining(): number {
    return this.#remaining;
  }

  take(text: string, cap = Number.POSITIVE_INFINITY): Utf8Prefix & { cutBy: "budget" | "cap" | null } {
    const available = this.#remaining;
    const prefix = truncateUtf8(text, Math.min(available, Math.max(0, cap)));
    this.#remaining -= prefix.bytes;
    return { ...prefix, cutBy: !prefix.truncated ? null : available < cap ? "budget" : "cap" };
  }

  fits(text: string): boolean {
    const bytes = utf8Bytes(text);
    if (bytes > this.#remaining) return false;
    this.#remaining -= bytes;
    return true;
  }
}
