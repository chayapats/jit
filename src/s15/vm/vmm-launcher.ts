import { localVmTools } from "./local";
import { qemuArgv } from "./qemu";
import { validateVmm, vmmLayout, type QemuVmmOptions } from "./vmm";

/** Absolute host tools the launcher runs. Production uses the distribution paths; tests substitute recorders. */
export interface VmmLauncherTools { systemctl: string; systemdRun: string; qemuImg: string }
export const vmmLauncherTools: Readonly<VmmLauncherTools> = Object.freeze({ systemctl: "/usr/bin/systemctl", systemdRun: "/usr/bin/systemd-run", qemuImg: localVmTools.img });

const hex = (count: number) => "[0-9a-f]".repeat(count);
const literal = (value: string) => {
  if (!/^[A-Za-z0-9 ._/:,=+@-]*$/.test(value)) throw new Error("vmm_launcher_unsafe_literal");
  return value ? `'${value}'` : "";
};
const tokens = { NAME: "name", CPUS: "cpus", MEMORY: "memory", MAC: "mac", PORT: "port" } as const;

/**
 * The QEMU argv for one architecture as shell words, derived from `qemuArgv` itself with placeholder values,
 * so the launcher and the controller's `/proc` re-verification can never disagree on the restricted profile.
 */
function qemuWords(vmm: QemuVmmOptions, architecture: "x86_64" | "aarch64", desktop = false): string {
  const layout = vmmLayout(vmm.directory);
  const argv = qemuArgv({ name: "@@NAME@@", architecture, machineDirectory: `${layout.machines}/@@NAME@@`, cpus: "@@CPUS@@" as unknown as number,
    memoryMiB: "@@MEMORY@@" as unknown as number, mac: "@@MAC@@", sshPort: "@@PORT@@" as unknown as number, proxySocket: layout.proxySocket, ...(desktop ? { desktop } : {}) });
  return argv.map(arg => arg.split(/(@@[A-Z]+@@)/).map(part => {
    const token = /^@@([A-Z]+)@@$/.exec(part)?.[1] as keyof typeof tokens | undefined;
    if (token) { if (!tokens[token]) throw new Error("vmm_launcher_unknown_token"); return `"$${tokens[token]}"`; }
    if (part.includes("@@")) throw new Error("vmm_launcher_unknown_token");
    return literal(part);
  }).join("")).join(" \\\n        ");
}

/**
 * Renders the root-owned launcher (`QemuVmmOptions.launcher`) that the installer installs mode 0755 and the
 * sudoers rule names. It runs only as the QEMU identity, sets that identity's own user-manager runtime directory,
 * refuses any unknown operation or argument (exit 64, nothing run), and runs one fixed command per operation:
 * `check` (prints `jit-vmm-ready-v1`; the installer's end-to-end sudo probe), `kvm` (device access probe), `show|stop|kill <vm>` (its transient unit), `info <vm> shared|exclusive`,
 * `resize <vm> <GiB>`, `create <vm> <base sha256> <GiB>`, `snapshot <vm> create|apply|delete <tag>`,
 * `seed <vm>` (the NoCloud seed from stdin, at most 16 MiB), `remove <vm>` (that VM's machine directory) and
 * `start <vm> <arch> <cpus> <MiB> <mac> <ssh port>` (QEMU in a transient user unit, UMask 0007 so only the
 * shared group reaches its QMP socket). It reads no environment input and accepts no path, flag or command.
 */
