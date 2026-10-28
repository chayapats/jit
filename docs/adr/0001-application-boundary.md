---
status: accepted
scope: Jit design
---

# Jit เป็น application แยก โดยใช้ Schway เป็น execution engine

ผู้ก่อตั้งเลือกให้ Jit ดูแล project groups, specialists, memory, durable jobs และ channels ส่วน Schway เป็นเจ้าของ agent loop, models, tools, native sessions/context และ retries Jit จะอยู่ repository และ release แยกจาก Schway เพื่อให้ product experience พัฒนาได้โดยไม่ขยาย coding harness ให้ถือภาระทั้งหมด

ทางเลือกคือย้าย persistent-agent product framework เข้า Schway หรือวาง Jit application ใน repository เดิม ทั้งสองทำให้แก้โค้ดร่วมกันสะดวกกว่า แต่เพิ่ม coupling ของ scope และ release การตัดสินใจนี้ยอมรับภาระดูแล public integration contract และ compatibility tests แทนการพึ่ง private source imports

การมี function ใน source ไม่เท่ากับเป็น API ที่รองรับ ปัจจุบัน public entry มีเฉพาะ schway/extensions; ช่องว่าง host API เป็นข้อเสนอแยกใน Schway S02 ไม่รวมอยู่ในสถานะ accepted ของฉบับนี้

ที่มา: C19–C20 ใน [decision record](../product/decision-record.md); ดู [stability policy](https://github.com/chayapats/schway/blob/eb41354cc35a6e191c0e89747e150c2aff2a896f/docs/stability.md)
