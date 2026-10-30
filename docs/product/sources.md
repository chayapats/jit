# Jit — Repository and platform evidence

แยก observed facts ออกจาก proposed design รายการนี้ไม่ใช่ผล deployment/security test และไม่รับรอง external provider availability ในอนาคต

## Repository snapshot

ตรวจ Schway checkout ที่ commit eb41354: fix require live evidence before hosted search admission; origin chayapats/schway ช่วง discovery package ระบุ version 1.0.0-rc.2, Bun/TypeScript และ MIT

| Observation | หลักฐานใน checkout |
| --- | --- |
| ปัจจุบันเป็น coding-agent harness | [CONTEXT](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/CONTEXT.md), [package metadata](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/package.json), [README](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/README.md) |
| loop รับ native session/model/context/tools และ stream events | [agent loop](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/agent/loop.ts), [conversation types](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/conversation/types.ts) |
| stable API มีเฉพาะ schway/extensions; deep imports เป็น private | [stability](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/docs/stability.md#extension-api), [package exports](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/package.json), [extension exports](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/extensions/index.ts) |
| extension เพิ่ม hooks/tools/events ได้ แต่ไม่แทน runtime; code เป็น trusted local code | [extension boundaries](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/docs/extensions.md), [extension contract](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/extensions/index.ts) |
| headless -p/--json/--resume มีจริง และ TUI ถูกโหลดเฉพาะ interactive path | [headless docs](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/docs/headless.md), [CLI runtime](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/cli/runtime.ts) |
| scheduler จัด tool calls ภายใน run ไม่ใช่ persistent jobs | [scheduler](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/agent/scheduler.ts), [loop caller](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/agent/loop.ts) |
| durable JSONL/branches มี recovery แต่ไม่ replay tool effects; one writer ต่อ session | [sessions](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/docs/sessions.md#format-4-and-recovery), [JSONL loader](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/session/jsonl.ts) |
| context เตรียม dynamic sections/compaction; auto-discover AGENTS.md และ skills | [context manager](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/context/manager.ts), [instruction discovery](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/context/agents.ts) |
| interactive-memory จำ provider/auth/model choice ไม่ใช่ personal-memory engine | [interactive memory](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/config/interactive-memory.ts), [ADR 0001](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/docs/adr/0001-interactive-choice-memory.md) |
| approval เป็น auto/ask/read-only; headless ask ปฏิเสธ mutation; default auto | [approval](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/agent/approval.ts), [executor](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/tools/executor.ts), [headless](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/docs/headless.md#task-input-and-recovery) |
| workspace path ไม่เป็น security boundary และ absolute paths ออกนอก root ได้ | [path resolver](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/tools/path.ts), [read tool](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/tools/read.ts) |
| read-only web_fetch ยังส่ง URL ไป network และไม่เป็น browser automation | [tools](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/docs/tools.md), [web fetch](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/tools/web-fetch.ts) |
| native tools มี read/write/edit/bash/web_fetch/grep/find/ls | [CLI tool registration](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/cli/runtime.ts) |
| provider loading แยก route และ lazy; subscription adapters มีอยู่ | [loader](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/model/loader.ts), [Grok](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/model/providers/grok-subscription.ts), [Codex](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/model/providers/codex-subscription.ts) |
| transport retries เป็นของ Schway; usage/events ไม่เท่ากับ goal verification | [retry](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/agent/retry.ts), [events](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/agent/events.ts), [loop](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/agent/loop.ts) |
| provider-hosted lookup อาจส่ง conversation-derived query ไป search service; production allowlist ปัจจุบันว่าง | [ADR 0007](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/docs/adr/0007-provider-hosted-lookups.md), [hosted tools](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/model/hosted-tools.ts) |
| OS secret store และ Linux prerequisites; ไม่มี silent plaintext fallback | [credentials](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/docs/credentials.md#platform-requirements-and-recovery), [store](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/src/auth/store.ts) |

การค้น source/docs ที่เกี่ยวข้องไม่พบ native persistent scheduler, cross-project personal-memory pipeline, external messaging channels, MCP server หรือ subagent orchestration สำหรับ Jit ข้อความ “ไม่พบ” จำกัดตาม checkout ที่ตรวจ ไม่ได้พิสูจน์ว่าไม่มี external extension หรือเพิ่มผ่าน application ไม่ได้

ADR 0005 มีข้อความ historical ว่า approval ยังไม่ implement แต่ code/headless docs ปัจจุบัน implement แล้ว จึงใช้ current code เป็นหลัก ไม่แก้ประวัติ ADR จากงานนี้

## Host snapshot จาก read-only SSH

เป้าหมายที่ผู้ก่อตั้งระบุคือ Raspberry Pi 5 เข้าถึง SSH ได้ ผลตรวจพื้นฐาน:

- Linux kernel 6.8.0-1064-raspi, aarch64, 64-bit; OS รายงาน Ubuntu 24.04.5 LTS
- RAM รวมประมาณ 7.8 GiB; root NVMe ว่างประมาณ 218 GiB จาก filesystem 235 GiB ณ เวลาตรวจ
- พบ Git ที่ /usr/bin/git
- command lookup ไม่พบ bun ใน PATH ของ SSH session ที่ตรวจ ไม่ใช่หลักฐานว่าไม่มี binary ที่อื่น

ยังไม่ตรวจการรัน Schway, dependencies บน ARM64, libsecret/Secret Service/D-Bus ใน service context, provider login/inference/refresh, reboot credentials, backup หรือ isolated executor ไม่มีการติดตั้ง อ่าน token หรือเปลี่ยนค่า host จาก discovery

## External primary references

ตรวจเอกสารทางการประกอบ proposal วันที่ 2026-10-18; ข้อกำหนดที่อาจเปลี่ยนต้องตรวจซ้ำเมื่อ implement

- [Bun installation](https://bun.com/docs/installation): มี Linux ARM64 target; การมี platform support ยังไม่พิสูจน์ app dependencies บน Pi
- [Bun Secrets](https://bun.com/docs/runtime/secrets): Linux ใช้ libsecret/Secret Service และ collection อาจล็อก จึงต้องทดสอบ boot/service identity
- [Telegram receiving updates](https://core.telegram.org/bots/api#getting-updates): polling/webhooks เป็นทางเลือก และ server ไม่เก็บ incoming updates เกิน 24 ชั่วโมง
- [Telegram getUpdates](https://core.telegram.org/bots/api#getupdates): offset confirmation ต้องสัมพันธ์กับ durable ingestion; ไม่ต้องสมมติ public webhook เมื่อเลือก polling
- [Telegram privacy §3.3](https://telegram.org/privacy#3-3-your-messages): Cloud Chats เก็บบน Telegram servers แยกจาก Secret Chats
- [Telegram bot overview](https://core.telegram.org/bots#how-are-bots-different-from-users): owner ต้องเริ่ม/ผูกการติดต่อก่อนใช้ private bot notifications
- [GitHub pull requests API](https://docs.github.com/en/rest/pulls/pulls): source สำหรับ read integration; ต้องพิจารณา pagination และ content completeness
- [GitHub REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api): แนวทาง conditional requests/rate-limit behavior ที่ polling spec ต้องใช้
- [SQLite backup](https://www.sqlite.org/backup.html): reference สำหรับ consistent snapshot; schema และ restore protocol ของ Jit ยังเป็นข้อเสนอ
- [MIT license](https://opensource.org/license/mit): license ที่เสนอให้ตรง permissive intent; Jit repository ใช้ LICENSE นี้แล้ว

ไม่มีการใช้เอกสาร provider เป็นหลักฐานว่าบัญชี subscription ของเจ้าของให้ inference ได้จริง ไม่มีการยืนยัน entitlement, limits หรือ protocol stability จากการมี adapter ใน source เพียงอย่างเดียว

## S14 references — 2026-10-30

- Owner decisions: [S14](../specs/S14-bot-first-local-assistant.md), [#244](https://github.com/chayapats/jit/issues/244). The owner chose the A paths except Q12, which explicitly allows fresh state without legacy-data conversion.
- [CopilotKit/OpenBot README](https://github.com/CopilotKit/OpenBot/blob/ab9855c19848378c90a806426130d86699cc798c/README.md), [coworkers](https://github.com/CopilotKit/OpenBot/blob/ab9855c19848378c90a806426130d86699cc798c/docs/coworkers.md), [research](https://github.com/CopilotKit/OpenBot/blob/ab9855c19848378c90a806426130d86699cc798c/docs/web-research.md): persistent coworkers/computers, controlled handoffs and provider research roles. MIT reference; distinct from the historical nightly-labs/openbot reference above. No source/assets copied.
- [CopilotKit/OpenDuet README](https://github.com/CopilotKit/OpenDuet/blob/677e0fcd148d80b99dd788c6d6f9c1c9f40a72db/README.md): proactive briefs/triage/routines and exact actions. Built on OpenBot and requires CopilotKit Intelligence in its own setup; Jit does not inherit that dependency.
- [Grok Bot overview](https://docs.x.ai/grok-bot/overview): persistent named Bots, work handoffs and computer use. Reference behavior, not a dependency or copied UI.
- [Parallel MCP](https://docs.parallel.ai/integrations/mcp/quickstart), fetched 2026-10-30: unified endpoint, anonymous rate-limited search/fetch, explicit authenticated billing and tool selection. Vendor availability/terms remain external policy.
- [Schway host source](https://github.com/chayapats/schway/blob/98ba7f007a0ba382f1a26195ec7774559e25eab3/src/host/auth-routes.ts), [runtime](https://github.com/chayapats/schway/blob/98ba7f007a0ba382f1a26195ec7774559e25eab3/src/host/runtime.ts), [public API](https://github.com/chayapats/schway/blob/98ba7f007a0ba382f1a26195ec7774559e25eab3/api/host.api.md): evidence for the shared-lifecycle proposal. Jit's pinned 2068b71 artifact is unchanged.
- Existing [Schway #414](https://github.com/chayapats/schway/issues/414) is reused for orphan-session discovery; [#413](https://github.com/chayapats/schway/issues/413) distinct-account aliases remain separate scope.
- Design provenance and parent verification: [contract/design resolutions](../contracts/s14-authority-and-design-resolutions.md).
