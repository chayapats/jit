import { AppError } from "../../errors";
import type { ConversationStore } from "../../s15/conversation/store";
import type { ConversationRequest } from "../../s15/conversation/types";
import { canonical, exact, identity, integer } from "../../s15/conversation/validation";
import { approvedWebsiteOrigin, websiteSensitiveOnly, type WebsiteTier } from "../../s15/browser/sites";
import type { ScreenControl } from "./screen";
import type { ComputerNeedsYouCard, ComputerNeedsYouCommand, ComputerNeedsYouPost, ComputerNeedsYouResult, ComputerScreenOutcome } from "./needs-you-types";

type StoredCard = ComputerNeedsYouPost & { id: string; createdAt: number; expiresAt: number; voidedAt?: number };
/** One public HTTP(S) origin only; paths, credentials, query strings and fragments never enter a card. */
export function computerNeedsYouOrigin(input: unknown): string {
  if (typeof input !== "string" || Buffer.byteLength(input) > 2048) throw new AppError("computer_browser_operation_invalid", 409);
  let url: URL; try { url = new URL(input); } catch { throw new AppError("computer_browser_operation_invalid", 409); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/" || input !== url.origin && input !== url.origin + "/") throw new AppError("computer_browser_operation_invalid", 409);
  try { approvedWebsiteOrigin(`https://${url.host}`); } catch { throw new AppError("computer_browser_url_invalid", 409); }
  return url.origin;
}
/** Protected two-store handoff. Card insertion precedes yield; only committed result publication marks delivery. */
export class ComputerNeedsYou<Owner> {
  readonly minutes: number;
  constructor(readonly options: {
    store: ConversationStore; screen: ScreenControl<Owner>; requireOwner(owner: Owner): void; ownerGeneration(): number;
    vmGeneration(vmId: string): number;
    /** Live host tier; a changed site cannot be signed into through a previously posted desktop card. */
    tier(hostname: string): WebsiteTier | undefined;
    /** The request's admitted computer resource and any private-Bot restriction must both match. */
    allows(request: ConversationRequest, vmId: string): boolean;
    now?: () => number; minutes?: number;
  }) {
    this.minutes = options.minutes ?? 240; integer(this.minutes, 30, 1440);
    for (const row of options.store.db.query<{ record_json: string }, [number]>("SELECT record_json FROM computer_needs_you WHERE json_extract(record_json,'$.voidedAt') IS NULL AND created_at<=?").all(this.now() - 60_000)) this.current(JSON.parse(row.record_json));
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private allowed(origin: string): string {
    const normalized = computerNeedsYouOrigin(origin);
    if (websiteSensitiveOnly(normalized)) throw new AppError("website_sensitive_only", 409);
    if (this.options.tier(new URL(normalized).hostname.toLowerCase().replace(/\.$/, "")) === "sensitive") throw new AppError("website_protected", 409);
    return normalized;
  }
  private void(card: StoredCard): void {
    this.options.store.db.query("UPDATE computer_needs_you SET record_json=json_set(record_json,'$.voidedAt',?) WHERE id=?").run(this.now(), card.id);
    card.voidedAt = this.now();
  }
  private get(id: string): StoredCard {
    identity(id); const row = this.options.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM computer_needs_you WHERE id=?").get(id);
    if (!row) throw new AppError("not_found", 404); return JSON.parse(row.record_json) as StoredCard;
  }
  private pending(conversation: string): StoredCard[] {
    return this.options.store.db.query<{ record_json: string }, [string, number]>("SELECT record_json FROM computer_needs_you WHERE conversation_id=? AND owner_generation=? AND delivered_by IS NULL AND json_extract(record_json,'$.voidedAt') IS NULL ORDER BY rowid").all(conversation, this.options.ownerGeneration()).map(row => JSON.parse(row.record_json) as StoredCard);
  }
  private current(card: StoredCard): ComputerNeedsYouCard {
    // Reading the control first expires an overdue yield through ScreenControl.row(), with its durable event.
    const control = this.options.screen.cardControl(card.id), outcome = this.options.screen.cardOutcome(card.id);
    if (card.voidedAt === undefined && this.now() - card.createdAt >= 60_000 && !control && !outcome) this.void(card);
    let code: string | null = null; try { this.allowed(card.origin); } catch (error) { code = error instanceof AppError ? error.code : "computer_browser_unavailable"; }
    return { ...card, state: outcome?.outcome ?? (card.voidedAt === undefined ? "pending" : "void"), generation: outcome?.generation ?? control?.generation ?? null,
      code, screenState: control?.state ?? null, canWatch: code === null && card.voidedAt === undefined && !!control && !outcome, canDecline: card.voidedAt === undefined && control?.state === "yield" && !outcome };
  }
  /** Posts metadata only, then yields. Failed insertion cannot yield; failed yield voids the already inserted card. */
  post(input: ComputerNeedsYouPost): { state: "yielded"; cardId: string; generation: number; expiresAt: number } {
    exact(input, ["requestId", "conversationId", "ownerGeneration", "vmGeneration", "vmId", "reason", "origin"]);
    [input.requestId, input.conversationId, input.vmId].forEach(identity); integer(input.ownerGeneration, 1); integer(input.vmGeneration, 1);
    if (!["sign_in", "verify", "captcha"].includes(input.reason)) throw new AppError("computer_browser_operation_invalid", 409);
    const origin = this.allowed(input.origin);
    const request = this.options.store.request(input.requestId);
    if (request.state !== "running" || request.receipt.conversationId !== input.conversationId || request.owner.generation !== input.ownerGeneration || input.ownerGeneration !== this.options.ownerGeneration() || !this.options.allows(request, input.vmId)) throw new AppError("outside_scope", 409);
    if (this.options.vmGeneration(input.vmId) !== input.vmGeneration) throw new AppError("computer_browser_stale", 409);
    const createdAt = this.now(), card: StoredCard = { ...input, origin, id: `need_${crypto.randomUUID().replaceAll("-", "")}`, createdAt, expiresAt: createdAt + this.minutes * 60_000 };
    this.options.store.transaction(() => {
      const count = this.options.store.db.query<{ count: number; bytes: number }, []>("SELECT count(*) AS count,coalesce(sum(length(CAST(record_json AS BLOB))),0) AS bytes FROM computer_needs_you").get()!;
      if (count.count >= 10000 || count.bytes + Buffer.byteLength(canonical(card)) > 8 * 1024 * 1024 || this.pending(input.conversationId).filter(row => this.current(row).state !== "void").length >= 64) throw new AppError("computer_needs_you_limit", 409);
      this.options.store.db.query("INSERT INTO computer_needs_you(id,conversation_id,request_id,vm_id,owner_generation,created_at,record_json) VALUES (?,?,?,?,?,?,?)").run(card.id, card.conversationId, card.requestId, card.vmId, card.ownerGeneration, card.createdAt, canonical(card));
    });
    try {
      if (this.now() - createdAt >= 60_000) throw new AppError("computer_browser_timeout", 504);
      const yielded = this.options.screen.yieldToOwner(card.vmId, card.id, card.expiresAt);
      return { state: "yielded", cardId: card.id, generation: yielded.generation, expiresAt: card.expiresAt };
    } catch (error) { this.void(card); throw error; }
  }
  /** Authenticated current cards: all undelivered cards (at most 64), plus 64 recent delivered/void cards. */
  list(owner: Owner, conversation: string): ComputerNeedsYouCard[] {
    this.options.requireOwner(owner); identity(conversation);
    const pending = this.pending(conversation).map(card => this.current(card));
    const recent = this.options.store.db.query<{ record_json: string }, [string, number]>("SELECT record_json FROM computer_needs_you WHERE conversation_id=? AND owner_generation=? AND (delivered_by IS NOT NULL OR json_extract(record_json,'$.voidedAt') IS NOT NULL) ORDER BY rowid DESC LIMIT 64").all(conversation, this.options.ownerGeneration()).reverse().map(row => this.current(JSON.parse(row.record_json)));
    return [...new Map([...pending, ...recent].map(card => [card.id, card])).values()];
  }
  /** Select the carried set once. The caller persists its IDs before sending this separate host source to MODEL. */
  prepare(request: ConversationRequest): ComputerScreenOutcome[] {
    if (!request.authority || request.owner.generation !== this.options.ownerGeneration()) return [];
    return this.pending(request.receipt.conversationId).flatMap(row => {
      const card = this.current(row);
      return ["resumed", "declined", "expired"].includes(card.state) && card.generation !== null && this.options.allows(request, card.vmId)
        ? [{ cardId: card.id, origin: card.origin, reason: card.reason, outcome: card.state as ComputerScreenOutcome["outcome"], generation: card.generation }] : [];
    });
  }
  /** Must share the conversation publication transaction; failed/held/cancelled runs never mark outcomes delivered. */
  delivered(request: ConversationRequest): void {
    if (!this.options.store.db.inTransaction || request.state !== "completed") throw new AppError("completion_transaction_required", 409);
    for (const id of request.screenOutcomeCards ?? []) this.options.store.db.query("UPDATE computer_needs_you SET delivered_by=? WHERE id=? AND conversation_id=? AND owner_generation=? AND delivered_by IS NULL").run(request.receipt.rootRequestId, id, request.receipt.conversationId, request.owner.generation);
  }
  /** Exact authenticated owner ingress. It never reopens the posting run or accepts credentials. */
  async command(owner: Owner, input: unknown, guard: () => void = () => {}): Promise<ComputerNeedsYouResult> {
    guard(); this.options.requireOwner(owner); exact(input, ["contract", "requestId", "conversationId", "cardId", "kind", "generation"]);
    const command = input as unknown as ComputerNeedsYouCommand;
    if (command.contract !== "s16-computer-needs-you/v1" || !["watch", "decline"].includes(command.kind)) throw new AppError("invalid_body");
    [command.requestId, command.conversationId, command.cardId].forEach(identity); integer(command.generation);
    const stored = this.get(command.cardId);
    if (stored.conversationId !== command.conversationId || stored.ownerGeneration !== this.options.ownerGeneration()) throw new AppError("not_found", 404);
    let card = this.current(stored);
    if (card.state !== "pending") return { contract: "s16-computer-needs-you-result/v1", card, screen: null };
    if (card.generation !== command.generation) throw new AppError("stale_screen", 409);
    if (command.kind === "decline") {
      guard(); this.options.requireOwner(owner); this.options.screen.declineYield(card.vmId, card.id, command.generation);
      return { contract: "s16-computer-needs-you-result/v1", card: this.current(this.get(card.id)), screen: null };
    }
    if (!card.canWatch) throw new AppError(card.code ?? "takeover_state_changed", 409);
    const current = () => { guard(); this.options.requireOwner(owner); this.allowed(card.origin); if (this.options.vmGeneration(card.vmId) !== card.vmGeneration) throw new AppError("computer_browser_stale", 409); };
    current();
    const screen = card.screenState === "yield" || card.screenState === "fenced"
      ? (await this.options.screen.command(owner, { contract: "s16-screen-command/v1", requestId: command.requestId, vmId: card.vmId, kind: "takeover", generation: command.generation }, current)).view
      : await this.options.screen.view(owner, card.vmId);
    current(); card = this.current(this.get(card.id));
    return { contract: "s16-computer-needs-you-result/v1", card, screen };
  }
}
