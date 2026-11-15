import { AppError } from "../../errors";
import { exact, identity } from "../../s15/conversation/validation";
import type { VmStore } from "../../s15/vm/store";
import type { ComputerBrowser } from "./browser";
import { BrowserDispatchRefused, type BrowserActionFacts, type BrowserInput, type HumanBrowserRow } from "./browser-actions";

export interface BrowserCardContext { requestId: string; conversationId: string; vmGeneration: number; ownerGeneration: number }
export interface HeldBrowserAction extends BrowserCardContext { vm: string; targetId: string; facts: BrowserActionFacts; op: BrowserInput; row: HumanBrowserRow }
export interface BrowserActionCard {
  id: string; requestId: string; conversationId: string; vm: string; vmGeneration: number; ownerGeneration: number;
  targetId: string; facts: BrowserActionFacts; row: HumanBrowserRow; kind: BrowserInput["kind"];
  expiresAt: number; state: "pending" | "sending" | "sent" | "unknown" | "stale" | "declined" | "expired";
  /** Proposed type/select bytes are transient: never part of the durable card or normal tool history. */
  value?: string;
}
/** Dedicated owner-only card continuity. No model/typed reply can call decide; a press never resumes the old work. */
export class BrowserActionCards<Owner> {
  readonly #values = new Map<string, string>();
  readonly #pressing = new Set<string>();
  constructor(readonly options: { store: VmStore; browser: ComputerBrowser; requireOwner(actor: Owner): void; ownerGeneration(): number; now?: () => number }) {
    options.store.db.exec("CREATE TABLE IF NOT EXISTS s16_browser_cards (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, record TEXT NOT NULL)");
    for (const row of this.rows()) if (row.state === "sending") this.save({ ...row, state: "unknown" });
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private rows(conversation?: string): BrowserActionCard[] {
    return (conversation ? this.options.store.db.query<{ record: string }, [string]>("SELECT record FROM s16_browser_cards WHERE conversation_id=? ORDER BY rowid").all(conversation) : this.options.store.db.query<{ record: string }, []>("SELECT record FROM s16_browser_cards ORDER BY rowid").all()).map(r => JSON.parse(r.record) as BrowserActionCard);
  }
  private save(card: BrowserActionCard): void {
    const { value: _value, ...record } = card;
    this.options.store.db.query("INSERT INTO s16_browser_cards VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record").run(card.id, card.conversationId, JSON.stringify(record));
    if (card.state !== "pending") this.#values.delete(card.id);
  }
  private current(card: BrowserActionCard): BrowserActionCard {
    if (card.state === "pending" && (card.expiresAt <= this.now() || card.ownerGeneration !== this.options.ownerGeneration())) this.save(card = { ...card, state: "expired" });
    if (card.state === "pending" && (card.kind === "type" || card.kind === "select") && !this.#values.has(card.id)) this.save(card = { ...card, state: "stale" });
    return { ...card, ...(this.#values.has(card.id) ? { value: this.#values.get(card.id)! } : {}) };
  }
  hold(action: HeldBrowserAction): { state: "pending"; cardId: string; expiresAt: number } {
    identity(action.requestId); identity(action.conversationId);
    if (this.rows(action.conversationId).filter(c => this.current(c).state === "pending").length >= 64) throw new AppError("computer_browser_card_limit", 409);
    const { op, ...rest } = action;
    const card: BrowserActionCard = { ...rest, id: `bcard_${crypto.randomUUID().replaceAll("-", "")}`, kind: op.kind, expiresAt: this.now() + 1_800_000, state: "pending" };
    if ("value" in op) this.#values.set(card.id, op.value);
    this.save(card); return { state: "pending", cardId: card.id, expiresAt: card.expiresAt };
  }
  list(actor: Owner, conversationId: string): BrowserActionCard[] {
    this.options.requireOwner(actor); identity(conversationId);
    const cards = this.rows(conversationId).filter(c => c.ownerGeneration === this.options.ownerGeneration()).map(c => this.current(c));
    // Keep every live press, plus a bounded recent history, within the protected client's response limit.
    return [...cards.filter(c => c.state === "pending"), ...cards.filter(c => c.state !== "pending").slice(-64)];
  }
  async decide(actor: Owner, value: unknown, guard: () => void = () => {}): Promise<BrowserActionCard> {
    this.options.requireOwner(actor);
    exact(value, ["contract", "conversationId", "cardId", "decision"]);
    const v = value as { contract: string; conversationId: string; cardId: string; decision: string };
    if (v.contract !== "s16-browser-card-decision/v1" || !["approve", "decline"].includes(v.decision)) throw new AppError("invalid_body");
    identity(v.conversationId); identity(v.cardId);
    const found = this.rows(v.conversationId).find(c => c.id === v.cardId && c.ownerGeneration === this.options.ownerGeneration());
    if (!found) throw new AppError("not_found", 404);
    let card = this.current(found);
    if (card.state !== "pending") return card;
    if (this.#pressing.has(card.id)) throw new AppError("computer_browser_busy", 409);
    if (v.decision === "decline") { this.save(card = { ...card, state: "declined" }); return card; }
    this.#pressing.add(card.id);
    try {
      const outcome = await this.options.browser.press(card, () => {
        guard(); this.options.requireOwner(actor); card = this.current(card);
        if (card.state !== "pending") throw new AppError("computer_browser_stale", 409);
        // Claim durably immediately before the sole input batch. A crash/uncertain result is never replayed.
        this.save(card = { ...card, state: "sending" });
      });
      this.save(card = { ...card, state: outcome });
    } catch (error) {
      if (error instanceof BrowserDispatchRefused) this.save(card = { ...card, state: "stale" });
      else if (card.state === "sending") this.save(card = { ...card, state: "unknown" });
      else if (error instanceof AppError && error.code === "computer_browser_stale") this.save(card = { ...card, state: "stale" });
      else throw error; // Busy/screen/site/admission refusal preserves the pending press.
    } finally { this.#pressing.delete(card.id); }
    return this.current(card);
  }
}
