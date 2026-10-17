# Jit Architecture Proposal

สถานะ: ขอบเขตผลิตภัณฑ์และอำนาจ confirmed; component/interface/storage/deployment design ด้านล่างเป็นข้อเสนอสำหรับ feature specs ยังไม่ใช่ API ที่ Schway มีอยู่ ดู [ADRs](04-architecture-decisions.md) และ [sources](sources.md)

## รูปแบบระบบ

เสนอ modular monolith บน Pi หนึ่งเครื่อง ใช้ Bun/TypeScript ฝั่งบริการ มี Web client และ channel adapters เข้าสู่ application service เดียว แยก modules ตามเจ้าของ state โดยยังไม่เพิ่ม distributed broker, microservices หรือ vector database

แต่ละ installation มี owner identity และ state ของตนเอง ไม่มี cross-installation synchronization ใน MVP การใช้ subscription เดียวกันไม่ได้ทำให้สอง installation แชร์ memory หรือ task state

| ส่วน | รับผิดชอบ | สิ่งที่ไม่เป็นเจ้าของ |
| --- | --- | --- |
| Web / Telegram adapters | รับ authenticated command, แสดงผล/notification, project binding | การตัดสิน authorization จากชื่อที่ model อ้าง |
| Application service | commands, project/group/task/decision state, revisions, authority | provider protocol และ model retry loop |
| Team coordinator | topic routing, bounded specialist work, synthesis, user decision requests | เปลี่ยนสิทธิ์หรือรับรอง task แทนผู้ใช้ |
| Memory service | claim extraction/retrieval, source lineage, correction/forget suppression | canonical Schway conversation format |
| Job scheduler | durable jobs, priority, schedules, leases, fencing, retry eligibility | scheduling ของ sibling tool calls ภายใน Schway |
| PR integration | repo allowlist, immutable review inputs, completeness manifest, CI/spec references | execute PR code หรือ GitHub mutation |
| Schway host bridge | versioned run/session/context/tools/auth access และ events | group UX, project tasks หรือ calendar scheduler |
| Persistence / outbox | app transactions, inbox, state, audit intent, delivery state | distributed exactly-once delivery |
| Future executor | shell/file changes ใน boundary แยกตาม start authorization | การถือ subscription/Telegram credentials; ยังไม่เปิดใน MVP |

## Schway Core กับ Jit

**Reuse:** agent loop, provider-independent conversation/model/tool types, provider adapters และ auth renewal, semantic sessions/branches, compaction/context budgeting, tool execution semantics, cancellation และ bounded transport retries

**Jit owns:** project groups/topics, roles, conversation presentation, durable task/job lifecycle, project/cross-project memory, reminder scheduling, notification policy, API/Web/Telegram และ operational recovery ของ application

แต่ละ specialist analysis ใช้ run/context ที่แยกกัน ผ่าน Schway loop เดิม Jit สร้าง work plan และรับผล ไม่สร้าง Responses/tool/retry loop อีกชุด ผู้ประสานงานอาจใช้ model เพื่อสรุปผ่าน run เดียวกันตาม contract นี้

## Integration gap ที่ต้องทำให้เป็น public contract

ปัจจุบัน export ที่รับประกันมีเฉพาะ schway/extensions; core functions มีใน source แต่ private จึงเสนอ host API ที่แคบ ไม่ใช้ production deep import หรือ import CLI แล้วแอบดัดแปลง runtime

| Contract ที่เสนอ | Inputs/outputs เชิงสัญญา | ข้อจำกัด |
| --- | --- | --- |
| Runtime capabilities/version | contract version, supported routes/features, compatibility result | configured access ไม่ใช่ proof of inference |
| Session lifecycle | create/open/close, native conversation append, stable session reference | one writer ต่อ session; core เป็นเจ้าของ format/recovery |
| Run lifecycle | selected model/auth route, session, trusted context, tools, cancellation, finite limits → events + durable outcome references | ไม่มี loop ที่ provider เป็นเจ้าของ; ไม่โหลด TUI |
| Context source policy | trusted operator instructions กับ source documents แยกกัน; enable/disable workspace instruction/skill/package discovery อย่าง explicit | PR-controlled AGENTS.md, skills หรือ extensions ไม่ถูก autoload |
| Tool registration/selection | host-supplied tool registry และ schemas, scoped capabilities | selected registry เป็น enforcement; approval mode เป็นอีกชั้น |
| Credential route management | opaque credential identity, readiness/renewal state, trusted setup lifecycle | secret values ไม่ไป model หรือ API clients |
| Outcome/usage | normalized events, final/cancel/error/max-round outcome, session/report refs, usage completeness | delta/agent.finished ไม่ใช่ verified application completion |

