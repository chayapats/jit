import { tr, type MessageKey } from "./i18n";
import { escape, hiddenCommand } from "./web-layout";
import type { ConnectionView } from "./exec/connections";
import type { McpProposalView } from "./exec/mcp";
import { sameRoute, type RoleProposalView } from "./team/role-proposals";
import type { RoleRoute } from "./team/types";
import { routeText } from "./team/route-options";
import { promotionNameChars, type PromotionProposalView } from "./promotion";
import { canonicalJson, type ApprovalCard, type EffectAction } from "./exec/approval-cards";

/**
 * web.approval_cards/v1 card summary (EXE09): human-readable lines for the exact pinned action.
 * The action holds only metadata (names, SHAs, titles); no connection value ever appears here.
 */
export function summarizeApprovalAction(action: EffectAction): string[] {
  switch (action.kind) {
    case "outbound_release":
      return [action.tool, action.subject, ...(action.outbound?.reason ? [] : [`${tr("web.matched_span")}: ${action.matchedSpan}`])];
    case "effect.git_push":
      return [
        `${action.remote.name} (${action.remote.url})`,
        action.repository,
        ...action.updates.map(update => `${update.ref}: ${update.oldSha ?? "new"} → ${update.newSha}`),
        ...action.commits.map(commit => `${commit.sha.slice(0, 8)} ${commit.summary}`),
      ];
    case "effect.github_pr_create":
      return [`${action.github.owner}/${action.github.repo}`, `base ${action.base} ← head ${action.head}`, action.title, ...(action.body ? [action.body.slice(0, 500)] : []), action.draft ? "draft" : "ready"];
    case "effect.github_comment":
      return [`${action.github.owner}/${action.github.repo} #${action.issueNumber}`, action.body.slice(0, 500)];
    case "effect.github_pr_merge":
      return [`${action.github.owner}/${action.github.repo} #${action.pullNumber}`, action.headSha.slice(0, 8), action.method];
    case "effect.deploy":
      return [`${action.target.name} (${action.target.url})`, action.ref ?? "-"];
    // app.mcp_servers/v1 (EXE12): the server, tool and exact arguments the owner approves.
    case "mcp_tool":
      return [`${action.server.name} · ${action.tool}`, JSON.stringify(action.arguments).slice(0, 2000)];
    // exec.browser/v1 (EXE14): the page, the element and the form's field names; a password value never appears.
    case "browser_confirm":
      return [action.url, `${action.operation} · ${action.element.name || action.element.tag}`, ...(action.formFields.length ? [action.formFields.join(", ")] : []),
        ...(action.operation === "type" ? [action.text ?? "••••••"] : [])];
    // exec.computer/v1 (EXE16): the exact desktop input, the model's declared intent and Jit's reasons.
    case "computer_confirm":
      return [action.operation === "click" ? `click ${action.x}, ${action.y}` : action.operation === "key" ? `key ${action.keys!.join(" ")}` : `type ${action.text!}`,
        `${action.intent} · ${action.reasons.join(", ")}`];
  }
}

