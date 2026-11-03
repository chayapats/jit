import type { ComposedDisclosure } from '../disclosure/composition';
import type { RecipientApproval } from '../disclosure';
import type { Ref } from '../policy';
import { equal } from '../policy/validation';
import { s15GithubRecipient, type GithubConnections } from './connection';

/**
 * GIT15-04 (ADR 0073): every Web-selected repository is a PRIVATE DATA15 source by default, exactly like a configured
 * source, so its content carries lineage. Approvals exist only while the repository is selected and only for the default
 * policy's model provider recipients (work and interpretation purposes) and the GitHub service itself (work purpose).
 * Unselecting removes future approvals; the source stays resolvable and private, so existing lineage is never declassified.
 */
export function webGithubDisclosure(base: ComposedDisclosure, input: { connections(): GithubConnections | undefined; providers(): readonly Ref[]; work: Ref; interpretation: Ref; now(): number }): ComposedDisclosure {
  const sources = () => input.connections()?.sources() ?? [];
  return { ...base,
    catalogs: { ...base.catalogs,
      source: value => input.connections()?.source(value) ?? base.catalogs.source(value),
      approvals: () => [...base.catalogs.approvals(), ...sources().filter(s => s.selected).flatMap(({ source }): RecipientApproval[] => {
        // Re-derived at every check while selected; one day is only the validity of this derivation.
        const scope = { resources: [structuredClone(source.resource)], dataClasses: ['private' as const], sources: [structuredClone(source.ref)], expiresAt: input.now() + 86_400_000 };
        return [...input.providers().flatMap(recipient => [input.work, input.interpretation].map(purpose => ({ recipient: structuredClone(recipient), purpose: structuredClone(purpose), ...scope }))),
          { recipient: { ...s15GithubRecipient }, purpose: structuredClone(input.work), ...scope }];
      })] },
    workSources: work => [...base.workSources(work), ...sources().filter(({ source }) => work.request.resources.some(r => equal(r, source.resource))).map(({ source }) => structuredClone(source.ref))],
  };
}
