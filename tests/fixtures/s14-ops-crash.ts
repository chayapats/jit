import { S14Maintenance, type OpsFault } from "../../src/s14/ops";
import type { S14Options } from "../../src/s14/application";
import type { OpsCommand, OpsNativePort } from "../../src/s14/ops-types";

const input = JSON.parse(await Bun.stdin.text()) as { path: string; token: string; point: OpsFault; command: OpsCommand; options: Pick<S14Options, "policy">; now: number };
const native: OpsNativePort = { supported: () => true, async open() { throw Error("fixture has no native intents"); } };
const maintenance = new S14Maintenance(input.path, { ...input.options, now: () => input.now, chat: { async reply() { throw Error("no inference"); } } }, native, point => {
  if (point === input.point) process.kill(process.pid, "SIGKILL");
});
try { await maintenance.execute(maintenance.app.authenticate(input.token).actor, input.command); }
finally { maintenance.close(); }
