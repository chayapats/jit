import { expect, test } from "bun:test";
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
