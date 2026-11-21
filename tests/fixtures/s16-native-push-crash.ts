import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NativeNotificationService } from "../../src/s16/native-notifications/service";
import type { NativePushProvider } from "../../src/s16/native-notifications/types";

// Disposable protocol fixture only: represents provider acceptance before its HTTP reply was lost to SIGKILL.
const directory = process.argv[2]!;
const provider: NativePushProvider = {
  kind: "apns", status: () => ({ provider: "apns", available: true, code: null }),
  async send(input) {
    input.guard();
    writeFileSync(join(directory, "accepted-notice.json"), JSON.stringify(input.payload), { mode: 0o600 });
    console.log(JSON.stringify({ state: service.deliveries(input.payload.id)[0]!.state, id: input.payload.id }));
    return await new Promise(() => {});
  }
};
const service = new NativeNotificationService({ path: join(directory, "native-notifications.sqlite"), installationId: "fixture", create: true, origin: "https://jit.example", providers: [provider], principal: () => ({ ownerId: "owner", generation: 1 }), ownerCurrent: () => true, now: () => 1000 });
service.subscribe({}, { provider: "apns", token: "a".repeat(64), locale: "en" });
service.record({ source: "crashed_native_notice", owner: { ownerId: "owner", generation: 1 }, kind: "needs_you", path: "/s16/chat/opaque_conversation" });
setInterval(() => {}, 1000);
await service.deliver();
