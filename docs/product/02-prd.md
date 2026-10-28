# Jit Product Requirements Document

สถานะ: behavioral baseline หลัง discovery; รายละเอียด engineering ที่ยังเลือกไม่ได้ระบุใน [architecture](03-architecture.md) และ [open questions](08-validation-and-open-questions.md) ที่มาของ requirement อ้าง Cxx ใน [decision record](decision-record.md)

## เป้าหมายและ actors

เจ้าของ installation คนเดียวใช้ project groups เพื่อหารือกับ specialists ติดตามข้อผูกพัน และรับ static PR review ส่วน coordinator, specialist, scheduler และ channel adapters เป็น system actors ไม่มีอำนาจเท่าผู้ใช้

MVP ไม่มี model-driven repository mutation หรือ shell execution การเขียน app state, memory, report และ cache โดยบริการเป็นงานระบบที่จำเป็น ไม่ใช่สิทธิ์แก้โค้ดโครงการ

## User journeys

### J01 — เริ่มโครงการและหารือกับทีม

ครั้งแรกผู้ใช้ผ่าน setup "ตั้งจิต" เพื่อเชื่อม model route และตั้ง persona ของ Jit (FR-23) จากนั้นพิมพ์คุยได้ทันทีในพื้นที่ทั่วไปหรือโครงการที่เลือก Jit ตอบทุกข้อความ เสนอ specialist ใหม่หรือยกหัวข้อเป็นโครงการเป็นการ์ดให้ยืนยัน (FR-19–FR-22) เมื่อผูก repository ที่อนุญาตแล้ว Jit/coordinator เลือกผู้เชี่ยวชาญที่เกี่ยวข้องภายใน dispatch allowance แต่ละคนวิเคราะห์แยก ส่งคำตอบพร้อมเหตุผล แล้ว coordinator สรุปทางเลือกและคำถามที่ผู้ใช้ต้องตัดสิน ผู้ใช้เรียกหรือหยุดบทบาทที่ต้องการได้

### J02 — กลับมาข้ามวันและรับรองงาน

ผู้ใช้กลับมาถามงานค้าง Jit ใช้ accepted tasks, decisions และ memory ที่ยังใช้ได้ พร้อมลิงก์ไปที่มา suggestion ใหม่อยู่ใน proposed จนผู้ใช้รับรอง การรับรองไม่เริ่ม execution หากจำผิด ผู้ใช้แก้หรือสั่งลืมได้ และคำตอบครั้งถัดไปต้องไม่ใช้ claim ที่ถูกถอนเป็นความจริงเดิม

### J03 — PR ใหม่หรือเปลี่ยน revision

เมื่อ repository ที่ผู้ใช้เปิด monitoring มี PR เข้าเงื่อนไข Jit รับเหตุการณ์อย่าง durable สร้าง review job ผูกกับ revision อ่าน diff/context/spec/CI evidence ที่เข้าถึงได้ แล้วสร้างรายงานส่วนตัว ปัญหาที่มีหลักฐานนำไปแจ้งผ่าน Telegram ได้ ส่วนข้อสงสัยอยู่ในรายงาน การอ่านไม่ได้ครอบคลุมทั้งหมดต้องแสดงขอบเขตที่ขาด

### J04 — ใช้ Telegram ระหว่างอยู่นอกบ้าน

ผู้ใช้ที่ผูก identity แล้วรับ notification ถามต่อหรือรับรอง proposed task ได้ ทุก command ต้องระบุหรือ resolve project อย่างไม่กำกวม และเข้าสู่ state เดียวกับ Web คำสั่งซ้ำไม่สร้าง accepted task ซ้ำ รายละเอียดทีมเต็มรูปแบบอยู่ใน Web ผ่าน VPN

### J05 — เครื่องหยุดหรือ subscription ใช้ไม่ได้

หลัง reboot บริการอ่าน persisted state และตรวจ run ที่ขาดการติดต่อ งานอ่านที่ยังเกี่ยวข้องอาจเริ่ม attempt ใหม่ได้ งานไม่สำเร็จไม่ถูกปิดว่าเสร็จ เมื่อ credential/route ใช้ไม่ได้ งานรอการแก้ไขพร้อมเหตุผลและ next action ไม่เปลี่ยน billing route เอง

## Functional requirements

### FR-01 — Project groups

ที่มา C01–C02; MUST ใน MVP

- หนึ่ง project มีหนึ่ง group พร้อม topics และประวัติที่แยกจาก project อื่น
- การเลือก project, repository และ thread ต้องชัดก่อนรับคำสั่งที่เปลี่ยน state; input กำกวมให้ถามก่อนผูก
- ทดสอบสองโครงการที่มีชื่อ task ซ้ำแล้ว state และบริบทเฉพาะโครงการไม่ปะปน
- การแชร์ memory ข้าม project ไม่เปลี่ยนเจ้าของ task หรือ project ของ source

