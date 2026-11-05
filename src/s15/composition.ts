import { fsyncSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { createS16ClientHandler } from '../s16/http';
import { createS16WebHandler } from '../s16/web/handler';
import { FileStore } from '../s16/files/store';
import { createFileWorkflow } from '../s16/files/workflow';
import type { FileLimits } from '../s16/files/types';
import { createHostCredentialLifecycle, type HostAuthFetch, type HostClock, type HostCredentialStore, type Model } from 'schway/host';
import { AppError } from '../errors';
import { openPolicyService, type ActionAdapter, type AuthenticatedOwner, type CatalogPort, type OwnerActor, type PolicyInput, type ReadHandler, type Ref, type S15PolicyService, type SubscriptionModels, type WorkActor } from './policy';
import { canonical, equal, unknownUsage } from './policy/validation';
import { ConversationApplication, ConversationStore, createConversationHandler, createConversationPolicy, createConversationVmTools, type ConversationPolicyWork, type ConversationToolPort } from './conversation';
import { WorkingVmService, VmEnrollment, VmManagers, VmPolicyIntegration, VmPool, VmStore, LocalVmProvisioning, createVmApi, isVmLocalManagement, placeWorkingVm, probeLocalVmHost, startLocalVmControl, type LocalVmControlOptions, type WorkingVmOptions } from './vm';
import { registerProtectedBrowser, type BrowserOptions, type BrowserRegistration } from './browser';
import type { BrowserEngine, EngineOptions } from './browser/engine';
import type { ApprovedWebsites } from './browser/sites';
import type { ProtectedChromium } from './browser/chromium';
import { createEffectsConversationTools, registerGoogleEffects, type GoogleEffectsOptions } from './effects';
import { closeCredentialLifecycle, openModelService, createModelProjectionHandler, type ModelOptions } from './model';
import { openWorkService, openResumeBindings, createResponsibilityProjectionHandler, type ResumeOwnerSnapshot, type WorkOptions } from './work';
import { openTelegramChannel, type TelegramLimits, type TelegramTransport } from './telegram';
import { GithubService, GithubStore, createGithubActionAdapter, createGithubConversationTools, createGithubHandler, githubReadHandler, type GithubLimits, type GithubRepository, type GithubWorkspace, type ProtectedGithubGateway } from './github';
import { GithubConnections, s15GithubRecipient } from './github/connection';
import { webGithubDisclosure } from './github/disclosure';
import { s15DefaultPolicy, s15DefaultRefs, s15NeedsBudget, s15SamePolicyScope, s15MeteredBudget, S15_DEFAULT_POLICY_LIFETIME_MS, S15_POLICY_RENEW_WINDOW_MS, s15BudgetPeriods, s15HeldClasses, type DefaultResource, type DefaultSelection } from './policy/defaults';
import { openDisclosureService } from './disclosure';
import { createRecurringRules, type RecurringRuleOptions } from './policy/recurring';
import type { ComposedDisclosure } from './disclosure/composition';
import { TeamService, teamCandidatesHash, type DataScope, type TeamOptions, type TeamResource } from './team';
import { coordinateWorkingVm, reconcileVmLeases } from './team/vm';
import { MemoryService, createConversationMemory } from './memory';
import { createS15WebHandler, s15ConversationPort, s15ActionsPort, s15DutiesPort, s15RecurringPort, s15TeamPort, s15ReadinessFromGithub, s15AdoptionPort, type S15WebPorts } from './web';

/** Existing protected owner service. Proofs are process-local actors, never JSON/VM bearer credentials. */
export interface S15OwnerAuthentication {
  authenticate(token: string): { proof: unknown; csrf: string };
  verifyOwner(proof: unknown): AuthenticatedOwner | null;
  generation(): number;
  verifyCsrf(expected: string, supplied: unknown): void;
}
/** Explicit host composition. All callable dependencies are trusted service code; none is selected by a model. */
export interface S15CompositionOptions {
  runtime: 's15'; directory: string; create: boolean; installationId: string; origin: string;
  owner: S15OwnerAuthentication; catalogs: CatalogPort;
  conversation: Omit<Parameters<typeof createConversationPolicy>[1], 'ownerGeneration'>;
  model: Pick<ModelOptions, 'registry' | 'limits' | 'scripted'>;
  disclosure?: ComposedDisclosure;
  /** Explicit S16 file byte custody; requires DATA15. Does not change installed standing rules. */
  files?: { limits?: FileLimits };
  recurring?: RecurringRuleOptions;
  /** Selected host transition. Status is read-only; its activity guard fences work and records released
   * activity durably. Composition cannot activate/release or import old authority through this port. */
  adoption?: { service: Pick<import('./adoption').AdoptionService, 'status' | 'guardActivity'>; authenticate(owner: OwnerActor): import('./adoption').AdoptionOwner };
  interpreter?: Model; clock?: HostClock; subscriptionModels?: SubscriptionModels;
  /** Deterministic credential-store and transport seam for every composed route host; production omits it
   * (OS secure store, global fetch). Composition owns the one credential lifecycle built over it. */
  credentials?: { store?: HostCredentialStore; fetch?: HostAuthFetch };
  /** A proposal is displayed for authenticated installation; constructing a service never installs it. */
  proposedPolicy: PolicyInput | null;
  vm: { id: string; resource: Ref; managers: WorkingVmOptions['managers']; managementVault?: import('../exec/connections').ConnectionVault; upperBound: VmPolicyIntegration['options']['upperBound']; destination: VmPolicyIntegration['options']['destination']; transport?: WorkingVmOptions['transport']; limits?: WorkingVmOptions['limits']; enrollmentRun?: ConstructorParameters<typeof VmEnrollment>[0]['run'];
    /** Jit-managed nested KVM working VMs on this host (requires `managementVault`); state defaults to `<directory>/vm-local` and must stay within 64 characters. */
    local?: Omit<LocalVmControlOptions, 'directory'> & { directory?: string } };
  browser?: Omit<BrowserOptions, 'runtime' | 'continuity' | 'profilePath'> & { factory?: (input: EngineOptions) => Promise<BrowserEngine>; ownerUi?: Omit<import('./web').S15WebBrowser<OwnerActor>, 'owner'>;
    /** TEAM resource label; defaults to the sign-in site label or the resource id. */
    label?: string;
    /**
     * BROW15-02 provisioned browser: the owner's protected approved-website list and the pinned Chromium
     * status, exposed only through the owner-verified Resources → Websites port. An installation composed
     * before its browser existed gains a fresh `browser.sqlite` once, with no other store change.
     */
    approved?: { sites: Pick<ApprovedWebsites, 'list' | 'add' | 'remove'>; engine: Pick<ProtectedChromium, 'status' | 'retry'> } };
  google?: GoogleEffectsOptions;
  github?: { repositories: readonly GithubRepository[]; gateway: ProtectedGithubGateway; limits: GithubLimits; catalogPurpose?: Ref; workspace(input: { policy: S15PolicyService; vm: import('./vm').WorkingVmPort; disclosure?: import('./disclosure').DisclosureService; guardModel?(work: import('./policy').WorkAuthority, request: unknown): void; beforeRead?(work: import('./policy').WorkAuthority, payload: import('./policy').JsonValue): void; recordRead?(actor: import('./policy').WorkActor): void; routeAuth?: { lifecycle: import('schway/host').HostCredentialLifecycle; fetch?: HostAuthFetch } }): GithubWorkspace };
  /** Additional reviewed protected adapters, for example the fixture-only payment transport. */
  adapters?: readonly ActionAdapter[];
  reads?: readonly ReadHandler[];
  tools?: readonly { resourceId: string; port: ConversationToolPort<ConversationPolicyWork> }[];
  team?: { maxConcurrentOperations: number; retention(work: import('./policy').WorkAuthority): DataScope | null };
  web?: Pick<S15WebPorts<OwnerActor>, 'accounts' | 'locale' | 'decisions'>;
  /** POLICY15-02: with no configured `proposedPolicy`, the owner reviews a default proposal derived from the active
   * catalog and the composed resources (ADR 0073). `concurrency` bounds a metered budget's parallel charges. */
  defaultPolicy?: { lifetimeMs?: number; concurrency: number };
  /** GIT15-04: the owner connects GitHub from the Web; the token lives only in `vault`. Ignored with an explicit `github`. */
  githubWeb?: { vault: import('../exec/connections').ConnectionVault; fetch?: typeof fetch;
    runtime(input: { repositories(): readonly GithubRepository[]; credential(): string; catalogPurpose: Ref; fetch?: typeof fetch; now?: () => number }): { github: NonNullable<S15CompositionOptions['github']>; readHandler: ReadHandler; current(id: string): { ref: Ref; active: boolean } | null } };
  /** CHAN15-01 bound Telegram owner channel. The bot token is written only by the owner's protected Web form into this vault. */
  telegram?: { vault: import('../exec/connections').ConnectionVault; transport(token: string): TelegramTransport; limits?: Partial<TelegramLimits>; beforeOffsetAdvance?: () => void };
}

/** Combine the modules' closed read validators. Every request must pass one actual owning handler. */
export function composeS15ReadHandlers(handlers: readonly ReadHandler[]): ReadHandler[] {
  return [...new Set(handlers.map(h => h.operation))].map(operation => ({ operation, validate(payload, context) {
    for (const handler of handlers.filter(h => h.operation === operation)) {
      try { handler.validate(payload, context); return; } catch { /* The next owning validator must independently accept. */ }
    }
    throw new AppError('read_operation_unavailable', 403);
  } }));
}

/**
 * Boot one explicitly selected protected S15 installation. Fresh creation is all-or-nothing admission:
 * a missing or changed store inventory on reopen refuses before recreating any ledger. S14/legacy files
 * are never opened. Models receive scoped tool closures only, with no host-local execution fallback.
 */
export async function composeS15(options: S15CompositionOptions) {
  if (options.runtime !== 's15' || !isAbsolute(options.directory) || resolve(options.directory) !== options.directory) throw new AppError('s15_opt_in_required');
  if (options.files && !options.disclosure) throw new AppError('classification_unknown');
  const webGithubEnabled = !options.github && !!options.githubWeb;
  if (!options.disclosure && (options.browser || options.google || options.github || webGithubEnabled)) throw new AppError('classification_unknown');
  if (options.disclosure && (options.browser && !options.disclosure.browserRoute || options.google && !options.disclosure.googleRoute || (options.github || webGithubEnabled) && !options.disclosure.githubRoute)) throw new AppError('route_unknown');
  // GIT15-04: Web-selected repositories are private DATA15 sources; every consumer below sees the wrapped catalogs.
  let githubConnections: GithubConnections | undefined;
  if (webGithubEnabled && options.disclosure) options = { ...options, disclosure: webGithubDisclosure(options.disclosure, { connections: () => githubConnections, providers: () => [...new Map(options.model.registry.list().map(r => [r.recipient.id, r.recipient] as const)).values()], work: { ...s15DefaultRefs.work }, interpretation: { ...s15DefaultRefs.interpretation }, now: options.clock?.now ?? Date.now }) };
  const root = options.directory, manifestPath = join(root, 'composition.json');
  const storeNames = ['conversation.sqlite', 'policy.sqlite', 'model.sqlite', 'work.sqlite', 'vm.sqlite', 'team.sqlite', 'memory.sqlite', ...(options.disclosure ? ['disclosure.sqlite'] : []), ...(options.browser ? ['browser.sqlite'] : []), ...(options.github || webGithubEnabled ? ['github.sqlite'] : []), ...(options.files ? ['files.sqlite'] : [])];
  const manifest = { contract: 's15-composition/v1', installationId: options.installationId, stores: storeNames };
  if (options.create) {
    // mkdir without recursive prevents accidentally accepting an existing S14/legacy/partial directory.
    mkdirSync(root, { mode: 0o700 });
  }
  // BROW15-02 / GIT15-04: an installation whose manifest predates the provisioned browser or the Web GitHub
  // connection gains exactly those stores (`browser.sqlite`, `github.sqlite`), when its manifest is otherwise
  // identical; any other difference still refuses before a ledger opens. An existing unlisted additive store is
  // adopted, never replaced: it is either the store of a release that was rolled back (the installer restores the
  // earlier manifest, which an earlier release needs to start) and may hold an armed effect, or a complete fresh
  // store (creation is atomic). Only a store this boot created is removed if the boot fails. A store the manifest
  // already lists must still exist; a missing listed ledger always refuses.
  const additive = [...(options.browser?.approved ? ['browser.sqlite'] : []), ...(webGithubEnabled ? ['github.sqlite'] : []), ...(options.files ? ['files.sqlite'] : [])];
  let added: string[] = [];
  const created: string[] = [];
  if (!options.create) {
    const directory = lstatSync(root);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o077) throw new AppError('unprotected_ledger');
    const stored: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!equal(stored, manifest)) {
      // Exactly a nonempty subset of the additive stores may be missing from an otherwise identical manifest.
      const listed = Array.isArray((stored as { stores?: unknown } | null)?.stores) ? (stored as { stores: unknown[] }).stores : [];
      const missing = storeNames.filter(name => !listed.includes(name));
      if (!missing.length || missing.some(name => !additive.includes(name)) || !equal(stored, { ...manifest, stores: storeNames.filter(name => !missing.includes(name)) })) throw new AppError('continuity_unavailable');
      for (const name of missing) {
        const existing = lstatSync(join(root, name), { throwIfNoEntry: false });
        if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.mode & 0o077)) throw new AppError('continuity_unavailable');
        added.push(name); if (!existing) created.push(name);
      }
    }
    for (const name of storeNames) { if (added.includes(name)) continue; const s = lstatSync(join(root, name)); if (!s.isFile() || s.isSymbolicLink() || s.mode & 0o077) throw new AppError('continuity_unavailable'); }
  }
  const cleanup: (() => void | Promise<void>)[] = [];
  // A failed additive boot removes only stores it created itself, so the next boot sees the same state.
  if (created.length) cleanup.push(() => { if (!added.length) return; for (const name of created) for (const suffix of ['', '-wal', '-shm', '.runtime-lock.sqlite']) rmSync(join(root, `${name}${suffix}`), { force: true }); });
  let closing = false;
  let draining: Promise<void> | null = null;
  try {
    // One credential lifecycle per composed installation (one per process in production) for CHAT, MODEL15 and the
    // GitHub runner, so two renewals on the same store can never race on a rotating refresh token. It closes last.
    const credentials = createHostCredentialLifecycle(options.credentials?.store ? { store: options.credentials.store } : {});
    cleanup.push(async () => { await closeCredentialLifecycle(credentials); });
    const routeAuth = { lifecycle: credentials, ...(options.credentials?.fetch ? { fetch: options.credentials.fetch } : {}) };
    const store = new ConversationStore(join(root, 'conversation.sqlite'), options.installationId, options.create, !!options.files); cleanup.push(() => store.close());
    let files: FileStore<OwnerActor | WorkActor> | undefined;
    const vmStore = new VmStore(join(root, 'vm.sqlite')); cleanup.push(() => vmStore.close());
    // POOL15-01: `vm.id` names the team's working-computer pool and its default member; other members are
    // enrollment records in the protected VM journal, never a hand-written list.
    const pool = new VmPool({ store: vmStore, id: options.vm.id, ...(options.vm.limits ? { maxSessions: options.vm.limits.maxSessions } : {}), ...(options.clock ? { now: options.clock.now } : {}) });
    // GIT15-04: the GitHub service recipient is current only while the Web connection exists.
    const disclosureCatalogs = options.disclosure ? { ...options.disclosure.catalogs, source: (value: Ref) => files?.source(value.id) ?? options.disclosure!.catalogs.source(value), recipient: (value: Ref) => { const row = githubConnections?.recipient(value.id); return row ? (equal(row.ref, value) ? row : null) : options.disclosure!.catalogs.recipient(value); } } : undefined;
    const disclosure = options.disclosure ? openDisclosureService({ ...options.disclosure, catalogs: disclosureCatalogs!, ...(options.clock ? { now: options.clock.now } : {}), runtime: 's15', path: join(root, 'disclosure.sqlite'), create: options.create, installationId: options.installationId }) : undefined;
    if (disclosure) cleanup.push(() => disclosure.close());
    const vmIntegration = new VmPolicyIntegration({ store: vmStore, resource: id => { if (!pool.has(id)) throw new AppError('outside_scope'); return options.vm.resource; },
      attemptCurrent: (work, attemptId) => attemptId === `chat_${work.id}` || /^github_[a-f0-9]{32}$/.test(attemptId), upperBound: options.vm.upperBound, destination: options.vm.destination, ...(disclosure && options.disclosure?.acquisitionRoute ? { disclosure: disclosure.acquisition(options.disclosure.acquisitionRoute) } : {}) });
    const browser: BrowserRegistration | undefined = options.browser ? await registerProtectedBrowser({ ...options.browser, runtime: 's15', continuity: { path: join(root, 'browser.sqlite'), create: options.create || created.includes('browser.sqlite') }, profilePath: join(root, 'profiles'), ...(disclosure && options.disclosure?.browserRoute ? { disclosure: disclosure.browser(options.disclosure.browserRoute, options.browser.resource) } : {}) }, options.browser.factory) : undefined;
    if (browser) cleanup.push(() => browser.close());
    const google = options.google ? registerGoogleEffects({ ...options.google, ...(disclosure && options.disclosure?.googleRoute ? { disclosure: { protectAdapter: adapter => disclosure.protectAdapter(adapter, options.disclosure!.googleRoute!), beforeRead: (work, payload) => disclosure.guardRead(work, options.disclosure!.googleRoute!, payload), recordRead: actor => { const work = policy.work.guard(actor); for (const source of options.disclosure!.workSources(work)) disclosure.read(actor, source); } } } : {}) }) : undefined;
    const githubStore = options.github || webGithubEnabled ? new GithubStore(join(root, 'github.sqlite'), options.installationId, options.create || created.includes('github.sqlite')) : undefined;
    if (githubStore) cleanup.push(() => githubStore.close());
    if (webGithubEnabled && githubStore) githubConnections = new GithubConnections({ store: githubStore, vault: options.githubWeb!.vault, installationId: options.installationId, ...(options.clock ? { now: options.clock.now } : {}), ...(options.githubWeb!.fetch ? { fetch: options.githubWeb!.fetch } : {}) });
    const webGithub = githubConnections ? options.githubWeb!.runtime({ repositories: () => githubConnections!.repositories(), credential: () => githubConnections!.credential(), catalogPurpose: { ...s15DefaultRefs.work }, ...(options.githubWeb!.fetch ? { fetch: options.githubWeb!.fetch } : {}), ...(options.clock ? { now: options.clock.now } : {}) }) : undefined;
    /** The composed GitHub module: explicit configuration, or the live protected Web connection (GIT15-04). */
    const gh = options.github ?? webGithub?.github;
    /** Current DATA15 lineage fence of a Web-connected repository's latest source generation. */
    const githubSourceRow = (id: string) => { const row = githubConnections?.sources().find(s => s.source.ref.id === id); return row ? { ref: structuredClone(row.source.ref), active: true } : null; };
    const githubIds = () => (gh?.repositories ?? []).map(r => r.resource.id);
    let policy!: S15PolicyService;
    let team!: TeamService;
    // Protected channel principals (WORK15-02 settlement, the bound Telegram owner). Each proof is a process-local
    // object whose check re-reads its durable binding on every POLICY owner verification; none is serializable,
    // and a changed owner generation or revoked binding refuses at once.
    const channelProofs = new WeakMap<object, () => AuthenticatedOwner | null>(), channelActors = new WeakSet<OwnerActor>();
    let verified: AuthenticatedOwner | null = null;
    const verifyOwner = (proof: unknown) => { const check = proof !== null && typeof proof === 'object' ? channelProofs.get(proof) : undefined; return verified = check ? check() : options.owner.verifyOwner(proof); };
    const clockNow = options.clock?.now ?? Date.now;
    const principalOf = (actor: OwnerActor): ResumeOwnerSnapshot => { verified = null; policy.owner.current(actor); const principal = verified as AuthenticatedOwner | null; if (!principal) throw new AppError('authentication_required', 401); return { ownerId: principal.id, generation: principal.generation }; };
    if (options.files) {
      files = new FileStore({ path: join(root, 'files.sqlite'), directory: join(root, 'file-bytes'), installationId: options.installationId, create: options.create || created.includes('files.sqlite'), resource: options.vm.resource, ...(options.files.limits ? { limits: options.files.limits } : {}), now: clockNow,
        requireOwner(actor: OwnerActor | WorkActor) {
          try { const owner = principalOf(actor as OwnerActor); return { id: owner.ownerId, generation: owner.generation }; }
          catch { try { const work = policy.work.guard(actor as WorkActor); return { id: options.conversation.ownerId, generation: work.ownerGeneration }; } catch { throw new AppError('authentication_required', 401); } }
        } });
      cleanup.push(() => files!.close());
    }
    const fileWorkflow = files ? createFileWorkflow({ store: files, resource: options.vm.resource, policy: () => policy, disclosure: () => disclosure,
      guardResource(current, write) { team.resource(team.bind(current.actor), options.vm.resource.id, write ? 'write' : 'read'); },
      request(workId) { const row = store.db.query<{ id: string }, [string]>("SELECT id FROM requests WHERE json_extract(record_json,'$.authority.id')=?").get(workId); if (!row) throw new AppError('outside_scope'); return store.request(row.id); } }) : undefined;
    const channelOwner = (snapshot: ResumeOwnerSnapshot, current: () => boolean, channel: boolean): OwnerActor | null => {
      const proof = Object.freeze({});
      channelProofs.set(proof, () => current() && snapshot.generation === options.owner.generation() ? { id: snapshot.ownerId, generation: snapshot.generation, expiresAt: clockNow() + 60000 } : null);
      try { const actor = policy.owner.authenticate(proof); if (channel) channelActors.add(actor); return actor; } catch { return null; }
    };
    const currentCatalogs: CatalogPort = { ...(options.catalogs.allowsModel ? { allowsModel: options.catalogs.allowsModel } : {}), current: (kind, id) => {
        // A Web-connected repository that was unselected or whose connection was removed is inactive whatever TEAM says.
        const connected = kind === 'resource' ? githubConnections?.resource(id) : kind === 'recipient' ? githubConnections?.recipient(id) : kind === 'lineage' ? files?.source(id) ?? webGithub?.current(id) ?? githubSourceRow(id) : null;
        if (connected && !connected.active) return connected;
        const teamRow = kind === 'resource' ? team?.currentResource(id) : null;
        // A repository selected again has a newer live identity; its older TEAM row must not shadow it (the TEAM row is
        // refreshed by the owner's reviewed registration and, until then, TEAM's own check refuses the work).
        if (connected && teamRow && !equal(teamRow.ref, connected.ref)) return connected;
        return teamRow ?? connected ?? options.catalogs.current(kind, id);
      },
      allows: (work, action) => options.catalogs.allows(work, action) && !!team && team.allowsWork(work) };
    const baseGithubAdapter = gh && githubStore ? createGithubActionAdapter({ store: githubStore, gateway: gh.gateway, limits: gh.limits, now: options.clock?.now ?? Date.now, policy: () => policy }) : undefined;
    const githubAdapter = baseGithubAdapter && disclosure && options.disclosure?.githubRoute ? disclosure.protectAdapter(baseGithubAdapter, options.disclosure.githubRoute) : baseGithubAdapter;
    policy = openPolicyService({ runtime: 's15', path: join(root, 'policy.sqlite'), create: options.create, installationId: options.installationId,
      ...(options.adoption ? { activityGuard: () => options.adoption!.service.guardActivity() } : {}), ownerGeneration: options.owner.generation, verifyOwner, catalogs: vmIntegration.catalogs(disclosure ? disclosure.catalogs(currentCatalogs) : currentCatalogs),
      adapters: [vmIntegration.adapter, ...(fileWorkflow ? [fileWorkflow.adapter] : []), ...(disclosure ? [disclosure.adapter] : []), ...(browser ? [browser.adapter] : []), ...(google?.adapters ?? []), ...(githubAdapter ? [githubAdapter] : []), ...(options.adapters ?? []).map(adapter => disclosure && options.disclosure?.adapterRoutes?.[adapter.id] ? disclosure.protectAdapter(adapter, options.disclosure.adapterRoutes[adapter.id]!) : adapter)],
      reads: composeS15ReadHandlers([...vmIntegration.reads, ...(fileWorkflow ? [fileWorkflow.readHandler] : []), ...(browser ? [browser.readHandler] : []), ...(google ? [google.readHandler] : []), ...(options.github ? [githubReadHandler(options.github.repositories)] : []), ...(webGithub ? [{ operation: 'read' as const, validate: (payload: import('./policy').JsonValue, context: { work: import('./policy').WorkAuthority; resource: Ref }) => githubReadHandler(githubConnections!.repositories()).validate(payload, context) }, webGithub.readHandler] : []), ...(options.reads ?? [])]),
      ...(options.clock ? { now: options.clock.now } : {}), ...(options.subscriptionModels ? { subscriptionModels: options.subscriptionModels } : {}) });
    cleanup.push(() => policy.control.close()); disclosure?.attach(policy); browser?.attach(policy); google?.attach(policy);
    team = new TeamService({ runtime: 's15', path: join(root, 'team.sqlite'), create: options.create, installationId: options.installationId, policy, maxConcurrentOperations: options.team?.maxConcurrentOperations ?? 16, producerCurrent(producer) { try { const work = policy.work.guard(policy.control.bindWork(producer.workId)); return equal(work.request.bot, producer.bot) && work.policyRevision === producer.policyRevision && work.ownerGeneration === producer.ownerGeneration; } catch { return false; } }, ...(options.clock ? { now: options.clock.now } : {}) }); cleanup.push(() => team.close());
    const memory = new MemoryService({ runtime: 's15', path: join(root, 'memory.sqlite'), create: options.create, installationId: options.installationId, team, retention: work => options.team?.retention(work) ?? null, ...(options.clock ? { now: options.clock.now } : {}) }); cleanup.push(() => memory.close());
    const activeGuards = new Map<string, () => void>();
    const requireOwner = (actor: object) => { policy.owner.current(actor as OwnerActor); };
    if (options.vm.local && !options.vm.managementVault) throw new AppError('vm_management_unavailable', 503);
    // Local working VMs: protected registry proxy on a controller-only socket, reached only by the QEMU guest-forward.
    const localVm = options.vm.local ? await startLocalVmControl(vmStore, { directory: join(root, 'vm-local'), ...options.vm.local }) : null;
    if (localVm) cleanup.push(() => localVm.close());
    const managers = options.vm.managementVault ? new VmManagers({ store: vmStore, vault: options.vm.managementVault, requireOwner, ...(localVm ? { local: localVm.host } : {}) }) : new Map(options.vm.managers);
    for (const [id, manager] of options.vm.managers) managers.set(id, manager);
    const vm = new WorkingVmService({ store: vmStore, policy: vmIntegration.bind(policy), managers, requireOwner, ...(disclosure ? { disclosure } : {}),
      ...(options.vm.transport ? { transport: options.vm.transport } : {}), ...(options.vm.limits ? { limits: options.vm.limits } : {}), ...(options.clock ? { now: options.clock.now } : {}),
      ...(localVm ? { proxyLease: localVm.lease } : {}) });
    if (localVm) {
      // A local VM survives controller restarts; re-attach and re-verify it (or restart it after a host reboot) in the background.
      const reattach = new AbortController(), reattaching = vm.reattach(reattach.signal).catch(() => {});
      cleanup.push(async () => { reattach.abort(); await reattaching; });
    }
    // Placement runs before the TEAM lease so the lease, its fence and its stop-proof link name the exact member.
    const workingVm = placeWorkingVm(coordinateWorkingVm(vm, team, options.vm.resource.id, vmStore), pool);
    // Protected TEAM/VM reconciliation: leases left unknown by a crash or by recovery are released only on
    // the VM journal's own stop proof. Runs at boot, after owner recovery/VM commands and on every drain.
    const reconcileVm = () => { try { reconcileVmLeases(team, vmStore); } catch { /* Unproven leases stay fenced. */ } };
    reconcileVm();
    const enrollment = new VmEnrollment({ store: vmStore, keyDirectory: join(root, 'vm-keys'), requireOwner, managers,
      ...(options.vm.enrollmentRun ? { run: options.vm.enrollmentRun } : {}), ...(options.clock ? { now: options.clock.now } : {}),
      ...(localVm ? { proxyLease: (sessionId: string, expiresAt: number) => localVm.lease(sessionId, expiresAt), updateRegistryHosts: (hosts: readonly string[]) => localVm.setHosts(hosts) } : {}) });
    // SETUP15-01: the durable job that creates the default working computer on a KVM controller. Only the
    // owner's `setup --s15`, the protected controller boot and the owner's authenticated setup form start it.
    const provisioning = localVm && managers instanceof VmManagers ? new LocalVmProvisioning({ store: vmStore, vmId: options.vm.id,
      host: () => probeLocalVmHost(localVm.host.directory, localVm.host.probe), manager: () => managers.ensureLocal(),
      enroll: input => enrollment.provisionLocal(input), ...(options.clock ? { now: options.clock.now } : {}) }) : null;
    if (provisioning) cleanup.push(() => provisioning.close());
    const checkedManagers = new Map<string, string | null>();
    const unboundAdapter = (id: string) => { const manager = managers.get(id); return !!manager && !isVmLocalManagement(manager) && !enrolledManagers().has(id); };
    const enrolledManagers = () => new Set(vmStore.db.query<{ data: string }, []>('SELECT data FROM vm_registry').all().map(row => (JSON.parse(row.data) as { managerId: string | null }).managerId));
    const localHost = (owner: OwnerActor) => {
      requireOwner(owner); if (!localVm) return null;
      const host = probeLocalVmHost(localVm.host.directory, localVm.host.probe), facts = host.facts;
      return { state: host.state, code: host.state === 'missing' ? host.code : null, facts: facts ? { cpus: facts.cpus, memoryGiB: Math.floor(facts.memoryBytes / 1_073_741_824), diskFreeGiB: Math.floor(facts.diskFreeBytes / 1_073_741_824) } : null,
        resources: host.state === 'ready' ? host.resources : null };
    };
    const authentication = { authenticate(token: string) { const auth = options.owner.authenticate(token); return { actor: policy.owner.authenticate(auth.proof), csrf: auth.csrf }; }, verifyCsrf: options.owner.verifyCsrf };
    const cookieName = new URL(options.origin).protocol === 'https:' ? '__Host-jit_s14' : 'jit_s14';
    const authenticate = (request: Request): OwnerActor => {
      const url = new URL(request.url), origin = new URL(options.origin);
      if (url.origin !== origin.origin || request.headers.get('host') !== null && request.headers.get('host') !== origin.host) throw new AppError('host_rejected', 403);
      if (!['GET', 'POST'].includes(request.method)) throw new AppError('method_rejected', 405);
      if (request.method === 'POST' && request.headers.get('origin') !== options.origin) throw new AppError('origin_rejected', 403);
      const cookies = (request.headers.get('cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.startsWith(cookieName + '='));
      if (cookies.length !== 1) throw new AppError('authentication_required', 401);
      const auth = authentication.authenticate(cookies[0]!.slice(cookieName.length + 1));
      if (request.method === 'POST') authentication.verifyCsrf(auth.csrf, request.headers.get('x-csrf-token'));
      return auth.actor;
    };
    const subjectIds = new Proxy([] as string[], { get: (_target, key) => { const ids = githubIds(), value = Reflect.get(ids, key); return typeof value === 'function' ? value.bind(ids) : value; } });
    const conversationPolicy = createConversationPolicy(policy, { ...options.conversation, ...(gh ? { subjectResourceIds: options.github ? options.github.repositories.map(r => r.resource.id) : subjectIds } : {}), ownerGeneration: options.owner.generation });
    const effects = createEffectsConversationTools(policy, { ...(google ? { google: google.tools } : {}), ...(browser ? { browser, browserResourceId: options.browser!.resource.id } : {}) }); cleanup.push(() => effects.close());
    conversationPolicy.dispatchAction = effects.dispatchAction;
    // Defense in depth for ADR 0072: a channel owner can never decide a held action, whatever its text says.
    for (const name of ['decideAction', 'decidePending'] as const) {
      const decide = conversationPolicy[name] as ((actor: OwnerActor, input: never) => void) | undefined;
      if (decide) conversationPolicy[name] = ((actor: OwnerActor, input: never) => { if (channelActors.has(actor)) throw new AppError('approval_web_only', 403); decide.call(conversationPolicy, actor, input); }) as never;
    }
    let conversation!: ConversationApplication<OwnerActor, ConversationPolicyWork>;
    const work = openWorkService({ runtime: 's15', path: join(root, 'work.sqlite'), create: options.create, installationId: options.installationId, policy,
      conversation: { view: (owner, id) => conversation.view(owner, id) }, remainingCalls: workId => {
        const current = policy.control.policyForWork(workId), used = policy.control.reservations(workId).reduce((n, row) => n + row.upperBound.calls, 0);
        return current.budget ? Math.max(0, current.budget.ceiling.calls - policy.control.usage().charged.calls) : options.subscriptionModels ? Math.max(0, options.subscriptionModels.perWork.calls - used) : null;
      }, ...(options.clock ? { now: options.clock.now } : {}) } satisfies WorkOptions); cleanup.push(() => work.close());
    const modelDisclosure = disclosure && options.disclosure ? disclosure.model(options.disclosure.modelRoute) : undefined;
    const models = openModelService({ runtime: 's15', path: join(root, 'model.sqlite'), create: options.create, installationId: options.installationId, nativeDirectory: join(root, 'native-model'), policy, ...options.model, routeAuth, ...(modelDisclosure ? { disclosure: modelDisclosure } : {}),
      guardWork: workId => { activeGuards.get(workId)?.(); policy.work.guard(policy.control.bindWork(workId)); if (closing) throw new AppError('aborted'); }, ...(options.clock ? { clock: options.clock } : {}) }); cleanup.push(() => models.close());
    const githubDisclosure = disclosure && options.disclosure?.githubRoute ? { beforeRead: (work: import('./policy').WorkAuthority, payload: import('./policy').JsonValue) => disclosure.guardRead(work, options.disclosure!.githubRoute!, payload), recordRead: (actor: import('./policy').WorkActor) => { const current = policy.work.guard(actor); for (const source of options.disclosure!.workSources(current)) disclosure.read(actor, source); } } : undefined;
    const github = gh && githubStore ? new GithubService({ runtime: 's15', store: githubStore, policy, ...gh, ...(githubConnections ? { currentRepositories: () => githubConnections!.repositories() } : {}), ...(options.disclosure?.githubRecipients ? { publicationRecipients: options.disclosure.githubRecipients } : {}), workspace: gh.workspace({ policy, vm: workingVm, routeAuth, ...(disclosure ? { disclosure, ...githubDisclosure, guardModel(current, request) { const candidate = options.model.registry.current(current.request.selection); if (!candidate || !modelDisclosure) throw new AppError('route_unavailable'); modelDisclosure.guard(current, candidate, request); } } : {}) }), ...(githubDisclosure ? { disclosure: githubDisclosure } : {}), responsibilities: work, ...(options.clock ? { now: options.clock.now } : {}) }) : undefined;
    const vmPort = { resourceId: options.vm.resource.id, port: createConversationVmTools(workingVm, { vmId: options.vm.id, resourceId: options.vm.resource.id }) };
    const githubPorts = new Map<string, ConversationToolPort<ConversationPolicyWork>>();
    // Repository ports follow the live selection; each stays scoped to its one repository resource.
    const ports = () => [vmPort, ...(github ? githubIds().map(id => ({ resourceId: id, port: githubPorts.get(id) ?? (githubPorts.set(id, createGithubConversationTools(github, id)), githubPorts.get(id)!) })) : []), ...(options.tools ?? [])];
    conversation = new ConversationApplication(store, { policy: conversationPolicy, memory: createConversationMemory(memory), ...(fileWorkflow ? { files: fileWorkflow.port } : {}), nativeDirectory: join(root, 'native-chat'), routeAuth, ...(options.interpreter ? { interpreterModel: options.interpreter } : {}), ...(options.clock ? { clock: options.clock } : {}),
      ...(disclosure && modelDisclosure && options.disclosure ? { guardInterpretation(current: ConversationPolicyWork, payload: unknown) {
        const candidate = options.model.registry.current(current.authority.request.selection); if (!candidate || candidate.availability !== 'available') throw new AppError('route_unavailable');
        const standing = policy.control.policyForWork(current.authority.id);
        // Privacy check conservatively covers all standing resources because isolated owner/assistant
        // history can contain derived results. This projection is never admitted or used for tools.
        const privacy = { ...current.authority, request: { ...current.authority.request, resources: standing.resources } };
        privacy.request.fences = [...(privacy.request.fences ?? []), ...options.disclosure!.workSources(privacy).map(ref => ({ kind: 'lineage' as const, ref }))];
        modelDisclosure.guard(privacy, candidate, payload);
      } } : {}),
      tools: { async open(current, input) {
        if (disclosure && options.disclosure) for (const source of options.disclosure.workSources(current.authority)) disclosure.read(current.actor, source);
        const context = team.bind(current.actor);
        const scopedGuard = () => { input.guard(); for (const resource of current.authority.request.resources) team.resource(context, resource.id); };
        scopedGuard();
        const opened = [] as Awaited<ReturnType<ConversationToolPort<ConversationPolicyWork>['open']>>[];
        try {
          for (const registration of ports()) if (current.authority.request.resources.some(r => r.id === registration.resourceId)) opened.push(await registration.port.open(current, { ...input, guard: scopedGuard }));
          if (google || browser) opened.push(await effects.tools.open(current, { ...input, guard: scopedGuard }));
          return { tools: opened.flatMap(p => p.tools).map(tool => ({ ...tool, definition: { ...tool.definition, async execute(value, call) { scopedGuard(); for (const resource of current.authority.request.resources) team.resource(context, resource.id, tool.access === 'read' ? 'read' : tool.definition.name === 'protected_browser' ? 'input' : 'write'); const result = await tool.definition.execute(value, call); scopedGuard(); return result; } } })), async cancel() { await Promise.all(opened.map(p => p.cancel())); }, async close() { await Promise.all(opened.map(p => p.close())); } };
        } catch (error) { await Promise.allSettled(opened.map(p => p.close())); throw error; }
      } },
      async runWork(input) {
        input.guard();
        if (disclosure && options.disclosure) { for (const source of options.disclosure.workSources(input.work.authority)) disclosure.read(input.work.actor, source); for (const route of options.model.registry.list()) modelDisclosure?.allows(input.work.authority, route); }
        activeGuards.set(input.work.authority.id, input.guard);
        try { const record = await models.runStep(input.work.actor, { stepId: 'conversation', difficulty: 'ordinary', text: input.request.intent.instruction,
          ownerDecisions: [canonical({ intent: input.request.intent, authority: input.request.authority })], sources: [], tools: input.definitions, ...(input.memorySection ? { memorySection: input.memorySection } : {}) }, input.signal, { beforeCall: input.countModelCall });
        input.guard(); if (record.state !== 'completed') throw new AppError(record.code ?? 'conversation_run_incomplete');
        let text = ''; models.publish(input.work.actor, 'conversation', output => { text = output; });
        if (Buffer.byteLength(text) > input.request.authority!.limits.outputBytes) throw new AppError('output_limit');
        return { text, usage: null }; } finally { activeGuards.delete(input.work.authority.id); }
      } });
    // WORK15-02: the owner's own completed stall reply resumes its named responsibility, after restart too.
    const resumes = openResumeBindings<OwnerActor>({ store, conversation: { submit: (actor, command) => conversation.submit(actor, command) },
      work: { project: (actor, id) => work.project(actor, id), resume: (actor, id, source) => { work.resume(actor, id, source); } },
      principal: principalOf, owner: snapshot => channelOwner(snapshot, () => true, false), now: clockNow });
    const telegram = options.telegram ? openTelegramChannel({ installationId: options.installationId, origin: options.origin, store, vault: options.telegram.vault, transport: options.telegram.transport,
      conversation: { submit: (actor, command) => conversation.submit(actor, command), publish: (actor, id, consume) => conversation.publish(actor, id, consume), slips: (actor, actions) => conversationPolicy.actionSlips?.(actor, actions) ?? [] },
      resumes, work: { list: actor => work.list(actor), project: (actor, id) => work.project(actor, id) }, principal: principalOf,
      owner: binding => channelOwner({ ownerId: binding.ownerId, generation: binding.generation }, binding.current, true),
      ...(options.web?.locale ? { locale: options.web.locale } : {}), clock: options.clock ?? { now: Date.now, sleep: (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, ms); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }, { once: true }); }) },
      ...(options.telegram.limits ? { limits: options.telegram.limits } : {}), ...(options.telegram.beforeOffsetAdvance ? { beforeOffsetAdvance: options.telegram.beforeOffsetAdvance } : {}) }) : undefined;
    if (telegram) cleanup.push(() => telegram.close());
    const githubCatalogActor = (owner: OwnerActor) => {
      const current = policy.owner.current(owner), purpose = gh?.catalogPurpose;
      if (!current || !purpose || !github) throw new AppError('outside_scope');
      // An explicit owner profile form admits only protected repository inspection, never issue execution.
      const admitted = policy.owner.admit(owner, { requestId: 'profile_' + crypto.randomUUID().replaceAll('-', ''), intent: 'inspect', access: 'read', purpose, bot: options.conversation.bot,
        resources: gh!.repositories.map(r => r.resource), recipients: current.recipients, selection: options.conversation.selection, selectionPin: options.conversation.selection,
        expiresAt: current.expiresAt, readLimit: Math.min(256, current.budget?.ceiling.reads ?? policy.control.subscriptionLimits()?.tools?.reads ?? 0) });
      if (!admitted.work) throw new AppError('outside_scope');
      const actor = policy.control.bindWork(admitted.work.id);
      if (disclosure && options.disclosure) for (const source of options.disclosure.workSources(admitted.work)) disclosure.read(actor, source);
      return actor;
    };
    // Explicit owner registration of TEAM resources (F1/F12). A fresh installation has none, but every
    // work resource must be registered; nothing is registered until the owner confirms this exact list.
    const composedResources = (): { ref: Ref; kind: TeamResource['kind']; label: string }[] => {
      const known: { ref: Ref; kind: TeamResource['kind']; label: string }[] = [{ ref: options.vm.resource, kind: 'workspace', label: options.vm.id }];
      if (options.browser) known.push({ ref: options.browser.resource, kind: 'browser', label: options.browser.label ?? options.browser.ownerUi?.site ?? options.browser.resource.id });
      for (const r of gh?.repositories ?? []) known.push({ ref: r.resource, kind: 'data', label: r.name });
      for (const account of [options.google?.mailAccount, options.google?.calendarAccount]) { try { const a = account?.(); if (a) known.push({ ref: a.resource, kind: 'account', label: a.account }); } catch { /* Unavailable connection: not offered. */ } }
      return known;
    };
    // POLICY15-02: the default standing-policy proposal, derived from the active catalog and composed resources.
    const active = (kind: import('./policy').CatalogKind, ref: Ref) => { const row = currentCatalogs.current(kind, ref.id); return !!row && row.active && equal(row.ref, ref); };
    const dayStart = () => { const t = clockNow(); return t - t % 86_400_000; };
    const defaultScope = () => {
      const routes = options.model.registry.list().filter(r => active('route', r.selection.route) && active('model', r.selection.model) && active('recipient', r.recipient));
      const selections: (DefaultSelection & { available: boolean; currency: string | null })[] = routes.map(r => ({ selection: r.selection, recipient: r.recipient, charge: r.charge, label: `${r.provider} · ${r.modelId}`, available: r.availability === 'available', currency: r.currency ?? null }));
      const resources: DefaultResource[] = [];
      if (active('resource', options.vm.resource)) resources.push({ ref: options.vm.resource, kind: 'computer', label: options.vm.id, adapters: [{ id: vmIntegration.adapter.id, operations: ['vm_write', 'vm_shell', 'vm_system_admin', 'vm_snapshot', 'vm_acquire'] }, ...(fileWorkflow ? [{ id: fileWorkflow.adapter.id, operations: ['artifact_create'] }] : []), ...(disclosure ? [{ id: disclosure.adapter.id, operations: ['disclose'] }] : [])] });
      if (browser && options.browser && active('resource', options.browser.resource)) resources.push({ ref: options.browser.resource, kind: 'browser', label: options.browser.label ?? options.browser.ownerUi?.site ?? options.browser.resource.id, adapters: [{ id: browser.adapter.id, operations: ['browser_request'] }] });
      for (const r of gh?.repositories ?? []) if (active('resource', r.resource)) resources.push({ ref: r.resource, kind: 'repository', label: r.name, adapters: [{ id: 's15_github', operations: ['push', 'pr_create', 'pr_update', 'review_reply', 'merge'] }] });
      const extraRecipients = githubConnections ? (active('recipient', s15GithubRecipient) && resources.some(r => r.kind === 'repository') ? [{ ...s15GithubRecipient }] : []) : (options.disclosure?.githubRecipients ?? []).filter(r => gh && active('recipient', r));
      return { selections, resources, extraRecipients, bot: active('bot', options.conversation.bot) ? options.conversation.bot : null };
    };
    const meteredCurrency = (selections: readonly { charge: string; currency: string | null }[]): { currency: string | null; code: string | null } => {
      const metered = selections.filter(s => s.charge !== 'subscription'); if (!metered.length) return { currency: null, code: null };
      const set = new Set(metered.map(s => s.currency));
      return set.has(null) ? { currency: null, code: 'metered_currency_unknown' } : set.size !== 1 ? { currency: null, code: 'metered_currency_mixed' } : { currency: [...set][0]!, code: null };
    };
    const defaultPolicyInput = (owner: OwnerActor, entry: import('./web').S15BudgetEntry | null) => {
      if (!options.defaultPolicy || options.proposedPolicy) return null;
      const scope = defaultScope(), now = dayStart(), current = policy.owner.current(owner), lifetimeMs = options.defaultPolicy.lifetimeMs ?? S15_DEFAULT_POLICY_LIFETIME_MS;
      if (!scope.bot) return null;
      // One budget covers every metered route, so they must share one known currency; otherwise nothing is offered.
      const money = meteredCurrency(scope.selections);
      const budget = s15NeedsBudget(scope.selections) && entry && money.currency && entry.currency === money.currency ? s15MeteredBudget({ now, policyExpiresAt: now + lifetimeMs, currency: entry.currency, spendMinor: entry.spendMinor, periodId: entry.periodId, concurrency: options.defaultPolicy.concurrency }) : null;
      const build = (value: import('./policy').OperatingBudget | null) => s15DefaultPolicy({ now, bot: scope.bot!, resources: scope.resources, selections: scope.selections, extraRecipients: scope.extraRecipients, budget: value, carry: current?.rules ?? [], lifetimeMs });
      // Scope comparison keeps the installed budget unless the owner typed a new one: a metered policy that is
      // installed and unchanged is current, and a new amount is asked for only to change or renew it.
      return { scope, money, input: build(budget), scopeInput: build(budget ?? (s15NeedsBudget(scope.selections) ? current?.budget ?? null : null)), current };
    };
    const teamCandidates = (owner: OwnerActor, proposed?: import('./policy').PolicyInput | null): TeamResource[] => {
      const standing = proposed ?? policy.owner.current(owner) ?? options.proposedPolicy ?? defaultPolicyInput(owner, null)?.input ?? null;
      if (!standing) return [];
      const known = composedResources();
      return standing.resources.filter((ref, index) => standing.resources.findIndex(other => other.id === ref.id) === index).flatMap((ref): TeamResource[] => {
        // A registered row is offered again only to refresh it to a newer owning identity, with every other field unchanged.
        const registered = team.resourceRecord(ref.id);
        if (registered) return ref.revision > registered.revision ? [{ ...registered, revision: ref.revision, generation: ref.generation }] : [];
        const rules = standing.rules.filter(rule => rule.mode !== 'deny' && rule.resources.some(r => r.id === ref.id));
        const purposes = [...new Set((rules.length ? rules.flatMap(rule => rule.purposes) : standing.purposes.filter(p => p.id !== standing.interpretationPurpose?.id)).map(p => p.id))];
        const match = known.find(item => item.ref.id === ref.id);
        return [{ contract: 's15-team-resource/v1', id: ref.id, revision: ref.revision, generation: ref.generation, label: match?.label ?? ref.id, kind: match?.kind ?? 'data', scope: { kind: 'team' }, purposes, allowedBots: null, deniedBots: [], operations: ['read', 'write', 'input'], active: true, coordinationKey: ref.id }];
      });
    };
    const teamPort = { ...s15TeamPort<OwnerActor>(team, actor => actor),
      pending(owner: OwnerActor) { const items = teamCandidates(owner); return { items, hash: teamCandidatesHash(items) }; },
      register(owner: OwnerActor, requestId: string, hash: string) { team.registerReviewed(owner, requestId, hash, () => teamCandidates(owner)); } };
    const recurring = options.recurring ? createRecurringRules(policy, { ...options.recurring, ...(options.clock ? { now: options.clock.now } : {}) }) : undefined;
    const selectedAdoptionStatus = options.adoption ? s15AdoptionPort<OwnerActor>(options.adoption.service, owner => { policy.owner.current(owner); return options.adoption!.authenticate(owner); }) : undefined;
    const adoptionStatus = (owner: OwnerActor) => { policy.owner.current(owner); return selectedAdoptionStatus?.(owner) ?? null; };
    const web = createS15WebHandler({ authentication, memory, conversation: s15ConversationPort(conversation), models,
      ...(adoptionStatus ? { adoption: adoptionStatus } : {}),
      actions: s15ActionsPort<OwnerActor>(policy, actor => actor), duties: s15DutiesPort<OwnerActor>(work, actor => actor), resumes, team: teamPort,
      ...(telegram ? { telegram } : {}),
      ...(recurring ? { recurring: s15RecurringPort<OwnerActor>(recurring, actor => actor) } : {}),
      ...(browser && options.browser?.ownerUi ? { browsers: [{ ...options.browser.ownerUi, owner: browser.owner }] } : {}),
      // BROW15-02 Resources → Websites: every read and command re-verifies the owner through POLICY first.
      ...(browser && options.browser?.approved ? { websites: (approved => ({
        status: (actor: OwnerActor) => { policy.owner.current(actor); return approved.engine.status(); },
        list: (actor: OwnerActor) => { policy.owner.current(actor); return approved.sites.list(); },
        add: (actor: OwnerActor, _requestId: string, input: string) => { policy.owner.current(actor); return approved.sites.add(input); },
        remove: (actor: OwnerActor, _requestId: string, origin: string, revision: number) => { policy.owner.current(actor); approved.sites.remove(origin, revision); },
        retry: (actor: OwnerActor) => { policy.owner.current(actor); void approved.engine.retry().catch(() => {}); },
      }))(options.browser.approved) } : {}),
      ...(github && gh?.catalogPurpose ? { github: { capture: (owner: OwnerActor) => github.personalCapture(owner, githubCatalogActor(owner)), install: (owner: OwnerActor, input: Parameters<typeof github.installPersonal>[2]) => github.installPersonal(owner, githubCatalogActor(owner), input), revoke: (owner: OwnerActor, input: Parameters<typeof github.revokePersonal>[1]) => github.revokePersonal(owner, input) } } : {}),
      readiness(owner, requestId) {
        const row = conversation.view(owner, requestId); if (!row.result || row.intent.kind !== 'inspect' || !githubStore) return null;
        const item = row.evidence.find(e => e.tool === 'github_readiness'); if (!item) return null;
        const reportId = JSON.parse(item.content).id; if (typeof reportId !== 'string' || !/^report_[a-f0-9]{64}$/.test(reportId)) return null;
        const report = githubStore.get<{ repository: GithubRepository; rows: import('./github').GithubReadiness[] }>('report', reportId);
        return report ? s15ReadinessFromGithub(report.repository.name, report.rows) : null;
      },
      computer: { vmId: options.vm.id,
        // An owner-supplied VM binds only a configured, still-unbound adapter; never the Jit-created local manager.
        get managerId() { for (const [id] of managers) if (unboundAdapter(id)) return id; return null; }, hypervisor: null,
        ...(provisioning ? { local: { host: localHost, job: (owner: OwnerActor) => { requireOwner(owner); return provisioning.view(); }, start: (owner: OwnerActor) => { requireOwner(owner); provisioning.start(); } } } : {}),
        pool: { members: (owner: OwnerActor) => { requireOwner(owner); return pool.members().map(member => ({ ...member, local: (() => { const row = vmStore.registration(member.id); return !!row.managerId && isVmLocalManagement(managers.get(row.managerId)); })(), status: enrollment.status(owner, member.id) })); },
          drain: (owner: OwnerActor, id: string, drained: boolean) => { requireOwner(owner); pool.setDrained(id, drained); },
          ...(managers instanceof VmManagers ? { registerManager: (owner: OwnerActor, input: import('./web').S15ManagerInput) => { requireOwner(owner); managers.register(owner, input); } } : {}),
          nextId: (owner: OwnerActor) => { requireOwner(owner); const job = provisioning?.view(); return pool.nextId(!!job && job.state !== 'enrolled'); } },
        begin: actor => enrollment.begin(actor),
        // POOL15-01: an added (non-default) computer is enrolled only with an unused, non-local management
        // adapter, so its hypervisor binding can be proven and placement can select it.
        async checkMachine(actor, input) {
          const job = provisioning?.view(), adding = pool.nextId(!!job && job.state !== 'enrolled') !== options.vm.id;
          if (adding && (!input.managerId || !unboundAdapter(input.managerId))) throw new AppError('vm_management_required', 409);
          const check = await enrollment.checkMachine(actor, input);
          checkedManagers.set(check.checkId, input.managerId ?? null); for (const id of [...checkedManagers.keys()].slice(0, Math.max(0, checkedManagers.size - 64))) checkedManagers.delete(id);
          return check;
        },
        async useMachine(actor, input) {
          if (input.id !== options.vm.id && (!checkedManagers.get(input.checkId) || !unboundAdapter(checkedManagers.get(input.checkId)!))) throw new AppError('vm_management_required', 409);
          const status = await enrollment.useMachine(actor, input); checkedManagers.delete(input.checkId); return status;
        },
        status: (actor, id) => enrollment.status(actor, id), snapshots: (actor, id) => vm.snapshots(actor, id), restore: async (actor, input) => { try { await vm.recover(actor, input); } finally { reconcileVm(); } } },
      rules: { current: actor => policy.owner.current(actor),
        propose: (actor, budget) => {
          const defaults = defaultPolicyInput(actor, budget);
          if (defaults) return policy.owner.proposePolicy(actor, defaults.input);
          if (budget) throw new AppError('configured_budget_required'); return policy.owner.proposePolicy(actor, options.proposedPolicy);
        },
        install: (actor, id, hash) => policy.owner.installProposal(actor, id, hash),
        budgetOptions: actor => { const defaults = defaultPolicyInput(actor, null), currency = defaults?.money.currency ?? null;
          return currency ? { currencies: [currency], periods: s15BudgetPeriods.filter(p => p.days * 86_400_000 <= (options.defaultPolicy?.lifetimeMs ?? S15_DEFAULT_POLICY_LIFETIME_MS)).map(p => ({ ...p })) } : { currencies: [], periods: [] }; },
        review: (actor, entry) => {
          const defaults = defaultPolicyInput(actor, entry); if (!defaults) return null;
          const { scope, input, scopeInput, money, current } = defaults, needsBudget = s15NeedsBudget(scope.selections);
          const rows: import('./web').S15PolicyRow[] = [
            ...(scope.bot ? [{ kind: 'bot' as const, id: scope.bot.id, label: scope.bot.id, detail: null }] : []),
            { kind: 'purpose', id: s15DefaultRefs.work.id, label: s15DefaultRefs.work.id, detail: 'work' }, { kind: 'purpose', id: s15DefaultRefs.interpretation.id, label: s15DefaultRefs.interpretation.id, detail: 'interpretation' },
            ...scope.resources.map(r => ({ kind: r.kind === 'account' ? 'computer' as const : r.kind, id: r.ref.id, label: r.label, detail: null })),
            ...scope.selections.map(s => ({ kind: 'model' as const, id: s.selection.model.id, label: s.label, detail: s.charge })),
            ...scope.selections.filter((s, i, all) => all.findIndex(o => o.recipient.id === s.recipient.id) === i).map(s => ({ kind: 'recipient' as const, id: s.recipient.id, label: s.label.split(' · ')[0]!, detail: 'provider' as const })),
            ...scope.extraRecipients.map(r => ({ kind: 'recipient' as const, id: r.id, label: 'GitHub', detail: 'github' as const })) ];
          const base = { rows, held: [...s15HeldClasses], personalGithub: input?.rules.some(r => r.mode.startsWith('personal_github')) ? 'kept' as const : 'off' as const, needsBudget };
          const renewFrom = current ? current.expiresAt - S15_POLICY_RENEW_WINDOW_MS : null;
          if (current && scopeInput && s15SamePolicyScope(current, scopeInput) && clockNow() < (renewFrom ?? 0)) return { ...base, change: 'current', proposal: null, expiresAt: current.expiresAt, reason: null, renewFrom, team: null };
          if (!input) return { ...base, change: current ? 'update' : 'new', proposal: null, expiresAt: null, reason: !scope.selections.length ? 'route_unavailable' : 'vm_not_enrolled', renewFrom: null, team: null };
          const proposal = policy.owner.proposePolicy(actor, input);
          const reason = proposal.installable ? null : !scope.selections.some(s => s.available) ? 'route_unavailable' : needsBudget && money.code ? money.code : needsBudget && !input.budget ? 'finite_budget_required' : 'proposal_incomplete';
          const items = teamCandidates(actor, input), change = !current ? 'new' : scopeInput && s15SamePolicyScope(current, scopeInput) ? 'renew' : 'update';
          return { ...base, change, proposal, expiresAt: input.expiresAt, reason, renewFrom: null, team: items.length ? { hash: teamCandidatesHash(items), count: items.length } : null };
        } },
      ...(githubConnections ? { githubConnection: {
        view: (owner: OwnerActor): import('./web').S15GithubConnectionView => {
          requireOwner(owner); const c = githubConnections!.current();
          return c ? { state: c.state, revision: c.revision, login: c.login, tokenExpiresAt: c.tokenExpiresAt, verifiedAt: c.verifiedAt, truncated: c.truncated, accessible: c.state === 'connected' ? c.accessible.map(a => ({ name: a.name, target: a.target, private: a.private, push: a.push })) : [], selected: c.selected.map(s => s.repository.name) }
            : { state: 'not_connected', revision: 0, login: null, tokenExpiresAt: null, verifiedAt: null, truncated: false, accessible: [], selected: [] };
        },
        connect: async (owner: OwnerActor, requestId: string, token: string) => { requireOwner(owner); await githubConnections!.connect(requestId, token); requireOwner(owner); },
        select: (owner: OwnerActor, requestId: string, expectedRevision: number, names: string[]) => { requireOwner(owner); githubConnections!.select(requestId, expectedRevision, names); },
        remove: (owner: OwnerActor, requestId: string, expectedRevision: number) => { requireOwner(owner); githubConnections!.remove(requestId, expectedRevision); },
      } } : {}),
      ...options.web,
      ...(githubConnections ? { accounts: { list: (owner: OwnerActor) => [...(options.web?.accounts?.list(owner) ?? []).filter(row => row.id !== 'github'),
        { id: 'github', kind: 'service' as const, label: 'GitHub', state: githubConnections!.current()?.state === 'connected' ? 'configured' as const : 'not_connected' as const, uses: ['github' as const], signInHref: '/resources/github' }] } } : {}) },
      { origin: options.origin, cookieName, loginPath: '/s14/login', ...(options.clock ? { now: options.clock.now } : {}) });
    const chatHandler = createConversationHandler(conversation, { origin: options.origin, cookieName, authentication });
    const clientHandler = createS16ClientHandler(conversation, { origin: options.origin, cookieName, authentication, ...(files ? { files } : {}) });
    const s16Web = await createS16WebHandler(clientHandler);
    const vmHandler = createVmApi(enrollment, async request => authenticate(request), { service: vm, ...(managers instanceof VmManagers ? { managers } : {}) });
    const modelHandler = createModelProjectionHandler(models, authenticate), workHandler = createResponsibilityProjectionHandler(work, authenticate);
    const githubHandler = github ? createGithubHandler(github, { origin: options.origin, cookieName, authentication, resolveWork(owner, id) {
      requireOwner(owner); const row = store.db.query<{ id: string }, [string]>("SELECT id FROM requests WHERE json_extract(record_json,'$.authority.id')=?").get(id);
      if (!row || conversation.view(owner, row.id).authority?.id !== id) throw new AppError('outside_scope'); return policy.control.bindWork(id);
    } }) : undefined;
    if (options.create) writeFileSync(manifestPath, canonical(manifest), { mode: 0o600, flag: 'wx' });
    if (added.length) {
      // Atomic replacement after every store opened and before the service is returned to run any work.
      const next = join(root, `.composition.next-${crypto.randomUUID()}`);
      writeFileSync(next, canonical(manifest), { mode: 0o600, flag: 'wx' });
      const fd = openSync(next, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(next, manifestPath);
      const dir = openSync(root, 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
      added = [];
    }
    return { policy, conversation, team, memory, files, disclosure, adoptionStatus, githubConnections, vm, workingVm, vmStore, enrollment, vmManagers: managers, vmPool: pool, provisioning, models, work, github, browser, authentication, resumes, telegram,
      /** One protected scheduler wake; waiting records alone hold no VM/native session. Telegram ingress is
       * submitted first, stall-reply resumes settle after CHAT, and channel notices are derived last. */
      drain(): Promise<void> { if (closing) return Promise.resolve(); return draining ??= (async () => { try { reconcileVm(); try { telegram?.process(); } catch { /* Retried next wake. */ } await conversation.drain(); try { resumes.settle(); } catch { /* Pending bindings stay pending. */ } await github?.drain(); try { telegram?.observe(); } catch { /* Retried next wake. */ } } finally { draining = null; } })(); },
      /** Mount after the installation's existing login/OAuth/device routes, on the same authenticated server. */
      async fetch(request: Request): Promise<Response> {
        try {
          if (closing) throw new AppError('service_closed', 503);
          const path = new URL(request.url).pathname;
          if (path === '/s15/adoption/status') { const owner = authenticate(request); if (request.method !== 'GET') throw new AppError('method_rejected', 405); return Response.json(adoptionStatus?.(owner) ?? null, { headers: { 'Cache-Control': 'no-store' } }); }
          if (path === '/s15/team/resources' || path === '/s15/memory') {
            const owner = authenticate(request);
            if (request.method === 'GET') return Response.json(path === '/s15/memory' ? memory.view(owner) : team.resources(owner), { headers: { 'Cache-Control': 'no-store' } });
            const reader = request.body?.getReader(); if (!reader) throw new AppError('invalid_body'); const chunks = []; let bytes = 0;
            try { for (;;) { const r = await reader.read(); if (r.done) break; bytes += r.value.length; if (bytes > 32768) { await reader.cancel(); throw new AppError('body_too_large', 413); } chunks.push(r.value); } } finally { reader.releaseLock(); }
            const body = JSON.parse(Buffer.concat(chunks).toString());
            if (path === '/s15/memory') return Response.json(memory.command(owner, body));
            if (Object.keys(body).sort().join() !== 'expectedRevision,requestId,resource') throw new AppError('invalid_body');
            return Response.json(team.register(owner, body.requestId, body.expectedRevision, body.resource));
          }
          if (path === '/s16' || path.startsWith('/s16/')) return s16Web(request);
          if (path.startsWith('/api/s15/')) return chatHandler(request);
          if (path.startsWith('/api/s16/client/')) return clientHandler(request);
          if (path.startsWith('/s15/vm/')) { authenticate(request); try { return await vmHandler(request); } finally { if (request.method === 'POST') reconcileVm(); } }
          if (path === '/s15/models') { authenticate(request); return modelHandler(request); }
          if (path.startsWith('/s15/responsibilities/')) { authenticate(request); return workHandler(request); }
          if (path.startsWith('/s15/github/') && githubHandler) return githubHandler(request);
          return web(request);
        } catch (error) { return Response.json({ error: error instanceof AppError ? error.code : 's15_unavailable' }, { status: error instanceof AppError ? error.status : 503, headers: { 'Cache-Control': 'no-store' } }); }
      },
      /** Await all model/tool cleanup before releasing protected stores. Unknown VM/effects remain fenced. */
      async close() { if (closing) return; closing = true; await conversation.shutdown(); await draining; await files?.close(); for (const close of cleanup.reverse()) await close(); },
    };
  } catch (error) { for (const close of cleanup.reverse()) try { await close(); } catch {} throw error; }
}
