import type { ClientBootstrap, ClientSnapshot } from "../client";
import type { MobileSession } from "./session";

/** Read-only recent Work card, retaining its original conversation and request identity. */
export interface MobileWorkItem { readonly conversationId: string; readonly row: ClientSnapshot["conversation"]["rows"][number] }
/** Safe local failure. No response text, source content, credential or native path enters it. */
export class MobileWorkError extends Error { constructor(readonly code: string) { super(code); this.name = "MobileWorkError"; } }
type Selection = { ids: readonly string[]; key: string };
const errorCode = (error: unknown) => error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(error.code) ? error.code : "mobile_request_failed";

/**
 * One finite current-owner Work read at a time (<=64 snapshots, <=128 cards). Unchanged bootstrap polls
 * coalesce into the in-flight read, so a load longer than the poll interval can still publish. Changed
 * navigation is queued once behind it and removed identities are withheld from publication. Leaving
 * Work or a session lifecycle/binding change aborts the actual read and prevents every late publication.
 */
export class MobileWork {
  readonly #generation: number;
  readonly #scope: string | undefined;
  readonly #publish: (items: readonly MobileWorkItem[] | null) => void;
  readonly #failure: (error: MobileWorkError) => void;
  #closed = false;
  #pending: Selection | null = null;
  #running: Promise<void> | null = null;
  #stop: AbortController | null = null;
  #release: (() => void) | null = null;
  constructor(readonly session: MobileSession, observer: { publish(items: readonly MobileWorkItem[] | null): void; failure(error: MobileWorkError): void }) {
    this.#generation = session.projection.generation; this.#scope = session.projection.bootstrap?.sessionScope;
    this.#publish = observer.publish.bind(observer); this.#failure = observer.failure.bind(observer);
  }
  #current(): boolean { const frame = this.session.projection; return !this.#closed && frame.phase === "ready" && frame.generation === this.#generation && !!this.#scope && frame.bootstrap?.sessionScope === this.#scope; }
  /** A poll schedules a read, never a command, resume or cancellation of an unchanged active load. */
  refresh(bootstrap: Omit<ClientBootstrap, "csrf">): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (!this.#current() || bootstrap.sessionScope !== this.#scope) { this.close(); return Promise.resolve(); }
    if (bootstrap.conversations.length > 64 || bootstrap.conversations.some(row => !/^[A-Za-z0-9_-]{1,128}$/.test(row.conversationId))) {
      this.close(); this.#failure(new MobileWorkError("mobile_work_selection_invalid")); return Promise.resolve();
    }
    const ids = Object.freeze([...new Set(bootstrap.conversations.map(row => row.conversationId))]);
    this.#pending = { ids, key: JSON.stringify([...ids].sort()) };
    if (!this.#release) this.#release = this.session.subscribe(() => { if (!this.#current()) this.close(); });
    if (this.#running) return this.#running;
    const pending = this.#drain(); this.#running = pending;
    void pending.finally(() => { if (this.#running === pending) this.#running = null; }).catch(() => {});
    return pending;
  }
  async #drain(): Promise<void> {
    while (this.#current() && this.#pending) {
      const selected = this.#pending, stop = new AbortController(); this.#stop = stop;
      try {
        const items: MobileWorkItem[] = [];
        for (const conversationId of selected.ids) {
          if (!this.#current() || stop.signal.aborted) return;
          if (!this.#pending?.ids.includes(conversationId)) continue;
          const snapshot = await this.session.readSnapshot(conversationId, stop.signal);
          if (!this.#current() || stop.signal.aborted) return;
          items.push(...snapshot.conversation.rows.slice().reverse().slice(0, 128 - items.length).map(row => Object.freeze({ conversationId, row })));
          if (items.length >= 128) break;
        }
        if (!this.#current() || stop.signal.aborted) return;
        const latest = this.#pending!, allowed = new Set(latest.ids), order = new Map(latest.ids.map((id, index) => [id, index]));
        const current = items.filter(item => allowed.has(item.conversationId)).sort((a, b) => order.get(a.conversationId)! - order.get(b.conversationId)!);
        this.#publish(Object.freeze(current));
        if (this.#pending?.key === selected.key) { this.#pending = null; return; }
      } catch (error) {
        if (this.#current() && !stop.signal.aborted) { this.#publish(null); this.#failure(new MobileWorkError(errorCode(error))); }
        this.#pending = null; return;
      } finally { if (this.#stop === stop) this.#stop = null; }
    }
  }
  /** Synchronous private invalidation plus actual read abort. A late completion can never restore cards. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true; this.#pending = null; this.#stop?.abort(); this.#release?.(); this.#release = null; this.#publish(null);
  }
}
