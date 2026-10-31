import { mock } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import type { S14Options } from "../../src/s14/application";
import type { OpsNativePort } from "../../src/s14/ops-types";

const input = JSON.parse(await Bun.stdin.text()) as { path: string; token: string; failure: string | null; options: Pick<S14Options, "policy">; now: number };
const real = { ...fs }, descriptors = new Map<number, string>();
const root = `${input.path}.ops`, backups = join(root, "backups");
const events: { kind: "mkdir" | "sync"; path: string; directory: boolean }[] = [];
let injected = false;
// A separate process keeps this filesystem seam out of the rest of the Bun test suite.
mock.module("node:fs", () => ({ ...real,
  openSync(...args: Parameters<typeof fs.openSync>) { const fd = real.openSync(...args); descriptors.set(fd, String(args[0])); return fd; },
  closeSync(fd: number) { descriptors.delete(fd); real.closeSync(fd); },
  mkdirSync(...args: Parameters<typeof fs.mkdirSync>) {
    const existed = real.existsSync(args[0]), result = real.mkdirSync(...args);
    if (!existed) events.push({ kind: "mkdir", path: String(args[0]), directory: true });
    return result;
  },
  fsyncSync(fd: number) {
    const path = descriptors.get(fd)!;
    const directory = real.fstatSync(fd).isDirectory();
    events.push({ kind: "sync", path, directory });
    const fail = input.failure === "directory" && directory && path === backups ||
      input.failure === "parent" && directory && path === root && real.existsSync(backups) ||
      input.failure === "contents" && !directory && path.startsWith(backups) && path.endsWith("/application.sqlite");
    if (fail && !injected) { injected = true; throw Error("injected_fsync_failure"); }
    if (input.failure === "atomic" && directory && path === root && real.existsSync(join(root, "atomic.json"))) { injected = true; throw Error("injected_fsync_failure"); }
    real.fsyncSync(fd);
  },
}));
const { S14Maintenance } = await import("../../src/s14/ops");
const { opsAtomic } = await import("../../src/s14/ops-files");
const native: OpsNativePort = { supported: () => true, async open() { throw Error("no native sessions"); } };
const m = new S14Maintenance(input.path, { ...input.options, now: () => input.now, chat: { async reply() { throw Error("no inference"); } } }, native);
try {
  let state = "failed";
  try {
    if (input.failure === "atomic") { opsAtomic(join(root, "atomic.json"), {}); state = "complete"; }
    else state = (await m.execute(m.app.authenticate(input.token).actor, { kind: "backup.create", requestId: "a".repeat(32), expectedRevision: m.control.revision, payload: {} })).state;
  } catch { /* The parent asserts failures cannot produce a complete receipt. */ }
  process.stdout.write(JSON.stringify({ state, injected, events, control: m.control }));
} finally { m.close(); }
