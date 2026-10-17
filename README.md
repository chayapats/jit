# Jit

ผู้ช่วยส่วนตัวสำหรับโครงการซอฟต์แวร์ คุยกับทีมผู้เชี่ยวชาญ จำงานและการตัดสินใจข้ามวัน และตรวจ PR บนเครื่องที่คุณควบคุม โดยใช้ [Schway](https://github.com/chayapats/schway) เป็น execution engine

**สถานะ:** จบ discovery และแตก implementation tickets ของ MVP แล้ว ยังไม่มี application ที่ติดตั้งใช้งานได้ Repository นี้เก็บ product baseline, design specs และ backlog สำหรับเริ่มพัฒนา

## เริ่มอ่าน

- [Product documents](docs/product/README.md) — vision, PRD, architecture, trust, MVP, roadmap และ validation
- [Feature specifications](docs/specs/README.md) — MVP หลักและ S01; เชื่อม S02 ที่เป็นเจ้าของโดย Schway
- [MVP implementation backlog](docs/tickets/README.md) — tickets, blockers, contract versions และ FR/NFR traceability
- [Domain glossary](CONTEXT.md) และ [architecture decisions](docs/product/04-architecture-decisions.md)
- [Migration record](docs/migration.md) — ที่มาเอกสารและ mapping ของ ADR

รุ่นแรกโฟกัส project groups, independent specialist analyses, sourced memory/tasks, static private PR review, Web ผ่าน VPN และ Telegram เป็นช่องทางเสริม เป้าหมาย deployment แรกคือ Raspberry Pi 5 กับ Grok/Codex subscriptions ที่เจ้าของตั้งค่าไว้

การแก้ repository, shell/tests/build โดย agent อยู่หลัง MVP และต้องมี isolated execution กับ explicit start authorization

## การพัฒนา

ใช้ GitHub Issues เป็น tracker ของ design specs และ implementation tickets แยกจากกัน อ่าน [workflow](docs/agents/workflow.md) ก่อนแตกหรือเริ่ม ticket ไม่มี runtime commands ให้รันจนกว่า implementation tickets จะสร้าง application ขึ้นมา

## License

[MIT](LICENSE). Repository เริ่มต้นเป็น private ระหว่างเตรียม specs; เป้าหมายผลิตภัณฑ์เป็น open source และ self-hostable
