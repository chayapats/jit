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
  const held = new Map<string, { work: ConversationPolicyWork; browser: BrowserWork; action: ActionRef }>();
  const tools: ConversationToolPort<ConversationPolicyWork> = { async open(work, input) {
    input.guard(); const google = await options.google?.open(work, input), browser = options.browser?.open(work.actor);
    let retain = false, released = false;
    const release = () => { if (released) return; released = true; browser?.release(); for (const [key, value] of held) if (value.browser === browser) held.delete(key); };
    return { tools: [...(google?.tools ?? []), ...(browser ? protectedBrowserTools(browser).map(definition => ({ access: (input.mode === 'inspect' ? 'read' : 'reversible_write') as 'read' | 'reversible_write', definition: { ...definition,
      async execute(value: unknown, context: Parameters<NonNullable<typeof definition.execute>>[1]) {
        input.guard();
        if (input.mode === 'inspect' && (!value || typeof value !== 'object' || !['state', 'navigate', 'read', 'find', 'screenshot'].includes((value as { kind: string }).kind))) fail('outside_scope');
        const result = await definition.execute(value, { ...context, signal: input.signal }); input.guard();
        const parsed = JSON.parse(result.content) as BrowserResult;
        if (parsed.state === 'held') { if (!input.onAction) { release(); fail('adapter_unproven'); } retain = true; held.set(parsed.action.id, { work, browser, action: parsed.action }); input.onAction(parsed.action); }
        return result;
      },
    } })) : [])],
      async cancel() { release(); await google?.cancel(); },
      async close() { await google?.close(); if (!retain) release(); },
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
      try {
        const result = await original.browser.resume(action);
        if (result.state !== 'ok' && result.state !== 'unknown') fail('code' in result ? result.code : 'request_unavailable');
        const { evidence: _, ...facts } = policy.control.publishable(original.work.actor, action);
        return facts;
      } finally { held.delete(action.id); original.browser.release(); }
    },
    /** Protected cleanup for host shutdown/stop, never a model-selected new browser session. */
    close() { for (const entry of held.values()) entry.browser.release(); held.clear(); },
  };
}
