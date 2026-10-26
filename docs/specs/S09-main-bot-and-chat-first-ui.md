# Spec S09 — Jit main bot and chat-first interface

Tracker: https://github.com/chayapats/jit/issues/90

Owner: Jit. Status: confirmed by the owner on 2026-10-26 and ready for ticket breakdown. Parent: [MVP spec](00-mvp.md). Requirements: [PRD FR-19–FR-25 and NFR-11](../product/02-prd.md). Visual system: [design/README.md](../design/README.md).

## Problem Statement

Jit ตอนนี้เป็น workspace แบบจัดการโครงการ ข้อความของ owner ใน topic ถูกบันทึกแต่ไม่มีใครตอบ specialist ถูกสร้างได้ทางเดียวจากฟอร์มตั้งค่าทีม และการเรียกทีมต้องเริ่ม "การหารือ" เอง ทำให้ต้องจัดทีมตายตัวตั้งแต่แรกก่อนจะได้คุณค่า

Owner ต้องการคุยกับบอทหลักแบบ Grok: เปิดมาพิมพ์ได้ทันที บอทตอบเอง เสนอผู้เชี่ยวชาญเฉพาะทางได้เมื่อจำเป็น และเรียกทีมมาช่วยภายใต้ขอบเขตที่ owner อนุญาต หน้าตาต้อง modern และ polished มีความเป็นไทยเล็กน้อยที่โลโก้ตามชื่อ "จิต"

## Solution

Coordinator กลายเป็น Jit ในบทสนทนา: ตอบทุกข้อความ owner ด้วย persona ที่ owner ตั้งตอนเปิดใช้ครั้งแรก ("ตั้งจิต") เสนอ role ใหม่เป็นการ์ดที่ owner ยืนยัน เรียก specialists ที่มีอยู่เองภายใน dispatch allowance แล้วตอบเป็นเสียงเดียวที่อ้างผลของทีม

Web ถูกออกแบบใหม่ทั้งหมดเป็น chat-first, monochrome dark/light, ใช้ browser script แบบ progressive enhancement ที่ไม่มี build step, สองภาษา และติดตั้งเป็น PWA ได้ ทุก authority invariant เดิมคงอยู่: model output ไม่สร้าง configuration, task หรือ decision เอง

## Confirmed decisions

Owner ยืนยันข้อเหล่านี้ระหว่าง grilling session วันที่ 2026-10-26 และยืนยันรายละเอียดของ D09/D14 หลัง review เอกสารชุดแรกในวันเดียวกัน ข้อเสนอวิศวกรรมอยู่ใน ADR ไม่ใช่ส่วนหนึ่งของตารางนี้ เอกสารนี้เป็น single source of truth ของ S09; เมื่อขัดกับ baseline เดิม ให้ถือตามตารางด้านล่าง

