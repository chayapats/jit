import { AppError } from "../../errors";
import type { ConversationPolicyWork, ConversationRequest, ConversationToolPort, ConversationTools } from "../../s15/conversation";
import { exact } from "../../s15/conversation/validation";
import type { ConnectionDirectory } from "./service";

/**
 * CONN16-01 chat entry: `propose_connection` lets a Bot suggest connecting GitHub or adding an MCP/OpenAPI/GraphQL source.
 * The result is an inert card in the conversation. It carries no secret (a URL with credentials or a query refuses), it
 * creates and authorizes nothing, and pressing it only opens the owner's protected form on the Connections page, which
 * returns to the same conversation afterwards. Connecting never approves the work that asked for it.
 */
export function createConnectionTools<Owner>(options: { directory: ConnectionDirectory<Owner>; request(workId: string): ConversationRequest }): ConversationToolPort<ConversationPolicyWork> {
  return { async open(work, input): Promise<ConversationTools> {
    input.guard();
    const parent = options.request(work.authority.id);
    if (parent.delegation || parent.fileInputs) return { tools: [], async cancel() {}, async close() {} };
    return { tools: [{ access: "read", definition: {
      name: "propose_connection",
      description: "Suggest that the owner connects an app or tool source. kind is github, mcp (an HTTPS MCP server URL), openapi or graphql (an HTTPS endpoint). This only shows a card the owner presses to open the protected connection form; never ask for or repeat tokens, keys or passwords. Nothing is connected until the owner finishes on that form.",
      inputSchema: { type: "object", additionalProperties: false, required: ["kind"], properties: { kind: { type: "string", enum: ["github", "mcp", "openapi", "graphql"] }, endpoint: { type: "string", maxLength: 2048 }, label: { type: "string", maxLength: 60 } } },
      execution: "exclusive", effect: "read-only",
      async execute(value) {
        input.guard();
        const v = (value ?? {}) as Record<string, unknown>;
        exact(v, Object.keys(v).filter(k => ["kind", "endpoint", "label"].includes(k)));
        if (Object.keys(v).some(k => !["kind", "endpoint", "label"].includes(k))) throw new AppError("invalid_connection_request");
        const card = options.directory.proposeFromChat({ conversationId: parent.receipt.conversationId, requestId: parent.receipt.rootRequestId, kind: v.kind, endpoint: v.endpoint ?? null, label: v.label ?? null });
        input.guard();
        return { content: JSON.stringify({ card: card.id, state: "waiting_for_owner", note: "The owner connects on the card's protected form. Do not say it is connected yet, and never ask for secrets in chat." }) };
      } } }], async cancel() {}, async close() {} };
  } };
}
