import { expect, test } from "bun:test";
import { validateBinaryFileConfig } from "../src/s16/files/runtime";
import { PodmanAttachmentSanitizer } from "../src/attachments/sanitizer-runtime";
import { readConfig } from "../src/config";
import { imageProbes } from "./fixtures/s16-binary";
import { SCHWAY_PINNED_REVISION } from "../src/schway-version";

const image = "jit-box-base@sha256:" + "a".repeat(64);
test("installed binary configuration requires an immutable image and current unambiguous live probe revision", () => {
  expect(() => validateBinaryFileConfig({ parserImage: image, imageProbes: [] })).not.toThrow();
  const probe = { ...imageProbes[0]!, revision: SCHWAY_PINNED_REVISION };
  expect(() => validateBinaryFileConfig({ parserImage: image, imageProbes: [probe] })).not.toThrow();
  for (const value of [{ parserImage: "base:latest", imageProbes: [] }, { parserImage: image, imageProbes }, { parserImage: image, imageProbes: [null] }, { parserImage: image, imageProbes: [probe, { ...probe, verdict: "fail" }] }, { parserImage: image, imageProbes: [], extra: true }]) expect(() => validateBinaryFileConfig(value)).toThrow("invalid_s15_config");
});
test("strict S16 runtime refuses the older parser image even though legacy decoding remains available", async () => {
  let version = "2";
  const command = async (args: readonly string[]) => ({ exitCode: 0, stderr: new Uint8Array(), stdout: Buffer.from(JSON.stringify(args[0] === "info" ? { host: { security: { rootless: true }, cgroupVersion: "v2", cgroupControllers: ["memory", "cpu", "pids"] } } : [{ Config: { Labels: { "jit.sanitize.version": version } } }])) });
  const runtime = new PodmanAttachmentSanitizer(image, "fixture", readConfig({}).attachments, command, undefined, "s16-isolated-file/v1");
  expect(await runtime.available()).toBe(false); version = "3"; expect(await runtime.available()).toBe(true);
  expect(runtime.s16).toEqual({ contract: "s16-isolated-file/v1", generation: image });
});
