import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConversationStore } from "../src/s15/conversation/store";
import { ConversationApplication } from "../src/s15/conversation/application";
import type { ConversationOptions } from "../src/s15/conversation/types";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const path = () => { const root = mkdtempSync(join(tmpdir(), "jit-skill-chat-")); cleanups.push(() => rmSync(root, { recursive: true, force: true })); return join(root, "chat.sqlite"); };
const version = (store: ConversationStore) => store.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;

test("the first skill-use format stamp rolls back with CHAT and old readers refuse the committed dependency without changing bytes", () => {
  const file = path(), store = new ConversationStore(file, "fixture", true, false, false, true); cleanups.push(() => store.close());
  expect(() => store.requireSkillContract()).toThrow("skills_required");
  expect(() => store.transaction(() => { store.requireSkillContract(); throw Error("controlled rollback"); })).toThrow("controlled rollback"); expect(version(store)).toBe(1);
  store.transaction(() => store.requireSkillContract()); expect(version(store)).toBe(5); store.close(); const bytes = readFileSync(file);
  expect(() => new ConversationStore(file, "fixture", false, true, true)).toThrow("conversation_store_incompatible"); expect(readFileSync(file)).toEqual(bytes);
  const reopened = new ConversationStore(file, "fixture", false, false, false, true); cleanups.push(() => reopened.close()); expect(version(reopened)).toBe(5);
});

test("removing the owning guard cannot reopen loaded CHAT and later file-format stamps retain the strongest dependency", () => {
  const store = new ConversationStore(path(), "fixture", true, true, true, true); cleanups.push(() => store.close());
  store.transaction(() => { store.requireSkillContract(); store.requireFileContract(4); }); expect(version(store)).toBe(5);
  // No work/authority port is used: dependency refusal must happen before any engine or tool can open.
  expect(() => new ConversationApplication(store, {} as ConversationOptions<unknown, unknown>)).toThrow("skills_required");
  const old = new ConversationStore(path(), "fixture", true); cleanups.push(() => old.close());
  expect(() => new ConversationApplication(old, { skills: { guard() {} } } as unknown as ConversationOptions<unknown, unknown>)).toThrow("skills_required");
});
