# Synthetic image probe challenges

`image-probe.png` (582731) and `image-probe.jpeg` (914026) are the synthetic
challenges from Schway's MIT-licensed `src/live/fixtures/`, pinned at
`2068b7139f53bd62f85c3545546724e5367588cd`. They contain no owner data.

Jit's explicitly confirmed Web probe uses these exact bundled files via
`schway/host`. It never loads owner attachments or private Schway modules.
Only exact answers to both formats, with the first image replayed on the
second request, produce a passing `HostImageProbeRecord`.
