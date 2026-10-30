import type { Application } from "./application";
import { tr } from "./i18n";
import { escape, hiddenCommand } from "./web-layout";

/** Plain Web forms bind explicit quota confirmation to one configured route/model and revision; rendering performs no live call. */
export function imageProbeCards(state: ReturnType<Application["imageProbeState"]>, csrf: string, projectId: string | null): string {
  const action = projectId ? `/projects/${projectId}/team/image-probe` : "/team/image-probe";
  return `<section class="team-card"><h2>${tr("attachments.image_probe_title")}</h2><p>${tr("attachments.image_probe_note")}</p>${state.routes.map(({ route, record, passed, reason }) =>
    `<article><h3>${escape(route.provider)} / ${escape(route.model)}</h3><p>${reason ? tr("attachments.image_probe_refused") : passed ? tr("attachments.image_probe_pass") : tr("attachments.route_cannot_see_images")}${record ? ` · ${escape(record.testedAt)} · ${tr(`attachments.image_probe_result_${record.verdict}`)}` : ""}</p>`
    + (reason ? `<p role="status">${tr(`attachments.image_probe_reason_${reason}`)} ${reason === "sign_in" ? `<a href="/settings/team#sign-in-${escape(route.provider)}">${tr("attachments.image_probe_next_sign_in")}</a>` : tr(`attachments.image_probe_next_${reason}`)}</p>` : "")
    + `<form method="post" action="${action}">${hiddenCommand(csrf, state.revision)}<input type="hidden" name="provider" value="${escape(route.provider)}"><input type="hidden" name="model" value="${escape(route.model)}">`
    + `<label><input type="checkbox" name="confirmed" value="true" required>${tr("attachments.image_probe_confirm")}</label><button>${tr("attachments.image_probe_run")}</button></form></article>`).join("")}</section>`;
}
