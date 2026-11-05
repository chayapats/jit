# S16 artifact library design

Authored by the primary agent for ART16-01 [#407](https://github.com/chayapats/jit/issues/407). It applies the [experience handoff](S16-rakazo-experience.md) Artifacts section and reuses the existing [Mobbin research](S16-mobbin-research.md) (R03 organization cues); no new research was done. It reuses the [memory client](S16-memory-client.md) list/detail layout primitives so the two owner libraries behave the same.

## Layout

- Entry: rail "Artifacts" opens `/s16/artifacts` when the server advertises `artifacts.library`; older services keep the in-conversation list. On mobile it is reached through More. A conversation preview offers "Sources and revisions", which opens `/s16/artifacts/<id>`. Deep links reload to the same artifact.
- Main column: title, one-sentence scope ("only files you can still use are listed"), a labelled search field (`role="search"`, file name) and a Type filter as a native select. The results count is a status line. Each row is one button: name, type badge, revision, date, and "From: <producing request>". "Show older files" appends the next page; there is no page-number navigation, because the server recomputes access on each read.
- Inspector (desktop column / full-screen dialog under 900 px): file name as a focusable heading, then type · size · revision · date, then the preview, then actions (Download, Revise this file, Open conversation) and a one-line explanation that Revise starts nothing and never changes the original. After that come Sources (exact inputs; a revision input links to its earlier revision), Revision history (oldest first; the viewed one is marked, others are buttons) and Details (immutability note, SHA-256).

## Preview

- Text, Markdown and CSV: escaped text after a fresh verified byte/hash read.
- HTML: a static sandboxed frame after the same verification, labelled "Static preview: scripts, forms, network and links are turned off."
- Other kinds: "Preview is not available for this file type. You can still download it."
- Verification repeats every four seconds. A withdrawn source closes the inspector, shows "This file is no longer available…" and refreshes the list.

## Revise

"Revise this file" adopts the exact bytes into the artifact's own conversation, then navigates there. The composer gets the file as a ready chip and an editable request, with the caret placed where changes go:
- English: "Review the attached file. Changes: … . Then create a revised file."
- Thai: "อ่านไฟล์ที่แนบ สิ่งที่ต้องแก้: … แล้วสร้างไฟล์ฉบับแก้ไข".

The owner edits and presses Send. An existing draft is preserved. A pending/unknown send blocks the chip until it is resolved.

## States and accessibility

Loading, error with Refresh, empty ("Produced files appear here after a Bot delivers them."), no results, gone, revise pending/failed. Escape closes the inspector and returns focus to the originating row. Mobile traps Tab inside the dialog. Long names and hashes wrap, with no horizontal overflow at 390 px. Copy keys are `s16.artifact.*` in `src/i18n/en.ts` and `src/i18n/th.ts`.
