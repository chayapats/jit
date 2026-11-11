/**
 * Installs the CI apt packages with bounded retries. A short runner DNS or mirror outage
 * ("Temporary failure resolving archive.ubuntu.com", #456) then does not fail a shard before
 * its tests start. Each attempt has a wall-clock deadline, so a resolver-bound apt walk cannot
 * use up the job timeout. Once the retries run out the step still fails loudly; it never skips packages.
 */

/** Runs one apt-get invocation, killed after `seconds`, and returns its exit code (124/137 on timeout). */
export type AptRun = (args: string[], seconds: number) => Promise<number>;

/** Waits between attempts: 10 s, 30 s, then 60 s, so four attempts in total. */
export const RETRY_DELAYS_MS = [10_000, 30_000, 60_000];

/** Wall-clock budget for one attempt (`update` plus `install`). A healthy runner needs about 10 s. */
export const ATTEMPT_DEADLINE_MS = 70_000;

/** Seconds `timeout` waits after SIGTERM before it sends SIGKILL to apt-get. */
export const KILL_AFTER_S = 5;

/** Exit code a timed-out attempt reports when its budget is already spent before `install` starts. */
export const TIMED_OUT = 124;

/**
 * No apt-level fetch retries (the outer loop is the retry) and a fetch timeout for both schemes.
 * The timeout only helps a stalled connection; the per-attempt deadline is the real cap.
 */
export const APT_OPTIONS = ["-q", "-o", "Acquire::Retries=0", "-o", "Acquire::http::Timeout=30", "-o", "Acquire::https::Timeout=30"];

/** Wraps a command in GNU `timeout`: SIGTERM after `seconds`, SIGKILL `KILL_AFTER_S` later. */
export function timeoutCommand(seconds: number, argv: string[]): string[] {
  return ["timeout", `--kill-after=${KILL_AFTER_S}`, String(seconds), ...argv];
}

/** `timeout` runs under sudo, so its signals reach apt-get itself and not only sudo. */
export function aptCommand(args: string[], seconds: number): string[] {
  return ["sudo", ...timeoutCommand(seconds, ["apt-get", ...args])];
}

/**
 * Upper bound on how long `aptInstall` can run with the given delays: every attempt hits its
 * deadline, pays the SIGKILL grace and up to 2 s of whole-second rounding, then every wait follows.
 */
export function worstCaseMs(delays = RETRY_DELAYS_MS, deadlineMs = ATTEMPT_DEADLINE_MS): number {
  const attempts = delays.length + 1;
  return attempts * (deadlineMs + KILL_AFTER_S * 1000 + 2000) + delays.reduce((sum, ms) => sum + ms, 0);
}

export interface AptInstallOptions {
  run: AptRun;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  delays?: number[];
  deadlineMs?: number;
  log?: (line: string) => void;
}

/**
 * Installs every requested package, running `update` before each `install` attempt. Both share one
 * attempt deadline: `install` only gets what `update` left. Defaults to four attempts with 10 s,
 * 30 s and 60 s waits after failures; a failed or timed-out install restarts from `update` on the
 * next attempt. Rejects with `apt_install_no_packages` for an empty list, with
 * `apt_install_failed after N attempts (exit C)` once every attempt fails, or with whatever `run`
 * or `sleep` rejects with.
 */
export async function aptInstall(packages: string[], options: AptInstallOptions): Promise<void> {
  const { run, sleep, now = Date.now, delays = RETRY_DELAYS_MS, deadlineMs = ATTEMPT_DEADLINE_MS, log = line => console.error(line) } = options;
  if (packages.length === 0) throw new Error("apt_install_no_packages");
  for (let attempt = 1; ; attempt++) {
    const deadline = now() + deadlineMs;
    const left = () => Math.ceil((deadline - now()) / 1000);
    // `update` can exit 0 when it only warns about unreachable mirrors, so install failures retry too.
    const update = await run([...APT_OPTIONS, "update"], left());
    let code = update;
    if (update === 0) code = left() > 0 ? await run([...APT_OPTIONS, "install", "-y", "--no-install-recommends", ...packages], left()) : TIMED_OUT;
    if (code === 0) return;
    const delay = delays[attempt - 1];
    if (delay === undefined) throw new Error(`apt_install_failed after ${attempt} attempts (exit ${code})`);
    log(`apt-install: attempt ${attempt} failed with exit ${code}; retrying in ${delay / 1000}s`);
    await sleep(delay);
  }
}

if (import.meta.main) {
  const run: AptRun = (args, seconds) => Bun.spawn(aptCommand(args, seconds), { stdout: "inherit", stderr: "inherit" }).exited;
  await aptInstall(process.argv.slice(2), { run, sleep: ms => Bun.sleep(ms) }).catch(error => {
    console.error(`apt-install: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
