import { AppError } from "../../errors";
import type { JsonValue } from "../../s15/policy";
import { connectionLimits, type JsonSchema } from "./types";

/**
 * Bounded JSON Schema handling for discovered tools (ADR 0089). A source's schema is untrusted data: it is copied only
 * when it is plain JSON within finite depth/size, `$ref` is refused (the importers inline local references first), and
 * argument validation enforces a deliberate subset (`type`, `enum`, `const`, `properties`, `required`,
 * `additionalProperties`, `items`, string/number/array bounds, `anyOf`/`oneOf`/`allOf`). Unknown keywords are kept for
 * the model but never relaxed into authority: the request is still built only by the trusted binding.
 */
export function boundJson(value: unknown, depth = 0): JsonValue {
  const copy = (item: unknown, level: number): JsonValue => {
    if (level > connectionLimits.schemaDepth) throw new AppError("source_schema_unsupported");
    if (item === null || typeof item === "boolean" || typeof item === "string") return item;
    if (typeof item === "number") { if (!Number.isFinite(item)) throw new AppError("source_schema_unsupported"); return item; }
    if (Array.isArray(item)) { if (item.length > 256) throw new AppError("source_schema_unsupported"); return item.map(entry => copy(entry, level + 1)); }
    const prototype = item && typeof item === "object" ? Object.getPrototypeOf(item) : undefined;
    if (prototype === Object.prototype || prototype === null) {
      const entries = Object.entries(item as Record<string, unknown>);
      if (entries.length > 256) throw new AppError("source_schema_unsupported");
      const out: { [key: string]: JsonValue } = {};
      for (const [key, entry] of entries) { if (key === "$ref" || key === "$dynamicRef" || key === "$recursiveRef") throw new AppError("source_schema_unsupported"); out[key] = copy(entry, level + 1); }
      return out;
    }
    throw new AppError("source_schema_unsupported");
  };
  return copy(value, depth);
}
/** A tool's top-level input schema: a bounded object schema (an absent schema means "no arguments"). */
export function boundSchema(value: unknown): JsonSchema {
  const result = value === undefined || value === null ? { type: "object", properties: {} } : boundJson(value);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new AppError("source_schema_unsupported");
  if (result.type !== undefined && result.type !== "object") throw new AppError("source_schema_unsupported");
  if (Buffer.byteLength(JSON.stringify(result)) > connectionLimits.schemaBytes) throw new AppError("source_schema_unsupported");
  return { ...result, type: "object" };
}

const typeOf = (value: unknown): string => value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
const matchesType = (value: unknown, type: unknown): boolean => {
  const types = Array.isArray(type) ? type : [type];
  const actual = typeOf(value);
  return types.some(t => t === actual || t === "number" && actual === "integer");
};

/** Validate model-supplied arguments against the reviewed schema subset. Refuses with `source_arguments_invalid`. */
export function validateArguments(schema: JsonSchema, value: unknown): asserts value is { [key: string]: JsonValue } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("source_arguments_invalid");
  let size: number; try { size = Buffer.byteLength(JSON.stringify(value)); } catch { throw new AppError("source_arguments_invalid"); }
  if (size > connectionLimits.argumentBytes) throw new AppError("source_arguments_too_large");
  let checks = 0;
  const fail = (): never => { throw new AppError("source_arguments_invalid"); };
  const check = (s: JsonValue, v: unknown, depth: number): boolean => {
    if (++checks > 20_000 || depth > 32) fail();
    if (s === true || s === undefined) return true;
    if (s === false) return false;
    if (!s || typeof s !== "object" || Array.isArray(s)) return true;
    if (s.type !== undefined && !matchesType(v, s.type)) return false;
    if (Array.isArray(s.enum) && !s.enum.some(option => JSON.stringify(option) === JSON.stringify(v))) return false;
    if (s.const !== undefined && JSON.stringify(s.const) !== JSON.stringify(v)) return false;
    if (typeof v === "string") {
      if (typeof s.maxLength === "number" && [...v].length > s.maxLength) return false;
      if (typeof s.minLength === "number" && [...v].length < s.minLength) return false;
    }
    if (typeof v === "number") {
      if (typeof s.maximum === "number" && v > s.maximum) return false;
      if (typeof s.minimum === "number" && v < s.minimum) return false;
    }
    if (Array.isArray(v)) {
      if (typeof s.maxItems === "number" && v.length > s.maxItems) return false;
      if (typeof s.minItems === "number" && v.length < s.minItems) return false;
      if (s.items !== undefined && !Array.isArray(s.items) && !v.every(item => check(s.items as JsonValue, item, depth + 1))) return false;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const object = v as Record<string, unknown>, properties = s.properties && typeof s.properties === "object" && !Array.isArray(s.properties) ? s.properties as Record<string, JsonValue> : {};
      if (Array.isArray(s.required) && s.required.some(key => typeof key === "string" && !Object.hasOwn(object, key))) return false;
      for (const [key, entry] of Object.entries(object)) {
        if (Object.hasOwn(properties, key)) { if (!check(properties[key]!, entry, depth + 1)) return false; }
        else if (s.additionalProperties === false) return false;
        else if (s.additionalProperties && typeof s.additionalProperties === "object" && !check(s.additionalProperties, entry, depth + 1)) return false;
      }
    }
    if (Array.isArray(s.allOf) && !s.allOf.every(part => check(part, v, depth + 1))) return false;
    if (Array.isArray(s.anyOf) && !s.anyOf.some(part => check(part, v, depth + 1))) return false;
    if (Array.isArray(s.oneOf) && s.oneOf.filter(part => check(part, v, depth + 1)).length !== 1) return false;
    return true;
  };
  if (!check(schema, value, 0)) fail();
}
