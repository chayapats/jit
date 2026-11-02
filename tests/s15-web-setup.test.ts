import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VmEnrollment } from "../src/s15/vm/enrollment";
import { VmStore } from "../src/s15/vm/store";
import { vmHostCommand } from "../src/s15/vm/host";
import type { VmHostCommand, VmManagement } from "../src/s15/vm/types";
import type { S15AccountRow, S15WebComputer, S15WebRules } from "../src/s15/web";
import { toMinor } from "../src/s15/web/setup";
import { fixture as policyFixture } from "./fixtures/s15-policy";
import { webFixture, type WebActor, type WebFixture } from "./fixtures/s15-web";

// UX15-01b: one-page setup (handoff F1, F7 capability rows, /resources/computer).
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });

/** Real VM15 enrollment with a scripted host command: no SSH, no network, deterministic guest facts. */
function computer(options: { manager?: boolean; docker?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "jit-s15-web-vm-")), store = new VmStore(":memory:");
  cleanups.push(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  let publicKey = "";
  const run: VmHostCommand = async (argv, opts) => {
    if (argv[0] === "ssh-keygen") { const result = await vmHostCommand(argv, opts); publicKey = (await Bun.file(`${argv.at(-1)}.pub`).text()).trim().split(" ").slice(0, 2).join(" "); return result; }
    if (argv[0] === "ssh-keyscan") return { exitCode: 0, stdout: Buffer.from(`vm.test ${publicKey}\n`) };
    opts.beforeStart?.();
    const script = argv.at(-1) ?? "";
    return { exitCode: 0, stdout: Buffer.from(script.includes("platform.machine") ? JSON.stringify({ architecture: "x86_64", os: "ubuntu:24.04", cpuCount: 4, memoryBytes: 8589934592, diskBytes: 68719476736, sudo: true, docker: options.docker ?? true, basis: "guest_reported" })
      : script.includes("nicMacs") ? JSON.stringify({ nicMacs: ["52:54:00:12:34:56"] }) : script.includes("reachable") ? JSON.stringify({ reachable: [false, false, false, false, false, false] }) : "jit-vm-ready-v1\n") };
  };
  const manager: VmManagement = { async inspect() { return { state: "running", identity: "vm", boot: "boot", cpuCount: 4, memoryBytes: 100, diskBytes: 100, network: "isolated", nicMac: "52:54:00:12:34:56" }; }, async stop() {}, async snapshot() {}, async restore() {}, async retireSnapshot() {} };
  let owner: object | null = null;
  const enrollment = new VmEnrollment({ store, keyDirectory: join(directory, "keys"), requireOwner: actor => { if (actor !== owner) throw new Error("not owner"); }, managers: new Map(options.manager ? [["proxmox", manager]] : []), run });
  const port = (actor: WebActor): S15WebComputer<WebActor> => { owner = actor; return {
    vmId: "team-computer", managerId: options.manager ? "proxmox" : null, hypervisor: options.manager ? "Proxmox" : null,
    begin: a => enrollment.begin(a), checkMachine: (a, input) => enrollment.checkMachine(a, input), useMachine: (a, input) => enrollment.useMachine(a, input), status: (a, id) => enrollment.status(a, id),
  }; };
  return { enrollment, store, port };
}

/** Real POLICY15 service: the composition maps the typed amount onto its protected base policy. */
function rules(options: { currencies?: string[]; profile?: boolean } = {}) {
  const policy = policyFixture({}); cleanups.push(() => policy.cleanup());
  const port: S15WebRules<WebActor> = {
    current: () => policy.service.owner.current(policy.owner),
    propose: (_actor, budget) => policy.service.owner.proposePolicy(policy.owner, budget && options.profile !== false ? { ...structuredClone(policy.input), budget: { ...policy.input.budget!, currency: budget.currency, ceiling: { ...policy.input.budget!.ceiling, spendMinor: budget.spendMinor } } } : null),
    install: (_actor, requestId, hash) => policy.service.owner.installProposal(policy.owner, requestId, hash),
    budgetOptions: () => ({ currencies: options.currencies ?? ["USD"], periods: [{ id: "month", days: 30 }] }),
  };
  return { policy, port };
}
const accountsList: S15AccountRow[] = [
  { id: "codex", kind: "model", label: "ChatGPT", state: "configured", uses: ["model"], signInHref: "/settings/provider" },
  { id: "google", kind: "service", label: "Google", state: "not_connected", uses: ["email_read", "calendar"], signInHref: "//evil.test/steal" },
];
function setup(extra: Parameters<typeof webFixture>[0] = () => ({})) { const f = webFixture(extra); cleanups.push(() => f.cleanup()); return f; }
const html = async (f: WebFixture, path: string) => (await f.get(path)).text();
const section = (page: string, id: string) => {
  const start = page.indexOf(`id="s15-setup-${id}"`), next = page.indexOf('class="s-card s15-setup-section"', start);
  return page.slice(start, next < 0 ? page.indexOf("</main>", start) : next);
};

