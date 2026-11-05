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
| [S12](S12-fluid-conversation.md) / [issue](https://github.com/chayapats/jit/issues/170) | Jit | Done 2026-10-29 (follow-ups #216, #221, evidence #222). Just-works first: answer first (D01 done in #169), streaming, web tools via a vendor-neutral Schway contract with SSRF guard and zero-config SearXNG, Web sign-in, one-command install, project/role deletion, short chat voice, quiet team work, reply chips (concepts from openbot/OpenDuet) |
| [S13](S13-chat-attachments.md) / [issue](https://github.com/chayapats/jit/issues/187) | Jit | Done 2026-10-29, on by default (follow-up evidence #222). Chat attachments (PNG/JPEG/WebP/PDF/text), sanitized out of process, untrusted; Schway image content [schway#436](https://github.com/chayapats/schway/issues/436) |

ขอบเขต S03–S08 ใน [roadmap](../product/07-roadmap.md) ถูกแตกจาก MVP เป็น [implementation backlog](../tickets/README.md) ครบแล้ว แต่ละ ticket ระบุ FR/NFR, acceptance, test seam และ versioned contract prerequisites การยังไม่มีผล feasibility ไม่ขัดขวาง deterministic feature work แต่ห้ามอ้างว่า host/account support หรือ dependency ผ่านแล้ว

## การแตก tickets ต่อ

1. เลือก vertical slice ที่มีผลลัพธ์ตรวจรับได้จาก spec parent
2. ระบุ FR/NFR, acceptance cases, test seam, out-of-scope และ prerequisites
3. แยก human credential/host verification จาก deterministic implementation work
4. เชื่อม blockers โดย contract/version และใช้ tracker ของ repository ที่เป็นเจ้าของการเปลี่ยนแปลง
5. ใช้ ready-for-agent เฉพาะ ticket ที่แคบพอและไม่มี decision ที่ต้องเดา; spec parents ใช้ spec กับ needs-triage

ดู [workflow](../agents/workflow.md) Specs นี้ไม่ได้สร้าง implementation claims หรืออนุมัติให้ติดตั้งบน Pi/ใช้ live subscription จากงานเขียนเอกสาร

## S16 — current owner-confirmed target

[S16](S16-rakazo-experience.md), confirmed 2026-11-05, makes Rakazo the primary product reference while retaining Jit + Schway. The owner authorized selective source/concept reuse and improvements to existing stacks. Files/artifacts, general browser/desktop, app/tool/skill connections, persistent team/routine/memory behavior, voice and native clients are required outcomes. [ADR 0074](../adr/0074-rakazo-reuse-and-product-convergence.md) separates integration proposals from confirmed direction. Track delivery in [#392](https://github.com/chayapats/jit/issues/392) and the [S16 graph](../tickets/S16-rakazo-experience-roadmap.md). S14 remains default; S15 is opt-in; no parity or live adoption is inferred.

## S15 — retained authority baseline and opt-in implementation

[S15](S15-conversational-autonomy.md), confirmed 2026-11-02, records conversational execution under standing policy, an administrable working VM, shared team resources, browser-first work and automatic memory with protected human approvals. Default GitHub publication waits; an opt-in personal workflow may publish and auto-merge selected work, while production still waits. [ADR 0064](../adr/0064-conversational-authority-and-protected-control-plane.md) separates proposed engineering and unresolved enforcement gates. The 23 decisions and S15-AC01–AC16 are the current target, tracked by [#316](https://github.com/chayapats/jit/issues/316) and the [delivery graph](../tickets/S15-conversational-autonomy-roadmap.md); no S15 implementation or live cutover is claimed.

## S14 — implemented runtime and previous product direction

[S14](S14-bot-first-local-assistant.md) / [#244](https://github.com/chayapats/jit/issues/244) introduced persistent Bots/local computers and Parallel research without required Projects. Its implementation, required coding/personal slices and scoped evidence are recorded in [CONTEXT.md](../../CONTEXT.md) and the [S14 tracker](../tickets/S14-bot-first-roadmap.md). It remains the implemented default, with explicit legacy compatibility. Earlier broad ADR/design proposals do not certify another build or host. S15 supersedes conflicting product choices without changing S14 runtime behavior through documentation.
