import type { ClientRequest } from "../client";
import type { MobileCommands, MobilePending } from "./commands";
import { checkMobileIntent, MobileIntentError, type MobileDrafts, type MobileIntent } from "./drafts";

/**
 * Read the original receipt under the current composer binding, without replaying a command.
 * Confirmed messages clear their composer; decision recovery preserves unrelated text and upload chips.
 */
export async function recoverMobileCommand(commands: MobileCommands, drafts: MobileDrafts, intent: MobileIntent, entry: MobilePending): Promise<ClientRequest> {
  checkMobileIntent(intent);
  if (entry.sessionScope !== intent.scope || entry.conversationId !== intent.conversationId) throw new MobileIntentError("mobile_binding_changed");
  const result = await commands.recover(entry);
  checkMobileIntent(intent);
  if (entry.kind === "message") drafts.change(intent, () => ({ text: "", files: [] }));
  return result;
}
