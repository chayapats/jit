# Jit Open Questions & Validation Plan

สถานะทุกการทดลองในเอกสารนี้: ยังไม่ดำเนินการ ผล SSH read-only และ source inspection อยู่ใน [sources](sources.md) ไม่มี inference หรือ deployment test จากงานจัดทำเอกสาร

## แยกความถูกต้องกับคุณค่า

Functional/security invariants ใน PRD เป็นข้อกำหนดที่ทดสอบได้ ส่วนความคุ้มค่าของ Jit เทียบกับวิธีเดิม ผู้ก่อตั้งจะใช้แล้วให้ feedback เอง ยังไม่มี pilot project, ระยะทดลอง หรือ precision/adoption threshold ที่ยืนยัน

เก็บ observations เพื่อช่วยตัดสินใจได้ เช่น เวลาที่ต้องอธิบายซ้ำ findings ที่รับ/ปฏิเสธ เหตุผลที่ปิด notification และความผิดพลาดของ memory แต่ไม่เปลี่ยน observations เป็น success claim โดยไม่มี baseline/คำยืนยัน

## Risks และ experiments

| Risk | สิ่งที่ยังไม่รู้ | Experiment / evidence | Gate |
| --- | --- | --- | --- |
| R01 | Grok/Codex ใช้บน Pi แบบ unattended ได้จริงหรือไม่ | E01 service-context login/inference ที่ opt-in, refresh และ reboot แยกต่อ route; เก็บ sanitized result ไม่เก็บ token | ก่อนรับรอง provider support |
| R02 | host API แคบพอและไม่รั่ว core internals หรือไม่ | E02 prototype scripted run ที่เลือก context/tools/session; import/declaration/compatibility checks | ก่อน production bridge |
| R03 | specialists เพิ่มคุณค่าหรือเพียงข้อความ | E03 เปรียบเทียบ coordinator + relevant specialists กับ single-role ในงานเดียวกัน; owner ให้เหตุผลเรื่องประโยชน์/ส่วนซ้ำ | วัดระหว่าง pilot; ไม่มี numeric threshold |
| R04 | retrieval ไทย/อังกฤษและข้ามวันดีพอหรือไม่ | E04 corpus ของ tasks/decisions/claims พร้อม paraphrases, conflicts และ cross-project queries; ตรวจ sources ที่ถูกดึงและการตอบที่มีหลักฐาน | functional cases ก่อน pilot; semantic quality วัดจริง |
| R05 | inference ผิดกลายเป็น preference ถาวรหรือไม่ | E04 legacy-database scenario และ explicit instruction conflict; ตรวจ origin/status และ correction propagation | ก่อนเปิด automatic learning |
| R06 | ลืม/ลบแล้วข้อมูลกลับมาจาก history/session/backup หรือไม่ | E05 derived chains, old session replay, cancelled extractor และ restore deletion ledger | ก่อน pilot |
| R07 | PR text/instructions สั่ง tools หรือปลอม owner ได้หรือไม่ | E06 adversarial PR/AGENTS/skills/CI/comments พยายามอ่าน secrets, เปิด URL, รับรอง task | ก่อน PR monitoring |
| R08 | source incompleteness/stale revision ให้ผล clean เท็จหรือไม่ | E07 truncated/missing files, denied spec, base/head updates ระหว่าง run, closed/reopened PR | ก่อน PR monitoring |
| R09 | inbox/outbox ส่งซ้ำหรือหายเงียบหรือไม่ | E08 Telegram update replay, callback stale, edited input, send-accepted-but-timeout, offline >24h | ก่อนใช้ Telegram จริง |
| R10 | multi-role/schedules ใช้ quota/RAM ไม่สิ้นสุดหรือไม่ | E09 fake-clock priority/limits + E12 bounded load บน Pi; เก็บ queue/usage completeness/peak memory | ก่อน pilot |
| R11 | boot, storage และ restore ใช้งานต่ออย่างถูกต้องหรือไม่ | E10 crash matrix + E11 consistent backup/restore/schema/deletion drill | ก่อน pilot |
| R12 | scope เกินกำลังเจ้าของ 14 ชม./สัปดาห์หรือไม่ | E13 บันทึก effort ที่ใช้ review/operate และ owner feedback หลังแต่ละ milestone | re-estimate หลัง M0/M1 และ pilot |

