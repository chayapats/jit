---
status: proposed
scope: Jit storage design
---

# เสนอ SQLite สำหรับ app state และคง native Schway sessions แยกกัน

Jit ต้องเปลี่ยน task revisions, command deduplication, job leases และ outbox intent อย่างสอดคล้องบน host เดียว จึงเสนอ SQLite สำหรับ application state พร้อม managed file references ส่วน native conversation คงใช้ Schway session format ภายใต้เจ้าของเดิม

ทางเลือกใช้ Schway JSONL เป็นทั้ง task store ไม่ให้ app transactions ที่ต้องการ และ session files ออกแบบสำหรับ writer เดียว การเพิ่ม external database/queue ตั้งแต่แรกเพิ่ม deployment ภาระบน personal installation โดยยังไม่มี use case ที่พิสูจน์

App transaction กับ Schway session append ไม่ atomic ร่วมกัน จึงต้องมี reconciliation ของ interrupted attempts และไม่กล่าวอ้าง exactly-once external delivery Backup/restore ต้อง consistent กับ session manifests และ deletion/suppression ledger

ก่อน accepted ต้องมี state schema และ crash/duplicate/concurrent-writer/restore tests บน Pi พร้อมเลือก retention/search strategy ที่ผ่าน Thai/English cases การใช้ SQLite ไม่ได้กำหนดให้ทำ event-sourcing framework หรือ embeddings

หลักฐาน: [sessions](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/docs/sessions.md#format-4-and-recovery), [architecture](../product/03-architecture.md), [SQLite backup](https://www.sqlite.org/backup.html)
