import { AppError } from '../../errors';
import type { ApprovedModelRoute } from '../model';
import type { CatalogPort, JsonValue, Ref } from '../policy';
import { equal } from '../policy/validation';
import type { ComposedDisclosure } from './composition';
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
export function runtimeDisclosure(config: RuntimeDisclosureConfig, models: readonly ApprovedModelRoute[], catalogs: CatalogPort, googleRecipients: readonly { ref: Ref; address: string }[]): ComposedDisclosure {
  const origins = [...config.browser, ...config.acquisitions];
  if (origins.some(r => new URL(r.origin).origin !== r.origin) || config.registries.some(r => !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(r.hostname))) throw new AppError('route_unknown');
  const origin = (payload: JsonValue, acquisition = false): string | null => {
    try { const p = payload as { url?: string; request?: { url?: string } }; return new URL((acquisition ? p.request?.url : p.url) ?? '').origin; } catch { return null; }
  };
  return {
    catalogs: {
      source: value => config.sources.find(s => equal(s.ref, value)) ?? null,
      recipient: value => { const current = catalogs.current('recipient', value.id); return current && equal(current.ref, value) ? current : null; },
      approvals: () => config.approvals,
    },
    routes: [
      ...models.map((model, index) => ({ id: `inference_${index}`, kind: 'model' as const, resolve: () => [model.recipient] })),
      ...(config.githubRecipient ? [{ id: 'github', kind: 'adapter' as const, resolve: () => [config.githubRecipient!] }] : []),
      ...(config.googleRecipient ? [{ id: 'google', kind: 'adapter' as const, resolve: (_work: unknown, payload: JsonValue) => {
        const p = payload as { message?: { to: string[]; cc: string[]; bcc: string[] }; calendar?: { event: { attendees: string[] } } };
        const addresses = p.message ? [...p.message.to, ...p.message.cc, ...p.message.bcc] : p.calendar?.event.attendees ?? [];
        const recipients = addresses.map(address => googleRecipients.find(r => r.address === address)?.ref);
        return recipients.some(r => !r) ? null : [config.googleRecipient!, ...recipients as Ref[]];
      } }] : []),
      { id: 'browser', kind: 'browser', resolve: (_work, payload) => { const binding = config.browser.find(r => r.origin === origin(payload)); return binding ? [binding.recipient] : null; } },
      { id: 'acquisition', kind: 'artifact', resolve: (_work, payload) => { const binding = config.acquisitions.find(r => r.origin === origin(payload, true)); return binding ? [binding.recipient] : null; } },
    ],
    modelRoute(candidate) { const index = models.findIndex(r => equal(r, candidate)); if (index < 0) throw new AppError('route_unknown'); return `inference_${index}`; },
    workSources: work => config.sources.filter(s => work.request.resources.some(r => equal(r, s.resource))).map(s => s.ref),
    ...(config.githubRecipient ? { githubRoute: 'github', githubRecipients: [config.githubRecipient] } : {}), ...(config.googleRecipient ? { googleRoute: 'google' } : {}),
    browserRoute: 'browser', acquisitionRoute: 'acquisition',
    browserSource: (_work, url) => config.browser.find(r => r.origin === new URL(url).origin)?.source ?? null,
    registryRecipient: destination => config.registries.find(r => r.hostname === destination)?.recipient ?? null,
  };
}
