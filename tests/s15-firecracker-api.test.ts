import { afterEach, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FirecrackerApi, FirecrackerApiError, type FirecrackerApiOperation } from '../src/s15/vm/firecracker/api';

const fixtures: { server: Server; directory: string; sockets: Set<Socket>; clients: FirecrackerApi[] }[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await Promise.all(f.clients.map(client => client.close()));
    for (const socket of f.sockets) socket.destroy();
    await new Promise<void>(resolve => f.server.close(() => resolve())); rmSync(f.directory, { recursive: true, force: true });
  }
});
async function fixture(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jit-fcapi-'))), path = join(directory, 'api.sock'), sockets = new Set<Socket>(), clients: FirecrackerApi[] = [];
  const requests: { method: string; path: string; body: string; headers: IncomingMessage['headers'] }[] = [];
  const entered = Promise.withResolvers<void>();
  const server = createServer((request, response) => {
    request.on('error', () => {}); response.on('error', () => {}); let body = '';
    request.on('data', chunk => { body += String(chunk); });
    request.once('end', () => { requests.push({ method: request.method!, path: request.url!, body, headers: request.headers }); response.setHeader('Content-Type', 'application/json'); entered.resolve(); handler(request, response, body); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(path, resolve)); fixtures.push({ server, directory, sockets, clients });
  return { path, requests, entered: entered.promise, client(options: { guard?: () => void | Promise<void>; timeoutMs?: number; maxInFlight?: number } = {}) { const client = new FirecrackerApi({ socketPath: path, guard: () => {}, ...options }); clients.push(client); return client; } };
}

test('real Unix HTTP selects only closed GET routes with no ambient network credential and settles descriptors', async () => {
  const f = await fixture((request, response) => response.end(JSON.stringify({ observed: request.url }))); let guards = 0;
  const client = f.client({ guard() { guards++; } });
  for (const [operation, path] of [['instance', '/'], ['version', '/version'], ['configuration', '/vm/config']] as const) {
    expect(await client.call(operation)).toEqual({ observed: path }); expect(client.active()).toBe(0);
  }
  expect(guards).toBe(9); expect(f.requests.map(row => [row.method, row.path])).toEqual([['GET', '/'], ['GET', '/version'], ['GET', '/vm/config']]);
  for (const row of f.requests) { expect(row.headers.authorization).toBeUndefined(); expect(row.headers.cookie).toBeUndefined(); expect(row.headers.connection).toBe('close'); expect(row.body).toBe(''); }
});

test('start sends one fixed mutation after its guards and a complete reply is not a running/stop certification', async () => {
  const f = await fixture((_request, response) => { response.writeHead(204); response.end(); }); const client = f.client();
  expect(await client.call('start')).toBeNull(); expect(f.requests.map(row => [row.method, row.path, row.body])).toEqual([['PUT', '/actions', '{"action_type":"InstanceStart"}']]); expect(client.active()).toBe(0);
});

test('lost mutation response stays unknown and starts no replacement, read-back or retry', async () => {
  const f = await fixture((_request, response) => response.socket!.destroy()); const client = f.client();
  await expect(client.call('start')).rejects.toMatchObject({ code: 'vm_firecracker_unavailable', outcome: 'unknown' });
  expect(f.requests.map(row => row.method)).toEqual(['PUT']); expect(client.active()).toBe(0);
});

test('a redirect response is refused without following a network URL or publishing its body', async () => {
  const f = await fixture((_request, response) => { response.writeHead(302, { Location: 'http://192.0.2.1/private' }); response.end('{"fault_message":"DO_NOT_PUBLISH"}'); });
  const client = f.client(); let failure: unknown;
  try { await client.call('configuration'); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'vm_firecracker_api_refused', httpStatus: 302 }); expect(String(failure)).not.toContain('DO_NOT_PUBLISH'); expect(String(failure)).not.toContain(f.path);
  expect(f.requests).toHaveLength(1); expect(client.active()).toBe(0);
});

test.each(['{"state":"Running","state":"Paused"}', '[]', '12', 'null', '{"x":'])('invalid/duplicate JSON never reaches publication: %j', async text => {
  const f = await fixture((_request, response) => response.end(text)); const client = f.client();
  await expect(client.call('instance')).rejects.toMatchObject({ code: 'vm_firecracker_protocol_invalid' }); expect(client.active()).toBe(0); expect(f.requests).toHaveLength(1);
});

test('malformed UTF-8 is refused rather than replacement-decoded into an instance projection', async () => {
  const f = await fixture((_request, response) => response.end(Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125]))); const client = f.client();
  await expect(client.call('instance')).rejects.toMatchObject({ code: 'vm_firecracker_protocol_invalid' }); expect(client.active()).toBe(0);
});

test.each(['text/plain', 'text/html'])('unexpected content type %s is refused', async contentType => {
  const f = await fixture((_request, response) => { response.setHeader('Content-Type', contentType); response.end('{}'); });
  await expect(f.client().call('version')).rejects.toMatchObject({ code: 'vm_firecracker_protocol_invalid' });
});

test('duplicate headers and encoded responses are refused before body interpretation', async () => {
  const duplicate = await fixture((_request, response) => { response.setHeader('X-Duplicate', ['a', 'b']); response.end('{}'); });
  await expect(duplicate.client().call('version')).rejects.toMatchObject({ code: 'vm_firecracker_protocol_invalid' });
  const compressed = await fixture((_request, response) => { response.setHeader('Content-Encoding', 'gzip'); response.end('{}'); });
  await expect(compressed.client().call('version')).rejects.toMatchObject({ code: 'vm_firecracker_protocol_invalid' });
});

