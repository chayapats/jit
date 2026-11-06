import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DurableJournal } from '../durable-journal';
import type { ComposedDisclosure } from '../disclosure/composition';
import type { DisclosureSource } from '../disclosure';
import type { CatalogKind, JsonValue, Ref } from '../policy';
import { PolicyError } from '../policy';
import type { BrowserSitePolicy } from './types';
import { BrowserError } from './validation';

/** At most this many websites are approved at once (`website_list_full`; removing one frees a place). */
export const approvedWebsiteLimit = 200;
/**
 * At most this many different origins are ever approved in one journal (`website_history_full`). A removed
 * website keeps its record, because its recipient revision and lineage source must stay resolvable, so
 * removing does not free a place here; re-adding a website approved before needs no new place.
 */
export const approvedWebsiteHistoryLimit = 500;
/**
 * Website trust tier (S16-D09, ADR 0084). `sensitive` (the default) keeps the site's session in the protected browser
 * outside the working VM behind request mediation; `trusted` ("use freely") means the Bot uses the site in the working
 * VM browser, where a session it signs into lives in the VM profile and is not bypass-resistant (accepted residual).
 */
export type WebsiteTier = 'trusted' | 'sensitive';
/** One owner-approved HTTPS origin the protected browser may read. `revision` advances on every re-approval or tier change. */
export interface ApprovedWebsite { origin: string; revision: number; addedAt: number; tier: WebsiteTier }

/** Identity providers, primary email, banking and payment hosts: always sensitive, never usable freely in the VM. */
const sensitiveOnlyHosts = ['accounts.google.com', 'mail.google.com', 'myaccount.google.com', 'pay.google.com', 'login.microsoftonline.com', 'login.live.com', 'account.microsoft.com', 'outlook.live.com', 'outlook.office.com', 'appleid.apple.com', 'icloud.com', 'paypal.com', 'stripe.com', 'wise.com', 'revolut.com', 'id.me', 'okta.com', 'auth0.com', 'login.yahoo.com', 'mail.yahoo.com', 'proton.me', 'github.com'];
/** True for a site that must stay in the protected browser whatever the owner marks (`website_sensitive_only`). */
export function websiteSensitiveOnly(origin: string): boolean {
  let host: string; try { host = new URL(origin).hostname; } catch { return true; }
  return sensitiveOnlyHosts.some(h => host === h || host.endsWith(`.${h}`)) || host.split('.').some(label => /bank|banking|wallet|payment|pay$/.test(label) && label !== 'paysite') || /^(?:login|signin|sso|auth|id|accounts?)\./.test(host);
}

// Reserved, special-use and conventional private DNS names (RFC 2606/6761/6762/8375 and common LAN suffixes).
const nonPublicSuffixes = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'private', 'test', 'example', 'invalid', 'onion', 'arpa', 'alt'];

/**
 * Normalizes an owner's entry to one exact public HTTPS origin, or refuses with a stable code. A pasted
 * page link keeps only its origin; a bare name gets `https://`. Refused: `http:` (`website_https_required`),
 * IP literals, single-label, reserved and private names (`website_not_public`), anything else that is not a
 * plain public host name (`website_invalid`). DNS is not consulted here.
 */