### FR-02 — Specialist participation

ที่มา C03, C12; MUST

- specialists มี role, responsibility, configured model/auth route และ analysis context แยกกัน
- router เลือกผู้เกี่ยวข้องตามหัวข้อ โดยมี participation/call/round budgets ที่มีค่าจำกัด
- ผู้ใช้เรียก เพิ่ม หยุด หรือไม่ให้ role ตอบได้ และเห็นว่าใครกำลังทำอะไร
- บทบาทที่ไม่เกี่ยวข้องเงียบได้; ไม่มีการบังคับเรียกทุก provider ทุกข้อความ
- deterministic fixture ต้องแสดงว่าผลของ specialist หนึ่งไม่ถูกใส่เป็นคำสั่งของอีกคนโดยปริยาย

### FR-03 — Coordinator and decisions

ที่มา C03; MUST

- coordinator แสดงข้อสรุป ความเห็นต่าง เหตุผล และสิ่งที่รอผู้ใช้ตัดสิน
- เก็บ user decision แยกจากข้อเสนอหรือผลโหวตของ agents
- เมื่อ model จบการตอบแต่ไม่มีข้อสรุปตามรูปแบบที่ต้องการ ระบบแสดง incomplete/failed ตามจริง
- การรับรอง decision ที่แก้ไปแล้วต้องตรวจ revision ของ proposal เพื่อไม่อนุมัติข้อความคนละชุด

### FR-04 — Project continuity

ที่มา C05; MUST

- เก็บ accepted/proposed tasks, decisions, project history และ links ไปหลักฐานข้าม process/reboot
- ถามงานค้างแล้วรวมตามสถานะปัจจุบัน ไม่เอางาน cancelled/superseded มารายงานว่า active
- ทดสอบ restart แล้วคืนรายการ task และ decision ที่ commit แล้วได้เหมือนเดิม
- ประวัติข้อความ, Schway session และ project memory เป็นคนละสิ่ง; การมี transcript อย่างเดียวไม่ผ่าน requirement

### FR-05 — Memory claims and cross-project learning

ที่มา C05–C06; MUST

- claim ระบุ source, originating project, explicit/inferred status และ active/corrected/forgotten state
- เรียนรู้และ retrieve ข้าม project ได้อัตโนมัติ โดยคง origin และไม่ย้าย task/decision มาเป็นข้อผูกพันอีกโครงการ
- ข้ออนุมานที่เปลี่ยนคำแนะนำสำคัญต้องเปิดเผยที่มา; user instruction ปัจจุบันและข้อจำกัดของ project มี precedence
- หาก sources ขัดกันต้องรักษาความขัดแย้งหรือถาม ไม่เขียนทับเป็น “ความจริงล่าสุด” โดยไร้หลักฐาน
- ทดสอบ project A ใช้ฐานข้อมูลเพราะ legacy แล้ว Jit ต้องไม่อ้างว่าเป็นความชอบที่ผู้ใช้ยืนยันสำหรับ B

### FR-06 — Task acceptance and start authority

ที่มา C04, C21; MUST สำหรับ task tracking

- ข้อเสนอสร้าง proposed task; ผู้ใช้รับรองจึงเป็น accepted พร้อม actor, timestamp, proposal revision และ source
- accepted task ไม่เริ่มแก้โค้ดหรือรัน shell; capability เหล่านี้ยังปิดใน MVP
- คำสั่งรับรองจาก Web/Telegram ถูก authorize และ deduplicate ก่อนเปลี่ยน state
- PR monitoring เป็น standing authorization สำหรับ read-only job จึงไม่ต้องสร้าง accepted user task อัตโนมัติ

### FR-07 — Completion by work type

ที่มา C17; MUST

| ประเภท | เงื่อนไข completion |
| --- | --- |
| การหารือ/สรุป | มีผลลัพธ์ที่ commit และ source links; user decision ยังแยกต่างหาก |
| Static PR review job | มีรายงานผูก revision พร้อม scope และ incomplete sections; หากอ่านไม่ครบต้องเป็น partial/incomplete ไม่อ้าง complete review |
| Reminder | บันทึกผลส่ง; failed/unknown delivery ไม่เท่ากับ delivered |
| User task ใน MVP | ผู้ใช้ยืนยันผล หรือ completion policy เฉพาะประเภทที่ระบุไว้รองรับหลักฐาน; model จบคำตอบอย่างเดียวปิด task ไม่ได้ |
| Coding task ในอนาคต | ส่งพร้อมให้ตรวจและหลักฐานตาม policy; acceptance รายละเอียดเป็นงาน phase ถัดไป |

