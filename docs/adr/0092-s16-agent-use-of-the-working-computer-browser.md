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
   - **One client, handshake first.** The relay serves one client at a time. Every accepted connection first gets
     exactly one NUL-framed handshake frame before any CDP byte: `{"jit":"attached"}` when it becomes the client, or
     `{"jit":"busy"}` when another client is attached, after which that connection is closed. The handshake is not a
     CDP message (`CdpClient` drops frames with no `id`/`method` and would report `cdp_closed`), so the controller
     reads it itself (decision 2).
   - **Unbuffered, both ways.** The relay writes every frame, the handshake included, as soon as it has it: socket
     writes use `sendall`, writes to Chromium's pipe use `os.write` in a loop until every byte is written. It never
     writes through `sys.stdout`/`sys.stdout.buffer` or another buffered file object, so nothing waits in a
     user-space buffer while the process runs. Its shebang is `#!/usr/bin/python3 -Iu` (one argument: Linux passes
     everything after the interpreter as a single word; `-I` ignores `PYTHON*` variables and the user site, `-u`
     unbuffers the standard streams as a second guard).
   - **Lifetimes.** A client disconnect closes only that client, drops partial frames, and leaves Chromium running
     with its tabs. When Chromium exits, the relay exits, and the loop starts both again after 2 s; the next tool call
     reconnects. When the relay exits for any other reason (SIGTERM from a unit stop, `Restart=always` restarting
     xinit, an error), it terminates Chromium and waits for it, so the profile's `SingletonLock` is released before
     the next start. It is not a copy of `ops/box/cdp-relay`, which reads the VT and kills the process group on client
     close.
   - Guest root can reach the socket. That is the same residual as ADR 0084 (guest root can already use the profile).
