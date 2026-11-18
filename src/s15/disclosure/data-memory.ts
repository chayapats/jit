import { createHash } from "node:crypto";
import type { DataLineagePort } from "../data-lineage";
import type { ConversationDataMemory } from "../memory/conversation";
import type { S15PolicyService, WorkAuthority } from "../policy";
import type { DisclosureService } from "./types";
import { canonical } from "../policy/validation";

/** Current inference-only standing-resource projection. This does not admit work or create any tool rights. */
export function historyPrivacy(policy: S15PolicyService, work: WorkAuthority): WorkAuthority {
  return work.mode === "interpretation" ? { ...work, request: { ...work.request, resources: policy.control.policyForWork(work.id).resources } } : work;
}
/** Owning DATA15/MEM/TEAM bridge. Claim selection is pure; actual handoffs inherit all uncited original restrictions. */
export function disclosureMemory(policy: S15PolicyService, disclosure: DisclosureService): { lineage: DataLineagePort; conversation: ConversationDataMemory } {
  return {
    lineage: {
      inspect(work, values, history) { const privacy = history ? historyPrivacy(policy, work) : work; let privateData = false; for (const value of values) for (const source of disclosure.ancestry(privacy, value)) if (source.botIds !== undefined && source.botIds !== null) privateData = true; return { private: privateData }; },
      release(actor, values) { for (const value of values) disclosure.inherit(actor, value); },
    },
    conversation: { observed(work, evidence) {
      const sources = disclosure.lineage(work.actor).map(source => source.ref); if (!sources.length) return [];
      // CHAT retains each observation's evidence identity. DATA15 snapshots describe its source ancestry:
      // repeated observations of the same footprint in a work need no additional immutable descendant.
      const ref = { id: "memd_" + createHash("sha256").update(canonical({ workId: work.authority.id, sources })).digest("hex").slice(0, 32), revision: 1, generation: 1 };
      disclosure.derive(work.actor, ref, "text"); return [ref];
    } },
  };
}
