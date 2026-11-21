import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareMobileBuildSource } from "../ops/mobile/source";

function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "jit-mobile-source-"))), source = join(directory, "repository"), build = join(directory, "build");
  mkdirSync(source, { mode: 0o700 }); mkdirSync(build, { mode: 0o700 });
  const git = (...args: string[]) => { const result = Bun.spawnSync(["git", "-C", source, ...args], { stdout: "pipe", stderr: "pipe" }); if (result.exitCode !== 0) throw Error("fixture_git_failed"); return result.stdout.toString().trim(); };
  git("init", "-q"); mkdirSync(join(source, "clients/mobile"), { recursive: true });
  writeFileSync(join(source, ".gitignore"), "clients/mobile/ios/\nclients/mobile/android/\nnode_modules/\n");
  writeFileSync(join(source, "clients/mobile/index.ts"), "export const reviewed = true;\n");
  git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Reviewed fixture source");
  return { directory, source, build, git, commit: () => git("rev-parse", "HEAD"), close: () => rmSync(directory, { recursive: true, force: true }) };
}

test("native release source is a new immutable Git snapshot that excludes and preserves old ignored native edits", () => {
  const f = fixture();
  try {
    for (const platform of ["ios", "android"]) { mkdirSync(join(f.source, "clients/mobile", platform)); writeFileSync(join(f.source, "clients/mobile", platform, "unreviewed-native.txt"), "Unreviewed local native source must survive locally and never compile."); }
    mkdirSync(join(f.source, "node_modules")); writeFileSync(join(f.source, "node_modules", "local-extra.js"), "unreviewed");
    const snapshot = prepareMobileBuildSource(f.source, f.build, f.commit());
    expect(snapshot.archiveSha256).toMatch(/^[a-f0-9]{64}$/); expect(snapshot.files).toBe(2); expect(snapshot.bytes).toBeGreaterThan(0); expect(snapshot.directory).not.toBe(f.source);
    expect(readFileSync(join(snapshot.directory, "clients/mobile/index.ts"), "utf8")).toBe("export const reviewed = true;\n");
    for (const platform of ["ios", "android"]) { expect(existsSync(join(snapshot.directory, "clients/mobile", platform))).toBe(false); expect(readFileSync(join(f.source, "clients/mobile", platform, "unreviewed-native.txt"), "utf8")).toContain("must survive"); }
    expect(existsSync(join(snapshot.directory, "node_modules"))).toBe(false);
    writeFileSync(join(f.source, "clients/mobile/index.ts"), "export const reviewed = false;\n"); expect(readFileSync(join(snapshot.directory, "clients/mobile/index.ts"), "utf8")).toContain("true");
  } finally { f.close(); }
});

test("archive attributes cannot silently omit a reviewed input or substitute different bytes", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source, ".git/info/attributes"), "clients/mobile/index.ts export-ignore\n");
    expect(() => prepareMobileBuildSource(f.source, f.build, f.commit())).toThrow("mobile_build_source_mismatch");
  } finally { f.close(); }
});

test("committed executable modes remain exact despite a host archive umask override", () => {
  const f = fixture(); let previous: number | null = null;
  try {
    writeFileSync(join(f.source, "build-helper.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 }); f.git("add", "."); f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Executable fixture"); f.git("config", "tar.umask", "0077");
    previous = process.umask(0o077);
    const snapshot = prepareMobileBuildSource(f.source, f.build, f.commit()); expect(lstatSync(join(snapshot.directory, "build-helper.sh")).mode & 0o777).toBe(0o755); expect(lstatSync(join(snapshot.directory, "clients/mobile/index.ts")).mode & 0o777).toBe(0o644);
  } finally { if (previous !== null) process.umask(previous); f.close(); }
});

test("tracked source symlinks are refused before extraction and never read through", () => {
  const f = fixture();
  try {
    const external = join(f.directory, "external.txt"); writeFileSync(external, "private fixture sentinel"); symlinkSync(external, join(f.source, "clients/mobile/link"));
    f.git("add", "."); f.git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Fixture symlink");
    expect(() => prepareMobileBuildSource(f.source, f.build, f.commit())).toThrow("mobile_build_source_mode_invalid"); expect(existsSync(join(f.build, "source"))).toBe(false); expect(readFileSync(external, "utf8")).toBe("private fixture sentinel");
  } finally { f.close(); }
});

test("dirty sources, changed commit and reused snapshot destinations refuse without overwriting previous state", () => {
  const f = fixture();
  try {
    expect(() => prepareMobileBuildSource(f.source, f.build, "a".repeat(40))).toThrow("mobile_build_source_changed");
    writeFileSync(join(f.source, "clients/mobile/index.ts"), "uncommitted\n"); expect(() => prepareMobileBuildSource(f.source, f.build, f.commit())).toThrow("mobile_source_dirty");
    f.git("checkout", "--", "clients/mobile/index.ts"); const snapshot = prepareMobileBuildSource(f.source, f.build, f.commit());
    expect(() => prepareMobileBuildSource(f.source, f.build, f.commit())).toThrow("mobile_build_source_destination_invalid"); expect(readFileSync(join(snapshot.directory, "clients/mobile/index.ts"), "utf8")).toContain("reviewed");
  } finally { f.close(); }
});
