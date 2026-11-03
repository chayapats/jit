import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dictionaries } from "../src/i18n";
import { s15WebEn } from "../src/i18n/s15-web-en";
import { s15WebTh } from "../src/i18n/s15-web-th";

// UX15-01 dictionary freeze: every key the S15 Web UI can render exists in Thai and English.
const directory = join(import.meta.dir, "../src/s15/web");
const literal = new Set(readdirSync(directory).filter(name => name.endsWith(".ts")).flatMap(name => [...readFileSync(join(directory, name), "utf8").matchAll(/"(s15\.[a-z0-9_.]+[a-z0-9_])"/g)].map(match => match[1]!)).filter(key => !["s15.css", "s15.js"].includes(key)));
const families: Record<string, readonly string[]> = {
  "s15.state": ["received", "understanding", "inspecting", "working", "waiting_ci", "waiting_review", "waiting_schedule", "waiting_login", "needs_you", "question", "stalled", "budget_hold", "partial", "blocked", "unsupported", "unknown", "failed", "stopping", "stopped", "done", "changed", "expired", "denied"],
  "s15.scope.access": ["read", "reversible_write", "effect"],
  "s15.readiness.state": ["ready", "blocked", "owned", "open_pr"], "s15.readiness.fact": ["scope", "acceptance", "blockers", "assignee", "branch_pr"],
  "s15.model.effort": ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"], "s15.model.reason": ["owner_pin", "ordinary", "difficult", "approved_alternative"],
  "s15.memory.source": ["owner_message", "work", "historical"], "s15.memory.filter": ["all", "facts", "inferences", "preferences", "corrected", "forgotten", "s14"],
  "s15.models.charge": ["subscription", "metered"], "s15.models.availability": ["available", "unavailable", "quota"],
  "s15.budget.dimension": ["attempts", "steps", "calls", "reads", "outputBytes", "activeMs", "spendMinor"], "s15.budget.status": ["owner_required", "profile_required"],
  "s15.needs.group": ["action", "question", "reconciliation"],
  "s15.class": ["ordinary_edit", "guest_local_admin", "guest_system_admin", "new_egress", "communication", "financial", "github_publish", "github_merge", "production", "disclosure", "major_change"],
  "s15.accounts.state": ["not_connected", "configured", "checked", "unavailable"], "s15.accounts.use": ["email_read", "email_draft", "calendar", "documents", "github", "websites", "model"],
  "s15.setup.alone": ["research", "computer", "edits", "accounts", "models"], "s15.setup.asks": ["messages", "github", "merge", "production", "payments", "recipients", "major", "new_accounts"],
  "s15.computer.row": ["proven", "reported", "missing", "unproven", "unavailable"], "s15.computer.state": ["ready", "unproven", "uncertain", "stopped"],
  // UX15-02/03/06 computed families.
  "s15.rules.deviation": ["payee", "account", "currency", "amount_ceiling", "frequency", "count", "total", "rule_expired"],
  "s15.github.production": ["none", "protected_gate", "would_deploy", "unknown"], "s15.github.mode": ["personal_github_publish", "personal_github_merge"],
  "s15.decision.option": ["apply_exact", "investigate", "keep"], "s15.decision.evidence": ["fact", "inference", "missing"], "s15.slip.statement": ["occurred", "did_not_occur"],
  "s15.slip.data_class": ["public", "private", "personal", "business"], "s15.duty.trigger": ["ci", "review", "owner", "schedule", "assigned"], "s15.duty.attempt": ["active", "settled", "unknown"],
  "s15.stall.progress": ["unknown", "none", "made"], "s15.resources.kind": ["account", "browser", "workspace", "data"], "s15.resources.op": ["read", "write", "input"], "s15.resources.restriction": ["deny", "purpose", "inactive", "bot_private", "current_standing_policy", "mediated_credentials"],
  "s15.adoption.runtime": ["s14", "legacy", "s15"], "s15.adoption.state": ["preparing", "validated", "activating", "active_fenced", "complete", "rolling_back", "rolled_back", "discarded", "blocked"],
  "s15.rules.saved": ["recurring_installed", "recurring_revoked", "github_installed", "github_revoked", "policy_installed"], "s15.rules.frequency": ["hours", "daily", "weekly", "monthly"], "s15.slip.field": ["recipients", "resources", "classes", "transaction", "github", "upperBound", "fences", "impact", "expiresAt"],
  // SETUP15-01 / POOL15-01 computed families.
  "s15.provision.step": ["host", "download", "checksum", "disk", "boot", "connect", "checks", "enrolled"],
  "s15.provision.next": ["generic", "vm_host_unsupported", "vm_kvm_unavailable", "vm_kvm_denied", "vm_qemu_missing", "vm_host_too_small", "vm_disk_insufficient", "vm_image_unavailable", "vm_image_unverified", "vm_management_unavailable"],
  "s15.code": ["stall_no_progress", "stall_attempt_limit", "stall_budget_headroom", "login_required", "stale_input", "input_busy",
    // BROW15-02 provisioned browser and approved-website refusals.
    "website_not_approved", "website_invalid", "website_https_required", "website_not_public", "website_list_full", "website_history_full", "website_changed", "engine_unavailable", "browser_provisioning",
    "browser_host_unsupported", "browser_directory_unsafe", "browser_disk_insufficient", "browser_download_unavailable", "browser_checksum_mismatch", "browser_extract_failed", "browser_libraries_missing", "browser_engine_unavailable",
    // POLICY15-02 / GIT15-04 refusal codes the review and GitHub pages can show.
    "route_unavailable", "policy_required", "expired", "finite_budget_required", "proposal_incomplete", "vm_not_enrolled", "github_token_required", "github_token_fine_grained_required", "github_token_invalid", "github_token_forbidden", "github_unreachable", "github_verify_failed", "github_not_connected", "github_repository_denied", "github_credential_unavailable", "stale_revision"],
  "s15.websites.step": ["verify", "download", "checksum", "extract", "libraries"], "s15.websites.limit": ["read", "no_forms", "private", "public"],
  "s15.websites.next": ["generic", "browser_host_unsupported", "browser_directory_unsafe", "browser_disk_insufficient", "browser_download_unavailable", "browser_checksum_mismatch", "browser_extract_failed", "browser_libraries_missing", "browser_engine_unavailable"],
  // POLICY15-02 / GIT15-04 computed families.
  "s15.policy.purpose": ["work", "interpretation"], "s15.policy.charge": ["subscription", "metered"], "s15.policy.group": ["bot", "purpose", "resources", "models", "recipients"],
  "s15.policy.title": ["new", "update", "renew", "expired", "current"], "s15.policy.lead": ["new", "update", "renew", "expired"], "s15.policy.install": ["renew", "update"],
  "s15.ghc.perm": ["contents", "issues", "pulls", "checks", "statuses", "administration", "metadata"], "s15.ghc.saved": ["connected", "selected", "removed"],
};

