---
status: accepted
scope: S11 browser-use and computer-use engineering choices; extends ADRs 0028, 0036 and 0037
---

# Browser-use and computer-use inside the box, with a pause before submit and a script-free takeover

S11-D07 puts Chromium, with a profile per project, and a virtual desktop inside the project box. The owner sees a live view and can take over. The agent pauses before any submit or confirm.

## Selected implementation

### Image and display

- Boxes that need a browser use the pinned `browser` image target.
- `Xvfb :99` runs at 1280×800, together with a minimal window manager. Chromium runs with `--user-data-dir=/profile` (the per-project profile volume) and `--remote-debugging-pipe`.
- Jit drives Chromium with a CDP client over the runner pipe. No debugging port is ever exposed.

### Browser tools

The tools are:

- `browser_open(url)`
- `browser_snapshot()`, which returns the visible text and an accessibility tree as text, bounded to 32 KiB
- `browser_click(ref)`
- `browser_type(ref, text)`
- `browser_select(ref, value)`
- `browser_screenshot()`, which stores the image for the live view and returns only a reference

### Pause before submit or confirm

These actions are **confirm actions**:

- A click on a submit control, or on any element inside a `<form>` that would submit it.
- A click on an element whose accessible name matches the operator-configured confirm vocabulary. The Thai and English defaults include submit, send, pay, buy, confirm, delete, ส่ง, ยืนยัน, ชำระ, ซื้อ and ลบ.
- Pressing Enter in a form field.

A confirm action produces an approval card of kind `browser_confirm`. The card shows the URL, the element text and the form field names. Password field values are never shown.

### Computer-use

- The tools are `computer_screenshot()`, `computer_click(x, y, intent)`, `computer_type(text, intent)` and `computer_key(keys, intent)`, run with `xdotool` inside the box.
- The `intent` is declared by the model: `input`, `navigate`, `submit` or `confirm`. A declared `submit` or `confirm` produces an approval card.
- Because the intent comes from the model, computer-use is limited to the `full` level. The project setting `computer.confirmEveryClick` (default **on**) turns every click into a card until the owner turns it off in the Web UI.

### Live view and takeover

- `/projects/:project/box/live` shows the latest screenshot as an `<img>`.
- Takeover works without script:
  - A `<form>` with `<input type="image">` posts the click coordinates.
  - A text form posts typed text.
  - Key buttons post special keys.
- The local script (ADR 0028) only refreshes the image every second.
- Starting a takeover (`takeover.start`, Web-only) records a `takeover_sessions` row. While it is active, every agent browser and computer tool call fails with `takeover_active`. `takeover.end` returns control.

## Alternatives and consequences

- noVNC was rejected because it would add a vendored JavaScript dependency and a WebSocket path, and it needs script.
- Approving every browser click was rejected as too slow for normal browsing.
- Residual risk: computer-use intent is model-declared, so in Full with `confirmEveryClick` off a misclassified click can submit something. This is why the default is on and the setting is Web-only.
