import { protectedBrowserTools, type BrowserRegistration, type BrowserWork, type BrowserResult } from '../browser';
import type { ActionRef, Observation, S15PolicyService } from '../policy';
import { equal, fail } from '../policy/validation';
import type { ConversationAuthority, ConversationPolicyWork, ConversationToolPort } from '../conversation';

/**
 * Additive CHAT bridge for protected native-form work. Held browser actions keep their original
 * paused request, so owner approval resumes that request rather than calling a new browser input.
 * Compose dispatchAction into the real ConversationPolicy; other actions use its existing dispatcher.
 */
export function createEffectsConversationTools(policy: S15PolicyService, options: { google?: ConversationToolPort<ConversationPolicyWork>; browser?: BrowserRegistration }) {
  const held = new Map<string, { work: ConversationPolicyWork; browser: BrowserWork; action: ActionRef; settled: Promise<void>; done: boolean; dispatching: boolean; cancel(): Promise<void>; release(): void }>();
  const tools: ConversationToolPort<ConversationPolicyWork> = { async open(work, input) {
    input.guard();
    // A denial/stop has no dispatcher callback. Reap it before admitting another CHAT browser lease.
    for (const entry of [...held.values()]) {
      if (entry.dispatching) continue;
      let terminal = entry.done;
      try { const decision = policy.work.evaluate(entry.work.actor, entry.action); terminal ||= decision.state === 'deny' || decision.state === 'unsupported'; }
      catch { terminal = true; }
      if (terminal) await entry.cancel();
    }
    input.guard(); const google = await options.google?.open(work, input), browser = options.browser?.open(work.actor);
    const abort = new AbortController(), signal = AbortSignal.any([input.signal, abort.signal]);
    let retain = false, released = false;
    const release = () => { if (released) return; browser?.release(); released = true; for (const [key, value] of held) if (value.browser === browser) held.delete(key); };
    const cancel = async () => { if (released) return; const settled = browser?.settled(); abort.abort(); await settled; release(); };
    return { tools: [...(google?.tools ?? []), ...(browser ? protectedBrowserTools(browser).map(definition => ({ access: (input.mode === 'inspect' ? 'read' : 'reversible_write') as 'read' | 'reversible_write', definition: { ...definition,
      async execute(value: unknown, context: Parameters<NonNullable<typeof definition.execute>>[1]) {
        input.guard();
        if (input.mode === 'inspect' && (!value || typeof value !== 'object' || !['state', 'navigate', 'read', 'find', 'screenshot'].includes((value as { kind: string }).kind))) fail('outside_scope');
        const result = await definition.execute(value, { ...context, signal }); input.guard();
        const parsed = JSON.parse(result.content) as BrowserResult;
        if (parsed.state === 'held') {
          if (!input.onAction) { await cancel(); fail('adapter_unproven'); }
          retain = true;
          const entry = { work, browser, action: parsed.action, settled: browser.settled(), done: false, dispatching: false, cancel, release };
          held.set(parsed.action.id, entry);
          // Deadline/cancellation settlement releases passively; an in-flight approval owns its cleanup.
          void entry.settled.then(() => { entry.done = true; if (!entry.dispatching) release(); }).catch(() => {});
          input.onAction(parsed.action);
        }
        return result;
      },
    } })) : [])],
      async cancel() { try { await cancel(); } finally { await google?.cancel(); } },
      async close() { await google?.close(); if (!retain && !released) void (browser?.settled() ?? Promise.resolve()).then(release).catch(() => {}); },
    };
  } };
  return { tools,
    /** Host-only exact action dispatcher. A stale/expired/lost context refuses; it cannot be reconstructed. */
    async dispatchAction(authority: ConversationAuthority, action: ActionRef): Promise<Observation> {
      const original = held.get(action.id);
      if (!original) {
        const actor = policy.control.bindWork(authority.id);
        if (policy.work.guardBeforeDispatch(actor, action).adapter === 'protected_browser') fail('request_unavailable');
        return policy.work.dispatch(actor, action);
      }
      if (original.work.authority.id !== authority.id || !equal(original.action, action)) fail('stale_action');
      original.dispatching = true;
      try {
        const result = await original.browser.resume(action);
        if (result.state !== 'ok' && result.state !== 'unknown') fail('code' in result ? result.code : 'request_unavailable');
        const { evidence: _, ...facts } = policy.control.publishable(original.work.actor, action);
        return facts;
      } finally { original.dispatching = false; void original.settled.then(original.release).catch(() => {}); }
    },
    /** Protected cleanup for host shutdown/stop, never a model-selected new browser session. */
    async close() { await Promise.all([...held.values()].map(entry => entry.cancel())); },
  };
}
