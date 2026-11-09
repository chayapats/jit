---
status: implemented for DESK16-01 (#410), first slice; deterministic evidence; guest desktop session, desktop-browser egress and live host evidence pending (#410 follow-up, #431)
date: 2026-11-08
scope: DESK16-01 (#410); S16-AC05/AC07; FR-02/10/14/15/18/21/35/36/38/40; NFR-01/06/07/11/12/14
---

# Watch and take over a working computer

## Context

S16-AC07 asks the owner to watch the working screen, take exclusive control, complete a protected-input step and hand control back with fresh generations. Agent input must be fenced throughout, and old frames or handles must never regain authority. Sensitive-site credentials stay in the protected browser (S15 BROW15, ADR 0079); trusted sites may keep their session in the working VM browser (S16-D09, ADR 0084). #442 still waits for "a trusted site works in the VM browser after one owner login", which needs this takeover.

The S15/S16 working VM had no display: QEMU ran with `-display none` and no display device, and work used only shell and file tools over SSH. The protected browser already has an owner takeover (`BrowserOwner.takeover/frame/input/handBack`, field-based, generation-checked) on the S15 Web pages.

## Options compared

1. **Rakazo (pinned `abf3c08`)**: the computer image runs Xvfb, fluxbox, Chromium, `x11vnc -viewonly` and websockify/noVNC inside the sandbox; the API seals a screen capability (Bot, computer, screen generation, control lease) and the web client embeds noVNC; human control is a lease that interactive VNC needs. The agent runs as an unprivileged user without escalation, so the in-sandbox VNC server is outside its reach.
2. **Guest VNC in the Jit working VM**: in Jit the agent has root in the VM (RT15-01 option B). A guest VNC server, its input path and its fencing would be under the agent's control; noVNC also adds an MPL-2.0 client and a WebSocket proxy.
3. **Host-side screen through QMP (chosen)**: QEMU owns the virtual display. Frames come from QMP `screendump` (PNG) and input goes through QMP `input-send-event` on the controller-only QMP socket that already exists. No display server, port or guest channel is added; fencing is enforced in the controller, before any event reaches QEMU.

Option 3 keeps Rakazo's product concept (watch, take control with a lease, generation-fenced capability, hand back) and is simpler and stronger for a root-controlled guest. Frames are polled (about 2 per second while the owner drives, under 1 per second while watching) instead of streamed; that is enough for a login or a confirmation step and needs no new dependency. Streaming can replace polling later behind the same contract.

## Decision

1. **Desktop profile** (`s15-runtime/v1` `desktop: true`, requires `computers`). Jit-created VMs start with `-device virtio-vga,xres=1280,yres=800` (`virtio-gpu-pci` on aarch64), `-device virtio-tablet-pci` and `-device virtio-keyboard-pci`; `-display none` stays. The headless argv is unchanged byte for byte, and `/proc` re-verification accepts either exact profile, so a VM that was already running headless keeps working and reports `vm_desktop_restart_required` until its next start (idle sleep makes that natural). The VM15-03 launcher accepts an optional sixth `start` word `desktop` and nothing else; an installed older launcher refuses it, so a separate-identity host needs the installer's launcher refresh before desktop starts (owner-host transition, CUT16-01).
2. **Host screen device** (`QemuVmManagement.screen()`, `src/s15/vm/screen.ts`). `unavailable()` reports `vm_desktop_unavailable`, `vm_not_running` or `vm_desktop_restart_required` from controller facts only. `capture()` runs one QMP `screendump` at a time into the VM's hypervisor directory, reads it once and always removes it before the capture settles (under VM15-03 the file belongs to the QEMU identity, so its launcher's `discard-frame <vm>` removes exactly `<vm>/screen.png`; a frame that cannot be removed fails the capture). `stop()` (also the idle stop) and the launcher's `start` remove any frame left behind, so a stopped VM keeps none, and accepts only a bounded PNG whose IHDR is 1280×800. `send()` maps one validated input to QMP events: absolute pointer moves, button press/release pairs, wheel buttons, and key press/release batches with qcodes. Text is limited to characters a US keyboard types; anything else is refused (`screen_text_unsupported`), never approximated.
3. **Exclusive control** (`s16-computer-screen/v1`, `ScreenControl`, protected VM journal tables `s16_screen_control`, `s16_screen_commands`, `s16_screen_events`). States are `agent`, `settling`, `owner` and `fenced`, and every transition (takeover, lease lapse, restart, hand-back) advances the generation:
   - Every working-VM operation holds an agent ticket from admission until it settled. `WorkingVmService` checks the ticket wherever it already checks session currency (before the claim, at dispatch, before start, before publish), so after a takeover no work operation is admitted, dispatched or published.
   - Takeover moves to `settling` while tickets of the earlier generation are open and to `owner` when the last one ends. Owner input is refused (`takeover_settling`) until then, so work and owner never hold a writable generation together.
   - Owner input names the generation and takeover id, is checked against the live row immediately before it is sent, and is serialized per computer. Hand-back first refuses new owner input, waits for the input being sent, then returns the screen to work under a new generation. An input still queued behind a hand-back is refused.
   - Owner control lasts 30 s per renewal; the client renews every 10 s. A lapsed lease or a controller restart while the owner held control becomes `fenced`: nobody writes until the owner takes control again or hands back. Work never regains the screen because a tab closed.
   - Idle release skips a computer that is not in `agent`.
   - Frames are served only for the current generation and are dropped if a transition happened during the capture (`stale_screen`).
   - Takeover and hand-back are idempotent per `requestId` (hash of the command, which holds no input). Input request ids are kept in memory for the current owner generation: a retry never sends twice, and a send whose outcome is unknown is refused (`screen_input_unknown`) instead of retried; no typed text, hash of it, or frame is written to the journal, history, memory or logs.
4. **Owner surface.** `GET /api/s16/client/computers/<vm>/screen` (state), `GET .../screen/frame?generation=N` (PNG, `private, no-store`, `nosniff`, CSP `default-src 'none'`), and `POST /api/s16/client/computers/screen/commands` with exact `s16-screen-command/v1` bodies (`takeover`, `renew`, `input`, `hand_back`), owner-authenticated with CSRF rechecked after the body. The Computers page gains "Watch screen" on running computers: live frame with a text alternative, take over / hand back / cancel, clicks, double and right clicks, wheel, a keyboard-capture region (Tab leaves it), a masked "type on the computer" field that clears after sending, and Enter/Tab/Esc/Backspace buttons. English and Thai copy.
5. **Lineage.** The screen view carries the computer's scope; a private computer's frames are its Bot's private data and the owner's. Frames are never given to a model in this slice: Schway's public tool results are text only, so an agent screenshot tool needs a Schway contract first (not added here).
6. **Protected browser stays separate.** Sensitive-site login keeps using the protected browser takeover (S15 `BrowserOwner`, ADR 0079): its frames and input never pass through the VM screen, and the VM screen never carries a protected-browser session.

## Consequences

- With `desktop` on, a Jit-created VM has a virtual GPU and input devices; the guest sees them as ordinary hardware. A text console is what the screen shows until a guest desktop session runs.
- While the owner holds a shared computer, every Bot's work on it pauses (`takeover_active`, which work treats like any refused VM operation). Private computers pause only their Bot.
- Residual: a process the work started earlier inside the guest (for example a detached background job) keeps running during takeover, and guest root can draw on or read its own screen. That is inherent to a root-controlled guest; it is why sensitive login stays in the protected browser. Freezing the work sessions' guest slices during takeover is a possible hardening.

## Pending (not delivered by this slice)

- Guest desktop session (X server on the virtual display, window manager, browser) and the desktop browser's egress: the VM proxy admits only per-session leases, so a desktop browser outside a work session needs a reviewed lease design before a trusted-site login can work in the VM. #442's remaining item depends on it.
- Live evidence on `jit-vm` (QEMU `screendump` and input on the real host, VM15-03 file permissions, restart into the desktop profile) belongs to LIVE16-01 (#431).
