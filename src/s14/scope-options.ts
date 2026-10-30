import type { AppTransaction } from "../store";
import type { S14Application } from "./application";
import { record } from "./application";
import type { Bot, OwnerActor } from "./types";
import type { ScopePolicy } from "./authority-types";
import type { MemoryShare } from "./memory-types";
import { identity } from "./validation";

/** Recovers only durable, already owner-selected resource ceilings; it creates no resource or share authorization. */
export function existingResourceCeilings(tx: AppTransaction): string[] {
  const ids = new Set<string>();
  for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM bots")) {
    const bot = JSON.parse(row.record_json) as Bot;
    if (!bot.enabled) continue;
    for (const id of bot.capabilities.resources) { identity(id); ids.add(id); }
  }
  return [...ids];
}

/** Lists existing live memory-share scopes inside a Bot's explicit resource ceiling; snapshot sharing stays with #253. */
export function scopeOptions(app: S14Application, actor: OwnerActor, botId: string): { label: string; scope: ScopePolicy }[] {
  identity(botId);
  return app.store.read(tx => {
    app.requireOwner(tx, actor);
    const bot = record<Bot>(tx, "bots", botId);
    if (!bot.enabled) return [];
    const options = [];
    for (const id of bot.capabilities.resources.slice(0, 64)) {
      const row = tx.get<{ record_json: string }>("SELECT record_json FROM memory_shares WHERE id=?", id);
      if (!row) continue;
      const share = JSON.parse(row.record_json) as MemoryShare;
      if (share.receiverBotId !== bot.id) continue;
      const scope = app.memory.scope(tx, { kind: "share", id, revision: share.revision });
      if (scope) options.push({ label: record<Bot>(tx, "bots", scope.ownerBotId).name, scope });
    }
    return options;
  });
}
