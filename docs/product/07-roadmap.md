# Jit Development Roadmap

สถานะ: ข้อเสนอหลัง discovery ไม่ใช่ commitment วันส่งมอบ ขอบเขตอ้าง [MVP](06-mvp.md); engineering choices ต้องผ่าน gates ใน [validation plan](08-validation-and-open-questions.md)

## กำลังและวิธีประมาณ

ผู้ก่อตั้งให้เวลา review/ตัดสินใจ/ดูแลประมาณ 14 ชั่วโมงต่อสัปดาห์ ยังไม่มี release deadline ชั่วโมงด้านล่างเป็น engineering effort โดยประมาณสำหรับการ implement/review/verify แบบมีเจ้าของ integration คนเดียว ไม่ใช่เวลา model inference และไม่สมมติว่า agent ลด effort ได้เป็นสัดส่วนตายตัว

ช่วงรวม 142–246 ชั่วโมง เทียบกำลัง 14 ชั่วโมง/สัปดาห์ได้ประมาณ 10–18 สัปดาห์ก่อนเวลารอ provider, งานแก้จากผลทดลอง, ภาระ maintenance และ buffer จึงยังใช้เป็นวันที่เปิดตัวไม่ได้ ต้อง re-estimate หลัง M0/M1 โดยเฉพาะ public API และ credential boot path

## Milestones

| Milestone | ผลลัพธ์ | Depends on | Effort / complexity / confidence |
| --- | --- | --- | --- |
| M0 — Host/auth feasibility | Bun/Schway บน Pi, Grok/Codex service login/refresh/reboot, role route smoke ที่ opt-in; เลือก operating constraints | docs baseline | 10–18 ชม. / M / ต่ำถึงกลาง |
| M1 — Schway host contract | public API spec และ minimal bridge ที่เลือก context sources/tools/session/run/auth ได้ พร้อม compatibility tests | M0, แยก issue/spec ฝั่ง Schway | 20–36 ชม. / L / ต่ำ |
| M2 — Durable app state | project/group/topic, owner identity, commands/revisions, task/job separation, inbox/outbox, attempt fencing | M1 contract stable พอให้ fixture ใช้ได้ | 16–28 ชม. / M / กลาง |
| M3 — Web and specialist team | owner Web ผ่าน VPN, independent role analyses, routing/coordinator, model assignment, inspect/stop | M2 + bridge | 24–40 ชม. / L / กลาง |
| M4 — Continuity and memory | tasks/decisions/history, cross-project sourced claims, correction/forget/delete และ context invalidation | M2–M3 | 20–36 ชม. / L / ต่ำ |
| M5 — Static PR workflow | repo monitoring, snapshot manifests, revision-aware reports, finding policy และ private outbox | M2–M4 | 20–32 ชม. / L / กลาง |
| M6 — Telegram and schedules | owner binding, project commands/acceptance, notifications, configured reminder/summary, priority/limits | M3–M5 | 16–28 ชม. / M / กลาง |
| M7 — Recovery and pilot handoff | crash/duplicate/security checks, reboot, backup/restore/deletion reconciliation, operating profile และ runbook | M0–M6 | 16–28 ชม. / L / ต่ำถึงกลาง |

ผล feasibility อาจเปลี่ยน effort หรือทำให้ milestone รอ หาก route ใดไม่ผ่านให้แสดง blocker ไม่อ้างรองรับทั้งสองเพียงเพราะเลือกไว้ใน discovery และไม่เปลี่ยนไป billing route อื่นโดยไม่มี owner decision

## Exit criteria ต่อ milestone

### M0

- บันทึก runtime/dependency versions และ actual service context บน ARM64
- ทดสอบแต่ละ subscription ที่ owner ตั้งใจใช้ รวม token renewal และ boot credential access
- ไม่มีการเปิด public ingress เพื่อให้ integration ใช้ได้โดยไม่ผ่านการตัดสินใจ
- สรุปข้อจำกัด quota/concurrency ที่วัดได้และสิ่งที่ยังไม่รู้ โดยไม่อ่าน credentials ออกมาเป็นหลักฐาน

