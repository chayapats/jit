import { safeAlias } from "./evidence/contract";
import { exportProbeSummary, cancelProbeAttempt, liveProbe, parseLiveOptions, parseProbeConfig, preflightProbe, readProbeAttempt, reconcileProbeAttempts, type ProbePorts } from "./evidence/probe";
import { readLocalConfig } from "./evidence/records";

/** Scriptable probe boundary; the default command ports fail closed with no network, accounts or secret reads. */
export function defaultProbePorts(): ProbePorts {
  return {
    now: Date.now,
    id: () => crypto.randomUUID(),
    // Skeleton: no credential boundary is wired, so readability reports
    // missing without touching any secret store or environment.
    readCredential: async () => "missing",
    // Skeleton: no supported Schway transport exists, so every live attempt
    // fails closed locally before any account request could be admitted.
    infer: async () => "failed",
  };
}

function usage(): { exitCode: 2; output: unknown } {
  return { exitCode: 2, output: { error: "invalid-probe-command",
    nextAction: "use-preflight-live-reconcile-cancel-or-export",
    hint: "probe preflight --config <path> | probe live --config <path> --route <alias> --model <id> --attempts <1-10> --deadline <1-60000> | probe reconcile | probe cancel --id <uuid> | probe export --id <uuid>" } };
}

/** Local probe config names one installation label plus the candidate routes preflight may report. */
function probeRoutes(raw: unknown): { route: string; model: string | null; configured: boolean }[] {
  const config = raw as { routes?: unknown };
  if (!Array.isArray(config?.routes) || config.routes.length > 8) throw new Error("invalid_configuration");
  return config.routes.map(item => {
    const candidate = item as Record<string, unknown>;
    if (!candidate || typeof candidate !== "object" || Object.keys(candidate).sort().join(",") !== "configured,model,route" ||
        typeof candidate.configured !== "boolean") throw new Error("invalid_configuration");
    const route = safeAlias(candidate.route), model = candidate.model === null ? null : safeAlias(candidate.model);
    if (typeof model !== "string" && model !== null) throw new Error("invalid_configuration");
    if (candidate.configured && model === null) throw new Error("invalid_configuration");
    return { route, model, configured: candidate.configured as boolean };
  });
}

/** Command boundary permits only preflight, explicit opt-in live, reconcile, cancel and sanitized export. */
export async function runProbeCommand(args: string[], root: string, ports: ProbePorts = defaultProbePorts()): Promise<{ exitCode: number; output: unknown }> {
  const [command, ...rest] = args;
  try {
    if (command === "reconcile") {
      if (rest.length !== 0) return usage();
      const updated = await reconcileProbeAttempts(root);
      return { exitCode: 0, output: { reconciled: updated.map(record => record.id), interrupted: updated.length } };
    }
    if (command === "cancel") {
      if (rest.length !== 2 || rest[0] !== "--id") return usage();
      const record = await cancelProbeAttempt(root, rest[1]!);
      return { exitCode: 0, output: { ...exportProbeSummary(record), stored: true } };
    }
    if (command === "export") {
      if (rest.length !== 2 || rest[0] !== "--id") return usage();
      return { exitCode: 0, output: exportProbeSummary(await readProbeAttempt(root, rest[1]!)) };
    }
    if (command === "preflight" || command === "live") {
      const flags = new Map<string, string>();
      for (let index = 0; index < rest.length; index += 2) {
        const key = rest[index], value = rest[index + 1];
        if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) return usage();
        flags.set(key, value);
      }
      const configPath = flags.get("--config");
      if (!configPath || ![...flags.keys()].every(key => ["--config", "--route", "--model", "--attempts", "--deadline"].includes(key))) return usage();
      const raw = await readLocalConfig(root, configPath);
      const { installationLabel } = parseProbeConfig(raw);
      if (command === "preflight") {
        if (flags.size !== 1) return usage();
        const configured = probeRoutes(raw).filter(item => item.configured);
        if (configured.length !== 1 || configured[0]!.model === null) {
          return { exitCode: 2, output: { error: "preflight-requires-one-configured-route", nextAction: "configure_exact_route" } };
        }
        const { record, self } = await preflightProbe(installationLabel, configured[0]!.route, configured[0]!.model, ports, root);
        return { exitCode: 0, output: { ...exportProbeSummary(record), stored: true, self } };
      }
      const route = flags.get("--route"), model = flags.get("--model"), attempts = flags.get("--attempts"), deadline = flags.get("--deadline");
      if (!route || !model || !attempts || !deadline || flags.size !== 5) return usage();
      const options = parseLiveOptions({ route, model, maxAttempts: Number(attempts), deadlineMs: Number(deadline) });
      if (!Number.isSafeInteger(options.maxAttempts) || !Number.isSafeInteger(options.deadlineMs) ||
          String(options.maxAttempts) !== attempts || String(options.deadlineMs) !== deadline) return usage();
      const { record, self } = await liveProbe(installationLabel, options, ports, root, AbortSignal.timeout(options.deadlineMs));
      return { exitCode: 0, output: { ...exportProbeSummary(record), stored: true, self } };
    }
    return usage();
  } catch {
    return { exitCode: 2, output: { error: "probe-unavailable", nextAction: "check-local-configuration-and-inventory" } };
  }
}

if (import.meta.main) {
  const result = await runProbeCommand(process.argv.slice(2), process.cwd());
  console.log(JSON.stringify(result.output));
  process.exitCode = result.exitCode;
}
