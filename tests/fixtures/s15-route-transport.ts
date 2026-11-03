import { createHash } from 'node:crypto';
import { credentialReferenceForRoute, type HostAuthFetch, type HostCredentialStore } from 'schway/host';

/** Exact model ids each scripted route lists. */
export const ROUTE_MODEL = { grok: 'grok-4.7', codex: 'gpt-6-luna' } as const;
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** A completed Responses stream with one text message and reported usage. */
export function responsesStream(text = 'Completed the selected step.'): Response {
  const events = [
    { type: 'response.created', response: { id: 'resp', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg', type: 'message', role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'msg', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] } },
    { type: 'response.completed', response: { id: 'resp', status: 'completed', usage: { input_tokens: 3, output_tokens: 2 } } },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
}

/**
 * Scripted provider transport and in-memory credential store for Schway's public route seam
 * (`HostAuthSelection.store`/`fetch`). No network, account or credential leaves the process. Inference
 * requests answer from `responses` in order (`401` = auth rejection, `ok` = completed stream).
 */
export function routeTransport(route: 'grok' | 'codex', script: { responses?: (401 | 'ok')[]; levels?: string[]; renewal?: () => Promise<void> } = {}) {
  const values = new Map<string, string>(), bodies: string[] = [], catalogs: string[] = [], renewals: string[] = [];
  const responses = [...(script.responses ?? ['ok'])];
  let levels = script.levels ?? ['low', 'high'], afterCatalogRead: (() => void) | null = null, armed: (() => void) | null = null;
  const tokens = (access: string) => JSON.stringify({ accessToken: access, refreshToken: 'fixture-refresh', obtainedAt: 1, expiresAt: 9_000_000_000_000, ...(route === 'codex' ? { accountId: 'fixture-account' } : {}) });
  values.set(credentialReferenceForRoute(route).account, tokens('fixture-access'));
  const store: HostCredentialStore = {
    async get(ref) { const hook = armed; armed = null; hook?.(); return values.get(ref.account) ?? null; },
    async set(ref, value) { values.set(ref.account, value); },
    async delete(ref) { return values.delete(ref.account); },
  };
  const fetch: HostAuthFetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('https://api.x.ai/v1/models') || url.includes('/backend-api/codex/models')) {
      catalogs.push(url); armed = afterCatalogRead; afterCatalogRead = null;
      return Response.json(route === 'grok' ? { data: [{ id: ROUTE_MODEL.grok, supported_reasoning_levels: levels }] }
        : { models: [{ slug: ROUTE_MODEL.codex, visibility: 'list', supported_reasoning_levels: levels.map(effort => ({ effort })) }] });
    }
    if (url.startsWith('https://auth.x.ai/') || url.startsWith('https://auth.openai.com/')) {
      renewals.push(url); await script.renewal?.();
      return Response.json({ access_token: 'fixture-renewed', refresh_token: 'fixture-rotated', expires_in: 3600, id_token: 'fixture.id.token' });
    }
    if (url === 'https://api.x.ai/v1/responses' || url.includes('/backend-api/codex/responses')) {
      bodies.push(typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body as Uint8Array));
      return (responses.shift() ?? 'ok') === 401 ? Response.json({ error: { message: 'fixture token expired', type: 'invalid_request_error' } }, { status: 401 }) : responsesStream();
    }
    throw new Error(`unexpected fixture request ${url}`);
  };
  return {
    store, fetch, bodies, catalogs, renewals,
    /** Account change: later listings advertise these effort levels. */
    set levels(value: string[]) { levels = value; },
    /** Run `hook` inside the first credential read after the next catalog listing (the adapter's pre-send read). */
    onFirstReadAfterCatalog(hook: () => void) { afterCatalogRead = hook; },
  };
}