ทดสอบ agent.finished reason completed แล้วไม่มี report/evidence: job/task ต้องไม่ถูกปิดตามคำกล่าวของ model โดยลำพัง

### FR-08 — PR monitoring and static review

ที่มา C16; MUST

- monitoring เปิดโดยผู้ใช้ต่อ repository allowlist; trigger policy เป็น configuration ที่มองเห็นได้
- ข้อเสนอเริ่มต้นคือ PR ที่พร้อม review และ revision ใหม่ โดย skip draft จน ready; policy นี้ยังต้องล็อกใน integration spec
- review ระบุ repository identity, PR number, base/head SHA, policy version และ attempts
- อ่าน diff, relevant files, issue/spec references และ CI evidence ที่อนุญาตได้ แต่ไม่ install dependencies, checkout แล้ว execute code, run tests/build หรือเรียก shell จาก model
- บันทึก coverage manifest ของสิ่งที่อ่านได้/ไม่ได้; truncated diff, missing patch, inaccessible spec และ failed fetch ไม่ถูกตีความว่าไม่มีปัญหา
- revision ใหม่ทำให้ผลเก่ามีสถานะ stale; attempt เก่าไม่ปิดงานหรือส่ง notification ราวกับเป็นผลล่าสุด
- ไม่มี GitHub write tool สำหรับ comment, review submission, commit, request changes หรือ merge

### FR-09 — Findings and private notifications

ที่มา C16; MUST

- actionable finding มีตำแหน่ง/แหล่งโค้ด เงื่อนไขที่ทำให้เกิดปัญหา ผลกระทบ เหตุผล และประเภทหลักฐาน
- แจ้งส่วนตัวเมื่อผ่าน finding policy; ข้อสงสัยและความเห็นเชิงรสนิยมอยู่ในรายงาน
- ผล “ไม่พบ” แสดง scope/revision แยกจาก not reviewed, partial, failed และ stale
- deduplicate logical notification ต่อ report/revision/finding revision; ไม่อ้าง exactly-once delivery ผ่าน external API
- timeout ที่แยกไม่ได้ว่าส่งถึง Telegram หรือยังต้องเป็น delivery unknown และมีวิธีตรวจ/ส่งใหม่ ไม่ retry แบบไร้ขอบเขต

### FR-10 — Web workspace

ที่มา C09–C10; MUST

- มี project/group/topics, roles, task states, decisions, memory source/correction, jobs/reviews และ connection status
- เห็น progress, pending decisions, scope of review และ failure reason พร้อม next action
- Web อ่าน persisted state ได้แม้ provider ใช้ไม่ได้; interrupted streaming ไม่กลายเป็น final answer
- authentication สำหรับ owner และ mutation authorization ต้องมีแม้อยู่หลัง VPN
- รองรับ stop/cancel; refresh หน้าจอแล้วไม่สร้าง run หรือ mutation ซ้ำ

### FR-11 — Telegram companion channel

ที่มา C09; MUST

- ผูก owner identity และ allowed chat ผ่าน trusted setup; username อย่างเดียวไม่ให้ authority
- รับ notifications, follow-up, project-scoped commands และ task acceptance ได้ โดยไม่ต้อง mirror บทสนทนาทุก specialist
- update/callback ซ้ำให้เกิด logical mutation เดียว; stale approval ถูกปฏิเสธพร้อมให้เปิด proposal ล่าสุด
- source code/เนื้อหาที่เกี่ยวข้องส่งได้ตามขอบเขตที่ยืนยัน แต่ credentials ไม่เป็นเนื้อหา prompt/chat
- outbound reply มี project/topic context และอ้างอิงกลับไป report/task เดียวกับ Web
- การแก้ข้อความ Telegram เดิมไม่เปลี่ยน accepted command ย้อนหลังเงียบ ๆ

### FR-12 — Configured schedules

ที่มา C15; MUST

- reminder/summary ทำงานตามเวลา เงื่อนไข timezone และ enabled state ที่ผู้ใช้ตั้งไว้
- แสดง next run, last result และ pause/resume ได้
- ไม่สร้าง autonomous coding mandate จาก deadline หรือ task acceptance
- downtime ไม่ทำให้ส่งทุก occurrence ย้อนหลังเป็นพายุ; misfire policy ต้องกำหนดและทดสอบ

### FR-13 — Model/auth configuration

ที่มา C12; MUST

- รองรับ Grok และ Codex subscription routes ผ่าน Schway หลัง feasibility gate ของแต่ละ route ผ่าน
- ผู้ใช้กำหนด role/project defaults; exact model ID และ route ที่ effective แสดงให้ตรวจได้
- ไม่มี silent provider/model/billing fallback เมื่อ quota/auth ล้มเหลว
- credential renewal ของแต่ละ routeใช้กลไก Schway ไม่สร้าง protocol client ซ้ำใน Jit
- route ที่ยังไม่ได้พิสูจน์บน host แสดง configured/unverified/blocked ตามหลักฐาน ไม่อ้าง ready จากการพบ token

