import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shardFiles, testFiles } from "../ops/ci/test-shard";

test("every test file runs in exactly one CI shard", () => {
  const files = testFiles(), total = 6;
  const shards = Array.from({ length: total }, (_, index) => shardFiles(files, index, total));
  expect(shards.flat().sort()).toEqual(files);
  expect(new Set(shards.flat()).size).toBe(files.length);
  expect(Math.max(...shards.map(s => s.length)) - Math.min(...shards.map(s => s.length))).toBeLessThanOrEqual(1);
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
  expect(workflow).toContain("needs: [typecheck, tests]");
});