2. **Controller channel: a dedicated desktop CDP stream.** The controller adds one new host stream,
   `vmDesktopCdpStream`, built on `vmSshArgs` (`ssh -T`, same key, host key pin and port as other working-VM
   operations) that runs `sudo -n -u jit-desktop /usr/local/lib/jit-desktop/cdp-attach`. `cdp-attach` is fixed
   Python: it connects to the socket, copies bytes both ways unchanged, and exits when either side closes. It is a
   `BoxStream` for `CdpClient`, with stdin and stdout kept open as pipes.
   - **Unbuffered, both ways.** Like the relay (`#!/usr/bin/python3 -Iu`), `cdp-attach` reads with `os.read` and
     writes at once: socket to stdout with `os.write(1, …)` in a loop, stdin to socket with `sendall`. Over `ssh -T`
     its stdout is a pipe, where Python would otherwise block-buffer about 8 KiB, and sudo's `env_reset` clears
     `PYTHONUNBUFFERED`, so the program does not rely on the environment.
   - **stderr stays out of the stream.** The controller reads the SSH process's stderr separately, bounded, for
     diagnostics only, and never merges it into stdout (`2>&1` is not used anywhere on the path). sudo's own
     messages and Python tracebacks therefore cannot corrupt a frame.
   - **Why sudo, and why it is a byte pipe.** SSH logs in as `jit` (`qemu.ts` endpoint), and the socket stays
     `0600` in the `0700 jit-desktop` directory (decision 1), so `cdp-attach` runs as `jit-desktop`. `jit` already
     has `NOPASSWD:ALL`; no group membership, sudoers rule or setuid is added (setuid does not apply to a Python
     script). The key is installed with `restrict` (no pty) and the stream uses `ssh -T`, so there is no terminal:
     sudo (sudo-rs on the Ubuntu 26.04 guest, ADR 0091 decision 6) allocates a pty only when it can open the user's
     terminal, and otherwise execs without one. `invoke` already carries its JSON through `sudo -n` both ways and
     checks it byte for byte (`transport.ts`).
   - **Handshake.** After spawning the stream, the controller reads the relay's handshake frame itself, with a 10 s
     deadline, before it constructs `CdpClient`. `{"jit":"attached"}` hands the stream to `CdpClient`;
     `{"jit":"busy"}` closes it and refuses with `computer_browser_busy`; anything else, EOF or the deadline closes it
     and refuses with `computer_browser_unavailable`.
   - **Not the one-shot channel.** It does **not** use `VmSshTransport.invoke`, `control()` or `vmHostCommand`,
     which are one-shot: they buffer stdout until exit and are bounded by `commandMs`/`sessionMs`.
   - **One per run.** The first `computer_browser` call of a work run opens it; later calls in that run share it.
     The controller holds at most one per VM: any other opener while it is open (another run, or a held-card press
     while the posting run still holds it, decision 6) is refused with `computer_browser_busy`, as is the relay's own
     second-attach refusal.
   - **Reopen.** Any admitted call that finds the stream closed (idle close, browser restart, a broken pipe, a
     finished takeover or yield) opens it again before dispatch. It is not reopened while the screen is `yield`,
     `settling`, `owner` or `fenced`, or while the VM is stopped; those calls are refused before admission
     (decisions 5 and 7).
   - **Own bounds.** Each message is at most `cdpMessageBytes` (1 MiB) in either direction, and each CDP command has
     the `CdpClient` deadline (15 s). Each tool call has its own deadline (60 s, refused with
     `computer_browser_timeout`).
     The stream closes after 5 minutes without a call. `commandMs` and `sessionMs` do not apply to it, and the
     stream does not keep the work session open.
   - **Closing.** It closes when the run ends, after 5 minutes idle, on takeover, when a held card is posted (decision
     6), when a held-card press ends, sent or refused (decision 6), on yield (decision 7), and on stop, idle sleep and
     restore. Closing ends `ssh` and `cdp-attach` only. The relay sees a client disconnect and leaves Chromium running
     (decision 1).
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
4. **Which sites, on every operation.** A sensitive-only host (`website_sensitive_only`, the same
   `websiteSensitiveOnly` check as the desktop lease filter, which still refuses them in the proxy) and an approved
   site the owner left at the `sensitive` tier (`website_protected`) are refused. The result tells the Bot to use
   `protected_browser`. Trusted sites and unapproved public sites are allowed, as ADR 0084 says.
   - `navigate` checks the target before dispatch.
   - Every operation (`state`, `navigate`, `read`, `find`, `click`, `type`, `select`, `submit`) checks the current
     origin of the tab it acts on **before dispatch** and the tab's origin again **before returning page text**, so a
     tab the owner opened, or a redirect after a click or navigate, onto a refused origin is neither driven nor read.
   - **Leaving a refused tab.** When the tab `navigate` would act on is on a refused origin and the target URL is
     allowed, `navigate` opens the target in a new tab (one `Target.createTarget`) and acts there. The refused tab is
     not navigated, its URL stays the same (the owner's half-filled form is not lost), and none of its text is
     returned. Every other operation on that tab stays refused.
   - `state` lists tabs but returns no title, URL path or text for a tab on a refused origin, only its origin and
     `website_protected`/`website_sensitive_only`.
5. **Fenced by the screen.** Every `computer_browser` call except `needs_you` holds a ScreenControl agent ticket from
   admission until it settles, and checks it again immediately before each CDP input batch is sent. A call whose
   action is held (decision 6) settles when the card is posted: it closes the run's stream, releases its ticket, and
   the press is a new admission. A takeover moves the screen to `settling` until the call ends, and refuses new calls
   with `takeover_active`. Agent and owner input never share a writable generation (#410 AC1). A call admitted before
   a hand-back is refused (#410 AC2). `needs_you` holds no ticket and sends no CDP batch (decision 7).
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
   | deploy, release, promote to production | (d) production deploys |
   | delete, remove, cancel account, close account | (e) destructive changes to data outside the VM |
   | password, account settings, security, permissions | (f) password/account/credential/permission changes |

   Website `delete` is row (e) as written: a website's data lives outside the working VM. ADR 0084 row (e) exempts
   only changes inside the VM, which this tool does not make. Row (d) applies to a production deploy started from a
   website (a hosting or CI console). Row (g) has no browser vocabulary and stays ADR 0084's residual; row (h) is
   decision 7.
   **Held card (S16-D08).** A held action becomes an in-chat card with the URL, the element text, the matched row,
   and the action's exact non-secret values: amount, recipients, message or post content, target. Content longer
   than the card shows is reached through a deep link, as S16-D08 says. Values of `password`, `file`, `hidden` and
   one-time-code fields are never shown. The card is bound to a revision: the URL, the target element and those
   values. One press resumes the action once, only if the live revision still equals the card's; any change returns
   `stale` and the Bot must raise a new card. Decline, expiry and stale cards do nothing. The vocabulary is a
   heuristic, and guest root can bypass it. ADR 0084 already accepted that residual for trusted sites.
   - **The call does not wait.** The held call returns `{ state: "pending", cardId, expiresAt }` within the tool
     deadline (60 s). Before that result returns, it closes the run's desktop CDP stream and releases its agent
     ticket. The turn continues or ends normally (ADR 0037:37), as with `exec.browser` `pause()` and approval-cards-v1
     `pending_approval`; if the run calls `computer_browser` again, the stream reopens (decision 2). The card expires
     after 30 minutes, as approval-cards-v1 cards do.
   - **One press is a new admission, in this order.** Every exit after a successful step 2 closes the stream that this
     press opened (a sent batch, `stale`, a refused origin, or a step-3 throw), and every exit after step 3 ends that
     ticket (`end()`) exactly once, success or refusal, so a press never leaves a stream or a ticket behind.
     1. Screen state, before any stream or ticket: not `agent` is refused with `computer_yielded` (`yield`) or
        `takeover_active` (`settling`, `owner`, `fenced`).
     2. Open the press's own desktop CDP stream. If the VM's stream is held, by another run or by the run that
        posted the card, the press is refused with `computer_browser_busy`.
     3. Take an agent ticket (`agentInput`). If it throws, the stream from step 2 is closed before the refusal
        returns.
     4. Re-check the card's revision (`stale` on any change) and the tab's current origin (decision 4).
     5. Send the CDP batch, then close the stream and end the ticket.
   - **Only a sent batch uses the press.** A press refused at steps 1 to 4 for busy, a non-`agent` screen, a step-3
     throw or a refused origin sends nothing, leaves no stream and no ticket, and does not consume the one press, so
     the next press can send at once, without waiting for the idle close or a takeover. The card stays pending until a
     press sends its batch, the revision is `stale`, the owner declines, or the 30 minutes pass. The outcome is
     recorded on the card and shown in the conversation, not returned to the earlier tool call.
7. **"Needs you" and the yield state.** `computer_browser` has one more kind, `needs_you { reason: "sign_in" |
   "verify" | "captcha", origin }` (S16-D07 row h).
   - **Yield.** ScreenControl gains a fifth state, `yield`. `needs_you` is refused unless the screen is `agent`
     (`takeover_state_changed`). It moves the screen from `agent` to `yield` under a new generation, closes the
     desktop CDP stream, and holds no ticket itself. `agentInput` (`screen.ts:116`) refuses with `computer_yielded`
     when the screen is `yield`, and with `takeover_active` for `settling`, `owner` and `fenced` as today. Tickets
     that other work already holds (a shell or file call from another session, up to `maxSessions`) are not aborted
     and run to their end. While in `yield`:
     - new agent tickets are refused for every work on that computer, not only this run (`computer_yielded`);
     - `idleBlocked` is true, so idle sleep does not stop the VM while the owner is wanted;
     - a **Watch screen** takeover is accepted from `yield` (the takeover guard accepts `agent`, `fenced` and
       `yield`) and follows the same rule as from `agent` (`screen.ts` takeover): `settling` while any ticket is still
       held, otherwise `owner`. Owner input is refused with `takeover_settling` until the last ticket ends; since
       `yield` admits no new tickets, that is bounded by `commandMs`, and the screen shows `agentBusy` meanwhile. The
       Watch screen button sends the `yield` generation; an older generation is `stale_screen`.
   - **No `yield` without a card.** The card lives in the conversation store (`conversation.sqlite`,
     `s15/composition.ts:205`) and ScreenControl in `vm.sqlite` (`composition.ts:207`): two stores with no shared
     transaction. So the order is fixed: insert the card first, then move the screen to `yield`. If the card insert
     fails, the screen stays `agent` and the call fails. If the move to `yield` fails (the screen is no longer
     `agent`, or the write fails), the card is voided and never shows a Watch screen button. A process that dies after
     the insert and before the move leaves a pending card that no caller voids. So a pending `needs_you` card is
     voided when all three hold: it is older than the 60 s call deadline, no `s16_screen_control` row holds its
     `card_id`, and no `yield_*` event carries its `card_id`. This is checked on card read and at startup; a failed
     void is repaired on the next read. The `yield` row keeps its own `card_id` and `expires_at` (the card's
     `expiresAt`), so expiry and hand-back never need the conversation store. `card_id` stays on the row through
     `settling`, `owner` and `fenced` (including the restart and lapsed-lease fences) and is cleared when the screen
     returns to `agent`. Watch screen overwrites `expires_at` with the owner lease (`screen.ts:191`) and never copies
     the card expiry into `settling`, `owner` or `fenced`; only `card_id` carries over.
   - **The call does not wait.** `needs_you` posts the card, enters `yield` and returns at once, within the tool
     deadline (60 s): `{ state: "yielded", cardId, generation, expiresAt }`. The turn continues or ends normally (ADR
     0037:37), as with other owner cards (`exec.browser` `pause()`, approval-cards-v1 `pending_approval`); any later
     `computer_browser` or VM call in that run is refused with `computer_yielded`. The tool never waits for the owner,
     so no tool call or run outlives its own deadline (60 s per call; a conversation run's `activeMs` is at most 1 h).
   - **Yield is not tied to the run.** `yield` lives as long as the card and the screen. A run that is cancelled,
     crashes or simply ends leaves `yield` in place, so the owner can still press Watch screen and hand back.
   - **Card.** It posts a card in the conversation: "<Bot> needs you on <origin> to <reason>", with a **Watch
     screen** button that opens the takeover for that computer. The card never asks for, carries or accepts a
     credential, and typed replies in chat do not resolve it.
   - **Outcome on the card, not as a tool result.** Every way out of the card's `yield` writes one screen event
     (`yield_resumed`, `yield_declined`, `yield_expired`) with the new generation in `vm.sqlite`. In the same
     `vm.sqlite` transaction the event gets the `card_id` the row held before the way out (read before the write), and
     the row that returns to `agent` gets `card_id` null; the event never copies the new row's null (`write()` at
     `screen.ts:86-89` today uses one argument set for both, and hand-back at `:207` passes `agent, null, null`). This
     holds for hand-back, decline and the expiry in `row()`. The card's outcome (`resumed`, `declined`, `expired`) is
     read from that event and shown in the conversation, so a failed card update cannot lose it. Hand-back from that
     takeover advances the generation, returns the screen to `agent` and records `resumed` with the new generation; no
     CDP batch is sent. The card shown in the UI does not count as the model having seen the outcome.
   - **The next run gets the outcome as data.** The next work run in the conversation that posted the card, with that
     computer in its admitted resources, gets one work-prompt source in the same form as the memory source
     (`schway.ts:46`, data never authority): `{ cardId, origin, reason, outcome, generation }`, where `generation` is
     the new one. It is marked delivered in the conversation store only by the publication transaction that sets
     `request.state = "completed"` (`application.ts:694-705`, the state write at `:701`), as one more write in that
     transaction, and it counts only if that transaction commits. Only the `cardId`s that run actually carried in its
     prompt are marked; this covers both the `runConversation` and the `runWork` path (`:682`), since both publish
     through `:701`. Schway returning outcome `completed` (`schway.ts:100-103`) is not the mark: a reply came back,
     but publication can still throw at `:696`, `:697` (`result_unavailable`: intent not `answer` and no successful
     tool evidence) or `:704`, and the catch at `:710` then sets `held`. A run that throws there, fails, is cancelled,
     is refused or ends `held` does not mark it, and neither does `onUsage` (`:685`, which saves usage on a failed run
     too), so the next eligible run gets it again (at least once, never lost). `providerRequests` counts started
     provider sends, not prompt content (schway `host/index.d.ts:231-239`), so it is not the delivery mark. The
     interpretation context is not changed (`application.ts:767-771`: owner text and tool-free answers only; `origin`
     is a model argument and must not influence scope selection). The run calls under that generation, which reopens
     the stream, and a call under the generation from before `yield` is refused, so #410 AC2 holds. Starting a run
     automatically on hand-back is out of scope for this ADR (follow-up #459, which uses this source for the outcome).
   - **Decline or expiry, only while still `yield`.** The owner declines, or the card expires (D3), while the screen
     is still `yield`: the card records `declined` / `expired` and the screen returns to `agent` under a new
     generation. Expiry has no timer or separate hook: `ScreenControl.row()` returns an overdue `yield` (past its
     row's `expires_at`) to `agent` under a new generation with a `yield_expired` event as it reads it, the same way
     it fences a lapsed owner lease today (`screen.ts:93-99`). `idleBlocked` (read by the idle sweep at
     `service.ts:361`), `agentInput`, `needs_you` and Watch screen all read through `row()`, so the sweep sees `agent`
     and can stop the VM, and no admission sees an overdue `yield`. Once the owner has pressed Watch screen
     (`settling`, `owner` or `fenced`), the card no longer declines or expires: it waits for the hand-back, and
     records `resumed` only then. An owner lease that lapses during the takeover is `fenced`, as today, and the owner
     hands back from there.
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
  "needs you" (the tool returns at once), the owner signs in on the screen and hands back, and the Bot's next run
  continues with the session, which survives stop/start because it lives in the desktop profile. The site must sign in
  on its own host (not through an identity provider the desktop filter refuses).
- While a `needs_you` card is open the computer is in `yield`: it does not idle-sleep, and other work on that computer
  is refused (`computer_yielded`) until the owner hands back, or declines or the card expires before Watch screen.
  This does not depend on the run that raised it, which has already ended. Card expiry length is D3.
- The Bot does not continue by itself after hand-back: the owner's next message (or another trigger) starts the run,
  which gets the `resumed` outcome and the new generation as a data source in its work prompt (decision 7), even when
  the owner types only "continue". If that run's publication does not commit `completed` (`application.ts:701`),
  including a run that ends `held`, the next one gets the source again. Automatic continuation is follow-up #459.
- The desktop browser becomes shared between owner and Bot, as in Rakazo. Tabs the owner leaves open are visible to
  the Bot's `state`/`read`.
- Guest root can drive the same browser through the socket without Jit's classification. That is ADR 0084's
  accepted residual, now with a named path. The protected browser remains the only bypass-resistant browser.
- No new dependency. The relay and attach programs are fixed Python files installed with the desktop session.
- **Reinstall on change.** Today `ready-v1` holds only the Chrome pin, and the installer runs only when the lease
  writer finds it absent or different from `qemuDesktopBrowser.version`. A session change that keeps the same Chrome
  would never be installed. The skip key becomes `<chrome version>+session.<revision>`, where the session revision
  covers the session script, the units, `cdp-relay` and `cdp-attach`. Both sides use the same composite key: the
  installer writes it to `ready-v1`, and the lease writer and the install check compare `ready-v1` with it (not with
  `qemuDesktopBrowser.version` alone, which would make every boot look absent). A mismatch runs the install again;
  the installer keeps an already unpacked, hash-checked `/opt/jit-desktop/chrome-<version>` and does not download
  Chrome again.

## Decisions for Champ

- **D1, what waits on trusted/public sites.** Proposed: only actions matching the human-required vocabulary (decision
  6). Alternative: hold every submit, as exec.browser/v1 does. That is safer, but it asks often and works against the
  Grok-style default.
- **D2, shared browser.** Proposed: the Bot drives the same desktop browser the owner sees. Alternative: a second
  profile for the Bot, with the owner's trusted-site sessions copied in. That adds complexity, and cookies would leave
  the profile, so it is not recommended.
- **D3, how long a "needs you" card waits.** Proposed: 24 h. Held action cards (decision 6) keep approval-cards-v1's
  30 minutes; a sign-in waits longer because the owner has to come to the screen. During that time the
  computer stays awake and other work on it waits. Alternative: a shorter expiry (for example 1 h), which frees the
  computer sooner but loses requests the owner sees late.

## Delivery and evidence (planned slices)

- **3a**: relay, attach, `vmDesktopCdpStream`, provisioning (session revision in `ready-v1`), `computer_browser` read
  operations (`state`, `navigate`, `read`, `find`) with site rules and ScreenControl tickets. Tests: provisioning
  steps exact and absent for headless; `ready-v1` matching the Chrome pin but missing the session revision (relay
  files absent) runs the install and does not download Chrome again; the lease writer accepts the composite key and
  reports absent for the bare Chrome pin; `/run/jit-desktop` is `0700 jit-desktop` and created by root; (i) a frame
  containing `\0`, `\r`, `\n`, `0x03` and `0x04` goes through `ssh -T` + `sudo -n -u jit-desktop` + `cdp-attach` to a
  stub echo peer on the socket (not Chromium) and comes back byte for byte before either side closes, while both
  processes are still running; (ii) the real relay's handshake reaches the controller within 10 s while the relay and
  `cdp-attach` are still running (not on exit); refusal of sensitive-only and sensitive-tier hosts before dispatch; an
  owner-opened tab on a sensitive-tier origin is refused for `read`/`find` and `state` returns no title or text for
  it; with a sensitive-tier tab as the only open tab, `navigate` to an allowed URL succeeds in a new tab, the old
  tab's URL is unchanged, and none of its text is returned; a navigate that redirects onto a sensitive-tier origin
  returns no page text; a takeover refuses new calls and waits for a running one; a hanging attach does not go through
  `invoke`/`control` and does not block them; the controller reads the handshake before `CdpClient`, and a second
  concurrent attach is refused with `computer_browser_busy`; a missing or malformed handshake is
  `computer_browser_unavailable`; a client disconnect leaves Chromium running; relay exit reaps Chromium and the next
  start gets the profile lock; reconnect after a browser restart; the stream closes after 5 minutes idle and the next
  call reopens it and succeeds.
- **3b**: `click`/`type`/`select`/`submit`, the vocabulary rule, held cards with one-press resume and stale refusal,
  secret-field refusal, current-origin check on every input operation. Tests: classification table per S16-D07 row (a)
  to (f), including ordinary submits that do not wait; password, file, hidden and one-time-code fields refused; a
  click whose result redirects onto a sensitive-tier origin returns no page text; the card shows the amount,
  recipients and content and never a secret field's value; a held call returns `pending` within 60 s, closes the run's
  stream and releases its ticket (a takeover while the card is open goes straight to `owner`); a press while the
  posting run still holds the stream (it called `computer_browser` again) gets `computer_browser_busy`, does not
  consume the press and leaves no ticket (Watch screen then goes straight to `owner`), and a later press once the
  stream is free sends exactly once; a press refused at any step leaves no ticket; (a) a press on a tab that moved to
  a refused origin leaves no stream and no ticket, and once the tab is back on an allowed origin the next press sends
  exactly once without waiting for the idle close or a takeover; (b) a press refused at step 3 (`agentInput` throws)
  leaves no stream; card approve once, decline, stale when the URL, element or any shown value changed, reload with no
  duplicate dispatch; a press after the run ended takes a new ticket and its own stream; a press while the screen is
  not `agent` is refused (`takeover_active` / `computer_yielded`) before any ticket and sends nothing; a press on a
  tab that moved to a refused origin sends nothing; neither consumes the press; the card expires after 30 minutes; no
  typed text in journal, history or logs.
- **3c**: `needs_you` card and the `yield` state, resume on hand-back, routine `needs_you` state, English/Thai copy;
  `Closes #442`. Tests: `needs_you` is refused unless the screen is `agent`; a failed card insert leaves the screen
  `agent` and new work is not refused with `computer_yielded`; a failed move to `yield` voids the card; a process
  killed after the card insert and before the move to `yield`: after restart and 60 s, the screen is `agent`, the card
  is void and shows no Watch screen button; a card read between the insert and the move does not void the card, and
  the move still succeeds; it returns `{ state: "yielded", cardId, generation, expiresAt }` within 60 s, and a later
  call in the same run is refused with `computer_yielded`; a cancelled run leaves `yield` in place and Watch screen
  and hand-back still work; Watch screen sends the `yield` generation, and an older one is `stale_screen`; a second
  work on the same computer is refused while yielded; the idle sweep does not stop a yielded VM, and it is still
  running 31 minutes after the last session closed; (a) with no ticket held, Watch screen goes to `owner` and the
  owner can type immediately; (b) with another session holding a shell ticket, Watch screen goes to `settling`, owner
  input gets `takeover_settling` until that shell call ends, then the screen is `owner`, and the shell call has
  finished when the owner types; hand-back advances the generation and the card records `resumed` with no CDP batch;
  the owner's next message is only "continue", and the admitted work prompt (checked on the request the model
  receives, `schway.ts:78`, not on `providerRequests`) contains `resumed`, the origin and the new generation that the
  owner did not type; that run's first call under the new generation succeeds and a call under the generation from
  before `yield` is refused; if the provider fails on the run that carried the source, the next run with only
  "continue" still gets it; after a completed run that carried the source, a second run gets no outcome source for
  that card; if Schway returns outcome `completed` on the run that carried the source but there is no successful tool
  evidence, publication throws `result_unavailable` and the request is `held`, and the next run with only "continue"
  still has `resumed`, the origin and the new generation on the request the model receives (`schway.ts:78`); after
  hand-back the control row's `card_id` is null and `yield_resumed.card_id` equals the card; with the card update
  failing, the card still shows `resumed` read from that event and the void rule does not void it; expiry writes
  `yield_expired.card_id` equal to the card; decline and expiry while still `yield` record `declined` / `expired` and
  return to `agent`; a `yield` past `expiresAt` is returned to `agent` by `row()` without a timer: a yielded VM left
  untouched past `expiresAt` is stopped by the idle sweep, and the next admission sees `agent`; the card expiring
  while the owner holds the screen does not remove the owner, no resumed/timeout outcome is recorded and the state was
  not forced back; card never carries a credential; typed "ok" does not resolve it; sensitive origins refused; the
  #442 flow end to end with a non-IdP fixture login site and a scripted owner takeover.
- Contracts: new `s16-computer-browser-v1`; updates to `s16-computer-screen-v1` (agent tickets for browser calls, the
  `yield` state: `takeover` from `agent`, `fenced` or `yield`, and Watch screen sends the `yield` generation) with the
  code change it names in `src/s16/computers/screen.ts` (the takeover guard at `:189` accepts `yield`; `agentInput` at
  `:116` refuses `yield` with `computer_yielded`; `row()` expires an overdue `yield`; the `s16_screen_control` state
  CHECK at `:78` adds `'yield'` and the table gains `card_id`, rebuilt by a migration because SQLite cannot alter a
  CHECK in place; in the same migration `s16_screen_events` gains `card_id`, written by the event insert at `:89` with
  the `card_id` the row held before the write, in the same transaction that sets the row's `card_id`, so a way out of
  `yield` records the card on the event and null on the `agent` row) and `s15-working-vm-v1` (`vmDesktopCdpStream`
  with its `sudo -n -u jit-desktop` attach and handshake, relay files, composite `ready-v1` key). Live evidence on
  `jit-vm` (real Chromium pipe, sign-in on a trusted non-IdP fixture site, stop/start) belongs to #431.