test('oversized declared and chunked bodies close the original transport with no uncaught response error', async () => {
  const declared = await fixture((_request, response) => { response.setHeader('Content-Length', '40000'); response.end('{}'); });
  const a = declared.client(); await expect(a.call('configuration')).rejects.toMatchObject({ code: 'vm_firecracker_protocol_invalid' }); expect(a.active()).toBe(0);
  const chunked = await fixture((_request, response) => { response.write(' '.repeat(32768)); response.end('{}'); });
  const b = chunked.client(); await expect(b.call('configuration')).rejects.toMatchObject({ code: 'vm_firecracker_protocol_invalid' }); expect(b.active()).toBe(0);
});

test('current generation is rechecked after a complete mutation reply and a late guard cannot publish it', async () => {
  const final = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let generation = 1, calls = 0;
  const f = await fixture((_request, response) => { response.writeHead(204); response.end(); });
  const client = f.client({ async guard() { if (++calls === 3) { final.resolve(); await release.promise; } if (generation !== 1) throw Object.assign(new Error('stale'), { code: 'vm_fenced' }); } });
  const waiting = client.call('start'); await final.promise; generation = 2; release.resolve();
  await expect(waiting).rejects.toMatchObject({ code: 'vm_fenced', outcome: 'response', httpStatus: 204 }); expect(f.requests).toHaveLength(1); expect(client.active()).toBe(0);
});

test('one finite budget includes a silent peer and a stalled preparation guard', async () => {
  const silent = await fixture(() => {}), a = silent.client({ timeoutMs: 30 });
  await expect(a.call('instance')).rejects.toMatchObject({ code: 'vm_firecracker_timeout', outcome: 'unknown' }); expect(a.active()).toBe(0); expect(silent.requests).toHaveLength(1);
  const release = Promise.withResolvers<void>(), neverSent = await fixture(() => {}), b = neverSent.client({ timeoutMs: 20, guard: () => release.promise });
  await expect(b.call('start')).rejects.toMatchObject({ code: 'vm_firecracker_timeout', outcome: 'not_sent' }); release.resolve(); await Promise.resolve(); expect(neverSent.requests).toEqual([]); expect(b.active()).toBe(0);
});

test('pending guard reserves capacity; close cancels original calls before any late private endpoint I/O', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), f = await fixture(() => {});
  const client = f.client({ maxInFlight: 1, guard() { entered.resolve(); return release.promise; } });
  const waiting = client.call('start'); await entered.promise; expect(client.active()).toBe(1);
  await expect(client.call('version')).rejects.toMatchObject({ code: 'vm_firecracker_capacity', outcome: 'not_sent' });
  const rejected = waiting.catch(error => error);
  await client.close(); expect(await rejected).toMatchObject({ code: 'aborted', outcome: 'not_sent' }); release.resolve(); await Promise.resolve(); expect(client.active()).toBe(0); expect(f.requests).toEqual([]);
  await expect(client.call('instance')).rejects.toMatchObject({ code: 'vm_firecracker_closed', outcome: 'not_sent' }); await client.close();
});

test('abort after receiving a body but before final publication retains response observation and closes capacity', async () => {
  const final = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), abort = new AbortController(); let calls = 0;
  const f = await fixture((_request, response) => response.end('{}'));
  const client = f.client({ async guard() { if (++calls === 3) { final.resolve(); await release.promise; } } });
  const waiting = client.call('configuration', abort.signal); await final.promise; abort.abort();
  await expect(waiting).rejects.toMatchObject({ code: 'aborted', outcome: 'response' }); release.resolve(); await Promise.resolve(); expect(client.active()).toBe(0); expect(f.requests).toHaveLength(1);
});

test('a configuration reload cannot repoint an existing client or replace its current-custody guard', async () => {
  const original = await fixture((_request, response) => response.end('{"original":true}')), other = await fixture((_request, response) => response.end('{"other":true}')); let guards = 0;
  const options = { socketPath: original.path, guard() { guards++; options.socketPath = other.path; options.guard = () => {}; } };
  const client = new FirecrackerApi(options);
  try { expect(await client.call('instance')).toEqual({ original: true }); expect(guards).toBe(3); expect(other.requests).toEqual([]); } finally { await client.close(); }
});

test('invalid selections and pre-abort start no authority guard, socket or network fallback', async () => {
  let guards = 0; const f = await fixture(() => {});
  const client = f.client({ guard() { guards++; } }), abort = new AbortController(); abort.abort();
  await expect(client.call('instance', abort.signal)).rejects.toMatchObject({ code: 'aborted', outcome: 'not_sent' });
  await expect(client.call('/metrics' as FirecrackerApiOperation)).rejects.toMatchObject({ code: 'vm_firecracker_invalid', outcome: 'not_sent' });
  for (const patch of [{ socketPath: 'relative' }, { socketPath: '/tmp/../socket' }, { timeoutMs: 0 }, { timeoutMs: 5001 }, { maxInFlight: 0 }, { maxInFlight: 5 }]) expect(() => new FirecrackerApi({ socketPath: f.path, guard() { guards++; }, ...patch })).toThrow('vm_firecracker_invalid');
  expect(guards).toBe(0); expect(f.requests).toEqual([]);
});

test('response headers cannot exceed the selected finite bound even on a different native HTTP parser', async () => {
  const f = await fixture((_request, response) => { response.setHeader('X-Oversized', 'a'.repeat(9000)); response.end('{}'); });
  const client = f.client(); const failure = await client.call('version').catch(error => error);
  expect(failure).toBeInstanceOf(FirecrackerApiError);
  if (!(failure instanceof FirecrackerApiError)) throw failure;
  expect(['vm_firecracker_protocol_invalid', 'vm_firecracker_unavailable']).toContain(failure.code); expect(failure.outcome).toBe('unknown'); expect(client.active()).toBe(0);
});
