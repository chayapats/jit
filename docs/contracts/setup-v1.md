# BOT02 setup and General space contracts, v1

Owner: Jit #93 (S09 BOT02). Status: implemented on the issue branch. Spec: [S09](../specs/S09-main-bot-and-chat-first-ui.md) (S09-D07, D09, D12, S09-AC06). Decisions: [ADR 0029](../adr/0029-jit-conversation-and-role-proposals.md) for the persona, [ADR 0031](../adr/0031-general-space-and-topic-promotion.md) for the General space and [ADR 0028](../adr/0028-progressive-enhancement-browser-assets.md) for the script and CSP. Requirements: FR-13, FR-22, FR-23, FR-25, NFR-05, NFR-10.

Uses `app.persona/v1`, `app.role_configuration/v1`, `app.jit_reply/v1` (coordinator selection), `ui.preferences/v1`, `jobs.queue_admission/v1`, `jobs.attempt_fence/v1` and `app.run_port/v1` without changing them.

| Contract | Public entry and behavior |
| --- | --- |
| `app.setup/v1` | `src/setup.ts`, schema 26 `setup_state` (one row). `Application.setup(actor)` returns `{ revision, complete, completedAt, step, done: { wake, connect, know, personality }, personalitySkipped, connection, persona, general }`, derived from persisted state only. `step` is the first unfinished step, or `ceremony`. Each step is one owner command `{ kind, requestId, projectId: null, expectedRevision, payload }`, where `expectedRevision` is the setup revision, and returns `{ setup }`. Commands are revisioned (`stale_revision`), idempotent by request id (`request_id_conflict` when the payload differs), validated (`invalid_setup_command`, and `invalid_persona` for persona fields), ordered (`setup_step_unavailable`), audited and refused during upgrade or restore fences. After the ceremony every step is refused (`setup_complete`). |
| `app.general_space/v1` | `src/setup.ts`, schema 26 `general_space` (singleton row, unique project). `Application.generalSpace(actor)` returns `{ projectId, topicId, greetingMessageId, createdAt }` or `null`. The General space is one ordinary project with its group (ADR 0031), named "ทั่วไป" or "General" in the interface language, plus its first topic. Every project rule applies to it unchanged. Only setup creates it, and never more than one. |

## Steps

| Step | Command | Effect, all through existing owner configuration paths |
| --- | --- | --- |
| ตื่น (wake) | `setup.wake { language: "th" \| "en" }` | Saves the interface language (`ui.preferences.set` semantics; the theme is kept). The wake page has a TH/EN toggle (`/setup?lang=en`) that previews the other language without saving anything. |
| เชื่อมจิต (connect) | `setup.connect { route }` | Saves Jit's route on the layer that wins for Jit in the General space: its project-role override, the General project default, its own role route, or the owner default. Other roles keep resolving as before. When no coordinator is enabled, setup first creates one named "จิต"/"Jit", with a fixed responsibility and no route of its own, and then writes the layer that wins for it. Afterwards Jit's effective route is exactly the submitted route (`setup_route_not_effective` otherwise). Setup never creates specialists. The same command starts one route check (below). |
| | `setup.check {}` | Starts a new check of the current route. No second job is admitted while a check is queued or running. |
| | `setup.connect.continue {}` | Ends the connect step. It needs a route (`setup_route_required`), but not a verified one: the step shows the evidence, and the owner decides. |
| รู้จักกัน (know) | `setup.know { addressAs, selfReference, language, particle }` | Writes a persona revision through `app.persona/v1`. The other persona fields are kept. Jit's language defaults to the interface language and can be set separately (FR-25). |
| นิสัยของจิต (personality) | `setup.personality { personality, aboutMe }` or `setup.personality.skip {}` | Writes a persona revision, or skips and keeps the current personality. |
| ตั้งจิต (ceremony) | `setup.complete {}` | Creates the General space if it does not exist yet, posts Jit's greeting as its first message, and marks setup complete. |

Every step sets values rather than adding records. Repeating a step after a refresh, a restart or a second tab therefore never creates a second route, coordinator, persona revision, General space or greeting:

- A route equal to the saved one is not saved again.
- Persona values equal to the current revision are not written again. The first save is always written, so the persona is owner-authored.
- `done` timestamps keep their first value.

Each step commits its configuration writes, the setup row, the receipt and the audit row in one transaction. An interrupted step leaves nothing behind (NFR-05), and the same form can be posted again.

