import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeNativeDesktop, desktopCurrent, desktopInstallation, installNativeDesktop, rollbackNativeDesktop, sealNativeDesktop, selectDesktopService, verifyNativeDesktop } from "../src/s16/desktop/installation";
import { writeDesktopRecord } from "../src/s16/desktop/storage";

/** Small controlled public code trees test filesystem/recovery contracts; actual bundled distribution is separate. */
function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "jit-native-install-"))), root = join(parent, "installation");
  const artifact = (revision: string, bootstrap = "/* stable v1 fixture bootstrap */") => {
    const directory = join(parent, "artifact-" + revision); mkdirSync(directory, { mode: 0o755 });
    const files: Record<string, string> = { "main.js": `export const fixtureRevision=${JSON.stringify(revision)};`, "bootstrap.js": bootstrap, "icon.png": "Controlled fixture icon", "icon.icns": "Controlled fixture icon", LICENSE: "Controlled fixture license", NOTICE: "Controlled fixture notice", "node_modules/playwright-core/package.json": JSON.stringify({ name: "playwright-core", version: "1.64.1" }), "node_modules/playwright-core/LICENSE": "Controlled fixture dependency license", "node_modules/playwright-core/NOTICE": "Controlled fixture notice", "node_modules/playwright-core/ThirdPartyNotices.txt": "Controlled fixture third party notices" };
    for (const [path, text] of Object.entries(files)) { const target = join(directory, path); mkdirSync(join(target, ".."), { recursive: true, mode: 0o755 }); writeFileSync(target, text, { mode: 0o644 }); chmodSync(target, 0o644); }
    const manifest = sealNativeDesktop(directory, { version: "0.1.0", bunVersion: "1.4.2", playwrightVersion: "1.64.1", source: { commit: null, dirty: true, lockHash: "a".repeat(64) } });
    return { directory, manifest };
  };
  return { parent, root, artifact, runtime: { bun: process.execPath, browser: process.execPath, locale: "en" as const, service: "https://jit.example.test" }, close: () => rmSync(parent, { recursive: true, force: true }) };
}

test.each([0o022, 0o077])('native package seal keeps its required public manifest mode under producer umask %i', mask => {
  const f = fixture(), previous = process.umask(mask);
  try {
    const artifact = f.artifact('umask-' + mask);
    expect(statSync(join(artifact.directory, 'manifest.json')).mode & 0o7777).toBe(0o644);
    expect(verifyNativeDesktop(artifact.directory)).toEqual(artifact.manifest);
  } finally { process.umask(previous); f.close(); }
});

test("local native install, update and rollback select complete code without changing service/profile identity", () => {
  const f = fixture(); try {
    const a = f.artifact("a"), b = f.artifact("b");
    expect(installNativeDesktop({ artifact: a.directory, root: f.root, runtime: f.runtime })).toMatchObject({ active: a.manifest.id, previous: null });
    const config = readFileSync(join(f.root, "installation.json"));
    mkdirSync(join(f.root, "profiles"), { mode: 0o700 }); writeDesktopRecord(join(f.root, "profiles", "retained.json"), { originalRequest: "r1", privateState: "retained" });
    const profile = readFileSync(join(f.root, "profiles", "retained.json"));
    expect(installNativeDesktop({ artifact: b.directory, root: f.root })).toMatchObject({ active: b.manifest.id, previous: a.manifest.id });
    expect(activeNativeDesktop(f.root).manifest.id).toBe(b.manifest.id);
    expect(rollbackNativeDesktop(f.root)).toMatchObject({ active: a.manifest.id, previous: b.manifest.id });
    expect(activeNativeDesktop(f.root).manifest.id).toBe(a.manifest.id);
    expect(readFileSync(join(f.root, "installation.json"))).toEqual(config); expect(readFileSync(join(f.root, "profiles", "retained.json"))).toEqual(profile);
  } finally { f.close(); }
});

test.each(["staged", "renamed", "committed"] as const)("interruption at %s has one recoverable pointer and retains original profile bytes", phase => {
  const f = fixture(); try {
    const a = f.artifact("a"), b = f.artifact("b"); installNativeDesktop({ artifact: a.directory, root: f.root, runtime: f.runtime });
    writeDesktopRecord(join(f.root, "retained-profile.json"), { receipt: "original" }); const profile = readFileSync(join(f.root, "retained-profile.json"));
    expect(() => installNativeDesktop({ artifact: b.directory, root: f.root }, current => { if (current === phase) throw new Error("controlled_interruption"); })).toThrow("controlled_interruption");
    const expected = phase === "committed" ? b.manifest.id : a.manifest.id;
    expect(desktopCurrent(f.root)!.active).toBe(expected); expect(activeNativeDesktop(f.root).manifest.id).toBe(expected);
    expect(installNativeDesktop({ artifact: b.directory, root: f.root })).toMatchObject({ active: b.manifest.id, previous: a.manifest.id });
    expect(readFileSync(join(f.root, "retained-profile.json"))).toEqual(profile);
  } finally { f.close(); }
});

