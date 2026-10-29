# Spec S13 — Chat attachments

Tracker: https://github.com/chayapats/jit/issues/187 · Schway: https://github.com/chayapats/schway/issues/436

Owner: Jit. สถานะ: **confirmed** owner ยืนยันทุกข้อตามที่แนะนำเมื่อ 2026-10-29 และสั่งให้แตก ticket Parent: [S12](S12-fluid-conversation.md) ใช้หลัก just works และ D13 (ไม่ผูกกับ Pi) ที่มาคือ review แบบอ่านอย่างเดียวของ `origin/main` `cb1a99c` กับ Schway `ac63557` เมื่อ 2026-10-29

## Problem Statement

Grok bot รับรูป, PDF และไฟล์ข้อความในแชตได้ แต่ Jit ยังรับได้แค่ข้อความ ตรวจกับโค้ดแล้วพบดังนี้:

- Composer เป็น form ข้อความอย่างเดียว และ `payload()` จำกัด body ที่ 16 KiB (`JIT_BODY_BYTES`) ไม่รองรับ multipart
- Contract ห้ามไว้ตรงๆ: "no placeholder model/attachment controls" (`docs/contracts/app-conversation-v1.md`)
- `sources.kind` มี CHECK รับแค่ `topic | message | output | external` ต้อง migrate
- Schway: `UserContent = TextContent` และ `HostInput = { text }` ส่วน adapters ส่งได้แค่ `input_text`
- Execution box รับ mount ได้ 2 จุดพอดี (`expectedBoxMounts`) ไฟล์ที่จะให้ box ใช้ต้อง copy เข้าไป จะเพิ่ม mount ไม่ได้
- Backup, export และ delete ยังไม่รู้จักไฟล์บนดิสก์

## Solution

แนบไฟล์ได้แบบ Grok: ลากวาง, วางรูป หรือกดเลือกไฟล์ ไฟล์ทุกไฟล์ถือเป็นข้อมูลที่ไม่น่าเชื่อถือเสมอ ตรวจชนิดจากเนื้อไฟล์จริง ล้างข้อมูลแฝงในกระบวนการแยกที่ไม่มี network และให้อำนาจใดๆ ไม่ได้ จิตอ่านเนื้อหาได้ในทุกระดับสิทธิ์ ส่วน box ได้สำเนาที่ล้างแล้วเมื่อระดับสิทธิ์เป็น workspace ขึ้นไป

## Confirmed decisions

