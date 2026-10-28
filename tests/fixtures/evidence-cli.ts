import { runEvidenceCommand } from "../../src/evidence-cli";
import type { InventoryPorts } from "../../src/evidence/inventory";

const [root, mode] = process.argv.slice(2);
const ports: InventoryPorts = {
  now: () => 1800000000000, id: () => "ee781630-4d14-4d8b-a0eb-21b276ed5632",
  host: () => ({ os: "linux", architecture: mode === "x64" ? "x64" : "arm64", kernel: "6.8.0-1018-raspi", bun: "1.4.2", uid: 12345, effectiveUid: 12345 }),
  bunOnPath: async () => mode === "missing" ? { found: false, version: null } : mode === "malformed" ? { found: true, version: "Authorization: Bearer TOKEN_SENTINEL 192.0.2.44 PATH=private" } : { found: true, version: "1.4.2" },
  directories: async () => ({ workingDirectory: "ready", persistentState: mode === "unwritable" ? "unavailable" : "writable" }),
  dependencies: async () => [{ name: "typescript", declared: "7.0.2", installed: "7.0.2", compatibility: "unverified" }],
};
const result = await runEvidenceCommand(["inventory", "--config", ".local/config.json"], root!, ports);
console.log(JSON.stringify(result.output)); process.exitCode = result.exitCode;
