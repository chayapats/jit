import { createHash } from 'node:crypto';
import { containsCredential } from '../../security/credentials';
import { validatePersonalDraft } from '../../s14/personal-effect-validation';
import { canonical, exact, fail, id, nat, string } from '../policy/validation';
import type { MailAttachment, MailProposal } from './types';

/** Validates final message fields without trimming, normalization, implicit recipients or header injection. */
export function validateMailProposal(value: unknown): asserts value is MailProposal {
  canonical(value); exact(value, ['to', 'cc', 'bcc', 'subject', 'body', 'attachments']);
  validatePersonalDraft({ kind: 'mail', to: value.to, cc: value.cc, bcc: value.bcc, subject: value.subject, body: value.body });
  if (!Array.isArray(value.attachments) || value.attachments.length > 8) fail('invalid_attachment');
  const seen = new Set<string>();
  for (const a of value.attachments) { exact(a, ['id', 'revision']); id(a.id); nat(a.revision, true); if (seen.has(a.id)) fail('invalid_attachment'); seen.add(a.id); }
}
/** Rejects active/file-path/credential payloads before immutable preparation; fixture ceilings are not consent. */
export function validateMailAttachment(a: MailAttachment): void {
  canonical(a); exact(a, ['id', 'revision', 'name', 'mediaType', 'dataBase64']); id(a.id); nat(a.revision, true); string(a.name, 200);
  if (!a.name || /[\r\n"\\/]/.test(a.name) || containsCredential(a.name) || !/^[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*\/[a-zA-Z0-9][a-zA-Z0-9!#$&^_.+-]*$/.test(a.mediaType)) fail('invalid_attachment');
  const bytes = Buffer.from(a.dataBase64, 'base64');
  if (bytes.toString('base64') !== a.dataBase64 || bytes.length > 16384 || containsCredential(bytes.toString('utf8'))) fail('invalid_attachment');
}
const lines = (s: string) => (Buffer.from(s).toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
/** Deterministic multipart MIME binds account, envelope headers, message identity and every exact attachment byte. */
export function finalMailRaw(account: string, messageId: string, p: MailProposal, attachments: MailAttachment[]): string {
  validateMailProposal(p); attachments.forEach(validateMailAttachment);
  if (attachments.length !== p.attachments.length || attachments.some((a, i) => a.id !== p.attachments[i]!.id || a.revision !== p.attachments[i]!.revision)) fail('attachment_changed');
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(account) || /[\r\n]/.test(account) || !/^[a-f0-9]{64}$/.test(messageId)) fail('invalid_mail_account');
  const boundary = 'jit_' + messageId;
  const headers = [`From: ${account}`, `To: ${p.to.join(',\r\n ')}`, `Cc: ${p.cc.join(',\r\n ')}`, `Bcc: ${p.bcc.join(',\r\n ')}`, `Subject: =?UTF-8?B?${Buffer.from(p.subject).toString('base64')}?=`, `Message-ID: <${messageId}@jit.invalid>`, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`];
  const parts = [`--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${lines(p.body)}`];
  for (const a of attachments) parts.push(`--${boundary}\r\nContent-Type: ${a.mediaType}\r\nContent-Disposition: attachment; filename*=UTF-8''${encodeURIComponent(a.name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}\r\nContent-Transfer-Encoding: base64\r\n\r\n${(a.dataBase64.match(/.{1,76}/g) ?? []).join('\r\n')}`);
  return Buffer.from(headers.join('\r\n') + '\r\n\r\n' + parts.join('\r\n') + `\r\n--${boundary}--\r\n`).toString('base64url');
}
/** Raw attachment identity is displayed beside exact bytes in the owner ActionSlip. */
export const attachmentDigest = (a: MailAttachment): string => createHash('sha256').update(Buffer.from(a.dataBase64, 'base64')).digest('hex');
