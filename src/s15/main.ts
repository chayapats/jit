import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { s16ComputerIdleStopMs } from '../s16/computers/defaults';
import { AppError } from '../errors';
import { readHiddenPassword } from '../terminal-password';
import { ConnectionVault } from '../exec/connections';
import { S14Application } from '../s14/application';
import { S14Store } from '../s14/store';
import { s14Policy } from '../s14/policy';
import { createS14Handler } from '../s14/web';
import { createS14Auth } from '../s14/web-first-run';
import { createS14Product } from '../s14/web-product';
import { renderS14 } from '../s14/web-pages';
import { PersonalVault } from '../s14/personal-vault';
import { personalProxyRequest, personalServiceBinding } from '../s14/personal-origin';
import { GooglePersonal } from '../s14/personal-protocol';
import { s14CredentialLifecycle } from '../s14/lifecycle';
import { requireS14OwnerLinkPipe, writeS14OwnerSetupLink } from '../s14/owner-bootstrap';
import { lookupS14Asset } from '../s14/web-assets';
import { composeS15, type S15CompositionOptions } from './composition';
import { LimaVmManagement } from './vm';
import { RemoteVmManagement } from './vm/remote';
import { equal } from './policy/validation';
import type { GoogleEffectAccount } from './effects';
import { openProvisionedBrowser, type BrowserSitePolicy, type ProvisionedBrowser } from './browser';
import { RecipientDirectory } from '../s16/autonomy/recipients';
import { githubConnectionRuntime, githubRuntime } from './github/runtime';
import { s15GithubRecipient } from './github/connection';
import { s15DefaultCatalog, s15SubscriptionModels } from './policy/defaults';
import { readS15Credential, s15CredentialKey, s15GoogleConnection } from './credentials';
import { runtimeDisclosure } from './disclosure/runtime';
import { liveRouteAvailability } from './model/availability';
import { readS15RuntimeConfig, readS15VmPool } from './runtime-config';
import { takeInheritedSocket, vmmProxySocketName } from './vm/vmm';
import { binaryFileRuntime } from '../s16/files/runtime';

export { parseS15RuntimeConfig, readS15RuntimeConfig, readS15VmPool, type S15RuntimeConfig } from './runtime-config';

/**
 * Explicit S15 bootstrap only. It reuses the existing owner-session/CSRF/OAuth/device-login service in
 * separate protected state, mounts the Opus-authored S15 Web UI, and starts no S14 work pump. Setup
 * requires a fresh directory; serve refuses partial/missing journals. This is not live host adoption.
 */
