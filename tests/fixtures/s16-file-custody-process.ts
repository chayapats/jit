import { lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileStore } from '../../src/s16/files/store';
import { launchPdf } from './s16-binary';

// Disposable process-death fixture. It deliberately never closes the owning stream/parser.
const [directory, installationId, ownerId, mode] = Bun.argv.slice(2) as [string, string, string, string];
let id = '';
const original = mode === 'validating' ? launchPdf() : Buffer.from('incomplete upload body\n');
const store = new FileStore({ path: join(directory, 'runtime/files.sqlite'), directory: join(directory, 'runtime/file-bytes'), installationId, create: false, resource: { id: 'computer', revision: 1, generation: 1 },
  requireOwner: () => ({ id: ownerId, generation: 1 }),
  ...(mode === 'validating' ? { parserRuntime: { s16: { contract: 's16-isolated-file/v1' as const, generation: 'localhost/jit-parser@sha256:' + 'a'.repeat(64) }, async available() { return true; }, async reset() {}, async run(job: { output: string }) { writeFileSync(join(job.output, 'text.txt'), 'unpublished output\n', { mode: 0o600 }); writeFileSync(join(job.output, 'result.json'), '{incomplete', { mode: 0o600 }); console.log(JSON.stringify({ id, state: store.journal.get<{ state: string }>(id).state })); await new Promise(() => {}); } } } : {}) });
const upload = store.create({} as never, { requestId: 'original_interrupted', conversationId: 'conversation', name: mode === 'validating' ? 'notes.pdf' : 'notes.txt', bytes: original.length, sha256: new Bun.CryptoHasher('sha256').update(original).digest('hex') }); id = upload.id;
const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(mode === 'validating' ? original : original.subarray(0, 4)); if (mode === 'validating') controller.close(); } });
const pending = store.write({} as never, id, stream);
if (mode === 'uploading') setTimeout(() => { if (lstatSync(join(directory, 'runtime/file-bytes', id + '.part')).size !== 4) process.exit(2); console.log(JSON.stringify({ id, state: store.journal.get<{ state: string }>(id).state })); }, 20);
await pending;
