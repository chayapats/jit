import { constants, lstatSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";

/** Explicit installed executable only. Return the canonical file; no shell expansion or argument fragments. */
export function desktopExecutable(path: string): string {
  if (!isAbsolute(path) || /[\u0000-\u001f]/.test(path)) throw new Error("desktop_executable_invalid");
  try {
    const canonical = realpathSync(path), info = statSync(canonical), direct = lstatSync(canonical);
    const adminGroup = process.platform === "darwin" && info.gid === 80;
    if (!direct.isFile() || !info.isFile() || (info.mode & 0o002) !== 0 || (info.mode & 0o020) !== 0 && !adminGroup || (info.mode & constants.S_IXUSR) === 0 || process.getuid && ![0, process.getuid()].includes(info.uid)) throw new Error();
    return canonical;
  } catch { throw new Error("desktop_executable_invalid"); }
}

/** macOS vendor installs may be admin-group writable; verify their complete signed Chrome bundle before launch. */
export function desktopBrowser(path: string): string {
  const executable = desktopExecutable(path);
  if (process.platform === "darwin") {
    const bundle = dirname(dirname(dirname(executable)));
    const checked = Bun.spawnSync(["/usr/bin/codesign", "--verify", "--deep", "--strict", '-R=anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "EQHXZ8M8AV"', bundle], { stdout: "ignore", stderr: "ignore" });
    if (checked.exitCode !== 0) throw new Error("desktop_browser_signature_invalid");
  }
  return executable;
}