export async function runS15(args: string[], env: NodeJS.ProcessEnv = process.env, protectedPorts: Pick<S15CompositionOptions, 'adoption'> = {}): Promise<void> {
  const index = args.indexOf('--config'), path = args[index + 1];
  if (!['setup', 'init', 'serve', 'owner-link', 'credential'].includes(args[0] ?? '') || !args.includes('--s15') || index < 0 || !path) throw new AppError('explicit_s15_config_required');
  const config = withModelAttempts(readS15RuntimeConfig(path)), setup = args[0] === 'setup', initialize = setup || args[0] === 'init', localCommand = ['owner-link', 'credential'].includes(args[0]!);
  if (args[0] === 'owner-link') requireS14OwnerLinkPipe(3);
  if (initialize) { mkdirSync(dirname(config.directory), { recursive: true, mode: 0o700 }); mkdirSync(config.directory, { mode: 0o700 }); }
  const state = lstatSync(config.directory);
  if (!state.isDirectory() || state.isSymbolicLink() || state.mode & 0o077) throw new AppError('unprotected_ledger');
  const ownerDirectory = join(config.directory, 'owner');
  if (initialize) mkdirSync(ownerDirectory, { mode: 0o700 });
  const ownerState = lstatSync(ownerDirectory);
  if (!ownerState.isDirectory() || ownerState.isSymbolicLink() || ownerState.mode & 0o077) throw new AppError('unprotected_ledger');
  const ownerPath = join(ownerDirectory, 'owner.sqlite');
  if (!initialize && !lstatSync(ownerPath).isFile()) throw new AppError('continuity_unavailable');
  const ownerStore = new S14Store(ownerPath);
  // Same API and separation as S14: broker secrets are outside state, backups and execution roots.
  const vault = new ConnectionVault(join(config.directory, 'vault'), { forbidden: [ownerDirectory, join(config.directory, 'runtime'), join(config.directory, 'backups')] });
  const ownerApp = new S14Application(ownerStore, { policy: s14Policy({}), chat: { async reply() { throw new AppError('s15_conversation_required'); } }, personal: { vault: new PersonalVault(vault) } });
  let service: Awaited<ReturnType<typeof composeS15>> | undefined;
  let provisioned: ProvisionedBrowser | null = null;
  try {
    if (args[0] === 'owner-link') { writeS14OwnerSetupLink(ownerStore, config.origin, 3); return; }
    if (args[0] === 'credential') {
      const key = args[args.indexOf('--key') + 1]; if (!key || !args.includes('--secret-stdin')) throw new AppError('secret_stdin_required');
      const secret = process.stdin.isTTY ? await readHiddenPassword() : (await Bun.stdin.text()).replace(/\r?\n$/, '');
      if (!secret || secret.length > 4096 || /[\r\n\0]/.test(secret)) throw new AppError('invalid_credential');
      vault.write(s15CredentialKey(config.installationId, key), secret); readS15Credential(vault, config.installationId, key); console.log(JSON.stringify({ state: 'credential_stored' })); return;
    }
    if (setup) {
      if (!process.stdin.isTTY && !args.includes('--password-stdin')) throw new AppError('password_stdin_flag_required');
      const password = process.stdin.isTTY ? await readHiddenPassword() : (await Bun.stdin.text()).replace(/\r?\n$/, '');
      await ownerApp.provisionOwner(password);
    }
    const generation = () => ownerStore.read(tx => tx.get<{ generation: number }>('SELECT generation FROM owner')?.generation ?? 1);
    const requireOwner = (proof: unknown) => {
      try { ownerStore.read(tx => ownerApp.requireOwner(tx, proof as import('../s14/types').OwnerActor)); return { id: 'owner', generation: generation(), expiresAt: Date.now() + 1000 }; } catch { return null; }
    };
    const vmPool = readS15VmPool(config.vm);
    // VM15-03: under the installed unit, systemd binds the registry-proxy socket in the root mount namespace.
    const proxySocketFd = !initialize && config.vm.vmm ? takeInheritedSocket(vmmProxySocketName) : null;
    // Approved subscription routes become available once this identity's Web device login stores a credential.
    const availability = liveRouteAvailability();
    let availabilityTimer: ReturnType<typeof setInterval> | undefined;
    if (!initialize && !localCommand) {
      await availability.refresh(config.models);
      availabilityTimer = setInterval(() => { void availability.refresh(config.models).catch(() => {}); }, 15_000); availabilityTimer.unref?.();
    }
    const models = () => config.models.map(route => availability.apply(route));
    // GitHub work names the pool; the composed port places each work on a member and keeps it there.
    const git = config.github ? githubRuntime(config.github, { directory: config.directory, vmId: vmPool.poolId, route: config.conversation.route, modelCallUpperBound: config.conversation.modelCallUpperBound, credential: ref => readS15Credential(vault, config.installationId, ref) }) : null;
    // BROW15-02: without an explicit `browser` config, an S15 installation gets the protected browser with the
    // pinned Chromium and the owner's approved-website list (empty until the owner adds a website in the Web).
    if (!config.browser && config.disclosure) provisioned = openProvisionedBrowser({ directory: config.directory, installationId: config.installationId });
    // POLICY15-02: the runtime registers the default purposes and the approved routes' provider recipients; explicit rows win.
    const defaultCatalog = s15DefaultCatalog(config.models);
    // AUTH16-01: installation-wide people the owner addressed and remembered private-data recipients (ADR 0084).
    const recipients = new RecipientDirectory(join(config.directory, 'recipients.sqlite'), config.installationId);
    const catalogs: S15CompositionOptions['catalogs'] = {
      current: (kind, id) => (kind === 'lineage' ? git?.current(id) ?? config.disclosure?.sources.find(s => s.ref.id === id) : null) ?? config.catalog.find(row => row.kind === kind && row.ref.id === id) ?? provisioned?.catalog(kind, id) ?? recipients.catalog(kind, id) ?? defaultCatalog.find(row => row.kind === kind && row.ref.id === id) ?? null,
      allows: (work, action) => {
        const resources = action?.resources ?? work.request.resources;
        return resources.every(resource => { const restriction = config.resourceBots.find(r => r.resourceId === resource.id); return !restriction || restriction.botIds.includes(work.request.bot.id); });
      },
    };
    if (config.vm.limaInstance && config.vm.remote) throw new AppError('vm_management_scope_denied');
    const managers = new Map<string, import('./vm').VmManagement>(config.vm.remote ? [['working', new RemoteVmManagement({ origin: config.vm.remote.origin, credential: () => readS15Credential(vault, config.installationId, config.vm.remote!.credentialRef), allowLoopback: true })]] : config.vm.limaInstance ? [['working', new LimaVmManagement({ instance: config.vm.limaInstance })]] : []);
    const account = (id: string | null): GoogleEffectAccount | null => {
      if (!id || !config.google) return null;
      try {
        const connection = ownerStore.read(tx => ownerApp.personal.connection(tx, id));
        const binding = config.google.resources.find(r => r.connectionId === id); if (!binding) return null;
        return { resource: { ...binding.resource, revision: connection.revision }, account: connection.account, calendarId: connection.calendarId, scopes: connection.scopes };
      } catch { return null; }
    };
    const site: BrowserSitePolicy = { loginDocuments: [], session: null,
      observable: url => !!config.browser?.publicOrigins.includes(new URL(url).origin),
      classify(request) { const u = new URL(request.url); return config.browser?.publicOrigins.includes(u.origin) && request.method === 'GET' && request.navigation && !request.bodyBase64 && !u.search ? { kind: 'read', private: false } : null; } };
    service = await composeS15({ runtime: 's15', directory: join(config.directory, 'runtime'), create: initialize, installationId: config.installationId, origin: config.origin,
      ...protectedPorts,
      ...(config.routines ? { routines: {} } : {}),
      ...(config.notifications ? { notifications: {} } : {}),
      // TEAM16-01: owner decision 2026-11-07, a working computer with no open session sleeps after 30 minutes.
      ...(config.computers ? { computers: { idleStopMs: s16ComputerIdleStopMs } } : {}),
      // DESK16-01: watch and take over a desktop working computer.
      ...(config.computers && config.desktop ? { screen: {} } : {}),
      // BOT16-01/DELEG16-01: persistent Bots the owner accepts and bounded Bot-to-Bot assignments.
      ...(config.bots ? { bots: {} } : {}),
      // CONN16-01/MCP16-01/OPEN16-01: apps and tool sources the owner connects; secrets stay in the protected vault.
      ...(config.connections ? { connections: { vault } } : {}),
      ...(config.files ? { files: { ...(typeof config.files === 'object' ? { parserRuntime: binaryFileRuntime(config.files, config.directory, env), imageProbes: config.files.imageProbes } : {}), ...(config.fileMemory ? { memory: true } : {}) } } : {}),
      recipients,
      owner: { authenticate: token => { const auth = ownerApp.authenticate(token); return { proof: auth.actor, csrf: auth.csrf }; }, generation, verifyOwner: requireOwner, verifyCsrf: (expected, supplied) => ownerApp.verifyCsrf(expected, supplied) }, catalogs,
      ...(config.disclosure ? { disclosure: (configured => provisioned ? provisioned.disclosure(configured) : configured)(runtimeDisclosure(config.disclosure, config.models, catalogs, () => [...(config.google?.recipients ?? []), ...recipients.bindings()], config.github ? undefined : { ...s15GithubRecipient }, () => recipients.approvals())) } : {}),
      // POLICY15-02: approved subscription routes need no owner budget; the registry bounds each work. Without a configured
      // policy the owner reviews a default proposal; GIT15-04: without a configured GitHub the owner connects it in the Web.
      subscriptionModels: s15SubscriptionModels(models, config.team?.maxConcurrentOperations ?? 2),
      ...(config.policy ? {} : { defaultPolicy: { concurrency: config.team?.maxConcurrentOperations ?? 2 } }),
      ...(!config.github && config.disclosure ? { githubWeb: { vault, runtime: input => githubConnectionRuntime({ directory: config.directory, vmId: vmPool.poolId, route: config.conversation.route, modelCallUpperBound: config.conversation.modelCallUpperBound, ...input }) } } : {}),
      ...(config.recurring ? { recurring: config.recurring } : {}),
      ...(config.team ? { team: { maxConcurrentOperations: config.team.maxConcurrentOperations, retention: work => config.team!.memory === 'off' ? null : config.team!.memory === 'team' ? { kind: 'team' as const } : { kind: 'bot' as const, botId: work.request.bot.id, origin: 's15' as const } } } : {}),
      conversation: config.conversation, proposedPolicy: config.policy,
      model: { limits: config.modelLimits, registry: { list: models, current: selection => models().find(r => equal(r.selection, selection)) ?? null, pins: () => ({ route: null, model: null, effort: null }) } },
      ...(git ? { github: git.github, reads: [git.readHandler] } : {}),
      web: { accounts: { list(actor) { service!.policy.owner.current(actor); return [
        ...models().map(model => ({ id: model.account.id, kind: 'model' as const, label: model.provider, state: model.availability === 'available' ? 'configured' as const : 'unavailable' as const, uses: ['model' as const], signInHref: '/settings/provider' })),
        ...(config.github ? [{ id: 'github', kind: 'service' as const, label: 'GitHub', state: 'configured' as const, uses: ['github' as const], signInHref: null }] : []),
        ...(config.google ? [{ id: 'google', kind: 'service' as const, label: 'Google', state: account(config.google.mailConnectionId) || account(config.google.calendarConnectionId) ? 'configured' as const : 'not_connected' as const, uses: ['email_read' as const, 'email_draft' as const, 'calendar' as const], signInHref: '/settings/google' }] : []),
      ]; } } },
      vm: { id: vmPool.poolId, resource: config.vm.resource, managers, managementVault: vault, upperBound: () => config.vm.upperBound, destination: host => config.disclosure?.acquisitions.find(r => new URL(r.origin).hostname === host)?.recipient ?? null, ...(vmPool.local ? { local: { ...(config.vm.vmm ? { vmm: config.vm.vmm, ...(proxySocketFd !== null ? { proxySocketFd } : {}) } : {}), ...(config.computers && config.desktop ? { desktop: true } : {}) } } : {}) },
      ...(config.browser ? { browser: { mode: 'static', resource: config.browser.resource, fences: [], executablePath: config.browser.executablePath, site, upperBound: config.browser.upperBound, ...(config.browser.ownerUi ? { ownerUi: config.browser.ownerUi } : {}) } } : provisioned ? { browser: provisioned.options() } : {}),
      ...(config.google ? { google: { runtime: 's15', google: new GooglePersonal(), mailAccount: () => account(config.google!.mailConnectionId), calendarAccount: () => account(config.google!.calendarConnectionId),
        async token(binding, scope) { const current = ownerStore.read(tx => s15GoogleConnection(config.google!.resources, binding, scope, id => ownerApp.personal.connection(tx, id)));
          return ownerApp.personal.token(current, () => { ownerStore.read(tx => ownerApp.personal.connection(tx, current.id, current.revision)); }); },
        recipients: () => [...config.google!.recipients, ...recipients.bindings()], bindRecipient: address => recipients.bind(address), attachment: () => null, bounds: config.google.bounds, now: Date.now } } : {}),
    });
    if (initialize) {
      // SETUP15-01: on a KVM controller the owner's `setup --s15` creates, starts and enrolls the default
      // working computer with no typed value, printing one JSON line per step. Interrupting it is safe: the
      // durable job resumes at the next `serve`. Without KVM it reports why; the Web offers enrollment instead.
      const computer = setup && service.provisioning ? await setupComputer(service.provisioning, line => console.log(JSON.stringify(line))) : null;
      await service.close(); service = undefined; await provisioned?.close(); provisioned = null; console.log(JSON.stringify({ state: 's15_initialized', policy: 'not_installed', readiness: 'configured_unverified', ...(computer ? { computer } : {}) })); return;
    }
    const binding = personalServiceBinding(config.origin), auth = createS14Handler(ownerApp, config.origin, renderS14, createS14Product(ownerApp), createS14Auth(ownerApp));
    const server = Bun.serve({ hostname: binding.hostname, port: binding.port, async fetch(request) {
      try { const incoming = binding.proxy ? personalProxyRequest(request, config.origin) : request, url = new URL(incoming.url);
        return url.pathname.startsWith('/s14/') || url.pathname.startsWith('/owner/') || url.pathname.startsWith('/api/s14/sign-in/') || ['/api/s14/providers', '/api/s14/personal', '/settings/provider'].includes(url.pathname) || url.pathname.startsWith('/settings/google') || url.pathname.startsWith('/api/s14/personal/oauth/') || !!lookupS14Asset(url.pathname) ? auth(incoming) : service!.fetch(incoming);
      } catch { return new Response('host_rejected', { status: 403 }); }
    } });
    // Protected boot pass: resume an interrupted working-computer job, or start the first one on a ready KVM host.
    try { service.provisioning?.ensure(); } catch { /* The Web card shows the host reason and offers the owner's start. */ }
    // BROW15-02: verify (or download once) the pinned Chromium in the background; Resources → Websites shows each step.
    void provisioned?.chromium.start();
    const wake = setInterval(() => { void service?.drain().catch(() => {}); }, 1000);
    const shutdown = async () => { clearInterval(wake); clearInterval(availabilityTimer); server.stop(true); await service?.close(); await provisioned?.close(); await ownerApp.signIns.close(); await s14CredentialLifecycle().close(); ownerStore.close(); };
    process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
    process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
    console.log(JSON.stringify({ state: 's15_listening', origin: config.origin, contract: 's15-composition/v1', readiness: 'configured_unverified' }));
  } catch (error) { await service?.close(); await provisioned?.close(); ownerStore.close(); throw error; }
  finally { if (initialize || localCommand) ownerStore.close(); }
}

