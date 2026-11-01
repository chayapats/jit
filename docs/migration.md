# Migration from Schway discovery workspace

Jit ถูกสร้างเป็น repository แยกตาม C20 เอกสาร discovery เดิมอยู่ใน Schway worktree และยังไม่ถูก commit ก่อน migration Initial history ของ Jit จะเก็บชุดเอกสารนี้เป็นต้นฉบับ tracked version

Product documents ย้ายจาก docs/jit ของ Schway มา docs/product ของ Jit และแก้ relative links ให้ใช้ local Jit documents หรือ commit-pinned Schway evidence ตามเจ้าของจริง มีสำเนา local ของต้นฉบับก่อนย้ายสำหรับ recovery

## ADR ownership mapping

| ต้นฉบับใน Schway worktree | ปลายทาง/เจ้าของ |
| --- | --- |
| 0008-jit-application-boundary | [Jit 0001](adr/0001-application-boundary.md) |
| 0009-jit-local-runtime-and-external-inference | [Jit 0002](adr/0002-local-runtime-and-external-inference.md) |
| 0010-jit-cross-project-memory-with-provenance | [Jit 0003](adr/0003-cross-project-memory-with-provenance.md) |
| 0011-jit-task-authority-and-staged-execution | [Jit 0004](adr/0004-task-authority-and-staged-execution.md) |
| 0012-jit-static-private-pr-review | [Jit 0005](adr/0005-static-private-pr-review.md) |
| 0013-jit-schway-host-contract | [Schway S02](https://github.com/chayapats/schway/issues/393), ADR 0008 ฝั่ง Schway |
| 0014-jit-local-transactional-state | [Jit 0006](adr/0006-local-transactional-state.md) |

Jit-specific terms อยู่ที่ root CONTEXT.md ของ Jit ส่วน Schway เก็บนิยาม consumer application สั้น ๆ กับ core terms เดิม ไม่มีการสร้าง canonical conversation format ซ้ำ

## Provenance and scope

Source inspection อ้าง Schway commit eb41354cc35a6e191c0e89747e150c2aff2a896f ซึ่งเป็น baseline ก่อน host API ใหม่ เอกสาร product/ADR ที่ย้ายยังไม่ใช่ implementation ของ API นี้

SSH target ของ Pi อยู่เฉพาะ ignored installation-local notes ไม่มี credentials ถูกย้ายในงานนี้ และไม่มี runtime installation, live inference หรือ reboot จากการสร้าง repository/specs

Repository Jit เริ่มเป็น private พร้อม MIT LICENSE ระหว่างเตรียม specs การเปิด public และ support policy ยังเป็น release decision ภายหลัง


## 2026-11-01 — S14 fresh-state default (CUT14-01)

This is an installation cutover, separate from the historical repository-discovery migration above. New bare source serve/setup/ops and bare installer runs select S14 with independent state, identity and credentials. `--s14` remains supported; `--legacy` explicitly retains the old source/installer path. Existing service config omission continues to mean legacy, and old immutable builds keep their original argv. No data conversion, credential transfer, schema downgrade or legacy deletion is provided.

The release-evidence prerequisite #256 closed after reviewed PR #304 merged at `143ca067e3728af94badfc2eb677b4f04a5cdb59`; #265 is closed. The [default-selection ADR](adr/0061-s14-default-selection-and-legacy-compatibility.md) documents compatibility. The [owner-host cutover runbook](runbooks/s14-default-cutover.md) requires a separate fresh S14 installation on the owner-selected Pi, complete consistent legacy-byte comparisons, an actual first reply and rehearsed rollback to the retained prior legacy release. The [actual owner-Pi record](evidence/s14-owner-pi-cutover.md) supplies those three host criteria at `5eec7aa`; post-reply R4 equality also passed. Reviewed #267/#244 closeout remains pending. Deterministic tests are not their evidence. Installation-specific identity/addresses/recovery commands stay ignored and private.
