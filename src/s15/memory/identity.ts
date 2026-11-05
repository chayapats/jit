import { digest } from "../conversation/validation";

/** Keeps composed internal memory keys bounded while preserving persisted short identities. */
export function memoryId(value: string): string {
  return value.length <= 128 ? value : `memory_${digest(value)}`;
}
