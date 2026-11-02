# Jit visual system

The owner-approved S14 Plain replacement uses its warm monochrome palette and shell dimensions from `src/s14/web-design.ts`, preserving the same contrast, local-font and token-lint rules. See [S14 Plain](S14-plain-experience.md) and [ADR 0062](../adr/0062-s14-browser-navigation-and-drafts.md). The shared tokens and historical legacy evidence below remain unchanged.

Status: confirmed direction for [S09](../specs/S09-main-bot-and-chat-first-ui.md) (owner decisions S09-D05, D06, D08, D10–D13). UX01 checked the token values below against contrast tests. One value changed: light `--warn` went from `#a16207` to `#8f5706`, because the original was 4.47:1 on `--surface-2`. They are now implemented in `src/web-design.ts` (`ui.design_tokens/v1`, see [the contract](../contracts/web-design-system-v1.md)). Change values there and here together.

## Principles

1. **Quiet like Grok.** Use monochrome surfaces, few lines and no decoration, so the conversation stays the hero.
2. **Calm but powerful.** Use stable shapes, generous spacing and slow motion. Nothing bounces.
3. **Identity only in the mark.** The meditating-bot logo and the "Jit" wordmark carry the identity. The interface itself stays neutral.
4. **Every state has words.** Status is never shown by colour or animation alone (NFR-11).

## Logo — "บอทนั่งสมาธิ" (concept D)

![Concept D](assets/logo-concept-d.png)

This raster image is the AI-generated concept the owner chose. The SVG is hand-built on a 24-unit grid with its geometry measured from this image, so it keeps the concept's proportions:

- **Head:** a big rounded square (corner radius about a quarter of its width) with two closed-eye arcs cut out as negative space, set a little below the middle.
- **Neck:** a small gap where the head's rounded corners meet the shoulders, so the head reads as a separate shape.
- **Body:** rounded shoulders just under the head, a gentle slope, then a base that flares into two soft cloud-like lobes. No limbs.
- **จุดตั้งจิต:** a small solid dot floating above the head. It is the only animated part. It breathes on a 4.8 s cycle while Jit is thinking, and stays static when `prefers-reduced-motion` is set.
- **Halo:** one thin ring behind the figure. Drop it below 24 px.

Rules:

- Use one colour only, `--fg` on `--bg`.
- Do not add Buddhist iconography: no ushnisha, lotus throne, unalome, flames or gold leaf.
- Keep the concept's cuteness: its head-to-body proportions, eye size and soft base. Do not add a blush, a smile or other features. (Owner decision, 2026-10-27; it replaces the earlier rule to tone the cuteness down.)
- Lockup: mark plus the "Jit" wordmark (custom SVG lettering, not font text). No Thai wordmark. Use the mark alone for the favicon, PWA icon and avatar. UX03 draws the PWA icons from the same favicon geometry (`appIcon` in `src/web-logo.ts`, rasterized by `src/web-icons.ts`): a rounded tile for `any`, a full-bleed tile with the figure inside the 80 % safe circle for `maskable`, and a full-bleed 180 px tile for iOS.

The UX01 drawing lives in `src/web-logo.ts`: `logoMark` (24-unit grid, halo only at 24 px and above; below that the figure moves up to stay centred and the eye cuts get thicker), `logoLockup` (round-capped stroked "Jit") and `faviconSvg` (mark without halo on a dark tile). The dot breathes only inside `[data-state="thinking"]`, which BOT01 sets while Jit is replying.

## Colour tokens

NFR-13 ([S10](../specs/S10-reliability-and-owner-integrations.md)): colours, text sizes, radii and durations come only from these tokens. A CI check (`ui.token_lint/v1`) fails on literal values outside `src/web-design.ts`. See [ui.token_lint/v1](../contracts/ui-token-lint-v1.md) for the rule list and the long-motion allowlist.

