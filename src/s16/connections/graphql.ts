import { AppError } from "../../errors";
import type { JsonValue } from "../../s15/policy";
import { boundSchema } from "./schema";
import { toolName, type ImportResult, type ToolCandidate } from "./openapi";
import { connectionLimits } from "./types";

/**
 * OPEN16-01 GraphQL gateway source (ADR 0089): the owner writes named operations (a persisted-operation catalog); Jit
 * never introspects a schema and never sends a model-written document. A trusted parser of the GraphQL executable
 * grammar reads each operation's real type (`query`/`mutation`; `subscription` is unsupported), its variables (the
 * only model input) and the fragments it uses, and bounds its expanded selection depth and field count. The operation
 * name, aliases and field names are never evidence of what an operation does: a `mutation` can never be reviewed as a
 * read, whatever it is called.
 */
type Token = { kind: "punct" | "name" | "number" | "string" | "spread"; value: string; start: number };

function lex(source: string): Token[] {
  const tokens: Token[] = []; let i = 0;
  while (i < source.length) {
    if (tokens.length > 100_000) throw new AppError("graphql_too_large");
    const c = source[i]!;
    if (c === "#") { while (i < source.length && source[i] !== "\n" && source[i] !== "\r") i++; continue; }
    if (/[\s,﻿]/.test(c)) { i++; continue; }
    if (source.startsWith("...", i)) { tokens.push({ kind: "spread", value: "...", start: i }); i += 3; continue; }
    if ("!$&()=:@[]{}|".includes(c)) { tokens.push({ kind: "punct", value: c, start: i }); i++; continue; }
    if (/[A-Za-z_]/.test(c)) { const start = i; while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) i++; tokens.push({ kind: "name", value: source.slice(start, i), start }); continue; }
    if (/[-0-9]/.test(c)) { const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(source.slice(i)); if (!match) throw new AppError("graphql_syntax"); tokens.push({ kind: "number", value: match[0], start: i }); i += match[0].length; continue; }
    if (source.startsWith('"""', i)) { const end = source.indexOf('"""', i + 3); if (end < 0) throw new AppError("graphql_syntax"); tokens.push({ kind: "string", value: source.slice(i + 3, end), start: i }); i = end + 3; continue; }
    if (c === '"') { let j = i + 1; while (j < source.length && source[j] !== '"') { if (source[j] === "\\") j++; if (source[j] === "\n") throw new AppError("graphql_syntax"); j++; } if (j >= source.length) throw new AppError("graphql_syntax"); tokens.push({ kind: "string", value: source.slice(i + 1, j), start: i }); i = j + 1; continue; }
    throw new AppError("graphql_syntax");
  }
  return tokens;
}

type Selection = { kind: "field"; name: string; selections: Selection[] } | { kind: "spread"; name: string } | { kind: "inline"; selections: Selection[] };
type TypeRef = { kind: "named"; name: string; nonNull: boolean } | { kind: "list"; of: TypeRef; nonNull: boolean };
interface Operation { type: "query" | "mutation" | "subscription"; name: string; variables: { name: string; type: TypeRef; hasDefault: boolean }[]; selections: Selection[]; start: number; end: number; spreads: Set<string> }
interface Fragment { name: string; selections: Selection[]; start: number; end: number }

function parse(source: string): { operations: Operation[]; fragments: Map<string, Fragment> } {
  const tokens = lex(source); let p = 0;
  const peek = (value?: string) => { const t = tokens[p]; return t && (value === undefined || t.value === value) ? t : null; };
  const take = (value?: string): Token => { const t = tokens[p]; if (!t || value !== undefined && t.value !== value) throw new AppError("graphql_syntax"); p++; return t; };
  const name = (): string => { const t = take(); if (t.kind !== "name") throw new AppError("graphql_syntax"); return t.value; };
  const value = (depth: number): void => {
    if (depth > 32) throw new AppError("graphql_too_deep");
    const t = take();
    if (t.value === "$") { name(); return; }
    if (t.value === "[") { while (!peek("]")) value(depth + 1); take("]"); return; }
    if (t.value === "{") { while (!peek("}")) { name(); take(":"); value(depth + 1); } take("}"); return; }
    if (t.kind === "punct") throw new AppError("graphql_syntax");
  };
  const directives = () => { while (peek("@")) { take("@"); name(); if (peek("(")) { take("("); while (!peek(")")) { name(); take(":"); value(0); } take(")"); } } };
  const type = (): TypeRef => {
    let ref: TypeRef;
    if (peek("[")) { take("["); ref = { kind: "list", of: type(), nonNull: false }; take("]"); } else ref = { kind: "named", name: name(), nonNull: false };
    if (peek("!")) { take("!"); ref.nonNull = true; }
    return ref;
  };
  const selectionSet = (depth: number, spreads: Set<string>): Selection[] => {
    if (depth > 64) throw new AppError("graphql_too_deep");
    take("{"); const out: Selection[] = [];
    while (!peek("}")) {
      if (peek("...")) {
        take("...");
        if (peek("on") || peek("{") || peek("@")) { if (peek("on")) { take("on"); name(); } directives(); out.push({ kind: "inline", selections: selectionSet(depth + 1, spreads) }); }
        else { const fragment = name(); spreads.add(fragment); directives(); out.push({ kind: "spread", name: fragment }); }
        continue;
      }
      let field = name(); if (peek(":")) { take(":"); field = name(); }
      if (peek("(")) { take("("); while (!peek(")")) { name(); take(":"); value(0); } take(")"); }
      directives();
      out.push({ kind: "field", name: field, selections: peek("{") ? selectionSet(depth + 1, spreads) : [] });
    }
    take("}"); if (!out.length) throw new AppError("graphql_syntax");
    return out;
  };
  const operations: Operation[] = [], fragments = new Map<string, Fragment>();
  while (p < tokens.length) {
    const start = tokens[p]!.start, t = peek();
    if (t?.value === "fragment") {
      take(); const fragmentName = name(); take("on"); name(); directives();
      const selections = selectionSet(0, new Set());
      if (fragments.has(fragmentName)) throw new AppError("graphql_duplicate_fragment");
      fragments.set(fragmentName, { name: fragmentName, selections, start, end: tokens[p - 1]!.start + 1 });
      continue;
    }
    if (t?.value === "{") throw new AppError("graphql_operation_name_required");
    if (!t || !["query", "mutation", "subscription"].includes(t.value)) throw new AppError("graphql_definition_unsupported");
    take(); if (!peek() || peek()!.kind !== "name") throw new AppError("graphql_operation_name_required");
    const operationName = name(), variables: Operation["variables"] = [];
    if (peek("(")) { take("("); while (!peek(")")) { take("$"); const variable = name(); take(":"); const ref = type(); let hasDefault = false; if (peek("=")) { take("="); value(0); hasDefault = true; } directives(); variables.push({ name: variable, type: ref, hasDefault }); } take(")"); }
    directives();
    const spreads = new Set<string>(), selections = selectionSet(0, spreads);
    operations.push({ type: t.value as Operation["type"], name: operationName, variables, selections, start, end: tokens[p - 1]!.start + 1, spreads });
  }
  return { operations, fragments };
}

