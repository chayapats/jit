import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../src/config";
import { PodmanAttachmentSanitizer } from "../src/attachments/sanitizer-runtime";

// Owner-run only on a disposable rootless Linux host; deterministic CI never builds or invokes a container.
const live = process.env.JIT_LIVE_PODMAN === "1" && !!process.env.JIT_LIVE_BOX_IMAGE;
(live ? test : test.skip)("opt-in real base image strips fixture metadata and produces a model derivative", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jit-live-sanitize-"));
  const input = join(directory, "in"), output = join(directory, "out");
  mkdirSync(input, { mode: 0o700 }); mkdirSync(output, { mode: 0o700 });
  const runtime = new PodmanAttachmentSanitizer(process.env.JIT_LIVE_BOX_IMAGE!, directory, readConfig({}).attachments);
  try {
    writeFileSync(join(input, "input"), readFileSync(join(import.meta.dir, "fixtures/attachments/metadata-polyglot.png")), { mode: 0o600 });
    expect(await runtime.available()).toBe(true); await runtime.reset();
    await runtime.run({ input, output, kind: "png", pixels: 40_000_000 });
    expect(JSON.parse(readFileSync(join(output, "result.json"), "utf8"))).toMatchObject({ ok: true, width: 3000, height: 1 });
    for (const name of ["clean.png", "model.png"]) {
      const bytes = readFileSync(join(output, name));
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bytes.includes(Buffer.from("POLYGLOT_MARKER"))).toBe(false); expect(bytes.includes(Buffer.from("GPS"))).toBe(false);
    }
  } finally { await runtime.reset(); rmSync(directory, { recursive: true, force: true }); }
}, 60_000);
