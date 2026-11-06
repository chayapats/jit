# S16 routines design

Authored by the primary agent for ROUT16-01 [#414](https://github.com/chayapats/jit/issues/414) and ROUT16-02 [#415](https://github.com/chayapats/jit/issues/415). It applies the [experience handoff](S16-rakazo-experience.md) "Bots, delegation and routines" section and the existing [Mobbin research](S16-mobbin-research.md) R07 (conversational entry followed by a structured schedule review); no new research was done. It reuses the [memory client](S16-memory-client.md) list/detail primitives so the owner libraries behave alike. Behavior is specified in the [routines contract](../contracts/s16-routines-v1.md).

## Entry

- **From the conversation (R07).** The composer shows "Schedule" next to Send when the server advertises `routines`. It opens the review sheet with the composer text as the instruction, the current conversation as the routine's home, and a schedule prefilled from the owner's own unquoted words ("every weekday at 9:30", "ทุกวันธรรมดา เวลา 9:30", "every hour", "ทุกวันจันทร์"). The prefill is a suggestion; nothing is saved. Messages with attached files keep their ordinary Send path.
- **From the rail.** Secondary navigation "Routines" (with an unseen-outcome count) opens `/s16/routines`; "New routine" opens an empty sheet. Deep links `/s16/routines/<id>` reopen a routine.

## Review sheet

A modal dialog (focus trapped, Escape and backdrop close, full screen under 900 px):

1. **Edit**: name, "What should happen" (instruction), Repeat (every day, weekdays, chosen days, every few minutes/hours, once, only on reactions), time/date/minutes, timezone (browser zone by default, full IANA list), "If runs are missed" (run once when the service returns / skip), "Stay quiet when there is nothing new" (on by default), at most N runs, ends on (clamped to the standing-policy expiry), and "What it may use": purpose, resources (TEAM labels) and allowed work (read and report / change files on the working computer / prepare actions outside the computer).
2. **Review** (server-computed): the instruction, the schedule in words with its timezone, missed-run rule, quiet rule, scope, limits, the approval boundary ("Each run is checked against your current standing rules… a run never approves itself"), which reactions the scope allows, and the next three runs with DST notes ("moved past a daylight-saving gap", "first of the repeated hour"). Interval routines note that runs count from save.
3. **Save routine** accepts exactly this review. Edit returns to the form; a changed policy shows "Something changed since the review" and asks for a new review.

## Routines page

- **List**: each routine is one button with its name, unseen count, state badge (Active, Running, Waiting for you, Blocked, Paused, Stopped, Ended), schedule in words, reaction count, next run in the routine's zone and runs left. The calendar feed panel sits under the list.
- **Detail** (desktop column, full-screen panel under 900 px): name heading (focused on open), state and runs left, the instruction as quoted owner text, facts (schedule · zone, missed-run rule, quiet rule, scope, limits, approval boundary), ended reason, next three runs, actions (Run now primary, Pause/Resume, Open conversation, Stop routine behind a confirmation that explains the impact), Reactions and History.
- **History**: newest first; state badge, trigger (Scheduled, Run now, Signed event, File revision), local time, "Includes N missed or merged triggers", a link to the run in its conversation ("Review the held action" while waiting), "I've handled this" for unknown or needs-you runs, and the safe diagnostic code under Details.
- **Reactions**: each active source shows its kind, endpoint address, accepted/merged/repeat/ignored/refused counts and last outcome, with Rotate secret and Remove. Adding one picks GitHub CI or review (repository + events), Signed event (names) or New file revision (a file from this routine's conversation). Signed and GitHub kinds are disabled with a reason unless the routine is read-and-report. A new or rotated secret appears once with the address and setup help; it is never shown again.
- **Calendar feed**: on/off, new address, "Show routine names in the calendar" (off by default); the address appears once.

## Conversation

A routine run appears in its conversation with a "Routine run" label above the instruction (a link back to the routine), so it is not mistaken for something the owner just typed. A quiet result reads "Nothing new this time." instead of the typed outcome.

## States and accessibility

Loading, empty ("No routines yet." with the Schedule hint), error with Refresh, unavailable capability, pending/unknown command ("Check again" with the same request) and stale revision ("Refresh") are all labelled; notices take focus. Every control is a native button, input, select or fieldset with a visible label. Copy lives in `src/i18n/en.ts` and `src/i18n/th.ts` under `s16.routine.*`, `s16.chat.schedule*`, `s16.chat.routineRun`, `s16.chat.nothingNew` and `s16.nav.routines`. Evidence: `tests/s16-routines.browser.test.ts` in English at 1440 px and Thai at 390 px, without horizontal overflow.
