import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { activeNativeDesktop } from "./installation";

/** Stable v1 loader: verify local code/runtime before importing the selected immutable release. */
export async function launchInstalledDesktop(root: string): Promise<void> {
  const selected = activeNativeDesktop(root);
  if (Bun.version !== selected.manifest.bunVersion) throw new Error("desktop_bun_version_mismatch");
  const module = await import(pathToFileURL(join(selected.directory, "main.js")).href) as { runInstalledDesktop?: (root: string) => Promise<void> };
  if (typeof module.runInstalledDesktop !== "function") throw new Error("desktop_entry_invalid");
  await module.runInstalledDesktop(root);
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error("desktop_arguments_invalid");
    await launchInstalledDesktop(process.argv[2]!);
  } catch (error) { console.error(error instanceof Error && /^desktop_[a-z_]+$/.test(error.message) ? error.message : "desktop_start_failed"); process.exitCode = 1; }
}