/**
 * POLICY15-02: every settled model call reports one attempt, so a route or conversation bound with `attempts: 0`
 * (written by installers before this release and preserved on upgrade) would record a permanent overrun on the
 * first call. Such bounds are read as one attempt per call; no other value changes.
 */
export function withModelAttempts(config: import('./runtime-config').S15RuntimeConfig): import('./runtime-config').S15RuntimeConfig {
  const fix = <T extends { attempts: number } | null>(bound: T): T => bound && bound.attempts === 0 ? { ...bound, attempts: 1 } : bound;
  return { ...config, conversation: { ...config.conversation, modelCallUpperBound: fix(config.conversation.modelCallUpperBound) }, models: config.models.map(route => ({ ...route, upperBound: fix(route.upperBound) })) };
}

/**
 * CLI progress for the automatic working computer: one `s15_computer_progress` line for every step transition
 * the job recorded (its retained history, so a step finished between polls is still printed, in order), then
 * the terminal projection (`enrolled`, `failed` with its step and code, `paused`, or `fallback` with the host code).
 */
export async function setupComputer(provisioning: import('./vm').LocalVmProvisioning, print: (line: Record<string, unknown>) => void, poll: (ms: number) => Promise<void> = ms => Bun.sleep(ms)): Promise<Record<string, unknown>> {
  const started = provisioning.ensure();
  if (!started) { const host = provisioning.options.host(); return host.state === 'ready' ? { state: 'enrolled', vmId: provisioning.options.vmId } : { state: 'fallback', code: host.code }; }
  // A job that already finished (setup re-run) prints no progress, only its terminal state.
  if (started.state === 'enrolled') return { state: 'enrolled', vmId: started.vmId };
  if (started.state === 'failed') return { state: 'failed', step: started.failedStep, code: started.error };
  let printed = 0, attemptStart = started.history[0]?.at ?? null;
  for (;;) {
    const view = provisioning.view()!;
    // A new attempt (owner retry elsewhere) restarts its history; print it from the beginning.
    if ((view.history[0]?.at ?? null) !== attemptStart) { attemptStart = view.history[0]?.at ?? null; printed = 0; }
    for (const entry of view.history.slice(printed)) if (entry.step !== 'enrolled') print({ state: 's15_computer_progress', step: entry.step });
    printed = view.history.length;
    if (view.state === 'enrolled') return { state: 'enrolled', vmId: view.vmId };
    if (view.state === 'failed') return { state: 'failed', step: view.failedStep, code: view.error };
    if (!view.active) return { state: 'paused', step: view.step };
    await poll(500);
  }
}