const scalar = (name: string): JsonValue => name === "Int" ? { type: "integer" } : name === "Float" ? { type: "number" } : name === "Boolean" ? { type: "boolean" } : name === "String" || name === "ID" ? { type: "string" } : {};
const schemaOf = (ref: TypeRef): JsonValue => ref.kind === "list" ? { type: "array", items: schemaOf(ref.of) } : scalar(ref.name);

/** Import the owner's named operations. Each operation is one tool; skipped operations are named with a reason. */
export function importGraphql(input: string): ImportResult {
  if (typeof input !== "string" || !input.trim() || Buffer.byteLength(input) > connectionLimits.documentBytes) throw new AppError("source_document_invalid");
  let parsed: ReturnType<typeof parse>;
  try { parsed = parse(input); } catch (error) { throw new AppError(error instanceof AppError ? error.code : "graphql_syntax"); }
  if (!parsed.operations.length) throw new AppError("graphql_operation_required");
  const tools: ToolCandidate[] = [], skipped: { name: string; code: string }[] = [], names = new Set<string>();
  let truncated = false;
  for (const operation of parsed.operations) {
    if (tools.length >= connectionLimits.toolsPerSource) { truncated = true; break; }
    try {
      if (names.has(operation.name)) throw new AppError("graphql_duplicate_operation");
      if (operation.type === "subscription") throw new AppError("graphql_subscription_unsupported");
      // Expand fragments for the depth/field bounds and collect every fragment the operation actually needs.
      const used = new Set<string>(); let fields = 0;
      const measure = (selections: Selection[], depth: number, stack: string[]): number => {
        let deepest = depth;
        for (const s of selections) {
          if (s.kind === "field") { if (++fields > connectionLimits.graphqlFields) throw new AppError("graphql_too_large"); deepest = Math.max(deepest, s.selections.length ? measure(s.selections, depth + 1, stack) : depth + 1); }
          else if (s.kind === "inline") deepest = Math.max(deepest, measure(s.selections, depth, stack));
          else { const fragment = parsed.fragments.get(s.name); if (!fragment) throw new AppError("graphql_fragment_missing"); if (stack.includes(s.name)) throw new AppError("graphql_fragment_cycle"); used.add(s.name); deepest = Math.max(deepest, measure(fragment.selections, depth, [...stack, s.name])); }
          if (deepest > connectionLimits.graphqlDepth) throw new AppError("graphql_too_deep");
        }
        return deepest;
      };
      measure(operation.selections, 0, []);
      const document = [input.slice(operation.start, operation.end), ...[...used].sort().map(name => { const f = parsed.fragments.get(name)!; return input.slice(f.start, f.end); })].join("\n");
      const properties: Record<string, JsonValue> = {}, required: string[] = [];
      for (const variable of operation.variables) { properties[variable.name] = schemaOf(variable.type); if (variable.type.nonNull && !variable.hasDefault) required.push(variable.name); }
      const name = toolName(operation.name); if (names.has(name)) throw new AppError("graphql_duplicate_operation");
      names.add(name);
      tools.push({ name, title: operation.name, description: `${operation.type} ${operation.name}`, inputSchema: boundSchema({ type: "object", properties, required, additionalProperties: false }),
        hint: { readOnly: null, destructive: null, method: null, operation: operation.type }, binding: { kind: "graphql", operationName: operation.name, operation: operation.type, document } });
    } catch (error) { skipped.push({ name: operation.name, code: error instanceof AppError ? error.code : "operation_unsupported" }); }
  }
  return { tools, skipped, truncated, base: null, server: { name: null, version: null, protocol: "graphql" } };
}
