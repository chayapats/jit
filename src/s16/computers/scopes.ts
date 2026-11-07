import { AppError } from "../../errors";
import type { VmStore } from "../../s15/vm/store";
import { vmId } from "../../s15/vm/validation";

/** Owner-visible scope of one working computer. A private computer belongs to exactly one Bot. */
export type ComputerScope = { kind: "shared" } | { kind: "private"; botId: string };
/** One protected private assignment row (`s16-computer-scope/v1`). */
export interface ComputerAssignment { vmId: string; botId: string; createdAt: number; retiredAt: number | null }

/**
 * TEAM16-01 protected computer scopes, stored in the VM journal next to the pool rows they constrain.
 *
 * Every member without a row is shared. A private row is written once, by the authenticated owner's
 * explicit command, for a member that has never held work (normally one Jit is about to create), so no
 * existing shared workspace becomes private. The row's Bot is immutable and the row is never deleted:
 * a private computer can never be re-labelled shared or given to another Bot, because its disk holds
 * that Bot's private working state (no silent promotion). Retiring only stops new placement there; work
 * whose workspace lives on it keeps returning, still only for its Bot.
 */
export class ComputerScopes {
  constructor(readonly store: VmStore, readonly defaultMemberId: string, readonly now: () => number = Date.now) {
    vmId(defaultMemberId);
    store.db.exec(`CREATE TABLE IF NOT EXISTS vm_scope (vm_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, created_at INTEGER NOT NULL, retired_at INTEGER);
      CREATE TRIGGER IF NOT EXISTS vm_scope_no_delete BEFORE DELETE ON vm_scope BEGIN SELECT RAISE(ABORT,'computer_scope_immutable'); END;
      CREATE TRIGGER IF NOT EXISTS vm_scope_no_rebind BEFORE UPDATE ON vm_scope WHEN NEW.vm_id<>OLD.vm_id OR NEW.bot_id<>OLD.bot_id OR NEW.created_at<>OLD.created_at OR OLD.retired_at IS NOT NULL OR NEW.retired_at IS NULL
        BEGIN SELECT RAISE(ABORT,'computer_scope_immutable'); END;`);
  }
  private row(vm: string): ComputerAssignment | null {
    const row = this.store.db.query<{ vm_id: string; bot_id: string; created_at: number; retired_at: number | null }, [string]>("SELECT * FROM vm_scope WHERE vm_id=?").get(vm);
    return row ? { vmId: row.vm_id, botId: row.bot_id, createdAt: row.created_at, retiredAt: row.retired_at } : null;
  }
  /** Bot a member is privately assigned to, retired or not; null for a shared member. */
  privateBot(vm: string): string | null { vmId(vm); return this.row(vm)?.botId ?? null; }
  /** Owner-visible scope of a member. */
  scope(vm: string): ComputerScope { const bot = this.privateBot(vm); return bot === null ? { kind: "shared" } : { kind: "private", botId: bot }; }
  /** Current (not retired) private members of a Bot, including one still being set up, oldest first. */
  assigned(botId: string): string[] {
    vmId(botId);
    return this.store.db.query<{ vm_id: string }, [string]>("SELECT vm_id FROM vm_scope WHERE bot_id=? AND retired_at IS NULL ORDER BY created_at, rowid").all(botId).map(row => row.vm_id);
  }
  /** Every private assignment, retired included, oldest first. */
  all(): ComputerAssignment[] {
    return this.store.db.query<{ vm_id: string }, []>("SELECT vm_id FROM vm_scope ORDER BY created_at, rowid").all().map(row => this.row(row.vm_id)!);
  }
  /**
   * Writes the one private row for a member that has never held work and has no open session. The default
   * member stays shared. A Bot has at most one current private computer. Runs inside the caller's VM
   * journal transaction when one is open.
   */
  assignPrivate(vm: string, botId: string): ComputerAssignment {
    vmId(vm); vmId(botId);
    if (vm === this.defaultMemberId) throw new AppError("computer_default_shared", 409);
    return this.store.transaction(() => {
      if (this.row(vm)) throw new AppError("computer_scope_immutable", 409);
      if (this.assigned(botId).length) throw new AppError("computer_private_exists", 409);
      const used = this.store.db.query("SELECT 1 FROM vm_affinity WHERE vm_id=? LIMIT 1").get(vm) || this.store.db.query("SELECT 1 FROM vm_sessions WHERE vm_id=? LIMIT 1").get(vm);
      if (used) throw new AppError("private_promotion_requires_migration", 409);
      this.store.db.query("INSERT INTO vm_scope VALUES (?,?,?,NULL)").run(vm, botId, this.now());
      return this.row(vm)!;
    });
  }
  /** Stops new placement for a Bot on its private computer; the row (and its Bot) stay forever. */
  retire(vm: string): ComputerAssignment {
    vmId(vm);
    return this.store.transaction(() => {
      const row = this.row(vm); if (!row) throw new AppError("computer_not_private", 409);
      if (row.retiredAt === null) this.store.db.query("UPDATE vm_scope SET retired_at=? WHERE vm_id=?").run(this.now(), vm);
      return this.row(vm)!;
    });
  }
}