### FR-14 — Priority and bounded work

ที่มา C13; MUST

- interactive work ได้ admission ก่อน background work ที่ยังไม่เริ่ม; running provider call ไม่ถูกอ้างว่าถูก preempt ทันที
- มี finite concurrency, per-role/chain round limits, wall-clock deadlines และ queue bounds
- background job ที่รอ quota/state มีสถานะและ next action; retry ไม่วนใช้ subscription ไม่สิ้นสุด
- ป้องกัน coordinator/agent output, memory extraction และ summary กระตุ้นกันเป็น loop

### FR-15 — Recovery and idempotency

ที่มา C11, C14; MUST

- รับ command และผล commit ก่อน acknowledge ว่าบันทึกแล้ว
- restart แล้ว reconcile jobs/attempts/cursors; ใช้ attempt/generation fencing ปฏิเสธ late results
- replay read job ได้เฉพาะเมื่อยัง authorized และ revision ยังเกี่ยวข้อง พร้อมเก็บ attempt history
- ไม่มีการ replay user mutation หรือ externally visible notification แบบ blind retry
- cancellation ต้องหยุดการรับผลลัพธ์ใหม่ของ attempt เดิม แม้ transport callback มาทีหลัง

### FR-16 — Correct, forget and delete

ที่มา C07; MUST

- correction เก็บ replacement และ source; invalidate derived claims ที่ขึ้นต่อกัน
- forget ถอน derived claim และ suppress การดึง/สรุป claim เดิมกลับจากประวัติโดยอัตโนมัติ แต่ผู้ใช้ยังเปิดต้นฉบับเองได้
- explicit instruction ให้จำใหม่สร้าง authority ใหม่ได้; background extractor ไม่ทำลาย suppression
- ถ้าเป้าหมายคำสั่งลืมตรงกับ task/decision ที่ยังมีผล ต้องแสดง scope และถามเมื่อกำกวม การถอน derived memory ไม่ยกเลิกข้อผูกพันหรือเปลี่ยน user decision เงียบ ๆ
- delete มี preview ของ local sources/derived data ที่จะกระทบ และยืนยันแบบผูก revision
- ป้องกัน late worker, caches, cross-project derivatives และ restore จาก backup นำข้อมูลที่ถูกถอนกลับมาใช้
- สถานะการลบ local, backup retention และสำเนาภายนอกต้องแสดงแยกกัน

### FR-17 — Authority and untrusted input

ที่มา C04, C08, C18; MUST

- model output, PR text, repository instructions, comments, CI logs และ retrieved memory ไม่ให้สิทธิ์ผู้ใช้
- อนุญาต tool ต่อ run ตาม purpose และ resources ที่ service ตรวจสอบ; read-only approval ของ Schway ไม่ใช่ filesystem/network sandbox
- ไม่ autoload extensions/packages/skills หรือ AGENTS.md จาก PR snapshot เป็น trusted instruction
- provider-hosted web search/lookup ปิดใน MVP; ไม่ใช้ความสามารถ read-only ของ provider เป็นช่องส่ง context ไป search service ที่ยังไม่ได้อนุญาต
- เอกสารที่อ้างว่าเป็นคำสั่ง owner ไม่เปลี่ยน policy จนผ่านช่องทางที่ authorize จริง
- model หรือ agent จำกัดสิทธิ์ได้อย่างเดียว ขยายไม่ได้; role หรือ run ใหม่ไม่เกินขอบเขตของผู้สร้าง; มีเพียง owner ที่ขยายสิทธิ์ได้ (S10-D02)

### FR-18 — Inspect, stop and export

ที่มา C03, C07, C14; MUST

- ตรวจว่าใครทำอะไร ใช้ route ใด ข้อมูลอ้างอิงใด รออะไร และ output artifact อยู่ไหน
- หยุด run/job และ pause monitoring/schedule แยกกันได้; คำสั่งใหม่ไม่เกิดจาก cancel
- export project data และสร้าง/restore backup ด้วย version information ได้; secrets ไม่รวมใน export ทั่วไป
- กำหนด app records สำหรับ audit แยกจาก transient Schway runtime events

### FR-19 — Jit conversational replies

ที่มา S09-D02, S09-D08; MUST — [S09](../specs/S09-main-bot-and-chat-first-ui.md)

