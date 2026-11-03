import { TelegramTransportError, type TelegramTransport } from './types';

const statusCode = (status: number) => status === 401 || status === 404 ? 'telegram_token_rejected' : status === 403 ? 'telegram_chat_blocked' : status === 409 ? 'telegram_webhook_active' : status === 429 ? 'telegram_rate_limited' : status >= 500 ? 'telegram_unavailable' : 'telegram_request_refused';

/**
 * Real Telegram Bot API transport over HTTPS long polling (no webhook, no inbound exposure). The token lives
 * only in this closure and the request URL; errors carry stable codes and never the URL, token or response
 * body. A network failure or 5xx on `sendMessage` is `unknown` because Telegram may already have delivered it.
 */
export function createTelegramBotApi(token: string, fetchImpl: typeof fetch = fetch, timeoutMs = 60000): TelegramTransport {
  async function call<T>(method: string, body: Record<string, unknown>, signal: AbortSignal | undefined, sending: boolean): Promise<T> {
    const unknown = sending ? 'unknown' as const : 'not_sent' as const;
    let response: Response;
    try {
      response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch { throw new TelegramTransportError('telegram_unreachable', unknown); }
    let json: { ok?: unknown; result?: unknown; parameters?: { retry_after?: unknown } };
    // An unreadable body after headers may follow an accepted send (connection lost mid-body): only a valid response confirms refusal.
    try { json = await response.json() as typeof json; } catch { throw new TelegramTransportError('telegram_protocol', unknown); }
    if (json.ok === true && response.ok) return json.result as T;
    const retry = typeof json.parameters?.retry_after === 'number' && Number.isFinite(json.parameters.retry_after) ? Math.min(3600, Math.max(1, Math.ceil(json.parameters.retry_after))) : null;
    throw new TelegramTransportError(statusCode(response.status), response.status >= 500 ? unknown : 'not_sent', response.status === 429 ? retry ?? 5 : null);
  }
  return {
    getMe: signal => call('getMe', {}, signal, false),
    getUpdates: (input, signal) => call('getUpdates', { offset: input.offset, timeout: input.timeout, allowed_updates: input.allowedUpdates }, signal, false),
    sendMessage: (input, signal) => call('sendMessage', { chat_id: input.chatId, text: input.text, link_preview_options: { is_disabled: true }, ...(input.replyTo ? { reply_parameters: { message_id: input.replyTo, allow_sending_without_reply: true } } : {}) }, signal, true),
  };
}
