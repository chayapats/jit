# Spec — Jit MVP: project teams, continuity and private PR review

> S14 target status: Historical implemented product baseline. The owner-confirmed S14 target replaces required Projects, the first useful workflow and execution scopes; unchanged authority/evidence invariants remain. See [S14](S14-bot-first-local-assistant.md).

Tracker: https://github.com/chayapats/jit/issues/1

Owner: Jit. Status: ready for ticket breakdown; implementation depends on explicit host/API feasibility gates. [Product baseline](../product/README.md) และ [decision record](../product/decision-record.md) เป็นที่มาของ scope

## Problem Statement

เจ้าของต้องการทีมผู้ช่วยที่รักษางานค้างและเหตุผลของโครงการข้ามวัน พร้อมอ่าน PR ที่เข้ามาและแจ้งปัญหาที่มีหลักฐาน โดยเก็บ runtime, state และ credentials บนเครื่องที่ตนควบคุม วิธีที่ใช้อยู่ยังไม่ให้ความไว้ใจใน cloud computer ที่ถือ execution และข้อมูลส่วนตัว

Jit ต้องลดภาระอธิบายบริบทซ้ำ ประสานความเห็น และตามงาน โดยไม่เปลี่ยน suggestions เป็นข้อผูกพันหรือเพิ่มอำนาจให้ agent เอง คุณค่าจริงจะประเมินจาก owner หลังทดลอง

## Solution

สร้าง single-owner application บน host ส่วนตัว มีหนึ่ง group ต่อ software project ใช้ specialists ที่วิเคราะห์แยกผ่าน Schway และ coordinator เลือกทีม/สรุปข้อขัดแย้ง เก็บ tasks/decisions/sourced memory และ read-only PR jobs อย่าง durable

Web ผ่าน VPN เป็นพื้นที่หลัก Telegram เป็นช่องทางเสริมสำหรับแจ้ง ถาม สั่งและรับรองงาน ใช้ Grok/Codex subscriptions ที่ owner กำหนดต่อบทบาทหรือโครงการ

[S09](S09-main-bot-and-chat-first-ui.md) ต่อยอด spec นี้: coordinator ทำหน้าที่เป็น Jit main bot ที่ตอบทุกข้อความ และ Web เป็น chat-first ดู baseline changes ใน S09

## User Stories

