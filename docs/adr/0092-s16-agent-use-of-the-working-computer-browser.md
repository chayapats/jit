---
status: proposed for DESK16-01 (#410), third slice; closes AUTH16-01 (#442)'s last acceptance item once implemented; live host evidence belongs to #431
date: 2026-11-12
scope: DESK16-01 (#410); AUTH16-01 (#442); S16-AC06/AC07/AC11; FR-10/14/15/35/38/40; NFR-07/14
---

# The Bot uses the working computer's browser, and asks for you when it needs a sign-in

## Context

ADR 0090 gave the owner a watched, fenced screen on the working VM. ADR 0091 put a desktop session with a pinned
Chromium on it, a public-web desktop lease, and a proxy filter that keeps sensitive-only hosts out of the guest. Its
decision 4 left two things for this slice: the Bot using that browser, and the Bot asking the owner for help ("needs
you"). Decision 4 sketched the first as "CDP on guest loopback, reached through the work session". This ADR replaces
that line: there is no loopback debugging port (decision 1), and the controller does not use the work session's
one-shot channel (decision 2).

#442 still waits for one acceptance item: "a trusted site works in the VM browser after one owner login". Today the
owner can sign in to a trusted site on the screen and the session survives stop/start, but the Bot cannot use it:
the protected browser refuses a trusted site with `website_trusted_vm` (`src/s15/browser/sites.ts`), and the Bot has
no browser tool in the VM, only shell and files. ADR 0084 already says that for trusted sites the human-required list
is applied "by tool policy and Bot instructions", not bypass-resistantly. That tool policy does not exist yet.

## Options compared

1. **Screen-level agent (Rakazo `computer_act`).** The Bot sees screenshots and sends pointer/keyboard input through
   the QMP screen device. Works on any app, but needs image tool results, which Schway's public tool results do not
   carry (ADR 0090 decision 5), and gives Jit nothing to classify a submit or payment click with.
2. **Guest browser automation run by the Bot itself.** The Bot installs Playwright or similar in the VM and drives a
   second Chromium. The owner's sign-in lives in the desktop profile, which a second instance cannot open while the
   desktop browser holds it, and Jit sees only shell commands, so no tool policy is possible.
3. **CDP to the desktop Chromium, through a fixed relay and a dedicated SSH stream (proposed).** The desktop session
   starts Chromium with `--remote-debugging-pipe` behind a small fixed relay. The controller opens its own long-lived
   SSH stream to the relay (not the work session's one-shot `invoke`/`control` channel, which reads all stdin and
   returns one JSON after exit) and talks to it with the existing `CdpClient` framing (`jit.box.cdp-stream/v1`:
   NUL-terminated JSON, bounded messages and deadlines). The Bot gets a closed operation union, like
   `protected_browser`, on the same browser window the owner watches. Jit classifies each action before dispatch.

Option 3 reuses parts Jit already has (CDP client, the protected browser's operation union and secret-field rules,
ScreenControl tickets). The owner sees the Bot work on the screen, as in Rakazo.

## Decision (proposed)

1. **Debugging pipe, no port; the relay is the session loop body.** The session script's browser loop
   (`while :; do … sleep 2; done`, `qemu.ts`) runs `/usr/local/lib/jit-desktop/cdp-relay` instead of Chromium
   directly. The relay is fixed Python, installed with the session. It starts Chromium as its child with
   `--remote-debugging-pipe`, keeping the existing flags, and bridges the child's pipe descriptors 3/4 to one Unix
   socket, `/run/jit-desktop/cdp.sock`.
   - **Socket only, no VT.** The relay's stdin is `/dev/null`. It never reads the unit's tty (`StandardInput=tty` stays
     for xinit), and has no TCP listener. No debugging port is opened, so page content and other guest users cannot
     reach DevTools over loopback.
   - **Directory.** `jit-desktop` cannot create `/run/jit-desktop`. Root does it: the unit gains
     `ExecStartPre=+/usr/bin/install -d -m 0700 -o jit-desktop -g jit-desktop /run/jit-desktop`, next to the existing
     `+chvt`. The relay creates the socket `0600` inside it and refuses to start if the directory is not
     `0700 jit-desktop`.
   - **One client.** The relay serves one client at a time. A second connection while one is attached gets one framed
     refusal message (`{"jit":"busy"}`) and is closed; the controller maps it to `computer_browser_busy`.
   - **Lifetimes.** A client disconnect closes only that client, drops partial frames, and leaves Chromium running
     with its tabs. When Chromium exits, the relay exits, and the loop starts both again after 2 s; the next tool call
     reconnects. When the relay exits for any other reason (SIGTERM from a unit stop, `Restart=always` restarting
     xinit, an error), it terminates Chromium and waits for it, so the profile's `SingletonLock` is released before
     the next start. It is not a copy of `ops/box/cdp-relay`, which reads the VT and kills the process group on client
     close.
   - Guest root can reach the socket. That is the same residual as ADR 0084 (guest root can already use the profile).
2. **Controller channel: a dedicated desktop CDP stream.** The controller adds one new host stream,
   `vmDesktopCdpStream`, built on `vmSshArgs` (`ssh -T`, same key, host key pin and port as other working-VM
   operations) that runs the fixed `/usr/local/lib/jit-desktop/cdp-attach` (connects to the socket, copies bytes both
   ways, exits when either side closes). It is a `BoxStream` for `CdpClient`, with stdin and stdout kept open as
   pipes. It does **not** use `VmSshTransport.invoke`, `control()` or `vmHostCommand`, which are one-shot: they buffer
   stdout until exit and are bounded by `commandMs`/`sessionMs`.
   - **One per run.** The first `computer_browser` call of a work run opens it; later calls in that run share it.
     The controller holds at most one per VM: a call from another run while it is open is refused with
     `computer_browser_busy`, as is the relay's own second-attach refusal.
   - **Own bounds.** Each message is at most `cdpMessageBytes` (1 MiB) in either direction, and each CDP command has
     the `CdpClient` deadline (15 s). Each tool call has its own deadline (60 s, refused with
     `computer_browser_timeout`).
     The stream closes after 5 minutes without a call. `commandMs` and `sessionMs` do not apply to it, and the
     stream does not keep the work session open.
   - **Closing.** It closes when the run ends, after 5 minutes idle, on takeover, on yield (decision 7), and on stop,
     idle sleep and restore. Closing ends `ssh` and `cdp-attach` only. The relay sees a client disconnect and leaves
     Chromium running (decision 1).
   - A VM without the desktop session refuses with `vm_desktop_unavailable`.
   - `s15-working-vm-v1` names `vmDesktopCdpStream` and its bounds next to `invoke`/`control`.
3. **Tool `computer_browser`.** It is offered only when the run's computer has a running desktop session. The
   operation union matches `protected_browser`: `state`, `navigate`, `read`, `find`, `click`, `type`, `select`,
   `submit`, each with the current generation and an observed opaque target id. There is no JS, selector, cookie,
   raw CDP or file upload/download. Page text, snapshots and element names are untrusted data, bounded like
   exec.browser/v1 (32 KiB snapshot). `screenshot` is not offered until Schway carries image results (ADR 0090
   decision 5). Typed text is never echoed back, stored or logged.
   **Secret fields** follow the protected engine (`src/s15/browser/engine.ts`, `read` and `interact`): `type`,
   `select`, `click` and `submit` on an element of type `password`, `file` or `hidden`, or with
   `autocomplete=one-time-code`, are refused with `computer_browser_secret_field`. The Bot never enters credentials
   or one-time codes, and the owner signs in on the screen (decision 7).
4. **Which sites.** `navigate` refuses sensitive-only hosts before dispatch (`website_sensitive_only`, the same
   `websiteSensitiveOnly` check as the desktop lease filter, which still refuses them in the proxy). It also refuses
   an approved site the owner left at the `sensitive` tier (`website_protected`). The result tells the Bot to use
   `protected_browser`. Trusted sites and unapproved public sites are allowed, as ADR 0084 says.
5. **Fenced by the screen.** Every `computer_browser` call except `needs_you` holds a ScreenControl agent ticket from
   admission until it settles, and checks it again immediately before each CDP input batch is sent. A takeover moves
   the screen to `settling` until the call ends, and refuses new calls with `takeover_active`. Agent and owner input
   never share a writable generation (#410 AC1). A call admitted before a hand-back is refused (#410 AC2); the
   `needs_you` resume in decision 7 is not such a call, because it returns after the hand-back without a CDP batch.
6. **Human-required list on trusted and public sites (tool policy, not bypass-resistant).** There is one rule:
   `click`, `submit`, `select` and Enter-carrying `type` are held when the target element's accessible name, its
   form's field names, or the page URL path match the human-required vocabulary below. Everything else runs without
   approval (Grok-style, ADR 0084), including ordinary submits. This vocabulary check is **new** code. It is not
   exec.browser/v1's `classifyBrowserAction` (which holds every submit and any line break) and not
   `defaultConfirmWords` (`src/config.ts`). Each word maps to one S16-D07 row:

   | Words (English, with Thai equivalents) | S16-D07 row |
   | --- | --- |
   | pay, buy, purchase, checkout, order, transfer, subscribe | (a) payments, purchases, transfers, new billing |
   | send (a message or email) | (b) messages to other people |
   | post, publish, share publicly | (c) public posts |
   | delete, remove, cancel account, close account | (e) destructive changes to data outside the VM |
   | password, account settings, security, permissions | (f) password/account/credential/permission changes |

   Website `delete` is row (e) as written: a website's data lives outside the working VM. ADR 0084 row (e) exempts
   only changes inside the VM, which this tool does not make. Rows (d) and (g) have no browser vocabulary here; row
   (h) is decision 7.
   A held action becomes an in-chat card with the URL, the element text, the matched row and the form field names
   (never values). One press resumes it once if the page and element are unchanged, and returns `stale` otherwise.
   Decline, expiry and stale cards do nothing. The vocabulary is a heuristic, and guest root can bypass it. ADR 0084
   already accepted that residual for trusted sites.
7. **"Needs you" and the yield state.** `computer_browser` has one more kind, `needs_you { reason: "sign_in" |
   "verify" | "captcha", origin }` (S16-D07 row h).
   - **Yield.** ScreenControl gains a fifth state, `yield`. `needs_you` moves the computer's screen from `agent` to
     `yield` under a new generation, closes the desktop CDP stream, and then holds **no** ticket (a ticket would keep
     a takeover in `settling`, and the owner could not type). While in `yield`:
     - new agent tickets are refused for every work on that computer, not only this run (`computer_yielded`);
     - `idleBlocked` is true, so idle sleep does not stop the VM while the owner is wanted;
     - a **Watch screen** takeover goes straight to `owner` with no `settling`, because no ticket can exist.
   - **Card.** It posts a card in the conversation: "<Bot> needs you on <origin> to <reason>", with a **Watch
     screen** button that opens the takeover for that computer. The card never asks for, carries or accepts a
     credential, and typed replies in chat do not resolve it.
   - **Resume.** Hand-back from that takeover advances the generation and returns the screen to `agent`; then
     `needs_you` returns `resumed` with the new generation and sends no CDP batch. The Bot's next call is a new call
     under the new generation and reopens the stream, so #410 AC2 holds.
   - **Decline or expiry.** The owner declines, or the card expires (D3); the screen returns from `yield` to `agent`
     under a new generation, and the tool returns `owner_declined` / `owner_timeout`. An owner lease that lapses
     during the takeover is `fenced`, as today, and the owner hands back from there.
   - **Refused origins.** A sensitive-only or `sensitive`-tier origin is refused and pointed at the protected
     browser's own login handoff. An identity-provider redirect that the desktop lease filter already refuses (ADR
     0091 decision 5, e.g. `accounts.`/`login.`/`sso.` hosts) cannot be signed in here either: the owner would see the
     proxy refusal on the screen. "Sign in with Google" and similar flows on a trusted site stay unsupported in the
     desktop browser.
   - **Routines.** A routine run does not yield; it uses the existing `needs_you` occurrence state
     (`s16-routines-v1`) instead of waiting.
8. **Lineage.** Content read through `computer_browser` carries the computer's scope (a private computer's pages are
   its Bot's private data). Nothing from the page enters memory or history except the Bot's own reply.

## Consequences

- #442's last item closes in the implementation: the owner marks a site trusted, the Bot hits its sign-in, raises
  "needs you", the owner signs in on the screen and hands back, and the Bot continues with the session, which
  survives stop/start because it lives in the desktop profile. The site must sign in on its own host (not through an
  identity provider the desktop filter refuses).
- While a `needs_you` card is open the computer is in `yield`: it does not idle-sleep, and other work on that computer
  waits (`computer_yielded`) until the owner hands back, declines or the card expires. Card expiry length is D3.
- The desktop browser becomes shared between owner and Bot, as in Rakazo. Tabs the owner leaves open are visible to
  the Bot's `state`/`read`.
- Guest root can drive the same browser through the socket without Jit's classification. That is ADR 0084's
  accepted residual, now with a named path. The protected browser remains the only bypass-resistant browser.
- No new dependency. The relay and attach programs are fixed Python files installed with the desktop session.
- **Reinstall on change.** Today `ready-v1` holds only the Chrome pin, and the installer runs only when the lease
  writer finds it absent or different from `qemuDesktopBrowser.version`. A session change that keeps the same Chrome
  would never be installed. The skip key becomes `<chrome version>+session.<revision>`, where the session revision
  covers the session script, the units, `cdp-relay` and `cdp-attach`. A mismatch runs the install again; the
  installer keeps an already unpacked, hash-checked `/opt/jit-desktop/chrome-<version>` and does not download Chrome
  again.

## Decisions for Champ

- **D1, what waits on trusted/public sites.** Proposed: only actions matching the human-required vocabulary (decision
  6). Alternative: hold every submit, as exec.browser/v1 does. That is safer, but it asks often and works against the
  Grok-style default.
- **D2, shared browser.** Proposed: the Bot drives the same desktop browser the owner sees. Alternative: a second
  profile for the Bot, with the owner's trusted-site sessions copied in. That adds complexity, and cookies would leave
  the profile, so it is not recommended.
- **D3, how long a "needs you" card waits.** Proposed: 24 h, matching other owner cards. During that time the
  computer stays awake and other work on it waits. Alternative: a shorter expiry (for example 1 h), which frees the
  computer sooner but loses requests the owner sees late.

## Delivery and evidence (planned slices)

- **3a**: relay, attach, `vmDesktopCdpStream`, provisioning (session revision in `ready-v1`), `computer_browser`
  read operations (`state`, `navigate`, `read`, `find`) with site rules and ScreenControl tickets. Tests:
  provisioning steps exact and absent for headless; `ready-v1` matching the Chrome pin but missing the session
  revision (relay files absent) runs the install and does not download Chrome again; `/run/jit-desktop` is
  `0700 jit-desktop` and created by root; refusal of sensitive-only and sensitive-tier hosts before dispatch; a
  takeover refuses new calls and waits for a running one; a hanging attach does not go through `invoke`/`control`
  and does not block them; a second concurrent attach is refused with `computer_browser_busy`; a client disconnect
  leaves Chromium running; relay exit reaps Chromium and the next start gets the profile lock; reconnect after a
  browser restart; idle close after 5 minutes.
- **3b**: `click`/`type`/`select`/`submit`, the vocabulary rule, held cards with one-press resume and stale refusal,
  secret-field refusal. Tests: classification table per S16-D07 row, including ordinary submits that do not wait;
  password, file, hidden and one-time-code fields refused; card approve once, decline, stale, reload with no
  duplicate dispatch; no typed text in journal, history or logs.
- **3c**: `needs_you` card and the `yield` state, resume on hand-back, routine `needs_you` state, English/Thai copy;
  `Closes #442`. Tests: a second work on the same computer is refused while yielded; the idle sweep does not stop a
  yielded VM, and it is still running 31 minutes after the last session closed; Watch screen takeover can type
  immediately (no `settling`); hand-back advances the generation and `needs_you` returns with no CDP batch; decline
  and expiry return to `agent`; card never carries a credential; typed "ok" does not resolve it; sensitive origins
  refused; the #442 flow end to end with a non-IdP fixture login site and a scripted owner takeover.
- Contracts: new `s16-computer-browser-v1`; updates to `s16-computer-screen-v1` (agent tickets for browser calls,
  the `yield` state) and `s15-working-vm-v1` (`vmDesktopCdpStream`, relay files, `ready-v1` session revision). Live
  evidence on `jit-vm` (real Chromium pipe, sign-in on a trusted non-IdP fixture site, stop/start) belongs to #431.
