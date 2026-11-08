import { afterEach, expect, test } from 'bun:test';
import { connect as dial } from 'node:net';
import { buildCatalog, mcpCandidates, reviewDecisions } from '../src/s16/connections/catalog';
import { importGraphql } from '../src/s16/connections/graphql';
import { eventStreamMessages, McpHttpSession, SourceAuthRequired } from '../src/s16/connections/mcp';
import { openSourceNetwork, sourceUrl } from '../src/s16/connections/net';
import { importOpenApi, openApiRequest, parseDocument } from '../src/s16/connections/openapi';
import { boundSchema, validateArguments } from '../src/s16/connections/schema';

// MCP16-01 / OPEN16-01 bounded importers, schema handling, the protected source network and the MCP HTTP client.
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
const code = (fn: () => unknown) => { try { fn(); return null; } catch (error) { return (error as { code?: string }).code ?? String(error); } };

test('OPEN16-01: OpenAPI operations become fixed requests; external refs, required headers and aliases refuse', () => {
  const doc = JSON.stringify({ openapi: '3.1.0', info: { title: 'Items', version: '2' }, servers: [{ url: 'https://api.example.com/v1' }],
    components: { schemas: { Item: { type: 'object', properties: { name: { type: 'string', maxLength: 40 } }, required: ['name'] } } },
    paths: {
      '/items/{id}': { parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], get: { operationId: 'getItem', summary: 'Read one item' }, delete: { operationId: 'deleteItem' } },
      '/items': { post: { operationId: 'createItem', requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Item' } } } } } },
      '/remote': { get: { operationId: 'remote', responses: { 200: { content: { 'application/json': { schema: { $ref: 'https://evil.example/schema.json' } } } } } } },
      '/headers': { get: { operationId: 'needsHeader', parameters: [{ name: 'X-Tenant', in: 'header', required: true }] } },
    } });
  const imported = importOpenApi(doc);
  expect(imported.base).toBe('https://api.example.com/v1');
  expect(imported.tools.map(t => [t.name, (t.binding as { method: string }).method])).toEqual([['getItem', 'GET'], ['deleteItem', 'DELETE'], ['createItem', 'POST']]);
  expect(imported.skipped).toEqual([{ name: 'remote', code: 'external_reference' }, { name: 'needsHeader', code: 'header_parameter_unsupported' }]);
  // The local reference is inlined; the schema never carries `$ref`.
  const create = imported.tools.find(t => t.name === 'createItem')!;
  expect(JSON.stringify(create.inputSchema)).not.toContain('$ref');
  expect(() => validateArguments(create.inputSchema, { body: { name: 'ok' } })).not.toThrow();
  expect(code(() => validateArguments(create.inputSchema, { body: { name: 'x'.repeat(41) } }))).toBe('source_arguments_invalid');
  expect(code(() => validateArguments(create.inputSchema, {}))).toBe('source_arguments_invalid');
  expect(code(() => validateArguments(create.inputSchema, { body: { name: 'ok' }, extra: 1 }))).toBe('source_arguments_invalid');
  // The request stays under the owner's endpoint: a path value cannot climb out of it.
  const get = imported.tools[0]!.binding as Parameters<typeof openApiRequest>[1];
  expect(openApiRequest('https://api.example.com/v1', get, { id: '../../admin?x=1' })).toEqual({ url: 'https://api.example.com/v1/items/..%2F..%2Fadmin%3Fx%3D1', method: 'GET', body: null });
  // Suggestions follow the method only as a hint: GET suggests a read, anything else waits for approval.
  const catalog = buildCatalog('openapi', 'https://api.example.com/v1', imported, 1);
  expect(catalog.tools.map(t => [t.name, t.suggested])).toEqual([['getItem', 'read'], ['deleteItem', 'approval'], ['createItem', 'approval']]);
  // YAML aliases (a small file that expands without bound) and unknown versions refuse.
  expect(code(() => parseDocument('openapi: 3.0.0\nbase: &a [1,2]\nmore: *a\n'))).toBe('source_document_aliases_unsupported');
  expect(code(() => importOpenApi(JSON.stringify({ swagger: '2.0' })))).toBe('source_document_unsupported');
  expect(importOpenApi('openapi: 3.0.3\ninfo: { title: Y, version: "1" }\npaths:\n  /a:\n    get:\n      operationId: readA\n').tools.map(t => t.name)).toEqual(['readA']);
});

test('OPEN16-01: GraphQL operations keep their real type; mutations can never be reviewed as reads; unbounded documents refuse', () => {
  const deep = 'query TooDeep { a { b { c { d { e { f { g { h { i { j { k { l { m { n } } } } } } } } } } } } } }';
  const doc = `
    # Owner-written operations
    query ListItems($first: Int!, $after: String) { items(first: $first, after: $after) { ...ItemFields } }
    mutation getUser($id: ID!) { harmless: deleteUser(id: $id) { ok } }
    subscription Watch { items { id } }
    ${deep}
    query Cycle { ...A }
    fragment A on Item { ...B }
    fragment B on Item { ...A }
    fragment ItemFields on Item { id name }
  `;
  const imported = importGraphql(doc);
  expect(imported.tools.map(t => [t.name, (t.binding as { operation: string }).operation])).toEqual([['ListItems', 'query'], ['getUser', 'mutation']]);
  expect(imported.skipped).toEqual([{ name: 'Watch', code: 'graphql_subscription_unsupported' }, { name: 'TooDeep', code: 'graphql_too_deep' }, { name: 'Cycle', code: 'graphql_fragment_cycle' }]);
  // Each tool sends only its own operation and the fragments it uses.
  const list = imported.tools[0]!.binding as { document: string };
  expect(list.document).toContain('query ListItems'); expect(list.document).toContain('fragment ItemFields'); expect(list.document).not.toContain('mutation');
  expect(imported.tools[0]!.inputSchema).toMatchObject({ properties: { first: { type: 'integer' }, after: { type: 'string' } }, required: ['first'] });
  const catalog = buildCatalog('graphql', 'https://gql.example.com/graphql', imported, 1);
  const mutation = catalog.tools.find(t => t.name === 'getUser')!;
  // The name says "get" and the field is aliased "harmless": it is still a mutation.
  expect(mutation).toMatchObject({ suggested: 'approval', allowed: ['change', 'approval', 'off'] });
  expect(code(() => reviewDecisions(catalog, { ListItems: 'read', getUser: 'read' }))).toBe('source_review_read_refused');
  expect(reviewDecisions(catalog, { ListItems: 'read', getUser: 'approval' })).toEqual({ ListItems: 'read', getUser: 'approval' });
  expect(code(() => reviewDecisions(catalog, { ListItems: 'read' }))).toBe('source_review_incomplete');
  expect(code(() => importGraphql('{ anonymous }'))).toBe('graphql_operation_name_required');
  expect(code(() => importGraphql('type Query { a: Int }'))).toBe('graphql_definition_unsupported');
});

test('MCP16-01: MCP hints are suggestions; any schema or hint change gives a new catalog hash', () => {
  const listed = [{ name: 'search', description: 'Find things', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'wipe', annotations: { readOnlyHint: true, destructiveHint: true } }, { name: 'bad name!' }, { name: 'refs', inputSchema: { type: 'object', properties: { a: { $ref: '#/x' } } } }];
  const result = mcpCandidates(listed, false, { name: 'srv', version: '1', protocol: '2025-06-18' });
  expect(result.skipped).toEqual([{ name: 'bad name!', code: 'tool_name_invalid' }, { name: 'refs', code: 'source_schema_unsupported' }]);
  const catalog = buildCatalog('mcp', 'https://mcp.example.com/mcp', result, 1);
  // A destructive tool that claims to be read-only is not suggested as a read.
  expect(catalog.tools.map(t => [t.name, t.suggested])).toEqual([['search', 'read'], ['wipe', 'approval']]);
  const flipped = buildCatalog('mcp', 'https://mcp.example.com/mcp', mcpCandidates([{ ...listed[0]!, inputSchema: { type: 'object', properties: { q: { type: 'string' }, scope: { type: 'string' } } } }, listed[1]!], false, result.server), 2);
  expect(flipped.hash).not.toBe(catalog.hash);
  expect(code(() => boundSchema({ type: 'array' }))).toBe('source_schema_unsupported');
  expect(eventStreamMessages('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n: comment\n\ndata: not json\n\n')).toEqual([{ jsonrpc: '2.0', id: 1, result: {} }]);
});

/** A local HTTP server reached through the checked egress: DNS answers a public address, the dial goes to loopback. */
function fixtureNetwork(handler: (request: Request) => Response | Promise<Response>, address = '93.184.215.14') {
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: handler });
  const network = openSourceNetwork({ allowHttp: true, resolve: async () => [{ address, family: 4 }], connect: () => dial({ host: '127.0.0.1', port: server.port! }) });
  cleanups.push(() => { network.close(); server.stop(true); });
  return { network, url: (path: string) => `http://mcp.example.com:${server.port}${path}` };
}

