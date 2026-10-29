# Feature specifications

ชุดนี้ใช้ product baseline ที่ยืนยันแล้วเป็น input สำหรับแตก implementation tickets Specs เป็น design parents ที่แยกจาก tickets ที่จะให้ agent ลงมือจริง

| Spec | Owner | สถานะและขอบเขต |
| --- | --- | --- |
| [MVP](00-mvp.md) / [issue](https://github.com/chayapats/jit/issues/1) | Jit | พฤติกรรมทั้ง release, requirements, seams และ acceptance |
| [S01](S01-host-auth-feasibility.md) / [issue](https://github.com/chayapats/jit/issues/2) | Jit | หลักฐาน Pi/service/subscription ที่ต้องได้ก่อนรับรอง runtime support |
| [S02](https://github.com/chayapats/schway/issues/393) | Schway | public host contract และ strict context/tool policy; design spec อยู่ใน Schway |
| [S09](S09-main-bot-and-chat-first-ui.md) / [issue](https://github.com/chayapats/jit/issues/90) | Jit | Jit main bot, role proposals, dispatch allowance, General space และ chat-first Web สองภาษา |
| [S10](S10-reliability-and-owner-integrations.md) / [issue](https://github.com/chayapats/jit/issues/111) | Jit | quiet/failed runs, deterministic routing, notify-once, result contract, context packet, local API/CLI, signed webhooks และ `.ics` feed (openbot-inspired) |
| [S11](S11-execution-access-and-tools.md) / [issue](https://github.com/chayapats/jit/issues/123) | Jit | Access levels, execution box (rootless Podman), approval cards, connections, MCP, browser-use และ computer-use; Schway contract [schway#429](https://github.com/chayapats/schway/issues/429) |
| [S12](S12-fluid-conversation.md) / [issue](https://github.com/chayapats/jit/issues/170) | Jit | Draft: answer first (D01 done in #169), streaming, read-only web search/fetch, short chat voice, quiet team work, reply chips (concepts from openbot/OpenDuet) |

ขอบเขต S03–S08 ใน [roadmap](../product/07-roadmap.md) ถูกแตกจาก MVP เป็น [implementation backlog](../tickets/README.md) ครบแล้ว แต่ละ ticket ระบุ FR/NFR, acceptance, test seam และ versioned contract prerequisites การยังไม่มีผล feasibility ไม่ขัดขวาง deterministic feature work แต่ห้ามอ้างว่า host/account support หรือ dependency ผ่านแล้ว

## การแตก tickets ต่อ

1. เลือก vertical slice ที่มีผลลัพธ์ตรวจรับได้จาก spec parent
2. ระบุ FR/NFR, acceptance cases, test seam, out-of-scope และ prerequisites
3. แยก human credential/host verification จาก deterministic implementation work
4. เชื่อม blockers โดย contract/version และใช้ tracker ของ repository ที่เป็นเจ้าของการเปลี่ยนแปลง
5. ใช้ ready-for-agent เฉพาะ ticket ที่แคบพอและไม่มี decision ที่ต้องเดา; spec parents ใช้ spec กับ needs-triage

ดู [workflow](../agents/workflow.md) Specs นี้ไม่ได้สร้าง implementation claims หรืออนุมัติให้ติดตั้งบน Pi/ใช้ live subscription จากงานเขียนเอกสาร
