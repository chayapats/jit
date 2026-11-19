import { JitClientError, type ClientDecision, type ClientMessage, type ClientReceipt, type ClientRequest } from "../client";
import type { FileReference } from "../files/types";
import type { ActionSlip } from "../../s15/policy";
import type { MobileSession } from "./session";
import { mobileServiceId, type MobileSecureStore } from "./transport";

/** Recovery metadata only. Exact command bytes remain in RAM; this record cannot authorize or reconstruct a POST. */
export interface MobilePending {
  readonly kind: "message" | "decision";
  readonly requestId: string;
  readonly conversationId: string;
  readonly sessionScope: string;
}
export class MobileCommandError extends Error {
  constructor(readonly code: "mobile_command_busy" | "mobile_pending_invalid" | "mobile_pending_limit" | "mobile_binding_changed" | "mobile_command_unavailable" | "stale_action") { super(code); this.name = "MobileCommandError"; }
}
const id = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const writes = new Map<string, Promise<void>>();
type Retained = { metadata: MobilePending; command: ClientMessage | ClientDecision };

/**
 * Native explicit send/decision admission with a synchronous duplicate-gesture lock. Storage and recovery contain
 * identities only. Nothing here retries a request or reconstructs an uncertain command after process loss.
 */
export class MobileCommands {
  readonly #ram = new Map<string, Retained>();
  readonly #busy = new Set<string>();
  readonly #settledActions = new Set<string>();
  readonly #absent = new Map<string, MobilePending>();
  constructor(readonly session: MobileSession, readonly store: MobileSecureStore) {}
  #binding(conversationId?: string): string {
    const frame = this.session.projection, scope = frame.bootstrap?.sessionScope;
    if (frame.phase !== "ready" || !sha(scope) || conversationId !== undefined && frame.conversationId !== conversationId) throw new MobileCommandError("mobile_binding_changed");
    return scope;
  }
  async #key(): Promise<string> { return "jit.mobile.pending.v1." + await mobileServiceId(this.session.transport.origin); }
  async #read(key: string): Promise<MobilePending[]> {
    const raw = await this.store.get(key); if (raw === null) return [];
    try {
      if (raw.length > 32768) throw Error();
      const value = JSON.parse(raw);
      if (!value || Object.keys(value).sort().join() !== "contract,entries" || value.contract !== "s16-mobile-pending/v1" || !Array.isArray(value.entries) || value.entries.length > 32) throw Error();
      const ids = new Set<string>();
      for (const entry of value.entries) {
        if (!entry || Object.keys(entry).sort().join() !== "conversationId,kind,requestId,sessionScope" || !["message", "decision"].includes(entry.kind) || !id(entry.requestId) || !id(entry.conversationId) || !sha(entry.sessionScope) || ids.has(entry.requestId)) throw Error();
        ids.add(entry.requestId);
      }
      return value.entries;
    } catch { throw new MobileCommandError("mobile_pending_invalid"); }
  }
  async #edit(update: (entries: MobilePending[]) => MobilePending[]): Promise<void> {
    const key = await this.#key(), previous = writes.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      const entries = update(await this.#read(key));
      if (entries.length > 32) throw new MobileCommandError("mobile_pending_limit");
      if (entries.length) await this.store.set(key, JSON.stringify({ contract: "s16-mobile-pending/v1", entries })); else await this.store.delete(key);
    });
    writes.set(key, operation);
    try { await operation; } finally { if (writes.get(key) === operation) writes.delete(key); }
  }
  /** Current-session identities for read-only recovery. Other owner/session bindings are never projected. */
  async pending(): Promise<readonly MobilePending[]> {
    const scope = this.#binding(), entries = await this.#read(await this.#key());
    if (this.#binding() !== scope) throw new MobileCommandError("mobile_binding_changed");
    return Object.freeze(entries.filter(entry => entry.sessionScope === scope).map(entry => Object.freeze({ ...entry })));
  }
  async #submit(retained: Retained): Promise<ClientReceipt> {
    const { metadata, command } = retained;
    if (this.#binding(metadata.conversationId) !== metadata.sessionScope) throw new MobileCommandError("mobile_binding_changed");
    try {
      await this.#edit(entries => {
        const current = entries.filter(entry => entry.sessionScope === metadata.sessionScope), existing = current.find(entry => entry.requestId === metadata.requestId);
        if (existing && (existing.kind !== metadata.kind || existing.conversationId !== metadata.conversationId)) throw new MobileCommandError("mobile_pending_invalid");
        return existing ? current : [...current, metadata];
      });
    } catch (error) { this.#ram.delete(metadata.requestId); throw error; }
    if (this.#binding(metadata.conversationId) !== metadata.sessionScope) throw new MobileCommandError("mobile_binding_changed");
    const receipt = await this.session.perform((client, signal) => metadata.kind === "message" ? client.send(command as ClientMessage, signal) : client.decide(command as ClientDecision, signal));
    await this.#edit(entries => entries.filter(entry => entry.requestId !== metadata.requestId));
    this.#ram.delete(metadata.requestId); return receipt;
  }
  /** One owner Send gesture. The lock is held before any preparation, store read or network await. */
  async send(conversationId: string, text: string, files: readonly FileReference[] = []): Promise<ClientReceipt> {
    if (this.#busy.has(conversationId)) throw new MobileCommandError("mobile_command_busy");
    this.#busy.add(conversationId);
    try {
      const scope = this.#binding(conversationId);
      if ((await this.pending()).some(entry => entry.conversationId === conversationId)) throw new MobileCommandError("mobile_command_busy");
      if (this.#binding(conversationId) !== scope) throw new MobileCommandError("mobile_binding_changed");
      const command = await this.session.perform(async client => client.prepareMessage(conversationId, text, files));
      const retained: Retained = { metadata: Object.freeze({ kind: "message", requestId: command.requestId, conversationId, sessionScope: scope }), command };
      this.#ram.set(command.requestId, retained); return await this.#submit(retained);
    } finally { this.#busy.delete(conversationId); }
  }
  /** One exact currently displayed card press. Notification/text arguments cannot select an action revision. */
  async decide(conversationId: string, slip: ActionSlip, decision: "approve" | "deny"): Promise<ClientReceipt> {
    if (this.#busy.has(conversationId)) throw new MobileCommandError("mobile_command_busy");
    this.#busy.add(conversationId);
    try {
      const scope = this.#binding(conversationId), a = slip.action, actionKey = `${a.id}:${a.revision}:${a.actionHash}`;
      const current = this.session.projection.snapshot?.conversation.rows.flatMap(row => row.slips).find(candidate => candidate.action.id === a.id && candidate.action.revision === a.revision && candidate.action.actionHash === a.actionHash && candidate.state === "pending");
      if (!current || decision === "approve" && !current.canApprove || this.#settledActions.has(actionKey)) throw new MobileCommandError("stale_action");
      if ((await this.pending()).some(entry => entry.conversationId === conversationId)) throw new MobileCommandError("mobile_command_busy");
      const command: ClientDecision = Object.freeze({ contract: "s15-conversation-decision/v1", requestId: crypto.randomUUID().replaceAll("-", ""), conversationId, action: Object.freeze({ id: a.id, revision: a.revision, actionHash: a.actionHash }), decision });
      const retained: Retained = { metadata: Object.freeze({ kind: "decision", requestId: command.requestId, conversationId, sessionScope: scope }), command };
      this.#ram.set(command.requestId, retained);
      const receipt = await this.#submit(retained); this.#settledActions.add(actionKey); return receipt;
    } finally { this.#busy.delete(conversationId); }
  }
  /** Original receipt lookup only. Not-found leaves the identity intact and permits no automatic send. */
  async recover(entry: MobilePending): Promise<ClientRequest> {
    if (this.#binding() !== entry.sessionScope || !(await this.pending()).some(item => item.requestId === entry.requestId && item.conversationId === entry.conversationId && item.kind === entry.kind)) throw new MobileCommandError("mobile_binding_changed");
    let result: ClientRequest;
    try { result = await this.session.perform((client, signal) => client.request(entry.requestId, signal)); }
    catch (error) { if (error instanceof JitClientError && error.status === 404 && this.#binding() === entry.sessionScope) this.#absent.set(entry.requestId, entry); throw error; }
    if (result.conversationId !== entry.conversationId) throw new JitClientError("client_recovery_scope_mismatch", null, "response", entry.requestId);
    if (this.#binding() !== entry.sessionScope) throw new MobileCommandError("mobile_binding_changed");
    await this.#edit(entries => entries.filter(item => item.requestId !== entry.requestId)); this.#ram.delete(entry.requestId); return result;
  }
  /** Explicit retry of the same immutable RAM command after revalidation. Never available after process loss. */
  async retry(requestId: string): Promise<ClientReceipt> {
    const retained = this.#ram.get(requestId); if (!retained) throw new MobileCommandError("mobile_command_unavailable");
    if (this.#binding(retained.metadata.conversationId) !== retained.metadata.sessionScope) throw new MobileCommandError("mobile_binding_changed");
    if (!this.#absent.has(requestId)) throw new MobileCommandError("mobile_command_unavailable");
    const conversation = retained.metadata.conversationId;
    if (this.#busy.has(conversation)) throw new MobileCommandError("mobile_command_busy");
    this.#busy.add(conversation); try { return await this.#submit(retained); } finally { this.#busy.delete(conversation); }
  }
  /** Whether an explicit same-command retry is available after a current not-found receipt lookup. */
  canRetry(entry: MobilePending): boolean { return this.#ram.has(entry.requestId) && this.#absent.get(entry.requestId)?.sessionScope === entry.sessionScope; }
  /** Explicit blank replacement after process loss and a protected 404. Never copies or sends the old command. */
  async forgetAbsent(entry: MobilePending): Promise<void> {
    if (this.#binding() !== entry.sessionScope || this.#absent.get(entry.requestId)?.sessionScope !== entry.sessionScope) throw new MobileCommandError("mobile_command_unavailable");
    await this.#edit(entries => entries.filter(item => item.requestId !== entry.requestId)); this.#ram.delete(entry.requestId); this.#absent.delete(entry.requestId);
  }
  /** Drop private command bytes on lifecycle loss; persisted identities remain usable only for receipt reads. */
  clearPrivate(): void { this.#ram.clear(); this.#settledActions.clear(); this.#absent.clear(); }
}
