import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S14Application, type S14Options } from "../../src/s14/application";
import { S14Store } from "../../src/s14/store";
import type { EnableRoutineCommand } from "../../src/s14/routine-types";
import type { StartWorkCommand } from "../../src/s14/authority-types";
import type { Capabilities } from "../../src/s14/types";

/** Generates an opaque per-action deterministic-fixture retry identity. */
export const retryId = () => crypto.randomUUID().replaceAll("-", "");
/** Creates a local no-network S14 owner with an explicit fake clock and injectable trusted ports. */
export async function domainFixture(overrides: Partial<S14Options> = {}, initialCapabilities?: Capabilities) {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-domain-"));
  const path = join(root, "application.sqlite"), clock = { now: Date.UTC(2026, 9, 31, 0) };
  const options: S14Options = { now: () => clock.now,
    policy: { routes: [{ id: "selected", provider: "codex", model: "fixture" }], tools: ["web_search", "web_fetch", "computer"], resources: ["share1", "resource1"] },
    chat: { async reply() { return { text: "Proposal", proposal: { name: "Researcher", responsibility: "Research facts" } }; } },
    ...overrides };
  let store = new S14Store(path);
  let app = new S14Application(store, options);
  const password = "domain-fixture-owner-password";
  await app.provisionOwner(password);
  const token = await app.login(password);
  const auth = app.authenticate(token);
  const setup = app.execute(auth.actor, { kind: "setup", requestId: retryId(), expectedRevision: 0,
    payload: { ownerName: "Owner", language: "en", routeId: "selected", capabilities: initialCapabilities ?? { tools: options.policy.tools, resources: options.policy.resources } } });
  return { root, path, clock, options, token, auth, app, store, bot: setup.bot!, conversationId: setup.conversation!.id,
    reopen() { store.close(); store = new S14Store(path); app = new S14Application(store, options); this.store = store; this.app = app; this.auth = app.authenticate(token); },
    dispose() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
/** Shared fixture type carries current owner and application instances across reopen. */
export type DomainFixture = Awaited<ReturnType<typeof domainFixture>>;
/** Builds an explicit finite standing command without deriving authority from test text. */
export function routineCommand(f: DomainFixture, changes: Partial<EnableRoutineCommand["payload"]> = {}): EnableRoutineCommand {
  return { kind: "routine.enable", requestId: retryId(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision,
    payload: { conversationId: f.conversationId, title: "Daily facts", purpose: "Compare public facts", completionRule: "Evidence for review",
      bots: [{ id: "jit", revision: f.app.home(f.auth.actor).bots.find(b => b.id === "jit")!.revision }], tools: [], scopes: [],
      limits: { attempts: 4, steps: 4, calls: 8, outputBytes: 32768, wallMs: 60000, concurrency: 2, reads: 4 },
      timezone: "Asia/Bangkok", recurrence: { kind: "interval", everyMs: 60000 }, misfire: "coalesce", occurrenceBudget: 3,
      endsAt: f.clock.now + 30 * 86400000, ...changes } };
}
/** Builds a new explicit work command under current Bot and conversation revisions. */
export function workCommand(f: DomainFixture, changes: Partial<StartWorkCommand["payload"]> = {}): StartWorkCommand {
  const { timezone: _tz, recurrence: _r, misfire: _m, occurrenceBudget: _b, endsAt: _e, ...purpose } = routineCommand(f).payload;
  return { kind: "work.start", requestId: retryId(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision,
    payload: { ...purpose, task: null, expiresAt: f.clock.now + 60000, ...changes } };
}
/** Creates a second permanent Bot only by the scripted suggestion and exact owner acceptance path. */
export async function secondBot(f: DomainFixture) {
  f.app.execute(f.auth.actor, { kind: "message.post", requestId: retryId(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision,
    payload: { conversationId: f.conversationId, text: "Suggest a research Bot" } });
  await f.app.drainReplies();
  const proposal = f.app.home(f.auth.actor).proposals.find(p => p.state === "proposed")!;
  return f.app.execute(f.auth.actor, { kind: "bot.proposal.accept", requestId: retryId(), expectedRevision: proposal.revision,
    payload: { proposalId: proposal.id, capabilities: { tools: f.options.policy.tools, resources: f.options.policy.resources } } }).bot!;
}
