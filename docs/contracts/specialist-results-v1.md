# Specialist results, v1

Owner: Jit #11 (TEAM02). Contract: `app.specialist_results/v1`. Lives beside team dispatch in `src/team/dispatch.ts` and attributed conversation/source commits. Complements `app.team_dispatch/v1` and `app.run_records/v1`.

A specialist result is committed only when `WorkContext.commit` accepts a succeeded step for `team.specialist-analysis` and the normalized `ApplicationRunOutcome` is `complete` with nonempty fixture output. The trusted producer writes one output source (`commitOutputSource` with participant/run attribution) and one topic message in the same app transaction as the retained specialist run outcome. Since BOT04 the message advances the topic's message order but not its revision, and each attempt reserves `floor(outputTokens / (retries + 1))` output tokens. Incomplete, blocked, cancelled or invalid outcomes record the outcome on the run without a successful history message and never alter role configuration.

Participation projection exposes `state`, `reason`, `nextAction`, `route`, committed `output` source reference and cleared progress after commitment. `coverageGap` lists selected roles that are not completed/skipped/excluded. Peer results are ordinary untrusted text if later read as sources; they are never copied into another role's `instructions.operator` or shared managed context.

Stop/supersede/cancel fencing prevents duplicate committed answers for the same generation. Host finished/completed without valid normalized output becomes `invalid_result` / non-complete evidence, not a successful analysis. Resume of quota/login/route waits remains on the original fixture admission route (`jit-fixture/scripted/internal`) while the captured request route stays unchanged.