/** web.approval_cards/v1 card (EXE09) over `ApprovalCard` (the merged EXE07 read model; there is no separate `ApprovalCardView`). */
export function approvalCard(view: ApprovalCard, options: { topicBase: string; csrf: string; now?: number }): string {
  const kindSuffix = view.kind.replace(/^effect\./, "");
  const kindKey = `approval.kind_${kindSuffix}` as MessageKey;
  const title = tr(kindKey);
  const summary = summarizeApprovalAction(view.action) ?? [];
  if (view.action.outbound && !view.action.outbound.reason) summary.push(`${tr("web.matched_span")}: ${view.action.outbound.span}`);
  const actionJson = canonicalJson(view.action);
  const now = options.now ?? Date.now();
  const minutes = Math.max(0, Math.ceil((view.expiresAt - now) / 60_000));
  const meta = `${tr("approval.title")} · ${fillText(tr("approval.expires_in"), { minutes: String(minutes) })}`;
  const fields = (view.action.outbound ? `<dt>${escape(title)}</dt><dd class="error">${tr(view.action.outbound.reason ? "attachments.outbound_uncertain" : "attachments.outbound_marker")} (${view.outboundBlocks ?? 1})</dd>` : "") + summary.map(line => `<dt>${escape(title)}</dt><dd>${view.action.outbound && line.endsWith(view.action.outbound.span) ? escape(line.slice(0, -view.action.outbound.span.length)) + `<mark>${escape(view.action.outbound.span)}</mark>` : escape(line)}</dd>`).join("");
  const details = `<details><summary>${tr("approval.details")}</summary><pre>${escape(actionJson)}</pre></details>`;
  const open = view.state === "pending";
  if (!open) {
    const stateKey = `approval.state_${view.state}` as MessageKey;
    return `<article class="team-card proposal-card" id="approval-${escape(view.id)}" data-approval-kind="${escape(view.kind)}" data-approval-state="${view.state}">`
      + `<header><div><p class="eyebrow">${escape(tr("approval.title"))}</p><h3>${escape(title)}</h3></div>`
      + `<span class="job-status" data-state="${view.state}">${escape(tr(stateKey))}</span></header>`
      + `<p class="proposal-meta">${escape(meta)}</p><dl class="proposal-fields">${fields}</dl>${details}</article>`;
  }
  const approveAction = `${options.topicBase}/approvals/${view.id}`;
  const hidden = hiddenCommand(options.csrf, view.revision)
    + `<input type="hidden" name="cardId" value="${escape(view.id)}"><input type="hidden" name="expectedDigest" value="${escape(view.digest)}">`;
  const actions = `<div class="proposal-actions">`
    + `<form method="post" action="${approveAction}">${hidden}<input type="hidden" name="decision" value="approve"><button class="primary">${tr("approval.approve")}</button></form>`
    + `<form method="post" action="${approveAction}">${hidden}<input type="hidden" name="decision" value="deny"><button>${tr("approval.deny")}</button></form></div>`;
  return `<article class="team-card proposal-card" id="approval-${escape(view.id)}" data-approval-kind="${escape(view.kind)}" data-approval-state="pending">`
    + `<header><div><p class="eyebrow">${escape(tr("approval.title"))}</p><h3>${escape(title)}</h3></div>`
    + `<span class="job-status" data-state="pending">${escape(title)}</span></header>`
    + `<p class="proposal-meta">${escape(meta)}</p><dl class="proposal-fields">${fields}</dl>${details}${actions}</article>`;
}

/**
 * The proposal card of the design system (docs/design/README.md, "Components"): one Jit suggestion with a status
 * pill in words, its fields, what was dropped from the model's request and the owner's actions. It is generic so
 * every proposal kind (role here; dispatch and promotion later) renders the same way. Every value is escaped
 * here; `actions` and `footer` are trusted markup built from dictionary text and service identifiers.
 */
export interface ProposalCard {
  /** Element id is `proposal-<id>`, the anchor redirects and links return to. */
  id: string;
  kind: string;
  state: "proposed" | "accepted" | "rejected" | "superseded" | "dropped";
  /** Localised kind line, e.g. "Jit suggests a new specialist". */
  eyebrow: string;
  /** Untrusted proposal text (model- or owner-authored). */
  title: string;
  /** Localised revision and author line. */
  meta: string;
  fields: readonly { label: string; value: string; literal?: boolean; code?: boolean }[];
  /** Localised labels of what was dropped, plus the total when more were dropped than listed. */
  dropped: { items: readonly string[]; total: number } | null;
  /** Localised authority note shown while the proposal is open. */
  note: string | null;
  actions: string;
  footer: string;
}

const tone: Record<ProposalCard["state"], string> = { proposed: "proposed", accepted: "accepted", rejected: "dismissed", superseded: "disabled", dropped: "dismissed" };

/** Renders one proposal card. It works without script: every action is a plain form post. */
export function proposalCard(card: ProposalCard): string {
  const dropped = card.dropped && card.dropped.total
    ? `<div class="proposal-dropped" role="note"><p>${tr("proposal.dropped")} (${card.dropped.total})</p><ul>${card.dropped.items.map(item => `<li>${escape(item)}</li>`).join("")}</ul></div>` : "";
  return `<article class="team-card proposal-card" id="proposal-${escape(card.id)}" data-proposal-kind="${escape(card.kind)}" data-proposal-state="${card.state}">
    <header><div><p class="eyebrow">${escape(card.eyebrow)}</p><h3>${escape(card.title)}</h3></div><span class="job-status" data-state="${tone[card.state]}">${tr(`proposal.state.${card.state}` as MessageKey)}</span></header>
    <p class="proposal-meta">${escape(card.meta)}</p>
    <dl class="proposal-fields">${card.fields.map(field => `<dt>${escape(field.label)}</dt><dd${field.literal ? ' class="literal"' : ""}>${field.code ? `<code>${escape(field.value)}</code>` : escape(field.value)}</dd>`).join("")}</dl>
    ${dropped}${card.note ? `<p class="proposal-note">${escape(card.note)}</p>` : ""}${card.actions}${card.footer}</article>`;
}

