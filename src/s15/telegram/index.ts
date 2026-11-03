/** CHAN15-01 opt-in S15 Telegram owner channel. Composed only by protected S15 composition; legacy `src/telegram` is unchanged. */
export { openTelegramChannel } from './service';
export { createTelegramBotApi } from './api';
export { TelegramTransportError } from './types';
export type { TelegramBinding, TelegramChannel, TelegramChannelOptions, TelegramLimits, TelegramState, TelegramTransport } from './types';
export { classify, codeCandidate, conversationIdFor, displayCode, requestIdFor, splitText } from './protocol';