test("interrupted first install is explicitly incomplete until the same complete release is selected again", () => {
  const f = fixture(); try {
    const a = f.artifact("a");
    expect(() => installNativeDesktop({ artifact: a.directory, root: f.root, runtime: f.runtime }, phase => { if (phase === "renamed") throw new Error("controlled_interruption"); })).toThrow("controlled_interruption");
    expect(desktopCurrent(f.root)).toBeNull(); expect(() => activeNativeDesktop(f.root)).toThrow("desktop_install_incomplete");
    expect(installNativeDesktop({ artifact: a.directory, root: f.root })).toMatchObject({ active: a.manifest.id, previous: null });
    expect(activeNativeDesktop(f.root).manifest.id).toBe(a.manifest.id);
  } finally { f.close(); }
});

test.each(["corrupt", "extra", "symlink", "duplicate_json"] as const)("a %s candidate cannot change the active release or bootstrap", kind => {
  const f = fixture(); try {
    const a = f.artifact("a"), b = f.artifact("b"); installNativeDesktop({ artifact: a.directory, root: f.root, runtime: f.runtime });
    const pointer = readFileSync(join(f.root, "current.json")), bootstrap = readFileSync(join(f.root, "bootstrap.js"));
    if (kind === "corrupt") writeFileSync(join(b.directory, "main.js"), "changed bytes");
    if (kind === "extra") writeFileSync(join(b.directory, "extra.js"), "uninventoried");
    if (kind === "symlink") { rmSync(join(b.directory, "main.js")); symlinkSync(join(a.directory, "main.js"), join(b.directory, "main.js")); }
    if (kind === "duplicate_json") { const path = join(b.directory, "manifest.json"), text = readFileSync(path, "utf8"); writeFileSync(path, text.replace('  "id":', '  "id": "' + b.manifest.id + '",\n  "id":')); }
    expect(() => installNativeDesktop({ artifact: b.directory, root: f.root })).toThrow();
    expect(readFileSync(join(f.root, "current.json"))).toEqual(pointer); expect(readFileSync(join(f.root, "bootstrap.js"))).toEqual(bootstrap);
  } finally { f.close(); }
});

test("changed bootstraps and corrupt retained releases refuse rollback/migration without erasing the current app", () => {
  const f = fixture(); try {
    const a = f.artifact("a"), b = f.artifact("b"), c = f.artifact("c", "/* changed bootstrap */"); installNativeDesktop({ artifact: a.directory, root: f.root, runtime: f.runtime });
    expect(() => installNativeDesktop({ artifact: c.directory, root: f.root })).toThrow("desktop_bootstrap_migration_required");
    installNativeDesktop({ artifact: b.directory, root: f.root });
    writeFileSync(join(f.root, "releases", a.manifest.id, "main.js"), "corrupt previous");
    expect(() => rollbackNativeDesktop(f.root)).toThrow("desktop_release_hash_invalid"); expect(activeNativeDesktop(f.root).manifest.id).toBe(b.manifest.id);
    writeFileSync(join(f.root, "bootstrap.js"), "corrupt bootstrap"); expect(() => activeNativeDesktop(f.root)).toThrow("desktop_bootstrap_invalid");
  } finally { f.close(); }
});

test("activation has one native writer and explicit service selection never replaces runtime configuration", () => {
  const f = fixture(); try {
    const a = f.artifact("a"), b = f.artifact("b"); installNativeDesktop({ artifact: a.directory, root: f.root, runtime: f.runtime });
    installNativeDesktop({ artifact: b.directory, root: f.root }, phase => { if (phase === "renamed") expect(() => installNativeDesktop({ artifact: a.directory, root: f.root })).toThrow("desktop_profile_busy"); });
    const before = desktopInstallation(f.root); selectDesktopService(f.root, "https://other.example.test");
    expect(desktopInstallation(f.root)).toEqual({ ...before, service: "https://other.example.test" });
    expect(() => selectDesktopService(f.root, "https://user:password@other.example.test")).toThrow("desktop_service_invalid");
    expect(desktopInstallation(f.root).service).toBe("https://other.example.test"); expect(verifyNativeDesktop(b.directory).id).toBe(b.manifest.id);
    expect(() => installNativeDesktop({ artifact: a.directory, root: f.root, runtime: f.runtime })).toThrow("desktop_configuration_changed");
    expect(activeNativeDesktop(f.root).manifest.id).toBe(b.manifest.id);
  } finally { f.close(); }
});
