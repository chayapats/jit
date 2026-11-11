/**
 * Installs the CI apt packages with bounded retries. A short runner DNS or mirror outage
 * ("Temporary failure resolving archive.ubuntu.com", #456) then does not fail a shard before
 * its tests start. Once the retries run out the step still fails loudly; it never skips packages.
 */

/** Runs one apt-get invocation and returns its exit code. */
export type AptRun = (args: string[]) => Promise<number>;

/** Waits between attempts: 10 s, 30 s, then 60 s, so four attempts in total. */
export const RETRY_DELAYS_MS = [10_000, 30_000, 60_000];

/** apt's own per-download retries and a timeout, so one slow mirror cannot use up the job timeout. */
export const APT_OPTIONS = ["-q", "-o", "Acquire::Retries=5", "-o", "Acquire::http::Timeout=30"];

/**
 * Installs every requested package, running `update` before each `install` attempt.
 * Defaults to four attempts with 10 s, 30 s and 60 s waits after failures; a failed install
 * restarts from `update` on the next attempt. Rejects with `apt_install_no_packages` for an empty
 * list, with `apt_install_failed after N attempts (exit C)` once every attempt fails, or with
 * whatever `run` or `sleep` rejects with.
 */
export async function aptInstall(packages: string[], run: AptRun, sleep: (ms: number) => Promise<void>, delays = RETRY_DELAYS_MS, log: (line: string) => void = line => console.error(line)): Promise<void> {
  if (packages.length === 0) throw new Error("apt_install_no_packages");
  for (let attempt = 1; ; attempt++) {
    // `update` can exit 0 when it only warns about unreachable mirrors, so install failures retry too.
    const update = await run([...APT_OPTIONS, "update"]);
    const code = update === 0 ? await run([...APT_OPTIONS, "install", "-y", "--no-install-recommends", ...packages]) : update;
    if (code === 0) return;
    const delay = delays[attempt - 1];
    if (delay === undefined) throw new Error(`apt_install_failed after ${attempt} attempts (exit ${code})`);
    log(`apt-install: attempt ${attempt} failed with exit ${code}; retrying in ${delay / 1000}s`);
    await sleep(delay);
  }
}

if (import.meta.main) {
  const run: AptRun = args => Bun.spawn(["sudo", "apt-get", ...args], { stdout: "inherit", stderr: "inherit" }).exited;
  await aptInstall(process.argv.slice(2), run, ms => Bun.sleep(ms)).catch(error => {
    console.error(`apt-install: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