/** A null route inherits the default; the label names that default, or says there is none. */
const routeLabel = (route: RoleRoute | null, fallback: RoleRoute | null) => route ? routeText(route)
  : fallback ? `${tr("proposal.route_default")} (${routeText(fallback)})` : tr("proposal.route_default_missing");
const droppedKeys: Record<string, MessageKey> = {
  "field:tools": "proposal.dropped.tools", "field:tool": "proposal.dropped.tools",
  "field:budgets": "proposal.dropped.budgets", "field:budget": "proposal.dropped.budgets", "field:limits": "proposal.dropped.budgets",
  "route:unconfigured": "proposal.dropped.route_unconfigured", "route:invalid": "proposal.dropped.route_invalid",
  "redaction:field": "proposal.dropped.redacted",
};
/** Dictionary label of one dropped code; other fields show their safe identifier after a generic label. */
export function droppedLabel(code: string): string {
  const key = droppedKeys[code];
  if (key) return tr(key);
  return code.startsWith("field:") ? `${tr("proposal.dropped.field")} ${code.slice(6)}` : code;
}

/**
 * app.role_proposals/v1 card. While open it offers create (accept this revision), edit (an owner-authored
 * revision; the route list holds only configured routes) and dismiss. All three post to
 * `<topic>/replies/<reply>/proposals/<id>/(accept|revise|reject)` with the current revision.
 */
export function roleProposalCard(view: RoleProposalView, options: { topicBase: string; csrf: string; routes: readonly RoleRoute[]; defaultRoute: RoleRoute | null }): string {
  const action = (verb: string) => `${options.topicBase}/replies/${view.replyId}/proposals/${view.id}/${verb}`;
  const open = view.state === "proposed";
  const previous = view.history.slice(0, -1).map(item => `${item.revision} ${tr(item.author === "owner" ? "proposal.by_owner" : "proposal.by_jit")} · ${tr(`proposal.state.${item.state}` as MessageKey)}`);
  const meta = `${tr("proposal.revision")} ${view.revision} · ${tr(view.author === "owner" ? "proposal.by_owner" : "proposal.by_jit")}${previous.length ? ` · ${tr("proposal.earlier")} ${previous.join(", ")}` : ""}`;
  const selected = (route: RoleRoute | null) => (route && view.route ? sameRoute(route, view.route) : route === view.route) ? " selected" : "";
  // Without its own route and without a default, the role could not run: the owner picks a route by editing first.
  const routeless = !view.route && !options.defaultRoute;
  const actions = open ? `<div class="proposal-actions">
      ${routeless ? "" : `<form method="post" action="${action("accept")}">${hiddenCommand(options.csrf, view.revision)}<button class="primary">${tr("proposal.role.accept")}</button></form>`}
      <form method="post" action="${action("reject")}">${hiddenCommand(options.csrf, view.revision)}<button>${tr("proposal.dismiss")}</button></form></div>
    <details class="proposal-edit"><summary>${tr("proposal.edit")}</summary><form class="team-form" method="post" action="${action("revise")}">${hiddenCommand(options.csrf, view.revision)}
      <label>${tr("proposal.role.name")}<input name="name" required maxlength="80" value="${escape(view.name)}"></label>
      <label>${tr("proposal.role.responsibility")}<textarea name="responsibility" required>${escape(view.responsibility)}</textarea></label>
      <label>${tr("proposal.role.route")}<select name="route"><option value=""${selected(null)}>${escape(routeLabel(null, options.defaultRoute))}</option>${options.routes.map(route => `<option value="${escape(JSON.stringify(route))}"${selected(route)}>${escape(routeText(route))}</option>`).join("")}</select></label>
      <small>${tr("proposal.edit_note")}</small><button class="primary">${tr("proposal.save_edit")}</button></form></details>` : "";
  const footer = view.state === "accepted" && view.roleId
    ? `<p class="proposal-outcome">${tr("proposal.role.created")} <a href="/settings/team#role-${view.roleId}">${tr("proposal.role.open_team")}</a></p>`
    : view.state === "rejected" ? `<p class="proposal-outcome">${tr("proposal.dismissed_note")}</p>`
    : view.closedByDeletion ? `<p class="proposal-outcome">${tr("proposal.closed_by_deletion")}</p>` : "";
  return proposalCard({
    id: view.id, kind: "role", state: view.state, eyebrow: tr("proposal.role.eyebrow"), title: view.name, meta,
    fields: [{ label: tr("proposal.role.responsibility"), value: view.responsibility, literal: true }, { label: tr("proposal.role.route"), value: routeLabel(view.route, options.defaultRoute) }],
    dropped: view.droppedTotal ? { items: view.dropped.map(droppedLabel), total: view.droppedTotal } : null,
    note: open ? tr(routeless ? "proposal.role.needs_route" : "proposal.role.note") : null, actions, footer,
  });
}

