import { AppError } from "../../errors";
import type { SourceNetwork, SourceResponse } from "./net";
import { connectionLimits } from "./types";

/**
 * MCP16-01 client for the MCP Streamable HTTP transport (spec revision 2025-06-18). JSON-RPC 2.0 requests are POSTed to
 * one endpoint through the protected {@link SourceNetwork}; a reply is either one JSON body or a bounded
 * `text/event-stream` whose matching response ends the request. A server session (`Mcp-Session-Id`) belongs to exactly
 * one {@link McpHttpSession}: it is held in host memory only, sent only by that session's requests and ended with DELETE,
 * so two runs never exchange session identities. Server-to-client requests (sampling, roots, elicitation) are never
 * answered with data: Jit offers no client capability. Jit does not use the standalone GET stream.
 */
export const mcpHttpProtocol = "2025-06-18";
const supportedProtocols = new Set(["2025-06-18", "2025-03-26", "2025-11-25"]);

/** Untrusted listed tool, bounded by the catalog builder. */
export interface McpHttpTool { name: unknown; title?: unknown; description?: unknown; inputSchema?: unknown; annotations?: unknown }
/** Untrusted tool result. */
export interface McpHttpResult { content?: unknown; structuredContent?: unknown; isError?: unknown }
/** A 401 reply: the endpoint needs OAuth. `resourceMetadata` is the RFC 9728 URL from `WWW-Authenticate`, if given. */
export class SourceAuthRequired extends AppError {
  constructor(readonly resourceMetadata: string | null) { super("source_login_required", 401); }
}
/** Outcome of one effectful call, for exact settlement: `unknown` whenever the request may have been processed. */
export type McpCallOutcome = { outcome: "succeeded" | "failed"; result: McpHttpResult | null; code: string | null } | { outcome: "unknown"; result: null; code: string };

/** Parse an `WWW-Authenticate: Bearer resource_metadata="..."` challenge. */
export function resourceMetadataOf(header: string | null): string | null {
  const match = header ? /resource_metadata="([^"]{1,2048})"/i.exec(header) : null;
  return match ? match[1]! : null;
}

/** Bounded event-stream parsing: the JSON payload of every `data:` event, in order. */
export function eventStreamMessages(text: string): unknown[] {
  const out: unknown[] = [];
  for (const block of text.replace(/\r\n?/g, "\n").split("\n\n")) {
    const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    try { out.push(JSON.parse(data)); } catch { /* A malformed event is ignored; the request then has no matching response. */ }
    if (out.length > 1024) break;
  }
  return out;
}

/** One MCP session over the protected network. Auth headers are resolved per request by trusted host code. */
export class McpHttpSession {
  #id = 1;
  #session: string | null = null;
  #protocol = mcpHttpProtocol;
  #closed = false;
  server: { name: string | null; version: string | null; protocol: string | null } = { name: null, version: null, protocol: null };
  private constructor(private readonly network: SourceNetwork, private readonly endpoint: string, private readonly auth: () => Promise<Record<string, string>>) {}