- ทุกข้อความ owner ใน topic ได้คำตอบจาก Jit (coordinator ในบทสนทนา) หนึ่งคำตอบผ่าน bounded interactive job ไม่ใช่แค่บันทึกข้อความ
- คำตอบใช้ Jit persona ที่ owner ตั้ง; persona เป็น trusted owner configuration ไม่ใช่สิ่งที่ model จำหรือแก้เอง
- streaming เป็น provisional จน outcome และ app commit ยืนยัน; refresh/reconnect อ่าน persisted state ไม่ launch คำตอบซ้ำ
- เมื่อมี specialist ร่วม Jit ตอบเป็นเสียงเดียวที่อ้าง specialist results; ผลดิบของแต่ละ role เปิดดูได้และ coverage gap แสดงตามจริง
- route ใช้ไม่ได้/quota/auth ล้มเหลวแสดง blocked พร้อม next action ไม่เปลี่ยน route หรือ billing

### FR-20 — Role proposals

ที่มา S09-D03; MUST

- Jit เสนอ specialist ใหม่เป็น role proposal revision (ชื่อ, responsibility, route ที่เลือกจาก configured routes) ได้จากบทสนทนา
- role ถูกสร้างหรือแก้เฉพาะเมื่อ owner ยอมรับ proposal revision นั้น ผ่าน owner command เดียวกับ role configuration
- owner แก้ไขก่อนยอมรับ หรือปฏิเสธได้; proposal ที่ stale หรือถูกแทนแล้วยอมรับไม่ได้
- proposal ไม่ให้ tools, routes, budgets หรือ authority นอกที่ owner configuration อนุญาต; ข้อความใน source/memory ที่อ้างว่าเป็นคำสั่ง owner สร้าง role ไม่ได้

### FR-21 — Owner dispatch allowance

ที่มา S09-D04; MUST

- owner ตั้ง allowance ต่อโครงการว่า Jit เรียก enabled specialists เองได้กี่ role ต่อข้อความ owner (ค่าเริ่มต้น 3, finite, ปิดได้)
- dispatch ภายใน allowance ใช้ admission, budgets และ fencing เดิม; เกิน allowance ต้องผ่าน confirmation card ของ owner
- owner หยุดทั้งหมดหรือข้ามราย role ได้ระหว่างทำงาน; การกระทำที่มีผลถาวร (role, task, decision) ยังต้องยืนยันทุกครั้ง

### FR-22 — General space and topic promotion

ที่มา S09-D09; MUST

- installation มีพื้นที่ "ทั่วไป" ที่ระบบสร้างเป็นโครงการพิเศษ แชทใหม่ที่ไม่ได้เลือกโครงการไปอยู่ที่นั่น
- Jit เสนอการยกหัวข้อเป็นโครงการใหม่ได้; โครงการถูกสร้างเฉพาะเมื่อ owner ยอมรับ
- การยกระดับสร้างโครงการและหัวข้อใหม่ที่ต่อจากหัวข้อต้นทางพร้อมลิงก์ ณ revision ที่แน่นอน; หัวข้อต้นทางเป็นอ่านอย่างเดียว
- sources/memory/obligations เดิมคง project identity และ provenance; ไม่ย้าย obligations ข้ามโครงการเงียบ ๆ

### FR-23 — First-run setup (ตั้งจิต)

ที่มา S09-D07; MUST

- installation ที่ยังไม่ตั้งค่าเริ่มที่ setup ไม่ใช่หน้า workspace: ตื่น → เชื่อมจิต (route และการตรวจว่าเรียกได้) → รู้จักกัน (การเรียกขาน, ภาษา) → นิสัยของจิต (ข้ามได้) → ตั้งจิต
- ทุกขั้น idempotent และกลับมาทำต่อได้หลัง refresh/restart; ผลเป็น owner configuration ที่แก้ได้ในตั้งค่า
- route ที่ยังไม่ผ่านการตรวจแสดง configured/unverified/blocked ตามหลักฐาน; setup ไม่สร้าง specialists หรือโครงการให้เอง

### FR-24 — Chat-first Web experience

ที่มา S09-D01, S09-D05, S09-D06, S09-D10, S09-D11, S09-D13; MUST

- หน้าแรกเป็นช่องพิมพ์หลัก; sidebar แสดงโครงการ → หัวข้อ; memory/tasks/jobs/PR อยู่ใน panel ของหัวข้อและ command palette; งาน ops อยู่ในตั้งค่า
- dark และ light theme ใช้ design tokens ชุดเดียว; ทำตาม `prefers-color-scheme` และ owner เลือกเองได้
- ทุก form และ command ใช้งานได้เมื่อไม่มี browser script; script เป็น local static asset เท่านั้น
- ติดตั้งเป็น PWA ได้; service worker cache เฉพาะ static assets ไม่ cache project data หรือ authenticated responses

### FR-25 — Bilingual interface

ที่มา S09-D12; MUST

