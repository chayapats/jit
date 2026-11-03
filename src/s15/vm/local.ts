import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, closeSync, constants, createReadStream, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statfsSync, writeSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { AppError } from "../../errors";
import { vmFail, vmInteger } from "./validation";

const GiB = 1_073_741_824, MiB = 1_048_576;

/** Owner-editable working-VM resources. They apply at the next protected VM start, never to a running guest. */
export interface LocalVmResources { cpus: number; memoryMiB: number; diskGiB: number }
/** Controller-side host facts used for default sizing. Guest output never contributes to them. */
export interface LocalVmHostFacts {
  architecture: "x86_64" | "aarch64" | null; kvm: boolean; qemu: boolean;
  cpus: number; memoryBytes: number; diskTotalBytes: number; diskFreeBytes: number;
}
/** The controller plus protected Chromium always keep at least this much; the VM gets at least the minimum. */
export const localVmControllerReserve = Object.freeze({ cpus: 2, memoryMiB: 6144 });
/** Smallest working VM Jit creates automatically, and the default sparse disk size. */
export const localVmMinimum = Object.freeze({ cpus: 1, memoryMiB: 2048, diskGiB: 20 });
export const localVmDefaultDiskGiB = 60;

/**
 * Installer disk reserve (`install.sh` rule): below 20 GiB total, 10% with a 256 MiB floor; otherwise 2%
 * clamped to 2–16 GiB. A working-VM disk must fit in free space minus this reserve.
 */
export function localVmDiskReserve(totalBytes: number): number {
  if (!Number.isSafeInteger(totalBytes) || totalBytes < 0) vmFail("vm_limit_invalid", 400);
  if (totalBytes < 20 * GiB) return Math.max(Math.floor(totalBytes / 10), 256 * MiB);
  return Math.min(Math.max(Math.floor(totalBytes / 50), 2 * GiB), 16 * GiB);
}

/**
 * Default working-VM sizing from controller-observed host facts: about half of the CPUs and about 45% of
 * RAM (rounded to whole GiB), clamped so the controller plus protected Chromium keep 2 vCPU and 6 GiB,
 * and a 60 GiB sparse qcow2 disk. Examples: 10 vCPU / 20 GiB gives 5 vCPU / 9 GiB; 4 vCPU / 8 GiB gives
 * 2 vCPU / 2 GiB. A host that cannot keep the reserve and still give 1 vCPU / 2 GiB is `vm_host_too_small`;
 * a disk that does not fit in free space minus the installer reserve is `vm_disk_insufficient`.
 */
export function defaultLocalVmResources(host: Pick<LocalVmHostFacts, "cpus" | "memoryBytes" | "diskTotalBytes" | "diskFreeBytes">): LocalVmResources {
  for (const value of [host.cpus, host.memoryBytes, host.diskTotalBytes]) vmInteger(value);
  vmInteger(host.diskFreeBytes, Number.MAX_SAFE_INTEGER, 0);
  const vcpus = Math.min(Math.floor(host.cpus / 2), host.cpus - localVmControllerReserve.cpus);
  const hostMiB = Math.floor(host.memoryBytes / MiB);
  const target = Math.round(host.memoryBytes * 0.45 / GiB) * 1024;
  const ceiling = Math.floor((hostMiB - localVmControllerReserve.memoryMiB) / 256) * 256;
  const memoryMiB = Math.min(target, ceiling);
  if (vcpus < localVmMinimum.cpus || memoryMiB < localVmMinimum.memoryMiB) vmFail("vm_host_too_small", 422);
  if (host.diskFreeBytes - localVmDiskReserve(host.diskTotalBytes) < localVmDefaultDiskGiB * GiB) vmFail("vm_disk_insufficient", 422);
  return { cpus: vcpus, memoryMiB, diskGiB: localVmDefaultDiskGiB };
}

