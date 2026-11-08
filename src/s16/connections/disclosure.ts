import type { ComposedDisclosure } from "../../s15/disclosure/composition";
import type { DisclosureSource, RecipientApproval } from "../../s15/disclosure";
import type { JsonValue, Ref } from "../../s15/policy";
import { equal } from "../../s15/policy/validation";
import type { SourceRecord } from "./types";

/** DATA15 route of connected-source reads and calls. */
export const sourceRoute = "s16_sources";

/**
 * CONN16-01 DATA15 binding (ADR 0089). Everything read from a connected source is a PRIVATE source of that service, so
 * it carries lineage. While a source is reviewed and not removed, approvals exist only for the approved model providers
 * (work and interpretation purposes) and the source's own service recipient (work purpose). Sending any other private
 * data to a source (for example a private repository's content) is therefore a first disclosure to a new recipient: a
 * call holds as an exact card, and a read refuses. Removal keeps the source resolvable and private; lineage is never
 * declassified.
 */
export function sourceDisclosure(base: ComposedDisclosure, input: { records(): readonly SourceRecord[]; record(id: string): SourceRecord | null; providers(): readonly Ref[]; work: Ref; interpretation: Ref; now(): number }): ComposedDisclosure {
  const row = (record: SourceRecord): DisclosureSource => ({ ref: structuredClone(record.source), resource: structuredClone(record.resource), classification: "private", active: true, ownerReleasable: true });
  return { ...base,
    catalogs: { ...base.catalogs,
      source: value => { const record = input.records().find(r => r.source.id === value.id); return record ? (equal(record.source, value) ? row(record) : null) : base.catalogs.source(value); },
      approvals: () => [...base.catalogs.approvals(), ...input.records().filter(r => r.review !== null && r.state !== "removed").flatMap((record): RecipientApproval[] => {
        // Re-derived at every check while connected; one day is only the validity of this derivation.
        const scope = { resources: [structuredClone(record.resource)], dataClasses: ["private" as const], sources: [structuredClone(record.source)], expiresAt: input.now() + 86_400_000 };
        return [...input.providers().flatMap(recipient => [input.work, input.interpretation].map(purpose => ({ recipient: structuredClone(recipient), purpose: structuredClone(purpose), ...scope }))),
          { recipient: structuredClone(record.recipient), purpose: structuredClone(input.work), ...scope }];
      })] },
    routes: [...base.routes, { id: sourceRoute, kind: "adapter", resolve: (_work, payload: JsonValue) => {
      const id = payload && typeof payload === "object" && !Array.isArray(payload) && typeof payload.source === "string" ? payload.source : null;
      const record = id ? input.record(id) : null;
      return record && record.state !== "removed" ? [structuredClone(record.recipient)] : null;
    } }],
    workSources: work => [...base.workSources(work), ...input.records().filter(record => work.request.resources.some(r => equal(r, record.resource))).map(record => structuredClone(record.source))],
  };
}
