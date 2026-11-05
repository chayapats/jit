import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { binaryFileRuntime } from "../src/s16/files/runtime";
import { FileParser } from "../src/s16/files/parser";
import { encryptedPdf, fixtureImage, launchPdf } from "./fixtures/s16-binary";

// Disposable rootless Linux only. This never builds/pulls images or enables the installed owner host.
const live = process.env.JIT_LIVE_S16_FILES === "1" && !!process.env.JIT_LIVE_BOX_IMAGE;
(live ? test : test.skip)("opt-in strict S16 parser on rootless Linux processes actual PDF/PNG/JPEG and refuses encryption", async () => {
  const directory = realpathSync(mkdtempSync(join(process.env.JIT_LIVE_CONTAINER_ROOT ?? tmpdir(), "jit-live-s16-")));
  const runtime = binaryFileRuntime({ parserImage: process.env.JIT_LIVE_BOX_IMAGE!, imageProbes: [] }, directory, process.env), parser = new FileParser(runtime, join(directory, "parser"), true);
  try {
    expect(await parser.available()).toBe(true);
    const pdf = await parser.parse("pdf", launchPdf()); expect(new TextDecoder().decode(pdf.bytes)).toContain("Launch: Friday.");
    for (const [kind, name] of [["png", "metadata-polyglot.png"], ["jpeg", "exif-gps.jpg"]] as const) { const image = await parser.parse(kind, fixtureImage(name)); expect(image.kind).toBe("image"); expect(image.bytes.length).toBeGreaterThan(0); }
    await expect(parser.parse("pdf", encryptedPdf())).rejects.toThrow();
  } finally { await parser.close(); await runtime.reset(); rmSync(directory, { recursive: true, force: true }); }
}, 60000);
