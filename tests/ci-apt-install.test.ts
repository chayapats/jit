import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APT_OPTIONS, aptInstall, RETRY_DELAYS_MS } from "../ops/ci/apt-install";

/** Fake apt-get that fails the given verb a set number of times, then succeeds. */
function fakeApt(failVerb: "update" | "install", failures: number) {
  const calls: string[] = [];
  let left = failures;
  const run = async (args: string[]) => {
    const verb = args.includes("update") ? "update" : "install";
    calls.push(verb);
    if (verb === failVerb && left > 0) { left--; return 100; }
    return 0;
  };
  return { calls, run };
}

function recordSleeps() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => { slept.push(ms); } };
}

test("a failing apt-get update is retried with backoff and then installs", async () => {
  const apt = fakeApt("update", 2), clock = recordSleeps();
  await aptInstall(["ripgrep"], apt.run, clock.sleep, RETRY_DELAYS_MS, () => {});
  expect(apt.calls).toEqual(["update", "update", "update", "install"]);
  expect(clock.slept).toEqual([10_000, 30_000]);
});

test("an install that fails after a warning-only update is retried from update", async () => {
  const apt = fakeApt("install", 1), clock = recordSleeps();
  await aptInstall(["ripgrep"], apt.run, clock.sleep, RETRY_DELAYS_MS, () => {});
  expect(apt.calls).toEqual(["update", "install", "update", "install"]);
  expect(clock.slept).toEqual([10_000]);
});

test("the step still fails loudly once every retry is used", async () => {
  const apt = fakeApt("update", 99), clock = recordSleeps();
  await expect(aptInstall(["ripgrep"], apt.run, clock.sleep, RETRY_DELAYS_MS, () => {})).rejects.toThrow("apt_install_failed after 4 attempts (exit 100)");
  expect(apt.calls).toEqual(["update", "update", "update", "update"]);
  expect(clock.slept).toEqual([10_000, 30_000, 60_000]);
});

test("an empty package list is refused instead of passing silently", async () => {
  const apt = fakeApt("update", 0), clock = recordSleeps();
  await expect(aptInstall([], apt.run, clock.sleep)).rejects.toThrow("apt_install_no_packages");
  expect(apt.calls).toEqual([]);
});

test("apt-get gets its own fetch retries and installs exactly the requested packages", async () => {
  const seen: string[][] = [];
  await aptInstall(["ripgrep", "poppler-utils"], async args => { seen.push(args); return 0; }, async () => {});
  expect(seen).toEqual([
    [...APT_OPTIONS, "update"],
    [...APT_OPTIONS, "install", "-y", "--no-install-recommends", "ripgrep", "poppler-utils"],
  ]);
  expect(APT_OPTIONS).toContain("Acquire::Retries=5");
});

test("the CI tests job installs its packages through the retrying helper", () => {
  const workflow = readFileSync(join(import.meta.dir, "../.github/workflows/checks.yml"), "utf8");
  expect(workflow).toContain("- run: bun ops/ci/apt-install.ts ripgrep python3-pil poppler-utils");
  expect(workflow).not.toContain("sudo apt-get");
});
