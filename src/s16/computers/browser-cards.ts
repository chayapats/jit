import { AppError } from "../../errors";
import { exact, identity } from "../../s15/conversation/validation";
import type { VmStore } from "../../s15/vm/store";
import type { ComputerBrowser } from "./browser";
import { BrowserDispatchRefused, type BrowserActionFacts, type BrowserInput, type HumanBrowserRow } from "./browser-actions";

export interface BrowserCardContext { requestId: string; conversationId: string; vmGeneration: number; ownerGeneration: number; routine?: boolean }
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
    // Partial indexes keep refresh independent of historical form snapshots.
    options.store.db.exec(`
      CREATE INDEX IF NOT EXISTS s16_browser_cards_pending ON s16_browser_cards(conversation_id) WHERE json_extract(record,'$.state')='pending';
      CREATE INDEX IF NOT EXISTS s16_browser_cards_recent ON s16_browser_cards(conversation_id,json_extract(record,'$.ownerGeneration')) WHERE json_extract(record,'$.state')!='pending';
      CREATE INDEX IF NOT EXISTS s16_browser_cards_sending ON s16_browser_cards(json_extract(record,'$.state')) WHERE json_extract(record,'$.state')='sending';
      UPDATE s16_browser_cards SET record=json_set(record,'$.state','unknown') WHERE json_extract(record,'$.state')='sending';
    `);
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private pending(conversation: string): BrowserActionCard[] {
    return this.options.store.db.query<{ record: string }, [string]>("SELECT record FROM s16_browser_cards WHERE conversation_id=? AND json_extract(record,'$.state')='pending' ORDER BY rowid").all(conversation).map(r => JSON.parse(r.record) as BrowserActionCard);
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
    if (this.pending(action.conversationId).filter(c => this.current(c).state === "pending").length >= 64) throw new AppError("computer_browser_card_limit", 409);
    const { op, ...rest } = action;
    const card: BrowserActionCard = { ...rest, id: `bcard_${crypto.randomUUID().replaceAll("-", "")}`, kind: op.kind, expiresAt: this.now() + 1_800_000, state: "pending" };
    if ("value" in op) this.#values.set(card.id, op.value);
    this.save(card); return { state: "pending", cardId: card.id, expiresAt: card.expiresAt };
  }
  list(actor: Owner, conversationId: string): BrowserActionCard[] {
    this.options.requireOwner(actor); identity(conversationId);
    const generation = this.options.ownerGeneration();
    const pending = this.pending(conversationId).map(c => this.current(c)).filter(c => c.state === "pending" && c.ownerGeneration === generation);
    // Reconcile live presses first so newly expired/stale cards participate in the same bounded SQL history.
    const recent = this.options.store.db.query<{ record: string }, [string, number]>("SELECT record FROM s16_browser_cards WHERE conversation_id=? AND json_extract(record,'$.ownerGeneration')=? AND json_extract(record,'$.state')!='pending' ORDER BY rowid DESC LIMIT 64").all(conversationId, generation).reverse().map(r => JSON.parse(r.record) as BrowserActionCard);
    return [...pending, ...recent];
  }
  async decide(actor: Owner, value: unknown, guard: () => void = () => {}): Promise<BrowserActionCard> {
    this.options.requireOwner(actor);
    exact(value, ["contract", "conversationId", "cardId", "decision"]);
    const v = value as { contract: string; conversationId: string; cardId: string; decision: string };
    if (v.contract !== "s16-browser-card-decision/v1" || !["approve", "decline"].includes(v.decision)) throw new AppError("invalid_body");
    identity(v.conversationId); identity(v.cardId);
    const found = this.options.store.db.query<{ record: string }, [string, string]>("SELECT record FROM s16_browser_cards WHERE id=? AND conversation_id=?").get(v.cardId, v.conversationId);
    if (!found) throw new AppError("not_found", 404);
    const saved = JSON.parse(found.record) as BrowserActionCard;
    if (saved.ownerGeneration !== this.options.ownerGeneration()) throw new AppError("not_found", 404);
    let card = this.current(saved);
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
