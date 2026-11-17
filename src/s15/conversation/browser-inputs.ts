import type { ModelStreamEvent, ToolDefinition } from "schway/host";

/**
 * Native Schway history is exact. Replace browser input bytes BEFORE the assistant entry reaches it, then
 * hydrate only at the trusted tool boundary. The model sees its opaque receipt on subsequent turns, not an echo.
 * No upstream/private API, alternate loop, durable vault or retry is involved.
 */
export function transientBrowserInputs(definitions: readonly ToolDefinition[]): { definitions: readonly ToolDefinition[]; event(event: ModelStreamEvent): ModelStreamEvent; clear(): void } {
  const values = new Map<string, string>();
  return {
    definitions: definitions.map(d => d.name !== "computer_browser" ? d : { ...d, async execute(value, context) {
      const v = value as Record<string, unknown> | null;
      if (v && ["type", "select"].includes(String(v.kind))) {
        const token = String(v.value), text = values.get(token); values.delete(token);
        if (text === undefined) return { content: JSON.stringify({ state: "denied", code: "computer_browser_operation_invalid" }), isError: true };
        return d.execute({ ...v, value: text }, context);
      }
      return d.execute(value, context);
    } }),
    event(event) {
      if (event.type !== "message_complete") return event;
      return { ...event, message: { ...event.message, content: event.message.content.map(part => {
        if (part.type !== "tool_call" || part.name !== "computer_browser" || !part.arguments || typeof part.arguments !== "object") return part;
        const args = part.arguments as Record<string, unknown>;
        if (!["type", "select"].includes(String(args.kind)) || typeof args.value !== "string") return part;
        const token = `browser_input_${crypto.randomUUID().replaceAll("-", "")}`;
        if (values.size < 64 && Buffer.byteLength(args.value) <= 4096) values.set(token, args.value);
        const { providerMetadata: _metadata, ...safe } = part;
        return { ...safe, arguments: { ...args, value: token } };
      }) } };
    },
    clear() { values.clear(); },
  };
}
