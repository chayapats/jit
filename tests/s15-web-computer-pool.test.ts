import { afterEach, expect, test } from "bun:test";
import { AppError } from "../src/errors";
import { dictionaries } from "../src/i18n";
import type { VmStatus } from "../src/s15/vm";
import type { S15LocalHost, S15PoolMember, S15ProvisioningJob, S15WebComputer } from "../src/s15/web";
import { elapsed } from "../src/s15/web/setup";
import { webFixture, type WebActor, type WebFixture } from "./fixtures/s15-web";

// SETUP15-01 / POOL15-01: automatic working computer states and the multi-computer Resources page.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0)) fn(); });
const en = { "accept-language": "en" };
const T = (key: string, locale: "th" | "en" = "th") => (dictionaries[locale] as Record<string, string>)[key]!;
const html = async (f: WebFixture, path: string, headers: Record<string, string> = {}) => (await f.get(path, headers)).text();
const section = (page: string, id: string) => { const start = page.indexOf(`id="s15-setup-${id}"`), next = page.indexOf('class="s-card s15-setup-section"', start); return page.slice(start, next < 0 ? page.indexOf("</main>", start) : next); };
const escaped = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

const status = (id: string, extra: Partial<VmStatus> = {}): VmStatus => ({ id, generation: 1, state: "ready", networkIsolated: true, recoveryAvailable: true, activeSessions: 0, maxSessions: 2, reason: null,
  capabilities: [{ id: "network-isolated", state: "proven", reason: null }, { id: "snapshot-recovery", state: "unproven", reason: null }, { id: "hypervisor-stop", state: "unproven", reason: null }],
  facts: { architecture: "x86_64", os: "ubuntu:26.04", cpuCount: 5, memoryBytes: 9 * 1073741824, diskBytes: 60 * 1073741824, sudo: true, docker: false, basis: "guest_reported" }, ...extra });
// The Web handler renders elapsed time from its own clock; the margins keep the floored seconds stable.
const job = (extra: Partial<S15ProvisioningJob> = {}): S15ProvisioningJob => ({ state: "running", step: "download", failedStep: null, error: null, attempts: 1, startedAt: Date.now() - 125_300, stepStartedAt: Date.now() - 5_300, updatedAt: Date.now(), finishedAt: null, active: true, ...extra });
const readyHost: S15LocalHost = { state: "ready", code: null, facts: { cpus: 10, memoryGiB: 20, diskFreeGiB: 150 }, resources: { cpus: 5, memoryMiB: 9216, diskGiB: 60 } };

/** Scripted computer port: fake host probe and job, fake pool; every command is recorded. */
function computer(input: { host?: S15LocalHost | null; job?: S15ProvisioningJob | null; members?: S15PoolMember[]; defaultStatus?: VmStatus | null } = {}) {
  const calls: string[] = [];
  const state = { host: input.host ?? null, job: input.job ?? null, members: input.members ?? [], defaultStatus: input.defaultStatus ?? null };
  const port: S15WebComputer<WebActor> = {
    vmId: "working", managerId: null, hypervisor: null,
    begin: async () => { calls.push("begin"); return { setupId: "a".repeat(32), publicKey: "ssh-ed25519 AAAA jit-working-vm", command: "install -d -m 700 ~/.ssh" }; },
    checkMachine: async () => { throw new Error("unused"); }, useMachine: async () => { throw new Error("unused"); },
    status: (_actor, id) => { const found = id === "working" ? state.defaultStatus : state.members.find(m => m.id === id)?.status ?? null; if (!found) throw new AppError("vm_not_enrolled", 404); return found; },
    snapshots: () => [], restore: async (_actor, value) => { calls.push(`restore:${value.vmId}:${value.snapshotId}`); },
    local: { host: () => state.host, job: () => state.job, start: () => { calls.push("start"); } },
    pool: { members: () => state.members, drain: (_actor, id, drained) => { calls.push(`drain:${id}:${drained}`); }, nextId: () => "computer_0011aabb" },
  };
  return { port, calls, state };
}
function setup(c: ReturnType<typeof computer>) { const f = webFixture(() => ({ computer: c.port })); cleanups.push(() => f.cleanup()); return f; }

test("elapsed time renders m:ss and h:mm:ss and never goes negative", () => {
  expect(elapsed(125000)).toBe("2:05"); expect(elapsed(3723000)).toBe("1:02:03"); expect(elapsed(-5)).toBe("0:00");
});

