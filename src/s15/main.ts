import { lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
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
import type { PersonalConnection } from '../s14/personal-types';
import { s14CredentialLifecycle } from '../s14/lifecycle';
import { requireS14OwnerLinkPipe, writeS14OwnerSetupLink } from '../s14/owner-bootstrap';
import { lookupS14Asset } from '../s14/web-assets';
import { composeS15, type S15CompositionOptions } from './composition';
import { LimaVmManagement } from './vm';
import { RemoteVmManagement } from './vm/remote';
import { equal, canonical } from './policy/validation';
import type { CatalogKind, PolicyInput, Ref } from './policy';
import type { ApprovedModelRoute, ModelRunLimits } from './model';
import type { EffectBounds, GoogleEffectAccount } from './effects';
import type { BrowserSitePolicy } from './browser';
import { githubRuntime, type GithubRuntimeConfig } from './github/runtime';

/** Credential-free explicit source/disposable-service configuration; never an existing omitted-runtime service file. */
export interface S15RuntimeConfig {
  contract: 's15-runtime/v1'; installationId: string; directory: string; origin: string;
  policy: PolicyInput | null;
  catalog: { kind: CatalogKind; ref: Ref; active: boolean }[];
  /** Optional narrower per-Bot resource ceilings. Absence never imports an S14-private resource. */
  resourceBots: { resourceId: string; botIds: string[] }[];
  conversation: S15CompositionOptions['conversation']; models: ApprovedModelRoute[]; modelLimits: ModelRunLimits;
  team?: { maxConcurrentOperations: number; memory: 'team' | 'bot' | 'off' };
  vm: { id: string; resource: Ref; limaInstance: string | null; remote?: { origin: string; credentialRef: string }; upperBound: import('./policy').BudgetVector };
  browser: null | { resource: Ref; executablePath: string; publicOrigins: string[]; upperBound: import('./policy').BudgetVector };
  github: GithubRuntimeConfig | null;
  google: null | { mailConnectionId: string | null; calendarConnectionId: string | null; bounds: EffectBounds; resources: { connectionId: string; resource: Ref }[]; recipients: { ref: Ref; address: string }[] };
}

/** Reads a bounded owner-controlled configuration. Embedded credentials are refused by canonical validation. */
export function readS15RuntimeConfig(path: string): S15RuntimeConfig {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.mode & 0o077 || s.size > 65536) throw new AppError('unsafe_s15_config');
  const value = JSON.parse(readFileSync(path, 'utf8')) as S15RuntimeConfig; canonical(value);
  if (value.contract !== 's15-runtime/v1' || !isAbsolute(value.directory) || !/^[A-Za-z0-9_-]{1,128}$/.test(value.installationId) || new URL(value.origin).origin !== value.origin || !Array.isArray(value.catalog) || !Array.isArray(value.models) || !value.models.length) throw new AppError('invalid_s15_config');
  if (!value.models.some(r => equal(r.selection, value.conversation.selection) && r.modelId === value.conversation.route.model && r.provider === value.conversation.route.provider)) throw new AppError('route_unavailable');
  return value;
}

/**
 * Explicit S15 bootstrap only. It reuses the existing owner-session/CSRF/OAuth/device-login service in
 * separate protected state, mounts the Opus-authored S15 Web UI, and starts no S14 work pump. Setup
 * requires a fresh directory; serve refuses partial/missing journals. This is not live host adoption.
 */
