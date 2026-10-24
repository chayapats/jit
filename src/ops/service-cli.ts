import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfig } from "../config";
import { gatherServiceStatus } from "./status";
import {
  defaultHostPaths, disableService, installService, installedConfigPath, planInstall, readServiceConfigFile, upgradePackage,
  type OperatorHost,
} from "./service-package";
import { SystemdSupervisor, spawnRunner, type CommandRunner } from "./supervisor";
import { assertNoSecretValues, parseServiceConfig } from "../../ops/package/service-config";

/** Injectable seams for the operator command boundary; production uses the real runner and terminal password. */
export interface ServiceCliDeps {
  cwd: string;
  run?: CommandRunner;
  readPassword?: () => Promise<string>;
  /** Liveness probe for upgrade (tests); production polls the supervisor and the private bind. */
  health?: () => Promise<boolean>;
  bunPath?: string;
}

const usage = "Use: service <plan|install|start|stop|restart|status|upgrade|disable|uninstall> [--config <path>] [--artifact <dir>] " +
  "[--bun <path>] [--unit-dir <dir>] [--journald-dir <dir>] [--config-dir <dir>] [--password-stdin]";
const valueFlags = ["--config", "--artifact", "--bun", "--unit-dir", "--journald-dir", "--config-dir"] as const;

function parseArgs(args: string[]): { command: string; flags: Map<string, string>; passwordStdin: boolean } | null {
  const [command, ...rest] = args;
  if (!command) return null;
  const flags = new Map<string, string>();
  let passwordStdin = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (flag === "--password-stdin") { passwordStdin = true; continue; }
    if (!(valueFlags as readonly string[]).includes(flag) || flags.has(flag) || i + 1 >= rest.length) return null;
    flags.set(flag, rest[++i]!);
  }
  return { command, flags, passwordStdin };
}

function sanitized(output: unknown): unknown {
  try { assertNoSecretValues(JSON.stringify(output)); return output; }
  catch { return { error: "service-output-redacted", nextAction: "inspect-local-configuration" }; }
}

/**
 * Bounded operator command boundary for ops.service_package/v1. Output is
 * JSON with fixed fields, rendered texts and safe next actions; secret values,
 * raw command output and stack traces never appear. Every external program
 * runs through the injected runner with finite timeouts.
 */
export async function runServiceCommand(args: string[], deps: ServiceCliDeps): Promise<{ exitCode: number; output: unknown }> {
  const parsed = parseArgs(args);
  if (!parsed) return { exitCode: 2, output: { error: "invalid-service-command", usage } };
  const { command, flags } = parsed;
  const run = deps.run ?? spawnRunner;
  const host: OperatorHost = {
    run,
    unitDir: resolve(deps.cwd, flags.get("--unit-dir") ?? defaultHostPaths.unitDir),
    journaldDir: resolve(deps.cwd, flags.get("--journald-dir") ?? defaultHostPaths.journaldDir),
    configDir: resolve(deps.cwd, flags.get("--config-dir") ?? defaultHostPaths.configDir),
    bunPath: resolve(deps.cwd, flags.get("--bun") ?? deps.bunPath ?? process.execPath),
  };
  const configPath = flags.get("--config") ? resolve(deps.cwd, flags.get("--config")!) : installedConfigPath(host);
  try {
    if (command === "plan" || command === "install") {
      const artifact = flags.get("--artifact");
      if (!artifact || !flags.get("--config")) return { exitCode: 2, output: { error: "invalid-service-command", usage } };
      // The operator's source configuration lives in ignored .local records; it is validated strictly before anything else.
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      const service = parseServiceConfig(raw);
      if (command === "plan") {
        const plan = await planInstall({ service, artifactDir: resolve(deps.cwd, artifact), host });
        return { exitCode: plan.ok ? 0 : 1, output: sanitized(plan) };
      }
      const installed = await installService({ service, artifactDir: resolve(deps.cwd, artifact), host });
      const { plan, ...rest } = installed;
      return { exitCode: installed.ok ? 0 : 1, output: sanitized({ ...rest, checks: plan.checks, files: plan.files.map(f => ({ path: f.path, mode: f.mode, sha256: f.sha256 })),
        nextAction: installed.ok ? "start-service" : plan.checks.find(c => !c.ok)?.nextAction ?? "inspect-supervisor" }) };
    }
    const service = readServiceConfigFile(configPath);
    const supervisor = new SystemdSupervisor(run);
    const status = async () => ({ supervisor: await supervisor.state(), service: gatherServiceStatus(readConfig({}), service) });
    if (command === "status") return { exitCode: 0, output: sanitized(await status()) };
    if (command === "start" || command === "stop" || command === "restart") {
      const done = command === "start" ? await supervisor.start()
        : command === "stop" ? await supervisor.stop()
        : (await supervisor.stop()) && await supervisor.start();
      return { exitCode: done ? 0 : 1, output: sanitized({ command, accepted: done, ...(await status()) }) };
    }
    if (command === "disable" || command === "uninstall") {
      const result = await disableService({ service, host, remove: command === "uninstall" });
      return { exitCode: result.disabled ? 0 : 1, output: sanitized({ command, ...result }) };
    }
    if (command === "upgrade") {
      const artifact = flags.get("--artifact");
      if (!artifact || !parsed.passwordStdin || !deps.readPassword) return { exitCode: 2, output: { error: "invalid-service-command", usage } };
      const ownerPassword = await deps.readPassword();
      const result = await upgradePackage({ service, artifactDir: resolve(deps.cwd, artifact), host, ownerPassword,
        ...(deps.health ? { health: deps.health } : {}) });
      return { exitCode: result.outcome === "upgraded" ? 0 : 1, output: sanitized(result) };
    }
    return { exitCode: 2, output: { error: "invalid-service-command", usage } };
  } catch (error) {
    const code = error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : "service-command-failed";
    return { exitCode: 2, output: { error: code, nextAction: "check-service-configuration-and-paths" } };
  }
}