for (const locale of ["th", "en"] as const) test(`F1 step 3 progress (${locale}): current step, elapsed time and no paste line, never done`, async () => {
  const c = computer({ host: readyHost, job: job() }), f = setup(c), full = await html(f, "/setup", locale === "en" ? en : {}), page = section(full, "computer");
  expect(page).toContain(escaped(T("s15.provision.title_running", locale)));
  expect(page).toContain(escaped(T("s15.provision.lead_running", locale)));
  // Earlier steps done, the current one marked for assistive technology, later ones still to do.
  expect(page).toMatch(/<li data-state="done"><span class="s-grow">[^<]+<\/span>/);
  expect(page).toContain(`<li aria-current="step" data-state="now"><span class="s-grow">${escaped(T("s15.provision.step.download", locale))}</span>`);
  expect(page).toContain(`data-state="todo"><span class="s-grow">${escaped(T("s15.provision.step.checks", locale))}`);
  expect(page).toContain(escaped(T("s15.provision.elapsed", locale).replace("{time}", "2:05")));
  expect(page).toContain(escaped(T("s15.provision.step_elapsed", locale).replace("{time}", "0:05")));
  expect(page).toContain('data-s15-refresh="5"'); expect(page).toContain('href="/setup#s15-setup-computer"');
  expect(page).not.toContain("/s15/forms/computer/begin"); expect(page).not.toContain("s15-paste-line");
  // Nothing claims readiness while provisioning: the section is still unfinished and no capability row shows.
  expect(full).toMatch(new RegExp(`href="#s15-setup-computer">[^<]*</a> <span class="s-pill[^"]*">${escaped(T("s15.setup.todo", locale))}<`)); expect(page).not.toContain("s15-caps");
});

for (const locale of ["th", "en"] as const) test(`failed job (${locale}): failed step, plain reason, next step, code and one Try again form`, async () => {
  const c = computer({ host: readyHost, job: job({ state: "failed", step: "checksum", failedStep: "checksum", error: "vm_image_unverified", finishedAt: 1800000000000 }) }), f = setup(c);
  const page = section(await html(f, "/setup", locale === "en" ? en : {}), "computer");
  expect(page).toContain('role="alert"');
  expect(page).toContain(escaped(T("s15.provision.failed_title", locale).replace("{step}", T("s15.provision.step.checksum", locale))));
  expect(page).toContain(escaped(T("s15.code.vm_image_unverified", locale))); expect(page).toContain(escaped(T("s15.provision.next.vm_image_unverified", locale)));
  expect(page).toContain(">vm_image_unverified<");
  expect(page).toContain(`<li aria-current="step" data-state="failed">`);
  expect(page).toContain('action="/s15/forms/computer/provision"'); expect(page).toContain(escaped(T("s15.provision.retry", locale)));
  expect(page).not.toContain("/s15/forms/computer/begin");
  // The no-script "Try again" form posts with CSRF and returns to the same section.
  const retried = await f.post("/s15/forms/computer/provision", { return: "setup" });
  expect(retried.status).toBe(303); expect(retried.headers.get("location")).toBe("/setup#s15-setup-computer"); expect(c.calls).toEqual(["start"]);
  expect((await f.post("/s15/forms/computer/provision", { return: "setup" }, { origin: "http://evil.test" })).status).toBe(403); expect(c.calls).toEqual(["start"]);
});

for (const [code, locale] of [["vm_kvm_unavailable", "th"], ["vm_kvm_denied", "en"], ["vm_qemu_missing", "th"], ["vm_disk_insufficient", "en"], ["vm_host_too_small", "th"], ["vm_host_unsupported", "en"]] as const) test(`no-KVM fallback ${code} (${locale}): why, what to do, then the existing enrollment form`, async () => {
  const c = computer({ host: { state: "missing", code, facts: { cpus: 4, memoryGiB: 8, diskFreeGiB: 20 }, resources: null } }), f = setup(c);
  const page = section(await html(f, "/setup", locale === "en" ? en : {}), "computer");
  expect(page).toContain(escaped(T("s15.provision.unavailable_title", locale))); expect(page).toContain(escaped(T(`s15.code.${code}`, locale)));
  expect(page).toContain(escaped(T(`s15.provision.next.${code}`, locale))); expect(page).toContain(`>${code}<`);
  expect(page).toContain(escaped(T("s15.provision.host_facts", locale).replace("{cpus}", "4").replace("{memory}", "8").replace("{disk}", "20")));
  expect(page).toContain(escaped(T("s15.provision.own_vm_title", locale))); expect(page).toContain('action="/s15/forms/computer/begin"');
  expect(page).not.toContain("/s15/forms/computer/provision"); expect(page).not.toContain("s15-caps");
  // The fallback is the unchanged no-script enrollment flow.
  expect((await f.post("/s15/forms/computer/begin", { return: "setup" })).status).toBe(303); expect(c.calls).toEqual(["begin"]);
  expect(section(await html(f, "/setup"), "computer")).toContain("s15-paste-line");
});

