import { tr, trMaybe, withLocale, type Locale, type MessageKey } from '../../i18n';
import type { ActionSlip } from '../policy';
import type { ResponsibilityProjection } from '../work';

/**
 * Outbound Telegram copy (CHAN15-01). Every sentence is a trusted dictionary value in the owner's language;
 * owner, model and website text appear only inside a labelled slot and are sent as plain text, never parsed
 * as formatting. Links point to the owner's own Web pages; approving happens only there.
 */
export type TelegramNotice =
  | { kind: 'bound' } | { kind: 'help' } | { kind: 'unsupported' } | { kind: 'credential' } | { kind: 'approval_web_only' } | { kind: 'rebind' }
  | { kind: 'refused'; code: string } | { kind: 'reply'; text: string } | { kind: 'reply_held' } | { kind: 'progress' }
  | { kind: 'status'; state: 'question' | 'needs_you' | 'budget_hold' | 'blocked' | 'unknown' | 'stopped' | 'accepted'; code: string | null }
  | { kind: 'held'; slip: ActionSlip } | { kind: 'stall'; duty: ResponsibilityProjection } | { kind: 'resume_received' } | { kind: 'resume_refused'; code: string };

const slot = (text: string, values: Record<string, string | number>) => text.replace(/\{([a-z_]+)\}/g, (all, name: string) => Object.hasOwn(values, name) ? String(values[name]) : all);
const t = (name: string, values: Record<string, string | number> = {}) => slot(tr(name as MessageKey), values);
/** One plain sentence for a refusal code, from the same dictionary families the Web page uses. */
export function reason(code: string | null): string {
  for (const prefix of ['s15.code.', 's15.conversation.', 's15.policy.']) { const text = code ? trMaybe(prefix + code) : null; if (text) return text; }
  return tr('s15.code.generic');
}

/** Renders one notice in `locale`. `url` is an absolute link to the exact Web page for it. */
export function noticeText(locale: Locale, notice: TelegramNotice, url: string): string {
  return withLocale(locale, () => {
    switch (notice.kind) {
      case 'bound': return t('s15.telegram.msg.bound', { url });
      case 'help': return t('s15.telegram.msg.help', { url });
      case 'unsupported': return t('s15.telegram.msg.unsupported', { url });
      case 'credential': return t('s15.telegram.msg.credential', { url });
      case 'approval_web_only': return t('s15.telegram.msg.approval_web_only', { url });
      case 'rebind': return t('s15.telegram.msg.rebind', { url });
      case 'refused': return t('s15.telegram.msg.refused', { reason: reason(notice.code), url });
      case 'reply': return `${notice.text}\n\n${t('s15.telegram.msg.reply_link', { url })}`;
      case 'reply_held': return t('s15.telegram.msg.reply_held', { url });
      case 'progress': return t('s15.telegram.msg.progress', { url });
      case 'status': return notice.state === 'needs_you' || notice.state === 'blocked' ? t(`s15.telegram.msg.status.${notice.state}`, { reason: reason(notice.code), url }) : t(`s15.telegram.msg.status.${notice.state}`, { url });
      case 'held': {
        const what = notice.slip.action.classes.map(name => trMaybe(`s15.class.${name}`) ?? name).join(' · ');
        return t('s15.telegram.msg.held', { what, revision: notice.slip.action.revision, url });
      }
      case 'stall': {
        const report = notice.duty.report!, subject = notice.duty.subject?.startsWith('issue:') ? `#${notice.duty.subject.slice(6)}` : notice.duty.originalText.slice(0, 200);
        return [t('s15.stall.title', { n: report.attempts.length }), t('s15.telegram.msg.stall_subject', { subject }), t('s15.telegram.msg.stall_recommendation', { text: report.recommendation }), t('s15.telegram.msg.stall_reply', { url })].join('\n\n');
      }
      case 'resume_received': return t('s15.telegram.msg.resume_received', { url });
      case 'resume_refused': return t('s15.telegram.msg.resume_refused', { reason: reason(notice.code), url });
    }
  });
}
