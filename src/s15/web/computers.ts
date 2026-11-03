import { tr } from "../../i18n";
import { banner, codeText, e, fill, form, hidden, key, pill } from "./render";
import { capabilityRows, factsList, statusTone } from "./setup";
import type { S15PoolMember } from "./types";

/** Owner-facing name of one pool member; the owner never typed one, so it comes from its position. */
export function memberName(member: Pick<S15PoolMember, "isDefault">, index: number): string {
  return member.isDefault ? tr("s15.pool.main") : fill("s15.pool.extra", { n: index + 1 });
}
const anchor = (id: string) => `s15-computer-${id.replace(/[^A-Za-z0-9_-]/g, "")}`;

/**
 * POOL15-01 `/resources/computer` list: every enrolled computer with its observed status, capability rows,
 * active sessions and drain control. Draining stops new placement only; running work finishes and work whose
 * files live there keeps returning. Rows are observed facts from enrollment; nothing is ✓ from configuration.
 */
export function poolList(input: { members: S15PoolMember[]; csrf: string; hypervisor: string | null; saved: "drained" | "undrained" | null; savedId: string | null; refused: string | null; refusedId: string | null }): string {
  const items = input.members.map((member, index) => {
    const status = member.status, [word, tone, glyph] = statusTone[status.state], id = anchor(member.id), name = memberName(member, index);
    const saved = input.saved && input.savedId === member.id ? `<div role="status">${banner("ok", tr(input.saved === "drained" ? "s15.pool.drained_saved" : "s15.pool.undrained_saved"))}</div>` : "";
    const refused = input.refused && input.refusedId === member.id ? `<div role="alert">${banner("warn", codeText(input.refused), "", `<p class="s-mono s-meta">${e(input.refused)}</p>`)}</div>` : "";
    const drain = form("/s15/forms/computer/drain", input.csrf, `${hidden("vmId", member.id)}${hidden("drained", member.drained ? "0" : "1")}<button class="s-btn${member.drained ? " primary" : ""}" aria-describedby="${id}-drain-note">${tr(member.drained ? "s15.pool.undrain" : "s15.pool.drain")}</button>`);
    return `<li><article class="s15-computer" aria-labelledby="${id}" id="${id}-card">${saved}${refused}
      <div class="s-row"><h3 class="s-grow" id="${id}">${e(name)}</h3>${pill(tr(key(word)), tone, glyph)}${member.drained ? pill(tr("s15.pool.drained"), "warn", "!") : ""}</div>
      <p class="s-meta">${tr(member.local ? "s15.pool.origin_local" : "s15.pool.origin_own")} · ${fill("s15.computer.generation", { n: status.generation })} · ${fill("s15.computer.sessions", { n: member.activeSessions, max: member.capacity })}${member.works ? ` · ${fill("s15.pool.works", { n: member.works })}` : ""} · <span class="s-mono">${e(member.id)}</span></p>
      ${status.reason ? `<p class="s-sub">${codeText(status.reason)}</p>` : ""}${capabilityRows(status, input.hypervisor)}${status.facts ? `<details class="s-more"><summary>${tr("s15.computer.facts_title")}</summary><div>${factsList(status.facts)}</div></details>` : ""}
      <div class="s-row">${drain}</div><p class="s-note" id="${id}-drain-note">${tr(member.drained ? "s15.pool.undrain_note" : "s15.pool.drain_note")}</p></article></li>`;
  }).join("");
  return `<p class="s-sub">${tr("s15.pool.lead")}</p><ul class="s15-pool" aria-label="${tr("s15.pool.list_label")}">${items}</ul>`;
}

/**
 * "Add another computer". An added computer takes work only with a hypervisor binding, so the flow first
 * registers an unused management adapter (Lima instance or VM-scoped Proxmox token) and explains why; only
 * then is the existing enrollment flow offered. The token field is write-only: never prefilled or echoed.
 */
export function addComputer(input: { flow: string; managed: boolean; canRegister: boolean; csrf: string; refused: string | null; saved: boolean }): string {
  const head = `<h2 id="s15-computer-add-title">${tr("s15.pool.add_title")}</h2><p class="s-sub">${tr("s15.pool.add_lead")}</p>`;
  if (input.managed) {
    const saved = input.saved ? `<div role="status">${banner("ok", tr("s15.pool.manager_saved"))}</div>` : "";
    return `<section class="s-card" id="s15-computer-add" aria-labelledby="s15-computer-add-title">${head}${saved}<p class="s-note">${tr("s15.pool.manager_ready")}</p>${input.flow}</section>`;
  }
  const refused = input.refused ? `<div role="alert">${banner("warn", codeText(input.refused), "", `<p class="s-mono s-meta">${e(input.refused)}</p>`)}</div>` : "";
  const field = (name: string, label: string, attributes: string) => `<label class="s-field"><span>${e(label)}</span><input name="${name}" ${attributes}></label>`;
  const forms = input.canRegister ? `<details class="s-more" open><summary>${tr("s15.pool.manager_lima")}</summary><div>${form("/s15/forms/computer/manager", input.csrf, `${hidden("kind", "lima")}${field("instance", tr("s15.pool.manager_lima_instance"), 'required maxlength="63" pattern="jit-work(-[a-z0-9-]+)?" autocomplete="off" spellcheck="false"')}<div><button class="s-btn primary">${tr("s15.pool.manager_save")}</button></div>`, ' class="s-stack"')}</div></details>
    <details class="s-more"><summary>${tr("s15.pool.manager_proxmox")}</summary><div>${form("/s15/forms/computer/manager", input.csrf, `${hidden("kind", "proxmox")}${field("baseUrl", tr("s15.pool.manager_base_url"), 'required maxlength="253" inputmode="url" autocomplete="off" spellcheck="false"')}${field("node", tr("s15.pool.manager_node"), 'required maxlength="63" autocomplete="off" spellcheck="false"')}${field("vmid", tr("s15.pool.manager_vmid"), 'required inputmode="numeric" pattern="[0-9]{1,9}" autocomplete="off"')}
      <label class="s-field"><span>${tr("s15.pool.manager_token")}</span><input name="token" type="password" required maxlength="4096" autocomplete="off" spellcheck="false" aria-describedby="s15-manager-token-note"></label><p class="s-note" id="s15-manager-token-note">${tr("s15.pool.manager_token_note")}</p>
      ${field("proxyAddress", tr("s15.pool.manager_proxy_address"), 'required maxlength="253" autocomplete="off" spellcheck="false"')}${field("proxyPort", tr("s15.pool.manager_proxy_port"), 'required inputmode="numeric" pattern="[0-9]{1,5}" autocomplete="off"')}<div><button class="s-btn primary">${tr("s15.pool.manager_save")}</button></div>`, ' class="s-stack"')}</div></details>` : "";
  return `<section class="s-card" id="s15-computer-add" aria-labelledby="s15-computer-add-title">${head}${refused}<h3 class="s-section-t">${tr("s15.pool.manager_title")}</h3><p>${tr("s15.pool.manager_why")}</p>${forms}</section>`;
}