## Route state (FR-13)

`connection` reports Jit's effective route and the latest check of exactly that route and role. Jit is resolved by the same rule replies use (`jitCoordinator` in `src/team/jit-reply.ts`): the first enabled coordinator whose effective route resolves, in the General space. An owner default with no coordinator is `missing`, because nothing can answer with it. Saved configuration and found tokens are never evidence.

| `status` | Meaning | `nextAction` |
| --- | --- | --- |
| `missing` | No route. | `configure_route` |
| `configured` | A route is saved, but no check covers this exact route, for example after a change in settings. | `check_route` |
| `checking` | The check job is queued or running. | — |
| `verified` | The check completed with a non-empty answer in `production` mode on this route. | — |
| `unverified` | The answer came from the scripted host (`fixture`), the check was inconclusive (an invalid result, a stop, a deadline, or a job left waiting after a restart, which the queue never resumes alone), or no job was admitted (`scheduler_unavailable`, `queue_full`). | `connect_live_host_then_check`, `check_again`, `start_service_then_check_again`, `wait_then_check_again` |
| `blocked` | The host reported `needs_login`, `quota`, `route_unavailable` or `unknown_model`. | `sign_in_then_check`, `wait_for_quota_then_check`, `check_route_then_check`, `fix_model_then_check` |

## Route check

- **Admission.** The check is a `setup.route-check` interactive job admitted through `jobs.queue_admission/v1` inside the owner's connect or check command. A job always belongs to a project, so the first check creates the General space; otherwise the ceremony creates it. A check that is still queued, running or waiting is stopped through `job.stop` when a new one starts.
- **Request.** It makes one bounded call through `app.run_port/v1` on the coordinator's exact route. The request has one fixed operator line (`setupCheckMarker`, which names no owner, project or credential), an empty manifest and no tools. Its limits allow one admitted attempt, so a host may replay once after a refresh. The context allows 1024 tokens, the output 256 tokens, and the wall clock 30 s.
- **Result.** A result commits only through the attempt fence, and only while it is still the current check. Only the outcome's reason code and adapter mode are stored. The model's text is discarded: it reaches neither the setup record nor job evidence, and it writes no configuration. Evidence is a code line, for example `setup-check · fixture · fixture/complete · tools none · check <id>`.
- **Blocked outcomes.** Quota, sign-in, route and model problems end the check as `blocked`. There is no waiting, retry loop or fallback route.
- **Job list.** The worker is internal and never offered as a generic start form. Its stored purpose equals `system.setup_check_purpose`, so job pages translate it.
- **Revision.** A background result never moves the setup revision, so a form the owner is looking at stays valid.

## General space before the ceremony

The General space can exist before the ceremony, because the first check creates it. Until setup is complete, `Application.execute` refuses every project command scoped to it, from every ingress, with `setup_incomplete`. The only exceptions are `job.stop` and `job.resume`, so the check job stays controllable. This covers messages, topics, routes, jobs and tasks, and it guarantees that Jit's greeting is the first message. Reads stay open.

## Greeting

`setupGreeting(persona)` builds the first message of the General topic from dictionary templates in the persona's language, with the owner's `addressAs`, `selfReference` and particle. Placeholders are filled in one pass, and owner text is inserted literally: `$&`, `{self}` and similar sequences are never interpreted. It is fixed product text, never model output. It is stored as an output source with `{ kind: "service", service: "jit-setup" }` attribution (`commitServiceOutput`). The topic page shows it as Jit's message, labelled "ข้อความต้อนรับจากการตั้งจิต"/"Welcome message from setup". It is not owner or Jit-reply history, so `app.jit_reply/v1` leaves it out of reply manifests.

## Web

- **Redirect.** `GET /` redirects to `/setup` until setup is complete (FR-23). `/api/projects` is unchanged. After completion `GET /setup` redirects to `/`, and the values stay editable in settings: persona and language in `/settings`, the route in `/settings/team`.
- **Pages.** `GET /setup[?step=<reached step>]` shows one server-rendered page per step, outside the workspace shell, with a step list that labels every state in words. `GET /api/setup` returns the read model.
- **Posts.** `POST /setup/{wake|connect|check|connect-continue|know|personality|personality-skip|complete}` takes form fields: `provider`, `model` and `authRoute` for the route; persona fields as in settings. JSON goes under `/api/setup/...` with `route` as an object. Posts use the same session, Origin, CSRF, exact-field and receipt rules as every command.
  - A form post redirects back to `/setup`, or to `/setup?step=connect#connection` for connect and check. The ceremony redirects to the General topic at the greeting.
  - A stale form redirects to `/setup` (its current step), and a post after completion redirects to `/`. JSON answers with the error code.
