import { readFileSync } from "node:fs";
import { join } from "node:path";
import { activeNativeDesktop } from "../../src/s16/desktop/installation";
import { privateDesktopDirectory, writeDesktopFile } from "../../src/s16/desktop/storage";

const sh = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
// Desktop Entry applies the string escape layer before its Exec quoting/field-code layer.
const desktop = (value: string) => '"' + value.replace(/[\\"`$]/g, char => "\\" + char).replaceAll("%", "%%").replaceAll("\\", "\\\\") + '"';
const bytes = (value: string) => Buffer.from(value);

/** Creates local OS launch entries with fixed quoted arguments only; it never registers an execution host/service. */
export function installDesktopEntries(root: string, platform: "darwin" | "linux" = process.platform as "darwin" | "linux"): string {
  const selected = activeNativeDesktop(root), { installation } = selected;
  if (platform === "darwin") {
    const app = privateDesktopDirectory(join(root, "Jit.app")), contents = privateDesktopDirectory(join(app, "Contents")), macos = privateDesktopDirectory(join(contents, "MacOS")), resources = privateDesktopDirectory(join(contents, "Resources"));
    writeDesktopFile(join(macos, "Jit"), bytes(`#!/bin/sh\nexec ${sh(installation.bun)} ${sh(join(root, "bootstrap.js"))} ${sh(root)}\n`), 0o700);
    writeDesktopFile(join(resources, "Jit.icns"), readFileSync(join(selected.directory, "icon.icns")));
    writeDesktopFile(join(contents, "Info.plist"), bytes(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>Jit</string><key>CFBundleDisplayName</key><string>Jit</string><key>CFBundleIdentifier</key><string>dev.jit.desktop</string><key>CFBundleExecutable</key><string>Jit</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${selected.manifest.version}</string><key>CFBundleIconFile</key><string>Jit.icns</string></dict></plist>`));
    return app;
  }
  if (platform === "linux") {
    if (installation.bun.includes("=")) throw new Error("desktop_executable_path_unsupported");
    const path = join(root, "Jit.desktop");
    writeDesktopFile(path, bytes(`[Desktop Entry]\nType=Application\nName=Jit\nExec=${desktop(installation.bun)} ${desktop(join(root, "bootstrap.js"))} ${desktop(root)}\nIcon=${join(selected.directory, "icon.png").replaceAll("\\", "\\\\")}\nTerminal=false\nCategories=Utility;\n`), 0o700);
    return path;
  }
  throw new Error("desktop_platform_unsupported");
}