1. ในฐานะ owner ฉันต้องการสร้าง project group เพื่อให้บริบทและข้อผูกพันของแต่ละโครงการแยกกัน
2. ฉันต้องการ topics ภายใน group เพื่อกลับมาคุยเรื่องเดิมได้
3. ฉันต้องการตั้งบทบาทและ responsibility เพื่อให้แต่ละ specialist มีหน้าที่ชัด (S09: ทางหลักคือยอมรับ role proposal ของ Jit)
4. ฉันต้องการกำหนด Grok/Codex model/auth route ต่อบทบาทหรือโครงการเพื่อควบคุมการใช้งาน
5. ฉันต้องการให้ Jit เลือกผู้เกี่ยวข้องกับหัวข้อเพื่อลดภาระเรียกทีมเอง
6. ฉันต้องการเรียก หยุด หรือข้าม specialist ได้เพื่อควบคุมการหารือ
7. ฉันต้องการ independent analyses เพื่อได้เหตุผลที่ต่างกันจริง
8. ฉันต้องการ coordinator สรุปทางเลือกและข้อขัดแย้งเพื่อให้ฉันตัดสิน
9. ฉันต้องการให้เฉพาะคำตอบที่ฉันรับรองเป็น decision เพื่อไม่ให้ข้อเสนอถูกจำเป็นมติ
10. ฉันต้องการให้ suggestions อยู่ใน proposed task ก่อน เพื่อให้ task list สะท้อนข้อผูกพันจริง
11. ฉันต้องการรับรองและแก้ task จาก Web/Telegram โดยไม่เกิดรายการซ้ำ
12. ฉันต้องการให้ accepted task ยังรอ explicit start สำหรับ execution เพื่อแยกการวางแผนกับการลงมือ
13. ฉันต้องการถามงานค้างหลังข้ามวันและ reboot โดยไม่ป้อนบริบทเดิมใหม่
14. ฉันต้องการเปิดดูประวัติและ source ของ decision เพื่อเข้าใจเหตุผลเดิม
15. ฉันต้องการให้ Jit ใช้ความรู้ข้ามโครงการได้ โดยบอกว่าอะไรเป็น fact หรือ inference
16. ฉันต้องการให้ข้อจำกัดโครงการปัจจุบันชนะ preference ที่อนุมาน เพื่อไม่ให้บริบทเดิมบังคับทางเลือกผิด
17. ฉันต้องการแก้ memory ที่ผิดและให้ derived claims เปลี่ยนตาม
18. ฉันต้องการลืม derived memory โดยยังเปิดต้นฉบับเองได้ และไม่ถูกสกัดกลับเงียบ ๆ
19. ฉันต้องการลบ local sources/derivatives ด้วย preview ที่บอกผลกระทบต่อ history และ backup
20. ฉันต้องการเปิด monitoring เฉพาะ repositories ที่อนุญาต
21. ฉันต้องการ static PR review ที่ผูก base/head revision และบอกสิ่งที่ตรวจไม่ครบ
22. ฉันต้องการให้อ่าน spec/context/CI evidence ได้โดยไม่รันโค้ดจาก PR
23. ฉันต้องการให้ actionable findings มาพร้อมตำแหน่ง เงื่อนไข ผลกระทบและหลักฐาน
24. ฉันต้องการรับแจ้งส่วนตัวเฉพาะประเด็นที่มีหลักฐาน ส่วนข้อสงสัยอยู่ในรายงาน
25. ฉันต้องการให้ revision ใหม่ทำให้ผลเดิม stale เพื่อไม่เชื่อผลที่ไม่ตรงโค้ดล่าสุด
26. ฉันต้องการ owner-only Telegram binding เพื่อไม่ให้ผู้อื่นสั่งงานผ่าน bot
27. ฉันต้องการถามต่อและรับรอง task จาก Telegram โดยเห็น state เดียวกับ Web
28. ฉันต้องการตั้ง reminders/summaries พร้อม timezone และหยุดได้
29. ฉันต้องการให้บทสนทนาที่กำลังใช้มี priority ก่อนงานเบื้องหลัง
30. ฉันต้องการเห็นงานที่รอ quota/auth และ next action โดยไม่มี billing fallback
31. ฉันต้องการ stop/cancel และให้ late results ไม่แก้ state ต่อ
32. ฉันต้องการให้บริการกลับมาหลัง reboot และตรวจงานค้างก่อนทำต่อ
33. ฉันต้องการ backup/restore ที่ไม่ปลุกข้อมูลซึ่งลืมหรือลบไปแล้ว
34. ฉันต้องการดูหลักฐานว่า job/task สำเร็จจริงตามประเภท ไม่ใช่เพราะ model ตอบว่า done

## Implementation Decisions

### Ownership and integration