/**
 * app.mcp_servers/v1 card (EXE13, web.mcp_settings/v1) over `McpProposalView` (the merged EXE12 read model).
 * Shows the source, package, pinned version, command and args verbatim — escaped, inside `<code>` — and one
 * connection select per env name (connections of kind `mcp_env` serving the project, plus a none option).
 * Accept (with the env bindings), reject and revise post to `${topicBase}/mcp-proposals/${id}` with `decision`,
 * `expectedRevision` and `requestId`. Only an open proposal offers actions; a dropped one shows its offered
 * fields and why it cannot be installed. Secret values never appear: the selects carry ids and labels only.
 */
export function mcpInstallProposalCard(view: McpProposalView, options: { topicBase: string; csrf: string; connections: ConnectionView[] }): string {
  const action = `${options.topicBase}/mcp-proposals/${view.id}`;
  const open = view.state === "proposed";
  const spec = view.spec;
  const name = spec?.name ?? view.offered?.name ?? view.id;
  const previous = view.history.slice(0, -1).map(item => `${item.revision} ${tr(item.author === "owner" ? "proposal.by_owner" : "proposal.by_jit")} · ${tr(`proposal.state.${item.state}` as MessageKey)}`);
  const meta = `${tr("proposal.revision")} ${view.revision} · ${tr(view.author === "owner" ? "proposal.by_owner" : "proposal.by_jit")}${previous.length ? ` · ${tr("proposal.earlier")} ${previous.join(", ")}` : ""}`;
  const offered: { label: string; value: string }[] = [];
  if (!spec && view.offered) {
    const labels = { name: "proposal.role.name", source: "mcp.source", package: "mcp.package", version: "mcp.version" } as const;
    for (const [field, label] of Object.entries(labels)) {
      const value = view.offered[field as keyof typeof view.offered];
      if (value !== undefined) offered.push({ label: tr(label as MessageKey), value });
    }
  }
  const fields: ProposalCard["fields"] = spec
    ? [{ label: tr("mcp.source"), value: spec.source, code: true }, { label: tr("mcp.package"), value: spec.package, code: true },
      { label: tr("mcp.version"), value: spec.version, code: true }, { label: tr("mcp.command"), value: spec.command, code: true },
      { label: tr("mcp.args"), value: spec.args.join(" "), code: true },
      ...(spec.env.length ? [{ label: tr("mcp.env"), value: spec.env.join(", ") }] : [])]
    : offered.map(field => ({ ...field, code: true }));
  const dropped = [...view.dropped, ...(view.state === "dropped" && view.reason ? [view.reason] : [])];
  // Only connections that could serve this project appear; the value stays in the vault.
  const eligible = options.connections.filter(connection => connection.kind === "mcp_env" && connection.removedAt === null &&
    (connection.projectScope === null || connection.projectScope.includes(view.projectId)));
  const selects = (spec?.env ?? []).map(env => `<label>${escape(env)}<select name="env_${escape(env)}" required>`
    + `<option value="">${tr("mcp.env_none")}</option>${eligible.map(connection => `<option value="${connection.id}">${escape(connection.label)}</option>`).join("")}</select></label>`).join("");
  const actions = open && spec ? `<div class="proposal-actions">`
    + `<form method="post" action="${action}">${hiddenCommand(options.csrf, view.revision)}<input type="hidden" name="decision" value="accept">${selects}<button class="primary">${tr("mcp.install")}</button></form>`
    + `<form method="post" action="${action}">${hiddenCommand(options.csrf, view.revision)}<input type="hidden" name="decision" value="reject"><button>${tr("mcp.reject")}</button></form></div>`
    + `<details class="proposal-edit"><summary>${tr("mcp.revise")}</summary><form class="team-form" method="post" action="${action}">${hiddenCommand(options.csrf, view.revision)}<input type="hidden" name="decision" value="revise">`
    + `<label>${tr("proposal.role.name")}<input name="name" required maxlength="80" value="${escape(spec.name)}"></label>`
    + `<label>${tr("mcp.source")}<select name="source" required>${(["npm", "pypi", "oci"] as const).map(source => `<option value="${source}"${source === spec.source ? " selected" : ""}>${source}</option>`).join("")}</select></label>`
    + `<label>${tr("mcp.package")}<input name="package" required maxlength="255" value="${escape(spec.package)}"></label>`
    + `<label>${tr("mcp.version")}<input name="version" required maxlength="255" value="${escape(spec.version)}"></label>`
    + `<label>${tr("mcp.command")}<input name="command" required maxlength="128" value="${escape(spec.command)}"></label>`
    + `<label>${tr("mcp.args")}<input name="args" required maxlength="2000" value="${escape(JSON.stringify(spec.args))}"></label>`
    + `<label>${tr("mcp.env")}<input name="env" maxlength="500" value="${escape(spec.env.join(", "))}"></label>`
    + `<small>${tr("proposal.edit_note")}</small><button class="primary">${tr("proposal.save_edit")}</button></form></details>` : "";
  return proposalCard({
    id: view.id, kind: "mcp_install", state: view.state === "dropped" ? "dropped" : view.state, eyebrow: tr("mcp.proposal_title"), title: name, meta,
    fields, dropped: dropped.length ? { items: dropped.map(droppedLabel), total: dropped.length } : null, note: null, actions, footer: "",
  });
}
/** Replaces `{name}` placeholders of a trusted dictionary template; values are escaped by the caller's renderer. */
export const fillText = (template: string, values: Readonly<Record<string, string>>) =>
  template.replace(/\{([a-z]+)\}/g, (token, name: string) => Object.hasOwn(values, name) ? values[name]! : token);

