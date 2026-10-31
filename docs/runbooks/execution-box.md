# Runbook: execution boxes on rootless Podman (EXE02)

Owner-executable checklist for box images, operator `execution` config and `jit ops box-doctor`
(`ops.execution_config/v1`, `ops.box_image/v1`, `ops.box_doctor/v1`). Build and plan run anywhere;
install and Podman setup on the Pi happen only in an owner-approved change window. Never paste tokens,
digests beyond the pinned image references, addresses or raw diagnostics into issues; attach only
sanitized summaries.

## 1. Install Podman (Ubuntu 24.04)

```sh
sudo apt install podman uidmap slirp4netns passt
```

- Create a dedicated non-root, non-login service identity (for example `jit`, shell `/usr/sbin/nologin`).
- Add subuid/subgid entries for the service user (for example in `/etc/subuid` and `/etc/subgid`):

```text
jit:100000:65536
```

- Verify `podman --version` is 4.4 or newer (`jit ops box-doctor` checks `podman-version>=4.4`).
- When the service user's home (and so its rootless container storage) lies under `/var/lib` (for example
  `/var/lib/jit`), create `/var/lib/cni` once as root (`sudo mkdir -p /var/lib/cni`). Podman 4.x otherwise mounts a
  tmpfs over `/var/lib` inside its rootless network namespace, which hides the user's network definitions there, and
  every box on `jit-box-internal` fails with `unable to find network with name or ID jit-box-internal` (observed on
  the Pi with Podman 4.9.3, 2026-10-28).

## 2. Enable lingering and the user API socket (OPS09, 2026-10-29)

```sh
sudo loginctl enable-linger <serviceUser>
# Replace 1001 with `id -u <serviceUser>`:
sudo systemctl start user@1001.service
sudo runuser -u <serviceUser> -- env XDG_RUNTIME_DIR=/run/user/1001 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus \
  systemctl --user enable --now podman.socket
sudo systemctl restart jit.service
```

- The service user needs a lingering user manager so rootless Podman and its networks survive logout.
- Re-check with `loginctl show-user <serviceUser>`.
- Installer/install/upgrade repeat socket enablement safely. Check the API as
  the identity with `podman --remote --url unix:///run/user/1001/podman/podman.sock info`.
- The installed unit selects `JIT_PODMAN_MODE=remote` and sets `XDG_RUNTIME_DIR`.
  Development defaults to local mode (`--remote=false`); choose either mode
  explicitly in a test/CLI environment. Remote failures never retry locally.
- Keep the API Unix-only and owned by the identity. Do not publish it, bind it
  into containers, add a rootful socket or expose container storage to Jit.

## 3. Build images

```sh
bun ops/box/build.ts --target base --tag 2026-10-28
bun ops/box/build.ts --target browser --tag 2026-10-28
```

- Each build prints `{ "image": "jit-box-<target>:<tag>", "digest": "sha256:..." }`.
- Copy the printed digests into the service config `execution.images` as
  `<name>@sha256:<hex>` (for example `jit-box-base@sha256:...` — use your registry
  or local name prefix plus the printed digest).
- Images are `ops.box_image/v1`: `base` is `debian:bookworm-slim` plus the fixed
  package set; `browser` adds Chromium, Xvfb and Thai fonts. Never use unpinned
  `latest` tags.

## 4. Configure `execution` in the service config

Add the `execution` block to `.local/service-config.json` (validated by `parseServiceConfig`):

```json
{
  "execution": {
    "directory": "/var/lib/jit/boxes",
    "secretsDirectory": "/var/lib/jit/box-secrets",
    "images": { "base": "jit-box-base@sha256:..." },
    "maxBoxes": 2,
    "memoryMb": 2048,
    "cpus": 2,
    "pidsLimit": 512,
    "idleMinutes": 30,
    "registryHosts": ["registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "proxy.golang.org", "crates.io"],
    "fullAllowed": false
  }
}
```

- `directory` and `secretsDirectory` must be absolute paths that do not equal,
  contain, or lie inside `stateDirectory`, `backupDirectory`, the ledger directory,
  `workingDirectory` or the releases directory, and must not contain each other.