## Test/evidence plan และ requirement coverage

### E01 — Runtime/auth feasibility

ครอบคลุม FR-13, FR-15, NFR-04: ตรวจ Bun/ARM64 dependencies, service identity/secret service, route-specific readiness, renewal และ reboot ใช้ live inference เฉพาะเมื่อ owner เปิดการทดสอบที่ใช้ subscription/โควตาเอง ไม่ใช้ deterministic suite เรียก account จริง

Exit evidence: versions, service startup/reboot observations, per-route pass/fail/blocked พร้อมเหตุผล ไม่ถือว่าพบ credential = inference ผ่าน

### E02 — Engine ownership and host contract

ครอบคลุม FR-17, NFR-02–NFR-03, NFR-10: scripted models/protocol fixtures พิสูจน์ selected-provider imports, no TUI, no SDK retries, cancellation, native session ownership, host-controlled context และ registry

Exit evidence: public declarations/API compatibility result และ negative case ที่ PR snapshot มี AGENTS/skills/packages แต่ไม่ถูกโหลดเป็น trusted code/instructions

### E03 — Groups, roles and synthesis

ครอบคลุม FR-01–FR-03, FR-10, FR-13–FR-14: ทดสอบสอง projects, topic routing, role override, bounded analyses, disagreement และ user decision revisions ด้วย scripted model ก่อนวัดคุณภาพจาก model จริงภายหลัง

Exit evidence: source attribution ของแต่ละ specialist และ coordinator, ไม่มี implicit user decision, stop และ UI refresh ไม่สร้าง run ซ้ำ

### E04 — Continuity and retrieval

ครอบคลุม FR-04–FR-05, NFR-11: restart แล้วคืน task/decision ที่ commit, query ไทย/อังกฤษ, related/unrelated cross-project claims, explicit/inferred conflicts และ stale source revisions

Exit evidence: fixed corpus ที่ตรวจ expected facts/source IDs ได้ Semantic recall จาก model จริงยังต้อง owner evaluate และไม่ใช้ผ่าน deterministic tests แทน quality evidence

### E05 — Authority and memory lifecycle

ครอบคลุม FR-06–FR-07, FR-16: proposed/accepted ไม่เริ่ม execution, source correction, forget suppression, delete preview, old derived memory และ late worker

Exit evidence: forgotten claim ไม่ถูก feed หรือ re-extract อัตโนมัติแม้ยังเปิดต้นฉบับเองได้; deletion ทราบผลต่อ affected native sessions และไม่มี late publication

### E06 — Untrusted input and access

ครอบคลุม FR-17, NFR-01, NFR-07, NFR-09: owner spoofing, prompt injection, path traversal/symlink/special file, arbitrary network URL, unsafe rendered content และ token redaction

Exit evidence: enforced denial นอก model พร้อม tests ที่ไม่ได้ตรวจแค่ prompt text และไม่มี GitHub mutation/shell capability ใน MVP รวมการยืนยันว่า provider-hosted lookup ปิดอยู่

### E07 — PR correctness contract

ครอบคลุม FR-08–FR-09: revision changes, duplicate triggers, drafts, inaccessible issue/CI, incomplete diff/patch, contradictory findings และ model กล่าวว่าตรวจครบทั้งที่ manifest ไม่ครบ

Exit evidence: report ผูก base/head/policy, scope gaps มีผลต่อ status, stale attempt ถูก fence และไม่มี notification ที่อ้าง revision ผิด

### E08 — Telegram and delivery

ครอบคลุม FR-09–FR-11, FR-15: binding wrong sender/chat, project ambiguity, duplicate/stale callback, edited accepted message, offset persistence crash และ delivery unknown

Exit evidence: app mutation เดียวต่อ logical command, ไม่ acknowledge ก่อน durable inbox, Web แสดง ambiguous delivery และไม่อ้าง exactly-once external send

### E09 — Schedule, priority and quotas

ครอบคลุม FR-12–FR-14: fake clock timezone/misfire, enabled/revoked schedules, active interactive work, background retry, role feedback loop และ unavailable subscription

Exit evidence: finite limits ทุก chain, queued background yield priority, ไม่มี provider/billing fallback และไม่ burst ทุก missed occurrence