test("ready KVM host with no job offers one Create now button with the default sizing and asks for no value", async () => {
  const c = computer({ host: readyHost }), f = setup(c), page = section(await html(f, "/setup"), "computer");
  expect(page).toContain(escaped(T("s15.provision.ready_lead").replace("{cpus}", "5").replace("{memory}", "9").replace("{disk}", "60")));
  expect(page).toContain('action="/s15/forms/computer/provision"'); expect(page).not.toMatch(/<input (?!type="hidden")/);
});

test("a job interrupted by a restart shows the paused step and a Continue now command", async () => {
  const c = computer({ host: readyHost, job: job({ step: "boot", active: false }) }), f = setup(c), page = section(await html(f, "/setup", en), "computer");
  expect(page).toContain(escaped(T("s15.provision.paused_title", "en").replace("{step}", T("s15.provision.step.boot", "en"))));
  expect(page).toContain(`<li aria-current="step" data-state="paused">`); expect(page).toContain(escaped(T("s15.provision.continue", "en"))); expect(page).not.toContain("data-s15-refresh");
});

test("an enrolled default computer shows only observed rows; Docker is reported only from guest inventory", async () => {
  const c = computer({ host: readyHost, job: job({ state: "enrolled", step: "enrolled" }), defaultStatus: status("working") }), f = setup(c);
  const page = section(await html(f, "/setup"), "computer");
  expect(page).not.toContain(T("s15.provision.title_running")); expect(page).toContain("s15-caps");
  // Docker missing in the guest inventory renders as missing, never as reported from configuration.
  expect(page).toMatch(new RegExp(`Docker</span>[^]*?${escaped(T("s15.computer.row.missing"))}`));
});

const members = (): S15PoolMember[] => [
  { id: "working", isDefault: true, local: true, drained: false, activeSessions: 1, capacity: 2, works: 3, status: status("working", { activeSessions: 1 }) },
  { id: "computer_0011aabb", isDefault: false, local: false, drained: true, activeSessions: 0, capacity: 2, works: 1, status: status("computer_0011aabb", { state: "uncertain", reason: "vm_stop_unconfirmed", recoveryAvailable: false }) },
];
for (const locale of ["th", "en"] as const) test(`Resources list (${locale}): every computer with state, sessions, origin, drain and an add section`, async () => {
  const c = computer({ host: readyHost, members: members(), defaultStatus: members()[0]!.status }), f = setup(c), page = await html(f, "/resources/computer", locale === "en" ? en : {});
  expect(page).toContain(escaped(T("s15.pool.lead", locale))); expect(page).toContain(`aria-label="${escaped(T("s15.pool.list_label", locale))}"`);
  expect(page).toContain(`>${escaped(T("s15.pool.main", locale))}</h3>`); expect(page).toContain(`>${escaped(T("s15.pool.extra", locale).replace("{n}", "2"))}</h3>`);
  expect(page).toContain(escaped(T("s15.pool.origin_local", locale))); expect(page).toContain(escaped(T("s15.pool.origin_own", locale)));
  expect(page).toContain(escaped(T("s15.computer.sessions", locale).replace("{n}", "1").replace("{max}", "2")));
  expect(page).toContain(escaped(T("s15.pool.works", locale).replace("{n}", "3")));
  expect(page).toContain(escaped(T("s15.pool.drained", locale))); expect(page).toContain(escaped(T("s15.code.vm_stop_unconfirmed", locale)));
  expect(page).toContain(escaped(T("s15.pool.drain", locale))); expect(page).toContain(escaped(T("s15.pool.undrain", locale))); expect(page).toContain(escaped(T("s15.pool.drain_note", locale)));
  expect((page.match(/class="s15-caps"/g) ?? []).length).toBe(2);
  expect(page).toContain('id="s15-computer-add"'); expect(page).toContain(escaped(T("s15.pool.add_title", locale))); expect(page).toContain('action="/s15/forms/computer/begin"');
  // Each member has its own restore section with unique ids.
  expect(page).toContain('id="s15-restore-title"'); expect(page).toContain('id="s15-restore-title-computer_0011aabb"');
});

