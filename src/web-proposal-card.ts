import { tr, type MessageKey } from "./i18n";
import { escape, hiddenCommand } from "./web-layout";
import { sameRoute, type RoleProposalView } from "./team/role-proposals";
import type { RoleRoute } from "./team/types";
import { promotionNameChars, type PromotionProposalView } from "./promotion";

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
  state: "proposed" | "accepted" | "rejected" | "superseded";
  /** Localised kind line, e.g. "Jit suggests a new specialist". */
  eyebrow: string;
  /** Untrusted proposal text (model- or owner-authored). */
  title: string;
  /** Localised revision and author line. */
  meta: string;
  fields: readonly { label: string; value: string; literal?: boolean }[];
  /** Localised labels of what was dropped, plus the total when more were dropped than listed. */
  dropped: { items: readonly string[]; total: number } | null;
  /** Localised authority note shown while the proposal is open. */
  note: string | null;
  actions: string;
  footer: string;
}

const tone: Record<ProposalCard["state"], string> = { proposed: "proposed", accepted: "accepted", rejected: "dismissed", superseded: "disabled" };

/** Renders one proposal card. It works without script: every action is a plain form post. */
export function proposalCard(card: ProposalCard): string {
  const dropped = card.dropped && card.dropped.total
    ? `<div class="proposal-dropped" role="note"><p>${tr("proposal.dropped")} (${card.dropped.total})</p><ul>${card.dropped.items.map(item => `<li>${escape(item)}</li>`).join("")}</ul></div>` : "";
  return `<article class="team-card proposal-card" id="proposal-${escape(card.id)}" data-proposal-kind="${escape(card.kind)}" data-proposal-state="${card.state}">
    <header><div><p class="eyebrow">${escape(card.eyebrow)}</p><h3>${escape(card.title)}</h3></div><span class="job-status" data-state="${tone[card.state]}">${tr(`proposal.state.${card.state}` as MessageKey)}</span></header>
    <p class="proposal-meta">${escape(card.meta)}</p>
    <dl class="proposal-fields">${card.fields.map(field => `<dt>${escape(field.label)}</dt><dd${field.literal ? ' class="literal"' : ""}>${escape(field.value)}</dd>`).join("")}</dl>
    ${dropped}${card.note ? `<p class="proposal-note">${escape(card.note)}</p>` : ""}${card.actions}${card.footer}</article>`;
}

const routeText = (route: RoleRoute) => `${route.provider} / ${route.model} · ${route.authRoute}`;
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
