import { AppError } from "../../errors";
import type { JsonValue } from "../../s15/policy";
import { boundJson, boundSchema } from "./schema";
import { connectionLimits, type JsonSchema, type SourceBinding, type SourceTool } from "./types";

/** A tool before the catalog assigns its hash and the review vocabulary. */
export type ToolCandidate = Pick<SourceTool, "name" | "title" | "description" | "inputSchema" | "hint" | "binding">;
export interface ImportResult { tools: ToolCandidate[]; skipped: { name: string; code: string }[]; truncated: boolean; server: { name: string | null; version: string | null; protocol: string | null }; base: string | null }

const methods = ["get", "head", "post", "put", "patch", "delete"] as const;
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max: number) => typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max) : "";
/** Model-facing tool identity: `[A-Za-z0-9_-]`, at most 64 characters. */
export const toolName = (value: string) => value.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || "tool";

/** Parse a bounded JSON or YAML document. YAML anchors/aliases are refused, so a small file cannot expand without bound. */
export function parseDocument(input: string): unknown {
  if (typeof input !== "string" || !input.trim() || Buffer.byteLength(input) > connectionLimits.documentBytes) throw new AppError("source_document_invalid");
  const trimmed = input.trimStart();
  if (trimmed.startsWith("{")) { try { return JSON.parse(input); } catch { throw new AppError("source_document_invalid"); } }
  if (/(^|[\s[{,:-])[&*][A-Za-z0-9_.-]+/m.test(input.replace(/(["'])(?:\\.|(?!\1).)*\1/g, "\"\"").replace(/#.*$/gm, ""))) throw new AppError("source_document_aliases_unsupported");
  try { return Bun.YAML.parse(input); } catch { throw new AppError("source_document_invalid"); }
}

/**
 * OPEN16-01 bounded OpenAPI 3.0/3.1 importer (ADR 0089). Each operation becomes one tool whose request (method, exact
 * path template, path/query parameters and an optional JSON body) is fixed by the document; the model supplies only
 * argument values. Only local `#/...` references are followed (at most {@link connectionLimits.openapiRefs}, cycles
 * refuse); an operation using an external reference, a required header/cookie parameter or a non-JSON required body is
 * skipped and named. The base URL is the owner's endpoint, never a later document change.
 */
export function importOpenApi(input: string): ImportResult {
  const doc = record(parseDocument(input));
  if (!doc || typeof doc.openapi !== "string" || !/^3\.(0|1)\.\d+$/.test(doc.openapi)) throw new AppError("source_document_unsupported");
  const info = record(doc.info);
  const servers = Array.isArray(doc.servers) ? doc.servers.map(record).filter(Boolean) as Record<string, unknown>[] : [];
  const base = servers.map(s => s.url).find((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)) ?? null;
  let refs = 0;
  const resolve = (value: unknown, stack: string[] = []): unknown => {
    const object = record(value);
    if (Array.isArray(value)) return value.map(item => resolve(item, stack));
    if (!object) return value;
    if (typeof object.$ref === "string") {
      const ref = object.$ref;
      if (!ref.startsWith("#/")) throw new AppError("external_reference");
      if (++refs > connectionLimits.openapiRefs || stack.includes(ref) || stack.length > connectionLimits.schemaDepth) throw new AppError("reference_unsupported");
      let target: unknown = doc;
      for (const part of ref.slice(2).split("/").map(p => p.replace(/~1/g, "/").replace(/~0/g, "~"))) { target = record(target)?.[part]; if (target === undefined) throw new AppError("reference_unsupported"); }
      return resolve(target, [...stack, ref]);
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(object)) out[key] = resolve(entry, stack);
    return out;
  };
  const tools: ToolCandidate[] = [], skipped: { name: string; code: string }[] = [], names = new Set<string>();
  let truncated = false;
  const paths = record(doc.paths) ?? {};
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = record(rawItem); if (!item) continue;
    for (const method of methods) {
      const raw = record(item[method]); if (!raw) continue;
      const label = typeof raw.operationId === "string" ? raw.operationId : `${method} ${path}`;
      if (tools.length >= connectionLimits.toolsPerSource) { truncated = true; break; }
      try {
        if (!/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/{}]*$/.test(path) || path.length > 1024) throw new AppError("path_unsupported");
        const operation = resolve(raw) as Record<string, unknown>;
        const shared = (resolve(item.parameters ?? []) as unknown[]).map(record).filter(Boolean) as Record<string, unknown>[];
        const own = (Array.isArray(operation.parameters) ? operation.parameters : []).map(record).filter(Boolean) as Record<string, unknown>[];
        const merged = [...shared.filter(p => !own.some(o => o.name === p.name && o.in === p.in)), ...own];
        const properties: Record<string, JsonValue> = {}, required: string[] = [], parameters: { name: string; in: "path" | "query"; required: boolean; explode?: boolean }[] = [];
        for (const p of merged) {
          if (typeof p.name !== "string" || !/^[A-Za-z0-9_.\-[\]]{1,128}$/.test(p.name) || p.name === "body") throw new AppError("parameter_unsupported");
          if (p.in === "header" || p.in === "cookie") { if (p.required === true) throw new AppError("header_parameter_unsupported"); continue; }
          if (p.in !== "path" && p.in !== "query") throw new AppError("parameter_unsupported");
          const isRequired = p.in === "path" || p.required === true;
          // Only the default encodings are built: path `simple` with scalar values, query `form` with scalars or arrays of
          // scalars. Any other style, an object value or a `content` parameter cannot be encoded, so the operation is skipped.
          const schema = record(p.schema), type = schema?.type, style = p.style ?? (p.in === "path" ? "simple" : "form");
          if (p.content !== undefined || style !== (p.in === "path" ? "simple" : "form") || type === "object" || p.in === "path" && type === "array" || type === "array" && ["object", "array"].includes(String(record(schema!.items)?.type))) throw new AppError("parameter_encoding_unsupported");
          properties[p.name] = boundJson({ ...(record(p.schema) ?? { type: "string" }), ...(typeof p.description === "string" ? { description: text(p.description, 512) } : {}) }, 1);
          if (isRequired) required.push(p.name);
          parameters.push({ name: p.name, in: p.in, required: isRequired, ...(p.in === "query" && type === "array" ? { explode: p.explode !== false } : {}) });
        }
        for (const match of path.matchAll(/\{([^}]+)\}/g)) if (!parameters.some(p => p.in === "path" && p.name === match[1])) throw new AppError("path_unsupported");
        let body: "none" | "json" = "none", bodyRequired = false;
        const requestBody = record(operation.requestBody);
        if (requestBody) {
          const content = record(requestBody.content) ?? {}, jsonType = Object.keys(content).find(type => /^application\/(?:[a-z0-9.+-]*\+)?json$/i.test(type.split(";")[0]!.trim()));
          if (jsonType) { body = "json"; bodyRequired = requestBody.required === true; properties.body = (record(record(content[jsonType])?.schema) ?? {}) as JsonValue; if (bodyRequired) required.push("body"); }
          else if (requestBody.required === true) throw new AppError("body_unsupported");
        }
        const inputSchema: JsonSchema = boundSchema({ type: "object", properties, required, additionalProperties: false });
        let name = toolName(label); for (let n = 2; names.has(name); n++) name = `${toolName(label).slice(0, 60)}_${n}`;
        names.add(name);
        const binding: SourceBinding = { kind: "openapi", method: method.toUpperCase() as Extract<SourceBinding, { kind: "openapi" }>["method"], path, parameters, body, bodyRequired };
        tools.push({ name, title: text(operation.summary, 160) || name, description: text(operation.description ?? operation.summary, connectionLimits.descriptionChars), inputSchema,
          hint: { readOnly: null, destructive: method === "delete" ? true : null, method: method.toUpperCase(), operation: null }, binding });
      } catch (error) { skipped.push({ name: text(label, 160), code: error instanceof AppError ? error.code : "operation_unsupported" }); }
    }
    if (truncated) break;
  }
  if (skipped.length > 256) skipped.length = 256;
  return { tools, skipped, truncated, base, server: { name: text(info?.title, 128) || null, version: text(info?.version, 64) || null, protocol: `openapi ${doc.openapi}` } };
}

/** Build the exact request of an OpenAPI tool from validated arguments (trusted adapter code only). */
export function openApiRequest(endpoint: string, binding: Extract<SourceBinding, { kind: "openapi" }>, args: Record<string, JsonValue>): { url: string; method: string; body: string | null } {
  const base = new URL(endpoint);
  let path = binding.path;
  const query = new URLSearchParams();
  for (const p of binding.parameters) {
    const value = args[p.name];
    if (value === undefined) { if (p.required) throw new AppError("source_arguments_invalid"); continue; }
    if (value === null || typeof value === "object" && !Array.isArray(value)) throw new AppError("source_arguments_invalid");
    const values = Array.isArray(value) ? value : [value];
    if (values.some(v => v === null || typeof v === "object")) throw new AppError("source_arguments_invalid");
    if (p.in === "path") { if (Array.isArray(value)) throw new AppError("source_arguments_invalid"); path = path.replaceAll(`{${p.name}}`, encodeURIComponent(String(value))); }
    else if (Array.isArray(value) && p.explode === false) query.append(p.name, values.map(String).join(","));
    else for (const v of values) query.append(p.name, String(v));
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  const url = new URL(base.origin + prefix + path);
  url.search = query.toString();
  // A path value can never leave the owner's endpoint: the URL keeps the base origin and its path prefix.
  if (url.origin !== base.origin || !url.pathname.startsWith(prefix + "/") && url.pathname !== prefix) throw new AppError("source_arguments_invalid");
  const body = binding.body === "json" && args.body !== undefined ? JSON.stringify(args.body) : null;
  if (binding.bodyRequired && body === null) throw new AppError("source_arguments_invalid");
  return { url: url.href, method: binding.method, body };
}
