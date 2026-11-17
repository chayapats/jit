import { AppError } from "../../errors";
import { PolicyError } from "../../s15/policy/validation";
import type { ConversationApplication } from "../../s15/conversation/application";
import type { ConversationStore } from "../../s15/conversation/store";
import type { ComputerNeedsYou } from "./needs-you";
import type { ScreenControl } from "./screen";
import type { ComputerContinuationView } from "./needs-you-types";

type Binding = { card_id: string; conversation_id: string; source_request_id: string; owner_id: string; owner_generation: number; request_id: string | null; state: ComputerContinuationView["state"]; code: string | null };
/** Durable host-only scheduling. A screen event names eligibility, never new owner authority or a tool retry. */
export class ComputerContinuations<Actor, Work> {
  constructor(readonly options: { store: ConversationStore; conversation: ConversationApplication<Actor, Work>; needsYou: ComputerNeedsYou<Actor>; screen: ScreenControl<Actor>; owner(snapshot: { ownerId: string; generation: number }): Actor | null; now(): number }) {
    options.store.db.exec(`CREATE TABLE IF NOT EXISTS computer_continuations(card_id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL,source_request_id TEXT NOT NULL REFERENCES requests(id),owner_id TEXT NOT NULL,owner_generation INTEGER NOT NULL,request_id TEXT REFERENCES requests(id),state TEXT NOT NULL,code TEXT);
      CREATE INDEX IF NOT EXISTS computer_continuations_pending ON computer_continuations(state);
      CREATE TABLE IF NOT EXISTS computer_continuation_cursor(id INTEGER PRIMARY KEY CHECK(id=1),sequence INTEGER NOT NULL);
      INSERT OR IGNORE INTO computer_continuation_cursor VALUES(1,0);`);
  }
  private binding(card: string): Binding | null { return this.options.store.db.query<Binding, [string]>("SELECT * FROM computer_continuations WHERE card_id=?").get(card); }
  private finish(row: Binding, state: Binding["state"], code: string | null, requestId = row.request_id): void {
    this.options.store.db.query("UPDATE computer_continuations SET state=?,code=?,request_id=? WHERE card_id=?").run(state, code, requestId, row.card_id);
  }
  private requestState(id: string): ComputerContinuationView {
    const request = this.options.store.request(id);
    return { requestId: id, state: request.state === "queued" ? "queued" : request.state === "running" ? "running" : request.state === "completed" ? "completed" : request.state === "stopped" ? "stopped" : request.state === "reconcile_only" ? "unknown" : "held", code: request.code };
  }
  /** Current facts only. Reading never queues or advances a binding, so a page view cannot start work. */
  view(card: string): ComputerContinuationView | null {
    const row = this.binding(card); if (!row) return null;
    return row.state === "queued" && row.request_id ? this.requestState(row.request_id) : { state: row.state, requestId: row.request_id, code: row.code };
  }
  /** Bounded durable scan and settlement, repeated by the existing service drain after restart too. */
  pump(): void {
    const { store, needsYou, screen, conversation } = this.options;
    const cursor = store.db.query<{ sequence: number }, []>("SELECT sequence FROM computer_continuation_cursor WHERE id=1").get()!.sequence;
    for (const event of screen.resumptions(cursor)) store.transaction(() => {
      let proof; try { proof = needsYou.resumption(event.cardId); } catch { proof = null; }
      if (proof) {
        const source = store.request(proof.requestId);
        if (!source.routine) store.db.query("INSERT OR IGNORE INTO computer_continuations VALUES(?,?,?,?,?,NULL,'pending',NULL)").run(proof.cardId, proof.conversationId, proof.requestId, source.owner.id, proof.ownerGeneration);
      }
      store.db.query("UPDATE computer_continuation_cursor SET sequence=? WHERE id=1").run(event.sequence);
    });
    for (const row of store.db.query<Binding, []>("SELECT * FROM computer_continuations WHERE state IN ('pending','queued') ORDER BY rowid LIMIT 64").all()) {
      try {
        if (row.request_id) {
          const state = this.requestState(row.request_id);
          if (state.state !== "queued") { if (state.state !== "running") this.finish(row, state.state, state.code); continue; }
        }
        const actor = this.options.owner({ ownerId: row.owner_id, generation: row.owner_generation });
        if (!actor) throw new AppError("owner_changed");
        if (!row.request_id) {
          const delivered = store.db.query<{ delivered_by: string | null }, [string]>("SELECT delivered_by FROM computer_needs_you WHERE id=?").get(row.card_id)?.delivered_by;
          if (delivered) { this.finish(row, "covered", null, delivered); continue; }
          // A run carrying this outcome gets one chance to settle; failure remains attention, never an outer retry.
          const carrier = store.db.query<{ id: string; state: string }, [string]>("SELECT r.id,r.state FROM requests r,json_each(r.record_json,'$.screenOutcomeCards') c WHERE c.value=? ORDER BY r.rowid DESC LIMIT 1").get(row.card_id);
          if (carrier) {
            if (["queued", "running"].includes(carrier.state)) continue;
            this.finish(row, carrier.state === "stopped" ? "stopped" : carrier.state === "reconcile_only" ? "unknown" : "held", "computer_continuation_unavailable", carrier.id); continue;
          }
          // Serialize before binding a second request. Conversation drain owns the actual execution lock.
          if (store.db.query("SELECT 1 FROM requests WHERE conversation_id=? AND state IN ('queued','running') LIMIT 1").get(row.conversation_id)) continue;
        }
        conversation.resumeComputer(actor, row.card_id, receipt => this.finish(row, "queued", null, receipt.rootRequestId));
      } catch (error) {
        const code = error instanceof AppError || error instanceof PolicyError ? error.code : "computer_continuation_unavailable";
        if (code === "capacity_busy") continue;
        store.transaction(() => {
          this.finish(row, code === "aborted" ? "stopped" : code === "reconciliation_required" ? "unknown" : "held", code);
          if (row.request_id) {
            const request = store.request(row.request_id);
            if (request.state === "queued") { request.state = "held"; request.code = code; request.revision++; store.save(request); store.event(request, "needs_me", this.options.now(), code); }
          }
        });
      }
    }
  }
}
