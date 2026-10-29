import { AppError } from "../errors";

/** Headers of one `multipart/form-data` part: its field name and, for a file control, the raw (browser-escaped) filename. */
export interface MultipartPart { name: string; filename: string | null }

const invalid = () => new AppError("invalid_attachment_upload");
const crlf = Buffer.from("\r\n"), headerEnd = Buffer.from("\r\n\r\n");
/** RFC 2046 boundary characters; browsers generate shorter, alphanumeric boundaries. */
const boundaryPattern = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;
/** Largest header block of one part. A display name is at most 1024 encoded bytes, so a real header block stays well under this. */
const headerBytes = 4096;

/**
 * Parses the boundary of a `multipart/form-data` Content-Type. Any other media type is 415
 * `unsupported_content_type`; a missing or malformed boundary is 400 `invalid_attachment_upload`.
 */
export function multipartBoundary(contentType: string | null): string {
  const [type, ...params] = (contentType ?? "").split(";").map(item => item.trim());
  if (type?.toLowerCase() !== "multipart/form-data") throw new AppError("unsupported_content_type", 415);
  const values = params.filter(param => /^boundary=/i.test(param)).map(param => param.slice(9));
  if (values.length !== 1) throw invalid();
  const raw = values[0]!, boundary = raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1) : raw;
  if (!boundaryPattern.test(boundary)) throw invalid();
  return boundary;
}

/**
 * Turns a browser multipart filename into the percent-encoded form the ATT01 upload path takes (`attachmentDisplayName`).
 * Browsers send the name as raw UTF-8 and escape only `"`, CR and LF as `%22`, `%0D` and `%0A` (HTML form submission).
 * The name is cut to 128 UTF-8 bytes first, keeping a short extension, so the encoded form stays under the 1024-byte
 * bound; the upload path then applies the full display-name rules. The result names nothing on disk.
 */
export function multipartFileName(raw: string): string {
  const name = raw.replace(/%22/gi, '"').replace(/%0D/gi, "\r").replace(/%0A/gi, "\n");
  const dot = name.lastIndexOf("."), suffix = dot > 0 && Buffer.byteLength(name.slice(dot)) < 32 ? name.slice(dot) : "";
  let stem = "", used = Buffer.byteLength(suffix);
  for (const char of suffix ? name.slice(0, -suffix.length) : name) {
    const n = Buffer.byteLength(char); if (used + n > 128) break; stem += char; used += n;
  }
  return encodeURIComponent(stem + suffix);
}

/**
 * A strict, streaming reader for the ordered `?send=1` body (app.attachments/v1). It pulls from the request only when
 * it needs more bytes, so a caller can check the first part (`csrf`) before any later part is pulled, parsed or
 * stored. A file part is exposed as a lazy stream that ends at the next delimiter; nothing is buffered beyond one
 * chunk plus a delimiter-sized tail. Any framing it does not expect (a preamble, an unknown header, a malformed
 * Content-Disposition, transport padding, an epilogue or a truncated body) is 400 `invalid_attachment_upload`.
 */
