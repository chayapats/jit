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
you").

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
3. **CDP to the desktop Chromium, through a fixed relay over the work session (proposed).** The desktop session
   starts Chromium with `--remote-debugging-pipe` behind a small fixed relay. The controller reaches the relay over
   the existing SSH work channel and talks to it with the existing `CdpClient` framing (`jit.box.cdp-stream/v1`:
   NUL-terminated JSON, bounded messages and deadlines). The Bot gets a closed operation union, like
   `protected_browser`, on the same browser window the owner watches. Jit classifies each action before dispatch.

Option 3 reuses parts Jit already has (CDP client, exec.browser/v1's element description and submit/confirm
classification, the protected browser's operation union, ScreenControl tickets). The owner sees the Bot work on the
screen, as in Rakazo.

## Decision (proposed)

1. **Debugging pipe, no port.** The desktop session script starts Chromium as a child of
   `/usr/local/lib/jit-desktop/cdp-relay` (fixed Python, installed with the session, part of `ready-v1`). The relay
   bridges Chromium's pipe descriptors 3/4 to a Unix socket `/run/jit-desktop/cdp.sock` in a `0700 jit-desktop`
   directory, one client at a time. No TCP debugging port is opened, so page content and other guest users cannot
   reach DevTools over loopback. Guest root can reach the socket. That is the same residual as ADR 0084 (guest root can
   already use the profile). The unit still restarts the browser if it exits; a restart drops the client, and the
   next tool call reconnects.
2. **Controller channel.** The first browser call of a work run opens one `ssh … /usr/local/lib/jit-desktop/cdp-attach`
   stream (fixed program: connects to the socket, copies bytes both ways, exits when either side closes). It is
   bound to the work session like any other working-VM operation and closes when the run ends, after 5 minutes idle,
   on takeover, stop, idle sleep and restore. A VM without the desktop session refuses with `vm_desktop_unavailable`.
3. **Tool `computer_browser`.** It is offered only when the run's computer has a running desktop session. The
   operation union matches `protected_browser`: `state`, `navigate`, `read`, `find`, `click`, `type`, `select`,
   `submit`, each with the current generation and an observed opaque target id. There is no JS, selector, cookie,
   raw CDP or file upload/download. Page text, snapshots and element names are untrusted data, bounded like
   exec.browser/v1 (32 KiB snapshot). `screenshot` is not offered until Schway carries image results (ADR 0090
   decision 5). Typed text is never echoed back, stored or logged. Typing into a password field is refused
   (`computer_browser_secret_field`). The Bot never enters credentials, and the owner signs in on the screen.
4. **Which sites.** `navigate` refuses sensitive-only hosts before dispatch (`website_sensitive_only`, the same
   `websiteSensitiveOnly` check as the desktop lease filter, which still refuses them in the proxy). It also refuses
   an approved site the owner left at the `sensitive` tier (`website_protected`). The result tells the Bot to use
   `protected_browser`. Trusted sites and unapproved public sites are allowed, as ADR 0084 says.
5. **Fenced by the screen.** Every `computer_browser` call holds a ScreenControl agent ticket from admission until
   it settles, and checks it again immediately before each CDP input batch is sent. A takeover moves the screen to
   `settling` until the call ends, and refuses new calls with `takeover_active`. Agent and owner input never share a
   writable generation (#410 AC1), and a call queued before a hand-back is refused (#410 AC2).
6. **Human-required list on trusted and public sites (tool policy, not bypass-resistant).** Jit classifies each
   `click`, `submit` and Enter-carrying `type` with exec.browser/v1's element description: a submit control, a
   default button in a form, or an element whose accessible name matches the confirm vocabulary. Ordinary actions
   run without approval (Grok-style, ADR 0084). An action whose element name, form fields or URL match the
   human-required vocabulary (pay, buy, order, transfer, send, post/publish, delete, password/account settings) is
   held as an in-chat card with the URL, the element text and the form field names (never values). One press
   resumes it once if the page and element are unchanged, and returns `stale` otherwise. Decline, expiry and stale
   cards do nothing. The vocabulary is a heuristic, and guest root can bypass it. ADR 0084 already accepted that
   residual for trusted sites.
7. **"Needs you".** `computer_browser` has one more kind, `needs_you { reason: "sign_in" | "verify" | "captcha",
   origin }`. It posts a card in the conversation: "<Bot> needs you on <origin> to <reason>", with a **Watch screen**
   button that opens the takeover for that computer. The run pauses, holding no ticket, until the owner hands the
   screen back (resume, with a new generation) or declines/lets it expire (24 h; the tool returns `owner_declined` /
   `owner_timeout`). The card never asks for, carries or accepts a credential, and typed replies in chat do not
   resolve it. A sensitive-only or `sensitive`-tier origin is refused and pointed at the protected browser's own
   login handoff. A routine run uses the existing `needs_you` occurrence state (`s16-routines-v1`) instead of waiting.
8. **Lineage.** Content read through `computer_browser` carries the computer's scope (a private computer's pages are
   its Bot's private data). Nothing from the page enters memory or history except the Bot's own reply.

## Consequences

- #442's last item closes in the implementation: the owner marks a site trusted, the Bot hits its sign-in, raises
  "needs you", the owner signs in on the screen and hands back, and the Bot continues with the session, which
  survives stop/start because it lives in the desktop profile.
- The desktop browser becomes shared between owner and Bot, as in Rakazo. Tabs the owner leaves open are visible to
  the Bot's `state`/`read`.
- Guest root can drive the same browser through the socket without Jit's classification. That is ADR 0084's
  accepted residual, now with a named path. The protected browser remains the only bypass-resistant browser.
- No new dependency. The relay and attach programs are fixed Python files installed with the desktop session;
  changing them bumps the `ready-v1` version, so existing desktop VMs reinstall on their next start.

## Decisions for Champ

- **D1, what waits on trusted/public sites.** Proposed: only actions matching the human-required vocabulary (decision
  6). Alternative: hold every submit, as exec.browser/v1 does. That is safer, but it asks often and works against the
  Grok-style default.
- **D2, shared browser.** Proposed: the Bot drives the same desktop browser the owner sees. Alternative: a second
  profile for the Bot, with the owner's trusted-site sessions copied in. That adds complexity, and cookies would leave
  the profile, so it is not recommended.

## Delivery and evidence (planned slices)

- **3a**: relay, attach, provisioning (`ready-v1` bump), `computer_browser` read operations (`state`, `navigate`,
  `read`, `find`) with site rules and ScreenControl tickets. Tests: provisioning steps exact and absent for headless;
  refusal of sensitive-only and sensitive-tier hosts before dispatch; a takeover refuses new calls and waits for a
  running one; reconnect after a browser restart; socket directory mode/owner.
- **3b**: `click`/`type`/`select`/`submit`, classification, held cards with one-press resume and stale refusal,
  password-field refusal. Tests: classification table; card approve once, decline, stale, reload with no duplicate
  dispatch; no typed text in journal, history or logs.
- **3c**: `needs_you` card, resume on hand-back, routine `needs_you` state, English/Thai copy; `Closes #442`.
  Tests: card never carries a credential; typed "ok" does not resolve it; sensitive origins refused; the #442 flow
  end to end with a fixture site and a scripted owner takeover.
- Contracts: new `s16-computer-browser-v1`; updates to `s16-computer-screen-v1` (agent tickets for browser calls) and
  `s15-working-vm-v1` (relay files). Live evidence on `jit-vm` (real Chromium pipe, sign-in on a trusted fixture
  site, stop/start) belongs to #431.
