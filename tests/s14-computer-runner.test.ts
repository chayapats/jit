import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { localBox, runnerCall, type LocalBox } from "./fixtures/box-local-runner";

const boxes: LocalBox[] = [];
afterEach(() => { for (const box of boxes.splice(0)) rmSync(dirname(box.root), { recursive: true, force: true }); });

test("the reused runner rejects direct/relative/symlink access to another Bot, protected profile and control socket", async () => {
  const a = localBox("s14-runner-a-"), b = localBox("s14-runner-b-"); boxes.push(a, b);
  const profile = join(dirname(a.root), "protected-profile"); mkdirSync(profile);
  const other = join(b.root, "private-report"), session = join(profile, "synthetic-session");
  writeFileSync(other, "B private marker"); writeFileSync(session, "synthetic session marker");
  symlinkSync(b.root, join(a.root, "other-bot"));
  symlinkSync(profile, join(a.root, "profile"));
  const socketPath = join(a.root, "fake-control.sock"), server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  try {
    for (const path of [other, session, join(a.root, "other-bot/private-report"), join(a.root, "profile/synthetic-session"), join(a.root, "../protected-profile/synthetic-session")]) {
      expect(await runnerCall(a, { op: "read", path, offset: 0, length: 100 })).toMatchObject({ ok: false, error: { code: "EACCES" } });
    }
    expect(await runnerCall(a, { op: "read", path: socketPath, offset: 0, length: 100 })).toMatchObject({ ok: false, error: { code: "EINVAL" } });
    expect(await runnerCall(a, { op: "write", path: join(a.root, "profile/planted"), data: Buffer.from("blocked").toString("base64"), createParents: true })).toMatchObject({ ok: false, error: { code: "EACCES" } });
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  // This proves runner path/protocol confinement; real process/mount isolation remains the opt-in Linux gate.
});
