import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { installerDefaults, installerOwnerLink, installerSchemaVersion, prepareInstallerHome, runInstaller, InstallerFailure, type HostFacts } from "./installer";
import { parseServiceConfig } from "../service-config";

const args = process.argv.slice(2), command = args.shift();
try {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || flags.has(args[i]!) || !args[i + 1]) throw new Error("invalid-installer-arguments");
    flags.set(args[i]!, args[i + 1]!);
  }
  if (command === "prepare-home" || command === "schema-version") {
    if (flags.size !== 1 || flags.get("--home") !== "/var/lib/jit") throw new Error("invalid-installer-arguments");
    if (command === "prepare-home") prepareInstallerHome(flags.get("--home")!);
    else console.log(installerSchemaVersion(flags.get("--home")!) ?? "none");
  } else if (command === "owner-link" || command === "initialize-state") {
    if (flags.size !== 1 || !flags.has("--config")) throw new Error("invalid-installer-arguments");
    const link = installerOwnerLink(parseServiceConfig(JSON.parse(readFileSync(flags.get("--config")!, "utf8"))), command === "owner-link");
    if (link) process.stdout.write(link + "\n"); // Captured by installer; never sent to journald or another log.
  } else if (command === "apply" || command === "plan") {
    const dry = flags.get("--dry-run") === "true", root = flags.get("--root") ?? "/";
    const facts = dry ? JSON.parse(readFileSync(resolve(root, "host.json"), "utf8")) as HostFacts : {
      family: flags.get("--family")!, arch: flags.get("--arch")!, ramMb: Number(flags.get("--ram-mb")), cpus: Number(flags.get("--cpus")),
      diskBytes: Number(flags.get("--disk-total")), freeBytes: Number(flags.get("--disk-free")),
    };
    const defaults = installerDefaults(facts);
    if (command === "plan") console.log(JSON.stringify({ contract: "ops.installer/v1", facts, defaults }));
    else await runInstaller({ root, dryRun: dry, facts, source: flags.get("--source")!, bunPath: process.execPath, uninstall: flags.get("--uninstall") === "true", out: line => console.log(line) });
  } else throw new Error("invalid-installer-command");
} catch (error) {
  console.error(error instanceof InstallerFailure ? error.message : "Failed at installer-input. Next: verify the release, arguments and fake-root host.json, then re-run.");
  process.exitCode = 1;
}
