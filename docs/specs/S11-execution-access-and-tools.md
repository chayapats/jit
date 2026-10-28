# Spec S11 — Execution access levels, approval cards and extensible tools

Tracker: https://github.com/chayapats/jit/issues/123

Owner: Jit. Status: owner ยืนยันการตัดสินใจทั้งหมดเมื่อ 2026-10-28 และสั่งให้แตก ticket ภาษาอังกฤษ พร้อมใส่ prefix model tier ไว้หน้าชื่อ spec นี้พร้อมแตก ticket แล้ว Parent: [MVP spec](00-mvp.md) ต่อยอดจาก [S09](S09-main-bot-and-chat-first-ui.md) และ [S10](S10-reliability-and-owner-integrations.md) Requirements: [PRD FR-35–FR-40, NFR-14 และ NFR-01 ที่ปรับขอบเขตเป็น MVP](../product/02-prd.md) Schway contract: [schway#429](https://github.com/chayapats/schway/issues/429)

## Problem Statement

หลัง S09 และ S10 Jit คุย วางแผน และเรียกทีมได้แล้ว แต่ทุก run ยังได้แค่สิทธิ์อ่าน เพราะ MVP ล็อกไว้ว่า "coding/shell execution and GitHub mutations are deferred" (AGENTS.md, NFR-01) Owner อยากให้ Jit กับ specialist ลงมือทำงานได้จริง เช่น รันคำสั่ง แก้โค้ด ติดตั้ง package ใช้ network ต่อ MCP server ใช้ browser และใช้ computer-use

ข้อจำกัดเดิมที่ต้องรักษา:
- Decision record C18 กำหนดว่างาน shell และงานแก้โค้ดต้องมี execution boundary แยกจากบริการ
- Decision record C21 วาง execution ไว้เป็น milestone ถัดไปหลัง MVP
- Schway host ไม่มี sandbox ("supplied tools are trusted executable code, not a sandbox") และยังไม่ export core tools ให้ host เรียกใช้

## Solution

แยกงาน execution ทั้งหมดไปไว้ใน **execution box** คือ rootless Podman container หนึ่งตัวต่อโครงการบน Pi ใน box มีเพียง workspace ของโครงการนั้น ไม่มี credential ของ Jit, SQLite, backup หรือ token ของช่องทางสื่อสารใดๆ

แต่ละโครงการมี **access level** สามระดับ คือ Read, Workspace และ Full มีเพียง owner ที่เพิ่มระดับได้ และต้องทำใน Web เท่านั้น

ใน Full ทำอะไรก็ได้ภายใน box แต่ทุก **external effect** ต้องผ่าน **approval card** ก่อน credential ที่ใช้ทำ action นั้นปล่อยผ่าน **connection** และใช้ได้เฉพาะ action ที่อนุมัติแล้วเท่านั้น

Schway export core tools ผ่าน executor ที่ host เสียบเองได้ (schway#429) ส่วน Jit ดูแล box, runner, approvals, connections และ gateway สำหรับ MCP, browser-use และ computer-use

## Confirmed decisions

Owner ยืนยันทั้งหมดเมื่อ 2026-10-28 ข้อเสนอทางวิศวกรรมอยู่ใน ADR 0036–0039

| ID | ข้อตกลง |
| --- | --- |
| S11-D01 | Execution รันใน execution boundary ที่แยกจากบริการบน Pi (ตาม C18) Box ไม่มี credential ของ Jit, SQLite, backup หรือ token ของช่องทางสื่อสาร |
| S11-D02 | Access level ตั้งต่อโครงการ: **Read** (ค่าเริ่มต้น), **Workspace**, **Full** Specialist ตั้งต่ำกว่าระดับของโครงการได้ ตั้งสูงกว่าไม่ได้ การเพิ่มระดับทำได้เฉพาะ owner ใน Web หลังกดยืนยัน ส่วน Telegram และ model ทำได้แค่ลดระดับ มี badge บอกระดับปัจจุบันตลอด และมี kill switch |
| S11-D03 | ใน Full ทำงานภายใน box ได้อิสระ แต่ external effect ต้องผ่าน approval card ได้แก่ push, PR/comment/merge, deploy, การส่งข้อความในนาม owner, การจ่ายเงิน และการลบของบน remote Credential ปล่อยผ่าน connection เฉพาะ action ที่อนุมัติแล้ว ตั้ง auto-approve ต่อโครงการได้ |
| S11-D04 | แบ่งความรับผิดชอบเรื่อง tool: Schway export core tools ที่ host เสียบ executor ได้ (schway#429) ส่วน Jit ดูแล box, runner, approvals, connections และ gateway สำหรับ MCP, browser-use และ computer-use |
| S11-D05 | ใช้ rootless Podman หนึ่ง box ต่อโครงการ ค่าเริ่มต้น: เปิดพร้อมกันได้ 2 box, box ละ 2 GB และ 2 CPU, หยุดเองเมื่อว่าง 30 นาที, reset ได้เฉพาะเมื่อ owner สั่ง |
| S11-D06 | MCP: agent ติดตั้งได้หลัง owner อนุมัติการ์ดที่แสดง source, version ที่ pin และ command ที่จะรัน Server รันใน box Secret ให้ owner กรอกใน Web เท่านั้น Tool ที่ไม่มี `readOnlyHint` ต้องขออนุมัติทุกครั้ง หรือตั้ง auto-approve ทีละ tool |
| S11-D07 | Browser-use (Chromium พร้อม profile ต่อโครงการ) และ computer-use (Xvfb) รันใน box Owner ดู live view และ takeover ได้ Agent หยุดรอก่อน action ประเภท submit หรือ confirm Remote runner สำหรับ desktop จริงเลื่อนไปทำทีหลัง |
| S11-D08 | Telegram ตอบ approval ทีละ action ได้ โดย approval ผูกกับ revision มีวันหมดอายุ และรับเฉพาะจาก owner chat ที่ bind ไว้ เรื่องต่อไปนี้ทำได้ใน Web เท่านั้น: เพิ่มระดับ, อนุมัติการติดตั้ง MCP, กรอก secret, takeover และตั้ง auto-approve |
| S11-D09 | ลำดับการส่งมอบ: SCH → box → Full + approvals → {MCP, browser} → computer-use เริ่มทำคู่กับ S10 ได้ Full จะเปิดใช้กับโครงการจริงได้ก็ต่อเมื่อมี Pi resource evidence แบบ opt-in แล้ว |

## Baseline changes

S11 เปลี่ยน baseline เดิมดังนี้ และได้ปรับเอกสารต้นทางให้ตรงกันแล้ว

| เดิม | ตาม S11 |
| --- | --- |
| AGENTS.md: "Coding/shell execution and GitHub mutations are deferred." | ถูกควบคุมด้วย access level ของโครงการและ approval card (FR-35, FR-37) |
| NFR-01: ไม่มี repository mutation หรือ agent shell | จำกัดขอบเขตไว้ที่ MVP หลัง S11 การ mutation ทำได้ตาม access level และ approval card ใน execution box (NFR-14) |
| Decision record C18 (Q33 B): execution boundary แยกจากบริการ | นำไปทำแล้วเป็น execution box (ADR 0036) |
| Decision record C21 (Q38 B): execution เป็น milestone ถัดไป | S11 คือ milestone นั้น |
| Schway host: `tools.definitions` ที่ host ส่งเข้ามาเองเท่านั้น และไม่มี core tools | `schway.host.core-tools/v1` (schway#429) export core tools พร้อม `ExecutionBackend` ให้ host เสียบเอง |
| C16: PR review ไม่โพสต์หรือแก้ PR | PR review อัตโนมัติยังคงเดิม ส่วน PR mutation ที่ owner อนุมัติทีละ action ทำได้ใน Full ผ่าน approval card |

## User Stories

51. ในฐานะ owner ฉันอยากให้ Jit รันคำสั่งและแก้ไฟล์ในโครงการได้ โดยไม่เสี่ยงว่าจะอ่านหรือทำลาย credential และฐานข้อมูลของ Jit
52. ฉันอยากตั้งระดับสิทธิ์ของแต่ละโครงการ และเห็นตลอดว่าตอนนี้อยู่ระดับไหน
53. ฉันอยากหยุดทุกอย่างในโครงการได้ทันทีด้วยปุ่มเดียว
54. ฉันอยากอนุมัติ push, PR หรือ deploy ทีละครั้ง จากมือถือก็ได้ และให้ credential ถูกใช้เฉพาะตอนที่ฉันอนุมัติ
55. ฉันอยากให้ agent ติดตั้ง MCP server ได้เมื่อฉันอนุมัติ และ tool ที่เขียนข้อมูลได้ต้องผ่านฉันก่อน
56. ฉันอยากให้ agent ใช้ browser และ desktop เสมือนได้ โดยฉันดูหน้าจอได้ เข้าควบคุมเองได้ และ agent หยุดถามก่อนกดส่งหรือยืนยัน

เลขต่อจาก user stories 1–50 ของ MVP, S09 และ S10

## Required behavior

| Case | Observable outcome | Requirements |
| --- | --- | --- |
| S11-AC01 | Run ใน Read ไม่ได้ execution tool เลย Run ใน Workspace ได้ core tools ใน box โดย network ออกได้เฉพาะ package registry ที่ owner อนุญาต Run ใน Full ได้ network | FR-35, FR-36 |
| S11-AC02 | Box ไม่มี path ของ state directory, backup, secret file หรือ environment ของ Jit service ถ้า process ใน box พยายามอ่าน path เหล่านั้นจะล้มเหลว | FR-36, NFR-14 |
| S11-AC03 | การเพิ่มระดับมาจาก owner command ใน Web ที่ยืนยัน revision แล้วเท่านั้น คำสั่งจาก Telegram, model หรือ API ที่พยายามเพิ่มระดับถูกปฏิเสธ ส่วนการลดระดับทำได้จากทุกช่องทางที่ authorized | FR-35, FR-17 |
| S11-AC04 | Kill switch ยกเลิก run และ attempt ที่ทำงานอยู่ทั้งหมดของโครงการ หยุด box และป้องกันการ admit งานใหม่จนกว่า owner จะ resume ผลที่มาช้าถูก fence ทิ้ง | FR-35, FR-15 |
| S11-AC05 | External effect ทุกครั้งต้องมี approval card ที่ผูกกับ revision ใช้ได้ครั้งเดียว และมีวันหมดอายุ อนุมัติแล้ว effect เกิดหนึ่งครั้งพร้อม receipt การ์ดที่ stale, ถูกใช้แล้ว หรือหมดอายุ ไม่ทำอะไร | FR-37, FR-15 |
| S11-AC06 | Credential ของ connection ไม่ปรากฏใน prompt, log, export, box filesystem หรือ tool result | FR-38, NFR-07 |
| S11-AC07 | การติดตั้ง MCP ต้องผ่านการ์ดใน Web ที่แสดง source, version ที่ pin และ command Tool ที่ไม่มี `readOnlyHint` ต้องขออนุมัติ เว้นแต่ owner ตั้ง auto-approve ให้ tool นั้น | FR-39 |
| S11-AC08 | Browser และ desktop รันใน box action ประเภท submit หรือ confirm หยุดรอการ์ด ระหว่าง owner takeover agent ส่ง input ไม่ได้ | FR-40 |
| S11-AC09 | Telegram อนุมัติได้เฉพาะ approval card ทีละ action จาก owner chat ที่ bind ไว้ คำสั่งที่ทำได้เฉพาะใน Web ถูกปฏิเสธเมื่อมาจาก Telegram | FR-37, FR-11 |
| S11-AC10 | Full ตั้งไม่ได้จนกว่า operator config จะบันทึกว่ามี Pi resource evidence แล้ว | FR-35, NFR-06 |

## Proposed engineering choices

- [ADR 0036](../adr/0036-execution-box-and-runner.md): execution box ที่ใช้ rootless Podman, runner protocol, `ExecutionBackend` adapter, network mode ต่อระดับ และ lifecycle
- [ADR 0037](../adr/0037-access-levels-approvals-and-connections.md): access levels, กฎ restrict-only, kill switch, approval cards, effect tools และ connections
- [ADR 0038](../adr/0038-mcp-gateway.md): MCP install proposals, gateway และการจัดประเภท effect
- [ADR 0039](../adr/0039-browser-and-computer-use.md): Chromium และ Xvfb ใน box, การหยุดก่อน submit และ takeover

## Testing Decisions

ทุก deterministic test ใช้ **fake box runtime** ที่ implement interface เดียวกับ Podman adapter แต่ไม่เรียก Podman จริง และใช้ scripted model กับ fake clock ตามเดิม

การทดสอบ Podman จริงบนเครื่อง dev และการวัดทรัพยากรบน Pi เป็น evidence แบบ opt-in ใน ticket EXE06 ไม่ใช่ release test

Injection fixtures ต้องพิสูจน์ว่า model, ข้อความจาก source, ผลของ MCP tool และเนื้อหาหน้าเว็บ ไม่สามารถเพิ่มระดับ, อนุมัติการ์ด, เปิด auto-approve หรืออ่าน credential ได้

## Out of scope

- Remote runner ที่ควบคุม desktop จริงของ owner
- การ sandbox ภายใน Schway
- Public webhook ที่รับเข้าจากอินเทอร์เน็ต
- ระบบจ่ายเงินจริง: S11 กำหนดแค่ว่าการจ่ายเงินเป็น external effect ที่ต้องมีการ์ด ยังไม่มี connector สำหรับจ่ายเงิน
- Multi-user

## Tickets

แตกเป็น vertical slices ตาม [workflow](../agents/workflow.md) ทุก ticket ใช้ prefix model tier ดูรายการและ blocker ได้ที่ [ticket backlog](../tickets/README.md#s11--execution-access-levels-approval-cards-and-extensible-tools)
