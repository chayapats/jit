import { resolve } from "node:path";
import { buildNativeDesktop } from "./build";
import { installDesktopEntries } from "./entries";
import { activeNativeDesktop, installNativeDesktop, rollbackNativeDesktop, verifyNativeDesktop } from "../../src/s16/desktop/installation";

/** Local operator packaging CLI. No arbitrary command/browser flags, credentials, remote feed or service mutation. */
export async function desktopPackageCommand(args: string[]): Promise<unknown> {
  const [command, ...rest] = args, values = new Map<string, string>();
  for (let at = 0; at < rest.length; at += 2) { const key = rest[at], value = rest[at + 1]; if (!key?.startsWith("--") || !value || value.startsWith("--") || values.has(key)) throw new Error("desktop_arguments_invalid"); values.set(key, value); }
  const get = (key: string) => { const value = values.get(key); if (!value) throw new Error("desktop_arguments_invalid"); return value; };
  const allowed: Record<string, string[]> = { build: ["--source", "--output"], verify: ["--artifact"], install: ["--artifact", "--root", "--bun", "--browser", "--locale", "--service"], update: ["--artifact", "--root"], rollback: ["--root"], status: ["--root"] };
  if (!command || !allowed[command] || [...values.keys()].some(key => !allowed[command]!.includes(key))) throw new Error("desktop_arguments_invalid");
  if (command === "build") return buildNativeDesktop({ source: resolve(get("--source")), output: resolve(get("--output")) });
  if (command === "verify") return verifyNativeDesktop(resolve(get("--artifact")));
  if (!["darwin", "linux"].includes(process.platform)) throw new Error("desktop_platform_unsupported");
  const root = resolve(get("--root"));
  if (command === "install" || command === "update") {
    const locale = values.get("--locale") ?? "th"; if (!["en", "th"].includes(locale)) throw new Error("desktop_arguments_invalid");
    const current = installNativeDesktop({ artifact: resolve(get("--artifact")), root, ...(command === "install" ? { runtime: { bun: get("--bun"), browser: get("--browser"), locale: locale as "en" | "th", ...(values.has("--service") ? { service: get("--service") } : {}) } } : {}) });
    installDesktopEntries(root); return { contract: current.contract, active: current.active, previous: current.previous };
  }
  if (command === "rollback") { const current = rollbackNativeDesktop(root); installDesktopEntries(root); return current; }
  const selected = activeNativeDesktop(root); return { contract: selected.manifest.contract, id: selected.manifest.id, version: selected.manifest.version, source: selected.manifest.source };
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await desktopPackageCommand(process.argv.slice(2)))); }
  catch (error) { console.error(error instanceof Error && /^desktop_[a-z_]+$/.test(error.message) ? error.message : "desktop_package_failed"); process.exitCode = 1; }
}
