import { createHost } from "schway/host";
import { S14Application } from "../../src/s14/application";
import { S14Store } from "../../src/s14/store";
import { record } from "../../src/s14/application";
import { nativeIntentPaths } from "../../src/s14/native-recovery";
import type { Attempt } from "../../src/s14/authority-types";
import type { Policy } from "../../src/s14/types";
import { canonical } from "../../src/s14/validation";

const input = JSON.parse(await Bun.stdin.text()) as { path: string; directory: string; policy: Policy; now: number; attemptId: string; phase: string };
const store = new S14Store(input.path);
const app = new S14Application(store, { policy: input.policy, now: () => input.now, chat: { async reply() { throw Error("No inference in crash fixture"); } } });
const attempt = store.read(tx => record<Attempt>(tx, "work_attempts", input.attemptId));
const intent = app.recovery.intent(attempt.id, attempt.memoryId!, attempt.snapshot.route);
if (input.phase === "before_creation") process.exit(0);
const host = await createHost({ ...nativeIntentPaths(input.directory, intent), context: { policy: "strict", systemPrompt: "Fixture metadata only", sections: [] }, tools: { policy: "exact", hostedLookup: "off", definitions: [] }, limits: { maxTurns: 1, maxConcurrentTools: 1, contextWindow: 32768, maxInputChars: 1024 } });
const session = await host.createSession();
if (input.phase === "after_native_persistence") process.exit(0);
app.recovery.correlate(intent.id, session.reference);
if (input.phase === "during_retirement") await session.retire();
if (input.phase === "during_deletion") {
  intent.reference = session.reference; intent.mode = "delete";
  store.transaction(tx => tx.run("UPDATE native_intents SET record_json=? WHERE id=?", canonical(intent), intent.id));
  await session.close();
  const result = await host.deleteSession(session.reference);
  if (result.status !== "deleted") throw Error("Fixture deletion did not settle");
}
// Exit without app lifecycle acknowledgement or host disposal: OS lease release is the crash barrier.
process.exit(0);
