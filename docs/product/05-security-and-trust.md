# Jit Security & Trust Model

สถานะ: authority/product boundaries confirmed; enforcement design proposed และต้องพิสูจน์ก่อน pilot เอกสารนี้เป็น design model ไม่ใช่ผล security audit ของ implementation

## Assets และ trust boundaries

Assets ได้แก่ subscription refresh/access tokens, Telegram bot token, GitHub credentials, owner sessions, private source code, project conversations, tasks/decisions, memory, backups และ host resources

| Boundary | Trust assumption | Enforcement ที่ต้องมี |
| --- | --- | --- |
| Owner → Web/Telegram | owner ที่ผูก identity เท่านั้นให้ authority | authenticated session, allowed numeric IDs/chat binding, CSRF/origin controls, revision-bound commands |
| Model → application | output เป็นข้อเสนอ/คำขอ tool | schema validation, purpose/authorization checks, finite limits |
| Repository/PR/CI/web → context | เป็น untrusted data รวมไฟล์ instructions | ไม่มี autoload เป็น trusted policy; scoped retrieval, safe rendering |
| Jit → Schway | trusted pinned runtime ผ่าน public contract | native types, selected tools/provider, context source policy |
| Jit → external services | ส่งเนื้อหาได้ตามขอบเขตที่ตกลง | endpoint/resource allowlist, redact secrets, connection status |
| App → future executor | execution code ถือสิทธิ์น้อยกว่าบริการ | isolated filesystem/network/process scope; ไม่มี service tokens |
| Host → storage/secrets | trusted host/service identity เป็นฐาน | restricted OS access, controlled provisioning/backup; host compromise เป็น residual risk |

VPN เป็น network access layer เพิ่มเติม ไม่แทน owner authorization ใน Web

## Authority model

Authority มาจาก authenticated user command หรือ standing authorization ที่ผู้ใช้เปิดไว้ มี owner, project/resources, action class, proposal/config revision, created time และ revoke state

| การกระทำ | อำนาจที่ต้องมี | MVP |
| --- | --- | --- |
| วิเคราะห์/ตอบใน project group | authenticated user message และ scoped context | เปิด |
| เสนอ task/decision | system proposal ที่อ้าง source | เปิด แต่ยังไม่ใช่ user acceptance |
| รับรอง/แก้/ยกเลิก task | owner command ผูก proposal revision | เปิด |
| อ่าน PR อัตโนมัติ | enabled monitoring ของ repo ที่อนุญาต | เปิด |
| แจ้ง owner | authorized job + notification policy + bound channel | เปิด |
| เตือน/สรุปตามเวลา | schedule ที่ owner ตั้ง | เปิด |
| เรียนรู้ข้าม project | policy ที่ผู้ใช้ยืนยัน + source lineage | เปิด แต่ไม่เพิ่มสิทธิ์หรือเปลี่ยน obligations |
| แก้ code/run shell/tests | explicit start + isolated execution grant | ปิด; phase ถัดไป |
| โพสต์ GitHub/merge/deploy | ต้องออกแบบและขอ authorization ใหม่ | ปิด |
| เพิ่ม provider/billing route | owner configuration change | ไม่มี automatic fallback |
| ลบ local data | owner confirmation ของ deletion preview | เปิด |

การกดรับรอง task ไม่เปิด shell และการที่ agent อีกตัวบอกว่า “ผู้ใช้อนุมัติแล้ว” ไม่สร้าง authority chain

## Read-only ต้องบังคับที่ resource

Schway approval mode ใช้ tool effect declaration และ workspace path ไม่เป็น sandbox ดู [หลักฐาน](sources.md) Jit จึงต้องสร้าง registry ที่ไม่มี generic bash/write/edit และไม่เปิด arbitrary read/web_fetch โดยยึดแค่ effect ว่า read-only

