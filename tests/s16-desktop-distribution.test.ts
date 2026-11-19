import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildNativeDesktop } from "../ops/desktop/build";
import { installDesktopEntries } from "../ops/desktop/entries";
import { desktopPackageCommand } from "../ops/desktop/main";
import { activeNativeDesktop, installNativeDesktop, rollbackNativeDesktop, verifyNativeDesktop } from "../src/s16/desktop/installation";

test("actual native bundles/dependency/notices install, update and roll back with a stable verified bootstrap", async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "jit-desktop-distribution-"))), source = join(parent, "source"), repository = resolve(import.meta.dir, "..");
  mkdirSync(source, { mode: 0o755 });
  try {
    for (const path of ["src/s16/desktop", "src/i18n", "src/web-assets/icons", "third_party", "package.json", "bun.lock", "LICENSE", "NOTICE"]) {
      const target = join(source, path); mkdirSync(join(target, ".."), { recursive: true }); cpSync(join(repository, path), target, { recursive: true });
    }
    // Input uses the existing frozen installation. Output must contain ordinary dependency files, never this link.
    symlinkSync(join(repository, "node_modules"), join(source, "node_modules"));
    const first = join(parent, "first"), same = join(parent, "same");
    const a = await buildNativeDesktop({ source, output: first }), repeated = await buildNativeDesktop({ source, output: same });
    expect(a.id).toBe(repeated.id); expect(a.files.length).toBeGreaterThan(100);
    expect(a.files.some(file => file.path === "node_modules/playwright-core/ThirdPartyNotices.txt")).toBe(true);
    expect(readFileSync(join(first, "icon.icns")).subarray(0, 4).toString()).toBe("icns");
    const entry = join(source, "src/s16/desktop/main.ts"); writeFileSync(entry, readFileSync(entry, "utf8") + '\nexport const distributionProbe = "updated-public-code";\n');
    const second = join(parent, "second"), b = await buildNativeDesktop({ source, output: second });
    expect(b.id).not.toBe(a.id);
    expect(b.files.find(file => file.path === "bootstrap.js")!.sha256).toBe(a.files.find(file => file.path === "bootstrap.js")!.sha256);
    const root = join(parent, "owner's app $data %01");
    installNativeDesktop({ artifact: first, root, runtime: { bun: process.execPath, browser: process.execPath, locale: "en" } });
    const mac = installDesktopEntries(root, "darwin"), linux = installDesktopEntries(root, "linux");
    const script = join(mac, "Contents/MacOS/Jit"), checked = Bun.spawnSync(["/bin/sh", "-n", script], { stdout: "ignore", stderr: "pipe" });
    expect(checked.exitCode).toBe(0); expect(readFileSync(script, "utf8")).toContain("'\"'\"'");
    expect(readFileSync(linux, "utf8")).toContain("%%01");
    expect(readFileSync(linux, "utf8")).toContain("\\\\$data");
    installNativeDesktop({ artifact: second, root });
    const selected = activeNativeDesktop(root), loaded = await import(pathToFileURL(join(selected.directory, "main.js")).href);
    expect(selected.manifest.id).toBe(b.id); expect(loaded.distributionProbe).toBe("updated-public-code");
    expect(typeof loaded.openDesktopSession).toBe("function"); expect(typeof loaded.runInstalledDesktop).toBe("function");
    rollbackNativeDesktop(root); expect(activeNativeDesktop(root).manifest.id).toBe(a.id);
    expect(verifyNativeDesktop(second).id).toBe(b.id);
  } finally { rmSync(parent, { recursive: true, force: true }); }
}, 30000);

test("operator packaging CLI accepts no command, flags, remote feed or duplicate-field escape", async () => {
  for (const args of [["exec", "--command", "ignored"], ["status", "--root", "/unused", "--eval", "ignored"], ["status", "--root", "/unused", "--root", "/other"], ["update", "--root", "/unused", "--feed", "https://example.test"], ["status", "/unused"]]) await expect(desktopPackageCommand(args)).rejects.toThrow("desktop_arguments_invalid");
});