ชื่อ methods และ package entry point เป็นงาน API spec ภายหลัง ก่อน merge API ต้องผ่าน Schway public-surface tests, type declarations, lazy-provider/headless tests และ compatibility review

**ข้อควรระวังที่พบจริง:** context manager ปัจจุบันค้นหา project AGENTS.md และ skills และ CLI สร้าง built-in tools ครบชุด การใช้ headless read-only อย่างเดียวจึงไม่ใช่ Jit host policy ที่เพียงพอ ไม่เสนอแก้ปัญหาด้วยการให้ extension เปลี่ยน source code ของ runtime

CLI JSONL ใช้เป็น reference/prototype transport ได้เมื่อทดสอบ feasibility แต่ไม่ใช่ข้อสรุปว่าคุม context/tool registry หรือให้ durable recovery ตาม PRD ได้แล้ว

## Domain model และแหล่งความจริง

คำศัพท์ canonical อยู่ [CONTEXT.md](../../CONTEXT.md)

| Entity | ข้อมูลหลัก | ความสัมพันธ์/กติกา |
| --- | --- | --- |
| Project | ID, name, authorized repo/resources, settings version | มีหนึ่ง ProjectGroup; repo binding แก้แบบตรวจ revision |
| Group/Topic | project, topic, display messages, user decisions | ข้อความทุกแหล่งมี identity และ source |
| RoleAssignment | role, responsibility, model, auth route, enabled state | ผู้ใช้ตั้ง; model เลือก billing ใหม่ไม่ได้ |
| TaskProposal / Task | content, project, state, revision, owner acceptance, completion policy | proposal ไม่เป็น obligation จน accepted; state transitions audit ได้ |
| Decision | selected proposal revision, actor, rationale, source | agent recommendation ไม่เป็น user decision |
| MemoryClaim | origin, source refs, explicit/inferred, confidence metadata, valid/suppressed generation | cross-project retrieval ไม่ลบ origin |
| Owner preferences | explicit role/model assignments และกติกาทั่วไปที่ owner ตั้ง | แยกจาก learned inference; memory ไม่เขียนทับ authority/configuration |
| Job / Attempt | purpose, authorization ref, priority, input revision, lease, generation, deadline, outcome | หนึ่ง job มีหลาย attempts; late attempts ไม่มีสิทธิ์ commit |
| Review / Finding | repo/PR/base/head, scope manifest, evidence, status, finding revisions | report เก่าคงดูได้แต่ stale ชัดเจน |
| ChannelBinding / Command | owner identity, chat/project/topic, request ID, actor, payload revision | ingress ทุกทางเข้า application command path เดียว |
| OutboxItem | logical notification key, payload ref, queued/sending/sent/failed/unknown | provider acceptance/remote delivery ไม่เหมือน local intent |

**App source of truth:** เสนอ SQLite transaction store สำหรับ project/group/task/job/memory/inbox/outbox และ bounded metadata audit ส่วน Schway sessions เป็น source of truth ของ native model conversation ไม่ย้าย wire payload มาเป็น canonical group schema

Group messages มี presentation และ attribution ของสมาชิก พร้อม run/session references และ committed output; ไม่ให้ทุก specialist เขียนลง engine session เดียวร่วมกัน คำตอบที่แสดงเป็น provisional จน native attempt และ app commit ยืนยัน

## Persistence และ concurrency

เสนอ SQLite บน local disk, migrations แบบ versioned, bounded transactions และ app writer ที่ serialize การเปลี่ยน revision ข้อมูลใหญ่/engine transcripts อยู่ใน managed files พร้อม references ไม่สร้าง event-sourcing framework เต็มรูปแบบ

Command transaction ต้องบันทึก inbox/deduplication key, state transition, audit metadata และ outbox intent ร่วมกัน Schway session append กับ SQLite commit ไม่ใช่ transaction เดียว จึงต้องเก็บ pending attempt/session references แล้ว reconcile กรณี crash ระหว่างสอง store ผลที่ session บันทึกแล้วแต่ app ยังไม่ commit จะไม่กลายเป็น accepted task mutation โดยอัตโนมัติ

ใช้ job leases และ attempt/generation fencing เพื่อไม่รับผลจาก worker เก่า service instance ที่สองต้องไม่แย่งเป็น session writer อย่างเงียบ ๆ cancellation, deletion และ revision supersession เปลี่ยน generation ก่อนรับ late callbacks

Operational state ที่เสนอ:

- Job: queued → running → succeeded / partial / waiting_user / waiting_connection / failed / cancelled / superseded
- Task: proposed → accepted → ready_for_review / completed / cancelled; running ใช้กับ phase execution ในอนาคต
- Finding: suspected / actionable / dismissed / superseded; severity/confidence ไม่ใช่ completion state
- Notification: queued → sending → sent / failed / unknown

Transitions ต้องมี authorized actor และ expected revision ไม่ให้ model เขียนสถานะตามข้อความ free-form โดยตรง

## Project memory และ context

1. อ่าน committed sources และ decisions/tasks ที่ยังมีผล
2. สกัด claim ที่มี source พร้อมแยก explicit fact, project-specific fact และ inference
3. ตรวจ conflicts, suppression/deletion และ source generation ก่อน publish
4. retrieve จาก project ปัจจุบันก่อน แล้วเลือก cross-project claims ที่เกี่ยวข้องภายใต้ context budget
5. แสดง provenance เมื่อ inference มีผลสำคัญ และเก็บว่า run ใช้ claim revision ใด

เสนอ structured retrieval + lexical search เป็น baseline ก่อนเลือก embeddings ต้องทดลอง Thai/English tokenization และ paraphrase recall ไม่อ้างว่า lexical index ทำ semantic memory ได้ครบ

Context คือข้อมูลที่เลือกให้ run หนึ่งครั้ง ส่วน memory คือ claim ที่เก็บต่อเนื่อง และ owner preferences คือการตั้งค่า/คำสั่งที่ผู้ใช้ให้โดยตรง การเรียนรู้ใน MVP ปรับ retained claims และบริบทที่เลือกใช้ ไม่ฝึก model weights หรือเปลี่ยน execution policy เอง

Correction invalidate dependent claims/indices/context snapshots ส่วน forget ต้องรักษา suppression lineage ข้าม project และ extraction generations ไม่เพียงลบแถว memory แล้วสรุปกลับใหม่จาก transcript เก่า

Schway session ที่เคยมีเนื้อหาที่ลืมอาจ replay เนื้อหาเดิมได้ จึงต้อง retire affected model contexts/sessions และสร้างบริบทใหม่จาก sources ที่อนุญาต โดยไม่ rewrite append-only Schway history ผู้ใช้ยังเปิดต้นฉบับที่เก็บไว้ได้ผ่าน history view แต่ไม่ถูก feed กลับอัตโนมัติ

Explicit delete ทำ preview ของ source records, derivatives, cache, managed snapshots และ affected engine sessions ก่อนลบ ถ้าไม่สามารถแยกเนื้อหาจาก native session ได้ ต้องลบ affected session ทั้งหน่วยหรือรายงาน blocker ไม่อ้างว่าลบครบทั้งที่ provider replay metadata ยังอยู่ การเก็บ source ที่เหลือและสร้าง session ใหม่เป็นคนละการกระทำกับแก้ native format

คำสั่งลืมที่ชน active task/decision ต้อง resolve operation scope ก่อน: การลบ derived claim ไม่ยกเลิก task หรือถอน user decision โดยปริยาย การลบ source เหล่านั้นต้องอยู่ใน explicit deletion preview

## PR review pipeline

1. Poll configured repositories พร้อม persisted cursor/conditional requests และ API limits
2. ยืนยัน PR readiness กับ base/head SHA แล้วสร้าง logical review key
3. ดึง immutable contents และ references ผ่าน allowlisted connector; ไม่ checkout/run hooks หรือ install repository code
4. เก็บ scope manifest และ input generation; PR texts/AGENTS/comments/CI logs ทั้งหมดเป็น untrusted data
5. รัน relevant specialist analyses แยกกัน แล้ว coordinator สรุป findings/evidence
6. ตรวจ schema, sources, revision และ scope ก่อน commit report; structural validation ไม่ได้พิสูจน์ว่าข้อค้นพบถูกจริง
7. สร้าง private notification เฉพาะ finding ที่ผ่าน policy; update/rebase ใหม่ทำให้ report เดิม stale

Source fetch ที่ incomplete ต้องสร้าง partial/incomplete result ไม่ส่ง “ตรวจแล้วไม่มีปัญหา” PR draft/ready/update/closed/reopened และ target-base change ต้องมี fixtures ก่อนล็อก trigger policy

MVP ปิด provider-hosted web search/lookup และไม่มี arbitrary web_fetch registry เพื่อคุม external recipients ตามขอบเขตที่ตกลง การเปิด read-only hosted lookup ของ Schway ในอนาคตไม่เปิดความสามารถนั้นให้ Jit โดยอัตโนมัติ

## Channels และ delivery

