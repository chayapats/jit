# Jit MVP Definition

สถานะ: scope baseline จาก C01–C22; ข้อเสนอการส่งมอบภายใน scope อยู่ใน roadmap

## สิ่งที่รุ่นแรกต้องพิสูจน์

เจ้าของคนเดียวคุยกับทีมผู้เชี่ยวชาญใน project group กลับมาข้ามวันแล้วติดตามงาน/ข้อสรุปต่อได้ และรับ static PR review บน infrastructure ของตนเอง พร้อม Telegram เป็นช่องทางเสริม

นี่คือขั้นต่ำที่ผู้ก่อตั้งเลือกให้ทดลองก่อนมี agent execution สำหรับแก้โค้ด ไม่ลดกรุ๊ปหรือความจำออกจาก MVP เพื่อทำ bot แจ้ง PR อย่างเดียว

## In scope

| Capability | ขอบเขตขั้นต่ำ | PRD |
| --- | --- | --- |
| โครงการและกรุ๊ป | หนึ่ง group ต่อ project, topics, references และประวัติ | FR-01 |
| ทีม | specialist analyses แยก, topic router, coordinator; ผู้ใช้เรียก/หยุด role ได้ | FR-02–FR-03 |
| Models | Grok/Codex subscriptions, role/project assignment; ไม่บังคับใช้ทั้งคู่ทุกครั้ง | FR-13 |
| ความต่อเนื่อง | tasks, decisions, history, sourced memory, cross-project learning พร้อม explicit/inferred distinction | FR-04–FR-05 |
| ข้อผูกพัน | proposed/accepted แยก, completion ตามประเภท; acceptance ไม่เริ่ม coding | FR-06–FR-07 |
| PR | configured repo monitoring, static snapshot review, scope/evidence, private reports/alerts | FR-08–FR-09 |
| Web | project conversation, tasks, memory, jobs, controls, owner authentication หลัง VPN | FR-10, FR-17–FR-18 |
| Telegram | notifications, follow-up, project-scoped commands/acceptance; binding กับ owner | FR-11 |
| Background | user-configured reminders/summaries, interactive priority, finite budgets | FR-12, FR-14 |
| Operations | reboot/recovery, stop/pause, durable state, backup/restore, corrections/forget/delete | FR-15–FR-18 |

ทีมเทค ดีไซน์ และมาร์เก็ตติ้งเป็น role presets ที่เสนอ ไม่ใช่ข้อกำหนดให้เรียกสามทีมพร้อมกันทุกข้อความ ตัวเลือก role/model defaults ต้องตั้งค่าได้โดยเจ้าของ ตาม [S09](../specs/S09-main-bot-and-chat-first-ui.md) ทางหลักในการได้ role คือยอมรับ role proposal ที่ Jit เสนอในบทสนทนา ส่วน presets เป็นทางเลือกเสริม

## Explicit exclusions

- Agent แก้ไฟล์ใน repository, shell, tests/build, dependency installation และการ execute โค้ดจาก PR
- GitHub comment/review submission, request changes, commits, merge หรือ deployment อัตโนมัติ
- MCP Server, local inference และ full mirror ของทุก specialist message ไป Telegram
- browser/computer automation, voice, multi-user/tenant administration และ marketplace
- team autonomy ที่ยอมรับงานหรือตัดสินใจสำคัญแทนผู้ใช้โดยปริยาย
- การย้าย group/memory/job product logic เข้า Schway core
- vector database หรือ learned model weights เป็นเงื่อนไขของคำว่า memory
- provider-hosted web search/lookup และ arbitrary network/file access ที่อยู่นอก scoped integration

การสร้าง record/report/cache ในพื้นที่บริการเป็น system persistence ที่อนุญาต ไม่เปิดช่องให้ model เขียน filesystem ตามอำเภอใจ

## Release gates

1. **Runtime:** Pi ARM64 รัน service และสอง subscription routes ได้ในบริบทจริง รวม reboot/refresh โดยไม่ fallback ไป API billing
2. **Integration:** ผ่าน stable Schway host contract ที่รองรับ policy ของ Jit; ไม่มี private deep imports หรือ TUI load ใน headless path
3. **Product journey:** J01–J05 ใน PRD ผ่าน scripted fixtures และ local service restart
4. **Trust:** ไม่มี unapproved GitHub writes, shell/repo execution, arbitrary file/network access, forged owner commands หรือ PR-controlled instruction autoload
5. **State:** duplicate commands, changed PR revisions, stale approvals, cancelled attempts และ corrections/forget ไม่ทำ state ผิด
6. **Operations:** inspect/stop/pause, degraded mode, backups, restore และ deletion reconciliation ใช้ได้จริง
7. **Operating profile:** บันทึกค่าจำกัด resource/queue/retry/retention และวัดบน Pi; ไม่มี unlimited fallback
8. **Pilot handoff:** ผู้ก่อตั้งเข้าใช้งานและรายงาน feedback ได้ โดยยังไม่มี product-value numeric threshold ที่ตกลง

## เกณฑ์ที่ไม่ใช้เป็นข้ออ้างว่า MVP สำเร็จ

จำนวน agent messages, model ตอบว่า done, การมี transcript บน disk และการส่ง Telegram API สำเร็จบางครั้งไม่แทนเกณฑ์ด้าน project continuity, completion หรือ delivery state

## การยก scope เข้ารุ่นถัดไป

การเพิ่ม coding execution ต้องมีแยก user start authorization, isolated executor, scoped secrets/network/filesystem, evidence-based completion และ recovery ของ side effects ตาม C04/C14/C17/C18 ก่อนเปิด capability นั้น โดยไม่เปิดพร้อม MVP เพียงเพราะ Schway มี bash/edit/write อยู่แล้ว

รายการงานหลัง pilot ต้องมาจาก feedback ของผู้ก่อตั้งและ risk evidence ไม่ตั้ง browser, voice หรือ multi-agent concurrency สูงเป็น roadmap ที่ผูกพันล่วงหน้า