- ป้าย UI ทั้งหมดมาจาก dictionary ไทยและอังกฤษ; ไทยเป็นค่าเริ่มต้น
- ภาษาที่เลือกใน setup ใช้กับ UI และภาษาที่ Jit พูด และแยกตั้งค่าได้
- ไม่มีป้ายที่ขาดคำแปลใน release; test ตรวจ key ครบทั้งสองภาษา

### FR-26 — Quiet and failed scheduled runs

ที่มา S10-D01; MUST — [S10](../specs/S10-reliability-and-owner-integrations.md)

- run ที่เกิดจาก schedule ไม่มีคนรอคำตอบ จึงจบเป็น `no_update` ได้ผ่าน typed outcome; `no_update` ไม่สร้าง delivery intent, ไม่นับเป็น unread และไม่เปลี่ยน preview แต่ยังอยู่ในประวัติ run
- run ที่ทำงานไม่สำเร็จรายงาน `failed(reason)` ผ่าน typed outcome; failed ไม่มีทางเป็น quiet และแจ้งเตือนเสมอ
- การตัดสินว่า quiet ใช้ typed outcome ไม่ใช่การจับคำในข้อความ; run ที่ owner สั่งเองหรือ Test run ไม่มีทางเป็น quiet

### FR-27 — Deterministic-first routing with visible selection

ที่มา S10-D01; MUST

- ใช้กฎตายตัวก่อนเรียก model: ผู้รับที่ owner ระบุชื่อ, การตอบต่อใน task ที่ผูกอยู่, การถามต่อของ task เดียวที่เปิดอยู่ และโครงการที่มี specialist ที่พร้อมทำงานเพียงคนเดียว
- กรณีอื่นให้ Jit เลือกด้วย run ที่ไม่มี tool และตอบตาม result schema; ผลที่ไม่ถูกต้องหรือ stale ทำให้ broadcast ไม่ได้
- ทุกการเลือกที่ใช้ model แสดงบรรทัดเหตุผลให้ owner เห็นและแก้ได้; การเลือกด้วยกฎตายตัวไม่เพิ่มข้อความ

### FR-28 — Attention levels and notify-once

ที่มา S10-D01; MUST

- owner ตั้งระดับการแจ้งเตือนต่อช่องทางได้: `all` หรือ `needs-me` (เฉพาะคำถาม, การยืนยัน, decision ที่รอ owner และความล้มเหลว)
- งานหนึ่งชุด (Jit reply พร้อม discussion ของมัน) แจ้งเตือนครั้งเดียวเมื่อไม่มีงานเปิดค้าง; การแจ้งที่รอ owner ปิดเองเมื่อ owner ตอบจากช่องทางอื่น
- ระดับการแจ้งเตือนไม่ระงับ report, decision หรือประวัติ; เปลี่ยนแค่ว่าจะส่งอะไรออกไป

### FR-29 — Specialist result contract

ที่มา S10-D01; MUST

- ผลของ specialist ประกอบด้วย `Status` (done/partial/blocked/failed), `Result`, `Evidence` (อ้าง source หรือระบุว่าไม่มีหลักฐาน) และเมื่อ blocked ต้องมี `Unblock` ที่ระบุ action เดียว
- ผลที่ผิดรูปแบบถือเป็น incomplete ไม่ใช่สำเร็จ; คำว่า "เสร็จแล้ว" ในข้อความไม่ใช่หลักฐาน
- เมื่อ specialist รายงานว่างานติด Jit ไม่สั่งงานเดิมซ้ำ แต่ส่งเรื่องที่ติดกับวิธีปลดล็อกให้ owner

### FR-30 — Communication policy

ที่มา S10-D01; SHOULD

- trusted instructions ของ Jit และ specialists มี communication policy แบบ versioned: ไม่บรรยายขั้นตอนเตรียมตัว, อัปเดตเฉพาะผลที่มีความหมาย, ไม่ส่ง ack ไปมาจนวนลูป และคำตอบที่มาจาก specialist ระบุชื่อคนนั้นก่อน
- policy อยู่ในโค้ดและผ่าน review; model, source หรือ memory แก้ไม่ได้

### FR-31 — Self-contained context packet

ที่มา S10-D01; MUST

- ทุก run ได้ packet ที่ครบในตัว: purpose, responsibilities, คำขอปัจจุบัน, owner decisions ที่ยังมีผลของ topic (ปักไว้ ไม่ถูกตัดก่อน), ข้อความล่าสุด และ summary แบบ versioned พร้อม source IDs
- compaction, reopen หรือการเปลี่ยน provider ไม่ทำให้ owner decision ที่ยังมีผลหลุดจาก packet; ถ้า budget ไม่พอให้ตัดส่วนอื่นก่อนและแจ้งสิ่งที่ตัดไป

### FR-32 — Owner local API and CLI

