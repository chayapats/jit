#!/bin/sh
# ops.installer/v1. POSIX bootstrap; never enable tracing or echo child output.
set -eu
set +x
umask 077

step=arguments
next='use install.sh [--yes] [--uninstall] [--dry-run --root /absolute/disposable/root]'
scratch=
reported=false
# Invoked by the EXIT trap through finish.
# shellcheck disable=SC2329
cleanup() { if [ -n "$scratch" ]; then rm -rf -- "$scratch"; fi; }
failed() { reported=true; printf 'Failed at %s. Next: %s\n' "$step" "$next" >&2; exit 1; }
# Invoked by the POSIX shell EXIT trap.
# shellcheck disable=SC2329
finish() {
  status=$?
  cleanup
  if [ "$status" -ne 0 ] && [ "$reported" = false ]; then printf 'Failed at %s. Next: %s\n' "$step" "$next" >&2; fi
}
trap 'finish' EXIT
trap 'failed' HUP INT TERM

yes=false
uninstall=false
dry=false
root=/
source_dir=
release_url=https://github.com/chayapats/jit/releases/latest/download
while [ "$#" -gt 0 ]; do
  case "$1" in
    --yes) yes=true ;;
    --uninstall) uninstall=true ;;
    --dry-run) dry=true ;;
    --root) shift; [ "$#" -gt 0 ] || failed; root=$1 ;;
    --source) shift; [ "$#" -gt 0 ] || failed; source_dir=$1 ;;
    *) failed ;;
  esac
  shift