- **Ceremony.** The ceremony page has the mark with its halo inside `[data-ceremony]` and the form `form[data-ceremony-form]`. `app.js` delays that form's own submit by `scaleTokens.motion.ceremony` (1600 ms) while CSS draws the halo in and then lifts and settles the dot. Under `prefers-reduced-motion: reduce` the script does not intercept, and the global reduced-motion rule stops every animation. Without script the form posts at once.
- **Labels.** All labels are dictionary keys (`setup.*`, `error.invalid_setup_command`, `error.setup_complete`, `error.setup_step_unavailable`, `error.setup_route_required`, `system.setup_check_purpose`) in Thai and English. The word "อธิษฐาน" appears nowhere.

## Upgraded installations

Schema 26 adds empty tables. An installation upgraded from 25 or earlier has no `setup_state` row, so its owner goes through setup once. The steps are pre-filled from existing configuration: language, Jit's current route and the persona. The ceremony then creates the General space. Existing projects, roles and persona revisions are kept. This is a proposed engineering choice: it gives every installation exactly one General space through one path. It is not an owner decision in S09.

## Schema

Schema 26 adds:

- `setup_state` (id = 1, revision, record_json, completed_at). `record_json` holds step timestamps, the skip flag and the latest check: its id, route, role, project and job, plus its reason code and mode.
- `general_space` (id = 1, project_id unique, topic_id, greeting_message_id unique or NULL, created_at).

Both tables are classified `include` for backups. Existing installations need the owner-authorized staged upgrade (`ops.schema_migrations/v1`).

## Boundaries

BOT05 owns the chat-first home, new chats landing in the General space, refusing deletion or a kind change of the General space, and promotion. This slice only creates the General space and exposes `Application.generalSpace`. Setup creates no specialists, no other projects and no tasks or decisions.

## Evidence

`tests/setup.test.ts` uses a scripted host, a live-host stand-in that returns `production` outcomes, and a fake clock. It never calls paid inference. It covers:

- **Redirect.** A fresh installation is redirected to setup, and a finished one never sees setup again. Steps are refused afterwards, and settings still edits the values.
- **No script.** The whole flow runs as plain form posts: the TH/EN toggle, connect and check, continue unverified, know, personality and ceremony. The result is one General space and one coordinator, with no specialists and no other projects. The greeting is the first message, and Jit then replies in General.
- **Greeting.** Thai and English greetings with address, self-reference and particle.
- **Restart.** A restart in the middle of connect (with the check still queued), know, personality and the ceremony. A crash inside the ceremony transaction is followed by a resubmit and a receipt replay. Exact counts of General spaces, projects, topics, messages, roles, persona revisions and jobs.
- **Stale and replayed forms** resume at the current step. The JSON boundary returns `stale_revision`.
- **Validation.** Step order, malformed input, persona rules, request id conflicts, CSRF and Origin.
- **Route states.** `blocked` for `needs_login`, `quota`, `route_unavailable` and `unknown_model`; `unverified` for fixture and inconclusive checks; `configured` after a route change elsewhere. Each check carries the exact route, the fixed prompt, an empty manifest and no tools.
- **Production.** Only a production `complete` outcome verifies. A route change drops the evidence.
- **No scheduler.** The check is `unverified` with a next action, and setup still finishes.
- **Injection.** Check output that asks for persona, route, role or setup changes has no effect and is not stored.
- **Existing coordinator.** It is reused and pointed at the new route, the owner default is untouched, and the older check is stopped and fenced.
- **Ceremony.** Markup, CSS tokens and the reduced-motion rule. A fake-DOM `app.js` contract covers both the animated path and reduced motion, and the no-script submit still works.
- **Rendering.** Every step in Thai and English, dark and light, with no raw keys, no inline script and no "อธิษฐาน".
- **Backups and composition.** Backup classification, and the worker registered in the composed queue.

`tests/ops-upgrade.test.ts` migrates fixtures at schemas 17–25 to 26.
