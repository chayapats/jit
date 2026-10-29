# Spec S12 — Fluid conversation: answer first, stream, and read the web

Tracker: https://github.com/chayapats/jit/issues/170

Owner: Jit. สถานะ: **draft** ที่รอ owner ยืนยันตาราง "Proposed decisions" ด้านล่าง ยังไม่ได้แตก ticket ยกเว้น D01 ซึ่ง owner สั่งเมื่อ 2026-10-29 ให้แก้ที่ต้นเหตุ และทำแล้วใน [#169](https://github.com/chayapats/jit/issues/169) Parent: [MVP spec](00-mvp.md) ต่อยอดจาก [S09](S09-main-bot-and-chat-first-ui.md), [S10](S10-reliability-and-owner-integrations.md) และ [S11](S11-execution-access-and-tools.md)

แหล่งแนวคิด: [nightly-labs/openbot](https://github.com/nightly-labs/openbot) (PolyForm Noncommercial ใช้ได้เฉพาะแนวคิด ห้ามคัดลอกโค้ดหรือข้อความ) และ [CopilotKit/OpenDuet](https://github.com/CopilotKit/OpenDuet) (MIT) แต่ spec นี้ยืมแค่แนวคิดจากทั้งสองโครงการ

## Problem Statement

Owner ลองใช้ Jit บน Pi เมื่อ 2026-10-29 แล้วรายงานว่า "ใช้งานไม่ไหลลื่นเหมือน Grok bot" อาการที่เจอและสาเหตุที่ตรวจพบมีดังนี้:

1. **คุยไปนิดเดียวก็เรียกทีม** rule `single` ของ ADR 0033 เรียก specialist คนเดียวที่มีอยู่ทุกข้อความ ส่วน `follow_up` เรียกทีมเดิมซ้ำทุกครั้งหลังทีมตอบ ทั้งสองกฎไม่ได้ดูว่าข้อความนั้นต้องใช้ทีมหรือไม่ อีกส่วนหนึ่งมาจาก role ของ drill ที่ค้างอยู่ในเครื่องจริง ทั้งสองเรื่องแก้แล้วใน #169
2. **เข้าอินเทอร์เน็ตไม่ได้** host API ของ Schway ตั้ง `hostedLookup: "disabled-only"` และ Jit ส่ง tool list ว่างให้จิต จิตจึงค้นหรืออ่านเว็บไม่ได้เลย ส่วน execution box ก็ออกได้แค่ package registry
3. **ไม่เห็นคำตอบไหลออกมา** คำตอบของจิตเป็น JSON (`{"reply": ..., "proposals": [...]}`) ข้อความจริงจึง stream ไม่ได้ Schway ส่ง `delta` มาแล้ว แต่ Jit แสดงเป็น progress ชั่วคราวผ่าน SSE ที่ poll ทุก 1 วินาที
4. **ทีมคุยกันจนรก** การ์ดทีม การ์ดข้อเสนอ และแจ้งเตือน แย่งพื้นที่กับบทสนทนา ขณะที่ Grok bot ตอบเป็นเสียงเดียว

## Solution

จิตตอบเองก่อนเสมอ และคำตอบไหลออกมาทันทีเหมือนแชตทั่วไป จิตค้นและอ่านเว็บได้แบบอ่านอย่างเดียว ส่วนงานของทีมทำอยู่เบื้องหลัง จิตบอกสั้นๆ หนึ่งบรรทัดว่าถามใครอยู่ แล้วสรุปผลเป็นคำตอบเดียว

หลักเดิมทุกข้อยังอยู่ครบ: ผลจาก model และเนื้อหาที่ดึงมาให้อำนาจอะไรไม่ได้, external effect ต้องผ่าน approval card และการยอมรับ task ไม่ได้แปลว่าอนุญาตให้เริ่มทำงาน

## Proposed decisions

| ID | ข้อเสนอ | ที่มาของแนวคิด | สถานะ |
| --- | --- | --- | --- |
| S12-D01 | **Answer first:** service เรียก specialist เองได้เฉพาะเมื่อ owner ตั้งใจชัดเจน คือ `@name` หรือตอบกลับความเห็นของ specialist นอกจากนั้นจิตตอบเอง และเสนอ dispatch เฉพาะเมื่อ owner ขอทีม หรือคำถามต้องใช้การวิเคราะห์แยกจริงๆ | openbot orchestrator: "ตอบเองถ้าทำได้ ส่ง delegate เมื่อต้องใช้ tools หรืองานยาวของคนอื่น" | **owner สั่งแล้ว 2026-10-29 ทำใน #169** |
| S12-D02 | **Stream ข้อความจริง:** เปลี่ยนรูปแบบคำตอบให้ข้อความไหลออกมาเป็นข้อความธรรมดาก่อน แล้วตามด้วย block ของ proposals ที่มีโครงสร้าง Web แสดงตัวอักษรตามที่ `delta` ส่งมา (push ผ่าน SSE แทน poll ทุก 1 วินาที) ข้อความที่ยัง stream อยู่เป็นของชั่วคราว จนกว่าจะ commit ผ่าน attempt fence | OpenDuet: relay ที่ไม่ buffer และ stall guard | รอยืนยัน |
| S12-D03 | **Web search แบบอ่านอย่างเดียว เฟส A:** ใช้การค้นที่ provider host ไว้ (xAI Live Search บน Grok และ `web_search` บน Codex) ต้องเพิ่ม host contract ใน Schway เพื่อเปิด hosted lookup ต่อ run ผลค้นถือเป็นข้อมูลที่ไม่น่าเชื่อถือเสมอ แสดงที่มา และไม่ให้อำนาจใดๆ เปิด/ปิดได้ต่อโครงการ | openbot ใช้ `web_search` ของ provider | รอยืนยัน |
| S12-D04 | **Web fetch เฟส B:** tool `read_web_page` ที่อ่านหน้าเว็บผ่าน proxy ที่ Jit คุม ใส่เนื้อหาใน envelope `untrusted_data` จำกัดขนาด และไม่ส่ง cookie หรือ credential ใดๆ | OpenDuet: "Search the web / Read web pages" + `untrusted-content.ts` | รอยืนยัน |
| S12-D05 | **เสียงแชตสั้น:** คำตอบในแชตกระชับเป็นค่าเริ่มต้น งานหลายขั้นตอนให้ตอบ "รับไว้แล้ว" พร้อมการ์ดงาน เนื้อหายาวย้ายไปเป็นหน้าเอกสาร และวัดผลด้วย eval แบบ scripted | OpenDuet: `agents.yaml` และ `evals/voice` | รอยืนยัน |
| S12-D06 | **ทีมทำงานเงียบๆ:** การ์ดทีมพับไว้เป็นค่าเริ่มต้น จิตพิมพ์หนึ่งบรรทัดว่ากำลังถามใคร แล้วตอบสรุปเป็นคำตอบเดียวที่ให้เครดิต specialist แจ้งเฉพาะเรื่องติดขัดและเรื่องที่ต้องอนุมัติ | openbot communication policy | รอยืนยัน |
| S12-D07 | **ระหว่างจิตกำลังตอบ:** ข้อความใหม่ขึ้นสถานะ "รอคิว" ให้เห็น ถ้า Schway รองรับ native steer ภายหลัง ค่อยเปลี่ยนไปส่งต่อเข้า turn ที่กำลังทำงาน | openbot busy mode, OpenDuet composer queue | รอยืนยัน |
| S12-D08 | **Reply chips:** ใต้คำตอบมีปุ่มทางเลือก 2–3 ปุ่ม กดแล้วเท่ากับ owner พิมพ์ข้อความนั้นเอง ห้ามใช้ chips แทน approval | OpenDuet: `suggest_replies` | รอยืนยัน |

## Required behavior

- คำตอบที่ stream อยู่เป็นของชั่วคราว ข้อความจะถูกบันทึกและนำไปใช้เป็นแหล่งข้อมูลได้ก็ต่อเมื่อ commit ผ่าน fence แล้วเท่านั้น (NFR-05)
- ผลค้นเว็บและหน้าเว็บที่อ่านมาเป็นข้อมูล ไม่ใช่คำสั่ง สร้าง role/task/decision ไม่ได้ ขยายสิทธิ์ไม่ได้ และนับเป็นแหล่งที่มาตามกฎ memory ของ ADR 0019
- คำค้นอาจทำให้ context ส่วนตัวรั่วออกไป (OpenDuet ยอมรับข้อนี้เอง) จึงต้องมีสวิตช์ต่อโครงการ และทุกคำค้นต้องแสดงให้ owner เห็นใน "รายละเอียด" ของข้อความ
- ห้ามสลับ route หรือ billing เงียบๆ (FR-13) ถ้า route ไหนค้นเว็บไม่ได้ จิตต้องบอกตรงๆ

## Ticket plan (หลัง owner ยืนยัน)

1. Schway: host contract สำหรับ hosted lookup ต่อ run (D03)
2. Jit: เปลี่ยนรูปแบบคำตอบและ stream ผ่าน SSE แบบ push (D02)
3. Jit: เชื่อม web search แบบอ่านอย่างเดียว (D03) และ fetch (D04)
4. Jit: communication policy ฉบับใหม่ ครอบคลุมเสียงแชต การ์ดทีม และ chips (D05, D06, D08)
5. Jit: แสดงคิวระหว่างจิตกำลังตอบ (D07)

## Out of scope

Telegram transport (ยังไม่มี live transport), ให้ LLM reviewer อนุมัติ action แทน owner (ขัดหลัก authority) และการบันทึก memory โดยไม่ผ่านการยืนยันของ owner
