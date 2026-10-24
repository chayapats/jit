import { serviceUnitName } from "../../ops/package/service-config";

/**
 * Process boundary for operator commands (ops.service_package/v1). Every
 * external program the package drives — `systemctl`, `id`, `bun --version`,
 * `bun install` and the new build's `upgrade` — goes through one injectable
 * runner, so deterministic tests substitute a fake supervisor and never call
 * systemctl, the package registry or a real service.
 */
export interface CommandResult {
  exitCode: number;
  /** Bounded stdout. Callers parse fixed fields only and never echo it raw. */
  stdout: string;
  timedOut: boolean;
}

export interface CommandOptions {
  /** Finite wall-clock budget; the child is killed when it expires. */
  timeoutMs: number;
  cwd?: string;
  env?: Record<string, string>;
  /** Written to the child's stdin and never logged (owner password for `upgrade`). */
  stdin?: string;
}

export type CommandRunner = (argv: string[], options: CommandOptions) => Promise<CommandResult>;

const outputLimit = 64 * 1024;

/** Real runner: Bun.spawn with a hard timeout, bounded stdout and discarded stderr. */
export const spawnRunner: CommandRunner = async (argv, options) => {
  if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== "string" || a.includes("\0"))) throw new Error("invalid_command");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 1_800_000) throw new Error("invalid_command");
  const child = Bun.spawn(argv, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env ?? { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    stdin: options.stdin !== undefined ? new TextEncoder().encode(options.stdin) : "ignore",
    stdout: "pipe", stderr: "ignore",
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs);
  try {
    const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { exitCode: timedOut ? 124 : exitCode, stdout: stdout.slice(0, outputLimit), timedOut };
  } finally { clearTimeout(timer); }
};

/** Observed supervisor state. `unknown` is reported honestly when systemctl gives no answer. */
export interface SupervisorState {
  active: "active" | "inactive" | "failed" | "activating" | "deactivating" | "unknown";
  enabled: boolean | null;
  restarts: number | null;
  mainPid: number | null;
}

/**
 * Drives the one managed unit through systemctl. Commands are fixed argv
 * vectors (no shell); timeouts are finite; nothing here downloads packages
 * or requests accounts.
 */
export class SystemdSupervisor {
  readonly unit = serviceUnitName;
  constructor(readonly run: CommandRunner, readonly options: { timeoutMs?: number; systemctl?: string } = {}) {}

  #call(args: string[], timeoutMs = this.options.timeoutMs ?? 120_000): Promise<CommandResult> {
    return this.run([this.options.systemctl ?? "systemctl", ...args], { timeoutMs });
  }

  async daemonReload(): Promise<boolean> { return (await this.#call(["daemon-reload"])).exitCode === 0; }
  async enable(): Promise<boolean> { return (await this.#call(["enable", this.unit])).exitCode === 0; }
  /** Disables boot start and stops the unit. Managed data and secret references are untouched. */
  async disable(): Promise<boolean> { return (await this.#call(["disable", "--now", this.unit])).exitCode === 0; }
  async start(): Promise<boolean> { return (await this.#call(["start", this.unit])).exitCode === 0; }
  /** Requests a stop; systemd sends SIGTERM (cooperative drain) and kills only after TimeoutStopSec. */
  async stop(): Promise<boolean> { return (await this.#call(["stop", this.unit])).exitCode === 0; }

  async state(): Promise<SupervisorState> {
    const result = await this.#call(["show", this.unit, "--property=ActiveState,UnitFileState,NRestarts,MainPID"], 30_000);
    if (result.exitCode !== 0) return { active: "unknown", enabled: null, restarts: null, mainPid: null };
    const fields = new Map(result.stdout.split("\n").map(line => line.split("=", 2) as [string, string]).filter(p => p.length === 2));
    const active = fields.get("ActiveState");
    const known = ["active", "inactive", "failed", "activating", "deactivating"] as const;
    const restarts = Number(fields.get("NRestarts")), pid = Number(fields.get("MainPID"));
    const unitFile = fields.get("UnitFileState");
    return {
      active: known.includes(active as typeof known[number]) ? active as SupervisorState["active"] : "unknown",
      enabled: unitFile === "enabled" ? true : unitFile === "disabled" ? false : null,
      restarts: Number.isSafeInteger(restarts) && restarts >= 0 ? restarts : null,
      mainPid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
    };
  }
}