test("every S15 Web key, literal or computed, exists in both Thai and English with plain text", () => {
  const keys = [...literal, ...Object.entries(families).flatMap(([prefix, names]) => names.map(name => `${prefix}.${name}`))];
  expect(keys.length).toBeGreaterThan(250);
  for (const locale of ["th", "en"] as const) for (const key of keys) {
    const value = (dictionaries[locale] as Record<string, string>)[key];
    expect({ locale, key, present: typeof value === "string" && value.trim().length > 0 }).toEqual({ locale, key, present: true });
  }
  expect(Object.keys(s15WebEn).sort()).toEqual(Object.keys(s15WebTh).sort());
});

test("the handoff §10.2 core keys used by UX15-01 keep their authored Thai and English copy", () => {
  const authored: [string, string, string][] = [
    ["s15.composer.placeholder", "พิมพ์ถึงจิตได้เลย…", "Message Jit…"], ["s15.composer.refused_kept", "ยังส่งไม่ได้ ข้อความยังอยู่ในช่องพิมพ์", "Not sent. Your text is still in the box."],
    ["s15.intent.inspect", "ตรวจดูอย่างเดียว ไม่แก้ไขอะไร", "Looking only. Nothing will be changed."], ["s15.intent.execute", "เริ่มทำแล้ว", "Started"],
    ["s15.progress.title", "ความคืบหน้า (ยังไม่ใช่หลักฐาน)", "Progress (not evidence yet)"], ["s15.readiness.no_pick", "จิตจะไม่เลือกเองว่าจะทำข้อไหน", "Jit won’t choose which one to do"],
    ["s15.vm.option_b", "จิตมีสิทธิ์เต็มในเครื่องนี้ ข้อมูลสำคัญ รหัสผ่าน และการส่งออกไปข้างนอกอยู่นอกเครื่องนี้เสมอ ถ้าเครื่องพัง ย้อนกลับจาก snapshot ได้", "Jit has full control of this machine. Your important data, passwords and anything that leaves for the outside world stay outside it. If it breaks, it can be restored from a snapshot."],
    ["s15.setup.budget_required", "ใส่งบใช้งานก่อน จิตจะไม่เดาตัวเลขให้", "Enter a usage budget first. Jit won’t guess a number for you."], ["s15.setup.personal_off", "โปรไฟล์ GitHub ส่วนตัว: ปิดอยู่ ตั้งได้ที่ กฎประจำ", "Personal GitHub profile: off. Set it up under Standing rules."],
    ["s15.budget.unknown", "ไม่ทราบ", "Unknown"], ["s15.model.no_switch", "จิตไม่เปลี่ยนไปใช้บัญชีอื่นเอง", "Jit won’t switch to another account on its own"],
  ];
  for (const [key, thai, english] of authored) { expect((dictionaries.th as Record<string, string>)[key]).toBe(thai); expect((dictionaries.en as Record<string, string>)[key]).toBe(english); }
});

