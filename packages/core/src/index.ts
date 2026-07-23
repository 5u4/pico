// biome-ignore lint/performance/noBarrelFile: package public API aggregation entry
export { Auth } from "./agents/auth.ts";
export { Catalog } from "./agents/catalog.ts";
export type { ChatSession } from "./agents/chat.ts";
export { Chats } from "./agents/chats.ts";
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
export {
  ConfigFileInvalid,
  layerPicoConfig,
  PicoConfig,
} from "./config/pico-config.ts";
export {
  ChatNotFound,
  DbError,
  DuplicateExternalId,
  SpaceNotFound,
} from "./store/errors.ts";
export { Chat, Platform, Space } from "./store/schema.ts";
export {
  type CreateChatInput,
  type CreateSpaceInput,
  layerStore,
  Store,
  type StoreApi,
} from "./store/store.ts";
export {
  CwdNotFound,
  InvalidChatTitle,
  InvalidCwd,
  InvalidSpaceName,
  NotADirectory,
  SpaceHasActiveChats,
} from "./surface/errors.ts";
export {
  type ChatHandle,
  makeSurface,
  type Surface,
} from "./surface/surface.ts";