| ID | ข้อตกลง |
| --- | --- |
| S09-D01 | ใช้ browser script แบบ progressive enhancement: vanilla, local static asset, ไม่มี framework/build; form ทั้งหมดใช้ได้เมื่อไม่มี script |
| S09-D02 | แก่นของ Jit คือคุยกับบอทหลักแบบ Grok แล้วให้บอทช่วยสร้างและเรียกผู้เชี่ยวชาญ ไม่ใช่การจัดทีมตายตัวตั้งแต่แรก |
| S09-D03 | Jit ร่าง specialist เป็นการ์ด; owner กด สร้าง / แก้ไข / ไม่เอา; การสร้างยังเป็น owner command |
| S09-D04 | Jit เรียก specialists ที่มีอยู่เองได้ภายใน allowance ที่ owner ตั้ง ค่าเริ่มต้น 3 role ต่อข้อความ; เกินต้องยืนยัน; role/task/decision ยังต้องยืนยันทุกครั้ง |
| S09-D05 | โครงสร้าง chat-first แบบ Grok: หน้าแรกเป็นช่องพิมพ์, sidebar โครงการ → หัวข้อ, panel ของหัวข้อและ ⌘K สำหรับ memory/tasks/jobs/PR, งาน ops ย้ายไปตั้งค่า |
| S09-D06 | Dark-first monochrome พร้อม light mode; ไม่มีสี accent ไทย; สีอื่นมีเฉพาะสีความหมาย |
| S09-D07 | Onboarding "ตั้งจิต" ตั้งค่าตัว Jit ครั้งเดียว: ตื่น → เชื่อมจิต → รู้จักกัน → นิสัยของจิต (ข้ามได้) → ตั้งจิต; ไม่ใช้คำว่า "อธิษฐาน" ใน UI |
| S09-D08 | Specialists แสดงเป็นการ์ดทีมที่พับได้; Jit ตอบเป็นเสียงเดียว; ความเห็นแต่ละคนเปิดอ่านได้ |
| S09-D09 | แชทใหม่อยู่ในพื้นที่ "ทั่วไป"; Jit เสนอการ์ดยกหัวข้อเป็นโครงการได้; การยกระดับคือการสร้างโครงการและหัวข้อใหม่ที่ต่อจากต้นทางพร้อมลิงก์ ณ revision ที่แน่นอน ต้นทางกลายเป็นอ่านอย่างเดียว ไม่ย้าย project identity |
| S09-D10 | โลโก้แนว D "บอทนั่งสมาธิ" พร้อม wordmark "จิต"; ความเป็นไทยอยู่ที่โลโก้เท่านั้น; หลีกเลี่ยงสัญลักษณ์ทางศาสนา |
| S09-D11 | ฟอนต์ Inter + Noto Sans Thai + JetBrains Mono แบบ self-host |
| S09-D12 | UI สองภาษาไทยและอังกฤษในรอบนี้; ไทยเป็นค่าเริ่มต้น |
| S09-D13 | Responsive เต็มรูปแบบและติดตั้งเป็น PWA ได้ |
| S09-D14 | ส่งมอบเป็นเฟส: เอกสาร → design system/shell → ประสบการณ์หลัก → เก็บงาน; แต่ละ ticket เป็น vertical slice ที่รวม UI และ backend ของฟีเจอร์นั้น ตาม [workflow](../agents/workflow.md) |

## Baseline changes

S09 เปลี่ยน baseline เดิมดังนี้ เอกสารต้นทางถูกปรับให้ตรงกันแล้ว

| เดิม | ตาม S09 |
| --- | --- |
| [J01](../product/02-prd.md): ตั้ง role/model route ก่อนคุย | Setup ตั้งจิตเชื่อม route และ persona ครั้งเดียว; roles เกิดจาก role proposals ในบทสนทนาหรือแก้ในตั้งค่า |
| [MVP story 3](00-mvp.md) และ [role presets](../product/06-mvp.md) | ยังตั้ง role เองได้ แต่ทางหลักคือยอมรับ role proposal ของ Jit; presets เป็นทางเลือกเสริม |
| การเรียกทีมต้องเริ่ม discussion เอง | Jit เรียกเองภายใน dispatch allowance (ค่าเริ่มต้น 3) |
| ข้อความ owner ถูกบันทึกโดยไม่มีคำตอบ | Jit ตอบทุกข้อความ (FR-19) |
| [ADR 0007](../adr/0007-first-web-slice.md): ไม่มี browser JavaScript | Progressive enhancement ตาม ADR 0028 |
| [Architecture](../product/03-architecture.md): event stream transport ยังไม่เลือก | SSE จาก persisted progress ตาม ADR 0028 |
| NFR-11: ภาษาป้าย UI ยังไม่ล็อก | ไทย (ค่าเริ่มต้น) และอังกฤษ ตาม FR-25 |

## User Stories

35. ในฐานะ owner ฉันต้องการพิมพ์คุยกับ Jit ได้ทันทีที่เปิดแอป โดยไม่ต้องเลือกโครงการหรือตั้งทีมก่อน
36. ฉันต้องการให้ Jit ตอบทุกข้อความด้วยน้ำเสียงและภาษาที่ฉันตั้งไว้
37. ฉันต้องการบอก Jit ให้สร้างผู้เชี่ยวชาญเฉพาะทาง แล้วยืนยันได้ในคลิกเดียว
38. ฉันต้องการให้ Jit เรียกผู้เชี่ยวชาญที่เกี่ยวข้องเองภายในงบที่ฉันอนุญาต และหยุดหรือข้ามได้
39. ฉันต้องการคำตอบเดียวที่สรุปแล้ว แต่เปิดดูความเห็นของแต่ละคนได้
40. ฉันต้องการยกเรื่องที่คุยในพื้นที่ทั่วไปเป็นโครงการ โดยไม่เสียที่มาของบทสนทนาเดิม
41. ฉันต้องการตั้งค่า Jit ครั้งแรกผ่านขั้นตอนสั้น ๆ ที่บอกได้ว่า model ใช้ได้จริงหรือไม่
42. ฉันต้องการใช้ Jit บนมือถือเหมือนแอป และเลือก dark/light กับไทย/อังกฤษได้

