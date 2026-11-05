import { digest, identity } from "../conversation/validation";

/** Bounds composed source keys and legacy native lookups while preserving persisted short keys. */
export function memoryId(value: string): string {
  return value.length <= 128 ? value : `memory_${digest(value)}`;
}

/** Host-generated derivative keys are disjoint from the public request identity grammar. */
export function memoryDerivativeId(kind: "native" | "summary" | "artifact" | "work", value: string): string {
  identity(value);
  return `memory:${kind}:${digest(value)}`;
}

/** Accepts persisted legacy keys and the closed host namespace, never an arbitrary colon key. */
export function derivativeIdentity(value: unknown, kind?: string): asserts value is string {
  if (typeof value === "string" && /^memory:(native|summary|artifact|work):[a-f0-9]{64}$/.test(value) && (!kind || value.startsWith(`memory:${kind}:`))) return;
  identity(value);
}
