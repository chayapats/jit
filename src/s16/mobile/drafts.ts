import type { FileReceipt } from "../files/types";
import type { MobileSession } from "./session";

/** Same-session RAM-only composer. No bytes, credential, offline queue or persisted private projection. */
export interface MobileDraft { readonly text: string; readonly files: readonly MobileFileChip[] }
/** Original upload identity remains visible through a lost response; Check only reads this upload. */
export interface MobileFileChip {
  readonly requestId: string; readonly name: string; readonly bytes: number;
  readonly sha256: string;
  readonly uploadId: string | null; readonly phase: "uploading" | "validating" | "ready" | "failed";
  readonly receipt: FileReceipt | null; readonly code: string | null;
}
/** Owner OS-sheet continuity pin. It is data only and never starts work. */
export interface MobileIntent { readonly session: MobileSession; readonly scope: string; readonly conversationId: string; readonly selectionRevision: number }
export class MobileIntentError extends Error { constructor(readonly code: "mobile_binding_changed" | "mobile_file_limit") { super(code); this.name = "MobileIntentError"; } }
/** Capture a currently authenticated target before opening a picker or permission sheet. */
export function mobileIntent(session: MobileSession): MobileIntent {
  const frame = session.projection, scope = frame.bootstrap?.sessionScope;
  if (frame.phase !== "ready" || !scope || !/^[a-f0-9]{64}$/.test(scope) || !frame.conversationId) throw new MobileIntentError("mobile_binding_changed");
  return Object.freeze({ session, scope, conversationId: frame.conversationId, selectionRevision: session.selectionRevision });
}
/** Accept a sheet result only after fresh protected reads, in the exact original target/session selection. */
export function checkMobileIntent(intent: MobileIntent): void {
  const frame = intent.session.projection;
  if (frame.phase !== "ready" || frame.bootstrap?.sessionScope !== intent.scope || frame.conversationId !== intent.conversationId || intent.session.selectionRevision !== intent.selectionRevision) throw new MobileIntentError("mobile_binding_changed");
}
const empty: MobileDraft = Object.freeze({ text: "", files: Object.freeze([]) });
/** Ephemeral shared composer survives an OS sheet remount only under its validated service/session/target pins. */
export class MobileDrafts {
  readonly #drafts = new Map<string, MobileDraft>(); readonly #listeners = new Set<() => void>();
  #key(scope: string, conversation: string): string { return `${scope}:${conversation}`; }
  get(scope: string, conversation: string): MobileDraft { return this.#drafts.get(this.#key(scope, conversation)) ?? empty; }
  subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; }
  #notify(): void { for (const listener of this.#listeners) listener(); }
  /** An authored renderer update; callers cannot use file/model text to choose another target. */
  change(intent: MobileIntent, update: (draft: MobileDraft) => MobileDraft): void {
    checkMobileIntent(intent); const value = update(this.get(intent.scope, intent.conversationId));
    this.#drafts.set(this.#key(intent.scope, intent.conversationId), Object.freeze({ text: value.text, files: Object.freeze([...value.files]) })); this.#notify();
  }
  /** Forget private RAM drafts at sign-out/service switch or changed owner/session binding. */
  clear(): void { this.#drafts.clear(); this.#notify(); }
}
