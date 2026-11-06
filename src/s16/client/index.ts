/** Browser/native-safe client entry point. Runtime imports never load protected services or Schway. */
export { JitClient, JitClientError } from "./client";
export { beginConversation, emptyConversationState, receiveConversation, withholdConversation } from "./state";
export type * from "./contracts";
export type { ConversationClientState } from "./state";
export { applicationServerKey, disableNotifications, enableNotifications, endpointSha256, notificationLocale, notificationStatus, notificationSupport, notificationWorker, sameApplicationServerKey } from "./notifications";
export type { NotificationEnvironment, NotificationStatus, NotificationSupport } from "./notifications";