เสนอ HTTP command/query API และ resumable event stream สำหรับ Web โดย transport/library ยังเลือกได้ API mutations มี request ID และ expected revision ส่วน live stream ใช้แสดง progress จาก durable state ไม่ใช้แทน persistence

เสนอ Telegram bot เดียวแบบ private companion channel ใน MVP; เป็น implementation preference ไม่ใช่ข้อจำกัดว่าต้องมี bot account ต่อ specialist ผูก user/chat IDs ผ่าน setup บน Web แล้วทุก command resolve project/topic ชัดเจน

Long polling ไม่ต้องเปิด public webhook แต่ updates มี retention สูงสุด 24 ชั่วโมงตาม [Bot API](https://core.telegram.org/bots/api#getting-updates) จึง persist inbox ก่อน advance offset หาก offline นานต้องแจ้ง possible input gap และให้ผู้ใช้ตรวจ/ส่งใหม่ ไม่อ้าง replay ประวัติที่ bot ไม่ได้รับ

Outbox ป้องกัน logical notification ซ้ำได้ แต่กรณี request timeout หลัง Telegram รับแล้วอาจไม่รู้ผล delivery ให้เป็น unknown หยุด blind retry และแสดงใน Web พร้อมทางเลือกส่งใหม่ ไม่ประกาศ exactly-once กับ external API

## Scheduling, priority และ recovery

- schedules ระบุ timezone, next occurrence และ misfire policy; เสนอ coalesce missed summary/reminder เป็นรายการเดียว ไม่ burst ทุกนัด
- interactive admission มาก่อน queued background work; running model call yield ได้ตาม cancellation/round boundary ไม่สัญญา immediate preemption
- bounds ครอบคลุม chain hops, specialist count, model rounds, queued jobs, retries, deadline, context/output bytes และ disk watermarks
- transient model retry ใช้ Schway policy ส่วน job retry พิจารณา input freshness/authorization/remaining budget โดยไม่คูณ retries ไม่สิ้นสุด
- quota/auth ใช้ต่อไม่ได้ให้ waiting_connection/needs_attention; role routing ไม่เปลี่ยน provider/billing เอง
- reboot reconcile attempts, report commits, cursor และ outbox; readonly job อาจ restart ได้ ส่วน execution side effects ในอนาคตต้องตรวจ evidence ก่อน

## Deployment และ credentials

Target ที่ยืนยันคือ Pi 5/Ubuntu ARM64 และ local storage รายงาน host snapshot อยู่ใน sources ยังไม่มี readiness claim

เสนอ dedicated service identity, Linux service supervisor, persistent app directory และ network bind ที่เข้าถึงผ่าน VPN พร้อม owner authentication เปิด outward connections ไป configured providers, GitHub และ Telegram ตาม purpose ห้าม model เลือก arbitrary LAN/loopback destinations

Boot credential access เป็น requirement ที่ยืนยัน แต่กลไกยังเป็น feasibility gate: Schway ใช้ Bun.secrets บน Linux ซึ่งต้องมี libsecret/Secret Service; SSH login ไม่รับรองว่า service หลัง reboot อ่านและ refresh token ได้ ต้องพิสูจน์โดยใช้ identity ของ service จริง ไม่มีการ copy secrets จาก CLI อื่นหรือ plaintext fallback เงียบ ๆ

Credentials อยู่กับ trusted service/provider clients ไม่ใส่ role prompts, group state, reports หรือ future executor ระบบนี้ไม่อ้างป้องกัน administrator ของ host ที่ยึดได้แล้ว

Backup ต้อง snapshot SQLite อย่าง consistent พร้อม managed files/session manifests ไม่ copy database ที่มี WAL แบบไม่ตรวจ consistency ใช้ generation/checkpoint และ quarantine restore จนตรวจ deletion ledger กับ outstanding jobs เสร็จ ดู [SQLite backup](https://www.sqlite.org/backup.html)

หาก restore จาก backup เก่าแล้วไม่มี ledger ล่าสุดที่ยืนยันการลืม/ลบได้ ต้องคง quarantine และหยุด automatic extraction/context assembly/notifications จน reconcile กับ owner หรือแหล่ง ledger ที่เชื่อถือได้ ไม่อ้างกู้ deletion state ที่หายไปเอง กลไกเก็บ ledger นอก restore point ต้องล็อกใน backup spec

## Proposed feature-spec sequence

runtime/auth feasibility → Schway host contract → app state/commands → Web + team chat → memory/tasks → read-only PR pipeline → Telegram/schedules → recovery/backup/pilot

Dependency และ effort อยู่ใน [roadmap](07-roadmap.md); รายการนี้ไม่ใช่คำสั่งเริ่ม implementation
