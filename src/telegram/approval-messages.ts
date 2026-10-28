import { withLocale, tr, type Locale } from "../i18n";
import type { ApprovalCard } from "../exec/approval-cards";

/** telegram.approval_cards/v1 message (EXE10) over `ApprovalCard` (the merged EXE07 read model). */
export function renderApprovalMessage(card: ApprovalCard, locale: Locale, options?: { projectName?: string | undefined; topicTitle?: string | undefined }): { text: string; buttons: { text: string; data: string }[] } {
  return withLocale(locale, () => {
    const kindSuffix = card.kind.replace(/^effect\./, "");
    const kindTitle = tr(`approval.kind_${kindSuffix}` as never);
    const project = options?.projectName ?? card.projectId;
    const topic = options?.topicTitle ?? card.topicId;
    const { pinned, flexible } = approvalDetailParts(card);
    const lines = [kindTitle, project, topic, ...pinned, ...flexible];
    const text = lines.join("\n");
    return { text, buttons: [{ text: tr("approval.approve"), data: "" }, { text: tr("approval.deny"), data: "" }] };
  });
}

/** Splits the card summary into pinned lines (always kept) and flexible lines (truncated first). */
export function approvalDetailParts(card: ApprovalCard): { pinned: string[]; flexible: string[] } {
  const action = card.action;
  switch (action.kind) {
    case "effect.git_push":
      return {
        pinned: [`${action.remote.name}`, action.repository,
          ...action.updates.map(update => `${update.ref}: ${update.oldSha ?? "new"} -> ${update.newSha}`)],
        flexible: action.commits.map(commit => `${commit.sha.slice(0, 8)} ${commit.summary}`),
      };
    case "effect.github_pr_create":
      return {
        pinned: [`${action.github.owner}/${action.github.repo}`, `base ${action.base} <- head ${action.head}`, action.title],
        flexible: action.body ? [action.body] : [],
      };
    case "effect.github_comment":
      return { pinned: [`${action.github.owner}/${action.github.repo} #${action.issueNumber}`], flexible: [action.body] };
    case "effect.github_pr_merge":
      return {
        pinned: [`${action.github.owner}/${action.github.repo} #${action.pullNumber}`, action.headSha.slice(0, 8), action.method],
        flexible: [],
      };
    case "effect.deploy":
      return { pinned: [action.target.name, action.ref ?? "-"], flexible: [] };
    case "mcp_tool":
      return { pinned: [`${action.server.name} · ${action.tool}`], flexible: [JSON.stringify(action.arguments)] };
  }
}
