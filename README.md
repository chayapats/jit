# Jit

ผู้ช่วยส่วนตัวสำหรับโครงการซอฟต์แวร์ คุยกับทีมผู้เชี่ยวชาญ จำงานและการตัดสินใจข้ามวัน และตรวจ PR บนเครื่องที่คุณควบคุม โดยใช้ [Schway](https://github.com/chayapats/schway) เป็น execution engine

**สถานะ:** APP01 มี Web workspace ขั้นแรกสำหรับ owner login และ project groups ที่เก็บถาวรแล้ว ส่วน conversation, specialists, memory, tasks และ production Schway bridge ยังอยู่ใน implementation backlog ยังไม่มี Pi/pilot support evidence

## เริ่มอ่าน

- [Product documents](docs/product/README.md) — vision, PRD, architecture, trust, MVP, roadmap และ validation
- [Feature specifications](docs/specs/README.md) — MVP หลักและ S01; เชื่อม S02 ที่เป็นเจ้าของโดย Schway
- [MVP implementation backlog](docs/tickets/README.md) — tickets, blockers, contract versions และ FR/NFR traceability
- [Domain glossary](CONTEXT.md) และ [architecture decisions](docs/product/04-architecture-decisions.md)
- [Migration record](docs/migration.md) — ที่มาเอกสารและ mapping ของ ADR

รุ่นแรกโฟกัส project groups, independent specialist analyses, sourced memory/tasks, static private PR review, Web ผ่าน VPN และ Telegram เป็นช่องทางเสริม เป้าหมาย deployment แรกคือ Raspberry Pi 5 กับ Grok/Codex subscriptions ที่เจ้าของตั้งค่าไว้

การแก้ repository, shell/tests/build โดย agent อยู่หลัง MVP และต้องมี isolated execution กับ explicit start authorization

## การพัฒนา

ต้องมี Bun 1.4.2 ขึ้นไป ไม่มี subscription หรือ Schway build เป็น prerequisite ของ workspace นี้

```sh
bun install --frozen-lockfile
bun run setup
bun start
```

`setup` รับรหัสผ่าน owner จาก terminal แบบไม่แสดงตัวอักษร (12–256 ตัว) และสร้าง owner ได้คนเดียว จากนั้นเปิด `http://localhost:3000` เพื่อ login และสร้าง project บริการฟัง loopback เป็นค่าเริ่มต้น ไม่มี public signup และไม่เรียก external services โดยอัตโนมัติ

ข้อมูลอยู่ใน ignored `.local/jit.sqlite` และ SQLite sidecars อย่า commit, แชร์ หรือเปิดสิทธิ์ directory นี้ให้ผู้อื่น ใน fresh installation directory ใช้ mode 0700 และ database/snapshots ใช้ 0600 หากย้ายไป directory ที่มีอยู่แล้วให้ operator ตรวจสิทธิ์ directory เอง

หากลืมรหัสผ่าน ให้ใช้ `bun run owner:reset` บนเครื่องที่มีสิทธิ์เข้าถึง database คำสั่ง local นี้ตั้งรหัสผ่านใหม่และเพิกถอน browser sessions เดิมโดยคง projects ไว้ ไม่มี remote reset route อย่าใส่รหัสผ่านใน CLI arguments, environment หรือประวัติ shell; automation ที่ควบคุม stdin ได้ใช้ `--password-stdin` ได้

```sh
bun test
bun run typecheck
```

ใช้ GitHub Issues เป็น tracker อ่าน [workflow](docs/agents/workflow.md), [APP01 contracts](docs/contracts/app-foundation-v1.md) และ [ADR 0007](docs/adr/0007-first-web-slice.md) ก่อนพัฒนาต่อ

## Local configuration

สำหรับ Web ผ่าน VPN ให้ใช้ HTTPS reverse proxy ที่คง `Host` ตาม `JIT_ORIGIN` และตั้ง `JIT_HOST` ให้เหมาะกับ proxy ไม่เชื่อ `Forwarded`/`X-Forwarded-*` จาก client และไม่ถือ VPN เป็น owner identity การใช้ HTTP อนุญาตเฉพาะ origin loopback สำหรับพัฒนา; remote origin ต้องเป็น HTTPS เพื่อใช้ Secure/HttpOnly/SameSite cookies อย่าเปิด backend port ให้ข้าม TLS proxy

| Setting | Development default | Limit |
| --- | --- | --- |
| `JIT_DATABASE` | `.local/jit.sqlite` | local application database path |
| `JIT_ORIGIN` | `http://localhost:3000` | one exact origin |
| `JIT_HOST` / `JIT_PORT` | `127.0.0.1` / `3000` | port 1–65535 |
| `JIT_BODY_BYTES` | 16384 | 1–1048576 bytes |
| `JIT_QUERY_BYTES` | 2048 | 1–16384 path/query bytes |
| `JIT_PAGE_SIZE` | 50 | 1–200 projects |
| `JIT_SESSION_SECONDS` | 28800 | 1–86400 seconds; at most 16 live browser sessions |
| `JIT_LOGIN_ATTEMPTS` | 8 | 1–100 attempts per installation window, including successful logins |
| `JIT_LOGIN_WINDOW_SECONDS` | 900 | 1–86400 seconds |

ค่าเหล่านี้เป็น finite local-development defaults ที่ต้องวัดก่อน pilot ไม่ใช่ผล capacity benchmark ไม่มี outbound telemetry โดยปริยาย migrations มี version และ snapshot ก่อนแก้ database เก่า แต่ full backup/restore/deployment ยังเป็น tickets แยก

## License

[MIT](LICENSE). Repository เริ่มต้นเป็น private ระหว่างเตรียม specs; เป้าหมายผลิตภัณฑ์เป็น open source และ self-hostable
