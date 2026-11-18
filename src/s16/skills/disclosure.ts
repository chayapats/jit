import { AppError } from "../../errors";
import type { ComposedDisclosure } from "../../s15/disclosure/composition";
import type { DisclosureSource, RecipientApproval } from "../../s15/disclosure";
import type { Ref, WorkAuthority } from "../../s15/policy";
import { equal } from "../../s15/policy/validation";
import type { SkillDirectory } from "./service";

/** Protected source catalog for current package use and immutable data deliberately released to a VM.
 * Review covers only this package's exact bytes and frozen recipients; no other input obtains consent. */
export function skillDisclosure<Owner>(base: ComposedDisclosure, input: {
  directory(): SkillDirectory<Owner> | undefined; ownerGeneration(): number;
  computer(work: WorkAuthority, vmId: string): { resource: Ref; botId: string | null };
  copyCurrent(vmId: string, resource: Ref): boolean; work: Ref; interpretation: Ref; now(): number;
}): ComposedDisclosure {
  const rows = (): { source: DisclosureSource; recipients: Ref[] }[] => {
    const directory = input.directory(); if (!directory) return [];
    return [
      ...directory.records().filter(record => record.activePin && record.review).map(record => ({ source: {
        ref: record.source, resource: record.resource, classification: "private" as const,
        active: record.ownerGeneration === input.ownerGeneration() && record.state === "active",
        ownerReleasable: true, botIds: record.review!.availability.kind === "team" ? null : record.review!.availability.botIds,
      }, recipients: record.review!.recipients })),
      ...directory.copies().map(copy => ({ source: { ref: copy.ref, resource: copy.resource, classification: "private" as const,
        active: copy.ownerGeneration === input.ownerGeneration() && input.copyCurrent(copy.vmId, copy.resource),
        ownerReleasable: true, botIds: copy.botIds,
      }, recipients: copy.recipients })),
    ];
  };
  return { ...base, catalogs: { ...base.catalogs,
    source(value) { if (/^sk[sv]_/.test(value.id)) return rows().find(row => equal(row.source.ref, value))?.source ?? null; return base.catalogs.source(value); },
    approvals() { return [...base.catalogs.approvals(), ...rows().filter(row => row.source.active).flatMap(({ source, recipients }): RecipientApproval[] =>
      recipients.flatMap(recipient => [input.work, input.interpretation].map(purpose => ({ recipient: structuredClone(recipient), purpose: structuredClone(purpose), resources: [structuredClone(source.resource)], dataClasses: ["private"], sources: [structuredClone(source.ref)], expiresAt: input.now() + 86_400_000 })))
    )]; },
  },
  projectVmInput(work, vmId, source) {
    if (!source.ref.id.startsWith("sks_")) return base.projectVmInput?.(work, vmId, source) ?? source.ref;
    const directory = input.directory(); if (!directory) throw new AppError("skill_unavailable", 409);
    const computer = input.computer(work, vmId); return directory.copy(work, vmId, source.ref, computer.resource, computer.botId);
  } };
}