test('MCP16-01: private addresses and redirects refuse before a credential leaves; endpoints with credentials refuse', async () => {
  expect(code(() => sourceUrl('http://mcp.example.com/mcp'))).toBe('source_endpoint_invalid');
  expect(code(() => sourceUrl('https://user:pw@mcp.example.com/mcp'))).toBe('source_endpoint_invalid');
  expect(code(() => sourceUrl('https://localhost/mcp'))).toBe('source_address_not_public');
  const seen: string[] = [];
  const privateHost = fixtureNetwork(request => { seen.push(request.url); return new Response('{}'); }, '10.0.0.5');
  await expect(privateHost.network.request(privateHost.url('/mcp'), { method: 'POST', headers: { Authorization: 'Bearer secret' }, body: '{}', timeoutMs: 2000, maxBytes: 1000 })).rejects.toMatchObject({ code: 'source_address_not_public' });
  const metadata = fixtureNetwork(() => new Response('{}'), '169.254.169.254');
  await expect(metadata.network.request(metadata.url('/'), { method: 'GET', headers: {}, timeoutMs: 2000, maxBytes: 1000 })).rejects.toMatchObject({ code: 'source_address_not_public' });
  expect(seen).toEqual([]);
  const redirect = fixtureNetwork(request => { seen.push(new URL(request.url).pathname); return new Response(null, { status: 307, headers: { Location: 'http://169.254.169.254/latest' } }); });
  await expect(redirect.network.request(redirect.url('/mcp'), { method: 'POST', headers: {}, body: '{}', timeoutMs: 2000, maxBytes: 1000 })).rejects.toMatchObject({ code: 'source_redirect_refused' });
  expect(seen).toEqual(['/mcp']);
  const large = fixtureNetwork(() => new Response('x'.repeat(5000)));
  await expect(large.network.request(large.url('/'), { method: 'GET', headers: {}, timeoutMs: 2000, maxBytes: 1000 })).rejects.toMatchObject({ code: 'source_response_too_large' });
});

