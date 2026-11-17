# s16-client-models/v1

MODEL16-01 (#421), ADR 0093. This is an additive protected S16 projection over MODEL15 and BOT16-01, not another provider, registry or approval service.

- `GET /api/s16/client/models` returns configured approved-route metadata, installed-policy availability and finite/unknown budget facts. Current owner authentication, exact Host, Fetch Metadata and no-store response rules apply. Reading never lists an account catalog, renews a credential or starts inference.
- `ClientCapabilities.models` advertises this projection only when MODEL is composed. Bot model/effort changes continue to use exact revision-bound `s16-bot-command/v1`; non-null selections are exact pins. Missing pins hold `selection_pinned`; a form never converts an unavailable saved selection to the default through an unrelated edit.
- Conversation snapshots add `modelUsage` with `records` keyed by request ID and an explicit `truncated` flag. Only the authorized snapshot's work identities are queried, at most 32. The protected journal query returns at most 128 recent steps; selection history outside the window is not inferred to be empty.
- Each step exposes recorded provider/model, exact selection, reason/state/code, effort observations, token samples/totals, physical-send counts and usage. No prompt/output/native-session handle is returned. Null telemetry remains unknown; provider effort reports do not prove internal computation, and configured spend bounds are not measured bills.
- Bot updates affect future work admission; an active work's POLICY selection pin is unchanged. New requests retain product Bot/conversation/source lineage while Schway creates compatible native contexts. Private-recipient, account, billing, limits and unknown-effect guards remain mandatory.

The existing protected `/settings/provider` surface handles sign-in to configured supported Schway routes. This API has no route/account/credential/billing mutation. New routes are not synthesized from a model catalog or source document. S14 remains the default runtime and S15 remains opt-in; installed policies retain their exact meaning.
