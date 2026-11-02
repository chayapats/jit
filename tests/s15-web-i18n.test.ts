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
  "s15.state": ["received", "understanding", "inspecting", "working", "waiting_ci", "waiting_review", "waiting_login", "needs_you", "question", "stalled", "budget_hold", "partial", "blocked", "unsupported", "unknown", "failed", "stopping", "stopped", "done", "changed", "expired", "denied"],
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