- local read รับเฉพาะ managed snapshot/resource handles ภายใต้ realpath scope ปฏิเสธ traversal, symlink escape, special files และ secrets/service directories
- GitHub connector resolve repo identity และ immutable ref เอง ไม่รับ URL/credential headers ที่ model สร้าง
- ไม่อ่าน network private/loopback โดย model request; integration endpoints มาจาก trusted config
- ปิด provider-hosted web search/lookup ใน MVP ด้วย แม้ core/provider จะถือว่า read-only เพราะ query อาจส่ง context ไปผู้รับข้อมูลเพิ่ม
- snapshots ไม่เป็น executable workspace และไม่ค้นหา AGENTS.md, project config, skills/extensions/packages เพื่อโหลดเป็น authority
- cache/report writes เป็น service-owned operation ไม่ใช่ tool ให้ model เลือก destination

Enforcement นี้เป็น MVP requirement แม้ isolated coding executor จะถูกเลื่อน การไม่มี shell ไม่ได้ทำให้ arbitrary reads หรือ URLs ปลอดภัยโดยอัตโนมัติ

## Prompt injection และ memory poisoning

ถือว่า PR description, comments, code, AGENTS.md, issue text, CI output และ model-generated summaries อาจมีคำสั่งให้เปลี่ยนบทบาทหรือขโมยข้อมูล

มาตรการต้องประกอบกัน: แยก trusted instructions กับ source data, ใช้ narrow tools, ตรวจ resource access นอก model, validate output citations, จำกัด context/rounds และไม่แปลง external text เป็น user acceptance

Memory claim จาก external/model source ต้องระบุ origin/status; specialist เห็นด้วยหลายตัวไม่เปลี่ยน inference เป็น explicit user fact เมื่อ source ถูกแก้ ลืม หรือลบ ต้อง invalidate derivatives ข้าม project รวม context ที่เคยใช้ claim นั้น

ไม่อ้างว่าการใส่คำเตือนใน prompt ป้องกัน injection ได้ครบ negative tests ต้องพยายามอ่าน token paths, ส่งข้อมูลไป arbitrary URL, โหลด malicious skill, ปิด task เอง และ forged approval

## Credentials และ unattended boot

- ใช้ Schway provider auth/refresh mechanisms แทนการสร้าง OAuth/protocol logic ซ้ำ
- provision credentials ให้ service identity อย่าง explicit ไม่ import จาก user's other agents/CLI โดยเงียบ ๆ
- owner login, model login และ Telegram identity เป็นคนละ identity
- เก็บ token ที่ trusted credential boundary ไม่รวมใน prompt, transcript, memory, logs, API response หรือทั่วไป export
- Linux Bun.secrets ต้องมี Secret Service ที่ใช้งานใน service context ได้ รวมหลัง reboot; proof นี้ยังไม่เกิด
- error ของ secure store/auth ทำให้ route blocked/waiting ไม่ fallback plaintext หรือ API-key billing
- token rotation/revocation ต้อง fence active refresh และปิดการใช้ identity เก่า; application ใช้ capability ของ Schway และตรวจ integration race

การเปิดทำงานเองหลัง boot หมายถึง service มีทางเข้าถึง secret โดยไม่รอ owner พิมพ์รหัส ขอบเขตนี้ยอมรับแล้ว จึงไม่อ้างว่าการเข้ารหัส at rest ป้องกันผู้ยึด host ที่กำลังทำงานได้ทั้งหมด

## Telegram และ external data