  /** `initialize` then `notifications/initialized`. A 401 throws {@link SourceAuthRequired}. */
  static async open(network: SourceNetwork, endpoint: string, auth: () => Promise<Record<string, string>>, signal?: AbortSignal): Promise<McpHttpSession> {
    const session = new McpHttpSession(network, endpoint, auth);
    const response = await session.#post({ method: "initialize", params: { protocolVersion: mcpHttpProtocol, capabilities: {}, clientInfo: { name: "jit", version: "1" } } }, connectionLimits.requestMs, signal, true);
    const result = session.#result(response.reply) as { protocolVersion?: unknown; serverInfo?: { name?: unknown; version?: unknown } } | null;
    if (!result || typeof result.protocolVersion !== "string" || !supportedProtocols.has(result.protocolVersion)) throw new AppError("source_protocol_unsupported", 502);
    session.#protocol = result.protocolVersion;
    const id = response.headers.get("mcp-session-id");
    if (id !== null) { if (!/^[\x21-\x7e]{1,256}$/.test(id)) throw new AppError("source_protocol_error", 502); session.#session = id; }
    const text = (value: unknown) => typeof value === "string" ? value.slice(0, 128) : null;
    session.server = { name: text(result.serverInfo?.name), version: text(result.serverInfo?.version), protocol: result.protocolVersion };
    await session.#notify("notifications/initialized", signal);
    return session;
  }

  /** Every listed tool within the bounds; `truncated` when the server listed more. */
  async listTools(signal?: AbortSignal): Promise<{ tools: McpHttpTool[]; truncated: boolean }> {
    const tools: McpHttpTool[] = []; let cursor: string | null = null, truncated = false;
    for (let page = 0; ; page++) {
      if (page >= connectionLimits.listPages) { truncated = true; break; }
      const response = await this.#post({ method: "tools/list", params: cursor ? { cursor } : {} }, connectionLimits.requestMs, signal);
      const result = this.#result(response.reply) as { tools?: unknown; nextCursor?: unknown } | null;
      if (!result || !Array.isArray(result.tools)) throw new AppError("source_protocol_error", 502);
      for (const tool of result.tools) { if (tools.length >= connectionLimits.toolsPerSource) { truncated = true; break; } if (tool && typeof tool === "object") tools.push(tool as McpHttpTool); }
      if (truncated || typeof result.nextCursor !== "string" || !result.nextCursor) break;
      cursor = result.nextCursor.slice(0, 1024);
    }
    return { tools, truncated };
  }

  /** One `tools/call` read: any failure throws (reads are never settled as remote effects). */
  async read(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpHttpResult> {
    const response = await this.#post({ method: "tools/call", params: { name, arguments: args } }, connectionLimits.callMs, signal);
    const result = this.#result(response.reply);
    if (!result || typeof result !== "object") throw new AppError("source_protocol_error", 502);
    return result as McpHttpResult;
  }

  /**
   * One effectful `tools/call`, sent at most once. A JSON-RPC error or a 4xx refusal is conclusive (`failed`); a
   * tool result with `isError` is the server's own failed execution (`failed`); anything lost after the request may have
   * been read (timeout, 5xx, broken stream, no matching response) is `unknown` and never retried.
   */
  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallOutcome> {
    let response: { status: number; reply: unknown; headers: Headers };
    try { response = await this.#post({ method: "tools/call", params: { name, arguments: args } }, connectionLimits.callMs, signal); }
    catch (error) {
      const code = error instanceof AppError ? error.code : "source_unreachable";
      // Refused before any byte left (address, endpoint) or conclusively refused by the server.
      if (["source_address_not_public", "source_endpoint_invalid", "source_login_required", "source_forbidden", "source_session_expired", "source_request_refused"].includes(code)) return { outcome: "failed", result: null, code };
      return { outcome: "unknown", result: null, code };
    }
    const reply = response.reply as { result?: unknown; error?: unknown } | null;
    if (reply && typeof reply === "object" && reply.error !== undefined) return { outcome: "failed", result: null, code: "source_tool_error" };
    const result = reply?.result;
    if (!result || typeof result !== "object") return { outcome: "unknown", result: null, code: "source_protocol_error" };
    return { outcome: (result as McpHttpResult).isError === true ? "failed" : "succeeded", result: result as McpHttpResult, code: (result as McpHttpResult).isError === true ? "source_tool_failed" : null };
  }

  /** End the server session (best effort). The identity is forgotten either way. */
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true;
    const session = this.#session; this.#session = null;
    if (!session) return;
    try { await this.network.request(this.endpoint, { method: "DELETE", headers: { ...await this.auth(), "Mcp-Session-Id": session, "MCP-Protocol-Version": this.#protocol }, timeoutMs: 5_000, maxBytes: 4_096 }); } catch { /* The server expires it. */ }
  }

  #result(reply: unknown): unknown {
    const message = reply as { result?: unknown; error?: unknown } | null;
    if (!message || typeof message !== "object") throw new AppError("source_protocol_error", 502);
    if (message.error !== undefined) throw new AppError("source_tool_error", 502);
    return message.result ?? null;
  }

  async #headers(initial: boolean): Promise<Record<string, string>> {
    return { ...await this.auth(), Accept: "application/json, text/event-stream", "Content-Type": "application/json", ...(initial ? {} : { "MCP-Protocol-Version": this.#protocol }), ...(this.#session ? { "Mcp-Session-Id": this.#session } : {}) };
  }

  async #notify(method: string, signal?: AbortSignal): Promise<void> {
    const response = await this.network.request(this.endpoint, { method: "POST", headers: await this.#headers(false), body: JSON.stringify({ jsonrpc: "2.0", method }), ...(signal ? { signal } : {}), timeoutMs: connectionLimits.requestMs, maxBytes: 65_536 });
    if (response.status === 401) throw new SourceAuthRequired(resourceMetadataOf(response.headers.get("www-authenticate")));
    if (response.status >= 400) throw new AppError("source_protocol_error", 502);
  }

  async #post(message: { method: string; params: Record<string, unknown> }, timeoutMs: number, signal: AbortSignal | undefined, initial = false): Promise<{ status: number; reply: unknown; headers: Headers }> {
    if (this.#closed) throw new AppError("source_session_closed", 409);
    const id = this.#id++, body = JSON.stringify({ jsonrpc: "2.0", id, ...message });
    if (Buffer.byteLength(body) > connectionLimits.argumentBytes + 4_096) throw new AppError("source_arguments_too_large");
    const response: SourceResponse = await this.network.request(this.endpoint, { method: "POST", headers: await this.#headers(initial), body, ...(signal ? { signal } : {}), timeoutMs, maxBytes: connectionLimits.responseBytes });
    if (response.status === 401) throw new SourceAuthRequired(resourceMetadataOf(response.headers.get("www-authenticate")));
    if (response.status === 403) throw new AppError("source_forbidden", 403);
    if (response.status === 404 && this.#session) throw new AppError("source_session_expired", 409);
    if (response.status >= 400 && response.status < 500) throw new AppError("source_request_refused", 502);
    if (response.status >= 500) throw new AppError("source_unavailable", 502);
    const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
    let replies: unknown[];
    if (type === "application/json") { try { const parsed: unknown = JSON.parse(response.text); replies = Array.isArray(parsed) ? parsed : [parsed]; } catch { throw new AppError("source_protocol_error", 502); } }
    else if (type === "text/event-stream") replies = eventStreamMessages(response.text);
    else throw new AppError("source_protocol_error", 502);
    const reply = replies.find(item => !!item && typeof item === "object" && (item as { id?: unknown }).id === id && (item as { method?: unknown }).method === undefined);
    if (!reply) throw new AppError("source_protocol_error", 502);
    return { status: response.status, reply, headers: response.headers };
  }
}
