import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import type { S14Application } from "./application";
import { record } from "./application";
import type { Bot, BotReceipt, Conversation, Envelope, Home } from "./types";
import { canonical, exact, identity } from "./validation";

/** Owner preference and conversation commands confer no work or resource authority. */
export type OwnerCommand = Envelope<"owner.preferences.set", { language: "th" | "en"; theme: "system" | "light" | "dark" }>
  | Envelope<"conversation.create", { botId: string }>;

/** Applies explicit owner configuration inside the shared receipt transaction. */
export function applyOwnerCommand(app: S14Application, tx: AppTransaction, c: OwnerCommand): BotReceipt {
  const row = tx.get<{ revision: number; profile_json: string | null }>("SELECT * FROM installation")!;
  if (!row.profile_json) throw new AppError("setup_required", 409);
  if (c.kind === "owner.preferences.set") {
    exact(c.payload, ["language", "theme"]);
    if (c.expectedRevision !== row.revision) throw new AppError("stale_revision", 409);
    if (!["th", "en"].includes(c.payload.language)) throw new AppError("invalid_language");
    if (!["system", "light", "dark"].includes(c.payload.theme)) throw new AppError("invalid_theme");
    const profile: NonNullable<Home["owner"]> = JSON.parse(row.profile_json);
    profile.language = c.payload.language;
    profile.theme = c.payload.theme;
    tx.run("UPDATE installation SET revision=revision+1,profile_json=?", canonical(profile));
    return { kind: c.kind, requestId: c.requestId, preferences: { revision: row.revision + 1, ...c.payload } };
  }
  exact(c.payload, ["botId"]);
  identity(c.payload.botId);
  const bot = record<Bot>(tx, "bots", c.payload.botId);
  if (c.expectedRevision !== bot.revision) throw new AppError("stale_revision", 409);
  if (!bot.enabled) throw new AppError("bot_disabled", 403);
  const conversation: Conversation = { id: crypto.randomUUID().replaceAll("-", ""), botId: bot.id, revision: 1 };
  tx.run("INSERT INTO conversations VALUES (?,?,?)", conversation.id, bot.id, 1);
  return { kind: c.kind, requestId: c.requestId, conversation };
}