export class OrderedMultipart {
  #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer = Buffer.alloc(0);
  #delimiter: Buffer;
  #ended = false;
  #state: "start" | "between" | "body" | "done" = "start";
  #consumed = 0;
  #reads = 0;
  constructor(body: ReadableStream<Uint8Array>, readonly boundary: string) {
    if (!boundaryPattern.test(boundary)) throw invalid();
    this.#reader = body.getReader();
    this.#delimiter = Buffer.from(`\r\n--${boundary}`);
  }
  /** Bytes of framing and text values consumed so far (not the bytes merely buffered). */
  get consumed(): number { return this.#consumed; }
  /** Chunks pulled from the request body so far. */
  get reads(): number { return this.#reads; }
  async #fill(bytes: number): Promise<boolean> {
    while (this.#buffer.length < bytes) {
      if (this.#ended) return false;
      const { done, value } = await this.#reader.read();
      if (done) { this.#ended = true; return this.#buffer.length >= bytes; }
      this.#reads++;
      if (value.byteLength) this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, value]) : Buffer.from(value);
    }
    return true;
  }
  #take(bytes: number): Buffer {
    const head = this.#buffer.subarray(0, bytes);
    this.#buffer = this.#buffer.subarray(bytes); this.#consumed += bytes;
    return head;
  }
  /**
   * Moves to the next part and returns its field name and filename, or null after the closing delimiter.
   * Call only when the previous part's value has been read to its end.
   */
  async next(): Promise<MultipartPart | null> {
    if (this.#state === "done") return null;
    if (this.#state === "body") throw invalid();
    if (this.#state === "start") {
      // No preamble: the body starts with the first dash-boundary (the delimiter without its leading CRLF).
      const first = this.#delimiter.subarray(2);
      if (!await this.#fill(first.length) || !this.#buffer.subarray(0, first.length).equals(first)) throw invalid();
      this.#take(first.length);
    }
    if (!await this.#fill(2)) throw invalid();
    const after = this.#take(2).toString("latin1");
    if (after === "--") {
      // The close delimiter may be followed by one CRLF and nothing else.
      await this.#fill(3);
      if (this.#buffer.length === 2 && this.#buffer.equals(crlf)) this.#take(2);
      if (this.#buffer.length || !this.#ended) throw invalid();
      this.#state = "done";
      return null;
    }
    if (after !== "\r\n") throw invalid();
    let end = -1;
    for (;;) {
      end = this.#buffer.indexOf(headerEnd);
      if (end >= 0 || this.#buffer.length > headerBytes) break;
      if (!await this.#fill(this.#buffer.length + 1)) throw invalid();
    }
    if (end < 0 || end > headerBytes) throw invalid();
    let block: string;
    try { block = new TextDecoder("utf-8", { fatal: true }).decode(this.#take(end)); } catch { throw invalid(); }
    this.#take(headerEnd.length);
    let part: MultipartPart | null = null;
    for (const line of block.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon <= 0) throw invalid();
      const header = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim();
      // The part's Content-Type is ignored (contract: the type is decided from the bytes); nothing else may appear.
      if (header === "content-type") continue;
      if (header !== "content-disposition" || part) throw invalid();
      part = disposition(value);
    }
    if (!part) throw invalid();
    this.#state = "body";
    return part;
  }
  /** Reads the current part's value as UTF-8 text of at most `maxBytes`; longer is 413 `request_too_large`. */
  async text(maxBytes: number): Promise<string> {
    const chunks: Buffer[] = []; let total = 0;
    for await (const chunk of this.#values()) {
      total += chunk.length;
      if (total > maxBytes) throw new AppError("request_too_large", 413);
      chunks.push(chunk);
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); } catch { throw invalid(); }
  }
  /** The current part's value as a lazy stream that ends before the next delimiter; cancelling it cancels the request. */
  body(): ReadableStream<Uint8Array> {
    const values = this.#values();
    return new ReadableStream<Uint8Array>({
      pull: async controller => {
        try {
          const { done, value } = await values.next();
          if (done) controller.close(); else controller.enqueue(value);
        } catch (error) { controller.error(error); }
      },
      cancel: () => this.cancel(),
    }, { highWaterMark: 0 });
  }
  /**
   * True when the current part's value is empty (the browser's "no file chosen" entry). Stops at the first value byte,
   * so a non-empty value is refused without reading it.
   */
  async empty(): Promise<boolean> { for await (const chunk of this.#values()) if (chunk.length) return false; return true; }
  async *#values(): AsyncGenerator<Buffer> {
    if (this.#state !== "body") throw invalid();
    const keep = this.#delimiter.length - 1;
    for (;;) {
      const at = this.#buffer.indexOf(this.#delimiter);
      if (at >= 0) {
        if (at) yield Buffer.from(this.#take(at));
        this.#take(this.#delimiter.length);
        this.#state = "between";
        return;
      }
      // Everything but a tail that could start a delimiter is part of the value.
      if (this.#buffer.length > keep) { yield Buffer.from(this.#take(this.#buffer.length - keep)); continue; }
      if (!await this.#fill(this.#buffer.length + 1)) throw invalid();
    }
  }
  /** Stops reading: the unread request body is cancelled and never parsed. */
  async cancel(): Promise<void> {
    this.#state = "done";
    try { await this.#reader.cancel(); } catch { /* Already closed or errored. */ }
  }
}

/** Parses `form-data; name="…"` with an optional `filename="…"`; quoted values carry no escapes (browsers percent-escape). */
function disposition(value: string): MultipartPart {
  const match = /^form-data\s*;\s*name="([^"\r\n]*)"(?:\s*;\s*filename="([^"\r\n]*)")?\s*$/i.exec(value);
  if (!match || !match[1]) throw invalid();
  return { name: match[1], filename: match[2] ?? null };
}
