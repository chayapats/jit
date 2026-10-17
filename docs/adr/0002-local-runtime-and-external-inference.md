---
status: accepted
scope: Jit design
---

# Jit เก็บ runtime บน host ส่วนตัวและใช้ external inference ได้

ผู้ก่อตั้งต้องการควบคุมเครื่องที่เก็บ state, credentials และ execution โดยเลือก Raspberry Pi 5 ที่เปิดต่อเนื่อง พร้อม Web ผ่าน VPN และ Telegram เป็นช่องทางเสริม ยอมให้ส่ง relevant project content/source code ให้ Grok/Codex subscription inference และผ่าน Telegram จึงไม่ตั้ง local inference หรือการห้ามข้อมูลออกจากเครื่องเป็นข้อกำหนด MVP

บริการต้องกลับมาทำงานหลัง reboot ได้เอง จึงยอมให้ service identity เข้าถึง credentials ที่จำเป็นโดยไม่รอ manual unlock กลไก secure provisioning ยังต้องพิสูจน์จริงบน Linux; การยืนยัน requirement นี้ไม่ได้รับรองว่า Bun.secrets หรือ subscription login พร้อมใช้แล้ว

ทางเลือก local-only inference ถูกเลื่อน และการให้ cloud computer ถือ execution/credentials ไม่ใช่ทิศทางที่เลือก ผลตามมาคือ external recipients และ retained copies ต้องระบุชัด รวมทั้งยอมรับ residual risk ของ host ที่ถูกยึดได้แล้ว

ที่มา: C08–C12 ใน [decision record](../product/decision-record.md); [trust model](../product/05-security-and-trust.md)
