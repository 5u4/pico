// biome-ignore lint/performance/noBarrelFile: package public API aggregation entry
export { Auth } from "./agents/auth.ts";
export { Catalog } from "./agents/catalog.ts";
export type { Chat } from "./agents/chat.ts";
export { Chats, type GetOrCreateOptions } from "./agents/chats.ts";
export { ChatsConfig, layerChatsConfig } from "./agents/config.ts";
export {
  AuthUnavailable,
  ChatBusy,
  InvalidChatId,
  ModelUnavailable,
  SessionInitFailed,
} from "./agents/errors.ts";
export {
  ChatEvent,
  ChatMessage,
  ChatRole,
  PromptOutcome,
} from "./agents/schema.ts";
