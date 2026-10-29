/** Reserved trailer delimiter for app.jit_reply/v2; never part of the owner-visible prose. */
export const replyTrailer = "```jit-proposals";
/** Output format instruction; handlers still decide which untrusted proposals may be retained. */
export const replyFormatInstruction = 'Write the reply as prose first. Optionally end with exactly one block: newline, ```jit-proposals, newline, {"version":2,"proposals":[...]}, newline, ```. Nothing follows that block. Normal Markdown code fences are fine; only the line-start jit-proposals fence is reserved for this trailer. Unknown fields and proposal kinds are discarded.';

/** The bounded, authority-free result of parsing a reply; only the attempt fence can publish its text. */
export type ParsedReply = { state: "complete"; text: string; structured: boolean; discarded: string[]; discardedTotal: number }
  | { state: "failed"; reason: "malformed" | "empty" };

const safe = (key: unknown) => typeof key === "string" && /^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(key) ? key : "invalid";

/**
 * Parses prose plus an optional version-2 trailer, or transition-release v1 JSON.
 * A broken trailer discards all its contents as field:proposals while preserving valid prose.
 * Unknown keys/kinds use the existing safe evidence codes (eight retained, total counted).
 */
export function parseReply(output: string, outputBytes: number, handlers: Readonly<Record<string, (item: unknown) => boolean>> = {}): ParsedReply {
  if (!output.isWellFormed() || Buffer.byteLength(output) > outputBytes) return { state: "failed", reason: "malformed" };
  let text = output.trim();
  if (!text) return { state: "failed", reason: "empty" };
  let object: Record<string, unknown> | null = null, legacy = false, structured = false;
  const dropped: string[] = [];
  const start = output.length - output.trimStart().length;
  const fenced = (!start || output[start - 1] === "\n") ? /^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$/.exec(text) : null;
  if (fenced) {
    // A normal whole-output code example is prose unless it actually has the v1 shape.
    try {
      const value = JSON.parse(fenced[1]!);
      if (value && typeof value === "object" && !Array.isArray(value) && typeof value.reply === "string") object = value;
    } catch { /* Ordinary fenced code is prose. */ }
  }
  if (object || /^[{[]/.test(text)) {
    legacy = true; structured = true;
    try { object ??= JSON.parse(text); } catch { return { state: "failed", reason: "malformed" }; }
    if (!object || typeof object !== "object" || Array.isArray(object) || typeof object.reply !== "string") return { state: "failed", reason: "malformed" };
    text = object.reply.trim();
  } else {
    // Inspect the original output: trimming first would turn an indented fence into metadata.
    const fence = /(^|\n)```jit-proposals(?=\r?\n|$)/.exec(output);
    if (fence) {
      structured = true;
      const trailer = output.slice(fence.index + fence[1]!.length);
      text = output.slice(0, fence.index).trim();
      const match = /^```jit-proposals\r?\n([\s\S]*?)\r?\n```\s*$/.exec(trailer);
      try { if (match) object = JSON.parse(match[1]!); } catch { /* Entire trailer is discarded below. */ }
      if (!object || typeof object !== "object" || Array.isArray(object) || object.version !== 2 || !Array.isArray(object.proposals)) {
        object = null; dropped.push("field:proposals");
      }
    }
  }
  if (!text) return { state: "failed", reason: "empty" };
  if (!text.isWellFormed() || Buffer.byteLength(text) > outputBytes) return { state: "failed", reason: "malformed" };
  for (const [key, value] of Object.entries(object ?? {})) {
    if (legacy ? key === "reply" : key === "version") continue;
    if (key === "proposals" && Array.isArray(value)) {
      for (const item of value) {
        const kind = safe(item && typeof item === "object" ? item.kind : null);
        if (!Object.hasOwn(handlers, kind) || !handlers[kind]!(item)) dropped.push(`proposal:${kind}`);
      }
    } else dropped.push(`field:${safe(key)}`);
  }
  return { state: "complete", text, structured, discarded: dropped.slice(0, 8), discardedTotal: dropped.length };
}

/**
 * Incremental bounded prose filter. Withholds v1 JSON and only possible line-start jit-proposals openers;
 * no trailer bytes escape. The final result is parsed independently. Overflow drops the preview only.
 */
export class ReplyProseBuffer {
  #raw = "";
  #rawBytes = 0;
  #overflow = false;
  constructor(readonly bytes: number) {}
  /** Consumes an arbitrary chunk (even half a surrogate pair) and returns a replacement prose snapshot. */
  append(delta: string): string {
    if (this.#overflow) return "";
    const joinsPair = /[\uD800-\uDBFF]$/.test(this.#raw) && /^[\uDC00-\uDFFF]/.test(delta);
    const nextBytes = this.#rawBytes + Buffer.byteLength(delta) - (joinsPair ? 2 : 0);
    if (nextBytes > this.bytes) {
      this.#raw = ""; this.#rawBytes = 0; this.#overflow = true; return "";
    }
    this.#raw += delta; this.#rawBytes = nextBytes;
    if (legacyPreview(this.#raw)) return "";
    const fence = /(^|\n)```jit-proposals\r?\n/.exec(this.#raw);
    const line = this.#raw.lastIndexOf("\n") + 1, tail = this.#raw.slice(line);
    const ambiguous = tail && (replyTrailer.startsWith(tail) || tail === `${replyTrailer}\r`);
    let prose = fence ? this.#raw.slice(0, fence.index) : ambiguous ? this.#raw.slice(0, line) : this.#raw;
    // Never encode a half of a UTF-16 pair as a replacement character.
    if (/[\uD800-\uDBFF]$/.test(prose)) prose = prose.slice(0, -1);
    return prose.isWellFormed() ? prose.trim() : "";
  }
}

// Transition-release exception: keep a possible v1 envelope private until it can be ruled out.
// Other leading code fences are released as soon as their header/body diverges from v1 JSON.
function legacyPreview(raw: string): boolean {
  const text = raw.trimStart();
  if (/^[{[]/.test(text)) return true;
  const start = raw.length - text.length;
  if (start && raw[start - 1] !== "\n") return false;
  const header = /^```(?:json)?[ \t]*\r?\n/.exec(text);
  if (!header) return !text.includes("\n") && ("```json".startsWith(text) || /^```(?:json)?[ \t]*\r?$/.test(text));
  const body = text.slice(header[0].length);
  if (!body.trimStart()) return true;
  if (!body.trimStart().startsWith("{")) return false;
  const closing = /\r?\n```(?:\r?\n|$)/.exec(body);
  if (!closing) return true;
  try {
    const value = JSON.parse(body.slice(0, closing.index));
    return value && typeof value === "object" && !Array.isArray(value) && typeof value.reply === "string";
  } catch { return false; }
}
