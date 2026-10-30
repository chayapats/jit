---
status: accepted
scope: Jit design
---

# Jit เรียนรู้ข้ามโครงการโดยรักษาที่มาและสถานะของ claim

ผู้ก่อตั้งเลือกให้ Jit เรียนรู้และใช้บริบทข้ามโครงการได้อัตโนมัติ เพื่อให้กลับมาทำงานต่อได้ แต่ต้องแยก explicit facts กับ inference และเปิดเผยที่มาเมื่อ inference มีผลต่อคำแนะนำสำคัญ Task และ decision ยังคง origin project; การเรียนรู้ไม่เพิ่ม authority หรือย้ายข้อผูกพัน

ทางเลือกแยกความจำทุกโครงการลด contamination แต่ลด personalization ส่วนการแชร์ทุกอย่างเป็นความจริงเดียวเสี่ยงสรุปเหตุผลเฉพาะโครงการเป็นความชอบถาวร ผลตามมาคือต้องรองรับ conflicting sources, corrections และ propagation ไป derived claims/context

“ลืม” ถอน derived memory แต่เก็บต้นฉบับไว้เปิดดูเอง และต้องป้องกันการสกัดกลับอัตโนมัติ “ลบข้อมูล” เป็น operation แยกที่ระบุ local sources/derivatives และผลต่อ backup/สำเนาภายนอก กลไก lineage/generation และการ retire engine contexts เป็นข้อเสนอ enforcement ใน architecture ไม่เปลี่ยน canonical Schway session format

ที่มา: C05–C07 ใน [decision record](../product/decision-record.md); FR-04–FR-05 และ FR-16

## S14 refinement status

This record retains its implemented legacy meaning. The owner-confirmed [S14 target](../specs/S14-bot-first-local-assistant.md) and proposed ADRs 0045–0048 refine Project ownership, grants/computers, Parallel default or replay-safe recovery where applicable. They do not claim a new supported API or change this build's behavior. Unchanged authority, fencing, credential and evidence invariants remain.
