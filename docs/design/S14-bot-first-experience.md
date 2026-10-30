# S14 bot-first experience

Parent: [S14 spec](../specs/S14-bot-first-local-assistant.md), [design brief](S14-design-brief.md), issues [#244](https://github.com/chayapats/jit/issues/244) and [#245](https://github.com/chayapats/jit/issues/245).
Author: Claude Opus 5.5 (`claude-opus-5-5`), as the sole UI/UX designer required by S14-D14. Parent verification: orchestrator creation, completed-task metadata and read-only thread configuration confirm `effort: high`. The delegate saw an internal numeric value of 25; no mapping from that value is asserted. Date: 2026-10-30.
Interactive review artifact: [s14-bot-first-prototype.html](s14-bot-first-prototype.html). It runs on fixture data and connects to nothing.

Parent contract/factual review: [authority and design resolutions](../contracts/s14-authority-and-design-resolutions.md) resolves Q1–Q7 and P-E1–P-E3 without replacing the designer's UI/UX. In particular, model classification cannot mint a grant; existing forms can support script-free takeover; the visual OwnerStrip is not an authorization boundary. Parent rendered three sample states with `html_preview`; the source prototype remains unchanged.

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
| รอคิว / Queued | Capacity is full. It will start on its own. |
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
| blocked | รอหลักฐาน | Waiting for evidence | neutral | hollow |
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
