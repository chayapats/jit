# Jit — Discovery decision record

สถานะ: ปิด discovery ตามคำยืนยันของผู้ก่อตั้ง และได้รับคำสั่งให้สร้างชุดเอกสาร spec แล้ว บันทึกนี้รักษาเจตนาจาก Q1–Q41; ข้อเสนอวิศวกรรมใหม่ไม่ใช่คำตอบเพิ่มเติมของผู้ก่อตั้ง

## Confirmed decisions

| ID | ข้อตกลง | ที่มา |
| --- | --- | --- |
| C01 | ผู้ใช้แรกคือผู้ก่อตั้ง; personal operator และ developer assistant สำหรับโครงการซอฟต์แวร์ | Q1 A, Q4 B/C, Q11 A |
| C02 | ต้องมีกรุ๊ปแชทและความต่อเนื่องข้ามวัน; หนึ่ง project ต่อ group | Q5, Q12 A |
| C03 | ผู้เชี่ยวชาญแยกการวิเคราะห์/ทำงานจริง มี router เลือกทีมและ coordinator สรุปให้ผู้ใช้ตัดสิน | Q7 B, Q8 B, Q13 B |
| C04 | ไอเดียเป็น proposed task ก่อน ผู้ใช้รับรองจึง accepted; execution ต้องรอคำสั่งเริ่ม | Q14 B, Q22 B |
| C05 | จำงานค้าง งานที่ต้องทำ และประวัติโครงการ; เรียนรู้และใช้ข้ามโครงการอัตโนมัติได้ | Q10, Q28 C |
| C06 | แยก explicit fact/inference พร้อมที่มาและเปิดเผย inference ที่มีผลสำคัญ | Q31 B |
| C07 | ลืม = ลบ derived memory แต่เก็บต้นฉบับ; ลบข้อมูล = แยกคำสั่งสำหรับ local source/derived data; แก้ข้อมูลผิดได้ | Q29 รับข้อเสนอ |
| C08 | runtime, credentials, persistent storage และ execution อยู่บน host ส่วนตัว; ส่ง relevant content ให้ cloud inference ได้ | Q3, Q6 A |
| C09 | Web เป็นหลัก; Telegram เสริมสำหรับแจ้ง ถาม สั่งและรับรองงาน; ส่งเนื้อหาและโค้ดที่เกี่ยวข้องได้ | Q15 A + Telegram, Q18 A, Q19 B |
| C10 | host ที่เปิดต่อเนื่องคือ Raspberry Pi 5; Web เข้าได้ผ่าน private network/VPN | Q16 B, Q20, Q34 B |
| C11 | reboot แล้วกลับมาทำงานเอง โดย service เข้าถึง credentials ที่จำเป็นได้ | Q35 A |
| C12 | ใช้ subscription ที่มีอยู่ของ Grok และ Codex; ผู้ใช้กำหนดต่อบทบาท/โครงการ | Q23, Q24, Q30 A |
| C13 | บทสนทนาที่ผู้ใช้กำลังใช้งานมี priority เหนืองาน background | Q25 A |
| C14 | งานอ่านกู้แล้วเริ่มใหม่ได้; งานเปลี่ยนไฟล์ต้องตรวจสถานะจริง ถ้าพิสูจน์ไม่ได้ให้ถาม | Q26 B |
| C15 | ทำ reminder/summary ตามเวลาและเงื่อนไขที่ผู้ใช้ตั้งไว้ได้ | Q27 B |
| C16 | PR review อัตโนมัติอ่านเท่านั้น แจ้งส่วนตัว ไม่โพสต์/แก้ PR; แจ้งประเด็นที่มีหลักฐาน ส่วนข้อสงสัยอยู่ในรายงาน | Q2, Q9 A, Q17 B, Q21 A |
| C17 | เกณฑ์ completion กำหนดต่อประเภทงาน | Q32 C |
| C18 | งาน shell/แก้โค้ดในอนาคตต้องมี execution boundary แยกจากบริการ | Q33 B |
| C19 | Schway ถือ execution primitives; Jit ถือ product orchestration, memory, groups, jobs และ channels | Q36 A |
| C20 | Jit application อยู่ repository แยก; เจตนา license แบบ permissive | Q37 A, Q39 A |
| C21 | รุ่นแรกพิสูจน์ group/memory/tasks/PR workflow; execution สำหรับแก้โค้ดเป็น milestone ถัดไป | Q38 B |
| C22 | ผู้ก่อตั้งมีเวลาประมาณ 14 ชั่วโมงต่อสัปดาห์; จะทดลองแล้วให้ feedback เอง | Q40, Q41 |

