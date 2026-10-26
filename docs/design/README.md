# Jit visual system

Status: confirmed direction for [S09](../specs/S09-main-bot-and-chat-first-ui.md) (owner decisions S09-D05, D06, D08, D10–D13). UX01 checked the token values below against contrast tests and kept them unchanged. They are now implemented in `src/web-design.ts` (`ui.design_tokens/v1`, see [the contract](../contracts/web-design-system-v1.md)). Change values there and here together.

## Principles

1. **Quiet like Grok.** Use monochrome surfaces, few lines and no decoration, so the conversation stays the hero.
2. **Calm but powerful.** Use stable shapes, generous spacing and slow motion. Nothing bounces.
3. **Thai only in the mark.** The logo and the "จิต" wordmark carry the Thai identity. The interface itself stays neutral.
4. **Every state has words.** Status is never shown by colour or animation alone (NFR-11).

## Logo — "บอทนั่งสมาธิ" (concept D)

![Concept D](assets/logo-concept-d.png)

This raster image is the AI-generated concept the owner chose. UX01 redraws it as hand-built SVG on a 24-unit grid:

- **Head:** a rounded square with two thin closed-eye arcs cut out as negative space.
- **Body:** a wide, low, rounded seated base. The width gives stability and power. No limbs.
- **จุดตั้งจิต:** a small solid dot floating above the head. It is the only animated part. It breathes on a 4.8 s cycle while Jit is thinking, and stays static when `prefers-reduced-motion` is set.
- **Halo:** one thin ring behind the figure. Drop it below 24 px.

Rules:

- Use one colour only, `--fg` on `--bg`.
- Do not add Buddhist iconography: no ushnisha, lotus throne, unalome, flames or gold leaf.
- Tone down cuteness compared with the concept image: smaller eyes, a heavier base and no blush or smile.
- Lockup: mark plus the "จิต" wordmark (custom SVG lettering, not font text) with "JIT" small caps under it. Use the mark alone for the favicon, PWA icon and avatar.

The UX01 drawing lives in `src/web-logo.ts`: `logoMark` (24-unit grid, halo only at 24 px and above, thicker eye cuts below 24 px), `logoLockup` (loopless stroked จ, ิ and ต; drawn "JIT" caps) and `faviconSvg` (mark without halo on a dark tile). The dot breathes only inside `[data-state="thinking"]`, which BOT01 sets while Jit is replying.

## Colour tokens

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
| `--ok` / `--warn` / `--danger` | `#86efac` / `#fde047` / `#fca5a5` | `#15803d` / `#a16207` / `#b91c1c` | Semantic text and icons only |

There is no brand accent colour. Focus rings use `--fg` at 2 px with a 2 px offset.

UX01 contrast results (WCAG 2.x, tested in `tests/web-ui.test.ts`). The lowest ratio of each family is shown; every listed pair passes AA (4.5:1).

| Pair | Dark | Light |
| --- | --- | --- |
| `--fg` on `--bg` / `--surface-3` | 16.9 / 12.9 | 19.0 / 16.6 |
| `--fg-2` on `--surface-2` | 6.8 | 7.1 |
| `--fg-3` on `--surface-2` (lowest meta pair) | 4.9 | 4.8 |
| `--on-fg` on `--fg` (primary button) | 16.9 | 19.0 |
| `--ok` / `--warn` / `--danger` on `--bg` | 14.1 / 15.0 / 10.4 | 4.8 / 4.7 / 6.2 |

Derived non-text tones (`--line-strong`, the tinted status backgrounds and lines) are `color-mix` values of the tokens above and carry no text.

## Type

- Inter for Latin, Noto Sans Thai for Thai (loopless) and JetBrains Mono for code. All three are self-hosted variable WOFF2 (ADR 0028). The vendored releases, hashes and OFL licences are listed in `src/web-assets/fonts/README.md`.
- Scale: 12, 13, 14 (UI), 15 (chat body), 18, 24, 32 (home greeting). Weights are 400, 500 and 600 only.
- Line height: 1.7 for Thai-heavy chat text, 1.4 for UI labels. Use `letter-spacing: -0.015em` on sizes of 24 px and above only.

## Shape, space and motion

- Radius: 8 px for controls, 14 px for cards, 24 px for the composer, full pill for chips and buttons.
- Spacing on a 4 px base. The chat column is at most 720 px wide.
- Motion: 160 ms ease-out for UI transitions, 240 ms for the drawer and panels, 4.8 s for breathing. The ตั้งจิต ceremony is one 1.6 s sequence: the halo draws in, then the dot rises and settles. All motion stops under reduced motion.

## Layout

- **Home:** greeting, a large composer with a project chip (default "ทั่วไป"), and a quiet strip of items waiting on the owner.
- **Sidebar:** new chat, search (⌘K), projects with nested topics, badges for pending items, and settings at the bottom. On mobile it becomes a drawer.
- **Topic:** a single chat column. The right panel, closed by default, holds memory, tasks, jobs, PR reports and the team.
- **Settings:** persona, models and routes, dispatch allowance, appearance and language, Telegram, backups, upgrades, restores, exports and deletions. UX01 ships appearance and language (owner-persisted, `ui.preferences/v1`) and links to team, backups, upgrades and restores. Until the right panel exists, a project's memory, tasks, jobs, notifications and team links sit under the selected project in the sidebar.

## Components

Composer, message (owner bubble or Jit plain text), team card (collapsible, per-role state with stop and skip), proposal card (role, dispatch or promotion, with accept, edit and dismiss), decision chip, status pill with text, command palette, drawer, right panel, setup steps, toast. Each component exists in dark, light, Thai and English.

## Voice

- Thai is the default. Write short, calm, direct sentences.
- The setup verb is **ตั้งจิต**. Do not use "อธิษฐาน" in the UI.
- Name the next action in errors: "เชื่อมจิตไม่สำเร็จ — ตรวจบัญชี Grok แล้วลองอีกครั้ง".

## UX01 screenshots

These show the fixture installation used for review. Columns are dark Thai, dark English, light Thai and light English. Rows are home, topic and team.

![UX01 shell matrix](assets/ux01-shell-matrix.png)

The next image shows the mobile topic page, the drawer opened with `#sidebar` (no script needed) and the settings page.

![UX01 mobile and settings](assets/ux01-mobile-settings.png)