/**
 * Validates an owner edit. CPUs stay within the host count, memory leaves at least 2 GiB to the controller
 * (multiples of 256 MiB), and disks only grow, within 2 TiB and the free space left after the installer reserve.
 * `appliedDiskGiB` is the size the image actually has; all outstanding growth beyond it must fit.
 */
export function validateLocalVmResources(host: Pick<LocalVmHostFacts, "cpus" | "memoryBytes" | "diskTotalBytes" | "diskFreeBytes">, value: unknown, current?: LocalVmResources, appliedDiskGiB?: number): LocalVmResources {
  if (!value || typeof value !== "object" || Array.isArray(value)) vmFail("vm_limit_invalid", 400);
  const r = value as Record<string, unknown>;
  if (Object.keys(r).sort().join() !== "cpus,diskGiB,memoryMiB") vmFail("vm_limit_invalid", 400);
  vmInteger(r.cpus, host.cpus); vmInteger(r.memoryMiB, Math.floor(host.memoryBytes / MiB) - 2048, localVmMinimum.memoryMiB);
  vmInteger(r.diskGiB, 2048, Math.max(localVmMinimum.diskGiB, current?.diskGiB ?? 0));
  if ((r.memoryMiB as number) % 256) vmFail("vm_limit_invalid", 400);
  // Growth is measured from the disk size actually applied to the image, so earlier pending (not yet applied)
  // edits cannot be stacked past the free space left after the reserve.
  const applied = appliedDiskGiB ?? current?.diskGiB ?? 0;
  const growth = ((r.diskGiB as number) - applied) * GiB;
  if (growth > 0 && host.diskFreeBytes - localVmDiskReserve(host.diskTotalBytes) < growth) vmFail("vm_disk_insufficient", 422);
  return { cpus: r.cpus as number, memoryMiB: r.memoryMiB as number, diskGiB: r.diskGiB as number };
}

/**
 * Host probe seam for deterministic tests. The default reads only controller-local facts. `platform` and
 * `exists` are optional so older probes keep working: an absent `platform` means Linux, an absent `exists`
 * reports an inaccessible `/dev/kvm` as missing rather than denied.
 */
export interface LocalVmHostProbe { arch(): string; kvm(): boolean; executable(path: string): boolean; readable(path: string): boolean; cpus(): number; memoryBytes(): number; disk(path: string): { total: number; free: number };
  platform?(): string; exists?(path: string): boolean }
export const localVmHostProbe: LocalVmHostProbe = {
  arch: () => process.arch, platform: () => process.platform, exists: path => existsSync(path),
  kvm: () => { if (process.platform !== "linux") return false; try { accessSync("/dev/kvm", constants.R_OK | constants.W_OK); return true; } catch { return false; } },
  executable: path => { try { accessSync(path, constants.X_OK); return true; } catch { return false; } },
  readable: path => { try { accessSync(path, constants.R_OK); return true; } catch { return false; } },
  cpus: () => cpus().length,
  memoryBytes: () => totalmem(),
  disk: path => { const fs = statfsSync(path); return { total: Number(fs.blocks) * Number(fs.bsize), free: Number(fs.bavail) * Number(fs.bsize) }; },
};
/** QEMU, image and seed tools required on the controller host; all come from distribution packages. */
export const localVmTools = Object.freeze({ x86_64: "/usr/bin/qemu-system-x86_64", aarch64: "/usr/bin/qemu-system-aarch64", img: "/usr/bin/qemu-img", seed: "/usr/bin/cloud-localds", nc: "/usr/bin/nc",
  /** UEFI firmware (Ubuntu `qemu-efi-aarch64`); x86_64 boots the cloud image with the default SeaBIOS. */
  aarch64Firmware: "/usr/share/qemu-efi-aarch64/QEMU_EFI.fd" });
/**
 * Detects whether this controller can run a Jit-managed nested KVM working VM: Linux, x86_64/aarch64,
 * an accessible `/dev/kvm` for this (non-root) service user, and the QEMU/seed tools. Without KVM,
 * setup falls back to the existing owner-supplied VM enrollment.
 */
