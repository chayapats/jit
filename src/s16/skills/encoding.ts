import { createHash } from "node:crypto";
import { canonical, fail } from "../../s15/policy/validation";

/** Package-only JSON envelope: base64 for 2 MiB plus retained instruction bodies/metadata fits within an 8 MiB journal envelope.
 * Primitive validation, secret refusal, exact ordering and depth/container limits match POLICY. POLICY's
 * own 128 KiB bound remains unchanged; no caller can supply a larger limit to its canonicalizer. */
export function canonicalSkill(value: unknown): string {
  const seen = new Set<object>(), parts: string[] = []; let bytes = 0;
  const append = (part: string) => { bytes += Buffer.byteLength(part); if (bytes > 8 * 1024 * 1024) fail("input_too_large"); parts.push(part); };
  const walk = (value: unknown, depth: number): void => {
    if (depth > 16) fail("invalid_shape");
    if (value === null || typeof value !== "object") { append(canonical(value)); return; }
    if (seen.has(value)) fail("invalid_shape"); seen.add(value);
    if (Array.isArray(value)) {
      if (value.length > 256 || Reflect.ownKeys(value).length !== value.length + 1) fail("invalid_shape");
      append("[");
      for (let i = 0; i < value.length; i++) { const entry = Object.getOwnPropertyDescriptor(value, i); if (!entry?.enumerable || !("value" in entry)) fail("invalid_shape"); if (i) append(","); walk(entry.value, depth + 1); }
      append("]");
    } else {
      if (Object.getPrototypeOf(value) !== Object.prototype) fail("invalid_shape");
      const keys = Reflect.ownKeys(value); if (keys.length > 256 || keys.some(key => typeof key !== "string")) fail("invalid_shape");
      append("{");
      for (const [index, key] of (keys as string[]).sort().entries()) { const entry = Object.getOwnPropertyDescriptor(value, key)!; if (!entry.enumerable || !("value" in entry) || Buffer.byteLength(key) > 4096) fail("invalid_shape"); if (index) append(","); append(canonical(key)); append(":"); walk(entry.value, depth + 1); }
      append("}");
    }
    seen.delete(value);
  };
  walk(value, 0); return parts.join("");
}
/** Exact command identity with the package-sized envelope; unchanged small commands keep their original hash. */
export const skillCommandHash = (value: unknown): string => createHash("sha256").update("s16.skills.command.v1\n" + canonicalSkill(value)).digest("hex");
