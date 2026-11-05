import { AppError } from "../../errors";
import type { ConversationIntent, ConversationScope } from "./types";
import { exact, identity, parseCommandJson } from "./validation";
import { groundConversationIntent } from "./intent";

/**
 * Validates a tool-free interpreter proposal against the preapproved catalog, then takes the narrower
 * deterministic/original-byte ceiling. This never installs policy or approves an effect. The returned
 * purpose/resources/access are frozen before any retrieval/tool and cannot be changed by the work loop.
 */
export function freezeInterpretation(raw: string, grounded: ConversationIntent, catalog: { purposes: readonly string[]; resources: readonly string[]; selectedSubjects?: readonly string[]; fileOutput?: boolean }): ConversationIntent {
  const proposal = parseCommandJson(raw);
  exact(proposal, ["intent", "purposeId", "resourceIds", "access", "subject"]);
  if (!["answer", "accept", "inspect", "execute", "ambiguous"].includes(proposal.intent as string) || !["read", "reversible_write", "effect"].includes(proposal.access as string)) throw new AppError("outside_scope");
  identity(proposal.purposeId);
  if (!catalog.purposes.includes(proposal.purposeId) || !Array.isArray(proposal.resourceIds) || proposal.resourceIds.length > 64 || new Set(proposal.resourceIds).size !== proposal.resourceIds.length) throw new AppError("outside_scope");
  for (const resource of proposal.resourceIds) { identity(resource); if (!catalog.resources.includes(resource)) throw new AppError("outside_scope"); }
  if (proposal.subject !== null && (typeof proposal.subject !== "string" || !/^issue:[1-9]\d{0,12}$/.test(proposal.subject))) throw new AppError("material_ambiguity");
  let kind = proposal.intent as ConversationIntent["kind"];
  if (grounded.kind === "answer") kind = "answer";
  if (grounded.kind === "accept" || proposal.intent === "accept") kind = "accept";
  if (grounded.kind === "inspect" && kind === "execute") kind = "inspect";
  const explicitIssues = [...new Set([...grounded.instruction.replace(/"[^"\n]*"|`[^`]*`|^\s*>.*$/gm, " ").matchAll(/(?:issue\s*|#)(\d+)/gi)].map(match => `issue:${match[1]}`))];
  if (explicitIssues.length > 1 && grounded.kind === "ambiguous") kind = "ambiguous";
  // Re-ground retained original bytes too: requests persisted before hold metadata existed are safe.
  const hold = grounded.hold ?? groundConversationIntent(grounded.instruction, { fileOutput: catalog.fileOutput === true }).hold;
  if (hold) kind = "inspect";
  if (grounded.subject && proposal.subject && grounded.subject !== proposal.subject) throw new AppError("outside_scope");
  if (explicitIssues.length === 0 && proposal.subject && !catalog.selectedSubjects?.includes(proposal.subject)) throw new AppError("material_ambiguity");
  const scope: ConversationScope = { purposeId: proposal.purposeId, resourceIds: [...proposal.resourceIds] as string[], access: kind === "execute" ? proposal.access as ConversationScope["access"] : "read" };
  return { kind, instruction: grounded.instruction, subject: grounded.subject ?? proposal.subject as string | null, scope, ...(hold ? { hold } : {}) };
}