| ID | ข้อเสนอ | สถานะ |
| --- | --- | --- |
| S13-D01 | **Upload:** endpoint แยก `POST /projects/:p/topics/:t/attachments` (session, CSRF และ Origin เหมือนเดิม) stream ลงไฟล์ชั่วคราว คำนวณ sha256 ระหว่าง stream และตัดทันทีเมื่อเกินเพดาน route อื่นคงเพดาน 16 KiB ไว้ ถ้าไม่มี script ให้ composer ส่ง multipart (ข้อความ + ไฟล์) ไปที่ `POST .../attachments?send=1` ซึ่ง stream ไฟล์ผ่านเส้นทาง upload เดียวกันแล้วสร้างข้อความ ห้ามผ่าน `payload()` เพราะรับแค่ urlencoded/JSON ไม่เกิน 16 KiB | **owner ยืนยัน 2026-10-29** |
| S13-D02 | **ชนิดไฟล์ v1:** PNG, JPEG, WebP, PDF และข้อความ UTF-8 (ต้องไม่มี NUL) ต้องตรวจทั้ง magic bytes และนามสกุลให้ตรงกัน ไม่เชื่อ `Content-Type` ปฏิเสธ SVG, HTML, archive, docx/xlsx, ไฟล์รัน และ HEIC พร้อมบอกเหตุผล ชื่อที่แสดงผ่าน NFC และตัดอักขระควบคุม/bidi ออก ยาวไม่เกิน 128 bytes และไม่ใช้เป็น path | **owner ยืนยัน 2026-10-29** |
| S13-D03 | **ที่เก็บ:** `<data>/attachments/<projectId>/<sha[0:2]>/<sha>` สิทธิ์ directory 0700 และไฟล์ 0600 อยู่นอกฐานข้อมูลและ web root dedupe เฉพาะภายในโครงการเดียวกัน มีตาราง `attachments` กับ `attachment_events` (upload, reject, sanitize, ส่งให้ model พร้อม route, copy เข้า box, download, delete) ตารางเหล่านี้ไม่เก็บเนื้อหาไฟล์ | **owner ยืนยัน 2026-10-29** |
| S13-D04 | **ล้างข้อมูลแฝงนอก process:** รันเป็นงานสั้นใน container ที่มี hardening แบบเดียวกับ box และ `--network none` จำกัด ~512 MB, 30 s และทีละงาน<br>• รูป: encode ใหม่เป็น PNG/JPEG ซึ่งลบ EXIF/GPS และกัน polyglot เพดาน ~40 MP และย่อเหลือ ≤2048 px ก่อนส่งให้ model<br>• PDF: ใช้ `pdftotext` จำกัด ~50 หน้า และข้อความ ~2 MB ไม่ render หรือเปิด PDF ในหน้าเว็บ<br>• เครื่องที่ไม่มี container runtime: รับข้อความกับ PNG/JPEG ได้ โดยลบ metadata ใน TypeScript แต่ไม่ได้ encode ใหม่ จึงไม่ผ่านเงื่อนไข preview ของ D05 รูปเหล่านี้ดาวน์โหลดได้อย่างเดียว และ UI บอกเหตุผลว่าทำไมไม่มี preview ส่วน PDF ปิดพร้อมบอกเหตุผล | **owner ยืนยัน 2026-10-29** |
| S13-D05 | **ส่งไฟล์ให้ดูอย่างปลอดภัย:** มี route `preview` กับ `download` ที่ต้องมี session ใส่ `Cache-Control: private, no-store`, `nosniff` และ CORP same-origin preview ให้เฉพาะรูปที่ encode ใหม่แล้ว พร้อม CSP `default-src 'none'; sandbox` ไฟล์อื่นทั้งหมดส่งเป็น `Content-Disposition: attachment` | **owner ยืนยัน 2026-10-29** |
| S13-D06 | **จิตอ่านไฟล์อย่างไร:**<br>• ข้อความ และข้อความที่ดึงจาก PDF ใส่ลงใน context เป็น source ที่ไม่น่าเชื่อถือ (`attachment:<id>@rev`) ห่อแบบ `frameMcpResult` เพดาน ~32 KiB<br>• ส่วนที่เกินอ่านต่อด้วย `read_attachment({ id, offset?, maxBytes? })` ซึ่งอ่านข้อมูลของ Jit เองในขอบเขตโครงการ มี fence และ audit<br>• **ข้อเสนอ:** อนุญาต `read_attachment` ในระดับ Read ด้วย เพราะไม่ได้แตะ host หรือ network ข้อนี้ขัดกับกฎ "Read = ไม่มี tool" ใน `run-tools.ts` จึงต้องบันทึกใน ADR 0040 | **owner ยืนยัน 2026-10-29:** อนุญาตในระดับ Read |
| S13-D07 | **ไฟล์ + web tools (ความเสี่ยงหลัก):** ถ้า run มีเนื้อหาจากไฟล์แนบ คำค้นและ URL ที่จะส่งออกต้องผ่านการตรวจว่าไม่มีข้อความยาวจากไฟล์ (เช่น ≥ 24 ตัวอักษรติดกัน) ถ้าพบ ให้บล็อกแล้วถาม owner ครั้งเดียว ทางเลือกคือปิด web ทั้ง run ทุกครั้งที่มีไฟล์แนบ ซึ่งปลอดภัยกว่าแต่ขัดหลัก just works | **owner ยืนยัน 2026-10-29:** ตรวจคำค้นและ URL แล้วบล็อกเมื่อพบ พร้อมถาม owner ครั้งเดียว |
| S13-D08 | **Backup:** ถ้าขนาดรวมของไฟล์แนบเกินเพดาน backup ให้ backup ล้มเหลวพร้อมบอกเหตุผล ไม่ตัดไฟล์ออกเงียบๆ<br>**Backup:** รวมไฟล์แนบใน backup เป็น artifact ที่จำกัดขนาด export มีแค่ metadata เป็นค่าเริ่มต้น และ restore replay ต้องไม่ดึงไฟล์ที่ลบไปแล้วกลับมา ทางเลือกคือไม่รวมไฟล์ใน backup แล้วบันทึกไว้ใน manifest | **owner ยืนยัน 2026-10-29:** รวมใน backup ส่วน export มีแค่ metadata |
| S13-D09 | **เพดานเริ่มต้น:** 10 MB/ไฟล์, 5 ไฟล์/ข้อความ, 500 MB/โครงการ, ปฏิเสธเมื่อดิสก์เหลือน้อยกว่า 2 GB และล้างไฟล์ staged ที่อายุเกิน 24 ชม. ทุกค่าปรับตามเครื่องได้ (S12-D13) | **owner ยืนยัน 2026-10-29** |
| S13-D10 | **รูปถึง model:** ส่ง `input_image` เฉพาะ PNG/JPEG ที่ encode ใหม่แล้ว (xAI รับแค่ jpg/png) และเฉพาะ route ที่ผ่าน live probe แล้ว รูปจากเครื่องที่ไม่มี container ไม่ส่งให้ model ถ้า route ยังไม่ผ่าน จิตบอกตรงๆ ว่า "route นี้ยังมองรูปไม่ได้" ไม่เดาเนื้อหารูป ต้องรอ Schway เพิ่ม image content (https://github.com/chayapats/schway/issues/436) | **owner ยืนยัน 2026-10-29** |

## ช่องทางส่งข้อมูลออก (ADR 0040)

| ช่องทาง | การจัดการ |
| --- | --- |
| `web_search`, `web_fetch`, URL ของ `browser_open`, ข้อความของ `browser_type`, argument ของ MCP tool | **มี guard:** ถ้าพบข้อความจากไฟล์หรือ context ส่วนตัวยาว ≥24 ตัวอักษรติดกัน บล็อกแล้วถาม owner ครั้งเดียว |
| `bash`/`curl` ใน box ระดับ Full | **ความเสี่ยงที่ยังเหลือ:** box มี network และมีสำเนาไฟล์ (#194) ADR บอกข้อนี้ตรงๆ และ UI มีคำเตือนเมื่อตั้งระดับ Full |
| เนื้อหาที่ถูก encode, ตัดเป็นท่อน หรือถอดความ | **ความเสี่ยงที่ยังเหลือ:** การตรวจแบบตรงตัวอักษรจับไม่ได้ ADR บันทึกไว้ |

## Required behavior

- เนื้อหาไฟล์สร้าง task, role หรือ decision ไม่ได้ และเปลี่ยนระดับสิทธิ์ไม่ได้ มี test ที่ฝังคำสั่งไว้ในไฟล์เพื่อพิสูจน์
- ทุกไฟล์ที่ส่งให้ provider ต้องบันทึก route ไว้ และ UI ต้องบอกว่า "ไฟล์จะถูกส่งให้ผู้ให้บริการ model"
- การลืมหรือลบข้อความ หัวข้อ หรือโครงการ ต้องลบไฟล์ด้วย นับ reference ต่อโครงการ ผ่าน preview → confirm ตาม data lifecycle เดิม
- ไฟล์ที่ถูกลบระหว่าง admission กับการเริ่ม attempt ต้องไม่ถูกใช้ (ทำร่วมกับ #186)
- workspace/full: copy สำเนาที่ล้างแล้วเข้า `/workspace/.jit/attachments/<id>-<safe>` ผ่าน runner โดยไม่เพิ่ม mount

## Changes to existing tickets

- #173 WEB01: เพิ่ม AC ตาม D07 พร้อม test ที่ใช้ marker
- #177 LIFE02: preview แสดงจำนวนและขนาดไฟล์ และหลัง confirm ต้องไม่เหลือไฟล์บนดิสก์
- #186 CTX01: ไฟล์ที่ถูกลบหลัง admission ต้องไม่ถูกใช้
- #176 INST01: สร้าง directory สำหรับไฟล์แนบ ตรวจพื้นที่ดิสก์สำรอง และติดตั้ง image ที่มีเครื่องมือ sanitize

## Tickets

**Feature gate:** `JIT_ATTACHMENTS` ปิดเป็นค่าเริ่มต้น และเปิดได้หลัง ATT04 (#193) กับ ATT06 (#195) merge แล้วเท่านั้น จะได้ไม่มี release ที่เก็บไฟล์ซึ่งลบไม่ได้

ลำดับ: ATT00 → ATT01 → ATT02 ‖ ATT03 → ATT04 (ทำพร้อมหรือหลัง #173) → ATT06 (ทำพร้อม #177) → ATT05 → ATT07 (หลัง Schway release) ประมาณงาน ~15–19 วันทำงาน ถ้าทำ MVP แค่ข้อความ + รูป ไม่รวม PDF ใช้ ~8–10 วัน

| Ticket | ผลลัพธ์ | Blocked by |
| --- | --- | --- |
| [#189](https://github.com/chayapats/jit/issues/189) ATT00 | ADR 0040 + `app.attachments/v1` ยกเลิกข้อห้ามเรื่องไฟล์แนบ | — |
| [#190](https://github.com/chayapats/jit/issues/190) ATT01 | Upload แบบ staged, ตรวจชนิดไฟล์, quota และดิสก์สำรอง | #189 |
| [#191](https://github.com/chayapats/jit/issues/191) ATT02 | Sanitizer นอก process ที่ไม่มี network | #190 |
| [#192](https://github.com/chayapats/jit/issues/192) ATT03 | Composer, transcript และ route สำหรับเปิดดูอย่างปลอดภัย | #190 (preview ต้องรอ #191) |
| [#193](https://github.com/chayapats/jit/issues/193) ATT04 | จิตอ่านไฟล์ได้ (`read_attachment` ทุกระดับ) พร้อม exfiltration guard | #191, #192, #173 |
| [#194](https://github.com/chayapats/jit/issues/194) ATT05 | Copy เข้า box โดยไม่เพิ่ม mount | #193 |
| [#195](https://github.com/chayapats/jit/issues/195) ATT06 | Lifecycle: delete, forget, backup, export, restore | #190, #192 |
| [#196](https://github.com/chayapats/jit/issues/196) ATT07 | รูปถึง model เฉพาะ route ที่ probe ผ่าน | schway#436, #193 |

## Out of scope

SVG/HTML/Office/archive ใน v1, การ render PDF, เสียงหรือวิดีโอ และการแชร์ไฟล์ข้ามโครงการ
