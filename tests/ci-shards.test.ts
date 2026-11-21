import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { RECOVERY_SUITE, recoveryPattern, shardFiles, testFiles } from "../ops/ci/test-shard";

test("every ordinary file runs in exactly one CI shard and recovery has its own job", () => {
  const files = testFiles(), total = 6;
  const shards = Array.from({ length: total }, (_, index) => shardFiles(files, index, total));
  expect([...shards.flat(), RECOVERY_SUITE].sort()).toEqual(files);
  expect(new Set(shards.flat()).size).toBe(files.length - 1);
  expect(Math.max(...shards.map(s => s.length)) - Math.min(...shards.map(s => s.length))).toBeLessThanOrEqual(1);
});

test("recovery partitions are exhaustive and disjoint, including future test names", () => {
  const filters = [0, 1].map(index => new RegExp(recoveryPattern(index)));
  for (const name of ["actual complete forward repair SIGKILL at admitted resumes original state", "actual complete forward repair SIGKILL at future_boundary", "actual candidate SIGKILL at plan", "complete forward repair recovers 257 actual current members", "future case", ""]) {
    expect(filters.filter(filter => filter.test(name))).toHaveLength(1);
  }
  expect(filters[0]!.test("actual complete forward repair SIGKILL at admitted")).toBe(true);
  for (const index of [-1, 2, 0.5, NaN]) expect(() => recoveryPattern(index)).toThrow("invalid_recovery_partition");
});

test.each([[6, 6], [-1, 6], [0, 0], [1.5, 6]])("shard %d of %d is refused", (index, total) => {
  expect(() => shardFiles(["a"], index, total)).toThrow("invalid_shard");
});

test("checks run every shard on both x64 and ARM64 runners, and deterministic needs them all", () => {
  const workflow = readFileSync(join(import.meta.dir, "../.github/workflows/checks.yml"), "utf8");
  expect(workflow).toContain("arch: [x64, arm64]");
  expect(workflow).toContain("shard: [0, 1, 2, 3, 4, 5]");
  expect(workflow).toContain("runs-on: ${{ matrix.arch == 'arm64' && 'ubuntu-24.04-arm' || 'ubuntu-latest' }}");
  expect(workflow).toContain("name: tests (${{ matrix.arch }}, ${{ matrix.shard }})");
  expect(workflow).toContain("key: bun-${{ runner.os }}-${{ matrix.arch }}-${{ hashFiles('bun.lock') }}");
  expect(workflow).toContain("partition: [0, 1]");
  expect(workflow).toContain("bun ops/ci/test-shard.ts recovery ${{ matrix.partition }}");
  expect(workflow).toContain("needs: [typecheck, tests, recovery]");
  expect(workflow).toContain('test "${{ needs.recovery.result }}" = success');
});