done
case "$root" in /*) ;; *) failed ;; esac
if [ "$dry" = true ]; then
  [ "$root" != / ] || failed
else
  [ "$root" = / ] || failed
fi
# Local releases and checkouts resolve alongside this script. In curl | sh, $0 is sh.
if [ -z "$source_dir" ] && [ -f "$0" ]; then
  candidate=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  if [ -f "$candidate/ops/package/installer/main.ts" ]; then source_dir=$candidate; fi
  if [ -f "$candidate/artifact/ops/package/installer/main.ts" ]; then source_dir=$candidate/artifact; fi
fi
if [ -z "$source_dir" ] && [ "$uninstall" = true ] && [ -f /opt/jit/current/ops/package/installer/main.ts ]; then source_dir=/opt/jit/current; fi
if [ -n "$source_dir" ]; then
  case "$source_dir" in /*) ;; *) failed ;; esac
  [ -f "$source_dir/ops/package/installer/main.ts" ] || failed
fi

step=detect-host
next='use 64-bit Linux x64/arm64 with systemd; install core dependencies manually on other distributions'
if [ "$dry" = true ]; then
  [ -n "$source_dir" ] && [ -f "$root/host.json" ] || failed
  bun=$(command -v bun) || failed
  "$bun" "$source_dir/ops/package/installer/main.ts" plan --root "$root" --dry-run true || failed
else
  [ "$(uname -s)" = Linux ] && [ "$(getconf LONG_BIT)" = 64 ] && [ -d /run/systemd/system ] || failed
  case "$(uname -m)" in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) failed ;; esac
  # Read os-release as data, never source a file as root.
  family=$(awk -F= '$1 == "ID" { gsub(/"/, "", $2); print $2 }' /etc/os-release)
  case "$family" in
    debian|ubuntu|linuxmint|pop) manager=apt-get ;;
    fedora|rhel|centos|rocky|almalinux) manager=dnf ;;
    *) manager=manual ;;
  esac
  ram_mb=$(awk '/^MemTotal:/ {print int($2/1024)}' /proc/meminfo)
  cpus=$(getconf _NPROCESSORS_ONLN)
  disk_path=/var/lib
  if [ -d /var/lib/jit/state ]; then disk_path=/var/lib/jit/state; fi
  disk_total=$(df -Pk "$disk_path" | awk 'NR==2 {printf "%.0f", $2*1024}')
  disk_free=$(df -Pk "$disk_path" | awk 'NR==2 {printf "%.0f", $4*1024}')
  for number in "$ram_mb" "$cpus" "$disk_total" "$disk_free"; do
    case "$number" in *[!0-9]*|'') failed ;; esac
  done
  reserve=$((disk_total / 50))
  if [ "$disk_total" -lt 21474836480 ]; then
    reserve=$((disk_total / 10)); [ "$reserve" -ge 268435456 ] || reserve=268435456
  else
    [ "$reserve" -ge 2147483648 ] || reserve=2147483648
    [ "$reserve" -le 17179869184 ] || reserve=17179869184
  fi
  printf 'Detected %s %s; RAM %s MiB; CPUs %s; disk %s bytes, free %s; reserve %s bytes.\n' "$family" "$arch" "$ram_mb" "$cpus" "$disk_total" "$disk_free" "$reserve"
  if [ "$uninstall" = false ]; then
    step=disk-reserve; next='free disk space above the displayed reserve plus 512 MiB staging space, then re-run'
    [ "$disk_free" -ge "$((reserve + 536870912))" ] || failed
  fi
fi

printf '%s\n' 'Plan (ops.installer/v1):'
if [ "$uninstall" = true ]; then
  printf '%s\n' '  Stop/disable Jit and its Secret Service; remove their units and journald config.' '  Retain identity, linger, packages, Bun, releases, config, data, backups, attachments and keyring/unlock file.'
else
  printf '%s\n' \
    '  Install core dependencies with apt/dnf, or verify them on other systemd distributions.' \
    '  Download SHA-256-pinned Bun 1.4.2 for this architecture to /opt/jit/bin/bun.' \
    '  Create/verify non-login jit identity with /var/lib/jit home; owner-only data/work/ledger/backups/keyring directories.' \
    '  Create <data>/attachments mode 0700 and check the hardware-scaled disk reserve (+512 MiB staging).' \
    '  Try Podman/uidmap/slirp4netns; allocate unused subuid/subgid ranges and create /var/lib/cni.' \
    '  Enable linger/user manager; install a Secret Service boot-unlock unit and random 0600 unlock file (preserve on re-run).' \
    '  Build/install sealed service artifact and dependencies; preserve existing config and data.' \
    '  Write /etc/jit/service-config.json: loopback:3000, Schway, Codex/Grok recommended models, Telegram disabled.' \
    '  Size service memory from RAM/3 (256 MiB..8 GiB), logs from disk/1000 (16..256 MiB); record RAM/CPU-sized box recommendations.' \
    '  Stop/repair/install/enable/start jit.service and bounded journald namespace; never run Jit as root.' \
    '  Initialize only a new database; schema-changing upgrades retain owner-authorized staged migration gates.' \
    '  Probe local health; optionally pre-pull only listed digest-pinned images and run box-doctor (never blocks chat).' \
    '  Issue a hashed, single-use 15-minute first-owner link; an existing owner receives the sign-in URL.'
  if [ -z "$source_dir" ]; then printf '  Download release artifact/checksum from %s.\n' "$release_url"; fi
fi
step=consent
next='re-run with --yes for unattended consent, or run from a terminal and approve the plan'
if [ "$yes" != true ]; then
  printf 'Apply this plan? [y/N] ' >&2
  # curl | sh owns stdin; /dev/tty keeps the approval distinct from the script input.
  if [ "$dry" = true ]; then read -r answer || failed
  else read -r answer </dev/tty || failed
  fi
  case "$answer" in y|Y|yes|YES) ;; *) printf '%s\n' 'Cancelled; no changes applied.'; exit 0 ;; esac
fi

if [ "$dry" = true ]; then
  if "$bun" "$source_dir/ops/package/installer/main.ts" apply --root "$root" --dry-run true --source "$source_dir" --uninstall "$uninstall"; then exit 0; fi
  reported=true; exit 1
fi

step=privileges
next='run the installer as root or provide sudo for the already displayed plan'
if [ "$(id -u)" != 0 ]; then
  # Re-exec a private copy after approval; no second installer prompt.
  if [ -f "$0" ]; then installer_script=$0
  else
    scratch=$(mktemp -d)
    installer_script=$scratch/install.sh
    # stdin is the remainder of a piped script, so fetch the complete bootstrap instead.
    curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 120 "$release_url/install.sh" -o "$installer_script" || failed
  fi
  set -- --yes
  if [ -n "$source_dir" ]; then set -- "$@" --source "$source_dir"; fi
  if [ "$uninstall" = true ]; then set -- "$@" --uninstall; fi
  sudo sh "$installer_script" "$@" || failed
  exit 0
fi
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
step=dependencies
next='restore package registry access, or install curl, unzip, CA certificates, util-linux, useradd, dbus user sessions and gnome-keyring; re-run'
if [ "$uninstall" = false ]; then
  case "$manager" in
    apt-get)
      timeout 600 env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || failed
      timeout 600 env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl unzip util-linux passwd dbus-user-session gnome-keyring libsecret-tools >/dev/null 2>&1 || failed
      if ! timeout 600 env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq podman uidmap slirp4netns >/dev/null 2>&1; then printf '%s\n' 'Optional Podman install unavailable; continuing chat-only if Podman is absent.'; fi ;;
    dnf)
      timeout 600 dnf install -y ca-certificates curl unzip util-linux shadow-utils dbus-daemon gnome-keyring libsecret >/dev/null 2>&1 || failed
      if ! timeout 600 dnf install -y podman shadow-utils-subid slirp4netns >/dev/null 2>&1; then printf '%s\n' 'Optional Podman install unavailable; continuing chat-only if Podman is absent.'; fi ;;
  esac
  for tool in curl unzip sha256sum tar runuser useradd getent loginctl systemctl busctl gnome-keyring-daemon; do command -v "$tool" >/dev/null || failed; done
fi
step='bun-runtime'
next='verify Bun release access and SHA-256 pins; re-run with a supported libc/architecture'
bun=/opt/jit/bin/bun
if [ "$uninstall" = false ]; then
  scratch=$(mktemp -d /var/tmp/jit-install.XXXXXXXX)
  chmod 755 "$scratch"
  case "$arch" in
    x64) asset='bun-linux-x64-baseline'; digest=c678040f14fe0440eb839d37cbd0ce4c051a32da72806ac97de6a6aab6bf728f ;;
    arm64) asset='bun-linux-aarch64'; digest=54328bbc2d9c8e0c9f892c544d66c57a83b84139e34909e5ee81758f1ac8fda7 ;;
  esac
  if ldd --version 2>&1 | awk 'BEGIN {found=0} /musl/ {found=1} END {exit !found}'; then
    case "$arch" in
      x64) asset='bun-linux-x64-musl-baseline'; digest=76e1db84e98f22f78de0a87e309bfbbf297732847f9720db36750646c85c8c18 ;;
      arm64) asset='bun-linux-aarch64-musl'; digest=71760b6c8ea30623b81a4907cb815d48e2ea266f2e73e751534a44a0607950df ;;
    esac
  fi
  curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 180 "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/$asset.zip" -o "$scratch/bun.zip" || failed
  printf '%s  %s\n' "$digest" "$scratch/bun.zip" | sha256sum -c - >/dev/null 2>&1 || failed
  unzip -q "$scratch/bun.zip" -d "$scratch" || failed
  install -d -m 755 /opt/jit /opt/jit/bin
  # Never truncate a binary in use by an existing service.
  install -m 755 "$scratch/$asset/bun" /opt/jit/bin/bun.new || failed
  mv -f /opt/jit/bin/bun.new "$bun" || failed
fi
[ "$("$bun" --version)" = 1.4.2 ] || failed

step=release
next='publish/verify jit-install.tar.gz and its SHA-256 sidecar, or run ./install.sh from a release tarball'
if [ -z "$source_dir" ]; then
  [ -n "$scratch" ] || scratch=$(mktemp -d /var/tmp/jit-install.XXXXXXXX)
  chmod 755 "$scratch"
  curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 180 "$release_url/jit-install.tar.gz" -o "$scratch/jit-install.tar.gz" || failed
  curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 120 "$release_url/jit-install.tar.gz.sha256" -o "$scratch/checksum" || failed
  digest=$(awk 'NR==1 {print $1}' "$scratch/checksum")
  [ "${#digest}" = 64 ] || failed
  case "$digest" in *[!a-f0-9]*) failed ;; esac
  printf '%s  %s\n' "$digest" "$scratch/jit-install.tar.gz" | sha256sum -c - >/dev/null 2>&1 || failed
  mkdir -m 755 "$scratch/release"
  (umask 022; tar -xzf "$scratch/jit-install.tar.gz" --no-same-owner --no-same-permissions -C "$scratch/release") || failed
  source_dir=$scratch/release/artifact
fi
if "$bun" "$source_dir/ops/package/installer/main.ts" apply --root / --source "$source_dir" --uninstall "$uninstall" --family "$family" --arch "$arch" --ram-mb "$ram_mb" --cpus "$cpus" --disk-total "$disk_total" --disk-free "$disk_free"; then exit 0; fi
reported=true; exit 1
