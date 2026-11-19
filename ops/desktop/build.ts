import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import { sealNativeDesktop, type NativeDesktopManifest } from "../../src/s16/desktop/installation";

function modes(root: string): void {
  chmodSync(root, 0o755);
  for (const name of readdirSync(root)) { const path = join(root, name), info = lstatSync(path); if (info.isSymbolicLink()) throw new Error("desktop_dependency_symlink"); if (info.isDirectory()) modes(path); else if (info.isFile()) chmodSync(path, info.mode & 0o111 ? 0o755 : 0o644); else throw new Error("desktop_dependency_member_invalid"); }
}

/**
 * Bundles authored Bun/TS entry/loader with the existing frozen Playwright dependency and all applicable notices.
 * Chrome/Bun executables and every private installation/profile file are excluded. Output must be a fresh directory.
 */
export async function buildNativeDesktop(options: { source: string; output: string }): Promise<NativeDesktopManifest> {
  const source = realpathSync(options.source), output = resolve(options.output), rel = relative(source, output);
  if (output === source || !rel.startsWith("..") && /^(?:src|node_modules|third_party)(?:\/|$)/.test(rel) || existsSync(output) || !isAbsolute(output)) throw new Error("desktop_build_output_invalid");
  if (Bun.version !== "1.4.2") throw new Error("desktop_bun_version_mismatch");
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };
  const dependency = join(source, "node_modules/playwright-core"), version = JSON.parse(readFileSync(join(dependency, "package.json"), "utf8")) as { version: string };
  if (pkg.dependencies["playwright-core"] !== "1.64.1" || version.version !== "1.64.1") throw new Error("desktop_dependency_mismatch");
  mkdirSync(output, { mode: 0o755 });
  for (const entry of ["main", "bootstrap"]) {
    const built = await Bun.build({ entrypoints: [join(source, `src/s16/desktop/${entry}.ts`)], target: "bun", minify: true, external: ["playwright-core"] });
    if (!built.success || built.outputs.length !== 1) throw new Error("desktop_bundle_failed");
    writeFileSync(join(output, entry + ".js"), await built.outputs[0]!.text(), { mode: 0o644 });
  }
  mkdirSync(join(output, "node_modules"), { mode: 0o755 }); cpSync(dependency, join(output, "node_modules/playwright-core"), { recursive: true, dereference: false });
  for (const name of ["LICENSE", "NOTICE"]) cpSync(join(source, name), join(output, name));
  cpSync(join(source, "third_party"), join(output, "third_party"), { recursive: true, dereference: false });
  cpSync(join(source, "src/web-assets/icons/icon-512.png"), join(output, "icon.png"));
  // ICNS ic09 embeds the authored 512px PNG directly; no image transformation or imported branding.
  const png = readFileSync(join(output, "icon.png")), icns = Buffer.alloc(16 + png.length); icns.write("icns"); icns.writeUInt32BE(icns.length, 4); icns.write("ic09", 8); icns.writeUInt32BE(8 + png.length, 12); png.copy(icns, 16); writeFileSync(join(output, "icon.icns"), icns);
  writeFileSync(join(output, "package.json"), JSON.stringify({ name: "jit-desktop", version: pkg.version, private: true, type: "module", dependencies: { "playwright-core": "1.64.1" } }, null, 2) + "\n");
  modes(output);
  const commit = Bun.spawnSync(["git", "-C", source, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" }), dirty = Bun.spawnSync(["git", "-C", source, "status", "--porcelain"], { stdout: "pipe", stderr: "ignore" });
  const pin = commit.stdout.toString().trim();
  return sealNativeDesktop(output, { version: pkg.version, bunVersion: Bun.version, playwrightVersion: version.version, source: { commit: /^[a-f0-9]{40}$/.test(pin) ? pin : null, dirty: dirty.exitCode !== 0 || dirty.stdout.length > 0, lockHash: createHash("sha256").update(readFileSync(join(source, "bun.lock"))).digest("hex") } });
}
