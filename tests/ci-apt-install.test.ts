import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APT_OPTIONS, ATTEMPT_DEADLINE_MS, aptCommand, aptInstall, KILL_AFTER_S, RETRY_DELAYS_MS, timeoutCommand, worstCaseMs } from "../ops/ci/apt-install";

const workflow = readFileSync(join(import.meta.dir, "../.github/workflows/checks.yml"), "utf8");

/** Fake apt-get that fails the given verb with `code` a set number of times, then succeeds. */
function fakeApt(failVerb: "update" | "install", failures: number, code = 100) {
  const calls: string[] = [];
  let left = failures;
  const run = async (args: string[]) => {
    const verb = args.includes("update") ? "update" : "install";
    calls.push(verb);
    if (verb === failVerb && left > 0) { left--; return code; }
    return 0;
  };
  return { calls, run };
}

function recordSleeps() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => { slept.push(ms); } };
}

const quiet = () => {};

test("a failing apt-get update is retried with backoff and then installs", async () => {
  const apt = fakeApt("update", 2), clock = recordSleeps();
  await aptInstall(["ripgrep"], { run: apt.run, sleep: clock.sleep, log: quiet });
  expect(apt.calls).toEqual(["update", "update", "update", "install"]);
  expect(clock.slept).toEqual([10_000, 30_000]);
});

test("an install that fails after a warning-only update is retried from update", async () => {
  const apt = fakeApt("install", 1), clock = recordSleeps();
  await aptInstall(["ripgrep"], { run: apt.run, sleep: clock.sleep, log: quiet });
  expect(apt.calls).toEqual(["update", "install", "update", "install"]);
  expect(clock.slept).toEqual([10_000]);
});

test("an install killed by its deadline (exit 124 or 137) is retried from update", async () => {
  for (const code of [124, 137]) {
    const apt = fakeApt("install", 1, code), clock = recordSleeps(), lines: string[] = [];
    await aptInstall(["ripgrep"], { run: apt.run, sleep: clock.sleep, log: line => lines.push(line) });
    expect(apt.calls).toEqual(["update", "install", "update", "install"]);
    expect(lines).toEqual([`apt-install: attempt 1 failed with exit ${code}; retrying in 10s`]);
  }
});

test("a hanging update and install share one attempt deadline, and a spent budget skips install", async () => {
  let t = 0;
  const seen: Array<[string, number]> = [];
  // Attempt 1: update hangs past the deadline and is killed. Attempt 2: update takes 50 s, install
  // hangs and is killed when the attempt's 70 s run out. Attempt 3: update uses the whole budget, so
  // install never starts. Attempt 4 succeeds quickly.
  const plan = [
    { verb: "update", took: ATTEMPT_DEADLINE_MS + KILL_AFTER_S * 1000, code: 137 },
    { verb: "update", took: 50_000, code: 0 },
    { verb: "install", took: 20_000, code: 124 },
    { verb: "update", took: ATTEMPT_DEADLINE_MS, code: 0 },
    { verb: "update", took: 3_000, code: 0 },
    { verb: "install", took: 5_000, code: 0 },
  ];
  const run = async (args: string[], seconds: number) => {
    const step = plan.shift()!;
    expect(args.includes("update") ? "update" : "install").toBe(step.verb);
    seen.push([step.verb, seconds]);
    t += step.took;
    return step.code;
  };
  const lines: string[] = [];
  await aptInstall(["ripgrep"], { run, sleep: async ms => { t += ms; }, now: () => t, log: line => lines.push(line) });
  expect(seen).toEqual([["update", 70], ["update", 70], ["install", 20], ["update", 70], ["update", 70], ["install", 67]]);
  expect(lines.map(line => line.match(/exit (\d+)/)?.[1])).toEqual(["137", "124", "124"]);
  expect(plan).toEqual([]);
});

test("the step still fails loudly once every retry is used", async () => {
  const apt = fakeApt("update", 99), clock = recordSleeps();
  await expect(aptInstall(["ripgrep"], { run: apt.run, sleep: clock.sleep, log: quiet })).rejects.toThrow("apt_install_failed after 4 attempts (exit 100)");
  expect(apt.calls).toEqual(["update", "update", "update", "update"]);
  expect(clock.slept).toEqual([10_000, 30_000, 60_000]);
});

test("an empty package list is refused instead of passing silently", async () => {
  const apt = fakeApt("update", 0), clock = recordSleeps();
  await expect(aptInstall([], { run: apt.run, sleep: clock.sleep })).rejects.toThrow("apt_install_no_packages");
  expect(apt.calls).toEqual([]);
});

test("apt-get has no fetch retries of its own and installs exactly the requested packages", async () => {
  const seen: string[][] = [];
  await aptInstall(["ripgrep", "poppler-utils"], { run: async args => { seen.push(args); return 0; }, sleep: async () => {} });
  expect(seen).toEqual([
    [...APT_OPTIONS, "update"],
    [...APT_OPTIONS, "install", "-y", "--no-install-recommends", "ripgrep", "poppler-utils"],
  ]);
  expect(APT_OPTIONS).toContain("Acquire::Retries=0");
  expect(APT_OPTIONS).toContain("Acquire::https::Timeout=30");
});

test("timeout runs under sudo so its signals reach apt-get, not only sudo", () => {
  expect(aptCommand(["update"], 70)).toEqual(["sudo", "timeout", `--kill-after=${KILL_AFTER_S}`, "70", "apt-get", "update"]);
});

test("the timeout wrapper kills a child that ignores SIGTERM", async () => {
  const started = performance.now();
  const code = await Bun.spawn(timeoutCommand(1, ["sh", "-c", "trap '' TERM; sleep 30"]), { stdout: "ignore", stderr: "ignore" }).exited;
  expect(code).toBe(137);
  expect(performance.now() - started).toBeLessThan((1 + KILL_AFTER_S + 3) * 1000);
}, 15_000);

test("the worst-case apt budget plus 6 min of setup and tests fits the tests job timeout", () => {
  const job = workflow.slice(workflow.indexOf("\n  tests:\n"), workflow.indexOf("\n  deterministic:\n"));
  const minutes = Number(job.match(/\n    timeout-minutes: (\d+)\n/)?.[1]);
  expect(minutes).toBe(15);
  expect(worstCaseMs()).toBe(4 * (70_000 + 5_000 + 2_000) + 100_000);
  expect(worstCaseMs()).toBeLessThanOrEqual(7 * 60_000);
  expect(worstCaseMs() + 6 * 60_000).toBeLessThanOrEqual(minutes * 60_000);
});

test("the CI tests job installs its packages through the retrying helper", () => {
  expect(workflow).toContain("- run: bun ops/ci/apt-install.ts ripgrep python3-pil poppler-utils");
  expect(workflow).not.toContain("sudo apt-get");
  expect(RETRY_DELAYS_MS).toHaveLength(3);
});