| Token | Dark (default) | Light | Use |
| --- | --- | --- | --- |
| `--bg` | `#0a0a0a` | `#fafaf9` | Page |
| `--surface-1` | `#141414` | `#ffffff` | Sidebar, cards |
| `--surface-2` | `#1c1c1c` | `#f4f4f3` | User bubble, inputs |
| `--surface-3` | `#262626` | `#ebebea` | Hover, pressed |
| `--line` | `#262626` | `#e7e7e5` | Hairlines |
| `--fg` | `#ededed` | `#0a0a0a` | Primary text, primary button background |
| `--fg-2` | `#a3a3a3` | `#525252` | Secondary text |
| `--fg-3` | `#8a8a8a` | `#6b6b6b` | Meta text (AA on `--bg`) |
| `--on-fg` | `#0a0a0a` | `#fafaf9` | Text on primary button |
| `--ok` / `--warn` / `--danger` | `#86efac` / `#fde047` / `#fca5a5` | `#15803d` / `#8f5706` / `#b91c1c` | Semantic text and icons only |

There is no brand accent colour. Focus rings use `--fg` at 2 px with a 2 px offset.

UX01 contrast results (WCAG 2.x, tested in `tests/web-ui.test.ts`). The lowest ratio of each family is shown; every listed pair passes AA (4.5:1).

| Pair | Dark | Light |
| --- | --- | --- |
| `--fg` on `--bg` / `--surface-3` | 16.9 / 12.9 | 19.0 / 16.6 |
| `--fg-2` on `--surface-2` | 6.8 | 7.1 |
| `--fg-3` on `--surface-2` (lowest meta pair) | 4.9 | 4.8 |
| `--on-fg` on `--fg` (primary button) | 16.9 | 19.0 |
| `--ok` / `--warn` / `--danger` on `--surface-2` (lowest semantic pair) | 12.1 / 12.9 / 9.0 | 4.6 / 5.4 / 5.9 |

Derived tones (`--line-strong` and the tinted status borders) are `color-mix` values of the tokens above and carry no text. Status pills and error boxes have transparent backgrounds, so semantic text always sits on a tested surface.

## Type

- Inter for Latin, Noto Sans Thai for Thai (loopless) and JetBrains Mono for code. All three are self-hosted variable WOFF2 (ADR 0028). The vendored releases, hashes and OFL licences are listed in `src/web-assets/fonts/README.md`.
- Scale: 12, 13, 14 (UI), 15 (chat body), 18, 24, 32 (home greeting). Weights are 400, 500 and 600 only.
- Line height: 1.7 for Thai-heavy chat text, 1.4 for UI labels. Use `letter-spacing: -0.015em` on sizes of 24 px and above only.

## Shape, space and motion

- Radius: 8 px for controls, 14 px for cards, 24 px for the composer, full pill for chips and buttons.
- Spacing on a 4 px base. The chat column is at most 720 px wide.
- Motion: 160 ms ease-out for UI transitions, 240 ms for the drawer and panels, 4.8 s for breathing. The ตั้งจิต ceremony is one 1.6 s sequence: the halo draws in, then the dot rises and settles. The streaming dot after Jit's draft reuses the breathing. All motion stops under reduced motion.

## Layout

