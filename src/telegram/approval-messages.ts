import { withLocale, tr, type Locale } from "../i18n";
import type { ApprovalCard } from "../exec/approval-cards";

/** telegram.approval_cards/v1 message (EXE10) over `ApprovalCard` (the merged EXE07 read model). */
export function renderApprovalMessage(card: ApprovalCard, locale: Locale, options?: { projectName?: string | undefined; topicTitle?: string | undefined }): { text: string; buttons: { text: string; data: string }[] } {
  return withLocale(locale, () => {
    const kindSuffix = card.kind.replace(/^effect\./, "");
    const kindTitle = tr(`approval.kind_${kindSuffix}` as never);
    const project = options?.projectName ?? card.projectId;
    const topic = options?.topicTitle ?? card.topicId;
    const lines = [kindTitle, project, topic, ...summarize(card)];
    const text = lines.join("\n");
    return { text, buttons: [{ text: tr("approval.approve"), data: "" }, { text: tr("approval.deny"), data: "" }] };
  });
}

function summarize(card: ApprovalCard): string[] {
  const action = card.action;
  switch (action.kind) {
    case "effect.git_push":
      return [`${action.remote.name}`, action.repository,
        ...action.updates.map(update => `${update.ref}: ${update.oldSha ?? "new"} -> ${update.newSha}`),
        ...action.commits.map(commit => `${commit.sha.slice(0, 8)} ${commit.summary}`)];
    case "effect.github_pr_create":
      return [`${action.github.owner}/${action.github.repo}`, `base ${action.base} <- head ${action.head}`, action.title];
    case "effect.github_comment":
      return [`${action.github.owner}/${action.github.repo} #${action.issueNumber}`, action.body.slice(0, 500)];
    case "effect.github_pr_merge":
      return [`${action.github.owner}/${action.github.repo} #${action.pullNumber}`, action.headSha.slice(0, 8), action.method];
    case "effect.deploy":
      return [action.target.name, action.ref ?? "-"];
  }
}
