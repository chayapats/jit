import { AppError } from '../../../errors';
import { registerSecretFingerprint } from '../../../security/secret-fingerprints';
import { vmCanonical, vmInteger, vmRecord } from '../validation';
import type { FirecrackerRpcOperation } from './rpc';

/** Protected transport inputs only; ordinary clients and maintenance retain separate operation surfaces. */
export interface FirecrackerRequestOptions {
  origin: string; installationId: string; timeoutMs: number; credential(): string; guard(): void; fetch?: typeof fetch;
}
function fail(): never { throw new AppError('vm_firecracker_management_unavailable', 503); }
/** Existing finite authenticated loopback transport. It does not open or recover a controller journal. */
export async function requestFirecrackerManagement(options: FirecrackerRequestOptions, operation: FirecrackerRpcOperation): Promise<unknown> {
  const { origin, installationId, timeoutMs } = options, transport = options.fetch ?? fetch;
  const url = new URL(origin); if (url.origin !== origin || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || !/^[A-Za-z0-9_-]{1,128}$/.test(installationId)) return fail(); vmInteger(timeoutMs, 360000);
  const current = () => { if ((options.guard() as unknown) !== undefined) fail(); };
  current(); let credential: string; try { credential = options.credential(); } catch { return fail(); } if (!/^[A-Za-z0-9_-]{32,256}$/.test(credential)) return fail(); registerSecretFingerprint(credential);
  const controller = new AbortController(), expired = Promise.withResolvers<never>(), timer = setTimeout(() => { controller.abort(); expired.reject(new AppError('vm_firecracker_management_unavailable', 503)); }, timeoutMs);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const body = vmCanonical({ contract: 's16-firecracker-management/v1', installationId, ...operation }); if (Buffer.byteLength(body) > 4096) return fail(); current();
    const response = await Promise.race([transport(origin + '/v1/firecracker', { method: 'POST', redirect: 'error', signal: controller.signal, headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' }, body }), expired.promise]); current();
    if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'application/json' || Number(response.headers.get('content-length') ?? 0) > 16384 || !response.body) return fail();
    reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const next = await Promise.race([reader.read(), expired.promise]); current(); if (next.done) break; size += next.value.length; if (size > 16384) return fail(); chunks.push(next.value); }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))), r = vmRecord(value, ['contract', 'result']); if (r.contract !== 's16-firecracker-management/v1') return fail(); current(); return r.result;
  } catch { return fail(); }
  finally { clearTimeout(timer); controller.abort(); if (reader) void reader.cancel().catch(() => {}); }
}
