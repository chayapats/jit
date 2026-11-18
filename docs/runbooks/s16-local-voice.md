# Optional local dictation and playback

VOICE16-01 ([ADR 0096](../adr/0096-s16-bounded-local-dictation-and-playback.md), [contract](../contracts/s16-voice-v1.md)) adds bounded dictation/playback to the explicit S15 service and shared `/s16` client. Omitted configuration keeps text available and creates no voice journal. Installation, model download, device permission and owner-host activation never happen automatically. S14/default/legacy services and installed policy are unchanged. Continuous calls belong to #423; physical-device and owner-host acceptance remain #431/#432.

## Supply trusted local artifacts

On Linux, supply `whisper.cpp`'s `whisper-cli`, a compatible public GGML model, `espeak-ng` and its local voice data. macOS development/evidence may explicitly select `/usr/bin/say`. Use canonical absolute paths with no symlink components, no group/world-writable artifacts, and executable bits for binaries. Hash each actual executable/model with SHA-256 after resolving its path. Retain its source/build provenance and applicable licenses; Jit's MIT license does not relicense weights, libraries or voice data. Pins do not sandbox malicious executables or attest every dynamic dependency.

The proof uses whisper.cpp v1.9.2 commit `306c88f4d1286aec1bf96e544632897886af5501` and public GGML models at Hugging Face revision `5359861c739e955e79d9a303bcbc70fb988958b1` (upstream labels MIT):

| Model | Bytes | SHA-256 | Observed proof |
| --- | --- | --- | --- |
| [base.en](https://huggingface.co/ggerganov/whisper.cpp/blob/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.en.bin) | 147,964,211 | `a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002` | Linux eSpeak NG synthetic sentence passes the unchanged known-word assertions |
| [tiny.en](https://huggingface.co/ggerganov/whisper.cpp/blob/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.en.bin) | 77,704,715 | `921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f` | macOS `say` sentence passes; Linux eSpeak NG pronunciation was misrecognized, so it is not the validated Linux example |

These English-only models do not establish Thai recognition accuracy. Choose and verify a compatible multilingual model/language for Thai. Browser Thai copy is separate evidence. No model/binary is bundled with Jit.

Add an explicit `voice` entry to a reviewed S15 runtime configuration. This template's paths/hashes must be replaced with the supplied artifacts; it is not an activation command:

```json
{
  "voice": {
    "local": {
      "transcription": {
        "executable": { "path": "/protected/voice/bin/whisper-cli", "sha256": "<actual 64 lowercase hexadecimal SHA-256>" },
        "model": { "path": "/protected/voice/models/ggml-base.en.bin", "sha256": "a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002" },
        "language": "en"
      },
      "synthesis": {
        "kind": "espeak",
        "executable": { "path": "/usr/bin/espeak-ng", "sha256": "<actual 64 lowercase hexadecimal SHA-256>" },
        "voice": "en-us"
      },
      "timeoutMs": 60000
    },
    "quota": { "dailyMs": 120000, "captureMs": 30000 }
  }
}
```

The macOS evidence alternative is `kind: "say"` with the verified canonical `say` executable and an already installed local voice such as `Samantha`. No download/fallback is requested. Configuration contains no remote URL, credentials or arbitrary flags. The local supervisor uses fixed arguments, no shell, CPU-only whisper flags and a minimal environment. A healthy status read starts no speech; unchanged artifact metadata may cache health, but each actual speech job rehashes all three pins. Keep installation paths/config/receipts in ignored `.local` records.

`captureMs` is an integer from 1 through 30,000; `dailyMs` is finite, at least the configured capture bound and at most 3,600,000. Playback needs its full 60,000 ms reservation before synthesis. `timeoutMs` is 1–120,000. These are local audio-second limits, not compute-time or monetary billing measurements. Process/model limits also depend on the trusted host; the wrapper is not an OS memory sandbox.

## Use and recovery

Open `/s16` through a browser secure context (HTTPS, or browser-trusted loopback). Dictate reserves quota before asking for microphone access. Recording displays elapsed time, Stop and Discard. Stop produces an editable transcript; Add to message copies it to the ordinary composer. Only Send admits work. The transcript, including the word "approve", cannot press an exact decision card. Permission denial/revocation, unavailable local artifacts or exhausted quota leave ordinary text available. No browser/vendor speech service is selected.

Listen to this reply binds the exact currently guarded result. Stop listening interrupts audio and pending voice responses, independently of the Bot's Stop action. A changed/withdrawn source or session prevents fresh audio publication. The client clears voice on conversation/view/session refresh and disposes microphone tracks, audio nodes and object URLs; a cancelled permission prompt's later stream is stopped immediately.

The service owns metadata-only `voice.sqlite` under the existing protected state manifest/exclusive lease. Audio/text scratch uses a private installation-specific system temporary directory outside application state/backups; audio/transcripts are never journal fields. Completed response caches are memory-only, at most sixteen entries/8 MiB/five minutes. A transcript deliberately sent to CHAT follows ordinary CHAT retention.

Known accepted PCM duration is charged when STT starts. Synthesis keeps its worst-case charge until a valid actual WAV narrows it. Unknown/failed started processing is not refunded or replayed after restart. The supervisor's stdin liveness lease kills and joins the CLI after controller loss. Startup removes scratch only when no job could have started or a matching settlement receipt proves physical CLI exit; an unproven orphan makes voice unavailable. Do not delete the voice journal or orphan evidence to bypass usage/recovery. Read safe codes and retain private installation receipts for investigation; no raw CLI stderr is exposed.

## Verify an exact build

Deterministic suites:

```sh
bun test tests/s16-voice-audio.test.ts tests/s16-voice-local.test.ts tests/s16-voice-service.test.ts tests/s16-voice-client.test.ts
bun run typecheck
```

Real React/AudioWorklet browser tests use an isolated loopback test server on port 3099, fake native media devices and muted audio. They never open the owner's microphone. Supply an installed Chrome path with `JIT_BROWSER_EXECUTABLE` when needed:

```sh
JIT_S16_BROWSER_TESTS=1 bun test tests/s16-voice.browser.test.ts
```

For opt-in actual local speech, put only the `local` object in an ignored configuration file; its supplied binaries/model must match their pins. The harness creates its own public synthetic sentence and scripted conversation/VM fixture, transcribes via actual whisper, checks that no work exists before ordinary Send, then synthesizes the currently guarded reply. It does not use a subscription/account or a private recording:

```sh
JIT_S16_NATIVE_VOICE_TESTS=1 \
JIT_S16_NATIVE_VOICE_CONFIG=.local/voice-config.json \
JIT_S16_NATIVE_VOICE_RECEIPT=.local/voice-receipt.json \
bun test tests/s16-voice.native.test.ts
```

Keep exact build/artifact hashes, durations, outcomes and limitations with release evidence. This native harness does not prove physical microphone permission, recognition quality in every language, mobile background/continuity, real account policy or owner-host activation.