test("without composed slices the setup page states honest unavailable sections and invents nothing", async () => {
  const f = setup(), page = await html(f, "/setup");
  expect(page).toContain("ตั้งรหัสผ่านแล้ว");
  expect(section(page, "computer")).toContain("การตั้งเครื่องทำงานยังไม่เปิดในเครื่องนี้");
  expect(section(page, "rules")).toContain("การตั้งกฎประจำยังไม่เปิดในเครื่องนี้");
  expect(section(page, "models")).toContain("การเข้าสู่ระบบบัญชีโมเดลจากหน้านี้ยังไม่เปิดในเครื่องนี้");
  expect(page).not.toContain('action="/s15/forms/rules/install"');
  // "/" sends the owner to setup until standing rules exist.
  const home = await f.get("/"); expect(home.headers.get("location")).toBe("/setup");
});

test("working computer: paste one public-key line, type the address once, check, then use it", async () => {
  const vm = computer({ manager: true }), f = setup(base => ({ computer: vm.port(webActor(base)) }));
  let page = await html(f, "/setup");
  expect(section(page, "computer")).toContain(">สร้างบรรทัดสำหรับวาง<");
  expect(section(page, "computer")).toContain("จิตมีสิทธิ์เต็มในเครื่องนี้");
  expect((await f.post("/s15/forms/computer/begin", { return: "setup" })).status).toBe(303);
  page = await html(f, "/setup");
  const card = section(page, "computer");
  expect(card).toContain("วางบรรทัดนี้ในเครื่องใหม่ครั้งเดียว"); expect(card).toContain("restrict ssh-ed25519"); expect(card).not.toContain("PRIVATE KEY");
  // The address is the only typed value; port and user sit under Details with defaults.
  expect(card.match(/<input name="[a-z]+"/g)).toEqual(['<input name="host"', '<input name="port"', '<input name="user"']);
  expect(card.indexOf("รายละเอียด")).toBeLessThan(card.indexOf('name="port"'));
  const setupId = /name="setupId" value="([a-f0-9]+)"/.exec(card)![1]!;
  expect((await f.post("/s15/forms/computer/check", { return: "setup", setupId, host: "vm.test", port: "22", user: "jit" })).status).toBe(303);
  page = await html(f, "/setup");
  const checked = section(page, "computer");
  expect(checked).toContain("jit@vm.test:22"); expect(checked).toMatch(/SHA256:[A-Za-z0-9+/]+/); expect(checked).toContain("x86_64"); expect(checked).toContain("รายงานโดยเครื่องทำงาน");
  expect(vm.store.db.query("SELECT count(*) n FROM vm_registry").get()).toEqual({ n: 0 });
  const checkId = /name="checkId" value="([a-f0-9]+)"/.exec(checked)![1]!, fingerprint = /name="fingerprint" value="([^"]+)"/.exec(checked)![1]!;
  // A tampered fingerprint is refused; the owner's press binds the observed one.
  expect((await f.post("/s15/forms/computer/use", { return: "setup", checkId, fingerprint: "SHA256:forged" })).status).toBe(409);
  expect(vm.store.db.query("SELECT count(*) n FROM vm_registry").get()).toEqual({ n: 0 });
});

const webActor = (base: { authentication: { authenticate(token: string): { actor: WebActor } } }) => base.authentication.authenticate("owner-token").actor;

