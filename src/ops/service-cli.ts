import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertRootPath, assertRootTree, UnsafeRootPath, type RootPathPolicy } from "../../ops/package/trusted-paths";
import { assertServicePaths, assertServiceRuntime, rootPathFailure } from "./service-trust";
import { readConfig } from "../config";
import type { LedgerGate } from "./lifecycle";
import { gatherServiceStatus } from "./status";
import {
  assertReleaseDestination, defaultHostPaths, disableService, installService, installedConfigPath, planInstall, readServiceConfigFile, upgradePackage,
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
  /** Ledger gate for status/upgrade (tests inject fixtures; production uses the default). */
  ledgerGate?: LedgerGate;
  /** Ownership operation for install (tests inject a recorder). */
  chown?: OperatorHost["chown"];
  /** Effective uid of the caller (tests); production reads `process.geteuid()` (getuid fallback). */
  uid?: number;
  /** Fake-root trust policy; production checks real root ownership up to `/`. Non-root calls skip this gate. */
  rootPathPolicy?: RootPathPolicy;
  /** Running release root (fake-root tests); production checks this module's release. */
  runtimeDir?: string;
}

/**
 * Resolves the configured identity's uid through `getent passwd` for a
 * root-run status. Unresolvable or root identities return root's own uid,
 * so the state check stays blocked instead of trusting an unknown owner.
 */
async function serviceIdentityUid(run: CommandRunner, user: string): Promise<number> {
  const result = await run(["getent", "passwd", user], { timeoutMs: 10_000 });
  const fields = result.exitCode === 0 ? result.stdout.trim().split("\n")[0]?.split(":") ?? [] : [];
  const uid = fields[0] === user && /^\d{1,10}$/.test(fields[2] ?? "") ? Number(fields[2]) : 0;
  return uid > 0 ? uid : 0;
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
  const privileged = (deps.uid ?? process.geteuid?.() ?? process.getuid?.()) === 0;
  const policy = privileged ? deps.rootPathPolicy ?? {} : undefined;
  const runner = deps.run ?? spawnRunner;
  const run: CommandRunner = policy ? (argv, options) => runner(argv, { ...options,
    cwd: options.cwd ?? policy.root ?? "/", env: { ...options.env, PATH: "/usr/sbin:/usr/bin:/sbin:/bin" },
  }) : runner;
  const host: OperatorHost = {
    run,
    ...(policy ? { rootPathPolicy: policy } : {}),
    unitDir: resolve(deps.cwd, flags.get("--unit-dir") ?? defaultHostPaths.unitDir),
    journaldDir: resolve(deps.cwd, flags.get("--journald-dir") ?? defaultHostPaths.journaldDir),
    configDir: resolve(deps.cwd, flags.get("--config-dir") ?? defaultHostPaths.configDir),
    bunPath: resolve(deps.cwd, flags.get("--bun") ?? deps.bunPath ?? process.execPath),
    ...(deps.ledgerGate ? { ledgerGate: deps.ledgerGate } : {}),
    ...(deps.chown ? { chown: deps.chown } : {}),
  };
  const configPath = flags.get("--config") ? resolve(deps.cwd, flags.get("--config")!) : installedConfigPath(host);
  try {
    const artifactDir = flags.has("--artifact") ? resolve(deps.cwd, flags.get("--artifact")!) : null;
    if (policy) {
      assertServiceRuntime(deps.runtimeDir ?? resolve(import.meta.dir, "../.."), host.bunPath, policy);
      assertRootPath(configPath, policy);
      if (artifactDir) assertRootTree(artifactDir, policy);
    }
    if (command === "plan" || command === "install") {
      const artifact = flags.get("--artifact");
      if (!artifact || !flags.get("--config")) return { exitCode: 2, output: { error: "invalid-service-command", usage } };
      // The operator's source configuration lives in ignored .local records; it is validated strictly before anything else.
      const service = policy ? readServiceConfigFile(configPath) : parseServiceConfig(JSON.parse(readFileSync(configPath, "utf8")));
      if (policy) assertServicePaths(service, host, policy);
      if (command === "plan") {
        const plan = await planInstall({ service, artifactDir: artifactDir!, host });
        return { exitCode: plan.ok ? 0 : 1, output: sanitized(plan) };
      }
      const installed = await installService({ service, artifactDir: artifactDir!, host });
      const { plan, ...rest } = installed;
      return { exitCode: installed.ok ? 0 : 1, output: sanitized({ ...rest, checks: plan.checks, files: plan.files.map(f => ({ path: f.path, mode: f.mode, sha256: f.sha256 })),
        nextAction: installed.ok ? "start-service" : plan.checks.find(c => !c.ok)?.nextAction ?? "inspect-supervisor" }) };
    }
    const service = readServiceConfigFile(configPath);
    if (policy) assertServicePaths(service, host, policy);
    const supervisor = new SystemdSupervisor(run);
    // As root, directory ownership is judged against the configured identity, never root itself.
    const stateOwnerUid = privileged ? await serviceIdentityUid(run, service.serviceUser) : undefined;
    const status = async () => ({ supervisor: await supervisor.state(), service: gatherServiceStatus(readConfig({}), service, {
      ...(deps.ledgerGate ? { ledgerGate: deps.ledgerGate } : {}), ...(stateOwnerUid !== undefined ? { stateOwnerUid } : {}) }) });
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
      assertReleaseDestination(service, artifactDir!, policy);
      const ownerPassword = await deps.readPassword();
      const result = await upgradePackage({ service, artifactDir: artifactDir!, host, ownerPassword,
        ...(deps.health ? { health: deps.health } : {}) });
      return { exitCode: result.outcome === "upgraded" ? 0 : 1, output: sanitized(result) };
    }
    return { exitCode: 2, output: { error: "invalid-service-command", usage } };
  } catch (error) {
    if (error instanceof UnsafeRootPath) return { exitCode: 2, output: rootPathFailure(error) };
    if (error instanceof Error && error.message === "release_copy_invalid") return { exitCode: 2, output: { error: "release_copy_invalid", nextAction: "rebuild-artifact" } };
    const code = error instanceof Error && /^[a-z_]{1,64}$/.test(error.message) ? error.message : "service-command-failed";
    return { exitCode: 2, output: { error: code, nextAction: "check-service-configuration-and-paths" } };
  }
}
