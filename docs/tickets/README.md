# MVP implementation backlog

สถานะ ณ 18 ตุลาคม 2026: สร้าง implementation/verification tickets ครบ 43 ใบจาก specs ที่ยืนยันแล้ว แบ่งเป็น Jit 34 และ Schway 9 ใบ ยังไม่มี implementation claims และยังไม่ได้เริ่ม application/runtime

39 ใบใช้ `ready-for-agent` หลัง prerequisite และ ownership checks ผ่าน อีก 4 ใบใช้ `ready-for-human` สำหรับ host/account/reboot/pilot evidence Label ไม่ได้แปลว่าเริ่มทุกงานพร้อมกันได้

## Specs และที่มา

- [MVP / Jit #1](https://github.com/chayapats/jit/issues/1): product slices, bridge และ operations 29 ใบ

- [S01 / Jit #2](https://github.com/chayapats/jit/issues/2): deterministic feasibility tooling และ human observations 5 ใบ

- [S02 / Schway #393](https://github.com/chayapats/schway/issues/393): supported host contract 9 ใบ

- [PRD](../product/02-prd.md), [spec index](../specs/README.md), [ticket workflow](../agents/workflow.md)

## จุดเริ่มต้น

เริ่มได้ที่ [APP01](https://github.com/chayapats/jit/issues/3) (authenticated Web + durable project group) และ [ENG01](https://github.com/chayapats/schway/issues/395) (public scripted host consumer) ซึ่งไม่มี implementation blockers ในชุดนี้ ใช้ issue worktree/claim ตาม workflow ก่อนลงมือ พร้อมตรวจ comments, assignees และ PRs ปัจจุบัน การแตก tickets ไม่ได้ claim งานให้ agent ใด

Dependency graph ตรวจแล้วไม่มีวงจร มี native GitHub sub-issue links 43 รายการ และ blocking edges 61 รายการ เชื่อมข้าม repo โดยใช้ issue database IDs จริง รายการด้านล่างแสดง direct blockers หลังตัดเส้นที่ซ้ำผ่าน dependency ทางอ้อม Contract ที่ใช้ทั้งหมดและเจ้าของแต่ละ version อยู่ใน issue และ [machine-readable snapshot](mvp.json)

การปิด upstream issue ยังไม่พอ: downstream ต้องตรวจว่า supported public contract/version หรือ immutable tested artifact อยู่ใน integration base แล้ว ห้ามใช้ private Schway imports เพื่อข้าม gate

## Tickets

### Application

| Ticket | ผลลัพธ์ | Direct blockers | ผู้ทำ |
| --- | --- | --- | --- |
| [APP01](https://github.com/chayapats/jit/issues/3) | Owner เปิด Web ที่ยืนยันตัวตนและสร้าง project group ที่คงอยู่หลัง restart ได้ | ไม่มี | Agent |
| [APP02](https://github.com/chayapats/jit/issues/4) | Owner คุยและกลับมาเปิด topic/history ของแต่ละ project ได้โดยบริบทไม่ปะปน | [APP01](https://github.com/chayapats/jit/issues/3) | Agent |

### Teams and decisions

| Ticket | ผลลัพธ์ | Direct blockers | ผู้ทำ |
| --- | --- | --- | --- |
| [TEAM01](https://github.com/chayapats/jit/issues/8) | Owner ตั้ง specialist/model route และทดลอง role ผ่าน scripted host ได้โดยเห็นสถานะจริง | [APP02](https://github.com/chayapats/jit/issues/4) | Agent |
| [TEAM02](https://github.com/chayapats/jit/issues/11) | ข้อความใน topic เรียกทีมที่เกี่ยวข้องมาวิเคราะห์แยกอย่างมีขอบเขตและหยุดได้ | [JOB02](https://github.com/chayapats/jit/issues/9) | Agent |
| [TEAM03](https://github.com/chayapats/jit/issues/14) | Coordinator สรุปข้อขัดแย้งและบันทึกเฉพาะ decision revision ที่ owner เลือก | [TEAM02](https://github.com/chayapats/jit/issues/11) | Agent |

### Tasks and continuity

| Ticket | ผลลัพธ์ | Direct blockers | ผู้ทำ |
| --- | --- | --- | --- |
| [TASK01](https://github.com/chayapats/jit/issues/16) | ข้อเสนองานกลายเป็น accepted task เฉพาะ owner รับรอง revision นั้นและไม่เริ่ม execution | [TEAM03](https://github.com/chayapats/jit/issues/14) | Agent |
| [TASK02](https://github.com/chayapats/jit/issues/20) | Owner ตรวจงานค้างและปิดงานด้วยหลักฐานตาม completion policy ได้ข้ามวัน | [TASK01](https://github.com/chayapats/jit/issues/16) | Agent |

### Memory lifecycle

| Ticket | ผลลัพธ์ | Direct blockers | ผู้ทำ |
| --- | --- | --- | --- |
| [MEM01](https://github.com/chayapats/jit/issues/23) | Jit เก็บ memory claims จาก committed sources พร้อมที่มาและแยก fact/inference | [TASK02](https://github.com/chayapats/jit/issues/20) | Agent |
| [MEM02](https://github.com/chayapats/jit/issues/26) | ถามต่อข้ามวันได้ด้วย current project state และ cross-project memory ที่รักษาที่มา | [MEM01](https://github.com/chayapats/jit/issues/23) | Agent |
| [MEM03](https://github.com/chayapats/jit/issues/28) | Owner แก้ memory ผิดแล้ว derivatives และ context ทุกโครงการใช้ revision ใหม่ | [MEM02](https://github.com/chayapats/jit/issues/26) | Agent |
| [MEM04](https://github.com/chayapats/jit/issues/29) | คำสั่งลืมถอน derived memory และกันประวัติเก่าถูกสกัดหรือ replay กลับมาเอง | [MEM03](https://github.com/chayapats/jit/issues/28) | Agent |
| [MEM05](https://github.com/chayapats/jit/issues/30) | Owner preview และลบ local data พร้อม derivatives/managed sessions โดยไม่คืนข้อมูลผ่าน late work | [MEM04](https://github.com/chayapats/jit/issues/29), [OPS01](https://github.com/chayapats/jit/issues/18) | Agent |

### Jobs and schedules

| Ticket | ผลลัพธ์ | Direct blockers | ผู้ทำ |
| --- | --- | --- | --- |
| [JOB01](https://github.com/chayapats/jit/issues/6) | Admit durable interactive and background work with finite budgets | [APP01](https://github.com/chayapats/jit/issues/3) | Agent |
| [JOB02](https://github.com/chayapats/jit/issues/9) | Fence cancelled and interrupted attempts and reconcile native run references | [JOB01](https://github.com/chayapats/jit/issues/6), [TEAM01](https://github.com/chayapats/jit/issues/8) | Agent |
| [JOB03](https://github.com/chayapats/jit/issues/27) | Run owner-configured reminders and summaries with timezone and misfire controls | [MEM02](https://github.com/chayapats/jit/issues/26), [TG03](https://github.com/chayapats/jit/issues/13) | Agent |

### Static PR review

| Ticket | ผลลัพธ์ | Direct blockers | ผู้ทำ |
| --- | --- | --- | --- |
| [PR01](https://github.com/chayapats/jit/issues/10) | Monitor allowed repositories and capture revision-bound static review inputs | [JOB02](https://github.com/chayapats/jit/issues/9) | Agent |
| [PR02](https://github.com/chayapats/jit/issues/19) | Commit evidence-based static PR reports with coverage and currentness | [JBR01](https://github.com/chayapats/jit/issues/15), [PR01](https://github.com/chayapats/jit/issues/10), [TEAM03](https://github.com/chayapats/jit/issues/14) | Agent |
| [PR03](https://github.com/chayapats/jit/issues/24) | Notify the owner only about current actionable PR findings | [PR02](https://github.com/chayapats/jit/issues/19), [TG03](https://github.com/chayapats/jit/issues/13) | Agent |

### Telegram

| Ticket | ผลลัพธ์ | Direct blockers | ผู้ทำ |
| --- | --- | --- | --- |
| [TG01](https://github.com/chayapats/jit/issues/12) | Bind the numeric Telegram owner and durably ingest authorized updates | [JOB02](https://github.com/chayapats/jit/issues/9) | Agent |
| [TG02](https://github.com/chayapats/jit/issues/21) | Run Telegram project commands and task acceptance through the shared app boundary | [TASK01](https://github.com/chayapats/jit/issues/16), [TG01](https://github.com/chayapats/jit/issues/12), [TG03](https://github.com/chayapats/jit/issues/13) | Agent |
| [TG03](https://github.com/chayapats/jit/issues/13) | Persist private delivery intents and show sent, failed and unknown outcomes | [JOB02](https://github.com/chayapats/jit/issues/9) | Agent |

### Recovery, deployment and pilot

| Ticket | ผลลัพธ์ | Direct blockers | ผู้ทำ |
| --- | --- | --- | --- |
| [OPS01](https://github.com/chayapats/jit/issues/18) | Create consistent managed backups with versioned manifests and inventory | [JBR01](https://github.com/chayapats/jit/issues/15), [JOB02](https://github.com/chayapats/jit/issues/9) | Agent |
| [OPS02](https://github.com/chayapats/jit/issues/33) | Restore in quarantine until current lifecycle and job reconciliation pass | [OPS06](https://github.com/chayapats/jit/issues/32) | Agent |
| [OPS03](https://github.com/chayapats/jit/issues/31) | Export inspectable project data without secrets or resurrected deleted content | [MEM05](https://github.com/chayapats/jit/issues/30) | Agent |
| [OPS04](https://github.com/chayapats/jit/issues/34) | Provide bounded operating diagnostics and a repeatable full-application load drill | [JOB03](https://github.com/chayapats/jit/issues/27), [OPS02](https://github.com/chayapats/jit/issues/33), [OPS03](https://github.com/chayapats/jit/issues/31), [PR03](https://github.com/chayapats/jit/issues/24), [TG02](https://github.com/chayapats/jit/issues/21) | Agent |
| [OPS05](https://github.com/chayapats/jit/issues/36) | Validate the bounded full-app Pi profile and hand the pilot to the owner | [FEAS05](https://github.com/chayapats/jit/issues/25), [OPS07](https://github.com/chayapats/jit/issues/35) | Human |
| [OPS06](https://github.com/chayapats/jit/issues/32) | Upgrade an installation through staged schema migration with a recoverable prior version | [MEM05](https://github.com/chayapats/jit/issues/30), [TG03](https://github.com/chayapats/jit/issues/13) | Agent |
| [OPS07](https://github.com/chayapats/jit/issues/35) | Package the full Jit Linux service for private unattended start, stop and supported upgrades | [OPS04](https://github.com/chayapats/jit/issues/34) | Agent |

### Production Schway bridge

| Ticket | ผลลัพธ์ | Direct blockers | ผู้ทำ |
| --- | --- | --- | --- |
| [JBR01](https://github.com/chayapats/jit/issues/15) | Bridge: run the configured specialist through Schway's supported host contract | [ENG09](https://github.com/chayapats/schway/issues/403), [TEAM01](https://github.com/chayapats/jit/issues/8) | Agent |

### Pi and account feasibility

| Ticket | ผลลัพธ์ | Direct blockers | ผู้ทำ |
| --- | --- | --- | --- |
| [FEAS01](https://github.com/chayapats/jit/issues/5) | Feasibility: emit sanitized host inventory and versioned evidence records | [APP01](https://github.com/chayapats/jit/issues/3) | Agent |
| [FEAS02](https://github.com/chayapats/jit/issues/17) | Feasibility: run bounded selected-route service probes with sanitized results | [FEAS01](https://github.com/chayapats/jit/issues/5), [JBR01](https://github.com/chayapats/jit/issues/15) | Agent |
| [FEAS03](https://github.com/chayapats/jit/issues/7) | Feasibility: provision and verify the Pi ARM64 service context with the owner | [FEAS01](https://github.com/chayapats/jit/issues/5) | Human |
| [FEAS04](https://github.com/chayapats/jit/issues/22) | Feasibility: observe Grok and Codex subscription access in the Pi service identity | [FEAS02](https://github.com/chayapats/jit/issues/17), [FEAS03](https://github.com/chayapats/jit/issues/7) | Human |
| [FEAS05](https://github.com/chayapats/jit/issues/25) | Feasibility: prove unattended boot, interrupted probes and route readiness on Pi | [FEAS04](https://github.com/chayapats/jit/issues/22) | Human |

### Schway host contract

| Ticket | ผลลัพธ์ | Direct blockers | ผู้ทำ |
| --- | --- | --- | --- |
| [ENG01](https://github.com/chayapats/schway/issues/395) | Host: embed one scripted durable turn through a supported public entry | ไม่มี | Agent |
| [ENG02](https://github.com/chayapats/schway/issues/396) | Host: keep repository instructions, skills and packages inert in strict review runs | [ENG01](https://github.com/chayapats/schway/issues/395) | Agent |
| [ENG03](https://github.com/chayapats/schway/issues/399) | Host: enforce the exact supplied tool registry and disable hosted lookups | [ENG02](https://github.com/chayapats/schway/issues/396) | Agent |
| [ENG04](https://github.com/chayapats/schway/issues/397) | Host: accept durable input under one native-session writer and reopen its ancestry | [ENG01](https://github.com/chayapats/schway/issues/395) | Agent |
| [ENG05](https://github.com/chayapats/schway/issues/398) | Host: use explicit Grok/Codex routes with opaque shared credential lifecycle | [ENG01](https://github.com/chayapats/schway/issues/395) | Agent |
| [ENG06](https://github.com/chayapats/schway/issues/400) | Host: bound, cancel and settle embedded runs with honest terminal outcomes | [ENG04](https://github.com/chayapats/schway/issues/397) | Agent |
| [ENG07](https://github.com/chayapats/schway/issues/401) | Host: retire and delete managed native sessions without stale writers | [ENG06](https://github.com/chayapats/schway/issues/400) | Agent |
| [ENG08](https://github.com/chayapats/schway/issues/402) | Host: snapshot and validate restore of quiesced managed native state | [ENG07](https://github.com/chayapats/schway/issues/401) | Agent |
| [ENG09](https://github.com/chayapats/schway/issues/403) | Host: ship and verify a versioned consumer package for Jit | [ENG03](https://github.com/chayapats/schway/issues/399), [ENG05](https://github.com/chayapats/schway/issues/398), [ENG08](https://github.com/chayapats/schway/issues/402) | Agent |

## Requirement traceability

ตารางนี้หมายถึงมี ticket รับผิดชอบ requirement แล้ว ไม่ได้หมายความว่า implementation หรือ acceptance ผ่านครบ การรับรอง release ยังต้องมี evidence จาก deterministic checks และ human gates แยกกัน

| Requirement | Tickets |
| --- | --- |
| FR-01 | [APP01](https://github.com/chayapats/jit/issues/3), [APP02](https://github.com/chayapats/jit/issues/4), [TEAM02](https://github.com/chayapats/jit/issues/11), [TG02](https://github.com/chayapats/jit/issues/21) |
| FR-02 | [ENG01](https://github.com/chayapats/schway/issues/395), [ENG02](https://github.com/chayapats/schway/issues/396), [ENG04](https://github.com/chayapats/schway/issues/397), [ENG09](https://github.com/chayapats/schway/issues/403), [JBR01](https://github.com/chayapats/jit/issues/15), [MEM02](https://github.com/chayapats/jit/issues/26), [PR02](https://github.com/chayapats/jit/issues/19), [TEAM01](https://github.com/chayapats/jit/issues/8), [TEAM02](https://github.com/chayapats/jit/issues/11) |
| FR-03 | [JBR01](https://github.com/chayapats/jit/issues/15), [MEM02](https://github.com/chayapats/jit/issues/26), [PR02](https://github.com/chayapats/jit/issues/19), [TEAM03](https://github.com/chayapats/jit/issues/14) |
| FR-04 | [APP02](https://github.com/chayapats/jit/issues/4), [ENG04](https://github.com/chayapats/schway/issues/397), [MEM01](https://github.com/chayapats/jit/issues/23), [MEM02](https://github.com/chayapats/jit/issues/26), [MEM04](https://github.com/chayapats/jit/issues/29), [OPS03](https://github.com/chayapats/jit/issues/31), [OPS06](https://github.com/chayapats/jit/issues/32), [TASK01](https://github.com/chayapats/jit/issues/16), [TASK02](https://github.com/chayapats/jit/issues/20), [TEAM03](https://github.com/chayapats/jit/issues/14) |
| FR-05 | [MEM01](https://github.com/chayapats/jit/issues/23), [MEM02](https://github.com/chayapats/jit/issues/26), [MEM03](https://github.com/chayapats/jit/issues/28), [MEM04](https://github.com/chayapats/jit/issues/29), [MEM05](https://github.com/chayapats/jit/issues/30), [OPS03](https://github.com/chayapats/jit/issues/31) |
| FR-06 | [TASK01](https://github.com/chayapats/jit/issues/16), [TG02](https://github.com/chayapats/jit/issues/21) |
| FR-07 | [ENG06](https://github.com/chayapats/schway/issues/400), [JOB01](https://github.com/chayapats/jit/issues/6), [JOB02](https://github.com/chayapats/jit/issues/9), [JOB03](https://github.com/chayapats/jit/issues/27), [PR02](https://github.com/chayapats/jit/issues/19), [PR03](https://github.com/chayapats/jit/issues/24), [TASK02](https://github.com/chayapats/jit/issues/20), [TEAM03](https://github.com/chayapats/jit/issues/14), [TG02](https://github.com/chayapats/jit/issues/21), [TG03](https://github.com/chayapats/jit/issues/13) |
| FR-08 | [ENG03](https://github.com/chayapats/schway/issues/399), [PR01](https://github.com/chayapats/jit/issues/10), [PR02](https://github.com/chayapats/jit/issues/19), [PR03](https://github.com/chayapats/jit/issues/24) |
| FR-09 | [PR02](https://github.com/chayapats/jit/issues/19), [PR03](https://github.com/chayapats/jit/issues/24), [TG03](https://github.com/chayapats/jit/issues/13) |
| FR-10 | [APP01](https://github.com/chayapats/jit/issues/3), [APP02](https://github.com/chayapats/jit/issues/4), [JBR01](https://github.com/chayapats/jit/issues/15), [JOB01](https://github.com/chayapats/jit/issues/6), [JOB03](https://github.com/chayapats/jit/issues/27), [MEM01](https://github.com/chayapats/jit/issues/23), [MEM02](https://github.com/chayapats/jit/issues/26), [OPS04](https://github.com/chayapats/jit/issues/34), [OPS05](https://github.com/chayapats/jit/issues/36), [OPS07](https://github.com/chayapats/jit/issues/35), [PR01](https://github.com/chayapats/jit/issues/10), [PR03](https://github.com/chayapats/jit/issues/24), [TASK01](https://github.com/chayapats/jit/issues/16), [TASK02](https://github.com/chayapats/jit/issues/20), [TEAM01](https://github.com/chayapats/jit/issues/8), [TEAM02](https://github.com/chayapats/jit/issues/11), [TEAM03](https://github.com/chayapats/jit/issues/14), [TG01](https://github.com/chayapats/jit/issues/12), [TG02](https://github.com/chayapats/jit/issues/21) |
| FR-11 | [TASK01](https://github.com/chayapats/jit/issues/16), [TG01](https://github.com/chayapats/jit/issues/12), [TG02](https://github.com/chayapats/jit/issues/21), [TG03](https://github.com/chayapats/jit/issues/13) |
| FR-12 | [JOB03](https://github.com/chayapats/jit/issues/27) |
| FR-13 | [ENG01](https://github.com/chayapats/schway/issues/395), [ENG05](https://github.com/chayapats/schway/issues/398), [ENG09](https://github.com/chayapats/schway/issues/403), [FEAS01](https://github.com/chayapats/jit/issues/5), [FEAS02](https://github.com/chayapats/jit/issues/17), [FEAS03](https://github.com/chayapats/jit/issues/7), [FEAS04](https://github.com/chayapats/jit/issues/22), [FEAS05](https://github.com/chayapats/jit/issues/25), [JBR01](https://github.com/chayapats/jit/issues/15), [OPS05](https://github.com/chayapats/jit/issues/36), [OPS07](https://github.com/chayapats/jit/issues/35), [TEAM01](https://github.com/chayapats/jit/issues/8), [TEAM02](https://github.com/chayapats/jit/issues/11) |
| FR-14 | [ENG06](https://github.com/chayapats/schway/issues/400), [ENG09](https://github.com/chayapats/schway/issues/403), [FEAS02](https://github.com/chayapats/jit/issues/17), [FEAS05](https://github.com/chayapats/jit/issues/25), [JBR01](https://github.com/chayapats/jit/issues/15), [JOB01](https://github.com/chayapats/jit/issues/6), [JOB03](https://github.com/chayapats/jit/issues/27), [MEM01](https://github.com/chayapats/jit/issues/23), [MEM02](https://github.com/chayapats/jit/issues/26), [OPS04](https://github.com/chayapats/jit/issues/34), [OPS05](https://github.com/chayapats/jit/issues/36), [OPS07](https://github.com/chayapats/jit/issues/35), [PR01](https://github.com/chayapats/jit/issues/10), [TEAM01](https://github.com/chayapats/jit/issues/8), [TEAM02](https://github.com/chayapats/jit/issues/11), [TEAM03](https://github.com/chayapats/jit/issues/14) |
| FR-15 | [APP01](https://github.com/chayapats/jit/issues/3), [ENG01](https://github.com/chayapats/schway/issues/395), [ENG04](https://github.com/chayapats/schway/issues/397), [ENG06](https://github.com/chayapats/schway/issues/400), [ENG09](https://github.com/chayapats/schway/issues/403), [FEAS01](https://github.com/chayapats/jit/issues/5), [FEAS02](https://github.com/chayapats/jit/issues/17), [FEAS03](https://github.com/chayapats/jit/issues/7), [FEAS04](https://github.com/chayapats/jit/issues/22), [FEAS05](https://github.com/chayapats/jit/issues/25), [JBR01](https://github.com/chayapats/jit/issues/15), [JOB01](https://github.com/chayapats/jit/issues/6), [JOB02](https://github.com/chayapats/jit/issues/9), [JOB03](https://github.com/chayapats/jit/issues/27), [MEM01](https://github.com/chayapats/jit/issues/23), [MEM03](https://github.com/chayapats/jit/issues/28), [MEM04](https://github.com/chayapats/jit/issues/29), [MEM05](https://github.com/chayapats/jit/issues/30), [OPS01](https://github.com/chayapats/jit/issues/18), [OPS02](https://github.com/chayapats/jit/issues/33), [OPS04](https://github.com/chayapats/jit/issues/34), [OPS05](https://github.com/chayapats/jit/issues/36), [OPS06](https://github.com/chayapats/jit/issues/32), [OPS07](https://github.com/chayapats/jit/issues/35), [PR01](https://github.com/chayapats/jit/issues/10), [PR02](https://github.com/chayapats/jit/issues/19), [PR03](https://github.com/chayapats/jit/issues/24), [TASK01](https://github.com/chayapats/jit/issues/16), [TEAM02](https://github.com/chayapats/jit/issues/11), [TEAM03](https://github.com/chayapats/jit/issues/14), [TG01](https://github.com/chayapats/jit/issues/12), [TG02](https://github.com/chayapats/jit/issues/21), [TG03](https://github.com/chayapats/jit/issues/13) |
| FR-16 | [ENG02](https://github.com/chayapats/schway/issues/396), [ENG07](https://github.com/chayapats/schway/issues/401), [ENG08](https://github.com/chayapats/schway/issues/402), [ENG09](https://github.com/chayapats/schway/issues/403), [JBR01](https://github.com/chayapats/jit/issues/15), [JOB02](https://github.com/chayapats/jit/issues/9), [MEM03](https://github.com/chayapats/jit/issues/28), [MEM04](https://github.com/chayapats/jit/issues/29), [MEM05](https://github.com/chayapats/jit/issues/30), [OPS01](https://github.com/chayapats/jit/issues/18), [OPS02](https://github.com/chayapats/jit/issues/33), [OPS03](https://github.com/chayapats/jit/issues/31), [OPS05](https://github.com/chayapats/jit/issues/36), [OPS06](https://github.com/chayapats/jit/issues/32) |
| FR-17 | [APP01](https://github.com/chayapats/jit/issues/3), [APP02](https://github.com/chayapats/jit/issues/4), [ENG02](https://github.com/chayapats/schway/issues/396), [ENG03](https://github.com/chayapats/schway/issues/399), [ENG05](https://github.com/chayapats/schway/issues/398), [ENG09](https://github.com/chayapats/schway/issues/403), [FEAS02](https://github.com/chayapats/jit/issues/17), [JBR01](https://github.com/chayapats/jit/issues/15), [JOB03](https://github.com/chayapats/jit/issues/27), [MEM01](https://github.com/chayapats/jit/issues/23), [MEM02](https://github.com/chayapats/jit/issues/26), [MEM03](https://github.com/chayapats/jit/issues/28), [MEM04](https://github.com/chayapats/jit/issues/29), [MEM05](https://github.com/chayapats/jit/issues/30), [OPS07](https://github.com/chayapats/jit/issues/35), [PR01](https://github.com/chayapats/jit/issues/10), [PR02](https://github.com/chayapats/jit/issues/19), [TASK01](https://github.com/chayapats/jit/issues/16), [TEAM01](https://github.com/chayapats/jit/issues/8), [TEAM02](https://github.com/chayapats/jit/issues/11), [TEAM03](https://github.com/chayapats/jit/issues/14), [TG01](https://github.com/chayapats/jit/issues/12), [TG02](https://github.com/chayapats/jit/issues/21) |
| FR-18 | [ENG06](https://github.com/chayapats/schway/issues/400), [ENG07](https://github.com/chayapats/schway/issues/401), [ENG08](https://github.com/chayapats/schway/issues/402), [ENG09](https://github.com/chayapats/schway/issues/403), [JBR01](https://github.com/chayapats/jit/issues/15), [JOB01](https://github.com/chayapats/jit/issues/6), [JOB02](https://github.com/chayapats/jit/issues/9), [MEM02](https://github.com/chayapats/jit/issues/26), [MEM04](https://github.com/chayapats/jit/issues/29), [MEM05](https://github.com/chayapats/jit/issues/30), [OPS01](https://github.com/chayapats/jit/issues/18), [OPS02](https://github.com/chayapats/jit/issues/33), [OPS03](https://github.com/chayapats/jit/issues/31), [OPS04](https://github.com/chayapats/jit/issues/34), [OPS05](https://github.com/chayapats/jit/issues/36), [OPS06](https://github.com/chayapats/jit/issues/32), [OPS07](https://github.com/chayapats/jit/issues/35), [PR03](https://github.com/chayapats/jit/issues/24), [TASK02](https://github.com/chayapats/jit/issues/20), [TEAM02](https://github.com/chayapats/jit/issues/11), [TG03](https://github.com/chayapats/jit/issues/13) |
| NFR-01 | [ENG02](https://github.com/chayapats/schway/issues/396), [ENG03](https://github.com/chayapats/schway/issues/399), [JBR01](https://github.com/chayapats/jit/issues/15), [PR01](https://github.com/chayapats/jit/issues/10), [PR02](https://github.com/chayapats/jit/issues/19), [TASK01](https://github.com/chayapats/jit/issues/16), [TEAM01](https://github.com/chayapats/jit/issues/8), [TEAM02](https://github.com/chayapats/jit/issues/11) |
| NFR-02 | [ENG01](https://github.com/chayapats/schway/issues/395), [ENG02](https://github.com/chayapats/schway/issues/396), [ENG03](https://github.com/chayapats/schway/issues/399), [ENG04](https://github.com/chayapats/schway/issues/397), [ENG05](https://github.com/chayapats/schway/issues/398), [ENG06](https://github.com/chayapats/schway/issues/400), [ENG07](https://github.com/chayapats/schway/issues/401), [ENG08](https://github.com/chayapats/schway/issues/402), [ENG09](https://github.com/chayapats/schway/issues/403), [JBR01](https://github.com/chayapats/jit/issues/15), [OPS07](https://github.com/chayapats/jit/issues/35), [PR02](https://github.com/chayapats/jit/issues/19), [TEAM01](https://github.com/chayapats/jit/issues/8), [TEAM02](https://github.com/chayapats/jit/issues/11) |
| NFR-03 | [ENG01](https://github.com/chayapats/schway/issues/395), [ENG05](https://github.com/chayapats/schway/issues/398), [ENG09](https://github.com/chayapats/schway/issues/403), [JBR01](https://github.com/chayapats/jit/issues/15), [OPS07](https://github.com/chayapats/jit/issues/35), [PR02](https://github.com/chayapats/jit/issues/19), [TEAM01](https://github.com/chayapats/jit/issues/8) |
| NFR-04 | [FEAS01](https://github.com/chayapats/jit/issues/5), [FEAS02](https://github.com/chayapats/jit/issues/17), [FEAS03](https://github.com/chayapats/jit/issues/7), [FEAS04](https://github.com/chayapats/jit/issues/22), [FEAS05](https://github.com/chayapats/jit/issues/25), [OPS04](https://github.com/chayapats/jit/issues/34), [OPS05](https://github.com/chayapats/jit/issues/36), [OPS07](https://github.com/chayapats/jit/issues/35) |
| NFR-05 | [APP01](https://github.com/chayapats/jit/issues/3), [APP02](https://github.com/chayapats/jit/issues/4), [ENG04](https://github.com/chayapats/schway/issues/397), [ENG06](https://github.com/chayapats/schway/issues/400), [ENG07](https://github.com/chayapats/schway/issues/401), [ENG08](https://github.com/chayapats/schway/issues/402), [ENG09](https://github.com/chayapats/schway/issues/403), [JBR01](https://github.com/chayapats/jit/issues/15), [JOB01](https://github.com/chayapats/jit/issues/6), [JOB02](https://github.com/chayapats/jit/issues/9), [JOB03](https://github.com/chayapats/jit/issues/27), [MEM01](https://github.com/chayapats/jit/issues/23), [MEM02](https://github.com/chayapats/jit/issues/26), [MEM03](https://github.com/chayapats/jit/issues/28), [MEM04](https://github.com/chayapats/jit/issues/29), [MEM05](https://github.com/chayapats/jit/issues/30), [OPS01](https://github.com/chayapats/jit/issues/18), [OPS02](https://github.com/chayapats/jit/issues/33), [OPS04](https://github.com/chayapats/jit/issues/34), [OPS06](https://github.com/chayapats/jit/issues/32), [OPS07](https://github.com/chayapats/jit/issues/35), [PR01](https://github.com/chayapats/jit/issues/10), [PR03](https://github.com/chayapats/jit/issues/24), [TASK01](https://github.com/chayapats/jit/issues/16), [TASK02](https://github.com/chayapats/jit/issues/20), [TEAM02](https://github.com/chayapats/jit/issues/11), [TEAM03](https://github.com/chayapats/jit/issues/14), [TG01](https://github.com/chayapats/jit/issues/12), [TG03](https://github.com/chayapats/jit/issues/13) |
| NFR-06 | [ENG06](https://github.com/chayapats/schway/issues/400), [FEAS01](https://github.com/chayapats/jit/issues/5), [FEAS02](https://github.com/chayapats/jit/issues/17), [FEAS03](https://github.com/chayapats/jit/issues/7), [FEAS05](https://github.com/chayapats/jit/issues/25), [JOB01](https://github.com/chayapats/jit/issues/6), [JOB03](https://github.com/chayapats/jit/issues/27), [OPS04](https://github.com/chayapats/jit/issues/34), [OPS05](https://github.com/chayapats/jit/issues/36), [OPS07](https://github.com/chayapats/jit/issues/35) |
| NFR-07 | [APP01](https://github.com/chayapats/jit/issues/3), [APP02](https://github.com/chayapats/jit/issues/4), [ENG05](https://github.com/chayapats/schway/issues/398), [FEAS01](https://github.com/chayapats/jit/issues/5), [FEAS02](https://github.com/chayapats/jit/issues/17), [FEAS03](https://github.com/chayapats/jit/issues/7), [FEAS04](https://github.com/chayapats/jit/issues/22), [MEM01](https://github.com/chayapats/jit/issues/23), [MEM02](https://github.com/chayapats/jit/issues/26), [MEM03](https://github.com/chayapats/jit/issues/28), [MEM04](https://github.com/chayapats/jit/issues/29), [MEM05](https://github.com/chayapats/jit/issues/30), [OPS03](https://github.com/chayapats/jit/issues/31), [OPS04](https://github.com/chayapats/jit/issues/34), [OPS07](https://github.com/chayapats/jit/issues/35), [PR01](https://github.com/chayapats/jit/issues/10), [PR03](https://github.com/chayapats/jit/issues/24), [TASK01](https://github.com/chayapats/jit/issues/16), [TEAM01](https://github.com/chayapats/jit/issues/8), [TEAM02](https://github.com/chayapats/jit/issues/11), [TEAM03](https://github.com/chayapats/jit/issues/14), [TG01](https://github.com/chayapats/jit/issues/12), [TG02](https://github.com/chayapats/jit/issues/21), [TG03](https://github.com/chayapats/jit/issues/13) |
| NFR-08 | [ENG07](https://github.com/chayapats/schway/issues/401), [ENG08](https://github.com/chayapats/schway/issues/402), [ENG09](https://github.com/chayapats/schway/issues/403), [JBR01](https://github.com/chayapats/jit/issues/15), [MEM05](https://github.com/chayapats/jit/issues/30), [OPS01](https://github.com/chayapats/jit/issues/18), [OPS02](https://github.com/chayapats/jit/issues/33), [OPS05](https://github.com/chayapats/jit/issues/36), [OPS06](https://github.com/chayapats/jit/issues/32), [OPS07](https://github.com/chayapats/jit/issues/35) |
| NFR-09 | [APP01](https://github.com/chayapats/jit/issues/3), [ENG03](https://github.com/chayapats/schway/issues/399), [FEAS01](https://github.com/chayapats/jit/issues/5), [MEM05](https://github.com/chayapats/jit/issues/30), [OPS01](https://github.com/chayapats/jit/issues/18), [OPS03](https://github.com/chayapats/jit/issues/31), [OPS04](https://github.com/chayapats/jit/issues/34), [OPS05](https://github.com/chayapats/jit/issues/36), [OPS07](https://github.com/chayapats/jit/issues/35), [PR01](https://github.com/chayapats/jit/issues/10) |
| NFR-10 | [APP01](https://github.com/chayapats/jit/issues/3), [APP02](https://github.com/chayapats/jit/issues/4), [ENG01](https://github.com/chayapats/schway/issues/395), [ENG02](https://github.com/chayapats/schway/issues/396), [ENG03](https://github.com/chayapats/schway/issues/399), [ENG04](https://github.com/chayapats/schway/issues/397), [ENG05](https://github.com/chayapats/schway/issues/398), [ENG06](https://github.com/chayapats/schway/issues/400), [ENG07](https://github.com/chayapats/schway/issues/401), [ENG08](https://github.com/chayapats/schway/issues/402), [ENG09](https://github.com/chayapats/schway/issues/403), [FEAS01](https://github.com/chayapats/jit/issues/5), [FEAS02](https://github.com/chayapats/jit/issues/17), [FEAS04](https://github.com/chayapats/jit/issues/22), [FEAS05](https://github.com/chayapats/jit/issues/25), [JBR01](https://github.com/chayapats/jit/issues/15), [JOB01](https://github.com/chayapats/jit/issues/6), [JOB02](https://github.com/chayapats/jit/issues/9), [JOB03](https://github.com/chayapats/jit/issues/27), [MEM01](https://github.com/chayapats/jit/issues/23), [MEM02](https://github.com/chayapats/jit/issues/26), [MEM03](https://github.com/chayapats/jit/issues/28), [MEM04](https://github.com/chayapats/jit/issues/29), [MEM05](https://github.com/chayapats/jit/issues/30), [OPS01](https://github.com/chayapats/jit/issues/18), [OPS02](https://github.com/chayapats/jit/issues/33), [OPS03](https://github.com/chayapats/jit/issues/31), [OPS04](https://github.com/chayapats/jit/issues/34), [OPS05](https://github.com/chayapats/jit/issues/36), [OPS06](https://github.com/chayapats/jit/issues/32), [OPS07](https://github.com/chayapats/jit/issues/35), [PR01](https://github.com/chayapats/jit/issues/10), [PR02](https://github.com/chayapats/jit/issues/19), [PR03](https://github.com/chayapats/jit/issues/24), [TASK01](https://github.com/chayapats/jit/issues/16), [TASK02](https://github.com/chayapats/jit/issues/20), [TEAM01](https://github.com/chayapats/jit/issues/8), [TEAM02](https://github.com/chayapats/jit/issues/11), [TEAM03](https://github.com/chayapats/jit/issues/14), [TG01](https://github.com/chayapats/jit/issues/12), [TG02](https://github.com/chayapats/jit/issues/21), [TG03](https://github.com/chayapats/jit/issues/13) |
| NFR-11 | [APP02](https://github.com/chayapats/jit/issues/4), [MEM01](https://github.com/chayapats/jit/issues/23), [MEM02](https://github.com/chayapats/jit/issues/26), [OPS03](https://github.com/chayapats/jit/issues/31), [TASK02](https://github.com/chayapats/jit/issues/20), [TG02](https://github.com/chayapats/jit/issues/21) |
| NFR-12 | [APP01](https://github.com/chayapats/jit/issues/3), [ENG01](https://github.com/chayapats/schway/issues/395), [ENG04](https://github.com/chayapats/schway/issues/397), [ENG07](https://github.com/chayapats/schway/issues/401), [ENG08](https://github.com/chayapats/schway/issues/402), [ENG09](https://github.com/chayapats/schway/issues/403), [JBR01](https://github.com/chayapats/jit/issues/15), [JOB02](https://github.com/chayapats/jit/issues/9), [MEM03](https://github.com/chayapats/jit/issues/28), [MEM04](https://github.com/chayapats/jit/issues/29), [MEM05](https://github.com/chayapats/jit/issues/30), [OPS01](https://github.com/chayapats/jit/issues/18), [OPS02](https://github.com/chayapats/jit/issues/33), [OPS03](https://github.com/chayapats/jit/issues/31), [OPS05](https://github.com/chayapats/jit/issues/36), [OPS06](https://github.com/chayapats/jit/issues/32), [OPS07](https://github.com/chayapats/jit/issues/35) |

## Gates และขอบเขต

- Scripted product work เริ่มได้โดยไม่รอ live Pi/account proof; production bridge ใช้ supported host release และ real-route support claims รอ FEAS04/05 ของแต่ละ route

- FEAS03/04/05 เป็น runtime provisioning/account/reboot observations; OPS07 สร้าง service package และ OPS05 ตรวจ full Jit activation/reboot/pilot จริง การผ่าน probe ไม่แทน full-app boot evidence

- OPS01 ให้ backup inventory โดยไม่ขึ้นกับ memory deletion; MEM05 ใช้ inventory ใน delete preview; OPS06/02 จึงค่อยใช้ latest lifecycle ledger สำหรับ migration/restore เพื่อหลีกเลี่ยง cycle

- Correct/forget/delete ต้อง invalidate derived state และ retire managed native contexts; Jit ใช้ supported native APIs และไม่ rewrite Schway session formats

- ไม่มี agent shell, coding execution, GitHub mutation, MCP server, local inference, full Telegram team mirror หรือ multi-user ในชุด MVP นี้

- ค่าทรัพยากรเป็น finite operator configuration ที่ต้องวัดก่อน pilot ไม่มีการเพิ่ม deadline หรือ product-value benchmark แทนคำตอบของ owner

## การดูแล backlog

GitHub issues/comments/native dependency state เป็นสถานะทำงานปัจจุบัน เอกสารและ JSON นี้เป็น snapshot ของการแตกงาน หากแก้ scope/contract/blocker ให้ปรับ ticket ที่เกี่ยวข้องและ snapshot ให้สอดคล้องกัน รักษา FR/NFR IDs และไม่ถือ label/assignee อย่างเดียวเป็น atomic implementation ownership

## S09 — Jit main bot and chat-first interface

Parent: [S09 / Jit #90](https://github.com/chayapats/jit/issues/90) ([spec](../specs/S09-main-bot-and-chat-first-ui.md)). Created 2026-10-26. These are 8 vertical slices, linked as sub-issues of #90 with native blocking relations. Every ticket also waits for the S09 docs PR to merge.

| Ticket | Outcome | Direct blockers | Done by |
| --- | --- | --- | --- |
| [UX01](https://github.com/chayapats/jit/issues/91) | Every page uses the new monochrome bilingual design system and shell, and still works without scripts | None | Agent |
| [BOT01](https://github.com/chayapats/jit/issues/92) | Jit replies to every topic message with the owner's persona, streaming without duplicate replies | [UX01](https://github.com/chayapats/jit/issues/91) | Agent |
| [BOT02](https://github.com/chayapats/jit/issues/93) | A new installation starts at the "ตั้งจิต" setup and gets a General space | [BOT01](https://github.com/chayapats/jit/issues/92) | Agent |
| [BOT03](https://github.com/chayapats/jit/issues/94) | Role proposals create a role only when the owner accepts the current revision | [BOT01](https://github.com/chayapats/jit/issues/92) | Agent |
| [BOT04](https://github.com/chayapats/jit/issues/95) | Jit calls specialists within the dispatch allowance and answers with one voice | [BOT01](https://github.com/chayapats/jit/issues/92) | Agent |
| [BOT05](https://github.com/chayapats/jit/issues/96) | Chat-first home, General space and topic promotion that keeps provenance | [BOT02](https://github.com/chayapats/jit/issues/93) | Agent |
| [UX02](https://github.com/chayapats/jit/issues/97) | Ops pages consolidated under settings, topic right panel and ⌘K | [UX01](https://github.com/chayapats/jit/issues/91) | Agent |
| [UX03](https://github.com/chayapats/jit/issues/98) | Static-only PWA, mobile polish and accessibility | [UX02](https://github.com/chayapats/jit/issues/97), [BOT05](https://github.com/chayapats/jit/issues/96) | Agent |
