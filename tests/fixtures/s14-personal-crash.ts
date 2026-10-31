import { writeFileSync } from "node:fs";
import { personalFixture, connect, grant, personalAttempt, readInput } from "./s14-personal";
import { retryId } from "./s14-domain";

const manifestPath = process.argv[2]!;
const f = await personalFixture();
const connection = await connect(f, "gmail", ["gmail.readonly", "gmail.send"]);
grant(f, connection.id);
const attempt = personalAttempt(f, "mail", ["effect_send"]);
const view = f.app.personal.effects.propose(attempt.id, retryId(), readInput(f).scope, { kind: "mail", to: ["owner@example.test"], cc: [], bcc: [], subject: "Crash fixture", body: "Exactly once local dispatch" }, f.clock.now + 50000);
f.app.execute(f.auth.actor, { kind: "approval.decide", requestId: retryId(), expectedRevision: 1, payload: { effectId: view.effect.id, actionHash: view.effect.actionHash, decision: "approve" } });
writeFileSync(manifestPath, JSON.stringify({ root: f.root, vaultRoot: f.vaultRoot, path: f.path, policy: f.options.policy, now: f.clock.now, effectId: view.effect.id, draftId: view.draft.id }), { mode: 0o600 });
f.google.hook = async (url, init) => {
  if (url.endsWith("/messages/send")) {
    writeFileSync(`${manifestPath}.dispatched`, "one scripted provider dispatch", { mode: 0o600 });
    process.exit(79);
  }
  return f.google.normal(url, init);
};
await f.app.authority.runEffect(view.effect.id, 1, view.effect.actionHash);
throw new Error("Fixture must die during the claimed provider request");