Jit owns application commands/state, groups, roles, tasks, memory, durable jobs, channels and delivery. Schway owns model/tool loops, native sessions, compaction, retries, provider protocols and credential renewal. Use a supported host contract; missing engine behavior is tracked by [Schway S02](https://github.com/chayapats/schway/issues/393).

Each specialist run has distinct native context/session ownership. A group is an application conversation with attributed committed outputs and run references, not a shared mutable provider session.

### Authoritative state and transitions

Persist project/thread identities, expected revisions, actor/authorization references, task decisions, memory lineage, jobs/attempt generations and outbox intent. SQLite is the proposed store; it remains an engineering decision to validate with crash/restore tests.

Proposed → accepted requires owner command. Accepted does not start coding. Background PR/reminder work uses an explicitly enabled standing authorization. Completion policy is per work type and requires committed evidence.

Application state and native Schway session appends are separate commits. Reconcile interrupted cross-store work rather than claim atomicity. Duplicate ingress creates one logical mutation; cancelled/superseded attempts lose commit authority.

### Context, memory and tools

Keep operator instructions, owner preferences, source evidence and inferred claims distinct. Cross-project memory keeps its origin and never moves obligations between projects. Suppression/correction propagates through derivatives and future context assembly; affected native contexts are retired when replay would reintroduce forgotten content.

MVP uses scoped read connectors and service-owned persistence. Generic shell/write/edit/arbitrary fetch, repository instruction/package autoload and provider-hosted lookup are not enabled. GitHub integration has no mutation tools.

### Channels and background work

Web commands and bound Telegram commands use the same authorized/revisioned application path. Telegram delivery can be sent/failed/unknown; local deduplication is not exactly-once external delivery.

Scheduling is configured by owner, with timezone/misfire and finite limits. Interactive admission precedes queued background work; existing provider calls yield at supported cancellation/round boundaries.

### Deployment and configuration

Target one always-on Pi ARM64 host. Web is authenticated behind VPN. Runtime/credentials/state stay on the owner-controlled host while relevant content can be sent to selected inference services and Telegram.

Use role/project model configuration without automatic route/billing fallback. Numeric resource, polling, retry and retention values are operator configuration validated before pilot, not unlimited defaults.

## Acceptance Criteria

| Case | Observable outcome | Requirements |
| --- | --- | --- |
| AC01 | Two project groups retain their own topics/tasks while relevant cross-project memory keeps provenance | FR-01, FR-04–FR-05 |
| AC02 | Relevant specialists produce separate results; coordinator records disagreement and waits for owner decisions | FR-02–FR-03 |
| AC03 | Duplicate/stale acceptance cannot create duplicate obligations; accepted tasks do not execute code | FR-06–FR-07 |
| AC04 | Restart preserves committed tasks/decisions and reports unresolved attempts without claiming success | FR-04, FR-15 |
| AC05 | Correct/forget/delete affects dependent claims and future contexts, including restore/late-worker cases | FR-05, FR-16 |
| AC06 | Static review identifies current input revision, scope gaps and actionable evidence without tests or GitHub writes | FR-08–FR-09 |
| AC07 | Web and bound Telegram show the same committed state; wrong identity/ambiguous project/stale callbacks are rejected | FR-10–FR-11, FR-17 |
| AC08 | Configured schedules respect timezone/misfire, priority and finite budgets | FR-12, FR-14 |
| AC09 | Selected Grok/Codex routes use Schway lifecycle, report blocked access and do not switch billing | FR-13 |
| AC10 | Cancellation/revocation/supersession fences late results; notification ambiguity remains visible | FR-09, FR-15 |
| AC11 | Owner can inspect/stop/export and restore safely; missing latest deletion ledger keeps restore quarantined | FR-16, FR-18 |
| AC12 | ARM64 boot/auth, headless/provider import boundaries, resource profile, privacy and deterministic validation have evidence | NFR-01–NFR-12 |

All functional/security release cases must pass. Numeric product-value targets previously suggested during discovery are not accepted requirements.

## Testing Decisions

Primary seam: authenticated application command/query boundary → persistent state → scripted Schway host and fake external adapters → observable state/report/outbox. Reopen the store/service to prove durability. Avoid asserting private reducer or table layouts.

Use fake clocks for schedule/retry/lease behavior; protocol fixtures for PR/Telegram; scripted specialists for routing/conflict/memory; disposable local storage for crash/restore. Use existing Schway host/provider/session fixtures as prior art, while testing Jit at its own application boundary.

Live subscription/boot checks are opt-in S01 evidence and remain outside deterministic tests. Quality evaluation with actual models and owner feedback is separate from transport/state correctness.

## Out of Scope

Agent repository mutation, shell/tests/build/install, public GitHub review/comment/commit/merge/deploy, MCP Server, local inference, full Telegram specialist mirror, multi-user tenancy, browser/computer automation and voice.

## Further Notes

Detailed behavioral criteria remain [PRD FR-01–FR-18 and NFR-01–NFR-12](../product/02-prd.md). [S01](S01-host-auth-feasibility.md) gates host claims; [S02](https://github.com/chayapats/schway/issues/393) gates engine integration. S03–S08 are implementation-spec candidates derived from this parent, not authorization to implement the whole system in one ticket.

Before any ticket is ready-for-agent, declare its vertical slice, expected observable outcome, tests and exact contract blockers. Human login/reboot checks must be identified honestly.