test("drain and undrain are owner no-script posts naming a listed computer; unknown values are refused", async () => {
  const c = computer({ members: members(), defaultStatus: members()[0]!.status }), f = setup(c);
  const drained = await f.post("/s15/forms/computer/drain", { vmId: "working", drained: "1" });
  expect(drained.status).toBe(303); expect(drained.headers.get("location")).toBe("/resources/computer?saved=drained&vm=working#s15-computer-working-card");
  expect(await html(f, "/resources/computer?saved=drained&vm=working")).toContain(escaped(T("s15.pool.drained_saved")));
  expect((await f.post("/s15/forms/computer/drain", { vmId: "computer_0011aabb", drained: "0" })).status).toBe(303);
  expect((await f.post("/s15/forms/computer/drain", { vmId: "working", drained: "yes" })).status).toBe(404);
  expect((await f.post("/s15/forms/computer/drain", { vmId: "working", drained: "1", extra: "x" })).status).toBe(400);
  expect(c.calls).toEqual(["drain:working:true", "drain:computer_0011aabb:false"]);
});

test("adding another computer enrolls under a composition-chosen id; restore names the exact member", async () => {
  const c = computer({ members: members(), defaultStatus: members()[0]!.status });
  const used: string[] = [];
  c.port.checkMachine = async () => ({ checkId: "c".repeat(32), address: "jit@vm.test:22", fingerprint: "SHA256:fixture", transportProfile: "ssh-sudo-systemd/v1", facts: status("x").facts! });
  c.port.useMachine = async (_actor, value) => { used.push(value.id); return status(value.id); };
  const f = setup(c);
  expect((await f.post("/s15/forms/computer/begin", { return: "computer" })).status).toBe(303);
  expect((await f.post("/s15/forms/computer/check", { return: "computer", setupId: "a".repeat(32), host: "vm.test" })).status).toBe(303);
  expect((await f.post("/s15/forms/computer/use", { return: "computer", checkId: "c".repeat(32), fingerprint: "SHA256:fixture" })).status).toBe(303);
  expect(used).toEqual(["computer_0011aabb"]);
  const restored = await f.post("/s15/forms/computer/restore", { vmId: "computer_0011aabb", snapshotId: `jit-${"d".repeat(32)}`, generation: "1" });
  expect(restored.status).toBe(303); expect(restored.headers.get("location")).toBe("/resources/computer?restored=1&vm=computer_0011aabb#s15-restore-title-computer_0011aabb");
  expect((await f.post("/s15/forms/computer/restore", { vmId: "not_listed", snapshotId: `jit-${"d".repeat(32)}`, generation: "1" })).status).toBe(404);
  expect(c.calls.filter(call => call.startsWith("restore:"))).toEqual([`restore:computer_0011aabb:jit-${"d".repeat(32)}`]);
});

test("without a pool port the Resources page keeps the single-computer layout", async () => {
  const c = computer({ defaultStatus: status("working") }); delete c.port.pool; delete c.port.local;
  const f = setup(c), page = await html(f, "/resources/computer");
  expect(page).not.toContain("s15-pool"); expect(page).not.toContain("s15-computer-add"); expect(page).toContain("s15-caps");
});

test("model route refusal codes render as plain sentences with a next step instead of the generic text", async () => {
  const { codeText } = await import("../src/s15/web/render"), { withLocale } = await import("../src/i18n");
  for (const code of ["route_needs_login", "route_store_unavailable", "route_store_invalid", "route_rejected", "route_integration_unavailable", "quota_exceeded", "auth_retry_refused", "dispatch_refused", "route_control_refused", "effort_unproven", "usage_invalid", "cost_bound_unknown"])
    for (const locale of ["th", "en"] as const) {
      const text = withLocale(locale, () => codeText(code));
      expect(text).toBe(T(`s15.code.${code}`, locale)); expect(text).not.toBe(T("s15.code.generic", locale));
      // Each sentence names a next step: the Models and budget page, or (store unreadable) a service restart.
      expect(text).toContain(code === "route_store_unavailable" ? locale === "th" ? "เริ่มบริการจิตใหม่" : "restart the Jit service" : locale === "th" ? "หน้าโมเดลและงบ" : "Models and budget");
    }
});

test("every SETUP15-01 and POOL15-01 key exists in Thai and English", () => {
  const keys = Object.keys(dictionaries.th).filter(k => k.startsWith("s15.provision.") || k.startsWith("s15.pool."));
  expect(keys.length).toBeGreaterThan(50);
  for (const k of keys) { expect(T(k, "en")?.trim().length).toBeGreaterThan(0); expect(T(k, "th")).not.toBe(T(k, "en")); }
  for (const code of ["vm_host_unsupported", "vm_kvm_unavailable", "vm_kvm_denied", "vm_qemu_missing", "vm_host_too_small", "vm_disk_insufficient", "vm_image_unavailable", "vm_image_unverified", "vm_provisioning_failed", "vm_stopped", "vm_drained"])
    for (const locale of ["th", "en"] as const) expect(T(`s15.code.${code}`, locale)?.length).toBeGreaterThan(0);
});
