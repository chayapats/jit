# S01 — Pi/service/subscription feasibility

Owner: Jit. Status: ready for ticket breakdown; live host/account evidence requires owner participation. Parent scope: [Jit MVP](00-mvp.md). Related engine contract: [Schway S02](https://github.com/chayapats/schway/issues/393)

## Problem Statement

Jit ต้องทำงานต่อเนื่องบน Pi และกลับมาได้หลัง reboot โดยใช้ Grok/Codex subscriptions ที่ owner มี แต่หลักฐานปัจจุบันมีเพียง read-only host snapshot และ adapters ใน source ยังไม่พิสูจน์ dependency compatibility, service-context credentials, token renewal หรือ inference จริง

การพบไฟล์ credential หรือรัน CLI ผ่าน SSH ได้ไม่เท่ากับพร้อมใช้งานหลัง boot ต้องแยก observed facts จาก configured access และไม่แก้ข้อจำกัดด้วย plaintext/API billing fallback

## Solution

สร้าง repeatable, sanitized feasibility evidence สำหรับ exact runtime/service context และแต่ละ selected route พร้อมผล pass/fail/blocked ที่ให้ next action การตรวจจริงต้องจำกัดตามขอบเขตที่ owner เปิดให้ ไม่ติดตั้งหรือใช้ subscription จากการ author spec นี้

## User Stories

1. ในฐานะ owner ฉันต้องการรู้ว่ารุ่น Bun และ dependencies ใช้ได้บน ARM64 ก่อนเริ่มวางบริการ
2. ฉันต้องการแยก host prerequisites ที่มีอยู่จากสิ่งที่ต้องติดตั้ง เพื่อควบคุมการเปลี่ยนเครื่อง
3. ฉันต้องการ provision credentials ให้ service identity อย่างชัดเจน โดยไม่ดึงจาก CLI อื่นเงียบ ๆ
4. ฉันต้องการเลือก Grok/Codex routes และ exact model IDs ที่ account ใช้ได้
5. ฉันต้องการตรวจแต่ละ route แยกกัน เพื่อไม่เอาการผ่านของ route หนึ่งไปอ้างอีก route
6. ฉันต้องการให้ access/refresh tokens ไม่ปรากฏใน evidence, prompts หรือ issue attachments
7. ฉันต้องการตรวจ inference ใน service context จริง แทนการทดสอบเฉพาะ interactive shell
8. ฉันต้องการให้ token renewal ใช้ lifecycle ของ Schway และไม่เกิด refresh race เมื่อมีหลาย run
9. ฉันต้องการ reboot แล้ว service เรียก credentials ได้โดยไม่รอ unlock
10. ฉันต้องการเห็น needs-login/store-unavailable/quota/rejected states พร้อม next action
11. ฉันต้องการหยุดการทดสอบได้และรู้ว่าเหลือ process/state อะไร
12. ฉันต้องการหลักฐาน resource/concurrency พื้นฐานเพื่อกำหนด operating profile
13. ฉันต้องการให้การใช้ quota เกิดจาก opt-in live check โดยมีจำนวน attempts/deadline ที่จำกัด
14. ฉันต้องการผล blocked ที่ซื่อสัตย์ หาก route หรือ boot credential path ยังใช้ไม่ได้

## Implementation Decisions

### Scope and authority

แยก inventory/readiness จาก mutation/live probes การติดตั้ง runtime, provisioning service account, login และ reboot เป็น host changes ที่ ticket ต้องระบุขอบเขตและ owner participation ก่อนทำจริง Spec นี้ยังไม่ให้คำสั่งดำเนินการบนเครื่อง

ใช้เป้าหมายจาก installation-local configuration ห้าม hard-code SSH user/IP หรือ token ใน tracked scripts/docs ผลจาก discovery มี Ubuntu 24.04 ARM64, RAM ประมาณ 8 GB, NVMe และ Git; Bun ยังไม่พบใน SSH PATH ที่ตรวจ

### Evidence contract

ผลตรวจหนึ่งชุดต้องมี: evidence ID/time, host label ที่ไม่เปิด secret, OS/architecture/kernel, runtime/dependency versions, execution identity/context, selected route/model, probe class, bounded attempt/deadline, observed outcome และ next action

ผล route ใช้ states not-configured, configured-unverified, observed-ready, needs-login, store-unavailable, quota-waiting, rejected หรือ failed โดย observed-ready ระบุเวลา/รุ่นที่ตรวจ ไม่เป็นคำรับประกันถาวร

เก็บ sanitized evidence ใน installation-local records และ publish เฉพาะสรุปที่ตรวจว่าไม่มี credential/user-specific address Raw response bodies, auth headers, token payloads และ process environment dumps ไม่เป็น evidence artifacts

### Runtime and service

ระบุ exact Bun version และ test prerequisites ก่อนเลือก supervisor/installation packaging การผ่าน engine minimum version ไม่แทน dependency validation บน ARM64

ใช้ dedicated service identity ตาม deployment proposal และพิสูจน์ว่า identity นั้นมีสิทธิ์เฉพาะ managed state/resources ที่ต้องใช้ ทดสอบ PATH, working directory, persistent writable directory และ runtime startup ของ service context จริง

### Credentials and route probes

เริ่มจาก Schway's existing credential/renewal mechanisms Linux secure-store path ต้องมี Secret Service ที่ service identity เข้าถึงได้หลัง boot หากใช้ไม่ได้ ผลต้องเป็น blocker พร้อมข้อเสนอใน spec แยก ไม่สร้าง plaintext backend อัตโนมัติ

Grok และ Codex ตรวจแยกกัน: explicit setup → configured access → model/capability preflight → bounded opt-in inference → normal renewal path → service restart/reboot observation ห้ามนำ token ไปพิมพ์หรือย้ายจากแอปอื่นเพื่อให้ test ผ่าน

Renewal behavior ทดสอบ deterministic fixture ที่ existing adapter seam ก่อน ส่วน live evidence บอกตามจริงว่า renewal/revocation edge ใดสังเกตได้แล้ว ห้ามปลอม token expiry ของบัญชีจริงหรืออ้างว่า refresh ผ่านเพราะ login ผ่าน

ไม่เปลี่ยน provider/model/auth route หรือ API-key billing เมื่อ error หาก quota ใช้ต่อไม่ได้ให้หยุด probe และบันทึก waiting state

### Boot and recovery

Reboot evidence ต้องแสดงว่า service กลับมา เห็น persisted state และเข้าถึง credential route ที่จำเป็นโดยไม่ต้อง owner unlock พร้อมจับ orphaned probe attempt เป็น interrupted ไม่เป็น success

หากยังไม่ได้สังเกต actual renewal หลัง boot ให้แยก startup/credential-read/inference/refresh evidence ไม่รวมเป็น pass เดียวที่อ้างครบทั้งหมด

## Acceptance Criteria

- [ ] Inventory บันทึก exact ARM64/runtime prerequisites และแยก installed/absent-on-tested-PATH/unverified
- [ ] Live probe ทุกครั้งเลือก route/model และมี finite attempts/deadline ก่อนเรียก
- [ ] Evidence และ issue summary ไม่มี tokens, headers, SSH target หรือ environment dumps
- [ ] แต่ละ route มี outcome แยก; configured access ไม่กลายเป็น observed-ready โดยไม่มี successful request
- [ ] Auth/store/quota failures ไม่ trigger provider/billing/plaintext fallback
- [ ] Service restart และ reboot evidence ระบุ execution identity, persisted state และ credential accessibility จริง
- [ ] Observed renewal, fixture-only renewal และ untested renewal ถูกแยกชัด
- [ ] Cancellation/reboot ระหว่าง probe ไม่ทำให้ interrupted attempt ถูกอ้างว่าสำเร็จ
- [ ] บันทึก memory/disk/concurrency observations พร้อมข้อจำกัดของ sample โดยไม่ประกาศ capacity ที่ยังไม่วัด
- [ ] ถ้า route หรือ boot path ยัง blocked มี next action และผลกระทบต่อ support claim โดยไม่ซ่อน failure

## Testing Decisions

Primary seam: service-context readiness/probe command → selected Schway route → sanitized evidence result. ทดสอบ behavior ของ evidence classifier และ bounds ด้วย fake credential store, scripted model/protocol fixtures และ fake clock

Reuse Schway subscription-route/Grok/Codex renewal fixtures และ headless tests แทนการสร้าง provider client ใหม่ Infrastructure proof ใช้ disposable local service context ก่อน; Pi reboot/account inference เป็น opt-in human-involved evidence

กำหนด deterministic cases สำหรับ missing store, locked store, rejected account, quota, request timeout, cancellation, restart และ malformed response ไม่มี real-account probes ใน bun test หรือ CI

## Out of Scope

ติดตั้ง Jit ทั้งระบบ, production service rollout, Web/Telegram integration, token backend ใหม่, local inference, code execution sandbox และการ bypass subscription limits

## Further Notes

Trace: FR-13, FR-15, NFR-04, NFR-06, R01/R10/R11 และ O01/O02 ของ product baseline

ผล S01 เป็น evidence gate ไม่ใช่การเลือก API shape ของ S02 การเขียน feature fixtures ด้าน Jit ทำต่อได้ด้วย scripted host แต่จะประกาศว่าทั้งสอง subscriptions ใช้บน Pi ได้ก็ต่อเมื่อ evidence ของแต่ละ route ผ่าน
