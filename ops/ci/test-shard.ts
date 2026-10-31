import { Glob } from "bun";

/** Lists every test file in sorted order; each file belongs to exactly one shard. */
export function testFiles(root = "."): string[] {
  return [...new Glob("tests/**/*.test.ts").scanSync({ cwd: root })].sort();
}

/** Selects one zero-based shard round-robin, which spreads each suite family across runners. */
export function shardFiles(files: string[], index: number, total: number): string[] {
  if (!Number.isInteger(total) || total < 1 || !Number.isInteger(index) || index < 0 || index >= total) throw new Error("invalid_shard");
  return files.filter((_, position) => position % total === index);
}

if (import.meta.main) {
  const [index, total] = process.argv.slice(2).map(Number);
  // The leading ./ makes bun treat each entry as a path, not a substring filter.
  console.log(shardFiles(testFiles(), index!, total!).map(file => `./${file}`).join("\n"));
}
