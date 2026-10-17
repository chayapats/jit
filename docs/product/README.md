# Jit — ชุดเอกสารหลังปิด discovery

สถานะ: ผู้ก่อตั้งยืนยันให้ปิด discovery และจัดทำ specification แล้ว ชุดนี้ย้ายมาเป็น product baseline ใน Jit repository แล้ว ยังไม่มี implementation ของ Jit หรือการเปลี่ยน public API ของ Schway

## วิธีอ่านและใช้ต่อ

1. อ่าน [Product vision](01-product-vision.md) และ [MVP](06-mvp.md) เพื่อทราบว่ารุ่นแรกต้องพิสูจน์อะไร
2. ใช้ [PRD](02-prd.md) เป็นสัญญาพฤติกรรม โดยอ้าง requirement ID เมื่อลงรายละเอียด feature spec
3. ใช้ [Architecture proposal](03-architecture.md) และ [Security & trust](05-security-and-trust.md) กำหนดขอบเขต implementation
4. ตรวจ [ADRs](04-architecture-decisions.md), [decision record](decision-record.md) และ [หลักฐาน](sources.md) ก่อนเปลี่ยนการตัดสินใจ
5. ใช้ [Roadmap](07-roadmap.md) และ [Validation & open questions](08-validation-and-open-questions.md) แตกงานและตรวจ feasibility

## สถานะของข้อความ

- **Confirmed** คือทิศทางที่ผู้ก่อตั้งเลือกจาก discovery; การยืนยันสร้างเอกสารไม่ได้ทำให้รายละเอียดทางเทคนิคทุกข้อกลายเป็น confirmed
- **Required** คือพฤติกรรมและข้อจำกัดที่ PRD กำหนดเพื่อให้ทิศทางนั้นทดสอบได้
- **Proposed** คือแนวทางวิศวกรรมที่เสนอ เช่น SQLite, host API shape และ service deployment ต้องผ่านการตรวจที่ระบุไว้ก่อนถือเป็น implementation contract
- **Open** คือประเด็นที่ยังไม่ตัดสินใจหรือยังไม่มีหลักฐาน ห้ามเติมคำตอบแล้วอ้างว่าเป็นความต้องการที่ผู้ก่อตั้งยืนยัน
- **Deferred** คืออยู่นอกรุ่นแรก แม้จะมีการตกลงหลักการสำหรับอนาคตแล้ว

รายละเอียดที่ขัดกันให้ใช้ decision record ตรวจเจตนา ใช้ PRD ตรวจพฤติกรรม และเปิดบันทึกการเปลี่ยนแปลงเมื่อแก้ requirement; architecture proposal ไม่สามารถขยายอำนาจหรือขอบเขต MVP โดยลำพัง

## เอกสารส่งมอบทั้งแปดส่วน

| ส่วน | เอกสาร | ผลลัพธ์ที่ใช้ต่อ |
| --- | --- | --- |
| 1 | [Product vision](01-product-vision.md) | ตัวตน ผู้ใช้ ปัญหา ความต่าง และหลักผลิตภัณฑ์ |
| 2 | [PRD](02-prd.md) | Journeys, requirements, acceptance criteria และ non-functional requirements |
| 3 | [Architecture proposal](03-architecture.md) | ขอบเขต Schway/Jit, interfaces, state, memory, execution และ deployment |
| 4 | [Architecture decisions](04-architecture-decisions.md) | ADRs พร้อมสถานะ เหตุผล ทางเลือก และผลตามมา |
| 5 | [Security & trust](05-security-and-trust.md) | Authority, isolation, credentials, untrusted input และ failure behavior |
| 6 | [MVP definition](06-mvp.md) | ขอบเขตขั้นต่ำ สิ่งที่เลื่อน และ release gates |
| 7 | [Development roadmap](07-roadmap.md) | Milestones, dependencies, ความซับซ้อน และประมาณ effort |
| 8 | [Validation & open questions](08-validation-and-open-questions.md) | ความเสี่ยง การทดลอง และเงื่อนไขที่ยังต้องพิสูจน์ |

## ขอบเขตของชุดนี้

เอกสารผลิตภัณฑ์ย้ายจาก Schway มา repository นี้แล้ว ดู [migration record](../migration.md) สำหรับ ADR mapping และ source provenance ส่วน Schway host contract มีเจ้าของอยู่ฝั่ง Schway และติดตามที่ [S02](https://github.com/chayapats/schway/issues/393)

คำศัพท์ใช้ [CONTEXT.md](../../CONTEXT.md) เป็นแหล่งนิยาม ADR ของ Jit อยู่ docs/adr และหลักฐาน source Schway ใช้ commit-pinned links การย้ายเอกสารไม่ได้เปลี่ยน compatibility ของ Schway หรือเริ่ม implementation

ทำ feature specs ต่อจาก [spec index](../specs/README.md) แยก design parents ออกจาก implementation tickets