- `images.base` (and optional `images.browser`) must be `<name>@sha256:<hex>`.
- `registryHosts` is the only egress allowlist for `workspace` boxes.
- Plan and install through the service package (`docs/runbooks/ops-service.md`):
  the unit renders `JIT_EXECUTION_*` / `JIT_BOX_*` variables and writable paths
  for both directories.

## 5. Run `jit ops box-doctor`

`box-doctor` reads the same `JIT_EXECUTION_*` / `JIT_BOX_*` environment the
supervised unit sets (see `serviceEnvironment`). The service config file alone
is not enough: run the command with the unit's environment, for example as the
service user with the installed unit's `Environment=` values exported, or from
a shell that already has those variables.

```sh
jit ops box-doctor
```

- Exit 0 only when all twelve local checks (thirteen in remote mode) pass; otherwise exit 1 with the failing check,
  its `detail` and its `nextAction`.
- The command never runs containers and never prints secrets; it only probes
  `podman --version`, `podman info`, `podman image exists`, `podman image inspect` and the two directories. The `sanitizer-image` check requires the rebuilt base image label `jit.sanitize.version=2`.

## 6. What `fullAllowed` means

- `fullAllowed: false` (default) keeps the `full` access level unavailable:
  widening to `full` is rejected until there is Pi resource evidence.
- Set it to `true` only after EXE06 opt-in evidence (real Podman run plus Pi
  resource measurements) is recorded. It is an operator decision, not a model
  decision, and only the owner widens access in Web.

## 7. Troubleshooting

| Check | Next action |
| --- | --- |
| `podman-installed` | `install-podman`: install Podman 4.4+ and put `podman` on `PATH`, then re-run install/upgrade. |
| `podman-api-socket` (remote mode) | The executable is present but the API is unreachable. Run the exact identity/UID-specific socket command in `nextAction`; restart Jit after repair. |
| `podman-version>=4.4` | `upgrade-podman-to-4.4`: upgrade Podman to 4.4 or newer. |
| `rootless` | `enable-rootless-podman`: run as the service user without `sudo`, add subuid/subgid entries. |
| `cgroup-v2` | `enable-cgroup-v2`: boot with cgroup v2 (unified hierarchy). |
| `controllers` | `enable-cgroup-controllers`: enable the `memory`, `cpu` and `pids` controllers. |
| `execution-configured` | `configure-execution-block`: set `directory`, `secretsDirectory` and `images` in the service config. |
| `image-base-present` | `build-box-images`: run `bun ops/box/build.ts --target base --tag <tag>` and pin the digest. |
| `sanitizer-image` | `rebuild-base-image-and-pin-digest`: rebuild base with Pillow/Poppler and `/opt/jit/sanitize`, then pin the new digest. |
| `image-browser-present` | `build-box-images`: run `bun ops/box/build.ts --target browser --tag <tag>` and pin the digest (skipped when not configured). |
| `execution-directory` | `create-execution-directory` / `chown-execution-directory` / `restrict-execution-directory`: create the directory, chown to the service uid, chmod 0700. |
| `secrets-directory` | `create-execution-directory` / `chown-execution-directory` / `restrict-execution-directory`: same as above for the secrets directory. |

## Runtime (EXE03)

Once configured, Jit creates one box per project on demand (`jit-box-<projectId>`) with the hardening of [execution-box-v1](../contracts/execution-box-v1.md); it never pulls an image (`--pull=never`), so pre-build and pin both targets. `workspace` boxes use the internal network `jit-box-internal`, which Jit creates on first use, and reach only the registries in `registryHosts` through Jit's proxy on that network's gateway. Idle boxes stop after `idleMinutes`; the workspace stays under `<directory>/<projectId>/workspace`.

Live evidence on the host (opt-in, not a release test):

```sh
bun ops/box/build.ts --target base --tag <tag>          # prints the digest
JIT_LIVE_PODMAN=1 JIT_LIVE_BOX_IMAGE=jit-box-base:<tag>@sha256:<digest> bun test tests/box-podman.live.test.ts
```

It checks the inspected mounts, zero capabilities, no Jit variable or path in the box, and that the internal network blocks `example.com` while the proxy allows `registry.npmjs.org`.

