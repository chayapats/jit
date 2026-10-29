# Spec S12 — Fluid conversation that just works: answer first, stream, read the web

Tracker: https://github.com/chayapats/jit/issues/170

Owner: Jit. สถานะ: **confirmed** owner ยืนยันทุกข้อ (D01–D13) เมื่อ 2026-10-29 และสั่งให้แตก ticket D01 ทำแล้วใน [#169](https://github.com/chayapats/jit/issues/169) ส่วน ticket ที่เหลืออยู่ใน issue [#170](https://github.com/chayapats/jit/issues/170) Parent: [MVP spec](00-mvp.md) ต่อยอดจาก [S09](S09-main-bot-and-chat-first-ui.md), [S10](S10-reliability-and-owner-integrations.md) และ [S11](S11-execution-access-and-tools.md)

แหล่งแนวคิด: [nightly-labs/openbot](https://github.com/nightly-labs/openbot) (PolyForm Noncommercial ใช้ได้เฉพาะแนวคิด ห้ามคัดลอกโค้ดหรือข้อความ) และ [CopilotKit/OpenDuet](https://github.com/CopilotKit/OpenDuet) (MIT) แต่ spec นี้ยืมแค่แนวคิดจากทั้งสองโครงการ

## Problem Statement

Owner ลองใช้ Jit บน Pi เมื่อ 2026-10-29 แล้วรายงานว่า "ใช้งานไม่ไหลลื่นเหมือน Grok bot" อาการที่เจอและสาเหตุที่ตรวจพบมีดังนี้:

1. **คุยไปนิดเดียวก็เรียกทีม** rule `single` ของ ADR 0033 เรียก specialist คนเดียวที่มีอยู่ทุกข้อความ ส่วน `follow_up` เรียกทีมเดิมซ้ำทุกครั้งหลังทีมตอบ ทั้งสองกฎไม่ได้ดูว่าข้อความนั้นต้องใช้ทีมหรือไม่ อีกส่วนหนึ่งมาจาก role ของ drill ที่ค้างอยู่ในเครื่องจริง ทั้งสองเรื่องแก้แล้วใน #169
2. **เข้าอินเทอร์เน็ตไม่ได้** host API ของ Schway ตั้ง `hostedLookup: "disabled-only"` และ Jit ส่ง tool list ว่างให้จิต จิตจึงค้นหรืออ่านเว็บไม่ได้เลย ส่วน execution box ก็ออกได้แค่ package registry
3. **ไม่เห็นคำตอบไหลออกมา** คำตอบของจิตเป็น JSON (`{"reply": ..., "proposals": [...]}`) ข้อความจริงจึง stream ไม่ได้ Schway ส่ง `delta` มาแล้ว แต่ Jit แสดงเป็น progress ชั่วคราวผ่าน SSE ที่ poll ทุก 1 วินาที
4. **ทีมคุยกันจนรก** การ์ดทีม การ์ดข้อเสนอ และแจ้งเตือน แย่งพื้นที่กับบทสนทนา ขณะที่ Grok bot ตอบเป็นเสียงเดียว
5. **ติดตั้งแล้วยังใช้ไม่ได้ทันที เหมือนต้องทำงาน dev อีกงาน** การติดตั้งบน Pi ทำตาม runbook ทีละขั้นด้วยมือ (สร้าง user, Podman, Bun, unit, keyring) การ login Codex/Grok ต้อง SSH เข้าไปรัน `/login` ผ่าน tmux ในฐานะ service identity เพราะ host API ของ Schway ไม่มี login flow และในแอปไม่มีคำสั่งลบหรือเปลี่ยนชื่อโครงการ ลบ role ก็ไม่ได้ ข้อมูล drill ที่ค้างอยู่จึงลบออกจาก UI ไม่ได้

## Solution

**หลักแรกคือติดตั้งแล้วใช้ได้เลย (just works):** คนที่ลองติดตั้งต้องคุยกับจิตได้ภายในไม่กี่นาที โดยไม่ต้องแก้ config, ไม่ต้องพิมพ์ค่าที่ระบบเดาเองได้, ไม่ต้องหา API key และไม่ต้องเปิด terminal หลังติดตั้งเสร็จ ฟีเจอร์ที่ต้องตั้งค่าเพิ่มต้องมีค่าเริ่มต้นที่ใช้ได้ทันที และตั้งค่าเพิ่มได้ใน Web ภายในคลิกเดียว

จิตตอบเองก่อนเสมอ และคำตอบไหลออกมาทันทีเหมือนแชตทั่วไป จิตค้นและอ่านเว็บได้แบบอ่านอย่างเดียว ส่วนงานของทีมทำอยู่เบื้องหลัง จิตบอกสั้นๆ หนึ่งบรรทัดว่าถามใครอยู่ แล้วสรุปผลเป็นคำตอบเดียว

หลักเดิมทุกข้อยังอยู่ครบ: ผลจาก model และเนื้อหาที่ดึงมาให้อำนาจอะไรไม่ได้, external effect ต้องผ่าน approval card และการยอมรับ task ไม่ได้แปลว่าอนุญาตให้เริ่มทำงาน

## Confirmed decisions

| ID | ข้อเสนอ | ที่มาของแนวคิด | สถานะ |
| --- | --- | --- | --- |
| S12-D01 | **Answer first:** service เรียก specialist เองได้เฉพาะเมื่อ owner ตั้งใจชัดเจน คือ `@name` หรือตอบกลับความเห็นของ specialist นอกจากนั้นจิตตอบเอง และเสนอ dispatch เฉพาะเมื่อ owner ขอทีม หรือคำถามต้องใช้การวิเคราะห์แยกจริงๆ | openbot orchestrator: "ตอบเองถ้าทำได้ ส่ง delegate เมื่อต้องใช้ tools หรืองานยาวของคนอื่น" | **owner สั่งแล้ว 2026-10-29 ทำใน #169** |
| S12-D02 | **Stream ข้อความจริง:** เปลี่ยนรูปแบบคำตอบให้ข้อความไหลออกมาเป็นข้อความธรรมดาก่อน แล้วตามด้วย block ของ proposals ที่มีโครงสร้าง Web แสดงตัวอักษรตามที่ `delta` ส่งมา (push ผ่าน SSE แทน poll ทุก 1 วินาที) ข้อความที่ยัง stream อยู่เป็นของชั่วคราว จนกว่าจะ commit ผ่าน attempt fence | OpenDuet: relay ที่ไม่ buffer และ stall guard | **owner ยืนยัน 2026-10-29** |
| S12-D03 | **Web tools แบบ function tool ผ่าน contract กลางของ Schway:**<br>• Schway export ทาง `schway/host`: (1) interface `SearchProvider` ที่ไม่ผูกกับ vendor และ (2) `createWebFetchTool({ urlGuard })` ที่ใช้ `web_fetch` ตัวเดิม<br>• Schway ไม่ถือ key เอง: Jit ดึง key จาก connections vault แล้วส่งเข้าไปตอนสร้าง provider<br>• Hosted lookup ยังเป็น `"off"` เหมือนเดิม Jit ใส่ tools ผ่าน `tools.definitions` เพื่อให้การเปิด/ปิด, audit และการแสดงคำค้นอยู่ฝั่ง Jit<br>• Engine อื่นที่ใช้ Schway ก็ใช้ tools นี้ได้ | second opinion 2026-10-29 และ OpenDuet "Search the web / Read web pages" | **owner ยืนยัน 2026-10-29** |
| S12-D04 | **SSRF guard เป็นค่าเริ่มต้นของ `web_fetch`:**<br>• ตอนนี้ `checkUrl` ของ Schway ตรวจแค่ scheme กับ userinfo จึงอ่าน `127.0.0.1`, LAN และ `169.254.169.254` ได้<br>• guard ต้องตรวจ IP ที่ resolve ได้ตอนเชื่อมต่อจริง ทุก redirect และทุกรูปแบบ (loopback, private, link-local, CGNAT, ULA, IPv4-mapped IPv6, metadata) เพื่อกัน DNS rebinding<br>• `urlGuard` ของแอปทำได้แค่เพิ่มข้อจำกัด ลดไม่ได้<br>• ไม่ส่ง cookie หรือ credential และเนื้อหาที่ได้มาอยู่ใน envelope `untrusted_data` เสมอ | second opinion และ OpenDuet `untrusted-content.ts` | **owner ยืนยัน 2026-10-29** |
| S12-D05 | **เสียงแชตสั้น:** คำตอบในแชตกระชับเป็นค่าเริ่มต้น งานหลายขั้นตอนให้ตอบ "รับไว้แล้ว" พร้อมการ์ดงาน เนื้อหายาวย้ายไปเป็นหน้าเอกสาร และวัดผลด้วย eval แบบ scripted | OpenDuet: `agents.yaml` และ `evals/voice` | **owner ยืนยัน 2026-10-29** |
| S12-D06 | **ทีมทำงานเงียบๆ:** การ์ดทีมพับไว้เป็นค่าเริ่มต้น จิตพิมพ์หนึ่งบรรทัดว่ากำลังถามใคร แล้วตอบสรุปเป็นคำตอบเดียวที่ให้เครดิต specialist แจ้งเฉพาะเรื่องติดขัดและเรื่องที่ต้องอนุมัติ โดย owner ยืนยันเพิ่มเติม 2026-10-29 ว่ารายงาน schedule และ PR finding alerts ที่ owner ตั้งไว้ยังแจ้งภายใต้ `needs-me` ทั้งค่าที่บันทึกและค่าเริ่มต้น | openbot communication policy | **owner ยืนยัน 2026-10-29** |
| S12-D07 | **ระหว่างจิตกำลังตอบ:** ข้อความใหม่ขึ้นสถานะ "รอคิว" ให้เห็น ถ้า Schway รองรับ native steer ภายหลัง ค่อยเปลี่ยนไปส่งต่อเข้า turn ที่กำลังทำงาน | openbot busy mode, OpenDuet composer queue | **owner ยืนยัน 2026-10-29** |
| S12-D08 | **Reply chips:** ใต้คำตอบมีปุ่มทางเลือก 2–3 ปุ่ม กดแล้วเท่ากับ owner พิมพ์ข้อความนั้นเอง ห้ามใช้ chips แทน approval | OpenDuet: `suggest_replies` | **owner ยืนยัน 2026-10-29** |
| S12-D09 | **ค้นเว็บได้ทันทีโดยไม่ต้องหา key:**<br>• ค่าเริ่มต้นคือ SearXNG ที่ Jit ติดตั้งและดูแลเองเป็น rootless container บนเครื่อง (ใช้ Podman ตัวเดียวกับ execution box) ไม่ต้องมี API key และไม่ต้องสมัครบริการใด แต่คำค้นยังถูกส่งต่อไปยัง search engine ภายนอกที่ SearXNG ใช้ จาก IP ของเครื่องนี้ เพียงแต่ไม่ผูกกับบัญชีหรือ key ใดๆ หน้าตั้งค่าต้องบอกข้อนี้ตรงๆ<br>• Tavily หรือ Exa เลือกได้ใน ตั้งค่า › การค้นเว็บ โดยใส่ key ครั้งเดียว<br>• ถ้าเครื่องไม่มี Podman จิตบอกตรงๆ ว่ายังค้นเว็บไม่ได้ พร้อมปุ่มทางแก้ | หลัก just works | **owner ยืนยัน 2026-10-29** |
| S12-D10 | **Login Codex/Grok จากหน้า Web:**<br>• ขั้น "เชื่อมจิต" แสดง device code กับลิงก์ให้กดยืนยัน แทนการ SSH ไปรัน `/login`<br>• ต้องมี host contract ใน Schway สำหรับ device-code login ที่เขียน credential ลง Secret Service ของ service identity<br>• Credential ไม่ผ่าน Jit, ไม่อยู่ในฐานข้อมูล และไม่อยู่ใน log | หลัก just works | **owner ยืนยัน 2026-10-29** |
| S12-D11 | **ติดตั้งด้วยคำสั่งเดียว:**<br>• `install.sh` ที่ตรวจเครื่อง แล้วเตรียม Bun, service user, Podman, keyring unlock และ systemd unit ตาม runbook OPS07<br>• แสดงแผนก่อนแก้เครื่องทุกครั้ง และหยุดพร้อมบอกทางแก้เมื่อขั้นไหนไม่ผ่าน<br>• จบแล้วพิมพ์ URL ของหน้าเว็บให้เปิด ขั้นต่อไปทั้งหมดทำใน Web | หลัก just works | **owner ยืนยัน 2026-10-29** |
| S12-D12 | **จัดการของในแอปได้ครบ:**<br>• ลบหรือเปลี่ยนชื่อโครงการ และลบ role ได้จาก Web<br>• การลบผ่าน preview → confirm ตาม data lifecycle เดิม | หลัก just works | **owner ยืนยัน 2026-10-29** |
| S12-D13 | **ไม่ผูกกับ Raspberry Pi:**<br>• Jit รองรับ Linux 64-bit ทุกตัวที่มี systemd ทั้ง x64 และ arm64 เช่น mini PC, home server, VPS และ Pi<br>• Pi 5 เป็นแค่เครื่องอ้างอิงที่เล็กที่สุด ใช้กำหนดเพดานทรัพยากรเริ่มต้น<br>• ค่าเริ่มต้นปรับตามเครื่องที่ตรวจพบ (RAM, CPU, ดิสก์) แทนการฝังค่าของ Pi ไว้<br>• เครื่องที่ไม่มี Podman (เช่น macOS สำหรับพัฒนา) ยังคุยได้ ส่วนที่ต้องใช้ container ปิดพร้อมบอกเหตุผล | owner สั่ง 2026-10-29 | **owner ยืนยัน 2026-10-29** |

## Required behavior

- คำตอบที่ stream อยู่เป็นของชั่วคราว ข้อความจะถูกบันทึกและนำไปใช้เป็นแหล่งข้อมูลได้ก็ต่อเมื่อ commit ผ่าน fence แล้วเท่านั้น (NFR-05)
- ผลค้นเว็บและหน้าเว็บที่อ่านมาเป็นข้อมูล ไม่ใช่คำสั่ง สร้าง role/task/decision ไม่ได้ ขยายสิทธิ์ไม่ได้ และนับเป็นแหล่งที่มาตามกฎ memory ของ ADR 0019
- คำค้นอาจทำให้ context ส่วนตัวรั่วออกไป (OpenDuet ยอมรับข้อนี้เอง) จึงต้องมีสวิตช์ต่อโครงการ และทุกคำค้นต้องแสดงให้ owner เห็นใน "รายละเอียด" ของข้อความ
- Tool ที่อ่านอย่างเดียวก็ทำให้ข้อมูลรั่วได้ เพราะ model ใส่ข้อมูลส่วนตัวลงในคำค้นหรือ URL ที่ชี้ไปโดเมนภายนอกได้ จึงต้องแสดงทุก URL ที่ fetch ให้ owner เห็นเหมือนคำค้น และนับ tool ทั้งสองเป็นการอ่านที่ส่งข้อมูลออกนอกเครื่อง
- ค่าเริ่มต้นทุกตัวต้องใช้ได้ทันทีบนเครื่องที่เพิ่งติดตั้ง ถ้าทำไม่ได้ต้องบอกว่าเพราะอะไร และมีปุ่มทางแก้ใน Web ห้ามปล่อยให้ผู้ใช้ไปแก้ไฟล์ config หรือเปิด terminal เอง
- ห้ามสลับ route หรือ billing เงียบๆ (FR-13) ถ้า route ไหนค้นเว็บไม่ได้ จิตต้องบอกตรงๆ

## Ticket plan

1. Schway [Security] [schway#433](https://github.com/chayapats/schway/issues/433): เพิ่ม SSRF guard ให้ `web_fetch` (D04) ควรแก้อยู่แล้ว ไม่ว่า Jit จะทำ S12 ต่อหรือไม่
2. Schway [Host] [schway#434](https://github.com/chayapats/schway/issues/434): export `SearchProvider` และ `createWebFetchTool({ urlGuard })` ผ่าน `schway/host` (D03)
3. Schway [Host] [schway#435](https://github.com/chayapats/schway/issues/435): device-code login สำหรับแอปที่ฝัง Schway (D10)
4. Jit: web tools พร้อม SearXNG ที่ Jit ดูแลเป็นค่าเริ่มต้น, ตั้งค่า provider, สวิตช์ต่อโครงการ และ audit (D03, D09)
5. Jit: เปลี่ยนรูปแบบคำตอบและ stream ผ่าน SSE แบบ push (D02)
6. Jit: login จาก Web ในขั้นเชื่อมจิต (D10)
7. Jit: `install.sh` คำสั่งเดียว (D11)
8. Jit: ลบหรือเปลี่ยนชื่อโครงการ และลบ role (D12)
9. Jit: communication policy ฉบับใหม่ ครอบคลุมเสียงแชต การ์ดทีม chips และคิว (D05–D08)

## Tickets

| Ticket | Tier | ผลลัพธ์ | Decision | Blocked by |
| --- | --- | --- | --- | --- |
| [#169](https://github.com/chayapats/jit/issues/169) | Frontier | Answer first (ทำแล้ว) | D01 | — |
| [#173](https://github.com/chayapats/jit/issues/173) WEB01 | Frontier | จิตค้นและอ่านเว็บได้ทันที ผ่าน `web_search`/`web_fetch` แบบอ่านอย่างเดียว | D03, D04 | schway#433, schway#434 |
| [#178](https://github.com/chayapats/jit/issues/178) WEB02 | Frontier | SearXNG ที่ Jit ดูแลเองเป็นค่าเริ่มต้น | D09 | #173 |
| [#184](https://github.com/chayapats/jit/issues/184) WEB03 | Standard | ตั้งค่า › การค้นเว็บ: เลือก provider และใส่ key ครั้งเดียว | D09 | #173, #178 |
| [#174](https://github.com/chayapats/jit/issues/174) STR01 | Frontier | Stream คำตอบทีละ token | D02 | — |
| [#175](https://github.com/chayapats/jit/issues/175) SIGN01 | Frontier | Login Codex/Grok จาก Web | D10 | schway#435 |
| [#176](https://github.com/chayapats/jit/issues/176) INST01 | Frontier | ติดตั้งคำสั่งเดียว จบด้วยลิงก์ตั้งค่า | D11 | — |
| [#177](https://github.com/chayapats/jit/issues/177) LIFE02 | Frontier | ลบโครงการแบบ preview → confirm | D12 | — |
| [#181](https://github.com/chayapats/jit/issues/181) LIFE01 | Standard | เปลี่ยนชื่อโครงการ | D12 | — |
| [#182](https://github.com/chayapats/jit/issues/182) LIFE03 | Standard | ลบ (archive) role | D12 | — |
| [#179](https://github.com/chayapats/jit/issues/179) COMM01 | Standard | เสียงแชตสั้น งานยาวกลายเป็นการ์ด | D05 | — |
| [#180](https://github.com/chayapats/jit/issues/180) COMM02 | Standard | ทีมทำงานเงียบๆ การ์ดพับไว้ แจ้งเตือนเฉพาะเรื่องที่ต้องให้ owner ทำ | D06 | — |
| [#183](https://github.com/chayapats/jit/issues/183) COMM03 | Standard | ข้อความระหว่างจิตกำลังตอบขึ้น "รอคิว" แล้วตอบตามลำดับ | D07 | — |
| [#186](https://github.com/chayapats/jit/issues/186) CTX01 | Frontier | คำตอบที่รอคิวเห็นคำตอบก่อนหน้า (context assemble ตอนเริ่ม attempt) | D07 | #183 |
| [#185](https://github.com/chayapats/jit/issues/185) COMM04 | Standard | Reply chips 2–3 ปุ่ม | D08 | — |

## Out of scope

Telegram transport (ยังไม่มี live transport), ให้ LLM reviewer อนุมัติ action แทน owner (ขัดหลัก authority) และการบันทึก memory โดยไม่ผ่านการยืนยันของ owner
