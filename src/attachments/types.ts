import { AppError } from "../errors";

const tables = {
  png: ["png"], jpeg: ["jpg", "jpeg"], webp: ["webp"], pdf: ["pdf"],
  text: "txt md markdown csv tsv json jsonl yaml yml toml ini log xml sql py ts tsx js jsx mjs go rs java kt c h cc cpp hpp cs rb php swift css diff patch".split(" "),
  svg: ["svg", "svgz"], html: "html htm xhtml shtml mht".split(" "),
  archive: "zip tar gz tgz 7z rar bz2 xz zst".split(" "), office: "docx xlsx pptx doc xls ppt odt ods odp rtf".split(" "),
  executable: "exe dll so dylib msi deb rpm apk app jar com bat cmd ps1 vbs sh bash zsh command".split(" "), heic: ["heic", "heif"],
};
const known = new Set(Object.values(tables).flat());
/** Detected original type, independent of any client-supplied Content-Type. */
export interface AttachmentType { kind: "image" | "pdf" | "text"; mediaType: string }
/** Returns a fixed, safe refusal code and never includes file bytes or a display name. */
export function unsupportedAttachment(reason: string): never { throw new AppError("attachment_type_unsupported", 415, { reason }); }

/** Decodes one bounded UTF-8 header/filename and produces a display-only name, never a storage path. */
export function attachmentDisplayName(encoded: string | null): string {
  if (!encoded || Buffer.byteLength(encoded) > 1024) throw new AppError("invalid_attachment_upload");
  let name: string;
  try { name = decodeURIComponent(encoded); } catch { throw new AppError("invalid_attachment_upload"); }
  if (!name.isWellFormed()) throw new AppError("invalid_attachment_upload");
  name = name.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "")
    .replace(/[/\\]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "");
  const dot = name.lastIndexOf("."), ext = dot >= 0 ? name.slice(dot) : "";
  // An overlong suffix cannot be a supported extension; keep the bounded name for the type refusal.
  const suffix = Buffer.byteLength(ext) < 32 ? ext : "";
  let stem = "", used = 0;
  for (const c of (suffix ? name.slice(0, -suffix.length) : name)) {
    const n = Buffer.byteLength(c); if (used + n + Buffer.byteLength(suffix) > 128) break; stem += c; used += n;
  }
  return `${stem || "file"}${suffix}`;
}

/** Streaming byte validator: bounded magic prefix plus complete fatal UTF-8/NUL validation, without buffering a file. */
export class AttachmentSniffer {
  #prefix = Buffer.alloc(0);
  #decoder = new TextDecoder("utf-8", { fatal: true });
  #invalidUtf8 = false;
  #nul = false;
  #head = "";
  #xml = false;
  #declaration = false;
  #tail = "";
  #bytes = 0;
  /** Consumes each chunk exactly once; retains at most 512 magic bytes and 4096 text characters. */
  push(chunk: Uint8Array): void {
    this.#bytes += chunk.length;
    if (this.#prefix.length < 512) this.#prefix = Buffer.concat([this.#prefix, chunk.subarray(0, 512 - this.#prefix.length)]);
    if (chunk.includes(0)) this.#nul = true;
    if (!this.#invalidUtf8) {
      try { this.#text(this.#decoder.decode(chunk, { stream: true })); } catch { this.#invalidUtf8 = true; }
    }
  }
  #text(text: string): void {
    for (let at = 0; at < text.length; at += 512) {
      let part = text.slice(at, at + 512);
      if (this.#declaration) {
        part = this.#tail + part;
        const end = part.indexOf("?>");
        if (end < 0) { this.#tail = part.slice(-1); continue; }
        this.#declaration = false; this.#tail = ""; part = part.slice(end + 2);
      }
      this.#head = (this.#head + part).trimStart();
      if (!this.#xml && /^<\?xml\b/i.test(this.#head)) {
        this.#xml = true;
        const end = this.#head.indexOf("?>");
        if (end < 0) { this.#declaration = true; this.#tail = this.#head.slice(-1); this.#head = ""; }
        else this.#head = this.#head.slice(end + 2).trimStart();
      }
      this.#head = this.#head.slice(0, 4096);
    }
  }
  /** Requires both a closed extension and matching bytes; the whole text file must be valid UTF-8 without NUL. */
  finish(name: string): AttachmentType {
    if (!this.#invalidUtf8) { try { this.#text(this.#decoder.decode()); } catch { this.#invalidUtf8 = true; } }
    const parts = name.toLowerCase().split("."), ext = parts.length > 1 ? parts.at(-1)! : "";
    if (parts.length > 2 && known.has(parts.at(-2)!)) unsupportedAttachment("double_extension");
    for (const reason of ["svg", "html", "office", "executable", "heic", "archive"] as const) if (tables[reason].includes(ext)) unsupportedAttachment(reason);
    if (!this.#bytes) unsupportedAttachment("empty_file");
    const p = this.#prefix, hex = p.subarray(0, 8).toString("hex"), ascii = (start: number, end: number) => p.subarray(start, end).toString("ascii");
    if (/^<svg(?:\s|>|\/)/i.test(this.#head)) unsupportedAttachment("svg");
    if (/^(?:<!doctype\s+html\b|<html(?:\s|>|\/))/i.test(this.#head)) unsupportedAttachment("html");
    if (hex.startsWith("504b0304") || hex.startsWith("1f8b") || hex.startsWith("377abcaf271c") || hex.startsWith("52617221") ||
      hex.startsWith("425a68") || hex.startsWith("fd377a585a00") || hex.startsWith("28b52ffd") || ascii(257, 262) === "ustar") unsupportedAttachment("archive");
    if (hex.startsWith("7f454c46") || ascii(0, 2) === "MZ" || ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].some(x => hex.startsWith(x))) unsupportedAttachment("executable");
    if (ascii(4, 8) === "ftyp" && ["heic", "heix", "hevc", "mif1", "msf1"].includes(ascii(8, 12))) unsupportedAttachment("heic");
    if (!ext) unsupportedAttachment("extension_missing");
    const magic = hex === "89504e470d0a1a0a" ? "png" : hex.startsWith("ffd8ff") ? "jpeg" : ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP" ? "webp" : ascii(0, 5) === "%PDF-" ? "pdf" : null;
    const expected = (["png", "jpeg", "webp", "pdf", "text"] as const).find(type => tables[type].includes(ext));
    if (!expected) unsupportedAttachment("extension_unsupported");
    if (magic !== null && magic !== expected || magic === null && expected !== "text") unsupportedAttachment("extension_mismatch");
    if (expected === "text") {
      if (this.#nul) unsupportedAttachment("text_nul");
      if (this.#invalidUtf8) unsupportedAttachment("text_not_utf8");
      return { kind: "text", mediaType: "text/plain" };
    }
    return expected === "pdf" ? { kind: "pdf", mediaType: "application/pdf" } : { kind: "image", mediaType: `image/${expected}` };
  }
}
