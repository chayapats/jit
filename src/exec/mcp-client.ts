import { AppError } from "../errors";
import type { BoxStream } from "./box-runtime";

/**
 * The Jit-side MCP client (EXE12, ADR 0038): JSON-RPC 2.0 over the stdio transport of one server process reached
 * through a `podman exec -i` pipe ({@link BoxStream}). Messages are newline-delimited JSON, each at most
 * {@link mcpMessageBytes}; a longer line, malformed JSON or a closed pipe fails every pending request
 * (`mcp_protocol_error`, `mcp_closed`) and closes the client. Every request has a deadline (`mcp_timeout`).
 *
 * The client implements `initialize`, `tools/list` (paginated, bounded to {@link mcpToolLimit} tools) and
 * `tools/call`. Server-to-client requests (sampling, roots, elicitation) are answered "method not found": a server
 * gets nothing from Jit but tool calls. `notifications/tools/list_changed` marks the listing stale, so the gateway
 * re-reads hints before it trusts one again.
 */
export const mcpProtocolVersion = "2025-06-18";
/** Most bytes of one JSON-RPC message in either direction. */
export const mcpMessageBytes = 1_048_576;
/** Most tools one server may list; the rest are ignored. */
export const mcpToolLimit = 128;
/** Most `tools/list` pages read per listing. */
const pageLimit = 16;

/** One tool as listed by the server (untrusted; the gateway bounds and classifies it). */
export interface McpListedTool { name: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } & Record<string, unknown> }
/** One `tools/call` result (untrusted). */
export interface McpCallResult { content: unknown; structuredContent?: unknown; isError?: unknown }

/** Options of {@link McpClient.connect}. */
export interface McpClientOptions { requestMs?: number; callMs?: number; clientVersion?: string }

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

export class McpClient {
  readonly #stream: BoxStream;
  readonly #pending = new Map<number, Pending>();
  readonly #requestMs: number;
  readonly #callMs: number;
  #next = 1;
  #closed = false;
  #failure: AppError | null = null;
  /** True after the server announced `notifications/tools/list_changed` since the last listing. */
  listStale = false;

  private constructor(stream: BoxStream, options: McpClientOptions) {
    this.#stream = stream;
    this.#requestMs = options.requestMs ?? 30_000;
    this.#callMs = options.callMs ?? 120_000;
    void this.#read();
    void stream.exited.then(() => this.#fail(new AppError("mcp_closed", 502)));
  }

  /** Starts the session: `initialize` with no client capabilities, then `notifications/initialized`. */
  static async connect(stream: BoxStream, options: McpClientOptions = {}): Promise<McpClient> {
    const client = new McpClient(stream, options);
    try {
      const result = await client.#request("initialize", {
        protocolVersion: mcpProtocolVersion, capabilities: {}, clientInfo: { name: "jit", version: options.clientVersion ?? "1" },
      }, client.#requestMs) as { protocolVersion?: unknown; capabilities?: { tools?: unknown } } | null;
      if (!result || typeof result !== "object" || typeof result.protocolVersion !== "string") throw new AppError("mcp_protocol_error", 502);
      client.#notify("notifications/initialized");
      return client;
    } catch (error) { client.close(); throw error; }
  }

  get closed(): boolean { return this.#closed; }

  /** Every listed tool (up to {@link mcpToolLimit}), following `nextCursor` for at most 16 pages. Clears `listStale`. */
  async listTools(): Promise<McpListedTool[]> {
    this.listStale = false;
    const tools: McpListedTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < pageLimit && tools.length < mcpToolLimit; page++) {
      const result = await this.#request("tools/list", cursor ? { cursor } : {}, this.#requestMs) as { tools?: unknown; nextCursor?: unknown } | null;
      if (!result || !Array.isArray(result.tools)) throw new AppError("mcp_protocol_error", 502);
      for (const tool of result.tools) if (tool && typeof tool === "object" && tools.length < mcpToolLimit) tools.push(tool as McpListedTool);
      if (typeof result.nextCursor !== "string" || !result.nextCursor) break;
      cursor = result.nextCursor.slice(0, 1024);
    }
    return tools;
  }

