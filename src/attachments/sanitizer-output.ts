import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Hard byte bounds independent of compression ratios; over-cap output is rejected, never silently served. */
export const sanitizerOutputLimits = Object.freeze({ image: 16 * 1024 * 1024, text: 2 * 1024 * 1024, result: 2048 });
/** Total tmpfs/disk reservation, including a 64 KiB page for result metadata on x64 and arm64 hosts. */
export function sanitizerOutputBudget(kind: string): number {
  return (kind === "pdf" ? sanitizerOutputLimits.text : 2 * sanitizerOutputLimits.image) + 65536;
}
/** Maximum stdout transport: three length-prefixed records, with no archive or parser-controlled paths. */
export function sanitizerStreamLimit(kind: string): number { return sanitizerOutputBudget(kind) + 64; }

/** Validates the complete bounded stream before writing exclusive private files, after container cleanup. */
export function receiveSanitizerOutput(stream: Uint8Array, directory: string, kind: string): void {
  const invalid = (): never => { throw new Error("sanitize_output_invalid"); };
  if (stream.length > sanitizerStreamLimit(kind)) invalid();
  const ext = kind === "jpeg" ? "jpg" : "png";
  const caps: Record<string, number> = kind === "pdf" ? { "text.txt": sanitizerOutputLimits.text, "result.json": sanitizerOutputLimits.result }
    : { [`clean.${ext}`]: sanitizerOutputLimits.image, [`model.${ext}`]: sanitizerOutputLimits.image, "result.json": sanitizerOutputLimits.result };
  const files = new Map<string, Uint8Array>(); let offset = 0, total = 0;
  while (offset < stream.length) {
    const length = stream[offset++]!;
    if (length < 1 || length > 11 || offset + length + 4 > stream.length || files.size >= Object.keys(caps).length) invalid();
    const name = Buffer.from(stream.subarray(offset, offset + length)).toString("ascii"); offset += length;
    // Compare bytes too: ASCII decoding must not turn high-bit bytes into an allowed file name.
    if (!Object.hasOwn(caps, name) || !Buffer.from(name).equals(stream.subarray(offset - length, offset)) || files.has(name)) invalid();
    const bytes = new DataView(stream.buffer, stream.byteOffset + offset, 4).getUint32(0); offset += 4; total += bytes;
    if (bytes > caps[name]! || offset + bytes > stream.length || total > sanitizerOutputBudget(kind)) invalid();
    files.set(name, stream.subarray(offset, offset + bytes)); offset += bytes;
  }
  if (!files.has("result.json")) invalid();
  for (const [name, bytes] of files) writeFileSync(join(directory, name), bytes, { flag: "wx", mode: 0o600 });
}
