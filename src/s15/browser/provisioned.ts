import { join } from 'node:path';
import type { ComposedDisclosure } from '../disclosure/composition';
import type { BudgetVector, CatalogKind, Ref } from '../policy';
import { zero } from '../policy/validation';
import type { S15CompositionOptions } from '../composition';
import { ProtectedChromium, provisionedEngineFactory, type ProtectedChromiumPorts } from './chromium';
import type { BrowserEngine, EngineOptions } from './engine';
import { ApprovedWebsites, approvedWebsitePolicy, withApprovedWebsites } from './sites';

/** The provisioned browser's TEAM resource: one protected browser per S15 installation. */
export const provisionedBrowserResource: Readonly<Ref> = Object.freeze({ id: 'browser', revision: 1, generation: 1 });
/** Per-operation ceiling: one step and one public read, within the broker's 2 MiB response limit. */
export const provisionedBrowserUpperBound: Readonly<BudgetVector> = Object.freeze({ ...zero(), steps: 1, reads: 1, outputBytes: 2_097_152, activeMs: 60_000 });

/** Host-owned parts of the BROW15-02 browser. `close` stops a download and releases the list's lease. */
export interface ProvisionedBrowser {
  chromium: ProtectedChromium; sites: ApprovedWebsites;
  /** Composition registration: static mode, the approved-website semantics and the lazily launched pinned Chromium. */
  options(): NonNullable<S15CompositionOptions['browser']>;
  /** Catalog identities this browser adds: its resource, approved recipients and public website sources. */
  catalog(kind: CatalogKind, id: string): { ref: Ref; active: boolean } | null;
  disclosure(configured: ComposedDisclosure): ComposedDisclosure;
  close(): Promise<void>;
}

/**
 * Opens the protected browser an S15 installation gets without configuration (BROW15-02): the pinned
 * Chromium under `<state>/browser-engine` and the owner's approved-website journal
 * `<state>/browser-sites.sqlite`. Nothing is downloaded until `chromium.start()`; no origin is approved.
 */
export function openProvisionedBrowser(input: { directory: string; installationId: string; ports?: ProtectedChromiumPorts; launch?: (options: EngineOptions) => Promise<BrowserEngine>; now?: () => number }): ProvisionedBrowser {
  const sites = new ApprovedWebsites(join(input.directory, 'browser-sites.sqlite'), input.installationId, input.now ? { now: input.now } : {});
  const chromium = new ProtectedChromium(join(input.directory, 'browser-engine'), input.ports);
  const resource = (): Ref => ({ ...provisionedBrowserResource });
  return {
    chromium, sites,
    options: () => ({ mode: 'static', resource: resource(), fences: [], executablePath: chromium.executablePath, site: approvedWebsitePolicy(sites), upperBound: { ...provisionedBrowserUpperBound },
      factory: provisionedEngineFactory(chromium, input.launch), label: 'Protected browser', approved: { sites, engine: chromium } }),
    catalog: (kind, id) => kind === 'resource' && id === provisionedBrowserResource.id ? { ref: resource(), active: true } : sites.catalog(kind, id),
    disclosure: configured => withApprovedWebsites(configured, sites, resource()),
    async close() { await chromium.close(); sites.close(); },
  };
}
