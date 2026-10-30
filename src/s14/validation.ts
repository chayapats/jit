import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { containsCredential, redactCredentials } from "../security/credentials";
import type { Capabilities, Policy } from "./types";
import { resourceConfigured } from "./share-slots";

/** Rejects missing or extra keys rather than silently dropping authority-bearing fields. */
export function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) throw new AppError("invalid_shape");
}
/** Maximum UTF-8 bytes in a canonical record or command receipt. */
export const canonicalByteLimit = 131072;
/** Canonical bounded JSON for retry identities and immutable action hashes, rejecting accessors and cycles. */
export function canonical(value: unknown): string {
  const seen = new Set<object>();
  function visit(v: unknown, depth: number): unknown {
    if (depth > 16) throw new AppError("invalid_data");
    if (v === null || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (!v || typeof v !== "object" || seen.has(v)) throw new AppError("invalid_data");
    if (Object.getPrototypeOf(v) !== (Array.isArray(v) ? Array.prototype : Object.prototype)) throw new AppError("invalid_data");
    const keys = Reflect.ownKeys(v), descriptors = Object.getOwnPropertyDescriptors(v);
    if (keys.length > 257 || keys.some(k => typeof k !== "string") || Object.entries(descriptors).some(([k, d]) => !("value" in d) || (!d.enumerable && !(Array.isArray(v) && k === "length")))) throw new AppError("invalid_data");
    if (Array.isArray(v) && (keys.length !== v.length + 1 || v.some((_x, i) => !Object.hasOwn(v, i)))) throw new AppError("invalid_data");
    seen.add(v);
    const result = Array.isArray(v) ? Array.from(v, x => visit(x, depth + 1)) : Object.fromEntries(Object.keys(v).sort().map(k => [k, visit((v as Record<string, unknown>)[k], depth + 1)]));
    seen.delete(v); return result;
  }
  const encoded = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(encoded) > canonicalByteLimit) throw new AppError("data_too_large", 413);
  return encoded;
}
/** SHA-256 digest used for credentials, receipts and exact action binding. */
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
/** Validates an opaque identity without accepting a path or inferred alias. */
export function identity(v: unknown): asserts v is string { if (typeof v !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(v) || containsCredential(v)) throw new AppError("invalid_identity"); }
/** Validates finite revision and counter values. */
export function integer(v: unknown, min = 0, max = 1_000_000_000): asserts v is number { if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) throw new AppError("invalid_number"); }
/** Validates plain Unicode and removes credential patterns before persistence or prompts. */
export function text(v: unknown, max = 16384): string {
  if (typeof v !== "string" || !v.trim() || !v.isWellFormed() || Buffer.byteLength(v) > max || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(v)) throw new AppError("invalid_text");
  return redactCredentials(v.trim());
}
/** Validates explicit capability selection against installation policy without inheriting a sibling's state. */
export function capabilities(v: unknown, policy: Policy): Capabilities {
  exact(v, ["tools", "resources"]);
  for (const k of ["tools", "resources"] as const) {
    if (!Array.isArray(v[k]) || v[k].length > 64 || new Set(v[k]).size !== v[k].length) throw new AppError("invalid_capabilities");
    for (const item of v[k]) { identity(item); if (!(k === "resources" ? resourceConfigured(policy, item) : policy.tools.includes(item))) throw new AppError("capability_unconfigured", 403); }
  }
  return structuredClone(v) as unknown as Capabilities;
}