test('MCP16-01: one session per client over JSON and event-stream replies; a 401 names the resource metadata', async () => {
  const sessions: (string | null)[] = [];
  let issued = 0;
  const { network, url } = fixtureNetwork(async request => {
    if (request.method === 'DELETE') { sessions.push(`delete:${request.headers.get('mcp-session-id')}`); return new Response(null, { status: 204 }); }
    const body = await request.json() as { id?: number; method: string; params?: { name?: string } };
    sessions.push(request.headers.get('mcp-session-id'));
    if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'fixture', version: '1' }, capabilities: { tools: {} } } }, { headers: { 'Mcp-Session-Id': `s${++issued}` } });
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (body.method === 'tools/list') return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })}\n\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    if (body.method === 'tools/call') return Response.json({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: `echo:${body.params?.name}` }] } });
    return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no' } });
  });
  const a = await McpHttpSession.open(network, url('/mcp'), async () => ({ Authorization: 'Bearer a' }));
  const b = await McpHttpSession.open(network, url('/mcp'), async () => ({ Authorization: 'Bearer a' }));
  expect((await a.listTools()).tools.map(t => t.name)).toEqual(['echo']);
  expect(await b.call('echo', {})).toMatchObject({ outcome: 'succeeded', result: { content: [{ text: 'echo:echo' }] } });
  await a.close(); await b.close();
  // Each session's requests carried only its own server session identity, and each was ended.
  expect(sessions).toEqual([null, 's1', null, 's2', 's1', 's2', 'delete:s1', 'delete:s2']);
  const locked = fixtureNetwork(() => new Response(null, { status: 401, headers: { 'WWW-Authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"' } }));
  const refused = await McpHttpSession.open(locked.network, locked.url('/mcp'), async () => ({})).catch(error => error);
  expect(refused).toBeInstanceOf(SourceAuthRequired);
  expect((refused as SourceAuthRequired).resourceMetadata).toBe('https://mcp.example.com/.well-known/oauth-protected-resource');
});