test("capability rows show only what was observed; snapshots stay unproven or unavailable with the owner's way forward", async () => {
  for (const manager of [true, false]) {
    const vm = computer({ manager, docker: false }), f = setup(base => ({ computer: vm.port(webActor(base)) }));
    await f.post("/s15/forms/computer/begin", { return: "computer" });
    let page = await html(f, "/resources/computer");
    const setupId = /name="setupId" value="([a-f0-9]+)"/.exec(page)![1]!;
    await f.post("/s15/forms/computer/check", { return: "computer", setupId, host: "vm.test" });
    page = await html(f, "/resources/computer");
    const checkId = /name="checkId" value="([a-f0-9]+)"/.exec(page)![1]!, fingerprint = /name="fingerprint" value="([^"]+)"/.exec(page)![1]!;
    const used = await f.post("/s15/forms/computer/use", { return: "computer", checkId, fingerprint });
    expect(used.status).toBe(303);
    page = await html(f, "/resources/computer");
    const rows = page.slice(page.indexOf('class="s15-caps"'), page.indexOf("</ul>", page.indexOf('class="s15-caps"')));
    const row = (label: string) => rows.slice(rows.indexOf(label), rows.indexOf("</li>", rows.indexOf(label)));
    expect(row("รันคำสั่ง")).toContain("ตรวจแล้ว");
    expect(row("สิทธิ์ผู้ดูแล (sudo)")).toContain("เครื่องรายงานว่ามี");
    expect(row("Docker")).toContain("เครื่องรายงานว่าไม่มี");
    if (manager) {
      expect(row("Snapshot และการย้อนเครื่อง")).toContain("ยังไม่ได้ตรวจ");
      expect(row("เครือข่ายแยกจากภายนอก")).toContain("ตรวจแล้ว");
      expect(page).toContain("พร้อมใช้");
    } else {
      expect(row("Snapshot และการย้อนเครื่อง")).toContain("ทำไม่ได้");
      expect(row("Snapshot และการย้อนเครื่อง")).toContain("จิตย้อนเครื่องเองไม่ได้ ใช้ snapshot ในโปรแกรม VM ของคุณ");
      expect(row("เครือข่ายแยกจากภายนอก")).toContain("ยังไม่ได้ตรวจ");
      expect(page).toContain("ใช้ได้ แต่บางอย่างยังไม่ได้ตรวจ");
    }
    expect(rows.match(/✓/g)?.length ?? 0).toBe(manager ? 3 : 2);
    expect(page).not.toContain("vm.test"); expect(page).not.toContain("identityFile");
  }
});

test("an expired check is refused with its reason and the line must be made again", async () => {
  const vm = computer(), f = setup(base => ({ computer: vm.port(webActor(base)) }));
  const refused = await f.post("/s15/forms/computer/check", { return: "setup", setupId: "0".repeat(32), host: "vm.test" });
  expect(refused.status).toBe(409);
  const body = await refused.text();
  expect(body).toContain("การตั้งเครื่องหมดเวลาแล้ว"); expect(body).toContain("vm_setup_expired"); expect(body).toContain(">สร้างบรรทัดสำหรับวาง<");
});

