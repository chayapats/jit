import { readConfig } from "./config";
import { parseDrillConfig } from "./ops/config";
import { validateDrillRecord, type LoadDrillRecord } from "./ops/contracts";
import { gatherDiagnostics, inspectDiagnostics } from "./ops/diagnostics";
import { runLoadDrill } from "./ops/drill";
import { exportOpsSummary, readLocalDrillConfig, readOpsRecord, writeOpsRecord } from "./ops/records";
import { composeProfile, composeReleaseChecklist } from "./ops/report";

/** Live ports for operator use. Tests inject scripted seams instead. */
export interface OpsPorts {
  drill?: typeof runLoadDrill;
}

/**
 * Command boundary mirrors evidence-cli: only diagnose, drill and report.
 * Output never includes raw errors, paths or secrets; failures use fixed codes.
 */
export async function runOpsCommand(args: string[], root: string, ports: OpsPorts = {}): Promise<{ exitCode: number; output: unknown }> {
  const invalid = (nextAction: string) => ({ exitCode: 2, output: { error: "invalid-ops-command", nextAction } });
  try {
    if (args[0] === "diagnose" && args.length === 1) {
      const config = readConfig();
      return { exitCode: 0, output: inspectDiagnostics(gatherDiagnostics(root, config)) };
    }
    if (args[0] === "drill" && (args.length === 3 || args.length === 5) && args[1] === "--config") {
      if (args.length === 5 && args[3] !== "--label") return invalid("use-drill-config-label");
      const config = readConfig();
      const raw = await readLocalDrillConfig(root, args[2]!);
      const drillConfig = parseDrillConfig(raw, { diskWatermarkBytes: config.ops.diskWatermarkBytes, drillDeadlineMs: config.ops.drillDeadlineMs });
      const { record } = await (ports.drill ?? runLoadDrill)(drillConfig,
        args.length === 5 ? { installationLabel: args[4]! } : {});
      const retention = { retentionDays: config.ops.retentionDays };
      try { await writeOpsRecord(root, record, retention); }
      catch { return { exitCode: 2, output: { ...exportOpsSummary(record), stored: false, nextAction: "check-local-ops-evidence-directory" } }; }
      return { exitCode: 0, output: { ...exportOpsSummary(record), stored: true } };
    }
    if (args[0] === "report" && args.length === 5 && args[1] === "--id" && args[3] === "--checklist") {
      const stored = await readOpsRecord(root, args[2]!);
      if ((stored as { schema?: unknown }).schema !== "jit.ops.drill/v1") {
        return { exitCode: 2, output: { error: "ops-report-needs-drill", nextAction: "use-report-id-checklist" } };
      }
      validateDrillRecord(stored);
      const drill = stored as LoadDrillRecord;
      const checklistRaw = await readLocalDrillConfig(root, args[4]!) as Record<string, unknown>;
      // Deterministic rows are derived from the drill's executed legs; the file only links human gates.
      if (!checklistRaw || typeof checklistRaw !== "object" || Array.isArray(checklistRaw) ||
          Object.keys(checklistRaw).join(",") !== "human") {
        throw new Error("invalid_release_checklist");
      }
      // Exhausted limits are the drill's typed limit events; blocked/failed legs are not relabelled as limits.
      const profile = composeProfile({ installationLabel: drill.installationLabel, drill,
        sampleLimitations: [...drill.fixtureHonesty], nextAction: drill.nextAction });
      const checklist = composeReleaseChecklist({ installationLabel: drill.installationLabel, drill,
        human: checklistRaw.human as never });
      const retention = { retentionDays: readConfig().ops.retentionDays };
      try { await writeOpsRecord(root, profile, retention); await writeOpsRecord(root, checklist, retention); }
      catch { return { exitCode: 2, output: { error: "ops-report-not-stored", nextAction: "check-local-ops-evidence-directory" } }; }
      // Tested revisions are identity-only (versions, commit SHA, content hash, contract IDs) and validated on read.
      return { exitCode: 0, output: { stored: true, revisions: profile.versions, drill: exportOpsSummary(drill),
        profile: exportOpsSummary(profile), checklist: exportOpsSummary(checklist) } };
    }
    return invalid("use-diagnose-drill-or-report");
  } catch { return { exitCode: 2, output: { error: "ops-unavailable", nextAction: "check-local-ops-configuration" } }; }
}

if (import.meta.main) {
  const result = await runOpsCommand(process.argv.slice(2), process.cwd());
  console.log(JSON.stringify(result.output));
  process.exitCode = result.exitCode;
}
