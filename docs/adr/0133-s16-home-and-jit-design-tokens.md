---
status: implemented
date: 2026-11-23
scope: S16 client presentation; FR-28, FR-35; NFR-07, NFR-09
---

# Make S16 the home experience and draw it with the Jit design tokens

The S16 React client carried the complete product behaviour but was drawn as a
wireframe: system fonts, a grey-blue palette, text glyphs for controls and a
fixed bottom bar on phones. The server-rendered S15 pages already followed the
Jit design system in `src/web-design.ts` (`ui.design_tokens/v1`). An owner
who opened `/` also landed on the older S15 conversation and reached S16 only
by typing its address. On 2026-11-22 the owner asked for the whole experience
to read as one current product and allowed earlier presentation rules to
change where that was warranted.

Decisions:

- The composed service sends `/` to `/s16` once the standing rules are
  current. `S15WebOptions.home` carries the target; the handler's own default
  stays a new S15 conversation, and an installation without current rules
  still goes to `/setup`. S15 pages and their addresses are unchanged.
- The S16 stylesheet uses the Jit tokens: monochrome surfaces, no brand
  accent, Inter with Noto Sans Thai, the 8/14/24 radii and a 720 px
  conversation column. State colour is limited to ok/warn/danger.
- The typefaces ship inside the public desktop package as content-addressed
  assets together with their SIL OFL texts. The stylesheet names them through
  a `jit-font:` placeholder that the package build replaces, so a font byte
  changes the release identity. The CSP gains `font-src 'self'` only.
- Controls use authored line icons from `src/s16/web/icons.tsx`. Icons are
  decorative; each control keeps its accessible name. Replies render a
  bounded Markdown subset as React elements, never as HTML, with no images
  and with the real host shown beside a link whose text hides it.
- On narrow screens the rail is a drawer over a scrim and the header carries
  Menu, Needs you, back to the conversation and New conversation. The fixed
  bottom bar is removed.
- The native mobile client uses the same palette through its own style
  table. It gains no dependency and no native change.

Presentation only: no protected route, capability, approval path, session
rule or stored record changes. Model output still cannot approve anything;
starter prompts only fill the composer.