export function renderVmmLauncher(vmm: QemuVmmOptions, tools: VmmLauncherTools = vmmLauncherTools): string {
  validateVmm(vmm);
  const layout = vmmLayout(vmm.directory);
  for (const path of [tools.systemctl, tools.systemdRun, tools.qemuImg]) literal(path);
  const t = { systemctl: literal(tools.systemctl), run: literal(tools.systemdRun), img: literal(tools.qemuImg) };
  const unit = `${t.run} --user --quiet --collect --unit="$unit" --property=Type=exec --property=TimeoutStopSec=15 --property=UMask=0007 --`;
  return `#!/bin/sh
# Jit S15 working-VM launcher (VM15-03). Rendered and installed by install.sh --s15; do not edit.
# Runs only as ${vmm.user} through the controller's sudoers rule. Every argument is validated and QEMU's
# argv is fixed here; no environment, path, flag or command is accepted from the caller.
set -eu
umask 027
PATH=/usr/bin:/bin
LANG=C
export PATH LANG
refuse() { printf '%s\\n' 'jit-vmm: refused' >&2; exit 64; }
[ "$(id -un)" = ${literal(vmm.user)} ] || refuse
XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR
unset DBUS_SESSION_BUS_ADDRESS
nat() { case "$1" in ''|0*|*[!0-9]*) return 1 ;; esac; [ "\${#1}" -le "$2" ]; }
[ "$#" -ge 1 ] || refuse
op=$1
shift
if [ "$op" = check ]; then
  [ "$#" -eq 0 ] || refuse
  printf '%s\n' 'jit-vmm-ready-v1'
  exit 0
fi
if [ "$op" = kvm ]; then
  [ "$#" -eq 0 ] || refuse
  [ -r /dev/kvm ] && [ -w /dev/kvm ]
  exit
fi
[ "$#" -ge 1 ] || refuse
name=$1
shift
case "$name" in jit-work-${hex(12)}) ;; *) refuse ;; esac
dir=${literal(layout.machines)}/"$name"
disk="$dir/disk.qcow2"
unit="$name.service"
# umask 027 gives 0750; the setgid machines/ parent passes on its group and setgid bit (no special mode is set
# here: the controller unit's RestrictSUIDSGID also covers this sudo child).
prepare() { [ -d "$dir" ] || mkdir -- "$dir"; }
case "$op" in
  show)
    [ "$#" -eq 0 ] || refuse
    exec ${t.systemctl} --user show "$unit" --property=LoadState --property=ActiveState --property=MainPID ;;
  stop)
    [ "$#" -eq 0 ] || refuse
    exec ${t.systemctl} --user stop "$unit" ;;
  kill)
    [ "$#" -eq 0 ] || refuse
    exec ${t.systemctl} --user kill --signal=SIGKILL "$unit" ;;
  info)
    [ "$#" -eq 1 ] || refuse
    case "$1" in
      shared) exec ${t.img} info --force-share --output=json "$disk" ;;
      exclusive) exec ${t.img} info --output=json "$disk" ;;
      *) refuse ;;
    esac ;;
  resize)
    [ "$#" -eq 1 ] && nat "$1" 4 || refuse
    exec ${t.img} resize "$disk" "$1G" ;;
  create)
    [ "$#" -eq 2 ] && nat "$2" 4 || refuse
    case "$1" in ${hex(64)}) ;; *) refuse ;; esac
    prepare
    exec ${t.img} create -q -f qcow2 -F qcow2 -b ${literal(layout.images)}/"$1".qcow2 "$disk" "$2G" ;;
  snapshot)
    [ "$#" -eq 2 ] || refuse
    case "$2" in jit-${hex(32)}) ;; *) refuse ;; esac
    case "$1" in create) flag=-c ;; apply) flag=-a ;; delete) flag=-d ;; *) refuse ;; esac
    exec ${t.img} snapshot "$flag" "$2" "$disk" ;;
  seed)
    [ "$#" -eq 0 ] || refuse
    prepare
    part="$dir/.seed.$$"
    rm -f -- "$part"
    head -c 16777217 > "$part"
    size=$(($(wc -c < "$part")))
    if [ "$size" -lt 1 ] || [ "$size" -gt 16777216 ]; then rm -f -- "$part"; refuse; fi
    mv -f -- "$part" "$dir/seed.img" ;;
  remove)
    [ "$#" -eq 0 ] || refuse
    rm -rf -- "$dir" ;;
  start)
    # A sixth word selects the DESK16-01 desktop profile; nothing else is accepted there.
    [ "$#" -eq 5 ] || { [ "$#" -eq 6 ] && [ "$6" = desktop ]; } || refuse
    arch=$1 cpus=$2 memory=$3 mac=$4 port=$5 profile=headless
    if [ "$#" -eq 6 ]; then profile=desktop; fi
    nat "$cpus" 3 && nat "$memory" 7 && nat "$port" 5 || refuse
    [ "$port" -ge 1024 ] && [ "$port" -le 65535 ] || refuse
    case "$mac" in 52:54:00:${hex(2)}:${hex(2)}:${hex(2)}) ;; *) refuse ;; esac
    rm -f -- "$dir/qmp.sock"
    case "$arch:$profile" in
      x86_64:headless) exec ${unit} \\
        ${qemuWords(vmm, "x86_64")} ;;
      aarch64:headless) exec ${unit} \\
        ${qemuWords(vmm, "aarch64")} ;;
      x86_64:desktop) exec ${unit} \\
        ${qemuWords(vmm, "x86_64", true)} ;;
      aarch64:desktop) exec ${unit} \\
        ${qemuWords(vmm, "aarch64", true)} ;;
      *) refuse ;;
    esac ;;
  *) refuse ;;
esac
`;
}
