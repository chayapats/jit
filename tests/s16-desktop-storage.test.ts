import { expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desktopProfile, leaseDesktopProfile, prepareDesktopStartup, privateDesktopDirectory, readDesktopRecord, writeDesktopRecord } from "../src/s16/desktop/storage";
import { desktopExecutable } from "../src/s16/desktop/launcher";

function fixture() { const parent = realpathSync(mkdtempSync(join(tmpdir(), "jit-desktop-storage-"))); return { parent, root: join(parent, "installation"), close: () => rmSync(parent, { recursive: true, force: true }) }; }

test("managed profiles bind the complete service origin; neither another port nor a changed identity can borrow one", () => {
  const f = fixture(); try {
    const first = desktopProfile(f.root, "https://jit.example.test"), again = desktopProfile(f.root, "https://jit.example.test/s16/"), second = desktopProfile(f.root, "https://jit.example.test:8443");
    expect(first).toEqual(again); expect(first.directory).not.toBe(second.directory);
    expect(lstatSync(first.directory).mode & 0o777).toBe(0o700);
    const file = join(first.directory, "identity.json"); expect(lstatSync(file).mode & 0o777).toBe(0o600);
    writeDesktopRecord(file, { contract: "s16-desktop-profile/v1", origin: "https://other.test" });
    const bytes = readFileSync(file);
    expect(() => desktopProfile(f.root, "https://jit.example.test")).toThrow("desktop_profile_mismatch"); expect(readFileSync(file)).toEqual(bytes);
  } finally { f.close(); }
});

test("only one native writer owns a profile; normal release reopens it without removing profile state", () => {
  const f = fixture(); try {
    const profile = desktopProfile(f.root, "https://jit.example.test"), release = leaseDesktopProfile(profile.directory);
    writeDesktopRecord(join(profile.directory, "retained.json"), { state: "retained" });
    expect(() => leaseDesktopProfile(profile.directory)).toThrow("desktop_profile_busy");
    release(); release(); const next = leaseDesktopProfile(profile.directory); next();
    expect(readDesktopRecord(join(profile.directory, "retained.json"))).toEqual({ state: "retained" });
  } finally { f.close(); }
});

test("private records refuse broad access, symlink reads and writes, including dangling targets", () => {
  const f = fixture(); try {
    const root = privateDesktopDirectory(f.root), file = join(root, "record.json"); writeDesktopRecord(file, { preserved: true });
    const linked = join(root, "linked.json"); symlinkSync(file, linked);
    expect(() => readDesktopRecord(linked)).toThrow(); expect(() => writeDesktopRecord(linked, { changed: true })).toThrow("desktop_record_invalid");
    const dangling = join(root, "dangling.json"); symlinkSync(join(root, "missing.json"), dangling);
    expect(() => writeDesktopRecord(dangling, {})).toThrow("desktop_record_invalid");
    expect(readDesktopRecord(file)).toEqual({ preserved: true }); chmodSync(file, 0o644); expect(() => readDesktopRecord(file)).toThrow("desktop_record_invalid");
    const alias = join(f.parent, "alias"); symlinkSync(root, alias); expect(() => privateDesktopDirectory(alias)).toThrow("desktop_directory_invalid");
  } finally { f.close(); }
});

test("startup does not restore tabs or form navigations before guards; unrelated browser preferences survive", () => {
  const f = fixture(); try {
    const profile = desktopProfile(f.root, "https://jit.example.test"), browser = prepareDesktopStartup(profile.directory), file = join(browser, "Default", "Preferences");
    writeDesktopRecord(file, { session: { restore_on_startup: 1, startup_urls: ["https://other.test"], other: "retained" }, profile: { exit_type: "Crashed", theme: "retained" }, download: { prompt_for_download: true } });
    expect(prepareDesktopStartup(profile.directory)).toBe(browser);
    expect(readDesktopRecord(file)).toEqual({ session: { restore_on_startup: 5, startup_urls: [], other: "retained" }, profile: { exit_type: "Normal", theme: "retained", exited_cleanly: true }, download: { prompt_for_download: true } });
  } finally { f.close(); }
});

test("executable selection is a canonical installed file, never a shell expression or writable script", () => {
  const f = fixture(); try {
    expect(desktopExecutable(process.execPath)).toBe(realpathSync(process.execPath));
    expect(() => desktopExecutable(process.execPath + " --version")).toThrow("desktop_executable_invalid");
    expect(() => desktopExecutable("bun")).toThrow("desktop_executable_invalid");
    const executable = join(f.parent, "writable"); writeFileSync(executable, "controlled fixture", { mode: 0o777 }); chmodSync(executable, 0o777);
    expect(() => desktopExecutable(executable)).toThrow("desktop_executable_invalid");
  } finally { f.close(); }
});