/**
 * app.topic_promotion/v1 card. While open it offers accept (promote at this revision), edit (an owner-authored revision
 * of the project name) and dismiss, each posting to `<topic>/replies/<reply>/promotions/<id>/(accept|revise|dismiss)`
 * with the current revision. The card states what accept does and does not do.
 */
export function promotionProposalCard(view: PromotionProposalView, options: { topicBase: string; csrf: string; originTitle: string | null }): string {
  const action = (verb: string) => `${options.topicBase}/replies/${view.replyId}/promotions/${view.id}/${verb}`;
  const open = view.state === "proposed";
  const previous = view.history.slice(0, -1).map(item => `${item.revision} ${tr(item.author === "owner" ? "proposal.by_owner" : "proposal.by_jit")} · ${tr(`proposal.state.${item.state}` as MessageKey)}`);
  const meta = `${tr("proposal.revision")} ${view.revision} · ${tr(view.author === "owner" ? "proposal.by_owner" : "proposal.by_jit")}${previous.length ? ` · ${tr("proposal.earlier")} ${previous.join(", ")}` : ""}`;
  const actions = open ? `<div class="proposal-actions">
      <form method="post" action="${action("accept")}">${hiddenCommand(options.csrf, view.revision)}<button class="primary">${tr("promotion.accept")}</button></form>
      <form method="post" action="${action("dismiss")}">${hiddenCommand(options.csrf, view.revision)}<button>${tr("proposal.dismiss")}</button></form></div>
    <details class="proposal-edit"><summary>${tr("proposal.edit")}</summary><form class="team-form" method="post" action="${action("revise")}">${hiddenCommand(options.csrf, view.revision)}
      <label>${tr("promotion.name")}<input name="name" required maxlength="${promotionNameChars}" value="${escape(view.name)}"></label>
      <small>${tr("promotion.edit_note")}</small><button class="primary">${tr("proposal.save_edit")}</button></form></details>` : "";
  const footer = view.state === "accepted" && view.promotion
    ? `<p class="proposal-outcome">${tr("promotion.created")} <a href="/projects/${view.promotion.projectId}/topics/${view.promotion.topicId}">${tr("promotion.open_continuation")}</a></p>`
    : view.state === "rejected" ? `<p class="proposal-outcome">${tr("promotion.dismissed_note")}</p>`
    : view.closedByPromotion ? `<p class="proposal-outcome">${tr("promotion.closed_by_promotion")}</p>`
    : view.closedByDeletion ? `<p class="proposal-outcome">${tr("promotion.closed_by_deletion")}</p>` : "";
  return proposalCard({
    id: view.id, kind: "promotion", state: view.state, eyebrow: tr("promotion.eyebrow"), title: view.name, meta,
    fields: [{ label: tr("promotion.from_topic"), value: options.originTitle ?? tr("common.topic_unavailable") },
      { label: tr("promotion.what_happens"), value: tr("promotion.what_happens_text") }],
    dropped: view.droppedTotal ? { items: view.dropped.map(droppedLabel), total: view.droppedTotal } : null,
    note: open ? tr("promotion.note") : null, actions, footer,
  });
}