export function detectLocalVmHost(directory: string, probe: LocalVmHostProbe = localVmHostProbe): LocalVmHostFacts {
  const arch = probe.arch(), architecture = arch === "x64" ? "x86_64" : arch === "arm64" ? "aarch64" : null;
  const disk = probe.disk(directory);
  const qemu = !!architecture && [localVmTools[architecture], localVmTools.img, localVmTools.seed, localVmTools.nc].every(path => probe.executable(path)) && (architecture !== "aarch64" || probe.readable(localVmTools.aarch64Firmware));
  return { architecture, kvm: probe.kvm(), qemu, cpus: probe.cpus(), memoryBytes: probe.memoryBytes(), diskTotalBytes: disk.total, diskFreeBytes: disk.free };
}

/** Stable host-capability refusal codes. Each names exactly one missing item and has owner-facing copy. */
export type LocalVmHostCode = "vm_host_unsupported" | "vm_kvm_unavailable" | "vm_kvm_denied" | "vm_qemu_missing" | "vm_host_too_small" | "vm_disk_insufficient";
/**
 * Typed host-capability projection for automatic setup. `ready` carries the default sizing that setup will
 * use; `missing` names the first missing item in a fixed order (platform/architecture, KVM device, KVM access
 * for this service user, QEMU tools, CPU/RAM, disk). Facts are controller-side observations only.
 */
export type LocalVmHostReadiness =
  | { state: "ready"; facts: LocalVmHostFacts; resources: LocalVmResources }
  | { state: "missing"; code: LocalVmHostCode; facts: LocalVmHostFacts | null };
/**
 * Protected host-capability probe (SETUP15-01). It observes `/dev/kvm` access for the service identity, the
 * QEMU/seed tools, CPU, RAM and free disk; it never infers readiness from configuration. A usable `/dev/kvm`
 * is the CPU-virtualization evidence (on a VM host it also proves nested virtualization is on).
 */
export function probeLocalVmHost(directory: string, probe: LocalVmHostProbe = localVmHostProbe): LocalVmHostReadiness {
  if ((probe.platform?.() ?? "linux") !== "linux") return { state: "missing", code: "vm_host_unsupported", facts: null };
  let facts: LocalVmHostFacts;
  try { facts = detectLocalVmHost(directory, probe); } catch { return { state: "missing", code: "vm_host_unsupported", facts: null }; }
  if (!facts.architecture) return { state: "missing", code: "vm_host_unsupported", facts };
  if (!facts.kvm) return { state: "missing", code: probe.exists?.("/dev/kvm") ? "vm_kvm_denied" : "vm_kvm_unavailable", facts };
  if (!facts.qemu) return { state: "missing", code: "vm_qemu_missing", facts };
  try { return { state: "ready", facts, resources: defaultLocalVmResources(facts) }; }
  catch (error) { return { state: "missing", code: error instanceof AppError && error.code === "vm_disk_insufficient" ? "vm_disk_insufficient" : "vm_host_too_small", facts }; }
}

/** One pinned Ubuntu LTS cloud image. The dated release path is immutable; the pinned SHA-256 is the trust root. */
export interface LocalVmImage { id: string; architecture: "x86_64" | "aarch64"; url: string; sha256: string; maxBytes: number; os: string }
/**
 * Ubuntu 26.04 LTS `release-20261016` cloud images. Hashes were taken from the GPG-verified
 * (`UEC Image Automatic Signing Key`) `SHA256SUMS` of that release and cross-checked from two hosts.
 * Plain `amd64` (not `amd64v3`) is required because reference hosts may lack AVX2.
 */