  /** One `tools/call`. Aborting `signal` fails the call (`mcp_cancelled`) and notifies the server. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult> {
    const result = await this.#request("tools/call", { name, arguments: args }, this.#callMs, signal) as McpCallResult | null;
    if (!result || typeof result !== "object") throw new AppError("mcp_protocol_error", 502);
    return result;
  }

  /** Fails pending requests and closes the pipe (the server sees EOF). */
  close(): void {
    this.#fail(new AppError("mcp_closed", 502));
  }

  #fail(error: AppError): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#failure = error;
    for (const [id, pending] of this.#pending) { clearTimeout(pending.timer); pending.reject(error); this.#pending.delete(id); }
    this.#stream.close();
  }

  #send(message: Record<string, unknown>): void {
    const bytes = new TextEncoder().encode(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    if (bytes.length > mcpMessageBytes) throw new AppError("mcp_message_too_large", 413);
    this.#stream.write(bytes);
  }

  #notify(method: string, params?: Record<string, unknown>): void {
    if (this.#closed) return;
    try { this.#send({ method, ...(params ? { params } : {}) }); } catch { this.#fail(new AppError("mcp_closed", 502)); }
  }

  #request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#failure ?? new AppError("mcp_closed", 502));
    if (signal?.aborted) return Promise.reject(new AppError("mcp_cancelled", 409));
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const settle = () => { clearTimeout(pending.timer); this.#pending.delete(id); signal?.removeEventListener("abort", onAbort); };
      const onAbort = () => {
        settle();
        this.#notify("notifications/cancelled", { requestId: id, reason: "cancelled by Jit" });
        reject(new AppError("mcp_cancelled", 409));
      };
      const pending: Pending = {
        resolve: value => { settle(); resolve(value); },
        reject: error => { settle(); reject(error); },
        timer: setTimeout(() => {
          settle();
          this.#notify("notifications/cancelled", { requestId: id, reason: "timeout" });
          reject(new AppError("mcp_timeout", 504));
        }, timeoutMs),
      };
      this.#pending.set(id, pending);
      signal?.addEventListener("abort", onAbort, { once: true });
      try { this.#send({ id, method, params }); } catch (error) { pending.reject(error instanceof AppError ? error : new AppError("mcp_closed", 502)); }
    });
  }

  async #read(): Promise<void> {
    let buffer = new Uint8Array(0);
    try {
      for await (const chunk of this.#stream.stdout) {
        if (this.#closed) return;
        const joined = new Uint8Array(buffer.length + chunk.length);
        joined.set(buffer); joined.set(chunk, buffer.length);
        buffer = joined;
        for (let newline = buffer.indexOf(10); newline >= 0; newline = buffer.indexOf(10)) {
          const line = buffer.subarray(0, newline);
          buffer = buffer.slice(newline + 1);
          if (line.length > mcpMessageBytes) return this.#fail(new AppError("mcp_protocol_error", 502));
          const text = new TextDecoder().decode(line).trim();
          if (text) this.#dispatch(text);
          if (this.#closed) return;
        }
        if (buffer.length > mcpMessageBytes) return this.#fail(new AppError("mcp_protocol_error", 502));
      }
    } catch { /* The pipe broke; fall through. */ }
    this.#fail(new AppError("mcp_closed", 502));
  }

  #dispatch(text: string): void {
    let message: Record<string, unknown>;
    try { message = JSON.parse(text) as Record<string, unknown>; } catch { return this.#fail(new AppError("mcp_protocol_error", 502)); }
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") return this.#fail(new AppError("mcp_protocol_error", 502));
    if (typeof message.method === "string") {
      if (message.id !== undefined) {
        // A server request: Jit offers no client capability, so every one is refused.
        try { this.#send({ id: message.id, error: { code: -32601, message: "Method not found" } }); } catch { this.#fail(new AppError("mcp_closed", 502)); }
      } else if (message.method === "notifications/tools/list_changed") this.listStale = true;
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    if (message.error !== undefined) pending.reject(new AppError("mcp_error", 502, { code: typeof (message.error as { code?: unknown })?.code === "number" ? (message.error as { code: number }).code : 0 }));
    else pending.resolve(message.result ?? null);
  }
}