### Remote feature mapping (2026-10-29, #224)

| Feature | Installed service behavior |
| --- | --- |
| `create`, `run`, `start`, `inspect`, `rm`, `pull`, network/image queries | Same operation through `podman --remote --url unix:///run/user/<uid>/podman/podman.sock`. |
| `exec -i`, detached exec, MCP/CDP streams | Remote API stdin/stdout pipes, no TTY or inherited file descriptors. Sidecar secrets use `--env NAME` with values only in the client environment. |
| `cp` | Remote copy API; client-side files/streams, no host storage mount. Attachment copying continues through its confined runner. |
| Workspace/input/profile bind mounts | Paths belong to the API server host, which is the same machine/identity. Existing exact mount checks remain. Private service `/tmp` is not a shared bind source. |
| tmpfs, `--network none`, `--userns=keep-id:uid=…,gid=…` | Unchanged flags interpreted by the rootless server. Sanitizer output is still bounded stdout after cleanup. |
| `unshare --rootless-netns` (#163) | Local-only. Remote mode starts a separate pinned-base proxy container on internal + egress bridges, with both forwarding sysctls zero, no host mount/published port and existing CONNECT host/443 allowlist. Workspace boxes retain only their internal network. |
| API server environment | `--http-proxy=false` prevents implicit proxy environment inheritance for every container. |

The proxy adds a fixed 128 MiB / 0.5 CPU / 64 pid ceiling outside project box
capacity; the service removes it after drain or before replacing an orphan.
Its code is bundled for the base image's existing Node, so OPS09 needs no new
base-image digest. A different internal IP changes box environment labels and
recreates stale containers. Failure to establish the proxy refuses Workspace
execution; it never switches a box to an egress network.

### OPS09 live verification (2026-10-29)

Orchestrator/owner only, after merge, in the approved reference-host window.
Implementation tests never run these commands. Keep outputs/addresses/image
pins in ignored `.local` evidence; report only commit, OS/arch and pass/blocked.
Use the protected new build and normal owner-authorized `service upgrade`
procedure first. The actual service must have execution configured with a real
base digest and owner-enabled attachments before accepting all three features.

1. Run installed `service status` via `/opt/jit/current/src/main.ts` as above.
   Expect API `ready`. Inspect `systemctl cat jit.service` and
   `systemctl show jit.service -p NoNewPrivileges -p PrivateTmp -p ProtectSystem -p ProtectHome -p ProtectControlGroups -p ProtectKernelTunables -p RestrictSUIDSGID -p BindPaths -p ReadWritePaths -p InaccessiblePaths`.
   Check all template sandbox directives, remote environment, only the user
   socket directory/bus binds and default-storage exclusions. As the identity,
   `systemctl --user is-enabled podman.socket` and `is-active podman.socket`
   must succeed with its XDG/session-bus environment from §2.
2. Through the running service's Web, test built-in search, upload the tiny
   PNG/PDF fixtures and confirm sanitizer output/preview eligibility, then open
   an owner-authorized Workspace box and exercise runner + browser/CDP/MCP
   streams as configured. Confirm direct outbound HTTPS fails, a disallowed
   proxy host fails, and `registry.npmjs.org:443` succeeds. No access-level
   widening or approval is implied by this checklist.
3. For repeatable protocol/isolation probes under the same sandbox, prepare a
   reviewed, service-readable checkout at the tested HEAD with dependencies
   installed (the installed artifact omits tests). Stop Jit after draining;
   these probes share its service-owned proxy name. Use a **shared** disposable
   directory outside state/credentials, inside the configured execution path:

```sh
checkout=/opt/jit/ops09-checkout
service_uid="$(id -u jit)"
live_root="$(jq -r '.execution.directory' /etc/jit/service-config.json)/.ops09-live"
base_image="$(jq -r '.execution.images.base' /etc/jit/service-config.json)"
sudo install -d -o jit -g jit -m 0700 "$live_root"
sudo systemctl stop jit.service
sudo systemd-run --unit=jit-ops09-check --wait --pipe --collect --uid=jit --gid=jit \
  --property=NoNewPrivileges=true --property=PrivateTmp=true \
  --property=ProtectSystem=strict --property=ProtectHome=tmpfs \
  --property=ProtectKernelTunables=true --property=ProtectControlGroups=true \
  --property=RestrictSUIDSGID=true --property=UMask=0077 \
  --property=TasksMax=256 --property=LimitNOFILE=4096 \
  --property="BindPaths=/run/user/$service_uid/podman" \
  --property="ReadWritePaths=$live_root" \
  --property='InaccessiblePaths=-/var/lib/jit/.local/share/containers' \
  --setenv=HOME=/var/lib/jit --setenv="XDG_RUNTIME_DIR=/run/user/$service_uid" \
  --setenv=JIT_PODMAN_MODE=remote --setenv=JIT_SERVICE_USER=jit \
  --setenv=JIT_LIVE_PODMAN=1 --setenv=JIT_LIVE_SEARXNG=1 \
  --setenv="JIT_LIVE_BOX_IMAGE=$base_image" --setenv="JIT_LIVE_CONTAINER_ROOT=$live_root" \
  /opt/jit/bin/bun --no-env-file test "$checkout/tests/box-podman.live.test.ts" \
    "$checkout/tests/attachment-sanitizer.live.test.ts" "$checkout/tests/searxng.test.ts"
sudo systemctl start jit.service
```

   Record actual assertions/pass/blocked, not just process start. Restart Jit
   even if a probe fails. Inspect proxy topology/sysctls and confirm containers
   have no credential/state/socket mount. Remove only the reviewed disposable
   fixture directory after cleanup; retain no fixture content in public evidence.
4. On a disposable installation, stop the identity's user `podman.socket`
   **and** `podman.service` (the active API can outlive its listening unit).
   Web search, attachment and box readiness must say API unavailable, distinct
   from missing Podman. Run the displayed repair command and restart Jit;
   confirm recovery. Exercise absent Podman separately only on a disposable
   installation; ordinary chat must remain available. Never remove host
   packages on the production reference installation for this test.
5. Re-run install/upgrade's safe repair path as appropriate, then reboot in the
   owner's window. Confirm linger, user socket and all three features return
   under the actual unit. Stop and report any version/backend incompatibility;
   do not weaken system/container isolation to obtain a pass.


## Attachment sanitizer (ATT02)

The operator rebuilds the existing base image; no separate image is downloaded, no image is built in CI, and ATT02 does not depend on the installer under review. On the operator-approved host/window:

```sh
bun ops/box/build.ts --target base --tag <new-tag>
# Set execution.images.base / JIT_BOX_IMAGE_BASE to the actual new digest, then restart through the normal service workflow.
jit ops box-doctor
```

The base now includes `python3-pil`, `poppler-utils`, `/opt/jit/sanitize` and label `jit.sanitize.version=2`. The optional browser target inherits it; rebuild browser too when the operator wants matching targets. Never invent a published digest or reuse the prior digest for changed contents. The image is selected by the same base-image pin already used by execution boxes, so no extra installer image entry is required.

For opt-in acceptance on any disposable Linux x64/arm64 host with rootless Podman (never ordinary CI):

```sh
JIT_LIVE_PODMAN=1 JIT_LIVE_BOX_IMAGE=<base-name>@sha256:<real-digest> bun test tests/attachment-sanitizer.live.test.ts
```

Record tested commit, OS/architecture, memory, image digest and sanitized pass/fail only in ignored `.local` evidence. The test processes a tiny repository metadata/polyglot fixture in its own temporary directories. To extend evidence in that authorized window, use the bomb/huge/malformed fixtures from `tests/fixtures/attachments`, verify rejection, and inspect an active `jit-sanitize-*` container: network `none`, no added capabilities, non-root user, read-only root, only the private `/in` read-only bind mount, and `/out` tmpfs with its byte/inode caps. Confirm a deadline removes the container. Keep raw file content, installation paths, addresses and diagnostics out of issues.

The output tmpfs cap is 32 MiB + 64 KiB for images (4 inodes including root) or 2 MiB + 64 KiB for PDFs (3 inodes). It is fully included in the disk reservation and added to the parser cgroup memory/swap ceiling. Outputs return over a bounded length-prefixed stdout stream; no writable output bind mount reaches service disk. Host writes follow successful container cleanup only. Cleanup uncertainty quarantines work and its reservation until reset succeeds.

Runtime defaults are host-scaled memory `min(512, max(256, RAM/16))` MiB, up to 40 MP scaled with memory, 30 seconds and one parser at a time. PNG stays PNG, JPEG stays JPEG, WebP becomes PNG; model copies fit 2048 px. Images have a 16 MiB cap per derivative; PDFs produce at most 50 pages / 2 MiB UTF-8 text, never a rendered page. Attempt counts survive restart; two failed/interrupted attempts reject the file and remove its original when unshared.

Without a capable rootless runtime/rebuilt image, PNG/JPEG use metadata stripping only and are download-only; PDF/WebP upload is refused. No host image decoder is used by the service. `JIT_ATTACHMENTS` remains release-gated until ATT04 and ATT06 merge. ATT03 owns composer/preview serving; ATT04/ATT05/ATT07 must preserve the container/service/fallback eligibility rules in `docs/contracts/app-attachments-v1.md`.

Deterministic parser tests require local Python 3 with Pillow and Poppler (`python3-pil` and `poppler-utils` on Debian/Ubuntu), alongside the existing runner dependencies. They use generated fixture paths through the fake runtime, never Podman or live host files.

## S14 CODE14 registry and authenticated preload — opt-in Linux evidence, pending

These steps are for a later explicitly authorized disposable Linux x64/arm64 evidence session. They were **not run** for PR 276. Run neither live GitHub requests nor Podman in ordinary deterministic CI. Retain tested HEAD, kernel/Bun/Git/Podman versions, real pinned image digests and sanitized outcomes only in ignored `.local` evidence; credentials/addresses/raw diagnostics stay out of tracked files and PRs.

1. Follow `s14-bot-computer.md` to provision separate <=1 GiB dedicated ext4 workspace/profile filesystems for a disposable Bot, outside application/native/vault/backup paths. Use local rootless Podman, verified cgroup v2 delegation and pinned existing base/browser images. The base needs Git, Node, npm, curl and the runner (already in Containerfile); a Bun project additionally needs an operator-built, actually pinned image containing Bun. Do not invent a digest. S14 still refuses remote clients when local disk proof is unavailable.
2. In a fresh disposable `--s14` store, configure that Bot/resource ceiling and use authenticated POST `/api/s14/commands` with the usual session/CSRF/Origin envelope (see s14-foundation-http.md). Grant `{id,botId,url,baseCommit,registry:null}`, with a real full commit of a small disposable repository (<16 MiB full pack/bundle). Start coding with a registry install requirement. Require partial/unrun `coding_registry_scope_required` and zero registry runner dispatch. Source instructions claiming network permission must have no effect. Ordinary/model/research and protected-browser containers must inspect as `network=none`.
3. Use a new owner grant identity with `registry:{hosts:["registry.npmjs.org"]}`; queries/receipts must show it. Start a bounded install (for example `npm install` on a small disposable fixture with a harmless install script writing a workspace marker) with `network:'registry'`. Require that marker and actual exit/test evidence. Inspect while it runs: the check container has only that Bot's workspace mount; no profile, state, credentials, host home or socket. It joins exactly `jit-s14-<computerId>-registry-net`, created internal with DNS disabled. The named proxy alone joins that internal network and jit-registry-egress, has zero capabilities/forwarding, no published port/mount, non-root/read-only limits. The rootless gateway is not host-bindable (#163); the container proxy avoids that assumption. Verify /proc/net/route and /proc/net/ipv6_route inside the check namespace show no usable default route. A host routing table is insufficient evidence.
4. Under the same explicit scope, use bounded check commands to verify: `curl --proxytunnel --proxy "$HTTPS_PROXY" https://registry.npmjs.org/` reaches the allowed host; example.com:443, an IP literal, any port other than 443, and plain HTTP through the proxy refuse. Direct curl with all proxy variables unset/`--noproxy '*'` must fail, including a disposable pre-resolved IP supplied in the local evidence session. Check DNS/direct/raw-socket and alternate-network attempts too. Do not use real sensitive workspace data: allowed package requests **can exfiltrate** to an allowlisted registry. Package tools that ignore proxy variables must fail; no direct fallback is acceptable.
5. Stop/remove the proxy while a registry command is held, and separately revoke the repository at the dispatch barrier/during a harmless bounded wait. Require no new command after revocation, fenced late artifacts and no online fallback. After success, timeout, cancellation/revocation or setup failure, require absence of the check container, all its descendants, proxy and bridge. Simulate cleanup failure only in a disposable host session; it must fence the handle. Restart must remove orphan resources before reuse. Account for a component-sized ephemeral check plus the 128 MiB/0.5 CPU/64 PID proxy; `/run` is bounded at 128 MiB, `/tmp` at 64 MiB.
6. For private preload, create the resource first, then `git.connection.create`, and enter a disposable minimal GitHub credential only through write-only `git.connection.secret.set`. Start with explicit `connection:{id,revision}` and the pinned full commit. Require a strict bounded pack→bare-object verification→bundle→in-box clone/checkout, no host checkout/hooks/filters/submodules and no origin left in the workspace. Repeat a public repository with connection omitted: it must use the same broker with no Authorization header/credential fallback. Use malicious hook/filter/.gitmodules fixtures with harmless markers and verify none run on the host. Rotate/remove the connection during the read and require import refusal. Verify the sentinel absent from box environment/argv/config/remotes/files/bundles/logs/artifacts; never print an actual credential to collect evidence. Oversized/malformed/stalled response fixtures must fail at 16 MiB packed/bundle, 32 MiB decoded object stream or 60 seconds without import; reflected credential/Basic/base64 bytes inside compressed objects must also refuse. Larger full history, LFS and submodule population remain unsupported, not a reason for broader fetch/network authority.


7. Before any host Git object operation, provision a **separate disposable tmpfs** with total capacity <=128 MiB, private to the service UID and mode 0700; set `JIT_S14_GIT_SCRATCH` to its canonical path. Keep it separate from application/vault/native paths and outside all box mounts. Ensure util-linux `/usr/bin/prlimit` exists. Record `stat -f` filesystem type/capacity and sanitized `/proc/<Git/helper-pid>/limits`: hard/soft address space 268435456, file size 134217728 and core 0, inherited by index-pack/pack-objects/HTTPS helpers. HOME/TMPDIR and every mirror/temp file must stay on that finite tmpfs. Test missing launcher, non-tmpfs/oversized scratch and wrong ownership/permissions: require `git_resource_limits_required`, no object reader, no credentialed mutation and no host-shell/unlimited fallback. This broker cannot reuse the Bot's box for a credentialed push, and credentials never enter that box.
8. In the disposable Linux evidence harness, serve a complete <16 MiB pack containing a multi-GiB highly compressible blob, and separately feed the corresponding bundle into push import. Generate the pack with streaming compression in an independently capped producer; do not allocate the inflated object in the service or create it on an unbounded host disk. Keep valid pack checksum/framing. Observe the limits **before** index-pack/fetch/fsck starts; require bounded failure/settlement, no verified mirror/credential release/push, no host OOM and no writes outside the <=128 MiB scratch filesystem. Also exercise aggregate scratch exhaustion (many files), not only one large file. Repeat a small valid preload→coding→approved push control under the same real limits. Deterministic `s14-coding-git-limits.test.ts` uses an actual compressed pack fixture and fake enforcement gates; it does not establish this live Linux proof.
9. Exercise `--skip-worktree`, `--assume-unchanged` and hostile clean/smudge/attributes in the draft: a passing draft-only file must disappear in the raw fresh checkout and fail its real test. Repeat hidden mutations during checks and after approval at both export/final dispatch barriers. Require partial/null commit attribution or refused push, and zero remote mutation. A normal edit must pass checks in the fresh exact recorded commit, retain ignored dependencies only after rerunning the scoped install, and report/push that same full commit. Retain sanitized manifest/commit/diff hashes and outcomes, never credentials or private file content.

Record pass/fail and concrete blockers separately for each architecture. A passing fake transport, flags alone, or a public fixture does not prove authenticated live GitHub/Linux support. UI/UX acceptance remains the designated Opus handoff; these steps add no UI design or automatic activation.
