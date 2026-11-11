---
status: proposed for DESK16-01 (#410), second slice; for review before implementation
date: 2026-11-09
scope: DESK16-01 (#410); AUTH16-01 (#442) step 5; S16-AC07/AC11; FR-10/14/15/35/38/40; NFR-07/14
---

# A desktop and browser on the working computer, Rakazo-style

## Context

ADR 0090 (slice 1) gave the working VM a virtual screen, owner watch/takeover and fenced hand-back, but the guest
shows only a text console. Two things are pending (ADR 0090, "Pending"): a guest desktop session, and network egress
for a browser that runs outside a work session. Public-web egress itself is already wired: `startLocalVmControl` starts the proxy with
`publicWeb` on by default and `composeS15` uses that control for work-session leases (AUTH16-01, ADR 0084). What is
missing is a lease that exists outside a work session: the proxy hands out leases only per work session
(`VmRegistryProxy.lease`), so nothing in the guest can reach the web while no session runs. #442's "a trusted site
works in the VM browser after one owner login" needs both the desktop and that lease.

Champ chose on 2026-11-09 to follow Rakazo's model (pinned `abf3c08`) instead of the options offered (egress only
while the owner holds control, or per-site approval). What Rakazo does, read from its source and docs:

- Each computer runs one desktop (Xvfb, fluxbox, Chromium) with a persistent browser profile. Sites the user signs in
  to stay signed in (`docs/computer.md`; `docs/computer-runtime.md` keeps `.browser-profiles` login state).
- The browser has the public internet whenever the computer runs. `SANDBOX_COMPUTER_EGRESS=restricted` blocks the
  host, private/LAN ranges and cloud metadata, not public hosts (`docs/self-host-docker-computers.md`). Data leaving
  through a page or command is a recorded known gap (`SECURITY.md`, "Shell and browser").
- Takeover is a separate, exclusive control lease on the same screen; it does not change the network. The bot asks
  for it (`request_takeover`, "Needs you", then "I'm done" or "Skip") when a step needs the person.

## Decision

1. **One desktop session per desktop VM.** When the controller has the `desktop` opt-in, provisioning installs a
   fixed set of packages and a systemd unit `jit-desktop.service` in the guest: Xorg on the virtio display (the
   modesetting driver, 1280×800 to match the screen contract), fluxbox, and one Chromium window, all as an
   unprivileged guest user `jit-desktop` with no sudo. The profile lives in that user's home on the VM disk, so it
   survives stops and idle sleep and follows snapshot/restore like any other guest file. The unit restarts the
   browser if it exits. A headless controller installs nothing and is unchanged.
2. **The desktop browser gets a standing public-web lease while the VM runs.** On start (and on resume after idle
   sleep) the controller issues one proxy lease `desktop_<vm>_<random>` through the existing proxy, which already
   runs with `publicWeb` on: any public DNS name on 443 (CONNECT) or 80 (GET/HEAD) after the existing public-address
   check, nothing private, no registry disclosure lease, no injected upstream credential. The new code is the lease
   lifecycle outside a work session, not the public-web path, plus the host filter in decision 5. It is written over SSH to a root-owned `0640 root:jit-desktop` file the
   unit reads as its proxy setting. The lease is renewed while the VM runs and revoked on stop, idle sleep, restore
   and controller restart (a restarted controller issues a fresh one). Takeover does not touch it, as in Rakazo.
3. **Work sessions keep their own leases.** The desktop lease is separate, so revoking a work session never cuts the
   desktop, and the proxy log keeps the two apart (destination-only, as now).
4. **Agent use of the browser comes later.** This slice gives the owner a working browser on the screen; the agent
   still works through shell and files. Agent browser actions (CDP on guest loopback, reached through the work
   session) and an agent-raised "needs you" request are slice 3, each with its own contract.
5. **Sensitive sites stay in the protected browser.** Jit keeps one thing Rakazo does not have: banking, payment,
   primary email and identity providers sign in only in the protected browser (S15 BROW15, ADR 0079), because
   #442's acceptance says "a sensitive site never exposes its session to the VM" and guest root can read the
   desktop profile. The desktop browser is for public sites and sites the owner marks trusted (#442).
   Enforcement is in the proxy, not a promise: the desktop lease carries a host filter that refuses every host for
   which `websiteSensitiveOnly("https://" + host)` is true (identity providers, primary email, banking, payment,
   `login.`/`sso.`/`auth.`/`accounts.` hosts; `src/s15/browser/sites.ts`). It runs before DNS for every host on
   the lease, public-web and registry alike, and a refusal is logged as `denied` like any other. So when a trusted
   site sends the owner to a Google or Microsoft sign-in, the guest browser gets a proxy refusal and never shows the
   identity provider's page; credentials for those hosts cannot be typed into the guest. The screen panel then tells
   the owner to sign in to that site through the protected browser (the existing S15 BROW15 handoff). Work-session
   leases keep today's rules; the filter is new to the desktop lease only.
   Known limit, recorded as a residual: the list is a heuristic. An identity provider or bank on a host the list does
   not match is reachable from the guest. Adding hosts to the list is a one-line change and needs no ADR. Champ can
   drop this decision if he wants Rakazo's single browser, which removes the filter.
6. **Pinned browser.** Ubuntu 26.04 ships Chromium only as a snap, which needs snapd and store egress. Proposed:
   install a version-pinned Chromium build with a recorded SHA-256 for x86_64 and arm64 through the existing bounded
   provisioning lease, like the Docker install. The alternative is Firefox ESR from Mozilla's apt repository with
   its signing key pinned. Champ chose the pinned Chromium build on 2026-11-11.

## Consequences

- With `desktop` on, anything running in the guest can reach any public host, all the time the VM runs, through the
  desktop lease (guest root can read it). That matches Rakazo's known gap and ADR 0084's residual: private data the
  guest holds can leave through a public site; Jit-mediated paths (protected browser, connectors, effects broker)
  keep their disclosure gates. Hosts, private ranges and metadata stay unreachable.
- A trusted-site login made during takeover stays in the desktop profile, so the Bot's later work in the VM (and
  guest root) can use that session. That is what "trusted" means in #442; the owner is told so at the login handoff.
- Provisioning a desktop VM downloads more (Xorg, fluxbox, the browser) and the VM needs more memory; the desktop
  profile is sized and reported in the plan, not silently.
- Existing headless VMs are unchanged. Enabling `desktop` on an existing VM installs the session on its next start.

## Delivery and evidence

- Contract updates: `s15-working-vm-v1` (desktop session, desktop lease lifecycle), `s16-computer-screen-v1` (the
  screen now shows the desktop), ADR 0090 "Pending" and ADR 0084 (public web wired for the desktop lease).
- Tests: the proxy refuses private targets and admits public ones for the desktop lease; it refuses
  sensitive-only hosts (an identity provider, a `login.` host, a bank) on the desktop lease, before DNS, and logs
  them as `denied`, while a work-session lease is unchanged; revoke on stop, sleep,
  restore and restart; a work-session revoke leaves the desktop lease; provisioning steps are exact and absent for a
  headless controller; guest file mode and owner.
- Live evidence (real QEMU host, #431): the screen shows the browser, the owner signs in to a trusted fixture site,
  hands back, the session survives a stop/start.