### E10 — Crash/cancel reconciliation

ครอบคลุม FR-15, FR-18, NFR-05: crash ก่อน/หลัง inbox commit, native session append, app result commit, outbox send และ cancellation generation

Exit evidence: acknowledged state ไม่หาย, no duplicate mutation, orphaned outcomes reconcile ได้, late callback ไม่เปลี่ยน cancelled/superseded state

### E11 — Backup, migration and deletion restore

ครอบคลุม FR-16, FR-18, NFR-08, NFR-12: consistent DB+session manifest snapshot, schema migration failure, missing files, restored pending jobs และ latest deletion ledger

Exit evidence: restore quarantine จน reconcile; ไม่ resurrect forgotten/deleted data; แยก local deletion กับ expired/external backups ตามจริง และถ้าไม่มี latest deletion ledger ต้องไม่ enable context/extraction/notifications อัตโนมัติ

### E12 — Pi operating profile

ครอบคลุม FR-10, FR-14, NFR-06: วัด peak memory/disk/queue/call duration และ UI command acknowledgement ภายใต้ finite representative load บน host จริง

Exit evidence: บันทึกค่าตั้งต้น concurrency, deadlines, retry bounds, payload/context limits, disk watermark และ retention ที่ใช้ได้ ห้ามประกาศ latency/resource SLO ก่อนมีผลวัด

### E13 — Founder pilot feedback

เก็บผลตามที่ owner เลือกเมื่อเริ่มใช้: งานไหนประหยัดเวลา งานไหนต้องทำใหม่ ข้อค้นพบผิดหรือพลาด ความจำผิด/ลืม และทีมที่ตอบโดยไม่ช่วยตัดสินใจ รวม maintenance effort

Exit evidence: owner feedback และ next decision เท่านั้น ไม่มีตัวเลข 14 วัน/10 PR/80% ที่บังคับจาก discovery

## Open questions ที่ต้องทำใน feature spec

| ID | ประเด็น | สถานะ/ช่วงที่ต้องปิด |
| --- | --- | --- |
| O01 | exact Grok/Codex model IDs, role/project defaults และ route capability | owner configuration + M0 evidence ก่อนรับรอง support |
| O02 | Bun version, Linux secret service/provisioning และ service identity หลัง boot | blocker ของ M0 |
| O03 | public host API package/exports/lifecycle และ context source policy | blocker ของ M1 |
| O04 | SQLite schema/search ภาษาไทย, Web stack/event transport | proposed; ล็อกตาม spec M2–M4 หลัง spike |
| O05 | pilot repo allowlist, draft/update/base-change policies, polling/catch-up interval | ก่อน M5 เปิด monitoring |
| O06 | finding categories, evidence rubric, dedupe keys และ thresholds สำหรับ notification | ก่อน M5; owner-adjustable โดยไม่สร้าง truth guarantee |
| O07 | schedule timezone, misfire/catch-up และ quiet-hour preferences | ก่อนเปิด schedule แต่ละรายการ |
| O08 | queue/concurrency/round/deadline/output/disk bounds และ quota waiting policy | ก่อน representative load และ pilot |
| O09 | backup destination/encryption, retention/purge/deletion ledger และ restore procedure | ก่อน pilot |
| O10 | โครงการทดลองแรกและเกณฑ์ว่าคุ้มค่า | ผู้ก่อตั้งจะประเมินหลังใช้; ไม่บังคับถามซ้ำเพื่อปลดงาน spec |
| O11 | public release/support policy ของ Jit | ก่อน distribution; repository และ MIT LICENSE สร้างแล้ว |
| O12 | executor technology และ side-effect recovery สำหรับ coding | deferred; ไม่ block MVP ที่ปิด execution |

## กติกาการเปลี่ยนข้อสรุป

ถ้า experiment หักล้างสมมติฐาน ให้บันทึก evidence และผลกระทบต่อ FR/NFR/ADR ก่อนปรับ scope การลด confirmed requirement เช่น group/memory/Telegram หรือเปลี่ยน authority ต้องกลับให้ owner ตัดสิน ส่วน library/default ที่ reversible เปลี่ยนใน spec ได้โดยบันทึกเหตุผล
