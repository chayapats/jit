import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { AttachmentSanitizerRuntime } from "../../src/attachments/sanitizer-runtime";

/** Only known repository fixtures execute locally; production never uses this runtime. */
export function binaryRuntime(): AttachmentSanitizerRuntime {
  return { s16: { contract: "s16-isolated-file/v1", generation: "controlled-fixture-only" }, async available() { return true; }, async reset() {}, async run(job, signal) {
    const process = Bun.spawn([globalThis.process.env.JIT_TEST_PYTHON ?? "python3", join(import.meta.dir, "../../ops/box/sanitize"), job.kind, String(job.pixels), "30", "--s16", join(job.input, "input"), job.output], { env: { PATH: globalThis.process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" }, stdout: "ignore", stderr: "ignore" });
    const abort = () => process.kill("SIGKILL"); signal?.addEventListener("abort", abort, { once: true });
    try { if (signal?.aborted) abort(); if (await process.exited !== 0) throw Error("fixture_parser_failed"); } finally { signal?.removeEventListener("abort", abort); }
  } };
}
/** Minimal original PDF whose actual extracted text is used in the composed result. */
export function launchPdf(): Uint8Array {
  const stream = "BT /F1 12 Tf 20 50 Td (Launch: Friday.) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let pdf = "%PDF-1.4\n"; const offsets = [0]; for (const [i, object] of objects.entries()) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
export const fixtureImage = (name: "metadata-polyglot.png" | "exif-gps.jpg") => new Uint8Array(readFileSync(join(import.meta.dir, "attachments", name)));
export const imageProbes = [{ contract: "schway.host.image-input/v1" as const, route: "codex" as const, model: "fixture-model", testedAt: "2026-11-05T00:00:00.000Z", revision: "controlled-fixture-only", verdict: "pass" as const }];

/** A real PDF Standard Security R2 fixture, with an empty user password. Strict parsing must refuse
 * even when Poppler can open it without asking for a password. This is fixture encoding only. */
export function encryptedPdf(): Uint8Array {
  const md5 = (value: Uint8Array) => createHash("md5").update(value).digest();
  const rc4 = (key: Uint8Array, value: Uint8Array) => {
    const state = Array.from({ length: 256 }, (_, i) => i); let j = 0;
    for (let i = 0; i < 256; i++) { j = (j + state[i]! + key[i % key.length]!) % 256; [state[i], state[j]] = [state[j]!, state[i]!]; }
    let i = 0; j = 0;
    return Buffer.from(value.map(byte => { i = (i + 1) % 256; j = (j + state[i]!) % 256; [state[i], state[j]] = [state[j]!, state[i]!]; return byte ^ state[(state[i]! + state[j]!) % 256]!; }));
  };
  const padding = Buffer.from("28bf4e5e4e758a4164004e56fffa01082e2e00b6d0683e802f0ca9fe6453697a", "hex"), identifier = Buffer.alloc(16, 7), permissions = Buffer.alloc(4); permissions.writeInt32LE(-4);
  const owner = rc4(md5(Buffer.concat([Buffer.from("owner"), padding]).subarray(0, 32)).subarray(0, 5), padding);
  const key = md5(Buffer.concat([padding, owner, permissions, identifier])).subarray(0, 5), user = rc4(key, padding);
  const stream = rc4(md5(Buffer.concat([key, Buffer.from([4, 0, 0, 0, 0])])).subarray(0, 10), Buffer.from("BT /F1 12 Tf 20 50 Td (Encrypted launch.) Tj ET"));
  const objects = [Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"), Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"), Buffer.from("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>"), Buffer.concat([Buffer.from(`<< /Length ${stream.length} >>\nstream\n`), stream, Buffer.from("\nendstream")]), Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"), Buffer.from(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${owner.toString("hex")}> /U <${user.toString("hex")}> /P -4 >>`)];
  const parts = [Buffer.from("%PDF-1.4\n")], offsets: number[] = []; let size = parts[0]!.length;
  for (const [i, object] of objects.entries()) { offsets.push(size); const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), object, Buffer.from("\nendobj\n")]); parts.push(part); size += part.length; }
  parts.push(Buffer.from(`xref\n0 7\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size 7 /Root 1 0 R /Encrypt 6 0 R /ID [<${identifier.toString("hex")}><${identifier.toString("hex")}>] >>\nstartxref\n${size}\n%%EOF\n`));
  return Buffer.concat(parts);
}
