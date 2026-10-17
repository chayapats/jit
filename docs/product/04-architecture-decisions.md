# Jit Architecture Decision Records

ADRs อยู่ที่ docs/adr ของ Jit ทุกฉบับด้านล่างมี scope เป็น Jit design ไม่ประกาศว่ามี implementation หรือ public Schway API ใหม่แล้ว

## Accepted direction

| ADR | การตัดสินใจ | ที่มาจาก discovery |
| --- | --- | --- |
| [0001](../adr/0001-application-boundary.md) | Jit application แยก repository; Schway เป็น execution engine | C19–C20 |
| [0002](../adr/0002-local-runtime-and-external-inference.md) | local always-on host กับ external inference/channels และ unattended boot | C08–C12 |
| [0003](../adr/0003-cross-project-memory-with-provenance.md) | เรียนรู้ข้ามโครงการพร้อม provenance/correction/forget | C05–C07 |
| [0004](../adr/0004-task-authority-and-staged-execution.md) | task acceptance แยกจาก start; isolated coding execution เลื่อน | C04, C14, C17–C18, C21 |
| [0005](../adr/0005-static-private-pr-review.md) | static private PR review; evidence/revision/scope เป็นส่วนของผล | C16 |

## Proposed engineering decisions

| ADR | ข้อเสนอ | เงื่อนไขก่อนรับรอง implementation |
| --- | --- | --- |
| [Schway S02](https://github.com/chayapats/schway/issues/393) | narrow public Schway host API | feasibility + interface spec + Schway compatibility/review |
| [0006](../adr/0006-local-transactional-state.md) | SQLite app state กับ references ไป native Schway sessions | crash/restore/concurrency tests บน Pi และ storage spec |

Migration รักษา provenance และ mapping ของ accepted decisions แล้ว ส่วน ADR/API ที่กระทบ Schway อ้างกลับไป spec และ process ของ Schway การเลือก database, package entrypoint หรือ service supervisor ยังไม่กลายเป็นคำตอบของผู้ก่อตั้งเพราะมีชื่ออยู่ใน architecture proposal
