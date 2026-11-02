import { randomUUID } from 'node:crypto';
import type { ActionDraft, ActionRef, AdapterResult, JsonValue, S15PolicyService, WorkActor } from '../policy';
import { canonical, unknownUsage } from '../policy/validation';
import type { BrowserEngine, EngineOptions, EngineRequest, EngineInputContext } from './engine';
import { launchProtectedEngine } from './engine';
import type { BrokerResponse, BrowserOptions, BrowserRegistration, BrowserRequest, BrowserResult, BrowserWork, LoginState, RequestMeaning } from './types';
import { requestPayload } from './types';
import { browserContinuity } from './state';
import { BrowserError, browserUrl, bytesHash, operation, validateRequest } from './validation';

const id = () => randomUUID().replaceAll('-', '_');
const ref = (a: ActionRef): ActionRef => ({ id: a.id, revision: a.revision, actionHash: a.actionHash });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
/** Host-owned finite deadline source; deterministic tests advance it without sleeping. */
export interface BrowserClock { start(ms: number, callback: () => void): () => void }
const realClock: BrowserClock = { start(ms, callback) { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); } };
interface Scope {
  actor: WorkActor; generation: number; owner: boolean; count: number; stopped: boolean; abort: AbortController;
  held: ReturnType<typeof deferred<BrowserResult>>; interrupted: ReturnType<typeof deferred<BrowserResult>>;
  requests: Set<Promise<void>>; failure: string | null; released: boolean; verified: ActionRef[];
  input: EngineInputContext; nativeDone: Promise<unknown>; completion: Promise<BrowserResult>;
  cleanup(): void; unlock(): void;
}
interface Pending { scope: Scope; wire: EngineRequest; request: BrowserRequest; cookies: string; meaning: Extract<RequestMeaning, { kind: 'effect' }>; draft: ActionDraft; finish: () => void; response: BrokerResponse | null; used: boolean; released: boolean }
/** Construct only on the protected Jit host. The real policy adapter owns final exact-byte sends.
 * No S14 store/runtime is selected or modified. The injected engine is a trusted test/host dependency.
 */
