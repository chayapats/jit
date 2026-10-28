import { exportSummary } from "./evidence/contract";
import { inventory, localPorts, parseConfig, type InventoryPorts } from "./evidence/inventory";
import { readEvidence, readLocalConfig, writeEvidence } from "./evidence/records";

/** Command boundary permits only current-host inventory and sanitized export; output never includes raw errors or local paths. */
export async function runEvidenceCommand(args: string[], root: string, ports: InventoryPorts = localPorts()): Promise<{ exitCode: number; output: unknown }> {
  if (args.length !== 3 || !["inventory", "export"].includes(args[0]!) || args[1] !== (args[0] === "inventory" ? "--config" : "--id")) {
    return { exitCode: 2, output: { error: "invalid-evidence-command", nextAction: "use-inventory-config-or-export-id" } };
  }
  try {
    if (args[0] === "export") return { exitCode: 0, output: exportSummary(await readEvidence(root, args[2]!)) };
    const config = parseConfig(await readLocalConfig(root, args[2]!), root);
    const evidence = await inventory(config, ports);
    try { await writeEvidence(root, evidence); }
    catch { return { exitCode: 2, output: { ...exportSummary(evidence), outcome: "failed", stored: false, nextAction: "check-local-evidence-directory" } }; }
    return { exitCode: 0, output: { ...exportSummary(evidence), stored: true } };
  } catch { return { exitCode: 2, output: { error: "evidence-unavailable", nextAction: "check-local-configuration-and-inventory" } }; }
}

if (import.meta.main) {
  const result = await runEvidenceCommand(process.argv.slice(2), process.cwd());
  console.log(JSON.stringify(result.output)); process.exitCode = result.exitCode;
}
