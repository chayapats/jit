# s16-computer-screen/v1

Owner contract for watching a desktop working computer and taking exclusive control (DESK16-01, [ADR 0090](../adr/0090-s16-watch-and-take-over-a-working-computer.md)). Available when the installation enables `computers` and `desktop`; the bootstrap reports `capabilities.computers.screen: true`.

## Read the screen state

`GET /api/s16/client/computers/<vmId>/screen` (owner session, no query) returns:

```json
{ "contract": "s16-computer-screen/v1", "vmId": "vm", "available": true, "code": null, "width": 1280, "height": 800,
  "state": "agent", "generation": 0, "takeoverId": null, "expiresAt": null, "agentBusy": false, "scope": { "kind": "shared" } }
```

- `state`: `agent` (work may use the computer), `settling` (takeover requested; waiting for earlier work operations, `agentBusy`), `owner` (only owner input), `fenced` (control lost; nobody writes).
- `generation` advances on takeover, lease lapse, controller restart and hand-back.
- `available`/`code`: `vm_desktop_unavailable`, `vm_not_running` or `vm_desktop_restart_required` when no frame can be read.
- `scope`: lineage of every frame (a private computer's frames are its Bot's private data).
- Reading changes nothing, except that an owner lease that already lapsed is reported (and recorded) as `fenced`.

## Read one frame

`GET /api/s16/client/computers/<vmId>/screen/frame?generation=<n>` returns `image/png` (1280×800) with `Cache-Control: private, no-store`. Any other generation, or a transition during the capture, is `409 stale_screen`. The only query parameter is `generation`.

## Commands

`POST /api/s16/client/computers/screen/commands` (JSON, CSRF header, body ≤ 4 KiB), exact keys per kind:

| kind | fields | effect |
| --- | --- | --- |
| `takeover` | `generation` | from `agent` or `fenced`: new generation and takeover id; `owner` at once, or `settling` while work operations admitted earlier are still running |
| `renew` | `generation`, `takeoverId` | extends owner control by the lease (30 s); not journaled |
| `input` | `generation`, `takeoverId`, `input` | one input in `owner` only (`takeover_settling` while settling) |
| `hand_back` | `generation`, `takeoverId` (null when fenced) | waits for the input being sent, then `agent` under a new generation |

Every command also has `contract: "s16-screen-command/v1"`, `requestId` and `vmId`. The result is `{ "contract": "s16-screen-command-result/v1", "requestId", "view" }`.

`input` is one of:

- `{ "kind": "click", "x", "y", "button": "left" | "right" | "middle", "double": boolean }`
- `{ "kind": "move", "x", "y" }`
- `{ "kind": "scroll", "x", "y", "delta": -10..10, not 0 }`
- `{ "kind": "key", "keys": [1..4 distinct names] }`: `ctrl shift alt meta ret esc tab backspace delete insert home end pgup pgdn up down left right spc f1..f12` or one lowercase letter or digit
- `{ "kind": "text", "text": 1..512 characters a US keyboard types }` (`screen_text_unsupported` otherwise)

Coordinates are display pixels (`0 ≤ x < 1280`, `0 ≤ y < 800`).

## Idempotency and privacy

`takeover` and `hand_back` are idempotent per `requestId` (same body returns the current view; a different body is `request_id_conflict`). `input` is sent at most once per `requestId`: a retry joins a running send, returns the view after a finished one, and is refused (`screen_input_unknown`) after a send that failed once events may have reached the computer; only a refusal before sending (for example `takeover_settling`) releases the id. Ids are kept in controller memory for the current owner generation (a retry under an older generation is refused as stale or changed); input commands are never journaled, so no typed text or hash of it is stored. Frames are never stored.

## Errors

`screen_input_unknown`, `takeover_active` (work refused while the owner holds or lost control), `takeover_state_changed`, `takeover_settling`, `stale_screen`, `screen_control_lost`, `invalid_screen_input`, `screen_text_unsupported`, `vm_desktop_unavailable`, `vm_desktop_restart_required`, `vm_not_running`, `vm_screen_invalid`, `request_id_conflict`, `screen_unavailable` (not enabled).