### M1

- แยก user-facing extension API เดิมกับ host contract ใหม่อย่างชัดเจน
- run ใช้ core loop/context/session/retry; ปิด PR-controlled AGENTS/skills/package autoload และเลือก narrow registry ได้
- public declarations, scripted/protocol fixtures, headless/lazy-provider tests ผ่าน
- ทำตาม Schway issue ownership/review/checks สำหรับ implementation PR เมื่อเริ่มงานจริง

### M2–M4

- รับ command ซ้ำแล้วมี mutation เดียว และ stale acceptance ถูกปฏิเสธ
- coordinator, specialists และ user decisions มี provenance แยกกัน
- accepted tasks/decisions ข้าม reboot ได้; memory cross-project ยังมี origin/status
- correction/forget/delete fence late workers และไม่ฟื้น claim จาก native session เก่า

### M5–M6

- PR case ใหม่/update/rebase/draft/closed/partial fetch มีผลตาม policy ที่ล็อกแล้ว
- ไม่มี code execution หรือ GitHub writes ใน tool/credential path ของ reviewer
- Telegram duplicate/timeout/offline และ schedule misfire มีสถานะที่ตรวจได้
- interactive admission มาก่อน background และทุก chain มี finite limits

### M7

- release gates ทั้งหมดของ MVP ผ่านพร้อม evidence artifacts
- backup/restore และ deletion ledger ผ่าน restore drill
- owner ดู state/stop/pause/reconnect และให้ feedback ได้
- ไม่มีข้ออ้าง product-value benchmark ที่ owner ยังไม่รับรอง

## หน่วย feature spec ที่ควรแตกต่อ

| Spec | เนื้อหาที่ต้องล็อก | Output ก่อนลงมือ |
| --- | --- | --- |
| S01 Host and auth | runtime versions, service identity, secret provisioning, boot/refresh flow | feasibility evidence + failure runbook |
| S02 Schway embedding | versioned host API, context/tool policy, session ownership, outcomes | interface contract + fixtures + compatibility plan |
| S03 Application state | schema/state machines, expected revisions, inbox/outbox, deletion generations | data invariants + transaction/recovery cases |
| S04 Team/Web | project/topics, routing budget, role assignment, synthesis, owner controls | user flows + API contracts + scripted scenarios |
| S05 Memory/tasks | claim taxonomy, source lineage, retrieval, task acceptance, forget/delete | acceptance corpus ไทย/อังกฤษ + suppression tests |
| S06 PR review | repo/trigger policy, immutable input fetching, coverage, findings/delivery | protocol fixtures + static-review rubric |
| S07 Telegram/schedules | binding, project resolution, callbacks, delivery ambiguity, timezone/misfire | channel fixtures + replay cases |
| S08 Operations/release | budgets, metrics, backups, migrations, restore, pause/reconnect | Pi operating profile + release checklist |

เอกสารนี้เป็น baseline สำหรับ [tracked feature specs](../specs/README.md) การสร้าง design spec ไม่ใช่การ claim implementation เมื่อเริ่ม implementation ให้ใช้ issue tracker ของ repository ที่เป็นเจ้าของการเปลี่ยนแปลง และเก็บ ownership ตามกติกาของ repository นั้น

## งานหลัง MVP

Coding execution เป็น milestone แยก: explicit start grants, isolated executor, scoped workspace/network/secrets, evidence-based completion และ side-effect reconciliation ต้องมาก่อนเปิด capability ไม่มีประมาณ effort ที่น่าเชื่อถือจนเลือก executor technology และได้ feedback pilot

MCP, local models, browser/computer automation, voice และ multi-user ยังไม่ผูกเป็นลำดับถัดไปโดยอัตโนมัติ ต้องมี use case และ capacity รองรับก่อน
