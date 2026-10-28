# Spec S10 — Reliability and owner integrations

Tracker: https://github.com/chayapats/jit/issues/111

Owner: Jit. Status: the owner instructed on 2026-10-28 to adopt all ten ideas, and the spec is ready for ticket breakdown. Parent: [MVP spec](00-mvp.md); builds on [S09](S09-main-bot-and-chat-first-ui.md). Requirements: [PRD FR-26–FR-34, NFR-13 and the FR-17 refinement](../product/02-prd.md). Inspiration: [nightly-labs/openbot](https://github.com/nightly-labs/openbot).

## Problem Statement

หลัง S09 Jit คุยได้และเรียกทีมได้แล้ว แต่ยังขาดส่วนที่ทำให้ใช้งานจริงได้ต่อเนื่องทุกวัน:

- งานตามตารางเวลาส่งข้อความทุกครั้งแม้ไม่มีอะไรใหม่
- งานที่ specialist หลายคนช่วยกันอาจแจ้งเตือนหลายครั้ง
- การเลือก specialist ต้องพึ่ง model แม้กรณีที่ตัดสินได้ทันที และ owner ไม่เห็นเหตุผลว่าทำไมเลือกคนนั้น
- ผลของ specialist ไม่มีรูปแบบตายตัว เวลางานติดก็ไม่บอกว่าต้องทำอะไรต่อ
- การตัดสินใจของ owner อาจหลุดจาก context เมื่อมีการ compaction
- ไม่มีช่องให้ script บนเครื่อง owner หรือระบบภายนอกส่งงานเข้า Jit อย่างปลอดภัย
- ไม่มีวิธีดูตารางงานจากแอปปฏิทิน

## Solution

นำแนวคิด 10 ข้อจาก openbot มาปรับให้เข้ากับ authority model ของ Jit โดยไม่คัดลอกโค้ดหรือข้อความใดๆ เพราะ openbot ใช้ license PolyForm Noncommercial ทุกช่องทางใหม่ยังผ่าน command boundary, receipt และ fencing เดิม ข้อมูลที่เข้ามาจากภายนอกถือเป็นข้อมูลเสมอ ไม่ใช่คำสั่ง

## Confirmed decisions

| ID | ข้อตกลง |
| --- | --- |
| S10-D01 | Owner สั่งเมื่อ 2026-10-28 ให้ใช้แนวคิดทั้ง 10 ข้อ: quiet/failed runs, deterministic-first routing ที่แสดงเหตุผล, แจ้งเตือนครั้งเดียวพร้อมระดับ `all`/`needs-me`, result contract, communication policy, UI token lint, context packet, local API + CLI, signed webhooks และ `.ics` feed |
| S10-D02 | Model หรือ agent จำกัดสิทธิ์ได้อย่างเดียว ขยายไม่ได้; role ใหม่ไม่เกินขอบเขตของผู้สร้าง; มีเพียง owner ที่ขยายสิทธิ์ได้ |
| S10-D03 | ไม่นำ `create_agent` แบบสร้างทันทีและ automatic backup model มาใช้; S09-D03 (role proposal ต้องให้ owner ยอมรับ) และ FR-13 (ไม่สลับ route หรือ billing เงียบๆ) คงเดิม |
| S10-D04 | Full-access, shell, browser-use, computer-use และ MCP อยู่นอก S10 และ owner จะตัดสินใน S11; จนกว่า S11 จะ merge ให้ FR-17 และ NFR-01 คงเดิม |
| S10-D05 | ใช้ openbot เป็นแรงบันดาลใจด้านแนวคิดเท่านั้น ห้ามคัดลอกโค้ด ข้อความ หรือ asset |

## User Stories

43. ในฐานะ owner ฉันไม่อยากได้ข้อความจากงานตามตารางเวลาที่ไม่มีอะไรใหม่ แต่อยากรู้ทันทีเมื่องานล้มเหลวพร้อมเหตุผล
44. ฉันอยากเห็นว่าทำไม Jit เลือก specialist คนนั้น และแก้ได้ถ้าเลือกผิด
45. ฉันอยากได้รับแจ้งครั้งเดียวเมื่องานทั้งชุดจบ และเลือกได้ว่าจะรับทุกเรื่อง หรือเฉพาะเรื่องที่ต้องให้ฉันทำ
46. ฉันอยากได้ผลจาก specialist ในรูปแบบเดียวกันเสมอ และเมื่องานติดให้บอก action เดียวที่ช่วยปลดล็อก
47. ฉันอยากให้การตัดสินใจของฉันอยู่ใน context ของทุกงานที่เกี่ยวข้อง แม้บทสนทนาจะยาวหรือมีการเปลี่ยน provider
48. ฉันอยากสั่งงาน Jit จาก terminal บน Pi และรอคำตอบได้ โดย script ภายนอกเครื่องเข้าถึงไม่ได้
49. ฉันอยากให้ CI หรือ event ของ PR ปลุก Jit ให้ตรวจเร็วขึ้น โดย payload สั่งการอะไร Jit ไม่ได้
50. ฉันอยากเห็นตาราง reminder และ summary ในแอปปฏิทินของฉัน

เลขต่อจาก user stories 1–42 ของ MVP และ S09

## Required behavior

| Case | Observable outcome | Requirements |
| --- | --- | --- |
| S10-AC01 | Summary ที่ไม่มีอะไรใหม่จบเป็น `no_update`: ไม่สร้าง delivery intent, ไม่นับ unread แต่ยังอยู่ในประวัติ run; summary ที่ล้มเหลวแสดงเหตุผลและแจ้งเตือนเสมอ | FR-26, FR-12, FR-15 |
| S10-AC02 | ทุกกรณีที่ตัดสินได้ทันทีเลือก specialist โดยไม่เรียก model; การเลือกแต่ละครั้งแสดงเหตุผลที่ owner แก้ได้ | FR-27, FR-02, FR-21 |
| S10-AC03 | งานที่มีหลาย specialist แจ้งเตือนครั้งเดียวเมื่อไม่มีงานเปิดค้าง; ระดับ `needs-me` ส่งเฉพาะเรื่องที่ต้องรอ owner | FR-28, FR-09, FR-11 |
| S10-AC04 | ผล specialist ต้องมี Status / Result / Evidence และมี Unblock เมื่อติด; ผลที่ผิดรูปแบบแสดงเป็น incomplete ไม่ใช่สำเร็จ | FR-29, FR-03, FR-07 |
| S10-AC05 | Trusted instructions ของ Jit มี communication policy แบบ versioned; คำตอบที่มาจาก specialist ระบุชื่อคนนั้นก่อน | FR-30, FR-19 |
| S10-AC06 | ทุก run ได้ context packet ที่มี owner decisions ปักไว้เสมอ แม้หลัง compaction หรือ reopen | FR-31, FR-04, FR-05 |
| S10-AC07 | `jit ask … --wait` ผ่าน loopback ด้วย token file; ส่งซ้ำด้วย retry key เดิมได้ receipt เดิม; request ที่มี `Origin` หรือ `Host` แปลกปลอมถูกปฏิเสธ | FR-32, FR-15, NFR-07 |
| S10-AC08 | Webhook ที่ลงลายเซ็นถูกต้องทำได้แค่ปลุกให้ poll เร็วขึ้น; ลายเซ็นผิดหรือ event ซ้ำไม่มีผล; payload ไม่ถูกส่งเป็นคำสั่งถึง model | FR-33, FR-08, FR-17 |
| S10-AC09 | `.ics` feed แสดง occurrence ของ schedules ที่ active ล่วงหน้า 30 วัน อ่านอย่างเดียว เปลี่ยน token ได้ และ token ไม่อยู่ใน log | FR-34, NFR-07, NFR-09 |
| S10-AC10 | CI ล้มเมื่อพบค่าสี ขนาด radius หรือ duration ที่ไม่ใช่ token นอกไฟล์ token | NFR-13 |
| S10-AC11 | Model ลดสิทธิ์ได้แต่ขยายไม่ได้; role ที่เสนอไม่เกินขอบเขตของผู้เสนอ | FR-17, FR-20 |

## Proposed engineering choices

- [ADR 0032](../adr/0032-quiet-outcomes-and-attention-levels.md): ผลลัพธ์ quiet/failed, attention levels และการแจ้งเตือนครั้งเดียว
- [ADR 0033](../adr/0033-deterministic-routing-and-result-contract.md): deterministic-first routing, result contract และ communication policy
- [ADR 0034](../adr/0034-context-packet-with-pinned-decisions.md): context packet ที่ปัก owner decisions ไว้ (ต่อยอด ADR 0020)
- [ADR 0035](../adr/0035-owner-integration-surfaces.md): local API, `jit` CLI, signed webhooks และ `.ics` feed

## Testing Decisions

ใช้ seam เดิม: authenticated command/query → persistent state → scripted Schway host → observable state ทดสอบด้วย scripted model, fake clock และ protocol fixtures ไม่ใช้ paid inference

- Local API ทดสอบผ่าน loopback listener จริงด้วย token file ชั่วคราว
- Webhook ทดสอบด้วย HMAC fixtures
- `.ics` ตรวจผลกับ occurrence ที่คำนวณโดย `jobs.configured_schedules/v1` ตัวเดียวกัน

การทดสอบบน Pi จริง เช่นปฏิทินบนมือถือที่อ่าน feed ผ่าน VPN หรือ CI ภายนอกที่ส่ง webhook เป็น opt-in evidence ที่ owner ทำเอง

## Out of Scope

Full-access, shell, browser-use, computer-use, MCP (S11), การสร้าง agent ทันทีโดยไม่ผ่าน owner, automatic backup model, push notification ผ่าน iOS/Android, Slack/Discord, account cloud และการเปิด webhook endpoint สู่ internet สาธารณะ

## Tickets

แตกเป็น vertical slices ตาม [workflow](../agents/workflow.md) รายการ blocker และ ticket ที่ทำพร้อมกันได้อยู่ใน [ticket backlog](../tickets/README.md#s10--reliability-and-owner-integrations)