test("UX15-02/03/06 Thai product copy lives only in th.ts, with no extra Thai dictionary module", () => {
  const i18n = join(import.meta.dir, "../src/i18n"), th = readFileSync(join(i18n, "th.ts"), "utf8");
  expect(readdirSync(i18n).filter(name => name.startsWith("s15-actions"))).toEqual([]);
  for (const key of ["s15.hold.send_once", "s15.slip.page_title", "s15.duty.title", "s15.browser.hand_back", "s15.rules.recurring_set"]) expect(th).toContain(`"${key}":`);
});

test("the handoff §10.2 keys used by UX15-02/03/06 keep their authored Thai and English copy", () => {
  const authored: [string, string, string][] = [
    ["s15.hold.asks.email", "จิตขอส่งอีเมล", "Jit asks to send an email"], ["s15.hold.send_once", "ส่ง 1 ครั้ง", "Send once"], ["s15.hold.pay_once", "จ่าย 1 ครั้ง", "Pay once"],
    ["s15.hold.merge_deploy_once", "Merge และปล่อย deploy 1 ครั้ง", "Merge and let it deploy once"], ["s15.hold.allow_once", "อนุญาตเฉพาะครั้งนี้", "Allow this time only"],
    ["s15.hold.single_use", "การอนุมัติใช้ได้ครั้งเดียว กับเนื้อหานี้เท่านั้น", "One approval, for this exact content only"], ["s15.hold.which", "หมายถึงอันไหน", "Which one do you mean?"],
    ["s15.hold.changed", "ถูกแทนด้วย r{n} การอนุมัติเดิมใช้ไม่ได้", "Replaced by r{n}. The earlier approval no longer applies."], ["s15.hold.unknown", "ไม่ทราบผล จิตจะไม่ส่งซ้ำเอง", "Outcome unknown. Jit won’t resend on its own."],
    ["s15.github.prod_before_merge", "Merge นี้จะ deploy production ต้องให้คุณอนุมัติก่อน merge", "This merge would deploy to production. It needs your approval before merging."],
    ["s15.browser.driving", "คุณคุมอยู่ · จิตส่งคำสั่งไม่ได้จนกว่าคุณจะคืน", "You’re driving · Jit can’t send input until you hand back"], ["s15.browser.hand_back", "เสร็จแล้ว คืนให้จิต", "Done, hand back to Jit"],
    ["s15.rules.recurring_set", "ตั้งกฎนี้", "Set up this rule"], ["s15.rules.revoke", "หยุดใช้กฎนี้", "Stop using this rule"], ["s15.duty.waiting_ci", "รอ CI อยู่ จิตจะกลับมาดูเองเมื่อเสร็จ ไม่ต้องทำอะไร", "Waiting for CI. Jit will check back when it finishes. Nothing to do."],
    ["s15.stall.title", "หยุดพักไว้: ลอง {n} วิธีแล้วยังไม่คืบ", "Paused: tried {n} approaches with no progress"], ["s15.recovery.check_again", "ตรวจอีกครั้ง (อ่านอย่างเดียว)", "Check again (read only)"],
    ["s15.vm.restore_keeps", "ข้อมูลของคุณนอกเครื่อง อีเมลที่ส่งแล้ว PR และการจ่ายเงิน ไม่ถูกย้อน", "Your data outside the machine, sent emails, PRs and payments are not rolled back"],
  ];
  for (const [key, thai, english] of authored) { expect((dictionaries.th as Record<string, string>)[key]).toBe(thai); expect((dictionaries.en as Record<string, string>)[key]).toBe(english); }
});
