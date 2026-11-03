import type { ExecutionBackend } from 'schway/host';
import { AppError } from '../../errors';
import { codingCommit, codingGit, codingGitOutput, codingQuote } from '../../s14/coding-protocol';

/** Validate a work-rooted coding directory without imposing S14's literal /workspace mount on the VM. */
async function pathCurrent(backend: ExecutionBackend, path: string): Promise<void> {
  const root = backend.workspaceRoot, relative = path.slice(root.length);
  if (!path.startsWith(root + '/coding/') || !/^\/coding\/[A-Za-z0-9_-]+$/.test(relative)) throw new AppError('github_workspace_invalid');
  let parent = root;
  for (const part of relative.slice(1).split('/')) {
    const entry = (await backend.list(parent)).find(e => e.name === part);
    if (!entry || entry.type !== 'directory') throw new AppError('github_workspace_invalid');
    parent += '/' + part; if (await backend.realpath(parent) !== parent) throw new AppError('github_workspace_invalid');
  }
  const git = (await backend.list(path)).find(e => e.name === '.git');
  if (!git || git.type !== 'directory' || await backend.realpath(path + '/.git') !== path + '/.git') throw new AppError('github_workspace_invalid');
}
async function clone(backend: ExecutionBackend, source: string, target: string, signal?: AbortSignal): Promise<void> {
  codingGitOutput(await codingGit(backend, backend.workspaceRoot, ['-c', 'protocol.file.allow=always', 'clone', '--template=', '--no-local', '--no-hardlinks', '--no-checkout', '--', source, target], signal));
  await pathCurrent(backend, target);
  codingGitOutput(await codingGit(backend, target, ['remote', 'remove', 'origin'], signal));
  codingGitOutput(await backend.spawn({ cwd: backend.workspaceRoot, command: `mkdir -p -- ${codingQuote(target + '/.git/info')}`, timeoutMs: 10000, ...(signal ? { signal } : {}) }));
  await backend.writeFileAtomically(target + '/.git/info/attributes', '* -filter -text -ident -working-tree-encoding\n');
}
/** Fresh raw checkout before commands; guest output remains explicitly cooperative evidence. */
export async function githubEvidenceCheckout(backend: ExecutionBackend, path: string, head: string, branch: string, signal: AbortSignal): Promise<void> {
  codingCommit(head); await pathCurrent(backend, path); const draft = path + '_draft';
  if ((await backend.list(backend.workspaceRoot + '/coding')).some(e => e.name === draft.split('/').at(-1))) throw new AppError('github_workspace_invalid');
  codingGitOutput(await backend.spawn({ cwd: backend.workspaceRoot, command: `mv -- ${codingQuote(path)} ${codingQuote(draft)}`, timeoutMs: 10000, signal }));
  await clone(backend, draft, path, signal); codingGitOutput(await codingGit(backend, path, ['checkout', '--no-track', '-B', branch, head, '--'], signal));
}
/** Verify actual raw bytes against the exact commit using fresh metadata, outside the editable index/config. */
export async function githubEvidenceSnapshot<T>(backend: ExecutionBackend, path: string, head: string, use: (git: (args: string[]) => Promise<string>, unchanged: boolean) => Promise<T>, signal?: AbortSignal): Promise<T> {
  codingCommit(head); await pathCurrent(backend, path); const scratch = backend.workspaceRoot + '/coding/verify_' + crypto.randomUUID().replaceAll('-', '');
  try {
    await clone(backend, path, scratch, signal); const git = async (args: string[]) => codingGitOutput(await codingGit(backend, scratch, args, signal));
    const current = (await git(['rev-parse', 'HEAD'])).trim(); await git(['read-tree', head]);
    await git(['--work-tree', path, '-c', 'core.filemode=true', '-c', 'core.ignorecase=false', 'add', '--all']);
    return await use(git, current === head && (await git(['write-tree'])).trim() === (await git(['rev-parse', `${head}^{tree}`])).trim());
  } finally { codingGitOutput(await backend.spawn({ cwd: backend.workspaceRoot, command: `rm -rf -- ${codingQuote(scratch)}`, timeoutMs: 10000 })); }
}
