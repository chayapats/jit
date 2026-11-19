import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Exact downloaded iOS native framework files. Generated Xcode intermediates and installation paths are excluded. */
export function appleNativeInputs(repository: string) {
  const pods = resolve(repository, "clients/mobile/ios/Pods"), frameworks: { path: string; files: { path: string; sha256: string; bytes: number }[] }[] = [];
  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  function members(root: string, prefix = ""): { path: string; sha256: string; bytes: number }[] {
    const found: { path: string; sha256: string; bytes: number }[] = [];
    for (const name of readdirSync(join(root, prefix)).sort()) {
      const path = prefix ? prefix + "/" + name : name, full = join(root, path), info = lstatSync(full);
      if (info.isSymbolicLink()) throw Error("mobile_apple_input_link_refused");
      if (info.isDirectory()) found.push(...members(root, path));
      else if (info.isFile()) found.push({ path, sha256: digest(full), bytes: info.size });
      else throw Error("mobile_apple_input_invalid");
    }
    return found;
  }
  function walk(path: string): void {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name), info = lstatSync(full); if (info.isSymbolicLink() || !info.isDirectory()) continue;
      if (name.endsWith(".xcframework")) {
        const command = Bun.spawnSync(["plutil", "-convert", "json", "-o", "-", join(full, "Info.plist")], { stdout: "pipe", stderr: "pipe" }); if (command.exitCode) throw Error("mobile_apple_input_invalid");
        const plist = JSON.parse(command.stdout.toString()) as { AvailableLibraries: { SupportedPlatform: string; SupportedPlatformVariant?: string; LibraryIdentifier: string }[] };
        const selected = plist.AvailableLibraries.filter(slice => slice.SupportedPlatform === "ios" && (!slice.SupportedPlatformVariant || slice.SupportedPlatformVariant === "simulator"));
        if (!selected.length) throw Error("mobile_apple_input_invalid");
        const files = [{ path: "Info.plist", sha256: digest(join(full, "Info.plist")), bytes: lstatSync(join(full, "Info.plist")).size }];
        for (const slice of selected) {
          if (!/^[A-Za-z0-9_-]+$/.test(slice.LibraryIdentifier)) throw Error("mobile_apple_input_invalid");
          files.push(...members(join(full, slice.LibraryIdentifier)).map(member => ({ ...member, path: slice.LibraryIdentifier + "/" + member.path })));
        }
        frameworks.push({ path: relative(pods, full), files: files.sort((a, b) => a.path.localeCompare(b.path)) });
      } else walk(full);
    }
  }
  walk(pods);
  const specs = join(pods, "Local Podspecs"), archives = readdirSync(specs).sort().flatMap(name => {
    const value = JSON.parse(readFileSync(join(specs, name), "utf8"));
    return typeof value.source?.http === "string" ? [{ pod: String(value.name), version: String(value.version), url: value.source.http, podspecSha256: digest(join(specs, name)) }] : [];
  });
  if (!frameworks.length) throw Error("mobile_apple_input_invalid");
  return { contract: "s16-mobile-apple-inputs/v1", archives, frameworks: frameworks.sort((a, b) => a.path.localeCompare(b.path)) };
}