Q20 ระบุ SSH target ของ installation แรกไว้ในบันทึก .local ที่ไม่เข้า Git; ที่อยู่เครื่องเป็น configuration ของเจ้าของ ไม่ใช่ product default

## Tentative technical preferences

- P01: Bun/TypeScript ฝั่งบริการ เพื่อ reuse Schway; ยังต้องยืนยัน dependency/runtime บน ARM64
- P02: SQLite สำหรับ Jit state และ transactional inbox/outbox บนเครื่องเดียว ดู ADR 0006
- P03: public embedding API ที่แคบและ versioned ของ Schway ดู Schway S02; ยังไม่มี API นี้
- P04: Telegram long polling และ GitHub polling แบบมี cursor/conditional requests เพื่อไม่ต้องเปิด public ingress
- P05: service บน Linux พร้อม restart policy, dedicated identity และ boot credential provisioning ที่ต้องผ่าน spike
- P06: ใช้ MIT ตามเจตนา permissive; สร้าง Jit repository และ LICENSE แล้วระหว่าง migration ส่วน public release/support policy ยังต้องกำหนด
- P07: ค่า concurrency, retry deadline, polling interval และ retention เป็น configuration ที่ต้องวัดและกำหนดค่าเริ่มต้นภายหลัง

## Rejected alternatives สำหรับทิศทางรุ่นแรก

- general-life assistant และ multi-user product เป็น scope แรก
- แสดงหลาย persona โดยไม่มีการวิเคราะห์แยกเป็นหลักฐานของ specialist team
- ให้ทุกทีมตอบทุกครั้ง หรือให้ทีมตัดสินใจสำคัญแทนผู้ใช้โดยปริยาย
- รับทุก suggestion เป็นข้อผูกพันทันที และถือ accepted task เป็น start authorization
- โพสต์ review, แก้ PR หรือ merge จาก background PR review
- ย้าย product orchestration ทั้งหมดเข้า Schway core หรือสร้าง loop ใหม่ใน Jit
- ถือว่าการรัน local ทำให้ inference/Telegram ไม่ได้รับข้อมูล

## Deferred

- การแก้ repository, shell/tests/build โดย agent; หลักการ authorization/isolation/recovery ของระยะนี้ยืนยันแล้ว แต่ capability ยังไม่เปิดใน MVP
- MCP Server, local inference และ full Telegram mirror
- browser/computer automation, voice และ extension marketplace ไม่มี use case ที่ยืนยันให้รวมใน MVP; เปิดพิจารณาใหม่เมื่อมีหลักฐาน

## Unresolved และ trade-offs

- ยังไม่มีวันส่งมอบที่ยืนยัน; 14 ชั่วโมง/สัปดาห์คือกำลัง review/ตัดสินใจ/ดูแล ไม่ใช่วันที่เปิดตัว
- ผู้ก่อตั้งยังไม่ได้เลือก pilot project หรือเกณฑ์ product-value แบบตัวเลข
- หนึ่ง model ต่อบทบาทเลือกได้ แต่ exact model IDs, role defaults และ quota behavior ต้องตรวจตาม account จริง
- cross-project memory เพิ่มประโยชน์และความเสี่ยงการสรุปข้ามบริบท ต้องรักษาที่มาและ propagation ของ correction/forget
- boot availability แลกกับ service identity ที่เข้าถึง credentials ได้; ไม่อ้างป้องกัน host administrator หรือเครื่องที่ถูกยึดแล้ว
- isolation ที่เลือกสำหรับอนาคตยังไม่ได้เลือก container/VM/กลไกเฉพาะ
- PR event policy, repo allowlist, latency, retention และ numeric resource budgets เป็น spec/configuration work ดู validation plan

## Risks และ assumptions

อ้างอิงรายการ R01–R12 ใน [validation plan](08-validation-and-open-questions.md) โดยเฉพาะ Pi subscription readiness, minimal host API, prompt injection, source completeness, notification ambiguity, memory forgetting และประโยชน์ที่แท้จริงของหลาย specialist

## สิ่งที่ไม่ได้รับรองจาก discovery

ตัวเลขทดลอง 14 วัน, 10 PR และข้อค้นพบถูกต้อง 80% เป็นข้อเสนอ Q41 ที่ผู้ก่อตั้งไม่ได้รับรอง ห้ามใช้เป็น release acceptance หรือประกาศเป็น benchmark ของ Jit ค่าเวลาใน roadmap เป็นประมาณการวิศวกรรมหลัง discovery ไม่ใช่ commitment จาก Q40