ที่มา S10-D01; MUST

- owner เปิด local API ได้ต่อ installation (ปิดเป็นค่าเริ่มต้น); รับเฉพาะ loopback และใช้ bearer token จากไฟล์ที่เจ้าของ process อ่านได้คนเดียว
- `jit` CLI ส่งข้อความเข้า topic, รอคำตอบ (`--wait`), อ่านสถานะ และใช้ retry key ที่คงที่ได้ receipt เดิม; มี exit codes ที่ระบุความหมาย
- API ทำได้แค่สิ่งที่ owner ทำได้ผ่าน command เดิม และไม่ขยายสิทธิ์ใดๆ; request ที่มี `Origin` หรือ `Host` แปลกปลอมถูกปฏิเสธก่อนตรวจ token

### FR-33 — Signed webhook triggers

ที่มา S10-D01; SHOULD

- owner สร้าง webhook trigger ต่อ PR monitor ได้ ใช้ HMAC secret ที่เก็บแบบ redacted
- webhook ที่ลงลายเซ็นถูกต้องทำได้แค่ปลุก poll เดิมให้เร็วขึ้น; payload ไม่ใช่ input ของ review และไม่ถูกส่งเป็นคำสั่งถึง model
- event ซ้ำถูก dedupe ด้วย delivery ID; ลายเซ็นผิด, request ที่เกินขนาด หรือ rate เกินถูกปฏิเสธโดยไม่เปลี่ยน state

### FR-34 — Read-only schedule feed

ที่มา S10-D01; MAY

- owner สร้าง `.ics` feed URL แบบอ่านอย่างเดียวของ schedules ได้ แสดง occurrence ล่วงหน้า 30 วัน คำนวณจาก schedule logic ตัวเดียวกับที่สั่ง run
- token อยู่ใน path, เปลี่ยนหรือปิดได้ และไม่อยู่ใน log; token ผิดได้ 404
- ชื่อ event มีแค่ชนิดของ schedule และชื่อโครงการเป็นค่าเริ่มต้น; การใส่ข้อความ purpose ลงไปด้วยเป็นตัวเลือกที่ owner เปิดเอง

### FR-35 — Project access levels and kill switch

ที่มา S11-D02, S11-D08, S11-D09; MUST — [S11](../specs/S11-execution-access-and-tools.md)

- แต่ละโครงการมี access level `read` (ค่าเริ่มต้น), `workspace` หรือ `full` แบบ revisioned และ specialist ตั้ง override ที่ต่ำกว่าได้เท่านั้น
- การเพิ่มระดับต้องเป็น owner command จาก Web พร้อมขั้นยืนยัน; Telegram, model output, local API และ source text ลดระดับได้อย่างเดียว
- `full` ตั้งได้เมื่อ operator config บันทึก Pi resource evidence แล้วเท่านั้น
- ทุกหน้าของโครงการแสดงระดับปัจจุบันเป็นข้อความ; kill switch ยกเลิกงาน execution ทั้งหมด หยุด box และห้าม admit งานใหม่จน owner resume

### FR-36 — Execution box

ที่มา S11-D01, S11-D04, S11-D05; MUST

- execution tools ทำงานใน box ต่อโครงการที่แยกจาก Jit service; box ไม่มี credentials, database, backups หรือ channel tokens ของ Jit
- network ของ box ตามระดับ: `workspace` ออกได้เฉพาะ package registry ที่ owner อนุญาต; `full` ออกได้ทั้งหมด; `read` ไม่มี box
- ทรัพยากรมีขอบเขต finite (ค่าเริ่มต้น 2 box พร้อมกัน, 2 GB/2 CPU, idle stop 30 นาที); reset ทำได้โดย owner เท่านั้น
- run ใช้ core tools ของ Schway ผ่าน host-pluggable backend (`schway.host.core-tools/v1`) และทุก tool call ถูกบันทึก audit แบบ bounded

### FR-37 — External effects and approval cards

ที่มา S11-D03, S11-D08; MUST

- external effect (push, PR/comment/merge, deploy, ส่งข้อความในนาม owner, จ่ายเงิน, ลบของ remote) เกิดได้ผ่าน effect tool ของ Jit และ approval card เท่านั้น
- การ์ดผูกกับ action ที่แน่นอนและ revision, ใช้ได้ครั้งเดียว, หมดอายุ; การอนุมัติทำให้ effect เกิดครั้งเดียวพร้อม receipt
- owner ตั้ง auto-approve ต่อโครงการต่อชนิด effect ได้ใน Web เท่านั้น
- Telegram อนุมัติหรือปฏิเสธการ์ดทีละใบได้จาก bound owner chat; การตั้งค่าที่ขยายอำนาจทำได้ใน Web เท่านั้น

### FR-38 — Connections

