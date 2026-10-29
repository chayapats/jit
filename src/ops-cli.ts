import { readConfig } from "./config";
import { parseDrillConfig } from "./ops/config";
import { validateDrillRecord, type LoadDrillRecord } from "./ops/contracts";
import { gatherDiagnostics, inspectDiagnostics } from "./ops/diagnostics";
import { runLoadDrill } from "./ops/drill";
import { exportOpsSummary, readLocalDrillConfig, readOpsRecord, writeOpsRecord } from "./ops/records";
import { composeProfile, composeReleaseChecklist } from "./ops/report";
import { boxDoctor } from "./ops/box-doctor";
import { runBoxDrill, type BoxDrillHost, type BoxDrillInput } from "./ops/box-drill";
import { BoxManager } from "./exec/box-manager";
import { serviceBoxRuntime } from "./exec/box-service";
import { redactRegisteredSecrets } from "./security/secret-fingerprints";
import { readFileSync } from "node:fs";
import { statSync } from "node:fs";

/** Live ports for operator use. Tests inject scripted seams instead. */
export interface OpsPorts {
  drill?: typeof runLoadDrill;
  /** The box scenario's runtime and host samplers; the default is the service's rootless Podman on this host. */
  boxDrill?: Pick<BoxDrillInput, "runtime" | "host"> & { close?: () => Promise<void> };
}

function spawnText(cmd: string[]): string {
  try {
    const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
    return result.exitCode === 0 ? new TextDecoder().decode(result.stdout as Uint8Array) : "";
  } catch { return ""; }
}

const units: Record<string, number> = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3 };
function bytesOf(text: string): number | null {
  const match = /^([\d.]+)\s*([a-z]+)$/i.exec(text.trim());
  const unit = match ? units[match[2]!.toLowerCase()] : undefined;
  return match && unit ? Math.round(Number(match[1]) * unit) : null;
}

/** Live samplers for the box drill on a Linux host: `podman stats`, `/proc/meminfo`, `podman system df` and `du`. */
function liveBoxHost(executionDirectory: string): BoxDrillHost {
  return {
    async boxMemoryBytes(name) {
      try {
        const rows = JSON.parse(spawnText(["podman", "stats", "--no-stream", "--format", "json", name]) || "[]") as { mem_usage?: string }[];
        return bytesOf(rows[0]?.mem_usage?.split("/")[0] ?? "");
      } catch { return null; }
    },
    async memoryAvailableBytes() {
      const kb = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];
      return kb ? Number(kb) * 1024 : 0;
    },
    async diskBytes() {
      // A failed measurement is null, never a zero that reads as "no disk used".
      let images: number | null = null;
      try {
        for (const row of JSON.parse(spawnText(["podman", "system", "df", "--format", "json"])) as { Type?: string; RawSize?: number }[]) {
          if (row.Type === "Images" && typeof row.RawSize === "number") images = row.RawSize;
        }
      } catch { /* Unmeasured. */ }
      const du = /^(\d+)\s/.exec(spawnText(["du", "-sb", executionDirectory]))?.[1];
      return { images, workspaces: du === undefined ? null : Number(du) };
    },
    async hardware() {
      let model = "unknown";
      try { model = readFileSync("/proc/device-tree/model", "utf8").replace(/\0/g, "").trim(); } catch { /* Not a device-tree host. */ }
      const os = /^PRETTY_NAME="?([^"\n]+)"?/m.exec((() => { try { return readFileSync("/etc/os-release", "utf8"); } catch { return ""; } })())?.[1] ?? "unknown";
      const total = /MemTotal:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];
      return `${model} · ${os} · kernel ${spawnText(["uname", "-r"]).trim()} · ${spawnText(["uname", "-m"]).trim()} · ${total ? Math.round(Number(total) / 1024 / 1024 * 10) / 10 : "?"} GiB RAM · ${spawnText(["podman", "--version"]).trim()}`;
    },
  };
}

/**
 * Command boundary mirrors evidence-cli: only diagnose, drill, report and box-doctor.
 * Output never includes raw errors, paths or secrets; failures use fixed codes.
 */
export async function runOpsCommand(args: string[], root: string, ports: OpsPorts = {}): Promise<{ exitCode: number; output: unknown }> {
  const invalid = (nextAction: string) => ({ exitCode: 2, output: { error: "invalid-ops-command", nextAction } });
  try {
    if (args[0] === "box-doctor" && args.length === 1) {
      const config = readConfig();
      const report = boxDoctor({
        run: (cmd: string[]) => {
          try {
            const result = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
            return { exitCode: result.exitCode, stdout: new TextDecoder().decode(result.stdout as Uint8Array) };
          } catch {
            return { exitCode: 127, stdout: "" };
          }
        },
        stat: (path: string) => {
          try {
            const stats = statSync(path);
            return { uid: stats.uid, mode: stats.mode & 0o777, isDirectory: stats.isDirectory() };
          } catch { return null; }
        },
        uid: process.getuid?.() ?? 0,
      }, config.execution, config.searxngEnabled);
      return { exitCode: report.ok ? 0 : 1, output: report };
    }
    if (args[0] === "drill" && (args.length === 3 || args.length === 5) && args[1] === "--scenario") {
      if (args[2] !== "boxes") return invalid("use-drill-scenario-boxes");
      if (args.length === 5 && args[3] !== "--label") return invalid("use-drill-scenario-boxes-label");
      const config = readConfig();
      const service = ports.boxDrill ? { runtime: ports.boxDrill.runtime, close: ports.boxDrill.close ?? (async () => {}) } : serviceBoxRuntime(config);
      if (!service || !config.execution.directory) return { exitCode: 2, output: { error: "execution-not-configured", nextAction: "run-box-doctor" } };
      const { runtime } = service;
      try {
        const report = await runBoxDrill({
          config, runtime, host: ports.boxDrill?.host ?? liveBoxHost(config.execution.directory),
          // The same manager settings as createServiceBoxes, so the drill measures the boxes the service would run.
          boxes: (store, drillConfig, now) => new BoxManager(store, drillConfig, runtime,
            { now, profile: !!drillConfig.execution.images?.browser, backend: { redact: redactRegisteredSecrets } }),
          ...(args.length === 5 ? { installationLabel: args[4]! } : {}),
        });
        return { exitCode: report.decision === "fullAllowed may be set" ? 0 : 1, output: report };
      } finally { await service.close().catch(() => undefined); }
    }
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
        sampleLimitations: [...drill.fixtureHonesty] });
      const checklist = composeReleaseChecklist({ installationLabel: drill.installationLabel, drill,
        human: checklistRaw.human as never });
      const retention = { retentionDays: readConfig().ops.retentionDays };
      try { await writeOpsRecord(root, profile, retention); await writeOpsRecord(root, checklist, retention); }
      catch { return { exitCode: 2, output: { error: "ops-report-not-stored", nextAction: "check-local-ops-evidence-directory" } }; }
      // Tested revisions are identity-only (versions, commit SHA, content hash, contract IDs) and validated on read.
      return { exitCode: 0, output: { stored: true, revisions: profile.versions, drill: exportOpsSummary(drill),
        profile: exportOpsSummary(profile, drill), checklist: exportOpsSummary(checklist, drill) } };
    }
    return invalid("use-diagnose-drill-or-report");
  } catch { return { exitCode: 2, output: { error: "ops-unavailable", nextAction: "check-local-ops-configuration" } }; }
}

if (import.meta.main) {
  const result = await runOpsCommand(process.argv.slice(2), process.cwd());
  console.log(JSON.stringify(result.output));
  process.exitCode = result.exitCode;
}
