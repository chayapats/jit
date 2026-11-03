import { join, resolve } from "node:path";
import { localVmHostProbe, type LocalVmHostProbe } from "./local";
import { vmFail } from "./validation";

/**
 * Separate unprivileged QEMU identity (VM15-03). With it, every hypervisor-side host command (the transient QEMU
 * unit in this identity's lingering user manager, unit state/stop/kill, and `qemu-img` on the VM disk) runs as
 * `user` through one fixed argv prefix: `sudo -n -u <user> -- <launcher> <operation> ...`. The launcher is a
 * root-owned script that validates every argument and builds QEMU's argv itself, and the installer's sudoers
 * rule lets the controller run only that launcher as `user`. The controller keeps all management authority
 * (start/stop/snapshot/restore/inspect, the SSH client key, the registry proxy) and its own files stay
 * unreadable to `user`. Absent, QEMU runs as the controller identity exactly as before.
 */
export interface QemuVmmOptions {
  /** Unprivileged identity that owns the QEMU process, the VM disk and seed; never the controller. */
  user: string;
  /** Its numeric uid; a running QEMU counts as this VM's only when the kernel reports this uid. */
  uid: number;
  /** Root-owned hypervisor root shared through one group (layout in `vmmLayout`). */
  directory: string;
  /** Root-owned, argument-validating launcher the controller may run as `user` (sudoers, fixed path). */
  launcher: string;
}

/**
 * Shared hypervisor layout under `QemuVmmOptions.directory` (root-owned, group = the shared VM group, 0750):
 * `control/` is controller-owned (setgid, group-readable): verified base images and the registry-proxy socket
 * (0660, so only the shared group, i.e. the QEMU identity, can connect besides the controller). `machines/` is
 * owned by the QEMU identity (setgid, group-readable): one directory per VM with its overlay, seed and QMP socket.
 * Neither identity can rename the other's tree. The SSH client key, known_hosts and VM state stay in the
 * controller's private local-VM directory.
 */
export function vmmLayout(directory: string): { control: string; images: string; proxySocket: string; machines: string } {
  const control = join(directory, "control");
  return { control, images: join(control, "images"), proxySocket: join(control, "proxy.sock"), machines: join(directory, "machines") };
}

const safePath = (path: string, max: number) => typeof path === "string" && path.length <= max && path.startsWith("/") && resolve(path) === path && /^\/[A-Za-z0-9._/-]+$/.test(path);
/** Longest hypervisor root, so `<root>/machines/jit-work-<12 hex>/qmp.sock` fits `sun_path`. */
export const vmmDirectoryMax = 64;

/** Validates trusted composition input; malformed identities or paths are a setup error, never a fallback. */
export function validateVmm(vmm: QemuVmmOptions): QemuVmmOptions {
  if (!vmm || typeof vmm !== "object" || Object.keys(vmm).sort().join() !== "directory,launcher,uid,user") vmFail("vm_invalid_setup");
  if (typeof vmm.user !== "string" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(vmm.user) || !Number.isSafeInteger(vmm.uid) || vmm.uid < 1 || vmm.uid > 4294967294 ||
      !safePath(vmm.directory, vmmDirectoryMax) || !safePath(vmm.launcher, 256)) vmFail("vm_invalid_setup");
  return vmm;
}

/** The fixed privilege-transition prefix. `sudo -n` never prompts; the sudoers rule names only the launcher. */
export function vmmCommand(vmm: QemuVmmOptions, args: readonly string[]): string[] {
  return ["/usr/bin/sudo", "-n", "-u", vmm.user, "--", vmm.launcher, ...args];
}

/**
 * Host probe for a controller whose QEMU runs as the separate identity: `/dev/kvm` access is that identity's
 * (`launcher kvm`), never the controller's, which deliberately has none. Other facts are controller-side
 * observations. The answer is cached briefly because readiness is read on every Web card render.
 */
export function vmmHostProbe(vmm: QemuVmmOptions, base: LocalVmHostProbe = localVmHostProbe,
  spawn: (argv: string[]) => number = argv => { try { return Bun.spawnSync(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: { PATH: "/usr/bin:/bin" }, timeout: 10_000 }).exitCode ?? 1; } catch { return 1; } },
  now: () => number = Date.now): LocalVmHostProbe {
  validateVmm(vmm);
  let cached: { at: number; kvm: boolean } | null = null;
  return { ...base, kvm: () => {
    if ((base.platform?.() ?? process.platform) !== "linux") return false;
    if (!cached || now() - cached.at > 5000) cached = { at: now(), kvm: spawn(vmmCommand(vmm, ["kvm"])) === 0 };
    return cached.kvm;
  } };
}
