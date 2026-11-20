import { containsCredential } from '../../security/credentials';
import { portableFiles, portableId, portableLimits, portablePath, portableTreeHash, type PortableFile, type PortableFileBytes } from './portable-protocol';
import type { VmPortableTransfer } from './types';
import { vmBytes, vmFail, vmHash, vmRecord } from './validation';

/** Host-only session lane. Every call still uses the owning service's policy/transport/publication guards. */
export function vmPortableTransfer(root: string, call: (request: Record<string, unknown>, kind: 'read' | 'write') => Promise<Record<string, unknown>>, guard: () => void, access: 'inspect' | 'execute' = 'execute'): VmPortableTransfer {
  const request = (op: string, id: string, input: readonly PortableFile[]) => { guard(); if (op !== 'portable_inspect' && access !== 'execute') vmFail('vm_inspect_only', 403); const files = portableFiles(input); return { op, importId: portableId(id), files, treeSha256: portableTreeHash(files) }; };
  const observed = (value: unknown, id: string): string | null => { const r = vmRecord(value, ['path']), path = `${root}/restored-${portableId(id)}`; if (r.path !== null && r.path !== path) vmFail('vm_protocol_invalid'); guard(); return r.path as string | null; };
  return Object.freeze({
    async capture(input: readonly string[]) {
      guard(); if (!Array.isArray(input) || !input.length || input.length > portableLimits.files) vmFail('vm_portable_limit');
      const paths = input.map(portablePath); portableFiles(paths.map(path => ({ path, bytes: 0, sha256: '0'.repeat(64) })));
      const files: PortableFileBytes[] = []; let total = 0;
      for (const path of paths) {
        guard(); const r = vmRecord(await call({ op: 'portable_read', path: `${root}/${path}` }, 'read'), ['data']), data = vmBytes(r.data, portableLimits.fileBytes);
        total += data.length; if (total > portableLimits.totalBytes) vmFail('vm_portable_limit'); if (containsCredential(Buffer.from(data).toString('utf8'))) vmFail('vm_credentials_denied', 403);
        files.push({ path, bytes: data.length, sha256: vmHash(data), data }); guard();
      }
      portableFiles(files.map(({ data: _data, ...file }) => file)); return files;
    },
    async begin(id: string, files: readonly PortableFile[]) { await call(request('portable_begin', id, files), 'write'); guard(); },
    async put(id: string, files: readonly PortableFile[], file: PortableFileBytes) {
      const r = request('portable_put', id, files), selected = r.files.find(item => item.path === file.path);
      if (!selected || !(file.data instanceof Uint8Array) || file.data.length !== selected.bytes || vmHash(file.data) !== selected.sha256 || containsCredential(Buffer.from(file.data).toString('utf8'))) vmFail('vm_portable_changed');
      await call({ ...r, relative: file.path, data: Buffer.from(file.data).toString('base64') }, 'write'); guard();
    },
    async commit(id: string, files: readonly PortableFile[]) { const path = observed(await call(request('portable_commit', id, files), 'write'), id); if (!path) vmFail('vm_portable_unknown'); return path; },
    async inspect(id: string, files: readonly PortableFile[]) { return observed(await call(request('portable_inspect', id, files), 'read'), id); },
  });
}