export function approvedWebsiteOrigin(input: unknown): string {
  if (typeof input !== 'string') throw new BrowserError('website_invalid');
  const text = input.trim();
  if (!text || Buffer.byteLength(text) > 2048 || /[\x00-\x20\x7f]/.test(text)) throw new BrowserError('website_invalid');
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`); } catch { throw new BrowserError('website_invalid'); }
  if (url.protocol === 'http:') throw new BrowserError('website_https_required');
  if (url.protocol !== 'https:' || url.username || url.password) throw new BrowserError('website_invalid');
  const host = url.hostname;
  if (host.startsWith('[') || /^[0-9.]+$/.test(host)) throw new BrowserError('website_not_public');
  const labels = host.split('.');
  if (host.length > 253 || labels.some(label => !/^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(label))) throw new BrowserError('website_invalid');
  if (labels.length < 2 || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1)!) || nonPublicSuffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) throw new BrowserError('website_not_public');
  return url.origin;
}

const digest = (origin: string) => createHash('sha256').update(`s15.browser.website.v1\0${origin}`).digest('hex');
interface SiteRecord { kind: 'site'; origin: string; revision: number; active: boolean; addedAt: number; changedAt: number; tier?: WebsiteTier }
interface MetaRecord { kind: 'meta'; epoch: string }

/**
 * Protected owner list of websites the S15 browser may read (BROW15-02), in its own durable journal with an
 * exclusive process lease. It is not configuration and never comes from a model, a page or a working VM.
 * Every approved origin derives two catalog identities: a recipient (`web_…`, revision = approval revision,
 * active only while approved) that disclosure resolves for each request, and a stable public source
 * (`websrc_…`, revision 1, always active) for lineage of pages already read, so removing a website never
 * withdraws lineage that later work still carries. A missing journal opens empty, which only narrows access.
 */
export class ApprovedWebsites {
  readonly #journal: DurableJournal;
  readonly #epoch: string;
  readonly #now: () => number;
  #cache = new Map<string, SiteRecord>();
  constructor(path: string, installationId: string, options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#journal = new DurableJournal(path, installationId, !existsSync(path), 0x4a425135, { records: 512, bytes: 64 * 1_048_576 });
    try {
      const rows = this.#journal.all<SiteRecord | MetaRecord>();
      let meta = rows.find((row): row is MetaRecord => row.kind === 'meta');
      // A crash right after creating the journal leaves it without identity; an empty list can only narrow access.
      if (!meta && !rows.length) { meta = { kind: 'meta', epoch: randomBytes(8).toString('hex') }; const record = meta; this.#journal.tx(() => this.#journal.put('meta', record)); }
      if (!meta || !/^[a-f0-9]{16}$/.test(meta.epoch)) throw new BrowserError('continuity_unavailable');
      this.#epoch = meta.epoch;
      for (const row of rows) if (row.kind === 'site') this.#cache.set(row.origin, row);
    } catch (error) { this.#journal.close(); throw error; }
  }
  /** Currently approved websites, sorted by origin. */
  list(): ApprovedWebsite[] {
    return [...this.#cache.values()].filter(r => r.active).sort((a, b) => a.origin.localeCompare(b.origin)).map(r => ({ origin: r.origin, revision: r.revision, addedAt: r.addedAt, tier: r.tier ?? 'sensitive' }));
  }
  current(origin: string): ApprovedWebsite | null { const r = this.#cache.get(origin); return r?.active ? { origin: r.origin, revision: r.revision, addedAt: r.addedAt, tier: r.tier ?? 'sensitive' } : null; }
  /** Request-time tier of an exact approved origin; unknown or removed origins are sensitive. */
  tier(origin: string): WebsiteTier { const r = this.#cache.get(origin); return r?.active && r.tier === 'trusted' ? 'trusted' : 'sensitive'; }
  /**
   * Owner marks exactly the approval revision they saw as trusted or sensitive. Identity, email, banking and payment
   * sites refuse `trusted` with `website_sensitive_only`; a changed approval refuses with `website_changed`.
   */
  setTier(origin: unknown, revision: number, tier: WebsiteTier): ApprovedWebsite {
    if (typeof origin !== 'string' || approvedWebsiteOrigin(origin) !== origin || !Number.isSafeInteger(revision) || revision < 1 || (tier !== 'trusted' && tier !== 'sensitive')) throw new BrowserError('website_invalid');
    if (tier === 'trusted' && websiteSensitiveOnly(origin)) throw new BrowserError('website_sensitive_only');
    const record = this.#write(() => {
      const old = this.#cache.get(origin); if (!old?.active || old.revision !== revision) throw new BrowserError('website_changed');
      if ((old.tier ?? 'sensitive') === tier) return old;
      const next: SiteRecord = { ...old, tier, revision: old.revision + 1, changedAt: this.#now() }; this.#journal.put(this.#key(origin), next); return next;
    });
    return { origin: record.origin, revision: record.revision, addedAt: record.addedAt, tier: record.tier ?? 'sensitive' };
  }
  /** Request-time check: an exact origin string, so `http:` or another port never matches an HTTPS approval. */
  allows(origin: string): boolean { return !!this.#cache.get(origin)?.active; }
  /** Approves one website. Re-adding an approved website changes nothing and returns it. */
  add(input: unknown): ApprovedWebsite {
    const origin = approvedWebsiteOrigin(input);
    const record = this.#write(() => {
      const old = this.#cache.get(origin); if (old?.active) return old;
      if ([...this.#cache.values()].filter(r => r.active).length >= approvedWebsiteLimit) throw new BrowserError('website_list_full');
      if (!old && this.#cache.size >= approvedWebsiteHistoryLimit) throw new BrowserError('website_history_full');
      const now = this.#now(), next: SiteRecord = { kind: 'site', origin, revision: (old?.revision ?? 0) + 1, active: true, addedAt: now, changedAt: now, tier: 'sensitive' };
      this.#journal.put(this.#key(origin), next); return next;
    });
    return { origin: record.origin, revision: record.revision, addedAt: record.addedAt, tier: record.tier ?? 'sensitive' };
  }
  /** Removes exactly the approval revision the owner saw; a changed or absent approval refuses with `website_changed`. */
  remove(origin: unknown, revision: number): void {
    if (typeof origin !== 'string' || approvedWebsiteOrigin(origin) !== origin || !Number.isSafeInteger(revision) || revision < 1) throw new BrowserError('website_invalid');
    this.#write(() => {
      const old = this.#cache.get(origin); if (!old?.active || old.revision !== revision) throw new BrowserError('website_changed');
      const next: SiteRecord = { ...old, active: false, changedAt: this.#now() }; this.#journal.put(this.#key(origin), next); return next;
    });
  }
  /** Disclosure recipient of a request URL's origin while that origin is approved. */
  recipient(url: string): Ref | null {
    const origin = originOf(url), r = origin ? this.#cache.get(origin) : undefined;
    return r?.active ? { id: `web_${this.#epoch}_${digest(r.origin).slice(0, 24)}`, revision: r.revision, generation: 1 } : null;
  }
  /** Stable public lineage source of any website ever approved (pages read before a removal keep their lineage). */
  source(url: string): Ref | null {
    const origin = originOf(url), r = origin ? this.#cache.get(origin) : undefined;
    return r ? { id: `websrc_${this.#epoch}_${digest(r.origin).slice(0, 24)}`, revision: 1, generation: 1 } : null;
  }
  /** Policy/disclosure catalog lookups for the derived identities; unknown kinds and ids are null. */
  catalog(kind: CatalogKind, id: string): { ref: Ref; active: boolean } | null {
    const prefix = kind === 'recipient' ? `web_${this.#epoch}_` : kind === 'lineage' ? `websrc_${this.#epoch}_` : null;
    if (!prefix || !id.startsWith(prefix)) return null;
    for (const r of this.#cache.values()) {
      if (`${prefix}${digest(r.origin).slice(0, 24)}` !== id) continue;
      return kind === 'recipient' ? { ref: { id, revision: r.revision, generation: 1 }, active: r.active } : { ref: { id, revision: 1, generation: 1 }, active: true };
    }
    return null;
  }
  /** DATA15 source record: public content of an approved website, read through the protected browser resource. */
  disclosureSource(value: Ref, resource: Ref): DisclosureSource | null {
    const current = this.catalog('lineage', value.id);
    return current ? { ref: current.ref, resource: structuredClone(resource), classification: 'public', active: true, ownerReleasable: true } : null;
  }
  close(): void { this.#journal.close(); }
  #key(origin: string): string { return `site_${digest(origin).slice(0, 40)}`; }
  #write(change: () => SiteRecord): SiteRecord {
    let record: SiteRecord;
    try { record = this.#journal.tx(change); }
    // The journal's own record bound is the same lifetime limit, never something a removal could fix.
    catch (error) { if (error instanceof PolicyError && error.code === 'continuity_capacity') throw new BrowserError('website_history_full'); throw error; }
    this.#cache.set(record.origin, record); return record;
  }
}

function originOf(url: string): string | null { try { return new URL(url).origin; } catch { return null; } }

/**
 * Request-time site semantics for the provisioned browser. Only credential-free GET navigations without a
 * query or body to a currently approved origin are public reads, exactly as for configured origins; any
 * other request to an approved origin stays unknown (refused). Any request to an unlisted origin refuses
 * with `website_not_approved`, which the owner resolves by adding the website, never by approving a page.
 * There are no sign-in documents or session observations: signing in needs configured protected semantics.
 * A site the owner marked trusted refuses with `website_trusted_vm`: the Bot uses it in the working VM browser.
 */
export function approvedWebsitePolicy(sites: Pick<ApprovedWebsites, 'allows'> & Partial<Pick<ApprovedWebsites, 'tier'>>): BrowserSitePolicy {
  // S16-D09: a trusted site is used in the working VM browser, so the protected browser never accumulates its session.
  const protectedSite = (origin: string) => sites.allows(origin) && sites.tier?.(origin) !== 'trusted';
  return {
    loginDocuments: [], session: null,
    observable: url => { const origin = originOf(url); return !!origin && protectedSite(origin); },
    classify(request) {
      let url: URL; try { url = new URL(request.url); } catch { return null; }
      if (sites.tier?.(url.origin) === 'trusted') return { kind: 'unsupported', code: 'website_trusted_vm' };
      if (!sites.allows(url.origin)) return { kind: 'unsupported', code: 'website_not_approved' };
      return request.method === 'GET' && request.navigation && !request.bodyBase64 && !url.search ? { kind: 'read', private: false } : null;
    },
  };
}

/**
 * Extends configured disclosure with the approved websites: the browser route resolves an approved
 * origin's recipient, and browser lineage resolves its public source. Configured bindings keep priority.
 * An unlisted origin still resolves to no recipient, so disclosure refuses before any DNS or send.
 */
export function withApprovedWebsites(disclosure: ComposedDisclosure, sites: Pick<ApprovedWebsites, 'recipient' | 'source' | 'catalog' | 'disclosureSource'>, resource: Ref): ComposedDisclosure {
  const route = disclosure.browserRoute;
  const url = (payload: JsonValue) => { const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.url : null; return typeof value === 'string' ? value : null; };
  return {
    ...disclosure,
    catalogs: { ...disclosure.catalogs, source: value => disclosure.catalogs.source(value) ?? sites.disclosureSource(value, resource), recipient: value => disclosure.catalogs.recipient(value) ?? sites.catalog('recipient', value.id) },
    routes: disclosure.routes.map(r => r.id !== route ? r : { ...r, resolve: (work, payload) => { const configured = r.resolve(work, payload); if (configured) return configured; const target = url(payload), recipient = target ? sites.recipient(target) : null; return recipient ? [recipient] : null; } }),
    browserSource: (work, value, format) => disclosure.browserSource?.(work, value, format) ?? sites.source(value),
  };
}
