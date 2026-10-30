import { S14Application } from "../../src/s14/application";
import type { S14Command } from "../../src/s14/application";
import { S14Store } from "../../src/s14/store";
import type { Policy } from "../../src/s14/types";
const input = JSON.parse(await Bun.stdin.text()) as { path: string; token: string; policy: Policy; now: number; mode: string; command?: S14Command; effectId?: string; revision?: number; actionHash?: string };
const store = new S14Store(input.path);
const app = new S14Application(store, { policy: input.policy, now: () => input.now, chat: { async reply() { throw Error("fixture_no_inference"); } }, authority: { effects: { send: async () => new Promise<"succeeded">(() => {}) } } });
if (input.mode === "command") console.log(JSON.stringify(app.execute(app.authenticate(input.token).actor, input.command!)));
else {
  void app.authority.runEffect(input.effectId!, input.revision!, input.actionHash!);
  console.log("claimed_no_send");
}
store.close();
