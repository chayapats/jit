---
status: accepted
scope: Jit design
---

# PR review อัตโนมัติอ่านอย่างเดียวและแจ้ง owner เป็นการส่วนตัว

ผู้ก่อตั้งให้ Jit อ่าน PR แล้วแจ้งปัญหาที่มีหลักฐาน โดยยังไม่โพสต์ review/comment หรือแก้ PR และไม่รัน tests/build/install จาก PR การตัดสินใจนี้จำกัดผลกระทบของ background automation พร้อมให้ owner ประเมินคุณภาพ findings ก่อนเพิ่ม authority

ผล review ต้องผูก repository/PR/base/head revision แสดง source coverage และแยก actionable finding, uncertainty, partial, stale และ not reviewed การจบ model response ไม่ใช่หลักฐานว่า review ครบหรือข้อค้นพบถูกจริง

ทางเลือกรันโค้ดเพื่อหาหลักฐานช่วยตรวจปัญหาบางประเภทได้ แต่เปิด execution จาก contribution ที่อาจไม่น่าเชื่อถือ ส่วนการโพสต์ผลอัตโนมัติมีผลต่อผู้อื่น ผลตามมาคือ first release ทำ static analysis พร้อม CI evidence ที่อ่านได้ และรายงานข้อจำกัดโดยไม่กล่าวอ้างว่าได้ทดลองเอง

ที่มา: C16 ใน [decision record](../product/decision-record.md); FR-08–FR-09