- **Home:** greeting, a large composer with a project chip (default "ทั่วไป"), and a quiet strip of items waiting on the owner. BOT05 implemented it ([app.topic_promotion/v1](../contracts/topic-promotion-v1.md)): the chip is a plain `<select>`, the composer posts `chat.start` (a new topic plus its first message, answered by Jit), and the strip names each project with items waiting, in words and a number. Projects and project creation follow below.
- **Sidebar:** new chat, search (⌘K), projects with nested topics, badges for pending items, and settings at the bottom. On mobile it becomes a drawer.
- **Topic:** a single chat column. The right panel, closed by default, holds memory, tasks, jobs, PR reports and the team.
- **Settings:** persona, models and routes, dispatch allowance, appearance and language, Telegram, backups, upgrades, restores, exports and deletions. UX01 shipped appearance and language (owner-persisted, `ui.preferences/v1`). UX02 moved team and models, Telegram status, backups, upgrades, restores and project data (exports and deletions) under `/settings/*`, with a sub-navigation of section pills on every settings page. Old page URLs redirect there. BOT01 added the persona to the general page; BOT04 added Team dispatch (`/settings/dispatch`) with one allowance form per project. See [web.settings_ia/v1](../contracts/web-settings-ia-v1.md).
- **Right panel (UX02):** a header toggle on the topic page opens an aside with five tabs: memory, tasks (filtered to the topic, with "waiting on you" first), jobs, PR reports and team. It is closed by default. Without script the toggle opens the panel as its own page. Project pages outside a topic show the same five destinations as a project tools strip.
- **⌘K (UX02):** a centred dialog with one query field, rows labelled by kind (project, topic, go to) and a hint line. It is keyboard-first (↑ ↓ Enter Esc). Without script the sidebar search link opens a search page.
- **Badges (UX02):** an outlined pill after the project name, "รอคุณ 2" / "Waiting 2", counting proposals, close reviews and jobs awaiting resume. It always uses words, not colour alone.
- **Mobile and installed app (UX03):** at 360–430 px the sidebar is the drawer, the composer stays at the bottom, and no page scrolls sideways. Jit installs as a standalone app (`web.pwa/v1`, [contract](../contracts/web-pwa-v1.md)). With `viewport-fit=cover`, every edge that touches the screen keeps the device safe-area inset clear: the status bar, the notch and the home indicator. Below 520 px the setup step names wrap between words instead of being cut off. The service worker caches only static assets, never pages or data.

## Components

Composer, message (owner bubble or Jit plain text), team card (collapsible, per-role state with stop and skip), proposal card (role, dispatch or promotion, with accept, edit and dismiss), decision chip, status pill with text, command palette, drawer, right panel, setup steps, toast. Each component exists in dark, light, Thai and English.

