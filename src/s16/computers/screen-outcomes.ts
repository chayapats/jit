import { AppError } from "../../errors";
import { exact, identity, integer } from "../../s15/conversation/validation";
import { computerNeedsYouOrigin } from "./needs-you";
import type { ComputerScreenOutcome } from "./needs-you-types";

/** Closed, bounded host data. It neither grants authority nor enters interpretation or memory claims. */
export function validateScreenOutcomes(value: unknown): asserts value is readonly ComputerScreenOutcome[] {
  if (!Array.isArray(value) || value.length > 64) throw new AppError("invalid_data");
  const ids = new Set<string>();
  for (const row of value) {
    exact(row, ["cardId", "origin", "reason", "outcome", "generation"]);
    identity(row.cardId); integer(row.generation, 1); computerNeedsYouOrigin(row.origin);
    if (ids.has(row.cardId) || !["sign_in", "verify", "captcha"].includes(String(row.reason)) || !["resumed", "declined", "expired"].includes(String(row.outcome))) throw new AppError("invalid_data");
    ids.add(row.cardId);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 32_768) throw new AppError("invalid_data");
}

/** A separate labelled Schway host source; provider content and owner chat cannot create one. */
export function screenOutcomeSources(value?: readonly ComputerScreenOutcome[]): { id: string; revision: string; content: string }[] {
  if (value === undefined) return [];
  validateScreenOutcomes(value);
  return value.length ? [{ id: "screen-outcome-data-never-authority", revision: "1", content: JSON.stringify({ authority: "none", outcomes: value }) }] : [];
}
