import { AppError } from "../../errors";
import { digest } from "../../s15/policy/validation";
import { redactCredentials } from "../../security/credentials";
import { redactRegisteredSecrets } from "../../security/secret-fingerprints";
import type { McpHttpTool } from "./mcp";
import { toolName, type ImportResult, type ToolCandidate } from "./openapi";
import { boundSchema } from "./schema";
import { connectionLimits, type SourceCatalog, type SourceKind, type SourceReview, type SourceTool, type ToolClass } from "./types";

/** Source text shown to the owner and the model: control characters removed, bounded, credentials redacted. */
export const sourceText = (value: unknown, max: number): string => typeof value === "string" ? redactRegisteredSecrets(redactCredentials(value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""))).slice(0, max) : "";

/**
 * Map listed MCP tools to candidates. The MCP name is kept exactly for `tools/call`; the model-facing name is derived.
 * `annotations.readOnlyHint`/`destructiveHint` are recorded as the server's own hint only.
 */
export function mcpCandidates(listed: readonly McpHttpTool[], truncated: boolean, server: ImportResult["server"]): ImportResult {
  const tools: ToolCandidate[] = [], skipped: { name: string; code: string }[] = [], names = new Set<string>();
  for (const tool of listed) {
    const raw = typeof tool.name === "string" ? tool.name : "";
    try {
      if (!/^[A-Za-z0-9_.\-/]{1,128}$/.test(raw)) throw new AppError("tool_name_invalid");
      const inputSchema = boundSchema(tool.inputSchema);
      let name = toolName(raw); for (let n = 2; names.has(name); n++) name = `${toolName(raw).slice(0, 60)}_${n}`;
      names.add(name);
      const annotations = tool.annotations && typeof tool.annotations === "object" && !Array.isArray(tool.annotations) ? tool.annotations as Record<string, unknown> : {};
      const title = sourceText(tool.title ?? annotations.title, 160) || raw;
      tools.push({ name, title, description: sourceText(tool.description, connectionLimits.descriptionChars), inputSchema,
        hint: { readOnly: typeof annotations.readOnlyHint === "boolean" ? annotations.readOnlyHint : null, destructive: typeof annotations.destructiveHint === "boolean" ? annotations.destructiveHint : null, method: null, operation: null },
        binding: { kind: "mcp", tool: raw } });
    } catch (error) { skipped.push({ name: sourceText(raw, 128) || "?", code: error instanceof AppError ? error.code : "tool_unsupported" }); }
  }
  return { tools, skipped: skipped.slice(0, 256), truncated, server, base: null };
}

/** The suggestion shown pre-selected in the review: a read hint suggests `read`, anything else `approval`. */
function suggestion(tool: ToolCandidate): { suggested: ToolClass; allowed: ToolClass[] } {
  if (tool.binding.kind === "graphql") return tool.binding.operation === "mutation" ? { suggested: "approval", allowed: ["change", "approval", "off"] } : { suggested: "read", allowed: ["read", "change", "approval", "off"] };
  const read = tool.binding.kind === "openapi" ? tool.binding.method === "GET" || tool.binding.method === "HEAD" : tool.hint.readOnly === true && tool.hint.destructive !== true;
  return { suggested: read ? "read" : "approval", allowed: ["read", "change", "approval", "off"] };
}

/** Freeze one discovery into a catalog whose hash binds every tool's identity, text, hints, schema, binding and allowed classes. */
export function buildCatalog(kind: SourceKind, endpoint: string, result: ImportResult, now: number): SourceCatalog {
  const tools: SourceTool[] = result.tools.map(candidate => {
    const { suggested, allowed } = suggestion(candidate);
    return { ...candidate, suggested, allowed, schemaHash: digest("s16.source.tool.v1", { name: candidate.name, title: candidate.title, description: candidate.description, hint: candidate.hint, inputSchema: candidate.inputSchema, binding: candidate.binding, allowed }) };
  });
  return { contract: "s16-source-catalog/v1", hash: digest("s16.source.catalog.v1", { kind, endpoint, tools: tools.map(t => ({ name: t.name, schemaHash: t.schemaHash })) }), tools, skipped: result.skipped, truncated: result.truncated, server: result.server, discoveredAt: now };
}

/** Validate an owner review: every tool decided, each decision allowed for that tool. */
export function reviewDecisions(catalog: SourceCatalog, decisions: unknown): Record<string, ToolClass> {
  if (!decisions || typeof decisions !== "object" || Array.isArray(decisions)) throw new AppError("invalid_connection_command");
  const entries = Object.entries(decisions as Record<string, unknown>);
  if (entries.length !== catalog.tools.length) throw new AppError("source_review_incomplete", 409);
  const out: Record<string, ToolClass> = {};
  for (const tool of catalog.tools) {
    const decision = (decisions as Record<string, unknown>)[tool.name];
    if (typeof decision !== "string" || !tool.allowed.includes(decision as ToolClass)) throw new AppError(decision === "read" ? "source_review_read_refused" : "source_review_incomplete", 409);
    out[tool.name] = decision as ToolClass;
  }
  return out;
}

/** The reviewed decision of a tool, only while the review covers exactly the current catalog. */
export function decisionOf(catalog: SourceCatalog | null, review: SourceReview | null, name: string): { tool: SourceTool; decision: ToolClass } | null {
  if (!catalog || !review || review.catalogHash !== catalog.hash) return null;
  const tool = catalog.tools.find(t => t.name === name), decision = review.decisions[name];
  return tool && decision && decision !== "off" ? { tool, decision } : null;
}
