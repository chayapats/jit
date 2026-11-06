import { AppError } from '../../errors';
import type { ApprovedModelRoute } from '../model';
import type { CatalogPort, JsonValue, Ref } from '../policy';
import { equal } from '../policy/validation';
import type { ComposedDisclosure } from './composition';
import { googleEffectPeople, googleRecipientRefs } from '../effects/google';
import type { DisclosureSource, RecipientApproval } from './types';

/** Owner-controlled classifications and exact service destinations. This is a proposal/configuration,
 * not authority to install policy or consent. Unknown routes/addresses stay unavailable. */
export interface RuntimeDisclosureConfig {
  sources: DisclosureSource[];
  approvals: RecipientApproval[];
  githubRecipient: Ref | null;
  googleRecipient: Ref | null;
  browser: { origin: string; recipient: Ref; source: Ref }[];
  acquisitions: { origin: string; recipient: Ref }[];
  registries: { hostname: string; recipient: Ref }[];
}

/** Bind serialized configuration to protected owning-service resolvers. Actual Google recipients,
 * browser URL origins and acquisition URLs are resolved before I/O; model text supplies no labels. */
export function runtimeDisclosure(config: RuntimeDisclosureConfig, models: readonly ApprovedModelRoute[], catalogs: CatalogPort, googleRecipients: readonly { ref: Ref; address: string }[] | (() => readonly { ref: Ref; address: string }[]), webGithubRecipient?: Ref,
  /** AUTH16-01: installation-wide remembered recipients (S16-D07 g), merged after the configured approvals. */
  remembered?: () => readonly RecipientApproval[]): ComposedDisclosure {
  const bindings = typeof googleRecipients === 'function' ? googleRecipients : () => googleRecipients;
  // GIT15-04: a Web-connected GitHub account uses its protected service recipient when no GitHub recipient is configured.
  if (!config.githubRecipient && webGithubRecipient) config = { ...config, githubRecipient: webGithubRecipient };
  const origins = [...config.browser, ...config.acquisitions];
  if (origins.some(r => new URL(r.origin).origin !== r.origin) || config.registries.some(r => !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(r.hostname))) throw new AppError('route_unknown');
  const origin = (payload: JsonValue, acquisition = false): string | null => {
    try { const p = payload as { url?: string; request?: { url?: string } }; return new URL((acquisition ? p.request?.url : p.url) ?? '').origin; } catch { return null; }
  };
  return {
    catalogs: {
      source: value => config.sources.find(s => equal(s.ref, value)) ?? null,
      recipient: value => { const current = catalogs.current('recipient', value.id); return current && equal(current.ref, value) ? current : null; },
      approvals: () => remembered ? [...config.approvals, ...remembered()] : config.approvals,
    },
    routes: [
      ...models.map((model, index) => ({ id: `inference_${index}`, kind: 'model' as const, resolve: () => [model.recipient] })),
      ...(config.githubRecipient ? [{ id: 'github', kind: 'adapter' as const, resolve: () => [config.githubRecipient!] }] : []),
      ...(config.googleRecipient ? [{ id: 'google', kind: 'adapter' as const, resolve: (_work: unknown, payload: JsonValue) => {
        // Same derivation and address identity as the Google adapter itself (removed attendees, a
        // non-owner organizer, case-insensitive bindings); any unbound person keeps the route unknown.
        try { return [config.googleRecipient!, ...googleRecipientRefs(googleEffectPeople(payload as unknown as Parameters<typeof googleEffectPeople>[0]), bindings())]; }
        catch { return null; }
      } }] : []),
      { id: 'browser', kind: 'browser', resolve: (_work, payload) => { const binding = config.browser.find(r => r.origin === origin(payload)); return binding ? [binding.recipient] : null; } },
      { id: 'acquisition', kind: 'artifact', resolve: (_work, payload) => { const binding = config.acquisitions.find(r => r.origin === origin(payload, true)); return binding ? [binding.recipient] : null; } },
    ],
    // Availability is live credential state, not part of a route's disclosure identity.
    modelRoute(candidate) { const index = models.findIndex(r => equal({ ...r, availability: candidate.availability }, candidate)); if (index < 0) throw new AppError('route_unknown'); return `inference_${index}`; },
    workSources: work => config.sources.filter(s => work.request.resources.some(r => equal(r, s.resource))).map(s => s.ref),
    ...(config.githubRecipient ? { githubRoute: 'github', githubRecipients: [config.githubRecipient] } : {}), ...(config.googleRecipient ? { googleRoute: 'google' } : {}),
    browserRoute: 'browser', acquisitionRoute: 'acquisition',
    browserSource: (_work, url) => config.browser.find(r => r.origin === new URL(url).origin)?.source ?? null,
    registryRecipient: destination => config.registries.find(r => r.hostname === destination)?.recipient ?? null,
  };
}