test("rules: plain lists from the protected proposal, empty budget, disabled apply with its reason, then exact install", async () => {
  const r = rules(), f = setup(() => ({ rules: r.port }));
  let page = await html(f, "/setup");
  let card = section(page, "rules");
  for (const text of ["จิตทำเองได้", "ถามคุณก่อนเสมอ", "ส่งอีเมลหรือข้อความถึงคนอื่น", "Deploy production", "โปรไฟล์ GitHub ส่วนตัว: ปิดอยู่ ตั้งได้ที่ กฎประจำ"]) expect(card).toContain(text);
  expect(card).toContain('name="amount" inputmode="decimal" autocomplete="off" value=""');
  expect(card).toContain('<option value="USD" selected>USD</option>');
  expect(card).toContain('disabled aria-describedby="s15-rules-reason"'); expect(card).toContain("ใส่งบใช้งานก่อน จิตจะไม่เดาตัวเลขให้");
  expect(card).not.toContain('action="/s15/forms/rules/install"');
  // An invalid amount is refused and nothing is proposed or installed.
  expect((await f.post("/s15/forms/rules/review", { amount: "1.234", currency: "USD", periodId: "month" })).status).toBe(409);
  expect(r.policy.service.owner.current(r.policy.owner)).toBeNull();
  expect((await f.post("/s15/forms/rules/review", { amount: "25.50", currency: "USD", periodId: "month" })).status).toBe(303);
  page = await html(f, "/setup"); card = section(page, "rules");
  expect(card).toContain('value="25.50"'); expect(card).toContain("25.50 USD");
  const hash = /name="proposalHash" value="([a-f0-9]{64})"/.exec(card)![1]!;
  expect(r.policy.service.owner.current(r.policy.owner)).toBeNull();
  const installed = await f.post("/s15/forms/rules/install", { proposalHash: hash });
  expect(installed.status).toBe(200);
  const done = await installed.text();
  expect(done).toContain("ใช้กฎประจำ r1 แล้ว");
  const current = r.policy.service.owner.current(r.policy.owner)!;
  expect(current.revision).toBe(1); expect(current.budget!.ceiling.spendMinor).toBe("2550"); expect(current.rules.some(rule => rule.mode.startsWith("personal_github"))).toBe(false);
  expect((await f.get("/")).headers.get("location")).toBe("/chats/new");
  // A forged hash cannot install anything.
  const r2 = rules(), g = setup(() => ({ rules: r2.port }));
  expect((await g.post("/s15/forms/rules/install", { proposalHash: "a".repeat(64) })).status).toBe(409);
  expect(r2.policy.service.owner.current(r2.policy.owner)).toBeNull();
});

test("missing reviewed profile values keep the apply button disabled with that reason", async () => {
  const r = rules({ profile: false }), f = setup(() => ({ rules: r.port }));
  await f.post("/s15/forms/rules/review", { amount: "10", currency: "USD", periodId: "month" });
  const card = section(await html(f, "/setup"), "rules");
  expect(card).toContain("ยังไม่มีค่าที่ตรวจแล้ว"); expect(card).toContain("disabled"); expect(card).not.toContain('name="proposalHash"');
});

test("currency and period offer no preselection when the billing route catalog has several choices", async () => {
  const r = rules({ currencies: ["USD", "THB"] }), f = setup(() => ({ rules: r.port }));
  const card = section(await html(f, "/setup"), "rules");
  expect(card).toContain('<option value="" selected>เลือก</option><option value="USD">USD</option><option value="THB">THB</option>');
  expect(toMinor("12.5", "THB")).toBe("1250"); expect(toMinor("0", "USD")).toBeNull(); expect(toMinor("1e3", "USD")).toBeNull(); expect(toMinor("100", "JPY")).toBe("100"); expect(toMinor("1.5", "JPY")).toBeNull();
});

test("accounts: one-click sign-in rows, configured is not shown as checked, unsafe links are dropped", async () => {
  const f = setup(() => ({ accounts: { list: () => accountsList } })), page = await html(f, "/setup");
  const models = section(page, "models"), accounts = section(page, "accounts");
  expect(models).toContain("ChatGPT"); expect(models).toContain("ตั้งค่าแล้ว ยังไม่ได้ตรวจ"); expect(models).toContain('href="/settings/provider">เข้าสู่ระบบกับ ChatGPT');
  expect(accounts).toContain("อ่านอีเมล · ปฏิทิน · ใช้ได้ทั้งทีม"); expect(accounts).toContain("ข้ามไปก่อน"); expect(accounts).not.toContain("evil.test");
});

test("reload resumes at the first unfinished section", async () => {
  const r = rules(), vm = computer(), f = setup(base => ({ rules: r.port, computer: vm.port(webActor(base)), accounts: { list: () => accountsList } }));
  const page = await html(f, "/setup");
  expect(page).toContain('href="#s15-setup-computer">ทำต่อที่: เครื่องทำงาน');
  expect(page).toContain('<li aria-current="step"><a href="#s15-setup-computer">');
  const english = await (await f.get("/setup", { "accept-language": "en" })).text();
  expect(english).toContain("Continue with: Working computer"); expect(english).toContain("Jit has full control of this machine.");
});