Attachments (ATT03, [app.attachments/v1](../contracts/app-attachments-v1.md)):
- **Composer:** while `JIT_ATTACHMENTS` is on, a paperclip sits at the left of the bottom bar. Files can be picked, pasted (a screenshot) or dropped anywhere on the page, and the composer frame turns dashed with "Drop files here to attach" while a drag hovers.
- **Upload chips:** each file becomes a chip above the bar showing a kind icon (or the server's re-encoded thumbnail), the name, the size, its state in words (uploading with a percentage and a thin progress line, waiting for the safety check, ready, or not attached with the reason) and a × button.
- **Notices:** the provider notice appears under the chips and in the composer note. On a host without the container sanitizer, the note also says why PDF and WebP are off.
- **Transcript:** under a message, chips show a 48 px thumbnail (re-encoded images only, opening in a new tab) or a kind icon, the name, kind and size, the state in words and a download button. PDFs are never shown inline.
- **No-script and mobile:** without script, the browser's own file input replaces the paperclip and chips. On mobile, the upload chips scroll sideways.

The proposal card is `proposalCard` in `src/web-proposal-card.ts` (BOT03). It sits under the Jit reply that carries it. It shows a kind line, the title, a status pill in words, the revision and its author, the fields, a warning-ruled list of what was dropped from Jit's suggestion and an authority note. Actions are plain form posts. BOT03 renders role proposals with it ([app.role_proposals/v1](../contracts/role-proposals-v1.md)), and later kinds pass their own fields and actions. BOT05's promotion card (`promotionProposalCard`) shows the new project name, the origin topic and what accepting does; accepting opens the new topic, whose first block is an expandable "ต่อจากทั่วไป" / "Continued from General" quote of the origin at the linked revision, while the origin shows a read-only banner and a closed composer.

## Voice

- Thai is the default. Write short, calm, direct sentences.
- The setup verb is **ตั้งจิต**. Do not use "อธิษฐาน" in the UI.
- Name the next action in errors: "เชื่อมจิตไม่สำเร็จ — ตรวจบัญชี Grok แล้วลองอีกครั้ง".

## UX01 screenshots

These show the fixture installation used for review. Columns are dark Thai, dark English, light Thai and light English. Rows are home, topic and team.

![UX01 shell matrix](assets/ux01-shell-matrix.png)

The next image shows the mobile topic page, the drawer opened with `#sidebar` (no script needed) and the settings page.

![UX01 mobile and settings](assets/ux01-mobile-settings.png)

## BOT01 screenshots

These show a scripted fixture installation ([app.jit_reply/v1](../contracts/jit-reply-v1.md)). The first is dark Thai. A fixture reply is committed, and a second reply is still thinking: the mark's dot breathes, the provisional text is marked as not saved, and stop and refresh links are shown.

![BOT01 thinking, dark Thai](assets/bot01-thinking-dark-th.png)

The same topic in light English:

![BOT01 thinking, light English](assets/bot01-thinking-light-en.png)

A reply blocked on quota names the next action and keeps the same route:

![BOT01 quota blocked, dark Thai](assets/bot01-blocked-dark-th.png)

The persona form in settings:

![BOT01 persona settings, light English](assets/bot01-persona-light-en.png)

## BOT03 screenshots

These show a scripted fixture installation ([app.role_proposals/v1](../contracts/role-proposals-v1.md)). Jit's reply carries two role proposals. The first uses a configured route. The second asked for a shell tool, a budget and a route that is not configured; the card lists what was dropped, and the role would use the default route. Both are waiting on the owner: Create, Dismiss or Edit.

![BOT03 role proposal cards, light Thai](assets/bot03-proposal-light-th.png)

The same cards in dark English:

![BOT03 role proposal cards, dark English](assets/bot03-proposal-dark-en.png)

## BOT02 setup ("ตั้งจิต")

Setup is one calm card per step, outside the workspace shell ([app.setup/v1](../contracts/setup-v1.md)). A step list across the top labels every step as done, current or later in words. The steps are ตื่น, เชื่อมจิต, รู้จักกัน, นิสัยของจิต (which can be skipped) and ตั้งจิต. Every step is a plain form post. The script only plays the ceremony: the halo draws in, then the dot rises and settles, in one 1.6 s sequence (`--motion-ceremony`). Under reduced motion or without script the final form posts at once. These images use a scripted fixture installation.

The wake step in dark Thai, with the TH/EN toggle:

![BOT02 wake, dark Thai](assets/bot02-wake-dark-th.png)

The connect step after a scripted-host check. A fixture answer is "unverified", never "verified", and the next action is named:

![BOT02 connect, dark Thai](assets/bot02-connect-dark-th.png)

The ceremony with its summary, in light English:

![BOT02 ceremony, light English](assets/bot02-ceremony-light-en.png)

Jit's greeting is the first message of the General space, in the persona's language:

![BOT02 greeting, dark Thai interface](assets/bot02-greeting-dark-th.png)

## BOT05 chat-first home and topic promotion

These show a scripted fixture installation ([app.topic_promotion/v1](../contracts/topic-promotion-v1.md)). The home greets the owner by the persona's address. Its composer's project chip defaults to the General space, and the strip below names a project that has an item waiting:

![BOT05 home, dark Thai](assets/bot05-home-dark-th.png)

A General topic where Jit suggests a promotion. The card names the origin topic and says what accepting does and does not do:

![BOT05 promotion card, dark Thai](assets/bot05-card-dark-th.png)

After acceptance, the origin is read-only. It shows a banner, a closed composer and links to the continuation:

![BOT05 promoted origin, dark Thai](assets/bot05-origin-dark-th.png)

The continuation opens with the expandable "ต่อจากทั่วไป" block, which shows the origin at the linked revision:

![BOT05 continuation, dark Thai](assets/bot05-continued-dark-th.png)

The same block in English:

![BOT05 continuation, dark English](assets/bot05-continued-dark-en.png)

## UX03 screenshots

These show a scripted fixture installation (`tests/fixtures/ux03.ts`) at 390 px. The top row is dark Thai and the bottom row is light English. The columns are:

1. home;
2. a topic with a role proposal;
3. a General topic with a long unbroken message and a promotion card;
4. the drawer opened through `#sidebar`;
5. a setup step.

![UX03 mobile matrix](assets/ux03-mobile-matrix.png)

The install icons, from left to right: `any` (512 px, with transparent corners shown grey), `maskable` and the iOS touch icon:

![UX03 install icons](assets/ux03-icons.png)

## STR01 streaming reply

Jit's reply streams into the place where the committed message will land ([web.reply_stream/v2](../contracts/web-reply-stream-v2.md#owner-experience-and-no-script)):

- **Draft.** The draft has the same size, colour and spacing as the committed text. A small dot after the last character breathes like the mark's จุดตั้งจิต and is static under reduced motion. Under the draft, a quiet line reads "ร่างคำตอบ ยังไม่บันทึก" / "Draft reply, not saved yet".
- **Commit.** The committed text takes the draft's slot, and the line becomes "✓ บันทึกแล้ว" / "✓ Saved". The actions row keeps its height when Stop goes away, so nothing moves.
- **Pauses.** "จิตยังทำงานอยู่…" (no new text for 10 s) keeps the calm running pill. A reconnect is routine and silent. Only a gap longer than 3 s dims the draft and adds a muted hint, "กำลังเชื่อมต่อใหม่… จิตยังทำงานต่อระหว่างนี้". A stream that will not retry points to "ดูสถานะล่าสุด". None of these use error colours.
- **Scrolling and screen readers.** The view follows the stream only while the owner is at the bottom. Screen readers hear one polite line per phase change (replying, still working, connection, finished), never each token.

The image shows a scripted fixture at 390 px. From left to right, in dark Thai: thinking, still working and reconnecting. Then, in light English: replying, committed, and live updates stopped.

![STR01 streaming states, mobile](assets/str01-stream-matrix.png)

## S12 one voice: short replies, quiet team, reply chips

COMM01, COMM02 and COMM04 (S12-D05, D06, D08) keep the conversation to one short, calm voice.

- **Short replies.** Jit answers first, in a few short sentences, with no headings, preambles or "anything else?" sign-offs ([app.communication_policy/v2](../contracts/communication-policy-v2.md)). Long or multi-step work gets one line in chat, plus a task suggestion card under it: an open team card titled "จิตเสนอให้เก็บเป็นงาน" / "Jit suggests saving this as a task", holding the usual propose-as-task form already filled in, and the note that nothing is saved until the owner presses save.
- **Quiet team.** When Jit calls specialists, its reply is one line saying whom it is asking. The team card stays collapsed to one summary line: "กำลังถาม เทคโนโลยี, ออกแบบ" while the team works, "ทีมตอบแล้ว: เทคโนโลยี, ออกแบบ" after the team answer, and "ถาม … แล้ว" when the team stopped without one. The status pill keeps the counts in words. The card opens by itself only when something waits on the owner (a route wait, a blocked result, a hold or a failed team answer). Notifications default to "Only what needs me" ([dispatch allowance](../contracts/dispatch-allowance-v1.md#quiet-team-work-s12-d06)).
- **Reply chips.** Under Jit's newest answer, 1–3 suggested replies sit as quiet outlined pills (the `.choice` look: `--line-strong` border, pill radius, `--size-sm`). Long Thai text wraps inside the pill and never scrolls the page sideways. A tap sends exactly that text as the owner's message. Chips never appear beside a proposal, task, MCP, dispatch or approval card, or while any reply is live ([reply chips](../contracts/jit-reply-v1.md#s12-comm04-reply-chips)). With script, the chips appear in place when the streamed answer is saved.

## S14 design proposal

The [S14 experience](S14-bot-first-experience.md) and [standalone interactive prototype](s14-bot-first-prototype.html) are authored by Claude Opus 5.5 with orchestrator effort high. They propose the bot-first replacement for the project-centric layouts documented above. See the [approved product spec](../specs/S14-bot-first-local-assistant.md) and [parent contract/factual resolutions](../contracts/s14-authority-and-design-resolutions.md). The prototype is fixture-only and is not the shipped product.
