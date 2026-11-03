import type { ApprovedModelRoute } from '../model';
import type { Ref, WorkAuthority } from '../policy';
import type { DisclosureOptions } from './types';

/** Protected route/source bindings for the composition root. No function or registration comes from a model. */
export interface ComposedDisclosure extends Omit<DisclosureOptions, 'runtime' | 'path' | 'create' | 'installationId'> {
  modelRoute(candidate: ApprovedModelRoute): string;
  workSources(work: WorkAuthority): readonly Ref[];
  browserRoute?: string;
  googleRoute?: string;
  githubRoute?: string;
  /** Fixed service destinations covered by an explicit personal GitHub profile; DATA still checks each exact action. */
  githubRecipients?: readonly Ref[];
  acquisitionRoute?: string;
  adapterRoutes?: Readonly<Record<string, string>>;
}
