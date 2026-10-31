# S14 opt-in research corpus and usefulness rubric

EVID14-01 / #256. Owner-approved rubric delegation, 2026-10-30; drafted before any live model call in this evidence round. This corpus is opt-in, public-source only. Use exactly Codex `gpt-6.1-sol` subscription and anonymous Parallel. Stop on quota; never substitute route, model, key or billing.

Run every task independently on Linux x64 and arm64. Select two accepted research Bots with overlapping recorded native intervals and the main Bot for synthesis. Each work item has two concurrent Bots, 30 minutes and 40 public reads. Preserve actual source coverage, timestamps, report revision, artifact checksum and shortcomings. A completed response is not a report or a pass.

| ID | Language | Owner work request |
| --- | --- | --- |
| R1 | English | Research how rootless Podman enforces memory, CPU, PID and network isolation on Linux with cgroup v2. Use official Podman and kernel/systemd documentation. Distinguish configuration from observed enforcement; give a practical verification checklist and explain unsupported delegation. Divide independent documentation research between two Bots, then synthesize a cited report. |
| R2 | Thai | เปรียบเทียบ SQLite online backup, VACUUM INTO และการคัดลอกไฟล์ database ขณะมี WAL สำหรับแอป self-hosted อ้างอิงเอกสาร SQLite โดยตรง ระบุข้อจำกัดด้าน consistency, concurrent writers และ restore ให้สอง Bot ค้นคว้าแยกกัน แล้วสรุปข้อเสนอพร้อมเงื่อนไขและแหล่งข้อมูล ห้ามอ้างว่าทดสอบ durability แล้ว |
| R3 | English | Compare systemd timer behavior for OnCalendar, Persistent, time zones and missed occurrences. Use official systemd documentation and identify version-dependent details. Ask two independent Bots to investigate scheduling and recovery respectively; synthesize a cited decision guide without inventing exactly-once guarantees. |
| R4 | Thai | ศึกษาว่า HTTP retry เมื่อผลลัพธ์การเขียนไม่ทราบแน่ชัดควรทำอย่างไร ใช้ RFC 9110 และเอกสารสาธารณะของบริการที่อธิบาย idempotency key อย่างน้อยหนึ่งแห่ง แยก safe, idempotent และ application deduplication ให้ชัด ให้สอง Bot ทำงานขนาน แล้วส่งรายงานอ้างอิงพร้อมตัวอย่าง failure และสิ่งที่ยังยืนยันไม่ได้ ห้ามส่งคำขอเขียนจริง |
| R5 | English | Research accessible remote-computer controls using WCAG 2.2 and WAI documentation. Have two independent Bots examine keyboard/focus and status/error announcements. Produce a cited audit checklist that distinguishes browser viewport emulation from real device and screen-reader testing. Do not claim conformance from screenshots. |

## Rubric fixed before execution

Score each dimension 0 (absent/incorrect), 1 (usable with a material gap), or 2 (clear and supported):

1. Relevance: directly answers the request with a practical recommendation/checklist.
2. Traceability: key factual claims cite actually retrieved public sources; links and evidence identities resolve.
3. Coverage honesty: distinguishes snippets/excerpts/pages, missing sources, conflicts, unknown freshness and unverified claims.
4. Reasoning: separates source facts from inference and gives conditions/tradeoffs rather than unsupported certainty.
5. Delivery: coherent requested language, immutable committed report and a downloadable bounded artifact with verified checksum/media type.

A task passes at >=8/10, with traceability, coverage honesty and delivery each scoring 2 and no fabricated citation, undisclosed major retrieval failure or false empirical claim. Report all five individual scores; do not average away a failing task. Architecture rubric passes only when all five tasks pass. Host isolation/recovery/OPS results and selected-route readiness are separate gates.

The owner has not read or accepted the reports yet. Rubric evaluation is delegated assessment, not owner report acceptance. State this explicitly even if all rubric and host gates eventually pass. Missing reports remain unscored/pending, never zero-source successes.
