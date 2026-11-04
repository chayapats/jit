import { tr } from "../../i18n";
import { untrusted } from "../../s14/web-pages";
import type { ConversationOwnerRow } from "../conversation";
import { displayState, evidenceRow } from "./chat";
import { clip, clock, e, experienceIcon, fill, statePill } from "./render";

/** A currently readable conversation result, not a new artifact, report acceptance or execution grant. */
export interface S15LibraryItem { conversationId: string; row: ConversationOwnerRow }

/** Read-only library over fresh, owner-checked CHAT projections. No cached evidence or synthetic artifact identity. */
export function libraryBody(items: readonly S15LibraryItem[], selected: S15LibraryItem | null): string {
  if (selected) {
    const { row, conversationId } = selected;
    return `<div class="s-col s15-library-detail"><p>${statePill(displayState(row))} <span class="s-meta">${clock(row.receipt.receivedAt)} · ${fill("s15.library.revision", { n: row.revision })}</span></p>
      <h2>${e(clip(row.ownerMessage, 100))}</h2>${row.result ? untrusted(`<p class="s15-text">${e(row.result.text)}</p>`, tr("s15.result.answer")) : `<p class="s-note">${tr("s15.library.no_result")}</p>`}
      <section aria-labelledby="s15-library-evidence"><h3 id="s15-library-evidence">${tr("s15.library.evidence")}</h3>${row.evidence.length ? `<ul class="s15-progress-list">${row.evidence.slice(0, 64).map(evidenceRow).join("")}</ul>` : `<p class="s-note">${tr("s15.result.no_evidence")}</p>`}</section>
      <p class="s-note">${tr("s15.library.scope")}</p><a class="s-link-text" href="/chats/${e(conversationId)}#s15-row-${e(row.requestId)}">${tr("s15.library.conversation")}</a></div>`;
  }
  return `<div class="s-col"><h2>${tr("s15.library.title")}</h2><p class="s-sub">${tr("s15.library.lead")}</p>${items.length ? items.map(({ conversationId, row }) => `<a class="s15-library-item" href="/library?conversation=${e(conversationId)}&amp;request=${e(row.requestId)}" data-s15-detail>${experienceIcon("file")}<span>${e(clip(row.ownerMessage, 80))}<small>${clock(row.receipt.receivedAt)} · ${fill("s15.library.evidence_count", { n: row.evidence.length })}</small></span>${statePill(displayState(row))}</a>`).join("") : `<p class="s-note">${tr("s15.library.empty")}</p>`}</div>`;
}
