# Feature specifications

ชุดนี้ใช้ product baseline ที่ยืนยันแล้วเป็น input สำหรับแตก implementation tickets Specs เป็น design parents ที่แยกจาก tickets ที่จะให้ agent ลงมือจริง

| Spec | Owner | สถานะและขอบเขต |
| --- | --- | --- |
| [MVP](00-mvp.md) / [issue](https://github.com/chayapats/jit/issues/1) | Jit | พฤติกรรมทั้ง release, requirements, seams และ acceptance |
| [S01](S01-host-auth-feasibility.md) / [issue](https://github.com/chayapats/jit/issues/2) | Jit | หลักฐาน Pi/service/subscription ที่ต้องได้ก่อนรับรอง runtime support |
| [S02](https://github.com/chayapats/schway/issues/393) | Schway | public host contract และ strict context/tool policy; design spec อยู่ใน Schway |

S03–S08 ใน [roadmap](../product/07-roadmap.md) เป็น spec candidates สำหรับ app state, team/Web, memory/tasks, PR, Telegram/schedules และ operations โดยแตกจาก MVP และอ้าง contract ของ S01/S02 ที่พิสูจน์แล้ว การยังไม่มีผล feasibility ไม่ขัดขวางการเขียน acceptance fixtures แต่ห้ามอ้างว่า dependency ผ่านแล้ว

## การแตก tickets ต่อ

1. เลือก vertical slice ที่มีผลลัพธ์ตรวจรับได้จาก spec parent
2. ระบุ FR/NFR, acceptance cases, test seam, out-of-scope และ prerequisites
3. แยก human credential/host verification จาก deterministic implementation work
4. เชื่อม blockers โดย contract/version และใช้ tracker ของ repository ที่เป็นเจ้าของการเปลี่ยนแปลง
5. ใช้ ready-for-agent เฉพาะ ticket ที่แคบพอและไม่มี decision ที่ต้องเดา; spec parents ใช้ spec กับ needs-triage

ดู [workflow](../agents/workflow.md) Specs นี้ไม่ได้สร้าง implementation claims หรืออนุมัติให้ติดตั้งบน Pi/ใช้ live subscription จากงานเขียนเอกสาร
