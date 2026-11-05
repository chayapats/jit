# S16 memory client design

Authored by the primary agent for MEM16-01 [#416](https://github.com/chayapats/jit/issues/416) after the owner withdrew the design-subagent requirement on 2026-11-05. It applies the [experience handoff](S16-rakazo-experience.md) Memory section and reuses the existing [Mobbin research](S16-mobbin-research.md); no new research was done.

## Layout

- Entry: rail secondary navigation "Memory" opens `/s16/memory` inside the client when the server advertises the capability; otherwise it links to the S15 `/memory` page. A conversation's "Review memory" link opens the same view with the retained item preselected (`/s16/memory#<claimId>`).
- Main column: title and one-sentence purpose, a labelled search field (`role="search"`), then four filters as native selects: Status (In use / Corrected, forgotten or withdrawn / Everything), Type, Category and Visible to (All Bots or only what one Bot can use). Native selects keep keyboard, screen-reader and mobile behaviour predictable.
- Results: a count line ("Showing 1–50 of N") and a list of full-width row buttons. Each row shows the snippet, a pill for type and confirmation ("Fact · stated by you", dashed outline for inferences so they never read as confirmed), category, scope, source and date, and last use. Non-active rows show a state pill and an italic explanation instead of text. Previous/Next appear only when there is more than one page.
- Detail: the existing inspector pattern. On desktop it sits beside the list (sticky, 340–420 px); at ≤900 px it is a full-screen dialog with a focus trap. Escape or × closes it and returns focus to the originating row. It shows the remembered text, the exact source words when they differ, an inference note, source with "Open source conversation", created/last used, usage counts, file hashes with current/withdrawn state, and the correction chain.

## Commands

- Correct: inline textarea prefilled with the current text, 2048 limit with a live counter, help text explaining it becomes a new owner-stated fact and retires contexts built from the old one. Save is disabled for empty or unchanged text.
- Forget: two steps. The first click loads the impact preview (items, sources, contexts, summaries, files, model sessions, work items) and states the limits: future work stops using it, original conversations stay, already downloaded or sent copies cannot be recalled. The red Forget button confirms.
- While a command is pending or its outcome is unknown, both actions are disabled. Unknown shows "Check again", which resends the same retained command. `stale_revision` asks the owner to reopen. Success is announced with `role="status"` and the list refreshes; a correction opens the new item.

## States and accessibility

Loading (`role="status"`, `aria-busy`), list/detail errors with Refresh and a code disclosure, unavailable capability, empty memory and no-results are distinct. Authentication failure uses the app's shared withholding, which unmounts the view. All controls are buttons/links/selects with visible focus; no horizontal overflow at 390 px; filters stay two-column on phones; no motion is added. English and Thai copy live under `s16.memory.*`.
