import type { AppTransaction } from "../store";
import type { ComputerActivity } from "./computer-types";

/** Records only service-defined activity categories and time, retaining at most 200 events per computer. */
export function recordComputerActivity(tx: AppTransaction, computerId: string, generation: number, kind: "page.opened" | "screenshot" | "agent.scroll" | "system.stop", at: number): void {
  tx.run("INSERT INTO computer_activity(computer_id,generation,kind,at) VALUES (?,?,?,?)", computerId, generation, kind, at);
  tx.run("DELETE FROM computer_activity WHERE computer_id=? AND sequence NOT IN (SELECT sequence FROM computer_activity WHERE computer_id=? ORDER BY sequence DESC LIMIT 200)", computerId, computerId);
}

/** Reads bounded service-observed events without text, URLs, coordinates, secrets or image data. */
export function computerActivity(tx: AppTransaction, computerId: string, limit: number): ComputerActivity[] {
  return tx.all<ComputerActivity>("SELECT kind,at,NULL AS state FROM computer_activity WHERE computer_id=? ORDER BY sequence DESC LIMIT ?", computerId, limit);
}
