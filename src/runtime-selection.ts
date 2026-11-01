import { readServiceConfigFile } from "../ops/package/service-config";

/** Resolved CLI dispatch; args contain only the selected runtime's supported spelling. */
export interface RuntimeSelection { runtime: "s14" | "legacy" | "service"; args: string[] }

/** Safe bootstrap refusal; selection never opens application databases, locks, hosts or credentials. */
export class RuntimeSelectionError extends Error {}

function refuse(code: string): never { throw new RuntimeSelectionError(code); }
const legacyCommands = ["serve", "setup", "reset-owner", "probe", "diagnose", "preflight", "status", "upgrade", "ask", "pending"];

/**
 * Selects S14 for unconfigured serve/setup/ops, retaining --s14 and explicit --legacy.
 * A validated named legacy service config preserves prior argv; omitted persisted runtime stays legacy.
 * All selector/command/config conflicts refuse before application imports or writable state.
 * Arguments after the first -- remain literal data for the selected command.
 */
export function selectRuntime(args: string[], env: NodeJS.ProcessEnv = process.env): RuntimeSelection {
  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  const literal = separator < 0 ? [] : args.slice(separator);
  const selectors = options.filter(arg => arg === "--s14" || arg === "--legacy");
  if (selectors.length > 1) refuse("conflicting_or_duplicate_runtime_selector");
  const [command, ...optionRest] = options.filter(arg => arg !== "--s14" && arg !== "--legacy");
  const rest = [...optionRest, ...literal];
  if (!command || args[0] !== command) refuse("invalid_runtime_command");
  const explicit = selectors[0] === "--s14" ? "s14" : selectors[0] === "--legacy" ? "legacy" : undefined;
  if (command === "service") {
    // Operator selection remains explicit/config-selected, including its historical /etc/jit default.
    if (explicit) refuse("service_runtime_requires_config");
    return { runtime: "service", args: [command, ...rest] };
  }
  if (![...legacyCommands, "ops", "owner-link"].includes(command)) refuse("invalid_runtime_command");
  const configs = optionRest.filter(arg => arg === "--service-config");
  if (configs.length > 1) refuse("invalid_service_config_arguments");
  let configured: "legacy" | undefined;
  if (configs.length) {
    const index = optionRest.indexOf("--service-config"), path = optionRest[index + 1];
    if (!path || path.startsWith("--") || !["serve", "preflight", "status", "upgrade", "ask", "pending"].includes(command)) refuse("invalid_service_config_arguments");
    const config = readServiceConfigFile(path!);
    if (config.runtime === "s14") refuse("s14_service_requires_rendered_environment");
    configured = "legacy";
    if (explicit === "s14") refuse("runtime_service_config_mismatch");
  }
  const runtime = explicit ?? configured ?? "s14";
  if (runtime === "legacy") {
    if (!legacyCommands.includes(command)) refuse("invalid_legacy_command");
    if (command === "serve" && !(rest.length === 0 || rest.length === 2 && rest[0] === "--service-config")) refuse("invalid_legacy_arguments");
    if (["setup", "reset-owner"].includes(command) && !(rest.length === 0 || rest.length === 1 && rest[0] === "--password-stdin")) refuse("invalid_legacy_arguments");
    return { runtime, args: [command, ...rest] };
  }
  if (!["serve", "setup", "ops", "owner-link"].includes(command)) refuse("legacy_command_requires_explicit_selection");
  if (!explicit && env.JIT_DATABASE !== undefined) refuse("legacy_database_requires_explicit_runtime");
  if (command === "owner-link") {
    // This private installer protocol is deliberately not broadened by the new default.
    if (args.length !== 4 || args[1] !== "--s14" || args[2] !== "--output-fd" || args[3] !== "3") refuse("owner_link_private_pipe_required");
    return { runtime, args: [...args] };
  }
  const flags = command === "serve" ? ["--refusal-page", "--no-refusal-page"] : command === "setup" ? ["--password-stdin"] : ["--password-stdin", "--command"];
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    if (!flags.includes(flag) || seen.has(flag)) refuse("invalid_s14_arguments");
    seen.add(flag);
    if (flag === "--command" && (!rest[++i] || rest[i]!.startsWith("--"))) refuse("invalid_s14_arguments");
  }
  if (seen.has("--refusal-page") && seen.has("--no-refusal-page")) refuse("invalid_s14_arguments");
  return { runtime, args: [command, "--s14", ...rest] };
}
