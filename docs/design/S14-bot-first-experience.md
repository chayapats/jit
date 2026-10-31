# S14 bot-first experience

Parent: [S14 spec](../specs/S14-bot-first-local-assistant.md), [design brief](S14-design-brief.md), issues [#244](https://github.com/chayapats/jit/issues/244) and [#245](https://github.com/chayapats/jit/issues/245).
Author: Claude Opus 5.5 (`claude-opus-5-5`), as the sole UI/UX designer required by S14-D14. Parent verification: orchestrator creation, completed-task metadata and read-only thread configuration confirm `effort: high`. The delegate saw an internal numeric value of 25; no mapping from that value is asserted. Date: 2026-10-30.
Interactive review artifact: [s14-bot-first-prototype.html](s14-bot-first-prototype.html). It runs on fixture data and connects to nothing.

Parent contract/factual review: [authority and design resolutions](../contracts/s14-authority-and-design-resolutions.md) resolves Q1–Q7 and P-E1–P-E3 without replacing the designer's UI/UX. In particular, model classification cannot mint a grant; existing forms can support script-free takeover; the visual OwnerStrip is not an authorization boundary. Parent rendered three sample states with `html_preview`; the original UI/UX is preserved. After Greptile review, the parent corrected prototype Bot/share bindings, interval derivation and overlay keyboard focus; these are logic/accessibility fixes to this design, not a new design.

## How to read this document

Each design statement carries one of three labels.

| Label | Meaning | Who can change it |
| --- | --- | --- |
| **R** | Required behavior, restated from S14, S09, S12, S13 or `docs/design/README.md`. The source is named. | The owner, through the spec |
| **P** | Designer proposal: a choice made here. It has not been confirmed by the owner. | Reviewer or owner; record the change here |
| **Q** | Open question for the contract or owner review. A default is given so that design work is not blocked. | Parent review, then the owner if needed |

The layouts, spacing, copy and flows below are **P** unless marked otherwise. The authority rules they express are **R**.

## 1. Design thesis

Jit stays a quiet chat. The new product idea is that a team works behind that chat, on the owner's own machine, and the owner can always answer three questions at a glance:

1. **Who is doing what right now?**
2. **What can they touch?**
3. **What needs me?**

Five rules follow from this (**P**), and every screen uses them.

| Rule | What it means on screen | Why |
| --- | --- | --- |
| **The owner strip** | A decision that changes authority appears only in a `surface-2` strip at the foot of a card, under a lock icon and the label "การตัดสินใจของคุณ" / "Your decision". Bot text, web text and reply chips never render there. | The owner learns one place where authority is spent. This communicates separation; authenticated server commands and current policy enforce it (S14-D04). |
| **Mono means exact** | JetBrains Mono shows only literal data: URLs, search queries, hashes, revision IDs and the exact payload of an action. Paraphrase is always sans. | "What exactly will be sent?" gets a visual answer. Reviewers can trust that mono text is not a summary. |
| **The dot is alive** | The จุดตั้งจิต above the mark is the one moving thing. Each Bot's tile carries the same dot. It breathes while that Bot works, and several breathe at once when work overlaps. | Concurrency reads calmly, and the identity rule "only the mark moves" still holds. |
| **Words first** | Every state is a word. Colour, pattern and motion only repeat it. | NFR-11 and README principle 4. |
| **Honest gaps** | "ไม่ทราบ" / "Unknown" is a normal display value. Missing usage, unknown outcomes, unread sources and future phases are shown and never rounded to a good-looking number. | S14-AC07, AC08 and the "unknown is not zero" rule. |

## 2. What stays and what changes

| Area | Decision | Label |
| --- | --- | --- |
| Monochrome tokens, no accent colour, Inter + Noto Sans Thai + JetBrains Mono, the mark, wordmark, voice | Unchanged | R (README, S09-D05/06/10/11) |
| Setup steps ตื่น → เชื่อมจิต → รู้จักกัน → นิสัยของจิต → ตั้งจิต | Kept at five steps. Readiness sits inside ตื่น and เชื่อมจิต rather than a new step. | R (S09-D07) + P |
| Answer first, one voice, quiet team, reply chips, queued messages | Unchanged | R (S12-D01/05/06/07/08) |
| Streaming draft and commit | Unchanged | R (STR01) |
| Attachment chips | Unchanged, except that the composer's project chip is gone | R (S13) + S14 |
| No-script forms and static-only PWA cache | Retained. Three narrow exceptions are proposed in section 11. | R, with P flagged |
| Sidebar project tree, General space, promotion cards | Removed. Conversations are a flat recent list. | R (S14-D01) |
| Composer project chip | Replaced by the "ถึง" / "To" chip. Default is Jit. | P |
| Right panel of five project tabs | Replaced by the work pane, which belongs to a work item. | P |
| Mobile drawer | Replaced by four bottom tabs | P (changes UX03; see section 8) |
| Team card | Becomes the work card with one line per Bot. It is still quiet by default. | P, keeps S12-D06 |
| Dispatch allowance per message | Replaced in the UI by the work grant's finite limits | R (S14-D05) + P |

## 3. Information architecture

Primary navigation has four areas plus chat (**P**). Nothing in it is a project or a folder.

```text
Jit
├─ Home: greeting, composer, waiting items, team now
├─ Chats (recent list; a chat grants nothing)
│   └─ Chat + work pane
│        ├─ Progress: timeline, lanes, usage
│        ├─ Report: revisions, citations, files
│        ├─ Evidence: queries, sources, what left the machine
│        ├─ Grant: exact command, Bots, tools, limits, stop and revoke
│        └─ Computer: browser view, lease, takeover
├─ Work: waiting on you / in progress / proposals and unstarted / finished and outputs
├─ Team
│   └─ Bot: overview / computer / files / memory
├─ Memory: shared / one tab per Bot
├─ Routines: routine, history, out-of-scope proposals
├─ Settings: web / readiness / capabilities / appearance
└─ Search (⌘K): work, reports, Bots, memory
```

Reports have no top-level destination. A report belongs to its work item, and Work's "finished and outputs" group plus ⌘K find it later. This keeps navigation at a size that fits mobile tabs. A library can be added when phase B and C outputs arrive.

Proposed routes, all server-rendered for no-script use:

| Route | Surface |
| --- | --- |
| `/` | Home |
| `/chats/:id` | Conversation |
| `/work`, `/work/:id?tab=progress\|report\|evidence\|grant\|computer` | Work list and full-page form of the pane |
| `/team`, `/team/:bot?tab=…` | Team and Bot profile |
| `/memory?scope=shared\|<bot>` | Memory |
| `/routines`, `/routines/:id` | Routines |
| `/settings/*` | Settings, keeping the `web.settings_ia/v1` pill pattern |
| `/recovery` | Post-restart reconciliation |

Route names are design intent. The application contract decides the final paths.

## 4. Layouts

### Desktop

Measured against the app's container width, not the window (**P**).

| Container width | Navigation | Conversation | Work pane |
| --- | --- | --- | --- |
| ≥ 1360 px | Sidebar 264 px | Fluid, text column up to 720 px | 520 px, in flow |
| 1040–1359 px, pane closed | Sidebar 264 px | Fluid | None |
| 1040–1359 px, pane open | Rail 64 px | Fluid | 520 px, in flow |
| 680–1039 px | Rail 64 px | Fluid | Overlay, up to 520 px, with a scrim and focus contained |
| < 680 px | Bottom tabs 56 px | Full width | Full-screen page |

The Computer tab widens the pane to 720 px when space allows, because a browser view is unreadable at 520 px with long URLs.

Shell: header 56 px with 24 px side padding. Page column padding 24 px. Stacks use 8, 12, 16 and 24 px gaps. Cards use 16 px padding and the work card uses 12–14 px. Home starts its content 12 vh from the top.

### Mobile (360–430 px)

- Bottom tabs: แชต, งาน, ทีม, เพิ่มเติม. The Work tab carries a count. "เพิ่มเติม" holds Memory, Routines and Settings.
- Inside a conversation, tabs hide and the composer docks at the bottom, because the keyboard needs the height.
- Home places the composer low, within thumb reach. The greeting compresses to 24 px.
- The pane is a full-screen page with a close button, and the header back button returns to the previous level.
- Sheets rise from the bottom at up to 92% height.
- Tap targets are at least 44 px for buttons and icon buttons. Compact buttons are 40 px with spacing around them.
- Respect every safe-area inset (R, UX03). No page scrolls sideways at 360, 390 or 430 px (R, UX03). Tabs and code-like blocks scroll within their own box.

## 5. Flows

Each flow names its prototype scene. "Owner command" means an authenticated request; prototype buttons only simulate one.

### F1. Setup and readiness (`wake`–`set`, `legacy`, `first`)

1. **ตื่น:** the mark, one sentence and an automatic host check. Each row is a fact with a state in words. A warning that doesn't block use does not block Continue.
2. **เชื่อมจิต:** device code for the model route (R, S12-D10), then Parallel readiness. The row says three things plainly: no key is needed, queries and URLs go to Parallel, and free use has limits.
3. **รู้จักกัน** and **นิสัยของจิต:** unchanged. The second can be skipped.
4. **ตั้งจิต:** the 1.6 s ceremony (R), then a summary of the route, web source and team.

A fixture or unproven check must read "unverified", never "verified" (R, BOT02). Concurrency capacity reads "known after the first real run" until it is measured.

**Earlier data (R, S14-AC01):** a dedicated page says data was found, gives counts and location, and states that nothing moved or changed. The two actions are "Start fresh in a separate store" and "How to go back". There is no delete control on this page.

**After setup:** Home has one composer and two example commands. Pressing an example fills the composer and turns on "สั่งเป็นงาน". It does not send, so an example can't start work by itself.

### F2. Starting work (`ask`, `command`, `running`)

Three intake outcomes share one visual language.

| Owner does | Result | Label |
| --- | --- | --- |
| Turns on "สั่งเป็นงาน" and sends, or sends a clear command | Work and grant commit together. Jit posts one line and a work card. There is no second confirmation. | R (S14-D04), chip is P |
| Sends a question or an ambiguous request | Jit answers. Under the answer, a small card offers "เริ่มเป็นงาน". Nothing has started. | R (S12-D01) + P |
| Accepts a Bot's suggestion | The task is accepted and does not run. "เริ่มงานนี้" is a separate press (F5). | R (S14-AC03) |

The "สั่งเป็นงาน" chip works like the search mode chips owners know from Grok. When on, the composer shows the default limits in one line with an "ปรับ" link. The owner sees the budget before sending without any extra step. **Q1** covers how plain typed commands are recognised.

The work card shows: title, state word, receipt line ("เริ่มจากคำสั่งของคุณ · wk-0418 · g1"), one line per Bot, and Open progress, Stop work. The card makes immediate start inspectable: the receipt and the Stop button are visible right away. Grant validation and fencing remain server-side requirements.

A duplicate submit returns the same receipt and the same card (R, S14-AC03).

### F3. Delegation and concurrent progress (`running`, `queued`, `sibling`)

Jit decides who works, inside the grant. The pane's Progress tab has four parts.

1. **Headline:** "2 บอทกำลังทำพร้อมกัน · เพดาน 2 · 1 รอคิว". The limit is always next to the count, so a queue doesn't look like a fault.
2. **Timeline:** one thin track per Bot on a shared minute axis, showing intervals that really ran. This is the visual form of S14-AC04: overlap means real overlap. Encoding uses no hue except failure: solid is running, outline is queued, hatch is waiting, and a `--danger` mark with a text label is failure. A legend and "ดูเป็นตาราง" are always present. Text-only view is first-class. Draw bars from recorded run intervals only, never from estimates.
3. **Lanes:** Bot tile, name, state word, one plain line, the exact current query or URL in mono, reads done, and what it received from Jit ("รับจากจิต: คำสั่งของคุณ · ความจำกลาง 2 ข้อ"). Actions: View computer, Stop this Bot.
4. **Usage:** meters for time and reads against grant limits, each with words. "ใกล้เพดาน" appears at 80%. Unknown usage shows a hatched bar and "ไม่ทราบ", never 0.

Waiting has distinct words because the fixes differ:

| Word | Means |
| --- | --- |
| รอคิว / Queued | A ceiling holds it, and the lane names which one. It will start on its own. |
| รอหลักฐาน / Waiting for evidence | A dependency hasn't committed. |
| รอคุณ / Needs you | Nothing moves until the owner acts. |

**Sibling failure (R, S14-AC04):** the failed lane says so, the banner confirms the other Bot's evidence is safe, and the eventual report is labelled ได้บางส่วน.

### F4. Stopping (`stopping`, `stopped`)

"หยุดงาน" takes effect at once with no confirmation, because stopping is the safe direction. It shows "กำลังหยุด" until open calls settle, since a stop request doesn't prove the old call ended (R, S14 failure rules). Then it shows "หยุดแล้ว". Late results are never published. Evidence is kept, and Jit offers "ทำรายงานจากหลักฐานที่มี". Stopping one Bot works the same way at lane level.

### F5. Direct Bot work and Bot suggestions (`task`)

The "ถึง" chip or the Bot page's "สั่งโดยตรง" opens a chat with that Bot. A banner says the chat grants nothing extra and the Bot uses only its own things. Direct work has its own receipt.

A Bot's suggestion is a card showing "ข้อเสนอจากบอท ฉบับ r1 · ยังไม่มีผลใดๆ":

```text
Proposed      [Accept as a task] [Dismiss]
Accepted      [Start this work] [Make it a routine]   "Nothing is running."
Started       "Started from your command · grant g1"
```

There is deliberately no "Accept and start" button. Merging them would blur S14-AC03, and two presses here cost little because suggestions are not urgent.

### F6. Permanent Bot proposal (`botProposal`)

The card is a contract, not a chat message: exact revision, author, duty, web, computer, logins, memory, route and a diff against the previous revision. What it does *not* get is stated too (logins: none).

| State | Behavior |
| --- | --- |
| Open | "สร้างบอทตามฉบับ r2", Edit, Dismiss. The revision is in the button label. |
| Edited | A new revision. The old card closes. |
| Stale | Marked "ไม่ใช่ฉบับล่าสุด". The create button is disabled, and the service still refuses a stale post (R, S14-AC02). |
| Accepted | The Bot now exists, with no work or files. |
| Injected text | Shown in the untrusted frame with no controls, and the page explains why. Web content can't make a card. |

### F7. Work grant (`grant`)

The Grant tab answers "what can they touch?" in the same order every time: exact command in mono, grant revision and expiry, Bots, tools, outbound data, external actions, limits. The owner strip offers Adjust limits and Stop and revoke. Reducing is immediate. Raising creates a new grant revision. A Bot can't raise anything; it can only ask in words.

### F8. Cited report and download (`partial`, `complete`, `evidence`)

- The first revision may publish early as ได้บางส่วน once evidence is committed. Later revisions don't overwrite it, and older revisions stay readable (R, S14-AC08).
- The final state word is **พร้อมตรวจ / Ready for review**. The UI doesn't use "Complete", since the owner closes the work and gaps may remain.
- Under the title, a coverage block states what's covered and what's missing. It is above the fold so that a reader can't miss it.
- Each claim carries citation chips. A claim with a weakness carries a text flag: ราคาจาก cache, แหล่งขัดกัน, เห็นแค่ตัวอย่าง, ไม่มีหลักฐาน or ข้อสันนิษฐาน.
- Conflicts show both values with their sources. The UI doesn't pick one.
- A citation opens that exact source row in Evidence.
- Each file row shows name, type, size and hash in mono. Download is available for both `report-*.md` and `evidence-*.json`.

Evidence starts with what left the machine ("ออกนอกเครื่อง: 4 คำค้น · 6 URL") and the exact queries. Each source row shows mode (อ่านทั้งหน้า, จาก cache, เห็นแค่ตัวอย่าง, อ่านไม่ได้ · 403), retrieval time, Bot and freshness. Unknown freshness says unknown. Quoted text sits in the untrusted frame.

### F9. Exact-action approval (`approval`)

The approval slip uses a `--warn` border and states, in order: who asks, what kind of action, that it can't be undone, the exact content in mono, revision + hash, single use, and expiry.

- The approve label names the action and count: "ส่งคำขอนี้ 1 ครั้ง". There is no "Allow always" (R, S14-D04; approvals are single-use).
- When the owner opens a slip from Work or a notification, focus lands on the slip heading, not on Approve. Enter on arrival must not approve anything. A slip that arrives while the owner is reading or typing never takes focus.
- On mobile the exact content sits above the buttons, so it can't be skipped by scrolling.
- States: pending, sending, done, denied, expired, changed. Changed closes the old slip, shows the diff and links to the new revision.
- Takeover never releases a pending slip (F11).

Only the system creates this card, so a page can't fake it: Bot and web text have no way to render into an owner strip.

### F10. Unknown outcome (`unknown`, `recovery`)

The slip turns `--danger`, with the word "ไม่ทราบผล". It states what happened and that Jit will not resend. The owner strip offers "เปิดเบราว์เซอร์เพื่อตรวจ", "ส่งถึงแล้ว" and "ไม่ได้ส่ง". Either answer is a record, not a retry. Sending again requires a new approval (R, S14-AC09). "ลองใหม่" is deliberately absent from this card.

### F11. Browser view and takeover (`computer`)

The lease bar sits above the screen and always answers who is driving.

| Lease | Words | Action | Screen |
| --- | --- | --- | --- |
| Bot driving | "นักค้นคุมอยู่" | คุมเอง | View only, labelled Bot cursor |
| Sign-in wall | "นักค้นติดหน้าเข้าสู่ระบบ" | คุมเอง (primary) | Waiting |
| Owner driving | "คุณคุมอยู่ นักค้นส่งคำสั่งไม่ได้" | คืนให้นักค้น | 2 px `--fg` outline around the screen |
| Nobody | "ไม่มีใครคุม" | คุมเอง | Idle |

The outline is the takeover signal, so it reads without colour. A held submit shows "การส่งแบบฟอร์มที่ค้างยังไม่ถูกอนุมัติ" during takeover. Handing back returns it to its approval slip (R, S14-AC12). The action log beside the view lists opened pages and screenshots with times.

### F12. Explicit sharing and memory (`share`, `memory`)

**Sharing** starts from a file row. The sheet names the exact snapshot (file, revision, size, hash), the receiver and the scope, then says what isn't shared: other files, logins, memory and later edits. The default scope is the current work. Revocation shows "สิ่งที่อ่านไปแล้วเรียกคืนไม่ได้", as S14-AC05 requires.

**Memory** has one tab for shared memory and one per Bot, so the private boundary is the navigation. Each claim shows the text, ข้อเท็จจริง or ข้อสันนิษฐาน, the source and revision, and Correct / Forget. A private claim can be moved to shared only by the owner, through a sheet that states every Bot will see it. Forget opens a lineage preview listing the new-work context, reports and sessions affected, and states that data already sent out can't be recalled.

### F13. Routines (`routines`)

A routine is an authorization form written as sentences: what, when with timezone, which Bot, per-run limit, what happens if the host was off, and what happens with out-of-scope findings. The last row is fixed text: proposed to you, never run.

History shows every run, including quiet ones. Quiet runs say "เงียบ ไม่แจ้งเตือน" and create no notification (R, S14-AC10). Failures are visible and notified. An out-of-scope finding is a proposal slip with the same accept-is-not-start rule as F5.

### F14. Quota, provider failure and recovery (`rate`, `quota`, `recovery`, `web`)

Failure banners name the cause, what Jit will not do, and the owner's options.

- **Parallel rate limit:** "ลองใหม่ตอนนี้", "ทำรายงานจากที่มี", "ดูตัวเลือกบัญชี Parallel". If the service gave no reset time, the banner says so and shows no countdown.
- **Route quota:** the same structure. "เลือก route อื่นสำหรับงานนี้" is an owner choice for this work only.
- **Paid Parallel:** only in Settings, behind a sheet with an explicit cost acknowledgement. The enable button stays disabled until it is ticked. Paid mode is shown as a permanent state on the settings card.
- **Recovery:** after a restart, `/recovery` groups each open step by outcome and gives a plain reason: resumed safely, old session not confirmed closed, budget used up, or outcome unknown. Only `replay_safe` steps show "ทำต่อแล้ว" (R, S14-AC11).
- **Capabilities:** Settings › Capabilities lists phases A, B and C. B and C are "ต้องมีแน่ ยังไม่พร้อม" with no usable controls (R, brief).

## 6. State vocabulary

The UI uses one word for each state in all surfaces (**P**; states map to ADR 0045 where a state exists there).

| Key | ไทย | English | Pill | Bot dot |
| --- | --- | --- | --- | --- |
| proposed | ข้อเสนอ | Proposed | strong outline | none |
| accepted | รับแล้ว ยังไม่เริ่ม | Accepted, not started | neutral | none |
| queued | รอคิว | Queued | neutral | hollow |
| blocked | ติดขัด | Blocked | `--warn`, ! | `--warn` |
| waiting for evidence | รอหลักฐาน | Waiting for evidence | neutral | hollow |
| working | กำลังทำ | Working | strong outline | solid, breathing |
| waiting | รอคุณ | Needs you | `--warn`, ! | `--warn` |
| ready | พร้อมตรวจ | Ready for review | `--ok`, ✓ | `--ok` |
| partial | ได้บางส่วน | Partial | `--warn`, ! | none |
| failed | ไม่สำเร็จ | Failed | `--danger`, × | `--danger` |
| stopping | กำลังหยุด | Stopping | neutral | hollow |
| stopped | หยุดแล้ว | Stopped | neutral | none |
| unknown | ไม่ทราบผล | Outcome unknown | `--danger`, ? | `--danger` |

## 7. Components

```text
Shell
├─ Nav: Sidebar | Rail | BottomTabs
├─ Header
├─ Main
│   ├─ Composer > ToChip, ModeChip, BudgetLine, AttachButton, SendButton
│   ├─ Thread > OwnerBubble, BotMessage, ReplyChips
│   ├─ WorkCard > Receipt, MiniLane, Actions
│   ├─ Slip (approval, Bot proposal, task proposal) > Header, ExactBlock, MetaLine, OwnerStrip
│   ├─ ReportCard
│   └─ Banner (neutral, warn, danger)
├─ WorkPane > Tabs
│   ├─ Progress > Timeline, Lane, Meter
│   ├─ Report > CoverageBlock, Citation, Flag, FileRow
│   ├─ Evidence > OutboundSummary, SourceRow, UntrustedFrame
│   ├─ Grant > KeyValues, OwnerStrip
│   └─ Computer > LeaseBar, ScreenView, ActionLog
├─ Sheet (dialog on desktop, bottom sheet on mobile)
├─ CommandPalette, Toast
└─ Setup > StepList, ReadinessRow, DeviceCode, Ceremony
```

| Component | Key rule |
| --- | --- |
| BotTile | Rounded square with a 26% corner radius, echoing the mark's head. One grapheme (ค, ท, ต or Latin initial). 6 px dot floats 8 px above. Sizes 22, 32, 56 px. Tiles are `surface-3`, never hued. Jit alone uses the real mark. |
| OwnerStrip | The only host for authority buttons. Rendered from typed system data, never from Markdown or model text. |
| ExactBlock | `surface-2`, 1 px `--line`, mono 13 px, `pre-wrap`, never truncated. Content that exceeds the viewport scrolls inside the page, not inside a clipped box. |
| UntrustedFrame | 2 px `--line-strong` left rule, `surface-2`, label "ข้อมูลจากแหล่งภายนอก ไม่ใช่คำสั่ง". Plain text only: no links activated and no Markdown rendering of remote content. |
| Timeline | 12 px track, 4 px rounded data ends, recessive 1 px centre line and axis. One "now" hairline. `aria-hidden`, because the table carries the same data. |
| Meter | 6 px bar with a text value. Never shown without the words. |
| Pill | Transparent background, always text. Semantic colour only on text and icon (R, README). |

## 8. Visual system

**Tokens (R):** use `ui.design_tokens/v1` from `src/web-design.ts` unchanged. S14 adds no colours. Derived values are `color-mix` borders that carry no text: `--warn-line`, `--danger-line` and `--ok-line` (the existing README allows derived status borders). `--line-strong` is reused.

Proposed additions to `scaleTokens` (**P**):

| Token | Value | Use |
| --- | --- | --- |
| `--nav-w` | 264 px | Sidebar |
| `--rail-w` | 64 px | Rail |
| `--pane-w` | 520 px | Work pane |
| `--pane-wide` | 720 px | Computer tab |
| `--hatch` | 135°, 2 px stripe, 3 px gap, `--fg-3` | Waiting and unknown marks |

**Contrast:** text uses only existing tested pairs. One pair needs care: `--fg-3` on `--surface-3` is 4.38:1 dark and 4.47:1 light, below AA, so hover states switch secondary text to `--fg-2`. The prototype does this; the implementation must keep it.

**Type (R):** 12, 13, 14, 15, 16, 18, 24 and 32 px at weights 400, 500 and 600. Chat body 15/1.7. Mono 13, or 12 inside meta lines. Thai never gets negative tracking below 24 px.

**Radius (R):** 8 control, 14 card, 24 composer, pill. **Motion (R):** 160 ms UI, 240 ms panels, 4.8 s breath, 1.6 s ceremony. Nothing else moves. Progress changes aren't animated, so the timeline stays calm.

**Borders as hierarchy (P):** a normal card has `--line`. An interactive work card has `--line-strong`. A pending decision has `--warn-line`. An unknown outcome has `--danger-line`. A closed slip returns to `--line-strong`, so old cards recede in a long chat.

## 9. Accessibility

- All of the existing a11y fixture rules apply: skip link, one `main`, `lang`, zoom, names, focus ring, reduced motion (R).
- **Live updates:** one polite line per phase change, such as "สถานะงาน: รอคุณ". Timeline and read counters are never announced per tick (R pattern, STR01).
- **Focus:** on route change, focus the page heading. On opening a sheet, focus its first field. On closing, return to the opener. Overlay pane and sheets keep the background inert. Esc closes the top layer.
- **Tabs:** arrow keys move between tabs, with one tab stop.
- **Timeline:** the graphic is hidden from assistive technology and "ดูเป็นตาราง" carries the data.
- **Approval:** the slip is a named region. Announce arrival politely once. Never move focus to it uninvited while the owner is typing.
- **Forced colours:** running and failed bars become `CanvasText`. Queued and waiting keep their patterns.
- **Reduced motion:** dots are static, and the ceremony shows its final frame. Static dots still have words.
- **Browser view:** provide a text description (page title and URL) as the image alternative, and the action log as the readable record. Real interactive takeover has known limits for screen readers; see Q5.
- **Thai:** don't truncate mid-word in important copy. Lane lines may ellipsize only when the full text exists in the pane.

## 10. Copy

Voice stays short and calm, and errors name the next action (R, README). "จิต" is the Thai name in prose. The wordmark stays Latin.

| Term | ไทย | English | Avoid |
| --- | --- | --- | --- |
| Bot / team | บอท / ทีม | Bot / team | เอเจนต์, specialist |
| Work item | งาน | Work | โปรเจกต์, job, task (in the UI) |
| Grant | ขอบเขต | Grant | สิทธิ์ถาวร, permission |
| External effect | การกระทำภายนอก | External action | effect |
| Approval | อนุมัติ | Approve | ยอมรับ (reserved for tasks) |
| Accept a task | รับไว้เป็นงาน | Accept as a task | เริ่ม, อนุมัติ |
| Takeover | คุมเอง / คืนให้… | Take over / Hand back | รีโมต |
| Report / file | รายงาน / ไฟล์ | Report / file | artifact (in the UI) |
| Shared memory | ความจำกลาง | Shared memory | ความจำทีม |
| Fact / inference | ข้อเท็จจริง / ข้อสันนิษฐาน | Fact / Inference | ความเชื่อ, ความมั่นใจ % |
| Routine | กิจวัตร | Routine | automation, cron |
| Unknown | ไม่ทราบ | Unknown | 0, —, N/A |

| Moment | ไทย | English |
| --- | --- | --- |
| Composer | พิมพ์ถึงจิตได้เลย… | Message Jit… |
| Work chip | สั่งเป็นงาน | Run as work |
| Start notice | เริ่มทันทีเมื่อส่ง | Starts as soon as you send |
| Receipt | เริ่มจากคำสั่งของคุณ | Started from your command |
| Ask-first card | อยากให้ค้นจริงและทำรายงานไหม | Want this researched into a report? |
| Stopping | คำสั่งหยุดส่งแล้ว แต่ยังไม่นับว่าหยุดจนกว่าการเรียกที่ค้างจะจบจริง | The stop request went out, but work only counts as stopped once open calls settle. |
| Partial | ได้รายงานบางส่วนแล้ว ส่วนที่ขาดระบุไว้ในรายงาน | The partial report is ready. It lists what's missing. |
| Approve button | ส่งคำขอนี้ 1 ครั้ง | Send this once |
| Unknown | การเชื่อมต่อหลุดระหว่างส่ง ระบบไม่รู้ว่าเว็บได้รับหรือยัง จึงไม่ส่งซ้ำเอง | The connection dropped mid-send. Jit can't tell whether the site received it, so it won't resend. |
| Takeover | คุณคุมอยู่ · นักค้นส่งคำสั่งไม่ได้จนกว่าคุณจะคืน | You're driving · Scout can't send input until you hand back |
| Share limit | แชร์เฉพาะ snapshot นี้ | Only this snapshot is shared |
| Revoke | นักเทียบใช้ snapshot นี้ต่อไม่ได้ แต่สิ่งที่อ่านไปแล้วเรียกคืนไม่ได้ | Analyst can't use this snapshot any more, but what it already read can't be recalled. |
| Rate limit | โหมดไม่ใช้ key ถึงเพดานชั่วคราว ระบบไม่ได้บอกเวลาที่จะใช้ได้อีก จิตไม่เปลี่ยนผู้ให้บริการหรือเปิดบัญชีให้เอง | The no-key mode hit a temporary limit. The service didn't say when it resets. Jit won't change provider or turn on an account for you. |
| Quiet routine | เงียบ ไม่แจ้งเตือน | Quiet, no notification |
| Future phase | ต้องมีแน่ ยังไม่พร้อม | Required, not ready |

Thai and English keys go through `ui.i18n_dictionary/v1`. The prototype's inline pairs are only a review convenience.

## 11. Progressive enhancement and PWA

The existing policy stays (R, S09-D01, ADR 0028). No framework or build step is introduced. The prototype's inline script and styles exist only because it's a single review file. The app keeps its CSP and hashed external assets.

| Surface | With script | Without script |
| --- | --- | --- |
| Composer, chips, proposals, approval, share, memory, routine, grant | Enhanced in place | Plain form posts with revision fields |
| Work pane | Side pane | `/work/:id?tab=…` full page |
| Progress | SSE updates | Current state on load, with a refresh link |
| Timeline | Rendered from intervals | Server-rendered with CSS widths, and the table |
| Citations | Open Evidence in the pane | Links to `/work/:id?tab=evidence#source-n` |
| Takeover and stop | Live | Stop is a form post. Takeover: see below |
| Sheets and ⌘K | Dialog | Own page |

**Proposals needing owner review (not assumed):**

| ID | Proposal | Reason |
| --- | --- | --- |
| P-E1 | Designer initially proposed script-required takeover. Parent contract review retains the existing no-script form path; enhanced live interaction remains optional. | ADR 0039 uses image-coordinate, text and key forms. The earlier claim that forms cannot forward input was incorrect. |
| P-E2 | A live browser view stream may need a same-origin `img`/SSE or `WebSocket`/WebRTC transport. It needs a CSP change only if the chosen transport requires one. | The transport isn't chosen. The design doesn't depend on which is used. |
| P-E3 | Bottom tabs replace the `:target` drawer below 680 px. | Work needs one-tap reach with a badge. The tabs are plain links, so no-script behavior improves. It changes the UX03 contract and its snapshots. |

**PWA (R):** the service worker still caches only the static allowlist. Reports, artifacts, screenshots, chats and memory are never cached. Offline shows the browser's page. The report file is an authenticated `private, no-store` download. A browser view frame is sensitive and must follow the same rule.

## 12. Implementation handoff

### Data the UI needs

The contract review decides shapes; this list says what must be available, by surface.

| Surface | Fields |
| --- | --- |
| Work card | work ID, title, state, receipt, grant revision, per-Bot state + plain line |
| Timeline | per-step recorded `start`, `end`, kind (run, queued, waiting, failed) |
| Lane | current exact query or URL, reads, handoff summary (labels only), capabilities for Stop and View |
| Usage | limit, used, or explicit unknown; reservation state |
| Report | revision list, state, coverage items, claims with source refs and flags, files with name/type/size/hash |
| Evidence | outbound count and exact text, per-source mode, final URL, retrieval time, provider mode, freshness or unknown |
| Approval | action class, exact display text, destination, revision, hash, expiry, state, requester Bot |
| Lease | driver, Bot, generation, pending-held effect |
| Share | snapshot ID, file revision, hash, size, receiver, scope, state |
| Memory | claim, status, scope, origin, source revision, lineage preview |
| Routine | captured purpose, schedule + timezone, Bot, limits, misfire policy, runs with typed outcomes |
| Recovery | step, replay class, plain reason code, available owner actions |

### Slices

| Ticket | Design scope |
| --- | --- |
| BOT14-01 | Setup, earlier-data page, Home, chat without project, Bot proposal, Team |
| AUTH14-01 | Composer chip, intake outcomes, work card, grant tab, accept-is-not-start, approval and unknown slips |
| BOX14-01 | Bot profile computer tab, lease bar, screen view, takeover |
| SHARE14-01 | Files tab, share sheet, revoke |
| MEM14-01 | Memory page, correct, forget preview, move to shared |
| WEB14-01 | Evidence tab, web settings, rate-limit banner |
| TEAM14-01 | Progress tab, timeline, lanes, usage, sibling failure |
| REPORT14-01 | Report tab, revisions, coverage, citations, files |
| REC14-01 | Recovery page and banners |
| ROUT14-01 | Routines |

### Rules that must survive implementation

1. Authority buttons render only from typed server data inside OwnerStrip.
2. Every authority post carries the exact revision, and the server rechecks it. A disabled button is only a courtesy.
3. Never render remote content as HTML or Markdown. Keep the untrusted frame.
4. Never show 0 for unknown, or "complete" for a report with declared gaps.
5. Takeover state must come from the lease, not from local UI state.
6. Reply chips never appear beside an open slip (R, S12).
7. Keep literal values in `src/web-design.ts`, as `ui.token_lint/v1` requires. The prototype's small inline styles aren't a precedent.
8. Add the S14 pages to the a11y and responsive fixtures at 360, 390, 430 and 1280 px, in both themes and languages.

### Open questions

| ID | Question | Design default |
| --- | --- | --- |
| Q1 | Can a typed, classified command create a grant, or must a deterministic signal exist (the chip, `@Bot`)? A model classifier deciding authority needs review against "models may narrow but never widen". | Design supports both. If classification may not grant, plain text falls to the "เริ่มเป็นงาน" card, and no screen changes. |
| Q2 | Default limits (3 Bots, 2 at once, 30 min, 40 reads) are fixture values. | Host-derived defaults, per S12-D13 |
| Q3 | Which browser actions classify as external effects in phase A? The quote form is a fixture example. | Unknown classes ask or refuse, per ADR 0046 |
| Q4 | Does Jit itself have a computer? | Design says no: Jit coordinates, and computers belong to working Bots |
| Q5 | How accessible can live takeover be? Screen-reader users may not be able to drive a pixel view. | Keep the log and owner help. Record real evidence before claiming support. |
| Q6 | Should Stop-and-revoke differ from Stop? | One owner action in the grant tab: stops the work and revokes the grant |
| Q7 | Retiring or deleting a Bot, and editing its capabilities, aren't in the prototype. | Preview → confirm per the lifecycle rule; widening uses a new revision |

## 13. Reference ideas

| Source | Taken as an idea | Deliberately not taken |
| --- | --- | --- |
| [CopilotKit/OpenBot](https://github.com/CopilotKit/OpenBot) (MIT) | Each Bot has its own browser and files; "waiting on you"; take control in the same panel; Bot actions refused while you drive | Shared per-person container as the default, admin surfaces, multi-tenant screens, always-allow |
| [CopilotKit/OpenDuet](https://github.com/CopilotKit/OpenDuet) (MIT) | Show exactly what will happen and wait; tappable answers; suggested tasks with explicit Start; task grouping by who is needed | "Always allow" on approvals; morning brief as a first-run promise while phase C isn't ready |
| Grok | One composer, one voice, mode chip near the send button | Hidden background work |

No code, assets or wording were copied from these projects. Both were read through their public repository pages only.

## 14. Prototype guide

Open [s14-bot-first-prototype.html](s14-bot-first-prototype.html) as a file. The top bar is review tooling, not product UI. It holds the permanent "prototype · fixture data" label, the scene list with previous/next, language, theme, device width, per-scene state switches and simulation controls. `[` and `]` change scene. `#scene=running&lang=en&theme=light&device=mobile` opens a specific view.

The prototype embeds subsets of the self-hosted fonts, so it needs no network. Its model names, sites, prices and hashes are invented. It accepts no passwords, keys or files, downloads nothing, and doesn't simulate real authority.

| Brief item | Scenes | S14 cases |
| --- | --- | --- |
| Setup and readiness | `wake`, `connect`, `know`, `habit`, `set`, `legacy`, `first` | AC01, AC14 |
| First useful research | `first`, `command`, `running` | AC03, AC07 |
| Direct Bot work | `task` | AC03 |
| Bot proposal and grants | `botProposal`, `grant` | AC02, AC03 |
| Delegation, concurrency, cancel | `running`, `queued`, `sibling`, `stopping`, `stopped` | AC04, AC12 |
| Cited partial and complete report, download | `partial`, `complete`, `evidence` | AC08 |
| Exact approval and unknown effect | `approval`, `unknown` | AC09 |
| Browser view and takeover | `computer` | AC12 |
| Explicit sharing and memory | `share`, `memory` | AC05, AC06 |
| Routines | `routines` | AC10 |
| Quota, provider failure, recovery | `rate`, `quota`, `recovery`, `web` | AC07, AC11 |
| Honest future phases | `phases`, Bot overview, `routines` | D09 |
| Mobile, light, English | Device, theme and language controls on every scene | AC13 |

## 15. Verification and limits

Checks run on the prototype without a browser:

- `node --check` on the combined script.
- A scripted DOM pass with `happy-dom`: 34 scenes across both languages and themes plus every state variant (228 renders) and about 5,500 control activations. It found no raw `null`/`undefined` text, duplicate IDs, dangling ARIA references, unnamed buttons, unlabelled fields, missing action handlers, classes without CSS, or Thai text in English renders.
- All 639 text pairs have both languages.
- No external URL, `link`, `img`, `fetch`, `WebSocket` or similar reference exists in the file.
- Contrast was calculated for the text pairs that the prototype uses.

**Designer verification limit:** the designer did not render the prototype in a real browser; `happy-dom` does not evaluate actual layout. Parent subsequently rendered three sample states with `html_preview`: initial Thai/dark at 728 px, concurrent progress at 728 px and English/light report at 390 px, with no console messages. This is sample visual QA, not verification of every scene, container query, overflow, Thai line break or animation. Keyboard/focus was only partly exercised. No screen reader or real device has been used.

**Limits of the prototype:** timeline marks have no hover tooltip; the table carries that detail. Keyboard ↑ ↓ in the ⌘K list, slip focus on arrival, attachments, and Bot retire and edit flows aren't built. Mobile mode simulates width, not touch input or safe areas.

## 16. Product implementation refinements (BOT14-01, AUTH14-01)

Author: Claude Opus 5.5 (`claude-opus-5-5`), requested at effort high; the session also showed an internal numeric value of 25, and no mapping from it is asserted. Date: 2026-10-30. Code: `src/s14/web-pages.ts`, `web-style.ts`, `web-enhance.js`, `web-product.ts`, `web-refusal.ts`.

Real states required these changes to sections 1–12. Each is **P** and changes only the presentation of data the seam already has.

| Area | Change | Why |
| --- | --- | --- |
| `blocked` word | Now ติดขัด / Blocked with `--warn`, its reason and "will not restart by itself". รอหลักฐาน stays reserved for a real evidence dependency, which the seam does not emit yet. | The seam's `blocked` means halted with a reason and nothing will resume, so "waiting" would be false. |
| Pane below 1040 px | Replaces the conversation as a full page. No overlay, scrim or focus containment. | One server-rendered link works without script at every width, and there is no background to make inert. |
| Work pane tabs | Plain links, Progress and Grant only. Arrow-key tabs are not used. | The other tabs have no data in this slice, and links keep one no-script path. |
| Setup | Three steps: ตื่น, รู้จักกัน, ตั้งจิต. One form asks only name and language; a single route is inferred and several become a choice. | The seam has no device-code or persona step. |
| Composer limits | Always-visible editable numbers instead of one line plus "ปรับ". | Without script a summary line could disagree with edited values. |
| Concurrency limit | The editable value caps how many Bots the grant names, and a note says this build runs one at a time. | `WorkLimits` has no concurrency field, so the value cannot be pinned in the grant. It must not read as an enforced runtime limit. |
| Reads limit | "40 reads" maps to `limits.calls`; attempts and steps equal the number of named Bots; output is a fixed 256 KiB. | The owner never sizes internals. |
| To chip | A link to Team naming the current Bot. | The seam has one conversation per Bot and no create command. |
| Ask-first card | A chip linking to the composer prefilled with the owner's message and work mode on. | It starts nothing. It sits only on the last reply and never beside an open slip (rule 6). |
| Stale proposal | Earlier revisions appear as a closed list marked ไม่ใช่ฉบับล่าสุด, with no disabled button. | The current card is always the only one with controls. A stale tab is refused by the service and lands on a page linking the latest revision. |
| Approval without an adapter | `supported: false` hides Approve and keeps Deny, with the reason in words. | Approving could never send. The service check remains the boundary. |
| Unknown outcome | No "It arrived" or "It did not arrive" buttons. The card says the owner must check the destination and that this build cannot record the finding. | The seam has no reconcile command. A control that records nothing would be false. |
| Task suggestion | No Dismiss. | The seam has no task rejection command. |
| Task accepted | The start form sits in the same slip under a "Not started" banner, with its own limits. | Acceptance and start stay visibly separate presses. |
| Refused posts | A refused composer re-renders with the text kept. Credential-shaped text is not echoed back. Other refusals land on a page with the cause and one way forward. | A stale revision must not cost the owner their typing. |
| Refusal page | Explains after the CLI refusal when run with `--refusal-page`, shows the file name only, and has no counts. | It runs with no store open, unauthenticated, and has no form. Counts would need opening a legacy store. |
| Theme and language | Theme follows the system. Language is chosen in setup. | The seam has no preference command. |

**Q2 update:** the owner confirmed research defaults of 2 concurrent Bots, 30 minutes and 40 reads per work item on 2026-10-30, shown as editable values.

**Verification:** rendering and form-contract tests in `tests/s14-web-ui.test.ts`. A real headless Chromium run covered the no-script journey (sign-in, setup, chat, proposal, task, start, stop) with real form posts, every approval state, and layouts at 360, 390, 430, 820, 1100, 1280 and 1400 px in both themes. No real phone, Safari, Firefox, screen reader or live model route has been used.

## 17. Product implementation refinements (MEM14-01, WEB14-01)

Author: Claude Opus 5.5 (`claude-opus-5-5`), requested at effort high. Date: 2026-10-30. Code: `src/s14/web-memory.ts`, `web-research.ts`, `web-product-memory.ts`, `web-style-memory.ts`.

Each change below is **P**. Memory and web authority stay in the existing typed commands.

| Area | Change | Why |
| --- | --- | --- |
| Memory default | `/memory` opens the Jit tab, with Shared last. | Everything starts private, so Shared would usually open empty. |
| Sheets | Correct, Forget, Delete, Publish, Revoke and Share are own pages with a `?action=` preview. | One no-script path, as section 11 already allows. A preview is a read. |
| Forget and Delete | Two fixed lists, "What this does" and "What this cannot reach", then the live impact. The lists name provider copies, session history on disk, outside backups and the absence of undo. | The owner decides on what the command reaches, not on a reassuring sentence. |
| Impact | Counts for memories, originals, contexts and work, with readable text for dependents and links to affected work. Contexts are checked for a work name up to 64, and the remainder is counted. | `MemoryImpact` returns IDs. Work is resolved through the existing context query. |
| Withdrawn | A separate section with a word per case: deleted, forgotten, corrected, withdrawn or unavailable. Delete stays reachable after Forget. | A vanished row would hide what happened. |
| Gone source | Originals and claim pages explain that the text is gone. A deleted chat message reads as deleted rather than showing `[deleted]`. | The seam nulls the text, and the owner needs the reason. |
| Originals | A collapsed list that links to a page per source. | Every chat message is a source, so rendering all text would make Memory very long. |
| Fact wording | A permanent note says a fact is what the owner said, not something checked. | The contract says a fact proves a statement, not truth. |
| Decisions | No key field: a new decision gets a generated key. Editing shows the next revision. The page says decisions can't be removed yet. | The owner never names internals, and the seam has no removal command. |
| Share | One radio list of Bot and scope pairs. With no eligible scope the page explains and offers no control. | A dependent second select needs script. Production policy currently has no resources. |
| Evidence tab | Added between Progress and Grant. A rollup, an exact sent list, then one card per read and one row per source. URLs are plain text, not links. | The rule against activating remote content. |
| Failure actions | "Retry now" and "Report from what we have" are not offered. Quota and key failures link to settings only. | The seam has no such command. A control that does nothing would imply a fallback. |
| Success wording | `success` reads "Returned", and the banner says that does not mean the question is covered. | A returned read is not coverage. |
| Web settings | One route, `/settings/web`, rather than four tabs. The account section is collapsed until a key exists. | Other tabs have no data here, and public research needs nothing on this page. |
| Billing | The acknowledgement checkbox is `required` rather than a script-disabled button, and the service still refuses without it. | It works without script. |
| Setup | When the policy offers `web_search` and `web_fetch`, setup shows both ticked, in words, with what leaves the machine. The "Nothing is granted" row becomes "Nothing else is granted". | The form previously granted Jit no tools, so public research could never start. This is a visible owner choice and the owner can untick it. |
| Settings honesty | The page names Bots that have no web tools. | The seam has no command to widen a Bot's ceiling after setup. |

**Verification:** rendering and form-contract tests are in `tests/s14-web-memory.test.ts`. Headless Chrome on macOS covered the seeded pages at 360, 390, 430, 820 and 1280 px, in both themes and both languages, with no page overflow and no tap target under 44 px outside inline text-link rows. The same browser ran a no-script journey with script disabled: remember, revoke, forget, save key, enable with acknowledgement, remove key and return to free mode. With script on, the pages logged no CSP violation. Parallel reads used fixtures. No real phone, Safari, Firefox, screen reader, live model route or live Parallel service has been used.

## 18. Bot computer refinements (BOX14-01)

Author: Claude Opus 5.5 (`claude-opus-5-5`), requested at effort high. Date: 2026-10-30. Code: `src/s14/web-pages.ts`, `web-style.ts`, `web-enhance.js`, `web-product.ts`, plus the read-only `S14Computers.activity` query. F9 and F11 stay the source; each change below is **P** and presents only data the seam has.

| Area | Change | Why |
| --- | --- | --- |
| Where takeover lives | `/team/:bot?tab=computer` is the one full surface. The work Computer tab lists its Bots with state and lease words and links there. No 720 px pane. | A 1280 px surface does not fit a pane, and one page keeps one no-script path and one set of pinned forms. |
| Hand back | Labelled คืนเครื่อง / Hand back, without "to {Bot}". The note says nobody drives afterwards and the Bot gets input only if its work asks again. | `takeover.end` clears the lease and never restores an agent lease, so "คืนให้นักค้น" would promise something the service does not do. |
| Held action | Shown in every state, with a link to its own card and the words that takeover and hand back do not approve it. The hand-back note repeats this with or without a held action. | S14-AC12. No approval control exists on this page. |
| Sign-in wall | Not rendered. A fact row states no internet, website sign-in or sharing, and what the Bot can do (local reports, scroll). | Phase A has `--network=none` and no site adapter, so that state cannot occur. |
| Lease bar | The prototype's inline button moved into an owner strip under the lease words. | Keeps the rule that strips are the only host for authority buttons. |
| Expired takeover | Separate words and one action, ปิดการคุมนี้ / Close this takeover. Take over stays hidden until it is closed. | Input is refused once the lease expires, and `takeover.start` refuses while the expired owner lease remains, so offering it would only produce a refusal. |
| Screen picture | Below the state; framed by a note that the picture is the Bot's page, not a command, and can be false. No page title or URL in the alternative text. | The seam exposes neither, so the alternative text says the contents are not available as text. Pixels are treated as untrusted. |
| Owner image | Stays exactly 1280 by 800 without script, in a sideways scroller. With script it fits the page and the click is mapped back. | A browser reports image-button coordinates in rendered pixels, so a scaled image without script would click the wrong place. Checked in Chromium. |
| Image button focus | `tabindex="-1"`, with a separate typed coordinate form under Click by coordinates. | Enter on a focused image button submits (0,0), a phantom click. The form gives keyboard users exact clicks with the same fields. |
| Enhanced input | Script does not send input by itself. Every press stays one native form post, including the fitted click. | The enhancement contract says script never posts. One path also means one outcome page and no second retry story. Live typing without reload is deliberately absent. |
| Input outcome | Forms land on the computer page with Sent or Outcome unknown, not on JSON. Unknown has no resend control. | The bare seam redirects to a JSON receipt, which is a dead end without script. |
| Reset and delete | Links to a consequence card (`&confirm=`), with both scope IDs, what stays, what is interrupted and what follows. Focus lands on the heading. Stop posts directly because it keeps data. | The contract requires both scopes before submitting, and no-script needs a real page for it. |
| Activity log | Owner commands, input outcomes and work attempts bound to this computer, with times. The note says what it leaves out. | The seam records no opened pages or screenshots, so the design's example lines cannot be shown. |
| Fail closed | Missing runtime, unproved isolation and every runbook code get words, the code, the credential-free probe and "no fallback". | Honest repair for an owner who has to look at the host. It is the one place the just-works promise cannot hold, so it says exactly what is needed. |
| Vocabulary | Stopped is หยุดแล้ว, not "asleep". | Section 6 keeps one word per state. |
| Live reads | Three regions replaced by signature, driven by the one-event state stream, with a fresh picture preloaded per event. | A per-render request ID would otherwise replace forms under a press every read. |

**Verification:** rendering and form-contract tests in `tests/s14-computer-ui.test.ts`. A real headless Chromium run over the real handler with a fake runtime and a 1280 by 800 PNG covered real no-script posts of image, text, key and coordinate input, the fitted click at 390 px, state following across two contexts and layouts at 360, 390, 820 and 1280 px in both themes and languages, with no console or CSP errors. No real Linux computer, real phone, Safari, Firefox, screen reader or live model route has been used, and no claim is made that a screen reader can use the pixel desktop.

## 19. Team and report refinements (TEAM14-01, REPORT14-01)

Author: Claude Opus 5.5 (`claude-opus-5-5`), requested at effort high. Date: 2026-10-31. Code: `src/s14/web-team.ts`, `web-report.ts`, `web-product-team.ts`, `web-style-team.ts`, plus small hooks in `web-pages.ts`, `web-product.ts` and `web-memory.ts`. F3, F4, F7 and F8 stay the source. Each change below is **P** and presents only data the seam has. This section supersedes the "one at a time" concurrency row in section 16 and the CSS-width timeline row in section 11.

| Area | Change | Why |
| --- | --- | --- |
| Timeline unit | One row per step, not per Bot. A Bot with two steps reads "Jit · Research" and "Jit · Synthesis". | Each step has one recorded interval. A Bot may have two, and merging them would invent a span. |
| Timeline drawing | One SVG per row with geometry attributes, inside an `aria-hidden` block. | The CSP has no inline style, so server-rendered CSS widths are impossible. SVG attributes pass it and need no script. |
| Queued and waiting | Superseded: see "Accept control and pre-run phases" below. | The seam now records `queuedAt` and `waitingAt`. |
| Stopping | A hatched bar up to now that still counts in the headline. Stopped is an outlined bar. | A stop request does not end a call, and the lane keeps its capacity until it settles. |
| Overlap sentence | "Really ran at the same time for 1 min 20 s", computed from recorded intervals, or "No two steps have run at the same time". | S14-AC04 in words, so overlap does not depend on reading the graphic. |
| Table | "View as a table" is a collapsed section under the graphic. Null times read Not recorded and Not settled. | Same observations in text. An open section defers live refresh, like every other open section. |
| Lane words | Committed reads ส่งหลักฐานแล้ว / Evidence committed. The line adds that this does not mean the work is covered. | A lane must not read as finished work. |
| Waiting line | Names the exact lanes that have not committed. | The fix for a dependency wait differs from a queue. |
| Stop label | หยุดขั้นนี้ / Stop this step, with no Bot name. Offered only when the work has more than one lane. | Authority labels never carry a name a model may have proposed. A lone lane is the whole work, and Stop work already covers it. |
| Stop landing | A stopped lane lands on `/work/:id`, also from the pane. | The receipt carries no conversation. |
| Report from what we have | Not offered after a stop or failure. The banners say committed evidence is kept. | The seam has no such command, so a control would do nothing. |
| Bot state | Team and Home read each Bot's own lanes, so only Bots really running breathe. | Previously every Bot in a running grant read as working. |
| Work card | One line per step, up to six, with a report link and a Partial pill. | Shows overlap from the conversation. |
| Usage | Time is elapsed against the grant. Reads, calls and output are reservations. Near the limit is a word at 80%. Actual use stays hatched and Unknown. | Reads and calls are separate limits now, and only time is observed. |
| Work tabs | Progress, Report, Evidence, Grant, then Computer, the section 3 order. | Report needed a place, and this restores the designed order. |
| Report selection | `/work/:id?tab=report&report=:id` and the same on the chat pane. There is no `/reports/:id` page. | Section 3 keeps reports under their work, and one path works without script. |
| Four facts | A grid of Report, Coverage, Missing evidence and Your review, then one sentence saying what ready means. | The contract requires independent facts, and one badge would merge them. |
| Covered word | ครอบหลักฐานที่ระบุ / Listed evidence covered, neutral not green, with "does not prove the report is true, and the work is not closed". | Even `covered` only means the owner's list was met. No state says complete. |
| Gaps first | Covered, missing and limitations come before any claim. | F8 wants them above the fold. |
| Missing list | A stored gap becomes words only when typed data corroborates it: a real target, claim, step or read. Anything else stays visible as Bot text in the untrusted frame. | `missing` mixes service codes with model strings in one list. A model must not be able to forge a system line, and nothing may be dropped. |
| Title | Stays inside the untrusted frame. The heading is the fixed "Report r2". | A model must not author page chrome. |
| Citations | A numbered link to the exact Evidence row, then the URL as plain text, and the exact quote in a collapsed frame. | Section 7 keeps remote links inactive. Only the row in Evidence is one click away. |
| Conflicts | Both claims shown with both sources, each linking to the other. | F8: the UI does not pick one. |
| Revisions | Listed newest first with time and coverage. An older revision says so and links the latest. A withdrawn one shows only its number and the reason. | S14-AC08, and no payload after withdrawal. |
| Files | Exact bytes, word plus media type, full SHA-256 and time, with the attachment link. | Literal values in mono. KiB would hide the exact size. |
| Required evidence | An optional box under More on start forms, one line per target. A URL line asks for that page in full, and other lines are a topic. | Without targets `covered` is unreachable from the product. Only the owner sets them, and they appear in Grant. |
| Work defaults | `/settings/work`, one form with three numbers, plus read-only installation ceilings. Every start form reads the saved values. | One no-script path. Ceilings explain a queue under the grant limit, and they are not measured capacity. |
| Stale defaults | Shows the fresh saved values, not the typed ones. An out-of-range form keeps the typed values. | A stale form must not overwrite a change the owner has not seen. |
| Forget preview | Adds report and file counts, with a link to each revision. | The owner decides on what the command reaches. |

### Accept control and pre-run phases

Author: Claude Opus 5.5 (`claude-opus-5-5`), requested at effort high. Date: 2026-10-31. Code: `src/s14/web-report.ts`, `web-team.ts`, `web-style-team.ts`, plus the read and refused-post path in `web-product-team.ts`. Each change is **P** and presents only data the seam has.

| Area | Decision | Why |
| --- | --- | --- |
| Pre-run phases | F3's encoding, smaller than a run bar: a 6 px outline for queued and a 6 px hatch for waiting, both before the run on the same track. | The seam records both starts, and a run must stay the loudest mark on the track. |
| Phase ends | A phase ends at the next recorded start. Only a lane still in that phase runs to now. A zero-length phase draws nothing. | Phase starts stay on the lane after it moves on, so reading them alone would stretch old phases to now. |
| Ended before running | A lane cancelled or refused before it ran draws one short tick where its phase began. The table says "end not recorded". | Such a lane records no end. A bar to now would be an estimate, and F3 forbids that. |
| Stopped bar | Keeps its outline and gains an end cap, also on the legend. | Queued now uses an outline, so a stopped run needed a second cue. |
| Now hairline | Only on lanes still moving. | A lane that ended before running has nothing reaching now. |
| Axis and overlap | The axis starts at the earliest recorded phase. Overlap still counts run intervals only. | Waiting beside another lane is not running beside it. S14-AC04 depends on that. |
| Table | Adds Waited and Queued columns, each with the phase start and how long it lasted. Times don't wrap, and step names break at words. | The graphic is hidden from assistive technology, so the table carries every phase. |
| Holding ceiling | The lane says "Held by the limit of this work: 2", and the same words appear on the timeline row and in the table. It replaces "Capacity is full". | The fix differs per ceiling. |
| Computer hold | Shows no number. | That hold can be a workspace or input lease, so a count could be wrong. |
| Queued with no hold | Says no limit is holding it right now. | `queueCeiling: null` means no current hold, so "full" would be false. |
| Accept placement | The control sits after gaps, claims and files, before revisions. The Your review fact links down to it. | Reading comes first, so the control is reached after the gaps, not before them. |
| Accept label | "Accept r2", or "Accept r2 as partial". A partial report gets a plain button, with "Accepting keeps this partial" and the gap count above it. | The press itself states what stays true. Partial should not look like the expected path. |
| Accept word | ยอมรับ / Accept. Never อนุมัติ, เสร็จ, ปิด, complete or close. | อนุมัติ belongs to external effects, and acceptance closes nothing. |
| Accepted state | A neutral ✓ pill naming the revision, with the coverage pill beside it, the time and the sentence on what clears it. No green. | Two separate facts stay visibly side by side. |
| Earlier revision | Says only the latest revision takes a review, with no control. | The seam refuses an older revision, so "Needs your review" would be a dead end. |
| Cleared acceptance | The page returns to Needs your review. A withdrawn revision says any acceptance it had is cleared. There is no "your acceptance of r1 was cleared" line. | `ReportReview` keeps no past acceptance, and the page does not guess one from revision arithmetic. |
| Refused accept | Returns to that work's Report tab. Withdrawn and already-accepted refusals have their own words. | The command names only a report, so the page looks up its work for the way back. |
| Missing split | Typed gaps sit under "Recorded by Jit from this run". Bot text stays in its frame, labelled "The Bot says this is missing. Jit did not check it". The Missing fact counts them apart. | A Bot's sentence must not raise a recorded count or borrow service wording. |

**Verification of this pass:** `tests/s14-team-ui.test.ts` covers the form contract, clearing by new revision, forget and delete, stale and withdrawn refusals, each ceiling, phase geometry and the gap split in both languages. Headless Chrome on macOS covered Report and Progress at 360, 390, 820 and 1280 px in both themes and both languages, with no page overflow, no review control under 44 px at phone widths and no console or CSP errors. With script disabled, the same browser accepted a partial report through the real form and landed on the accepted state. One forced-colours render kept the queued and waiting patterns and all state words. No real phone, Safari, Firefox or screen reader was used in this pass.

**Verification of the first pass:** rendering and form-contract tests are in `tests/s14-team-ui.test.ts`, using the real scheduler, report handler and HTTP handler with scripted runs. Headless Chrome on macOS covered real states at 360, 390, 430, 820 and 1280 px in both themes and both languages, with no page overflow, no button, tab, revision row, citation or section toggle under 44 px at phone widths, and no console or CSP errors. One forced-colours render kept every state word; bars there lose their committed and failed shades, so the words carry the difference. The same browser with script disabled stopped a step, saved defaults, started work with evidence targets, downloaded a report file and followed a citation. With script on, a page followed a live graph to its end. Playwright's WebKit build covered the Thai pages at the same widths with no overflow; its only console lines were refusals of the style that the screenshot tool injects, and they appeared only where screenshots were taken. Firefox could not start in this environment. No real phone, Safari, screen reader, live model route or live Parallel service has been used.

## 20. First-run and recovery refinements (UX14-01)

Author: Claude Opus 5.5 (`claude-opus-5-5`), requested at effort high. Date: 2026-10-31. Code: `src/s14/web-first-run.ts`, `web-recovery.ts`, `web-style-first-run.ts`, `web-product-first-run.ts`, plus `web-pages.ts`, `web-memory.ts`, `web-enhance.js`. Each change below is **P** and presents the #265 seam. Where it conflicts with sections 16 to 18, this section wins.

| Area | Change | Why |
| --- | --- | --- |
| Setup steps | Four steps: ตื่น (password), เชื่อมจิต (provider), รู้จักกัน (name, language, research), ตั้งจิต. Password comes first because everything after it needs a session. | Section 16's three steps had no device sign-in. Provider comes before name so that setup cannot finish with no way to answer. |
| Provider choice | Names only, with one line about the account each uses. No model, route or alias reaches the owner. One signed-in provider is inferred; several become a choice of names. | The owner chooses a provider, never an ID. Model names stay visible on read-only Bot and grant pages as exact data. |
| Readiness words | Local readiness is "Signed in, not tested yet", never "ready". States a sign-in cannot fix offer no button. | Credentials do not prove a working subscription. |
| Code page | Open the page, enter the code, then wait, in that order. The code is large and selectable, with a Copy button added by script. | One calm path with a single thing to do at each point. |
| Code is shown once | The page keeps the code on screen and reads only safe state. No-script gets "I have approved it", with a note that the code cannot return. A pending GET says so and offers Cancel, then Get a new code. | The seam returns approval once. Reloading or leaving cannot show it again, so the page must not imply otherwise. |
| Provider link | Only an `https:` address becomes a link, opened in a new tab with `noopener noreferrer`. Anything else stays plain text. | Keeps the code page open, and a bad value cannot start a navigation. |
| Script on sign-in | Reads the safe status every 3 seconds. A settled flow replaces the page with its read-only address. It posts nothing. | Enhancement only, and the code never travels through script state. |
| Busy flow | Says a sign-in is open elsewhere and how long it can last, with no cancel. | The seam reports no flow ID for the other request, so a control here could not name it. |
| Refused setup link | A page rather than JSON, with no form. With an owner it offers Sign in. Without one it says to run the installer again, with the source path collapsed. | Added as the optional `ownerSetupRefused` renderer. The bare contract handler still answers JSON. |
| Fixable password errors | The same form returns with the cause and both fields empty. | The capability is still valid. A password is never echoed. |
| Unprovisioned sign-in | Points to the one-time link. The local command moved into a collapsed "Running from source" note. | A shell command was the first thing a new owner saw. It stays because source runs have no installer. |
| Blocked first reply | `reply_unavailable` links to `/settings/provider`. | The reason does not say why the model failed, so the page offers the likeliest check without claiming a cause. |
| Provider page | `/settings/provider` shows readiness, who uses each provider, and sign-in again. It has no route control. | Needed for that next action. Changing a Bot's route is a different decision. |
| Task rejection | Reject sits beside Accept in the strip. A rejected task is a closed slip, stays in the chat and gets its own group in Work. The word is ไม่รับแล้ว everywhere. | Replaces the section 16 row. History must show that nothing was granted. |
| New chat | A flat `new-chat` form in the sidebar, chat header, Bot page and a phone-only chat list on Home. Later chats read "Jit · chat 2". | The seam has no chat title. The form is not an authority control, so it needs no strip. Phones have no sidebar. |
| Preferences | Language and theme on More. The saved banner rereads the receipt, so a link cannot fake it. Sign-in and failure pages use the saved theme. | Replaces the section 16 row. A page in the wrong theme reads as a different product. |
| Unpin | A direct form under each decision, with what stays and what cannot be recalled. | Reversible by pinning again, so it needs no preview. Unpinned decisions leave the list. |
| Retry and summarize | A card lists retained sources by coverage, other Bots' sources, failed reads and what is left. Open on blocked and waiting work, collapsed on ready work. | Replaces the section 17 row. The owner decides on what exists, not on a promise. |
| No summary control | With no retained evidence there is no Summarize button. | The service would refuse, and the button would imply evidence. |
| Blockers | A word per case: external action, unconfirmed call, revoked, expired, Bot changed, limits used. Each offers its own unblock, never Retry. | Display only. The service rechecks every condition. |
| Start as new work | Opens the chat with the original text and work mode on. It starts nothing. | Spent or expired authority needs a new owner command, not a refund. |
| Result label | A summarized result carries a banner with its source count and "not a complete report". | Ready for review is not coverage. |
| Stopped work | No recovery card. | The seam accepts only blocked, waiting and ready work, so F4's "ทำรายงานจากหลักฐานที่มี" stays unavailable here. |
| Takeover | Extend beside Hand back while driving. When expired, Keep driving is primary beside Close this takeover. The note gives the idle limit and the work's expiry. | Replaces the section 18 row. The label states no fixed length because the grant can shorten it. |
| Page identity | Shown as text in the untrusted frame under the screen, never as a link. Otherwise a note says titles and addresses are withheld. | Only an observed offline page is exposed. Titles can hold typed text. |
| Open computer | Uses the eligibility query, shows at most 3 cards and a count, and says when no work qualifies. | The query is advisory, and `computer.open` repeats its checks. |
| Activity | Words for page opened, screenshot, Bot scroll, service stop and extension. | Replaces the section 18 note that these were not recorded. |
| Impact | Bot and work names come from the bounded service query, with omitted counts. | Replaces the 64-context lookup of section 17. |
| Refusal | Default browser behaviour after the CLI refusal, with no store, lock or worker. | Section 16 described it as opt-in. |

**Verification:** rendering and form-contract tests are in `tests/s14-first-run-ui.test.ts`. A real headless Chromium (Google Chrome for Testing) ran over the real handler with a fake provider protocol, fake credential store and scripted chat. It covered the full fresh journey with script off (Thai) and on (English, light), the Copy button, sign-in moving on by itself, the ceremony, Enter to send, and takeover, renewal, resuming an expired lease, retry, rejection, preferences and new chat with script off. Evidence-backed summarize ran through the real handler in tests, not in the browser. A matrix of 400 page loads (the 11 sign-in renders and 9 signed-in or refusal pages, at 360, 390, 430, 820 and 1280 px, in both themes and both browser languages) found no sideways overflow, no CSP error and no control under 40 px on phones. The seeded signed-in pages keep the owner's language, so that matrix tested them in Thai; their English rendering is covered by tests. The fixture image did not display in that harness, so the screen picture itself was not rechecked. No real provider, subscription, real phone, Safari, Firefox, screen reader, Linux host or live model route has been used.


### 2026-10-31 engineering wiring annotation (UX14-01)

The remaining-gap integration supersedes the section 20 seam limitations for the one-time link, busy cancellation, unpinned list and blocked replies. Interactive foreground serve issues the link privately on its terminal; service installers have the private-pipe `owner-link --s14 --output-fd 3` CLI. The collapsed source-only password command is removed. The same busy page uses its existing Cancel form with owner-only currentFlowId. Unpinned decisions stay in the existing list with the existing Unpinned pill and Pin form. Blocked replies use existing localized category words and offer sign-in only when that cause is known; unknown stays generic. This is logic wiring of existing patterns, with small factual copy corrections and no new screen/layout/state design. F4 remains unavailable because stop revokes the original inference grant; tests preserve that fence. See the HTTP handoff for the exact contract and #267 installer call.

## 21. Sharing, restart recovery and owner statement refinements (SHARE14-01, REC14-01)

Author: Claude Opus 5.5 (`claude-opus-5-5`), requested at effort high. Date: 2026-10-31. Code: `src/s14/web-sharing.ts`, `web-recovery-page.ts`, `web-statement.ts`, `web-product-sharing.ts`, `web-product-recovery.ts`, `web-style-sharing.ts`, plus hooks in `web-pages.ts`, `web-product.ts`, `web-report.ts`, `web-memory.ts` and `web-recovery.ts`. F10, F12 and F14 stay the source. Each change below is **P** and presents only data the seam has. Where it conflicts with sections 16 to 20, this section wins. The "Unknown outcome" row of section 16, the "Share" row of section 17 and the sign-in-wall network wording of section 18 are replaced.

| Area | Change | Why |
| --- | --- | --- |
| Where sharing starts | A Share link on each report file row and each memory original, plus `/shares`, reached from More. Originals are not listed on `/shares`. | F12 starts from a file row. Every chat message is a source, so listing them all would bury the files. |
| One sheet | `/shares/new` shows From, kind, name, revision, type, exact bytes and full SHA-256, then the exact content collapsed, then Which work, the two reach lists and the strip. | The owner reads what is pinned before choosing. The gateway check runs on this read, so a refused snapshot shows its reason and no control. |
| Receiver | One radio per eligible Bot, with nothing preselected unless there is exactly one. The radio pins the Bot revision and its first free slot. Other Bots are listed with the reason. | A slot is an internal the owner never picks. Pinning it in the rendered form keeps a retried post the same command. |
| Which work | The default is any work where the owner ticks this share at the start. A pin to an accepted task is a link that rereads the sheet, and the task title stays in an untrusted frame above the strip. | Grants are immutable, so only unstarted accepted tasks can use a pin. This narrows F12's "current work" default to what can really happen. A Bot-written title must not sit in the owner strip. |
| Expiry | A number of hours, 1 to 24, default 1, the same control as a memory share. | Finite by contract. The smaller default suits starting work right after sharing. |
| Naming a share | Start forms gain an unticked list under More options. It shows shares whose receiver is available to that form, and pinned shares appear only on their own task's form. | Without this a share could never be used. The service still rechecks receiver, work and revision. A refused post keeps the text and the ticks. |
| No receiver | The sheet states that a free share slot is needed and that Jit never widens a ceiling by itself, and it offers no form. | This is the default on a fresh install. See the handoff note below. |
| Revoke | `/shares/:id` lists the work that names the share, then a slip with what the command does and cannot reach, with one exact-revision button. | The honest limit belongs before the press. Revoke also withdraws derived output, so it is not a plain stop and earns the two lists. |
| Revoke words | Blocks future use, refuses late results, withdraws what the receiver built from it, removes the stored copy. It cannot recall what was read or sent to a provider, and it leaves the original alone. No line reads as erasure. | S14-AC05. Every line maps to `app.snapshot-sharing/v1`. |
| Ended shares | Revoked, Expired and Unavailable each have their own word and sentence and offer no control. They stay listed. | A share that vanished would hide what happened. `cannot_recall` holds in every state. |
| `/recovery` layout | Four counts, then Needs you, Old sessions, Jit can't confirm yet, Resumed and Not resuming. One line per work and reason, with its steps named. | Several lanes with one outcome are one thing to read. The owner's part comes first. |
| Resumed word | Will resume for a queued replay-safe step. Resumed only with a real replacement attempt and `replay_safe`. Anything else falls to Needs you. | S14-AC11. The renderer checks the class itself, so a wrong record cannot read as a safe resume. |
| Recovery is read-only | The page holds links only. Every decision stays on the card or work page that pins its revision. | No new authority surface, and a read cannot start anything. |
| Old sessions | A `--danger` slip per unresolved session: reason, what Jit tried, what the inventory last showed, and that Jit does not treat it as stopped or deleted. Confirmed sessions are one collapsed count, limited to this machine's session store. | Metadata cannot prove more. The inventory row is what was last seen, not a current fact. |
| Next start | Unresolved sessions and unsettled calls say Jit checks again at its next start, and that this page cleans up nothing. No restart control. | Cleanup is an exclusive boot step. Showing a button would promise something a page cannot do. |
| Attention | One row on Home and Work counts lines waiting on the owner or on Jit, plus unconfirmed sessions. Unknown effects keep their own rows, and stopping work clears its line. | Counted once, with a way to clear it. |
| Usage | One line with a hatched Unknown: actual usage stays Unknown and reservations are not returned. | `actualUsage` is null, and unknown is not zero. |
| Statement form | Lives only on the card's own page. The pane links to it. Two radios with nothing preselected, one required note, and one button: Record my statement. | Live refresh cannot take a half-typed note. A conscious answer needs no default, and it replaces F10's two buttons because the seam requires a note. |
| No third choice | Not sure means leaving the card as it is, and the strip says so. | A statement is a record, so not recording one is the honest "don't know". |
| Two facts | After a statement, a grid separates What Jit saw (Outcome unknown), What you stated, Checked by Jit (Not checked) and Recorded. The note sits in its own frame, labelled as typed. | The observed state stays unknown. |
| No green | The statement pill is neutral even for It happened, the banner is neutral, and the slip keeps `--danger-line`. | Green would read as verified. |
| After a statement | It leaves the attention count. Retry and summary stay closed with their own words, and Start as new work appears. | The service keeps refusing, because an owner statement is not an outcome. Waiting on a result that never comes would be false. |
| Lost note | A statement restored from the ledger says the note was lost. | The ledger keeps no note, and the placeholder is not the owner's words. |
| Network row | Now says nothing on this computer is shared with another Bot. | The old row read as if sharing did not exist. |

**Handoff note (superseded by section 22, which delivers the slot path):** production `JIT_S14_RESOURCES` defaults to `[]`, and this slice has no way to add a slot to a Bot's ceiling after acceptance (#275 holds capability editing). A default install therefore shows the no-receiver state until slots are configured and a Bot is accepted with one. This does not meet the just-works principle and is recorded for the owner.

**Seam limits shown as they are (boot time and free slots superseded by section 22):** the recovery query has no boot time and no per-line time, so the page says it cannot tell when Jit last started. Slots already used are read from `snapshot_shares` and `memory_shares`, because no query reports free slots. Resumed lines stay in history, so the page lists the newest 20 and counts the rest.

**Verification:** rendering and form-contract tests are in `tests/s14-share-recovery-ui.test.ts`, over the real application, boot reconciliation and handler with a scripted native port. Headless Chrome on macOS covered 11 seeded pages at 360, 390, 430, 820 and 1280 px in both themes and both languages (220 page loads), with no page overflow, no clipped block, no control under 40 px at phone widths, and no console or CSP errors. Focus landed on the sheet heading with script on. With script disabled, the same browser ran real clicks and typing in Thai and English: share, revoke, and record a statement. One forced-colours render of `/recovery` and of the unknown card kept every state word. No real phone, Safari, Firefox, screen reader, Linux host, live model route or real reboot has been used. Queued recovery live refresh, the two refusal pages and the hostile strings are covered by tests, not in the browser.

## 22. Routines, grouped attention and Bot lifecycle refinements (ROUT14-01, BOT14-02)

Author: Claude Opus 5.5 (`claude-opus-5-5`), requested at effort high. Date: 2026-10-31. Code: `src/s14/web-routines.ts`, `web-lifecycle.ts`, `web-product-routines.ts`, `web-product-lifecycle.ts`, `web-style-routines.ts`, plus hooks in `web-pages.ts`, `web-product.ts`, `web-sharing.ts`, `web-product-sharing.ts`, `web-recovery-page.ts`, `web-enhance.js` and `web.ts`. F5, F12, F13, F14 and resolution Q7 stay the source. The prototype omits the lifecycle flows, so everything about them here is new design. Each change is **P** and presents only data the seam has. Where it conflicts with sections 16 to 21, this section wins.

| Area | Change | Why |
| --- | --- | --- |
| Routes | `/routines`, `/routines/new`, `/routines/:id`, `/team/:id/capabilities`, `/team/:id/retire`, `/team/:id/delete`. Routines joins the sidebar, and phones reach it through More. Capabilities is a third Bot tab. | Section 3's routes, plus one page per lifecycle decision so no-script has real pages. |
| Routine form | One visible form, then a review step, instead of F13's single sheet. Edit carries every typed value back. | The owner has to read the exact capture and the computed first run before enabling. The review is a post that commits nothing, added as the optional `S14Product.review` hook, so purpose text stays out of URLs. |
| Exact capture | Review and routine page share one block in one order: text, when, runs, end, misfire, Bots with revision and generation, route, tools, shared items, each limit, other findings. | The two can be compared line by line, and nothing is paraphrased. |
| Routine text | Purpose and completion rule stay in the untrusted frame. The title appears only as escaped row text, and every heading is fixed. | The first line of a purpose becomes the title, and owner-reviewed text still must not author chrome. |
| Schedule | Every day at, every N hours, or once at. Weekly from the prototype's "Mondays 08:00" is not offered. | The seam has daily, interval and once only. |
| Timezone | Starts from the host's zone, and script replaces it with this device's on a new form. It stays a visible field and is shown again on review. | No-script still gets a working value, and a Pi on UTC should not silently mean UTC. |
| Fixed rows | Misfire and other findings are text, not controls. | There is one misfire policy and one outcome. A control with one choice would imply a second. |
| Finite by default | 30 runs, ending in 90 days, both editable. `once` captures one run whatever the field says. | The contract requires finite limits, and the owner should not have to invent them. |
| Run words | Quiet, Report, Needs you, Failed, Stopped by you. A quiet row loses its box so a long quiet stretch stays calm. Failed is `--danger` with its reason. | S14-AC10. Pausing a routine that was mid-run is recorded by the seam as a failed outcome, but the owner did that, so it must not read as a failure. |
| History summary | Four counts above the list, newest 50 listed, the rest counted. A latest-run failure is a banner above everything. | A failure must not sink under quiet rows. |
| Missed and clock | Coalesced runs say how many were missed. Clock changes say the time moved or ran first. | S14-AC10 and honest misfire. |
| Delivery | An unknown or failed notification says so on the run and on Home, and that it stays listed and is not resent. | ROUT14-01. Production has no transport, so this appears only with a port. |
| Findings | A separate section above the capture, in the untrusted frame, with only Accept and Reject in the strip. A note says the routine gains nothing and starting is a separate command with its own grant. Accepting lands on the existing task card with its Start form. | F13: accept is not start. |
| Replacement | Revoked, blocked and used-up routines offer a link that opens the form from the old capture. Bots that left the team drop out. It starts nothing. | Blocked has no resume in the seam, and a capture cannot be edited. |
| Attention control | No level setting is rendered. | Every notice is committed as `needs_owner`, so `attention.set` changes nothing today. A control that does nothing would be false. |
| Grouped needs-me | Home and Work group by External actions, Routines, Proposals and unstarted work, After a restart, Latest from routines. At most one row per routine and kind. Routine rows use a fixed heading with the title as small text. | A burst of runs must not become a burst of rows. |
| When a row leaves | A decision leaves when answered. A failure leaves when a newer run settles without failing or the routine stops being active. A blocked routine leaves when revoked, or when it has no runs left. A report is listed, newest per routine, and is never counted in the badge. History keeps everything. | The seam has no acknowledge command, so without this rule a row could never clear. |
| Ceiling draft | Every box is the exact selection sent, including what stays. Held resources, configured resources, and the next three free built-in slots are offered rather than all 64. | The contract says to send the full selection and infer nothing. 64 boxes would bury the choice. |
| Before and after | What changes first, with a word per line (Adds, Removes) and what each addition means, then the exact Now and After sets in mono, then what stops, then the two reach lists, then the strip. | The owner decides on the exact sets, and on what the press interrupts. |
| Accept label | "Accept this ceiling · a1b2c3d4", the first eight hash characters. The strip note says the press is bound to this version. | The press names what it binds to. Nothing carries a Bot's name. |
| Same ceiling | No Accept, with a line saying why. | Acceptance creates a new generation and would stop the Bot's work for nothing. The service allows it, so the page withholds it. |
| No Discard | A proposal has Change the selection only. Leaving it does nothing, and a new proposal replaces it. | The seam has no discard command. |
| What stops | Names the live work, routines and running computer. Work stops as a whole, including other Bots' steps. Routines stop and do not restart. | `fence` stops every grant naming the Bot and blocks every routine capturing it. |
| Stopping | One card on the Bot and Capabilities pages: the target in words, four steps (new work closed, calls ended, computer stopped, sessions closed) and the stored reason. The page follows it live and the step words never become a percentage. | A receipt is intent. The steps are read from the stored stage only. |
| Landing | A reread receipt gives one banner: the saved command while settling, "really finished" once settled. | One word per state, and a link cannot fake it. |
| Chat while closed | A closed Bot's chat stays readable and swaps the composer for a line. Home keeps the composer during Jit's own change and says when sending returns. | A retired Bot's chat is history. Jit's change is short, and the owner's typing must not be lost. |
| Retire | What stops, what stays, then one button, "Retire and keep history". There are no retention checkboxes. | Retention is not a choice in the seam, so the press itself states it, and both flags are sent. |
| Re-enable | Reuses the capability page, titled as a fresh generation, with a banner that old work and routines stay stopped. | Same exact proposal flow, with a stated difference. |
| Delete | Counts, what stops, a loss banner pointing at Retire, the two reach lists, retained lineage, then the full exact list in a collapsed section. One danger button. Focus lands on the heading. The reset link sits outside the card. | "Exact preview" means every identity is available, while the owner decides on the meaning first. Computer reset stays separate. |
| Deleted Bot | Reads Deleted Bot, leaves the sidebar, Home and More, and stays under Deleted on Team with no tabs or controls. | The seam leaves a `[deleted]` placeholder, which must not reach the owner. |
| No receiver | One row per Bot with its reason and a fixed Add a share slot link, which opens that Bot's form with a free slot ticked and remembers the sheet. After acceptance settles, the Bot page offers Back to sharing. With no other Bot, it points at Jit. | Replaces section 21's dead end. A slot is an internal, but the proposal shows it exactly. Nothing is accepted or shared by following the link. |
| Bot between ceilings | Listed on the sheet as changing its ceiling. | It would otherwise vanish right after the owner added its slot. |
| Boot time | One line above the counts, using the same `when` format as everywhere else. | Replaces the section 21 limit. |

**Seam limits at the initial ea7bc7f handoff (superseded by the PR #276 logic follow-up):** the attention seam has no acknowledge command and `attention.set` has no effect today. Capability proposals have no discard. `fenceBot` also blocks a routine that has used all its runs, so such a routine is not counted as needing the owner. After a Bot change the stored routine reason is `routine_generation_withdrawn`, not `bot_authority_changed`, so the words stay general. Revoked routines count towards the capacity of 128 and have no delete. There is no run-now command, so the prototype's button is absent. `app.routines.list` returns full history, and the attention projection reads it on every page, so a large history costs one read per page until a bounded query exists.

**Verification:** rendering and form-contract tests are in `tests/s14-routine-lifecycle-ui.test.ts`, over the real application and handler with a scripted executor and native port: both languages, each routine and lifecycle state, stale and refused posts, duplicates, hostile titles, findings and Bot names, and receipt spoofing. Headless Chrome for Testing on macOS loaded 22 seeded pages at 360, 390, 430, 820 and 1280 px in both themes and both languages (440 page loads), with no page overflow, no CSP or console error, and no control under 40 px at phone widths. With script disabled, the same browser ran 21 real steps in Thai and English: create, review, enable, pause, resume and revoke a routine, accept a finding without starting it, add a tool through the exact proposal, go from the share dead end through a reviewed slot back to a real share, then retire, re-enable and delete. With script on, it confirmed the device timezone, heading focus, and a stopping page following to Retired without a reload, with the phase announced. A keyboard pass in both languages reached and pressed Resume and Review by Tab and Enter, and on Delete confirmed focus starts on the heading, where Enter does nothing. Forced-colours renders of a routine, a proposal and a stopping Bot kept their state words in both languages. No real phone, Safari, Firefox, screen reader, Linux host, live model route or real reboot was used for this slice.

Engineering contract correction for PR #275 (owner-requested review fixes, no new UI/UX design): Home/Work now use `app.routines.attention` SQL aggregates bounded to 128 captures, selecting actual open proposal/waiting Work across all history. The latest-100-notice window no longer governs decisions or delivery warnings. A last-run failure also remains visible after finite-budget exhaustion or pause, until a newer settled success or explicit revocation; this supersedes the active-only implementation rule in section 22 under S14-AC10. Grouped rows, labels, controls and visual design stay as authored above. Full history on the separate routine list/detail query remains unchanged.

## 23. Backup, restore and upgrade status (OPS14-01)

Author: Claude Opus 5.5 (`claude-opus-5-5`), requested at effort high. Date: 2026-10-31. Code: `src/s14/web-backup.ts`, `web-product-backup.ts`, `web-style-backup.ts`, `backup-inventory.ts`, `ops-guide.ts`, plus hooks in `web-pages.ts`, `web-product.ts`, `web.ts`, `web-assets.ts`, `web-enhance.js` and `ops-cli.ts`. The prototype has no backup or restore flow, so everything here is new design. Each change is **P** and presents only data the seam has. Where it conflicts with sections 16 to 22, this section wins.

| Area | Change | Why |
| --- | --- | --- |
| Routes | `/settings/backup`, `/settings/backup/:id`, `/settings/backup/:id/restore`, reached from More. | One page per decision, so no-script has real pages. A restore is long and serious, so it does not share a page with the list. |
| Back up now | One typed command in the owner strip, with a landing page instead of the JSON receipt. | One press, no terminal. A bare handler without the product keeps the JSON contract. |
| Progress | Three named steps with a session count, no percentage. The page follows by the same live reads as work, and a Refresh link carries no-script. | The seam has a phase and a count. Unknown duration must not look like a measured bar. No script was added for this. |
| Past the minute | A warning that a session has not finished, that work stays paused until it really ends, and that a late copy is not kept. | `waiting_native_settlement` is not a failure, and no press helps. |
| Failure | The status card stays on the last result, with the cause, next step and code, until a newer request replaces it. The press stays available unless something real blocks it. | Failures live in the durable journal, so a reload must not clear them. |
| Blocked before the press | Running work, computers, Bot changes, replies and sign-ins are listed with links, and the button is withheld. The page refreshes itself and the button returns. | A refusal after a press teaches less than a named list before it. The list is advisory and the service rechecks. Nothing here stops anything. |
| No false press | Missing native support, a full retention list and a full retry journal each explain themselves and offer no button. | The service would refuse. |
| Paused after a failed close | Says work stays paused and points at a restart. | Only the exclusive start can release this. |
| Health | Looks complete, Damaged, Not usable by this version. "Looks complete" means every file is present at its recorded size, and the detail says the full check runs at restore. | Hashing up to ten 64 MiB images on a page load is wrong, and a size check must not read as verified. Replaces no contract: `restore.prepare` stays the only validation. |
| Backup list | Three counts, then one row per backup, newest first, with origin and health. A recovery point is labelled as such. Retention is one note. | Offline points are never rotated, so the owner should see which are which. |
| What a backup holds | Two fixed lists, Inside and Left out on purpose, then the reconnection line. Open until a first backup exists, collapsed afterwards, always open on a backup's page. | The exclusions are the point. Each line maps to the table policy in `ops-image.ts`. |
| Getting the file | Names the folder as `<JIT_S14_DATABASE>.ops/backups/<id>/`, says there is no download or import and why, and asks that copies stay private. | The contract forbids rendering internal paths, so the page names the setting instead of its value. See the seam gap below. |
| Restore wording | A neutral banner, never a warning: this part happens in a terminal, it is the one place Jit needs one, and why. Then What will happen, What to expect, The steps. | A restore is a calm, explained operation. An alarming page would push the owner to the wrong choice in a stressful moment. |
| What to expect | Six rows: later deletions stay deleted, newer chats stay in the recovery point, accounts need reconnecting, the password stays, nothing resumes, computers are not in a backup. | Each maps to a contract line. "Newer chats" is not in the brief and is the surprise most worth stating. |
| Keep this page open | Stated first in The steps. | The page cannot reload once Jit stops. A saved page is the only guide until the terminal takes over. |
| Exact command | A block that writes one command file and submits it. Its request ID is derived from the command, so a reload shows identical text and a repeat returns its receipt. Copy is added by script. | The owner never edits JSON and never loses retry identity. The password stays out of the file. The service rechecks revision and owner. |
| Terminal guide | After `ops --s14`, Jit prints the state, stage ID, source, recovery point, confirmation hash and each exact next command to stderr, in the owner's language. stdout stays the JSON result. Status prints the same steps. | See the seam gap below. This is where the owner reads the stage and decides. |
| Partial and blocked | The guide gives the reason, Check again and Drop, and never an activation command. | Only a validated stage or an interrupted activation has one. |
| No restore control on the Web | No button, form or shutdown link. A posted `restore.*` lands on a page that points to the steps. | Cutover must not run in a serving process. |
| After a restore | A neutral record in the Restore card with the IDs and links to After a restart and sign-in pages. It says finished is no claim about unknown work. No green. | Complete means restored, not that unknown effects succeeded. |
| Upgrades | A Version card states the data format, that there is nothing to upgrade, and that a later upgrade follows the restore path. | This build stages only 16 to 16. No control would do anything. |
| Copy control | `data-copy` may name the block it copies. | The restore page has several blocks. The sign-in code keeps its form. |

**Seam gaps shown as they are:**

- An unfinished stage cannot appear on the Web. `S14Store` refuses to open while the fence exists, so the service cannot run and no page exists at the moment the owner reviews a validated stage. Stage details and the activation command therefore live in the terminal guide, and the page says so ahead of time. A local maintenance page would need a new authenticated offline ingress, which is an engineering decision and was not added.
- There is no backup download. A backup is a multi-file folder that only restores on this installation, with no import. A download route would be a new exit for private data, not a query field, so it was not added.
- The query had no size, time or health, so `backup-inventory.ts` reads manifests for these pages only. `/api/s14/ops` is unchanged.
- How to stop Jit depends on how it was started, and the page cannot know that, so the step describes both cases instead of printing a service command.
- `backup.revision` doubles as the journal count, because each accepted request adds one. The press is withheld at 100 on that basis.

**Verification:** rendering and form-contract tests are in `tests/s14-backup-ui.test.ts`, over the real application and handler: both languages, each capture and refusal state, damage, retention bounds, hostile titles and journal reasons, and a spoofed landing link. One test runs a whole restore from the exact text the page and terminal print, through the real offline CLI, and confirms the store refuses to open while the stage is unfinished. Chrome headless shell 148 on macOS loaded 12 seeded pages at 360, 390, 430, 820 and 1280 px in both themes and both languages (240 page loads), with no page overflow, no CSP or console error, and no control under 40 px at phone widths. With script disabled, the same browser reached Back up now by Tab, pressed it with Enter and landed on the result in Thai and English. With script on, a capture followed to its result without a reload, the phase was announced in the status line, and the Copy buttons appeared. A forced-colours render of the list kept its state words. No real phone, Safari, Firefox, screen reader, Linux host or real service restart was used. The hold list was exercised with running work only: its computer, Bot-change, reply and sign-in rows were not.

## 24. Personal accounts, brief and exact Google actions (LIFE14-01, LIFE14-02)

Author: Claude Opus 5.5 (`claude-opus-5-5`), requested at effort high. Date: 2026-10-31. Code: `src/s14/web-personal.ts`, `web-personal-brief.ts`, `web-personal-effect.ts`, `web-product-personal.ts`, `web-style-personal.ts`, plus hooks in `web-pages.ts`, `web-product.ts`, `web-report.ts`, `web-routines.ts`, `web-product-routines.ts`, `web-lifecycle.ts`, `web-product-lifecycle.ts`, `web-statement.ts`, `web-enhance.js` and `web.ts`. F9, F10 and F13 stay the source. The prototype has no Google screens, so everything about them here is new design. Each change is **P** and presents only data the seam has, except the three handler changes named under "Seam changes". Where it conflicts with sections 16 to 22, this section wins.

| Area | Change | Why |
| --- | --- | --- |
| Routes | `/settings/google`, `/settings/google/guide?step=1..6`, `/settings/google/new?service=`, `/settings/google/connections/:id`, `/work/:id?tab=brief`, `/effects/:id?edit=1`. Reached from More. | One page per decision keeps one no-script path. |
| Guide shape | Six numbered pages, one forward button each: Before you start, Project, APIs, Consent, Client, Paste. The position lives in the address. | Each page can sit beside the Google console on a phone. Back and a reload always work, with no stored progress. |
| Guide state | The stepper shows only position. Nothing says a Google step is done. | Jit cannot see Google Cloud. A tick there would be invented. |
| Honest cost | Before you start and the empty page say why this is more than one click: no central Jit service holds a shared client. It reads as a fact with its upside, not an apology. | Owner decision, 2026-10-30. |
| Copied values | Redirect URI, app name and the four scope addresses are selectable code, with a Copy button that appears only when the clipboard works. | They must match exactly, and no-script must still reach them. |
| Redirect | Derived from the configured origin and carried in a hidden field. The owner never types it. | It is inferable, and typing is how it breaks. |
| Address warnings | Localhost says same machine only. A raw IP or internal name says Google may refuse it. A saved client whose address no longer matches says so before anyone tries. | The failure happens at Google, far from the cause. |
| Unverified warning | A framed block explains what the page says, why it is expected (your own app, nobody submitted it), the three presses, and when to stop (the developer email is not yours). It appears on Consent and again right before sign-in. | It reads as an alarm, so it needs words at the moment it appears. The exact Google labels may change, and the text says so. |
| Publish step | Consent ends with Publish app and the reason: Testing ends sign-in every 7 days, and a brief would stop. Publishing lets nobody else in. | The default looks safe and fails a week later. |
| Client secret | `type=password`, `autocomplete=new-password`, no `value`, and a refused post returns the ID only. After saving it reads Stored, never shown again. | Write-only, including on refusal. |
| Saved words | Configured, not tested. | The contract says a configured client proves nothing. |
| Read and write | Two fieldsets with their own legends. Read is ticked and write is not. A banner states that a read connection can never write and never counts as consent to write. | Read is what the card was opened for, and consent still happens at Google. Write must be a separate conscious tick. |
| Inferred fields | No label field. Calendar defaults to `primary`, with a note on finding another ID. | Just-works principle. |
| Send without read | Says Jit cannot check Sent mail or confirm the account, so a send stays Outcome unknown. | The owner trades that away at this moment, so it belongs here. |
| Account identity | One pill everywhere: Confirmed by Google, or Typed by you, not confirmed. | `accountVerification` must stay visibly distinct. |
| Sign-in states | One page whose top card swaps: Continue to Google, Open Google, Finish connecting, Connecting, link expired, Sign in again. | The next action is always in one place. |
| Open Google | A plain same-tab link on a same-origin page, not a redirect from the form post. | CSP `form-action 'self'` refuses a form post that redirects off-origin in Chrome. |
| Back from Google | A session-free return page with one link, followed by script with `location.replace`. | The session cookie is `SameSite=Strict`, so a chain that began on Google lands on sign-in. Checked in Chromium. |
| Finish press | A form press, not automatic. Script never posts. | Exchange needs the session and CSRF. |
| Failed sign-in | The service keeps no reason, so the page lists four common causes and does not pick one. | A different account, a cancel, Testing mode and a Google-side end look the same from here. |
| Attention | One Connected accounts group: one last step, or needs signing in again, with a Can’t read word. | A silent reauth would otherwise show only as failing briefs. |
| Per-Bot rows | One closed slip per Bot, with fixed labels and the name in the heading only: Allow this Bot, Allow again, Stop allowing, Add to the Bot’s ceiling. | Authority labels never carry a name. |
| Ceiling first | A Bot without the slot or tool gets a link that opens its capability form with both ticked and comes back afterwards. Allow appears only once the ceiling holds them. | Accepting a ceiling raises the generation and ends a grant, so the other order costs an extra press. |
| Revoke | A slip with the two reach lists, a note that Google may end sibling connections, and a separate remote state. Unknown links to the Google account page. | A local fence is not a remote revocation. |
| Naming an account | A new unticked list under More options. One tick names the slot and `personal_read`. `personal_read` is no longer a tool row. | A ticked-by-default read tool with no account would give ordinary work a permanent gap. |
| Write-only account | Listed as Draft only, in a separate `account-write:` field that adds no read tool. Routines do not offer it. | A send-only connection could not otherwise be named at all. |
| Morning brief | A link that opens the ordinary routine form prefilled with text, 07:00 and the readable accounts. Review and enable stay separate presses. | F13: a routine is an authorization. A brief gets no shortcut. |
| Brief tab | Added after Report when the grant names `personal_read`. Status banner, four facts, then requested inputs never read, then one card per read. | The written brief is in Report. This tab is what the Bot was given. |
| Status words | Every requested input was read, Some inputs are incomplete, No input has been read. Complete is not used. A clean empty read alone may say nothing was found, and it names its window. | Empty, inaccessible, partial and stale must not look alike. |
| Unread input | Comes from the service's typed gaps, not the query status. | `brief().status` reads only rows that exist, so an input never read would otherwise read as complete. |
| Times | Window, brief timezone, calendar timezone, read time and each source time are separate labelled rows, shown in the brief's zone. Unknown time and zone are bold words. | Timezone errors hide when clocks share a line. |
| Gap words | Every service code has words and shows the literal code. An unknown code gets a general sentence and still appears. | A gap must never vanish for lack of a translation. |
| Source text | Title in the frame, full text collapsed in the frame, nothing linked. Event JSON is laid out only when it parses. | Section 7. A URL in mail stays plain text. |
| Mail card | From with its identity pill, then one row per recipient for To, CC and BCC, a count, then Subject and Body in full, inside a frame saying the Bot wrote this and the text cannot approve anything. | "Exact" needs every field, and BCC is what people miss. |
| Event card | Change word, calendar, account, event ID, ETag, timezone, then start and end as readable time plus the exact value, repeats, attendees, notification sentence, then the framed text. | The readable time is for the owner, and the literal is what is sent. |
| Update and delete | Update says what replaces what. Delete says the draft holds an ID only, with a warning. | A delete draft has no title in the seam, and a card must not imply one. |
| Approve label | "Send this email once · 1a8ce811", with the first eight hash characters. | The press names what it binds to, the same rule as section 22. |
| Edit | Own page. Account, calendar and event identity are not fields. Saving lands on the new card with a field diff, and a refused edit keeps the typing. | Those need new work, and the new card must be seen before it is approved. |
| Card that cannot run | Revoked, changed or expired accounts hide Approve and say why. Deny stays. | Approving could only be refused. The service still rechecks. |
| Unknown | Two facts side by side: What Jit saw when sending, and Checked with Google. Check with Google reads only, and the note says so. A blocked check explains why, with no button. The statement form below it is unchanged. | Provider evidence, dispatch state and owner statement must stay three things. A verified read-back stays neutral, and its sentence says Sent mail is not delivery. |
| Report | A personal gap uses the Brief's words and links there. A personal citation shows its kind, never `personal:<id>`, and opens the Brief row. | The opaque ID means nothing to the owner. |
| Work tabs | Tabs now scroll inside their own box. | Six tabs do not fit 360 px. |

**Seam changes, all outside authority:** the callback redirects to `/s14/personal/oauth/done`, or `?refused=1` for an unusable callback, under a product handler. The form completion lands on the connection page. Form POST `/s14/personal/drafts/:id/readback` is the no-script twin of the JSON read-back, calling the same service method under the same session, Origin and CSRF checks. `work.start` and `routine.enable` forms can now carry `{kind:'resource'}` refs.

**Seam limits shown as they are:** `personal.grant.set` requires `policy.resources`, while built-in share slots are valid elsewhere, so an install with the default empty `JIT_S14_RESOURCES` can create connections but cannot allow any Bot; the page says No slot free. This does not meet the just-works principle and is recorded for the owner. The service keeps no reason for a failed sign-in, so an account mismatch cannot be named. A work naming a readable and a write-only account lists the write-only slot as requested but never read. The generic unknown banner says "send" on a calendar card.

**Verification:** rendering and form-contract tests are in `tests/s14-personal-ui.test.ts`, over the real application, broker and handler with a scripted Google transport: both languages, each setup, sign-in, grant, brief, card and unknown state, stale and refused posts, hostile mail and event text, no-script posts and CSRF. Chrome for Testing on macOS loaded 21 seeded pages at 360, 390, 430, 820 and 1280 px in both themes and both languages (420 page loads), with no page overflow, no control under 40 px at phone widths and no console or CSP error. With script off (Thai) and on (English), the same browser ran the whole journey from More to an allowed Bot by real clicks and typing, with `accounts.google.com` fulfilled locally so the redirect chain was really cross-site and nothing reached Google. A direct cross-site link to `/` landed on sign-in, which is why the return page exists. Copy worked with script on. A keyboard pass in both languages confirmed focus lands on the card heading, Enter there approves nothing, and Tab reaches the strip after the content. Forced-colours renders kept every state word. Playwright's WebKit loaded the Thai pages at 390 px with no overflow. No live Google call, real phone, Safari, Firefox, screen reader or Linux host was used, so the Google console labels in the guide are from public documents and were not walked through.

## 25. Coding, Git connection and exact push refinements (CODE14-01, CODE14-02)

Author: Claude Opus 5.5 (`claude-opus-5-5`), requested at effort high. Date: 2026-10-31. Code: `src/s14/web-coding.ts`, `web-coding-effect.ts`, `web-product-coding.ts`, `web-style-coding.ts`, the copy in `src/i18n/s14-coding-th.ts` and `s14-coding-en.ts`, plus small hooks in `web-pages.ts`, `web-product.ts`, `web-lifecycle.ts`, `web-recovery.ts` and the routine files. F9, F10, section 6 and section 7 stay the source. The prototype has no coding scenes, so everything about repositories and Git here is new design. Each change is **P** and presents only data the seam has. Where it conflicts with sections 16 to 22, this section wins.

| Area | Change | Why |
| --- | --- | --- |
| Routes | `/coding`, `/coding/new`, `/coding/repositories/:id`, `/coding/repositories/:id/start`, reached from More and from a Bot that has the coding tool. Work gains a Coding tab after Progress, shown only when the grant holds `coding`. | A repository is a resource, not a place in the main navigation. Section 3 keeps results under their work. |
| Grant form | URL, full commit, one radio per eligible Bot and the registry boxes, on one page, with the submit in the strip. The radio pins the Bot's free configured slot, and a browser address gains its `.git`. | The owner selects everything, and a slot is an internal the owner never picks. |
| No eligible Bot | One row per Bot with the reason and a Change this Bot's ceiling link, which opens the exact proposal with `computer` and `coding` ticked. `effect_push` stays unticked. | Same pattern as the section 22 share slot. Nothing is accepted by following it, and the right to ask for a push stays an explicit choice. |
| Registry control | Off is simply no host ticked. There is no master switch. The warning about data leaving is always visible under the boxes, repeats on the start form and on the repository page, and uses `--warn`. | The owner must read the risk before ticking, not after. A registry pill is never green, because it names a disclosure boundary. |
| Network words | One line on every repository surface: no internet for the Bot and ordinary commands. | Nothing may imply internet access. |
| Start form | Purpose, install line, test lines, limits, then what is allowed. Commands are split on spaces and quotes only, and the form says each runs without a shell. | The seam takes argv. A shell-looking box would promise pipes that do not exist. |
| Start time | Defaults to 120 minutes, not the saved 30, and the form says why. | A push must be approved inside the grant, so the limit also covers the owner's review. Research defaults stay unchanged. |
| Push permission | An unticked box on the start form, only when the Bot's ceiling has `effect_push`. Starting without it closes push for that work, and the Coding tab says so. | `effect_push` must be in the grant, and an owner should decide it up front. |
| Evidence order | Run banner, a fixed rule sentence, exact facts, commands, then the diff, then Git. | Commands stay above a long diff. |
| Green | A pass needs a recorded `passed`, exit 0 and no timeout. Anything else reads as Outcome unknown, whatever the state field says. | A result comes only from a real run. Model text never reaches this tab. |
| Unrun commands | Every planned command gets a row. With no record it reads Not run, and the heading counts it. | Failed and skipped must stay visible. A planned command must not vanish. |
| Output | Collapsed excerpts in an untrusted frame labelled as repository text, opened for a command that did not pass, closed while a page refreshes itself. | Live reads wait for an open section to close, so an open section would freeze the page. |
| Diff | The whole committed artifact, in its own horizontal scroller inside the untrusted frame. Lines keep their literal `+` and `-`, and colour only repeats them. Counts sit above. No line limit. | The service caps it at 32 KiB, so nothing needs cutting, and section 7 forbids clipping exact content. |
| Hash check | The page compares the artifact's SHA-256 with the run's `diffHash`, and a mismatch shows a `--danger` banner with no diff. | A file that is not the recorded one is not evidence. |
| Replay | Generic Retry, Summarize and Start as new work are removed from coding work. An interrupted run links to a new start on the repository. | The service refuses replay, and the generic link would start work that is not coding. |
| Connection | Create with a name, then a password field in the strip. A stored token shows Check, Replace and Remove, never its value. A refused post returns without it. | Two seam commands, and the stored value has no query. |
| Check word | Says the stored file is there and that this did not contact GitHub. | `git.connection.test` inspects local storage only, so "works" would be false. |
| Preparing a push | A plain form on the Coding tab, not in the strip, with the note that nothing leaves yet. PR fields appear when ticked, through CSS only. | A proposal grants nothing. Approval is the separate press. |
| Decide on the card | The Progress tab and chat show a summary and a link. Approve exists only on `/effects/:id`, under the diff and checks. | The contract requires review of the diff and checks before approval, and F9 keeps exact content above the buttons. |
| Exact block | Destination, ref, old and new commit, base, connection, then PR base, kind, title and body as literal text, then revision, hash and diff hash in full, and the canonical payload collapsed. | Each line is what the hash covers. Paraphrase stays out of mono. |
| Approve label | Push this once, or Push and open this PR once, plus the first eight hash characters. The strip note says no merge and no deploy. | The press names the action, the count and the binding. |
| Approve withheld | With no evidence to read, or evidence that does not match the card, Approve is absent and Deny stays. | The owner must not approve what cannot be read. The service check remains the boundary. |
| Weak tests | A partial run can still be approved, under a warning. | The seam allows it, and a green-only rule would hide a legitimate owner choice. |
| Changed diff | Failed, with the reason, Nothing was pushed, and no Approve. | A changed diff refuses the old approval. |
| Outcome facts | A grid of Push, PR, Confirmed from GitHub and Merge. Merge always reads None. | A refused PR can stand beside a pushed branch. |
| Reported versus confirmed | Only a read-back reads as confirmed. A stage that passed push without proof reads Reported pushed. An unconfirmed read-back reads Outcome unknown for both, even if an earlier reason implied more. | The stored reason is overwritten by later read-backs, so the page takes the weaker reading. |
| Unknown | Read back from GitHub in its own strip, then the existing statement form. Read-back words say it only reads. There is no third control. | F10 with the real seam: `git.reconcile` replaces "open the browser to check". |
| Read-back blocked | A rotated or removed connection, or a revoked repository, shows the reason, and the statement stays. | Those block read-back in the service, and the owner still needs a way to record what they found. |
| Following | The card follows approval and read-back by itself. Its heading takes no focus then. | A focused region defers live reads. No decision is on the page at that moment, so focus has nothing to protect. |
| Work forms | `coding` and `effect_push` leave the composer, task-start and routine forms. | They would do nothing there, and `coding` would have been ticked by default. |
| Tabs | Tab labels no longer wrap, and the row scrolls in its own box. | Six Thai tabs broke words at 390 px. |

**Seam limits at the initial ea7bc7f handoff (superseded by the PR #276 logic follow-up):** `coding.repository.grant` accepts only `policy.resources`, not the built-in slots, so a default install with no `JIT_S14_RESOURCES` reaches the no-slot banner and cannot grant a repository. This does not meet the just-works principle and is recorded for the owner. The base commit has no resolving query, so the owner pastes a full ID. Commands skipped after a failed install are stored only in `coding-checks.json`, so their rows read Not run with no reason. `git.connection.test` is local. The pull request is shown by number, as text.

**Verification:** rendering and form-contract tests are in `tests/s14-coding-ui.test.ts`, over the real application, scheduler, Git broker and handler with a generated repository, a scripted model and a scripted GitHub port: every run and card state, both languages, refused posts, write-only tokens and hostile repository, output, title and PR text. Playwright's Chromium for Testing on macOS loaded 14 seeded pages at 360, 390, 430, 820 and 1280 px in both themes and both languages (280 page loads), with no page overflow, no CSP or console error, no hostile element and no control under 40 px at phone widths. The only wide elements left are the work tabs and the existing timeline table, which scroll in their own boxes. With script disabled, the same browser ran the whole journey by real clicks in Thai and English: grant, connect, store the token, start, follow by reload, prepare, approve, then a confirmed result in English, and an unknown push, an unproved read-back and an owner statement in Thai. With script on, it confirmed the same journeys following live, focus on the card heading, and Enter there doing nothing. One forced-colours render of a finished card kept every state word. Firefox, Safari, a real phone, a screen reader, live GitHub, a live model route and a real Linux box were not used.

PR #276 logic follow-up preserves the section 25 layout and controls. The existing grant input accepts a branch or full commit; its label/help and bounds match the trusted resolver contract. Slot eligibility matches owner-accepted built-in/configured capability policy without an environment prerequisite. Command rows receive persisted skipped reasons, and the existing PR number links only to a validated provider HTTPS GitHub URL. No new UI/UX design is introduced; existing form, reason-row and link patterns are reused.

## 26. Routine controls, attention level and private branches (UX14-02)

Author: Claude Opus 5.5 (`claude-opus-5-5`), requested at effort high. Date: 2026-10-31. Code: `src/s14/web-routines.ts`, `web-product-routines.ts`, `web-lifecycle.ts`, `web-product-lifecycle.ts`, `web-coding.ts`, `web-product-coding.ts`, `web-style-routines.ts`, plus hooks in `web-pages.ts`, `web-product.ts`, `web-first-run.ts`, `web-style.ts`, `web-style-backup.ts` and the Thai and English dictionaries. F13, F14, Q7 and section 7 stay the source. Each change is **P** and presents only data the seam has. Where it conflicts with sections 22 and 25, this section wins: it replaces section 22's Schedule, Attention control, When a row leaves and No Discard rows.

| Area | Change | Why |
| --- | --- | --- |
| Dismiss | A fixed **Dismiss** beside a failed-run row and a report row on Home and Work, and on a routine's failure banner. It is a button next to the link, never inside it. A line under the groups says it clears the row, decides nothing and takes nothing back. Thai uses รับทราบ. | `attention.acknowledge` resolves a notice and answers nothing, so the words must not sound like a decision. รับทราบ says "noted", where a word for closing could read as stopping the routine. |
| What cannot be dismissed | A decision and a blocked routine have no Dismiss. Neither do external actions, proposals, unstarted work, recovery or accounts. | Acknowledging would leave the row where it is. A control that does nothing would be false, and those rows are real decisions. |
| Where Dismiss lands | Back on the page it came from: a `from` of home, work or routine, turned into a fixed path. A posted address cannot be followed. | The press should not move the owner. |
| Row name | The button's name stays fixed. `aria-describedby` points at the row's text, so a screen reader can tell two rows apart. | A title never sits on a button. A description is not a label, and the text stays escaped. |
| After dismiss | The routine page keeps its failure banner without the button, and history is unchanged. | History is the record. Only the attention row leaves. |
| Attention level | A card on More, "What appears in Needs you": Only what needs me (default), or Routine reports too. Failures and decisions always appear, and a note says it applies to new notices only. | `attention.set` now governs production reports. Failures are not a choice, so they are not offered as one. |
| Finding the level | One line at the foot of Routines says where new reports go, with a Change this link. | With the default, a report never reaches Needs you, and an owner should be able to see why. |
| Discard | **Discard this proposal** in the strip, after Accept and Change the selection, with a line saying nothing changes. It also appears on a proposal that matches today's ceiling. It is absent on stale, replaced, accepted or discarded proposals, which the service would refuse. | Plain weight, not danger: it loses nothing. It binds the same revision and hash as Accept, and the page says so through the same fields. |
| Discard landing | The Bot page with "Proposal discarded · The ceiling stays as it was". A share-sheet or account return survives. | The generic "really finished" line would imply a change. |
| Run once now | Its own closed slip directly under the capture: what it uses, the same scope, this run's limits, and that the schedule stays. A warning replaces the schedule row on the last run. The strip holds one button, and the note says findings and external actions stay as they are. | It belongs beside the capture it is bound to, so the owner reads the budget before the press. The command carries only the routine and revision, so nothing on the page can widen it. |
| When it is absent | Paused, blocked, used up, revoked or past the end date show no slip. While a run is open, one line says it returns when that run ends. | The service would refuse. "Resume" stays the only press on a paused routine. |
| Weekly | A fourth row, Every week on [day] at [time], Monday first, with a note that the clock time holds through clock changes. The capture reads "Every Monday at 08:00 · Asia/Bangkok". The first run and next run add the weekday. | The zone is already a visible, captured field, and the note appears only on the chosen row. The weekday lets the owner check the date against the promise. |
| Weekly fields | Its own `day` and `weekTime` fields, separate from the daily `time`. | One form cannot carry two fields of one name, and each row must keep its own typing across a review and a refusal. |
| Delete | A revoked routine offers a link to `?confirm=delete`: a slip above the capture with the two reach lists, a note that keeping it costs nothing, then one danger press and Keep this routine. Focus lands on the heading, where Enter does nothing. It lands on the list with a banner reread from the receipt. | A deleted routine has no page. A separate address means a stray press on the routine page cannot be the delete. |
| Delete hold | While the routine has open decisions, the slip explains that and has no press. | The Home row for a finding lives on its routine, so deleting first would take an unanswered decision out of Needs you. This is withheld by the page, see the seam gaps. |
| Private path | `/coding/connect`: three named steps, one page each. Choose the Bot, store the token, then the grant form locked to that token. The address is typed last. | A connection must exist before the grant, and without script a step away from the form would lose what was typed. In this order nothing can be lost. |
| Locked grant | The field reads Branch, with a note on what the read does and does not do. Bot and token are shown as facts, and a link goes back to the open form. A full commit still works, and then no read happens and no token is named. | The radio would otherwise be a second, conflicting choice. |
| Waiting tokens | Listed on the grant form under Private repository, with Use this token or Finish connecting. Remove sits on the connect page. | A half-finished connection has to be findable after a reload. Reads come from stored records, so the steps cannot drift. |
| Token field | Write-only, as in section 25, with a note that read access to Contents is enough to pin and that a push needs more. | Asking for less is the honest default. Section 25's note assumed a push. |
| Repin | A closed slip under Git connections on an active repository: branch, one radio per stored token, and a note that this is a fixed Git read, starts nothing, and that work already started on the old commit loses its access. With no stored token, one line says so. | The commit is the only thing that changes, and the side effect on running work belongs next to the press. |
| Step lists | The setup rail is now `.s-setup-steps`, and `.s-steps` stays the vertical stage list used by lifecycle, push and backup. Backup's overrides for the collision are gone, and connect reuses the stage list. | Before this, Chromium showed setup as a stacked column with both a top and a left border and no 24 px space under it, and the stopping card as boxed 12 px rows, because the later rule combined with the earlier one. |

**Seam gaps shown as they are:**

- `app.attention.view` returns the newest 100 notices, so a row whose notice is older shows no Dismiss. It still clears when a newer run settles or the routine is revoked.
- `routine.delete` does not refuse open decisions. The page withholds the press, but a JSON caller can delete first. The finding then stays Work, while the routine row that spoke for it is gone and `routineAttention` still hides it from the task rows.
- A connection stores a slot, not a Bot. The Bot chosen on the first step travels in the address, and it only narrows the page. Opening a waiting token from the list, where two Bots hold that slot, asks again.
- A public grant may take a slot that already holds a waiting token, when that Bot has no other free slot. The token then appears under that repository. It is visible and removable, but the UI cannot prevent it.
- Branches cannot be listed, so the name is typed. `coding.repository.resolve` requires a connection, so a public repository has no repin.
- History does not mark a manual run, so a Run once now row reads like a scheduled one.
- The page cannot see the recovery or backup barrier, so Run once now can be refused with `routine_not_ready`. The refusal explains it.

**Verification:** rendering and form-contract tests are in `tests/s14-routine-controls-ui.test.ts`, over the real application and handler with scripted executors and a scripted `git ls-remote` behind the real broker: every control in both languages, each state a control must be absent from, stale and forged posts, refused posts that keep the typing, write-only tokens, spoofed landing links and hostile titles. Chromium on macOS first confirmed the collision, then loaded 20 seeded pages at 360, 390, 430, 820 and 1280 px in both themes and both languages (400 page loads), with no page overflow, no CSP or console error, no hostile element and no control under 40 px at phone widths. The same browser ran 8 journeys in Thai and English, with script off and on (32 runs): dismiss, attention level, discard, weekly enable, run once now, revoke and delete, connect and grant a private branch, repin. That run found the two-Bot repeat, which is now fixed. A keyboard pass confirmed Tab reaches Dismiss and its description resolves, and that Enter on the delete heading deletes nothing. Forced-colours renders kept the state words. Playwright's WebKit loaded the 20 pages at 390 px in both languages with no overflow. Firefox failed to start here. No real phone, Safari, screen reader, live GitHub, real private repository, Linux host or live model was used. The switch from "a run is in progress" back to the slip when a run settles was not seen live, and the repin note about running work comes from the contract and was not exercised.

## 27. Acceptance run refinements (EVID14-01, S14-AC13)

From the [EVID14-01](../tickets/s14/EVID14-01.md) live run. Authority, grants and domain logic did not change. Each item is **P** unless marked. Per-engine results stay in the private evidence record.

| Finding | Decision | Label |
| --- | --- | --- |
| A refused post and a saved landing were plain banners, so neither appeared as an announcement | A refusal is `role="alert"`, a landing after a command is `role="status"`, and the failure page is an alert. The words stay the ones the page already shows | R (NFR-11) + P |
| A chat or Bot page opened during a ceiling change stayed closed after the Bot became active again | The foot of a chat and the Bot overview are live regions while a transition settles. A chat reopens by itself, the status region says so, and the page keeps a no-script refresh link. A closed foot always links to the Bot | P |
| A ceiling change read the same as a retired Bot | "{Bot} is changing its ceiling" says it clears by itself. "This chat can't take new messages now" stays for a Bot that will not come back on its own | P |
| A post refused during a transition lost its text, though the page promises to keep it | The composer stays with the text beside the closed notice. The service still refuses the send | R (F2 draft rule) + P |
| A live read that closed a chat replaced the composer and its unsent text | Script holds the text and options in page memory only, shows the text read-only under the closed notice and puts both back on the next composer, on that composer's fresh revisions. A choice no longer offered stays gone. With no script nothing is replaced, so a refused post returns its text on the response. No draft is stored on the server or in the browser, and leaving or reloading the page clears it, as the page says | P |
| The chat's own Bot was a hidden field, so a person could tick two Bots under a limit of 2 and not see a third run | The Bots group has a legend and a fixed text row for the chat's Bot, which says it takes one place. A note states that every Bot researches, what queues, and who writes the summary. It is words, not a control: the lead stays fixed and no limit is checked in the browser | P |
| A queued lane named the limit but not who held it | "Places in use: Scout · Analyst" sits under a lane held by this work's limit, from recorded running steps only | P |
| A vendor reset time existed but the copy said it was unknown | The time appears only when one was recorded. Absent still reads as unknown, never as ready | R (Honest gaps) + P |
| The composer's focus was a 1 px border change | It gains a second pixel, drawn as a ring | R (NFR-11) + P |
| Forced colours dropped the selected work chip and the current page marks | They use system colours or an outline in that mode | P |
| A phone on its side gave the composer over a third of the height | Under 480 px tall, the header and composer compact and the thread keeps the height | P |

The work pane at 680–1039 px is a full replacement of the chat column, not the overlay in section 4. Focus stays contained because the chat column is not rendered, so this refinement keeps it.
