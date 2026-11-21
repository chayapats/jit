import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const native = process.platform === "darwin" && process.env.JIT_MOBILE_NATIVE_TESTS === "1";
(native ? test : test.skip)("actual Darwin writer refuses existing names/symlinks and concurrent export cannot replace the winning bytes", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jit-mobile-export-")), binary = join(directory, "export-fixture");
  try {
    const compiled = Bun.spawnSync(["xcrun", "swiftc", resolve("clients/mobile/modules/jit-native-gate/ios/JitExclusiveExport.swift"), resolve("tests/fixtures/s16-mobile-exclusive-export.swift"), "-o", binary], { stdout: "pipe", stderr: "pipe" }); expect(compiled.stderr.toString()).not.toContain("error:"); expect(compiled.exitCode).toBe(0);
    const uri = pathToFileURL(directory).href;
    const run = async (name: string, text: string, selected = uri) => { const process = Bun.spawn([binary, selected, name, text], { stdout: "pipe", stderr: "pipe" }); const result = (await new Response(process.stdout).text()).trim(); expect(await process.exited).toBe(0); return result; };
    writeFileSync(join(directory, "existing.txt"), "original"); expect(await run("existing.txt", "replacement")).toBe("refused"); expect(readFileSync(join(directory, "existing.txt"), "utf8")).toBe("original");
    symlinkSync(join(directory, "existing.txt"), join(directory, "link.txt")); expect(await run("link.txt", "replacement")).toBe("refused"); expect(readFileSync(join(directory, "existing.txt"), "utf8")).toBe("original");
    for (const name of ["../escape", "a/b", "a\\b", ".", "..", "bad\nname"]) expect(await run(name, "unselected")).toBe("refused");
    const raced = await Promise.all([run("race.txt", "first"), run("race.txt", "second")]); expect(raced.sort()).toEqual(["created", "refused"]); expect(["first", "second"]).toContain(readFileSync(join(directory, "race.txt"), "utf8"));
    symlinkSync(directory, join(directory, "directory-link")); expect(await run("unselected.txt", "unselected", pathToFileURL(join(directory, "directory-link")).href)).toBe("refused");
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30000);