เลขต่อจาก user stories 1–34 ของ MVP

## Required behavior

| Case | Observable outcome | Requirements |
| --- | --- | --- |
| S09-AC01 | ข้อความ owner ใน topic ได้คำตอบจาก Jit หนึ่งคำตอบ; refresh ระหว่าง streaming ไม่สร้างคำตอบซ้ำ; route ที่ blocked แสดง next action | FR-19, FR-10, FR-13, FR-15 |
| S09-AC02 | Role proposal สร้าง role เฉพาะเมื่อ owner ยอมรับ revision ปัจจุบัน; stale/injected/forged proposals ไม่เปลี่ยน configuration | FR-20, FR-17 |
| S09-AC03 | Jit เรียกได้ไม่เกิน allowance; เกินแล้วรอการยืนยัน; stop/skip fence late results | FR-21, FR-02, FR-14, FR-15 |
| S09-AC04 | Jit ตอบเป็นเสียงเดียวที่อ้าง committed specialist results พร้อม coverage gap; decision ยังต้อง owner ยอมรับ | FR-19, FR-03 |
| S09-AC05 | แชทที่ไม่เลือกโครงการอยู่ใน "ทั่วไป"; การยกระดับสร้างโครงการเมื่อ owner ยอมรับและรักษา provenance | FR-22, FR-01, FR-05 |
| S09-AC06 | Installation ใหม่เข้าสู่ setup; ทำต่อได้หลัง restart; ผลแก้ได้ในตั้งค่า | FR-23, FR-13 |
| S09-AC07 | ทุกหน้าใช้ shell ใหม่ ใช้งานได้ทั้งมี/ไม่มี script, dark/light, ไทย/อังกฤษ; CSP อนุญาตเฉพาะ self | FR-24, FR-25, NFR-07, NFR-09, NFR-11 |
| S09-AC08 | PWA ติดตั้งได้และ cache เฉพาะ static assets; ไม่มี project data ใน cache | FR-24, NFR-09 |

## Proposed engineering choices

- [ADR 0028](../adr/0028-progressive-enhancement-browser-assets.md): local browser scripts, fonts, streaming และ PWA (แก้ส่วน "no browser JavaScript" ของ ADR 0007)
- [ADR 0029](../adr/0029-jit-conversation-and-role-proposals.md): Jit replies, persona และ role proposals (ต่อยอด ADR 0011 และ 0015)
- [ADR 0030](../adr/0030-owner-dispatch-allowance.md): dispatch allowance เป็น standing owner authorization
- [ADR 0031](../adr/0031-general-space-and-topic-promotion.md): พื้นที่ทั่วไปและการยกระดับหัวข้อโดยไม่ย้าย project identity

## Testing Decisions

ใช้ seam เดิมของ MVP: authenticated command/query boundary → persistent state → scripted Schway host → observable state ทุก ticket พิสูจน์ด้วย scripted model และ fake clock ไม่ใช้ paid inference

UI tests ตรวจ server-rendered HTML ทั้งแบบไม่มี script (form post) และ contract ของ script endpoints แยกกัน dictionary test ยืนยันว่า key ไทยและอังกฤษครบ Injection fixtures ต้องครอบ role proposal, dispatch และ promotion ว่า model/source text ไม่ได้ authority

การวัด performance และการติดตั้ง PWA บน Pi จริงเป็น opt-in evidence ที่ owner ทำ ไม่ใช่ deterministic release test

## Out of Scope

Voice, image generation ใน chat, provider-hosted search, multi-user, การให้ model สร้างหรือแก้ role/route/tool โดยไม่มีการยืนยันของ owner, coding/shell execution และ GitHub mutation (ยังคงตาม MVP)

## Tickets

แตกเป็น vertical slices ตาม [workflow](../agents/workflow.md) รายการและ blockers อยู่ใน [ticket backlog](../tickets/README.md#s09--jit-main-bot-and-chat-first-interface)
