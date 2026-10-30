/** Shared MEM01 active-lineage traversal; scope is checked by the inspector before returning any payload. */
export function activeLineage<R, T>(reference: R, inspect: (ref: R) => { value: T; key: string; children: R[]; available: boolean }, unavailable: (ref: R, reason: string) => T, options = { depth: 0, remaining: 64, seen: new Set<string>() }): T {
  function visit(ref: R, depth: number, seen: Set<string>): { value: T; available: boolean } {
    const item = inspect(ref);
    if (--options.remaining < 0 || depth > 8 || seen.has(item.key)) return { value: unavailable(ref, "lineage_limit"), available: false };
    if (!item.available) return { value: item.value, available: false };
    const next = new Set(seen).add(item.key);
    for (const child of item.children) {
      if (!visit(child, depth + 1, next).available) return { value: unavailable(ref, "dependency_unavailable"), available: false };
    }
    return { value: item.value, available: true };
  }
  return visit(reference, options.depth, options.seen).value;
}

/** Shared suppression closure; every descendant is visited once and an oversized graph fails before mutation. */
export function lineageClosure<T>(seeds: readonly T[], key: (item: T) => string, children: (item: T) => readonly T[], limit = 20_000): T[] {
  const queue = [...seeds], seen = new Set<string>(), result: T[] = [];
  for (let at = 0; at < queue.length; at++) {
    const item = queue[at]!, identity = key(item);
    if (seen.has(identity)) continue;
    if (seen.size >= limit) throw new Error("memory_lineage_limit");
    seen.add(identity);
    result.push(item);
    queue.push(...children(item));
  }
  return result;
}
