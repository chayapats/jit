import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertNotUpgradeFenced, clearUpgradeFence, readUpgradeFence, upgradeFenced, upgradeFenceLockPath, upgradeFencePath, withUpgradeFenceLock, writeUpgradeFence } from "../src/ops/upgrade-fence";

const roots: string[] = [], worker = join(import.meta.dir, "fence-lock-worker.ts");
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-fence-lock-")); roots.push(root);
  return { root, db: join(root, "state", "app.sqlite"), at: (name: string) => join(root, name) };
}
const spawn = (...args: string[]) => Bun.spawn([process.execPath, worker, ...args], { stdout: "pipe", stderr: "pipe" });
async function result(child: ReturnType<typeof spawn>): Promise<{ id: string; ok: boolean; code?: string }> {
  const [stdout] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return JSON.parse(stdout.trim());
}
async function until(path: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!existsSync(path)) { if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`); await Bun.sleep(5); }
}

test("a stale owner clearer paused between read and unlink never removes a fence a new id acquired meanwhile", async () => {
  const f = fixture();
  writeUpgradeFence(f.db, "stale", 1);
  // A reads the stale claim inside the critical section and pauses there.
  const a = spawn("clear-paused", f.db, "stale", f.at("a-read"), f.at("a-go"));
  await until(f.at("a-read"));
  // C (a second clearer of the same stale owner) and B (a new acquirer) start while A still holds its read.
  const c = spawn("clear", f.db, "stale", f.at("c-started")), b = spawn("acquire", f.db, "fresh", f.at("b-started"));
  await until(f.at("c-started")); await until(f.at("b-started"));
  // Without the lock, C would unlink the stale fence and B would link its own during this window.
  await Bun.sleep(400);
  expect(readUpgradeFence(f.db)?.upgradeId).toBe("stale");
  writeFileSync(f.at("a-go"), "go");
  expect(await result(a)).toEqual({ id: "stale", ok: true });
  expect(await result(c)).toEqual({ id: "stale", ok: true });
  expect(await result(b)).toEqual({ id: "fresh", ok: true });
  expect(readUpgradeFence(f.db)?.upgradeId).toBe("fresh");
  // The stale owner can still never clear the new claim; its own id can.
  clearUpgradeFence(f.db, "stale"); expect(readUpgradeFence(f.db)?.upgradeId).toBe("fresh");
  clearUpgradeFence(f.db, "fresh"); expect(readUpgradeFence(f.db)).toBeNull();
}, 30_000);

test("a process killed while holding the lock never blocks the next acquisition", async () => {
  const f = fixture();
  const holder = spawn("hold", f.db, "holder", f.at("held"));
  await until(f.at("held"));
  // While the holder lives, a bounded wait refuses as busy and changes nothing.
  expect(() => writeUpgradeFence(f.db, "blocked", 1)).toThrow(/upgrade_in_progress/);
  expect(() => withUpgradeFenceLock(f.db, () => "never", { timeoutMs: 100 })).toThrow(/upgrade_in_progress/);
  expect(readUpgradeFence(f.db)).toBeNull();
  holder.kill("SIGKILL"); await holder.exited;
  const started = Date.now();
  writeUpgradeFence(f.db, "next", 1);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(readUpgradeFence(f.db)?.upgradeId).toBe("next");
}, 30_000);

test("readers keep file-fence semantics and the lock file stays an empty single inode with no side files", () => {
  const f = fixture();
  expect(readUpgradeFence(f.db)).toBeNull(); expect(upgradeFenced(f.db)).toBe(false); expect(() => assertNotUpgradeFenced(f.db)).not.toThrow();
  writeUpgradeFence(f.db, "u1", 7, "restore");
  expect(readUpgradeFence(f.db)).toEqual({ contract: "ops.schema_migrations/v1", upgradeId: "u1", since: 7, holder: "restore" });
  expect(upgradeFenced(f.db)).toBe(true); expect(() => assertNotUpgradeFenced(f.db)).toThrow(/upgrade_in_progress/);
  // Re-acquiring the same id is a no-op; another id is refused with the holder's code.
  expect(() => writeUpgradeFence(f.db, "u1", 8, "restore")).not.toThrow();
  expect(() => writeUpgradeFence(f.db, "u2", 8)).toThrow(/restore_in_progress/);
  const lock = upgradeFenceLockPath(f.db), inode = statSync(lock).ino;
  expect(statSync(lock).size).toBe(0); expect(statSync(lock).mode & 0o777).toBe(0o600);
  clearUpgradeFence(f.db, "u1"); expect(readUpgradeFence(f.db)).toBeNull();
  // An unreadable fence still fences and is released only through its "unknown" claim.
  writeFileSync(upgradeFencePath(f.db), "{not json");
  expect(readUpgradeFence(f.db)?.upgradeId).toBe("unknown"); expect(upgradeFenced(f.db)).toBe(true);
  clearUpgradeFence(f.db, "u1"); expect(upgradeFenced(f.db)).toBe(true);
  clearUpgradeFence(f.db, "unknown"); expect(upgradeFenced(f.db)).toBe(false);
  writeUpgradeFence(f.db, "u3", 9); clearUpgradeFence(f.db); expect(upgradeFenced(f.db)).toBe(false);
  expect(statSync(lock).ino).toBe(inode); expect(statSync(lock).size).toBe(0);
  expect(readdirSync(join(f.root, "state")).sort()).toEqual(["app.sqlite.upgrade-fence.lock"]);
});

test("an unusable lock path refuses with a storage error and is never opened as a database", () => {
  const f = fixture(); mkdirSync(join(f.root, "state"));
  writeFileSync(upgradeFenceLockPath(f.db), "not a lock");
  expect(() => writeUpgradeFence(f.db, "u1", 1)).toThrow(/upgrade_storage_unavailable/);
  expect(() => clearUpgradeFence(f.db, "u1")).toThrow(/upgrade_storage_unavailable/);
  expect(readFileSync(upgradeFenceLockPath(f.db), "utf8")).toBe("not a lock");
  expect(upgradeFenced(f.db)).toBe(false);
  rmSync(upgradeFenceLockPath(f.db)); mkdirSync(upgradeFenceLockPath(f.db));
  expect(() => writeUpgradeFence(f.db, "u1", 1)).toThrow(/upgrade_storage_unavailable/);
});
