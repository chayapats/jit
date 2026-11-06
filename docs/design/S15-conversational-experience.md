# S15 conversational experience

Status: **authored UI/UX handoff for [UX15-00 #337](https://github.com/chayapats/jit/issues/337)**, revision 1, 2026-11-03. It is a design target for UX15 implementation slices, not an implemented S15 surface, a runtime contract freeze, a live grant or acceptance evidence. S14 remains the implemented default.

Interactive review artifact: [s15-conversational-prototype.html](s15-conversational-prototype.html). It is self-contained, uses fixture data and connects to nothing.

Inputs read at integration main `adaba2c` (after PR #351): [S15 spec](../specs/S15-conversational-autonomy.md) (S15-D01–D23, S15-AC01–AC16), [PRD](../product/02-prd.md), [CONTEXT.md](../../CONTEXT.md), [workflow](../agents/workflow.md), ADRs [0064](../adr/0064-conversational-authority-and-protected-control-plane.md)–[0071](../adr/0071-s15-mediated-team-resources-and-fenced-handoffs.md), the S15 contracts ([runtime feasibility](../contracts/s15-runtime-feasibility-v1.md), [state transition](../contracts/s15-state-transition-v1.md), [standing policy](../contracts/s15-standing-policy-v1.md), [working VM](../contracts/s15-working-vm-v1.md), [protected browser](../contracts/s15-protected-browser-v1.md), [conversation](../contracts/s15-conversation-v1.md), [model selection](../contracts/s15-model-selection-v1.md), [team resources](../contracts/s15-team-resources-v1.md)), the existing [S14 Plain](S14-plain-experience.md) and [S14 bot-first](S14-bot-first-experience.md) designs, the [design brief](S14-design-brief.md), the [visual system](README.md), the current Web code in `src/s14/web*.ts` and `src/i18n`, and issues #316, #337, #338 and #339.

Owner decisions applied (2026-11-03, delegated to the orchestrator and not re-asked): RT15-01 option B (full root inside an expendable working VM; valuable data, credentials and external effects stay outside; a broken VM is restored from a snapshot); the owner supplies the working VM (arm64 Lima or x64 Proxmox) and enrols it in one simple step; a private sandbox GitHub repository is used for evidence; and the "just works like Grok bot" principle: no configuration files, no typing of values Jit can infer, one-click setup in the Web UI and no terminal after install. Thai is the primary product language and owner-facing copy is plain.

## How to read this document

The labels from the S14 design remain in use.

| Label | Meaning | Who can change it |
| --- | --- | --- |
| **R** | Required behaviour restated from S15, the PRD, an S15 contract or the visual system. The source is named. | The owner, through the spec |
| **P** | Designer proposal made here. | Orchestrator review, then the owner if needed |
| **Q** | Open question with a default, so implementation is not blocked. | Orchestrator review, then the owner if needed |

Layouts, copy, components and flows are **P** unless marked otherwise. Authority rules are **R**. "Existing" means present on main at `adaba2c`; "proposed" means named by an S15 contract or by this document and not yet implemented.

## 1. Design thesis

1. **The conversation is the work surface (R: S15-D01).** The owner asks; Jit understands, starts, shows what it is doing and returns evidence. No Work switch, no limit fields in the composer, no per-request grant form and no second "start" confirmation.
2. **The system draws the authority line, and the UI shows where it is (R: S15-D12, ADR 0064).** Every reply states, in one line, what Jit is about to do on its own and what will wait for the owner. Held actions appear as exact cards whose buttons come only from typed system data. A model sentence never becomes a button, a checkmark or an "approved" state.
3. **One question, once (R: S15-D05, S15-D16, S15-AC09).** Each human-required action is approved once, on its final content. A decision already made is shown as made and never asked again. Ambiguity creates one question, not a form.
4. **Waiting is not stalling, and unknown is not failure (R: S15-D22, S15-AC15).** Durable waits for CI or review are calm and need nothing. A stalled item stops itself and explains. An unknown outcome is never retried by itself.
5. **Honest limits beat silent fallbacks (R: S15-D10, S15-AC05).** If a website step, VM operation or model setting is not supported, the UI names the exact boundary and offers the owner's own way forward.
6. **Setup is one page of plain choices (R: just-works principle).** Jit infers everything it can. The owner types only what Jit cannot know: their password, the working VM's address and finite budget amounts.

## 2. What changes from S14 Plain

| S14 Plain surface (existing) | S15 target (P unless marked) |
| --- | --- |
| Composer `s-mode` checkbox "สั่งเป็นงาน", limit fields, completion, evidence target and grant choices (`composer()` in `src/s14/web-pages.ts`) | Removed (R: S15-D01). The composer has the addressed Bot chip, attachments and send. Narrower restrictions are said in words and grounded by the protected service (R: conversation contract). |
| Task slip with "เริ่มงาน" and a second limit form (`taskSlip()`) | A suggested task is still accepted separately (R: CONTEXT "Task acceptance"). Starting it is an ordinary owner message such as "เริ่มเลย", or the prefilled reply chip below. No limit form. |
| Work card footer "ขอบเขต" (grant tab) | Replaced by a **Scope line**: the standing rule revision that admitted the work and what will still ask the owner. The Grant tab becomes "ทำไมจิตทำได้" (Why Jit may do this), read-only. |
| Per-Bot computer pages and private browser profiles (S14) | One **working computer** for the team plus protected **website sessions**, under Resources. S14 Bot computers stay listed as retained S14 items until MIG15 retires or converts them (R: S15-AC04, NFR-12). |
| Exact effect slip `effectSlip()`, personal slip, Git summary/page | Kept and generalized into the **ActionSlip** family with class-specific exact sections (§7.3). |
| "ขอบเขต"/grant vocabulary | Replaced by **กฎประจำ** (standing rules). "ขอบเขต" is not used in S15 owner copy. |
| `s14.setup.route_missing_detail` tells the owner to check `JIT_S14_ROUTES` | Replaced by a one-click provider sign-in row (just-works). No environment variable appears in S15 copy. |

Kept unchanged (R): OwnerStrip as the only host of authority buttons; UntrustedFrame for any model, website, email or tool text; exact blocks that are never truncated; receipts; textual states; dark/light; Thai default; same-origin assets, CSP, session/Host/Origin/CSRF and no-script command forms; browser-local drafts without authority (ADR 0062).

## 3. Information architecture

```text
Sidebar (desktop) / navigation disclosure (mobile)
├─ New conversation
├─ ต้องการคุณ · Needs you (count)        ← held actions, decisions, logins, stalled items
├─ งาน · Work                             ← working, waiting, responsibilities, done
├─ Bots (Jit first)
├─ Conversations (recent)
└─ Manage (grouped)
   ├─ Knowledge: ความจำ Memory · คลังผลงาน Library
   ├─ Team resources: เครื่องทำงาน Working computer · บัญชีและเว็บ Accounts and websites
   ├─ Rules and spend: กฎประจำ Standing rules · โมเดลและงบ Models and budget
   └─ Installation: การกู้คืน Recovery · สำรองข้อมูล Backup · ภาษาและธีม Preferences
```

**P.** "Needs you" becomes its own primary destination because S15 removes most owner interruptions; what remains must be easy to find. It lists only items that truly wait on the owner: held actions, decisions, login/2FA handoffs, stalled reports, budget holds and proposals. Durable CI/review waits are **not** listed there.

| Route | Status | Purpose |
| --- | --- | --- |
| `/`, `/chats/:id` | Existing | Conversation. S15 removes the mode switch and adds receipt/intent/progress/result rows. |
| `/work` | Existing | Becomes sections: Needs you · Working · Waiting (CI/review/login) · Responsibilities · Recently done. |
| `/needs` | Proposed | The "Needs you" list (also reachable as `/work#needs`). |
| `/actions/:id` | Proposed | Full-page ActionSlip, analogous to existing `/effects/:id`. |
| `/duties/:id` | Proposed | Responsibility detail with history and stall reports. |
| `/memory` | Existing | Extended with fact/inference filters, correction and forget impact. |
| `/resources/computer` | Proposed | Working VM status, enrolment, snapshot/restore. |
| `/resources/accounts` | Proposed | Connected accounts and website sessions; team sharing and narrower restrictions. |
| `/resources/websites` | Implemented (BROW15-02) | "เว็บที่จิตอ่านได้" (Websites Jit may read): protected browser status (ready, preparing with the current step, failed with step, reason, missing library, next step and Try again), the owner's approved websites with add and remove, what an approval does and does not allow, and the sign-in handoff for configured sign-in sites. A refused unlisted website in a LimitNotice links here. |
| `/rules` | Proposed | Standing rules: summary, personal GitHub profile, communication and recurring-payment rules, revoke. |
| `/models` | Proposed | Approved accounts/models/effort, pins, budget meters. |
| `/recovery` | Existing | Extended with unknown actions and VM/browser settlement facts. |
| `/` before setup, `/owner/setup` | Existing first-run seam (`setupPage`, `renderOwnerSetup` in `src/s14/web-first-run.ts`) | S15 adds working computer, accounts, rules and budget sections. |
| `/effects/:id`, `/library`, `/team`, `/more`, `/settings/provider` | Existing | Kept; `/actions/:id` may reuse the `/effects/:id` page pattern. |

## 4. Layouts

### Desktop (≥ 1024 px)

**P.** Keep the S14 Plain shell: 248 px sidebar, a reading column of at most 720 px, and an optional 400 px secondary pane for work detail, the protected browser view or an ActionSlip. A held action opened from the thread opens in the pane, so the conversation stays visible beside the exact content. The pane has its own heading and close button, and Esc returns focus to the opener.

### Tablet (640–1023 px)

The sidebar collapses to the navigation disclosure. The secondary pane becomes an overlay sheet that covers the column and marks the background inert.

### Mobile (360–639 px)

Details replace the conversation with a full page and a direct back link (R: S14 Plain). ActionSlips are full-width and keep their OwnerStrip directly after the exact content, never fixed to the viewport bottom, so the buttons cannot be pressed before the content is scrolled past (P). Long exact blocks wrap; they never scroll horizontally inside a clipped box (R: S14 ExactBlock). The protected browser view scales to the width and keeps "คืนให้จิต" (Hand back) above the image.

## 5. Flows

Each flow names its prototype scene in brackets.

### F1. First-run setup [setup]

**R:** FR-23, just-works principle, S15-D02/D07/D11/D17/D23, ADR 0065. **P:** one setup page with five short sections, each of which can be completed or skipped where allowed. Progress is saved per section through ordinary authenticated commands; reload resumes at the first unfinished section.

| Section | What the owner does | What Jit infers or shows |
| --- | --- | --- |
| 1. ตั้งรหัสผ่าน (Password) | Existing one-time owner link and password form | Nothing else |
| 2. บัญชีโมเดล (Model account) | One click "เข้าสู่ระบบกับ <provider>" per supported provider (existing device sign-in) | Supported providers, recommended model, readiness as *configured, not yet checked* (R: CONTEXT "Configured access") |
| 3. เครื่องทำงาน (Working computer) | Paste one line into the new VM, then type the VM's address once | Jit's connection key, the VM's architecture, OS, CPU, memory, disk, sudo, Docker presence and whether snapshots are available. Owner confirms "ใช้เครื่องนี้" |
| 4. บัญชีและเว็บ (Accounts and websites) | Optional: one click per account (Google, GitHub and so on) | Which tools each account enables for the team; "skip for now" is first-class |
| 5. กฎประจำและงบ (Rules and budget) | Read the plain summary, type the finite budget amount(s), press "ใช้กฎนี้" | Everything else in the rule proposal comes from the protected service |

#### Working computer enrolment (one simple step)

**P**, bounded by the [working VM contract](../contracts/s15-working-vm-v1.md) (host-initiated management, endpoint identity from trusted owner configuration, never from guest output):

1. The card says: "สร้าง VM ใหม่ที่จิตใช้ได้เต็มที่ (Ubuntu แนะนำ) แล้ววางบรรทัดนี้ในเครื่องนั้นครั้งเดียว". It shows one copyable line that authorizes Jit's management key inside the guest. The line contains only a public key and a comment; it fetches nothing from Jit, so the guest never needs a route to the protected service.
2. The owner types the VM's address (host name or IP). This is the only typed value, because Jit cannot infer it. Port and user default from the transport profile and appear under "รายละเอียด" only.
3. "ตรวจเครื่อง" connects host-initiated and shows the machine identity fingerprint plus the discovered facts. The owner presses "ใช้เครื่องนี้เป็นเครื่องทำงาน". That press is the owner's registration command.
4. The card then shows the capability rows that were actually observed, each with its own state: run commands, administrator (sudo), Docker, network for packages, snapshots and restore. A row is ✓ only when observed on this VM generation; otherwise it is "ยังไม่ได้ตรวจ" or "ทำไม่ได้".

The card states option B in plain words: "จิตมีสิทธิ์เต็มในเครื่องนี้ ข้อมูลสำคัญ รหัสผ่าน และการส่งออกไปข้างนอกอยู่นอกเครื่องนี้เสมอ ถ้าเครื่องพัง ย้อนกลับจาก snapshot ได้" (Jit has full control of this machine. Your important data, passwords and anything that leaves for the outside world stay outside it. If it breaks, it can be restored from a snapshot.)

If the hypervisor adapter cannot take snapshots (for example, SSH-only management), the snapshot row says "จิตย้อนเครื่องเองไม่ได้ ใช้ snapshot ใน Proxmox หรือ Lima แล้วกด ตรวจเครื่อง อีกครั้ง" and the restore control in F11 stays hidden (R: honest unsupported state).

**Q1.** Should Jit discover Lima instances on its own host or Proxmox guests through an API token? Default: no discovery in v1; the paste-and-address step is the supported path. Discovery would need a reviewed management adapter and is not inferred.

**Handoff note for F1/F7 (VM15-02 #366, owner decision 2026-11-03; behavior only, not a design).** The single-host topology is now the default. On a controller with KVM, setup creates the working computer automatically: no new VM to make, no line to paste and no address to type. Jit downloads a checksum-verified Ubuntu image and starts the guest itself, which takes minutes, so the section needs an honest in-progress state. When it finishes, the card shows the same observed capability rows as above: network isolation is ✓ only after the hypervisor and egress checks; snapshots/restore and hypervisor stop remain "ยังไม่ได้ตรวจ" until a real protected stop/restore is observed, never ✓ from configuration. Default CPU/RAM/disk come from the host and are editable later (they apply at the next start); the owner never has to type them. Where KVM is absent (`vm_host_unsupported`), setup falls back to the paste-and-address enrollment described above; owner-supplied VMs also remain the path for extra compute. New refusal codes (`vm_host_unsupported`, `vm_host_too_small`, `vm_disk_insufficient`, `vm_image_unverified`, `vm_image_unavailable`) need plain copy. The UI, its copy and the asynchronous setup route are SETUP15-01 (Claude Opus 5.5, high effort).

**Implementation note for F1/F7 (SETUP15-01 #369 and POOL15-01 #370).** On a KVM controller, step 3 shows the automatic job instead of the paste form: "กำลังสร้างเครื่องทำงานให้" with the step list (ตรวจเครื่องนี้ → ดาวน์โหลด Ubuntu → ตรวจ checksum → สร้างดิสก์และกุญแจ → เปิดเครื่องครั้งแรก → เชื่อมต่อและตั้งค่าเริ่มต้น → ตรวจตัวตนเครื่องและการแยกเครือข่าย), the current step marked with `aria-current="step"` and its own word, the elapsed time overall and for the step, a "ดูความคืบหน้าล่าสุด" link (enhanced pages reload themselves unless the owner is typing), and the note that closing the page or a restart is safe. A job interrupted by a restart reads "หยุดค้างไว้ที่ขั้น …" with "ทำต่อตอนนี้". A failure is an alert naming the failed step, the plain reason, one next step and the code, with one "ลองใหม่จากขั้นนี้" form. When the host cannot run the nested VM, the card names the missing item (no KVM, no access to `/dev/kvm`, QEMU missing, too small, not enough disk, unsupported platform) with what to do and the host's CPU/RAM/free disk, then offers "ใช้ VM ของคุณเอง" with the unchanged paste-and-address flow. A ready host with no job offers one "สร้างเครื่องทำงานตอนนี้" button showing the default sizing. The step stays unfinished, and no capability row appears, until a computer is registered; rows keep the observed-only semantics above.

`/resources/computer` lists every computer of the team pool ("เครื่องทำงานหลัก", "เครื่องทำงานเพิ่ม 2" …) with its state, origin (created by Jit on this machine or the owner's VM), sessions in use, how many works keep their files there, the observed capability rows and facts, and "หยุดใช้เครื่องนี้" / "กลับมาใช้เครื่องนี้" with their notes (running work finishes; nothing is cut off). Below it, "เพิ่มเครื่องทำงานอีกเครื่อง" first asks for the computer's management (a Lima instance, or a VM-scoped Proxmox token in a write-only field that is never shown again) and explains that Jit can send work only to a computer whose identity it can check and which it can stop or snapshot from outside; only then does it run the same enrollment flow for extra compute, and each computer has its own restore section. The lead sentence states placement in plain words: new work goes to the ready computer with the most room; started work returns to the computer that holds its files. All new strings have Thai and English keys (`s15.provision.*`, `s15.pool.*`, new `s15.code.vm_*`).

#### Rules and budget review

**R:** S15-D07 (no amount chosen), S15-D17 (personal GitHub exception is opt-in), standing policy `policy.install` with an exact proposal hash. **P:** the review shows two plain lists generated from the protected proposal, never from model text:

- **จิตทำเองได้ (Jit does these on its own):** answer and research; work on its working computer, including installing programs; edit your documents, tasks and solo calendar blocks when you ask; use connected accounts for the work you ask for; choose a model inside the list below.
- **ถามคุณก่อนเสมอ (Always asks you first):** sending email or messages to other people; GitHub push, pull requests and review replies; merging; production deploys; payments; giving private data to a new recipient; major or hard-to-undo changes; new providers, accounts or bigger budgets.

Budget fields are empty until the owner types an amount (R: no invented amount). Currency and period choices come from the selected billing route; the UI pre-selects nothing it cannot read from the route catalog. Non-money ceilings (calls, active time, reads) appear as read-only rows supplied by the protected proposal; if the proposal has no reviewed value, the row shows "ยังไม่มีค่าที่ตรวจแล้ว" and the "ใช้กฎนี้" button is disabled with that reason (R: NFR-06 finite limits; WORK15/MODEL15 own the profile).

The personal GitHub profile is not part of first-run. A quiet line says "โปรไฟล์ GitHub ส่วนตัว: ปิดอยู่ ตั้งได้ที่ กฎประจำ" (Personal GitHub profile: off. Set it up under Standing rules).

### F2. Ordinary tool-backed chat [chat]

**R:** S15-D01, S15-AC01, conversation contract dispositions. **P:** every owner message gets these rows in order. Each row has a stable region so that live updates replace content without moving focus.

1. **Owner message.** As S14 Plain: indented rule, exact text.
2. **Receipt line** (`ReceiptV1` committed): "ได้รับแล้ว" with time. Before commit the message shows "กำลังส่ง…"; a refused send keeps the text in the composer with the reason (R: retry and duplicate semantics).
3. **Intent line** (after admission or hold). One of:
   - Answer only: no line.
   - Inspect/report: "ตรวจดูอย่างเดียว ไม่แก้ไขอะไร" (Looking only. Nothing will be changed.)
   - Execute: "เริ่มทำแล้ว · ตามกฎประจำ r4" (Started · under standing rules r4), with "จะถามคุณก่อน: push, merge" when the admitted work contains known held classes.
   - Obligation only: "รับไว้เป็นงานแล้ว ยังไม่เริ่ม" (Kept as a task. Not started.)
   - Hold: "ขอถาม 1 ข้อก่อนเริ่ม" with the question card below.
4. **Work card** (execute and inspect): title as Jit's summary, labelled "สรุปโดยจิต"; the resolved subject as a trusted label (for example `chayapats/jit #328`); state pill; progress region; Stop.
5. **Progress region.** Provisional steps from the run, each one line with a verb and object: "รันคำสั่งในเครื่องทำงาน: `bun test`", "เปิดเว็บ: github.com/…", "อ่านไฟล์: src/…". The region header says "ความคืบหน้า (ยังไม่ใช่หลักฐาน)" (Progress — not evidence yet). Lines collapse after five with "ดูทั้งหมด". Committed evidence turns a line into an evidence row with ✓ and "บันทึกแล้ว".
6. **Result block** (R: FR-29 result contract): Status pill · Result (UntrustedFrame "คำตอบจากจิต") · Evidence list · Gaps · "ต้องการจากคุณ" when blocked.
7. **Disclosure footer**: model and effort used (§F10), memory notes (§F8), receipt details.

Quoted text, attachments, emails and tool output never produce an intent line of their own (R: S15-AC01). When the owner pastes an email that says "approve the payment", the reply treats it as content; the UntrustedFrame label reads "ข้อความที่คุณวางมา ไม่ใช่คำสั่ง" (Text you pasted — not an instruction).

#### Clarification hold

**R:** one bounded hold per material question; reconnect is never an answer. **P:** a **QuestionCard** sits under the intent line: one sentence naming the missing datum, up to four reply chips with trusted labels ("ส่งถึงลูกค้าคนเดิม", "ส่งถึงทีม", …) when the protected hold provides candidates, and "ตอบเองในช่องพิมพ์". Pressing a chip prefills the composer with that exact text; the owner sends it. Only the sent, authenticated message resolves the hold. Independent inspection that is already permitted keeps running and its progress stays visible beside the question.

### F3. GitHub readiness and select-and-start [readiness]

**R:** S15-D15/D16, S15-AC02. **P:**

1. "ช่วยดู issue ที่ค้างใน chayapats/jit หน่อย ว่าอันไหนพร้อมทำ" → Intent line "ตรวจดูอย่างเดียว ไม่แก้ไขอะไร".
2. The result is a **ReadinessTable**: one row per issue with Ready / Blocked / Owned by someone / Has an open PR, and the checked reasons as short facts (scope, acceptance criteria, blockers, assignee, branch/PR). Each fact links to its evidence. Sorting is by the system's readiness state, not by Jit's preference.
3. Under the table: "จิตจะไม่เลือกเองว่าจะทำข้อไหน" (Jit won't choose which one to do). Each ready row has a quiet chip "ทำข้อนี้" that prefills "เริ่มทำ #328" in the composer. Nothing starts until the owner sends.
4. "เริ่มทำ #328 เลย แล้วคอยดูจนผ่าน" in one message is enough (R: one-message select-and-start). The intent line reads "เริ่มทำแล้ว · #328 · ตามกฎประจำ r4" and a Responsibility row "คอยดูจนผ่าน" is created (§F9).
5. A duplicate send of the same request shows the original receipt: "ส่งไปแล้วเมื่อ 10:42 ยังเป็นงานเดิม" (R: at most one local work intent).

### F4. Held actions, approved once [hold-*]

**R:** S15-D05/D06/D08/D17–D21, S15-AC07–AC11, standing policy matching, `action.decide` binds the exact action revision and hash. **P:** every human-required action becomes one **ActionSlip** (§7.3). The conversation shows a compact slip with the class, the who/what in one line and "ดูทั้งหมดและตัดสินใจ" (Review all and decide); the decision happens on the full slip in the pane or page, under the complete exact content.

Shared rules for all slips (R unless marked):

- Exact content precedes the decision buttons. Nothing is truncated; long content wraps.
- The heading names the action class in system words, never Jit's paraphrase: "จิตขอส่งอีเมล" (Jit asks to send an email).
- Every class that applies is shown as a chip under the heading, for example "อีเมลถึงผู้อื่น · ข้อมูลส่วนตัวถึงผู้รับใหม่". One approval covers this exact action and all its classes (R: standing policy "Exact approvals bind the full multi-class action").
- Meta row: revision, expiry ("หมดอายุใน 45 นาที"), and "ไม่มีกฎประจำที่ครอบคลุม" or the rule that partially applies.
- Buttons in the OwnerStrip: a class-specific primary ("ส่ง 1 ครั้ง"), "ไม่ส่ง" and "ขอแก้". "ขอแก้" focuses the composer with "แก้อีเมลนี้: " prefilled; the revised action arrives as revision n+1 and the old slip shows "ถูกแทนด้วย r2 · การอนุมัติเดิมใช้ไม่ได้".
- The primary button never has default focus and has no keyboard shortcut (P).
- The primary button is absent when support is unproven; the strip says why: "จิตยังทำสิ่งนี้อย่างปลอดภัยไม่ได้ จึงไม่มีปุ่มส่ง" (R: approval cannot repair missing support).

#### Approval in conversation

**R:** a natural reply resolves to exactly one current eligible action; ambiguity, staleness and quotes never execute. **P:**

- When exactly one action is pending in the conversation and the owner writes "ส่งได้", the slip changes to "อนุมัติจากข้อความของคุณ 10:52" with a link to that message, then to its execution state.
- When two or more are pending, Jit replies "หมายถึงอันไหน" and the slips stay pending. Nothing executes.
- When the action changed after the owner last saw it, Jit replies "อีเมลนี้เปลี่ยนแล้ว (r2) ดูอีกครั้งก่อนนะ" and shows the diff.

#### Class-specific exact sections

| Class | Exact section (all from `PreparedActionV1.details`) | Primary button |
| --- | --- | --- |
| Email / message to others (S15-D05/D06) | Sending account, To, Cc, Bcc (each an exact identity), subject, full body, attachments with name, type, size and "เปิดดู" | "ส่ง 1 ครั้ง" (Send once) |
| GitHub, default profile (S15-D17) | Repository, branch, base → head commits, diff summary with "ดู diff ทั้งหมด", checks actually run with results, exact PR title/body or exact review reply and its thread | "Push และเปิด PR 1 ครั้ง" / "ตอบรีวิว 1 ครั้ง" |
| Merge (S15-D18) | Target branch and head, acceptance evidence, required checks/reviews with state, production consequence row | "Merge 1 ครั้ง" |
| Production (S15-D19) | Environment, what deploys (commit), trigger (direct or via merge), known rollback path or "ไม่ทราบวิธีย้อน" | "Deploy 1 ครั้ง" / "Merge และปล่อย deploy 1 ครั้ง" |
| Payment (S15-D08) | Payee identity, paying account, amount and currency exactly, one-time or recurring, reference | "จ่าย 1 ครั้ง" (Pay once) |
| Recurring-payment deviation | Same, plus the rule it deviates from and the deviating field highlighted in words: "ยอดสูงกว่าเพดานของกฎ" | "จ่ายครั้งนี้ 1 ครั้ง" |
| Recurring-payment rule proposal (F13) | Exact payee, paying account, currency, amount ceiling and frequency | "ตั้งกฎนี้" (Set up this rule) |
| New private-data recipient (S15-D20) | Recipient identity, the exact data (sources/files/fields), purpose, "ผู้รับนี้ยังไม่เคยได้รับข้อมูลของคุณ" | "อนุญาตเฉพาะครั้งนี้" (Allow this time only) |
| Major change / business commitment (S15-D09/D21) | **DecisionCard** (below) | Per option |
| VM restore (option B) | §F11 | "ย้อนเครื่อง 1 ครั้ง" |

#### DecisionCard

**R:** S15-AC09: options, evidence and a recommendation; a previous direction is retained. **P:** the heading states the impact class in words ("เปลี่ยนวิธียืนยันตัวตนของบริการ"); 2–4 options, each with what happens, what can't be undone and links to evidence; Jit's recommendation in an UntrustedFrame "จิตแนะนำ"; one button per option plus "ยังไม่ทำ". Investigation that is already permitted continues and the card says so: "ระหว่างรอ จิตจะลองในที่แยกไว้ต่อ ไม่แตะของจริง". A decision already recorded for the same impact and target shows as "ตัดสินใจไว้แล้ว 2 พ.ย. · ทางเลือก B" and is not asked again.

#### Slip states

| State | Owner sees | Controls |
| --- | --- | --- |
| pending | "รอคุณ" | Primary, deny, revise |
| approved → executing | "อนุมัติแล้ว · กำลังทำ" | None |
| succeeded (remote verified) | "ส่งแล้ว · ตรวจจากปลายทางแล้ว" | Open evidence |
| succeeded (local only) | "ส่งแล้ว · ปลายทางยังไม่ยืนยัน" | Open evidence |
| failed | "ไม่สำเร็จ · ปลายทางปฏิเสธ" with reason | Ask Jit to revise |
| unknown | "ไม่ทราบผล · จิตจะไม่ส่งซ้ำเอง" | "ตรวจอีกครั้ง (อ่านอย่างเดียว)", "บอกผลที่คุณรู้" (existing owner statement) |
| changed | "ถูกแทนด้วย r2" plus diff | Open r2 |
| expired | "หมดอายุ ไม่ได้ส่ง" | Ask Jit to prepare again |
| denied | "คุณไม่อนุมัติ" | None |
| unsupported | "ทำไม่ได้: <reason>" | None |
| stale rules | "กฎเปลี่ยนแล้ว ต้องเตรียมใหม่" | Ask Jit to prepare again |

### F5. GitHub default and personal profiles [github]

**R:** S15-D17–D19, S15-AC10; the personal column is configurable, not shipped. **P:**

- Every coding work card shows a **profile badge**: "GitHub: ค่าเริ่มต้น (ถามก่อน push)" or "GitHub: ส่วนตัว r3 · owner/sandbox". The badge links to the rule.
- **Default profile:** push, PR publication/update and review replies each produce an ActionSlip. Merge needs a separate merge slip. Production holds independently.
- **Personal profile:** actions covered by the rule appear as **ledger lines** in progress, not slips: "Push แล้วตามกฎส่วนตัว r3 · head a1b2c3d". Each ledger line links to the rule and to remote evidence. Review remediation shows the review comment in an UntrustedFrame "ความเห็นจากรีวิว ไม่ใช่คำสั่ง" and the change Jit made in response.
- **Auto-merge eligibility checklist** (personal profile): target/head current · acceptance evidence · required checks · required reviews · production consequence. Each item is a fact with evidence. When every item passes and production is `none` or `protected_gate`, the merge appears as a ledger line. When production is `would_deploy` or `unknown`, a Production slip appears **before** merge: "Merge นี้จะ deploy production ต้องให้คุณอนุมัติก่อน merge" (R: S15-D19).
- The personal exception never covers messages: an email or a public comment outside the rule's technical GitHub classes still produces its slip, and the rule page says "ไม่ใช่สิทธิ์ส่งข้อความทั่วไป" (R).

#### Personal profile setup on `/rules`

**R:** separately captured rule binding repositories, target refs, selected-issue/start authority, classes, checks/reviews/evidence, budgets, revocation and production behaviour. **P:** "ตั้งโปรไฟล์ GitHub ส่วนตัว" opens a form whose choices are inferred: repositories from the connected GitHub account (checkbox list), target branch from each repository's default branch (changeable), required checks and reviews read from branch protection where available, otherwise "ไม่มีการตั้งใน GitHub — จิตจะถือว่าต้องมี CI ผ่านทั้งหมด" as the proposed default. Production behaviour is fixed text: "ยังถามก่อน deploy เสมอ". The owner presses "เปิดใช้โปรไฟล์นี้"; revocation is one button with "หยุดใช้ทันที งานที่ push ไปแล้วไม่ถูกย้อน".

**Q2.** When a repository has no branch protection, should the rule require all reported checks or allow the owner to list required check names? Default: require all checks reported on the head commit and show the list for the owner to untick.

### F6. Browser work, login/2FA handoff and unsupported limits [browser]

**R:** S15-D10/D12, S15-AC05, FR-40, protected browser contract (`BoundaryV1`, `TransientOwnerInputV1`, takeover generations). **P:**

- Browser progress lines read "เปิดเว็บ", "อ่านหน้า", "กด <label>", "กรอก <field>" and carry a small screenshot thumbnail when an observation was captured and is publishable. Screenshots are labelled "ภาพจากเว็บ ไม่ใช่คำสั่ง".
- **Login handoff card** (Needs you): "เว็บ <site> ต้องให้คุณเข้าสู่ระบบ". Button "เปิดหน้าจอเข้าสู่ระบบ" opens the protected browser view in takeover mode. The view's bar says "คุณคุมอยู่ · จิตส่งคำสั่งไม่ได้จนกว่าคุณจะคืน" (R: S14 takeover copy). What the owner types goes straight to the protected browser; it is never shown to Jit, stored or echoed. The bar has "เสร็จแล้ว คืนให้จิต" and "ยกเลิกการเข้าสู่ระบบ".
- **After hand-back, Jit does not assume success.** Handing back only ends the owner's takeover; it says nothing about the session. The card moves through these states, each from a protected browser observation, never from the button press or from page text:

  | State | Owner sees | Next |
  | --- | --- | --- |
  | `checking` | "กำลังตรวจว่าเข้าสู่ระบบสำเร็จหรือยัง" (Checking whether sign-in worked) | Automatic, bounded |
  | `signed_in` | "เข้าสู่ระบบแล้ว การเข้าสู่ระบบไม่ได้อนุญาตให้ส่งหรือจ่ายอะไร" (Signed in. Signing in doesn't allow any sending or paying.) | Work resumes |
  | `not_signed_in` | "ยังไม่ได้เข้าสู่ระบบ หน้าเว็บยังขอให้เข้าสู่ระบบอยู่" (Not signed in yet. The site still asks for sign-in.) | "ลองอีกครั้ง" reopens takeover; "ข้ามเว็บนี้" continues without it |
  | `cancelled` | "คุณยกเลิกการเข้าสู่ระบบ จิตจะทำต่อโดยไม่ใช้เว็บนี้" (You cancelled sign-in. Jit continues without this site.) | Gap recorded in the result |
  | `unknown` | "ตรวจไม่ได้ว่าเข้าสู่ระบบแล้วหรือยัง" (Can't tell whether sign-in worked) | "ลองอีกครั้ง" or "ข้ามเว็บนี้"; never treated as signed in |

- **2FA**: same card, heading "ใส่รหัสยืนยันของ <site>".
- While the card waits, the work is "รอคุณเข้าสู่ระบบ" (waiting, not stalled; no active budget use).
- **Unsupported step (LimitNotice):** "จิตทำขั้นนี้ไม่ได้: ยังพิสูจน์ไม่ได้ว่าการกด ‘ยืนยัน’ บนเว็บนี้จะส่งอะไรออกไป" with three choices: "คุมเองแล้วทำขั้นนี้ด้วยตัวเอง" (owner takeover; the owner acts), "ข้ามขั้นนี้" and "ดูรายละเอียด". Uploads, file choosers and clipboard are shown as "เวอร์ชันนี้ยังอัปโหลดไฟล์บนเว็บไม่ได้" (R: no generic upload port in v1).
- **Held website effects:** a send, purchase or post on a website becomes an ActionSlip with the exact final request summary (recipient, content, amount) — only when the browser adapter supports that action class. Otherwise it is a LimitNotice, never a slip with a disabled button that looks approvable.
- **Read-only site** facts appear in the result's Gaps: "อ่านได้ 6 หน้า · 1 หน้าต้องเข้าสู่ระบบแต่ข้ามไป".

### F7. Working computer in daily use [vm]

**R:** S15-D02/D03, S15-AC03. **P:**

- Commands appear as progress lines with exit status. Output opens in an expandable mono block labelled "ผลจากเครื่องทำงาน · รายงานโดยเครื่อง" (Reported by the working computer). Remote facts that Jit verified outside the VM carry "ตรวจจากภายนอกแล้ว" instead (R: guest-reported versus protected evidence).
- Installing programs, Docker and services is ordinary and needs no card.
- **Boundary refusal:** when work asks for something outside the VM, the line says "ทำไม่ได้จากเครื่องทำงาน: <boundary>" (for example "บัญชี GitHub อยู่นอกเครื่องนี้ ใช้ผ่านการ push ที่ตรวจแล้วเท่านั้น"). It never claims success (R: S15-AC03).
- Disruptive or destructive VM changes that Jit chooses to do first ask as a DecisionCard when impact is major (R: S15-D03); under option B the owner has accepted that guest-local damage is recovered by restore, so ordinary admin does not ask.

### F8. Memory: inspect, correct, forget [memory]

**R:** S15-D14, S15-AC13, FR-05/16. **P:**

- Under a reply, a quiet disclosure "จำไว้ 2 เรื่อง" lists what was retained: the statement, a **Fact** or **Inference** tag ("ข้อเท็จจริง" / "ข้อสันนิษฐาน"), its source (this message, a document, a website) and two buttons "แก้" and "ลืม". Nothing is retained silently without this note (P).
- `/memory` lists claims with filters: Facts · Inferences · Preferences · Corrected · Forgotten · From S14 (private). Each row shows source and time, scope ("ทีม" or "เฉพาะ <Bot> · ส่วนตัวจาก S14"), and lifecycle state.
- **Correct:** an inline field prefilled with the old statement; "บันทึกการแก้" records the owner's correction, which takes precedence. The old claim shows "ถูกแก้โดยคุณ".
- **Forget:** a confirmation sheet states the impact: "จะไม่ถูกค้นหาหรือใช้ในงานต่อไป · งานที่ใช้ไปแล้ว 3 งานจะถูกทำเครื่องหมาย · สิ่งที่โมเดลเคยเห็นไปแล้วเรียกคืนไม่ได้" and "ลืม" as a danger button.
- If the owner types something credential-shaped, the message row says "จิตไม่เก็บรหัสผ่านหรือ token ข้อความนี้ถูกกันไว้ ไม่ส่งให้โมเดล" and suggests the account connection flow (R: credentials never become memory; `credential_content_refused`).
- No import surface exists in this design; future external memory (Jod) is deferred (R: S15-D14).

### F9. Responsibilities, waits and stalled work [duty, stall]

**R:** S15-D13/D22, S15-AC12/AC15, FR-04/26/28. **P:**

- "คอยดูแล PR #352 จนผ่าน" creates a **ResponsibilityCard** in the conversation and on `/work`: the owner's words quoted, the subject, "จบเมื่อ" (completion rule), "จิตทำเองได้" (from current rules) and "ยังถามคุณก่อน". States: working · รอ CI · รอรีวิว · รอคุณ · หยุดพัก (stalled) · เสร็จ · หยุดแล้ว.
- **Durable waits** read "รอ CI อยู่ จิตจะกลับมาดูเองเมื่อเสร็จ ไม่ต้องทำอะไร" and never appear in Needs you. After a restart: "ยังดูแลอยู่หลังรีสตาร์ต" (R: waits survive restart).
- **Out-of-purpose finding:** a proposal slip "พบเรื่องนอกหน้าที่: …" with "รับเป็นงานใหม่" and "ไม่สนใจ". Accepting keeps it as a task; starting it is an ordinary message (R: proposals are not new authority).
- **Stall report** (Needs you): "หยุดพักไว้: ลอง 3 วิธีแล้วยังไม่คืบ" with a numbered list of attempts (approach, evidence link, what happened), budget used for this work as words and a meter ("ใช้ไปประมาณครึ่งหนึ่งของงบงานนี้" or "ไม่ทราบบางส่วน"), Jit's recommendation in an UntrustedFrame, and three choices: "ลองตามที่แนะนำ" (prefills that instruction), "บอกวิธีอื่น" (focuses the composer) and "หยุดงานนี้". Other authorized work continues and the report says so. Each choice leads to a visible next state on the same report: after the owner sends the recommendation or their own approach, the report shows that owner message, "ทำต่อแล้ว · หน้าที่เดิม" (Resumed · same responsibility) and the new attempt as a progress line; after stop, "สั่งหยุดแล้ว · กำลังรอให้สิ่งที่ค้างจบจริง" and then "หยุดแล้ว". The report never sits unchanged after an owner reply.
- **Stop** names its scope: "หยุดเฉพาะ ‘ดูแล PR #352’ · งานอื่น 2 งานยังทำต่อ". Afterwards: "สั่งหยุดแล้ว · กำลังรอให้สิ่งที่ค้างจบจริง" until settlement, then "หยุดแล้ว". Late results after stop are not shown as new results (R).
- **Partial result:** pill "ได้บางส่วน" and a Gaps section that lists exactly what is missing; partial never appears as done.

### F10. Models and budget [models]

**R:** S15-D07/D23, S15-AC08/AC14, model selection contract. **P:**

- **Per-reply disclosure** in the footer: "ตอบด้วย <model> · คิด: สูง". Opening it shows "เลือกเพราะ: งานซับซ้อน (ในรายการที่คุณอนุมัติ)" and, if relevant, "ผู้ให้บริการไม่ยืนยันว่าใช้ระดับความคิดนี้" (`effort_unproven`/`effort_ignored`). A pinned choice shows "ตามที่คุณปักไว้".
- `/models` lists approved accounts and models. Each model has "อนุญาต" and "ปักไว้สำหรับ…" controls. Adding a provider or account uses the existing one-click sign-in and is never done by Jit (R).
- **Budget meters**: each finite ceiling shows "ใช้ไป" (charged), "วัดได้จริง" (measured) and "ไม่ทราบ" (unknown) in words with a meter; unknown is never shown as zero (R: NFR-06). The amount is the owner's typed value; no default amount is shown.
- **Budget hold** (Needs you): "งบใช้งานหมด งานใหม่ที่ต้องใช้โมเดลจะรอ" with "เพิ่มงบ" linking to `/models`. Jit can mention the need in chat but the change happens only on the protected page.
- **Unavailable route:** "บัญชี <provider> ใช้ไม่ได้ตอนนี้ (โควตาเต็ม) จิตไม่เปลี่ยนไปใช้บัญชีอื่นเอง". When an approved alternative exists inside the same account and billing, Jit may use it and the disclosure says "ใช้ <model B> แทน เพราะ <model A> ไม่ว่าง".

### F11. Evidence, recovery and VM restore [evidence, recovery, restore]

**R:** S15-D22, S15-AC07/AC15/AC16, ADR 0065, option B. **P:**

- **Evidence tab** per work groups evidence by origin: "ตรวจจากภายนอก" (protected/remote verified), "รายงานโดยเครื่องทำงาน" (guest reported), "ภาพและข้อความจากเว็บ", "ไฟล์ที่ได้". Each item has time, producing step and, where it exists, a hash in the receipt disclosure.
- **Reconnect:** a top banner "เชื่อมต่อใหม่แล้ว · ไม่มีอะไรถูกส่งซ้ำ" (Reconnected · nothing was sent again). Events missed while disconnected appear in order; nothing re-runs.
- **After restart:** `/recovery` lists "ค้างอยู่ 2 งาน · ไม่ทราบผล 1 การกระทำ". Unknown actions offer only read-only checks and owner statements (existing `web-statement.ts`), never "ส่งใหม่".
- **VM broken:** the working computer card states "เครื่องทำงานไม่ตอบ" / "เครื่องทำงานเสีย" with the last known facts. Jit may propose a restore in chat. **Restore slip:** "ย้อนเครื่องทำงานไปที่ snapshot <time>" with the impact in words: what inside the VM will be lost (work files after the snapshot, installed programs, running services), what is not affected ("ข้อมูลของคุณนอกเครื่อง อีเมลที่ส่งแล้ว PR และการจ่ายเงิน ไม่ถูกย้อน"), and "งานที่ใช้เครื่องนี้จะหยุดก่อน". Button "ย้อนเครื่อง 1 ครั้ง".
- **Q3.** Under option B, may a standing rule let Jit restore its own expendable VM without asking? Default: the restore waits for the owner, because the management contract requires current owner impact authority and stopping sibling work.
- **Adoption status** (S15-AC16) lives under Installation: "รุ่นที่ใช้: S14 · S15 ยังไม่เปิดใช้" with what adoption will keep (all S14 history, private items stay private, rollback point) and the exact tested build when one exists. The adoption command itself belongs to MIG15/CUT15 and is out of this handoff's UI scope beyond this status block.

### F12. Team resources and restrictions [resources]

**R:** S15-D11, S15-AC04, team resources contract. **P:**

- `/resources/accounts` lists connected accounts and website sessions as rows: name, what the team can do with it ("อ่านอีเมล · ร่างอีเมล"), "ใช้ได้ทั้งทีม" or "เฉพาะ <Bot>", and connection health.
- "จำกัดให้เฉพาะ…" opens a Bot checklist; narrowing applies immediately; widening back to the team is an explicit owner action.
- Items from S14 show "ส่วนตัวของ <Bot> จาก S14 · ยังไม่แชร์ให้ทีม" (R: no silent declassification). Converting one is an exact card "แชร์ <item> ให้ทั้งทีม" that names the item, revision and receivers; it is never offered as "แชร์ทั้งหมด" (R: no broad conversion).
- Browser input conflicts appear in progress as "รอใช้เบราว์เซอร์ <site> · <Bot> ใช้อยู่", not as an error.

### F13. Recurring-payment rules [payment]

**R:** S15-D08, S15-AC08, standing policy `RuleV1.mode:'recurring_payment'` with `recurrence {payee, account, currency, amountCeilingMinor, frequency}`; the claim verifies frequency and cumulative use; deviations hold. **P:**

- **From a held payment.** A payment slip shows a quiet secondary control below its OwnerStrip: "ตั้งเป็นกฎจ่ายประจำ" (Make this a recurring rule). It never replaces the one-time decision: approving the current payment and creating a rule are separate owner actions. Pressing it opens a **RuleProposal slip** prefilled from the exact payment: payee and paying account (fixed), currency (fixed), amount ceiling (prefilled with this payment's exact amount; the owner may change it) and frequency (the owner picks from frequencies the adapter supports; nothing is preselected unless the payment source states one).
- **From `/rules`.** "เพิ่มกฎจ่ายประจำ" (Add a recurring-payment rule) offers payees from past approved payments only. A new payee cannot be typed in, because a new payee is itself a held decision. The same RuleProposal slip follows.
- **RuleProposal slip:** heading "จิตเสนอกฎจ่ายประจำ" when Jit proposes it, "กฎจ่ายประจำใหม่" when the owner starts it; exact rows for payee, account, currency, ceiling, frequency and expiry; the consequence in plain words: "จ่ายได้เองเมื่อผู้รับ บัญชี สกุลเงินตรง ยอดไม่เกินเพดาน และไม่เกินความถี่นี้ อย่างอื่นจะถามคุณก่อน" (Pays on its own only when payee, account and currency match, the amount is within the ceiling and within this frequency. Anything else asks you first). The primary button "ตั้งกฎนี้" (Set up this rule) posts the owner's rule-install command for that exact proposal; "ไม่ตั้ง" discards it. Any suggestion text from Jit sits in an UntrustedFrame.
- **Use.** A matching payment appears as a ledger line "จ่ายแล้วตามกฎจ่ายประจำ r2 · ครั้งที่ 1 ของเดือนนี้" (Paid under recurring rule r2 · 1st this month). A deviation produces the F4 deviation slip. A rule never raises its own ceiling or frequency.
- **Revoke.** Each rule row on `/rules` has "หยุดใช้กฎนี้" (Stop using this rule) with "หยุดทันที การจ่ายที่ทำไปแล้วไม่ถูกย้อน" (Stops immediately. Payments already made are not reversed). Revoking only narrows authority, so this exact control is enough.

## 6. State vocabulary

**P.** One word per state across all surfaces. Keys map to contract states where they exist.

| Key | ไทย | English | Pill tone | In Needs you |
| --- | --- | --- | --- | --- |
| `received` | ได้รับแล้ว | Received | neutral | No |
| `understanding` | กำลังเข้าใจ | Understanding | neutral | No |
| `inspecting` | ตรวจดูอย่างเดียว | Looking only | strong outline | No |
| `working` | กำลังทำ | Working | strong outline | No |
| `waiting_ci` | รอ CI | Waiting for CI | neutral, clock | No |
| `waiting_review` | รอรีวิว | Waiting for review | neutral, clock | No |
| `waiting_login` | รอคุณเข้าสู่ระบบ | Waiting for your sign-in | `--warn`, ! | Yes |
| `needs_you` | รอคุณ | Needs you | `--warn`, ! | Yes |
| `question` | ขอถาม 1 ข้อ | One question | `--warn`, ! | Yes |
| `stalled` | หยุดพัก ยังไม่คืบ | Paused, no progress | `--warn`, ! | Yes |
| `budget_hold` | รองบ | Waiting for budget | `--warn`, ! | Yes |
| `partial` | ได้บางส่วน | Partial | `--warn`, ! | No |
| `blocked` | ติดขัด | Blocked | `--warn`, ! | Only with an owner unblock action |
| `unsupported` | ยังทำไม่ได้ | Not supported | neutral, × | No |
| `unknown` | ไม่ทราบผล | Outcome unknown | `--danger`, ? | Yes |
| `failed` | ไม่สำเร็จ | Failed | `--danger`, × | No |
| `stopping` | กำลังหยุด | Stopping | neutral | No |
| `stopped` | หยุดแล้ว | Stopped | neutral | No |
| `done` | เสร็จ | Done | `--ok`, ✓ | No |
| `changed` | ถูกแทนแล้ว | Superseded | `--warn`, ! | No |
| `expired` | หมดอายุ | Expired | neutral | No |
| `denied` | ไม่อนุมัติ | Not approved | neutral | No |

Every pill has words; colour and glyph are supplementary (R: README principle 4).

## 7. Components

### 7.1 Tree

```text
Shell (existing)
├─ Nav: Sidebar | MobileNavDisclosure, NeedsYouLink(count)
├─ Thread
│   ├─ OwnerMessage (existing) > ReceiptLine (new)
│   ├─ IntentLine (new)
│   ├─ WorkCard (changed) > ScopeLine, ProfileBadge, ProgressRegion, ResultBlock, StopStrip
│   ├─ QuestionCard (new) > ReplyChips
│   ├─ ActionSlip (generalized) > ClassChips, ExactSections, MetaRow, OwnerStrip
│   ├─ DecisionCard (new) > OptionRows, Recommendation(UntrustedFrame)
│   ├─ LoginHandoffCard, LimitNotice (new)
│   ├─ ResponsibilityCard, StallReport, ProposalSlip (new/changed)
│   └─ ReplyFooter > ModelDisclosure, MemoryNote, ReceiptDetails (new)
├─ Composer (changed: no ModeChip, no BudgetLine, no grant choices)
├─ Pane/Sheet: ActionSlip full | BrowserView(takeover) | WorkDetail tabs
├─ Pages: NeedsYou, Work, Memory, Resources(Computer, Accounts), Rules, Models, Recovery, Setup
└─ Banner, Pill, UntrustedFrame, ExactBlock, Meter (existing)
```

### 7.2 Component rules

| Component | Rule |
| --- | --- |
| ReceiptLine | Renders only from a committed receipt. Before commit: "กำลังส่ง…". Never a checkmark for model completion. |
| IntentLine | Renders only from admission/hold projections, never from model text. One line, system words, linked "ทำไมจิตทำได้" to the rule revision. |
| ScopeLine | "ตามกฎประจำ r4 · จะถามคุณก่อน: push, merge". Absent for answers. |
| ProgressRegion | Header "ความคืบหน้า (ยังไม่ใช่หลักฐาน)". At most one polite announcement per phase change. Bounded list, collapses after five lines. |
| ResultBlock | Status, Result (UntrustedFrame), Evidence, Gaps, Unblock. Missing evidence shows "ยังไม่มีหลักฐาน" and keeps the status out of `done`. |
| ActionSlip | Exact content before OwnerStrip. Class chips from adapter-derived classes. Primary button absent when unsupported. Full slip lives at `/actions/:id`; the thread shows a compact slip with a link. |
| DecisionCard | Options are system rows with evidence links; recommendation is untrusted model text. One button per option. |
| LoginHandoffCard | Opens the protected BrowserView in takeover. No text field inside Jit's page; owner input goes to the protected browser channel. |
| LimitNotice | Names the boundary and offers takeover/skip/details. Never styled like a slip and has no approve-looking button. |
| ProfileBadge | Text "GitHub: ค่าเริ่มต้น" or "GitHub: ส่วนตัว r3". Never colour-only. |
| ModelDisclosure | Model, effort, reason, pin, alternative. Reads the recorded selection, not a model's claim about itself. |
| MemoryNote | Lists retained claims with Fact/Inference, source, Correct and Forget. |
| Meter | 6 px bar plus words. Unknown part is a hatched segment with the word "ไม่ทราบ". |

### 7.3 ActionSlip anatomy

```text
┌ จิตขอส่งอีเมล                                   [รอคุณ !]
│ อีเมลถึงผู้อื่น · ข้อมูลส่วนตัวถึงผู้รับใหม่      ← class chips
│ ─────────────────────────────────────────────
│ ส่งจาก     you@example.com
│ ถึง        ...exact recipients...
│ หัวเรื่อง   ...exact...
│ เนื้อความ   ...exact, never truncated...
│ ไฟล์แนบ    quote.pdf · PDF · 182 KB · เปิดดู
│ ─────────────────────────────────────────────
│ r1 · หมดอายุใน 45 นาที · ไม่มีกฎประจำที่ครอบคลุม
│ 🔒 ส่วนที่คุณตัดสินใจ
│ [ ส่ง 1 ครั้ง ]  [ ไม่ส่ง ]  [ ขอแก้ ]
│ การอนุมัติใช้ได้ครั้งเดียว กับเนื้อหานี้เท่านั้น
└
```

## 8. Visual system

**R:** reuse the S14 Plain tokens in `src/s14/web-design.ts` and the shared tokens in `src/web-design.ts` (README). **P:** no new colour, size, radius or duration token is needed. New components compose existing classes: slips use `s-slip`, exact content uses `s-exact`, owner actions use `s-strip`, untrusted text uses `s-untrusted`, pills use `s-pill`. The prototype uses system fonts and inline CSS for review only; it is not production CSS precedent (R: NFR-13).

## 9. Accessibility, keyboard and focus

All existing S14 rules continue (R: skip link, one `main`, `lang`, zoom, names, focus ring, reduced motion, forced colours). S15 additions (P):

- **Composer:** Enter sends, Shift+Enter inserts a newline and an IME-composition Enter never sends (existing `src/s14/web-enhance.js` behaviour, retained). After send, focus stays in the composer.
- **Live announcements:** one polite line per phase: "จิตเริ่มทำแล้ว", "รอคุณอนุมัติ 1 รายการ", "งานเสร็จแล้ว". Progress lines are never announced one by one.
- **Held actions:** a new slip is announced politely once and never steals focus while the owner is typing. "Needs you" count updates with an `aria-live="polite"` region.
- **Opening a slip:** focus moves to its heading. The primary button is not focused automatically. Tab order is exact content → meta → primary → deny → revise.
- **No single-key approval.** No access key, command palette entry or keyboard shortcut approves, sends, pays, merges or deploys.
- **Takeover view:** focus moves to the view's bar; the image has a text alternative (page title, address, last action). "คืนให้จิต" is the first control. Esc does not hand back control (P: avoids accidental hand-back while typing a password).
- **Sheets/panes:** background inert, Esc closes the top layer (except takeover), focus returns to the opener.
- **Thai:** never truncate important copy mid-word; use `Intl.Segmenter` for any visual clipping of lane lines; exact content is never clipped.
- **Mobile:** touch targets at least 44 × 44 px; OwnerStrip buttons stack vertically below 400 px.

Real device, screen-reader and browser evidence must be labelled separately when implementation exists (R: NFR-11). This Markdown does not claim it.

## 10. Copy and dictionary-key intent

**R:** `ui.i18n_dictionary/v1` (`src/i18n/index.ts`): Thai defines the key set and English must define every key; values are trusted plain-text constants; owner and model content never become keys or values. **P:** S15 keys use the `s15.` prefix. Exact key names freeze in UX15 slices against frozen contracts; the intent below is the handoff.

### 10.1 Terms

| Term | ไทย | English | Avoid |
| --- | --- | --- | --- |
| Standing policy | กฎประจำ | Standing rules | ขอบเขต, grant, permission |
| Working VM | เครื่องทำงาน | Working computer | VM in Thai prose, กล่อง, sandbox |
| Held action | รอคุณอนุมัติ | Waiting for your approval | effect |
| Approve once | … 1 ครั้ง | … once | ยืนยัน, ตกลง |
| Responsibility | หน้าที่ | Responsibility | routine (reserved), automation |
| Stalled | หยุดพัก ยังไม่คืบ | Paused, no progress | ค้าง, error |
| Durable wait | รอ CI / รอรีวิว | Waiting for CI / review | ค้าง |
| Report only | ตรวจดูอย่างเดียว | Looking only | วิเคราะห์ |
| Website session | การเข้าสู่ระบบเว็บ | Website sign-in | cookie, session |
| Personal GitHub profile | โปรไฟล์ GitHub ส่วนตัว | Personal GitHub profile | auto mode |
| Budget | งบใช้งาน | Usage budget | เครดิต |
| Unsupported | ยังทำไม่ได้ | Not supported yet | ผิดพลาด |

### 10.2 Key intent (core set)

| Key | ไทย | English | Intent |
| --- | --- | --- | --- |
| `s15.composer.placeholder` | พิมพ์ถึงจิตได้เลย… | Message Jit… | Composer hint; no mode |
| `s15.composer.sending` | กำลังส่ง… | Sending… | Before receipt commit |
| `s15.composer.refused_kept` | ยังส่งไม่ได้ ข้อความยังอยู่ในช่องพิมพ์ | Not sent. Your text is still in the box. | Refused submit |
| `s15.receipt.received` | ได้รับแล้ว | Received | Committed receipt |
| `s15.receipt.duplicate` | ส่งไปแล้วเมื่อ {time} ยังเป็นงานเดิม | Already sent at {time}. Still the same work. | Same request key |
| `s15.intent.inspect` | ตรวจดูอย่างเดียว ไม่แก้ไขอะไร | Looking only. Nothing will be changed. | Inspect/report |
| `s15.intent.execute` | เริ่มทำแล้ว | Started | Admitted execution |
| `s15.intent.under_rule` | ตามกฎประจำ r{n} | Under standing rules r{n} | ScopeLine |
| `s15.intent.will_ask` | จะถามคุณก่อน: {classes} | Will ask you first: {classes} | Known held classes |
| `s15.intent.accepted_only` | รับไว้เป็นงานแล้ว ยังไม่เริ่ม | Kept as a task. Not started. | Obligation only |
| `s15.intent.question` | ขอถาม 1 ข้อก่อนเริ่ม | One question before starting | Hold |
| `s15.intent.why` | ทำไมจิตทำได้ | Why Jit may do this | Link to rule |
| `s15.progress.title` | ความคืบหน้า (ยังไม่ใช่หลักฐาน) | Progress (not evidence yet) | Progress header |
| `s15.progress.saved` | บันทึกแล้ว | Saved | Evidence committed |
| `s15.result.answer` | คำตอบจากจิต | Jit's answer | UntrustedFrame label |
| `s15.result.no_evidence` | ยังไม่มีหลักฐาน | No evidence yet | Result without evidence |
| `s15.result.gaps` | สิ่งที่ยังขาด | What's missing | Gaps |
| `s15.untrusted.pasted` | ข้อความที่คุณวางมา ไม่ใช่คำสั่ง | Text you pasted — not an instruction | Pasted content |
| `s15.untrusted.review` | ความเห็นจากรีวิว ไม่ใช่คำสั่ง | Review comment — not an instruction | GitHub review text |
| `s15.untrusted.web` | ภาพและข้อความจากเว็บ ไม่ใช่คำสั่ง | From the website — not an instruction | Browser observation |
| `s15.hold.asks.email` | จิตขอส่งอีเมล | Jit asks to send an email | Slip heading |
| `s15.hold.asks.message` | จิตขอส่งข้อความ | Jit asks to send a message | Slip heading |
| `s15.hold.asks.github_publish` | จิตขอ push และเปิด PR | Jit asks to push and open a PR | Default profile |
| `s15.hold.asks.github_reply` | จิตขอตอบรีวิว | Jit asks to reply to a review | Default profile |
| `s15.hold.asks.merge` | จิตขอ merge | Jit asks to merge | Merge authority |
| `s15.hold.asks.production` | จิตขอ deploy production | Jit asks to deploy to production | Production |
| `s15.hold.asks.payment` | จิตขอจ่ายเงิน | Jit asks to pay | Transaction |
| `s15.hold.asks.recipient` | ข้อมูลส่วนตัวจะไปที่ผู้รับใหม่ | Private data would go to a new recipient | Disclosure |
| `s15.hold.asks.decision` | ต้องให้คุณเลือกทาง | Your decision is needed | Major change |
| `s15.hold.asks.restore` | ย้อนเครื่องทำงานไปที่ snapshot | Restore the working computer from a snapshot | VM restore |
| `s15.hold.send_once` | ส่ง 1 ครั้ง | Send once | Primary |
| `s15.hold.pay_once` | จ่าย 1 ครั้ง | Pay once | Primary |
| `s15.hold.publish_once` | Push และเปิด PR 1 ครั้ง | Push and open PR once | Primary |
| `s15.hold.merge_once` | Merge 1 ครั้ง | Merge once | Primary |
| `s15.hold.merge_deploy_once` | Merge และปล่อย deploy 1 ครั้ง | Merge and let it deploy once | Production via merge |
| `s15.hold.allow_once` | อนุญาตเฉพาะครั้งนี้ | Allow this time only | New recipient |
| `s15.hold.deny` | ไม่ทำ | Don't do it | Deny |
| `s15.hold.revise` | ขอแก้ | Ask for changes | Revise |
| `s15.hold.single_use` | การอนุมัติใช้ได้ครั้งเดียว กับเนื้อหานี้เท่านั้น | One approval, for this exact content only | Strip note |
| `s15.hold.no_rule` | ไม่มีกฎประจำที่ครอบคลุม | No standing rule covers this | Meta |
| `s15.hold.unsupported` | จิตยังทำสิ่งนี้อย่างปลอดภัยไม่ได้ จึงไม่มีปุ่มส่ง | Jit can't do this safely yet, so there's no send button | Missing support |
| `s15.hold.from_message` | อนุมัติจากข้อความของคุณ {time} | Approved by your message at {time} | Chat approval |
| `s15.hold.which` | หมายถึงอันไหน | Which one do you mean? | Ambiguous approval |
| `s15.hold.changed` | ถูกแทนด้วย r{n} การอนุมัติเดิมใช้ไม่ได้ | Replaced by r{n}. The earlier approval no longer applies. | Superseded |
| `s15.hold.unknown` | ไม่ทราบผล จิตจะไม่ส่งซ้ำเอง | Outcome unknown. Jit won't resend on its own. | Unknown |
| `s15.hold.verified` | ตรวจจากปลายทางแล้ว | Confirmed at the destination | Remote verified |
| `s15.decision.recommend` | จิตแนะนำ | Jit recommends | UntrustedFrame label |
| `s15.decision.continue_safe` | ระหว่างรอ จิตจะลองในที่แยกไว้ต่อ ไม่แตะของจริง | While you decide, Jit keeps trying in an isolated copy and won't touch the real thing | Isolated investigation |
| `s15.decision.already` | ตัดสินใจไว้แล้ว {date} · {option} | Decided on {date} · {option} | Retained direction |
| `s15.github.default` | GitHub: ค่าเริ่มต้น (ถามก่อน push) | GitHub: default (asks before push) | Profile badge |
| `s15.github.personal` | GitHub: ส่วนตัว r{n} | GitHub: personal r{n} | Profile badge |
| `s15.github.ledger_push` | Push แล้วตามกฎส่วนตัว r{n} | Pushed under personal rule r{n} | Ledger line |
| `s15.github.prod_before_merge` | Merge นี้จะ deploy production ต้องให้คุณอนุมัติก่อน merge | This merge would deploy to production. It needs your approval before merging. | Production hold |
| `s15.github.not_messaging` | ไม่ใช่สิทธิ์ส่งข้อความทั่วไป | Not a general permission to send messages | Rule page note |
| `s15.readiness.no_pick` | จิตจะไม่เลือกเองว่าจะทำข้อไหน | Jit won't choose which one to do | Readiness report |
| `s15.readiness.do_this` | ทำข้อนี้ | Do this one | Prefill chip |
| `s15.browser.login` | เว็บ {site} ต้องให้คุณเข้าสู่ระบบ | {site} needs you to sign in | Handoff card |
| `s15.browser.open_login` | เปิดหน้าจอเข้าสู่ระบบ | Open the sign-in screen | Handoff button |
| `s15.browser.driving` | คุณคุมอยู่ · จิตส่งคำสั่งไม่ได้จนกว่าคุณจะคืน | You're driving · Jit can't send input until you hand back | Takeover bar |
| `s15.browser.hand_back` | เสร็จแล้ว คืนให้จิต | Done, hand back to Jit | Takeover button |
| `s15.browser.checking` | กำลังตรวจว่าเข้าสู่ระบบสำเร็จหรือยัง | Checking whether sign-in worked | After hand-back |
| `s15.browser.login_no_power` | เข้าสู่ระบบแล้ว การเข้าสู่ระบบไม่ได้อนุญาตให้ส่งหรือจ่ายอะไร | Signed in. Signing in doesn't allow any sending or paying. | Observed signed-in session |
| `s15.browser.not_signed_in` | ยังไม่ได้เข้าสู่ระบบ หน้าเว็บยังขอให้เข้าสู่ระบบอยู่ | Not signed in yet. The site still asks for sign-in. | Observed failure |
| `s15.browser.cancelled` | คุณยกเลิกการเข้าสู่ระบบ จิตจะทำต่อโดยไม่ใช้เว็บนี้ | You cancelled sign-in. Jit continues without this site. | Owner cancel |
| `s15.browser.login_unknown` | ตรวจไม่ได้ว่าเข้าสู่ระบบแล้วหรือยัง | Can't tell whether sign-in worked | Never treated as signed in |
| `s15.rules.recurring_from_payment` | ตั้งเป็นกฎจ่ายประจำ | Make this a recurring rule | From a payment slip |
| `s15.rules.recurring_set` | ตั้งกฎนี้ | Set up this rule | RuleProposal primary |
| `s15.rules.recurring_scope` | จ่ายได้เองเมื่อผู้รับ บัญชี สกุลเงินตรง ยอดไม่เกินเพดาน และไม่เกินความถี่นี้ อย่างอื่นจะถามคุณก่อน | Pays on its own only when payee, account and currency match, the amount is within the ceiling and within this frequency. Anything else asks you first. | RuleProposal consequence |
| `s15.rules.revoke` | หยุดใช้กฎนี้ | Stop using this rule | Revoke |
| `s15.browser.limit` | จิตทำขั้นนี้ไม่ได้: {reason} | Jit can't do this step: {reason} | LimitNotice |
| `s15.browser.do_it_myself` | คุมเองแล้วทำขั้นนี้ด้วยตัวเอง | Take over and do this step yourself | LimitNotice |
| `s15.browser.no_upload` | เวอร์ชันนี้ยังอัปโหลดไฟล์บนเว็บไม่ได้ | This version can't upload files to websites yet | Unsupported upload |
| `s15.vm.title` | เครื่องทำงาน | Working computer | Section |
| `s15.vm.paste_line` | วางบรรทัดนี้ในเครื่องใหม่ครั้งเดียว | Paste this line into the new machine once | Enrolment |
| `s15.vm.address` | ที่อยู่ของเครื่อง | Machine address | Only typed field |
| `s15.vm.check` | ตรวจเครื่อง | Check the machine | Host-initiated check |
| `s15.vm.use` | ใช้เครื่องนี้เป็นเครื่องทำงาน | Use this as the working computer | Registration |
| `s15.vm.option_b` | จิตมีสิทธิ์เต็มในเครื่องนี้ ข้อมูลสำคัญ รหัสผ่าน และการส่งออกไปข้างนอกอยู่นอกเครื่องนี้เสมอ ถ้าเครื่องพัง ย้อนกลับจาก snapshot ได้ | Jit has full control of this machine. Your important data, passwords and anything that leaves for the outside world stay outside it. If it breaks, it can be restored from a snapshot. | Option B statement |
| `s15.vm.reported` | รายงานโดยเครื่องทำงาน | Reported by the working computer | Guest-reported evidence |
| `s15.vm.verified_outside` | ตรวจจากภายนอกแล้ว | Verified outside the working computer | Protected evidence |
| `s15.vm.boundary` | ทำไม่ได้จากเครื่องทำงาน: {boundary} | Can't be done from the working computer: {boundary} | Boundary refusal |
| `s15.vm.no_snapshot` | จิตย้อนเครื่องเองไม่ได้ ใช้ snapshot ใน {hypervisor} แล้วกด ตรวจเครื่อง อีกครั้ง | Jit can't restore this machine itself. Use a snapshot in {hypervisor}, then press Check the machine again. | No snapshot adapter |
| `s15.vm.restore_keeps` | ข้อมูลของคุณนอกเครื่อง อีเมลที่ส่งแล้ว PR และการจ่ายเงิน ไม่ถูกย้อน | Your data outside the machine, sent emails, PRs and payments are not rolled back | Restore impact |
| `s15.setup.does_alone` | จิตทำเองได้ | Jit does these on its own | Rules review |
| `s15.setup.always_asks` | ถามคุณก่อนเสมอ | Always asks you first | Rules review |
| `s15.setup.budget_required` | ใส่งบใช้งานก่อน จิตจะไม่เดาตัวเลขให้ | Enter a usage budget first. Jit won't guess a number for you. | Empty budget |
| `s15.setup.no_reviewed_value` | ยังไม่มีค่าที่ตรวจแล้ว | No reviewed value yet | Missing profile |
| `s15.setup.apply_rules` | ใช้กฎนี้ | Use these rules | policy.install |
| `s15.setup.personal_off` | โปรไฟล์ GitHub ส่วนตัว: ปิดอยู่ ตั้งได้ที่ กฎประจำ | Personal GitHub profile: off. Set it up under Standing rules. | First-run note |
| `s15.memory.retained` | จำไว้ {n} เรื่อง | Remembered {n} things | MemoryNote |
| `s15.memory.fact` | ข้อเท็จจริง | Fact | Tag |
| `s15.memory.inference` | ข้อสันนิษฐาน | Inference | Tag |
| `s15.memory.correct` | แก้ | Correct | Action |
| `s15.memory.forget` | ลืม | Forget | Action |
| `s15.memory.forget_impact` | จะไม่ถูกค้นหาหรือใช้ในงานต่อไป · สิ่งที่โมเดลเคยเห็นไปแล้วเรียกคืนไม่ได้ | It won't be searched or used in later work · What a model already saw can't be recalled | Forget sheet |
| `s15.memory.credential_refused` | จิตไม่เก็บรหัสผ่านหรือ token ข้อความนี้ถูกกันไว้ ไม่ส่งให้โมเดล | Jit doesn't keep passwords or tokens. This text was held back and not sent to a model. | Credential refusal |
| `s15.memory.s14_private` | ส่วนตัวของ {bot} จาก S14 · ยังไม่แชร์ให้ทีม | Private to {bot} from S14 · not shared with the team | Retained privacy |
| `s15.duty.title` | หน้าที่ | Responsibility | Card |
| `s15.duty.waiting_ci` | รอ CI อยู่ จิตจะกลับมาดูเองเมื่อเสร็จ ไม่ต้องทำอะไร | Waiting for CI. Jit will check back when it finishes. Nothing to do. | Durable wait |
| `s15.duty.after_restart` | ยังดูแลอยู่หลังรีสตาร์ต | Still on it after the restart | Restart |
| `s15.duty.outside` | พบเรื่องนอกหน้าที่ | Found something outside this responsibility | Proposal |
| `s15.duty.stop_scope` | หยุดเฉพาะ ‘{name}’ · งานอื่น {n} งานยังทำต่อ | Stops only ‘{name}’ · {n} other items keep going | Stop impact |
| `s15.duty.stopping` | สั่งหยุดแล้ว · กำลังรอให้สิ่งที่ค้างจบจริง | Stop requested · waiting for open steps to really finish | Stopping |
| `s15.stall.title` | หยุดพักไว้: ลอง {n} วิธีแล้วยังไม่คืบ | Paused: tried {n} approaches with no progress | Stall report |
| `s15.stall.try_recommended` | ลองตามที่แนะนำ | Try the recommendation | Prefill |
| `s15.stall.other_way` | บอกวิธีอื่น | Suggest another way | Focus composer |
| `s15.model.used` | ตอบด้วย {model} · คิด: {effort} | Answered with {model} · thinking: {effort} | Disclosure |
| `s15.model.why` | เลือกเพราะ: {reason} (ในรายการที่คุณอนุมัติ) | Chosen because: {reason} (from your approved list) | Disclosure |
| `s15.model.effort_unproven` | ผู้ให้บริการไม่ยืนยันว่าใช้ระดับความคิดนี้ | The provider doesn't confirm it used this thinking level | Effort limit |
| `s15.model.pinned` | ตามที่คุณปักไว้ | As you pinned | Pin |
| `s15.model.no_switch` | จิตไม่เปลี่ยนไปใช้บัญชีอื่นเอง | Jit won't switch to another account on its own | Unavailable route |
| `s15.budget.charged` | ใช้ไป | Used | Charged |
| `s15.budget.measured` | วัดได้จริง | Measured | Actual |
| `s15.budget.unknown` | ไม่ทราบ | Unknown | Unknown usage |
| `s15.budget.exhausted` | งบใช้งานหมด งานใหม่ที่ต้องใช้โมเดลจะรอ | The usage budget is used up. New work that needs a model will wait. | Budget hold |
| `s15.recovery.reconnected` | เชื่อมต่อใหม่แล้ว · ไม่มีอะไรถูกส่งซ้ำ | Reconnected · nothing was sent again | Reconnect banner |
| `s15.recovery.check_again` | ตรวจอีกครั้ง (อ่านอย่างเดียว) | Check again (read only) | Reconcile |
| `s15.resources.team` | ใช้ได้ทั้งทีม | The whole team can use this | Resource scope |
| `s15.resources.only` | เฉพาะ {bots} | Only {bots} | Narrower restriction |
| `s15.resources.input_busy` | รอใช้เบราว์เซอร์ {site} · {bot} ใช้อยู่ | Waiting for the {site} browser · {bot} is using it | Lease wait |
| `s15.state.*` | §6 | §6 | One key per state |
| `s15.code.*` | — | — | One plain sentence per refusal code from the S15 contracts (`CodeV1`, `DecisionV1.code`), mirroring existing `s14.error.*` and `s14.next.*` |

Placeholders in braces are filled from trusted typed data only (time, revision, counts, resolved names). Model text never fills a placeholder in a heading or button (P, following the S14 OwnerStrip rule).

## 11. Progressive enhancement, async and reconnect

**R:** ADR 0028/0062, conversation contract event pages and cursors. **P:**

- Without script every surface is a server-rendered page; the composer posts a typed command; slips post `action.decide` with the exact action id, revision and hash; refresh shows the current state.
- With script, the thread reads bounded event pages after its cursor and replaces stable regions. A `reset` page replaces the thread with the current snapshot and shows "ข้อมูลบางส่วนเก่าเกินไป แสดงสถานะล่าสุดแทน".
- Reconnect never re-submits anything. A pending submit whose receipt is unknown shows "ไม่แน่ใจว่าส่งถึงหรือยัง กดส่งอีกครั้งได้ จิตจะไม่ทำซ้ำ" because the same request key returns the original receipt (R: request dedupe).
- Drafts stay browser-local for 30 days (R: ADR 0062). A draft never carries an approval, a selected action or a rule.
- A focused field is never replaced by a live update (R: S14 Plain inline work).

## 12. Integration surfaces

### 12.1 Existing surfaces on main (`adaba2c`)

| Surface | Path | S15 use |
| --- | --- | --- |
| Session/Host/Origin/CSRF, `/s14/commands`, `/s14/forms/*`, `/owner/setup` | `src/s14/web.ts` | Reuse the boundary and form seam; S15 needs new typed commands, not new meanings for S14 kinds |
| Shell, navigation, `ownerStrip`, `commandForm`, `untrusted`, `banner`, `pill`, `effectSlip`, `workCard`, `inlineWork`, `thread`, `composer` | `src/s14/web-pages.ts` | Shell and primitives reused; `composer`, `taskSlip`, `workCard` change as in §2 |
| View/draft model, `workLimitBounds`, `S14Draft` | `src/s14/web-product.ts` | `S14Draft.work`, limits and grant fields do not carry into S15 |
| First-run steps, provider choice | `src/s14/web-first-run.ts`, `src/s14/web-product-first-run.ts` | Extended with computer, accounts, rules and budget sections |
| Personal exact slip | `src/s14/web-personal-effect.ts` | Pattern for the email/calendar exact sections |
| Git exact page and summary | `src/s14/web-coding-effect.ts` | Pattern for GitHub publication slips and the diff page |
| Owner statement for unknown outcomes | `src/s14/web-statement.ts` | Reused unchanged |
| Recovery | `src/s14/web-recovery.ts`, `web-recovery-page.ts`, `web-product-recovery.ts` | Extended with VM/browser facts |
| Memory | `src/s14/web-memory.ts`, `web-product-memory.ts` | Extended with fact/inference, correction and forget impact |
| Library, team usage | `src/s14/web-library.ts`, `src/s14/web-team.ts` | Usage block informs budget meters |
| Drafts, live regions, focus deferral | `src/s14/web-enhance.js` | Reused; mode switch handling removed |
| Tokens and styles | `src/s14/web-design.ts`, `src/s14/web-style*.ts`, `src/web-design.ts` | Reused, no new tokens |
| Dictionary | `src/i18n/th.ts`, `src/i18n/en.ts`, `src/i18n/index.ts` | `s15.*` keys added in both |
| S14 commands `message.post`, `task.accept`, `work.start`, `work.stop`, `approval.decide`, `effect.reconcile` | S14 contracts | Retain S14 meanings; S15 UI must not post them with S15 semantics |

### 12.2 Proposed contracts the UI consumes (from the S15 contract proposals)

None of these exists as runtime code yet.

| Need | Proposed source |
| --- | --- |
| Submit, stop, receipt, duplicate | `ConversationPortV1.execute(CommandV1)` → `ReceiptV1` ([conversation](../contracts/s15-conversation-v1.md)) |
| Intent line, hold, question | `AdmissionV1`, `HoldV1` (conversation) |
| Progress and durable events, reconnect | `events(EventQueryV1)` → `EventPageV1`, `EventV1`/`ProgressV1` (conversation) |
| Result block | `ReplyV1`, `readReply` (conversation) |
| Slip content and states | `PreparedActionV1`, `DetailsV1`, `ApprovalV1`, `DecisionV1`, `ObservationV1` ([standing policy](../contracts/s15-standing-policy-v1.md)) |
| Approve/deny, rules install, revoke | `OwnerBodyV1` kinds `action.decide`, `policy.install`, `authority.revoke` (standing policy) |
| Chat approval resolution | `ConversationPolicyPortV1.decide` with `ActionBindingV1` (conversation) |
| Working computer status, snapshot, restore | `VmManagementPortV1`, `ManagementCommandV1` kinds `attach`, `status`, `snapshot`, `restore` ([working VM](../contracts/s15-working-vm-v1.md)) |
| Login/2FA and takeover | `BoundaryV1`, `TransientOwnerInputV1`, takeover generations ([protected browser](../contracts/s15-protected-browser-v1.md)) |
| Model disclosure, effort limits, refusal codes | Selection receipt and `CodeV1` ([model selection](../contracts/s15-model-selection-v1.md)) |
| Team scope, restrictions, input waits | [Team resources](../contracts/s15-team-resources-v1.md) effective scope and lease states |
| Adoption status | Adoption record fields ([state transition](../contracts/s15-state-transition-v1.md)) |

### 12.3 Contracts this design needs that no S15 contract defines yet (proposed here)

These are UI-driven requirements for the owning slices; each must be frozen there before its UX slice is ready.

| Proposed contract | Owner slice | Shape the UI needs |
| --- | --- | --- |
| Owner view projections `s15.owner-view/v1` | CHAT15-01 #323 with POLICY15-01 #320 | Safe read-only projections for conversation rows, intent line, scope line, Needs-you list and slip display (including full payload bytes for exact rendering) |
| Working computer registration command | VM15-01 #321 | Owner command binding typed address, observed identity fingerprint and transport profile; observed capability rows with states |
| Rule proposal for first run | POLICY15-01 #320 | A protected proposal with plain-language rows, finite fields the owner must fill and fields with reviewed values; `proposalHash` for `policy.install` |
| Personal GitHub rule capture | GIT15-02 #329 | Repository list from the connected account, target ref, required checks/reviews from branch protection, revoke |
| Responsibility and stall projection | WORK15-01 #327 | Responsibility state, waits, attempt list with evidence refs, budget use with unknown parts, scoped stop impact |
| Memory claim view and commands | MEM15-01 #325 | Claim kind, source, scope, lifecycle, correction and forget impact counts |
| Budget view | MODEL15-01 #326 | Charged, measured and unknown per finite ceiling; route availability; pins |
| Readiness report rows | GIT15-01 #328 | Per-issue state and checked reasons with evidence refs |

## 13. Coverage

### 13.1 Decisions

| Decision | Where |
| --- | --- |
| S15-D01 chat is the entry point | §1, §2, F2 |
| S15-D02 owner-supplied VM | F1 enrolment, F7 |
| S15-D03 VM administration; major changes ask | F7, F4 DecisionCard |
| S15-D04 reversible personal edits run | F2 (ordinary execution, no card), F1 rules list |
| S15-D05 email final review, one approval | F4 |
| S15-D06 messages to others; owner replies are ordinary | F4, F2 result |
| S15-D07 finite operating budget, no amount | F1 budget, F10 |
| S15-D08 payments and recurring rules | F4 payment and deviation rows; F13 recurring-rule setup, use and revoke on `/rules` |
| S15-D09 business records vs new commitments | F4 DecisionCard |
| S15-D10 browser core, login/2FA handoff | F6 |
| S15-D11 shared team resources | F12 |
| S15-D12 system-enforced gates, honest limits | §1, F4, F6 LimitNotice |
| S15-D13 responsibilities; outside purpose is a proposal | F9 |
| S15-D14 automatic memory with correction/forget; Jod deferred | F8 |
| S15-D15 GitHub scenario babysitting | F3, F5, F9 |
| S15-D16 no automatic issue selection | F3 |
| S15-D17 default vs personal GitHub publication | F5 |
| S15-D18 personal auto-merge eligibility | F5 checklist |
| S15-D19 production always waits, before merge if needed | F4, F5 |
| S15-D20 new private-data recipient | F4 |
| S15-D21 major change by impact | F4 DecisionCard |
| S15-D22 stall pause and report; durable waits | F9 |
| S15-D23 model/effort within approved routes | F10 |

### 13.2 Acceptance cases

| Case | UI coverage | Not covered by UI (evidence elsewhere) |
| --- | --- | --- |
| S15-AC01 | F2 receipt/intent/progress/result; untrusted pasted content; no Work mode | Actual tool call evidence (CHAT15/EVID15) |
| S15-AC02 | F3 readiness table, prefill chip, duplicate receipt | Readiness checks themselves (GIT15-01) |
| S15-AC03 | F1 enrolment capability rows, F7 boundary refusals, guest-reported labels | Isolation proof (VM15, RF15-G01/G02) |
| S15-AC04 | F12 team rows, restrictions, S14-private labels, input waits | Lease enforcement (TEAM15) |
| S15-AC05 | F6 handoff, takeover, LimitNotice, held website effects | Browser mediation proof (BROW15, RF15-G03) |
| S15-AC06 | F2 ordinary edits without cards; invitations and new terms reach F4 | Broker behaviour (EDIT15/BIZ15) |
| S15-AC07 | F4 exact slips, chat approval, changed/expired/unknown states | Alternate-route bypass proof (SEND15, RF15-G05) |
| S15-AC08 | F1 budget entry, F10 meters and holds, F4 payment and recurring deviation, F13 recurring-rule setup | Reservation enforcement (PAY15/MODEL15) |
| S15-AC09 | F4 DecisionCard with options, evidence, recommendation, retained direction | Impact classification (POLICY15) |
| S15-AC10 | F5 profile badge, ledger, eligibility checklist, production before merge | Merge gate enforcement (GIT15-02/03) |
| S15-AC11 | F4 new-recipient slip | Disclosure enforcement (DATA15) |
| S15-AC12 | F9 responsibility card, proposals, scoped stop | Admission fencing (WORK15) |
| S15-AC13 | F8 notes, filters, correction precedence, forget impact, credential refusal | Lineage propagation (MEM15) |
| S15-AC14 | F10 disclosure, pins, no account switch | Physical dispatch guard (MODEL15) |
| S15-AC15 | F9 durable waits, stall report, restart line; F11 reconnect, unknown | Durable responsibility (WORK15) |
| S15-AC16 | F11 adoption status block | Adoption and rollback (MIG15/CUT15) |

### 13.3 Requirements touched

FR-04/05/06/07/10/11/12/13/14/15/16/17/18/19/23/24/25/26/27/28/29/30/35/36/37/38/40/42 and NFR-05/06/07/11/13 are reflected above; their identifiers are unchanged.

## 14. Implementation split

**Orchestrator decision (2026-11-03):** no new UX issues are created. The scope is consolidated into the two existing issues. The slice letters below are **internal milestones** inside each issue, kept so review stays incremental; each milestone should be a reviewable PR or commit series under its issue. All milestones remain **Frontier** until their contracts freeze. A Standard extraction (dictionary keys, static page markup) becomes possible only after the listed contract is merged with exact signatures.

### #338 — UX15-01: setup, ordinary chat, memory, models and budget

| Milestone | Outcome | Scope from this document | Needs (merged, reviewed) | Acceptance |
| --- | --- | --- | --- | --- |
| UX15-01a | First tool-backed result from ordinary chat | §2 composer change; F2 receipt, intent line, scope line, progress, result; F3 readiness table and prefill chip; Needs-you link | #323, #320 | S15-AC01, AC02 (UI) |
| UX15-01b | One-page setup with working computer, accounts, rules and budget | F1 all sections; F7 capability rows; `/resources/computer` status | #321, #320, #326; after 01a | S15-AC01 setup, AC03 (UI), AC08 budget entry |
| UX15-04 | Memory inspect, correct and forget | F8 | #325; after 01a | S15-AC13 |
| UX15-05 | Model disclosure and budget settings | F10 | #326; after 01b | S15-AC14, AC08 (operating budget) |

### #339 — UX15-02: held actions, GitHub, responsibilities, browser and resources

| Milestone | Outcome | Scope from this document | Needs (merged, reviewed) | Acceptance |
| --- | --- | --- | --- | --- |
| UX15-02a | Review and approve one held action once | F4 slips for email/message, payment and recurring deviation, new recipient; chat approval; all slip states; `/actions/:id`; `/needs` | #320, #332, #333, #335 (new-recipient slip) | S15-AC07, AC08 (transactions), AC11 |
| DecisionCard | Major changes and business commitments | F4 DecisionCard and retained direction | #320 (impact classes), #334; with 02a | S15-AC09 |
| Recurring-rule setup | Create, use and revoke recurring-payment rules | F13 RuleProposal slip, ledger line, `/rules` revoke | #320, #333; after 02a | S15-AC08 (recurring) |
| UX15-02b | GitHub default and personal profiles through merge and production | F5 badge, slips, ledger, checklist, production-before-merge; `/rules` personal profile | #329, #330; after 02a | S15-AC10, AC02 follow-through |
| UX15-02c | Responsibilities, waits, stalls, stop and recovery | F9; F11 evidence tab, reconnect banner, recovery list | #327 | S15-AC12, AC15 |
| UX15-03 | Browser handoff and honest limits | F6 handoff with checking and result states, takeover view, LimitNotice, website slips | #322; after 02a | S15-AC05 |
| UX15-06 | Team resources, VM restore and adoption status | F12; F11 restore slip and adoption status | #324, #321, #336 | S15-AC04, AC16 (status only) |

The issue-level blockers of #338 and #339 should cover the "Needs" column of their milestones; the orchestrator owns any blocker edits. EVID15-01 #340 keeps depending on #338 and #339, which now carry every UX acceptance case above.

Before implementation starts, each milestone must freeze the exact dictionary keys in both `th` and `en`, name the exact routes and render functions, list the deterministic DOM/handler fixtures per state in §6 and F4, and keep real device and assistive-technology evidence separate.

## 15. Open questions

| ID | Question | Default used here |
| --- | --- | --- |
| Q1 | Discover Lima/Proxmox VMs automatically? | No; paste-and-address enrolment |
| Q2 | Required checks for repositories without branch protection | All checks reported on the head commit, owner may untick |
| Q3 | May a standing rule allow Jit to restore its own VM? | No; restore waits for the owner |
| Q4 | Approvals inside companion channels (Telegram) | Out of scope; Telegram was later removed (ADR 0085). Notifications only link to the Web slip |
| Q5 | Should MemoryNote appear on every reply that retained something, or only in a daily digest? | Every reply, collapsed |
| Q6 | Should "Needs you" include proposals from responsibilities? | Yes, as the lowest group |

The orchestrator accepted these defaults on 2026-11-03. None blocks implementation of UX15-01a.

## 16. Prototype guide

[s15-conversational-prototype.html](s15-conversational-prototype.html) is a single static file with inline CSS and script. It uses system fonts, connects to nothing and stores nothing. Its scenes match the flow tags above: `setup`, `chat`, `readiness`, `hold-email`, `github`, `production`, `payment`, `recipient`, `decision`, `browser`, `duty`, `stall`, `memory`, `models`, `restore`, `unknown`. Controls switch scene, language (ไทย/English), theme (dark/light) and width (desktop/mobile). Fixture values are examples: no account, model, provider, budget amount or repository named there is configured, available or approved. Buttons in the prototype change only the prototype's local display and are labelled as fixtures.

## 17. Verification and limits

This handoff was checked against S15-D01–D23 and S15-AC01–AC16 (§13), the S15 contracts named in §12, and the current Web code paths listed there. Links and `git diff --check` were validated for this documentation change. No runtime test, browser rendering, device or assistive-technology evidence is claimed. RT15-01 is resolved by the owner's option B choice only as a product tradeoff; RF15-G01–G08 remain unproven engineering gates, and nothing here certifies VM, browser, effect or model enforcement.