Owner ยอมให้ส่งบทสนทนาและโค้ดที่เกี่ยวข้องผ่าน Telegram แต่ token/credentials ไม่อยู่ในเนื้อหางาน Telegram Cloud Chats เก็บข้อมูลบน server ของ Telegram จึงต้องแสดงให้เข้าใจว่า local hosting ไม่จำกัดผู้รับข้อมูลไว้ที่ Pi — [Telegram privacy](https://telegram.org/privacy#3-3-your-messages)

Binding ใช้ owner user ID และ allowed chat/project context; unknown sender, forwarded command, stale callback หรือข้อความจาก bot อื่นไม่ให้ user authority การรับ update ซ้ำและแก้ข้อความเดิมต้องไม่ทำ mutation ซ้ำ

Outbound payload ใช้ report/task references ที่ commit แล้ว การส่ง timeout หลัง remote accept อาจทำให้ delivery unknown; การ deduplicate ใน local store ไม่พิสูจน์ exactly-once notification

## Lifecycle ของข้อมูล

| Operation | ผลที่ต้องเกิด |
| --- | --- |
| Correct | supersede claim พร้อม source ใหม่; dependent inference/index/context ถูก invalidate |
| Forget | ลบ derived memory และ suppress re-extraction; raw history เปิดดูเองได้ แต่ไม่ feed กลับอัตโนมัติ |
| Delete | preview sources/derivatives/managed sessions/cache ที่กระทบ; ลบ local data ตามขอบเขตและ revoke late writers |
| Restore | quarantine, replay latest deletion/suppression ledger, ตรวจ state ก่อน enable workers |

ถ้าคำสั่งลืมกำกวมกับ active task/decision ให้ชี้แจง scope ก่อน การลบ derived claim ไม่เปลี่ยนข้อผูกพันเงียบ ๆ ส่วน restore ที่ไม่มี ledger ล่าสุดต้องคง quarantine แทนการปลุกข้อมูลเก่าและให้ background workers ใช้งานทันที

Schway sessions เป็น append-only จึงไม่ rewrite record เพื่อทำให้ดูเหมือนลบสำเร็จ ต้อง retire context สำหรับ forget และลบ affected session ทั้งหน่วยเมื่อ explicit delete ต้องลบข้อมูลนั้นจริง พร้อมเปิดเผยผลกระทบใน preview

การลบจาก active local stores ไม่เท่ากับ forensic erasure จากสื่อ, backup หรือสำเนาบริการภายนอก ระบุ retention/purge status และ external deletion ที่ยังทำไม่ได้จริง ไม่อ้างครอบคลุมเกินหลักฐาน

Audit เก็บ metadata ที่จำเป็นกับ authority/state transitions โดยไม่ทำสำเนา payload ที่ผู้ใช้ลบไว้ใน logs อีกรอบ

## Failure behavior

| เหตุการณ์ | พฤติกรรม |
| --- | --- |
| Quota/auth ใช้ไม่ได้ | หยุด route, เก็บงาน, แสดง next action, แจ้งแบบ bounded; ไม่เปลี่ยน billing |
| Source fetch/truncation | partial/incomplete review พร้อม coverage gap; ไม่ตีความว่า clean |
| Input revision เปลี่ยน | supersede attempt/report เก่า; ไม่ส่งผลเก่าราวกับ current |
| Process/ไฟดับ | reconcile committed state; restart read job ที่ยังได้รับสิทธิ์; ไม่ replay mutations blindly |
| Telegram outage/ambiguous send | แสดง failed/unknown, เก็บ report ใน Web, ไม่ retry ไม่สิ้นสุด |
| Context/authority ไม่พอ | waiting_user พร้อมคำถามที่เจาะจง; user ไม่อยู่ไม่เพิ่มสิทธิ์เอง |
| Disk/store failure | ไม่ acknowledge mutation ว่าบันทึกแล้ว; หยุด state-changing jobs จนกู้ได้ |
| Cancel/revoke/delete | fence attempts ก่อนรับ late results; บันทึกสิ่งที่สำเร็จจริงโดยไม่สร้าง completion เท็จ |

## Security release evidence

ก่อน pilot ต้องมีผลทดสอบ owner spoofing/replay, injection, scoped read/network, credential redaction, stale authorization, deletion propagation, cancellation fencing และ boot auth/recovery ตาม FR-15–FR-17/NFR-04–NFR-08 ไม่มี implementation ให้รับรองจากเอกสารนี้