export const localVmImages: Readonly<Record<"x86_64" | "aarch64", LocalVmImage>> = Object.freeze({
  x86_64: Object.freeze({ id: "ubuntu-26.04-20261016-amd64", architecture: "x86_64", os: "ubuntu:26.04", maxBytes: 2 * GiB,
    url: "https://cloud-images.ubuntu.com/releases/resolute/release-20261016/ubuntu-26.04-server-cloudimg-amd64.img",
    sha256: "5645d0318ad21f643ebb1ac4567514620e9893380b07b0201fda163baa5b7eb5" }),
  aarch64: Object.freeze({ id: "ubuntu-26.04-20261016-arm64", architecture: "aarch64", os: "ubuntu:26.04", maxBytes: 2 * GiB,
    url: "https://cloud-images.ubuntu.com/releases/resolute/release-20261016/ubuntu-26.04-server-cloudimg-arm64.img",
    sha256: "8eb876c2ccc4b6ff89e4a65d511815923b285e04503ba465809bf587f763da24" }),
}) as Readonly<Record<"x86_64" | "aarch64", LocalVmImage>>;

/** Protected bounded HTTPS download seam. It writes only `file`; verification is separate and mandatory. */
export type LocalVmDownload = (url: string, file: string, options: { maxBytes: number; signal?: AbortSignal }) => Promise<void>;
/** Default protected image download: HTTPS only, no redirects, no credentials, finite size and time. */
export const localVmDownload: LocalVmDownload = async (url, file, options) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) vmFail("vm_image_unverified");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(1_800_000)]) : AbortSignal.timeout(1_800_000);
  let response: Response;
  try { response = await fetch(url, { redirect: "error", signal, headers: { "Accept-Encoding": "identity", "User-Agent": "Jit-vm-image/1" } }); }
  catch { vmFail("vm_image_unavailable", 503); }
  if (!response.ok || !response.body) vmFail("vm_image_unavailable", 503);
  const fd = openSync(file, "wx", 0o600); let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length; if (total > options.maxBytes) vmFail("vm_image_unverified");
      for (let offset = 0; offset < chunk.length;) offset += writeSync(fd, chunk, offset);
    }
    fsyncSync(fd);
  } finally { closeSync(fd); }
};

/** Streams a file through SHA-256 on the controller. */
export function localVmFileHash(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256"), stream = createReadStream(file);
    stream.on("data", chunk => hash.update(chunk)); stream.on("error", reject); stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Returns the read-only verified base image path, downloading it once. A cached or downloaded image whose
 * SHA-256 differs from the pin is deleted and refused with `vm_image_unverified`; there is no fallback.
 */
export async function ensureLocalVmImage(directory: string, image: LocalVmImage, download: LocalVmDownload = localVmDownload, signal?: AbortSignal, progress?: (step: "download" | "checksum") => void, guard: () => void = () => {}): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(image.sha256)) vmFail("vm_image_unverified");
  const images = join(directory, "images"); mkdirSync(images, { recursive: true, mode: 0o700 });
  const stat = lstatSync(images); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) vmFail("vm_key_directory_unsafe");
  const file = join(images, `${image.sha256}.qcow2`);
  const cached = lstatSync(file, { throwIfNoEntry: false });
  if (cached) {
    progress?.("checksum");
    if (cached.isFile() && !cached.isSymbolicLink() && await localVmFileHash(file) === image.sha256) { chmodSync(file, 0o400); return file; }
    guard(); rmSync(file, { force: true });
  }
  // A partial download left by a controller crash never held verified bytes; only this exact prefix is removed.
  guard();
  for (const name of readdirSync(images)) if (/^\.partial-[a-f0-9]{16}$/.test(name) && lstatSync(join(images, name)).isFile()) rmSync(join(images, name), { force: true });
  const partial = join(images, `.partial-${randomBytes(8).toString("hex")}`);
  try {
    progress?.("download"); guard();
    try { await download(image.url, partial, { maxBytes: image.maxBytes, ...(signal ? { signal } : {}) }); }
    catch (error) { if (error instanceof AppError) throw error; vmFail("vm_image_unavailable", 503); }
    progress?.("checksum");
    if (!existsSync(partial) || await localVmFileHash(partial) !== image.sha256) vmFail("vm_image_unverified");
    guard(); chmodSync(partial, 0o400); renameSync(partial, file);
    return file;
  } finally { rmSync(partial, { force: true }); }
}
