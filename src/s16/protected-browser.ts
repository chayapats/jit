import { AppError } from '../errors';
import { BrowserError, type BrowserOwnerControl, type BrowserOwnerState, type BrowserRegistration, type OwnerBrowserInput } from '../s15/browser';
import type { ActionRef, OwnerActor } from '../s15/policy';
import { PolicyError } from '../s15/policy/validation';
import { canonical, exact, identity, integer } from '../s15/conversation/validation';

/** Safe current facts from the one protected browser, independent of the working computer's screen. */
export interface ProtectedBrowserView extends BrowserOwnerState { contract: 's16-protected-browser/v1' }
/** Owner commands are transient ingress, never conversation messages, drafts or durable receipts. */
export type ProtectedBrowserCommand = { contract: 's16-protected-browser-command/v1'; requestId: string; generation: number } & (
  | { kind: 'takeover' } | { kind: 'check_session' }
  | { kind: 'hand_back'; cancel: boolean }
  | { kind: 'input'; input: OwnerBrowserInput }
  | { kind: 'reconcile'; action: ActionRef });
export interface ProtectedBrowserResult { contract: 's16-protected-browser-result/v1'; requestId: string; view: ProtectedBrowserView }
/** Protected host composition only. No browser/controller/owner object is exported to a tool. */
export interface ProtectedBrowserPort<Actor> {
  view(actor: Actor): ProtectedBrowserView;
  controls(actor: Actor, generation: number): Promise<BrowserOwnerControl[]>;
  frame(actor: Actor, generation: number): Promise<Uint8Array>;
  command(actor: Actor, input: unknown): Promise<ProtectedBrowserResult>;
}
function command(value: unknown): asserts value is ProtectedBrowserCommand {
  exact(value, Object.keys(value && typeof value === 'object' ? value : {}));
  const extra = value.kind === 'input' ? ['input'] : value.kind === 'hand_back' ? ['cancel'] : value.kind === 'reconcile' ? ['action'] : [];
  exact(value, ['contract', 'requestId', 'generation', 'kind', ...extra]);
  if (value.contract !== 's16-protected-browser-command/v1' || !['takeover', 'hand_back', 'input', 'check_session', 'reconcile'].includes(String(value.kind))) throw new AppError('invalid_browser_command');
  identity(value.requestId); integer(value.generation, 1, Number.MAX_SAFE_INTEGER);
  if (value.kind === 'hand_back' && typeof value.cancel !== 'boolean') throw new AppError('invalid_browser_command');
  if (value.kind === 'reconcile') { exact(value.action, ['id', 'revision', 'actionHash']); identity(value.action.id); integer(value.action.revision, 1); if (typeof value.action.actionHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.action.actionHash)) throw new AppError('invalid_browser_command'); }
  if (value.kind === 'input') {
    exact(value.input, ['kind', 'field', ...(value.input && typeof value.input === 'object' && 'kind' in value.input && value.input.kind === 'type' ? ['value'] : [])]);
    if (!['click', 'type'].includes(String(value.input.kind)) || typeof value.input.field !== 'string' || !/^o[0-9]+_[0-9]+$/.test(value.input.field)) throw new AppError('invalid_browser_command');
    if (value.input.kind === 'type' && (typeof value.input.value !== 'string' || !value.input.value || value.input.value.length > 2000 || !value.input.value.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.input.value))) throw new AppError('invalid_browser_command');
  }
}
const safeError = (error: unknown): never => { if (error instanceof BrowserError || error instanceof PolicyError) throw new AppError(error.code, error.code === 'authentication_required' ? 401 : error.code === 'authorization_required' ? 403 : 409); throw error; };

/** Reuse POLICY and its existing protected owner port. Duplicate transient input joins its first attempt;
 * only command identity/kind/target and a value-free promise are retained in memory. No text or text hash
 * is persisted. A restart loses these handles and advances browser continuity, so old input cannot replay. */
export function createProtectedBrowserPort<Actor>(options: { browser: BrowserRegistration; owner(actor: Actor): OwnerActor }): ProtectedBrowserPort<Actor> {
  const browser = options.browser.owner;
  const attempts = new Map<string, { identity: string; generation: number; settled: boolean; run: Promise<void> }>();
  const view = (actor: Actor): ProtectedBrowserView => ({ contract: 's16-protected-browser/v1', ...browser.state(options.owner(actor)) });
  return {
    view,
    async controls(actor, generation) { try { return await browser.controls(options.owner(actor), generation); } catch (error) { return safeError(error); } },
    async frame(actor, generation) { try { return await browser.frame(options.owner(actor), generation); } catch (error) { return safeError(error); } },
    async command(actor, value) {
      command(value); const owner = options.owner(actor), current = browser.state(owner);
      const key = JSON.stringify([value.kind, value.generation, value.kind === 'input' ? [value.input.kind, value.input.field] : value.kind === 'hand_back' ? value.cancel : value.kind === 'reconcile' ? value.action : null]);
      let attempt = attempts.get(value.requestId);
      if (attempt && attempt.identity !== key) throw new AppError('request_id_conflict', 409);
      if (!attempt) {
        if (current.generation !== value.generation) throw new AppError('stale_input', 409);
        for (const [id, previous] of attempts) if (previous.settled && previous.generation !== current.generation) attempts.delete(id);
        if (attempts.size >= 512) throw new AppError('browser_command_capacity', 409);
        const run = (async () => {
          if (value.kind === 'takeover') await browser.takeover(owner, value.generation);
          else if (value.kind === 'input') await browser.input(owner, value.generation, value.input);
          else if (value.kind === 'hand_back') browser.handBack(owner, value.generation, value.cancel);
          else if (value.kind === 'check_session') await browser.checkSession(owner);
          else {
            if (!current.reconciliation || canonical(current.reconciliation) !== canonical(value.action)) throw new AppError('stale_action', 409);
            await browser.reconcile(owner, value.action, value.requestId);
          }
        })();
        attempt = { identity: key, generation: value.generation, settled: false, run }; attempts.set(value.requestId, attempt);
        void run.finally(() => { attempt!.settled = true; }).catch(() => {});
      }
      try { await attempt.run; return { contract: 's16-protected-browser-result/v1', requestId: value.requestId, view: view(actor) }; }
      catch (error) { return safeError(error); }
    },
  };
}
