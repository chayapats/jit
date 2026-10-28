---
status: accepted
scope: Jit design
---

# การรับรอง task ไม่เริ่ม execution และ coding capability เลื่อนไปรุ่นถัดไป

สิ่งที่ agents เสนออยู่ใน proposed จนผู้ใช้รับรอง จึงกลายเป็นข้อผูกพันที่ยอมรับแล้ว การเริ่มแก้ code หรือรันเครื่องมือต้องมีคำสั่งเริ่มแยก และ completion กำหนดตามประเภทงาน ผู้ก่อตั้งเลือกรุ่นแรกสำหรับ groups, memory, task tracking และ read-only PR workflow ก่อนเปิด coding execution

PR review และ reminders ที่ผู้ใช้เปิดไว้เป็น authorized background jobs ไม่ต้องเปลี่ยนข้อเสนอใหม่ให้เป็น accepted user task การมี job ภายในจึงไม่ขยาย authority ของ model

เมื่อเพิ่ม execution ต้องแยก boundary ของโค้ดที่รันออกจากบริการที่ถือ credentials และหลัง interruption ต้องตรวจ evidence ก่อนทำต่อ ทางเลือกให้ accepted tasks เริ่มเองหรือใช้ host shell ตรงลดขั้นตอน แต่ทำให้การคิดแผนผูกกับสิทธิ์ลงมือและ side effects

ผลตามมาคือ MVP ปิด capability นี้แม้ Schway มี bash/edit/write แล้ว และต้องรักษา task/job/run เป็นคนละ state

ที่มา: C04, C14, C17–C18, C21 ใน [decision record](../product/decision-record.md)
