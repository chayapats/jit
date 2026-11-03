import type { ExecutionBackend } from 'schway/host';
import { createHash } from 'node:crypto';
import { AppError } from '../../errors';
import { repositoryBundle } from '../../s14/coding-preload';
import { codingGit, codingGitOutput, codingQuote } from '../../s14/coding-protocol';
import type { ReadHandler, S15PolicyService } from '../policy';
import { equal, unknownUsage } from '../policy/validation';
import type { GithubLimits, GithubRepository, GithubSelection } from './types';
import { digest, exact } from './validation';

/** Closed approved repository-byte read. Credentials stay with the protected Git object broker. */
export function githubBundleReadHandler(repositories: readonly GithubRepository[]): ReadHandler {
  return { operation: 'read', validate(payload, context) {
    exact(payload, ['kind', 'repository', 'base']);
    if (payload.kind !== 'github_bundle' || !repositories.some(r => r.name === payload.repository && equal(r.resource, context.resource)) || typeof payload.base !== 'string' || !/^[a-f0-9]{40}$/.test(payload.base)) throw new AppError('outside_scope');
  } };
}

/** Largest repository bundle the protected preload ever accepts (the S14 broker's pack limit). */
export const githubBundleMaxBytes = 16 * 1024 * 1024;

/** Fetches a pinned credential-free bundle through a charged protected read, then initializes only the admitted VM workspace.
 * The broker's pack limit is the smaller of `githubBundleMaxBytes` and the reserved read bound, so an accepted bundle never
 * exceeds the charge it was admitted under (an overrun would stop every later charge of the installation). */
export function createGithubPreload(options: { policy: S15PolicyService; repositories: readonly GithubRepository[]; credential(repository: GithubRepository): string; upperBound: GithubLimits['readUpperBound']; beforeRead?(work: import('../policy').WorkAuthority, payload: import('../policy').JsonValue): void; recordRead?(actor: import('../policy').WorkActor): void;
  /** Deterministic test seam for the protected bundle broker; production uses `repositoryBundle`. */
  fetchBundle?: typeof repositoryBundle }) {
  const packBytes = Math.min(githubBundleMaxBytes, options.upperBound.outputBytes);
  if (packBytes < 1) throw new AppError('cost_unknown');
  const schedule = (expire: () => void, timeoutMs: number) => { const timer = setTimeout(expire, timeoutMs); return () => clearTimeout(timer); };
  return async (backend: ExecutionBackend, selection: GithubSelection, guard: () => void): Promise<string> => {
    const repository = options.repositories.find(r => equal(r, selection.repository)); if (!repository) throw new AppError('outside_scope');
    guard(); const actor = options.policy.control.bindWork(selection.workId), claim = options.policy.work.reserveRead(actor, { requestId: 'bundle_' + crypto.randomUUID().replaceAll('-', ''), resource: repository.resource, operation: 'read', exactPayload: { kind: 'github_bundle', repository: repository.name, base: selection.base }, upperBound: options.upperBound, fences: [] });
    if (claim.state !== 'allow') throw new AppError(claim.code);
    let sent = false, returned = false, settled = false;
    let bytes: Uint8Array;
    try {
      // The public broker's guard is called after all credential waits and before each actual request.
      const secret = options.credential(repository);
      let dispatched = false;
      bytes = await (options.fetchBundle ?? repositoryBundle)({ id: repository.resource.id, revision: repository.resource.revision, botId: options.policy.work.guard(actor).request.bot.id, url: `https://github.com/${repository.name}.git`, baseCommit: selection.base, active: true, registry: null }, secret, AbortSignal.timeout(60000), () => {
        guard(); options.beforeRead?.(options.policy.work.guard(actor), { kind: 'github_bundle', repository: repository.name, base: selection.base }); if (!dispatched) { options.policy.work.guardRead(actor, claim.claim.id); sent = true; dispatched = true; } else options.policy.work.guard(actor);
      }, fetch, { packBytes, timeoutMs: 60000, schedule });
      if (bytes.length > packBytes) throw new AppError('coding_preload_size_limit', 413);
      returned = true; options.policy.control.settleRead(claim.claim.id, { outcome: 'succeeded', basis: 'remote_verified', code: null, actual: { ...unknownUsage(), outputBytes: bytes.length }, transportSettled: true }, createHash('sha256').update(bytes).digest('hex')); settled = true;
      guard(); options.recordRead?.(actor); options.policy.control.publishRead(actor, claim.claim.id);
    } catch (error) { if (!settled) options.policy.control.settleRead(claim.claim.id, { outcome: sent ? 'unknown' : 'not_dispatched', basis: sent ? 'uncertain' : 'local_guard', code: 'github_preload_unavailable', actual: unknownUsage(), transportSettled: returned || !sent }, null); throw error; }
    const root = backend.workspaceRoot, path = `${root}/coding/${selection.id}`, file = `${root}/preload.bundle`;
    guard(); await backend.writeFileAtomically(file + '.b64', Buffer.from(bytes).toString('base64'));
    codingGitOutput(await backend.spawn({ cwd: root, command: `base64 --decode -- ${codingQuote(file + '.b64')} > ${codingQuote(file)} && rm -f -- ${codingQuote(file + '.b64')}`, timeoutMs: 10000 }));
    const run = async (cwd: string, args: string[]) => { guard(); return codingGitOutput(await codingGit(backend, cwd, args, AbortSignal.timeout(30000))); };
    try {
      guard(); codingGitOutput(await backend.spawn({ cwd: root, command: `mkdir -p -- ${codingQuote(root + '/coding')}`, timeoutMs: 10000 }));
      if (await backend.realpath(root + '/coding') !== root + '/coding') throw new AppError('github_workspace_invalid');
      await run(root, ['-c', 'protocol.file.allow=always', 'clone', '--template=', '--no-local', '--no-hardlinks', '--no-checkout', '--', file, path]);
      await run(path, ['remote', 'remove', 'origin']);
      if ((await run(path, ['rev-parse', '--verify', `${selection.base}^{commit}`])).trim() !== selection.base) throw new AppError('github_base_changed');
      await run(path, ['checkout', '--no-track', '-b', selection.branch, selection.base, '--']); return path;
    } finally { guard(); codingGitOutput(await backend.spawn({ cwd: root, command: `rm -f -- ${codingQuote(file)}`, timeoutMs: 10000 })); }
  };
}