export async function runS15(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const index = args.indexOf('--config'), path = args[index + 1];
  if (!['setup', 'init', 'serve', 'owner-link', 'credential'].includes(args[0] ?? '') || !args.includes('--s15') || index < 0 || !path) throw new AppError('explicit_s15_config_required');
  const config = readS15RuntimeConfig(path), setup = args[0] === 'setup', initialize = setup || args[0] === 'init', localCommand = ['owner-link', 'credential'].includes(args[0]!);
  if (args[0] === 'owner-link') requireS14OwnerLinkPipe(3);
  if (initialize) { mkdirSync(dirname(config.directory), { recursive: true, mode: 0o700 }); mkdirSync(config.directory, { mode: 0o700 }); }
  const state = lstatSync(config.directory);
  if (!state.isDirectory() || state.isSymbolicLink() || state.mode & 0o077) throw new AppError('unprotected_ledger');
  const ownerPath = join(config.directory, 'owner.sqlite');
  if (!initialize && !lstatSync(ownerPath).isFile()) throw new AppError('continuity_unavailable');
  const ownerStore = new S14Store(ownerPath);
  const vault = new ConnectionVault(join(config.directory, 'vault'), { forbidden: [join(config.directory, 'runtime')] });
  const ownerApp = new S14Application(ownerStore, { policy: s14Policy({}), chat: { async reply() { throw new AppError('s15_conversation_required'); } }, personal: { vault: new PersonalVault(vault) } });
  let service: Awaited<ReturnType<typeof composeS15>> | undefined;
  try {
    if (args[0] === 'owner-link') { writeS14OwnerSetupLink(ownerStore, config.origin, 3); return; }
    if (args[0] === 'credential') {
      const key = args[args.indexOf('--key') + 1]; if (!key || !args.includes('--secret-stdin')) throw new AppError('secret_stdin_required');
      const secret = process.stdin.isTTY ? await readHiddenPassword() : (await Bun.stdin.text()).replace(/\r?\n$/, '');
      if (!secret || secret.length > 4096 || /[\r\n\0]/.test(secret)) throw new AppError('invalid_credential');
      vault.write(key, secret); console.log(JSON.stringify({ state: 'credential_stored' })); return;
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
    const git = config.github ? githubRuntime(config.github, { directory: config.directory, vmId: config.vm.id, route: config.conversation.route, modelCallUpperBound: config.conversation.modelCallUpperBound, credential: ref => vault.read(ref) }) : null;
    const catalogs: S15CompositionOptions['catalogs'] = {
      current: (kind, id) => (kind === 'lineage' ? git?.current(id) : null) ?? config.catalog.find(row => row.kind === kind && row.ref.id === id) ?? null,
      allows: (work, action) => {
        const resources = action?.resources ?? work.request.resources;
        return resources.every(resource => { const restriction = config.resourceBots.find(r => r.resourceId === resource.id); return !restriction || restriction.botIds.includes(work.request.bot.id); });
      },
    };
    if (config.vm.limaInstance && config.vm.remote) throw new AppError('vm_management_scope_denied');
    const managers = new Map<string, import('./vm').VmManagement>(config.vm.remote ? [['working', new RemoteVmManagement({ origin: config.vm.remote.origin, credential: () => vault.read(config.vm.remote!.credentialRef), allowLoopback: true })]] : config.vm.limaInstance ? [['working', new LimaVmManagement({ instance: config.vm.limaInstance })]] : []);
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
      owner: { authenticate: token => { const auth = ownerApp.authenticate(token); return { proof: auth.actor, csrf: auth.csrf }; }, generation, verifyOwner: requireOwner, verifyCsrf: (expected, supplied) => ownerApp.verifyCsrf(expected, supplied) }, catalogs,
      ...(config.team ? { team: { maxConcurrentOperations: config.team.maxConcurrentOperations, retention: work => config.team!.memory === 'off' ? null : config.team!.memory === 'team' ? { kind: 'team' as const } : { kind: 'bot' as const, botId: work.request.bot.id, origin: 's15' as const } } } : {}),
      conversation: config.conversation, proposedPolicy: config.policy,
      model: { limits: config.modelLimits, registry: { list: () => config.models, current: selection => config.models.find(r => equal(r.selection, selection)) ?? null, pins: () => ({ route: null, model: null, effort: null }) } },
      ...(git ? { github: git.github, reads: [git.readHandler] } : {}),
      vm: { id: config.vm.id, resource: config.vm.resource, managers, upperBound: () => config.vm.upperBound, destination: () => null },
      ...(config.browser ? { browser: { mode: 'static', resource: config.browser.resource, fences: [], executablePath: config.browser.executablePath, site, upperBound: config.browser.upperBound } } : {}),
      ...(config.google ? { google: { runtime: 's15', google: new GooglePersonal(), mailAccount: () => account(config.google!.mailConnectionId), calendarAccount: () => account(config.google!.calendarConnectionId),
        async token(binding, scope) { const current = ownerStore.read(tx => { const row = tx.get<{ record_json: string }>("SELECT record_json FROM personal_connections WHERE json_extract(record_json,'$.account')=? AND json_extract(record_json,'$.revision')=?", binding.account, binding.resource.revision); if (!row) throw new AppError('personal_connection_unavailable'); const value = JSON.parse(row.record_json) as PersonalConnection; if (!value.scopes.includes(scope)) throw new AppError('personal_consent_required'); return ownerApp.personal.connection(tx, value.id, value.revision); });
          return ownerApp.personal.token(current, () => { ownerStore.read(tx => ownerApp.personal.connection(tx, current.id, current.revision)); }); },
        recipients: () => config.google!.recipients, attachment: () => null, bounds: config.google.bounds, now: Date.now } } : {}),
    });
    if (initialize) { await service.close(); service = undefined; console.log(JSON.stringify({ state: 's15_initialized', policy: 'not_installed', readiness: 'configured_unverified' })); return; }
    const binding = personalServiceBinding(config.origin), auth = createS14Handler(ownerApp, config.origin, renderS14, createS14Product(ownerApp), createS14Auth(ownerApp));
    const server = Bun.serve({ hostname: binding.hostname, port: binding.port, async fetch(request) {
      try { const incoming = binding.proxy ? personalProxyRequest(request, config.origin) : request, url = new URL(incoming.url);
        return url.pathname.startsWith('/s14/') || url.pathname.startsWith('/owner/') || !!lookupS14Asset(url.pathname) ? auth(incoming) : service!.fetch(incoming);
      } catch { return new Response('host_rejected', { status: 403 }); }
    } });
    const wake = setInterval(() => { void service?.drain().catch(() => {}); }, 1000);
    const shutdown = async () => { clearInterval(wake); server.stop(true); await service?.close(); await ownerApp.signIns.close(); await s14CredentialLifecycle().close(); ownerStore.close(); };
    process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
    process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
    console.log(JSON.stringify({ state: 's15_listening', origin: config.origin, contract: 's15-composition/v1', readiness: 'configured_unverified' }));
  } catch (error) { await service?.close(); ownerStore.close(); throw error; }
  finally { if (initialize || localCommand) ownerStore.close(); }
}
