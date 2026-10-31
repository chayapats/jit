import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskMountUnit, diskPoolCapacity, provisionS14Disks } from "../ops/package/installer/s14-disks";
import { computerDiskPool, readComputerDiskPool } from "../src/s14/computer-disks";
import { computerPodmanHostLocal, localComputerPodman } from "../src/s14/computer-podman";
import type { PodmanClient } from "../src/exec/podman-client";

const GiB = 1024 ** 3, roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
test("capacity accounts for full sparse commitments, including existing not-yet-allocated blocks", () => {
  expect(() => diskPoolCapacity(18 * GiB, 2 * GiB, [], 16)).not.toThrow();
  expect(() => diskPoolCapacity(18 * GiB - 1, 2 * GiB, [], 16)).toThrow("computer_disk_pool_overcommit");
  expect(() => diskPoolCapacity(17 * GiB, 2 * GiB, [{ size: GiB, allocated: 1 }], 15)).toThrow("overcommit");
  expect(() => diskPoolCapacity(17 * GiB, 2 * GiB, [{ size: GiB, allocated: GiB }], 15)).not.toThrow();
});
test("installer creates eight finite pairs, reruns without reformatting, extends and preserves data", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pool-install-"))); roots.push(root);
  const dataRoot = join(root, "computers"), options = { root, dataRoot, uid: 1001, gid: 1001, reserveBytes: 2 * GiB, dryRun: true, freeBytes: 40 * GiB,
    run: async () => { throw new Error("no host tools in deterministic test"); } };
  const mask = process.umask(0o077);
  let pool;
  try { pool = await provisionS14Disks(options); } finally { process.umask(mask); }
  expect(statSync(join(dataRoot, "pool.json")).mode & 0o777).toBe(0o644);
  expect(pool.slots).toHaveLength(8);
  const image = join(dataRoot, "images/slot-0001-workspace.ext4"), inode = statSync(image).ino;
  expect(statSync(image).size).toBe(GiB);
  const keep = join(dataRoot, "slots/slot-0001/workspace/keep"); writeFileSync(keep, "Bot data");
  expect(await provisionS14Disks(options)).toEqual(pool);
  expect(statSync(image).ino).toBe(inode); expect(readFileSync(keep, "utf8")).toBe("Bot data");
  expect((await provisionS14Disks({ ...options, slots: 9 })).slots).toHaveLength(9);
  expect((await provisionS14Disks(options)).slots).toHaveLength(9);
  const mount = join(dataRoot, "slots/slot-0001/workspace");
  expect(readFileSync(join(root, "etc/systemd/system", diskMountUnit(mount)), "utf8")).toContain("Options=loop,nodev,nosuid");
  expect(() => computerDiskPool({ ...pool, slots: ["slot-0001", "slot-0001"] })).toThrow();
});
test("overcommit fails before creating images; linked installer paths and service-writable manifests refuse", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pool-refuse-"))); roots.push(root);
  const dataRoot = join(root, "computers"), options = { root, dataRoot, uid: 1001, gid: 1001, reserveBytes: GiB, dryRun: true, freeBytes: 16 * GiB,
    run: async () => { throw new Error("no host commands"); } };
  await expect(provisionS14Disks(options)).rejects.toThrow("overcommit"); expect(existsSync(dataRoot)).toBe(false);
  symlinkSync(root, dataRoot);
  await expect(provisionS14Disks({ ...options, freeBytes: 40 * GiB })).rejects.toThrow("unsafe_path");
  expect(() => readComputerDiskPool(root)).toThrow("computer_disk_pool_unavailable");
});
test("socket locality accepts only the owned real local Unix socket, never foreign, linked, writable or missing endpoints", () => {
  const client: PodmanClient = { remote: true, argv: ["--remote", "--url", "unix:///run/user/1001/podman/podman.sock"], env: {} };
  const stat = ((path: string) => ({ uid: path.startsWith("/run/user/1001") ? 1001 : 0, mode: path.endsWith(".sock") ? 0o660 : 0o700,
    isSocket: () => path.endsWith(".sock"), isDirectory: () => !path.endsWith(".sock"), isSymbolicLink: () => false })) as any;
  expect(localComputerPodman(client, 1001, stat)).toBe(true);
  expect(localComputerPodman(client, 1001, ((path: string) => ({ ...stat(path), ...(path === "/run/user" ? { mode: 0o1777 } : {}) })) as any)).toBe(true);
  expect(localComputerPodman(client, 1001, ((path: string) => ({ ...stat(path), ...(path === "/run/user/1001/podman" ? { mode: 0o1777 } : {}) })) as any)).toBe(false);
  for (const url of ["ssh://host/run/user/1001/podman/podman.sock", "tcp://localhost:1234", "unix:///run/user/1002/podman/podman.sock"]) {
    expect(localComputerPodman({ ...client, argv: ["--remote", "--url", url] }, 1001, stat)).toBe(false);
  }
  for (const change of [{ uid: 1002 }, { mode: 0o777 }, { isSymbolicLink: () => true }, { isSocket: () => false }]) {
    expect(localComputerPodman(client, 1001, ((path: string) => ({ ...stat(path), ...change })) as any)).toBe(false);
  }
  expect(localComputerPodman(client, 1001, (() => { throw Error(); }) as any)).toBe(false);
});


test("own Unix transport cannot certify a daemon on a different host or with a foreign/rootful identity", () => {
  const host = { os: "linux", hostname: "same-host", security: { rootless: true }, idMappings: { uidmap: [{ container_id: 0, host_id: 1001 }] } };
  expect(computerPodmanHostLocal(host, "same-host", 1001)).toBe(true);
  expect(computerPodmanHostLocal(host, "other-host", 1001)).toBe(false);
  expect(computerPodmanHostLocal(host, "same-host", 1002)).toBe(false);
  expect(computerPodmanHostLocal({ ...host, security: { rootless: false } }, "same-host", 1001)).toBe(false);
  expect(computerPodmanHostLocal(null, "same-host", 1001)).toBe(false);
});