ที่มา S11-D03, S11-D06; MUST

- owner สร้าง หมุน และลบ connection ใน Web; ค่า secret ไม่ถูกแสดงกลับ
- secret ไม่อยู่ใน prompt, log, export, box filesystem หรือ tool result; ใช้ได้เฉพาะตอน effect ที่อนุมัติหรือ MCP server ที่ owner ผูกไว้

### FR-39 — MCP servers

ที่มา S11-D06; MUST

- agent เสนอการติดตั้ง MCP server เป็นการ์ดที่แสดง source, pinned version และ command; owner อนุมัติใน Web เท่านั้น
- server รันใน box ของโครงการ; tool ที่ไม่มี `readOnlyHint` เป็น external effect ที่ต้องอนุมัติ เว้นแต่ owner ตั้ง auto-approve tool นั้น

### FR-40 — Browser-use and computer-use

ที่มา S11-D07; MUST

- Chromium (profile ต่อโครงการ) และ desktop เสมือนรันใน box ของโครงการ
- owner ดู live view และ takeover ได้ใน Web; ระหว่าง takeover agent ส่ง input ไม่ได้
- action ประเภท submit/confirm หยุดรอ approval card

## Non-functional requirements

| ID | ข้อกำหนดและการตรวจรับ |
| --- | --- |
| NFR-01 | ไม่มี repository mutation/agent shell ใน MVP; negative tests และ credential/tool scopes ต้องพิสูจน์. หลัง S11 การ mutation เกิดได้เฉพาะใน execution box ตาม access level และ approval card (FR-35–FR-37, NFR-14) |
| NFR-02 | Schway owns loop, retries, sessions, provider-independent conversation; Jit ไม่ deep-import private runtime เป็น production integration |
| NFR-03 | headless host ไม่โหลด TUI; โหลดเฉพาะ provider ที่ run เลือก; test import boundary ใน Schway bridge |
| NFR-04 | Pi ARM64 boot/reboot, persisted state และ subscription renewal ต้องผ่าน smoke test ใน service context จริง |
| NFR-05 | durable commands, state transitions และ outbox intent atomic ภายใน Jit store; interrupted cross-store operations reconcile ได้ ไม่อ้าง distributed atomicity |
| NFR-06 | resource settings มี finite positive bounds; วัด memory/disk/queue/latency บน Pi ก่อนกำหนด numeric operating profile |
| NFR-07 | Web/Telegram authorize owner และ project mutation, sanitize rendered untrusted content, redact secrets ใน logs/prompts/errors |
| NFR-08 | backup/restore ทดสอบกับ state, Schway sessions, deletion ledger และ schema versions; งานจาก backup ไม่รันก่อน reconciliation |
| NFR-09 | ไม่มี outbound telemetry โดยปริยาย; model/Telegram/GitHub เป็น external recipients ที่ระบุ; retention และ data volume ควบคุมได้ |
| NFR-10 | deterministic tests ใช้ scripted model, protocol fixtures และ fake clock ไม่ใช้ paid inference; live validation opt-in แยกจาก release tests |
| NFR-11 | ไทย/อังกฤษและ Unicode content ถูกเก็บ ค้น และแสดงไม่เสีย; UI สถานะมีข้อความไม่พึ่งสีอย่างเดียว; ป้าย UI รองรับไทยและอังกฤษตาม FR-25 (S09) |
| NFR-12 | migrations/version compatibility มี backup และ recovery path; Jit ไม่แก้หรือ rewrite Schway session format เอง |
| NFR-13 | UI ใช้ค่าสี ขนาดตัวอักษร radius และ duration จาก token เท่านั้น; CI ล้มเมื่อพบค่า literal นอกไฟล์ token ([S10](../specs/S10-reliability-and-owner-integrations.md)) |
| NFR-14 | execution ไม่รันใน process หรือด้วย identity ของ Jit service; box ไม่มี Jit credentials/state; deterministic tests ใช้ fake box runtime; Podman จริงและ Pi resource checks เป็น opt-in evidence ([S11](../specs/S11-execution-access-and-tools.md)) |

## Quality gates และสิ่งที่ยังไม่กำหนด

Functional/security acceptance ข้างต้นเป็น release gates ส่วนคุณค่าของทีม ความแม่นจริงของ model และความพอใจจะประเมินจากผู้ก่อตั้งหลังทดลอง ไม่ตั้ง product-value threshold แทนคำตอบ Q41

ก่อน pilot ต้องระบุ configuration จริงของ repo/trigger, role/model IDs, schedule timezone/misfire, retry/concurrency, backup/retention และ numeric resource limits ดู [validation plan](08-validation-and-open-questions.md) การยังไม่มีค่าที่วัดไม่ใช่เหตุให้ใช้ค่า unlimited
