import type { ActionClass, ActionRef, BudgetVector, Ref } from '../policy';
import type { PersonalEventFields } from '../../s14/personal-effect-types';

/** Protected account binding; this is metadata, never a token or an agent-selected endpoint. */
export interface GoogleEffectAccount { resource: Ref; account: string; calendarId: string | null; scopes: readonly ('gmail.readonly' | 'calendar.readonly' | 'gmail.send' | 'calendar.events')[] }
/** Exact approved endpoint identity. Labels or email spelling alone do not establish recipient authority. */
export interface CommunicationRecipient { ref: Ref; address: string }
/** Protected immutable attachment revision. Bytes are canonical base64, bounded and credential-free. */
export interface MailAttachment { id: string; revision: number; name: string; mediaType: string; dataBase64: string }
/** An untrusted proposal can select existing protected attachments, never a host/VM path. */
export interface MailProposal { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; attachments: { id: string; revision: number }[] }
/** Calendar updates require an observation acquired by this work; create never overwrites an existing ID. */
export interface CalendarProposal { operation: 'create' | 'update'; eventId: string | null; version: string | null; timezone: string; sendUpdates: 'none' | 'all'; event: PersonalEventFields }
/** Service-observed exact result. An undo proposal requires fresh authority/version and is never automatic. */
export interface EffectEvidence { contract: 's15-effect-evidence/v1'; action: ActionRef; providerId: string; version: string | null; observed: unknown; undo: unknown | null }
/** Numeric bounds are installed configuration; the adapter invents no operating allowance. */
export interface EffectBounds { read: BudgetVector; mutation: BudgetVector; reconciliation: BudgetVector; expiresInMs: number }
/** Shared default for every outbound route. Owner reports use CHAT's authenticated output, never this adapter. */
export function communicationClasses(route: 'email' | 'message' | 'public_post' | 'github_comment' = 'email'): ActionClass[] { return route === 'github_comment' ? ['communication', 'github_publish'] : ['communication']; }
/** Owner-only data matching the existing Claude-authored DecisionCard contract. No model label grants authority. */
export interface EffectDecisionCard {
  contract: 's15-effect-decision/v1'; action: ActionRef; target: string; version: number;
  impacts: string[]; evidence: { id: string; revision: number; status: 'fact' | 'inference' | 'missing'; value: string }[];
  options: { id: 'apply_exact' | 'investigate' | 'keep'; consequence: string; reversible: boolean }[];
  recommendation: { option: 'investigate' | 'keep'; text: string; authority: 'none' };
}
