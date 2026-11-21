import { Glob } from "bun";

/** This process-crash suite alone exceeds one ordinary shard's budget on CI. */
export const RECOVERY_SUITE = "tests/s16-ops-candidate-quarantine.test.ts";
const crashPrefix = "actual complete forward repair SIGKILL at ";

/** Two complementary name filters run every recovery case once, including newly added names. */
export function recoveryPattern(index: number): string {
  if (index === 0) return `^${crashPrefix}`;
  if (index === 1) return `^(?!${crashPrefix})`;
  throw new Error("invalid_recovery_partition");
}

/** Lists all test files in sorted order, including the separately partitioned recovery suite. */
export function testFiles(root = "."): string[] {
  return [...new Glob("tests/**/*.test.ts").scanSync({ cwd: root })].sort();
}

/** Selects ordinary files round-robin; the separately partitioned recovery job owns RECOVERY_SUITE. */
export function shardFiles(files: string[], index: number, total: number): string[] {
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(index) || index < 0 || index >= total) throw new Error("invalid_shard");
  return files.filter(file => file !== RECOVERY_SUITE).filter((_, position) => position % total === index);
}

if (import.meta.main) {
  if (process.argv[2] === "recovery") {
    const pattern = recoveryPattern(Number(process.argv[3]));
    const child = Bun.spawn([process.execPath, "test", "--timeout", "30000", "--test-name-pattern", pattern, "./" + RECOVERY_SUITE], { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    process.exit(await child.exited);
  } else {
    const [index, total] = process.argv.slice(2).map(Number);
    // The leading ./ makes bun treat each entry as a path, not a substring filter.
    console.log(shardFiles(testFiles(), index!, total!).map(file => `./${file}`).join("\n"));
  }
}