export async function registerProtectedBrowser(options: BrowserOptions, factory: (options: EngineOptions) => Promise<BrowserEngine> = launchProtectedEngine, clock: BrowserClock = realClock): Promise<BrowserRegistration> {
  if (options.runtime !== 's15') throw new BrowserError('runtime_required');
  const continuity = browserContinuity(options.continuity.path, options.continuity.create, options.resource.id);
  let policy: S15PolicyService | null = null, actor: WorkActor | null = null, generation = continuity.advance();
  let login: LoginState = 'not_signed_in', currentUrl = 'about:blank', closed = false;
  let closing: Promise<void> | null = null;
  let currentLease: object | null = null;
  const scopes = new Set<Scope>();
  let active: Scope | null = null, busy: object | null = null, ownerSettling: Promise<unknown> = Promise.resolve();
  const pending = new Map<string, Pending>();
  const now = options.now ?? Date.now;
  const service = () => { if (!policy) throw new BrowserError('policy_unavailable'); return policy; };
  const guard = (s: Scope, input = true) => {
    if (s.failure) throw new BrowserError(s.failure);
    if (closed || s.stopped || s.abort.signal.aborted || s.generation !== generation || generation !== continuity.generation()) throw new BrowserError('stale_input');
    if (input && (s.owner ? login !== 'owner_control' : login === 'owner_control')) throw new BrowserError('owner_control');
    service().work.guard(s.actor);
  };
  const failure = (s: Scope): BrowserResult => s.released ? { state: 'unknown', code: 'reconciliation_required' } : { state: s.failure === 'cancelled' ? 'denied' : 'unknown', code: s.failure ?? 'operation_unavailable' };
  const interrupt = (s: Scope, code: string) => {
    s.failure ??= code; s.stopped = true; s.abort.abort();
    // Abort the paused browser route, never an already-released broker effect transport.
    for (const [key, p] of pending) if (p.scope === s) { void p.wire.deny().catch(() => {}); p.finish(); if (!p.released) pending.delete(key); }
    s.interrupted.resolve(failure(s)); void s.nativeDone.then(s.unlock, s.unlock);
  };
  const stop = () => { for (const s of scopes) interrupt(s, 'stale_input'); };
  const scope = (workActor: WorkActor, owner: boolean, unlock: () => void, signal?: AbortSignal): Scope => {
    const s = { actor: workActor, generation, owner, count: 0, stopped: false, abort: new AbortController(), held: deferred<BrowserResult>(), interrupted: deferred<BrowserResult>(), requests: new Set<Promise<void>>(), failure: null, released: false, verified: [], nativeDone: Promise.resolve(), completion: Promise.resolve({ state: 'ok', generation } as BrowserResult), unlock } as unknown as Scope;
    s.input = { signal: s.abort.signal, guard: () => guard(s) };
    const cancel = () => interrupt(s, 'cancelled'), timer = clock.start(30000, () => interrupt(s, 'operation_timeout'));
    signal?.addEventListener('abort', cancel, { once: true });
    s.cleanup = () => { timer(); signal?.removeEventListener('abort', cancel); };
    scopes.add(s); if (signal?.aborted) cancel(); return s;
  };
  const complete = (s: Scope, input: Promise<void>): Promise<BrowserResult> => {
    s.nativeDone = input.catch(() => {}); ownerSettling = s.nativeDone;
    const done = async (): Promise<BrowserResult> => {
      try {
        let inputError: unknown;
        try { await input; } catch (e) { inputError = e; }
        while (s.requests.size) await Promise.allSettled([...s.requests]);
        if (inputError) throw inputError;
        guard(s);
        for (const action of s.verified) continuity.settle(action);
        return { state: 'ok', generation };
      } catch (e) {
        if (e instanceof Error && e.name === 'TimeoutError') interrupt(s, 'operation_timeout');
        if (s.failure) return failure(s);
        if (s.released) { interrupt(s, 'operation_unavailable'); return failure(s); }
        return { state: 'unsupported', code: e instanceof BrowserError ? e.code : 'operation_unavailable' };
      } finally {
        s.stopped = true; s.cleanup(); scopes.delete(s); if (active === s) active = null; s.unlock();
      }
    };
    s.completion = done(); return s.completion;
  };
  async function exchange(r: BrowserRequest, cookies: string, signal?: AbortSignal): Promise<BrokerResponse> {
    // Only this protected broker opens outbound sockets. Redirects never follow inside fetch.
    const headers: Record<string, string> = { 'accept': '*/*', 'user-agent': 'Jit-Protected-Browser/1' };
    if (r.contentType) headers['content-type'] = r.contentType;
    if (cookies) headers.cookie = cookies;
    const response = await fetch(r.url, { method: r.method, headers, ...(r.bodyBase64 ? { body: Buffer.from(r.bodyBase64, 'base64') } : {}), redirect: 'manual', ...(signal ? { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) } : {}) });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new BrowserError('redirect_unsupported'); }
    const type = response.headers.get('content-type') ?? '';
    if (!!response.headers.get('content-disposition') && !/^inline(?:\s*;|$)/i.test(response.headers.get('content-disposition')!.trim()) || !/^(text\/(html|plain|css|javascript)|application\/(javascript|json|x-javascript)|image\/(png|jpeg|webp|gif|svg\+xml)|font\/|application\/font|application\/octet-stream)/i.test(type) && response.status !== 204 && !(response.status >= 300 && response.status < 400)) { await response.body?.cancel(); throw new BrowserError('download_unsupported'); }
    // Unknown/octet-stream is never delivered as a download or renderer payload.
    if (/application\/octet-stream/i.test(type)) { await response.body?.cancel(); throw new BrowserError('download_unsupported'); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
    if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2_097_152) { await reader.cancel(); throw new BrowserError('output_limit'); } chunks.push(value); }
    const safe: Record<string, string> = {};
    for (const key of ['content-type', 'location']) { const value = response.headers.get(key); if (value) safe[key] = value; }
    // Cookies may be set only by their actual origin; the browser enforces Domain/Path/HttpOnly.
    return { status: response.status, headers: safe, setCookies: response.headers.getSetCookie(), body: Buffer.concat(chunks) };
  }
  function network(wire: EngineRequest): Promise<void> {
    const s = active; if (!s) return wire.deny();
    const task = handleNetwork(s, wire); s.requests.add(task);
    void task.finally(() => s.requests.delete(task)).catch(() => {}); return task;
  }
  async function handleNetwork(s: Scope, wire: EngineRequest): Promise<void> {
    try {
      const request = wire.request; validateRequest(request);
      if (!wire.main || !s || ++s.count > 64) throw new BrowserError('unattributable_request');
      guard(s);
      let meaning = options.site.classify(Object.freeze(structuredClone(request)), options.mode);
      if (!meaning) throw new BrowserError('effect_semantics_unknown');
      if (meaning.kind === 'unsupported') throw new BrowserError(meaning.code);
      if (meaning.kind === 'login') {
        if (!wire.attributable || !s.owner || login !== 'owner_control' || !options.site.loginDocuments.includes(currentUrl)) throw new BrowserError('login_required');
        guard(s); const response = await exchange(request, wire.cookies, s.abort.signal); guard(s);
        if (wire.document) currentUrl = request.url;
        await wire.send(response); return;
      }
      const work = service().work.guard(s.actor);
      const disclosure = options.disclosure?.inspect(work, request);
      const cookies = meaning.kind === 'read' && !meaning.private ? '' : wire.cookies;
      if (meaning.kind === 'read' && disclosure?.classes.length) meaning = { kind: 'effect', classes: disclosure.classes, recipients: disclosure.recipients, transaction: null, impact: 'reversible', verifyResponse: () => 'succeeded' };
      if (meaning.kind === 'read') {
        if (!['GET', 'HEAD'].includes(request.method) || request.bodyBase64) throw new BrowserError('effect_semantics_unknown');
        const p = service();
        const admission = p.work.reserveRead(s.actor, { requestId: id(), resource: options.resource, operation: 'read', exactPayload: requestPayload(request), upperBound: { ...options.upperBound, reads: Math.max(1, options.upperBound.reads) }, fences: options.fences });
        if (admission.state !== 'allow') throw new BrowserError(admission.code);
        let response: BrokerResponse;
        try {
          guard(s); p.work.guardRead(s.actor, admission.claim.id);
          options.disclosure?.guard(p.work.guard(s.actor), request);
          // Final guard and socket creation share this synchronous turn.
          const promise = exchange(request, meaning.private ? wire.cookies : '', s.abort.signal);
          response = await promise;
          p.control.settleRead(admission.claim.id, { outcome: 'succeeded', basis: 'remote_verified', code: null, actual: unknownUsage(), transportSettled: true }, bytesHash(response.body));
        } catch (e) {
          const closedResponse = e instanceof BrowserError && ['redirect_unsupported', 'download_unsupported', 'output_limit'].includes(e.code);
          p.control.settleRead(admission.claim.id, { outcome: closedResponse ? 'failed' : 'unknown', basis: closedResponse ? 'remote_verified' : 'uncertain', code: null, actual: unknownUsage(), transportSettled: closedResponse }, null); throw e;
        }
        guard(s); options.disclosure?.record(p.work.guard(s.actor), request.url, 'response'); p.control.publishRead(s.actor, admission.claim.id);
        if (wire.document) currentUrl = request.url;
        await wire.send(response); return;
      }
      // JavaScript fetch/timer/beacon cannot prove causality from an input timing window.
      // Only a main-document submission is supported for effects; background effects fail closed.
      if (!wire.attributable || !request.navigation || !wire.document || s.owner) throw new BrowserError('unattributable_request');
      const token = id(), completion = deferred<void>();
      if (disclosure && meaning.recipients.some(r => !disclosure.recipients.some(actual => canonical(r) === canonical(actual)))) throw new BrowserError('recipient_changed');
      const draft: ActionDraft = { operation: 'browser_request', classes: [...new Set([...meaning.classes, ...(disclosure?.classes ?? [])])], resources: [...new Map([options.resource, ...(disclosure?.disclosure?.sources.map(source => source.resource) ?? [])].map(r => [canonical(r), r])).values()], recipients: disclosure?.recipients ?? meaning.recipients, payload: requestPayload(request), fences: [...new Map([...options.fences, ...(disclosure?.fences ?? [])].map(f => [canonical(f), f])).values()], upperBound: options.upperBound, expiresAt: now() + 30000, transaction: meaning.transaction, github: meaning.github ?? null, impact: meaning.impact, ...(disclosure?.disclosure ? { disclosure: disclosure.disclosure } : {}) };
      const item: Pending = { scope: s, wire, request, cookies, meaning, draft, finish: () => completion.resolve(), response: null, used: false, released: false };
      pending.set(token, item);
      let prepared: ReturnType<S15PolicyService['work']['prepare']>;
      try { prepared = service().work.prepare(s.actor, { slot: token, adapter: 'protected_browser', proposal: { token } }); } catch (e) { pending.delete(token); throw e; }
      pending.delete(token); pending.set(prepared.action.id, item);
      if (prepared.decision.state === 'allow') { const result = await dispatch(ref(prepared.action)); if (result.state !== 'ok') { s.held.resolve(result); await wire.deny(); } return; }
      if (prepared.decision.state !== 'hold') { pending.delete(prepared.action.id); throw new BrowserError(prepared.decision.code); }
      s.held.resolve({ state: 'held', code: prepared.decision.code, action: ref(prepared.action) });
      await completion.promise;
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') interrupt(s, 'operation_timeout');
      const code = error instanceof BrowserError || error instanceof Error && 'code' in error && typeof error.code === 'string' ? (error as { code: string }).code : 'request_unavailable';
      if (wire.document) s?.held.resolve({ state: 'unsupported', code });
      await wire.deny();
    }
  }
  let engine: BrowserEngine;
  try { engine = await factory({ profilePath: options.profilePath, executablePath: options.executablePath, mode: options.mode, request: network }); } catch (e) { continuity.close(); throw e; }
  async function dispatch(action: ActionRef): Promise<BrowserResult> {
    const item = pending.get(action.id); if (!item) return { state: 'unsupported', code: 'request_unavailable' };
    try {
      guard(item.scope);
      const decision = service().work.evaluate(item.scope.actor, action);
      if (decision.state !== 'allow') return decision.state === 'hold' ? { state: 'held', code: decision.code, action } : { state: 'denied', code: decision.code };
      continuity.arm(action);
      const outcome = await service().work.dispatch(item.scope.actor, action);
      if (outcome.outcome !== 'unknown' && outcome.outcome !== 'succeeded' && !item.scope.failure) continuity.settle(action);
      if (item.scope.failure) { item.finish(); await item.wire.deny(); pending.delete(action.id); return failure(item.scope); }
      if (outcome.outcome !== 'succeeded' || !item.response) { item.finish(); await item.wire.deny(); pending.delete(action.id); return { state: 'unknown', code: outcome.code ?? 'reconciliation_required' }; }
      guard(item.scope); service().control.publishable(item.scope.actor, action);
      if (item.wire.document) currentUrl = item.request.url;
      options.disclosure?.record(service().work.guard(item.scope.actor), item.request.url, 'response');
      await item.wire.send(item.response); guard(item.scope); item.scope.verified.push(ref(action)); item.finish(); pending.delete(action.id);
      return { state: 'ok', generation };
    } catch (e) { item.finish(); await item.wire.deny(); pending.delete(action.id); return item.released ? { state: 'unknown', code: 'reconciliation_required' } : { state: 'denied', code: e instanceof BrowserError ? e.code : 'request_unavailable' }; }
  }
  const ownerCheck = (owner: Parameters<BrowserRegistration['owner']['takeover']>[0], expected?: number) => { service().owner.current(owner); if (closed) throw new BrowserError('engine_unavailable'); if (generation !== continuity.generation()) throw new BrowserError('stale_input'); if (expected !== undefined && (generation !== expected || login !== 'owner_control')) throw new BrowserError('stale_input'); };
  const safe = () => { if (!options.site.observable(currentUrl, options.mode) || login === 'owner_control' || login === 'checking') throw new BrowserError('secret_boundary'); };
  const registration: BrowserRegistration = {
    adapter: {
      id: 'protected_browser', version: 1,
      prepare(proposal, ctx) { const token = (proposal as { token?: string })?.token; const item = token ? pending.get(token) : null; if (!item || service().work.guard(item.scope.actor).id !== ctx.work.id) throw new BrowserError('request_unavailable'); guard(item.scope); return structuredClone(item.draft); },
      async perform(action, context) {
        const item = pending.get(action.id); if (!item || item.used) throw new BrowserError('request_unavailable');
        guard(item.scope); item.used = true;
        return context.commit(requestPayload(item.request), async (): Promise<AdapterResult> => {
          guard(item.scope);
          options.disclosure?.guard(service().work.guard(item.scope.actor), item.request, action.disclosure);
          item.released = true; item.scope.released = true;
          item.response = await exchange(item.request, item.cookies);
          return { outcome: item.scope.failure ? 'unknown' : item.meaning.verifyResponse?.({ status: item.response.status, body: item.response.body }) ?? 'unknown', actual: unknownUsage(), transportSettled: true };
        });
      },
      async reconcile(action, context) {
        if (!options.site.reconcileEffect) throw new BrowserError('reconciliation_unsupported');
        const payload = action.payload as Record<string, JsonValue>;
        if (payload.contract !== 's15-browser-request/v1') throw new BrowserError('effect_semantics_unknown');
        const { contract: _, ...request } = payload;
        validateRequest(request as unknown as BrowserRequest);
        return options.site.reconcileEffect(Object.freeze(request as unknown as BrowserRequest), context);
      },
    },
    readHandler: { operation: 'read', validate(payload, context) {
      if (canonical(context.resource) !== canonical(options.resource)) throw new BrowserError('outside_scope');
      const p = payload as Record<string, JsonValue>;
      if (p?.contract === 's15-browser-observe/v1') {
        if (Object.keys(p).sort().join() !== ['contract', 'format', 'generation', 'url'].sort().join() || typeof p.url !== 'string' || !options.site.observable(p.url, options.mode) || p.generation !== generation || !['text', 'image'].includes(p.format as string)) throw new BrowserError('secret_boundary');
        return;
      }
      if (!p || p.contract !== 's15-browser-request/v1') throw new BrowserError('effect_semantics_unknown');
      const { contract: _, ...r } = p; validateRequest(r as unknown as BrowserRequest);
      if (options.site.classify(r as unknown as BrowserRequest, options.mode)?.kind !== 'read') throw new BrowserError('effect_semantics_unknown');
    } },
    attach(p) { if (policy) throw new BrowserError('policy_already_attached'); policy = p; },
    open(workActor) {
      service().work.guard(workActor); if (actor) throw new BrowserError('input_busy'); actor = workActor;
      const lease = Object.freeze({}); currentLease = lease;
      const bound = () => { if (actor !== workActor || currentLease !== lease) throw new BrowserError('stale_input'); service().work.guard(workActor); };
      const work: BrowserWork = {
        state: () => { bound(); return { generation, login, reconciliation: continuity.uncertain() }; },
        async execute(input, signal) {
          const lock = {}; let ownsBusy = false, deferredUnlock = false;
          const check = () => { if (signal?.aborted) throw new BrowserError('cancelled'); if (closed) throw new BrowserError('engine_unavailable'); };
          try {
            check(); operation(input); bound();
            if (input.generation !== generation || generation !== continuity.generation()) throw new BrowserError('stale_input');
            if (login === 'owner_control' || login === 'checking') throw new BrowserError('owner_control');
            if (busy || pending.size) throw new BrowserError('input_busy');
            busy = lock; ownsBusy = true;
            if (input.kind === 'read' || input.kind === 'find' || input.kind === 'screenshot') {
              safe();
              const p = service(), admission = p.work.reserveRead(workActor, { requestId: id(), resource: options.resource, operation: 'read', exactPayload: { contract: 's15-browser-observe/v1', url: currentUrl, format: input.kind === 'screenshot' ? 'image' : 'text', generation }, upperBound: options.upperBound, fences: options.fences });
              if (admission.state !== 'allow') throw new BrowserError(admission.code);
              p.work.guardRead(workActor, admission.claim.id);
              let result: BrowserResult;
              try {
                const observed = await engine.read(generation); check();
                if (!options.site.observable(observed.url, options.mode) || observed.url !== currentUrl) throw new BrowserError('secret_boundary');
                if (input.kind === 'find') observed.elements = observed.elements.filter(e => e.name.includes(input.text));
                if (input.kind === 'screenshot') {
                  const bytes = await engine.image(); check(); if (bytes.length > 2_097_152) throw new BrowserError('output_limit');
                  result = { state: 'image', pngBase64: Buffer.from(bytes).toString('base64'), generation };
                } else result = { state: 'observed', observation: observed };
                p.control.settleRead(admission.claim.id, { outcome: 'succeeded', basis: 'remote_verified', code: null, actual: unknownUsage(), transportSettled: true }, result.state === 'image' ? bytesHash(Buffer.from(result.pngBase64, 'base64')) : bytesHash(canonical(result)));
              } catch (e) { p.control.settleRead(admission.claim.id, { outcome: 'failed', basis: 'remote_verified', code: 'capture_unavailable', actual: unknownUsage(), transportSettled: true }, null); throw e; }
              check(); p.work.guard(workActor); safe(); if (input.generation !== generation || generation !== continuity.generation()) throw new BrowserError('stale_input');
              options.disclosure?.record(p.work.guard(workActor), currentUrl, input.kind === 'screenshot' ? 'image' : 'text');
              p.control.publishRead(workActor, admission.claim.id); return result;
            }
            if (continuity.uncertain()) return { state: 'unknown', code: 'reconciliation_required' };
            if (input.kind !== 'navigate') safe();
            options.disclosure?.input(service().work.guard(workActor));
            generation = continuity.advance();
            const s = scope(workActor, false, () => { if (busy === lock) busy = null; }, signal);
            active = s; deferredUnlock = true;
            const action = input.kind === 'navigate' ? engine.navigate(input.url, s.input) : engine.interact(input.kind, input.target, 'value' in input ? input.value : undefined, input.generation, s.input);
            const completion = complete(s, action);
            const result = await Promise.race([s.held.promise, s.interrupted.promise, completion]);
            if (result.state === 'held') s.unlock();
            else if (result.state === 'unsupported' || result.state === 'denied') {
              const settled = await Promise.race([completion, s.interrupted.promise]);
              if (settled.state === 'unknown') return settled;
            }
            return signal?.aborted ? failure(s) : result;
          } catch (e) { return { state: 'denied', code: e instanceof BrowserError ? e.code : 'authority_unavailable' }; }
          finally { if (ownsBusy && !deferredUnlock && busy === lock) busy = null; }
        },
        async settled() {
          if (actor !== workActor || currentLease !== lease) throw new BrowserError('stale_input');
          await Promise.allSettled([...scopes].filter(s => s.actor === workActor).map(s => s.completion));
        },
        release() { if (actor !== workActor || currentLease !== lease) return; if (busy || pending.size || login === 'owner_control') throw new BrowserError('input_busy'); generation = continuity.advance(); stop(); actor = null; currentLease = null; },
        async resume(action, signal) {
          bound(); if (signal?.aborted) return { state: 'denied', code: 'cancelled' };
          if (login === 'owner_control') return { state: 'denied', code: 'owner_control' };
          if (busy) return { state: 'denied', code: 'input_busy' };
          const lock = {}, item = pending.get(action.id), s = item?.scope; busy = lock;
          const cancel = () => { if (s) interrupt(s, 'cancelled'); }; signal?.addEventListener('abort', cancel, { once: true });
          try {
            const attempt = dispatch(action);
            const result = await (s ? Promise.race([attempt, s.interrupted.promise]) : attempt);
            if (result.state === 'ok' && s) return await Promise.race([s.completion, s.interrupted.promise]);
            return signal?.aborted && s ? failure(s) : result;
          } finally { signal?.removeEventListener('abort', cancel); if (busy === lock) busy = null; }
        },
      }; return work;
    },
    owner: {
      async reconcile(owner, action, requestId) {
        ownerCheck(owner);
        const observed = await service().owner.reconcile(owner, action, requestId);
        ownerCheck(owner);
        if ((observed.outcome === 'succeeded' || observed.outcome === 'failed') && canonical(continuity.uncertain()) === canonical(action)) continuity.settle(action);
        return observed;
      },
      async takeover(owner) { ownerCheck(owner); const expected = generation = continuity.advance(); stop(); login = 'owner_control'; await ownerSettling; ownerCheck(owner, expected); return { generation: expected }; },
      async frame(owner, expected) { ownerCheck(owner, expected); const bytes = await engine.image(); ownerCheck(owner, expected); return bytes; },
      async input(owner, expected, input) {
        ownerCheck(owner, expected); if (!actor || !options.site.loginDocuments.includes(currentUrl)) throw new BrowserError('login_required');
        if (busy) throw new BrowserError('input_busy');
        const lock = {}; busy = lock;
        const s = scope(actor, true, () => { if (busy === lock) busy = null; }); active = s;
        const completion = complete(s, engine.ownerInput(input, s.input));
        const result = await Promise.race([completion, s.held.promise, s.interrupted.promise]);
        if (result.state !== 'ok' && !s.failure) await Promise.race([completion, s.interrupted.promise]);
        ownerCheck(owner, expected);
        if (result.state !== 'ok') throw new BrowserError('code' in result ? result.code : 'operation_unavailable');
      },
      handBack(owner, expected, cancel = false) { ownerCheck(owner, expected); generation = continuity.advance(); stop(); login = cancel ? 'cancelled' : 'checking'; return { generation, login, reconciliation: continuity.uncertain() }; },
      async checkSession(owner) {
        ownerCheck(owner); if (login !== 'checking') return login;
        const expected = generation, probe = options.site.session;
        if (!probe) { login = 'unknown'; return login; }
        try {
          browserUrl(probe.url); const cookie = await engine.cookie(probe.cookie, probe.url); ownerCheck(owner);
          const request: BrowserRequest = { method: 'GET', url: probe.url, contentType: '', bodyBase64: '', navigation: true };
          if (options.site.classify(request, options.mode)?.kind !== 'read') throw new BrowserError('session_unknown');
          const response = await exchange(request, cookie ?? '', new AbortController().signal);
          ownerCheck(owner); if (expected !== generation || login !== 'checking') throw new BrowserError('stale_input');
          login = cookie && response.status === probe.signedInStatus ? 'signed_in' : response.status === probe.signedOutStatus ? 'not_signed_in' : 'unknown';
        } catch { if (expected === generation && login === 'checking') login = 'unknown'; }
        return login;
      },
    },
    close() { return closing ??= (async () => { closed = true; generation = continuity.advance(); stop(); await Promise.allSettled([...scopes].map(s => s.completion)); try { await engine.close(); } finally { continuity.close(); } })(); },
  };
  return registration;
}
